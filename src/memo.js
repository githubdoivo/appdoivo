import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, unlinkSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import db from './db.js';
import { today, getTimezone, now } from './time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same DB_FILE resolution as db.js (not exported from there) - keeps the
// memo storage root sitting right next to app.sqlite always: /data on
// prod (persistent volume), and the project-local ephemeral data/ dir in
// dev/QA, so QA's uploads reset on every deploy for free, same as its DB.
const DB_FILE = process.env.DB_FILE || join(__dirname, '..', 'data', 'app.sqlite');
export const MEMO_DIR = join(dirname(DB_FILE), 'memo-uploads');
mkdirSync(MEMO_DIR, { recursive: true });

export const MEMO_SLOTS_PER_DAY = 5;
export const MEMO_WINDOW_OPEN_MINUTES = 15;
export const MEMO_MAX_FILE_BYTES = 100 * 1024 * 1024;

// The daily window guests can get pinged in - 14:00 to 02:00 (crosses
// midnight), Europe/Lisbon wall-clock. Deliberately the same hours as the
// Rata's reveal schedule (see scheduler.js): the two are the app's only
// unprompted interruptions, and a guest should be able to learn one set of
// hours rather than two. Not admin-configurable for v1; easy to tune here
// if the party's actual hours run differently.
const WINDOW_START_HOUR = 14;
const WINDOW_END_HOUR = 2;

// Minimum spacing enforced between any two of today's 5 slots for the same
// user - well above MEMO_WINDOW_OPEN_MINUTES so two windows can never
// overlap, but kept low enough that slots can still land close together
// sometimes (or far apart other times) rather than falling into an evenly-
// spaced, predictable rhythm - the whole point is not seeing it coming.
export const MEMO_MIN_GAP_MINUTES = 45;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Converts a wall-clock "HH:MM on this calendar day, in this timezone"
// into the equivalent UTC Date - the standard double-format correction
// trick (no timezone library in this project's dependencies). DST
// transitions are a non-issue for a few-day party's random prompts.
export function zonedTimeToUtc(dateStr, hour, minute, tz) {
  const guess = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(guess).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return new Date(guess.getTime() + (guess.getTime() - asUtc));
}

function toDbTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** Generates today's 5 shared random slots (same for every guest), if they don't exist yet. */
export function ensureTodaysSlots() {
  const day = today();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM memo_slots WHERE day = ?').get(day);
  if (existing.n > 0) return;

  const tz = getTimezone();
  const windowStart = zonedTimeToUtc(day, WINDOW_START_HOUR, 0, tz);
  const windowEnd = zonedTimeToUtc(addDays(day, 1), WINDOW_END_HOUR, 0, tz);
  // The window is always "14:00 today to 02:00 tomorrow" on the calendar,
  // but the schedule can end up being generated well after 14:00 (whoever
  // happens to trigger it first that day - e.g. the first guest to open
  // the app after lunch). Anchoring purely to windowStart in that case
  // would place several of the 5 random times in the past already, and
  // they'd all fire at once on the very next scheduler tick instead of
  // being spread through the day. Anchoring to whichever is later (window
  // start, or right now) guarantees every slot is still in the future.
  const effectiveStart = Math.max(windowStart.getTime(), now());

  // The day rolls over at 06:00 (see today() in time.js) but this window
  // shuts at 02:00, so for those four hours today() still names a day whose
  // window has already closed. Generating a schedule then crammed all five
  // slots into the small hours, outside the window they exist to live in -
  // guests pinged at 04:00 for a party that ended two hours ago. Nothing to
  // schedule is the honest answer: the window is shut, and the next call
  // after 06:00 generates the new day properly.
  //
  // In practice this only ever bit a freshly wiped QA opened in the small
  // hours - production always has the afternoon's schedule already - but it
  // is two lines, and the alternative was a note explaining the bug.
  if (effectiveStart >= windowEnd.getTime()) return;

  const gapMs = MEMO_MIN_GAP_MINUTES * 60 * 1000;

  // Five slots at the minimum gap need four gaps' worth of room - three
  // hours. A schedule built with less than that left (a QA wipe at 23:30,
  // or the first guest opening the app very late) cannot fit five without
  // running past 02:00, and it used to: slots landed at 02:53, outside the
  // window, and the test that noticed was loosened three times rather than
  // believed. Fit as many as the remaining window actually holds instead.
  // Fewer moments late in the evening is the honest outcome; the gap is
  // what stops two 15-minute windows overlapping, so compressing it to
  // force five in would break something real to preserve a number.
  const roomMs = windowEnd.getTime() - effectiveStart;
  const slotCount = Math.min(MEMO_SLOTS_PER_DAY, Math.floor(roomMs / gapMs) + 1);
  const slackMs = roomMs - gapMs * (slotCount - 1);

  // n random offsets into the leftover "slack" time, sorted ascending, then
  // spread apart by the fixed minimum gap. Because the offsets are sorted,
  // consecutive slots are always at least gapMs apart (the sorted gap
  // between offsets is >= 0, plus the fixed gapMs) - unlike picking a random
  // point independently within each of 5 fixed-width buckets, which lets
  // two picks land right next to each other across a bucket boundary.
  const offsets = Array.from({ length: slotCount }, () => Math.random() * slackMs).sort((a, b) => a - b);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memo_slots (day, slot_index, scheduled_at)
    VALUES (?, ?, ?)
  `);
  for (let i = 0; i < slotCount; i++) {
    const at = new Date(effectiveStart + offsets[i] + i * gapMs);
    insert.run(day, i, toDbTimestamp(at));
  }
}

/**
 * Slots due to fire right now (scheduled, not yet notified) - polled by the
 * scheduler. Scoped to today deliberately: without the day filter, any slot
 * that never fired stays "due" forever, so a day of downtime (or Memo being
 * switched off and back on) makes every accumulated slot fire at once, in a
 * single burst of notifications. A missed moment is missed - it doesn't get
 * replayed days later.
 */
export function getDueSlots() {
  // "Now" comes from the app's clock rather than SQLite's, so that the one
  // comparison deciding whether a moment has arrived reads the same clock
  // as the code that scheduled it. They agree in production either way;
  // they stop agreeing the moment a test pins one of them, and a test that
  // cannot hold this still is how the 02:00-06:00 bug survived so long.
  return db.prepare(`
    SELECT id, day, slot_index FROM memo_slots
    WHERE notified_at IS NULL
      AND day = ?
      AND scheduled_at <= ?
  `).all(today(), toDbTimestamp(new Date(now())));
}

/**
 * Memo is for the event itself, not the weeks before it. With
 * MEMO_START_DATE set, the whole feature stays shut to guests until that
 * day - the tab is hidden, every guest route 404s, and the scheduler sends
 * nothing. Admins keep full access throughout, so the feature ships to prod
 * fully working and testable rather than sitting behind a flag nobody can
 * exercise until the morning of the party.
 *
 * Unset means "open now", which is what QA wants.
 */
export function memoOpenToEveryone() {
  const start = process.env.MEMO_START_DATE;
  if (!start) return true;
  return today() >= start;
}

/** Whether this user may use Memo at all right now. */
export function memoAvailableTo(user) {
  if (process.env.ENABLE_MEMO !== 'true') return false;
  return memoOpenToEveryone() || !!(user && user.isAdmin);
}

/** The scheduler only broadcasts once Memo is open to everyone - a push sent
 *  while guests still 404 would advertise a tab they can't open. */
export function memoScheduleActive() {
  return process.env.ENABLE_MEMO === 'true' && memoOpenToEveryone();
}

export function markSlotNotified(slotId) {
  db.prepare("UPDATE memo_slots SET notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(slotId);
}

/**
 * Brings today's next un-fired slot forward to right now, so the owner can
 * start a moment on demand instead of waiting for its random time. Returns
 * the slot so the caller can notify for it exactly as the cron would.
 *
 * Picks the earliest still-unfired slot rather than inventing a new one:
 * the day still gets its five moments, one of them just happens sooner.
 * Returns { error } if today's are all used up.
 */
export function triggerNextSlot() {
  ensureTodaysSlots();
  const slot = db.prepare(`
    SELECT id, day, slot_index FROM memo_slots
    WHERE day = ? AND notified_at IS NULL
    ORDER BY scheduled_at
    LIMIT 1
  `).get(today());
  if (!slot) return { error: 'err_memo_no_slots_left' };
  markSlotNotified(slot.id);
  return { ok: true, slotIndex: slot.slot_index };
}

/**
 * The one moment that counts right now: the most recently fired slot of the
 * day. Exactly one moment is ever live, which the 15-minute window alone
 * doesn't guarantee - the owner can trigger the next slot early, and two
 * random times can land within a quarter hour of each other. Either way the
 * older one closes the instant a newer one fires: a moment you were too slow
 * for is gone, not something you can double back to once the next one opens.
 */
function currentSlotId(day) {
  const row = db.prepare(`
    SELECT id FROM memo_slots
    WHERE day = ? AND notified_at IS NOT NULL
    ORDER BY notified_at DESC, slot_index DESC
    LIMIT 1
  `).get(day);
  return row ? row.id : null;
}

/** A slot's derived status for display: waiting / open (+ secondsLeft) / uploaded / missed. */
function deriveStatus(slot, upload, currentId) {
  if (upload) return { status: 'uploaded', uploadId: upload.id, kind: upload.kind };
  if (!slot.notified_at) return { status: 'waiting' };
  if (slot.id !== currentId) return { status: 'missed' };
  const notifiedMs = new Date(`${slot.notified_at.replace(' ', 'T')}Z`).getTime();
  const deadlineMs = notifiedMs + MEMO_WINDOW_OPEN_MINUTES * 60 * 1000;
  const remainingMs = deadlineMs - now();
  if (remainingMs <= 0) return { status: 'missed' };
  return { status: 'open', secondsLeft: Math.round(remainingMs / 1000) };
}

/** Today's 5 shared slots, each with this user's own derived status - the checklist payload. */
export function getTodayForUser(userId) {
  ensureTodaysSlots();
  const day = today();
  const slots = db.prepare('SELECT * FROM memo_slots WHERE day = ? ORDER BY slot_index').all(day);
  const uploads = db.prepare('SELECT * FROM memo_uploads WHERE user_id = ? AND day = ?').all(userId, day);
  const uploadBySlot = new Map(uploads.map((u) => [u.slot_id, u]));
  const currentId = currentSlotId(day);
  return slots.map((s) => ({ id: s.id, slotIndex: s.slot_index, ...deriveStatus(s, uploadBySlot.get(s.id), currentId) }));
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
};

export function extForMime(mime) {
  return EXT_BY_MIME[mime] || extname(mime).slice(0, 10) || '';
}

/** Validates the shared slot is open and this user hasn't already used it, then records the upload. */
export function recordUpload(slotId, userId, { mimeType, filePath, fileSize }) {
  const slot = db.prepare('SELECT * FROM memo_slots WHERE id = ?').get(slotId);
  if (!slot) {
    const err = new Error('err_memo_slot_not_found');
    err.status = 404;
    throw err;
  }
  const derived = deriveStatus(
    slot,
    db.prepare('SELECT * FROM memo_uploads WHERE slot_id = ? AND user_id = ?').get(slotId, userId),
    currentSlotId(slot.day),
  );
  if (derived.status !== 'open') {
    const err = new Error(derived.status === 'uploaded' ? 'err_memo_already_uploaded' : 'err_memo_slot_not_open');
    err.status = 409;
    throw err;
  }
  const kind = mimeType.startsWith('video/') ? 'video' : 'photo';
  const info = db.prepare(`
    INSERT INTO memo_uploads (slot_id, user_id, day, kind, mime_type, file_path, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(slotId, userId, slot.day, kind, mimeType, filePath, fileSize);
  return db.prepare('SELECT * FROM memo_uploads WHERE id = ?').get(info.lastInsertRowid);
}

export function getUpload(uploadId) {
  return db.prepare('SELECT * FROM memo_uploads WHERE id = ?').get(uploadId);
}

// A small fixed set rather than a full picker - keeps the feed a quick tap,
// no emoji keyboard needed, and matches the deliberately light BeReal-style
// reaction weight (a glance, not a comment thread).
export const MEMO_REACTION_EMOJI = ['❤️', '💦', '👎'];

/**
 * The current moment's feed: what everyone else posted for the slot that is
 * live right now, newest first, with reaction counts and this viewer's own
 * reaction on each.
 *
 * Two deliberate limits, both the point of the feature rather than
 * incidental. It is scoped to the current moment, so a new one wipes the
 * slate instead of the day turning into an ever-growing gallery. And it
 * stays sealed until the viewer has posted their own - `locked` says which
 * of the two empties this is, so the UI can promise something is behind it
 * rather than showing a bare "nothing here yet".
 *
 * The viewer's own upload is included, flagged `mine`. It used to be left
 * out on the grounds that the checklist dot above already showed it back,
 * but a dot filling in is not the same as seeing the photo you just took:
 * shoot the first moment of a party and the feed had nothing in it, so the
 * whole card hid itself and capturing appeared to have done nothing at all.
 */
export function getTodayFeed(viewerUserId) {
  const day = today();
  const currentId = currentSlotId(day);
  if (!currentId) return { locked: false, uploads: [] };
  const mine = db.prepare('SELECT id FROM memo_uploads WHERE slot_id = ? AND user_id = ?').get(currentId, viewerUserId);
  if (!mine) return { locked: true, uploads: [] };
  const uploads = db.prepare(`
    SELECT u.*, us.name AS user_name
    FROM memo_uploads u
    JOIN users us ON us.id = u.user_id
    WHERE u.day = ? AND u.slot_id = ?
    ORDER BY u.uploaded_at DESC
  `).all(day, currentId);
  const reactionRows = db.prepare(`
    SELECT r.upload_id, r.emoji, r.user_id, COUNT(*) AS n
    FROM memo_reactions r
    JOIN memo_uploads u ON u.id = r.upload_id
    WHERE u.day = ?
    GROUP BY r.upload_id, r.emoji
  `).all(day);
  const myReactionRows = db.prepare(`
    SELECT r.upload_id, r.emoji
    FROM memo_reactions r
    JOIN memo_uploads u ON u.id = r.upload_id
    WHERE u.day = ? AND r.user_id = ?
  `).all(day, viewerUserId);
  const myReactionByUpload = new Map(myReactionRows.map((r) => [r.upload_id, r.emoji]));
  const countsByUpload = new Map();
  for (const row of reactionRows) {
    if (!countsByUpload.has(row.upload_id)) countsByUpload.set(row.upload_id, {});
    countsByUpload.get(row.upload_id)[row.emoji] = row.n;
  }
  return {
    locked: false,
    uploads: uploads.map((u) => ({
      id: u.id,
      userId: u.user_id,
      userName: u.user_name,
      mine: u.user_id === viewerUserId,
      kind: u.kind,
      flipped: !!u.flipped,
      uploadedAt: u.uploaded_at,
      reactions: countsByUpload.get(u.id) || {},
      myReaction: myReactionByUpload.get(u.id) || null,
    })),
  };
}

/**
 * Mirrors a photo left-to-right, or puts it back. Your own photo only -
 * how somebody looks in their own picture is not a thing anyone else gets a
 * vote on.
 *
 * Stored as a flag, applied as a CSS transform at render time. Nothing
 * rewrites the pixels: re-encoding a 2.5MB JPEG on a shared CPU to flip it
 * is work this machine should not be doing, and it would be lossy every
 * time somebody changed their mind.
 */
export function setUploadFlipped(uploadId, userId, flipped) {
  const row = db.prepare('SELECT user_id FROM memo_uploads WHERE id = ?').get(uploadId);
  if (!row) {
    const err = new Error('err_not_found');
    err.status = 404;
    throw err;
  }
  if (row.user_id !== userId) {
    const err = new Error('err_not_your_photo');
    err.status = 403;
    throw err;
  }
  db.prepare('UPDATE memo_uploads SET flipped = ? WHERE id = ?').run(flipped ? 1 : 0, uploadId);
  return !!flipped;
}

/** Reacting again with the same emoji clears it (toggle); a different one replaces it. */
export function toggleReaction(uploadId, userId, emoji) {
  if (!MEMO_REACTION_EMOJI.includes(emoji)) {
    const err = new Error('err_memo_invalid_reaction');
    err.status = 400;
    throw err;
  }
  const upload = db.prepare('SELECT id FROM memo_uploads WHERE id = ?').get(uploadId);
  if (!upload) {
    const err = new Error('err_memo_slot_not_found');
    err.status = 404;
    throw err;
  }
  const existing = db.prepare('SELECT emoji FROM memo_reactions WHERE upload_id = ? AND user_id = ?').get(uploadId, userId);
  if (existing?.emoji === emoji) {
    db.prepare('DELETE FROM memo_reactions WHERE upload_id = ? AND user_id = ?').run(uploadId, userId);
    return null;
  }
  db.prepare(`
    INSERT INTO memo_reactions (upload_id, user_id, emoji) VALUES (?, ?, ?)
    ON CONFLICT(upload_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
  `).run(uploadId, userId, emoji);
  return emoji;
}

/** Per-day summary for the admin history view. Slots are shared, but uploads
 * are per-guest, so uploadedCount is the total number of files that came in
 * that day (can exceed totalSlots once more than one guest uses a moment). */
export function listDays() {
  return db.prepare(`
    SELECT
      memo_slots.day AS day,
      (SELECT COUNT(*) FROM memo_slots s2 WHERE s2.day = memo_slots.day) AS totalSlots,
      (SELECT COUNT(*) FROM memo_uploads u2 WHERE u2.day = memo_slots.day) AS uploadedCount,
      (SELECT COUNT(*) FROM memo_recaps r WHERE r.day = memo_slots.day) AS hasRecap
    FROM memo_slots
    WHERE memo_slots.notified_at IS NOT NULL
    GROUP BY memo_slots.day
    ORDER BY memo_slots.day DESC
  `).all().map((r) => ({ ...r, hasRecap: !!r.hasRecap }));
}

export function listUploadsForDay(day) {
  return db.prepare(`
    SELECT u.*, us.name AS user_name
    FROM memo_uploads u
    JOIN users us ON us.id = u.user_id
    WHERE u.day = ?
    ORDER BY u.user_id, u.slot_id
  `).all(day);
}

export function saveRecap(day, userId, { mimeType, filePath, fileSize }) {
  db.prepare(`
    INSERT INTO memo_recaps (day, file_path, mime_type, file_size, uploaded_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      file_path = excluded.file_path, mime_type = excluded.mime_type,
      file_size = excluded.file_size, uploaded_by = excluded.uploaded_by,
      uploaded_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
  `).run(day, filePath, mimeType, fileSize, userId);
}

export function getRecap(day) {
  return db.prepare('SELECT * FROM memo_recaps WHERE day = ?').get(day);
}

// Seconds each photo is held on screen in the generated day video.
export const MEMO_RECAP_SECONDS_PER_PHOTO = 1;

// Portrait, and deliberately 720p rather than 1080p: both Fly machines run
// on 256MB, and libx264 encoding 1080x1920 was overrunning that and getting
// OOM-killed mid-encode (confirmed on QA - the process died right after
// "frame= 1"). 720x1280 is plenty for something watched on a phone in the
// Wall feed, and leaves real headroom. Anything that doesn't fit is
// letterboxed rather than cropped, so nobody's moment loses its subject.
const RECAP_WIDTH = 720;
const RECAP_HEIGHT = 1280;

// The video that goes on the Wall is compressed harder than ffmpeg's
// defaults, for the feed's sake more than the disk's.
//
// Measured on 20 deliberately noisy photos - the worst case for a codec,
// far harder to compress than a real photograph:
//   30fps, default crf .... 1561 KB
//   12fps, crf 28 ..........  764 KB
// So a full party day of ~120 photos goes from roughly 9MB to under 5MB,
// and what that buys is a feed that does not stall on somebody's mobile
// data halfway through the night.
//
// 12fps rather than 30 is free: this is a slideshow of stills, so the extra
// 18 frames a second were duplicates of a photo that is not moving. crf 28
// is a real (small) quality cost and where the line was drawn - 540p at crf
// 30 was another 2.3x smaller and visibly soft, which is the wrong trade for
// something people keep.
//
// The zip download is untouched and still hands over the original files.
// Compression here is about the thing that gets watched in a feed, not
// about what anybody takes home.
const RECAP_FPS = 12;
const RECAP_CRF = 28;

/**
 * Stitches every photo uploaded on `day` into a single mp4, one second per
 * photo, in the order they were taken. Videos in that day are skipped -
 * mixing arbitrary user-shot clips (each with its own resolution, rotation
 * and frame rate, some with audio) into a concat stream needs a full
 * re-encode pass per clip and is a different feature; the photo slideshow
 * is what "video of the day" means here.
 *
 * Returns { error } instead of throwing for the expected empty-day case, so
 * the route can surface it as a normal message.
 */
/** Whether a day has any photo to stitch. Cheap enough to ask before
 * answering "started" to a request that would otherwise fail a moment
 * later with nobody listening. */
/** How many photos a day has. Reported back when a video finishes so the
 * admin is told what went into it, not just that something did. */
export function countDayPhotos(day) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM memo_uploads WHERE day = ? AND kind = 'photo'"
  ).get(day).n;
}

