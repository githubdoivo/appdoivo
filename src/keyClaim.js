import db from './db.js';
import { decryptToken } from './tokens.js';

// Strips accents so "cesar" matches "César" - same accent-folding the
// admin Users search already does client-side (see settings.js). Here it
// runs server-side because this is unauthenticated: the client must never
// receive the full unclaimed-user list to filter locally, only whatever
// actually matches.
function foldAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Users who have never retrieved their key - neither through this same
 * first-time flow nor by ever logging in for real (see authenticate() in
 * auth.js, which stamps key_claimed_at on first successful auth). Below
 * 3 characters returns nothing, same floor as the admin search, so a
 * single keystroke can't fish for the whole unclaimed roster.
 *
 * SECURITY NOTE: the owner is included here, by request, rather than being
 * pre-claimed as they used to be. This endpoint is public and does no
 * identity check beyond matching a name, so until the owner's key is
 * actually claimed, whoever claims it first gets full admin over every
 * account and key. Claiming is one-shot and closes permanently, so the
 * exposure is the gap between deploying a fresh database and the owner
 * claiming - claim it immediately after any deploy that reseeds (QA does
 * on every deploy; prod's volume persists, so it's a one-time window).
 */
export function searchUnclaimedUsers(name) {
  const term = String(name || '').trim();
  if (term.length < 3) return [];

  const folded = foldAccents(term.toLowerCase());
  const rows = db.prepare('SELECT id, name FROM users WHERE key_claimed_at IS NULL').all();
  return rows
    .filter((u) => foldAccents(u.name.toLowerCase()).includes(folded))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reveals a user's key exactly once - the moment this succeeds, the
 * account is "claimed" and this same flow can never be used for it again
 * (see the key_claimed_at IS NULL guard). Whoever gets here first for a
 * given name gets the key; there's no further verification beyond
 * picking the right name, which is the accepted trade-off for a small,
 * invite-only guest list rather than a public signup.
 */
export function claimKey(userId) {
  const user = db.prepare('SELECT id, name, token_enc, key_claimed_at FROM users WHERE id = ?').get(userId);
  if (!user) return { error: 'err_user_not_found' };
  if (user.key_claimed_at) return { error: 'err_key_already_claimed' };

  db.prepare("UPDATE users SET key_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(userId);
  return { ok: true, name: user.name, token: decryptToken(user.token_enc) };
}
