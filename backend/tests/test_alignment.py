"""Geometry/segmentation regressions; no downloaded models required."""

from __future__ import annotations

import cv2
import numpy as np
import torch
from backend.algorithms import Features, Models, align_foreground, geometric_match, patch_distances
from backend.config import Settings
from backend.foreground import Foreground, crop_foreground
from backend.schemas import Thresholds
from backend.service import evaluate
from backend.tests.test_backend import configured as configured
from backend.tests.test_backend import enroll, png, verify
from PIL import Image


def test_crop_excludes_background_and_preserves_detached_parts():
    image = Image.new("RGB", (200, 200), "blue")
    mask = np.zeros((200, 200), np.uint8)
    mask[50:150, 60:140] = 255
    mask[155:165, 145:155] = 255  # Detached piece must not be discarded.
    result = crop_foreground(image, mask)
    assert result.valid
    assert result.image.width < image.width
    assert result.mask.sum() == 8100
    assert (np.asarray(result.image)[result.mask == 0] == 255).all()
    assert (np.asarray(result.image)[result.mask > 0] == [0, 0, 255]).all()
    assert not crop_foreground(image, np.zeros_like(mask)).valid


def test_magsac_recovers_perspective_with_outliers():
    rng = np.random.default_rng(5)
    query = rng.uniform(30, 370, (100, 2)).astype(np.float32)
    expected = np.array([[0.9, 0.03, 12], [-0.02, 0.95, 17], [0.0001, -0.0002, 1]])
    reference = cv2.perspectiveTransform(query[:, None], expected)[:, 0]
    reference[:25] = rng.uniform(0, 400, (25, 2))
    match = geometric_match(reference, query, (400, 400), "test")
    assert match.homography is not None
    assert match.inliers >= 70
    assert match.median_reprojection_error < 0.01
    predicted = cv2.perspectiveTransform(query[25:, None], match.homography)[:, 0]
    assert np.max(np.linalg.norm(predicted - reference[25:], axis=1)) < 0.01


def test_small_cluster_does_not_establish_whole_object_alignment():
    points = np.float32([[x, y] for x in (10, 20, 30, 40) for y in (10, 20, 30, 40)])
    match = geometric_match(points, points, (400, 400), "test")
    assert match.inliers == 16
    assert match.homography is None
    assert "cover" in match.rejection_reason


def test_coverage_is_relative_to_object_and_checked_in_both_images():
    mask = np.zeros((400, 400), np.uint8)
    mask[100:200, 100:200] = 1
    points = np.float32([[x, y] for x in (110, 150, 190) for y in (110, 150, 190)])
    match = geometric_match(points, points, (400, 400), "test", mask, mask)
    assert match.homography is not None
    assert match.coverage > 0.6
    wide = np.ones_like(mask)
    match = geometric_match(points, points, (400, 400), "test", mask, wide)
    assert match.homography is None
    assert match.query_coverage < 0.15


def test_alignment_keeps_silhouette_evidence_outside_shared_foreground():
    image = Image.new("RGB", (100, 100), "white")
    ref_mask = np.zeros((100, 100), np.uint8)
    ref_mask[10:90, 10:90] = 1
    query_mask = ref_mask.copy()
    query_mask[10:30, 10:90] = 0
    _, common, valid, iou, difference = align_foreground(
        image, np.eye(3), image, query_mask, ref_mask
    )
    assert valid
    assert iou == 0.75
    assert common.sum() == 4800
    assert difference.sum() == 1600
    assert not (common & difference).any()
    shifted = np.eye(3)
    shifted[0, 2] = 70
    assert not align_foreground(image, shifted, image, ref_mask, ref_mask)[2]


def test_masked_aliked_keypoints_and_descriptors_stay_in_sync():
    model = Models(Settings(device="cpu"))

    class Extractor:
        def extract(self, *_args, **_kwargs):
            return {
                "keypoints": torch.tensor([[[4.0, 4.0], [50.0, 50.0], [96.0, 96.0]]]),
                "descriptors": torch.arange(9).reshape(1, 3, 3),
                "keypoint_scores": torch.ones(1, 3),
                "image_size": torch.tensor([[100.0, 100.0]]),
            }

    model.extractor = Extractor()
    mask = np.zeros((100, 100), np.uint8)
    mask[20:80, 20:80] = 1
    features = model.local_features(Image.new("RGB", (100, 100)), mask)
    assert features["keypoints"].shape == (1, 1, 2)
    assert features["descriptors"].tolist() == [[[3, 4, 5]]]
    assert features["keypoint_scores"].shape == (1, 1)
    assert features["image_size"].shape == (1, 2)


