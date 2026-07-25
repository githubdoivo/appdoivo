import db from './db.js';

const MAX_MESSAGES = 20;
const MAX_AGE_MINUTES = 5;
const MAX_TEXT_LENGTH = 300;

/** Deletes anything older than 5 minutes, then trims down to the 20 most recent. */
export function pruneMessages() {
  db.exec(`DELETE FROM messages WHERE created_at < strftime('%Y-%m-%d %H:%M:%f', 'now', '-${MAX_AGE_MINUTES} minutes')`);
  db.exec(`
    DELETE FROM messages WHERE id NOT IN (
      SELECT id FROM messages ORDER BY id DESC LIMIT ${MAX_MESSAGES}
    )
  `);
}

/** Current (already-pruned) messages, oldest first. */
export function listMessages() {
  pruneMessages();
  return db.prepare(`
    SELECT m.id, m.text, m.created_at, u.name AS author
    FROM messages m
    JOIN users u ON u.id = m.user_id
    ORDER BY m.id ASC
  `).all();
}

/** Posts a message. Returns { ok } or { error }. */
export function postMessage(userId, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { error: 'Mensagem vazia.' };
  if (trimmed.length > MAX_TEXT_LENGTH) return { error: `Mensagem demasiado longa (max ${MAX_TEXT_LENGTH} caracteres).` };

  db.prepare('INSERT INTO messages (user_id, text) VALUES (?, ?)').run(userId, trimmed);
  pruneMessages();
  return { ok: true };
}
