"""Compare local foreground models on supplied photos; no accuracy labels assumed."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from backend.config import Settings
from backend.foreground import ForegroundSegmenter, crop_foreground
from backend.service import decode_image


def benchmark(images, models, repeats, cache, output):
    output.mkdir(parents=True, exist_ok=True)
    decoded = [decode_image(path.read_bytes(), Settings()) for path in images]
    masks, rows = {}, []
    for model in models:
        segmenter = ForegroundSegmenter(Settings(model_cache=cache, segmentation_model=model))
        start = time.perf_counter()
        segmenter.prepare(decoded[0])  # Initialize/warm once; keep out of warm measurements.
        initialization = (time.perf_counter() - start) * 1000
        model_masks, samples = [], []
        for index, (path, image) in enumerate(zip(images, decoded, strict=True)):
            timings = []
            for _ in range(repeats):
                start = time.perf_counter()
                mask = segmenter.predict_mask(image)
                foreground = crop_foreground(image, mask)
                timings.append((time.perf_counter() - start) * 1000)
            binary = mask > 127
            model_masks.append(binary)
            Image.fromarray(mask).save(output / f"{index:02d}-{model}-mask.png")
            foreground.image.save(output / f"{index:02d}-{model}-cutout.png")
            samples.append(
                {
                    "image": f"{path.parent.name}/{path.name}",
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "latency_ms": timings,
                    "median_ms": statistics.median(timings),
                    "foreground_fraction": foreground.source_fraction,
                    "valid": foreground.valid,
                }
            )
            print(
                f"{model} {index + 1}/{len(images)}: {statistics.median(timings):.1f} ms",
                flush=True,
            )
        masks[model] = model_masks
        checkpoint = cache / "segmentation" / f"{model}.onnx"
        rows.append(
            {
                "model": model,
                "input_shape": segmenter.session.inner_session.get_inputs()[0].shape,
                "providers": segmenter.session.inner_session.get_providers(),
                "weights_bytes": checkpoint.stat().st_size,
                "initialization_and_first_image_ms": initialization,
                "median_ms": statistics.median(s["median_ms"] for s in samples),
                "samples": samples,
            }
        )
    # Mask agreement is a diagnostic only: neither model is ground truth.
    if len(models) > 1:
        baseline = masks[models[-1]]
        for row in rows[:-1]:
            row["mask_iou_vs_last_model"] = [
                float(np.count_nonzero(a & b) / max(1, np.count_nonzero(a | b)))
                for a, b in zip(masks[row["model"]], baseline, strict=True)
            ]
    report = {
        "note": "Warm CPU segmentation including resizing and cropping. Mask agreement is not segmentation accuracy.",
        "repeats": repeats,
        "results": rows,
    }
    (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    # Contact sheet uses source photo and transparent red mask overlays for inspection.
    width, height = 240, 220
    sheet = Image.new("RGB", (width * (len(models) + 1), height * len(images)), "white")
    draw = ImageDraw.Draw(sheet)
    for index, (path, image) in enumerate(zip(images, decoded, strict=True)):
        panels = [image]
        for model in models:
            pixels = np.asarray(image).astype(float)
            alpha = masks[model][index][..., None].astype(float) * 0.35
            panels.append(
                Image.fromarray(
                    (pixels * (1 - alpha) + np.array([255, 40, 40]) * alpha).astype(np.uint8)
                )
            )
        for col, (label, panel) in enumerate(zip(["Original", *models], panels, strict=True)):
            thumb = ImageOps.contain(panel, (width - 12, height - 40))
            x, y = col * width, index * height
            sheet.paste(thumb, (x + (width - thumb.width) // 2, y + 36))
            draw.text((x + 6, y + 4), label, fill="black")
            draw.text((x + 6, y + 18), f"{path.parent.name}/{path.name}"[:38], fill="black")
    sheet.save(output / "comparison.png")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, action="append", required=True)
    parser.add_argument("--models", nargs="+", default=["u2netp", "birefnet-general-lite"])
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--cache", type=Path, default=Settings().data_dir / "models")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    benchmark(args.image, args.models, args.repeat, args.cache, args.output_dir)


if __name__ == "__main__":
    main()
