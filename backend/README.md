# ReturnScan CV API

Upload a returned-product photo and receive a visual-match confidence, per-method
evidence, and an image highlighting observed discrepancies. This is the runnable
backend for the CV proof of concept, **not a validated counterfeit detector**.

## Run

From the repository root, use Python 3.11–3.13 (supported by the pinned rembg release):

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Open <http://127.0.0.1:8000/docs> for interactive upload forms and the exact JSON
schemas. `/openapi.json` exposes the machine-readable contract. Startup does not
download weights. The first verification loads the pinned DINOv2 source and
pretrained weights, builds the reference index, and initializes local matching.
That request also downloads the BiRefNet Lite foreground model (~224 MB) and is slower.
Internet access is needed for uncached weights; subsequent requests reuse caches.

`RETURNSCAN_DEVICE=auto` chooses CUDA, then Apple Metal/MPS, then CPU. On an M4,
DINOv2/PatchCore uses MPS when available; ALIKED/LightGlue and ONNX foreground
segmentation use CPU for portability.
To force CPU, prefix the command with `RETURNSCAN_DEVICE=cpu`.

Use **one worker**: model state and JSON catalog writes are serialized within one
process. Run from the repository root. The frontend can run separately using
`npm run dev`.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/health` | Server status and whether DINOv2 has loaded |
| GET | `/v1/products` | List enrolled products, barcodes and reference counts |
| POST | `/v1/products` | Enroll a product with 1–8 genuine reference photos |
| POST | `/v1/verify` | Inspect one photo |
| POST | `/v1/verify/batch` | Inspect 1–4 photos independently in one request |
| GET | `/v1/results/{request_id}` | Retrieve a saved verification result |
| GET | `/v1/results/{request_id}/discrepancy.png` | Reference beside aligned query, with differences highlighted |
| GET | `/v1/results/{request_id}/heatmap.png` | Aligned query with anomaly overlay and discrepancy boxes |

No catalog photos are bundled. Enroll your own known-genuine reference images.
JPEG, PNG and WebP are supported (15 MiB per file, 20 megapixels, minimum 64×64).
Images are decoded, orientation-corrected, downscaled and stored without source
metadata. HEIC must first be converted to a supported format.

### 1. Enroll genuine references

```bash
curl http://127.0.0.1:8000/v1/products \
  -F 'product_id=drill-model-a' \
  -F 'name=Drill model A' \
  -F 'sku=DRILL-A' \
  -F 'barcode=1234567890123' \
  -F 'references=@/path/to/genuine-front.jpg' \
  -F 'references=@/path/to/genuine-side.jpg'
```

Use several clear views of the same SKU. Product IDs may contain letters, digits,
underscores and hyphens. Existing IDs and duplicate barcodes return `409` rather
than silently overwriting reference data. Barcodes are catalog lookup keys, not
decoded from the uploaded photo; the existing frontend scanner can supply them.

### 2. Upload one photo

```bash
curl http://127.0.0.1:8000/v1/verify \
  -F 'file=@/path/to/returned-item.jpg' \
  -F 'expected_product_id=drill-model-a'
```

Alternatively send `barcode=1234567890123`. Do not send both identity fields.
Omit both to retrieve the closest product from the reference catalog using CV.
Use `local_backend=auto` (default), `aliked` (fail if unavailable) or `sift`
(explicit CPU local-feature fallback; DINOv2 is still required).

The response includes:

- `confidence`: score from 0 to 1, higher means a stronger visual match.
- `confidence_percent`: the same score on a 0–100 scale.
- `decision`: `consistent`, `suspicious`, or `inconclusive`.
- `identified_product`, `compared_product`, `identity_consistent`,
  `identity_ambiguous`, and ranked candidates. Near-tied catalog matches require
  identity review instead of an arbitrary high-confidence SKU assignment.
- `geometry`: backend, MAGSAC++ inliers, foreground-relative coverage in **both**
  images, symmetric median reprojection error (pixels at a 1024-pixel long edge),
  foreground IoU, reference index, number of views attempted, alignment validity,
  and a rejection reason. Reference indices are zero-based enrollment order.
- `segmentation`: model name, query validity and foreground fractions before cropping.
- `score_is_informational`: true for an inconclusive comparison; do not use its
  confidence as evidence of authenticity.
- `diagnostic_image_urls`: original photo, foreground cutout, selected reference,
  aligned image, foreground mask and comparison mask. These use the same protected
  PNG route as the discrepancy outputs. When alignment fails, `aligned` shows the
  unaligned cutout and the comparison mask is its foreground mask.
- `patchcore`: anomaly and normality scores; higher anomaly means more differences.
- `discrepancy_image_url`, `heatmap_image_url`: paths relative to this API server.
- `discrepancy_regions`: boxes in the **448×448 aligned/letterboxed query**, not
  original camera-image coordinates or the side-by-side comparison's coordinates.
- `latency_ms`: preprocessing, queue wait, model/index load, retrieval, geometry,
  foreground segmentation, PatchCore, visualization and total processing time
  (not network transfer time). Reference segmentation is included in model/index
  load; the separate segmentation field measures the uploaded query.
- `reasons` and `warnings` for review.

Fetch a returned image URL directly to receive `image/png`. Results and derived
images persist under the configured data directory, including across restarts.

### 3. Upload multiple images

```bash
curl http://127.0.0.1:8000/v1/verify/batch \
  -F 'files=@/path/to/front.jpg' \
  -F 'files=@/path/to/side.jpg' \
  -F 'expected_product_id=drill-model-a'
