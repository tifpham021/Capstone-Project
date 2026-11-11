"""Frozen DINOv2 + PatchCore-style distances and ALIKED/LightGlue geometry.

No benchmark runner, user-specific paths, demo photos or model weights are required
by this module. Models download once on first use and stay cached in memory/disk.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass
from typing import Any

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from backend.config import Settings

LOG = logging.getLogger(__name__)
IMAGE_SIZE = 448
GRID_SIZE = IMAGE_SIZE // 14
DINO_REPO = "facebookresearch/dinov2:7764ea0f912e53c92e82eb78a2a1631e92725fc8"


def choose_device(requested: str) -> torch.device:
    if requested not in {"auto", "cpu", "mps", "cuda"}:
        raise ValueError("RETURNSCAN_DEVICE must be auto, cpu, mps or cuda")
    if requested == "auto":
        requested = (
            "cuda"
            if torch.cuda.is_available()
            else ("mps" if torch.backends.mps.is_available() else "cpu")
        )
    if requested == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is not available on this host")
    if requested == "mps" and not torch.backends.mps.is_available():
        raise ValueError("Apple Metal/MPS is not available on this host")
    return torch.device(requested)


def letterbox(image: Image.Image, valid_mask: np.ndarray | None = None):
    """Exclude only padding/invalid warp pixels, not arbitrary white products."""
    scale = IMAGE_SIZE / max(image.size)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    x, y = (IMAGE_SIZE - size[0]) // 2, (IMAGE_SIZE - size[1]) // 2
    boxed = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), "white")
    boxed.paste(image.resize(size, Image.Resampling.LANCZOS), (x, y))
    mask = np.zeros((IMAGE_SIZE, IMAGE_SIZE), np.uint8)
    source = np.ones((image.height, image.width), np.uint8) if valid_mask is None else valid_mask
    mask[y : y + size[1], x : x + size[0]] = cv2.resize(
        source, size, interpolation=cv2.INTER_NEAREST
    )
    return boxed, mask


@dataclass
class Features:
    global_feature: torch.Tensor
    patches: torch.Tensor
    mask: torch.Tensor


@dataclass
class LocalMatch:
    backend: str
    matches: int
    inliers: int
    inlier_ratio: float
    coverage: float
    score: float
    homography: np.ndarray | None
    query_coverage: float = 0.0
    median_reprojection_error: float | None = None
    rejection_reason: str | None = None


def foreground_coverage(points, size, mask=None):
    """Inlier hull coverage relative to the object, rather than the whole photograph."""
    if len(points) < 3:
        return 0.0
    hull = cv2.convexHull(np.float32(points))
    if mask is None:
        return float(cv2.contourArea(hull)) / (size[0] * size[1])
    support = np.zeros(mask.shape, np.uint8)
    cv2.fillConvexPoly(support, np.rint(hull).astype(np.int32), 1)
    return float(np.count_nonzero(support & mask)) / max(1, np.count_nonzero(mask))


def geometric_match(
    ref_points,
    query_points,
    ref_size,
    backend: str,
    ref_mask=None,
    query_mask=None,
    query_size=None,
) -> LocalMatch:
    ref_points, query_points = np.float32(ref_points), np.float32(query_points)
    count = len(ref_points)
    if count < 4:
        return LocalMatch(backend, count, 0, 0, 0, 0, None, rejection_reason="Too few matches")
    query_size = query_size or ref_size
    matrix, inlier_mask = cv2.findHomography(
        query_points,
        ref_points,
        cv2.USAC_MAGSAC,
        max(2.0, max(ref_size) * 4 / 1024),
        maxIters=10000,
        confidence=0.999,
    )
    valid = np.zeros(count, bool) if inlier_mask is None else inlier_mask.ravel().astype(bool)
    inliers = int(valid.sum())
    coverage = foreground_coverage(ref_points[valid], ref_size, ref_mask)
    query_coverage = foreground_coverage(query_points[valid], query_size, query_mask)
    ratio = inliers / count
    score = (
        0.50 * min(inliers / 60, 1)
        + 0.30 * float(np.clip((ratio - 0.08) / 0.52, 0, 1))
        + 0.20 * min(min(coverage, query_coverage) / 0.30, 1)
    )
    error, reason = None, None
    if matrix is None or not np.isfinite(matrix).all():
        reason = "Homography estimation failed"
    elif inliers < 8 or ratio < 0.20:
        reason = "Too few consistent foreground matches"
    elif min(coverage, query_coverage) < 0.15:
        reason = "Inliers cover too little of the foreground"
    else:
        try:
            forward = cv2.perspectiveTransform(query_points[valid, None], matrix)[:, 0]
            backward = cv2.perspectiveTransform(ref_points[valid, None], np.linalg.inv(matrix))[
                :, 0
            ]
            errors = 512 * (
                np.linalg.norm(forward - ref_points[valid], axis=1) / max(ref_size)
                + np.linalg.norm(backward - query_points[valid], axis=1) / max(query_size)
            )
            error = float(np.median(errors))
            if not np.isfinite(errors).all() or error > 4 or np.quantile(errors, 0.9) > 8:
                reason = "Symmetric reprojection error is too high"
        except np.linalg.LinAlgError:
            reason = "Homography is singular"
    if reason:
        matrix = None
    return LocalMatch(
        backend, count, inliers, ratio, coverage, score, matrix, query_coverage, error, reason
    )


def sift_match(
    reference: Image.Image, query: Image.Image, ref_mask=None, query_mask=None
) -> LocalMatch:
    sift = cv2.SIFT_create(nfeatures=2500)
    kp0, des0 = sift.detectAndCompute(
        cv2.cvtColor(np.asarray(reference), cv2.COLOR_RGB2GRAY),
        None if ref_mask is None else ref_mask * 255,
    )
    kp1, des1 = sift.detectAndCompute(
        cv2.cvtColor(np.asarray(query), cv2.COLOR_RGB2GRAY),
        None if query_mask is None else query_mask * 255,
    )
    if des0 is None or des1 is None:
        return LocalMatch("SIFT+MAGSAC++", 0, 0, 0, 0, 0, None)
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(des0, des1, k=2)
    good = [
        pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance
    ]
    pts0 = np.float32([kp0[m.queryIdx].pt for m in good]).reshape(-1, 2)
    pts1 = np.float32([kp1[m.trainIdx].pt for m in good]).reshape(-1, 2)
    return geometric_match(
        pts0, pts1, reference.size, "SIFT+MAGSAC++", ref_mask, query_mask, query.size
    )


def align_query(image: Image.Image, matrix: np.ndarray | None, ref_size):
    if matrix is None:
        return image, None, False
    # Reject fits mapping only a tiny fragment (or a degenerate plane) into view.
    corners = np.float32([[0, 0], [image.width, 0], [image.width, image.height], [0, image.height]])
    projected = cv2.perspectiveTransform(corners[None], matrix)[0]
    if not np.isfinite(projected).all() or not cv2.isContourConvex(projected):
        return image, None, False
    area_ratio = abs(cv2.contourArea(projected)) / (ref_size[0] * ref_size[1])
    if not 0.1 <= area_ratio <= 10:
        return image, None, False
    valid = cv2.warpPerspective(np.ones((image.height, image.width), np.uint8), matrix, ref_size)
    if float(valid.mean()) < 0.35:
        return image, None, False
    warped = cv2.warpPerspective(
        np.asarray(image),
        matrix,
        ref_size,
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    return Image.fromarray(warped), valid, True


def align_foreground(image, matrix, reference, query_mask, ref_mask):
    """Validate visibility and keep silhouette differences separate from shared pixels."""
    aligned, support, valid = align_query(image, matrix, reference.size)
    if not valid:
        return image, query_mask, False, None, None
    warped_mask = (
        cv2.warpPerspective(query_mask, matrix, reference.size, flags=cv2.INTER_NEAREST) > 0
    )
    ref_mask = ref_mask > 0
    common = warped_mask & ref_mask
    union = warped_mask | ref_mask
    overlap = int(common.sum())
    iou = overlap / max(1, int(union.sum()))
    visible = int((ref_mask & (support > 0)).sum()) / max(1, int(ref_mask.sum()))
    if visible < 0.70 or overlap / max(1, min(int(ref_mask.sum()), int(warped_mask.sum()))) < 0.50:
        return image, query_mask, False, iou, None
    differences = (warped_mask ^ ref_mask) & (support > 0)
    return aligned, common.astype(np.uint8), True, iou, differences.astype(np.uint8)


@torch.inference_mode()
def patch_distances(query: Features, references: list[Features], aligned: bool):
    """Nearest-neighbour cosine distances. Alignment restricts search spatially."""
    patches, mask = query.patches, query.mask
    side = math.isqrt(len(patches))
    if not references or not mask.any():
        raise ValueError("No valid reference/query patches")
    if aligned:
        refs = torch.stack([r.patches for r in references]).reshape(len(references), side, side, -1)
        rms = torch.stack([r.mask for r in references]).reshape(len(references), side, side)
        q = patches.reshape(side, side, -1)
        best = torch.full((side, side), 2.0, device=patches.device)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                y0, y1, x0, x1 = (
                    max(0, -dy),
                    min(side, side - dy),
                    max(0, -dx),
                    min(side, side - dx),
                )
                ref = refs[:, y0 + dy : y1 + dy, x0 + dx : x1 + dx]
                valid = rms[:, y0 + dy : y1 + dy, x0 + dx : x1 + dx]
                similarity = (ref * q[y0:y1, x0:x1]).sum(-1).masked_fill(~valid, -1)
                best[y0:y1, x0:x1] = torch.minimum(best[y0:y1, x0:x1], 1 - similarity.amax(0))
        distances = best.flatten().clamp(0, 2)
    else:
        bank = torch.cat([r.patches[r.mask] for r in references])
        if len(bank) == 0:
            raise ValueError("No valid reference patches")
        distances = torch.cat([1 - (part @ bank.T).amax(1) for part in patches.split(128)]).clamp(
            0, 2
        )
    anomaly = float(torch.quantile(distances[mask], 0.95).cpu())
    heat = distances.masked_fill(~mask, 0).reshape(side, side).cpu().numpy()
    return anomaly, heat


class Models:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.device = choose_device(settings.device)
        self.dino = None
        self.extractor = None
        self.matcher = None
        self.local_unavailable = False

    @property
    def loaded(self):
        return self.dino is not None

    def load(self):
        if self.dino is not None:
            return
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        cache = self.settings.model_cache or self.settings.data_dir / "models"
        cache.mkdir(parents=True, exist_ok=True)
        torch.hub.set_dir(str(cache))
        if self.settings.dino_source:
            model = torch.hub.load(self.settings.dino_source, "dinov2_vits14", source="local")
        else:
            model = torch.hub.load(DINO_REPO, "dinov2_vits14", trust_repo=True)
        self.dino = model.eval().requires_grad_(False).to(self.device)

    @torch.inference_mode()
    def features(self, image: Image.Image, valid_mask=None) -> Features:
        self.load()
        boxed, valid = letterbox(image, valid_mask)
        tensor = torch.from_numpy(np.asarray(boxed).copy()).permute(2, 0, 1).float() / 255
        mean = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
        std = torch.tensor([0.229, 0.224, 0.225])[:, None, None]
        output = self.dino.forward_features(((tensor - mean) / std)[None].to(self.device))
        patch_valid = (
            cv2.resize(
                valid.astype(np.float32), (GRID_SIZE, GRID_SIZE), interpolation=cv2.INTER_AREA
            )
            > 0.65
        )
        return Features(
            F.normalize(output["x_norm_clstoken"].float(), dim=-1)[0],
            F.normalize(output["x_norm_patchtokens"].float(), dim=-1)[0],
            torch.from_numpy(patch_valid.flatten()).to(self.device),
        )

    def _load_local(self):
        if self.extractor is not None:
            return
        if self.local_unavailable:
            raise RuntimeError("ALIKED/LightGlue is unavailable; use local_backend=sift")
        try:
            from lightglue import ALIKED, LightGlue

            # Local matching stays on CPU: portable and reliable on Apple Silicon.
            extractor = ALIKED(max_num_keypoints=2048).eval()
            matcher = LightGlue(features="aliked").eval()
            self.extractor, self.matcher = extractor, matcher
        except Exception:
            self.local_unavailable = True
            LOG.exception("Could not initialize ALIKED/LightGlue")
            raise

    @torch.inference_mode()
    def local_features(self, image: Image.Image, valid_mask=None) -> Any:
        self._load_local()
        tensor = torch.from_numpy(np.asarray(image).copy()).permute(2, 0, 1).float() / 255
        features = self.extractor.extract(tensor, resize=1024)
        if valid_mask is not None:
            points = features["keypoints"][0].cpu().numpy()
            # Descriptor neighborhoods near the cutout edge include synthetic background.
            interior = cv2.erode(valid_mask, np.ones((5, 5), np.uint8))
            x = np.clip(np.rint(points[:, 0]).astype(int), 0, image.width - 1)
            y = np.clip(np.rint(points[:, 1]).astype(int), 0, image.height - 1)
            keep = torch.from_numpy(interior[y, x] > 0)
            for key in ("keypoints", "descriptors", "keypoint_scores"):
                if key in features:
                    features[key] = features[key][:, keep]
        return features

    @torch.inference_mode()
    def match(
        self,
        ref_features,
        query_features,
        ref_size,
        ref_mask=None,
        query_mask=None,
        query_size=None,
    ):
        from lightglue.utils import rbd

        if min(ref_features["keypoints"].shape[1], query_features["keypoints"].shape[1]) < 4:
            return LocalMatch(
                "ALIKED+LightGlue",
                0,
                0,
                0,
                0,
                0,
                None,
                rejection_reason="Too few foreground keypoints",
            )
        matched = rbd(self.matcher({"image0": ref_features, "image1": query_features}))
        ref, query = rbd(ref_features), rbd(query_features)
        pairs = matched["matches"].cpu().numpy()
        pts0 = ref["keypoints"][pairs[:, 0]].cpu().numpy()
        pts1 = query["keypoints"][pairs[:, 1]].cpu().numpy()
        return geometric_match(
            pts0, pts1, ref_size, "ALIKED+LightGlue", ref_mask, query_mask, query_size
        )
