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
  if (!user) return { error: 'Utilizador não encontrado.' };
  if (user.key_claimed_at) return { error: 'Esta chave já foi levantada. Fala com quem organiza o evento.' };

  db.prepare("UPDATE users SET key_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(userId);
  return { ok: true, name: user.name, token: decryptToken(user.token_enc) };
}