export function dayHasPhotos(day) {
  return !!db.prepare(
    "SELECT 1 FROM memo_uploads WHERE day = ? AND kind = 'photo' LIMIT 1"
  ).get(day);
}

export async function buildDayRecapVideo(day) {
  const photos = db.prepare(
    "SELECT file_path FROM memo_uploads WHERE day = ? AND kind = 'photo' ORDER BY uploaded_at"
  ).all(day);
  if (photos.length === 0) return { error: 'err_memo_no_photos' };

  const outName = `recap-${day}-${Date.now()}.mp4`;
  const outPath = join(MEMO_DIR, outName);
  // ffmpeg's concat demuxer reads durations from a manifest. Its parser
  // treats a single quote as the path delimiter, so the only escaping that
  // matters is a quote inside a filename - ours are all generated names,
  // but this stays honest about it rather than assuming.
  const listPath = join(MEMO_DIR, `.recap-${day}-${Date.now()}.txt`);
  const q = (p) => `'${join(MEMO_DIR, p).replace(/'/g, "'\\''")}'`;
  const lines = photos.map((p) => `file ${q(p.file_path)}\nduration ${MEMO_RECAP_SECONDS_PER_PHOTO}`);
  // The concat demuxer ignores the final entry's duration, so the last
  // photo is repeated - without this it flashes by in a single frame.
  lines.push(`file ${q(photos[photos.length - 1].file_path)}`);
  writeFileSync(listPath, `${lines.join('\n')}\n`);

  try {
    await runFfmpeg([
      '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', [
        `scale=${RECAP_WIDTH}:${RECAP_HEIGHT}:force_original_aspect_ratio=decrease`,
        `pad=${RECAP_WIDTH}:${RECAP_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'format=yuv420p',
      ].join(','),
      '-r', String(RECAP_FPS),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(RECAP_CRF),
      // Single-threaded with a short lookahead and no B-frames: libx264's
      // memory scales with threads and lookahead depth, and on a 256MB box
      // the defaults are what tipped it over. Slower, but a day's photos is
      // a few seconds of video either way.
      '-threads', '1',
      '-x264-params', 'rc-lookahead=10:ref=1:bframes=0:sliced-threads=0',
      // Baseline-friendly output so it plays inline in iOS Safari.
      '-profile:v', 'high', '-level', '4.0',
      '-movflags', '+faststart',
      outPath,
    ]);
  } finally {
    try { unlinkSync(listPath); } catch { /* best effort */ }
  }

  return { filePath: outName, mimeType: 'video/mp4', fileSize: statSync(outPath).size, photoCount: photos.length };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (e) => reject(
      e.code === 'ENOENT' ? new Error('err_memo_ffmpeg_missing') : e
    ));
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve();
      // ffmpeg is verbose even on success, and its own banner is the least
      // useful part - pull out the lines that actually say what went wrong.
      // The signal matters too: a SIGKILL here means the kernel OOM-killer
      // took it, which looks nothing like a normal ffmpeg error in the log.
      const lines = stderr.split('\n').filter(Boolean);
      const blame = lines.filter((l) => /error|invalid|unable|no such|denied|killed/i.test(l));
      console.error(
        `[memo] ffmpeg exited code=${code} signal=${signal || 'none'}`,
        (blame.length ? blame : lines.slice(-4)).join(' | ')
      );
      reject(new Error(signal === 'SIGKILL' ? 'err_memo_recap_oom' : 'err_memo_recap_failed'));
    });
  });
}

export function listRecapDays() {
  return db.prepare('SELECT day FROM memo_recaps ORDER BY day DESC').all().map((r) => r.day);
}

/** Owner-only kill switch: clears every memo table AND the actual files on
 * disk - unlike the DB-BLOB-based wipes elsewhere, deleting the rows alone
 * would leave every uploaded photo/video sitting on the volume forever. */
export function wipeAll() {
  const paths = [
    ...db.prepare('SELECT file_path FROM memo_uploads').all().map((r) => r.file_path),
    ...db.prepare('SELECT file_path FROM memo_recaps').all().map((r) => r.file_path),
  ];
  db.exec('DELETE FROM memo_uploads; DELETE FROM memo_recaps; DELETE FROM memo_slots;');
  for (const relPath of paths) {
    const abs = join(MEMO_DIR, relPath);
    if (existsSync(abs)) unlinkSync(abs);
  }
}
