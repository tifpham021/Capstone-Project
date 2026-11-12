# ReturnScan CV API

Upload a returned-product photo and receive a visual-match confidence, per-method
evidence, and an image highlighting observed discrepancies. This is the runnable
backend for the CV proof of concept, **not a validated counterfeit detector**.

## Run

From the repository root, use Python 3.11+:

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
That request is slower and needs internet access; subsequent requests reuse caches.

`RETURNSCAN_DEVICE=auto` chooses CUDA, then Apple Metal/MPS, then CPU. On an M4,
DINOv2/PatchCore uses MPS when available; ALIKED/LightGlue uses CPU for portability.
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
- `geometry`: backend, matches, RANSAC inliers, coverage and alignment validity.
- `patchcore`: anomaly and normality scores; higher anomaly means more differences.
- `discrepancy_image_url`, `heatmap_image_url`: paths relative to this API server.
- `discrepancy_regions`: boxes in the **448×448 aligned/letterboxed query**, not
  original camera-image coordinates or the side-by-side comparison's coordinates.
- `latency_ms`: preprocessing, queue wait, model/index load, retrieval, geometry,
  PatchCore, visualization and total processing time (not network transfer time).
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

1. Frozen `dinov2_vits14` global features retrieve the closest catalog product.
2. ALIKED detects/describes local points; LightGlue matches them between query
   and references. RANSAC fits query-to-reference geometry and rejects outliers.
3. For a usable fit, compare spatially nearby DINOv2 patches against genuine
   reference patches (with mild brightness variants). PatchCore-style cosine
   distances produce a 95th-percentile anomaly score and discrepancy map.
4. Combine retrieval (15%), geometry (50%) and patch normality (35%). Identity,
   geometry and anomaly gates also influence the decision. If alignment fails,
   an unrestricted nearest-neighbor patch score is informational and the decision
   is `inconclusive`. No fake or random scores are used when models fail.

The heatmap uses an absolute threshold, so even a perfect reference match is not
forced to contain red patches. Boxes indicate appearance anomalies, not a proven
cause of damage or counterfeiting. This is a custom DINOv2-based PatchCore-style
variant, not the original paper's exact backbone/scoring implementation.

## Configuration and safety

See [`.env.example`](.env.example). Export variables or use
`uvicorn backend.main:app --env-file backend/.env --workers 1`.

- `RETURNSCAN_DATA_DIR`: catalog, normalized references, results and default model
  cache. Defaults to `backend/.runtime`, excluded from Git.
- `RETURNSCAN_DEVICE`: `auto`, `cpu`, `mps`, `cuda`.
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
establish authenticity, damage alone is not fraud, backgrounds can affect scores,
and a homography is only an approximation for a non-planar object. Real products
need controlled capture and genuine/defective/counterfeit evaluation data.

## Tests

```bash
python -m pip install -r backend/requirements-dev.txt
python -m pytest -c backend/pytest.ini backend/tests -q
ruff check backend
ruff format --check backend
```

Unit/HTTP contract tests inject deterministic test features and do **not**
download models. They also exercise real patch-distance math, RANSAC, upload
validation, auth, CORS, persistence, partial batches and PNG generation.
For a real-model HTTP smoke test, start the server and run:

```bash
python -m backend.smoke_test \
  --reference /path/to/genuine.jpg \
  --query /path/to/genuine-other-view.jpg \
  --query /path/to/damaged-item.jpg
```

The smoke test enrolls a uniquely named product, verifies every query using the
actual server, checks that both returned PNGs decode, and prints scores/latency.
It intentionally does not assert that an uncalibrated model labels every item
correctly. Use `--local-backend sift` to exercise the fallback.

## Upstream work

