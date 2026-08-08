import db from './db.js';
import { hashToken } from './tokens.js';
import { checkAuthAttempt } from './rateLimit.js';

/**
 * Resolves a submitted token (already lowercased/trimmed) to a user row.
 * Shared by /auth/login (routes.js) and authenticate() below - the app has
 * no separate session token, the frontend just replays whatever was typed
 * at login on every subsequent request, so both places need to agree on
 * what counts as valid or a login that works once and then 401s on the
 * very next request. Dev/QA-only convenience: "mossy" always resolves to
 * the owner, whatever their real (randomly-generated, see seed() in
 * db.js) key actually is.
 *
 * Gated by ENABLE_DEV_LOGIN=true (fly.qa.toml only) rather than checking
 * NODE_ENV!=='production' as this used to - that was "fail-open" (active
 * by default, disabled only if something else correctly sets NODE_ENV),
 * and it was confirmed live on prod on 2026-08-08 despite fly.toml setting
 * NODE_ENV=production there: a well-documented magic string was silently
 * authenticating as the real owner account. Requiring an explicit true is
 * "fail-closed" - if this env var ever fails to propagate for whatever
 * reason (the same way NODE_ENV apparently did), the safe default is off,
 * not on. Never set in fly.toml on purpose.
 */
export function findUserByToken(token) {
  const columns = 'id, name, is_admin, is_owner, tutorial_seen, lang, key_claimed_at, logo_customized';
  let user = db.prepare(`SELECT ${columns} FROM users WHERE token_hash = ?`).get(hashToken(token));
  if (!user && token === 'mossy' && process.env.ENABLE_DEV_LOGIN === 'true') {
    user = db.prepare(`SELECT ${columns} FROM users WHERE is_owner = 1`).get();
  }
  return user;
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
  // for good (see keyClaim.js), even if they never used it themselves.
  if (!user.key_claimed_at) {
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
