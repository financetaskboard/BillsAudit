# Odoo Bill Audit Portal

A single-page audit dashboard for Odoo vendor bills — checks attachments,
narration, TDS, GST, and account mapping against a **live Odoo instance**.
Scan results and settings are persisted to **Firebase Firestore**.

---

## Architecture

```
Browser (index.html)
    │
    ├─── Direct ──────────────────────────► Odoo  (self-hosted with CORS headers)
    │
    └─── Via Proxy ──► odoo-cors-proxy ──► Odoo  (odoo.com SaaS or any host
                        (Node on Render)           without CORS headers)
```

| Layer    | Technology                         |
|----------|------------------------------------|
| Frontend | Vanilla HTML/CSS/JS (single file)  |
| Proxy    | Node.js Express (Render Web Service)|
| Hosting  | Render (Static Site + Web Service) |
| Database | Firebase Firestore                 |

---

## Do I need the proxy?

| Odoo hosting          | Need proxy? |
|-----------------------|-------------|
| odoo.com SaaS         | **Yes** — browsers are blocked by CORS |
| Self-hosted (nginx)   | Only if you haven't added CORS headers |
| Self-hosted (same domain) | No |

### Adding CORS headers to self-hosted Odoo (nginx)

```nginx
location / {
    add_header 'Access-Control-Allow-Origin'  'https://odoo-bill-audit.onrender.com' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Content-Type, Cookie' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;
    if ($request_method = OPTIONS) { return 204; }
    proxy_pass http://127.0.0.1:8069;
}
```

---

## 1 — Firebase Setup

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com) → create project (e.g. `odoo-bill-audit`).
2. **Add app → Web**. Copy the `firebaseConfig` object.
3. **Build → Firestore Database → Create database** → Start in test mode → region `asia-south1`.

No CLI needed — the app uses the JS SDK via CDN.

---

## 2 — GitHub Setup

```bash
git init
git add .
git commit -m "Initial commit — Odoo Bill Audit Portal"
git remote add origin https://github.com/YOUR_USERNAME/odoo-bill-audit.git
git branch -M main
git push -u origin main
```

---

## 3 — Deploy on Render

The `render.yaml` deploys **two services** automatically.

1. Go to [https://render.com](https://render.com) → **New → Blueprint**.
2. Connect your GitHub repo.
3. Render detects `render.yaml` and creates both services:
   - **`odoo-bill-audit`** — static site (the dashboard)
   - **`odoo-cors-proxy`** — Node.js proxy (needed for odoo.com SaaS)
4. After deploy, copy the proxy URL (e.g. `https://odoo-cors-proxy.onrender.com`).
5. In Render dashboard → `odoo-cors-proxy` service → **Environment** → set:
   ```
   ALLOWED_ORIGIN = https://odoo-bill-audit.onrender.com
   ```

> **Free tier note:** Render free services spin down after 15 minutes of inactivity.
> The first scan after a cold start may take ~30 seconds while the proxy wakes up.
> Upgrade to the Starter plan ($7/mo) to avoid cold starts.

---

## 4 — Connect Odoo & Firebase in the App

1. Open your deployed app → **Settings** (top-right gear icon).
2. **Odoo Connection** panel:
   - **Odoo URL** — e.g. `https://ginesys.odoo.com`
   - **Database** — your Odoo database name
   - **Username** — your Odoo login email
   - **Password / API Key** — your Odoo password
   - **CORS Proxy URL** — paste the proxy URL from step 3 (leave blank if self-hosted with CORS)
   - Click **Test Connection** — you should see your user name and company.
3. **Firebase Configuration** panel:
   - Paste `apiKey`, `Project ID`, `Auth Domain`, `App ID`.
   - Click **Connect Firebase**.
4. Click **Save Settings**, then **▶ Run Full Scan**.

---

## What the scan does (live Odoo calls)

| Step | Odoo model queried | Check |
|------|--------------------|-------|
| Auth | `/web/session/authenticate` | Login |
| Bills | `account.move` | Fetch all posted vendor bills |
| Attachments | `ir.attachment` | Flag bills with no PDF/image attached |
| Narration | `account.move` `.narration` / `.ref` | Flag empty or too-short descriptions |
| Account pattern | `account.move.line` | Flag deviations from vendor's historical account |
| TDS | `account.move.line` (tax lines) | Flag missing or potentially wrong tax sections |
| GST | tax line names | Flag bills with contradictory IGST + CGST/SGST |

---

## Firestore Data Structure

```
scanResults/
  {auto-id}/
    timestamp, scanDate
    summary: { total, flagged, clean, avgScore }
    bills: [ ...array of bill objects with _odooId ]

config/
  odoo/    — odooUrl, odooDb, odooUser, odooProxy, updatedAt
  rules/   — minNarLen, accThreshold, tdsThreshold, dupDays, updatedAt
```

---

## Local Development

```bash
# Frontend — just open index.html in a browser (no build step)
npx serve .

# Proxy (optional for local testing)
node proxy.js
# Then set CORS Proxy URL in Settings to: http://localhost:3000
```

---

## Security Notes

- The password / API key is stored only in your browser's `localStorage` — it is **never** sent to Firebase.
- Before going to production, lock down Firestore rules and set `ALLOWED_ORIGIN` on the proxy to your exact frontend URL.
- Consider using an [Odoo API key](https://www.odoo.com/documentation/17.0/developer/reference/external_api.html#api-keys) instead of your password.
