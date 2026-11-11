"""Records database routes. Uses a minimal app so these tests don't need PyTorch."""

from __future__ import annotations

import io
import json

import pytest
from backend.common import ServiceError
from backend.config import Settings
from backend.database import Order, create_session_factory
from backend.records import create_records_router
from backend.seed import seed
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from PIL import Image

DRILL = {
    "id": "ORD-1",
    "customer_name": "Jane Doe",
    "items": [
        {
            "product_name": "20V Cordless Drill",
            "product_id": "drill-cd20",
            "sku": "DRL-20V-KIT",
            "serial_number": "DT20-8821-K7",
            "expected_weight_g": 1620,
            "unit_price_cents": 12900,
        }
    ],
}


def jpeg(color="orange"):
    output = io.BytesIO()
    Image.new("RGB", (160, 120), color).save(output, "JPEG")
    return output.getvalue()


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path)
    app = FastAPI()

    @app.exception_handler(ServiceError)
    async def service_error(_request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    app.include_router(create_records_router(settings, create_session_factory(settings)))
    with TestClient(app) as test_client:
        test_client.data_dir = tmp_path
        yield test_client


def make_return(client, order=DRILL):
    assert client.post("/v1/orders", json=order).status_code == 201
    response = client.post("/v1/returns", json={"order_id": order["id"], "station": "Station 01"})
    assert response.status_code == 201, response.text
    return response.json()


def test_order_roundtrip_and_duplicate(client):
    created = client.post("/v1/orders", json=DRILL)
    assert created.status_code == 201
    assert created.json()["items"][0]["expected_weight_g"] == 1620
    assert client.post("/v1/orders", json=DRILL).status_code == 409
    assert client.get("/v1/orders/ORD-1").json()["customer_name"] == "Jane Doe"
    assert client.get("/v1/orders/nope").status_code == 404


def test_order_search_by_sku_and_serial(client):
    client.post("/v1/orders", json=DRILL)
    assert [o["id"] for o in client.get("/v1/orders", params={"search": "drl-20v"}).json()] == [
        "ORD-1"
    ]
    assert len(client.get("/v1/orders", params={"search": "8821"}).json()) == 1
    assert client.get("/v1/orders", params={"search": "zzz"}).json() == []


def test_original_order_images_are_stored_and_served(client):
    client.post("/v1/orders", json=DRILL)
    item_id = client.get("/v1/orders/ORD-1").json()["items"][0]["id"]
    uploaded = client.post(
        f"/v1/orders/ORD-1/items/{item_id}/images",
        data={"view": "front"},
        files={"file": ("front.jpg", jpeg(), "image/jpeg")},
    )
    assert uploaded.status_code == 201, uploaded.text
    image = uploaded.json()
    assert image["view"] == "front" and image["width"] == 160
    served = client.get(image["url"])
    assert served.status_code == 200 and served.headers["content-type"] == "image/jpeg"
    assert client.get("/v1/orders/ORD-1").json()["items"][0]["images"][0]["id"] == image["id"]
    wrong_order = client.post(
        f"/v1/orders/ORD-2/items/{item_id}/images",
        files={"file": ("front.jpg", jpeg(), "image/jpeg")},
    )
    assert wrong_order.status_code == 404
    not_image = client.post(
        f"/v1/orders/ORD-1/items/{item_id}/images",
        files={"file": ("x.jpg", b"not an image", "image/jpeg")},
    )
    assert not_image.status_code == 415


def test_weight_check_compares_against_original_order(client):
    case = make_return(client)
    assert case["status"] == "identified"
    ok = client.post(f"/v1/returns/{case['id']}/weight", json={"measured_weight_g": 1610})
    assert ok.status_code == 201
    assert ok.json()["within_tolerance"] is True  # 10 g off, tolerance max(5 g, 2%) = 32.4 g
    assert ok.json()["tolerance_g"] == pytest.approx(32.4)
    light = client.post(f"/v1/returns/{case['id']}/weight", json={"measured_weight_g": 1200})
    assert light.json()["within_tolerance"] is False
    assert light.json()["difference_g"] == -420
    detail = client.get(f"/v1/returns/{case['id']}").json()
    assert detail["status"] == "inspection_in_progress"
    assert len(detail["weight_checks"]) == 2


def test_item_tolerance_override_and_missing_weight(client):
    order = {
        "id": "ORD-2",
        "items": [
            {"product_name": "Cable", "expected_weight_g": 48, "weight_tolerance_g": 4},
            {"product_name": "Sticker"},
        ],
    }
    client.post("/v1/orders", json=order)
    items = client.get("/v1/orders/ORD-2").json()["items"]
    assert client.post("/v1/returns", json={"order_id": "ORD-2"}).status_code == 422
    cable = client.post(
        "/v1/returns", json={"order_id": "ORD-2", "order_item_id": items[0]["id"]}
    ).json()
    check = client.post(f"/v1/returns/{cable['id']}/weight", json={"measured_weight_g": 53})
    assert check.json()["within_tolerance"] is False  # 5 g off, item allows 4 g
    sticker = client.post(
        "/v1/returns", json={"order_id": "ORD-2", "order_item_id": items[1]["id"]}
    ).json()
    missing = client.post(f"/v1/returns/{sticker['id']}/weight", json={"measured_weight_g": 5})
    assert missing.status_code == 409


def test_return_photos_and_cv_result_link(client):
    case = make_return(client)
    photo = client.post(
        f"/v1/returns/{case['id']}/images",
        data={"view": "top"},
        files={"file": ("top.jpg", jpeg("gray"), "image/jpeg")},
    )
    assert photo.status_code == 201 and client.get(photo.json()["url"]).status_code == 200

    request_id = "a" * 32
    result_dir = client.data_dir / "results" / request_id
    result_dir.mkdir(parents=True)
    (result_dir / "result.json").write_text(
        json.dumps(
            {
                "confidence": 0.81,
                "decision": "consistent",
                "compared_product": {"id": "drill-cd20"},
                "identity_consistent": True,
            }
        )
    )
    linked = client.post(f"/v1/returns/{case['id']}/verifications", json={"request_id": request_id})
    assert linked.status_code == 201, linked.text
    assert linked.json()["heatmap_image_url"] == f"/v1/results/{request_id}/heatmap.png"
    again = client.post(f"/v1/returns/{case['id']}/verifications", json={"request_id": request_id})
    assert again.status_code == 409
    bad = client.post(f"/v1/returns/{case['id']}/verifications", json={"request_id": "../x"})
    assert bad.status_code == 404


def test_lifecycle_and_decision(client):
    case = make_return(client)
    skip = client.post(f"/v1/returns/{case['id']}/status", json={"status": "completed"})
    assert skip.status_code == 409
    client.post(f"/v1/returns/{case['id']}/status", json={"status": "inspection_in_progress"})
    client.post(f"/v1/returns/{case['id']}/status", json={"status": "awaiting_decision"})
    decided = client.post(
        f"/v1/returns/{case['id']}/decision",
        json={"outcome": "approve", "note": "Looks right", "reviewer_email": "r@example.com"},
    )
    assert decided.status_code == 201
    body = decided.json()
    assert body["status"] == "completed" and body["decision"]["outcome"] == "approve"
    assert [e["status"] for e in body["events"]] == [
        "identified",
        "inspection_in_progress",
        "awaiting_decision",
        "completed",
    ]
    assert client.post(
        f"/v1/returns/{case['id']}/decision", json={"outcome": "fraud"}
    ).status_code == (409)
    assert (
        client.post(f"/v1/returns/{case['id']}/weight", json={"measured_weight_g": 1}).status_code
        == 409
    )
    assert [r["id"] for r in client.get("/v1/returns", params={"status": "completed"}).json()] == [
        case["id"]
    ]


def test_dates_come_back_in_utc(client):
    order = {**DRILL, "placed_at": "2026-10-28T10:04:00-05:00"}
    assert client.post("/v1/orders", json=order).status_code == 201
    assert client.get("/v1/orders/ORD-1").json()["placed_at"] == "2026-10-28T15:04:00Z"
    naive = {**DRILL, "id": "ORD-2", "placed_at": "2026-10-28T10:04:00"}
    assert client.post("/v1/orders", json=naive).status_code == 422


def test_seed_is_idempotent(tmp_path):
    settings = Settings(data_dir=tmp_path)
    assert seed(settings) == ["ORD-8921", "ORD-9004"]
    assert seed(settings) == []
    with create_session_factory(settings)() as db:
        photos = db.get(Order, "ORD-8921").items[0].images
        assert len(photos) == 1 and (tmp_path / photos[0].file_path).is_file()
