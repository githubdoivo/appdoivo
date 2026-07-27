import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIGHTS } from './nights.js';
import { hashToken, encryptToken, decryptToken } from './tokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database path (configurable for tests via DB_FILE).
const DB_FILE = process.env.DB_FILE || join(__dirname, '..', 'data', 'app.sqlite');
if (DB_FILE !== ':memory:') mkdirSync(dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_enc  TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    tutorial_seen INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'pt',
    wall_pseudonym TEXT
  );

  CREATE TABLE IF NOT EXISTS consequences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    day        TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    revealed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- A user can only suggest one consequence per day
  CREATE UNIQUE INDEX IF NOT EXISTS idx_consequence_user_day
    ON consequences(user_id, day);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Ephemeral open chat ("the Wall"): only the 20 most recent messages are
  -- ever kept (see src/chat.js). user_id is kept for internal reference
  -- only - the API never exposes the real author, just a random
  -- pseudonym assigned per message (the "pseudonym" column).
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    pseudonym  TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );
`);

/** Checks whether a column exists in a table. */
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// Migration: plain-text tokens -> encrypted/indexed.
// Older databases stored the 'token' column in plain text. We now store
// 'token_hash' (login index) and 'token_enc' (encrypted, so the admin can see
// the key). The table is rebuilt to drop the plain-text column.
if (columnExists('users', 'token') && !columnExists('users', 'token_hash')) {
  const rows = db.prepare('SELECT id, name, token, is_admin, created_at FROM users').all();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  db.exec(`
    CREATE TABLE users_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_enc  TEXT NOT NULL,
      is_admin   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ins = db.prepare(
    'INSERT INTO users_new (id, name, token_hash, token_enc, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    ins.run(r.id, r.name, hashToken(r.token), encryptToken(r.token), r.is_admin, r.created_at);
  }
  db.exec('DROP TABLE users');
  db.exec('ALTER TABLE users_new RENAME TO users');
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON');
}

// Migration: mark the master admin (owner). Never demotable, unlike admins
// promoted later via the admin panel. For databases seeded before this
// column existed, backfill it onto whichever admin was created first.
if (!columnExists('users', 'is_owner')) {
  db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0');
  const firstAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1').get();
  if (firstAdmin) {
    db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(firstAdmin.id);
  }
}

