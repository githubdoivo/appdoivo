// Regression test: QA has no persistent volume, so its database resets on
// every deploy - seedDemo() runs against a brand-new, empty DB each time.
// If demo user tokens were random (as generateUserToken is, by design, for
// real admin-created users), every tester's access key would change on
// every single deploy. generateDemoUserToken must be a pure, deterministic
// function of the name instead, so the same name always gets the same key
// across separate "deploys" - this exercises exactly that property, without
// needing to actually boot two separate databases to prove it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_FILE = join(tmpdir(), `appdoivo-demoseed-test-${process.pid}-${Date.now()}.sqlite`);
process.env.TOKEN_SECRET = 'irrelevant-for-this-test';
const { generateDemoUserToken } = await import('../src/db.js');

test('generateDemoUserToken is deterministic: same name -> same token, every time', () => {
  const a = generateDemoUserToken('Simão Valente');
  const b = generateDemoUserToken('Simão Valente');
  assert.equal(a, b);
  assert.match(a, /^simaovalente\d{4}$/);
});

test('generateDemoUserToken differs across different names', () => {
  const a = generateDemoUserToken('Alice Wonderland');
  const b = generateDemoUserToken('Bob Builder');
  assert.notEqual(a, b);
});

test('seedDemo registers 5 contestants per night, from the demo user template', async () => {
  const { seedDemo } = await import('../src/seedDemo.js');
  const { default: db } = await import('../src/db.js');
  const { NIGHTS } = await import('../src/nights.js');

  seedDemo();

  for (const night of NIGHTS) {
    const rows = db.prepare('SELECT name, confirmed_at FROM contestants WHERE night = ?').all(night);
    assert.equal(rows.length, 5, `expected 5 contestants for ${night}, got ${rows.length}`);
    // Solo demo entries have nobody to confirm with - unconfirmed would hide
    // them from the voting list and block opening voting on QA entirely.
    for (const row of rows) {
      assert.ok(row.confirmed_at, `seeded contestant ${row.name} should be pre-confirmed`);
    }
  }

  // Calling it again (simulating another boot with the same DB) must not
  // duplicate contestants - it's idempotent, same as the users/consequences seeding.
  seedDemo();
  const total = db.prepare('SELECT COUNT(*) AS n FROM contestants').get().n;
  assert.equal(total, 5 * NIGHTS.length, 'contestants should not be duplicated on a second seedDemo() call');
});
