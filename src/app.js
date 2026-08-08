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
app.use(express.json());

// API.
app.use('/api', apiRouter);

// RFC 9116 places security.txt at /.well-known/security.txt (see
// public/.well-known/security.txt) - that's the canonical location and
// already resolves on its own. Some older scanners only ever check the
// legacy bare /security.txt path though, so redirect that one too rather
// than letting the SPA fallback below swallow it into index.html.
app.get('/security.txt', (req, res) => res.redirect(301, '/.well-known/security.txt'));

// Static files (PWA).
app.use(express.static(PUBLIC_DIR));

// SPA fallback: any non-API route returns the index.
app.get('*', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

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
