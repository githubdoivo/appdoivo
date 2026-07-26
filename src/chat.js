import { randomInt } from 'node:crypto';
import db from './db.js';

const MAX_MESSAGES = 20;
const MAX_TEXT_LENGTH = 300;

// Furnished-themed object + swamp-themed creature (e.g. "chair" + "frog"
// -> "chairfrog"), matching the app's own Best Outfit night themes - the
// Wall is anonymous, so every message gets a random one of these instead
// of the real poster's name.
const FURNISHED_OBJECTS = [
  'chair', 'lamp', 'rug', 'sofa', 'curtain', 'mirror', 'vase', 'shelf',
  'candle', 'cushion', 'teapot', 'drawer', 'doormat', 'clock', 'stool',
  'mug', 'kettle', 'blanket', 'pillow', 'doorknob', 'footstool', 'teacup',
];
const SWAMP_CREATURES = [
  'frog', 'toad', 'newt', 'heron', 'eel', 'leech', 'moth', 'gator',
  'crane', 'snail', 'beetle', 'mosquito', 'catfish', 'turtle',
  'salamander', 'firefly', 'crawdad', 'dragonfly', 'tadpole', 'stork',
];

function randomPseudonym() {
  const object = FURNISHED_OBJECTS[randomInt(0, FURNISHED_OBJECTS.length)];
  const creature = SWAMP_CREATURES[randomInt(0, SWAMP_CREATURES.length)];
  return `${object}${creature}`;
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
