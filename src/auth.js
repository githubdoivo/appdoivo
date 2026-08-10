import db from './db.js';
import { hashToken } from './tokens.js';
import { checkAuthAttempt } from './rateLimit.js';

/**
 * Resolves a submitted token (already lowercased/trimmed) to a user row.
 * Shared by /auth/login (routes.js) and authenticate() below - the app has
 * no separate session token, the frontend just replays whatever was typed
 * at login on every subsequent request, so both places need to agree on
 * what counts as valid, or a login works once and then 401s on the very
 * next request.
 *
 * There is a QA-only shortcut here - see devLoginOwner() below - and its
 * history is the reason it is shaped the way it is. An earlier NODE_ENV-based
 * version of the same idea was found live on prod on 2026-08-08: a single
 * environment variable being wrong was enough to leave a documented magic
 * string authenticating as the account with full control over everyone's
 * keys. It was then re-gated behind ENABLE_DEV_LOGIN, then removed outright.
 *
 * Brought back on 2026-08-10 because QA's database is wiped by every deploy
 * and the owner's key changes several times an afternoon. What is different
 * this time: no passphrase in the repo (it comes from an env var that only
 * QA sets), and two independent conditions instead of one, so the same
 * single-variable mistake cannot repeat.
 */
const USER_COLUMNS = 'id, name, is_admin, is_owner, tutorial_seen, lang, key_claimed_at, logo_customized';

/**
 * A QA-only quick login for the owner, because QA has no volume: its database
 * is wiped by every deploy, so the owner's real key changes underneath whoever
 * is testing, several times an afternoon.
 *
 * Two conditions, deliberately both required:
 *
 *  - DEV_LOGIN_KEY is set to something. The word itself lives in QA's Fly
 *    secrets, never in this repo - production cannot leak a passphrase it
 *    was never given, and there is no constant here for anyone to read.
 *  - APP_ENV is exactly 'qa'. Production doesn't set APP_ENV at all, so even
 *    if the secret were one day copied to the wrong app by mistake, it stays
 *    inert there. One misconfiguration is not enough to open this.
 *
 * It resolves to the owner and never touches what is actually stored: the
 * owner's real key stays generated, and this is not it.
 */
export function isDevLoginKey(token) {
  const key = process.env.DEV_LOGIN_KEY;
  if (!key || process.env.APP_ENV !== 'qa') return false;
  return String(token).trim().toLowerCase() === String(key).trim().toLowerCase();
}

function devLoginOwner(token) {
  if (!isDevLoginKey(token)) return null;
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE is_owner = 1`).get() || null;
}

export function findUserByToken(token) {
  const real = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE token_hash = ?`).get(hashToken(token));
  return real || devLoginOwner(token);
}

/**
 * Token authentication middleware.
 * Accepts "Authorization: Bearer <token>" or "?token=" (for the service worker).
 */
export function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const token = bearer || req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'err_token_missing' });
  }

  // Keys are always lowercase (see /auth/login) - normalize here too.
  const user = findUserByToken(String(token).trim().toLowerCase());
  if (!user) {
    // Shares /auth/login's rate-limit budget - guessing tokens against any
    // endpoint that accepts a Bearer token is throttled the same way,
    // instead of only the dedicated login route.
    const result = checkAuthAttempt(req.ip);
    if (result.blocked) {
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({ error: 'err_rate_limited' });
    }
    return res.status(401).json({ error: 'err_token_invalid' });
  }

  // Any successful authenticated request proves this user already has
  // their key - closes the first-time name-search retrieval flow for them
  // for good (see keyClaim.js), even if they never used it themselves. The
  // QA dev key proves nothing of the sort, so it must not stamp: doing so
  // silently removes the owner from "find my key", which is exactly how the
  // owner got locked out of QA once already.
  if (!user.key_claimed_at && !isDevLoginKey(String(token).trim().toLowerCase())) {
    db.prepare("UPDATE users SET key_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(user.id);
  }

  req.user = {
    id: user.id,
    name: user.name,
    isAdmin: !!user.is_admin,
    isOwner: !!user.is_owner,
    tutorialSeen: !!user.tutorial_seen,
    lang: user.lang,
    logo_customized: !!user.logo_customized,
  };
  next();
}

/** Middleware that requires admin privileges. */
export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'err_admin_only' });
  }
  next();
}

/**
 * Middleware that requires owner privileges. Golden rule: nobody but the
 * owner may see other users' access keys, so anything that exposes them
 * (Manage Users) is gated behind this rather than plain requireAdmin.
 */
export function requireOwner(req, res, next) {
  if (!req.user?.isOwner) {
    return res.status(403).json({ error: 'err_owner_only' });
  }
  next();
}
