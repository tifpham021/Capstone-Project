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
another can start. Set the expected product to avoid a separate catalog-identification
API call for each camera. Do not enable an automatic paid scan loop unless desired.

Luna inference uses the OpenAI API; it needs outbound internet and a server-side
key on the **machine running this backend**. It does not need a local GPU,
segmentation, alignment, DINO or LightGlue. Captured/reference images leave
the backend for the comparison request, which sets `store=false`.

## Remote frontend

On the Mac, set this in `.env.local`, then restart Vite:

```dotenv
RETURNSCAN_API_PROXY_TARGET=http://172.20.10.7:8000
```

The existing Vite `/v1` proxy forwards both scan/poll requests and protected
result PNGs to the Pi. Keep `VITE_API_BASE_URL` empty to use that proxy.
If the Pi requires `RETURNSCAN_API_KEY`, configure the same value server-side
on the Vite host; do not expose either key as a `VITE_*` variable.

The Pi must be reachable at this address from the Mac. This is a private LAN
address; configure firewall/access control before exposing the backend elsewhere.

## Request flow and response

1. **Scan item** posts `/v1/cameras/scan`; the Pi captures fresh frames.
2. The camera worker calls the Luna verifier for each available view.
3. The frontend polls `/v1/cameras/scans/{scan_id}` until completion.
4. `ScanResults` renders the reference beside the boxed return image for each camera.

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
