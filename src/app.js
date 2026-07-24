import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seed } from './db.js';
import { initPush } from './push.js';
import apiRouter from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Seed the admin + settings (result used by server.js to print the token).
export const seedResult = seed({
  adminToken: process.env.ADMIN_TOKEN,
  adminName: process.env.ADMIN_NAME,
  timezone: process.env.TIMEZONE,
});

// Configure Web Push (disabled if VAPID keys are missing).
initPush();

const app = express();
// Fly.io terminates TLS and proxies requests, so trust its X-Forwarded-For
// header to get each client's real IP (needed for per-IP rate limiting).
app.set('trust proxy', 1);
app.use(express.json());

// API.
app.use('/api', apiRouter);

// Static files (PWA).
app.use(express.static(PUBLIC_DIR));

// SPA fallback: any non-API route returns the index.
app.get('*', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

export default app;
