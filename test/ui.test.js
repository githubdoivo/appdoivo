// UI/UX regression suite. Unlike test/api.test.js (server logic only), this
// drives real rendered pages with Playwright's WebKit engine - the same
// engine iOS Safari uses - so layout/rendering issues that only show up on
// an actual iPhone (not Chromium) get caught here before a deploy.
//
// Run with: npm run test:ui (needs `npx playwright install webkit` once).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { webkit, devices } from 'playwright';

const DB = join(tmpdir(), `appdoivo-ui-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_FILE = DB;
process.env.ADMIN_NAME = 'UI Test Admin';
process.env.ENABLE_ADMIN_PROMOTION = 'true';
process.env.ENABLE_PLAZA = 'true';

const { default: app, seedResult } = await import('../src/app.js');

// The admin's real key is always generated (see seed() in db.js - no more
// ADMIN_TOKEN pinning it, even outside production), so this reads the
// actual generated value off seedResult rather than assuming a fixed
// string.
const ADMIN = seedResult.token;
// GitHub Actions' shared runners occasionally get resource-starved enough
// that a login flow taking well under 5s locally blows past a 5000ms
// waitForSelector everywhere at once (seen firsthand: identical commits
// pass locally every time, then fail in CI with every login-dependent test
// timing out around 5.5-5.7s, and a rerun of the same commit often passes
// clean) - not a real regression, just CI's shared hardware being slower
// on a bad run. `CI` is set by GitHub Actions (and most other CI
// providers) automatically, so this only loosens the timeout there.
const WAIT_TIMEOUT = process.env.CI ? 15000 : 5000;
let server;
let base; // e.g. http://127.0.0.1:PORT (no /api - that's for page navigation)
let browser;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(DB + ext); } catch { /* ignore */ }
  }
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/** New browser context using a real iPhone device profile (viewport, UA, touch, DPR). */
async function iphoneContext(deviceName) {
  return browser.newContext({ ...devices[deviceName] });
}

/** Logs in via localStorage (like the app itself does) and waits for the app shell. */
async function loginPage(context, token, path = '/') {
  // First-session tutorial overlay would otherwise intercept every click in
  // tests that aren't specifically testing it - the tutorial has no skip
  // button by design (see the "no skip" feedback fix), so mark it seen via
  // the API up front instead of clicking through every step.
  await api('POST', '/me/tutorial-seen', { token });
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), token);
  await page.goto(base + path);
  await page.waitForSelector(path === '/settings.html' ? '#admin-content:not(.hidden)' : '#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  return page;
}

/** scrollWidth beyond the viewport means something is overflowing horizontally. */
async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/* ------------------------- No horizontal overflow ------------------------ */
// Sweep real iPhone sizes, smallest to largest, on every top-level screen.

const IOS_DEVICES = ['iPhone SE', 'iPhone 13', 'iPhone 16 Pro Max'];

for (const deviceName of IOS_DEVICES) {
  test(`login screen has no horizontal overflow on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await context.newPage();
    await page.goto(base + '/');
    await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });
    const overflow = await horizontalOverflow(page);
    assert.ok(overflow <= 1, `login screen overflows by ${overflow}px on ${deviceName}`);
    await context.close();
  });

  test(`main app (plaza + rata + best look + chat tabs) has no horizontal overflow on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await loginPage(context, ADMIN, '/');
    const plazaOverflow = await horizontalOverflow(page);
    assert.ok(plazaOverflow <= 1, `"plaza" tab overflows by ${plazaOverflow}px on ${deviceName}`);

    await page.click('[data-tab="rata"]');
    await page.waitForTimeout(150);
    const rataOverflow = await horizontalOverflow(page);
    assert.ok(rataOverflow <= 1, `"a rata" tab overflows by ${rataOverflow}px on ${deviceName}`);

    await page.click('[data-tab="outfit"]');
    await page.waitForTimeout(150);
    const outfitOverflow = await horizontalOverflow(page);
    assert.ok(outfitOverflow <= 1, `"best look" tab overflows by ${outfitOverflow}px on ${deviceName}`);

    await page.click('[data-tab="chat"]');
    await page.waitForTimeout(150);
    const chatOverflow = await horizontalOverflow(page);
    assert.ok(chatOverflow <= 1, `"chat" tab overflows by ${chatOverflow}px on ${deviceName}`);
    await context.close();
  });

  test(`admin panel has no horizontal overflow on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await loginPage(context, ADMIN, '/settings.html');
    const overflow = await horizontalOverflow(page);
    assert.ok(overflow <= 1, `admin panel overflows by ${overflow}px on ${deviceName}`);
    await context.close();
  });
}

