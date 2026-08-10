import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import yauzl from 'yauzl';

// Isolated test environment: temporary DB. The admin's real key is always
// generated (see seed() in db.js - no more ADMIN_TOKEN pinning it, even
// outside production), so ADMIN below reads the actual generated value
// off seedResult rather than assuming a fixed string.
const DB = join(tmpdir(), `appdoivo-test-${process.pid}-${Date.now()}.sqlite`);
// Memo's slots are a shared/global schedule now, not per-user - whichever
// test in this file happens to be the first to call /memo/today is the one
// that actually triggers generation, not necessarily the "5 daily slots"
// test itself. Anchoring the no-past-scheduling check to this run's start
// (not a timestamp captured locally inside that one test) is what the
// invariant actually means regardless of test order.
const TEST_RUN_STARTED_AT = Date.now();
process.env.DB_FILE = DB;
process.env.ADMIN_NAME = 'Test Admin';
process.env.ENABLE_ADMIN_PROMOTION = 'true';
process.env.ENABLE_PLAZA = 'true';
process.env.ENABLE_MEMO = 'true';

const { default: app, seedResult } = await import('../src/app.js');
const { default: db } = await import('../src/db.js');
const { MEMO_DIR, MEMO_MIN_GAP_MINUTES } = await import('../src/memo.js');
const { today } = await import('../src/time.js');

const ADMIN = seedResult.token;
let server;
let base;
let userToken;
let userId;
let contestantId;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server?.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(DB + ext); } catch { /* ignore */ }
  }
  // MEMO_DIR sits next to DB_FILE (see memo.js) - same temp-file lifecycle,
  // cleaned up the same way.
  try { rmSync(MEMO_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body, or non-JSON (e.g. a served photo) */ }
  return { status: res.status, data, headers: res.headers };
}

/** Raw (non-JSON) request, for the zip download route - returns the body
 * as a Buffer rather than trying (and failing) to parse it as JSON. */
async function apiBuffer(path, { token } = {}) {
  const res = await fetch(base + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buffer };
}

/** Multipart/form-data upload (Memo) - the outfit-photo tests above all go
 * through base64-in-JSON instead, but that's a 2mb request-body cap (see
 * express.json() in app.js), nowhere near enough for Memo's original-size
 * uploads, so this is a real multipart request instead. */
async function apiUpload(path, { token, buffer, filename, mimeType, method = 'POST' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(base + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, headers: res.headers };
}

/** Unpacks every entry in a zip buffer to { filename, contents } pairs. */
function readZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) return reject(err);
          const chunks = [];
          readStream.on('data', (c) => chunks.push(c));
          readStream.on('end', () => {
            entries.push({ filename: entry.fileName, contents: Buffer.concat(chunks) });
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

/* -------------------------------- Version --------------------------------- */

test('GET /version is public and reports env: null when APP_ENV is unset (prod default)', async () => {
  const r = await api('GET', '/version');
  assert.equal(r.status, 200);
  assert.ok(r.data.version);
  assert.equal(r.data.env, null);
});

/* ------------------------------- security.txt ------------------------------ */
// RFC 9116's canonical /.well-known/security.txt is a static file (see
// public/.well-known/security.txt), served automatically by express.static
// - nothing to test there. This covers the legacy bare-path redirect only.

test('GET /security.txt redirects to the canonical .well-known location', async () => {
  const appRoot = base.replace(/\/api$/, '');
  const res = await fetch(`${appRoot}/security.txt`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/.well-known/security.txt');
});

/* --------------------------------- Auth ---------------------------------- */

test('login rejects an invalid token', async () => {
  const r = await api('POST', '/auth/login', { body: { token: 'nao-existe' } });
  assert.equal(r.status, 401);
});

test('login accepts the admin', async () => {
  const r = await api('POST', '/auth/login', { body: { token: ADMIN } });
  assert.equal(r.status, 200);
  assert.equal(r.data.isAdmin, true);
});

// Regression: there used to be a "mossy" magic token that resolved to the
// owner account. It was originally gated by NODE_ENV!=='production' alone
// and was confirmed live on prod on 2026-08-08 despite fly.toml setting
// NODE_ENV=production, letting anyone who read this repo's own docs log in
// with full owner rights. It was then re-gated behind ENABLE_DEV_LOGIN and
// has now been removed outright. This test locks that removal in: no env
// var, in any environment, may bring it back.
test('there is no magic dev token - "mossy" is rejected like any other wrong key, whatever the environment says', async () => {
  const plain = await api('POST', '/auth/login', { body: { token: 'mossy' } });
  assert.equal(plain.status, 401);

  // Even with the old escape hatch explicitly switched on.
  process.env.ENABLE_DEV_LOGIN = 'true';
  try {
    const withOldFlag = await api('POST', '/auth/login', { body: { token: 'mossy' } });
    assert.equal(withOldFlag.status, 401, 'the removed dev-login flag must have no effect at all');
  } finally {
    delete process.env.ENABLE_DEV_LOGIN;
  }
});

/* ----------------------------- Permissions ------------------------------- */

test('admin creates a user', async () => {
  const r = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Ivo' } });
  assert.equal(r.status, 201);
  assert.ok(r.data.token);
  userToken = r.data.token;
  userId = r.data.id;
});

/* --------------------- First-time key retrieval (register) --------------- */

test('a brand-new user is searchable by name until they claim their key', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zélia Cunha' } });

  const tooShort = await api('GET', '/auth/unclaimed-users?name=ze');
  assert.equal(tooShort.data.users.length, 0, 'below 3 characters should return nothing');

  const accentless = await api('GET', '/auth/unclaimed-users?name=zelia');
  assert.ok(accentless.data.users.some((u) => u.id === created.data.id), 'plain-ASCII "zelia" should match "Zélia"');

  const claim = await api('POST', '/auth/claim-key', { body: { userId: created.data.id } });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.token, created.data.token);

  const again = await api('POST', '/auth/claim-key', { body: { userId: created.data.id } });
  assert.equal(again.status, 400, 'a key can only ever be claimed once');

  const afterClaim = await api('GET', '/auth/unclaimed-users?name=zelia');
  assert.ok(!afterClaim.data.users.some((u) => u.id === created.data.id), 'claimed users disappear from search');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test('logging in for real also closes the first-time key retrieval, even without using it', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Rogério Vale' } });

  const before = await api('GET', '/auth/unclaimed-users?name=rogerio');
  assert.ok(before.data.users.some((u) => u.id === created.data.id));

  // A real authenticated request (not the claim flow) with their actual key.
  await api('GET', '/me', { token: created.data.token });

  const after = await api('GET', '/auth/unclaimed-users?name=rogerio');
  assert.ok(!after.data.users.some((u) => u.id === created.data.id), 'a real login should close this even if the claim endpoint was never used');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

// The owner used to be excluded from this flow on purpose (pre-claimed at
// seed time). That was reversed by request so the owner can retrieve their
// own key the same way a guest does - see the security note on
// searchUnclaimedUsers(). Exercised against keyClaim.js directly rather
// than over HTTP: claiming shares the per-IP auth-attempt budget with
// /auth/login (see rateLimit.js), and spending two of it here tipped a
// later test expecting a plain 401 into a 429. The HTTP wiring itself is
// already covered by the brand-new-user test above.
test('the owner is searchable in the first-time key flow like anyone else, and claiming is still one-shot', async () => {
  const { default: db } = await import('../src/db.js');
  const { searchUnclaimedUsers, claimKey } = await import('../src/keyClaim.js');
  const owner = db.prepare('SELECT id, name FROM users WHERE is_owner = 1').get();
  // Already claimed by now (every earlier test authenticates as ADMIN, and
  // authenticate() stamps key_claimed_at on first use) - clear it to get a
  // freshly-seeded owner back.
  db.prepare('UPDATE users SET key_claimed_at = NULL WHERE id = ?').run(owner.id);

  try {
    assert.ok(
      searchUnclaimedUsers('test').some((u) => u.id === owner.id),
      'the owner must not be filtered out of the search'
    );

    const claimed = claimKey(owner.id);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.name, owner.name);
    assert.ok(claimed.token, 'the flow hands back the real key');

    assert.equal(claimKey(owner.id).error, 'err_key_already_claimed', 'claiming closes permanently, owner included');
    assert.ok(!searchUnclaimedUsers('test').some((u) => u.id === owner.id), 'and they drop out of the search');
  } finally {
    db.prepare("UPDATE users SET key_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(owner.id);
  }
});

test('a normal user cannot access the admin panel', async () => {
  const r = await api('GET', '/admin/users', { token: userToken });
  assert.equal(r.status, 403);
});

// The server always returns a stable alphabetical order (owner pinned
// first) - that's what "importing from DB" should look like. Floating a
// just-created/just-changed user to the top is a session-local nicety the
// frontend layers on top (see recentUserIds/withRecentFirst() in
// settings.js) rather than a permanent server-side sort, so it isn't
// exercised here - it needs a real page, not just the API.
test('Manage Users list: owner pinned first, then alphabetical by name', async () => {
  const zebra = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zzz Zebra' } });
  const apple = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Aaa Apple' } });

  const list = await api('GET', '/admin/users', { token: ADMIN });
  assert.equal(list.data[0].is_owner, true, 'owner must be first');
  const nonOwnerNames = list.data.filter((u) => !u.is_owner).map((u) => u.name);
  const alphabetical = [...nonOwnerNames].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(nonOwnerNames, alphabetical, 'everyone but the owner should be in alphabetical order');

  await api('DELETE', `/admin/users/${zebra.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${apple.data.id}`, { token: ADMIN });
});

test('promoting a user grants admin access, but not owner-only Manage Users access', async () => {
  const promote = await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  assert.equal(promote.status, 200);
  assert.equal(promote.data.is_admin, true);

  // General admin access: works.
  const votes = await api('GET', '/admin/votes', { token: userToken });
  assert.equal(votes.status, 200);

  // Golden rule: only the owner sees other users' access keys - a
  // non-owner admin can load the list, but only ever gets their own row.
  const users = await api('GET', '/admin/users', { token: userToken });
  assert.equal(users.status, 200);
  assert.equal(users.data.length, 1);
  assert.equal(users.data[0].id, userId);
});

test('demoting revokes admin access', async () => {
  const demote = await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  assert.equal(demote.status, 200);

  const check = await api('GET', '/admin/users', { token: userToken });
  assert.equal(check.status, 403);
});

test('cannot demote the last remaining admin', async () => {
  const me = await api('GET', '/me', { token: ADMIN });
  const demote = await api('PATCH', `/admin/users/${me.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  assert.equal(demote.status, 400);
});

test('the owner cannot be demoted even when other admins exist', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const me = await api('GET', '/me', { token: ADMIN });
  const demote = await api('PATCH', `/admin/users/${me.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  assert.equal(demote.status, 400);

  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('a promoted admin (not the owner) can still be removed', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'promotable' } });
  await api('PATCH', `/admin/users/${created.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const del = await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
  assert.equal(del.status, 200);

  const users = await api('GET', '/admin/users', { token: ADMIN });
  assert.ok(!users.data.some((u) => u.id === created.data.id), 'promoted admin should have been removed');
});

test('the owner can never be removed', async () => {
  const me = await api('GET', '/me', { token: ADMIN });
  const del = await api('DELETE', `/admin/users/${me.data.id}`, { token: ADMIN });
  assert.equal(del.status, 400);
});

test('a user can be renamed', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Typo Nmae' } });
  const rename = await api('PATCH', `/admin/users/${created.data.id}/name`, { token: ADMIN, body: { name: 'Fixed Name' } });
  assert.equal(rename.status, 200);

  const users = await api('GET', '/admin/users', { token: ADMIN });
  const found = users.data.find((u) => u.id === created.data.id);
  assert.equal(found.name, 'Fixed Name');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test('renaming a non-existent user returns 404', async () => {
  const r = await api('PATCH', '/admin/users/999999/name', { token: ADMIN, body: { name: 'Anyone' } });
  assert.equal(r.status, 404);
});

test('a non-owner admin cannot rename users', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Renamable' } });
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const rename = await api('PATCH', `/admin/users/${created.data.id}/name`, { token: userToken, body: { name: 'Hijacked' } });
  assert.equal(rename.status, 403);

  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test('a non-owner admin sees the Users list filtered to only their own row', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Someone Else' } });
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const list = await api('GET', '/admin/users', { token: userToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1, 'non-owner admin should only see their own row');
  assert.equal(list.data[0].id, userId);

  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test("regenerating a user's key issues a new one and invalidates the old", async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Regenerable' } });
  const oldToken = created.data.token;

  const regen = await api('POST', `/admin/users/${created.data.id}/regenerate-token`, { token: ADMIN });
  assert.equal(regen.status, 200);
  assert.notEqual(regen.data.token, oldToken);
  assert.match(regen.data.token, /^regenerable\d{4}$/);

  const oldLogin = await api('GET', '/me', { token: oldToken });
  assert.equal(oldLogin.status, 401);

  const newLogin = await api('GET', '/me', { token: regen.data.token });
  assert.equal(newLogin.status, 200);
});

test('regenerating a key also reopens first-time name-search retrieval for that user', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Wrongly Claimed Guest' } });

  // Simulate someone else claiming it by mistake.
  const claim = await api('POST', '/auth/claim-key', { body: { userId: created.data.id } });
  assert.equal(claim.status, 200);

  const goneFromSearch = await api('GET', '/auth/unclaimed-users?name=wrongly claimed');
  assert.ok(!goneFromSearch.data.users.some((u) => u.id === created.data.id), 'setup: should be claimed and gone from search');

  await api('POST', `/admin/users/${created.data.id}/regenerate-token`, { token: ADMIN });

  const backInSearch = await api('GET', '/auth/unclaimed-users?name=wrongly claimed');
  assert.ok(backInSearch.data.users.some((u) => u.id === created.data.id), 'regenerating the key should make the account findable again, so the rightful person can re-claim it');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

/* ----------------------------- Consequences ------------------------------ */

test('you can only suggest 1 consequence per day', async () => {
  const first = await api('POST', '/consequences', { token: userToken, body: { text: 'Beber agua' } });
  assert.equal(first.status, 201);
  const second = await api('POST', '/consequences', { token: userToken, body: { text: 'Outra' } });
  assert.equal(second.status, 409);
});

test('revealing makes the consequence the current one', async () => {
  const r = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(r.data.revealed);
  const cur = await api('GET', '/consequences/current', { token: userToken });
  assert.equal(cur.data.current.text, 'Beber agua');
});

test('with nothing pending, reveal returns 404', async () => {
  const r = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  assert.equal(r.status, 404);
});

test('the admin consequences list is sorted most-recently-touched first, so a fresh reveal jumps to the top', async () => {
  const posterA = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Consequence Poster A' } });
  const posterB = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Consequence Poster B' } });
  await api('POST', '/consequences', { token: posterA.data.token, body: { text: 'Older suggestion' } });
  await api('POST', '/consequences', { token: posterB.data.token, body: { text: 'Newer suggestion' } });

  const before = await api('GET', '/admin/consequences', { token: ADMIN });
  const newerIndex = before.data.findIndex((c) => c.text === 'Newer suggestion');
  const olderIndex = before.data.findIndex((c) => c.text === 'Older suggestion');
  assert.ok(newerIndex < olderIndex, 'the most recently suggested one should sort above the older one');

  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  assert.equal(revealed.status, 200);

  const after = await api('GET', '/admin/consequences', { token: ADMIN });
  assert.equal(after.data[0].id, revealed.data.revealed.id, 'whichever consequence was just revealed should now be first, regardless of which one it was');

  await api('DELETE', `/admin/users/${posterA.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${posterB.data.id}`, { token: ADMIN });
});

test('assigning a consequence notifies nobody but works even without push configured, and is visible to everyone via GET /consequences/revealed', async () => {
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Assign Poster' } });
  const holder = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Assign Holder' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Assign flow consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });

  const assigned = await api('PATCH', `/admin/consequences/${revealed.data.revealed.id}/assign`, {
    token: ADMIN, body: { userId: holder.data.id },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.consequence.assignedName, 'Assign Holder');

  const list = await api('GET', '/consequences/revealed', { token: userToken });
  const found = list.data.consequences.find((c) => c.id === revealed.data.revealed.id);
  assert.equal(found.assignedName, 'Assign Holder', 'the assignment is public - any logged-in user sees who was assigned');
  assert.equal(found.done_at, null);
  assert.equal(found.approved_at, null);

  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${holder.data.id}`, { token: ADMIN });
});

test('assigning stamps assigned_at, so the admin history can sort a fresh assignment to the top', async () => {
  // Regression guard: assignment used to record only who, never when. The
  // admin history sorts on the most recent of these timestamps, so with no
  // assigned_at a just-assigned row could not move - it sat wherever it
  // already was, which read as the assign having failed.
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Stamp Poster' } });
  const holder = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Stamp Holder' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Stamped consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  const id = revealed.data.revealed.id;

  const before = (await api('GET', '/admin/consequences', { token: ADMIN })).data.find((c) => c.id === id);
  assert.equal(before.assigned_at, null, 'nothing is assigned yet');

  await api('PATCH', `/admin/consequences/${id}/assign`, { token: ADMIN, body: { userId: holder.data.id } });

  const rows = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  const after = rows.find((c) => c.id === id);
  assert.ok(after.assigned_at, 'assigning records when it happened, not just who');
  const latest = (c) => c.approved_at || c.done_at || c.assigned_at || c.revealed_at || '';
  const top = [...rows].sort((a, b) => latest(b).localeCompare(latest(a)))[0];
  assert.equal(top.id, id, 'the freshly assigned one is now the most recently touched of all');

  // Clearing the assignment must not leave a stale recency behind.
  await api('PATCH', `/admin/consequences/${id}/assign`, { token: ADMIN, body: { userId: null } });
  const cleared = (await api('GET', '/admin/consequences', { token: ADMIN })).data.find((c) => c.id === id);
  assert.equal(cleared.assigned_at, null, 'unassigning clears the timestamp too');

  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${holder.data.id}`, { token: ADMIN });
});

test('a non-owner admin can assign a consequence, but only the owner can approve it', async () => {
  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Non Owner Assign Test' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Non Owner Test Poster' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Non-owner gate consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });

  const assignAttempt = await api('PATCH', `/admin/consequences/${revealed.data.revealed.id}/assign`, {
    token: nonOwnerAdmin.data.token, body: { userId: poster.data.id },
  });
  assert.equal(assignAttempt.status, 200, 'any admin, not just the owner, can record who was holding the rata');
  assert.equal(assignAttempt.data.consequence.assignedName, 'Non Owner Test Poster');

  const approveAttempt = await api('PATCH', `/admin/consequences/${revealed.data.revealed.id}/approve`, {
    token: nonOwnerAdmin.data.token,
  });
  assert.equal(approveAttempt.status, 403, 'approving is owner-only, unlike assigning');

  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
});

test('only the assigned user can mark a consequence done, only once, and only the owner can approve it afterwards', async () => {
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Mark Done Poster' } });
  const assignee = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Mark Done Assignee' } });
  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Mark Done Bystander' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Mark done consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  const id = revealed.data.revealed.id;

  await api('PATCH', `/admin/consequences/${id}/assign`, { token: ADMIN, body: { userId: assignee.data.id } });

  // Not the assigned user - rejected.
  const wrongUser = await api('POST', `/consequences/${id}/mark-done`, { token: bystander.data.token });
  assert.equal(wrongUser.status, 400);

  // Owner can't approve before it's been marked done.
  const tooEarly = await api('PATCH', `/admin/consequences/${id}/approve`, { token: ADMIN });
  assert.equal(tooEarly.status, 400);

  // The actual assignee marks it done.
  const markedDone = await api('POST', `/consequences/${id}/mark-done`, { token: assignee.data.token });
  assert.equal(markedDone.status, 200);
  assert.ok(markedDone.data.consequence.done_at);
  assert.equal(markedDone.data.consequence.approved_at, null, 'done is not the same as approved - still needs the owner');

  // Can't mark done twice.
  const again = await api('POST', `/consequences/${id}/mark-done`, { token: assignee.data.token });
  assert.equal(again.status, 400);

  // Now the owner approves it, and it shows as done to everyone.
  const approved = await api('PATCH', `/admin/consequences/${id}/approve`, { token: ADMIN });
  assert.equal(approved.status, 200);
  assert.ok(approved.data.consequence.approved_at);

  const list = await api('GET', '/consequences/revealed', { token: bystander.data.token });
  const found = list.data.consequences.find((c) => c.id === id);
  assert.ok(found.approved_at, 'the approval is public - shows as done to everyone, not just the owner/assignee');

  // Approving twice is rejected.
  const doubleApprove = await api('PATCH', `/admin/consequences/${id}/approve`, { token: ADMIN });
  assert.equal(doubleApprove.status, 400);

  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${assignee.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${bystander.data.id}`, { token: ADMIN });
});

/* -------------------------------- Voting --------------------------------- */

const NIGHT = 'furnished';

// Minimal structurally-valid JPEG (just the SOI+EOI markers) - enough to
// pass decodePhoto()'s magic-byte check without needing a real renderable
// image, since these tests only exercise the server-side validation.
const TEST_PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

test('a night that has never been opened reports started: false', async () => {
  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  const night = voting.data.nights.find((n) => n.night === NIGHT);
  assert.equal(night.status, 'closed');
  assert.equal(night.started, false, 'a night with no admin action yet should not look like "closed after running"');
});

test('voting closed by default blocks the vote', async () => {
  const c = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Concorrente A', night: NIGHT } });
  assert.equal(c.status, 201);
  contestantId = c.data.id;

  const status = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(status.data.night, NIGHT);
  assert.equal(status.data.status, 'closed');

  const vote = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(vote.status, 400);
});

test('admin opens the night and each user votes once', async () => {
  const open = await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN, body: { force: true } });
  assert.equal(open.data.votingStatus, 'open');

  const v1 = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v1.status, 201);

  const v2 = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v2.status, 400); // already voted this night

  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  const night = voting.data.nights.find((n) => n.night === NIGHT);
  assert.equal(night.started, true, 'once a night has been opened, it should never look "unstarted" again');
});

