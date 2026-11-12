"""Shared product catalog and artifacts; no local ML model imports."""

from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path

from backend.common import ServiceError, decode_image
from backend.config import Settings
from backend.schemas import ProductSummary, Thresholds

PRODUCT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
RESULT_ID = re.compile(r"[a-f0-9]{32}\Z")
IMAGE_ARTIFACTS = {
    "discrepancy.png",
    "capture.png",
    "normalized.png",
    "annotated.png",
    "reference-annotated.png",
    "heatmap.png",
    "original.png",
    "foreground.png",
    "reference.png",
    "reference-foreground.png",
    "aligned.png",
    "foreground-mask.png",
    "comparison-mask.png",
}
ALLOWED_ARTIFACTS = IMAGE_ARTIFACTS | {"result.json"}


def write_json(destination: Path, value):
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(destination)


class CatalogStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.catalog_path = self.settings.data_dir / "catalog.json"
        self._lock = threading.RLock()

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
            getattr(self, "_index", {}).pop(product_id, None)
            return self.summary(product)

    def artifact(self, request_id: str, filename: str) -> Path:
        if not RESULT_ID.fullmatch(request_id) or filename not in ALLOWED_ARTIFACTS:
            raise ServiceError("Result not found", 404)
        destination = self.settings.data_dir / "results" / request_id / filename
        if not destination.is_file():
            raise ServiceError("Result not found", 404)
        return destination
