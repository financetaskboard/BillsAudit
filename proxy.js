'use strict';

/**
 * Odoo CORS Proxy — Bills Audit Portal
 * ─────────────────────────────────────
 * Two modes:
 *
 *  1. SMART SYNC  — POST /api/odoo/sync-bills
 *     Does the full Odoo scan server-side (auth + bills + attachments +
 *     account lines + tax lines + audit scoring) and returns a ready-to-render
 *     bill array.  No CORS issues because the browser never touches Odoo.
 *     This mirrors exactly how the TDS app calls /api/odoo/sync-tds.
 *
 *  2. DUMB PASSTHROUGH — ANY /:host/*
 *     Forwards raw browser requests to Odoo and adds CORS headers.
 *     Still used for "Test Connection" (testConnection() in index.html).
 *
 * Deploy on Render as a Node "Web Service".
 * Set ALLOWED_ORIGIN env var to your frontend URL.
 */

const express = require('express');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie, X-Requested-With');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'Odoo Bill Audit Proxy running', ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: make a single Odoo JSON-RPC call from Node (no browser CORS issue)
// ─────────────────────────────────────────────────────────────────────────────
function odooRpc(odooUrl, path, params, sessionCookie) {
  return new Promise((resolve, reject) => {
    const url    = new URL(odooUrl.replace(/\/+$/, '') + path);
    const body   = JSON.stringify({ jsonrpc: '2.0', method: 'call', id: Date.now(), params });
    const isHttp = url.protocol === 'http:';
    const lib    = isHttp ? http : https;

    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Accept':         'application/json',
    };
    if (sessionCookie) headers['Cookie'] = sessionCookie;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (isHttp ? 80 : 443),
      path:     url.pathname + url.search,
      method:   'POST',
      headers,
    }, (res) => {
      // Capture Set-Cookie for session continuity across calls
      const setCookie = res.headers['set-cookie'];
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (json.error) {
            const msg = (json.error.data && json.error.data.message) || json.error.message || 'RPC error';
            return reject(new Error(msg));
          }
          resolve({ result: json.result, setCookie });
        } catch (e) {
          reject(new Error('Invalid JSON from Odoo: ' + e.message));
        }
      });
    });

    req.on('error', err => reject(new Error('Odoo request failed: ' + err.message)));
    req.write(body);
    req.end();
  });
}

