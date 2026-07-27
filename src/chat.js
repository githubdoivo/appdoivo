import { randomInt } from 'node:crypto';
import db from './db.js';
import { formatTimeInZone } from './time.js';

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

/** Returns this user's Wall pseudonym, assigning one the first time they
 * ever post (stored on users.wall_pseudonym, reused forever after). */
function getOrAssignPseudonym(userId) {
  const row = db.prepare('SELECT wall_pseudonym FROM users WHERE id = ?').get(userId);
  if (row?.wall_pseudonym) return row.wall_pseudonym;

  const pseudonym = randomPseudonym();
  db.prepare('UPDATE users SET wall_pseudonym = ? WHERE id = ?').run(pseudonym, userId);
  return pseudonym;
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
export function listMessages() {
  pruneMessages();
  const rows = db.prepare(`
    SELECT id, text, created_at, pseudonym AS author
    FROM messages
    ORDER BY id ASC
  `).all();
  return rows.map((m) => ({ ...m, time: formatTimeInZone(m.created_at) }));
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
  if (!sanitized) return { error: 'Mensagem vazia.' };
  if (sanitized.length > MAX_TEXT_LENGTH) return { error: `Mensagem demasiado longa (max ${MAX_TEXT_LENGTH} caracteres).` };

  const pseudonym = getOrAssignPseudonym(userId);
  db.prepare('INSERT INTO messages (user_id, text, pseudonym) VALUES (?, ?, ?)').run(userId, sanitized, pseudonym);
  pruneMessages();
  return { ok: true, pseudonym };
}