- [DINOv2](https://github.com/facebookresearch/dinov2), Apache-2.0.
- [LightGlue](https://github.com/cvg/LightGlue), Apache-2.0, including ALIKED support.
- [ALIKED](https://github.com/Shiaoming/ALIKED), BSD-3-Clause.
- [PatchCore paper](https://arxiv.org/abs/2106.08265).
- [RANSAC paper](https://doi.org/10.1145/358669.358692).

Code/weight sources are pinned where fetched through Git. Review upstream
licenses before redistributing models. No pretrained weights, source product
photos or user-specific paths are committed to this repository.

## Automatic Raspberry Pi camera verification

The backend can own one or two CSI cameras and run the existing verification algorithm
when **all available views stay still for two seconds**. It processes the initial settled
scene once, then requires sustained motion (0.3 seconds) before another scan.
Small blurred grayscale previews detect motion; the matching algorithm receives
1280×960 JPEGs from each active camera. Captures are close in time, not hardware synchronized.
Camera capture continues during inference; inference runs sequentially in one
background worker, without an accumulating queue. A scene changed during processing
is checked again after the worker is available and the views settle.

Install Picamera2 using Raspberry Pi OS packages, then create a virtual environment
that can access those system packages and install the backend requirements:

```bash
sudo apt install python3-picamera2
python3 -m venv --system-site-packages backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements.txt
RETURNSCAN_CAMERAS_ENABLED=1 RETURNSCAN_DEVICE=cpu \
  python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Enroll genuine references first using `/v1/products`. An empty catalog or unavailable
model weights produces explicit per-camera errors. The first scan may download
DINOv2 weights. Camera mode defaults to SIFT local matching to reduce Pi resource
use; DINOv2 retrieval and patch comparison still run. Close other camera applications
before enabling this mode. Use exactly one server worker and avoid reload mode.

Poll `GET /v1/cameras/status` (with `X-API-Key` if configured) for `status`, camera
errors, and `latest.results`, containing each camera ID and its normal verification
response or error. Successful results retain the existing persisted result/image
URLs. The latest scan summary stays in memory; it resets on server restart.
Camera initialization failure is reported here while upload endpoints remain usable.
This endpoint does not expose a live camera preview.

Settings in `.env.example` control camera IDs, settling time, sampling interval,
motion sensitivity, local backend and an optional expected product ID. The default
motion threshold is a 12-level grayscale difference in at least 1.5% of preview
pixels. Tune the fraction for the station's lighting and product size. Stillness
detection does not determine whether a product is present; an empty settled scene
also triggers a scan. Camera mode defaults to disabled.

Hardware-independent camera state tests:

```bash
python3 -m unittest backend.tests.test_cameras -v
```

## Frontend button capture

### Normalized comparison views

New scans show the selected reference and returned item as transparent PNGs.
GrabCut isolates a single product from its background. Leave space around the
product and use a contrasting background; failed segmentation is reported and
retains the original background. With valid matching geometry, the returned item
is warped into the reference perspective and both images share a crop and scale.
Without a valid fit, each foreground is oriented independently; the UI explicitly
reports that perspective alignment failed. This cannot reconstruct unseen sides.
These display transformations do not change the existing confidence calculation.

Only valid **ALIKED + LightGlue** matches with successful foreground isolation
produce a discrepancy image. A single returned-item view boxes substantial
changed/missing edges, with a small alignment tolerance and noise filtering.
There is no color heatmap. SIFT and failed alignment still return normalized
views, but do not produce discrepancy boxes. Lighting, reflections and imperfect
segmentation can affect edge differences; these boxes require visual review.
Set `RETURNSCAN_CAMERA_LOCAL_BACKEND=auto` to attempt LightGlue with SIFT fallback,
or `aliked` to require LightGlue. The default Pi configuration uses `sift`.

Responses include `normalized_reference_image_url`, `normalized_image_url`,
`background_removed`, and `normalization_alignment`. `discrepancy_image_url` is
nullable and `heatmap_image_url` is null for new results. Box coordinates use the
448×448 normalized image (`region_coordinate_system=normalized_448x448`). Older
saved images remain accessible through their original URLs.

### Black iPhone 15 references

Use your actual black reference photos rather than the previously downloaded
yellow phone photos. After restarting the updated backend, replace the enrolled
`iphone-15` references using:

```bash
backend/.venv/bin/python -m backend.enroll_iphone15 \
  --reference /absolute/path/to/black-phone.jpg --replace
```

Repeat `--reference` for additional views (up to eight). The helper labels the
product **Apple iPhone 15 · Black**. Replacement uses the authenticated
`PUT /v1/products/{product_id}/references` endpoint, writes new sanitized files,
updates the catalog atomically, and invalidates cached reference features.
Earlier reference files and scan results remain on disk. No photos are recolored.

Run the model-free image tests and injected-model API tests with:

```bash
backend/.venv/bin/python -m unittest backend.tests.test_visualization backend.tests.test_normalized_results -v
```

The inspection page's **Scan item** button requests new pictures from the available Pi
cameras, follows a scan ID, and displays independent per-view scores, decisions,
alignment checks and marked discrepancy images. The review page retains those
results for the active case while the app is open. Camera results are compared
with the enrolled catalog (or `RETURNSCAN_CAMERA_PRODUCT_ID` when configured).
They are not compared against each other. Scan tracking is in memory (last 16
button scans); successful verification artifacts continue to persist on disk.
Reloading the frontend resets its case-to-scan association.

Start the backend for button-only scanning:

```bash
RETURNSCAN_CAMERAS_ENABLED=1 RETURNSCAN_CAMERA_AUTO_SCAN=0 RETURNSCAN_DEVICE=cpu \
  backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

In another terminal from the repository root:

```bash
npm ci
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173 on the Pi, open an item's inspection screen, and press
**Scan item**. `RETURNSCAN_CAMERA_AUTO_SCAN=1` retains automatic stillness scans;
a button request returns 409 if another verification is already processing.
At least one configured camera must initialize successfully; unavailable cameras
are skipped automatically. Set `RETURNSCAN_CAMERA_IDS=0` to use one camera explicitly.
The status endpoint reports only active camera IDs. Images are captured close in time,
without hardware synchronization. Inconclusive results remain visibly
inconclusive, and partial per-camera failures do not hide successful views.

Vite development and preview servers proxy `/v1` to port 8000, including artifact
images. If using `RETURNSCAN_API_KEY`, export it for **both backend and Vite**;
the proxy adds the header server-side. Do not put it in a `VITE_*` variable.
Production hosting needs an equivalent trusted `/v1` reverse proxy; a static
build alone does not include Vite's proxy. A non-secret `VITE_API_BASE_URL` can
point directly at an API with suitable CORS when no API key is required.

New endpoints (protected by the configured API key):

- `POST /v1/cameras/scan`: returns HTTP 202 and `{scan_id, status: "queued"}`.
- `GET /v1/cameras/scans/{scan_id}`: returns queued/processing status, then
  `status: "complete"`, `captured_at`, and independent `results`. Camera capture
  failures produce `status: "error"`; individual CV errors appear per view.

Run hardware-independent capture and API tests with:

```bash
backend/.venv/bin/python -m unittest backend.tests.test_cameras backend.tests.test_camera_scan -v
```

### Rectangle alignment

`RETURNSCAN_ALIGNMENT_METHOD=rectangle` (default) uses the foreground mask from
existing local preprocessing and fits the reference and query outlines to a
shared rectangle canvas. It tries four corner orientations and chooses the best
spatial DINO patch agreement. The remote rectangle fitter retains detached pieces
and falls back to an enclosing rectangle when a quadrilateral would clip them.
This is outline normalization; internal feature correspondence is not verified.
Set `RETURNSCAN_ALIGNMENT_METHOD=features` to retain the previous ALIKED/SIFT path.
The camera routes, capture images, normalized result fields, and local frontend
remain compatible. No additional segmentation model or dependency is required.
