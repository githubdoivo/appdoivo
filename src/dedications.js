// Private messages to the birthday person. Guests write one each; only the
// owner can read them, and only they can take the collection out as a PDF -
// meant to be done once, at the end of the party, rather than read as they
// arrive.
import db from './db.js';

/** The caller's own message, or null if they have not written one yet. */
export function myDedication(userId) {
  return db.prepare('SELECT text, updated_at FROM dedications WHERE user_id = ?').get(userId) ?? null;
}

/**
 * Writes or rewrites the caller's message. One per person (see the UNIQUE
 * on user_id) - writing again replaces what was there rather than adding a
 * second, so nobody has to be told they already used theirs up.
 */
export function saveDedication(userId, rawText) {
  const text = String(rawText ?? '').trim();
  // No cap: this is the one place someone might want to write at length,
  // and being cut off mid-sentence in a message meant as a keepsake is a
  // worse outcome than a long entry in the PDF.
  if (!text) return { error: 'err_dedication_empty' };

  db.prepare(`
    INSERT INTO dedications (user_id, text) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      text = excluded.text,
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
  `).run(userId, text);
  return { ok: true };
}

/**
 * Every message with its author, oldest first - the order they were written
 * in, which is the order a keepsake reads best in.
 */
export function allDedications() {
  return db.prepare(`
    SELECT d.id, d.text, d.created_at, d.updated_at, u.name AS author
    FROM dedications d
    JOIN users u ON u.id = d.user_id
    ORDER BY d.created_at
  `).all();
}

export function wipeAll() {
  db.prepare('DELETE FROM dedications').run();
}
