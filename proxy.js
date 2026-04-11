/**
 * Odoo CORS Proxy
 * ---------------
 * Forwards browser requests to Odoo and adds CORS headers so the static
 * frontend can call Odoo SaaS (odoo.com) without being blocked.
 *
 * Route pattern: POST /<odoo-host>/<odoo-path>
 * Example: POST /ginesys.odoo.com/web/session/authenticate
 *
 * Deploy this on Render as a "Web Service" (Node environment).
 * Set the proxy's URL in the frontend Settings → CORS Proxy URL.
 */

'use strict';

const express = require('express');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Allowed origins (set ALLOWED_ORIGIN env var on Render, e.g. https://odoo-bill-audit.onrender.com)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── Body parser — Odoo JSON-RPC payloads can be a few KB
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ limit: '5mb' }));

// ── CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin || ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie, X-Requested-With');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ── Health / root
app.get('/', (_req, res) => {
  res.json({ status: 'Odoo CORS Proxy running', ts: new Date().toISOString() });
});

// ── Proxy handler: /:host/* → https://:host/*
app.all('/:host/*', (req, res) => {
  const host     = req.params.host;
  const pathTail = req.params[0] || '';
  const query    = Object.keys(req.query).length
    ? '?' + new URLSearchParams(req.query).toString()
    : '';
  const targetPath = '/' + pathTail + query;

  // Safety: only allow HTTPS targets, and block obvious non-Odoo hosts
  const blocked = /localhost|127\.|0\.0\.0\.0|169\.254|metadata\.google/i;
  if (blocked.test(host)) {
    return res.status(403).json({ error: 'Blocked target host' });
  }

  const isSecure = !host.startsWith('http:');   // default HTTPS
  const lib      = isSecure ? https : http;

  // Forward cookies so Odoo session is maintained
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
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
    // Forward Set-Cookie to browser (strip Domain/Secure so they apply to proxy domain)
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
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // Forward as-is (Odoo already returns JSON)
      res.send(raw);
    });
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy error]', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy upstream error: ' + err.message });
    }
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
});

app.listen(PORT, () => {
  console.log(`Odoo CORS Proxy listening on port ${PORT}`);
  console.log(`ALLOWED_ORIGIN = ${ALLOWED_ORIGIN}`);
});
