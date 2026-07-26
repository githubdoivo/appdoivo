import { randomInt } from 'node:crypto';
import db from './db.js';

const MAX_MESSAGES = 20;
const MAX_TEXT_LENGTH = 300;

// Cheeky mythological portmanteaus (e.g. "nasty" + "(h)ermes" ->
// "nastyermes", "horny" + "(a)phrodite" -> "hornyfrodite") - the Wall is
// anonymous, so every message gets a random one of these instead of the
// real poster's name.
const ADJECTIVES = [
  'nasty', 'horny', 'sad', 'moody', 'petty', 'feral', 'messy', 'dramatic',
  'thirsty', 'salty', 'spicy', 'chaotic', 'unhinged', 'clingy', 'extra',
  'iconic', 'unbothered', 'feisty', 'wistful', 'unwell', 'delulu', 'soggy',
];
const GODS = [
  'ermes', 'frodite', 'zeus', 'athena', 'poseidon', 'hades', 'apollo',
  'artemis', 'dionysus', 'hera', 'ares', 'demeter', 'persephone',
  'narcissus', 'icarus', 'eros', 'iris', 'circe', 'medusa', 'psyche',
];

function randomPseudonym() {
  const adj = ADJECTIVES[randomInt(0, ADJECTIVES.length)];
  const god = GODS[randomInt(0, GODS.length)];
  return `${adj}${god}`;
}

/** Trims down to the 20 most recent messages. No time-based expiry - the
 * Wall just always shows whatever the last 20 posts were. */
export function pruneMessages() {
  db.exec(`
    DELETE FROM messages WHERE id NOT IN (
      SELECT id FROM messages ORDER BY id DESC LIMIT ${MAX_MESSAGES}
    )
  `);
}

/** Current (already-pruned) messages, oldest first. "author" is always a
 * random pseudonym assigned at post time, never the real poster. */
export function listMessages() {
  pruneMessages();
  return db.prepare(`
    SELECT id, text, created_at, pseudonym AS author
    FROM messages
    ORDER BY id ASC
  `).all();
}

/** Posts a message. Returns { ok } or { error }. */
export function postMessage(userId, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { error: 'Mensagem vazia.' };
  if (trimmed.length > MAX_TEXT_LENGTH) return { error: `Mensagem demasiado longa (max ${MAX_TEXT_LENGTH} caracteres).` };

  db.prepare('INSERT INTO messages (user_id, text, pseudonym) VALUES (?, ?, ?)').run(userId, trimmed, randomPseudonym());
  pruneMessages();
  return { ok: true };
}
