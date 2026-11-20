"""Load demo orders into the records database.

    python -m backend.seed

Matches the frontend's sample return (ORD-8921, 20V Cordless Drill, 1.62 kg) and
adds ORD-1032, an Owala FreeSip 32 oz water bottle in hot pink, and ORD-1045, the
same bottle in pink with a tan lid, for testing the CV check with real product
photos. Safe to run more than once: existing orders
are left alone. Each order's first item gets its bundled photo as the original
image; add more with POST /v1/orders/{order_id}/items/{item_id}/images.

To let the AI check compare returns against the bottle, also enroll it:

    python -m backend.seed --enroll   (needs the API running on :8000)
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from backend.common import decode_image
from backend.config import Settings
from backend.database import Order, OrderImage, OrderItem, create_session_factory

SAMPLE_PHOTO = Path(__file__).parent.parent / "src/assets/figma/inspection/4036d.png"
OWALA_PHOTO = Path(__file__).parent / "samples/owala-freesip-32oz-hot-pink.png"
OWALA_TAN_PHOTO = Path(__file__).parent / "samples/owala-freesip-32oz-pink-tan-lid.png"

# Original-order photo for each seeded order (first item, "front" view).
ORDER_PHOTOS = {
    "ORD-8921": SAMPLE_PHOTO,
    "ORD-1032": OWALA_PHOTO,
    "ORD-1045": OWALA_TAN_PHOTO,
}

# Products the AI catalog needs for the seeded orders: (product_id, name, sku, photo).
CATALOG = [
    (
        "owala-freesip-32-hot-pink",
        "Owala FreeSip 32 oz (Hot Pink)",
        "OWL-FS32-HPK",
        OWALA_PHOTO,
    ),
    (
        "owala-freesip-32-pink-tan-lid",
        "Owala FreeSip 32 oz (Pink, tan lid)",
        "OWL-FS32-PTN",
        OWALA_TAN_PHOTO,
    ),
]


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
        Order(
            id="ORD-1032",
            customer_name="Alex Kim",
            customer_email="alex.customer@example.com",
            placed_at=datetime(2026, 11, 8, 20, 15, tzinfo=timezone.utc),
            items=[
                OrderItem(
                    product_id="owala-freesip-32-hot-pink",
                    product_name=(
                        "Owala FreeSip Insulated Stainless Steel Water Bottle, 32 oz, Hot Pink"
                    ),
                    sku="OWL-FS32-HPK",
                    # Approximate empty weight. Weigh the actual bottle and update this.
                    unit_price_cents=3299,
                    expected_weight_g=430,
                    weight_tolerance_g=15,
                )
            ],
        ),
        Order(
            id="ORD-1045",
            customer_name="Jordan Lee",
            customer_email="jordan.customer@example.com",
            placed_at=datetime(2026, 11, 10, 17, 40, tzinfo=timezone.utc),
            items=[
                OrderItem(
                    product_id="owala-freesip-32-pink-tan-lid",
                    product_name=(
                        "Owala FreeSip Insulated Stainless Steel Water Bottle, 32 oz, "
                        "Pink with tan lid"
                    ),
                    sku="OWL-FS32-PTN",
                    # Approximate empty weight. Weigh the actual bottle and update this.
                    unit_price_cents=3299,
                    expected_weight_g=430,
                    weight_tolerance_g=15,
                )
            ],
        ),
    ]


def sample_photo(
    settings: Settings, path: Path = SAMPLE_PHOTO, view: str = "front"
) -> OrderImage | None:
    """Stores a bundled photo the same way uploaded originals are stored."""
    if not path.is_file():
        return None
    image = decode_image(path.read_bytes(), settings)
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
            photo_path = ORDER_PHOTOS.get(order.id)
            if photo_path and (photo := sample_photo(settings, photo_path)):
                order.items[0].images.append(photo)
            db.add(order)
            added.append(order.id)
        db.commit()
    return added


def _multipart(fields: dict[str, str], files: list[tuple[str, Path]]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    body = b""
    for key, value in fields.items():
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'
        ).encode()
    for key, path in files:
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; '
            f'filename="{path.name}"\r\nContent-Type: image/png\r\n\r\n'
        ).encode()
        body += path.read_bytes() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def enroll(api_base: str, api_key: str = "") -> None:
    """Enrolls the seeded products in the running API's AI catalog."""
    import urllib.error
    import urllib.request

    for product_id, name, sku, photo in CATALOG:
        body, content_type = _multipart(
            {"product_id": product_id, "name": name, "sku": sku}, [("references", photo)]
        )
        headers = {"Content-Type": content_type}
        if api_key:
            headers["X-API-Key"] = api_key
        request = urllib.request.Request(f"{api_base}/v1/products", data=body, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=300):
                print(f"{product_id}: enrolled")
        except urllib.error.HTTPError as exc:
            print(f"{product_id}: failed ({exc.code}) {exc.read().decode(errors='replace')}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--enroll", action="store_true", help="also enroll the AI catalog")
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    settings = Settings.from_env()
    added = seed(settings)
    print(f"Database: {settings.resolved_database_url}")
    print(f"Added: {', '.join(added) if added else 'nothing (demo orders already exist)'}")
    if args.enroll:
        enroll(args.api, settings.api_key)
