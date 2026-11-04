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
