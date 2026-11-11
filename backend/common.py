"""Helpers shared by the CV service and the records database (no PyTorch imports)."""

from __future__ import annotations

import io
import warnings

from fastapi import UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from backend.config import Settings

IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


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


async def read_upload(file: UploadFile, settings: Settings) -> bytes:
    try:
        if file.content_type not in IMAGE_MIME_TYPES:
            raise ServiceError("Supported content types: image/jpeg, image/png, image/webp", 415)
        data = await file.read(settings.max_upload_bytes + 1)
        if not data:
            raise ServiceError("Image is empty", 400)
        if len(data) > settings.max_upload_bytes:
            raise ServiceError("Image exceeds the upload limit", 413)
        return data
    finally:
        await file.close()
