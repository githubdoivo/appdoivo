import db, { getSetting, setSetting } from './db.js';
import { nightStatus } from './time.js';
import { isNight } from './nights.js';
import { decodeJpegDataUrl as decodePhoto, MAX_PHOTO_BYTES } from './photos.js';

// Regular users don't see the full ranking the instant voting closes - the
// admin reveals it in stages (3rd, 2nd, 1st, then everyone), like an
// awards countdown, at their own pace during the event.
const REVEAL_PHASES = ['hidden', 'third', 'second', 'first', 'all'];

/**
 * Tie-breaking is the same machinery for both of the night's rounds - the
 * outfit vote and Miss Congeniality - so it is written once here and each
 * round keeps its own copy of the state under its own settings prefix.
 * Miss Congeniality used to have none of it: equal votes were sorted by
 * name, so the alphabet crowned somebody and no tie was ever visible. It
 * gets the same runoff the outfit vote has.
 */
function runoffKeys(prefix) {
  return {
    round: (night) => `${prefix}runoff_round_${night}`,
    ids: (night) => `${prefix}runoff_ids_${night}`,
    rank: (night) => `${prefix}runoff_rank_${night}`,
    order: (night) => `${prefix}tiebreak_order_${night}`,
  };
}
// The outfit vote's keys are unprefixed - they were named before there was
// a second round to tell apart, and renaming them would orphan the state of
// a night already in progress.
const OUTFIT_KEYS = runoffKeys('');
const CONG_KEYS = runoffKeys('cong_');

/** Which round of voting is live: 0 for the night's real vote, 1+ while a
 * tie-breaker runoff is running. Ballots are kept apart by round so that
 * settling a tie cannot disturb the placings it sits below. */
function roundFor(keys, night) {
  return Number(getSetting(keys.round(night), 0)) || 0;
}

/** The order a finished runoff settled a tied group into, as row ids.
 * Empty when no tie has been broken on this night yet. */
function tiebreakOrderFor(keys, night) {
  const raw = getSetting(keys.order(night));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The ids currently in a tie-breaker runoff for a night, or null if none
 * is active - see startRunoff()/startCongenialityRunoff() below. */
function runoffIdsFor(keys, night) {
  const raw = getSetting(keys.ids(night));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Opens a runoff on an already-ranked set of standings: picks the tied
 * group at `atRank` (or the highest unresolved tie when not told which) and
 * moves the round on, so the new ballots land somewhere of their own
 * instead of on top of the tally they exist to break. The caller does the
 * round-specific parts - checking its own vote is closed, and reopening it.
 */
function beginRunoff(keys, night, results, atRank) {
  const tiedPlaces = [...new Set(results.filter((r) => r.tied).map((r) => r.rank))].sort((a, b) => a - b);
  const rank = atRank == null ? tiedPlaces[0] : Number(atRank);
  if (rank == null || Number.isNaN(rank)) return { error: 'err_no_tie' };

  const tied = results.filter((r) => r.tied && r.rank === rank);
  if (tied.length < 2) return { error: 'err_no_tie' };

  // A NEW round rather than a wipe. Deleting the night's votes settled the
  // tie and destroyed every placing below it in the same stroke - after a
  // runoff for 1st, 2nd and 3rd were left on zero votes each. Rounds are
  // counted separately (see roundFor), so the real tally survives.
  setSetting(keys.round(night), String(roundFor(keys, night) + 1));
  setSetting(keys.ids(night), JSON.stringify(tied.map((r) => r.id)));
  setSetting(keys.rank(night), String(rank));
  return { ok: true, rank, ids: tied.map((r) => r.id) };
}

/**
 * Closes a runoff and records what it decided, given that round's own
 * tallies (id -> votes).
 *
 * The outcome is an ORDER, not a score. The tied group keeps the band of
 * places it already held - a runoff for 2nd settles 2nd and 3rd between
 * those two and cannot promote either past 1st - because a runoff is voted
 * by a different, smaller ballot and its counts mean nothing next to the
 * main round's.
 *
 * A runoff that ties again records nothing and says so, leaving the tie
 * standing for another one. Picking a winner out of a second dead heat is
 * exactly the silent alphabetical decision this replaced.
 */
function endRunoff(keys, night, tallies) {
  const ids = runoffIdsFor(keys, night);
  if (!ids) return { error: 'err_no_runoff' };

  const order = [...ids].sort((a, b) => tallies.get(b) - tallies.get(a));
  const stillTied = tallies.get(order[0]) === tallies.get(order[order.length - 1]);

  setSetting(keys.round(night), '0');
  setSetting(keys.ids(night), '');
  setSetting(keys.rank(night), '');
  if (stillTied) return { ok: true, stillTied: true };

  // Kept alongside any earlier tie this night already settled, so breaking a
  // second tie does not forget the first.
  const kept = tiebreakOrderFor(keys, night).filter((id) => !ids.includes(id));
  setSetting(keys.order(night), JSON.stringify([...kept, ...order]));
  return { ok: true, stillTied: false, order };
}

/** Ends a runoff scope without recording an outcome - a fresh
 * registration/reset(-all) starts a genuinely new round, not a
 * continuation of an old tie. */
function discardRunoff(keys, night) {
  setSetting(keys.ids(night), '');
  setSetting(keys.round(night), '0');
  setSetting(keys.rank(night), '');
  setSetting(keys.order(night), '');
}

function currentRound(night) {
  return roundFor(OUTFIT_KEYS, night);
}

function getTiebreakOrder(night) {
  return tiebreakOrderFor(OUTFIT_KEYS, night);
}

function getRunoffIds(night) {
  return runoffIdsFor(OUTFIT_KEYS, night);
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
    ? db.prepare('SELECT id, user_id, contestant_id, confirmed_at FROM votes WHERE night = ? AND round = ? AND user_id IN (?, ?)').get(night, currentRound(night), userId, partnerId)
    : db.prepare('SELECT id, user_id, contestant_id, confirmed_at FROM votes WHERE night = ? AND round = ? AND user_id = ?').get(night, currentRound(night), userId);
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
    'INSERT INTO votes (user_id, contestant_id, night, round) VALUES (?, ?, ?, ?)'
  ).run(userId, contestantId, night, currentRound(night));
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
    'SELECT COUNT(*) AS n FROM votes WHERE night = ? AND round = ? AND confirmed_at IS NULL'
  ).get(night, currentRound(night)).n;
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
  // Counts the live round's ballots: the night's real vote normally, the
  // runoff's while one is running. Without the round filter a runoff's
  // ballots would be added to the tally they were meant to break.
  const round = currentRound(night);
  const rows = db.prepare(`
    SELECT c.id, c.name, u1.name AS registeredBy, u2.name AS partnerName, COUNT(v.id) AS votes,
           c.photo IS NOT NULL AS hasPhoto
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    LEFT JOIN votes v ON v.contestant_id = c.id AND v.night = c.night AND v.round = ? AND v.confirmed_at IS NOT NULL
    WHERE c.night = ? AND c.confirmed_at IS NOT NULL
    GROUP BY c.id
    ORDER BY votes DESC, c.name COLLATE NOCASE
  `).all(round, night);
  // Once a runoff is active, the standings that matter are just the tied
  // group revoting among themselves - everyone else's (now stale) tally
  // from the first round would just be confusing clutter here.
  const runoff = getRunoffIds(night);
  const scoped = runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
  return rankRows(scoped.map((r) => ({ ...r, hasPhoto: !!r.hasPhoto })), getTiebreakOrder(night));
}

