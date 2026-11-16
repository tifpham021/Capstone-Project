"""Fast camera-only crop for the current metal-table inspection station."""


def object_bounds(im):
    """Return a padded central-object box, or None to preserve the full view."""
    import cv2
    import numpy as np

    h, w = im.shape[:2]
    s = min(1.0, 320 / w)
    a = cv2.resize(im, (320, round(h * s)), interpolation=cv2.INTER_AREA)
    g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(a, cv2.COLOR_BGR2HSV)
    H, W = g.shape
    components = []
    # Segment light and dark objects separately: joining both masks lets a
    # bright product connect to dark table scratches and become one huge blob.
    for pixels in (
        (g < 100) & (hsv[:, :, 1] < 140),
        (g > 195) & (hsv[:, :, 1] < 100),
    ):
        mask = np.uint8(pixels) * 255
        mask[: int(H * 0.30)] = 0
        mask[int(H * 0.97) :] = 0
        mask[:, : int(W * 0.14)] = 0
        mask[:, int(W * 0.86) :] = 0
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        _, _, stats, centroids = cv2.connectedComponentsWithStats(mask)
        components.extend(zip(stats[1:], centroids[1:]))
    candidates = []
    for (x, y, bw, bh, area), (cx, cy) in components:
        if area < 20 or area > H * W * 0.22 or bw > W * 0.65 or bh > H * 0.55:
            continue
        # Thin scratches and disconnected shadows are poor product candidates.
        if area / (bw * bh) < 0.4:
            continue
        # Ignore incomplete table edges/glare before ranking so they cannot
        # hide a valid product elsewhere in the inspection region.
        if (
            x <= int(W * 0.14)
            or y <= int(H * 0.30)
            or x + bw >= int(W * 0.86)
            or y + bh >= int(H * 0.97)
        ):
            continue
        dist = ((cx / W - 0.5) / 0.35) ** 2 + ((cy / H - 0.65) / 0.4) ** 2
        score = area**0.4 * np.exp(-dist * 2)
        candidates.append((score, (x, y, bw, bh), area))
    if not candidates:
        return None
    score, (x, y, bw, bh), area = max(candidates)
    if score < 2.2:
        return None
    pad = max(12, round(max(bw, bh) * 0.3))
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(W, x + bw + pad)
    y1 = min(H, y + bh + pad)
    box = tuple(round(v / s) for v in (x0, y0, x1, y1))
    # The verification decoder requires at least 64 pixels on each side.
    if box[2] - box[0] < 64 or box[3] - box[1] < 64:
        return None
    return box


def adaptive_crop(frame):
    """Keep native pixels and use the full frame when no safe crop is found."""
    bounds = object_bounds(frame)
    if bounds is None:
        return frame
    x0, y0, x1, y1 = bounds
    return frame[y0:y1, x0:x1].copy()
