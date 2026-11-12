"""Provider contract, decision semantics and saved-photo/result delivery."""

import io
import json

import httpx
import pytest
from backend.config import Settings
from backend.main import create_app
from backend.vision import LunaClient, LunaVerificationService
from fastapi.testclient import TestClient
from PIL import Image


def png(color="gray"):
    buffer = io.BytesIO()
    Image.new("RGB", (200, 300), color).save(buffer, "PNG")
    return buffer.getvalue()


def assessment(mismatch=False):
    return {
        "verdict": "discrepancy_detected" if mismatch else "visually_consistent",
        "verdict_confidence": 0.98,
        "reference_index": 0,
        "flags": {
            name: {
                "status": "present"
                if name == "different_item" and mismatch
                else "unknown"
                if name == "counterfeit_evidence"
                else "absent",
                "confidence": 0.96,
                "evidence": name,
            }
            for name in [
                "damage",
                "different_item",
                "missing_parts",
                "counterfeit_evidence",
                "insufficient_visual_evidence",
            ]
        },
        "discrepancies": [
            {
                "category": "different_item",
                "description": "Camera layout differs",
                "confidence": 0.98,
                "reference_box": [100, 100, 400, 300],
                "query_box": [200, 200, 600, 500],
            }
        ]
        if mismatch
        else [],
    }


@pytest.fixture
def setup(tmp_path):
    settings = Settings(data_dir=tmp_path, openai_api_key="test-not-a-secret")
    state = {"assessment": assessment(), "calls": [], "status": 200}

    def provider(request):
        payload = json.loads(request.content)
        state["calls"].append(payload)
        if state["status"] != 200:
            return httpx.Response(state["status"], json={"error": settings.openai_api_key})
        if state.get("response"):
            return httpx.Response(200, json=state["response"])
        value = state["assessment"]
        if payload["text"]["format"]["name"] == "catalog_identification":
            value = {"product_id": "phone"}
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": json.dumps(value)}],
                    }
                ],
            },
        )

    service = LunaVerificationService(settings, LunaClient(settings, httpx.MockTransport(provider)))
    with TestClient(create_app(settings, service=service)) as client:
        yield client, service, state
    service.client.close()


def enroll(client):
    response = client.post(
        "/v1/products",
        data={"product_id": "phone", "name": "Phone", "barcode": "123"},
        files=[("references", ("ref.png", png(), "image/png"))],
    )
    assert response.status_code == 201, response.text


def test_default_engine_needs_no_local_models(tmp_path):
    client = TestClient(create_app(Settings(data_dir=tmp_path)))
    health = client.get("/v1/health").json()
    assert health["decision_engine"] == "luna" and health["reasoning_effort"] == "none"
    assert health["configured"] is False and health["device"] == "api"
    enroll(client)
    response = client.post(
        "/v1/verify", data={"barcode": "123"}, files={"file": ("x.png", png(), "image/png")}
    )
    assert response.status_code == 503 and "OPENAI_API_KEY" in response.json()["detail"]


def test_luna_schema_flags_and_individual_images(setup):
    client, _, state = setup
    enroll(client)
    state["assessment"] = assessment(True)
    response = client.post(
        "/v1/verify", data={"barcode": "123"}, files={"file": ("x.png", png(), "image/png")}
    )
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["decision"] == "suspicious"
    assert value["confidence"] == 0.98  # confidence in a rejection is not a 98% visual match
    assert value["confidence_type"] == "uncalibrated_model_assessment"
    assert value["identified_product"] is None
    assert value["flags"]["different_item"]["status"] == "present"
    assert value["heatmap_image_url"] is None and value["geometry"] is None
    assert value["region_coordinate_system"] == "normalized_reference_query_1000"
    for key in [
        "reference_image_url",
        "annotated_image_url",
        "annotated_reference_image_url",
        "original_image_url",
        "discrepancy_image_url",
    ]:
        image = client.get(value[key])
        assert image.status_code == 200 and image.headers["content-type"] == "image/png"
        Image.open(io.BytesIO(image.content)).verify()
    assert (
        client.get(value["reference_image_url"]).content
        != client.get(value["annotated_reference_image_url"]).content
    )
    assert (
        client.get(value["original_image_url"]).content
        != client.get(value["annotated_image_url"]).content
    )
    assert client.get(f"/v1/results/{value['request_id']}").json() == value
    payload = state["calls"][0]
    assert payload["model"] == "gpt-6-luna" and payload["reasoning"] == {"effort": "none"}
    assert payload["store"] is False
    assert set(payload["text"]["format"]["schema"]["properties"]) == {
        "verdict",
        "verdict_confidence",
        "flags",
        "discrepancies",
        "reference_index",
    }


@pytest.mark.parametrize("status", [401, 429, 500])
def test_provider_errors_are_not_fake_scores_or_secret_leaks(setup, status):
    client, _, state = setup
    enroll(client)
    state["status"] = status
    response = client.post(
        "/v1/verify", data={"barcode": "123"}, files={"file": ("x.png", png(), "image/png")}
    )
    assert response.status_code == 503
    assert "test-not-a-secret" not in response.text


def test_invalid_box_is_rejected(setup):
    client, _, state = setup
    enroll(client)
    state["assessment"] = assessment(True)
    state["assessment"]["discrepancies"][0]["query_box"] = [900, 200, 100, 500]
    response = client.post(
        "/v1/verify", data={"barcode": "123"}, files={"file": ("x.png", png(), "image/png")}
    )
    assert response.status_code == 502


def test_ambiguous_damage_needs_review_despite_consistent_model_verdict(setup):
    client, _, state = setup
    enroll(client)
    state["assessment"]["flags"]["damage"]["status"] = "unknown"
    response = client.post(
        "/v1/verify", data={"barcode": "123"}, files={"file": ("x.png", png(), "image/png")}
    )
    assert response.json()["decision"] == "inconclusive"


def test_catalog_identification_without_claim(setup):
    client, _, state = setup
    enroll(client)
    response = client.post("/v1/verify", files={"file": ("x.png", png(), "image/png")})
    assert response.status_code == 200, response.text
    assert response.json()["identified_product"]["id"] == "phone"
    assert len(state["calls"]) == 2


def test_provider_truncation_is_not_persisted(setup):
    client, service, state = setup
    enroll(client)
    state["response"] = {"status": "incomplete", "output": []}
    response = client.post(
        "/v1/verify", data={"barcode": "123"}, files={"file": ("x.png", png(), "image/png")}
    )
    assert response.status_code == 502
    assert not (service.settings.data_dir / "results").exists()