// Helper: Odoo search_read via JSON-RPC
async function searchRead(odooUrl, cookie, userCtx, model, domain, fields, limit = 500, order = 'invoice_date desc') {
  const { result } = await odooRpc(odooUrl, '/web/dataset/call_kw', {
    model,
    method:  'search_read',
    args:    [domain],
    kwargs:  { fields, limit, order, context: userCtx || {} },
  }, cookie);
  return result || [];
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMART ENDPOINT: POST /api/odoo/test-connection
//
//  Body: { url, db, username, password }
//  Returns: { ok: true, name, company }  |  { ok: false, error: '...' }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/odoo/test-connection', async (req, res) => {
  const { url, db, username, password } = req.body || {};
  if (!url || !db || !username || !password) {
    return res.json({ ok: false, error: 'url, db, username and password are required' });
  }
  try {
    const { result: session } = await odooRpc(url, '/web/session/authenticate', {
      db, login: username, password,
    });
    if (!session || !session.uid) throw new Error('Authentication failed — check credentials or database name');
    res.json({
      ok:      true,
      name:    session.name,
      company: session.company_id ? session.company_id[1] : '?',
      uid:     session.uid,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});


//
//  Body: { url, db, username, password, minNarLen?, tdsThreshold?, accThreshold? }
//  Returns: { ok: true, bills: [...] }  |  { ok: false, error: '...' }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/odoo/sync-bills', async (req, res) => {
  const { url, db, username, password, minNarLen = 5, tdsThreshold = 30000, accThreshold = 70 } = req.body || {};

  if (!url || !db || !username || !password) {
    return res.json({ ok: false, error: 'url, db, username and password are required' });
  }

  const log = [];
  try {
    // ── Step 1: Authenticate ─────────────────────────────────────────────────
    log.push('Authenticating with Odoo…');
    const { result: session, setCookie: authCookie } = await odooRpc(url, '/web/session/authenticate', {
      db, login: username, password,
    });
    if (!session || !session.uid) throw new Error('Authentication failed — check credentials/database');
    const cookie  = authCookie ? authCookie.join('; ') : '';
    const userCtx = session.user_context || {};
    log.push(`Authenticated as ${session.name} (uid ${session.uid})`);

    // ── Step 2: Fetch posted vendor bills ────────────────────────────────────
    log.push('Fetching vendor bills…');
    const rawBills = await searchRead(url, cookie, userCtx,
      'account.move',
      [['move_type', '=', 'in_invoice'], ['state', '=', 'posted']],
      ['id', 'name', 'partner_id', 'invoice_date', 'journal_id', 'amount_total', 'narration', 'ref', 'invoice_line_ids'],
      500
    );
    log.push(`Fetched ${rawBills.length} bills`);

    const billIds = rawBills.map(b => b.id);
    if (!billIds.length) {
      return res.json({ ok: true, bills: [], log });
    }

    // ── Step 3: Fetch attachments ─────────────────────────────────────────────
    log.push('Checking attachments…');
    const atts = await searchRead(url, cookie, userCtx,
      'ir.attachment',
      [['res_model', '=', 'account.move'], ['res_id', 'in', billIds]],
      ['res_id'],
      5000,
      'id asc'
    );
    const attachedSet = new Set(atts.map(a => a.res_id));
    log.push(`Found attachments for ${attachedSet.size} bills`);

    // ── Step 4: Fetch product lines (for account pattern) ────────────────────
    log.push('Analysing account patterns…');
    const lines = await searchRead(url, cookie, userCtx,
      'account.move.line',
      [['move_id', 'in', billIds], ['display_type', '=', 'product']],
      ['move_id', 'account_id', 'partner_id'],
      5000,
      'id asc'
    );
    // vendor → { accountId: count }
    const vMap = {};
    lines.forEach(l => {
      const vid = l.partner_id && l.partner_id[0];
      const aid = l.account_id && l.account_id[0];
      if (!vid || !aid) return;
      if (!vMap[vid]) vMap[vid] = {};
      vMap[vid][aid] = (vMap[vid][aid] || 0) + 1;
    });
    // move_id → account used
    const moveAcc = {};
    lines.forEach(l => { if (l.account_id) moveAcc[l.move_id[0]] = l.account_id; });

    // ── Step 5: Fetch tax lines (TDS + GST checks) ───────────────────────────
    log.push('Checking TDS and GST entries…');
    const taxLines = await searchRead(url, cookie, userCtx,
      'account.move.line',
      [['move_id', 'in', billIds], ['tax_line_id', '!=', false]],
      ['move_id', 'tax_line_id', 'balance'],
      5000,
      'id asc'
    );
    const taxMap = {};
    taxLines.forEach(tl => {
      const mid = tl.move_id[0];
      if (!taxMap[mid]) taxMap[mid] = [];
      taxMap[mid].push(tl);
    });

    // ── GST: flag bills with contradictory IGST + CGST/SGST ─────────────────
    const gstIssueSet = new Set();
    Object.keys(taxMap).forEach(mid => {
      const names   = taxMap[mid].map(tl => (tl.tax_line_id && tl.tax_line_id[1]) || '');
      const hasIGST = names.some(n => /igst/i.test(n));
      const hasCGST = names.some(n => /cgst|sgst/i.test(n));
      if (hasIGST && hasCGST) gstIssueSet.add(parseInt(mid));
    });

    // ── Step 6: Audit each bill ───────────────────────────────────────────────
    log.push('Scoring bills…');
    const bills = rawBills.map(b => {
      const issues = [];
      let score = 100;

      // 1. Attachment
      if (!attachedSet.has(b.id)) { issues.push('attachment'); score -= 20; }

      // 2. Narration
      const nar = ((b.narration || '') + ' ' + (b.ref || '')).trim();
      if (nar.replace(/\s+/g, '').length < minNarLen) { issues.push('narration'); score -= 15; }

      // 3. TDS missing (bill amount ≥ threshold, no tax line)
      const billTaxes = taxMap[b.id] || [];
      if (b.amount_total >= tdsThreshold && billTaxes.length === 0) {
        issues.push('no-tds'); score -= 20;
      }

      // 4. Wrong TDS rate (194C on bill ≥ ₹50k — likely should be 194J)
      if (billTaxes.length > 0) {
        const taxNames = billTaxes.map(t => (t.tax_line_id && t.tax_line_id[1]) || '');
        const has194C  = taxNames.some(n => /194c/i.test(n));
        const has194J  = taxNames.some(n => /194j/i.test(n));
        if (has194C && !has194J && b.amount_total >= 50000) {
          issues.push('wrong-tds'); score -= 15;
        }
      }

      // 5. Account pattern deviation
      const vid = b.partner_id && b.partner_id[0];
      if (vid && vMap[vid] && moveAcc[b.id]) {
        const usedAcc  = moveAcc[b.id][0];
        const counts   = vMap[vid];
        const totalUse = Object.values(counts).reduce((a, c) => a + c, 0);
        const topAcc   = Object.keys(counts).reduce((a, k) => counts[k] > counts[a] ? k : a, Object.keys(counts)[0]);
        const pct      = totalUse ? (counts[topAcc] / totalUse * 100) : 0;
        if (String(usedAcc) !== String(topAcc) && pct >= accThreshold) {
          issues.push('account'); score -= 15;
        }
      }

      // 6. GST mismatch
      if (gstIssueSet.has(b.id)) { issues.push('gst'); score -= 10; }

      return {
        id:       b.name,
        _odooId:  b.id,
        vendor:   b.partner_id ? b.partner_id[1] : 'Unknown',
        date:     b.invoice_date || '—',
        journal:  b.journal_id  ? b.journal_id[1] : '—',
        amt:      b.amount_total || 0,
        narration: nar,
        issues,
        score: Math.max(0, score),
      };
    });

    log.push(`Done — ${bills.length} bills audited`);
    res.json({ ok: true, bills, log });

  } catch (err) {
    console.error('[sync-bills error]', err.message);
    res.json({ ok: false, error: err.message, log });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DUMB PASSTHROUGH — still used for Test Connection button in Settings
//  Route: /:host/*  →  https://<host>/<path>
// ─────────────────────────────────────────────────────────────────────────────
app.all('/:host/*', (req, res) => {
  const host     = req.params.host;
  const pathTail = req.params[0] || '';
  const query    = Object.keys(req.query).length
    ? '?' + new URLSearchParams(req.query).toString()
    : '';
  const targetPath = '/' + pathTail + query;

  const blocked = /localhost|127\.|0\.0\.0\.0|169\.254|metadata\.google/i;
  if (blocked.test(host)) return res.status(403).json({ error: 'Blocked target host' });

  const isSecure = !host.startsWith('http:');
  const lib      = isSecure ? https : http;

  const reqHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (req.headers.cookie) reqHeaders['Cookie'] = req.headers.cookie;

  const body = req.body ? JSON.stringify(req.body) : undefined;
  if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body);

  const options = {
    hostname: host,
    port:     isSecure ? 443 : 80,
    path:     targetPath,
    method:   req.method,
    headers:  reqHeaders,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const rawCookies = proxyRes.headers['set-cookie'];
    if (rawCookies) {
      const cleaned = rawCookies.map(c =>
        c.replace(/;\s*Domain=[^;]+/gi, '')
         .replace(/;\s*Secure/gi, '')
         .replace(/;\s*SameSite=[^;]+/gi, '; SameSite=Lax')
      );
      res.setHeader('Set-Cookie', cleaned);
    }
    res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
    res.status(proxyRes.statusCode || 200);
    const chunks = [];
    proxyRes.on('data', d => chunks.push(d));
    proxyRes.on('end', () => res.send(Buffer.concat(chunks).toString('utf8')));
  });

  proxyReq.on('error', err => {
    console.error('[proxy error]', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Proxy upstream error: ' + err.message });
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
});

app.listen(PORT, () => {
  console.log(`Odoo Bill Audit Proxy listening on port ${PORT}`);
  console.log(`ALLOWED_ORIGIN = ${ALLOWED_ORIGIN}`);
});
