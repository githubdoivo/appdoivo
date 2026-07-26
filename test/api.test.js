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

test('a normal user cannot access the admin panel', async () => {
  const r = await api('GET', '/admin/users', { token: userToken });
  assert.equal(r.status, 403);
});

test('Manage Users list: owner pinned first, then most recently created/updated', async () => {
  const older = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Older' } });
  const newer = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Newer' } });

  const list1 = await api('GET', '/admin/users', { token: ADMIN });
  assert.equal(list1.data[0].is_owner, true, 'owner must be first');
  assert.equal(list1.data[1].id, newer.data.id, 'most recently created user comes right after the owner');

  // Touch "older" (role change) so it becomes the most recently updated.
  await api('PATCH', `/admin/users/${older.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  await api('PATCH', `/admin/users/${older.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });

  const list2 = await api('GET', '/admin/users', { token: ADMIN });
  assert.equal(list2.data[1].id, older.data.id, 'the user just updated moves back to the top');

  await api('DELETE', `/admin/users/${older.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${newer.data.id}`, { token: ADMIN });
});

test('promoting a user grants admin access, but not owner-only Manage Users access', async () => {
  const promote = await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  assert.equal(promote.status, 200);
  assert.equal(promote.data.is_admin, true);

  // General admin access: works.
  const votes = await api('GET', '/admin/votes', { token: userToken });
  assert.equal(votes.status, 200);

  // Golden rule: only the owner sees other users' access keys.
  const users = await api('GET', '/admin/users', { token: userToken });
  assert.equal(users.status, 403);
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

/* -------------------------------- Voting --------------------------------- */

const NIGHT = 'furnished';

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

/* --------------------------- Owner content reset -------------------------- */
// Wipes contestants/votes/consequences - runs last so it doesn't disturb
// the shared state the tests above rely on.

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