test('GET /admin/voting reports how many non-admin accounts have not voted, excluding admins from the count', async () => {
  // A separate night from NIGHT/'furnished' (heavily reused by neighboring
  // tests) - and asserting deltas off a baseline rather than an absolute
  // number, since this file shares one DB across the whole run and earlier
  // tests may have left their own never-voted accounts behind.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  const nightsInfo = async () => {
    const r = await api('GET', '/admin/voting', { token: ADMIN });
    return r.data.nights.find((n) => n.night === night);
  };
  const baseline = (await nightsInfo()).notVoted;

  // A fresh admin should never raise the count - the organiser running the
  // show very often doesn't vote themselves.
  const freshAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Fresh Admin For NotVoted' } });
  await api('PATCH', `/admin/users/${freshAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  assert.equal((await nightsInfo()).notVoted, baseline, 'a new admin account should not raise the count');

  // Two fresh regular accounts should raise it by exactly two.
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'NotVoted Guest A' } });
  await api('POST', '/admin/users', { token: ADMIN, body: { name: 'NotVoted Guest B' } });
  const contestant = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'NotVoted Target', night } });
  assert.equal((await nightsInfo()).notVoted, baseline + 2, 'two fresh non-admin accounts should each raise the count by one');

  // One of them voting should drop it back by one.
  await api('POST', '/votes', { token: a.data.token, body: { contestantId: contestant.data.id, night } });
  assert.equal((await nightsInfo()).notVoted, baseline + 1, 'voting should remove that account from the count');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('who-voted-for-whom is owner-only; a regular admin only gets the aggregate results', async () => {
  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Non Owner Admin' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const asOwner = await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN });
  assert.ok(Array.isArray(asOwner.data.votes), 'owner should see the individual voter -> contestant breakdown');
  assert.ok(Array.isArray(asOwner.data.results), 'owner should also see the aggregate results');

  const asAdmin = await api('GET', `/admin/votes?night=${NIGHT}`, { token: nonOwnerAdmin.data.token });
  assert.equal(asAdmin.data.votes, undefined, 'a non-owner admin must not see who voted for whom');
  assert.ok(Array.isArray(asAdmin.data.results), 'a non-owner admin should still see the aggregate results');

  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });
});

test('nights are independent: voting in another night is possible', async () => {
  const other = 'swamp';
  const c = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Concorrente B', night: other } });
  assert.equal(c.status, 201);
  await api('POST', `/admin/voting/${other}/open`, { token: ADMIN, body: { force: true } });

  const v = await api('POST', '/votes', { token: userToken, body: { contestantId: c.data.id, night: other } });
  assert.equal(v.status, 201); // already voted in 'furnished', but not yet in this night
});

test('closing the night hides results until the admin reveals them in stages', async () => {
  const close = await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN });
  assert.equal(close.data.votingStatus, 'closed');

  // Closed but not revealed yet: no results visible to regular users.
  const hidden = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(hidden.data.status, 'closed');
  assert.equal(hidden.data.resultsPhase, 'hidden');
  assert.deepEqual(hidden.data.results, []);

  // Only one contestant this night (rank 1) - "third"/"second" phases have
  // nothing at those ranks yet, so results stay empty until "first".
  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> third
  const third = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(third.data.resultsPhase, 'third');
  assert.deepEqual(third.data.results, []);

  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> second
  const second = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(second.data.resultsPhase, 'second');
  assert.deepEqual(second.data.results, []);

  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> first
  const first = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(first.data.resultsPhase, 'first');
  const topFirst = first.data.results.find((r) => r.id === contestantId);
  assert.equal(topFirst.votes, 1);

  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> all
  const all = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(all.data.resultsPhase, 'all');
  assert.ok(all.data.results.find((r) => r.id === contestantId));

  // Advancing past "all" is a no-op.
  const again = await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN });
  assert.equal(again.data.resultsPhase, 'all');
});

test('reset clears the night votes and reopens voting', async () => {
  const reset = await api('POST', `/admin/voting/${NIGHT}/reset`, { token: ADMIN });
  assert.equal(reset.data.votingStatus, 'open');

  const status = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(status.data.myVote, null);

  const v = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v.status, 201);
});

test('reset-all clears votes AND contestants, back to a never-started night', async () => {
  const other = 'swamp'; // already has a contestant + a vote from earlier tests
  const before = await api('GET', `/admin/contestants?night=${other}`, { token: ADMIN });
  assert.ok(before.data.contestants.length > 0, 'test setup: swamp should already have a contestant');

  const resetAll = await api('POST', `/admin/voting/${other}/reset-all`, { token: ADMIN });
  assert.equal(resetAll.status, 200);
  assert.equal(resetAll.data.votingStatus, 'closed');

  const contestants = await api('GET', `/admin/contestants?night=${other}`, { token: ADMIN });
  assert.equal(contestants.data.contestants.length, 0, 'reset-all should wipe the contestant roster too');

  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  const night = voting.data.nights.find((n) => n.night === other);
  assert.equal(night.started, false, 'reset-all should return the night to its never-started state');
});

test('a tie for first place can be broken with a runoff scoped to just the tied contestants', async () => {
  await api('POST', `/admin/voting/${NIGHT}/reset-all`, { token: ADMIN });
  const a = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Runoff A', night: NIGHT } });
  const b = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Runoff B', night: NIGHT } });
  const c = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Runoff C', night: NIGHT } });

  await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN, body: { force: true } });

  const voters = [];
  for (let i = 0; i < 5; i++) {
    voters.push((await api('POST', '/admin/users', { token: ADMIN, body: { name: `Runoff Voter ${i}` } })).data.token);
  }
  // A and B tied at 2 votes each, C behind at 1.
  await api('POST', '/votes', { token: voters[0], body: { contestantId: a.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[1], body: { contestantId: a.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[2], body: { contestantId: b.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[3], body: { contestantId: b.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[4], body: { contestantId: c.data.id, night: NIGHT } });

  const beforeClose = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(beforeClose.status, 409);
  assert.equal(beforeClose.data.error, 'err_voting_not_closed', 'a tie can only be judged once voting is closed');

  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });

  const noTieYet = await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN });
  assert.equal(noTieYet.data.results[0].votes, noTieYet.data.results[1].votes, 'test setup: A and B should be tied at the top');

  const runoff = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(runoff.status, 200);
  assert.equal(runoff.data.votingStatus, 'open');
  assert.deepEqual(new Set(runoff.data.contestantIds), new Set([a.data.id, b.data.id]));

  const again = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'err_voting_not_closed', 'a runoff itself has to be voting-open, not still closed, to start another one');

  // C lost the first round - no longer votable, even though voting reopened.
  const status = await api('GET', `/votes/status?night=${NIGHT}`, { token: voters[0] });
  assert.equal(status.data.runoffActive, true);
  assert.deepEqual(new Set(status.data.contestants.map((x) => x.id)), new Set([a.data.id, b.data.id]));

  const rejectedC = await api('POST', '/votes', { token: voters[4], body: { contestantId: c.data.id, night: NIGHT } });
  assert.equal(rejectedC.status, 400);
  assert.equal(rejectedC.data.error, 'err_not_in_runoff');

  const okA = await api('POST', '/votes', { token: voters[4], body: { contestantId: a.data.id, night: NIGHT } });
  assert.equal(okA.status, 201, 'voting for a tied contestant during the runoff should still work');

  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });
  const runoffResults = await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN });
  assert.equal(runoffResults.data.results.length, 2, 'runoff results should only include the tied contestants, not C');

  const resetAgain = await api('POST', `/admin/voting/${NIGHT}/reset-all`, { token: ADMIN });
  assert.equal(resetAgain.status, 200);
  assert.equal(resetAgain.data.votingStatus, 'closed', 'reset-all already leaves the night closed - no need to close it again');
  const noTieResult = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(noTieResult.status, 409);
  assert.equal(noTieResult.data.error, 'err_no_tie', 'reset-all should have cleared the runoff, and there are no contestants left to tie');
});

test('Miss Congeniality is a separate per-person round: duos split up, self-votes are refused, and the winner only appears once revealed', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const ana = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Ana' } });
  const bea = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Bea' } });
  const caio = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Caio' } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', '/admin/contestants/register', { token: ADMIN, body: { night, name: 'Cong Solo', userId: ana.data.id } });
  // One duo entry - it must contribute its two people separately here, even
  // though the outfit vote treats it as a single entry.
  await api('POST', '/admin/contestants/register', { token: ADMIN, body: { night, name: 'Cong Duo', userId: bea.data.id, partnerUserId: caio.data.id } });

  const closed = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: bea.data.id } });
  assert.equal(closed.status, 400);
  assert.equal(closed.data.error, 'err_congeniality_not_open', 'the round starts closed - nobody votes before the admin opens it');

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'open' } });

  const status = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  assert.deepEqual(
    new Set(status.data.congeniality.candidates.map((c) => c.id)),
    new Set([ana.data.id, bea.data.id, caio.data.id]),
    'the duo should appear as its two individuals, alongside the solo entrant'
  );

  const own = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: ana.data.id } });
  assert.equal(own.data.error, 'err_cannot_vote_self');

  const outsider = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Outsider' } });
  const notRunning = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: outsider.data.id } });
  assert.equal(notRunning.data.error, 'err_not_a_candidate');

  assert.equal((await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: bea.data.id } })).status, 201);
  assert.equal((await api('POST', '/congeniality/vote', { token: caio.data.token, body: { night, targetUserId: bea.data.id } })).status, 201);
  const twice = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: caio.data.id } });
  assert.equal(twice.data.error, 'err_already_voted', 'one vote each, no changing it');

  const beforeReveal = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  assert.equal(beforeReveal.data.congeniality.winner, null, 'a guest must not see the winner before the reveal');
  assert.equal(beforeReveal.data.congeniality.myVote, bea.data.id);

  // An admin, by contrast, can watch the standings the whole way through.
  const adminView = await api('GET', '/admin/voting', { token: ADMIN });
  const nightRow = adminView.data.nights.find((n) => n.night === night);
  assert.equal(nightRow.congenialityStatus, 'open');
  assert.equal(nightRow.congenialityResults[0].votes, 2);

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });
  const revealed = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  assert.equal(revealed.data.congeniality.winner.id, bea.data.id);
  assert.equal(revealed.data.congeniality.winner.votes, 2);

  // Restarting the night's round has to take the congeniality result with
  // it - a revealed winner attached to votes that no longer exist would be
  // a lie the Wall could still be showing.
  await api('POST', `/admin/voting/${night}/reset`, { token: ADMIN });
  const afterReset = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  assert.equal(afterReset.data.congeniality.status, 'closed');
  assert.equal(afterReset.data.congeniality.winner, null);
});

test('publishing a Snatch result to the Wall needs the podium revealed first, and snapshots it so a later reset cannot rewrite it', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const a = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Podium A', night } });
  await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Podium B', night } });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const voter = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Podium Voter' } });
  await api('POST', '/votes', { token: voter.data.token, body: { contestantId: a.data.id, night } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });

  const tooEarly = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(tooEarly.status, 400);
  assert.equal(tooEarly.data.error, 'err_results_not_revealed', 'publishing before the reveal would spoil the countdown');

  // hidden -> third -> second -> first: the winner is out, but the post
  // carries all three, so it still refuses.
  for (let i = 0; i < 3; i++) await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  const winnerOnly = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(winnerOnly.status, 400, 'publishing at "first" would freeze two blank places into the post');

  // -> all
  await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  const published = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(published.status, 201);

  const feed = await api('GET', '/plaza-posts', { token: voter.data.token });
  const post = feed.data.posts.find((p) => p.type === 'podium');
  assert.ok(post, 'the podium post should be readable by any guest on the Wall');
  const snapshot = JSON.parse(post.text);
  assert.equal(snapshot.night, night);
  assert.equal(snapshot.podium[0].name, 'Podium A');
  assert.equal(snapshot.podium[0].votes, 1);
  assert.equal(snapshot.podium[0].rank, 1);

  // Wiping the night must leave the already-published post untouched.
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const afterWipe = await api('GET', '/plaza-posts', { token: voter.data.token });
  const stillThere = afterWipe.data.posts.find((p) => p.type === 'podium');
  assert.equal(JSON.parse(stillThere.text).podium[0].name, 'Podium A');
});

test('a solo contestant cannot vote for their own entry', async () => {
  const night = 'swamp'; // wiped clean by the reset-all test above
  const solo = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Solo Voter' } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const reg = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'Solo Persona', night, photoBase64: TEST_PHOTO } });
  assert.equal(reg.status, 201);

  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  const status = await api('GET', `/votes/status?night=${night}`, { token: solo.data.token });
  assert.equal(status.data.myContestant.id, reg.data.id, 'the frontend needs myContestant.id to filter this entry out of the vote list');

  const vote = await api('POST', '/votes', { token: solo.data.token, body: { contestantId: reg.data.id, night } });
  assert.equal(vote.status, 400);
  assert.equal(vote.data.error, 'err_cannot_vote_self');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('neither half of a duo can vote for their own shared entry', async () => {
  const night = 'swamp'; // wiped clean by the previous test
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Duo A' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Duo B' } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const reg = await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Duo Persona', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  assert.equal(reg.status, 201);
  // A duo entry now needs its named partner to sign off before it's a
  // real contestant (see confirmContestant()) - these tests are about
  // voting, so get the pair on the roster first.
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });

  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  const voteA = await api('POST', '/votes', { token: a.data.token, body: { contestantId: reg.data.id, night } });
  assert.equal(voteA.status, 400);
  assert.equal(voteA.data.error, 'err_cannot_vote_self');

  const voteB = await api('POST', '/votes', { token: b.data.token, body: { contestantId: reg.data.id, night } });
  assert.equal(voteB.status, 400);
  assert.equal(voteB.data.error, 'err_cannot_vote_self', "the partner who didn't register it also can't vote for it");

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test("a duo's vote only counts once the partner confirms it", async () => {
  const night = 'swamp'; // wiped clean by the previous test
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Pair One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Pair Two' } });
  const rival = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Rival', night } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Pair Persona', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  // A duo entry now needs its named partner to sign off before it's a
  // real contestant (see confirmContestant()) - these tests are about
  // voting, so get the pair on the roster first.
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  // One partner proposes - accepted, but flagged pending and worth nothing yet.
  const proposal = await api('POST', '/votes', { token: a.data.token, body: { contestantId: rival.data.id, night } });
  assert.equal(proposal.status, 201);
  assert.equal(proposal.data.pending, true);

  const beforeConfirm = await api('GET', `/admin/votes?night=${night}`, { token: ADMIN });
  assert.equal(beforeConfirm.data.results.find((r) => r.id === rival.data.id).votes, 0,
    'an unconfirmed proposal must not count towards the tally');

  // The proposer can't wave their own proposal through.
  const selfConfirm = await api('POST', '/votes/confirm', { token: a.data.token, body: { night } });
  assert.equal(selfConfirm.status, 400);
  assert.equal(selfConfirm.data.error, 'err_partner_must_confirm');

  // Neither of them gets a second, separate vote while one is pending.
  const second = await api('POST', '/votes', { token: b.data.token, body: { contestantId: rival.data.id, night } });
  assert.equal(second.status, 400);
  assert.equal(second.data.error, 'err_duo_already_voted');

  // The partner confirming is what turns it into a real vote.
  const confirm = await api('POST', '/votes/confirm', { token: b.data.token, body: { night } });
  assert.equal(confirm.status, 200);

  const afterConfirm = await api('GET', `/admin/votes?night=${night}`, { token: ADMIN });
  assert.equal(afterConfirm.data.results.find((r) => r.id === rival.data.id).votes, 1,
    'the pair should land exactly one vote between them, not two');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('a pending duo proposal can be swapped for another, and blocks closing until acknowledged', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Swap One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Swap Two' } });
  const first = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'First Pick', night } });
  const second = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Second Pick', night } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Swap Persona', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  // A duo entry now needs its named partner to sign off before it's a
  // real contestant (see confirmContestant()) - these tests are about
  // voting, so get the pair on the roster first.
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  await api('POST', '/votes', { token: a.data.token, body: { contestantId: first.data.id, night } });
  // The partner disagrees: dropping the proposal frees the pair to repick.
  const drop = await api('DELETE', '/votes/pending', { token: b.data.token, body: { night } });
  assert.equal(drop.status, 200);
  const repick = await api('POST', '/votes', { token: b.data.token, body: { contestantId: second.data.id, night } });
  assert.equal(repick.status, 201);

  // Closing on top of an unconfirmed proposal is refused once, with a count.
  const blocked = await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, 'err_pending_duo_votes');
  assert.equal(blocked.data.pending, 1);

  // The owner can still go ahead knowingly - the stranded vote just doesn't count.
  const forced = await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });
  assert.equal(forced.status, 200);
  const results = await api('GET', `/admin/votes?night=${night}`, { token: ADMIN });
  assert.equal(results.data.results.find((r) => r.id === second.data.id).votes, 0);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('a duo entry is not in the running until the named partner confirms it', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Entry One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Entry Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Unconfirmed Pair', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.pending, true);

  // Not votable, and not in anyone's contestant list, while unconfirmed.
  const listed = await api('GET', `/votes/status?night=${night}`, { token: ADMIN });
  assert.equal(listed.data.contestants.find((c) => c.id === reg.data.id), undefined,
    'an unconfirmed duo entry must stay off the voting list');
  // ...but the owner's roster does show it, flagged, so it can be chased.
  const roster = await api('GET', `/admin/contestants?night=${night}`, { token: ADMIN });
  assert.equal(roster.data.contestants.find((c) => c.id === reg.data.id).confirmed, 0);

  // The person who entered it can't wave it through themselves.
  const selfConfirm = await api('POST', '/outfit/register/confirm', { token: a.data.token, body: { night } });
  assert.equal(selfConfirm.status, 400);
  assert.equal(selfConfirm.data.error, 'err_partner_must_confirm_entry');

  // Opening the voting is refused once, since it would strand the entry.
  const blocked = await api('POST', `/admin/voting/${night}/open`, { token: ADMIN });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, 'err_pending_duo_entries');
  assert.equal(blocked.data.pending, 1);

  // The named partner confirming is what puts them in the running.
  const confirm = await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });
  assert.equal(confirm.status, 200);
  const nowListed = await api('GET', `/votes/status?night=${night}`, { token: ADMIN });
  assert.ok(nowListed.data.contestants.find((c) => c.id === reg.data.id),
    'once confirmed the pair should appear as a real contestant');

  // ...and with nothing pending, opening no longer needs forcing.
  const opened = await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  assert.equal(opened.status, 200);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('a refused duo entry frees both people to enter again', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Refuse One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Refuse Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Doomed Pair', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  // While it stands, it reserves both of them - neither can enter separately.
  const blocked = await api('POST', '/outfit/register', { token: b.data.token, body: { name: 'Solo Try', night, photoBase64: TEST_PHOTO } });
  assert.equal(blocked.status, 400);

  const refuse = await api('DELETE', '/outfit/register/pending', { token: b.data.token, body: { night } });
  assert.equal(refuse.status, 200);

  // Both are free again afterwards.
  const soloB = await api('POST', '/outfit/register', { token: b.data.token, body: { name: 'Solo B', night, photoBase64: TEST_PHOTO } });
  assert.equal(soloB.status, 201);
  assert.equal(soloB.data.pending, false, 'a solo entry needs nobody to confirm it');
  const soloA = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Solo A', night, photoBase64: TEST_PHOTO } });
  assert.equal(soloA.status, 201);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('either half of a pending duo can cancel it themselves, but not once it is confirmed', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  // Nothing registered yet - both actions 400 rather than crash.
  const noEntryConfirm = await api('POST', '/outfit/register/confirm', { token: a.data.token, body: { night } });
  assert.equal(noEntryConfirm.status, 400);
  assert.equal(noEntryConfirm.data.error, 'err_no_pending_entry');
  const noEntryCancel = await api('DELETE', '/outfit/register/pending', { token: a.data.token, body: { night } });
  assert.equal(noEntryCancel.status, 400);
  assert.equal(noEntryCancel.data.error, 'err_no_pending_entry');

  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Second Thoughts', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });

  // A change of heart is the same operation as a refusal - the registrant
  // can drop their own still-pending entry, not just the named partner.
  const selfCancel = await api('DELETE', '/outfit/register/pending', { token: a.data.token, body: { night } });
  assert.equal(selfCancel.status, 200);
  const soloAgain = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Solo Again', night, photoBase64: TEST_PHOTO } });
  assert.equal(soloAgain.status, 201);

  // Once confirmed, it's a real entry - cancel/confirm no longer apply to
  // it (there's no un-entering yourself; that's the owner's remove button).
  const c = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel Three' } });
  const d = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel Four' } });
  await api('POST', '/outfit/register', {
    token: c.data.token,
    body: { name: 'Settled Pair', night, partnerUserId: d.data.id, photoBase64: TEST_PHOTO },
  });
  await api('POST', '/outfit/register/confirm', { token: d.data.token, body: { night } });

  const reconfirm = await api('POST', '/outfit/register/confirm', { token: d.data.token, body: { night } });
  assert.equal(reconfirm.status, 400);
  assert.equal(reconfirm.data.error, 'err_you_already_registered');
  const lateCancel = await api('DELETE', '/outfit/register/pending', { token: c.data.token, body: { night } });
  assert.equal(lateCancel.status, 400);
  assert.equal(lateCancel.data.error, 'err_you_already_registered');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('an admin entering a pair on their behalf does not need a confirmation', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Admin Pair One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Admin Pair Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/admin/contestants/register', {
    token: ADMIN,
    body: { userId: a.data.id, partnerUserId: b.data.id, name: 'Organiser Pair', night },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.pending, false);

  const listed = await api('GET', `/votes/status?night=${night}`, { token: ADMIN });
  assert.ok(listed.data.contestants.find((c) => c.id === reg.data.id),
    'an organiser-created pair should be in the running immediately');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('self-registration requires a valid photo, but an organiser registering on someone\'s behalf does not', async () => {
  const night = 'swamp';
  const solo = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Required' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const noPhoto = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'No Photo', night } });
  assert.equal(noPhoto.status, 400);
  assert.equal(noPhoto.data.error, 'err_photo_required');

  const notAnImage = await api('POST', '/outfit/register', {
    token: solo.data.token,
    body: { name: 'Bad Photo', night, photoBase64: 'data:image/jpeg;base64,bm90IGEgamZpZg==' },
  });
  assert.equal(notAnImage.status, 400);
  assert.equal(notAnImage.data.error, 'err_photo_invalid');

  const wrongMime = await api('POST', '/outfit/register', {
    token: solo.data.token,
    body: { name: 'Wrong Mime', night, photoBase64: 'data:image/png;base64,aWJ2ZXI=' },
  });
  assert.equal(wrongMime.status, 400);
  assert.equal(wrongMime.data.error, 'err_photo_invalid');

  const tooBig = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(500 * 1024, 1)]).toString('base64');
  const oversized = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'Huge Photo', night, photoBase64: tooBig } });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.data.error, 'err_photo_too_large');

  const ok = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'Good Photo', night, photoBase64: TEST_PHOTO } });
  assert.equal(ok.status, 201);

  // The organiser registering someone else skips the whole requirement,
  // same as it already skips duo confirmation (autoConfirm).
  const c = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Organiser Solo' } });
  const organiserReg = await api('POST', '/admin/contestants/register', { token: ADMIN, body: { userId: c.data.id, name: 'No Photo Needed', night } });
  assert.equal(organiserReg.status, 201);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('an organiser registering someone else can attach a photo at the same time', async () => {
  // The admin form has always had a photo picker, but nothing was wired to
  // it and the route dropped photoBase64 on the floor, so an organiser
  // adding an entry could never attach a photo at that moment - only after
  // the fact via "mudar foto".
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Organiser Photo Guest' } });

  const reg = await api('POST', '/admin/contestants/register', {
    token: ADMIN,
    body: { userId: guest.data.id, name: 'With A Photo', night, photoBase64: TEST_PHOTO },
  });
  assert.equal(reg.status, 201);

  const listed = (await api('GET', `/admin/contestants?night=${night}`, { token: ADMIN }))
    .data.contestants.find((c) => c.id === reg.data.id);
  assert.equal(!!listed.hasPhoto, true, 'the attached photo is actually stored, not silently discarded');

  const photo = await api('GET', `/outfit/contestants/${reg.data.id}/photo`, { token: ADMIN });
  assert.equal(photo.status, 200, 'and it can be fetched back');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('DELETE', `/admin/users/${guest.data.id}`, { token: ADMIN });
});

test('either half of a duo can replace the entry photo before voting opens, not after', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Swap One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Swap Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Swappable Pair', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });

  // The partner didn't register it, but the photo belongs to the entry,
  // not to whoever uploaded it first.
  const swapByPartner = await api('PUT', '/outfit/register/photo', { token: b.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(swapByPartner.status, 200);
  const swapByRegistrant = await api('PUT', '/outfit/register/photo', { token: a.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(swapByRegistrant.status, 200);

  // Nobody without an entry tonight can "replace" a photo that isn't theirs.
  const stranger = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Stranger' } });
  const noEntry = await api('PUT', '/outfit/register/photo', { token: stranger.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(noEntry.status, 400);
  assert.equal(noEntry.data.error, 'err_no_contestant_entry');

  // Opening voting locks the roster - the photo included.
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const afterOpen = await api('PUT', '/outfit/register/photo', { token: a.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(afterOpen.status, 400);
  assert.equal(afterOpen.data.error, 'err_registration_not_open');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('a contestant photo is visible to its own entrants and admins any time, but to everyone else only once revealed', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Owner' } });
  const rival = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Rival' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Reveal Persona', night, photoBase64: TEST_PHOTO } });
  const photoUrl = `/outfit/contestants/${reg.data.id}/photo`;

  // The registrant can always see their own entry's photo.
  const ownView = await api('GET', photoUrl, { token: a.data.token });
  assert.equal(ownView.status, 200);
  // An admin can always see it too, for moderation.
  const adminView = await api('GET', photoUrl, { token: ADMIN });
  assert.equal(adminView.status, 200);
  // Nobody else can, before it's been revealed.
  const earlyPeek = await api('GET', photoUrl, { token: rival.data.token });
  assert.equal(earlyPeek.status, 404);

  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  await api('POST', '/votes', { token: rival.data.token, body: { contestantId: reg.data.id, night } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });

  // Still hidden while the reveal is staged and hasn't reached this rank.
  const stillHidden = await api('GET', photoUrl, { token: rival.data.token });
  assert.equal(stillHidden.status, 404);

  // Once the reveal actually reaches "all", it opens up to everyone -
  // advance through every stage (hidden -> third -> second -> first -> all)
  // regardless of how many contestants there are.
  for (let i = 0; i < 4; i++) {
    await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  }
  const revealed = await api('GET', photoUrl, { token: rival.data.token });
  assert.equal(revealed.status, 200);
  assert.ok(revealed.headers.get('content-type').startsWith('image/jpeg'));

  // A contestant with no photo at all (e.g. an organiser quick-add) 404s
  // rather than crashing.
  const noPhotoEntry = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Photoless', night } });
  const missing = await api('GET', `/outfit/contestants/${noPhotoEntry.data.id}/photo`, { token: ADMIN });
  assert.equal(missing.status, 404);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('admin/owner can download every submitted photo for a night as a zip; nobody else can', async () => {
  const night = 'swamp';
  const regular = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zip Bystander' } });
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zip Persona A' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zip Persona B' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const regA = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Ghost', night, photoBase64: TEST_PHOTO } });
  // Same character name on purpose - collisions inside the zip should
  // dedupe by contestant id rather than one entry silently overwriting the
  // other (see the filename logic in routes.js).
  const regB = await api('POST', '/outfit/register', { token: b.data.token, body: { name: 'Ghost', night, photoBase64: TEST_PHOTO } });

  // Not an admin - no access at all, regardless of the night's data.
  const forbidden = await apiBuffer(`/admin/outfit/${night}/photos.zip`, { token: regular.data.token });
  assert.equal(forbidden.status, 403);

  const zipRes = await apiBuffer(`/admin/outfit/${night}/photos.zip`, { token: ADMIN });
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  assert.ok(zipRes.headers.get('content-disposition').includes(`snatch-${night}-photos.zip`));

  const entries = await readZipEntries(zipRes.buffer);
  assert.equal(entries.length, 2, 'both contestants photos should be in the zip, deduped by id');
  // Whichever comes first keeps the clean name; the later same-named one
  // falls back to id-suffixed rather than the two colliding outright - not
  // asserting which specific one wins, just that dedup actually happened.
  const filenames = entries.map((e) => e.filename);
  // Lowercased on the way in: the app is lowercase throughout, and a
  // case-insensitive filesystem would collide "Ghost.jpg" with "ghost.jpg"
  // on extraction anyway.
  assert.ok(filenames.every((f) => f === f.toLowerCase()), 'entry names should be lowercase');
  assert.equal(filenames.filter((f) => f === 'ghost.jpg').length, 1, 'exactly one entry should keep the clean name');
  assert.equal(
    filenames.filter((f) => f === `ghost-${regA.data.id}.jpg` || f === `ghost-${regB.data.id}.jpg`).length,
    1,
    'the colliding entry should fall back to an id-suffixed name'
  );
  // Bytes actually made it through intact, not just the right count/names.
  const expectedBytes = Buffer.from(TEST_PHOTO.slice('data:image/jpeg;base64,'.length), 'base64');
  for (const entry of entries) {
    assert.equal(Buffer.compare(entry.contents, expectedBytes), 0, `${entry.filename} bytes should match what was uploaded`);
  }

  // A night with confirmed registration but no photos at all (furnished,
  // untouched by this test) 404s instead of handing back an empty zip.
  const empty = await apiBuffer('/admin/outfit/furnished/photos.zip', { token: ADMIN });
  assert.equal(empty.status, 404);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

/* --------------------------- Owner content reset -------------------------- */
// Wipes contestants/votes/consequences - runs last so it doesn't disturb
// the shared state the tests above rely on.

test('a non-owner admin can read and change the day-rollover-hour setting', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const get = await api('GET', '/admin/settings', { token: userToken });
  assert.equal(get.status, 200);
  const put = await api('PUT', '/admin/settings', { token: userToken, body: { dayRolloverHour: 6 } });
  assert.equal(put.status, 200);
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('a non-owner admin cannot use any feature wipe switch', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  for (const path of ['/admin/consequences/wipe', '/admin/contestants/wipe', '/admin/plaza-posts/wipe', '/admin/chat/wipe', '/admin/memo/wipe']) {
    const r = await api('POST', path, { token: userToken });
    assert.equal(r.status, 403, `${path} should be owner-only`);
  }
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('a non-owner admin can add a Best Look contestant but not remove one', async () => {
  // Adding is the sort of thing a helper does on the night - someone turns
  // up, someone puts them on the list. Removing is not: it throws away an
  // entry and any votes attached to it, so it stays with the owner.
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  try {
    await api('POST', `/admin/voting/${NIGHT}/registration`, { token: ADMIN });

    const byAdmin = await api('POST', '/admin/contestants/register', {
      token: userToken,
      body: { userId, name: 'Admin Registered', night: NIGHT },
    });
    assert.equal(byAdmin.status, 201, 'an admin should be able to put someone on the list');

    const remove = await api('DELETE', `/admin/contestants/${byAdmin.data.id}`, { token: userToken });
    assert.equal(remove.status, 403, 'but not take anyone off it');

    await api('DELETE', `/admin/contestants/${byAdmin.data.id}`, { token: ADMIN });
  } finally {
    // Always demoted, even if an assertion above throws: this is the shared
    // user, and leaving it an admin quietly breaks every later test that
    // expects a plain account. That is exactly what happened when these
    // rules changed - one failure here, one apparently unrelated failure
    // in Plaza.
    await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  }
});

/* ----------------------------------- Chat ---------------------------------- */

test('posting and reading a chat message', async () => {
  const post = await api('POST', '/chat/messages', { token: ADMIN, body: { text: 'ola pessoal' } });
  assert.equal(post.status, 201);

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  assert.equal(list.status, 200);
  const found = list.data.messages.find((m) => m.text === 'ola pessoal');
  assert.ok(found, 'posted message should appear in the list');
  // The Wall is anonymous - author is a random pseudonym, never the real
  // poster's name or user id.
  assert.notEqual(found.author, 'Test Admin');
  assert.match(found.author, /^[a-z]+$/);
  // "time" is created_at converted to the configured timezone, not the raw
  // UTC value - the client must never format created_at itself (see
  // formatTimeInZone() in time.js).
  assert.match(found.time, /^\d{2}:\d{2}$/);
});

test("a user's Wall pseudonym stays the same across multiple posts", async () => {
  await api('POST', '/chat/messages', { token: userToken, body: { text: 'stable-1' } });
  await api('POST', '/chat/messages', { token: userToken, body: { text: 'stable-2' } });

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const msg1 = list.data.messages.find((m) => m.text === 'stable-1');
  const msg2 = list.data.messages.find((m) => m.text === 'stable-2');
  assert.ok(msg1 && msg2, 'both messages should be in the list');
  assert.equal(msg1.author, msg2.author, 'the same user should get the same pseudonym on every post');
});

test('Wall messages are lowercased, but special characters and emoji survive', async () => {
  const post = await api('POST', '/chat/messages', { token: ADMIN, body: { text: 'OLÁ Malta!! 😀 <b>test</b> ***' } });
  assert.equal(post.status, 201);

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const found = list.data.messages.find((m) => m.text.startsWith('olá malta'));
  assert.ok(found, 'sanitized message should appear in the list');
  assert.equal(found.text, 'olá malta!! 😀 <b>test</b> ***');
});

test('the Wall name<->pseudonym mapping is owner-only', async () => {
  const forbidden = await api('GET', '/admin/wall-pseudonyms', { token: userToken });
  assert.equal(forbidden.status, 403);

  const ok = await api('GET', '/admin/wall-pseudonyms', { token: ADMIN });
  assert.equal(ok.status, 200);
  const entry = ok.data.find((r) => r.name === 'Ivo');
  assert.ok(entry, 'the posting user should show up in the mapping');

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const theirMsg = list.data.messages.find((m) => m.text === 'stable-1');
  const current = entry.pseudonyms[entry.pseudonyms.length - 1];
  assert.equal(current, theirMsg.author, 'the mapping should match what actually shows on the Wall');
});

test('a Wall pseudonym can be reset once a day, and the owner sees the full history', async () => {
  const before = await api('GET', '/admin/wall-pseudonyms', { token: ADMIN });
  const entryBefore = before.data.find((r) => r.name === 'Ivo');
  const oldPseudonym = entryBefore.pseudonyms[entryBefore.pseudonyms.length - 1];

  const forbidden = await api('POST', `/admin/users/${userId}/wall-pseudonym/reset`, { token: userToken });
  assert.equal(forbidden.status, 403, 'non-owner admins cannot reset a pseudonym');

  const first = await api('POST', `/admin/users/${userId}/wall-pseudonym/reset`, { token: ADMIN });
  assert.equal(first.status, 200);
  assert.notEqual(first.data.pseudonym, oldPseudonym, 'reset should produce a different pseudonym');

  const again = await api('POST', `/admin/users/${userId}/wall-pseudonym/reset`, { token: ADMIN });
  assert.equal(again.status, 400, 'a second reset the same day should be rejected');

  const after = await api('GET', '/admin/wall-pseudonyms', { token: ADMIN });
  const entryAfter = after.data.find((r) => r.name === 'Ivo');
  assert.ok(entryAfter.pseudonyms.includes(oldPseudonym), 'the old pseudonym should stay in the history');
  assert.ok(entryAfter.pseudonyms.includes(first.data.pseudonym), 'the new pseudonym should be in the history too');

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const oldMsg = list.data.messages.find((m) => m.text === 'stable-1');
  assert.equal(oldMsg.author, oldPseudonym, 'messages already posted keep the pseudonym that was active at the time');
});

test('a user can change their own access key, given the correct current one', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Selfservice' } });
  const oldToken = created.data.token;

  const wrongOld = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: 'notthecurrentone', newToken: 'newkey1234' },
  });
  assert.equal(wrongOld.status, 401);

  const badChars = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: oldToken, newToken: 'has-a-dash!' },
  });
  assert.equal(badChars.status, 400);

  const tooShort = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: oldToken, newToken: 'abc123' },
  });
  assert.equal(tooShort.status, 400, 'a 6-character key should be rejected - minimum is 7');

  const ok = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: oldToken, newToken: 'newkey1234' },
  });
  assert.equal(ok.status, 200);

  const oldStillWorks = await api('GET', '/me', { token: oldToken });
  assert.equal(oldStillWorks.status, 401, 'old key should stop working after the change');

  const newWorks = await api('GET', '/me', { token: 'newkey1234' });
  assert.equal(newWorks.status, 200, 'new key should work immediately');
});

test('changing to a key that already belongs to someone else is rejected', async () => {
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'KeyOwnerA' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'KeyOwnerB' } });

  const collision = await api('POST', '/me/change-token', {
    token: b.data.token, body: { currentToken: b.data.token, newToken: a.data.token },
  });
  assert.equal(collision.status, 409);
});

test('an empty chat message is rejected', async () => {
  const r = await api('POST', '/chat/messages', { token: ADMIN, body: { text: '   ' } });
  assert.equal(r.status, 400);
});

test('chat keeps only the 20 most recent messages', async () => {
  for (let i = 0; i < 25; i++) {
    await api('POST', '/chat/messages', { token: ADMIN, body: { text: `msg-${i}` } });
  }
  const list = await api('GET', '/chat/messages', { token: ADMIN });
  assert.ok(list.data.messages.length <= 20, `expected at most 20 messages, got ${list.data.messages.length}`);
  // The oldest ones (msg-0..msg-4) must have been trimmed; the latest survive.
  const texts = list.data.messages.map((m) => m.text);
  assert.ok(!texts.includes('msg-0'), 'oldest message should have been pruned');
  assert.ok(texts.includes('msg-24'), 'most recent message should still be there');
});

/* ------------------------------ Language preference ------------------------ */

test('a user can set their language preference, and it is reflected on /me', async () => {
  const r = await api('POST', '/me/lang', { token: ADMIN, body: { lang: 'en' } });
  assert.equal(r.status, 200);

  const me = await api('GET', '/me', { token: ADMIN });
  assert.equal(me.data.lang, 'en');

  // Reset back to pt so it doesn't bleed into other tests relying on ADMIN.
  await api('POST', '/me/lang', { token: ADMIN, body: { lang: 'pt' } });
});

test('an invalid language value falls back to pt', async () => {
  const r = await api('POST', '/me/lang', { token: ADMIN, body: { lang: 'xx' } });
  assert.equal(r.status, 200);
  const me = await api('GET', '/me', { token: ADMIN });
  assert.equal(me.data.lang, 'pt');
});

/* ----------------------------------- Plaza ----------------------------------- */

test('Plaza announcements: any logged-in user can read the feed, any admin (not just the owner) can post one', async () => {
  const forbidden = await api('POST', '/admin/plaza-posts', { token: userToken, body: { type: 'announcement', text: 'sneaky' } });
  assert.equal(forbidden.status, 403);

  const create = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'welcome! wifi: mossycottage' } });
  assert.equal(create.status, 200);

  const read = await api('GET', '/plaza-posts', { token: userToken });
  assert.equal(read.status, 200);
  const announcement = read.data.posts.find((p) => p.id === create.data.id);
  assert.equal(announcement.type, 'announcement');
  assert.equal(announcement.text, 'welcome! wifi: mossycottage');
  assert.equal(announcement.author, 'Test Admin');
  assert.equal(announcement.pinnedAt, null);

  // A regular (non-owner) admin can post to Plaza too now.
  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Plaza Admin Poster' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const asAdmin = await api('POST', '/admin/plaza-posts', { token: nonOwnerAdmin.data.token, body: { type: 'announcement', text: 'admin-posted announcement' } });
  assert.equal(asAdmin.status, 200);
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });

  await api('DELETE', `/admin/plaza-posts/${create.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${asAdmin.data.id}`, { token: ADMIN });
});

test('Plaza pinning: owner-only, either post type, pinned ones sort first (most-recently-pinned first)', async () => {
  const older = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'older announcement' } });
  const newer = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'poll', text: 'Dinner?', options: ['Pizza', 'Sushi'] } });
  const unpinned = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'never pinned' } });

  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Plaza Pin Tester' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  // Not owner - forbidden, regardless of post type.
  const forbidden = await api('PATCH', `/admin/plaza-posts/${older.data.id}/pin`, { token: nonOwnerAdmin.data.token, body: { pinned: true } });
  assert.equal(forbidden.status, 403);
  const forbiddenPoll = await api('PATCH', `/admin/plaza-posts/${newer.data.id}/pin`, { token: nonOwnerAdmin.data.token, body: { pinned: true } });
  assert.equal(forbiddenPoll.status, 403);

  // Pin the announcement first, then the poll - most-recently-pinned first,
  // and a poll can be pinned same as an announcement.
  const pin1 = await api('PATCH', `/admin/plaza-posts/${older.data.id}/pin`, { token: ADMIN, body: { pinned: true } });
  assert.equal(pin1.status, 200);
  const pin2 = await api('PATCH', `/admin/plaza-posts/${newer.data.id}/pin`, { token: ADMIN, body: { pinned: true } });
  assert.equal(pin2.status, 200);

  const feed = await api('GET', '/plaza-posts', { token: userToken });
  const pinnedIds = feed.data.posts.filter((p) => p.pinnedAt).map((p) => p.id);
  assert.deepEqual(pinnedIds, [newer.data.id, older.data.id]);
  assert.ok(feed.data.posts.findIndex((p) => p.id === older.data.id) < feed.data.posts.findIndex((p) => p.id === unpinned.data.id));

  const unpin = await api('PATCH', `/admin/plaza-posts/${older.data.id}/pin`, { token: ADMIN, body: { pinned: false } });
  assert.equal(unpin.status, 200);
  const afterUnpin = await api('GET', '/plaza-posts', { token: userToken });
  assert.equal(afterUnpin.data.posts.find((p) => p.id === older.data.id).pinnedAt, null);

  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${older.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${newer.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${unpinned.data.id}`, { token: ADMIN });
});

