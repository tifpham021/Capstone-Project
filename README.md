# ReturnScan

ReturnScan helps a reviewer process product returns. The reviewer identifies
the returned item, inspects it (weight and photos), and records a decision. A
computer vision (CV) check compares the return photo with the original order's
photos and suggests whether they match. The reviewer always makes the final call.

The project has three parts:

| Part | Where | What it does |
| --- | --- | --- |
| **Frontend** | [`src/`](src/) | React + Vite app. A desktop UI for computer workstations and a touchscreen UI for the Raspberry Pi station |
| **Backend API** | [`backend/`](backend/README.md) | Python/FastAPI service. Serves the CV check and the orders/returns database |
| **Database** | `backend/.runtime/returnscan.db` | SQLite: orders, original photos, expected weights, returns, weight checks, CV results, decisions |

```text
 Desktop UI / Pi touchscreen  ──HTTP──▶  FastAPI backend (port 8000)
   (React, port 5173)                      ├─ /v1/orders, /v1/returns  → SQLite + saved JPEGs
                                           └─ /v1/products, /v1/verify → CV pipeline (DINOv2 …)
```

## Quick start

You need **Node.js** and **Python 3.11–3.13**. Run the backend and the frontend
in two terminals from the repository root.

**1. Backend** (the first CV check downloads model weights, so it needs internet once):

```bash
python -m venv backend/.venv
# macOS/Linux:
source backend/.venv/bin/activate
# Windows (Git Bash):  source backend/.venv/Scripts/activate
# Windows (PowerShell): backend\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

**2. Demo data** (in another terminal with the venv active, once the API is up):

```bash
python -m backend.seed --enroll
```

This adds the demo orders `ORD-8921` (cordless drill), `ORD-9004` (headphones and
cable) and `ORD-1032` (Owala water bottle). It also enrolls the bottle's photo in
the CV catalog. Running it again is safe.

**3. Frontend:**

```bash
npm install
npm run dev
```

Open <http://localhost:5173>, choose **Use demo account**, and sign in. If the
backend is not running, the desktop UI still works with a built-in demo return,
but nothing is saved (the screen says so).

### Try the CV check

1. Look up `ORD-1032` and select **Begin inspection**. The original order photo
   appears as the shipped reference.
2. Enter the scale reading in kg (the order expects about 0.43 kg) and select
   **Record weight**.
3. Select **Add photo** and take or upload a photo of the returned bottle. The
   photo is saved to the return and sent to the CV check. The first check after
   the server starts takes up to a minute while models load.
4. Continue to review. The evidence package shows the weight, the visual match
   percentage and both photos. Choose a decision; it is saved with the return.

Results so far: the reference photo against itself scores 100%, and the drill
photo scores 0% (`suspicious`). **The CV check does not compare colour yet.** A
blue version of the bottle still scored 99% (see
[Known limitations](#known-limitations)).

## Desktop and touchscreen UI

One codebase builds both UIs. Choose which one appears:

| How | Example | Notes |
| --- | --- | --- |
| URL parameter | `http://localhost:5173/?ui=touch` | Remembered in that browser. `?ui=desktop` switches back; `?ui=default` clears it |
| Environment variable | `VITE_UI_MODE=touch` in `.env.local` | The default for that machine. Restart `npm run dev` after changing |
| Nothing set | | Desktop UI |

You can test the Raspberry Pi touchscreen UI on any computer with `?ui=touch`.
Use your browser's device toolbar (F12, then the phone/tablet icon) to try the
Pi screen size and touch input. The **desktop UI** uses the backend database and
CV check for the whole return. The touchscreen UI only calls the CV check to identify
an item from a photo; its returns still run on demo data and are not saved.

## Backend and database

The backend in [`backend/`](backend/README.md) does two jobs.

**Records database.** It stores what the checks compare against:

- **Orders:** order ID and customer.
- **Order items:** product, SKU, serial number, barcode, price, **expected weight**
  and weight tolerance, and the CV catalog `product_id`.
- **Original order photos.**

For each **return** it stores:

- the status history
- each scale reading compared with the order
- station photos
- CV results
- the reviewer's decision

By default this is a SQLite file. Set `RETURNSCAN_DATABASE_URL` to use PostgreSQL
instead. Photos are saved as cleaned JPEG files next to the database.

A weight passes when it is within the item's tolerance. Items without a tolerance
pass within 2% of the expected weight or 5 g, whichever is larger. Barcodes are
stored but barcode lookup is not built yet.

The desktop UI uses the database for all four steps of a return:

1. It looks up the order.
2. It creates the return.
3. It saves each weight and photo during inspection.
4. It records the decision.

**CV API.** You enroll a product with 1–8 genuine reference photos
(`POST /v1/products`). After that, `POST /v1/verify` compares a return photo with
those references and returns:

- a decision: `consistent`, `suspicious` or `inconclusive`
- a visual-match confidence
- the reasons for the decision
- discrepancy and heatmap images