/**
 * Competition ranking: equal votes share a place and the next place skips,
 * so four contestants on 3,3,1,1 come out 1st, 1st, 3rd, 3rd.
 *
 * Rank used to be the row's position in the list - `i + 1` over a query
 * sorted by votes then `name COLLATE NOCASE`. That quietly made the
 * alphabet the tiebreaker: a genuine tie was reported as a clean 1st and
 * 2nd, and the podium published whichever name came first. Nobody could
 * see that a tie had happened, least of all the person who lost one.
 *
 * Shared by both of the night's rounds, so it knows nothing about
 * contestants specifically - it ranks anything with an `id` and a `votes`.
 *
 * `order` is a runoff outcome - the ids of a tied group in the order that
 * runoff settled them. Applying it gives that group sequential places
 * within the band it already occupies, so breaking a tie for 2nd cannot
 * move anybody past 1st. A group with no runoff behind it keeps its shared
 * rank and is flagged `tied`, which is what tells the admin one is owed.
 */
function rankRows(rows, order) {
  const byVotes = new Map();
  for (const r of rows) {
    if (!byVotes.has(r.votes)) byVotes.set(r.votes, []);
    byVotes.get(r.votes).push(r);
  }
  const out = [];
  let place = 1;
  for (const votes of [...byVotes.keys()].sort((a, b) => b - a)) {
    const group = byVotes.get(votes);
    // Everyone on nought is not a tie, it is a night nobody has voted in
    // yet. Flagging it as one would offer a runoff between contestants who
    // have not been judged at all, and would block publishing a night that
    // simply went unvoted.
    const isRealTie = group.length > 1 && votes > 0;
    const settled = isRealTie && group.every((r) => order.includes(r.id));
    const ordered = settled
      ? [...group].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      : group;
    ordered.forEach((r, i) => {
      out.push({
        ...r,
        rank: settled ? place + i : place,
        tied: isRealTie && !settled,
      });
    });
    place += group.length;
  }
  return out;
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
export function startRunoff(night, atRank = null) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (nightStatus(night) !== 'closed') return { error: 'err_voting_not_closed' };

  // Any place, not only the top. Defaults to the highest unresolved tie,
  // because that is the one an organiser means when they press the button
  // without choosing.
  const started = beginRunoff(OUTFIT_KEYS, night, resultsForNight(night), atRank);
  if (started.error) return started;

  resetResultsPhase(night);
  setSetting(`voting_status_${night}`, 'open');
  return { ok: true, rank: started.rank, contestantIds: started.ids };
}