```

`results` preserves input order. Each entry contains its `result` or an `error`
with `status_code`, so one unreadable image does not discard successful results.
These are independent per-view scores, **not** a calibrated multi-camera
authenticity probability. Batch processing is sequential to bound model memory.

### JavaScript caller

```js
const apiBase = 'http://127.0.0.1:8000'
const form = new FormData()
form.append('file', file) // File from an upload input or camera capture
form.append('expected_product_id', 'drill-model-a')
const response = await fetch(`${apiBase}/v1/verify`, {
  method: 'POST',
  body: form,
}) // Do not manually set Content-Type: the browser supplies the multipart boundary.
if (!response.ok) throw new Error(await response.text())
const result = await response.json()
console.log(result.confidence_percent, result.decision)
const discrepancyImageSrc = `${apiBase}${result.discrepancy_image_url}`
```

If API-key protection is enabled, include `X-API-Key` on API **and image**
requests. To display a protected PNG, fetch it with that header, convert the
response to a Blob and use `URL.createObjectURL(blob)`; revoke the URL when done.
Do not put a production secret in a `VITE_*` environment variable or public JS.
Use a trusted authenticated proxy for production browser access. This service
does not validate the React app's OAuth session or perform refund decisions.

## How it works

1. Local `rembg` + **BiRefNet General Lite** segments the object in each photo.
   Threshold the mask, crop with a small margin, and replace background with white.
   Keep all foreground components so detached pieces are not deliberately discarded.
   Cache reference cutouts, masks and DINO brightness variants in memory. ALIKED
   reference descriptors are cached on their first use. References rebuild after restart.
2. Frozen `dinov2_vits14` features retrieve the closest catalog product and rank
   its reference views. Try the closest view first, then other views until a fit
   passes geometric and foreground checks. This is a latency optimization; it
   does not exhaustively choose the lowest anomaly score across all references.
3. ALIKED + LightGlue matches **foreground-only keypoints**. OpenCV
   `USAC_MAGSAC` (MAGSAC++) estimates query-to-reference homography. Require at
   least 8 inliers, 20% inlier ratio, and inlier-hull coverage of at least 15% of
   the foreground in **each** image. Reject excessive symmetric reprojection
   error, degenerate warps, insufficient visible reference area and poor overlap.
   Explicit SIFT fallback also uses foreground masks and MAGSAC++.
4. Warp both image and mask. Compare spatially nearby DINOv2 patches only in the
   shared foreground, against brightness variants of the selected reference.
   The PatchCore-style score remains the 95th percentile of cosine distances.
   Preserve foreground-outline differences separately: they appear in discrepancy
   images and trigger review when `1 - foreground_iou` exceeds the product's
   `max_foreground_difference` threshold (default 0.30). Outline differences can
   also come from segmentation errors or viewpoint changes.
5. Combine retrieval (15%) and patch normality (85%). Geometry is a **comparison
   quality gate**, not an authenticity vote. The legacy `min_geometry_score`
   catalog field is retained for compatibility but no longer controls the decision.
   A failed alignment or empty query segmentation produces `inconclusive`; any
   unrestricted patch score is informational. An unusable reference requires
   replacement, and model loading errors return `503` rather than fabricated scores.

The scoring weights changed from v1.0; old confidence values and calibrated
thresholds should not be compared directly. No threshold here is validated for
production authenticity decisions. Near-tied product identities prevent a `consistent` decision.

The heatmap uses an absolute threshold, so even a perfect reference match is not
forced to contain red patches. Boxes indicate appearance anomalies, not a proven
cause of damage or counterfeiting. Red regions include appearance anomalies and
foreground-outline differences; the latter are not included in the patch anomaly
scalar. This is a custom DINOv2-based PatchCore-style variant, not the original paper's exact backbone/scoring implementation.

## Configuration and safety

See [`.env.example`](.env.example). Export variables or use
`uvicorn backend.main:app --env-file backend/.env --workers 1`.

- `RETURNSCAN_DATA_DIR`: catalog, normalized references, results and default model
  cache. Defaults to `backend/.runtime`, excluded from Git.
- `RETURNSCAN_DEVICE`: `auto`, `cpu`, `mps`, `cuda` (PyTorch models).
- `RETURNSCAN_SEGMENTATION_MODEL`: defaults to `birefnet-general-lite`.
  `isnet-general-use` is an alternative local model; changing it rebuilds masks
  on restart and needs new validation. Segmentation runs on ONNX CPU.
  Weights are cached in the configured model cache under `segmentation/`.
- `RETURNSCAN_API_KEY`: optional shared key for all data/image routes. Leave empty
  only for local development. Health/docs remain public.
- `RETURNSCAN_CORS_ORIGINS`: comma-separated exact origins. Defaults to
  `http://localhost:5173,http://127.0.0.1:5173`.
