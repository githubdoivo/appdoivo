import db, { getSetting, setSetting } from './db.js';
import { nightStatus } from './time.js';
import { isNight } from './nights.js';

// Regular users don't see the full ranking the instant voting closes - the
// admin reveals it in stages (3rd, 2nd, 1st, then everyone), like an
// awards countdown, at their own pace during the event.
const REVEAL_PHASES = ['hidden', 'third', 'second', 'first', 'all'];

/** Current results-reveal phase for a night. */
export function getResultsPhase(night) {
  return getSetting(`results_phase_${night}`, 'hidden');
}

/** Resets the reveal phase back to hidden (voting opened/closed/reset). */
export function resetResultsPhase(night) {
  setSetting(`results_phase_${night}`, 'hidden');
}

/** Advances to the next reveal phase (stays at 'all' once fully revealed). */
export function advanceResultsPhase(night) {
  const idx = REVEAL_PHASES.indexOf(getResultsPhase(night));
  const next = REVEAL_PHASES[Math.min(idx + 1, REVEAL_PHASES.length - 1)];
  setSetting(`results_phase_${night}`, next);
  return next;
}

/** Contestants registered for a night, with the real user(s) behind the
 * character name (null for admin-added entries with no registrant) - a
 * character name is often improvised at submission time, so voters can't
 * be expected to recognise who's actually behind it otherwise. */
export function contestantsForNight(night) {
  return db.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? ORDER BY c.name COLLATE NOCASE
  `).all(night);
}

/** The user's vote for this night, if any. */
export function myVoteForNight(userId, night) {
  return db.prepare(
    'SELECT contestant_id FROM votes WHERE user_id = ? AND night = ?'
  ).get(userId, night) || null;
}

/** The OTHER user_id sharing this user's contestant entry for a night
 * (their duo partner), if they're registered as a duo. Null if solo or not
 * registered at all. */
function duoPartnerId(userId, night) {
  const row = db.prepare(
    'SELECT user_id, partner_user_id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
  ).get(night, userId, userId);
  if (!row) return null;
  return row.user_id === userId ? row.partner_user_id : row.user_id;
}

/** The contestant entry this user registered (solo or as part of a duo)
 * for a night, if any - used to show "you're entered as X" instead of the
 * registration form. */
export function myContestantForNight(userId, night) {
  const row = db.prepare(`
    SELECT c.id, c.name, c.user_id, u1.name AS registrant_name, u2.name AS partner_name
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? AND (c.user_id = ? OR c.partner_user_id = ?)
  `).get(night, userId, userId);
  if (!row) return null;
  const partnerName = row.user_id === userId ? row.partner_name : row.registrant_name;
  return { id: row.id, name: row.name, partnerName: partnerName || null };
}

/**
 * Self-registers the caller as a Best Look contestant for a night. Pass
 * partnerUserId to team up with another user (picked from /users/basic on
 * the frontend, not typed) - both then share one contestant entry, and one
 * combined vote for the night between them (see castVote()). Returns
 * { ok, id, name } or { error }.
 */
export function registerContestant(userId, night, name, partnerUserId) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'registration') return { error: 'err_registration_not_open' };

  const already = db.prepare(
    'SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
  ).get(night, userId, userId);
  if (already) return { error: 'err_you_already_registered' };

  const trimmedName = String(name || '').trim();
  if (!trimmedName) return { error: 'err_persona_name_required' };
  if (trimmedName.length > 60) return { error: 'err_max_60_chars' };

  let partnerId = null;
  if (partnerUserId) {
    partnerId = Number(partnerUserId);
    if (partnerId === userId) return { error: 'err_cannot_partner_with_self' };
    const partner = db.prepare('SELECT id FROM users WHERE id = ?').get(partnerId);
    if (!partner) return { error: 'err_user_invalid' };
    const partnerTaken = db.prepare(
      'SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
    ).get(night, partnerId, partnerId);
    if (partnerTaken) return { error: 'err_already_registered_this_night' };
  }

  const info = db.prepare(
    'INSERT INTO contestants (name, night, user_id, partner_user_id) VALUES (?, ?, ?, ?)'
  ).run(trimmedName, night, userId, partnerId);
  return { ok: true, id: info.lastInsertRowid, name: trimmedName };
}

/**
 * Records a vote for a night. Validates the night, the voting status, the
 * contestant and duplicates. A duo (see registerContestant()) shares one
 * combined vote - once either partner votes, the other is blocked. Returns
 * { ok } or { error }.
 */
export function castVote(userId, contestantId, night) {
  if (!isNight(night)) {
    return { error: 'err_invalid_night' };
  }
  if (nightStatus(night) !== 'open') {
    return { error: 'err_voting_not_open' };
  }

  const contestant = db.prepare(
    'SELECT id FROM contestants WHERE id = ? AND night = ?'
  ).get(contestantId, night);
  if (!contestant) {
    return { error: 'err_contestant_invalid_for_night' };
  }

  const existing = db.prepare(
    'SELECT id FROM votes WHERE user_id = ? AND night = ?'
  ).get(userId, night);
  if (existing) {
    return { error: 'err_already_voted' };
  }

  const partnerId = duoPartnerId(userId, night);
  if (partnerId) {
    const partnerVoted = db.prepare('SELECT id FROM votes WHERE user_id = ? AND night = ?').get(partnerId, night);
    if (partnerVoted) {
      return { error: 'err_duo_already_voted' };
    }
  }

  db.prepare(
    'INSERT INTO votes (user_id, contestant_id, night) VALUES (?, ?, ?)'
  ).run(userId, contestantId, night);
  return { ok: true };
}

/** Full ranking of contestants for a night, each with its rank (admin view).
 * Carries the same registeredBy/partnerName pair as contestantsForNight() -
 * results are just as identity-ambiguous as the vote picker otherwise. */
export function resultsForNight(night) {
  const rows = db.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName, COUNT(v.id) AS votes
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    LEFT JOIN votes v ON v.contestant_id = c.id AND v.night = c.night
    WHERE c.night = ?
    GROUP BY c.id
    ORDER BY votes DESC, c.name COLLATE NOCASE
  `).all(night);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Results a regular user may see right now, filtered by the reveal phase. */
export function visibleResultsForNight(night) {
  const all = resultsForNight(night);
  const phase = getResultsPhase(night);
  let results;
  if (phase === 'hidden') results = [];
  else if (phase === 'third') results = all.filter((r) => r.rank === 3);
  else if (phase === 'second') results = all.filter((r) => r.rank === 2 || r.rank === 3);
  else if (phase === 'first') results = all.filter((r) => r.rank <= 3);
  else results = all; // 'all'
  return { phase, results };
}
