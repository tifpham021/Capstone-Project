"""Small persistent demo order database and an explicitly simulated scale."""

from __future__ import annotations

import math
import random
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from pydantic import BaseModel

from backend.common import ServiceError

DEMO_ORDER = {
    "order_number": "1",
    "product_id": "iphone-15",
    "product_name": "Apple iPhone 15 · Black",
    "sku": "IPHONE-15-BLACK",
    "expected_weight_g": 171.0,
    "weight_tolerance_percent": 5.0,
}


class CameraOrder(BaseModel):
    order_number: str
    product_id: str
    product_name: str
    sku: str
    expected_weight_g: float
    weight_tolerance_percent: float
    reference_count: int


class OrderStore:
    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "orders.sqlite3"
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS demo_orders (
                order_number TEXT PRIMARY KEY,
                product_id TEXT NOT NULL,
                product_name TEXT NOT NULL,
                sku TEXT NOT NULL,
                expected_weight_g REAL NOT NULL CHECK(expected_weight_g > 0),
                weight_tolerance_percent REAL NOT NULL CHECK(weight_tolerance_percent BETWEEN 0 AND 100)
            )""")
            db.execute(
                """INSERT OR IGNORE INTO demo_orders VALUES
                (:order_number, :product_id, :product_name, :sku,
                 :expected_weight_g, :weight_tolerance_percent)""",
                DEMO_ORDER,
            )

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def get(self, order_number: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM demo_orders WHERE order_number = ?", (order_number.strip(),)
            ).fetchone()
        if row is None:
            raise ServiceError("Order not found. For this demo, enter order number 1.", 404)
        return dict(row)


def ensure_demo_reference(verifier):
    """Seed only missing demo references; never replace the station's enrolled photos."""
    if any(p["id"] == DEMO_ORDER["product_id"] for p in verifier.products()):
        return
    image = Path(__file__).parent / "samples" / "iphone15-demo-reference.jpg"
    verifier.register(
        DEMO_ORDER["product_id"],
        DEMO_ORDER["product_name"],
        DEMO_ORDER["sku"],
        None,
        [image.read_bytes()],
    )


def compare_weight(order, measured_weight_g):
    expected = order["expected_weight_g"]
    if not math.isfinite(measured_weight_g) or measured_weight_g <= 0:
        raise ServiceError("Weight sensor returned an invalid reading", 503)
    difference = measured_weight_g - expected
    tolerance = order["weight_tolerance_percent"]
    return {
        "expected_weight_g": expected,
        "measured_weight_g": measured_weight_g,
        "difference_g": round(difference, 2),
        "difference_percent": round(difference / expected * 100, 2),
        "tolerance_percent": tolerance,
        "within_tolerance": abs(difference) <= expected * tolerance / 100 + 1e-8,
    }


class DemoWeightSensor:
    def __init__(self):
        # Kept only for this backend lifetime; the first scan uses the full weight.
        self.scan_count = 0

    def read(self, expected_weight_g):
        self.scan_count += 1
        target_weight_g = expected_weight_g if self.scan_count % 2 else expected_weight_g / 2
        return round(target_weight_g * random.SystemRandom().uniform(0.95, 1.05), 2)

    def check(self, order):
        return {
            **compare_weight(order, self.read(order["expected_weight_g"])),
            "sensor_mode": "demo",
            "simulation_range_percent": 5.0,
        }


def combined_decision(results, weight):
    if not weight["within_tolerance"]:
        return "suspicious"
    decisions = [view.get("result", {}).get("decision") for view in results]
    if "suspicious" in decisions:
        return "suspicious"
    if not decisions or any(value != "consistent" for value in decisions):
        return "inconclusive"
    return "consistent"
