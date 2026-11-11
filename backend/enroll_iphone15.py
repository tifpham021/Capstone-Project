"""Enroll your actual black iPhone 15 reference photos via the running API.

Run from the repository root: python3 -m backend.enroll_iphone15 --reference /path/to/black-phone.jpg --replace
Requires Pillow (already part of backend requirements), network, and a running API.
"""
from __future__ import annotations

import argparse
import io
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid


def multipart(images):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in {"product_id": "iphone-15", "name": "Apple iPhone 15 · Black",
                        "sku": "IPHONE-15-BLACK"}.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for index, image in enumerate(images):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="references"; filename="black-{index}.png"\r\nContent-Type: image/png\r\n\r\n'.encode())
        parts.extend([image, b"\r\n"])
    parts.append(f"--{boundary}--\r\n".encode())
    return boundary, b"".join(parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--reference", type=Path, action="append", required=True, help="Actual black phone photo; repeat for multiple views")
    parser.add_argument("--replace", action="store_true", help="Replace existing iphone-15 references")
    args = parser.parse_args()
    try:
        from PIL import Image, ImageOps

        if not 1 <= len(args.reference) <= 8:
            raise ValueError("Supply 1–8 reference photos")
        images = []
        for path in args.reference:
            with Image.open(path) as source:
                if source.width * source.height > 20_000_000 or min(source.size) < 64:
                    raise ValueError("Reference must be at least 64×64 and at most 20 megapixels")
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((1600, 1600))
                output = io.BytesIO()
                image.save(output, "PNG")
                images.append(output.getvalue())
        boundary, body = multipart(images)
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        if os.getenv("RETURNSCAN_API_KEY"):
            headers["X-API-Key"] = os.environ["RETURNSCAN_API_KEY"]
        route = "/v1/products/iphone-15/references" if args.replace else "/v1/products"
        request = urllib.request.Request(args.api.rstrip("/") + route,
                                         data=body, headers=headers, method="PUT" if args.replace else "POST")
        with urllib.request.urlopen(request, timeout=120) as response:
            print(response.read().decode())
    except urllib.error.HTTPError as exc:
        parser.exit(1, f"HTTP {exc.code}: {exc.read(4096).decode(errors='replace')}\n")
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Enrollment failed: {exc}\n")


if __name__ == "__main__":
    main()
