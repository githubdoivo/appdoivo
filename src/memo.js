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

/** Generates this user's 5 random slots for today, if they don't exist yet. */
export function ensureTodaysSlots(userId) {
  const day = today();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM memo_slots WHERE user_id = ? AND day = ?').get(userId, day);
  if (existing.n > 0) return;

  const tz = getTimezone();
  const windowStart = zonedTimeToUtc(day, WINDOW_START_HOUR, 0, tz);
  const windowEnd = zonedTimeToUtc(addDays(day, 1), WINDOW_END_HOUR, 0, tz);
  const gapMs = MEMO_MIN_GAP_MINUTES * 60 * 1000;
  const slackMs = (windowEnd.getTime() - windowStart.getTime()) - gapMs * (MEMO_SLOTS_PER_DAY - 1);

  // n random offsets into the leftover "slack" time, sorted ascending, then
  // spread apart by the fixed minimum gap. Because the offsets are sorted,
  // consecutive slots are always at least gapMs apart (the sorted gap
  // between offsets is >= 0, plus the fixed gapMs) - unlike picking a random
  // point independently within each of 5 fixed-width buckets, which lets
  // two picks land right next to each other across a bucket boundary.
  const offsets = Array.from({ length: MEMO_SLOTS_PER_DAY }, () => Math.random() * slackMs).sort((a, b) => a - b);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memo_slots (user_id, day, slot_index, scheduled_at)
    VALUES (?, ?, ?, ?)
  `);
  for (let i = 0; i < MEMO_SLOTS_PER_DAY; i++) {
    const at = new Date(windowStart.getTime() + offsets[i] + i * gapMs);
    insert.run(userId, day, i, toDbTimestamp(at));
  }
}

/** Slots due to fire right now (scheduled, not yet notified) - polled by the scheduler. */
export function getDueSlots() {
  return db.prepare(`
    SELECT id, user_id, day, slot_index FROM memo_slots
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

/** Today's 5 slots for a user, each with its derived status - the checklist payload. */
export function getTodayForUser(userId) {
  ensureTodaysSlots(userId);
  const day = today();
  const slots = db.prepare('SELECT * FROM memo_slots WHERE user_id = ? AND day = ? ORDER BY slot_index').all(userId, day);
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

/** Validates ownership/window/kind and records an already-saved-to-disk upload. */
export function recordUpload(slotId, userId, { mimeType, filePath, fileSize }) {
  const slot = db.prepare('SELECT * FROM memo_slots WHERE id = ?').get(slotId);
  if (!slot || slot.user_id !== userId) {
    const err = new Error('err_memo_not_your_slot');
    err.status = 403;
    throw err;
  }
  const derived = deriveStatus(slot, db.prepare('SELECT * FROM memo_uploads WHERE slot_id = ?').get(slotId));
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

/** Per-day summary for the admin history view. */
export function listDays() {
  return db.prepare(`
    SELECT
      memo_slots.day AS day,
      COUNT(*) AS totalSlots,
      SUM(CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END) AS uploadedCount,
      (SELECT COUNT(*) FROM memo_recaps r WHERE r.day = memo_slots.day) AS hasRecap
    FROM memo_slots
    LEFT JOIN memo_uploads u ON u.slot_id = memo_slots.id
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