/* ---------------------- Topbar icon alignment (regression) --------------- */
// Bell + hamburger used to be nudged into place with per-icon transform
// hacks that kept drifting out of sync. Guard the actual invariant: their
// boxes must be vertically centered on each other.

test('every topbar icon button stays vertically aligned', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  // Push may be "unsupported" in a headless test browser, which hides the
  // bell via .hidden - force it visible to check its box regardless.
  await page.evaluate(() => document.getElementById('notif-btn').classList.remove('hidden'));

  const centers = await page.$$eval('.topbar-actions .icon-btn', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    })
  );
  assert.ok(centers.length >= 4, `expected at least 4 topbar icon buttons, found ${centers.length}`);
  const drift = Math.max(...centers) - Math.min(...centers);
  assert.ok(drift < 2, `topbar icon buttons are ${drift.toFixed(1)}px apart vertically`);
  await context.close();
});

/* ------------------------ Login flash (regression) ------------------------ */
// #login used to be visible by default, so an authenticated user briefly saw
// the login form before the session check resolved. It must ship hidden.

test('#login ships hidden in the raw HTML (no flash before auth check resolves)', async () => {
  const html = await (await fetch(base + '/')).text();
  const match = html.match(/<section id="login" class="([^"]*)"/);
  assert.ok(match, 'could not find #login in the served HTML');
  assert.ok(match[1].split(/\s+/).includes('hidden'), '#login is not hidden by default - it will flash before auth resolves');
});

// Regression: body used to get theme-rata applied unconditionally on boot,
// before the login/auth check resolved - #login's own white background
// couldn't fully mask it, since iOS Safari's rubber-band overscroll paints
// straight from body's background, a region no child element can cover.
test('body carries no night-theme class while the login screen is showing', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)');

  const bodyClasses = await page.evaluate(() => document.body.className);
  assert.doesNotMatch(bodyClasses, /theme-(rata|furnished|swamp|mural|plaza)/, `body should carry no night-theme class pre-login, got: "${bodyClasses}"`);

  await context.close();
});

// Regression: visiting /settings.html with no session used to strand the
// visitor on a dead-end admin page with just an error message - no way
// back to login short of manually navigating to "/" themselves.
test('visiting /settings.html with no session redirects to the login page', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/settings.html');
  await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.equal(new URL(page.url()).pathname, '/', 'should have redirected to the login page');
  await context.close();
});

/* --------------------- First-time key retrieval (register) --------------- */

test('a first-time user can find their name, claim their key, and get logged straight in', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Playwright Newcomer' } });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)');

  await page.click('#find-key-link');
  await page.fill('#token-input', 'playwright newcomer');
  await page.waitForSelector('.find-key-result', { timeout: WAIT_TIMEOUT });
  await page.click('.find-key-result');

  const modal = page.locator('.modal-overlay:not(.hidden)');
  await modal.waitFor({ timeout: WAIT_TIMEOUT });
  const revealed = await page.locator('.modal-message').textContent();
  assert.match(revealed, /copiada|copied/i, 'the modal should confirm the key was copied');
  await page.locator('.modal-actions button').first().click();

  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const me = await page.evaluate(async () => {
    const token = localStorage.getItem('appivo_token');
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    return res.json();
  });
  assert.equal(me.name, 'Playwright Newcomer', 'the auto-login after claiming should be the claimed account');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* ------------------------- Wall (admin posts/polls) ------------------------ */
// Internal id/routes/CSS classes stay "plaza" (see tab_plaza in i18n.js for
// the displayed-vs-internal mapping) - only the label changed to "Wall".

test('Wall opens by default and shows a posted announcement in the feed', async () => {
  const post = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'wifi: mossycottage' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');

  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'Wall should be the tab shown right after logging in');

  await page.waitForSelector('.plaza-post-announcement', { timeout: WAIT_TIMEOUT });
  const announcementText = await page.$eval('.plaza-post-announcement .plaza-post-text', (el) => el.textContent);
  assert.equal(announcementText, 'wifi: mossycottage');

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${post.id}`, { token: ADMIN });
});

test('Wall admin can pin an announcement (owner-only), and it floats to the top with a pinned badge', async () => {
  const older = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'older announcement' } });
  const newer = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'newer announcement' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-posts-list .user-row', { timeout: WAIT_TIMEOUT });

  const olderRow = page.locator('#plaza-posts-list .user-row', { hasText: 'older announcement' });
  await olderRow.locator('[data-pin-post]').click();
  await page.waitForFunction(() => document.querySelectorAll('.plaza-pinned-badge').length === 1);

  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForSelector('.plaza-post-announcement.pinned', { timeout: WAIT_TIMEOUT });

  const firstPostText = await page.$eval('.plaza-post-announcement .plaza-post-text', (el) => el.textContent);
  assert.equal(firstPostText, 'older announcement', 'the pinned announcement should be first, even though it is older');

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${older.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${newer.id}`, { token: ADMIN });
});

