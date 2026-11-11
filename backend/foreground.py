"""Local foreground segmentation, shared by enrollment indexing and verification."""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
from PIL import Image

from backend.config import Settings


@dataclass
class Foreground:
    image: Image.Image
    mask: np.ndarray
    source_fraction: float
    valid: bool = True
    reason: str | None = None


def crop_foreground(image: Image.Image, mask: np.ndarray) -> Foreground:
    """Preserve every foreground component, including detached/broken pieces."""
    mask = (np.asarray(mask) > 127).astype(np.uint8)
    if mask.shape != (image.height, image.width):
        raise ValueError("Foreground mask does not match image dimensions")
    fraction = float(mask.mean())
    if mask.sum() < 64 or fraction < 0.005:
        # Raw pixels remain available for informational retrieval; never authenticate.
        return Foreground(
            image,
            np.ones_like(mask),
            fraction,
            False,
            "No usable foreground found; retake with one clearly visible product.",
        )
    ys, xs = np.where(mask)
    margin = max(4, round(max(xs.max() - xs.min(), ys.max() - ys.min()) * 0.04))
    x0, y0 = max(0, int(xs.min()) - margin), max(0, int(ys.min()) - margin)
    x1, y1 = (
        min(image.width, int(xs.max()) + margin + 1),
        min(image.height, int(ys.max()) + margin + 1),
    )
    pixels = np.asarray(image).copy()
    pixels[mask == 0] = 255
    return Foreground(Image.fromarray(pixels[y0:y1, x0:x1]), mask[y0:y1, x0:x1], fraction)


class ForegroundSegmenter:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.session = None

    def predict_mask(self, image: Image.Image) -> np.ndarray:
        from rembg import new_session, remove

        if self.session is None:
            cache = self.settings.model_cache or self.settings.data_dir / "models"
            # rembg 2.0.69 reads U2NET_HOME; keep downloads in the configured cache.
            os.environ["U2NET_HOME"] = str(cache / "segmentation")
            os.environ.setdefault("OMP_NUM_THREADS", "4")
            self.session = new_session(
                self.settings.segmentation_model, providers=["CPUExecutionProvider"]
            )
        mask = remove(image, session=self.session, only_mask=True)
        return np.asarray(mask.convert("L"))

    def prepare(self, image: Image.Image) -> Foreground:
        return crop_foreground(image, self.predict_mask(image))
