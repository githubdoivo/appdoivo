import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Isolated test environment: temporary DB + known admin token.
// (Set BEFORE importing the app, so the seed uses these values.)
const DB = join(tmpdir(), `appdoivo-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_FILE = DB;
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.ADMIN_NAME = 'Test Admin';
process.env.TIMEZONE = 'Europe/Lisbon';
process.env.ENABLE_ADMIN_PROMOTION = 'true';
process.env.ENABLE_PLAZA = 'true';

const { default: app } = await import('../src/app.js');

const ADMIN = 'test-admin-token';
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
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

/* -------------------------------- Version --------------------------------- */

test('GET /version is public and reports env: null when APP_ENV is unset (prod default)', async () => {
  const r = await api('GET', '/version');
  assert.equal(r.status, 200);
  assert.ok(r.data.version);
  assert.equal(r.data.env, null);
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

test('the owner is never searchable via first-time key retrieval', async () => {
  const r = await api('GET', '/auth/unclaimed-users?name=test');
  assert.ok(!r.data.users.some((u) => u.name === 'Test Admin'), 'the owner already has their key from setup');
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
  const open = await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN });
  assert.equal(open.data.votingStatus, 'open');

  const v1 = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v1.status, 201);

  const v2 = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v2.status, 400); // already voted this night

  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  const night = voting.data.nights.find((n) => n.night === NIGHT);
  assert.equal(night.started, true, 'once a night has been opened, it should never look "unstarted" again');
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
  await api('POST', `/admin/voting/${other}/open`, { token: ADMIN });

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

/* --------------------------- Owner content reset -------------------------- */
// Wipes contestants/votes/consequences - runs last so it doesn't disturb
// the shared state the tests above rely on.

test('a non-owner admin can read and change the timezone setting', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const get = await api('GET', '/admin/settings', { token: userToken });
  assert.equal(get.status, 200);
  const put = await api('PUT', '/admin/settings', { token: userToken, body: { timezone: 'Europe/Lisbon' } });
  assert.equal(put.status, 200);
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('a non-owner admin cannot reset event content', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const r = await api('POST', '/admin/reset-content', { token: userToken });
  assert.equal(r.status, 403);
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('the owner can reset event content, users are untouched', async () => {
  const r = await api('POST', '/admin/reset-content', { token: ADMIN });
  assert.equal(r.status, 200);

  const contestants = await api('GET', `/admin/contestants?night=${NIGHT}`, { token: ADMIN });
  assert.equal(contestants.data.contestants.length, 0);

  const consequences = await api('GET', '/admin/consequences', { token: ADMIN });
  assert.equal(consequences.data.length, 0);

  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  assert.ok(voting.data.nights.every((n) => n.status === 'closed'));

  const users = await api('GET', '/admin/users', { token: ADMIN });
  assert.ok(users.data.some((u) => u.id === userId), 'user accounts must survive a content reset');
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

test('Plaza posts: only an admin can delete, and deleting one leaves the rest of the feed untouched', async () => {
  const create = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'temporary announcement' } });
  const postId = create.data.id;

  const forbidden = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: userToken });
  assert.equal(forbidden.status, 403);

  const del = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
  assert.equal(del.status, 200);

  const after = await api('GET', '/plaza-posts', { token: userToken });
  assert.ok(!after.data.posts.some((p) => p.id === postId), 'deleted post should no longer appear in the feed');

  const missing = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
  assert.equal(missing.status, 404);
});

test('Plaza is gated behind ENABLE_PLAZA - off (prod default) means every endpoint 404s', async () => {
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
