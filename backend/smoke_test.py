"""Exercise enrollment, real inference and discrepancy PNG routes over HTTP."""

from __future__ import annotations

import argparse
import io
import json
import mimetypes
import os
import uuid
from pathlib import Path

import httpx
from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--query", type=Path, action="append", required=True)
    parser.add_argument("--local-backend", choices=("auto", "aliked", "sift"), default="auto")
    args = parser.parse_args()
    headers = {}
    if os.getenv("RETURNSCAN_API_KEY"):
        headers["X-API-Key"] = os.environ["RETURNSCAN_API_KEY"]
    product_id = "smoke-" + uuid.uuid4().hex[:12]

    def upload(image_path):
        return (
            image_path.name,
            image_path.read_bytes(),
            mimetypes.guess_type(image_path)[0] or "image/jpeg",
        )

    with httpx.Client(base_url=args.base_url, headers=headers, timeout=600) as client:
        enrolled = client.post(
            "/v1/products",
            data={"product_id": product_id, "name": "Smoke-test reference"},
            files={"references": upload(args.reference)},
        )
        enrolled.raise_for_status()
        for query in args.query:
            response = client.post(
                "/v1/verify",
                data={"expected_product_id": product_id, "local_backend": args.local_backend},
                files={"file": upload(query)},
            )
            if response.is_error:
                raise RuntimeError(f"Verification failed ({response.status_code}): {response.text}")
            result = response.json()
            for field in ("discrepancy_image_url", "heatmap_image_url"):
                png = client.get(result[field])
                png.raise_for_status()
                Image.open(io.BytesIO(png.content)).verify()
            print(
                json.dumps(
                    {
                        "query": query.name,
                        "decision": result["decision"],
                        "confidence_percent": result["confidence_percent"],
                        "geometry": result["geometry"],
                        "patchcore": result["patchcore"],
                        "latency_ms": result["latency_ms"],
                        "discrepancy_image_url": result["discrepancy_image_url"],
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    main()