/** Closes the outfit vote's runoff and records what it decided - see
 * endRunoff() for what "decided" means here. */
export function resolveRunoff(night) {
  const ids = getRunoffIds(night);
  if (!ids) return { error: 'err_no_runoff' };

  const tallies = new Map(ids.map((id) => [id, 0]));
  for (const row of db.prepare(
    'SELECT contestant_id AS id, COUNT(*) AS votes FROM votes WHERE night = ? AND round = ? AND confirmed_at IS NOT NULL GROUP BY contestant_id'
  ).all(night, currentRound(night))) {
    if (tallies.has(row.id)) tallies.set(row.id, row.votes);
  }
  return endRunoff(OUTFIT_KEYS, night, tallies);
}


/* -------------------------- Miss Congeniality ----------------------------- */
// A second vote per night, run after the outfit vote. Two things make it
// deliberately simpler than the main vote above: it's cast for a *person*
// rather than an entry (so a duo splits into its two individuals - the
// pairing only ever mattered for the outfit itself), and it has no staged
// reveal, just open -> closed -> revealed.
//
// Ties are NOT one of the differences, though they were: this round used to
// order by votes then name, which handed a dead heat to whoever came first
// in the alphabet without anyone seeing a tie had happened. It now ranks and
// flags ties the same way, and breaks them with the same kind of runoff.

const CONGENIALITY_PHASES = ['closed', 'open', 'revealed'];

/** 'closed' (default, nobody can vote yet), 'open', or 'revealed'. */
export function congenialityStatus(night) {
  const s = getSetting(`congeniality_status_${night}`, 'closed');
  return CONGENIALITY_PHASES.includes(s) ? s : 'closed';
}

export function setCongenialityStatus(night, status) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (!CONGENIALITY_PHASES.includes(status)) return { error: 'err_invalid_congeniality_status' };
  // Revealing is this round's equivalent of publishing the podium, and the
  // outfit vote refuses that over an unbroken tie for the same reason: a
  // reveal cannot be taken back, so a tie has to be settled by a runoff
  // before it, not discovered afterwards by two people being crowned at
  // once. Only the top place matters here - this round announces a winner,
  // not a ranking, so a tie further down decides nothing.
  if (status === 'revealed') {
    const tie = congenialityResults(night).find((r) => r.tied && r.rank === 1);
    if (tie) return { error: 'err_congeniality_tie_unresolved', rank: tie.rank };
  }
  setSetting(`congeniality_status_${night}`, status);
  return { ok: true, night, congenialityStatus: status };
}

/** Whether a Miss Congeniality tie-breaker is running for a night. */
export function isCongenialityRunoffActive(night) {
  return runoffIdsFor(CONG_KEYS, night) !== null;
}

/**
 * Everyone in the running: every guest, whether or not they entered the
 * outfit vote. Congeniality is about the company someone was, not the look,
 * so it was wrong to limit it to people with a Best Outfit entry - a guest
 * who skipped the costume could still be the best company of the night.
 * The owner is the host, not a guest, so they are left out.
 */
function allCongenialityCandidates() {
  return db.prepare(`
    SELECT id, name FROM users
    WHERE is_owner = 0
    ORDER BY name COLLATE NOCASE
  `).all();
}

export function congenialityCandidates(night) {
  const rows = allCongenialityCandidates();
  // A runoff narrows who is actually votable to just the tied group, the
  // same way the outfit vote's does - everyone else was already judged in
  // the round that produced the tie.
  const runoff = runoffIdsFor(CONG_KEYS, night);
  return runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
}

/** This user's vote in the round that is live - so somebody who voted in the
 * night proper still has a vote to cast in a runoff. */
export function myCongenialityVote(userId, night) {
  const row = db.prepare(
    'SELECT target_user_id FROM congeniality_votes WHERE user_id = ? AND night = ? AND round = ?'
  ).get(userId, night, roundFor(CONG_KEYS, night));
  return row ? row.target_user_id : null;
}

