from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance

from backend.algorithms import (
    IMAGE_SIZE,
    Features,
    LocalMatch,
    Models,
    align_query,
    letterbox,
    patch_distances,
    sift_match,
)
from backend.common import ServiceError, decode_image  # noqa: F401 (re-exported)
from backend.config import Settings
from backend.schemas import ProductSummary, Thresholds, VerificationResponse

LOG = logging.getLogger(__name__)
PRODUCT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
RESULT_ID = re.compile(r"[a-f0-9]{32}\Z")
ALLOWED_ARTIFACTS = {"discrepancy.png", "heatmap.png", "result.json"}


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


def render_discrepancies(reference, aligned, valid_mask, heat, threshold):
    """Absolute anomaly scale: a perfect match does not get artificial red patches."""
    boxed, valid = letterbox(aligned, valid_mask)
    expanded = cv2.resize(heat, (IMAGE_SIZE, IMAGE_SIZE), interpolation=cv2.INTER_NEAREST)
    intensity = np.clip((expanded - threshold) / max(0.60 - threshold, 0.10), 0, 1) * valid
    rgb = np.asarray(boxed).astype(np.float32)
    alpha = (intensity * 0.65)[..., None]
    overlay = Image.fromarray(
        (rgb * (1 - alpha) + np.array([240, 45, 35]) * alpha).astype(np.uint8)
    )
    mask = ((expanded > threshold) & (valid > 0)).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    regions = []
    draw = ImageDraw.Draw(overlay)
    for x, y, width, height, area in stats[1:count]:
        if area < 30:
            continue
        draw.rectangle(
            (int(x), int(y), int(x + width - 1), int(y + height - 1)), outline="#e23427", width=2
        )
        regions.append(
            {
                "x": int(x),
                "y": int(y),
                "width": int(width),
                "height": int(height),
                "max_anomaly": float(expanded[y : y + height, x : x + width].max()),
            }
        )
    ref, _ = letterbox(reference)
    canvas = Image.new("RGB", (IMAGE_SIZE * 2 + 16, IMAGE_SIZE + 38), "white")
    canvas.paste(ref, (0, 38))
    canvas.paste(overlay, (IMAGE_SIZE + 16, 38))
    captions = ImageDraw.Draw(canvas)
    captions.text((10, 12), "GENUINE REFERENCE", fill="#203b45")
    captions.text((IMAGE_SIZE + 26, 12), "RETURNED ITEM / OBSERVED DIFFERENCES", fill="#203b45")
    return canvas, overlay, regions


class VerificationService:
    """Single-process catalog and serialized inference; no data leaves this server."""

    def __init__(self, settings: Settings, models=None):
        self.settings = settings
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
                indexed.references.append(Reference(product["id"], image, features, variants))
            if not indexed.references:
                raise ServiceError("Catalog product has no reference images", 503)
            self._index[product["id"]] = indexed

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
                ref.variants if alignment_valid else [r.features for r in target.references]
            )
            anomaly, heat = patch_distances(aligned_features, references, alignment_valid)
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
                    "No reliable homography. Pose-independent PatchCore is informational; decision is inconclusive."
                )
            request_id = uuid.uuid4().hex
            destination = self.settings.data_dir / "results" / request_id
            destination.mkdir(parents=True)
            discrepancy, heatmap, regions = render_discrepancies(
                ref.image, aligned, valid, heat, max(0.12, thresholds.patchcore_good)
            )
            discrepancy.save(destination / "discrepancy.png")
            heatmap.save(destination / "heatmap.png")
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
                },
                patchcore={
                    "anomaly_score": anomaly,
                    "normality_score": normality,
                    "method": "aligned_spatial"
                    if alignment_valid
                    else "unaligned_nearest_neighbor",
                },
                discrepancy_image_url=f"/v1/results/{request_id}/discrepancy.png",
                heatmap_image_url=f"/v1/results/{request_id}/heatmap.png",
                discrepancy_regions=regions,
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