test('Plaza polls: creating one requires 2-6 options, voting tallies correctly, and a second vote is rejected rather than moving it', async () => {
  const bad = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'poll', text: 'Dinner?', options: ['Only one'] } });
  assert.equal(bad.status, 400);

  const create = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'poll', text: 'Where for dinner?', options: ['Pizza', 'Sushi', 'Tacos'] },
  });
  assert.equal(create.status, 200);
  const postId = create.data.id;

  const before = await api('GET', '/plaza-posts', { token: userToken });
  const poll = before.data.posts.find((p) => p.id === postId);
  assert.equal(poll.type, 'poll');
  assert.equal(poll.options.length, 3);
  assert.ok(poll.options.every((o) => o.votes === 0));
  assert.equal(poll.myOptionId, null);

  const pizzaId = poll.options.find((o) => o.label === 'Pizza').id;
  const sushiId = poll.options.find((o) => o.label === 'Sushi').id;

  const vote1 = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: pizzaId } });
  assert.equal(vote1.status, 200);
  const voted = vote1.data.posts.find((p) => p.id === postId);
  assert.equal(voted.options.find((o) => o.id === pizzaId).votes, 1);
  assert.equal(voted.myOptionId, pizzaId);

  // A vote is final - trying to switch to a different option is rejected,
  // and the tally stays exactly as it was after the first vote.
  const vote2 = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: sushiId } });
  assert.equal(vote2.status, 400);
  const after = await api('GET', '/plaza-posts', { token: userToken });
  const stillPizza = after.data.posts.find((p) => p.id === postId);
  assert.equal(stillPizza.options.find((o) => o.id === pizzaId).votes, 1);
  assert.equal(stillPizza.options.find((o) => o.id === sushiId).votes, 0);
  assert.equal(stillPizza.myOptionId, pizzaId);

  // Same rejection even when re-submitting the option already voted for.
  const vote3 = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: pizzaId } });
  assert.equal(vote3.status, 400);

  const badVote = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: 999999 } });
  assert.equal(badVote.status, 400);

  await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
});

