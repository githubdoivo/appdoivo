import db from './db.js';
import { today } from './time.js';
import { broadcast, notifyUser } from './push.js';

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
    title: { pt: 'Rata', en: 'Rata' },
    body: { pt: 'quem tem a rata? a consequência foi revelada! entra na app agora.', en: 'who has the rat? the consequence was revealed - open the app now.' },
    tag: 'consequence',
    url: '/?tab=rata',
  });

  return pick;
}

const CONSEQUENCE_WITH_ASSIGNMENT = `
  SELECT c.id, c.text, c.revealed_at, u.name AS author,
         c.assigned_user_id, a.name AS assignedName,
         c.done_at, c.approved_at
  FROM consequences c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN users a ON a.id = c.assigned_user_id
`;

function getConsequenceWithAssignment(id) {
  return db.prepare(`${CONSEQUENCE_WITH_ASSIGNMENT} WHERE c.id = ?`).get(id);
}

/** Returns the currently revealed consequence (the most recent one). */
export function currentConsequence() {
  return db.prepare(`${CONSEQUENCE_WITH_ASSIGNMENT} WHERE c.status = 'used' ORDER BY c.revealed_at DESC LIMIT 1`).get() || null;
}

/**
 * Every revealed consequence, most recent first - the public tracking
 * list everyone sees on the Rata tab (text, who was assigned, and
 * done/approved state), not just the latest one.
 */
export function revealedConsequences() {
  return db.prepare(`${CONSEQUENCE_WITH_ASSIGNMENT} WHERE c.status = 'used' ORDER BY c.revealed_at DESC`).all();
}

/**
 * Owner records who was actually holding the rata when a consequence was
 * revealed - only known by looking around the party at that moment (or
 * asking around after the fact), so it can't be inferred automatically,
 * and isn't tied to "right now" since that's too easy to lose track of.
 * Notifies the assigned user directly, so they know they're on the hook.
 */
export async function assignConsequenceUser(consequenceId, userId) {
  const consequence = db.prepare(`SELECT id, text FROM consequences WHERE id = ? AND status = 'used'`).get(consequenceId);
  if (!consequence) return null;
  db.prepare('UPDATE consequences SET assigned_user_id = ? WHERE id = ?').run(userId, consequenceId);

  if (userId) {
    await notifyUser(userId, {
      title: { pt: 'Rata', en: 'Rata' },
      body: {
        pt: `foste marcado como quem tinha a rata em: "${consequence.text}". faz e marca como feito na app.`,
        en: `you were marked as holding the rat for: "${consequence.text}". do it and mark it done in the app.`,
      },
      tag: 'consequence-assigned',
      url: '/?tab=rata',
    });
  }

  return getConsequenceWithAssignment(consequenceId);
}

/**
 * The assigned user self-reports a consequence as done - the first of two
 * steps (the owner still has to approve it before it shows as done to
 * everyone). Only the person actually assigned to it can report it, and
 * only once.
 */
export function markConsequenceDone(consequenceId, userId) {
  const consequence = db.prepare(`SELECT id, assigned_user_id, done_at FROM consequences WHERE id = ? AND status = 'used'`).get(consequenceId);
  if (!consequence) return { error: 'Consequência não encontrada.' };
  if (consequence.assigned_user_id !== userId) return { error: 'Esta consequência não te foi atribuída.' };
  if (consequence.done_at) return { error: 'Já marcaste esta consequência como feita.' };
  db.prepare(`UPDATE consequences SET done_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).run(consequenceId);
  return { consequence: getConsequenceWithAssignment(consequenceId) };
}

/**
 * Owner-only: confirms a self-reported consequence actually happened -
 * only then does it show as done to everyone else. Requires done_at to
 * already be set (the owner confirms a report, doesn't stand in for one).
 */
export function approveConsequence(consequenceId) {
  const consequence = db.prepare(`SELECT id, done_at, approved_at FROM consequences WHERE id = ?`).get(consequenceId);
  if (!consequence) return { error: 'Consequência não encontrada.' };
  if (!consequence.done_at) return { error: 'Ainda não foi marcada como feita.' };
  if (consequence.approved_at) return { error: 'Já foi aprovada.' };
  db.prepare(`UPDATE consequences SET approved_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).run(consequenceId);
  return { consequence: getConsequenceWithAssignment(consequenceId) };
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
