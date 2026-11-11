"""Coarse foreground-outline rectification; no feature correspondences required."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image


class RectangleError(ValueError):
    pass


@dataclass
class RectangleView:
    image: Image.Image
    mask: np.ndarray
    matrix: np.ndarray
    corners: np.ndarray
    estimator: str
    rotation_degrees: int


def outline_rectangle(mask):
    binary = (np.asarray(mask) > 0).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or int(binary.sum()) < 64:
        raise RectangleError("No usable foreground outline")
    # Include detached pieces instead of silently excluding them from comparison.
    hull = cv2.convexHull(np.concatenate(contours))
    quad, estimator = None, "contour_quadrilateral"
    for epsilon in np.linspace(0.005, 0.10, 100):
        approximation = cv2.approxPolyDP(hull, epsilon * cv2.arcLength(hull, True), True)
        if len(approximation) == 4:
            quad = approximation[:, 0].astype(np.float32)
            break
    if quad is None:
        quad = cv2.boxPoints(cv2.minAreaRect(hull))
        estimator = "minimum_area_rectangle"
    center = quad.mean(0)
    quad = quad[np.argsort(np.arctan2(quad[:, 1] - center[1], quad[:, 0] - center[0]))]
    quad = np.roll(quad, -int(np.argmin(quad.sum(1))), axis=0).astype(np.float32)
    edges = np.linalg.norm(np.roll(quad, -1, axis=0) - quad, axis=1)
    if not np.isfinite(quad).all() or min(edges) < 4 or cv2.contourArea(quad) < 64:
        raise RectangleError("Foreground rectangle is degenerate or too thin")
    return quad, estimator


def rectify_rectangle(image, mask, *, size=None, quarter_turns=0, outline=None):
    """Map an outline into a shared canvas; size is determined by the reference."""
    quad, estimator = outline if outline is not None else outline_rectangle(mask)
    if size is None:
        edges = np.linalg.norm(np.roll(quad, -1, axis=0) - quad, axis=1)
        width, height = (edges[0] + edges[2]) / 2, (edges[1] + edges[3]) / 2
        scale = 480 / max(width, height)
        size = (max(96, round(width * scale) + 32), max(96, round(height * scale) + 32))
    destination = np.float32(
        [[16, 16], [size[0] - 17, 16], [size[0] - 17, size[1] - 17], [16, size[1] - 17]]
    )
    source = np.roll(quad, -quarter_turns, axis=0).copy()
    matrix = cv2.getPerspectiveTransform(source, destination)
    if not np.isfinite(matrix).all() or abs(np.linalg.det(matrix)) < 1e-10:
        raise RectangleError("Could not construct rectangle transform")
    pixels = cv2.warpPerspective(
        np.asarray(image), matrix, size, flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255)
    )
    valid = cv2.warpPerspective((mask > 0).astype(np.uint8), matrix, size, flags=cv2.INTER_NEAREST)
    if int(valid.sum()) < 64:
        raise RectangleError("Rectangle transform has too little foreground")
    # A fitted quad can be slightly inside rounded edges. Padding must retain them.
    support = cv2.warpPerspective(
        np.ones(valid.shape, np.uint8), np.linalg.inv(matrix), image.size, flags=cv2.INTER_NEAREST
    )
    retained = np.count_nonzero((mask > 0) & (support > 0)) / max(1, np.count_nonzero(mask))
    if retained < 0.95 and estimator != "minimum_area_rectangle":
        # Enclosing rectangle is safer than cropping off pieces of the object.
        points = cv2.findNonZero((mask > 0).astype(np.uint8))
        enclosing = cv2.boxPoints(cv2.minAreaRect(points))
        center = enclosing.mean(0)
        enclosing = enclosing[
            np.argsort(np.arctan2(enclosing[:, 1] - center[1], enclosing[:, 0] - center[0]))
        ]
        enclosing = np.roll(enclosing, -int(np.argmin(enclosing.sum(1))), axis=0)
        return rectify_rectangle(
            image,
            mask,
            size=size,
            quarter_turns=quarter_turns,
            outline=(enclosing.astype(np.float32), "minimum_area_rectangle"),
        )
    return RectangleView(
        Image.fromarray(pixels), valid, matrix, source, estimator, (quarter_turns % 4) * 90
    )
