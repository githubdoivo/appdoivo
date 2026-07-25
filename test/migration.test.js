// Regression test: booting the app against a database that predates a
// schema migration must not crash. Specifically covers the "updated_at"
// column - SQLite forbids a non-constant DEFAULT on ALTER TABLE ADD COLUMN
// (only CREATE TABLE allows one), which broke this exact migration once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `appdoivo-migration-test-${process.pid}-${Date.now()}.sqlite`);

test('booting against a pre-updated_at database migrates cleanly instead of crashing', async () => {
  // Build a legacy users table, as it looked before updated_at existed.
  const legacy = new DatabaseSync(DB);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_enc TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_owner INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacy.prepare(
    'INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner) VALUES (?, ?, ?, 1, 1)'
  ).run('LegacyOwner', 'legacy-hash', 'legacy-enc');
  legacy.close();

  process.env.DB_FILE = DB;
  process.env.ADMIN_TOKEN = 'irrelevant-legacy-boot-only';

  // Importing db.js runs every migration as a top-level side effect - if
  // the ALTER TABLE bug regresses, this import itself throws.
  const { default: db } = await import('../src/db.js');

  const row = db.prepare('SELECT updated_at, created_at FROM users WHERE name = ?').get('LegacyOwner');
  assert.ok(row.updated_at, 'updated_at was not backfilled');
  assert.equal(row.updated_at, row.created_at, 'updated_at should default to created_at for pre-existing rows');
});

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(DB + ext); } catch { /* ignore */ }
  }
});
