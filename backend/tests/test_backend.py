from __future__ import annotations

import io
import json
from dataclasses import replace

import numpy as np
import pytest
import torch
import torch.nn.functional as F
from backend.algorithms import (
    Features,
    LocalMatch,
    align_query,
    geometric_match,
    letterbox,
    patch_distances,
    sift_match,
)
from backend.config import Settings
from backend.foreground import Foreground
from backend.main import create_app
from backend.schemas import Thresholds
from backend.service import VerificationService, decode_image, evaluate, render_discrepancies
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError


def png(color="orange", size=(160, 160)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


class FakeSegmenter:
    def prepare(self, image):
        return Foreground(image, np.ones((image.height, image.width), np.uint8), 1.0)


class FakeModels:
    """Deterministic dependency injection for contract tests; NOT a CV fallback."""

    loaded = True
    device = "cpu"

    def load(self):
        pass

    def features(self, image, valid_mask=None):
        mean = np.asarray(image).mean((0, 1)).astype(np.float32)
        vector = F.normalize(torch.tensor([*mean, 1.0]), dim=0)
        return Features(vector, vector.repeat(1024, 1), torch.ones(1024, dtype=torch.bool))

    def local_features(self, image, valid_mask=None):
        return image

    def match(self, ref, query, ref_size, *masks):
        matrix = np.diag([ref.width / query.width, ref.height / query.height, 1.0])
        return LocalMatch("ALIKED+LightGlue", 100, 90, 0.9, 0.8, 0.95, matrix)


@pytest.fixture
def configured(tmp_path):
    settings = Settings(data_dir=tmp_path)
    service = VerificationService(settings, models=FakeModels(), segmenter=FakeSegmenter())
    with TestClient(create_app(settings, service=service)) as client:
        yield settings, service, client


def enroll(client, product_id="orange-product", color="orange", barcode="12345"):
    return client.post(
        "/v1/products",
        data={"product_id": product_id, "name": product_id, "barcode": barcode},
        files=[("references", ("ref.png", png(color), "image/png"))],
    )


def verify(client, image=None, **data):
    return client.post(
        "/v1/verify", data=data, files={"file": ("query.png", image or png(), "image/png")}
    )


def test_health_and_openapi(configured):
    _, _, client = configured
    assert client.get("/v1/health").status_code == 200
    paths = client.get("/openapi.json").json()["paths"]
    assert {
        "/v1/products",
        "/v1/verify",
        "/v1/verify/batch",
        "/v1/results/{request_id}",
    } <= paths.keys()
    assert client.get("/v1/products").json() == {"products": []}


def test_enrollment_and_roundtrip_result(configured):
    _, _, client = configured
    registered = enroll(client)
    assert registered.status_code == 201, registered.text
    assert registered.json()["reference_count"] == 1
    assert client.get("/v1/products").json()["products"][0]["id"] == "orange-product"
    response = verify(client, expected_product_id="orange-product")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["decision"] == "consistent"
    assert 0 <= result["confidence"] <= 1
    assert result["confidence_type"] == "uncalibrated_visual_match"
    assert result["patchcore"]["anomaly_score"] < 1e-5
    assert not result["discrepancy_regions"]
    assert result["latency_ms"]["total"] > 0
    for url in [
        result["discrepancy_image_url"],
        result["heatmap_image_url"],
        *result["diagnostic_image_urls"].values(),
    ]:
        image = client.get(url)
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/png"
        Image.open(io.BytesIO(image.content)).verify()
    assert client.get(f"/v1/results/{result['request_id']}").json() == result


def test_duplicate_product_and_barcode(configured):
    _, _, client = configured
    assert enroll(client).status_code == 201
    assert enroll(client).status_code == 409
    assert enroll(client, product_id="different").status_code == 409


def test_catalog_persists_across_restart(configured):
    settings, _, client = configured
    assert enroll(client).status_code == 201
    restarted = VerificationService(settings, models=FakeModels(), segmenter=FakeSegmenter())
    assert restarted.products()[0]["id"] == "orange-product"


def test_barcode_and_claim_mismatch(configured):
    _, _, client = configured
    enroll(client)
    enroll(client, product_id="blue-product", color="blue", barcode="67890")
    matched = verify(client, barcode="12345").json()
    assert matched["expected_product_id"] == "orange-product"
    wrong = verify(client, barcode="67890").json()
    assert wrong["decision"] == "suspicious"
    assert not wrong["identity_consistent"]
    assert wrong["identified_product"]["id"] == "orange-product"
    assert wrong["compared_product"]["id"] == "blue-product"
    assert verify(client, barcode="unknown").status_code == 404
    assert verify(client, expected_product_id="missing").status_code == 404
    assert verify(client, barcode="12345", expected_product_id="orange-product").status_code == 422


def test_no_catalog(configured):
    _, _, client = configured
    assert verify(client).status_code == 409


def test_indistinguishable_catalog_items_require_identity_review(configured):
    _, _, client = configured
    enroll(client)
    enroll(client, product_id="identical-looking-sku", barcode="67890")
    response = verify(client, expected_product_id="identical-looking-sku")
    assert response.status_code == 200
    result = response.json()
    assert result["identity_ambiguous"]
    assert result["identity_consistent"]
    assert result["decision"] == "inconclusive"
    assert any("ambiguous" in warning for warning in result["warnings"])


@pytest.mark.parametrize(
    "data,mime,status",
    [
        (b"", "image/png", 400),
        (b"not an image", "image/png", 415),
        (png(), "text/plain", 415),
        (png(size=(32, 32)), "image/png", 422),
    ],
)
def test_bad_uploads(configured, data, mime, status):
    _, _, client = configured
    response = client.post("/v1/verify", files={"file": ("file.png", data, mime)})
    assert response.status_code == status, response.text


def test_limits_and_product_id_safety(configured):
    settings, _, client = configured
    assert (
        client.post(
            "/v1/products",
            data={"product_id": "../escape", "name": "x"},
            files={"references": ("ref.png", png(), "image/png")},
        ).status_code
        == 422
    )
    limited = replace(settings, max_upload_bytes=100)
    with TestClient(
        create_app(limited, service=VerificationService(limited, FakeModels(), FakeSegmenter()))
    ) as small:
        assert verify(small).status_code == 413
    with pytest.raises(Exception, match="pixel limit"):
        decode_image(png(size=(200, 200)), replace(settings, max_pixels=1000))


def test_reference_count_limit(configured):
    _, _, client = configured
    response = client.post(
        "/v1/products",
        data={"product_id": "x", "name": "x"},
        files=[("references", (f"{i}.png", png(), "image/png")) for i in range(9)],
    )
    assert response.status_code == 422


def test_batch_partial_failure_and_limits(configured):
    _, _, client = configured
    enroll(client)
    result = client.post(
        "/v1/verify/batch",
        files=[
            ("files", ("good.png", png(), "image/png")),
            ("files", ("bad.png", b"broken", "image/png")),
        ],
    )
    assert result.status_code == 200, result.text
    items = result.json()["results"]
    assert items[0]["result"]["decision"] == "consistent"
    assert items[1]["status_code"] == 415
    assert items[1]["error"]
    assert result.json()["aggregation"] == "independent_images"
    too_many = client.post("/v1/verify/batch", files=[("files", ("p.png", png(), "image/png"))] * 5)
    assert too_many.status_code == 422


def test_auth_and_cors(configured):
    settings, service, _ = configured
    with TestClient(
        create_app(replace(settings, api_key="test-secret"), service=service)
    ) as client:
        assert client.get("/v1/products").status_code == 401
        assert client.get("/v1/products", headers={"X-API-Key": "wrong"}).status_code == 401
        assert client.get("/v1/products", headers={"X-API-Key": "test-secret"}).status_code == 200
        request_id = "a" * 32
        assert client.get(f"/v1/results/{request_id}/discrepancy.png").status_code == 401
        allowed = client.options(
            "/v1/verify",
            headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
        )
        assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
        rejected = client.options(
            "/v1/verify",
            headers={
                "Origin": "https://untrusted.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert "access-control-allow-origin" not in rejected.headers


def test_protected_image_paths(configured):
    _, _, client = configured
    for endpoint in [
        "/v1/results/not-a-uuid/discrepancy.png",
        f"/v1/results/{'a' * 32}/catalog.json",
        "/v1/results/missing",
    ]:
        assert client.get(endpoint).status_code == 404


def test_request_body_limit_catches_chunked_upload(configured):
    settings, service, _ = configured

    # Override the combined limit independently of the per-file limit.
    class TinySettings(Settings):
        @property
        def max_request_bytes(self):
            return 128

    with TestClient(
        create_app(TinySettings(data_dir=settings.data_dir), service=service)
    ) as client:
        response = client.post("/v1/verify", files={"file": ("p.png", png(), "image/png")})
        assert response.status_code == 413, response.text


def test_failed_alignment_is_not_an_authenticity_decision(configured):
    _, service, client = configured
    enroll(client)
    service.models.match = lambda *args: LocalMatch("ALIKED+LightGlue", 0, 0, 0, 0, 0, None)
    response = verify(client).json()
    assert response["decision"] == "inconclusive"
    assert not response["geometry"]["alignment_valid"]
    assert response["patchcore"]["method"] == "unaligned_nearest_neighbor"


def test_auto_fallback_and_forced_aliked_error(configured, monkeypatch):
    _, service, client = configured
    enroll(client)

    def fail(*_args):
        raise RuntimeError("weights missing")

    service.models.local_features = fail
    monkeypatch.setattr(
        "backend.service.sift_match",
        lambda *_args: LocalMatch("SIFT+MAGSAC++", 0, 0, 0, 0, 0, None),
    )
    result = verify(client).json()
    assert result["geometry"]["backend"] == "SIFT+MAGSAC++"
    assert any("fallback" in warning for warning in result["warnings"])
    assert verify(client, local_backend="aliked").status_code == 503


def test_threshold_validation():
    with pytest.raises(ValidationError):
        Thresholds(patchcore_good=0.8, patchcore_bad=0.2)
    with pytest.raises(ValidationError):
        Thresholds(min_retrieval_cosine=1)


def test_patchcore_distances_and_real_visualization():
    torch.manual_seed(0)
    patches = F.normalize(torch.rand(16, 8), dim=-1)
    mask = torch.ones(16, dtype=torch.bool)
    features = Features(patches[0], patches, mask)
    for aligned in (True, False):
        anomaly, heat = patch_distances(features, [features], aligned)
        assert anomaly < 1e-5
        assert heat.shape == (4, 4)
        changed = Features(patches[0], -patches, mask)
        anomaly, _ = patch_distances(changed, [features], aligned)
        assert anomaly > 1
    image = Image.new("RGB", (160, 160), "white")
    boxed, valid = letterbox(image)
    assert valid.sum() == 448 * 448  # White products must not disappear.
    assert boxed.size == (448, 448)
    _, _, regions = render_discrepancies(image, image, None, np.zeros((32, 32)), 0.24)
    assert regions == []
    heat = np.zeros((32, 32), np.float32)
    heat[8:16, 8:16] = 0.8
    _, _, regions = render_discrepancies(image, image, None, heat, 0.24)
    assert len(regions) == 1
    assert regions[0]["width"] > 0


def test_geometry_and_degenerate_alignment():
    points = np.float32([[x, y] for x in (10, 50, 90) for y in (10, 50, 90)])
    matched = geometric_match(points, points, (100, 100), "test")
    assert matched.inliers == 9
    assert matched.homography is not None
    image = Image.new("RGB", (100, 100))
    assert align_query(image, matched.homography, image.size)[2]
    assert not align_query(image, None, image.size)[2]
    assert not align_query(image, np.diag([0.001, 0.001, 1.0]), image.size)[2]
    blank = sift_match(image, image)
    assert blank.matches == 0


def test_decision_bounds():
    confidence, _, decision, _ = evaluate(1, 1, 0, True, True, Thresholds())
    assert confidence == 1
    assert decision == "consistent"
    assert evaluate(1, 1, 0, False, True, Thresholds())[2] == "inconclusive"
    assert evaluate(1, 1, 0, True, False, Thresholds())[2] == "suspicious"


def test_reject_catalog_path_escape(configured):
    settings, service, _ = configured
    outside = settings.data_dir.parent / "not-a-reference.png"
    outside.write_bytes(png())
    service.catalog_path.write_text(
        json.dumps(
            {
                "products": [
                    {
                        "id": "x",
                        "references": [str(outside)],
                        "name": "x",
                        "sku": "x",
                    }
                ]
            }
        )
    )
    with pytest.raises(Exception, match="escapes"):
        service.verify(png())
