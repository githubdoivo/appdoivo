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