Interactive docs for every route are at <http://127.0.0.1:8000/docs>. The
[backend README](backend/README.md) has the full route list, curl/JavaScript
examples, configuration (`RETURNSCAN_*` variables, API key, CORS) and tests.

## How the CV check works

1. **Remove the background.** rembg with the small U2Netp model cuts the
   product out of each photo.
2. **Find the product.** DINOv2 ViT-S/14 features find the closest enrolled
   product and its most similar reference photo.
3. **Line up the views.** By default, each cut-out's outline is fitted to a
   rectangle and warped onto a common canvas. All four orientations are tried
   and the best one is kept. ALIKED/LightGlue feature matching is an optional
   alternative (`RETURNSCAN_ALIGNMENT_METHOD=features`).
4. **Compare patches.** Nearby DINOv2 patches inside the product are compared,
   PatchCore-style. Outline differences are tracked separately.
5. **Score.** Product similarity (15%) and patch similarity (85%) are combined
   into the confidence. If the views cannot be aligned, the result is
   `inconclusive` and the UI hides the percentage.

It runs on CPU, Apple Silicon (MPS) or CUDA.

## Known limitations

- **No colour check.** The CV check compares shape and texture, not colour, so
  a different colourway of the same product passes. The backend README
  describes a possible fix.
- **Thresholds are not calibrated.** This is a proof of concept, not a validated
  counterfeit detector. Treat the confidence as a signal for the reviewer.
- **Demo values.** The `ORD-1032` weight (430 g) and price are estimates.
  Weigh a real bottle and update [`backend/seed.py`](backend/seed.py).
- **Not wired yet:**
  - the touchscreen UI to the orders/returns database
  - barcode lookup
  - account history from the database (it is still kept in the browser)
- **Sign-in is a frontend prototype.** The backend only supports an optional
  shared API key (`RETURNSCAN_API_KEY`), not per-user accounts.

## Project layout

```text
src/
  App.jsx, uiMode.js            picks the desktop or touchscreen UI
  DesktopApp.jsx                desktop workflow (identify → inspect → review)
  ItemInspection.jsx            weight entry, photos, CV check
  ReviewDecision.jsx            evidence package and decision
  api.js, returnRecords.js      backend calls and data conversion
  TouchApp.jsx, Touchscreen.jsx Raspberry Pi touchscreen UI
backend/
  main.py                       FastAPI app and CV routes
  records.py, database.py       orders/returns routes and tables
  service.py, alignment.py, foreground.py, algorithms.py   CV pipeline
  seed.py, samples/             demo orders and the Owala reference photo
  tests/                        pytest suite
```

## Scripts and tests

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the frontend dev server |
| `npm run build` | Production build in `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | ESLint |
| `python -m pip install -r backend/requirements-dev.txt` | Install the backend test tools |
| `python -m pytest backend` | Backend tests (no model downloads) |
| `ruff check backend && ruff format --check backend` | Python lint and formatting |

## Signing in

The app opens on a sign-in page. Three sign-in methods are available:

- **Email and password** — authentication is still a frontend prototype, so it accepts built-in demo accounts only:
  - `jane.doe@returnscan.com` / `ReturnScan2026!` (Reviewer)
  - `alex.kim@returnscan.com` / `ReturnScan2026!` (Supervisor)
- **Google** and **Microsoft** — real OAuth popups. They need client IDs; until those are set, the buttons show a "Setup needed" badge and explain what is missing.

To enable Google and Microsoft sign-in, copy `.env.example` to `.env.local`, fill in the IDs, and restart `npm run dev`:

1. **Google:** in Google Cloud Console, create an OAuth client ID of type *Web application* and add `http://localhost:5173` to *Authorized JavaScript origins*. Put the client ID in `VITE_GOOGLE_CLIENT_ID`.
2. **Microsoft:** in the Microsoft Entra admin center, register an app and add a *Single-page application* redirect URI of `http://localhost:5173/auth-redirect.html`. Put the Application (client) ID in `VITE_MICROSOFT_CLIENT_ID`. Leave `VITE_MICROSOFT_TENANT_ID=common` to allow both work and personal accounts.

If Vite runs on a different port, register that origin instead.

Once signed in, open the profile menu in the top-right corner to reach the **Account dashboard** or **Sign out**. The dashboard shows decision totals, recent decisions, the open return, profile and session details, and station preferences. Preferences and decision history are stored in the browser per account.

## Scanning item identity

On the **Identify return** screen, the scanner panel can read barcodes and QR codes in two ways:

- **Scan with camera** opens the station camera and reads a code automatically as soon as it is in frame. The browser asks for camera permission the first time. Camera access only works on `localhost` or over HTTPS.
- **Scan from photo** reads the code from an image file instead.

A detected code is placed in the lookup field. With the **Scanner auto-detect** preference on (account dashboard), the return is looked up immediately; with it off, the reviewer checks the code and selects **Find return**. Scanning uses [ZXing](https://github.com/zxing-js/browser), which supports QR, Code 128, Code 39, EAN, UPC, Data Matrix and other common formats.
