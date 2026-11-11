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
pretrained weights, builds the reference index, and initializes foreground alignment.
That request also downloads the small U2Netp foreground model (~4.6 MB) and is slower.
Internet access is needed for uncached weights; subsequent requests reuse caches.

`RETURNSCAN_DEVICE=auto` chooses CUDA, then Apple Metal/MPS, then CPU. On an M4,
DINOv2/PatchCore uses MPS when available; foreground segmentation and OpenCV
rectangle warps run on CPU. The default path does not load ALIKED/LightGlue.
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

## Records database

Orders, the original item photos and weights, and returns are stored in a
database so every station (desktop and Raspberry Pi) sees the same data.

- **Default:** SQLite, one file at `<RETURNSCAN_DATA_DIR>/returnscan.db`. Free,
  nothing to install, created automatically on startup.
- **Images** are saved as sanitized JPEGs under `order-images/` and
  `return-images/` in the data directory; the tables store their paths.
- **Moving later:** set `RETURNSCAN_DATABASE_URL` to any SQLAlchemy URL (e.g.
  PostgreSQL). The code does not change. Back up the `.db` file and the image
  folders together.
- **Schema changes:** tables are created if missing, but existing tables are not
  altered. During development, delete `returnscan.db` after changing a model.

Load the demo orders (`ORD-8921` matches the frontend's sample return):

```bash
python -m backend.seed
```

### Test order: Owala water bottle (`ORD-1032`)

`ORD-1032` is a real product for trying the CV check end to end: an Owala
FreeSip insulated stainless steel bottle, 32 oz, hot pink. Its original-order
photo is [`samples/owala-freesip-32oz-hot-pink.png`](samples/owala-freesip-32oz-hot-pink.png).
With the API running, seed it and enroll that photo in the AI catalog:

```bash
python -m backend.seed --enroll   # --api http://host:8000 if not local
```

| Field | Value |
| --- | --- |
| CV `product_id` | `owala-freesip-32-hot-pink` |
| SKU | `OWL-FS32-HPK` (placeholder, not a retailer SKU) |
| Price | $32.99 (approximate) |
| Expected weight | 430 g ± 15 g. **Estimate** for an empty bottle; weigh a real one and update `backend/seed.py` |
| Serial / barcode | None |

In the desktop UI, look up `ORD-1032`, start the inspection, enter the scale
reading, and add a photo of the returned bottle. The photo is saved to the return,
sent to `/v1/verify` and the result is attached before you can continue to review.

Results from the bundled photo (rectangle alignment, CPU):

| Photo checked against the bottle | Decision | Confidence |
| --- | --- | --- |
| The reference photo itself | `consistent` | 100% |
| The sample drill photo | `suspicious` | 0% |
| The reference with red and blue swapped (a **blue** bottle) | `consistent` | 99% |

The last row is a known gap; see [Known limitation: colour](#known-limitation-colour).
Real camera photos will score below 100%.

| Table | Holds |
| --- | --- |
| `orders` | Order number, customer, order date |
| `order_items` | Product, SKU, serial, barcode (stored; lookup not built yet), price, **expected weight**, optional weight tolerance, CV catalog `product_id` |
| `order_images` | Original photos of the item before shipping (front/back/top/side/label) |
| `returns` | A return at a station: order + item, status, station, reviewer |
| `return_events` | Status history (audit trail) |
| `weight_checks` | Scale reading vs. expected weight, difference and pass/fail |
| `return_images` | Station camera photos of the returned item |
| `verifications` | CV result summary linked to a return (`request_id`, confidence, decision) |
| `decisions` | Reviewer outcome (`approve`, `secondary`, `fraud`), reason and note |

Weights are in grams. Without an item tolerance, a weight passes when it is within
2% of the expected weight or 5 g, whichever is larger.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/orders` | Create an order with its items (JSON) |
| GET | `/v1/orders?search=` | List or search orders by number, SKU, serial or customer |
| GET | `/v1/orders/{order_id}` | One order with items and original image URLs |
| POST | `/v1/orders/{order_id}/items/{item_id}/images` | Upload an original item photo (`file`, `view`) |
| GET | `/v1/order-images/{id}` | Original photo (JPEG) |
| POST | `/v1/returns` | Start a return for an order (`order_item_id` needed if several items) |
| GET | `/v1/returns?status=&order_id=&reviewer_email=` | List returns |
| GET | `/v1/returns/{id}` | Return with item, weights, photos, CV results, decision and history |
| POST | `/v1/returns/{id}/status` | Move to the next status |
| POST | `/v1/returns/{id}/weight` | Record a scale reading and compare it with the order |
| POST | `/v1/returns/{id}/images` | Upload a station photo (`file`, `view`) |
| GET | `/v1/return-images/{id}` | Station photo (JPEG) |
| POST | `/v1/returns/{id}/verifications` | Attach a `/v1/verify` result by `request_id` |
| POST | `/v1/returns/{id}/decision` | Record the final decision; completes the return |

```bash
curl http://127.0.0.1:8000/v1/returns -H 'Content-Type: application/json'   -d '{"order_id": "ORD-8921", "station": "Station 01"}'
curl http://127.0.0.1:8000/v1/returns/RET-XXXXXXXXXX/weight   -H 'Content-Type: application/json' -d '{"measured_weight_g": 1610}'
```

Only the Owala test photo is bundled. Enroll your own known-genuine reference images.
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
Alignment defaults to **foreground rectangle normalization**. No minimum local
feature-match count is required. Set `RETURNSCAN_ALIGNMENT_METHOD=features` and
restart to use the previous feature-based homography path. Only that path uses
`local_backend=auto`, `aliked` (fail if unavailable) or `sift`. This form field is
accepted for compatibility but does not change rectangle alignment.

The response includes:

- `confidence`: score from 0 to 1, higher means a stronger visual match.
- `confidence_percent`: the same score on a 0–100 scale.
- `decision`: `consistent`, `suspicious`, or `inconclusive`.
- `identified_product`, `compared_product`, `identity_consistent`,
  `identity_ambiguous`, and ranked candidates. Near-tied catalog matches require
  identity review instead of an arbitrary high-confidence SKU assignment.
- `geometry`: `alignment_method`, `alignment_quality`, `alignment_valid`,
  foreground IoU, selected corner orientation (`rotation_degrees`), zero-based
  reference index and reference attempts. Rectangle mode reports `outline_only`:
  validity means the foreground warp was applied, not verified feature alignment.
  `matches`, `inliers` and feature coverage remain zero in rectangle mode.
  `reference_corners` and `query_corners` are in each cropped foreground's pixel
  coordinates. Their respective 3×3 transforms map into the common `canvas_size`.
  `orientation_score` is mean spatial DINO patch cosine similarity plus 0.03 ×
  foreground IoU; it is only used to rank corner orientations.
  The optional feature path additionally reports MAGSAC++ match/inlier evidence
  and median symmetric reprojection error at a 1024-pixel long edge.
- `segmentation`: model name, query validity and foreground fractions before cropping.
- `score_is_informational`: true for an inconclusive comparison; do not use its
  confidence as evidence of authenticity.
- `diagnostic_image_urls`: original photo, foreground cutout, selected reference,
  aligned image, foreground mask and comparison mask. `reference` is the normalized
  reference used by PatchCore; `reference-foreground` is its original cutout.
  These use the same protected PNG route as discrepancy outputs. When alignment
  fails, the `aligned` URL is omitted and that PNG returns 404; the unaligned
  cutout remains available as `foreground`.
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

1. Local `rembg` + **U2Netp** (the small U²-Net model) segments each photo at
   320×320 on CPU. BiRefNet Lite remains an optional higher-resolution alternative.
   Threshold the mask, crop with a small margin, and replace background with white.
   Keep all foreground components so detached pieces are not deliberately discarded.
   Cache reference cutouts, masks and normalized DINO brightness variants.
   References rebuild after restart.
2. Frozen `dinov2_vits14` features retrieve the closest catalog product from native
   cutouts and rank its reference views. Try the closest usable reference first.
3. **Rectangle alignment is the default.** Fit a convex four-corner outline to
   the foreground, or use an enclosing minimum-area rectangle when necessary.
   Include detached foreground pieces in the fitted hull. Normalize the reference
   with OpenCV `getPerspectiveTransform` / `warpPerspective`, using a canvas up to
   512 pixels whose aspect follows the reference rectangle, with padding. Normalize
   the query into the same canvas. Test all four corner orientations and select
   the best spatial DINO patch similarity with a small mask-overlap term. Reference
   selection and orientation search are alignment heuristics, not authenticity votes.
   The default path does not load or require ALIKED/LightGlue/SIFT.
   The optional `features` mode retains the previous masked ALIKED/LightGlue +
   MAGSAC++ alignment, with SIFT fallback and distribution/reprojection checks.
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
   Rectangle alignment is labeled `outline_only`; internal pixel correspondence
   is not verified. A failed warp or empty query segmentation produces `inconclusive`; any
   unrestricted patch score is informational. An unusable reference requires
   replacement, and model loading errors return `503` rather than fabricated scores.

Rectangle normalization can change patch scores and can normalize away changes
in overall proportions. Existing thresholds need re-evaluation after changing
alignment methods.

### Known limitation: colour

The check does not compare colour. DINOv2 features and the patch scores respond
mainly to shape and texture, so the same product in a different colour passes:
the hot pink Owala reference recoloured blue scored `consistent` at 99%. A
wrong-colour return (e.g. a cheaper colourway swapped in) is not caught. A fix
would add a colour comparison inside the shared foreground mask (for example a
hue/saturation histogram or mean Lab colour distance, with a per-product
threshold) as a separate reason that triggers review. Lighting and white balance
at the station will shift colour, so any threshold needs testing with real photos.

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
- `RETURNSCAN_ALIGNMENT_METHOD`: `rectangle` (default), or `features` for the
  previous ALIKED/LightGlue + MAGSAC++ path. Restart after changing it so reference
  patch banks rebuild in the correct coordinate system.
- `RETURNSCAN_SEGMENTATION_MODEL`: defaults to `u2netp` (320×320, ~4.6 MB).
  Set `birefnet-general-lite` for the previous 1024×1024 model (~224 MB), or
  `isnet-general-use` for another alternative. Changing it rebuilds reference masks
  on restart and needs new validation. Segmentation runs on ONNX CPU.
  Existing `.env` files with the old model name override the new default.
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
and rectangle normalization is only a coarse shape alignment. It can include
visible sidewalls and cannot establish correspondence across arbitrary 3D views. Segmentation
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
download models. They also exercise real patch-distance math, rectangle/perspective warping, quarter-turn orientation selection,
feature-mode MAGSAC++, masked keypoints,
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

### Rectangle alignment HTTP smoke test (current default)

Tested on Apple M4 with a small product reference and a separate table photo of
an object, including 90° and 180° rotations of the query. All six HTTP requests
applied rectangle alignment and returned decodable diagnostic/discrepancy PNGs.
The selected orientations kept the object upright relative to the reference.
Warm end-to-end processing took **390–418 ms**; the first request with cached
weights took **1.48 s**. The default path never initialized ALIKED/LightGlue.

This demonstrates coarse outline normalization and API behavior; it does not
validate pixel correspondence or authenticity accuracy. Recorded stage timings
are in [`benchmarks/rectangle-alignment.json`](benchmarks/rectangle-alignment.json).
Source photos supplied for this test are not committed.

### Small-model benchmark (previous feature-alignment version)

On Apple M4, CPU execution, four threads, eight real photos (three phones, two
bottles, a cable, a metal nut, and a circuit board), two warm runs per photo:

| Model | Input | Checkpoint | Median segmentation time |
| --- | --- | --- | --- |
| U2Netp (default) | 320×320 | 4.6 MB | 106 ms |
| BiRefNet General Lite | 1024×1024 | 224 MB | 3,960 ms |

Times include preprocessing, model inference, thresholding and cropping. U2Netp
was about **37× faster** on this small sample. Foreground reference masks and
features are still cached; the uploaded query is segmented once per request.

The same real-photo rotation/scale HTTP control below took **1.47 seconds warm**
with U2Netp (~110 ms segmentation), versus 6.57 seconds previously with BiRefNet.
Those full-pipeline numbers used the previous feature-based alignment; the
segmentation-only comparison is independent of the new rectangle path.
All diagnostic PNGs were fetched and decoded. This tests alignment on a transformed
reference, not authenticity accuracy on independent photos.

Visual inspection: phone and circuit-board masks broadly agree. U2Netp preserves
more of the glass-bottle rim, but misses the cable's outer jacket and fills the
metal nut's hole. Neither model is ground truth; keep BiRefNet available for
products where the small model removes important parts. Mask validity only checks
for an adequately sized foreground; it does not guarantee a correct segmentation.
Recorded measurements are in [`benchmarks/segmentation-models.json`](benchmarks/segmentation-models.json).

Reproduce on your own images, with local mask overlays and cutouts for review:

```bash
python -m backend.benchmark_segmentation \
  --image /path/to/phone.jpg \
  --image /path/to/another-product.jpg \
  --repeat 3 \
  --output-dir backend/.runtime/segmentation-comparison
```

This compares `u2netp` with `birefnet-general-lite`; `--models` accepts other
rembg model names. The JSON includes image hashes, individual timings and mask
agreement. Agreement between models is **not** segmentation accuracy.

### Previous BiRefNet Lite smoke test

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
- [U²-Net / U2Netp](https://github.com/xuebinqin/U-2-Net), Apache-2.0.
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), MIT (optional model).
- [OpenCV USAC / MAGSAC++](https://docs.opencv.org/4.x/de/d3e/tutorial_usac.html).
- [RANSAC paper](https://doi.org/10.1145/358669.358692).

Code/weight sources are pinned where fetched through Git. Review upstream
licenses before redistributing models. No pretrained weights, source product
photos or user-specific paths are committed to this repository.