// Migration: track when a user's role last changed, so Manage Users can
// surface recently created/promoted users above the rest.
// SQLite forbids a non-constant DEFAULT on ALTER TABLE ADD COLUMN (only
// CREATE TABLE allows one), so this adds it with a constant placeholder
// and backfills real values immediately after. Every INSERT elsewhere sets
// updated_at explicitly, so the column's post-migration default is never
// relied on for new rows.
if (!columnExists('users', 'updated_at')) {
  db.exec("ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
  db.exec('UPDATE users SET updated_at = created_at');
}

// Migration: whether a user has been shown the first-session onboarding
// tutorial yet. 0 is a constant, so a plain ALTER TABLE is fine here.
if (!columnExists('users', 'tutorial_seen')) {
  db.exec('ALTER TABLE users ADD COLUMN tutorial_seen INTEGER NOT NULL DEFAULT 0');
}

// Migration: last language a user selected in the app, so push notifications
// can be sent in their own language instead of a fixed default.
if (!columnExists('users', 'lang')) {
  db.exec("ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'pt'");
}

// Migration: the Wall's per-message pseudonym, replacing the real author
// (mirrors users.wall_pseudonym at post time). Existing (soon-to-be-pruned
// anyway, since the Wall only ever keeps 20 messages) rows just get an
// empty one until they age out.
if (!columnExists('messages', 'pseudonym')) {
  db.exec("ALTER TABLE messages ADD COLUMN pseudonym TEXT NOT NULL DEFAULT ''");
}

// Migration: a stable per-user Wall pseudonym (assigned lazily on first
// post - see getOrAssignPseudonym() in chat.js), replacing what used to
// be a fresh random one on every single message. Nullable: most users
// never post, so there's nothing to assign until they do.
if (!columnExists('users', 'wall_pseudonym')) {
  db.exec('ALTER TABLE users ADD COLUMN wall_pseudonym TEXT');
}

// Migration: per-day voting -> per-night voting.
// Older databases had contestants/votes with a 'day' column. Voting is now per
// night (furnished/swamp), so the old tables are dropped (voting data is
// ephemeral per edition). The new tables are created right after with the
// per-night schema.
if (columnExists('contestants', 'day') && !columnExists('contestants', 'night')) {
  db.exec(`
    DROP TABLE IF EXISTS votes;
    DROP TABLE IF EXISTS contestants;
  `);
}

// Per-night voting tables (created after the migration).
db.exec(`
  -- Contestants per night (Best Look). 'night' identifies the night/theme.
  CREATE TABLE IF NOT EXISTS contestants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    night      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Votes per night. A user votes once per night.
  CREATE TABLE IF NOT EXISTS votes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
    night         TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vote_user_night
    ON votes(user_id, night);
`);

// Migration: self-registered contestants (Best Look). A contestant can
// optionally be linked to the user(s) who entered themselves - solo
// (user_id only) or as a duo (user_id + partner_user_id), so the app can
// stop someone entering twice and can merge a duo's voting rights into one
// shared vote per night (see registerContestant()/castVote() in votes.js).
// Admin-added contestants (the original flow) leave both columns NULL.
if (!columnExists('contestants', 'user_id')) {
  db.exec('ALTER TABLE contestants ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
if (!columnExists('contestants', 'partner_user_id')) {
  db.exec('ALTER TABLE contestants ADD COLUMN partner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contestant_user_night
    ON contestants(user_id, night) WHERE user_id IS NOT NULL;
`);

/** Generates a secure, readable token. */
export function generateToken() {
  return randomBytes(24).toString('base64url');
}

/** Strips a name down to the plain-ASCII, lowercase base used by every token. */
function tokenBase(name) {
  return String(name)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'user';
}

/**
 * Generates a memorable per-user token: their name plus a random 4-digit
 * suffix (e.g. "rito8749"), easier to type/remember than an opaque string.
 * Retries on the rare collision (checked via the token's lookup hash).
 */
export function generateUserToken(name) {
  const base = tokenBase(name);

  let token;
  do {
    const digits = String(randomInt(0, 10000)).padStart(4, '0');
    token = `${base}${digits}`;
  } while (db.prepare('SELECT 1 FROM users WHERE token_hash = ?').get(hashToken(token)));

  return token;
}

/**
 * Deterministic variant for QA's demo-seed template (see seedDemo.js): the
 * same name always produces the same token across every reseed, since QA's
 * database resets on every deploy. Without this, a tester's access key
 * would change on every single deploy, forcing a re-send every time -
 * whereas prod's real users don't need this, their DB persists.
 */
export function generateDemoUserToken(name) {
  const base = tokenBase(name);
  let hash = 0;
  for (const ch of base) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const digits = String(hash % 10000).padStart(4, '0');
  return `${base}${digits}`;
}

/** Reads a setting with a default value. */
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

/** Writes/updates a setting. */
export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

/** Seeds settings and the admin user on first start. */
export function seed({ adminToken, adminName, timezone }) {
  // Per-night voting status (closed by default).
  for (const night of NIGHTS) {
    if (getSetting(`voting_status_${night}`) === null) {
      setSetting(`voting_status_${night}`, 'closed');
    }
  }
  if (getSetting('day_rollover_hour') === null) setSetting('day_rollover_hour', 6);
  if (getSetting('timezone') === null) setSetting('timezone', timezone || 'Europe/Lisbon');

  let admin = db.prepare('SELECT * FROM users WHERE is_admin = 1').get();
  if (!admin) {
    const token = adminToken || generateToken();
    const info = db.prepare(
      "INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner, updated_at) VALUES (?, ?, ?, 1, 1, strftime('%Y-%m-%d %H:%M:%f', 'now'))"
    ).run(adminName || 'Admin', hashToken(token), encryptToken(token));
    admin = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    return { admin, created: true, token };
  }
  try {
    return { admin, created: false, token: decryptToken(admin.token_enc) };
  } catch {
    throw new Error(
      'TOKEN_SECRET does not match the one used to create the existing admin user, so their ' +
      'token cannot be read. Either restore the previous TOKEN_SECRET, or delete the admin row ' +
      "(DELETE FROM users WHERE is_admin = 1) so a new admin is seeded with the current ADMIN_TOKEN."
    );
  }
}

export default db;