test('Plaza posts: only the owner can delete, and deleting one leaves the rest of the feed untouched', async () => {
  const create = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'temporary announcement' } });
  const postId = create.data.id;

  // Regular user cannot delete
  const forbidden = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: userToken });
  assert.equal(forbidden.status, 403);

  // Non-owner admin cannot delete
  const admin2 = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'test-admin-2' } });
  await api('PATCH', `/admin/users/${admin2.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const forbiddenAdmin = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: admin2.data.token });
  assert.equal(forbiddenAdmin.status, 403);

  // Owner can delete
  const del = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
  assert.equal(del.status, 200);

  const after = await api('GET', '/plaza-posts', { token: userToken });
  assert.ok(!after.data.posts.some((p) => p.id === postId), 'deleted post should no longer appear in the feed');

  const missing = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
  assert.equal(missing.status, 404);
});

test('Plaza is gated behind ENABLE_PLAZA - disabled means every endpoint 404s', async () => {
  process.env.ENABLE_PLAZA = 'false';
  try {
    const read = await api('GET', '/plaza-posts', { token: userToken });
    assert.equal(read.status, 404);

    const write = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'should not save' } });
    assert.equal(write.status, 404);

    const vote = await api('POST', '/plaza-posts/1/vote', { token: userToken, body: { optionId: 1 } });
    assert.equal(vote.status, 404);

    const pin = await api('PATCH', '/admin/plaza-posts/1/pin', { token: ADMIN, body: { pinned: true } });
    assert.equal(pin.status, 404);
  } finally {
    process.env.ENABLE_PLAZA = 'true';
  }
});

/* ---------------------------------- Memo ---------------------------------- */
// 5x/day, at a random independent time per user, upload a photo/video
// within 15 minutes of being notified. The scheduler (scheduler.js) is
// what actually flips a slot from "waiting" to "open" in real use - it's
// never started in this test file (only app.js's routes are under test,
// not server.js's cron job), so every slot stays "waiting" until a test
// deliberately marks it notified via a direct DB write, the same way this
// suite handles other time-dependent state.

function markSlotNotified(slotId, when = new Date()) {
  const ts = when.toISOString().replace('T', ' ').replace('Z', '');
  db.prepare('UPDATE memo_slots SET notified_at = ? WHERE id = ?').run(ts, slotId);
}

test('GET /memo/today lazily creates 5 distinct slots, idempotently', async () => {
  const first = await api('GET', '/memo/today', { token: userToken });
  assert.equal(first.status, 200);
  assert.equal(first.data.slots.length, 5);
  assert.ok(first.data.slots.every((s) => s.status === 'waiting'), 'nothing has been notified yet');

  const second = await api('GET', '/memo/today', { token: userToken });
  assert.deepEqual(second.data.slots.map((s) => s.id), first.data.slots.map((s) => s.id), 'a second call must not generate new slots for the same day');
});

test('the 5 daily slots never land close together - each is at least MEMO_MIN_GAP_MINUTES from the next', async () => {
  const ids = (await api('GET', '/memo/today', { token: userToken })).data.slots.map((s) => s.id);
  const rows = db.prepare(`SELECT scheduled_at FROM memo_slots WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY scheduled_at`).all(...ids);
  for (let i = 1; i < rows.length; i++) {
    const gapMinutes = (new Date(`${rows[i].scheduled_at.replace(' ', 'T')}Z`) - new Date(`${rows[i - 1].scheduled_at.replace(' ', 'T')}Z`)) / 60000;
    assert.ok(gapMinutes >= MEMO_MIN_GAP_MINUTES, `expected at least ${MEMO_MIN_GAP_MINUTES}min between consecutive slots, got ${gapMinutes}`);
  }
  // Regression: the window is always "11:00 today" on the calendar, but if
  // the schedule ends up generated later than that (whoever opens the app
  // first that day), anchoring purely to 11:00 would place several slots
  // in the past already, so they'd all fire at once on the next scheduler
  // tick instead of being spread out. None should ever be scheduled before
  // this run could possibly have generated them - can't check against a
  // timestamp taken locally above, since slots are a shared/global
  // schedule now: whichever test in this file happens to call /memo/today
  // first is the one that actually triggers generation, not necessarily
  // this test.
  for (const row of rows) {
    const scheduledMs = new Date(`${row.scheduled_at.replace(' ', 'T')}Z`).getTime();
    assert.ok(scheduledMs >= TEST_RUN_STARTED_AT, `a slot must never be scheduled in the past relative to when it was generated (${row.scheduled_at})`);
  }
});

// The five dots are read left to right as a progress bar, so the states
// have to stay monotonic: everything before the open one is settled
// (done or missed) and everything after it is still waiting. A later slot
// firing while an earlier one is untouched would be nonsense on screen -
// "you missed the third but the second hasn't happened yet".
test("today's slots fire strictly in order, so a later moment can never open before an earlier one", async () => {
  const { default: db } = await import('../src/db.js');
  const { ensureTodaysSlots, triggerNextSlot, MEMO_SLOTS_PER_DAY } = await import('../src/memo.js');
  const { today } = await import('../src/time.js');

  db.prepare('DELETE FROM memo_uploads').run();
  db.prepare('DELETE FROM memo_slots').run();
  ensureTodaysSlots();

  const slots = db.prepare('SELECT slot_index, scheduled_at FROM memo_slots WHERE day = ? ORDER BY slot_index').all(today());
  assert.equal(slots.length, MEMO_SLOTS_PER_DAY);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(
      slots[i].scheduled_at > slots[i - 1].scheduled_at,
      `slot ${i} is scheduled at or before slot ${i - 1} - the dots would fire out of order`
    );
  }

  // The owner's manual trigger must respect the same order, not skip ahead.
  for (let i = 0; i < MEMO_SLOTS_PER_DAY; i++) {
    assert.equal(triggerNextSlot().slotIndex, i, 'trigger-next should always open the earliest unfired slot');
  }
  assert.equal(triggerNextSlot().error, 'err_memo_no_slots_left');

  // And the notified timestamps came out in slot order too.
  const fired = db.prepare('SELECT slot_index, notified_at FROM memo_slots WHERE day = ? ORDER BY notified_at').all(today());
  assert.deepEqual(fired.map((f) => f.slot_index), [0, 1, 2, 3, 4]);

  // This test deliberately fires every slot, which would leave the later
  // tests with nothing un-notified to work against - clear them so the next
  // ensureTodaysSlots() call regenerates a fresh, untouched day.
  db.prepare('DELETE FROM memo_slots').run();
});

// A slot that never fired used to stay "due" indefinitely, with no day
// filter on the query - so a day of downtime, or Memo being switched off and
// back on, would fire every accumulated slot at once. A missed moment stays
// missed.
test('a slot from a previous day is never resurrected as due, however long it sat unfired', async () => {
  const { default: db } = await import('../src/db.js');
  const { getDueSlots, ensureTodaysSlots } = await import('../src/memo.js');
  const { today } = await import('../src/time.js');

  db.prepare('DELETE FROM memo_uploads').run();
  db.prepare('DELETE FROM memo_slots').run();
  db.prepare("INSERT INTO memo_slots (day, slot_index, scheduled_at) VALUES ('2026-01-01', 0, '2026-01-01 12:00:00')").run();

  assert.deepEqual(getDueSlots(), [], "a January slot must not be due in " + today());

  // A genuinely due slot today still fires.
  ensureTodaysSlots();
  db.prepare("UPDATE memo_slots SET scheduled_at = '2020-01-01 00:00:00' WHERE day = ? AND slot_index = 0").run(today());
  const due = getDueSlots();
  assert.equal(due.length, 1);
  assert.equal(due[0].day, today());

  db.prepare('DELETE FROM memo_slots').run();
});

// Memo ships to prod fully working but shut to guests until the party, so
// it can actually be exercised beforehand instead of sitting behind a flag
// nobody can test. Admins are the exception throughout.
test('MEMO_START_DATE hides Memo from guests and silences the scheduler, while admins keep full access', async () => {
  const { memoAvailableTo, memoScheduleActive, memoOpenToEveryone } = await import('../src/memo.js');
  const original = process.env.MEMO_START_DATE;
  const guest = { isAdmin: false }, admin = { isAdmin: true };
  try {
    delete process.env.MEMO_START_DATE;
    assert.equal(memoOpenToEveryone(), true, 'unset means open now - what QA wants');
    assert.equal(memoAvailableTo(guest), true);
    assert.equal(memoScheduleActive(), true);

    process.env.MEMO_START_DATE = '2099-01-01';
    assert.equal(memoAvailableTo(guest), false, 'a guest must not reach Memo before the date');
    assert.equal(memoAvailableTo(admin), true, 'an admin still can, so prod stays testable');
    assert.equal(memoScheduleActive(), false, 'and nobody gets pushed a prompt they cannot open');

    process.env.MEMO_START_DATE = '2000-01-01';
    assert.equal(memoAvailableTo(guest), true, 'once the day arrives it opens to everyone');
    assert.equal(memoScheduleActive(), true);
  } finally {
    if (original === undefined) delete process.env.MEMO_START_DATE;
    else process.env.MEMO_START_DATE = original;
  }
});

// The flag still wins over the date - ENABLE_MEMO off means off for everyone.
test('ENABLE_MEMO=off blocks Memo even for an admin, and even after the start date', async () => {
  const { memoAvailableTo, memoScheduleActive } = await import('../src/memo.js');
  const originalFlag = process.env.ENABLE_MEMO, originalDate = process.env.MEMO_START_DATE;
  try {
    process.env.ENABLE_MEMO = 'false';
    process.env.MEMO_START_DATE = '2000-01-01';
    assert.equal(memoAvailableTo({ isAdmin: true }), false);
    assert.equal(memoScheduleActive(), false);
  } finally {
    if (originalFlag === undefined) delete process.env.ENABLE_MEMO; else process.env.ENABLE_MEMO = originalFlag;
    if (originalDate === undefined) delete process.env.MEMO_START_DATE; else process.env.MEMO_START_DATE = originalDate;
  }
});

test('uploading to a slot that has not been notified yet is rejected', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[1];
  const res = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error, 'err_memo_slot_not_open');
});

test('a slot within its 15-minute window is shared - every guest can upload to it once, but not twice each', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[2];
  markSlotNotified(slot.id);

  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Bystander' } });
  const alsoOk = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: bystander.data.token,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(alsoOk.status, 201, 'a shared slot accepts uploads from any guest, not just one');

  const bystanderAgain = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: bystander.data.token,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo2.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(bystanderAgain.status, 409, 'but not twice for the same guest');
  assert.equal(bystanderAgain.data.error, 'err_memo_already_uploaded');

  const badType = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from('not a photo'),
    filename: 'notes.txt',
    mimeType: 'text/plain',
  });
  assert.equal(badType.status, 400);
  assert.equal(badType.data.error, 'err_memo_invalid_type');

  const ok = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.kind, 'photo');
  const uploadId = ok.data.id;

  const again = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo2.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'err_memo_already_uploaded');

  const refreshed = await api('GET', '/memo/today', { token: userToken });
  const uploadedSlot = refreshed.data.slots.find((s) => s.id === slot.id);
  assert.equal(uploadedSlot.status, 'uploaded');
  assert.equal(uploadedSlot.uploadId, uploadId);

  const own = await apiBuffer(`/memo/uploads/${uploadId}`, { token: userToken });
  assert.equal(own.status, 200);
  assert.deepEqual([...own.buffer], [0xff, 0xd8, 0xff, 0xd9]);

  // Every guest's moments are visible to every other guest via the shared
  // feed, not just the uploader/admins.
  const otherGuest = await apiBuffer(`/memo/uploads/${uploadId}`, { token: bystander.data.token });
  assert.equal(otherGuest.status, 200, 'any logged-in guest can view any upload, via the shared feed');

  const asAdmin = await apiBuffer(`/memo/uploads/${uploadId}`, { token: ADMIN });
  assert.equal(asAdmin.status, 200, 'an admin can view anyone\'s upload');
});

test('the shared Memo feed shows every guest\'s uploads for today with reaction counts, and reacting twice with the same emoji clears it', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[0];
  markSlotNotified(slot.id);
  const ok = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'feed-photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(ok.status, 201);
  const uploadId = ok.data.id;

  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Feed Bystander' } });

  // Sealed until the viewer has posted their own for this moment.
  const locked = await api('GET', '/memo/feed', { token: bystander.data.token });
  assert.equal(locked.status, 200);
  assert.equal(locked.data.locked, true, 'the feed stays locked until the viewer posts');
  assert.deepEqual(locked.data.uploads, [], 'a locked feed hands back nothing at all');

  const bystanderUpload = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: bystander.data.token,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'bystander.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(bystanderUpload.status, 201);

  const feed = await api('GET', '/memo/feed', { token: bystander.data.token });
  assert.equal(feed.status, 200);
  assert.equal(feed.data.locked, false);
  const entry = feed.data.uploads.find((u) => u.id === uploadId);
  assert.ok(entry, 'the feed should include every guest\'s upload, not just the viewer\'s own');
  assert.ok(
    !feed.data.uploads.some((u) => u.id === bystanderUpload.data.id),
    'the viewer\'s own upload is shown by their checklist dot, not repeated in the feed',
  );
  assert.equal(entry.myReaction, null);
  assert.deepEqual(entry.reactions, {});

  const badEmoji = await api('POST', `/memo/uploads/${uploadId}/react`, { token: bystander.data.token, body: { emoji: '💀' } });
  assert.equal(badEmoji.status, 400);
  assert.equal(badEmoji.data.error, 'err_memo_invalid_reaction');

  const react = await api('POST', `/memo/uploads/${uploadId}/react`, { token: bystander.data.token, body: { emoji: '💦' } });
  assert.equal(react.status, 200);
  assert.equal(react.data.emoji, '💦');

  const afterReact = await api('GET', '/memo/feed', { token: bystander.data.token });
  const entryAfter = afterReact.data.uploads.find((u) => u.id === uploadId);
  assert.equal(entryAfter.myReaction, '💦');
  assert.equal(entryAfter.reactions['💦'], 1);

  // Reacting again with the same emoji toggles it off.
  const toggleOff = await api('POST', `/memo/uploads/${uploadId}/react`, { token: bystander.data.token, body: { emoji: '💦' } });
  assert.equal(toggleOff.data.emoji, null);
  const afterToggleOff = await api('GET', '/memo/feed', { token: bystander.data.token });
  const entryToggledOff = afterToggleOff.data.uploads.find((u) => u.id === uploadId);
  assert.equal(entryToggledOff.myReaction, null);
  assert.equal(entryToggledOff.reactions['💦'] || 0, 0);
});

// The reported bug: forcing a moment early left the previous one still
// inside its 15-minute window, so two moments were open at once and you
// could double back to the one you had already let slip.
test('firing a new Memo moment closes the previous one on the spot', async () => {
  // A fresh guest, so no earlier test's upload can turn one of these slots
  // "uploaded" and mask what is being asserted. The day's five slots are
  // shared by everyone and earlier tests have already fired several, so this
  // picks by position and re-fires rather than hunting for untouched ones.
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Window Guest' } });
  const userToken = guest.data.token;
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const [first, second] = data.slots;
  markSlotNotified(first.id);

  const oneOpen = await api('GET', '/memo/today', { token: userToken });
  assert.equal(oneOpen.data.slots.find((s) => s.id === first.id).status, 'open');

  markSlotNotified(second.id);
  const afterSecond = await api('GET', '/memo/today', { token: userToken });
  const openNow = afterSecond.data.slots.filter((s) => s.status === 'open');
  assert.deepEqual(openNow.map((s) => s.id), [second.id], 'exactly one moment is ever open');
  assert.equal(
    afterSecond.data.slots.find((s) => s.id === first.id).status,
    'missed',
    'the older moment is gone the instant a newer one fires, not 15 minutes later',
  );

  // And the closed one really is closed - not just greyed out in the payload.
  const late = await apiUpload(`/memo/slots/${first.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'too-late.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(late.status, 409);
  assert.equal(late.data.error, 'err_memo_slot_not_open');
});

