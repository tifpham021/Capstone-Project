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


def geometric_match(ref_points, query_points, ref_size, backend: str) -> LocalMatch:
    count = len(ref_points)
    if count < 4:
        return LocalMatch(backend, count, 0, 0, 0, 0, None)
    matrix, inlier_mask = cv2.findHomography(query_points, ref_points, cv2.RANSAC, 4.0)
    valid = np.zeros(count, bool) if inlier_mask is None else inlier_mask.ravel().astype(bool)
    inliers = int(valid.sum())
    coverage = (
        float(cv2.contourArea(cv2.convexHull(ref_points[valid]))) / (ref_size[0] * ref_size[1])
        if inliers >= 3
        else 0.0
    )
    ratio = inliers / count
    score = (
        0.50 * min(inliers / 60, 1)
        + 0.30 * float(np.clip((ratio - 0.08) / 0.52, 0, 1))
        + 0.20 * min(coverage / 0.15, 1)
    )
    if matrix is None or not np.isfinite(matrix).all() or inliers < 8 or coverage < 0.03:
        matrix = None
    return LocalMatch(backend, count, inliers, ratio, coverage, score, matrix)


def sift_match(reference: Image.Image, query: Image.Image) -> LocalMatch:
    sift = cv2.SIFT_create(nfeatures=2500)
    kp0, des0 = sift.detectAndCompute(cv2.cvtColor(np.asarray(reference), cv2.COLOR_RGB2GRAY), None)
    kp1, des1 = sift.detectAndCompute(cv2.cvtColor(np.asarray(query), cv2.COLOR_RGB2GRAY), None)
    if des0 is None or des1 is None:
        return LocalMatch("SIFT+RANSAC", 0, 0, 0, 0, 0, None)
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(des0, des1, k=2)
    good = [
        pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance
    ]
    pts0 = np.float32([kp0[m.queryIdx].pt for m in good]).reshape(-1, 2)
    pts1 = np.float32([kp1[m.trainIdx].pt for m in good]).reshape(-1, 2)
    return geometric_match(pts0, pts1, reference.size, "SIFT+RANSAC")


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
    def local_features(self, image: Image.Image) -> Any:
        self._load_local()
        tensor = torch.from_numpy(np.asarray(image).copy()).permute(2, 0, 1).float() / 255
        return self.extractor.extract(tensor, resize=1024)

    @torch.inference_mode()
    def match(self, ref_features, query_features, ref_size):
        from lightglue.utils import rbd

        matched = rbd(self.matcher({"image0": ref_features, "image1": query_features}))
        ref, query = rbd(ref_features), rbd(query_features)
        pairs = matched["matches"].cpu().numpy()
        pts0 = ref["keypoints"][pairs[:, 0]].cpu().numpy()
        pts1 = query["keypoints"][pairs[:, 1]].cpu().numpy()
        return geometric_match(pts0, pts1, ref_size, "ALIKED+LightGlue")