test('Wall admin can publish a poll from Settings, and a user can vote on it from the main feed', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-post-form', { timeout: WAIT_TIMEOUT });

  await page.click('[data-post-type="poll"]');
  await page.fill('#plaza-poll-question', 'Where for dinner?');
  const optionInputs = page.locator('.plaza-poll-option-input');
  await optionInputs.nth(0).fill('Pizza');
  await optionInputs.nth(1).fill('Sushi');
  await page.click('#plaza-post-form button[type="submit"]');
  await page.waitForSelector('#plaza-posts-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForSelector('.plaza-post-poll', { timeout: WAIT_TIMEOUT });

  const questionText = await page.$eval('.plaza-post-poll .plaza-post-text', (el) => el.textContent);
  assert.equal(questionText, 'Where for dinner?');

  // Picking an option only stages it - the submit button starts disabled
  // and stays disabled until something is picked, nothing is voted yet.
  const submitBtn = page.locator('.plaza-poll-submit');
  assert.ok(await submitBtn.isDisabled(), 'submit should start disabled - nothing picked yet');
  await page.click('.plaza-poll-option:has-text("Pizza")');
  assert.ok(!(await submitBtn.isDisabled()), 'submit should enable once an option is picked');
  assert.equal(await page.locator('.plaza-poll-option.voted').count(), 0, 'picking an option should not vote by itself');

  await submitBtn.click();
  await page.waitForFunction(() => document.querySelector('.plaza-poll-option.voted')?.textContent.includes('Pizza'));
  const pizzaPct = await page.$eval('.plaza-poll-option.voted .plaza-poll-option-pct', (el) => el.textContent);
  assert.equal(pizzaPct, '100%');

  await context.close();
  const { posts } = await api('GET', '/plaza-posts', { token: ADMIN });
  const created = posts.find((p) => p.text === 'Where for dinner?');
  await api('DELETE', `/admin/plaza-posts/${created.id}`, { token: ADMIN });
});

/* --------------------- Role badge colors (regression) --------------------- */
// owner / admin / user must each render in a visually distinct color.

