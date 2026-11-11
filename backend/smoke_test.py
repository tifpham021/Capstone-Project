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
    parser.add_argument("--reference", type=Path, action="append", required=True)
    parser.add_argument("--query", type=Path, action="append", required=True)
    parser.add_argument(
        "--repeat", type=int, default=1, help="Repeat queries to measure warm latency"
    )
    parser.add_argument(
        "--output-dir", type=Path, help="Save response JSON and diagnostic PNGs locally"
    )
    parser.add_argument("--local-backend", choices=("auto", "aliked", "sift"), default="auto")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=True)
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
            files=[("references", upload(reference)) for reference in args.reference],
        )
        enrolled.raise_for_status()
        for iteration, query in ((i, q) for i in range(args.repeat) for q in args.query):
            response = client.post(
                "/v1/verify",
                data={"expected_product_id": product_id, "local_backend": args.local_backend},
                files={"file": upload(query)},
            )
            if response.is_error:
                raise RuntimeError(f"Verification failed ({response.status_code}): {response.text}")
            result = response.json()
            urls = {
                "discrepancy": result["discrepancy_image_url"],
                "heatmap": result["heatmap_image_url"],
                **result.get("diagnostic_image_urls", {}),
            }
            prefix = f"{query.stem}-{iteration}-{result['request_id'][:8]}"
            for label, url in urls.items():
                png = client.get(url)
                png.raise_for_status()
                Image.open(io.BytesIO(png.content)).verify()
                if args.output_dir:
                    (args.output_dir / f"{prefix}-{label}.png").write_bytes(png.content)
            if args.output_dir:
                (args.output_dir / f"{prefix}.json").write_text(json.dumps(result, indent=2))
            print(
                json.dumps(
                    {
                        "query": query.name,
                        "iteration": iteration,
                        "decision": result["decision"],
                        "confidence_percent": result["confidence_percent"],
                        "geometry": result["geometry"],
                        "segmentation": result["segmentation"],
                        "patchcore": result["patchcore"],
                        "latency_ms": result["latency_ms"],
                        "discrepancy_image_url": result["discrepancy_image_url"],
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    main()
