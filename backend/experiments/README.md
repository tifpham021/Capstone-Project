# Adaptive crop trial

Run from the repository root:

```sh
backend/.venv/bin/python backend/experiments/adaptive_crop.py
```

Outputs `/tmp/adaptive-crop/detected.jpg` (full frames with proposed crops and
crop previews) and `results.json` (coordinates and timings).

The trial inspects all readable saved `results/*/original.png` files. On
2026-11-14 this was 13 images; one additional original was unreadable.

The detector downsamples to 320 pixels wide, masks dark/bright low-saturation
regions on the metal table, closes small gaps, and ranks connected components
by area and proximity to the inspection area. It pads the selected box by 30%
of the larger object dimension (at least 48 source pixels at 1280-wide input).
It leaves the full image when no candidate qualifies or a candidate touches
the inspection boundary. It does not upscale crops.

Visual review on these same development images found complete product coverage
in all nine complete table views, including two earbud captures. The empty-table
image, two close-ups and one already-truncated phone frame were left uncropped.
This is a small, tuned development set, not held-out accuracy validation.

Thirty repetitions per image, OpenCV using one CPU thread on this development
machine: per-image median 1.6–2.2 ms; maximum per-image p95 2.6 ms. The timed
section includes detection and a contiguous crop copy; it excludes file/image
decoding, JPEG encoding and model inference. Raspberry Pi hardware has not
been benchmarked. Crops have not been submitted to Luna to measure box accuracy.

A local-contrast morphology alternative took about 2–3 ms with a rectangular
kernel but frequently selected reflections/shadows. An elliptical kernel took
about 36 ms and was rejected.

The trial now uses the same detector as the live Pi pipeline in
`backend/camera_crop.py`. Adaptive cropping replaces fixed 2x zoom before
verification, so Luna and frontend artifacts share the same framing. Disable
it with `RETURNSCAN_CAMERA_ADAPTIVE_ZOOM=0`. The offline script itself does
not mutate the live pipeline or saved results.
Saved captures include different framings and lighting, so they cannot all share
a single empty-table background. For a more general detector, capture an empty
background independently for each camera with the final framing/exposure, then
use low-resolution background difference and the same component/padding logic.
The current intensity thresholds are specific to these phone/earbud/table images
and should not be treated as a general product detector.
