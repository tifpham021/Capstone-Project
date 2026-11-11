"""Load demo orders into the records database.

    python -m backend.seed

Matches the frontend's sample return (ORD-8921, 20V Cordless Drill, 1.62 kg).
Safe to run more than once: existing orders are left alone. ORD-8921 gets the
frontend's sample drill photo as its original image; add real photos with
POST /v1/orders/{order_id}/items/{item_id}/images.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from backend.common import decode_image
from backend.config import Settings
from backend.database import Order, OrderImage, OrderItem, create_session_factory

SAMPLE_PHOTO = Path(__file__).parent.parent / "src/assets/figma/inspection/4036d.png"


def demo_orders() -> list[Order]:
    return [
        Order(
            id="ORD-8921",
            customer_name="Jane Doe",
            customer_email="jane.customer@example.com",
            placed_at=datetime(2026, 10, 28, 15, 4, tzinfo=timezone.utc),
            items=[
                OrderItem(
                    product_id="drill-cd20",
                    product_name="20V Cordless Drill (Model CD20)",
                    sku="DRL-20V-KIT",
                    serial_number="DT20-8821-K7",
                    unit_price_cents=12900,
                    expected_weight_g=1620,
                )
            ],
        ),
        Order(
            id="ORD-9004",
            customer_name="Sam Rivera",
            customer_email="sam.customer@example.com",
            placed_at=datetime(2026, 11, 2, 18, 30, tzinfo=timezone.utc),
            items=[
                OrderItem(
                    product_id="headphones-wh5",
                    product_name="Wireless Headphones WH-5",
                    sku="AUD-WH5-BLK",
                    serial_number="WH5-55102-B",
                    unit_price_cents=8999,
                    expected_weight_g=254,
                ),
                OrderItem(
                    product_name="USB-C Charging Cable 2 m",
                    sku="CBL-USBC-2M",
                    unit_price_cents=1499,
                    expected_weight_g=48,
                    weight_tolerance_g=4,
                ),
            ],
        ),
    ]


def sample_photo(settings: Settings, view: str = "front") -> OrderImage | None:
    """Stores the bundled sample photo the same way uploaded originals are stored."""
    if not SAMPLE_PHOTO.is_file():
        return None
    image = decode_image(SAMPLE_PHOTO.read_bytes(), settings)
    directory = settings.data_dir / "order-images"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{uuid.uuid4().hex}.jpg"
    image.save(destination, "JPEG", quality=90)
    return OrderImage(
        view=view,
        file_path=destination.relative_to(settings.data_dir).as_posix(),
        width=image.width,
        height=image.height,
    )


def seed(settings: Settings) -> list[str]:
    session_factory = create_session_factory(settings)
    added = []
    with session_factory() as db:
        for order in demo_orders():
            if db.get(Order, order.id) is not None:
                continue
            if order.id == "ORD-8921" and (photo := sample_photo(settings)):
                order.items[0].images.append(photo)
            db.add(order)
            added.append(order.id)
        db.commit()
    return added


if __name__ == "__main__":
    settings = Settings.from_env()
    added = seed(settings)
    print(f"Database: {settings.resolved_database_url}")
    print(f"Added: {', '.join(added) if added else 'nothing (demo orders already exist)'}")
