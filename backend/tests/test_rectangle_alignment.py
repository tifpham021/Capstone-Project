"""Default rectangle path, including orientation and real image/mask warping."""

from __future__ import annotations

import io

import cv2
import numpy as np
import pytest
import torch
import torch.nn.functional as F
from backend.algorithms import Features, letterbox
from backend.alignment import RectangleError, rectify_rectangle
from backend.config import Settings
from backend.foreground import Foreground, crop_foreground
from backend.main import create_app
from backend.service import VerificationService
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw


class SpatialModels:
    """Pixel descriptors retain spatial/rotation information; never used by the API."""

    loaded = True
    device = "cpu"

    def load(self):
        pass

    def features(self, image, valid_mask=None):
        boxed, mask = letterbox(image, valid_mask)
        rgb = cv2.resize(np.asarray(boxed), (32, 32), interpolation=cv2.INTER_AREA)
        patches = torch.from_numpy(rgb.reshape(-1, 3).copy()).float()
        patches = F.normalize(torch.cat([patches, torch.full((1024, 1), 50.0)], dim=1), dim=-1)
        valid = cv2.resize(mask.astype(np.float32), (32, 32), interpolation=cv2.INTER_AREA) > 0.65
        global_feature = F.normalize(patches.mean(0), dim=0)
        return Features(global_feature, patches, torch.from_numpy(valid.flatten()))

    def local_features(self, *_args):
        raise AssertionError("Default rectangle alignment must not load ALIKED/LightGlue")


class SyntheticSegmenter:
    def prepare(self, image):
        # Synthetic fixture only; real API still uses U2Netp.
        mask = (np.asarray(image).min(-1) < 240).astype(np.uint8) * 255
        return crop_foreground(image, mask)


def encode(image):
    stream = io.BytesIO()
    image.save(stream, "PNG")
    return stream.getvalue()


def patterned_object():
    image = Image.new("RGB", (200, 300), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((40, 30, 159, 269), fill=(90, 90, 90))
    draw.rectangle((45, 35, 95, 95), fill=(210, 20, 20))
    draw.rectangle((105, 190, 150, 255), fill=(20, 20, 210))
    draw.rectangle((110, 45, 150, 85), fill=(20, 210, 20))
    return image


@pytest.fixture
def rectangle_api(tmp_path):
    settings = Settings(data_dir=tmp_path)
    service = VerificationService(settings, SpatialModels(), SyntheticSegmenter())
    with TestClient(create_app(settings, service)) as client:
        reference = patterned_object()
        response = client.post(
            "/v1/products",
            data={"product_id": "object", "name": "Object"},
            files={"references": ("ref.png", encode(reference), "image/png")},
        )
        assert response.status_code == 201
        yield service, client, reference


@pytest.mark.parametrize("turns", [0, 1, 2, 3])
def test_default_corrects_quarter_turns_without_local_feature_matches(rectangle_api, turns):
    _, client, reference = rectangle_api
    query = reference.rotate(turns * 90, expand=True)
    response = client.post("/v1/verify", files={"file": ("q.png", encode(query), "image/png")})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["geometry"]["alignment_method"] == "rectangle"
    assert result["geometry"]["alignment_quality"] == "outline_only"
    assert result["geometry"]["alignment_valid"]
    assert result["geometry"]["matches"] == 0
    assert result["patchcore"]["method"] == "aligned_spatial"
    assert result["patchcore"]["anomaly_score"] < 0.02
    ref = Image.open(io.BytesIO(client.get(result["diagnostic_image_urls"]["reference"]).content))
    aligned = Image.open(io.BytesIO(client.get(result["diagnostic_image_urls"]["aligned"]).content))
    assert aligned.size == ref.size
    assert np.abs(np.asarray(aligned).astype(float) - np.asarray(ref)).mean() < 3


def test_perspective_corners_map_to_shared_canvas():
    mask = np.zeros((340, 240), np.uint8)
    cv2.fillConvexPoly(mask, np.int32([[40, 30], [190, 50], [210, 300], [20, 280]]), 1)
    image = Image.fromarray(np.repeat((mask * 150)[..., None], 3, axis=2))
    view = rectify_rectangle(image, mask)
    assert view.estimator == "contour_quadrilateral"
    mapped = cv2.perspectiveTransform(view.corners[None], view.matrix)[0]
    assert np.allclose(mapped[0], (16, 16), atol=0.01)
    assert np.allclose(mapped[2], (view.image.width - 17, view.image.height - 17), atol=0.01)
    assert view.mask[view.image.height // 2, view.image.width // 2] == 1


def test_round_outline_uses_enclosing_rectangle_and_keeps_foreground():
    mask = np.zeros((200, 200), np.uint8)
    cv2.circle(mask, (100, 100), 70, 1, -1)
    view = rectify_rectangle(Image.new("RGB", (200, 200)), mask)
    assert view.estimator == "minimum_area_rectangle"
    support = cv2.warpPerspective(
        np.ones(view.mask.shape, np.uint8),
        np.linalg.inv(view.matrix),
        (200, 200),
        flags=cv2.INTER_NEAREST,
    )
    assert np.count_nonzero(support & mask) / int(mask.sum()) > 0.99


def test_detached_piece_is_included_in_rectangle():
    mask = np.zeros((220, 250), np.uint8)
    mask[30:180, 60:160] = 1
    mask[160:170, 190:200] = 1
    view = rectify_rectangle(Image.new("RGB", (250, 220)), mask)
    point = cv2.perspectiveTransform(np.float32([[[195, 165]]]), view.matrix)[0, 0]
    assert view.mask[round(float(point[1])), round(float(point[0]))] == 1


def test_degenerate_foreground_does_not_produce_transform():
    image = Image.new("RGB", (200, 200))
    for mask in [np.zeros((200, 200), np.uint8), np.eye(200, dtype=np.uint8)]:
        with pytest.raises(RectangleError):
            rectify_rectangle(image, mask)


def test_failed_rectangle_does_not_expose_unaligned_image_as_aligned(rectangle_api):
    service, client, reference = rectangle_api
    # Cache valid reference first.
    client.post(
        "/v1/verify", files={"file": ("q.png", encode(reference), "image/png")}
    ).raise_for_status()

    def invalid(image):
        mask = np.eye(image.height, image.width, dtype=np.uint8)
        return Foreground(image, mask, float(mask.mean()))

    service.segmenter.prepare = invalid
    # Keep feature mask usable to reach rectangle rejection in this synthetic fixture.
    original = service.models.features

    def features(image, valid_mask=None):
        return original(image)

    service.models.features = features
    response = client.post("/v1/verify", files={"file": ("q.png", encode(reference), "image/png")})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["decision"] == "inconclusive"
    assert result["geometry"]["alignment_quality"] == "failed"
    assert "aligned" not in result["diagnostic_image_urls"]
    assert client.get(f"/v1/results/{result['request_id']}/aligned.png").status_code == 404