test('the Memo feed is scoped to the current moment - a new one clears what came before', async () => {
  const viewer = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Scope Viewer' } });
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Scope Poster' } });
  const { data } = await api('GET', '/memo/today', { token: viewer.data.token });
  const [older, newer] = data.slots;

  markSlotNotified(older.id);
  const posted = {};
  for (const [who, key] of [[viewer, 'viewer'], [poster, 'poster']]) {
    const up = await apiUpload(`/memo/slots/${older.id}/upload`, {
      token: who.data.token,
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      filename: 'older.jpg',
      mimeType: 'image/jpeg',
    });
    assert.equal(up.status, 201);
    posted[key] = up.data.id;
  }
  // By id, not by count - this slot is shared, and earlier tests have put
  // their own uploads on it.
  const during = await api('GET', '/memo/feed', { token: viewer.data.token });
  const ids = during.data.uploads.map((u) => u.id);
  assert.ok(ids.includes(posted.poster), 'the other guest\'s upload for this moment');
  assert.ok(!ids.includes(posted.viewer), 'not the viewer\'s own');

  // A new moment starts everyone over, including the viewer's own unlock.
  markSlotNotified(newer.id);
  const after = await api('GET', '/memo/feed', { token: viewer.data.token });
  assert.equal(after.data.locked, true, 'the previous moment does not keep the feed unlocked');
  assert.deepEqual(after.data.uploads, [], 'last moment\'s photos are not carried forward');
});

