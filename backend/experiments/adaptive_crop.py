"""Offline crop trial; does not change the live camera pipeline.

Run: backend/.venv/bin/python backend/experiments/adaptive_crop.py
Thresholds are experimental and tuned to the current metal-table captures.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.camera_crop import object_bounds

cv2.setNumThreads(1)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--results", type=Path, default=Path("backend/.runtime/results"))
parser.add_argument("--output", type=Path, default=Path("/tmp/adaptive-crop"))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
paths = [
    str(p) for p in sorted(args.results.glob("*/original.png")) if cv2.imread(str(p)) is not None
]
if not paths:
    raise SystemExit("No readable captures found")


out = Image.new("RGB", (1200, 300 * ((len(paths) + 3) // 4)), "white")
d = ImageDraw.Draw(out)
results = []
for i, p in enumerate(paths):
    im = cv2.imread(p)
    box = object_bounds(im)
    times = []
    for _ in range(30):
        start = time.perf_counter()
        candidate = object_bounds(im)
        if candidate:
            cx0, cy0, cx1, cy1 = candidate
            # Actual contiguous crop included, with no unnecessary upsampling.
            crop = im[cy0:cy1, cx0:cx1].copy()
        times.append((time.perf_counter() - start) * 1000)
    results.append(
        dict(
            index=i,
            path=p,
            box=box,
            p50_ms=float(np.median(times)),
            p95_ms=float(np.percentile(times, 95)),
        )
    )
    show = im.copy()
    if box:
        x0, y0, x1, y1 = box
        cv2.rectangle(show, (x0, y0), (x1, y1), (0, 0, 255), 4)
    thumb = Image.fromarray(cv2.cvtColor(show, cv2.COLOR_BGR2RGB))
    thumb.thumbnail((295, 210))
    x = i % 4 * 300
    y = i // 4 * 300
    out.paste(thumb, (x, y + 25))
    d.text((x + 3, y + 3), f"{i}: {np.median(times):.1f} ms", fill="black")
    if box:
        crop = Image.fromarray(cv2.cvtColor(im[y0:y1, x0:x1], cv2.COLOR_BGR2RGB))
        crop.thumbnail((110, 65))
        out.paste(crop, (x, y + 235))
out.save(args.output / "detected.jpg")
(args.output / "results.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