test('owner, admin and user role badges each render in a distinct color', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'plainuser' } });
  const toPromote = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'futureadmin' } });
  await api('PATCH', `/admin/users/${toPromote.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  const colorOf = (sel) => page.$eval(sel, (el) => getComputedStyle(el).borderColor);
  const ownerColor = await colorOf('.badge.role-owner');
  const adminColor = await colorOf('.badge.role-admin');
  const userColor = await colorOf('.badge.role-user');

  assert.notEqual(ownerColor, adminColor, 'owner and admin badges have the same color');
  assert.notEqual(ownerColor, userColor, 'owner and user badges have the same color');
  assert.notEqual(adminColor, userColor, 'admin and user badges have the same color');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
  await api('PATCH', `/admin/users/${toPromote.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${toPromote.id}`, { token: ADMIN });
});

test('Manage Users: a freshly created user floats to the top of this session\'s list, even though the base order is alphabetical', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.fill('#user-name-input', 'Zzz Session Tester');
  await page.click('#user-form button[type="submit"]');
  const alertOk = page.locator('.modal-actions button');
  await alertOk.first().waitFor({ timeout: WAIT_TIMEOUT });
  await alertOk.first().click();
  await page.waitForTimeout(300);

  const names = await page.$$eval('.user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  // "Zzz Session Tester" sorts last alphabetically, so finding it right
  // after the owner (index 1) proves the session-local recency float is
  // actually happening, not just alphabetical order.
  assert.equal(names[1], 'Zzz Session Tester', 'the just-created user should be pinned near the top this session');

  await context.close();
  const created = await api('GET', '/admin/users', { token: ADMIN });
  const tester = created.find((u) => u.name === 'Zzz Session Tester');
  await api('DELETE', `/admin/users/${tester.id}`, { token: ADMIN });
});

test('clicking a user\'s name renames it in place - no separate rename button', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Original Name' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // Anchor on the token div, not the name span - the span itself gets
  // replaced by an <input> once editing starts, so a locator keyed off
  // its text would stop matching the row mid-interaction.
  const row = page.locator('.user-row', { has: page.locator(`[data-token="${created.token}"]`) });
  await row.locator('.user-row-name-text').click();
  await row.locator('input.user-row-name-text').fill('Renamed Via Click');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  const names = await page.$$eval('.user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(names.includes('Renamed Via Click'), 'clicking the name should have opened an editable field that saved on Enter');
  assert.ok(!names.includes('Original Name'), 'the old name should be gone once renamed');

  const renameButtons = await page.locator('.row-actions button', { hasText: /renom|rename/i }).count();
  assert.equal(renameButtons, 0, 'rename should no longer be a separate button in the row actions');

  await context.close();
  const updated = await api('GET', '/admin/users', { token: ADMIN });
  const renamed = updated.find((u) => u.name === 'Renamed Via Click');
  await api('DELETE', `/admin/users/${renamed.id}`, { token: ADMIN });
});

test('user search ignores accents - "cesar" finds "César"', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'César Session Search' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.fill('#user-name-input', 'cesar session');
  await page.waitForTimeout(200);
  const names = await page.$$eval('.user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(names.includes('César Session Search'), 'plain-ASCII "cesar" should match the accented name');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

test('Manage Users role filter: owner/admin/user pills are cumulative (OR), not exclusive', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Role Filter Test User' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.click('#user-role-filter [data-role="owner"]');
  await page.waitForTimeout(200);
  const owners = await page.$$eval('#users-list .badge', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(owners, ['owner'], 'filtering to "owner" should show only the owner row');

  // Adding "user" on top of "owner" should widen the view (OR), not
  // replace it - both pills stay active, and both roles show up.
  await page.click('#user-role-filter [data-role="user"]');
  await page.waitForTimeout(200);
  const ownerStillActive = await page.$eval('#user-role-filter [data-role="owner"]', (el) => el.classList.contains('active'));
  const userNowActive = await page.$eval('#user-role-filter [data-role="user"]', (el) => el.classList.contains('active'));
  assert.ok(ownerStillActive && userNowActive, 'picking a second role should add to the filter, not replace it');
  const userRows = await page.$$eval('#users-list .user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(userRows.includes('Role Filter Test User'), 'owner+user filter should include the plain user just created');
  assert.ok(userRows.includes('UI Test Admin'), 'owner+user filter should still include the owner');
  const badgesOwnerUser = await page.$$eval('#users-list .badge', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(!badgesOwnerUser.includes('admin'), 'owner+user filter should exclude admins');

  // All three selected should show everyone - same as no filter at all, not
  // an empty/narrow result from ANDing three mutually-exclusive roles
  // together.
  await page.click('#user-role-filter [data-role="admin"]');
  await page.waitForTimeout(200);
  const allThreeRows = await page.$$('#users-list .user-row');
  const unfiltered = await api('GET', '/admin/users', { token: ADMIN });
  assert.equal(allThreeRows.length, unfiltered.length, 'owner+admin+user selected together should match the unfiltered count');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* --------------- Manage Users key layout (regression) --------------- */

test('Manage Users row keeps the access key visible with no overflow', async () => {
  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  const tokenVisible = await page.$eval('.user-row-token', (el) => el.getBoundingClientRect().width > 0);
  assert.ok(tokenVisible, 'access key is not visible in the user row');

  const overflow = await horizontalOverflow(page);
  assert.ok(overflow <= 1, `Manage Users overflows by ${overflow}px with the key inline`);
  await context.close();
});

test('access keys are censored by default, reveal on click, and copy automatically at the same time', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // Spy on the clipboard instead of relying on real OS clipboard access,
  // which needs permissions that aren't reliably grantable in WebKit.
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); };
  });

  const tokenEl = await page.$('.user-row-token');
  const realToken = await tokenEl.getAttribute('data-token');
  const shownBefore = await tokenEl.textContent();
  assert.notEqual(shownBefore, realToken, 'access key should be censored by default');
  assert.match(shownBefore, /^•+$/, 'censored key should render as dots');

  await tokenEl.click();
  await page.waitForTimeout(50);
  const shownAfter = await tokenEl.textContent();
  assert.equal(shownAfter, realToken, 'clicking the censored key should reveal the real value');
  const copiedOnReveal = await page.evaluate(() => window.__copied);
  assert.equal(copiedOnReveal, realToken, 'clicking to reveal should also copy the real key automatically');

  await tokenEl.click();
  const shownHiddenAgain = await tokenEl.textContent();
  assert.match(shownHiddenAgain, /^•+$/, 'clicking again should re-censor it');

  await context.close();
});

// Regression: renderAccountCard() only ran once at boot, so the "A tua
// conta" card kept showing/copying the OLD key after a self-service
// change via the change-key form - one that no longer even worked to log
// in - until a full page reload synced it back up.
test('the account card\'s key updates immediately after a self-service key change', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'accountcardtest' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, created.token, '/settings.html');

  const tokenEl = page.locator('#account-token');
  await tokenEl.click();
  await page.waitForTimeout(50);
  const shownOld = await tokenEl.textContent();
  assert.equal(shownOld, created.token, 'account card should reveal the current real key on click');

  const newKey = 'freshkey789';
  await page.fill('#current-key-input', created.token);
  await page.fill('#new-key-input', newKey);
  await page.click('#change-key-form button[type="submit"]');
  await page.waitForSelector('#change-key-msg:not(:empty)', { timeout: WAIT_TIMEOUT });

  await tokenEl.click(); // re-censor
  await page.waitForTimeout(50);
  await tokenEl.click(); // reveal again
  await page.waitForTimeout(50);
  const shownNew = await tokenEl.textContent();
  assert.equal(shownNew, newKey, 'account card should reflect the new key without a page reload');

  await context.close();
  const updated = await api('GET', '/admin/users', { token: ADMIN });
  const tester = updated.find((u) => u.name === 'accountcardtest');
  await api('DELETE', `/admin/users/${tester.id}`, { token: ADMIN });
});

/* -------------- Golden rule: non-owner admin UI (regression) ------------- */

test('a non-owner admin gets voting control, reveal-consequence, and a self-only Users view', async () => {
  const promoted = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'nonowneradmin' } });
  await api('PATCH', `/admin/users/${promoted.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, promoted.token, '/settings.html');

  // Sees user management inside Settings now (so they can get familiar with
  // it), but the API only ever returns their own row - see GET /admin/users -
  // so there's nothing here to further lock down on the frontend.
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });
  const rows = await page.$$('#users-list .user-row');
  assert.equal(rows.length, 1, 'non-owner admin should only see their own row in Users');
  const rowActionsCount = await page.$$eval('#users-list .row-actions', (els) => els.length);
  assert.equal(rowActionsCount, 0, 'non-owner admin should get a read-only row, no action buttons');

  // The Plaza (pseudonym-unmasking) admin tab - internal id "wall", see
  // tab_chat in i18n.js - was opened up to admins temporarily for testing;
  // it's owner-only again now, whole tab hidden.
  const wallTabHidden = await page.$eval('[data-atab="wall"]', (el) => el.classList.contains('hidden'));
  assert.ok(wallTabHidden, 'non-owner admin should no longer see the Plaza admin tab');

  const searchCardHidden = await page.$eval('#user-search-card', (el) => el.classList.contains('hidden'));
  assert.ok(searchCardHidden, 'non-owner admin cannot create/search users (owner-only on the backend)');

  const resetCardHidden = await page.$eval('#reset-content-card', (el) => el.classList.contains('hidden'));
  assert.ok(resetCardHidden, 'non-owner admin cannot reset event content (owner-only on the backend)');

  const plazaTabHidden = await page.$eval('[data-atab="plaza"]', (el) => el.classList.contains('hidden'));
  assert.ok(!plazaTabHidden, 'non-owner admin can also post to the Wall now');

  // Voting control (Best Look) and reveal-consequence (A Rata) stay available.
  await page.click('[data-atab="outfit"]');
  const votingControlsVisible = await page.$eval('#voting-advance-btn', (el) => el.getBoundingClientRect().width > 0);
  assert.ok(votingControlsVisible, 'non-owner admin should still see Best Look voting control');

  await page.waitForTimeout(300);
  const voterLogHidden = await page.$eval('#voter-log-card', (el) => el.classList.contains('hidden'));
  assert.ok(voterLogHidden, 'non-owner admin must not see the who-voted-for-whom card');

  await page.click('[data-atab="rata"]');
  // Lives in one of two spots depending on state - the standalone slot
  // (nothing revealed yet) or inside the current card (once something is)
  // - so check whichever one is actually visible right now.
  const revealBtnVisible = await page.$$eval('[data-reveal-next]', (els) => els.some((el) => el.getBoundingClientRect().width > 0));
  assert.ok(revealBtnVisible, 'non-owner admin should still see the reveal-consequence button');

  await context.close();
  await api('PATCH', `/admin/users/${promoted.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${promoted.id}`, { token: ADMIN });
});

