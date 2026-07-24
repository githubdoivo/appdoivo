// Minimal in-memory rate limiter, keyed by IP. No extra dependency, matching
// this project's minimal-stack style. Good enough for a single-process,
// ~50-user deployment; resets on restart.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map(); // ip -> { count, resetAt }

/** Blocks an IP after too many requests within the time window (login brute-force guard). */
export function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(ip, entry);
  }
  if (entry.count >= MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Demasiadas tentativas. Tenta novamente mais tarde.' });
  }
  entry.count++;
  next();
}
