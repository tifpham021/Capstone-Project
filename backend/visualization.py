"""Foreground-normalized comparison views and conservative line-difference boxes.

Display preprocessing is separate from the existing CV confidence calculation.
GrabCut assumes a single foreground product surrounded by visible background.
"""
from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageDraw

SIZE = 448


def foreground(image):
    rgb = np.asarray(image.convert("RGB"))
    scale = min(1, 640 / max(image.size))
    small = cv2.resize(rgb, (max(1, round(image.width * scale)),
                             max(1, round(image.height * scale))))
    height, width = small.shape[:2]
    mask = np.zeros((height, width), np.uint8)
    margin = max(2, round(min(height, width) * .025))
    if np.max(np.std(small.astype(np.float32), axis=(0, 1))) < 2:
        return rgb, np.ones(rgb.shape[:2], np.uint8), False
    try:
        cv2.grabCut(small, mask, (margin, margin, width - 2 * margin, height - 2 * margin),
                    np.zeros((1, 65)), np.zeros((1, 65)), 4, cv2.GC_INIT_WITH_RECT)
        mask = np.isin(mask, [cv2.GC_FGD, cv2.GC_PR_FGD]).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
        if count <= 1:
            raise ValueError("No foreground")
        largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        mask = (labels == largest).astype(np.uint8)
        if not .025 < mask.mean() < .94:
            raise ValueError("Unusable foreground")
        # Fill interior holes: dark camera lenses are part of a black phone.
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(mask, contours, -1, 1, cv2.FILLED)
        mask = cv2.resize(mask, image.size, interpolation=cv2.INTER_NEAREST)
        return rgb, mask, True
    except (cv2.error, ValueError):
        return rgb, np.ones(rgb.shape[:2], np.uint8), False


def _upright(rgb, mask):
    """Orient the segmented long axis vertically; this is not a geometric fit."""
    y, x = np.nonzero(mask)
    covariance = np.cov(np.stack([x, y]))
    _, vectors = np.linalg.eigh(covariance)
    axis = vectors[:, -1]
    angle = np.degrees(np.arctan2(axis[1], axis[0])) - 90
    height, width = mask.shape
    side = int(np.ceil(np.hypot(width, height)))
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1)
    matrix[:, 2] += [(side - width) / 2, (side - height) / 2]
    return (cv2.warpAffine(rgb, matrix, (side, side)),
            cv2.warpAffine(mask, matrix, (side, side), flags=cv2.INTER_NEAREST))


def _box(rgb, mask, bounds):
    x, y, width, height = bounds
    rgb, mask = rgb[y:y + height, x:x + width], mask[y:y + height, x:x + width]
    scale = (SIZE - 32) / max(width, height)
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    rgba = np.dstack([rgb, mask * 255])
    cutout = Image.fromarray(rgba).resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE))
    canvas.paste(cutout, ((SIZE - size[0]) // 2, (SIZE - size[1]) // 2))
    return canvas


def normalized_pair(reference, query, matrix, alignment_valid):
    ref, ref_mask, ref_ok = foreground(reference)
    item, item_mask, item_ok = foreground(query)
    segmented = ref_ok and item_ok
    if alignment_valid:
        # Fit both complete image footprints before warping. Warping into the
        # reference dimensions first permanently clips translated/rotated pixels.
        corners = np.float64([[0, 0], [query.width, 0],
                              [query.width, query.height], [0, query.height]])
        projected = cv2.perspectiveTransform(corners[None], matrix)[0]
        reference_corners = np.array([[0, 0], [reference.width, reference.height]])
        points = np.vstack([projected, reference_corners])
        low, high = points.min(axis=0), points.max(axis=0)
        scale = (SIZE - 32) / max(high - low)
        offset = (SIZE - (high - low) * scale) / 2 - low * scale
        fit = np.array([[scale, 0, offset[0]], [0, scale, offset[1]], [0, 0, 1.]])

        def render(rgb, mask, transform):
            # Premultiply color to avoid dark fringes from transparent padding.
            rgba = np.dstack([rgb * mask[..., None], mask * 255])
            return Image.fromarray(cv2.warpPerspective(
                rgba, transform, (SIZE, SIZE), flags=cv2.INTER_LINEAR))

        ref_view = render(ref, ref_mask, fit)
        item_view = render(item, item_mask, fit @ matrix)
    else:
        if ref_ok:
            ref, ref_mask = _upright(ref, ref_mask)
        if item_ok:
            item, item_mask = _upright(item, item_mask)
        ref_view = _box(ref, ref_mask, cv2.boundingRect(ref_mask))
        item_view = _box(item, item_mask, cv2.boundingRect(item_mask))
    return ref_view, item_view, segmented


def major_discrepancies(reference, query):
    """Highlight changed edges, allowing 3px for small alignment/interpolation errors."""
    ref, item = np.asarray(reference), np.asarray(query)
    shared = ((ref[..., 3] > 240) & (item[..., 3] > 240)).astype(np.uint8)
    shared = cv2.erode(shared, np.ones((9, 9), np.uint8))
    def edges(rgba):
        gray = cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2GRAY)
        return cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 45, 110) * shared
    ref_edges, item_edges = edges(ref), edges(item)
    ref_distance = cv2.distanceTransform((ref_edges == 0).astype(np.uint8), cv2.DIST_L2, 3)
    item_distance = cv2.distanceTransform((item_edges == 0).astype(np.uint8), cv2.DIST_L2, 3)
    changed = (((item_edges > 0) & (ref_distance > 3)) |
               ((ref_edges > 0) & (item_distance > 3))).astype(np.uint8)
    groups = cv2.dilate(changed, np.ones((9, 9), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(groups)
    candidates = []
    for label in range(1, count):
        x, y, width, height, _ = stats[label]
        support = int(changed[labels == label].sum())
        if support < 24 or max(width, height) < 18:
            continue
        candidates.append((support, {"x": int(x), "y": int(y), "width": int(width),
                                     "height": int(height),
                                     "max_anomaly": float(min(1, support / max(width * height, 1)))}))
    regions = [region for _, region in sorted(candidates, key=lambda pair: pair[0], reverse=True)[:8]]
    overlay = query.copy()
    draw = ImageDraw.Draw(overlay)
    for index, region in enumerate(regions, 1):
        x, y, width, height = (region[key] for key in ("x", "y", "width", "height"))
        draw.rectangle((x, y, x + width - 1, y + height - 1), outline="#e23427", width=3)
        draw.text((x + 4, y + 3), str(index), fill="#e23427", stroke_width=1)
    return overlay, regions
