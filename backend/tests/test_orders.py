"""Demo order lookup, per-job product binding and the simulated scale contract."""

import sqlite3

import pytest
from backend.cameras import CameraMonitor
from backend.common import ServiceError
from backend.config import Settings
from backend.main import create_app
from backend.orders import (
    DEMO_ORDER,
    DemoWeightSensor,
    OrderStore,
    combined_decision,
    compare_weight,
    ensure_demo_reference,
)
from fastapi.testclient import TestClient


class Verifier:
    def __init__(self):
        self.calls = []

    def products(self):
        return [{"id": "iphone-15", "reference_count": 2}]

    def verify(self, image, **kwargs):
        self.calls.append(kwargs)
        return {"decision": "consistent", "request_id": "example"}


class FixedSensor(DemoWeightSensor):
    def __init__(self, reading):
        self.reading = reading
        self.calls = 0

    def read(self, expected_weight_g):
        self.calls += 1
        return self.reading


def test_database_is_persistent_and_seed_is_idempotent(tmp_path):
    store = OrderStore(tmp_path)
    assert store.get("1") == DEMO_ORDER
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT COUNT(*) FROM demo_orders").fetchone()[0] == 1
        db.execute("UPDATE demo_orders SET expected_weight_g=172 WHERE order_number='1'")
    assert OrderStore(tmp_path).get("1")["expected_weight_g"] == 172
    with pytest.raises(ServiceError) as error:
        store.get("1' OR '1'='1")
    assert error.value.status_code == 404


@pytest.mark.parametrize(
    "weight, matches",
    [(162.45, True), (179.55, True), (171, True), (162.44, False), (179.56, False)],
)
def test_weight_comparison_bounds(weight, matches):
    assert compare_weight(DEMO_ORDER, weight)["within_tolerance"] is matches


def test_demo_sensor_alternates_full_and_half_weight_plus_or_minus_five_percent():
    sensor = DemoWeightSensor()
    for scan_number in range(1, 201):
        result = sensor.check(DEMO_ORDER)
        if scan_number % 2:
            assert 162.45 <= result["measured_weight_g"] <= 179.55
        else:
            assert 81.22 <= result["measured_weight_g"] <= 89.78
        assert result["within_tolerance"] is bool(scan_number % 2)
        assert result["sensor_mode"] == "demo"
        assert result["expected_weight_g"] == 171

    # A fresh backend sensor starts with a correct reading again.
    sensor.check(DEMO_ORDER)
    assert DemoWeightSensor().check(DEMO_ORDER)["within_tolerance"]


@pytest.mark.parametrize("weight", [float("nan"), float("inf"), -1, 0])
def test_invalid_sensor_reading_is_not_a_weight_match(weight):
    with pytest.raises(ServiceError):
        compare_weight(DEMO_ORDER, weight)


def test_weight_match_cannot_hide_an_image_mismatch_or_error():
    weight = compare_weight(DEMO_ORDER, 170)
    assert combined_decision([{"result": {"decision": "suspicious"}}], weight) == "suspicious"
    assert combined_decision([{"error": "provider unavailable"}], weight) == "inconclusive"
    assert combined_decision([], weight) == "inconclusive"
    assert (
        combined_decision([{"result": {"decision": "consistent"}}], compare_weight(DEMO_ORDER, 100))
        == "suspicious"
    )


def test_order_lookup_and_scan_job_use_a_snapshot_not_station_default(tmp_path, monkeypatch):
    monkeypatch.setenv("RETURNSCAN_CAMERA_PRODUCT_ID", "wrong-station-default")
    verifier = Verifier()
    sensor = FixedSensor(175)
    monitor = CameraMonitor(verifier, weight_sensor=sensor)
    monitor._set(status="watching")
    app = create_app(Settings(data_dir=tmp_path), service=verifier)
    app.state.camera_monitor = monitor
    with TestClient(app) as client:
        order = client.get("/v1/cameras/orders/1").json()
        assert client.get("/v1/orders/1").json() == order  # Legacy camera client
        saved = client.post("/v1/orders", json={"id": "1", "items": [{"product_name": "Bottle"}]})
        assert saved.status_code == 201
        assert client.get("/v1/orders/1").json()["items"][0]["product_name"] == "Bottle"
        assert client.get("/v1/cameras/orders/1").json() == order
        assert order["product_id"] == "iphone-15" and order["reference_count"] == 2
        assert order["expected_weight_g"] == 171
        assert client.get("/v1/cameras/orders/2").status_code == 404
        assert client.post("/v1/cameras/scan", json={"order_number": "999"}).status_code == 404
        assert not monitor.scans
        assert client.post("/v1/cameras/scan", json={"order_number": ""}).status_code == 422
        accepted = client.post("/v1/cameras/scan", json={"order_number": "1"})
        assert accepted.status_code == 202, accepted.text
        job = accepted.json()
        assert job["order"]["product_id"] == "iphone-15"
        # Changing the DB after acceptance must not change the in-flight job.
        with sqlite3.connect(app.state.orders.path) as db:
            db.execute("UPDATE demo_orders SET expected_weight_g=200 WHERE order_number='1'")
        original = monitor.scans[job["scan_id"]]["order"]
        completed = monitor._verify([b"view-a", b"view-b"], 123, original)
        assert all(call["expected_product_id"] == "iphone-15" for call in verifier.calls)
        assert sensor.calls == 1  # One scale reading for the entire scan, not per camera.
        assert completed["weight"]["expected_weight_g"] == 171
        assert completed["weight"]["measured_weight_g"] == 175
        assert completed["decision"] == "consistent"
        monitor.scans[job["scan_id"]].update(status="complete", **completed)
        polled = client.get(f"/v1/cameras/scans/{job['scan_id']}").json()
        assert polled["order"]["order_number"] == "1"
        assert polled["weight"]["sensor_mode"] == "demo"
        assert len(polled["results"]) == 2


def test_reference_seed_preserves_existing_station_photos():
    verifier = Verifier()
    verifier.register = lambda *_: pytest.fail("Existing references must not be replaced")
    ensure_demo_reference(verifier)


def test_reference_seed_supplies_the_demo_iphone15_when_missing():
    class EmptyCatalog:
        def products(self):
            return []

        def register(self, product_id, name, sku, barcode, images):
            assert product_id == "iphone-15" and sku == "IPHONE-15-BLACK"
            assert images[0].startswith(b"\xff\xd8")

    ensure_demo_reference(EmptyCatalog())


def test_product_only_scan_uses_enrolled_product_metadata(tmp_path):
    class ProductVerifier(Verifier):
        def products(self):
            return [{
                "id": "mouse",
                "name": "Wireless mouse",
                "sku": "MOUSE-1",
                "barcode": None,
                "reference_count": 3,
                "expected_weight_g": 85.0,
                "weight_tolerance_percent": 5.0,
            }]

    verifier = ProductVerifier()
    sensor = FixedSensor(86)
    monitor = CameraMonitor(verifier, weight_sensor=sensor)
    monitor._set(status="watching")
    app = create_app(Settings(data_dir=tmp_path), service=verifier)
    app.state.camera_monitor = monitor
    with TestClient(app) as client:
        accepted = client.post("/v1/cameras/scan", json={"product_id": "mouse"})
        assert accepted.status_code == 202, accepted.text
        job = accepted.json()
        assert "order" not in job
        assert job["product"]["product_id"] == "mouse"
        completed = monitor._verify([b"view"], 123, job["product"])
        assert completed["product"]["product_name"] == "Wireless mouse"
        assert completed["weight"]["expected_weight_g"] == 85
        assert completed["decision"] == "consistent"
