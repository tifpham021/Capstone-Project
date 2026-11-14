# Live camera inspection backend

This is the functional **Scan item** workflow on `local-ui-rectangle-alignment`.
The Pi's one/two-camera capture, stillness gate, job IDs and polling routes are
preserved. GPT-6 Luna (reasoning off) is now the default decision engine.

## Pi setup

```bash
git switch local-ui-rectangle-alignment
git pull --ff-only
python -m pip install -r backend/requirements.txt
# Keep the camera settings in backend/.env and add:
# OPENAI_API_KEY=...
# RETURNSCAN_DECISION_ENGINE=luna
# RETURNSCAN_OPENAI_MODEL=gpt-6-luna
# RETURNSCAN_OPENAI_REASONING=none
python -m uvicorn backend.main:app --env-file backend/.env --host 0.0.0.0 --port 8000 --workers 1
```

Camera setup remains `RETURNSCAN_CAMERAS_ENABLED=1`, `RETURNSCAN_CAMERA_IDS=0,1`
(or a single ID), `RETURNSCAN_CAMERA_PRODUCT_ID=<enrolled product ID>`, and
`RETURNSCAN_CAMERA_AUTO_SCAN=0` for button-only scans. Existing Picamera2 and
OpenCV capture requirements still apply. Unavailable cameras are skipped if
another can start. Order-based scans use the order's product instead of the
station-wide `RETURNSCAN_CAMERA_PRODUCT_ID`. That setting still applies to legacy
scans without an order. Do not enable an automatic paid scan loop unless desired.

Luna inference uses the OpenAI API; it needs outbound internet and a server-side
key on the **machine running this backend**. It does not need a local GPU,
segmentation, alignment, DINO or LightGlue. Captured/reference images leave
the backend for the comparison request, which sets `store=false`.

## Frontend on the same Pi

Start Vite in a second terminal on the Pi, from the repository root:

```bash
RETURNSCAN_API_PROXY_TARGET=http://127.0.0.1:8000 npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
```

The existing Vite `/v1` proxy forwards both scan/poll requests and protected
result PNGs to the local backend. Keep `VITE_API_BASE_URL` empty to use that proxy.
If the Pi requires `RETURNSCAN_API_KEY`, configure the same value server-side
on the Vite host; do not expose either key as a `VITE_*` variable.

Open `http://localhost:5173` on the Pi, or `http://100.70.178.175:5173` from
another device that can reach the Pi. The browser uses the frontend's origin;
the Pi's Vite process forwards API requests to `127.0.0.1:8000`.

## Request flow and response

1. **Scan item** opens a modal. Enter **1** and submit with **Scan item** or Enter.
2. Submission uses `GET /v1/orders/1` to load the black iPhone 15, its reference count and **171 g** expected weight.
3. A valid order immediately posts `{"order_number":"1"}` to `/v1/cameras/scan`; the Pi captures fresh frames. There is no separate lookup/confirmation step. An unknown order stays in the modal with an error and does not capture.
4. The worker compares each view against `iphone-15` references and takes one simulated weight reading for the entire scan.
5. The frontend polls `/v1/cameras/scans/{scan_id}` and renders the reference/boxed return image, weight difference and combined check result. The review screen retains the same reading.

The backend automatically creates `orders.sqlite3` inside `RETURNSCAN_DATA_DIR`
(default `backend/.runtime`) with demo order **1**. SQLite uses Python's standard
library; no database server or additional package is needed. If `iphone-15` is
already enrolled, its reference photos are preserved. Otherwise a bundled demo
reference is enrolled automatically; see [sample attribution](samples/README.md).
Replace that photo with your own verified reference using the enrollment routes
or `backend/enroll_iphone15.py`.

The **demo** sensor samples uniformly within ±5% of 171 g: **162.45–179.55 g**.
The weight tolerance is also ±5%, so this simulated reading passes by design.
It demonstrates the comparison UI; it is not a real scale measurement. Weight is
sampled once per scan and stays fixed during polling. A visual mismatch or failed
weight check makes the combined result suspicious; missing or inconclusive visual
results require review. Passing weight never overrides a visual mismatch.

Completed jobs add `order`, `weight` and `decision` to the existing per-camera
response. `weight` contains expected/measured grams, signed differences, tolerance,
`within_tolerance` and `sensor_mode: "demo"`. The order is snapshotted when the job
is queued, so later database edits cannot change an in-progress scan. Calls without
a JSON body remain supported for existing camera clients, without an order/weight check.

Results include `verdict`, `verdict_confidence`, five flags, discrepancies with
normalized 0–1000 boxes, the selected reference index and stage latency. Flags
are damage, different item, missing parts, counterfeit evidence and insufficient
visual evidence; each contains status (present/absent/unknown), confidence and evidence.
`summary` and `limitations` are omitted.

The frontend uses `reference_image_url` and `annotated_image_url`. Also available:
`original_image_url`, `annotated_reference_image_url` and a side-by-side
`discrepancy_image_url`. These are `/v1/results/{request_id}/*.png` paths served
through the same authenticated proxy. Numbered boxes correspond to the listed
discrepancies. `geometry`, `patchcore` and `heatmap_image_url` are null for Luna.

Confidence describes the model's assessment, including a rejection; it is not
a visual-match percentage or a calibrated authenticity probability. Unknown
condition/identity flags require review. The reviewer makes the final return decision.
Provider failure gives a per-camera error; no CV score is silently substituted.

Existing product enrollment, barcode/expected-product comparison, reference
replacement and batch routes remain available. Luna compares up to eight
reference views and picks the closest one for localization. Without an explicit
product, catalog identification uses one reference per product (maximum 20 products)
in an additional API request.

## Legacy local CV

Set `RETURNSCAN_DECISION_ENGINE=cv` and install `backend/requirements-cv.txt`
to use the previous engine. See [legacy documentation](README-CV.md).
The old normalized images/metrics remain supported in the frontend for that engine.

## Checks

```bash
python -m pip install -r backend/requirements-dev.txt
python -m pytest backend/tests -q
npm run lint
npm run build
```

Camera tests use fake Picamera2 devices to cover one/two-camera capture and
missing-camera fallback. Provider tests cover the real request schema, flags,
boxes, PNG delivery and API failure behavior without spending API credits.
