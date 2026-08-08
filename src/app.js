import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seed } from './db.js';
import { initPush, checkVersionUpdate } from './push.js';
import apiRouter from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Seed the admin + settings (result used by server.js to print the token).
export const seedResult = seed({
  adminName: process.env.ADMIN_NAME,
});

// Configure Web Push (disabled if VAPID keys are missing).
initPush();

// Tell everyone once when this boot is running a different version than
// the last one - see checkVersionUpdate() for why this only ever fires on prod.
const { version: appVersion } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
checkVersionUpdate(appVersion).catch((err) => console.error('[push] version-update notify failed:', err));

const app = express();
// Fly.io terminates TLS and proxies requests, so trust its X-Forwarded-For
// header to get each client's real IP (needed for per-IP rate limiting).
app.set('trust proxy', 1);
// Default 100kb is too small for a base64-encoded outfit photo (client
// resizes to ~800px JPEG first, but base64 still adds ~33% overhead) - 2mb
// leaves generous headroom while still bounding the request body.
app.use(express.json({ limit: '2mb' }));

// API.
app.use('/api', apiRouter);

// Cloudflare sits in front of qa/prod and its own "Browser Cache TTL"
// rewrites the Cache-Control it hands to the client regardless of what the
// origin (us) sends - confirmed directly, curling the live CSS shows
// "max-age=14400" even though the static middleware below sets "no-cache".
// Fixing that is a Cloudflare dashboard setting outside this repo, so
// rather than depend on any layer actually honouring a cache header,
// index.html/settings.html are served here (ahead of express.static) with
// their local <link>/<script> URLs stamped with the app version as a
// query string - a version bump (already required before every QA deploy)
// changes the URL itself, which is a guaranteed cache miss everywhere.
function withCacheBust(html) {
  return html.replace(
    /((?:href|src)=")(\/(?:css|js)\/[^"?]+)(")/g,
    (_match, pre, path, post) => `${pre}${path}?v=${appVersion}${post}`
  );
}

function sendVersionedHtml(res, filename) {
  const html = readFileSync(join(PUBLIC_DIR, filename), 'utf8');
  res.set('Cache-Control', 'no-cache').type('html').send(withCacheBust(html));
}

app.get('/settings.html', (req, res) => sendVersionedHtml(res, 'settings.html'));
app.get('/index.html', (req, res) => sendVersionedHtml(res, 'index.html'));

// Static files (PWA). "no-cache" (despite the name) still lets the browser
// keep a local copy, but forces a conditional revalidation against the
// server's ETag on every single load rather than trusting a max-age blindly -
// this repo ships several small fixes per session, and a stale JS/CSS bundle
// silently masking an already-shipped fix (mistaken for "still broken") has
// repeatedly cost real debugging time. A 304 on an unchanged file is cheap;
// serving five-year-old JS because a CDN/browser cached it for hours is not.
// index:false so a bare "/" falls through to the SPA catch-all below
// instead of express.static's own default index.html handling, which
// would otherwise serve the raw file and skip the version-stamping above.
app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// SPA fallback: any non-API route returns the index.
app.get('*', (req, res) => sendVersionedHtml(res, 'index.html'));

// Catch-all for anything a route handler didn't handle itself (a thrown
// error, a rejected promise in an async handler). Without this, Express's
// own default handler returns an HTML page with the full stack trace -
// NODE_ENV is never set in this deployment, so that page was going out to
// real users, showing up in the app as a raw "Erro 500" (see api.js, which
// falls back to that string when the response body isn't JSON) and leaking
// internals (file paths, line numbers) to anyone who happened to trigger
// an error. Logs the real error server-side, returns a clean, translatable
// message client-side.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'err_generic' });
});

export default app;
