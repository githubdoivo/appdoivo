import db, { getSetting, setSetting } from './db.js';
import { nightStatus } from './time.js';
import { isNight } from './nights.js';

// Regular users don't see the full ranking the instant voting closes - the
// admin reveals it in stages (3rd, 2nd, 1st, then everyone), like an
// awards countdown, at their own pace during the event.
const REVEAL_PHASES = ['hidden', 'third', 'second', 'first', 'all'];

/** Contestant IDs currently in a tie-breaker runoff for a night, or null if
 * none is active - see startRunoff() below. */
function getRunoffIds(night) {
  const raw = getSetting(`runoff_ids_${night}`);
  return raw ? JSON.parse(raw) : null;
}

export function isRunoffActive(night) {
  return getRunoffIds(night) !== null;
}

/** Ends whatever runoff scope was active - a fresh registration/reset(-all)
 * starts a genuinely new round, not a continuation of an old tie. */
export function clearRunoff(night) {
  setSetting(`runoff_ids_${night}`, '');
}

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
  const rows = db.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL
    ORDER BY c.name COLLATE NOCASE
  `).all(night);
  // A runoff narrows who's actually votable to just the tied group (see
  // startRunoff()) - everyone else already lost the first round.
  const runoff = getRunoffIds(night);
  return runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
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

  // Mid-runoff, only the tied group is actually votable - everyone else
  // already lost the first round (see startRunoff()).
  const runoff = getRunoffIds(night);
  if (runoff && !runoff.includes(contestantId)) {
    return { error: 'err_not_in_runoff' };
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

/** How many accounts have no confirmed vote for a night yet - the owner
 * gets warned about this before closing too, separately from
 * pendingVoteCount() above (that's specifically duo proposals already
 * mid-flight; this is everyone who hasn't voted at all). Goes through
 * myVoteForNight() per user rather than a raw count so a duo's non-
 * proposing half - whose vote lives under their partner's user_id, not
 * their own - correctly counts as having voted once confirmed. */
/** How many accounts are expected to vote at all - the denominator for
 *  "5 of 30 have voted". Same exclusion as usersWithoutVoteCount() below,
 *  or the two numbers would disagree with each other. */
/** How many people are on the roster for a night - a duo entry counts as
 *  two, because two people are in it. Compared against the number expected
 *  to vote before opening, so nobody is left out of their own night. */
export function enteredPeopleCount(night) {
  const rows = db.prepare(
    'SELECT user_id, partner_user_id FROM contestants WHERE night = ? AND confirmed_at IS NOT NULL'
  ).all(night);
  const people = new Set();
  for (const r of rows) {
    if (r.user_id) people.add(r.user_id);
    if (r.partner_user_id) people.add(r.partner_user_id);
  }
  return people.size;
}

// Everyone with an account, admins and the owner included. They are at the
// party and they vote like anyone else, so leaving them out made "5 of 30"
// count a smaller room than the one actually voting - and the two numbers
// only agree with each other if both are drawn from the same set.
export function eligibleVoterCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function usersWithoutVoteCount(night) {
  // Same set as eligibleVoterCount() above - every account, no exclusions.
  const userIds = db.prepare('SELECT id FROM users').all().map((r) => r.id);
  return userIds.filter((id) => {
    const vote = myVoteForNight(id, night);
    return !vote || !vote.confirmed;
  }).length;
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
  // Once a runoff is active, the standings that matter are just the tied
  // group revoting among themselves - everyone else's (now stale) tally
  // from the first round would just be confusing clutter here.
  const runoff = getRunoffIds(night);
  const scoped = runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
  return scoped.map((r, i) => ({ ...r, hasPhoto: !!r.hasPhoto, rank: i + 1 }));
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

/**
 * Starts a tie-breaker runoff: a fresh vote scoped to only the contestants
 * tied for 1st place, like a real election runoff, instead of leaving an
 * actual tie standing. Requires voting to already be closed (a tie can
 * only be judged once nobody can vote anymore) and at least two
 * contestants sharing the top spot. Wipes the previous votes - they
 * already served their purpose, identifying the tie - and reopens voting
 * scoped to just the tied group; see contestantsForNight()/castVote()/
 * resultsForNight() above for where that scope is enforced.
 */
export function startRunoff(night) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'closed') return { error: 'err_voting_not_closed' };

  const results = resultsForNight(night);
  const topVotes = results[0]?.votes ?? 0;
  const tied = results.filter((r) => r.votes === topVotes);
  if (tied.length < 2) return { error: 'err_no_tie' };

  setSetting(`runoff_ids_${night}`, JSON.stringify(tied.map((r) => r.id)));
  db.prepare('DELETE FROM votes WHERE night = ?').run(night);
  resetResultsPhase(night);
  setSetting(`voting_status_${night}`, 'open');
  return { ok: true, contestantIds: tied.map((r) => r.id) };
}

/* -------------------------- Miss Congeniality ----------------------------- */
// A second vote per night, run after the outfit vote. Two things make it
// deliberately simpler than the main vote above: it's cast for a *person*
// rather than an entry (so a duo splits into its two individuals - the
// pairing only ever mattered for the outfit itself), and it has no staged
// reveal, just open -> closed -> revealed.

const CONGENIALITY_PHASES = ['closed', 'open', 'revealed'];

/** 'closed' (default, nobody can vote yet), 'open', or 'revealed'. */
export function congenialityStatus(night) {
  const s = getSetting(`congeniality_status_${night}`, 'closed');
  return CONGENIALITY_PHASES.includes(s) ? s : 'closed';
}

export function setCongenialityStatus(night, status) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (!CONGENIALITY_PHASES.includes(status)) return { error: 'err_invalid_congeniality_status' };
  setSetting(`congeniality_status_${night}`, status);
  return { ok: true, night, congenialityStatus: status };
}

/**
 * Everyone in the running: the individual people behind the night's
 * confirmed entries, each listed once. A duo entry contributes both of its
 * people separately (that's the whole point - congeniality is personal,
 * the outfit was the shared part), and an admin-added entry with nobody
 * linked to it contributes nobody, since there's no person to vote for.
 */
export function congenialityCandidates(night) {
  return db.prepare(`
    SELECT DISTINCT u.id, u.name
    FROM contestants c
    JOIN users u ON u.id IN (c.user_id, c.partner_user_id)
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL
    ORDER BY u.name COLLATE NOCASE
  `).all(night);
}

export function myCongenialityVote(userId, night) {
  const row = db.prepare(
    'SELECT target_user_id FROM congeniality_votes WHERE user_id = ? AND night = ?'
  ).get(userId, night);
  return row ? row.target_user_id : null;
}

export function castCongenialityVote(userId, targetUserId, night) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (congenialityStatus(night) !== 'open') return { error: 'err_congeniality_not_open' };
  // Same rule as the outfit vote - you don't get to crown yourself.
  if (Number(targetUserId) === Number(userId)) return { error: 'err_cannot_vote_self' };
  if (!congenialityCandidates(night).some((c) => c.id === Number(targetUserId))) {
    return { error: 'err_not_a_candidate' };
  }
  if (myCongenialityVote(userId, night) !== null) return { error: 'err_already_voted' };

  db.prepare(
    'INSERT INTO congeniality_votes (user_id, target_user_id, night) VALUES (?, ?, ?)'
  ).run(userId, targetUserId, night);
  return { ok: true };
}

/** Full standings, most votes first. Admin-visible at any phase. */
export function congenialityResults(night) {
  return db.prepare(`
    SELECT u.id, u.name, COUNT(v.id) AS votes
    FROM contestants c
    JOIN users u ON u.id IN (c.user_id, c.partner_user_id)
    LEFT JOIN congeniality_votes v ON v.target_user_id = u.id AND v.night = c.night
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL
    GROUP BY u.id
    ORDER BY votes DESC, u.name COLLATE NOCASE
  `).all(night);
}

/** Just the winner, and only once revealed - what a guest is allowed to see. */
export function congenialityWinner(night) {
  if (congenialityStatus(night) !== 'revealed') return null;
  const [top] = congenialityResults(night);
  return top && top.votes > 0 ? top : null;
}

/** Wipes this night's congeniality vote back to square one. */
export function resetCongeniality(night) {
  db.prepare('DELETE FROM congeniality_votes WHERE night = ?').run(night);
  setSetting(`congeniality_status_${night}`, 'closed');
}

/** Clears the votes but leaves the round open - the "start over without
 *  shutting everyone out" case, mirroring the outfit vote's own reset. */
export function resetCongenialityVotes(night) {
  db.prepare('DELETE FROM congeniality_votes WHERE night = ?').run(night);
  setSetting(`congeniality_status_${night}`, 'open');
}