// The client keeps its own copy of the reaction list (app.js renders the
// buttons from it; the server validates against its own). They drifted once
// - the client still listed four after the server was cut to two, so two
// buttons rendered blank and any tap on them was rejected by the API.
test('the reaction list the client renders matches the one the server accepts', async () => {
  const { readFileSync } = await import('node:fs');
  const { MEMO_REACTION_EMOJI } = await import('../src/memo.js');
  const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const literal = source.match(/const MEMO_REACTION_EMOJI = \[(.*?)\];/s);
  assert.ok(literal, 'app.js should still declare MEMO_REACTION_EMOJI as an array literal');
  const clientList = [...literal[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(clientList, MEMO_REACTION_EMOJI);
});

test('a slot missed past its 15-minute window is reported as missed, not open', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[3];
  markSlotNotified(slot.id, new Date(Date.now() - 20 * 60 * 1000));

  const refreshed = await api('GET', '/memo/today', { token: userToken });
  const missedSlot = refreshed.data.slots.find((s) => s.id === slot.id);
  assert.equal(missedSlot.status, 'missed');

  const res = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'late.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error, 'err_memo_slot_not_open');
});

test('admin/owner can see per-day upload counts, download everything as a zip, and upload/view a recap video', async () => {
  await api('GET', '/memo/today', { token: userToken });
  const day = today();

  const days = await api('GET', '/admin/memo/days', { token: ADMIN });
  assert.equal(days.status, 200);
  const todayRow = days.data.days.find((d) => d.day === day);
  assert.ok(todayRow, 'today should show up once at least one slot has been notified');
  assert.ok(todayRow.uploadedCount >= 1);
  assert.equal(todayRow.hasRecap, false);

  const zip = await apiBuffer(`/admin/memo/${day}/uploads.zip`, { token: ADMIN });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const entries = await readZipEntries(zip.buffer);
  assert.ok(entries.length >= 1, 'the zip should contain at least the one uploaded photo');

  // Recap: video-only, any admin can upload it, any logged-in user can watch/download it.
  const badRecapType = await apiUpload(`/admin/memo/${day}/recap`, {
    token: ADMIN,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'not-a-video.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(badRecapType.status, 400);
  assert.equal(badRecapType.data.error, 'err_memo_invalid_type');

  const recapBytes = Buffer.from('fake mp4 bytes');
  const recapUpload = await apiUpload(`/admin/memo/${day}/recap`, {
    token: ADMIN,
    buffer: recapBytes,
    filename: 'recap.mp4',
    mimeType: 'video/mp4',
  });
  assert.equal(recapUpload.status, 201);

  const recapDays = await api('GET', '/memo/recaps', { token: userToken });
  assert.ok(recapDays.data.days.includes(day));

  const recapFetch = await apiBuffer(`/memo/recaps/${day}`, { token: userToken });
  assert.equal(recapFetch.status, 200);
  assert.deepEqual([...recapFetch.buffer], [...recapBytes]);

  const daysAfterRecap = await api('GET', '/admin/memo/days', { token: ADMIN });
  assert.equal(daysAfterRecap.data.days.find((d) => d.day === day).hasRecap, true);
});

test('Memo is gated behind ENABLE_MEMO - disabled means every endpoint 404s', async () => {
  process.env.ENABLE_MEMO = 'false';
  try {
    assert.equal((await api('GET', '/memo/today', { token: userToken })).status, 404);
    assert.equal((await api('GET', '/memo/recaps', { token: userToken })).status, 404);
    assert.equal((await api('GET', '/admin/memo/days', { token: ADMIN })).status, 404);
    assert.equal((await apiUpload('/memo/slots/1/upload', { token: userToken, buffer: Buffer.from('x'), filename: 'x.jpg', mimeType: 'image/jpeg' })).status, 404);
  } finally {
    process.env.ENABLE_MEMO = 'true';
  }
});

test('owner wipe clears every Memo table AND deletes the actual files from disk', async () => {
  // Owner-only permission itself is covered by "a non-owner admin cannot
  // use any feature wipe switch" above - this just checks what the wipe
  // actually does. ADMIN is the seeded owner (see seedResult).
  const before = await api('GET', '/memo/today', { token: userToken });
  const slot = before.data.slots[2]; // already uploaded to in the earlier "accepts one upload" test
  const uploadRow = db.prepare('SELECT file_path FROM memo_uploads WHERE slot_id = ?').get(slot.id);
  assert.ok(uploadRow, 'setup: this slot should already have an upload from an earlier test');
  const absPath = join(MEMO_DIR, uploadRow.file_path);
  assert.ok(existsSync(absPath), 'setup: the file should exist on disk before wiping');

  const asOwner = await api('POST', '/admin/memo/wipe', { token: ADMIN });
  assert.equal(asOwner.status, 200);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_slots').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_uploads').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_recaps').get().n, 0);
  assert.ok(!existsSync(absPath), 'the uploaded file itself should be deleted, not just its DB row');
});

/* --------------------------- Feature wipe switches --------------------------- */
// Runs at the very end (just before rate-limiting, which itself has to be
// last) - each wipe is broad on purpose (every consequence/contestant/
// post/message, not scoped to one night or user), so nothing earlier in
// the file can depend on that data still being there afterward.

test('the owner can wipe each feature independently - only that feature\'s data is cleared, everything else (including user accounts) survives', async () => {
  await api('POST', '/consequences', { token: userToken, body: { text: 'wipe-test consequence' } });
  await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'WipeTestContestant', night: NIGHT } });
  await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'wipe-test post' } });
  await api('POST', '/chat/messages', { token: ADMIN, body: { text: 'wipe-test message' } });

  // Wiping Rata only touches consequences.
  await api('POST', '/admin/consequences/wipe', { token: ADMIN });
  const afterRataWipe = await api('GET', '/admin/consequences', { token: ADMIN });
  assert.equal(afterRataWipe.data.length, 0, 'consequences should be gone after the Rata wipe');
  const contestantsSurvived = await api('GET', `/admin/contestants?night=${NIGHT}`, { token: ADMIN });
  assert.ok(contestantsSurvived.data.contestants.some((c) => c.name === 'WipeTestContestant'), 'Snatch data should survive a Rata-only wipe');

  // Wiping Snatch only touches contestants/votes, both nights.
  await api('POST', '/admin/contestants/wipe', { token: ADMIN });
  const contestantsGone = await api('GET', `/admin/contestants?night=${NIGHT}`, { token: ADMIN });
  assert.equal(contestantsGone.data.contestants.length, 0, 'contestants should be gone after the Snatch wipe');
  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  assert.ok(voting.data.nights.every((n) => n.status === 'closed'), 'Snatch wipe should also close voting for every night');

  // Wiping Wall only touches plaza_posts.
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  const posts = await api('GET', '/admin/plaza-posts', { token: ADMIN });
  assert.equal(posts.data.posts.length, 0, 'posts should be gone after the Wall wipe');

  // Wiping Plaza only touches chat messages.
  await api('POST', '/admin/chat/wipe', { token: ADMIN });
  const messages = await api('GET', '/chat/messages', { token: ADMIN });
  assert.equal(messages.data.messages.length, 0, 'messages should be gone after the Plaza wipe');

  // None of this touched user accounts.
  const users = await api('GET', '/admin/users', { token: ADMIN });
  assert.ok(users.data.some((u) => u.id === userId), 'user accounts must survive every wipe');
});