test('a plain (non-admin) user only sees the Settings tab on /settings.html', async () => {
  const plain = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'plainsettingsuser' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, plain.token, '/settings.html');

  for (const tab of ['plaza', 'outfit', 'rata', 'wall']) {
    const hidden = await page.$eval(`[data-atab="${tab}"]`, (el) => el.classList.contains('hidden'));
    assert.ok(hidden, `plain user should not see the ${tab} tab`);
  }
  const settingsTabHidden = await page.$eval('[data-atab="settings"]', (el) => el.classList.contains('hidden'));
  assert.ok(!settingsTabHidden, 'plain user should see the Settings tab');

  const panelVisible = await page.$eval('#atab-settings', (el) => !el.classList.contains('hidden'));
  assert.ok(panelVisible, 'the Settings panel should be the one shown by default for a plain user');

  const changeKeyCardVisible = await page.$eval('#change-key-card', (el) => !el.classList.contains('hidden'));
  assert.ok(changeKeyCardVisible, 'plain user (no user-management access) should still see the change-key form');

  const usersManagementHidden = await page.$eval('#users-management', (el) => el.classList.contains('hidden'));
  assert.ok(usersManagementHidden, 'plain user should not see the user-management section');

  await context.close();
});

/* --------------------- Live role sync (regression) ------------------------ */

