# ReturnScan

ReturnScan is a React application for processing product returns. It guides a reviewer through identifying a returned item, inspecting it, and reviewing a decision.

## Requirements

- Node.js and npm

## Run locally

From the project directory, install the dependencies and start the development server:

```bash
npm install
npm run dev
```

Open the local URL printed in the terminal. Vite typically uses [http://localhost:5173](http://localhost:5173); if that port is already in use, Vite will select another available port.

## Available scripts

- `npm run dev` starts the Vite development server with hot module replacement.
- `npm run build` creates a production build in `dist/`.
- `npm run preview` serves the production build locally after running `npm run build`.
- `npm run lint` runs ESLint.

## Signing in

The app opens on a sign-in page. Three sign-in methods are available:

- **Email and password** — the prototype has no backend, so it accepts built-in demo accounts only:
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
