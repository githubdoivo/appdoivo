import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import db from './db.js';
import { today, getTimezone } from './time.js';

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

// The daily window guests can get pinged in - 11:00 to 01:00 (crosses
// midnight), Europe/Lisbon wall-clock. Not admin-configurable for v1;
// easy to tune here if the party's actual hours run differently.
const WINDOW_START_HOUR = 11;
const WINDOW_END_HOUR = 1;

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
function zonedTimeToUtc(dateStr, hour, minute, tz) {
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
  // The window is always "11:00 today to 01:00 tomorrow" on the calendar,
  // but the schedule can end up being generated well after 11:00 (whoever
  // happens to trigger it first that day - e.g. the first guest to open
  // the app after lunch). Anchoring purely to windowStart in that case
  // would place several of the 5 random times in the past already, and
  // they'd all fire at once on the very next scheduler tick instead of
  // being spread through the day. Anchoring to whichever is later (window
  // start, or right now) guarantees every slot is still in the future.
  const effectiveStart = Math.max(windowStart.getTime(), Date.now());
  const gapMs = MEMO_MIN_GAP_MINUTES * 60 * 1000;
  const slackMs = Math.max(0, (windowEnd.getTime() - effectiveStart) - gapMs * (MEMO_SLOTS_PER_DAY - 1));

  // n random offsets into the leftover "slack" time, sorted ascending, then
  // spread apart by the fixed minimum gap. Because the offsets are sorted,
  // consecutive slots are always at least gapMs apart (the sorted gap
  // between offsets is >= 0, plus the fixed gapMs) - unlike picking a random
  // point independently within each of 5 fixed-width buckets, which lets
  // two picks land right next to each other across a bucket boundary.
  const offsets = Array.from({ length: MEMO_SLOTS_PER_DAY }, () => Math.random() * slackMs).sort((a, b) => a - b);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memo_slots (day, slot_index, scheduled_at)
    VALUES (?, ?, ?)
  `);
  for (let i = 0; i < MEMO_SLOTS_PER_DAY; i++) {
    const at = new Date(effectiveStart + offsets[i] + i * gapMs);
    insert.run(day, i, toDbTimestamp(at));
  }
}

/** Slots due to fire right now (scheduled, not yet notified) - polled by the scheduler. */
export function getDueSlots() {
  return db.prepare(`
    SELECT id, day, slot_index FROM memo_slots
    WHERE notified_at IS NULL AND scheduled_at <= strftime('%Y-%m-%d %H:%M:%f', 'now')
  `).all();
}

export function markSlotNotified(slotId) {
  db.prepare("UPDATE memo_slots SET notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(slotId);
}

/** A slot's derived status for display: waiting / open (+ secondsLeft) / uploaded / missed. */
function deriveStatus(slot, upload) {
  if (upload) return { status: 'uploaded', uploadId: upload.id, kind: upload.kind };
  if (!slot.notified_at) return { status: 'waiting' };
  const notifiedMs = new Date(`${slot.notified_at.replace(' ', 'T')}Z`).getTime();
  const deadlineMs = notifiedMs + MEMO_WINDOW_OPEN_MINUTES * 60 * 1000;
  const remainingMs = deadlineMs - Date.now();
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
  return slots.map((s) => ({ id: s.id, slotIndex: s.slot_index, ...deriveStatus(s, uploadBySlot.get(s.id)) }));
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
  const derived = deriveStatus(slot, db.prepare('SELECT * FROM memo_uploads WHERE slot_id = ? AND user_id = ?').get(slotId, userId));
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
export const MEMO_REACTION_EMOJI = ['❤️', '👎', '💧', '🍆'];

/** Today's feed: every guest's uploads, newest first, with reaction counts
 * and this viewer's own reaction (if any) on each. */
export function getTodayFeed(viewerUserId) {
  const day = today();
  const uploads = db.prepare(`
    SELECT u.*, us.name AS user_name
    FROM memo_uploads u
    JOIN users us ON us.id = u.user_id
    WHERE u.day = ?
    ORDER BY u.uploaded_at DESC
  `).all(day);
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
  return uploads.map((u) => ({
    id: u.id,
    userId: u.user_id,
    userName: u.user_name,
    kind: u.kind,
    uploadedAt: u.uploaded_at,
    reactions: countsByUpload.get(u.id) || {},
    myReaction: myReactionByUpload.get(u.id) || null,
  }));
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
