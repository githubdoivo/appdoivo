import { randomInt } from 'node:crypto';
import db from './db.js';
import { formatTimeInZone, today } from './time.js';
import { translationsFor } from './translations.js';
import { queueAndRun } from './translate.js';

const MAX_MESSAGES = 15;
const MAX_TEXT_LENGTH = 300;

// Furnished-themed object + swamp-themed whimsical/magical being (e.g.
// "chair" + "wisp" -> "chairwisp") - not literal swamp fauna, but the
// murky, folklore-ish creatures a swamp conjures, matching the app's own
// Best Look night themes. The Wall is anonymous to everyone but the
// owner (see settings.js's Wall-pseudonyms table), so every USER (not every
// message) gets one of these instead of their real name - stable across
// all their posts, so people stay recognizable to each other by their
// pseudonym without exposing who they actually are.
const FURNISHED_OBJECTS = [
  'chair', 'lamp', 'rug', 'sofa', 'curtain', 'mirror', 'vase', 'shelf',
  'candle', 'cushion', 'teapot', 'drawer', 'doormat', 'clock', 'stool',
  'mug', 'kettle', 'blanket', 'pillow', 'doorknob', 'footstool', 'teacup',
];
const SWAMP_BEINGS = [
  'wisp', 'sprite', 'witch', 'wraith', 'ghoul', 'specter', 'goblin',
  'troll', 'hag', 'banshee', 'phantom', 'imp', 'fae', 'gremlin',
  'mudwitch', 'bogfae', 'mosswraith', 'fenghoul', 'mirewisp', 'swampfae',
];

function randomPseudonym() {
  const object = FURNISHED_OBJECTS[randomInt(0, FURNISHED_OBJECTS.length)];
  const being = SWAMP_BEINGS[randomInt(0, SWAMP_BEINGS.length)];
  return `${object}${being}`;
}

/** Sets a user's current pseudonym and appends it to their history - every
 * pseudonym they've ever had, not just the latest (see wall_pseudonym_history
 * in db.js and GET /admin/wall-pseudonyms). */
function setPseudonym(userId, pseudonym) {
  db.prepare('UPDATE users SET wall_pseudonym = ? WHERE id = ?').run(pseudonym, userId);
  db.prepare('INSERT INTO wall_pseudonym_history (user_id, pseudonym) VALUES (?, ?)').run(userId, pseudonym);
}

/** Returns this user's Wall pseudonym, assigning one the first time they
 * ever post (stored on users.wall_pseudonym, reused forever after). */
function getOrAssignPseudonym(userId) {
  const row = db.prepare('SELECT wall_pseudonym FROM users WHERE id = ?').get(userId);
  if (row?.wall_pseudonym) return row.wall_pseudonym;

  const pseudonym = randomPseudonym();
  setPseudonym(userId, pseudonym);
  return pseudonym;
}

/** Re-rolls a user's Wall pseudonym to a fresh random one, at most once a
 * day - it's meant to stay stable (that's the whole point), just
 * occasionally refreshable if someone wants a change. Returns
 * { ok, pseudonym } or { error }. */
export function resetPseudonym(userId) {
  const user = db.prepare('SELECT wall_pseudonym, wall_pseudonym_reset_day FROM users WHERE id = ?').get(userId);
  if (!user) return { error: 'err_user_not_found' };

  const day = today();
  if (user.wall_pseudonym_reset_day === day) {
    return { error: 'err_pseudonym_reset_limit' };
  }

  const pseudonym = randomPseudonym();
  setPseudonym(userId, pseudonym);
  db.prepare('UPDATE users SET wall_pseudonym_reset_day = ? WHERE id = ?').run(day, userId);
  return { ok: true, pseudonym };
}

/** Every user who's ever posted, with the full list of pseudonyms they've
 * had over time (oldest first) - not just their current one, since a
 * re-rolled pseudonym doesn't erase the messages posted under the old one. */
export function wallPseudonymDirectory() {
  const rows = db.prepare(`
    SELECT u.id, u.name, h.pseudonym
    FROM users u
    JOIN wall_pseudonym_history h ON h.user_id = u.id
    ORDER BY u.name COLLATE NOCASE ASC, h.id ASC
  `).all();

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.id)) byUser.set(r.id, { id: r.id, name: r.name, pseudonyms: [] });
    byUser.get(r.id).pseudonyms.push(r.pseudonym);
  }
  return [...byUser.values()];
}

/** Trims down to the 15 most recent messages. No time-based expiry - the
 * Wall just always shows whatever the last 15 posts were. */
export function pruneMessages() {
  db.exec(`
    DELETE FROM messages WHERE id NOT IN (
      SELECT id FROM messages ORDER BY id DESC LIMIT ${MAX_MESSAGES}
    )
  `);
}

/** Current (already-pruned) messages, oldest first. "author" is each
 * poster's stable pseudonym, never their real name. "time" is created_at
 * converted from its stored UTC value to the app's configured timezone -
 * the client must not format created_at itself, or it renders as if it
 * were already local. */
export function listMessages(lang = null) {
  pruneMessages();
  const rows = db.prepare(`
    SELECT id, text, created_at, pseudonym AS author
    FROM messages
    ORDER BY id ASC
  `).all();
  // Same rule as everywhere else: a translation for the reader's language
  // if one exists, the original otherwise. A message written in the
  // language you are reading in has no row and is shown untouched.
  const t = lang ? translationsFor('message', rows.map((m) => m.id), lang) : null;
  return rows.map((m) => ({
    ...m,
    text: t?.get(`message:${m.id}:text`) ?? m.text,
    time: formatTimeInZone(m.created_at),
  }));
}

// Lowercases everything - keeps the Wall's tone consistently casual - but
// otherwise leaves the message untouched, special characters and emoji
// included.
function sanitizeMessage(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Posts a message. Returns { ok, pseudonym } or { error }. */
export function postMessage(userId, text) {
  const sanitized = sanitizeMessage(String(text || ''));
  if (!sanitized) return { error: 'err_empty_message' };
  if (sanitized.length > MAX_TEXT_LENGTH) return { error: 'err_message_too_long' };

  const pseudonym = getOrAssignPseudonym(userId);
  const info = db.prepare('INSERT INTO messages (user_id, text, pseudonym) VALUES (?, ?, ?)').run(userId, sanitized, pseudonym);
  pruneMessages();
  // Queued after the row exists and after pruning, so a message that was
  // immediately pruned off the end of the 20 never costs an API call.
  queueAndRun('message', info.lastInsertRowid, 'text', sanitized);
  return { ok: true, pseudonym };
}
