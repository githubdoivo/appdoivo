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

/** Contestants actually in the running for a night, with the real user(s)
 * behind the character name (null for admin-added entries with no
 * registrant) - a character name is often improvised at submission time,
 * so voters can't be expected to recognise who's actually behind it
 * otherwise. A duo entry the named partner hasn't confirmed yet isn't a
 * real entry, so it's left out of the voting list entirely (see
 * registerContestant()/confirmContestant()). */
export function contestantsForNight(night) {
  return db.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL
    ORDER BY c.name COLLATE NOCASE
  `).all(night);
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

/** The single vote row that belongs to this user tonight - their own if
 * they're solo, or the one shared with their duo partner whichever of the
 * two actually proposed it. */
function voteRowFor(userId, night) {
  const partnerId = duoPartnerId(userId, night);
  const row = partnerId
    ? db.prepare('SELECT id, user_id, contestant_id, confirmed_at FROM votes WHERE night = ? AND user_id IN (?, ?)').get(night, userId, partnerId)
    : db.prepare('SELECT id, user_id, contestant_id, confirmed_at FROM votes WHERE night = ? AND user_id = ?').get(night, userId);
  return { row: row || null, partnerId };
}

/**
 * The vote that counts for this user tonight, or null if nothing's been
 * cast yet. A duo shares one - so this deliberately returns the partner's
 * proposal too, and says whose it is (proposedByMe) and whether it's gone
 * through the partner's confirmation yet (confirmed), which is what the
 * frontend needs to tell "waiting on them" apart from "waiting on you".
 */
export function myVoteForNight(userId, night) {
  const { row, partnerId } = voteRowFor(userId, night);
  if (!row) return null;
  const partnerName = partnerId
    ? db.prepare('SELECT name FROM users WHERE id = ?').get(partnerId)?.name ?? null
    : null;
  return {
    contestant_id: row.contestant_id,
    confirmed: !!row.confirmed_at,
    proposedByMe: row.user_id === userId,
    partnerName,
  };
}

/** The contestant entry this user registered (solo or as part of a duo)
 * for a night, if any - used to show "you're entered as X" instead of the
 * registration form. */
export function myContestantForNight(userId, night) {
  const row = db.prepare(`
    SELECT c.id, c.name, c.user_id, c.confirmed_at, c.photo IS NOT NULL AS hasPhoto,
           u1.name AS registrant_name, u2.name AS partner_name
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? AND (c.user_id = ? OR c.partner_user_id = ?)
  `).get(night, userId, userId);
  if (!row) return null;
  const partnerName = row.user_id === userId ? row.partner_name : row.registrant_name;
  return {
    id: row.id,
    name: row.name,
    partnerName: partnerName || null,
    // A duo entry isn't live until the named partner confirms it, and the
    // two of them see different things until then - hence who registered it.
    confirmed: !!row.confirmed_at,
    registeredByMe: row.user_id === userId,
    hasPhoto: !!row.hasPhoto,
  };
}

// Generous ceiling over what an 800px-JPEG-then-base64 photo should ever
// weigh (the client resizes before sending) - this is the actual
// enforcement, since a client-side cap alone can't be trusted.
const MAX_PHOTO_BYTES = 400 * 1024;

/** Decodes+validates a photo submitted as a JPEG data URL. Only JPEG is
 * accepted - the client always exports to JPEG before sending, so anything
 * else is either a bug or a bypass attempt. Returns { buffer, mime } or
 * { error }. */
function decodePhoto(photoBase64) {
  const prefix = 'data:image/jpeg;base64,';
  if (typeof photoBase64 !== 'string' || !photoBase64.startsWith(prefix)) {
    return { error: 'err_photo_invalid' };
  }
  let buffer;
  try {
    buffer = Buffer.from(photoBase64.slice(prefix.length), 'base64');
  } catch {
    return { error: 'err_photo_invalid' };
  }
  // JPEG magic bytes - catches empty/garbage payloads a spoofed prefix alone wouldn't.
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return { error: 'err_photo_invalid' };
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    return { error: 'err_photo_too_large' };
  }
  return { buffer, mime: 'image/jpeg' };
}

/**
 * Self-registers the caller as a Best Look contestant for a night. Pass
 * partnerUserId to team up with another user (picked from /users/basic on
 * the frontend, not typed) - both then share one contestant entry, and one
 * combined vote for the night between them (see castVote()).
 *
 * A duo entry starts UNCONFIRMED: you can't put someone in a costume pair
 * without them agreeing, so the named partner has to confirmContestant()
 * on their own account before it's a real entry (until then it's hidden
 * from the voting list). Solo entries have nobody to agree with and go
 * live immediately. autoConfirm skips the whole dance for entries an admin
 * creates on someone's behalf - that's the organiser acting deliberately,
 * and blocking them behind a guest's phone would just get in the way (it
 * also skips requirePhoto, for the same reason).
 *
 * requirePhoto rejects a missing photo outright (the guest-facing route
 * sets this; organiser-created entries don't). The photo itself belongs to
 * the entry, not either person, so either half of a duo can swap it later
 * via replaceContestantPhoto() - this is only where it's first attached.
 *
 * Returns { ok, id, name, pending } or { error }.
 */
export function registerContestant(userId, night, name, partnerUserId, { autoConfirm = false, photoBase64 = null, requirePhoto = false } = {}) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'registration') return { error: 'err_registration_not_open' };

  const already = db.prepare(
    'SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
  ).get(night, userId, userId);
  if (already) return { error: 'err_you_already_registered' };

  const trimmedName = String(name || '').trim();
  if (!trimmedName) return { error: 'err_persona_name_required' };
  if (trimmedName.length > 60) return { error: 'err_max_60_chars' };

  let photo = null;
  if (photoBase64) {
    photo = decodePhoto(photoBase64);
    if (photo.error) return photo;
  } else if (requirePhoto) {
    return { error: 'err_photo_required' };
  }

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
    'INSERT INTO contestants (name, night, user_id, partner_user_id, photo, photo_mime) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(trimmedName, night, userId, partnerId, photo?.buffer ?? null, photo?.mime ?? null);
  // Only a self-registered duo waits on anyone.
  const pending = !!partnerId && !autoConfirm;
  if (!pending) {
    db.prepare("UPDATE contestants SET confirmed_at = datetime('now') WHERE id = ?").run(info.lastInsertRowid);
  }
  return { ok: true, id: info.lastInsertRowid, name: trimmedName, pending };
}

/**
 * Swaps the photo on the caller's own entry - either half of a duo, not
 * just whoever registered it, since it's a photo of the pair rather than
 * either person's individually. Allowed any time before voting opens, same
 * window as cancelling/confirming: opening voting locks the roster (photos
 * included), so this would otherwise let someone dodge a bad photo choice
 * after the fact. Returns { ok } or { error }.
 */
export function replaceContestantPhoto(userId, night, photoBase64) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'registration') return { error: 'err_registration_not_open' };

  const row = db.prepare(
    'SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
  ).get(night, userId, userId);
  if (!row) return { error: 'err_no_contestant_entry' };

  const photo = decodePhoto(photoBase64);
  if (photo.error) return photo;

  db.prepare('UPDATE contestants SET photo = ?, photo_mime = ? WHERE id = ?').run(photo.buffer, photo.mime, row.id);
  return { ok: true };
}

/** Raw lookup for the photo-serving route - carries the identity/night
 * fields it needs to decide whether the requester may see it (their own
 * entry, an admin, or a night whose results have been revealed that far).
 * Null if there's no photo at all (never uploaded, or an admin/seed entry
 * with nobody behind it to upload one). */
export function contestantPhotoRow(contestantId) {
  return db.prepare(
    'SELECT id, night, user_id, partner_user_id, photo, photo_mime FROM contestants WHERE id = ? AND photo IS NOT NULL'
  ).get(contestantId) || null;
}

/** Every photo submitted for a night, for the admin/owner zip download
 * (see GET /admin/outfit/:night/photos.zip) - includes pending (unconfirmed
 * duo) entries too, unlike contestantsForNight(), since an admin auditing
 * or archiving a night's submissions has reason to see everything, not
 * just what guests could vote on. */
export function allPhotosForNight(night) {
  return db.prepare(`
    SELECT c.id, c.name, c.photo, c.photo_mime, u1.name AS registeredBy, u2.name AS partnerName
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? AND c.photo IS NOT NULL
    ORDER BY c.name COLLATE NOCASE
  `).all(night);
}

/**
 * The named partner's half of a duo entry: confirms they're actually in
 * it, which is what puts the pair on the voting list. Only they can - the
 * person who registered it obviously already agrees. Entries are locked
 * once voting opens, so this is only possible while registration is still
 * running. Returns { ok } or { error }.
 */
export function confirmContestant(userId, night) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'registration') return { error: 'err_registration_not_open' };

  const row = db.prepare(
    'SELECT id, user_id, partner_user_id, confirmed_at FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
  ).get(night, userId, userId);
  if (!row) return { error: 'err_no_pending_entry' };
  if (row.confirmed_at) return { error: 'err_you_already_registered' };
  if (row.user_id === userId) return { error: 'err_partner_must_confirm_entry' };

  db.prepare("UPDATE contestants SET confirmed_at = datetime('now') WHERE id = ?").run(row.id);
  return { ok: true };
}

/**
 * Drops an unconfirmed duo entry, freeing both of them to enter again
 * (alone, or with someone else). Either can do it: the partner saying "no,
 * I'm not doing that" and the registrant thinking better of it are the
 * same operation, and neither loses anything since it was never live.
 * Returns { ok } or { error }.
 */
export function cancelPendingContestant(userId, night) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'registration') return { error: 'err_registration_not_open' };

  const row = db.prepare(
    'SELECT id, confirmed_at FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
  ).get(night, userId, userId);
  if (!row) return { error: 'err_no_pending_entry' };
  if (row.confirmed_at) return { error: 'err_you_already_registered' };

  db.prepare('DELETE FROM contestants WHERE id = ?').run(row.id);
  return { ok: true };
}

/** How many duo entries are still waiting on their named partner - the
 * owner gets warned about these before opening the voting, since opening
 * locks entries and strands them. */
export function pendingContestantCount(night) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM contestants WHERE night = ? AND confirmed_at IS NULL'
  ).get(night).n;
}

/**
 * Casts (solo) or proposes (duo) a vote for a night. Validates the night,
 * the voting status, the contestant, duplicates, and that the voter isn't
 * voting for their own entry.
 *
 * A duo (see registerContestant()) shares ONE vote, and it takes both of
 * them to spend it: this only proposes it, and the partner has to
 * confirmDuoVote() on their own account before it counts for anything.
 * Whoever gets there first no longer decides for the pair on their own.
 * Returns { ok, pending } or { error } - pending true means it's a
 * proposal still waiting on the partner.
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

  // Solo or as part of a duo, a contestant can't vote for their own entry -
  // left open, everyone would just vote for themselves, and a duo's shared
  // entry would get an "extra" vote nobody else's entry could get.
  const ownEntry = myContestantForNight(userId, night);
  if (ownEntry && ownEntry.id === contestant.id) {
    return { error: 'err_cannot_vote_self' };
  }

  // One row per person, or per pair - voteRowFor() already looks under
  // both names for a duo, so a partner's pending proposal blocks a second
  // one just as a finished vote does (they settle it between them via
  // confirm/cancel instead of racing each other).
  const { row: existing, partnerId } = voteRowFor(userId, night);
  if (existing) {
    return { error: partnerId ? 'err_duo_already_voted' : 'err_already_voted' };
  }

  const info = db.prepare(
    'INSERT INTO votes (user_id, contestant_id, night) VALUES (?, ?, ?)'
  ).run(userId, contestantId, night);
  // Solo: nobody left to agree with, so it counts immediately. Duo: left
  // unconfirmed until the partner signs off (see confirmDuoVote()).
  if (!partnerId) {
    db.prepare("UPDATE votes SET confirmed_at = datetime('now') WHERE id = ?").run(info.lastInsertRowid);
  }
  return { ok: true, pending: !!partnerId };
}

/**
 * The partner's half of a duo vote: confirms the proposal the other one
 * left, which is what actually makes it count. Deliberately refuses when
 * the caller is the proposer - letting them confirm their own proposal
 * would just be the old first-past-the-post rule with extra steps.
 * Returns { ok } or { error }.
 */
export function confirmDuoVote(userId, night) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'open') return { error: 'err_voting_not_open' };

  const { row, partnerId } = voteRowFor(userId, night);
  if (!partnerId) return { error: 'err_not_a_duo' };
  if (!row) return { error: 'err_no_pending_vote' };
  if (row.confirmed_at) return { error: 'err_already_voted' };
  if (row.user_id === userId) return { error: 'err_partner_must_confirm' };

  db.prepare("UPDATE votes SET confirmed_at = datetime('now') WHERE id = ?").run(row.id);
  return { ok: true };
}

/**
 * Drops a duo's unconfirmed proposal, freeing the pair to propose a
 * different contestant. Either of them can do it - the proposer changing
 * their mind and the partner disagreeing are the same operation, and
 * there's nothing to lose either way since it never counted. A confirmed
 * vote is final and can't be taken back. Returns { ok } or { error }.
 */
export function cancelPendingVote(userId, night) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'open') return { error: 'err_voting_not_open' };

  const { row, partnerId } = voteRowFor(userId, night);
  if (!partnerId) return { error: 'err_not_a_duo' };
  if (!row) return { error: 'err_no_pending_vote' };
  if (row.confirmed_at) return { error: 'err_already_voted' };

  db.prepare('DELETE FROM votes WHERE id = ?').run(row.id);
  return { ok: true };
}

/** How many duo proposals are still waiting on a partner tonight - the
 * owner gets warned about these before closing, since closing strands
 * them (they never counted and never will). */
export function pendingVoteCount(night) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM votes WHERE night = ? AND confirmed_at IS NULL'
  ).get(night).n;
}

/** Full ranking of contestants for a night, each with its rank (admin view).
 * Carries the same registeredBy/partnerName pair as contestantsForNight() -
 * results are just as identity-ambiguous as the vote picker otherwise.
 * Only confirmed votes are counted: a duo proposal nobody signed off on
 * isn't a vote yet (see castVote()/confirmDuoVote()). hasPhoto lets the
 * frontend skip rendering an image for entries that never got one (legacy
 * rows, organiser-created entries) instead of showing a broken-image icon -
 * the actual bytes are only ever served by the separately-gated photo route. */
export function resultsForNight(night) {
  const rows = db.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName, COUNT(v.id) AS votes,
           c.photo IS NOT NULL AS hasPhoto
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    LEFT JOIN votes v ON v.contestant_id = c.id AND v.night = c.night AND v.confirmed_at IS NOT NULL
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL
    GROUP BY c.id
    ORDER BY votes DESC, c.name COLLATE NOCASE
  `).all(night);
  return rows.map((r, i) => ({ ...r, hasPhoto: !!r.hasPhoto, rank: i + 1 }));
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
