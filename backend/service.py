from __future__ import annotations

import io
import json
import logging
import re
import threading
import time
import uuid
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageOps, UnidentifiedImageError

from backend.algorithms import (
    Features,
    LocalMatch,
    Models,
    align_query,
    patch_distances,
    sift_match,
)
from backend.alignment import RectangleError, RectangleView, rectify_rectangle
from backend.config import Settings
from backend.schemas import ProductSummary, Thresholds, VerificationResponse
from backend.visualization import _box, foreground, major_discrepancies, normalized_pair

LOG = logging.getLogger(__name__)
PRODUCT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
RESULT_ID = re.compile(r"[a-f0-9]{32}\Z")
ALLOWED_ARTIFACTS = {"capture.png", "reference.png", "normalized.png", "discrepancy.png", "heatmap.png", "result.json"}


class ServiceError(Exception):
    def __init__(self, detail: str, status_code: int = 422):
        super().__init__(detail)
        self.status_code = status_code


def decode_image(data: bytes, settings: Settings) -> Image.Image:
    if not data:
        raise ServiceError("Image is empty", 400)
    if len(data) > settings.max_upload_bytes:
        raise ServiceError("Image exceeds the upload limit", 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ServiceError("Image must be JPEG, PNG or WebP", 415)
                # Check the header BEFORE decoding the full pixel allocation.
                if source.width * source.height > settings.max_pixels:
                    raise ServiceError("Image exceeds the pixel limit", 413)
                if min(source.size) < 64:
                    raise ServiceError("Image must be at least 64 x 64 pixels")
                source.load()
                oriented = ImageOps.exif_transpose(source)
                oriented.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                rgba = oriented.convert("RGBA")
                background = Image.new("RGBA", rgba.size, "white")
                image = Image.alpha_composite(background, rgba).convert("RGB")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ServiceError("Image exceeds the pixel safety limit", 413) from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ServiceError("File is not a readable image", 415) from exc
    return image


def write_json(destination: Path, value):
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(destination)


@dataclass
class Reference:
    product_id: str
    image: Image.Image
    features: Features
    variants: list[Features]
    local: object = None
    rectangle: RectangleView | None = None
    rectangle_features: Features | None = None
    rectangle_variants: list[Features] = field(default_factory=list)


@dataclass
class IndexedProduct:
    metadata: dict
    references: list[Reference] = field(default_factory=list)


def evaluate(similarity, geometry, anomaly, alignment_valid, identity_consistent, thresholds):
    retrieval = float(
        np.clip(
            (similarity - thresholds.min_retrieval_cosine) / (1 - thresholds.min_retrieval_cosine),
            0,
            1,
        )
    )
    normality = float(
        np.clip(
            (thresholds.patchcore_bad - anomaly)
            / (thresholds.patchcore_bad - thresholds.patchcore_good),
            0,
            1,
        )
    )
    confidence = float(np.clip(0.15 * retrieval + 0.50 * geometry + 0.35 * normality, 0, 1))
    reasons = []
    if not identity_consistent:
        reasons.append("Retrieved identity disagrees with the claimed product.")
    if similarity < thresholds.min_retrieval_cosine:
        reasons.append("Weak similarity to the reference product.")
    if geometry < thresholds.min_geometry_score:
        reasons.append("Too few well-distributed, geometrically consistent matches.")
    if anomaly > thresholds.max_patchcore_anomaly:
        reasons.append("Local appearance differences exceed the demo threshold.")
    if confidence < thresholds.min_combined_score:
        reasons.append("Combined visual-match score is below the demo threshold.")
    if not alignment_valid:
        reasons.append("View alignment failed; retake a photo closer to a reference view.")
        decision = "inconclusive"
    else:
        decision = "suspicious" if reasons else "consistent"
    if not reasons:
        reasons.append("Identity, geometry and local appearance agree with the reference images.")
    return confidence, normality, decision, reasons



class VerificationService:
    """Single-process catalog and serialized inference; no data leaves this server."""

    def __init__(self, settings: Settings, models=None):
        self.settings = settings
        if settings.alignment_method not in {"rectangle", "features"}:
            raise ValueError("RETURNSCAN_ALIGNMENT_METHOD must be rectangle or features")
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.catalog_path = self.settings.data_dir / "catalog.json"
        self.models = models if models is not None else Models(settings)
        self._lock = threading.RLock()
        self._index: dict[str, IndexedProduct] = {}

    @property
    def loaded(self):
        return self.models.loaded

    def _catalog(self):
        if not self.catalog_path.exists():
            return {"products": []}
        try:
            catalog = json.loads(self.catalog_path.read_text(encoding="utf-8"))
            if not isinstance(catalog.get("products"), list):
                raise ValueError("missing products list")
            return catalog
        except (ValueError, OSError, AttributeError) as exc:
            raise ServiceError(
                "Catalog is unreadable; check the server data directory", 503
            ) from exc

    @staticmethod
    def summary(product):
        return ProductSummary(
            id=product["id"],
            name=product["name"],
            sku=product["sku"],
            barcode=product.get("barcode"),
            reference_count=len(product["references"]),
        ).model_dump()

    def products(self):
        with self._lock:
            return [self.summary(item) for item in self._catalog()["products"]]

    def register(
        self, product_id: str, name: str, sku: str, barcode: str | None, images: list[bytes]
    ):
        if not PRODUCT_ID.fullmatch(product_id):
            raise ServiceError("product_id must be 1-64 letters, digits, underscores or hyphens")
        if not 1 <= len(images) <= self.settings.max_references:
            raise ServiceError(f"Supply 1-{self.settings.max_references} genuine reference images")
        decoded = [decode_image(data, self.settings) for data in images]
        with self._lock:
            catalog = self._catalog()
            if any(p["id"] == product_id for p in catalog["products"]):
                raise ServiceError("Product already exists; use a different product_id", 409)
            if barcode and any(p.get("barcode") == barcode for p in catalog["products"]):
                raise ServiceError("Barcode already belongs to another product", 409)
            directory = self.settings.data_dir / "references" / uuid.uuid4().hex
            directory.mkdir(parents=True)
            references = []
            for i, image in enumerate(decoded):
                destination = directory / f"{i}.png"
                image.save(destination)  # Sanitized RGB, resized, no source metadata.
                references.append(str(destination.relative_to(self.settings.data_dir)))
            product = {
                "id": product_id,
                "name": name,
                "sku": sku,
                "barcode": barcode,
                "references": references,
                "thresholds": Thresholds().model_dump(),
            }
            catalog["products"].append(product)
            write_json(self.catalog_path, catalog)
            return self.summary(product)

    def replace_references(self, product_id, images, name=None):
        if not 1 <= len(images) <= self.settings.max_references:
            raise ServiceError(f"Supply 1-{self.settings.max_references} genuine references")
        decoded = [decode_image(data, self.settings) for data in images]
        with self._lock:
            catalog = self._catalog()
            product = next((p for p in catalog["products"] if p["id"] == product_id), None)
            if product is None:
                raise ServiceError("Product not found", 404)
            directory = self.settings.data_dir / "references" / uuid.uuid4().hex
            directory.mkdir(parents=True)
            references = []
            for index, image in enumerate(decoded):
                path = directory / f"{index}.png"
                image.save(path)
                references.append(str(path.relative_to(self.settings.data_dir)))
            product["references"] = references
            if name:
                product["name"] = name
            write_json(self.catalog_path, catalog)
            self._index.pop(product_id, None)
            return self.summary(product)

    def _load_index(self, catalog):
        self.models.load()
        for product in catalog["products"]:
            if product["id"] in self._index:
                continue
            indexed = IndexedProduct(product)
            for relative in product["references"]:
                source = (self.settings.data_dir / relative).resolve()
                if not source.is_relative_to(self.settings.data_dir.resolve()):
                    raise ServiceError("Reference path escapes the data directory", 503)
                image = decode_image(source.read_bytes(), self.settings)
                features = self.models.features(image)
                variants = [features] + [
                    self.models.features(ImageEnhance.Brightness(image).enhance(factor))
                    for factor in (0.90, 1.10)
                ]
                reference = Reference(product["id"], image, features, variants)
                if self.settings.alignment_method == "rectangle":
                    _, mask, segmented = foreground(image)
                    if segmented:
                        try:
                            reference.rectangle = rectify_rectangle(image, mask)
                            view = reference.rectangle
                            reference.rectangle_features = self.models.features(view.image, view.mask)
                            reference.rectangle_variants = [reference.rectangle_features] + [
                                self.models.features(ImageEnhance.Brightness(view.image).enhance(factor), view.mask)
                                for factor in (0.90, 1.10)
                            ]
                        except RectangleError:
                            LOG.warning("Reference has no usable foreground rectangle: %s", relative)
                indexed.references.append(reference)
            if not indexed.references:
                raise ServiceError("Catalog product has no reference images", 503)
            self._index[product["id"]] = indexed

    def _rectangle_alignment(self, image, references):
        """Use the remote rectangle fit and select its four orientations by DINO patches."""
        _, mask, segmented = foreground(image)
        if not segmented:
            return None
        for ref in references:
            if ref.rectangle is None:
                continue
            candidates = []
            try:
                for turn in range(4):
                    view = rectify_rectangle(image, mask, size=ref.rectangle.image.size, quarter_turns=turn)
                    features = self.models.features(view.image, view.mask)
                    tokens = features.mask & ref.rectangle_features.mask
                    if not bool(tokens.any()):
                        continue
                    appearance = float((features.patches[tokens] * ref.rectangle_features.patches[tokens]).sum(-1).mean().cpu())
                    common = (view.mask > 0) & (ref.rectangle.mask > 0)
                    union = (view.mask > 0) | (ref.rectangle.mask > 0)
                    iou = int(common.sum()) / max(1, int(union.sum()))
                    if int(common.sum()) >= 64:
                        candidates.append((appearance + 0.03 * iou, view, common, iou))
            except RectangleError:
                continue
            if candidates:
                _, view, common, iou = max(candidates, key=lambda candidate: candidate[0])
                return ref, view, common.astype(np.uint8), iou
        return None

    def verify(self, image_bytes, *, expected_product_id=None, barcode=None, local_backend="auto"):
        if expected_product_id and barcode:
            raise ServiceError("Supply expected_product_id or barcode, not both")
        if local_backend not in {"auto", "aliked", "sift"}:
            raise ServiceError("local_backend must be auto, aliked or sift")
        started = time.perf_counter()
        image = decode_image(image_bytes, self.settings)
        preprocessed = time.perf_counter()
        # Serialize models, catalog writes and MPS work. One uvicorn worker only.
        with self._lock:
            catalog = self._catalog()
            if not catalog["products"]:
                raise ServiceError(
                    "No products enrolled. POST genuine references to /v1/products first.", 409
                )
            if barcode:
                expected_product_id = next(
                    (p["id"] for p in catalog["products"] if p.get("barcode") == barcode), None
                )
                if expected_product_id is None:
                    raise ServiceError("Barcode is not in the reference catalog", 404)
            if expected_product_id and not any(
                p["id"] == expected_product_id for p in catalog["products"]
            ):
                raise ServiceError("Expected product is not in the reference catalog", 404)
            load_started = time.perf_counter()
            try:
                self._load_index(catalog)
            except ServiceError:
                raise
            except Exception as exc:
                LOG.exception("Could not initialize the reference/model index")
                raise ServiceError(
                    "Could not load CV models/references. Check server logs and first-run network access.",
                    503,
                ) from exc
            index_ready = time.perf_counter()
            query = self.models.features(image)
            candidates = []
            for product in self._index.values():
                similarity = max(
                    float((query.global_feature * r.features.global_feature).sum().cpu())
                    for r in product.references
                )
                candidates.append(
                    {
                        "product_id": product.metadata["id"],
                        "name": product.metadata["name"],
                        "cosine_similarity": float(np.clip(similarity, -1, 1)),
                    }
                )
            candidates.sort(key=lambda p: p["cosine_similarity"], reverse=True)
            identified_id = candidates[0]["product_id"]
            target = self._index[expected_product_id or identified_id]
            similarity = next(
                c["cosine_similarity"]
                for c in candidates
                if c["product_id"] == target.metadata["id"]
            )
            # Do not manufacture a confident SKU distinction for near-identical
            # catalog references. A barcode is a claim, not visual proof.
            identity_ambiguous = (
                len(candidates) > 1
                and candidates[0]["cosine_similarity"] - candidates[1]["cosine_similarity"] < 0.02
            )
            retrieved = time.perf_counter()
            warnings_list = [
                "Confidence is an uncalibrated visual-match score, not an authenticity probability.",
                "Demo thresholds require per-product validation. A visual match does not prove authenticity.",
                "Use cropped, well-lit product photos with reference-like views; backgrounds can influence scores.",
            ]
            rectangle = None
            if self.settings.alignment_method == "rectangle":
                ordered = sorted(target.references, key=lambda r: float((query.global_feature * r.features.global_feature).sum().cpu()), reverse=True)
                rectangle = self._rectangle_alignment(image, ordered)
                if rectangle is not None:
                    ref, rectangle_view, valid, iou = rectangle
                    aligned, alignment_valid = rectangle_view.image, True
                    geometry = LocalMatch("rectangle", 0, 0, 0, 0, iou, None)
                else:
                    ref = ordered[0]
                    aligned, valid, alignment_valid = image, None, False
                    geometry = LocalMatch("rectangle", 0, 0, 0, 0, 0, None)
                warnings_list.append("Rectangle alignment normalizes foreground outlines; internal feature correspondence is not verified.")
            else:
                matches: list[tuple[Reference, LocalMatch]] = []
                if local_backend != "sift":
                    try:
                        query_local = self.models.local_features(image)
                        for ref in target.references:
                            if ref.local is None:
                                ref.local = self.models.local_features(ref.image)
                            matches.append(
                                (ref, self.models.match(ref.local, query_local, ref.image.size))
                            )
                    except Exception as exc:
                        if local_backend == "aliked":
                            raise ServiceError(
                                "ALIKED/LightGlue failed. Retry with local_backend=sift or check model setup.",
                                503,
                            ) from exc
                        LOG.warning("Falling back to SIFT", exc_info=True)
                        matches = []
                        warnings_list.append(
                            "ALIKED/LightGlue unavailable; used SIFT + RANSAC CPU fallback."
                        )
                if not matches:
                    matches = [(ref, sift_match(ref.image, image)) for ref in target.references]
                ref, geometry = max(
                    matches, key=lambda pair: (pair[1].homography is not None, pair[1].score)
                )
                aligned, valid, alignment_valid = align_query(
                    image, geometry.homography, ref.image.size
                )
            geometry_done = time.perf_counter()
            aligned_features = self.models.features(aligned, valid)
            references = (
                (ref.rectangle_variants if rectangle is not None else ref.variants)
                if alignment_valid else [r.features for r in target.references]
            )
            anomaly, _ = patch_distances(aligned_features, references, alignment_valid)
            patch_done = time.perf_counter()
            thresholds = Thresholds.model_validate(target.metadata.get("thresholds", {}))
            identity_consistent = (
                expected_product_id is None
                or identified_id == expected_product_id
                or candidates[0]["cosine_similarity"] - similarity < 0.02
            )
            confidence, normality, decision, reasons = evaluate(
                similarity,
                geometry.score,
                anomaly,
                alignment_valid,
                identity_consistent,
                thresholds,
            )
            if identity_ambiguous:
                warnings_list.append(
                    "Top catalog products are visually ambiguous; the score cannot resolve SKU identity."
                )
                if decision == "consistent":
                    decision = "inconclusive"
                    reasons = [
                        "Multiple catalog products have near-equal visual similarity; human identity review is required."
                    ]
            if not alignment_valid:
                warnings_list.append(
                    "Alignment failed. Pose-independent PatchCore is informational; decision is inconclusive."
                )
            request_id = uuid.uuid4().hex
            destination = self.settings.data_dir / "results" / request_id
            destination.mkdir(parents=True)
            image.save(destination / "capture.png")
            if rectangle is not None:
                # Both views already share the remote algorithm's reference canvas.
                # Use one crop/scale for display, without estimating another warp.
                union = ref.rectangle.mask | rectangle_view.mask
                bounds = cv2.boundingRect(union)
                reference_view = _box(np.asarray(ref.rectangle.image), ref.rectangle.mask, bounds)
                normalized_view = _box(np.asarray(rectangle_view.image), rectangle_view.mask, bounds)
                background_removed = True
            else:
                reference_view, normalized_view, background_removed = normalized_pair(
                    ref.image, image, geometry.homography, alignment_valid
                )
            reference_view.save(destination / "reference.png")
            normalized_view.save(destination / "normalized.png")
            discrepancy_url = None
            regions = []
            if geometry.backend in {"ALIKED+LightGlue", "rectangle"} and alignment_valid and background_removed:
                discrepancy, regions = major_discrepancies(reference_view, normalized_view)
                discrepancy.save(destination / "discrepancy.png")
                discrepancy_url = f"/v1/results/{request_id}/discrepancy.png"
            if not background_removed:
                warnings_list.append("Background removal could not isolate both products. Retake with a contrasting background and space around the item.")
            rendered = time.perf_counter()
            response = VerificationResponse(
                request_id=request_id,
                confidence=confidence,
                confidence_percent=round(confidence * 100, 2),
                decision=decision,
                identified_product=self.summary(self._index[identified_id].metadata),
                compared_product=self.summary(target.metadata),
                expected_product_id=expected_product_id,
                identity_consistent=identity_consistent,
                identity_ambiguous=identity_ambiguous,
                candidates=candidates[:3],
                geometry={
                    "backend": geometry.backend,
                    "matches": geometry.matches,
                    "inliers": geometry.inliers,
                    "inlier_ratio": geometry.inlier_ratio,
                    "coverage": geometry.coverage,
                    "score": geometry.score,
                    "alignment_valid": alignment_valid,
                    "alignment_method": self.settings.alignment_method,
                    "alignment_quality": ("outline_only" if rectangle is not None else "feature_verified") if alignment_valid else "failed",
                    "rotation_degrees": rectangle_view.rotation_degrees if rectangle is not None else 0,
                },
                patchcore={
                    "anomaly_score": anomaly,
                    "normality_score": normality,
                    "method": "aligned_spatial"
                    if alignment_valid
                    else "unaligned_nearest_neighbor",
                },
                discrepancy_image_url=discrepancy_url,
                capture_image_url=f"/v1/results/{request_id}/capture.png",
                normalized_reference_image_url=f"/v1/results/{request_id}/reference.png",
                normalized_image_url=f"/v1/results/{request_id}/normalized.png",
                background_removed=background_removed,
                normalization_alignment="matched_geometry" if alignment_valid else "orientation_only",
                heatmap_image_url=None,
                discrepancy_regions=regions,
                region_coordinate_system="normalized_448x448",
                latency_ms={
                    "preprocessing": (preprocessed - started) * 1000,
                    "queue_wait": (load_started - preprocessed) * 1000,
                    "model_and_index_load": (index_ready - load_started) * 1000,
                    "retrieval": (retrieved - index_ready) * 1000,
                    "geometry": (geometry_done - retrieved) * 1000,
                    "patchcore": (patch_done - geometry_done) * 1000,
                    "visualization": (rendered - patch_done) * 1000,
                    "total": (rendered - started) * 1000,
                },
                reasons=reasons,
                warnings=warnings_list,
            ).model_dump()
            write_json(destination / "result.json", response)
            return response

    def artifact(self, request_id: str, filename: str) -> Path:
        if not RESULT_ID.fullmatch(request_id) or filename not in ALLOWED_ARTIFACTS:
            raise ServiceError("Result not found", 404)
        destination = self.settings.data_dir / "results" / request_id / filename
        if not destination.is_file():
            raise ServiceError("Result not found", 404)
        return destination