test('a role change made by the owner syncs to an already-open Settings session automatically', async () => {
  // The main app has no role-dependent UI at all (every tab is open to
  // everyone regardless of role - see showApp() in app.js), so this is
  // Settings-only: which admin tabs show does depend on role, synced by
  // its own watcher (see startRoleWatcher() in settings.js).
  const target = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Role Watch Test' } });
  await api('PATCH', `/admin/users/${target.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  await api('POST', '/me/tutorial-seen', { token: target.token });

  const context = await iphoneContext('iPhone 13');

  const settingsPage = await context.newPage();
  await settingsPage.clock.install();
  await settingsPage.goto(base + '/settings.html');
  await settingsPage.evaluate((tok) => localStorage.setItem('appivo_token', tok), target.token);
  await settingsPage.goto(base + '/settings.html');
  await settingsPage.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.ok(await settingsPage.$eval('#users-management', (el) => !el.classList.contains('hidden')), 'should start with admin-only Manage Users visible');

  await api('PATCH', `/admin/users/${target.id}/admin`, { token: ADMIN, body: { isAdmin: false } });

  // Losing admin access entirely sends them away from Settings altogether
  // (no reason to stay on a page built for admins) - lands on the main
  // app's Wall tab rather than reloading into a stripped-down admin view.
  await settingsPage.clock.fastForward('00:31');
  await settingsPage.waitForURL(base + '/', { timeout: WAIT_TIMEOUT });
  await settingsPage.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.ok(await settingsPage.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active')), 'demoted user should land on the Wall tab after being redirected away from Settings');

  await context.close();
  await api('DELETE', `/admin/users/${target.id}`, { token: ADMIN });
});

/* ------------------- Notification deep-link (regression) ----------------- */

test('?tab=&night= deep-links land on the right tab/night, then clean the URL', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.goto(`${base}/?tab=outfit&night=swamp`);
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(300);

  const outfitActive = await page.$eval('[data-tab="outfit"]', (el) => el.classList.contains('active'));
  const swampTheme = await page.evaluate(() => document.body.classList.contains('theme-swamp'));
  const cleanedUrl = await page.evaluate(() => location.search);

  assert.ok(outfitActive, 'deep link did not select the outfit tab');
  assert.ok(swampTheme, 'deep link did not apply the swamp night');
  assert.equal(cleanedUrl, '', 'query params were not cleaned up after applying the deep link');
  await context.close();
});

test('a Plaza notification\'s ?tab=chat deep link actually opens the Plaza', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.goto(`${base}/?tab=chat`);
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(300);

  const chatActive = await page.$eval('[data-tab="chat"]', (el) => el.classList.contains('active'));
  assert.ok(chatActive, '?tab=chat should select the Plaza tab, same as rata/outfit already do');
  await context.close();
});

test('reloading the page always opens on Wall, regardless of the last tab used', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.click('[data-tab="chat"]');
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(300);

  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'a reload should always land on Wall, not wherever was last open');
  await context.close();
});

test('with ENABLE_PLAZA disabled, Wall is hidden in both the main app and Settings, and Rata is the landing tab instead', async () => {
  process.env.ENABLE_PLAZA = 'false';
  try {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN, '/');

    const plazaTabHidden = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('hidden'));
    assert.ok(plazaTabHidden, 'Wall tab should be hidden in the main app when the flag is off');
    const rataActive = await page.$eval('[data-tab="rata"]', (el) => el.classList.contains('active'));
    assert.ok(rataActive, 'A Rata should be the landing tab instead of Wall when the Plaza feature is disabled');

    await page.goto(`${base}/settings.html`);
    await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
    const plazaAdminTabHidden = await page.$eval('[data-atab="plaza"]', (el) => el.classList.contains('hidden'));
    assert.ok(plazaAdminTabHidden, 'Wall admin tab should be hidden even for the owner when the flag is off');

    await context.close();
  } finally {
    process.env.ENABLE_PLAZA = 'true';
  }
});

/* --------------------- Font loading (regression) -------------------- */
// A render-blocking CSS @import caused a visible reflow on font swap; fonts
// must load via a <link> in <head> instead, in parallel with styles.css.

test('fonts load via a <link> in <head>, not a render-blocking @import', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com/, 'no font <link> found in <head>');

  const css = await (await fetch(base + '/css/styles.css')).text();
  assert.doesNotMatch(css, /@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com/, 'styles.css still render-blocks on a Google Fonts @import');
});

/* ------------------------- Version badge (regression) ---------------------- */
// APP_ENV is only ever set to "qa" (see fly.qa.toml) - prod leaves it unset,
// so the badge shows a bare "vX.Y.Z" there and "qa vX.Y.Z" on QA, making the
// environment obvious at a glance on both the login screen and the app.

test('version badge shows a "qa" label when APP_ENV=qa, and stays a bare version otherwise', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForFunction(() => document.getElementById('version-badge').textContent.length > 0);
  const prodLabel = await page.$eval('#version-badge', (el) => el.textContent);
  assert.match(prodLabel, /^v\d+\.\d+\.\d+$/, 'with APP_ENV unset, the badge should be a bare version, no env label');

  process.env.APP_ENV = 'qa';
  try {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('version-badge').textContent.startsWith('qa '));
    const qaLabel = await page.$eval('#version-badge', (el) => el.textContent);
    assert.match(qaLabel, /^qa v\d+\.\d+\.\d+$/, 'with APP_ENV=qa, the badge should be prefixed "qa "');
  } finally {
    delete process.env.APP_ENV;
  }

  await context.close();
});

/* --------------------------- Dark/light mode ------------------------------ */

test('dark/light mode toggles and persists, and gives each night theme its own dark/light variant', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');

  const initialIsDark = await page.evaluate(() => document.documentElement.classList.contains('mode-dark'));
  assert.equal(initialIsDark, false, 'should default to light mode');

  // On the rata tab (theme-rata active), each night theme now has a distinct
  // light AND dark variant (see html.mode-light/html.mode-dark compound
  // selectors in styles.css), so the card color must actually change when
  // the mode toggle is clicked - it should no longer be flattened away, but
  // it should also no longer stay frozen at a single look either.
  const rataCardBg = await page.$eval('.card', (el) => getComputedStyle(el).backgroundColor);

  await page.click('#theme-toggle');
  await page.waitForTimeout(200);
  const afterToggle = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('mode-dark'),
    stored: localStorage.getItem('appivo_mode'),
    cardBg: getComputedStyle(document.querySelector('.card')).backgroundColor,
  }));
  assert.equal(afterToggle.dark, true, 'clicking the toggle should switch to dark mode');
  assert.equal(afterToggle.stored, 'dark', 'the choice should persist to localStorage');
  assert.notEqual(afterToggle.cardBg, rataCardBg, 'theme-rata card color should switch to its dark variant');

  // The choice must still survive a reload.
  await page.reload();
  await page.waitForSelector('#app:not(.hidden)');
  const stillDark = await page.evaluate(() => document.documentElement.classList.contains('mode-dark'));
  assert.equal(stillDark, true, 'dark mode should survive a reload');

  // settings.html has no night theme competing for these variables, so dark
  // mode's own mystique palette (#1f1a2b = rgb(31,26,43)) applies there.
  await page.goto(base + '/settings.html');
  await page.waitForSelector('#admin-content:not(.hidden)');
  const adminCardBg = await page.$eval('.card', (el) => getComputedStyle(el).backgroundColor);
  assert.equal(adminCardBg, 'rgb(31, 26, 43)', 'settings.html should reflect dark mode with no theme to compete with');

  await context.close();
});

/* ------------------------------- Tutorial ---------------------------------- */

test('first-session tutorial shows once, steps through, then never shows again', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'tutorialtestuser' } });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), created.token);
  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)');

  // Shows immediately on a fresh account, asking for a language first.
  await page.waitForSelector('#tutorial-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const langStepVisible = await page.$eval('#tutorial-lang-step', (el) => !el.classList.contains('hidden'));
  assert.ok(langStepVisible, 'tutorial should ask for a language before showing content');

  // Picking English should render the actual tour content in English.
  await page.click('#tutorial-lang-en');
  await page.waitForSelector('#tutorial-content-step:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const firstTitle = await page.$eval('#tutorial-title', (el) => el.textContent);
  assert.ok(firstTitle.length > 0, 'first tutorial step has no title');
  assert.match(firstTitle, /welcome/i, 'choosing English did not render the tour in English');
  let activeDots = await page.$$eval('.tutorial-dots .dot.active', (els) => els.length);
  assert.equal(activeDots, 1, 'exactly one dot should be active at a time');

  // A plain (non-admin, non-owner) account gets no skip - has to read
  // through the whole tour.
  const skipHidden = await page.$eval('#tutorial-skip', (el) => el.classList.contains('hidden'));
  assert.ok(skipHidden, 'a regular user should not see a tutorial skip button');

  // Step through every step via "next" (8 total steps, so 7 clicks to
  // reach the last one; the final "finish" click happens after the loop).
  for (let i = 0; i < 7; i++) {
    const titleBefore = await page.$eval('#tutorial-title', (el) => el.textContent);
    await page.click('#tutorial-next');
    await page.waitForTimeout(100);
    const titleAfter = await page.$eval('#tutorial-title', (el) => el.textContent);
    assert.notEqual(titleAfter, titleBefore, `step ${i + 2} did not render new content`);
  }

  // Last step's button finishes the tutorial instead of advancing further.
  await page.click('#tutorial-next');
  await page.waitForSelector('#tutorial-overlay.hidden', { state: 'attached', timeout: WAIT_TIMEOUT });

  // Reloading (new "session") must not show it again - it's tied to the account.
  await page.reload();
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(300);
  const stillHidden = await page.$eval('#tutorial-overlay', (el) => el.classList.contains('hidden'));
  assert.ok(stillHidden, 'tutorial reappeared after being completed once');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

test('an admin account gets a tutorial skip button, and using it marks the tutorial seen', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'tutorialadmintest' } });
  await api('PATCH', `/admin/users/${created.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), created.token);
  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForSelector('#tutorial-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });

  await page.click('#tutorial-lang-en');
  await page.waitForSelector('#tutorial-content-step:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const skipHidden = await page.$eval('#tutorial-skip', (el) => el.classList.contains('hidden'));
  assert.ok(!skipHidden, 'an admin account should see a tutorial skip button');

  await page.click('#tutorial-skip');
  await page.waitForSelector('#tutorial-overlay.hidden', { state: 'attached', timeout: WAIT_TIMEOUT });

  const me = await api('GET', '/me', { token: created.token });
  assert.ok(me.tutorialSeen, 'skipping should mark the tutorial as seen, same as finishing it');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* ----------------------------------- Chat ---------------------------------- */

test('sending a chat message shows it in the list for another user', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.click('[data-tab="chat"]');
  await page.waitForTimeout(200);

  const unique = `hello-${Date.now()}`;
  await page.fill('#chat-text', unique);
  await page.click('#chat-form button[type=submit]');
  await page.waitForTimeout(300);

  const seenBySender = await page.evaluate(() => document.getElementById('chat-messages').textContent);
  assert.ok(seenBySender.includes(unique), 'sender does not see their own message');

  // Someone else polling should see it too, without sending anything themselves.
  const other = await api('GET', '/chat/messages', { token: ADMIN });
  assert.ok(other.messages.some((m) => m.text === unique));

  await context.close();
});