def test_patchcore_ignores_background_anomalies():
    patches = torch.tensor([[1.0, 0.0]]).repeat(16, 1)
    mask = torch.zeros(16, dtype=torch.bool)
    mask[5:10] = True
    changed = patches.clone()
    changed[~mask] = -changed[~mask]
    reference = Features(patches[0], patches, mask)
    query = Features(patches[0], changed, mask)
    for aligned in (False, True):
        anomaly, heat = patch_distances(query, [reference], aligned)
        assert anomaly == 0
        assert heat.sum() == 0


def test_geometry_is_comparison_quality_not_authenticity():
    assert evaluate(1, 0.1, 0, True, True, Thresholds())[2] == "consistent"
    assert evaluate(1, 1, 0, False, True, Thresholds())[2] == "inconclusive"


def test_segmentation_reused_for_references_and_masks_reach_matcher(configured):
    _, service, client = configured
    calls = []

    def prepare(image):
        calls.append(image.size)
        mask = np.ones((image.height, image.width), np.uint8)
        mask[:10] = 0
        return Foreground(image, mask, 0.9)

    service.segmenter.prepare = prepare
    original = service.models.match

    def match(ref, query, size, ref_mask, query_mask, query_size):
        assert ref_mask[:10].sum() == 0
        assert query_mask[:10].sum() == 0
        return original(ref, query, size)

    service.models.match = match
    enroll(client)
    for _ in range(2):
        result = verify(client).json()
        assert result["geometry"]["estimator"] == "USAC_MAGSAC"
        assert result["geometry"]["foreground_iou"] == 1
        assert result["segmentation"]["valid"]
        assert result["latency_ms"]["segmentation"] > 0
    assert len(calls) == 3  # Reference once; query on each request.


def test_empty_query_segmentation_cannot_authenticate(configured):
    _, service, client = configured
    enroll(client)
    verify(client)  # Cache valid references first.

    def empty(image):
        return crop_foreground(image, np.zeros((image.height, image.width), np.uint8))

    service.segmenter.prepare = empty
    result = verify(client).json()
    assert result["decision"] == "inconclusive"
    assert not result["segmentation"]["valid"]
    assert not result["geometry"]["alignment_valid"]


def test_missing_segmentation_model_returns_actionable_error(configured):
    _, service, client = configured
    enroll(client)
    verify(client)

    def fail(_image):
        raise RuntimeError("weights unavailable")

    service.segmenter.prepare = fail
    response = verify(client)
    assert response.status_code == 503
    assert "segmentation" in response.json()["detail"]


def test_invalid_reference_foreground_requires_replacement(configured):
    _, service, client = configured
    enroll(client)
    service.segmenter.prepare = lambda image: crop_foreground(
        image, np.zeros((image.height, image.width), np.uint8)
    )
    response = verify(client)
    assert response.status_code == 422
    assert "reference" in response.json()["detail"].lower()


def test_outline_discrepancy_is_preserved_when_appearance_matches(configured):
    _, service, client = configured
    enroll(client)
    verify(client)

    def missing_section(image):
        mask = np.ones((image.height, image.width), np.uint8)
        mask[:60] = 0
        return Foreground(image, mask, 0.625)

    service.segmenter.prepare = missing_section
    result = verify(client).json()
    assert result["geometry"]["alignment_valid"]
    assert result["patchcore"]["anomaly_score"] < 1e-5
    assert result["decision"] == "suspicious"
    assert result["discrepancy_regions"]
    assert any("outlines" in reason for reason in result["reasons"])


def test_closest_reference_view_is_attempted_first(configured):
    _, _, client = configured
    response = client.post(
        "/v1/products",
        data={"product_id": "multi", "name": "Multi-view"},
        files=[
            ("references", ("orange.png", png(), "image/png")),
            ("references", ("blue.png", png("blue"), "image/png")),
        ],
    )
    assert response.status_code == 201
    result = verify(client, image=png("blue")).json()
    assert result["geometry"]["reference_index"] == 1
    assert result["geometry"]["references_attempted"] == 1


def test_alternate_reference_attempted_when_first_does_not_align(configured):
    _, service, client = configured
    client.post(
        "/v1/products",
        data={"product_id": "multi", "name": "Multi-view"},
        files=[("references", (f"{i}.png", png(), "image/png")) for i in range(3)],
    ).raise_for_status()
    original = service.models.match
    calls = []

    def match(*args):
        calls.append(1)
        result = original(*args)
        if len(calls) == 1:
            result.homography = None
        return result

    service.models.match = match
    result = verify(client).json()
    assert result["geometry"]["reference_index"] == 1
    assert result["geometry"]["references_attempted"] == 2
    assert len(calls) == 2
