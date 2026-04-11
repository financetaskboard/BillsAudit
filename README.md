# Odoo Bill Audit Portal

A single-page audit dashboard for Odoo vendor bills — checks attachments, narration, TDS, GST, and account mapping. Scan results and settings are persisted to **Firebase Firestore**.

---

## Live Demo
Once deployed on Render, your app will be at:
`https://odoo-bill-audit.onrender.com` (or your chosen service name)

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (single file) |
| Hosting | Render (Static Site) |
| Database | Firebase Firestore |

---

## 1 — Firebase Setup

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com) and create a project (e.g. `odoo-bill-audit`).
2. In the project, click **Add app → Web**. Give it a nickname and register.
3. Copy the `firebaseConfig` object shown — you'll need these values:
   - `apiKey`
   - `projectId`
   - `authDomain`
   - `appId`
4. In the Firebase console, go to **Build → Firestore Database → Create database**.
   - Choose **Start in test mode** (you can add security rules later).
   - Pick a region close to you (e.g. `asia-south1` for India).

That's it. No Firebase CLI needed — the app uses the JS SDK via CDN.

---

## 2 — GitHub Setup

```bash
# Clone or init repo
git init
git add .
git commit -m "Initial commit — Odoo Bill Audit Portal"

# Push to GitHub (create a new repo on github.com first)
git remote add origin https://github.com/YOUR_USERNAME/odoo-bill-audit.git
git branch -M main
git push -u origin main
```

---

## 3 — Deploy on Render

1. Go to [https://render.com](https://render.com) and sign in.
2. Click **New → Static Site**.
3. Connect your GitHub account and select the `odoo-bill-audit` repo.
4. Render will auto-detect `render.yaml`. Settings will be:
   - **Publish directory:** `.`
   - **Build command:** *(leave blank)*
5. Click **Create Static Site**. Render will deploy in ~30 seconds.

> No environment variables are needed — Firebase credentials are entered directly in the app's **Settings → Firebase Configuration** panel and saved to `localStorage` for auto-reconnect on reload.

---

## 4 — Connect Firebase in the App

1. Open your deployed app (or `index.html` locally).
2. Go to **Settings** (top-right gear icon).
3. Scroll to the **🔥 Firebase Configuration** panel.
4. Paste in your `apiKey`, `Project ID`, `Auth Domain`, and `App ID`.
5. Click **Connect Firebase**.

From that point on:
- Every **Run Full Scan** automatically saves results to Firestore (`scanResults` collection).
- On next load, the last scan is restored from Firestore.
- **Save Settings** and **Save Rules** also persist to Firestore.

---

## Firestore Data Structure

```
scanResults/          ← one document per scan
  {auto-id}/
    timestamp         (server timestamp)
    scanDate          (ISO string)
    summary: { total, flagged, clean, avgScore }
    bills: [ ...array of bill objects ]

config/
  odoo/               ← Odoo connection settings
    odooUrl, odooDb, odooUser, updatedAt
  rules/              ← Audit rule thresholds
    minNarLen, accThreshold, tdsThreshold, dupDays, updatedAt
```

---

## Local Development

Just open `index.html` in a browser — no build step required.

```bash
# Optional: serve with any static server
npx serve .
# or
python3 -m http.server 8080
```

---

## Security Note

Before going to production, update Firestore security rules to restrict read/write access. Example:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Add Firebase Authentication to the app if you want user-level access control.