export function castCongenialityVote(userId, targetUserId, night) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (congenialityStatus(night) !== 'open') return { error: 'err_congeniality_not_open' };
  // Same rule as the outfit vote - you don't get to crown yourself.
  if (Number(targetUserId) === Number(userId)) return { error: 'err_cannot_vote_self' };
  if (!allCongenialityCandidates().some((c) => c.id === Number(targetUserId))) {
    return { error: 'err_not_a_candidate' };
  }
  // Mid-runoff only the tied group is votable. Told apart from "not a
  // candidate" on purpose: this person WAS in the running and no longer is,
  // which is a different thing to say.
  const runoff = runoffIdsFor(CONG_KEYS, night);
  if (runoff && !runoff.includes(Number(targetUserId))) return { error: 'err_not_in_runoff' };
  if (myCongenialityVote(userId, night) !== null) return { error: 'err_already_voted' };

  db.prepare(
    'INSERT INTO congeniality_votes (user_id, target_user_id, night, round) VALUES (?, ?, ?, ?)'
  ).run(userId, targetUserId, night, roundFor(CONG_KEYS, night));
  return { ok: true };
}

/**
 * Full standings, ranked. Admin-visible at any phase.
 *
 * Carries the same `rank`/`tied` pair as the outfit vote's results and for
 * the same reason: this used to be a bare list ordered by votes then name,
 * so two people on the same count came out as a clean 1st and 2nd and the
 * alphabet decided which - invisibly, to everyone including whoever lost.
 */
export function congenialityResults(night) {
  // The live round's ballots only: the night's real vote normally, the
  // runoff's while one is running (see startCongenialityRunoff()).
  const round = roundFor(CONG_KEYS, night);
  const rows = db.prepare(`
    SELECT u.id, u.name, COUNT(v.id) AS votes
    FROM users u
    LEFT JOIN congeniality_votes v
      ON v.target_user_id = u.id AND v.night = ? AND v.round = ?
    WHERE u.is_owner = 0
    GROUP BY u.id
    ORDER BY votes DESC, u.name COLLATE NOCASE
  `).all(night, round);
  const runoff = runoffIdsFor(CONG_KEYS, night);
  const scoped = runoff ? rows.filter((r) => runoff.includes(r.id)) : rows;
  return rankRows(scoped, tiebreakOrderFor(CONG_KEYS, night));
}

/** Just the winner, and only once revealed - what a guest is allowed to see.
 * An unbroken tie for the top has no winner to show: setCongenialityStatus()
 * refuses to reveal one, so this only returns null here if a night somehow
 * got past it. */
export function congenialityWinner(night) {
  if (congenialityStatus(night) !== 'revealed') return null;
  const top = congenialityResults(night).filter((r) => r.rank === 1);
  return top.length === 1 && top[0].votes > 0 ? top[0] : null;
}

/**
 * Starts a Miss Congeniality tie-breaker: a fresh vote scoped to just the
 * people tied at one place, exactly as the outfit vote's runoff works (see
 * startRunoff()). Needs the round closed first - a tie can only be judged
 * once nobody can still change it - and reopens voting scoped to the tied
 * group. The earlier ballots are kept, in their own round, so the tally the
 * tie came out of survives being broken.
 */
export function startCongenialityRunoff(night, atRank = null) {
  if (!isNight(night)) return { error: 'err_invalid_night' };
  if (congenialityStatus(night) !== 'closed') return { error: 'err_congeniality_not_closed' };

  const started = beginRunoff(CONG_KEYS, night, congenialityResults(night), atRank);
  if (started.error) return started;

  setSetting(`congeniality_status_${night}`, 'open');
  return { ok: true, rank: started.rank, userIds: started.ids };
}

/** Closes a Miss Congeniality runoff and records what it decided - see
 * endRunoff() for what that means. */
export function resolveCongenialityRunoff(night) {
  const ids = runoffIdsFor(CONG_KEYS, night);
  if (!ids) return { error: 'err_no_runoff' };

  const tallies = new Map(ids.map((id) => [id, 0]));
  for (const row of db.prepare(
    'SELECT target_user_id AS id, COUNT(*) AS votes FROM congeniality_votes WHERE night = ? AND round = ? GROUP BY target_user_id'
  ).all(night, roundFor(CONG_KEYS, night))) {
    if (tallies.has(row.id)) tallies.set(row.id, row.votes);
  }
  return endRunoff(CONG_KEYS, night, tallies);
}

/** Wipes this night's congeniality vote back to square one - every round of
 * it, and whatever a runoff had already settled. */
export function resetCongeniality(night) {
  db.prepare('DELETE FROM congeniality_votes WHERE night = ?').run(night);
  discardRunoff(CONG_KEYS, night);
  setSetting(`congeniality_status_${night}`, 'closed');
}

/** Clears the votes but leaves the round open - the "start over without
 *  shutting everyone out" case, mirroring the outfit vote's own reset. */
export function resetCongenialityVotes(night) {
  db.prepare('DELETE FROM congeniality_votes WHERE night = ?').run(night);
  discardRunoff(CONG_KEYS, night);
  setSetting(`congeniality_status_${night}`, 'open');
}