- `RETURNSCAN_MODEL_CACHE`: optional persistent PyTorch cache directory.
- `RETURNSCAN_DINO_SOURCE`: optional path to a trusted pre-downloaded DINOv2
  checkout. Used with `torch.hub`'s local source mode for offline installations.

To accept requests from a station on the same LAN, set a key and use
`--host 0.0.0.0 --port 8000 --workers 1`, with firewall rules restricting access.
This does not publish a public hosted endpoint. Before internet deployment, add
TLS, proper user/session authorization, rate limiting, monitoring, disk quotas
and retention cleanup. Uploaded references and output images stay on local disk;
the service does not call a paid inference API. Model downloads contact GitHub
and the upstream model-weight hosts.

Thresholds live per product in `.runtime/catalog.json`. Change them only after
held-out evaluation and restart the process after manual catalog changes. The
default thresholds and weights are heuristic: a `consistent` result cannot
establish authenticity, damage alone is not fraud, segmentation errors can affect scores,
and a homography is only an approximation for a non-planar object. Segmentation
can omit transparent, reflective or damaged parts and requires inspection. Real products
need controlled capture and genuine/defective/counterfeit evaluation data.

## Tests

```bash
python -m pip install -r backend/requirements-dev.txt
python -m pytest -c backend/pytest.ini backend/tests -q
ruff check backend
ruff format --check backend
```

Unit/HTTP contract tests inject deterministic test features and do **not**
download models. They also exercise real patch-distance math, MAGSAC++, masked keypoints,
foreground coverage, upload validation, auth, CORS, persistence, partial batches and PNG generation.
For a real-model HTTP smoke test, start the server and run:

```bash
python -m backend.smoke_test \
  --reference /path/to/genuine.jpg \
  --query /path/to/genuine-other-view.jpg \
  --query /path/to/damaged-item.jpg
```

The smoke test enrolls a uniquely named product, verifies every query using the
actual server, checks that all returned PNGs decode, and prints scores/latency.
It intentionally does not assert that an uncalibrated model labels every item
correctly. Use `--local-backend sift` to exercise the fallback. Repeat
`--reference` to enroll several views, use `--repeat 2` for cold/warm comparisons,
and `--output-dir backend/.runtime/smoke` to save every returned PNG and JSON.

### Measured local smoke test

On an Apple M4 laptop, using MPS for DINO and CPU for BiRefNet Lite and
ALIKED/LightGlue, one catalog product and one cached reference:

| HTTP request | Decision | Visual-match score | Processing time |
| --- | --- | --- | --- |
| Rotated/scaled photo, first request with cached weights | consistent | 99.25% | 16.33 s |
| Same reference photo, warm | consistent | 100% | 7.43 s |
| Rotated/scaled photo, warm | consistent | 99.25% | 6.57 s |
| Same reference photo, warm | consistent | 100% | 6.64 s |

The rotated query is a **synthetic 12° rotation and 0.90 scale of a real MVTec
bottle reference photo**. This verifies alignment and HTTP/image delivery; it is
not an independent-image authenticity benchmark. In separate real-model checks,
a different genuine bottle photo and a damaged bottle photo were both
inconclusive because the matched points covered too little foreground. This
pipeline rejects weak fits; it does not solve textureless objects or arbitrary
3D viewpoints. Foreground segmentation dominated warm latency (~4.6–5.6 s).
First-time weight downloads are additional. Recorded stage timings are
in [`benchmarks/alignment-smoke.json`](benchmarks/alignment-smoke.json).

## Upstream work

- [DINOv2](https://github.com/facebookresearch/dinov2), Apache-2.0.
- [LightGlue](https://github.com/cvg/LightGlue), Apache-2.0, including ALIKED support.
- [ALIKED](https://github.com/Shiaoming/ALIKED), BSD-3-Clause.
- [PatchCore paper](https://arxiv.org/abs/2106.08265).
- [rembg](https://github.com/danielgatis/rembg), MIT wrapper; model licenses are separate.
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), MIT.
- [OpenCV USAC / MAGSAC++](https://docs.opencv.org/4.x/de/d3e/tutorial_usac.html).
- [RANSAC paper](https://doi.org/10.1145/358669.358692).

Code/weight sources are pinned where fetched through Git. Review upstream
licenses before redistributing models. No pretrained weights, source product
photos or user-specific paths are committed to this repository.
