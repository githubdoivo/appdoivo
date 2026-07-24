import db from './db.js';
import { nightStatus } from './time.js';
import { isNight } from './nights.js';

/** Contestants registered for a night. */
export function contestantsForNight(night) {
  return db.prepare(
    'SELECT id, name FROM contestants WHERE night = ? ORDER BY name COLLATE NOCASE'
  ).all(night);
}

/** The user's vote for this night, if any. */
export function myVoteForNight(userId, night) {
  return db.prepare(
    'SELECT contestant_id FROM votes WHERE user_id = ? AND night = ?'
  ).get(userId, night) || null;
}

/**
 * Records a vote for a night. Validates the night, the voting status, the
 * contestant and duplicates. Returns { ok } or { error }.
 */
export function castVote(userId, contestantId, night) {
  if (!isNight(night)) {
    return { error: 'Noite invalida.' };
  }
  if (nightStatus(night) !== 'open') {
    return { error: 'A votacao desta noite nao esta aberta.' };
  }

  const contestant = db.prepare(
    'SELECT id FROM contestants WHERE id = ? AND night = ?'
  ).get(contestantId, night);
  if (!contestant) {
    return { error: 'Concorrente invalido para esta noite.' };
  }

  const existing = db.prepare(
    'SELECT id FROM votes WHERE user_id = ? AND night = ?'
  ).get(userId, night);
  if (existing) {
    return { error: 'Ja votaste nesta noite.' };
  }

  db.prepare(
    'INSERT INTO votes (user_id, contestant_id, night) VALUES (?, ?, ?)'
  ).run(userId, contestantId, night);
  return { ok: true };
}

/** Ranking of the most-voted contestants for a night. */
export function resultsForNight(night) {
  return db.prepare(`
    SELECT c.id, c.name, COUNT(v.id) AS votes
    FROM contestants c
    LEFT JOIN votes v ON v.contestant_id = c.id AND v.night = c.night
    WHERE c.night = ?
    GROUP BY c.id
    ORDER BY votes DESC, c.name COLLATE NOCASE
  `).all(night);
}
