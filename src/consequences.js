import db from './db.js';
import { today } from './time.js';
import { broadcast } from './push.js';

/**
 * Picks a random pending consequence, marks it as used/revealed and sends a
 * push notification to everyone. Returns the revealed consequence or null.
 */
export async function revealRandomConsequence() {
  const pick = db.prepare(`
    SELECT c.id, c.text, u.name AS author
    FROM consequences c
    JOIN users u ON u.id = c.user_id
    WHERE c.status = 'pending'
    ORDER BY RANDOM()
    LIMIT 1
  `).get();

  if (!pick) return null;

  db.prepare(`
    UPDATE consequences
    SET status = 'used', revealed_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(pick.id);

  await broadcast({
    title: { pt: 'A Rata', en: 'A Rata' },
    body: { pt: 'quem tem a rata? a consequência foi revelada! entra na app agora.', en: 'who has the rat? the consequence was revealed - open the app now.' },
    tag: 'consequence',
    url: '/?tab=rata',
  });

  return pick;
}

/** Returns the currently revealed consequence (the most recent one). */
export function currentConsequence() {
  return db.prepare(`
    SELECT c.id, c.text, c.revealed_at, u.name AS author,
           c.assigned_user_id, a.name AS assignedName
    FROM consequences c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN users a ON a.id = c.assigned_user_id
    WHERE c.status = 'used'
    ORDER BY c.revealed_at DESC
    LIMIT 1
  `).get() || null;
}

/**
 * Owner sets who's actually holding the rata when a consequence is
 * revealed - only known by looking around the party at that moment, so it
 * can't be inferred automatically.
 */
export function assignConsequenceUser(consequenceId, userId) {
  const consequence = db.prepare(`SELECT id FROM consequences WHERE id = ? AND status = 'used'`).get(consequenceId);
  if (!consequence) return null;
  db.prepare('UPDATE consequences SET assigned_user_id = ? WHERE id = ?').run(userId, consequenceId);
  return db.prepare(`
    SELECT c.id, c.text, c.revealed_at, u.name AS author,
           c.assigned_user_id, a.name AS assignedName
    FROM consequences c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN users a ON a.id = c.assigned_user_id
    WHERE c.id = ?
  `).get(consequenceId);
}

/** Number of consequences still to be revealed. */
export function pendingCount() {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM consequences WHERE status = 'pending'`).get();
  return row.n;
}

/** The user's suggestion for today, if any. */
export function mySuggestionToday(userId) {
  return db.prepare(
    `SELECT id, text, status FROM consequences WHERE user_id = ? AND day = ?`
  ).get(userId, today()) || null;
}