/* ------------------------------- Rate limiting ------------------------------ */
// Runs last in the file on purpose: it exhausts this IP's shared
// login/auth-guess budget, which would make any *later* test expecting a
// plain 401 for a bad token see 429 instead.

test('guessing tokens against a non-login endpoint is rate-limited too, not just /auth/login', async () => {
  let lastStatus;
  for (let i = 0; i < 12; i++) {
    const r = await api('GET', '/me', { token: `guess-${i}-does-not-exist` });
    lastStatus = r.status;
  }
  assert.equal(lastStatus, 429, 'repeated invalid-token attempts against a non-login endpoint should eventually be rate-limited');
});

test('no push notification copy carries a capital letter - the golden rule survives outside the CSS', async () => {
  // Every other string in the app is lowercased by body { text-transform:
  // lowercase } in styles.css. Push notifications are the one place that
  // rule cannot reach: iOS draws them itself, so a capital in the source
  // ships straight to the lock screen. That is exactly what had happened -
  // "Rata", "Wall", "Snatch", "Plaza", "Atualização" and the Furnished/
  // Swamp night labels were all capitalised while their message bodies
  // were not, so the titles were the only uppercase text in the whole app.
  const { readFileSync } = await import('node:fs');
  const offenders = [];
  for (const file of ['consequences.js', 'routes.js', 'push.js', 'scheduler.js', 'memo.js']) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!/\b(pt|en)\s*:/.test(line)) return;
      for (const [, single, tpl] of line.matchAll(/'([^']*)'|`([^`]*)`/g)) {
        const text = single ?? tpl;
        // ${...} holds names and other data, not copy - judge only the
        // literal words around it.
        if (text && /[A-ZÀ-Ý]/.test(text.replace(/\$\{[^}]*\}/g, ''))) {
          offenders.push(`${file}:${i + 1} ${text}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `notification copy must be lowercase:\n${offenders.join('\n')}`);

  // The night labels reach the lock screen through interpolation, so they
  // are copy too even though they never appear as a pt/en literal.
  const routes = readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
  const labels = [...routes
    .match(/const NIGHT_LABEL = \{[^}]*\}/)[0]
    .matchAll(/'([^']*)'/g)].map(([, v]) => v);
  assert.ok(labels.length, 'the night labels should still be found');
  assert.deepEqual(labels.filter((l) => /[A-ZÀ-Ý]/.test(l)), [], 'night labels reach push bodies and must be lowercase');
});

test('the pt and en dictionaries hold the same keys, once each', async () => {
  // Two Portuguese strings had been pasted into the English block on top of
  // their own keys - plaza_confirm_vote and outfit_nothing_open - leaving en
  // with 416 entries against pt's 414. Nothing broke, because a later
  // duplicate wins in an object literal and the later one happened to be
  // the English, so the mistake was invisible from the app and from every
  // test. It would not have been invisible if the paste had landed the
  // other way round.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
  const ptBlock = src.slice(src.indexOf('  pt: {'), src.indexOf('  en: {'));
  const enBlock = src.slice(src.indexOf('  en: {'));
  const keysOf = (block) => [...block.matchAll(/^ {4}([a-z0-9_]+):/gm)].map(([, k]) => k);

  for (const [lang, block] of [['pt', ptBlock], ['en', enBlock]]) {
    const keys = keysOf(block);
    const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    assert.deepEqual(dupes, [], `${lang} defines these keys more than once: ${dupes.join(', ')}`);
  }

  const pt = keysOf(ptBlock);
  const en = keysOf(enBlock);
  assert.deepEqual(pt.filter((k) => !en.includes(k)), [], 'every Portuguese string needs an English one');
  assert.deepEqual(en.filter((k) => !pt.includes(k)), [], 'and the other way round');
});

test('publishing the night to the Wall waits for both rounds, but not for a round that never ran', async () => {
  // The post carries the podium and the congeniality winner in one
  // snapshot, so going out mid-round would either spoil that round or
  // freeze a half-counted result into something that cannot be rewritten.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Publish Gate A' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Publish Gate B' } });
  for (const u of [a, b]) {
    await api('POST', '/admin/contestants/register', { token: ADMIN, body: { userId: u.data.id, name: `${u.data.name} look`, night } });
  }
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const listed = (await api('GET', `/votes/status?night=${night}`, { token: a.data.token })).data.contestants;
  await api('POST', '/votes', { token: a.data.token, body: { night, contestantId: listed.find((c) => c.name.startsWith('Publish Gate B')).id } });
  // Everyone eligible has to have voted before this can go out, so b votes
  // too. The Wall keeps the post as a snapshot that cannot be rewritten.
  await api('POST', '/votes', { token: b.data.token, body: { night, contestantId: listed.find((c) => c.name.startsWith('Publish Gate A')).id } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });
  for (let i = 0; i < 4; i += 1) await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });

  // Congeniality never opened: nothing to wait for, publishing is fine.
  const noRound = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(noRound.status, 201, 'a night without a congeniality round must still be publishable');

  // Now run one, and it blocks until revealed.
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'open' } });
  const whileOpen = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(whileOpen.status, 400);
  assert.equal(whileOpen.data.error, 'err_congeniality_not_revealed', 'cannot publish while congeniality is still taking votes');

  await api('POST', '/congeniality/vote', { token: a.data.token, body: { night, targetUserId: b.data.id } });
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'closed' } });
  const closedUnrevealed = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(closedUnrevealed.status, 400, 'closed with votes still counted is not finished - the winner is not out yet');

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });
  const revealed = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(revealed.status, 201, 'both rounds finished, so it goes out');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  for (const u of [a, b]) await api('DELETE', `/admin/users/${u.data.id}`, { token: ADMIN });
});

test('a feature can be filled with demo data and cleared again, owner-only', async () => {
  // The point is a final check on prod with something in it, then one press
  // to clear - rather than inventing entries by hand and picking them back
  // out. Seeding is deliberately a no-op when the feature already holds
  // anything, so a double press cannot double the data.
  await api('POST', '/admin/consequences/wipe', { token: ADMIN });

  // Its own admin rather than the file's shared user, whose key several
  // earlier tests regenerate - borrowing it here got a 401 that looked like
  // a permission result and was not one.
  const helper = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Seed Button Helper' } });
  await api('PATCH', `/admin/users/${helper.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const asAdmin = await api('POST', '/admin/consequences/seed-demo', { token: helper.data.token });
  assert.equal(asAdmin.status, 403, 'filling a feature belongs with the owner, like every other danger-zone switch');
  await api('DELETE', `/admin/users/${helper.data.id}`, { token: ADMIN });

  const seeded = await api('POST', '/admin/consequences/seed-demo', { token: ADMIN });
  assert.equal(seeded.status, 200);
  const after = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  assert.ok(after.length > 0, 'the feature should have something in it now');

  const again = await api('POST', '/admin/consequences/seed-demo', { token: ADMIN });
  assert.equal(again.status, 200);
  const afterTwice = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  assert.equal(afterTwice.length, after.length, 'pressing twice must not double the data');

  await api('POST', '/admin/consequences/wipe', { token: ADMIN });
  const cleared = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  assert.equal(cleared.length, 0, 'and the wipe beside it takes it all back out');
});

test('a dedication is private to the birthday person, one per guest, and comes out as a PDF', async () => {
  await api('POST', '/admin/dedications/wipe', { token: ADMIN });
  const ana = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Dedication Ana' } });
  const rui = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Dedication Rui' } });

  // Nothing written yet.
  const empty = await api('GET', '/dedications/mine', { token: ana.data.token });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.dedication, null);

  const written = await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'parabéns, és o maior' } });
  assert.equal(written.status, 200);
  assert.equal(written.data.dedication.text, 'parabéns, és o maior');

  // One each: writing again replaces, it does not add a second.
  await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'pensei melhor: és enorme' } });
  await api('PUT', '/dedications/mine', { token: rui.data.token, body: { text: 'obrigado por tudo' } });
  const all = await api('GET', '/admin/dedications', { token: ADMIN });
  assert.equal(all.data.dedications.length, 2, 'two people wrote, so there are two messages');
  assert.equal(all.data.dedications.find((d) => d.author === 'Dedication Ana').text, 'pensei melhor: és enorme');

  const blank = await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: '   ' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.data.error, 'err_dedication_empty');
  // Deliberately uncapped: this is the one place someone might write at
  // length, and a keepsake cut off mid-sentence is worse than a long entry.
  const long = await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'x'.repeat(4000) } });
  assert.equal(long.status, 200, 'a long message is allowed');
  await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'pensei melhor: és enorme' } });

  // Nobody but the owner reads them - not even an admin, which is the point.
  const helper = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Dedication Nosy Admin' } });
  await api('PATCH', `/admin/users/${helper.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const peek = await api('GET', '/admin/dedications', { token: helper.data.token });
  assert.equal(peek.status, 403, 'an admin has no more business reading these than any other guest');
  const peekPdf = await api('GET', '/admin/dedications.pdf', { token: helper.data.token });
  assert.equal(peekPdf.status, 403);
  // And a guest cannot read even their own back through the admin route.
  assert.equal((await api('GET', '/admin/dedications', { token: rui.data.token })).status, 403);

  // The PDF is a real one, and carries both messages.
  const pdfRes = await fetch(`${base}/admin/dedications.pdf`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(pdfRes.status, 200);
  assert.match(pdfRes.headers.get('content-type'), /application\/pdf/);
  const bytes = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF', 'it has to actually be a PDF, not an error page');
  assert.ok(bytes.length > 800, 'and have something in it');

  await api('POST', '/admin/dedications/wipe', { token: ADMIN });
  const gone = await api('GET', '/admin/dedications.pdf', { token: ADMIN });
  assert.equal(gone.status, 404, 'with nothing written there is no document to make');

  for (const u of [ana, rui, helper]) await api('DELETE', `/admin/users/${u.data.id}`, { token: ADMIN });
});

test('the owner can fill the whole app with demo data and clear it again, accounts included', async () => {
  // The per-feature pairs each cover their own section; this one exists for
  // setting the app up as a demo before a run-through and putting it back
  // afterwards, which means it is the only switch that touches accounts.
  const helper = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Global Wipe Helper' } });
  await api('PATCH', `/admin/users/${helper.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Global Wipe Guest' } });

  assert.equal((await api('POST', '/admin/wipe-everything', { token: helper.data.token })).status, 403,
    'wiping the whole app belongs with the owner');
  assert.equal((await api('POST', '/admin/seed-demo', { token: helper.data.token })).status, 403);

  const wiped = await api('POST', '/admin/wipe-everything', { token: ADMIN });
  assert.equal(wiped.status, 200);

  const left = (await api('GET', '/admin/users', { token: ADMIN })).data;
  assert.ok(left.some((u) => u.is_owner), 'the owner has to survive, or nobody can get back into the panel');
  assert.ok(left.some((u) => u.id === helper.data.id), 'other admins stay - they are people, not demo data');
  assert.ok(!left.some((u) => u.id === guest.data.id), 'guest accounts go');
  assert.equal((await api('GET', '/admin/consequences', { token: ADMIN })).data.length, 0);
  assert.equal((await api('GET', '/plaza-posts', { token: ADMIN })).data.posts.length, 0);

  const seeded = await api('POST', '/admin/seed-demo', { token: ADMIN });
  assert.equal(seeded.status, 200);
  const after = (await api('GET', '/admin/users', { token: ADMIN })).data;
  assert.ok(after.length > left.length, 'seeding brings the guest accounts back');
  assert.ok((await api('GET', '/admin/consequences', { token: ADMIN })).data.length > 0);

  await api('POST', '/admin/wipe-everything', { token: ADMIN });
  await api('DELETE', `/admin/users/${helper.data.id}`, { token: ADMIN });
});
