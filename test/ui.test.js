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
process.env.ADMIN_TOKEN = 'ui-test-admin-token';
process.env.ADMIN_NAME = 'UI Test Admin';
process.env.TIMEZONE = 'Europe/Lisbon';
process.env.ENABLE_ADMIN_PROMOTION = 'true';
process.env.ENABLE_PLAZA = 'true';

const { default: app } = await import('../src/app.js');

const ADMIN = 'ui-test-admin-token';
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
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), token);
  await page.goto(base + path);
  await page.waitForSelector(path === '/settings.html' ? '#admin-content:not(.hidden)' : '#app:not(.hidden)', { timeout: 5000 });
  // First-session tutorial overlay would otherwise intercept every click in
  // tests that aren't specifically testing it - dismiss it if it's showing
  // (language choice first, then skip the content step).
  const langBtn = await page.$('#tutorial-lang-pt');
  if (langBtn && await langBtn.isVisible()) {
    await langBtn.click();
    await page.waitForSelector('#tutorial-content-step:not(.hidden)', { timeout: 5000 });
    await page.click('#tutorial-skip');
    await page.waitForSelector('#tutorial-overlay.hidden', { state: 'attached', timeout: 5000 });
  }
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
    await page.waitForSelector('#login:not(.hidden)', { timeout: 5000 });
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

/* --------------------- First-time key retrieval (register) --------------- */

test('a first-time user can find their name, claim their key, and get logged straight in', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Playwright Newcomer' } });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)');

  await page.click('#find-key-link');
  await page.fill('#token-input', 'playwright newcomer');
  await page.waitForSelector('.find-key-result', { timeout: 5000 });
  await page.click('.find-key-result');

  const modal = page.locator('.modal-overlay:not(.hidden)');
  await modal.waitFor({ timeout: 5000 });
  const revealed = await page.locator('.modal-message').textContent();
  assert.match(revealed, /copiada|copied/i, 'the modal should confirm the key was copied');
  await page.locator('.modal-actions button').first().click();

  await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
  const me = await page.evaluate(async () => {
    const token = localStorage.getItem('appivo_token');
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    return res.json();
  });
  assert.equal(me.name, 'Playwright Newcomer', 'the auto-login after claiming should be the claimed account');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* --------------------------------- Plaza ----------------------------------- */

test('Plaza opens by default and shows a posted announcement in the feed', async () => {
  const post = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'wifi: mossycottage' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');

  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'Plaza should be the tab shown right after logging in');

  await page.waitForSelector('.plaza-post-announcement', { timeout: 5000 });
  const announcementText = await page.$eval('.plaza-post-announcement .plaza-post-text', (el) => el.textContent);
  assert.equal(announcementText, 'wifi: mossycottage');

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${post.id}`, { token: ADMIN });
});

test('Plaza admin can pin an announcement (owner-only), and it floats to the top with a pinned badge', async () => {
  const older = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'older announcement' } });
  const newer = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'newer announcement' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-posts-list .user-row', { timeout: 5000 });

  const olderRow = page.locator('#plaza-posts-list .user-row', { hasText: 'older announcement' });
  await olderRow.locator('[data-pin-post]').click();
  await page.waitForFunction(() => document.querySelectorAll('.plaza-pinned-badge').length === 1);

  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('.plaza-post-announcement.pinned', { timeout: 5000 });

  const firstPostText = await page.$eval('.plaza-post-announcement .plaza-post-text', (el) => el.textContent);
  assert.equal(firstPostText, 'older announcement', 'the pinned announcement should be first, even though it is older');

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${older.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${newer.id}`, { token: ADMIN });
});

test('Plaza admin can publish a poll from Settings, and a user can vote on it from the main feed', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-post-form', { timeout: 5000 });

  await page.click('[data-post-type="poll"]');
  await page.fill('#plaza-post-text', 'Where for dinner?');
  const optionInputs = page.locator('.plaza-poll-option-input');
  await optionInputs.nth(0).fill('Pizza');
  await optionInputs.nth(1).fill('Sushi');
  await page.click('#plaza-post-form button[type="submit"]');
  await page.waitForSelector('#plaza-posts-list .user-row', { timeout: 5000 });

  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('.plaza-post-poll', { timeout: 5000 });

  const questionText = await page.$eval('.plaza-post-poll .plaza-post-text', (el) => el.textContent);
  assert.equal(questionText, 'Where for dinner?');

  await page.click('.plaza-poll-option:has-text("Pizza")');
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
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

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
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

  await page.fill('#user-name-input', 'Zzz Session Tester');
  await page.click('#user-form button[type="submit"]');
  const alertOk = page.locator('.modal-actions button');
  await alertOk.first().waitFor({ timeout: 5000 });
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
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

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
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

  await page.fill('#user-name-input', 'cesar session');
  await page.waitForTimeout(200);
  const names = await page.$$eval('.user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(names.includes('César Session Search'), 'plain-ASCII "cesar" should match the accented name');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

test('Manage Users role filter narrows the list to just that role', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Role Filter Test User' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

  await page.click('#user-role-filter [data-role="owner"]');
  await page.waitForTimeout(200);
  const owners = await page.$$eval('#users-list .badge', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(owners, ['owner'], 'filtering to "owner" should show only the owner row');
  const ownerPillActive = await page.$eval('#user-role-filter [data-role="owner"]', (el) => el.classList.contains('active'));
  assert.ok(ownerPillActive, 'the clicked pill should show as active');

  await page.click('#user-role-filter [data-role="user"]');
  await page.waitForTimeout(200);
  const userRows = await page.$$eval('#users-list .user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(userRows.includes('Role Filter Test User'), 'filtering to "user" should include the plain user just created');
  assert.ok(!userRows.includes('UI Test Admin'), 'filtering to "user" should exclude the owner');
  const ownerPillInactive = await page.$eval('#user-role-filter [data-role="owner"]', (el) => !el.classList.contains('active'));
  assert.ok(ownerPillInactive, 'only one pill should be active at a time');

  await page.click('#user-role-filter [data-role="all"]');
  await page.waitForTimeout(200);
  const allRows = await page.$$('#users-list .user-row');
  assert.ok(allRows.length >= 2, 'switching back to "all roles" should restore the full list');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* --------------- Manage Users key layout (regression) --------------- */

test('Manage Users row keeps the access key visible with no overflow', async () => {
  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

  const tokenVisible = await page.$eval('.user-row-token', (el) => el.getBoundingClientRect().width > 0);
  assert.ok(tokenVisible, 'access key is not visible in the user row');

  const overflow = await horizontalOverflow(page);
  assert.ok(overflow <= 1, `Manage Users overflows by ${overflow}px with the key inline`);
  await context.close();
});

test('access keys are censored by default, reveal on click, and copy automatically at the same time', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

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

/* -------------- Golden rule: non-owner admin UI (regression) ------------- */

test('a non-owner admin gets voting control, reveal-consequence, and a self-only Users view', async () => {
  const promoted = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'nonowneradmin' } });
  await api('PATCH', `/admin/users/${promoted.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, promoted.token, '/settings.html');

  // Sees user management inside Settings now (so they can get familiar with
  // it), but the API only ever returns their own row - see GET /admin/users -
  // so there's nothing here to further lock down on the frontend.
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });
  const rows = await page.$$('#users-list .user-row');
  assert.equal(rows.length, 1, 'non-owner admin should only see their own row in Users');
  const rowActionsCount = await page.$$eval('#users-list .row-actions', (els) => els.length);
  assert.equal(rowActionsCount, 0, 'non-owner admin should get a read-only row, no action buttons');

  // The Wall tab was opened up to admins temporarily for testing - it's
  // owner-only again now, whole tab hidden.
  const wallTabHidden = await page.$eval('[data-atab="wall"]', (el) => el.classList.contains('hidden'));
  assert.ok(wallTabHidden, 'non-owner admin should no longer see the Wall tab');

  const searchCardHidden = await page.$eval('#user-search-card', (el) => el.classList.contains('hidden'));
  assert.ok(searchCardHidden, 'non-owner admin cannot create/search users (owner-only on the backend)');

  const resetCardHidden = await page.$eval('#reset-content-card', (el) => el.classList.contains('hidden'));
  assert.ok(resetCardHidden, 'non-owner admin cannot reset event content (owner-only on the backend)');

  const timezoneCardHidden = await page.$eval('#timezone-card', (el) => el.classList.contains('hidden'));
  assert.ok(!timezoneCardHidden, 'non-owner admin should be able to see and fix the timezone setting too');

  const plazaTabHidden = await page.$eval('[data-atab="plaza"]', (el) => el.classList.contains('hidden'));
  assert.ok(!plazaTabHidden, 'non-owner admin can also post to Plaza now');

  // Voting control (Best Look) and reveal-consequence (A Rata) stay available.
  await page.click('[data-atab="outfit"]');
  const votingControlsVisible = await page.$eval('#voting-advance-btn', (el) => el.getBoundingClientRect().width > 0);
  assert.ok(votingControlsVisible, 'non-owner admin should still see Best Look voting control');

  await page.waitForTimeout(300);
  const voterLogHidden = await page.$eval('#voter-log-card', (el) => el.classList.contains('hidden'));
  assert.ok(voterLogHidden, 'non-owner admin must not see the who-voted-for-whom card');

  await page.click('[data-atab="rata"]');
  const revealBtnVisible = await page.$eval('#reveal-btn', (el) => el.getBoundingClientRect().width > 0);
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

  const roleBadgeHidden = await page.$eval('#role-badge', (el) => el.classList.contains('hidden'));
  assert.ok(roleBadgeHidden, 'plain user should get no role badge, same as the main app');

  await context.close();
});

/* ------------------- Notification deep-link (regression) ----------------- */

test('?tab=&night= deep-links land on the right tab/night, then clean the URL', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.goto(`${base}/?tab=outfit&night=swamp`);
  await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(300);

  const outfitActive = await page.$eval('[data-tab="outfit"]', (el) => el.classList.contains('active'));
  const swampTheme = await page.evaluate(() => document.body.classList.contains('theme-swamp'));
  const cleanedUrl = await page.evaluate(() => location.search);

  assert.ok(outfitActive, 'deep link did not select the outfit tab');
  assert.ok(swampTheme, 'deep link did not apply the swamp night');
  assert.equal(cleanedUrl, '', 'query params were not cleaned up after applying the deep link');
  await context.close();
});

test('a Wall notification\'s ?tab=chat deep link actually opens the Wall', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.goto(`${base}/?tab=chat`);
  await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(300);

  const chatActive = await page.$eval('[data-tab="chat"]', (el) => el.classList.contains('active'));
  assert.ok(chatActive, '?tab=chat should select the Wall tab, same as rata/outfit already do');
  await context.close();
});

test('reloading the page always opens on Plaza, regardless of the last tab used', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.click('[data-tab="chat"]');
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(300);

  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'a reload should always land on Plaza, not wherever was last open');
  await context.close();
});

test('with ENABLE_PLAZA off (prod default), Plaza is hidden in both the main app and Settings, and Rata is the landing tab instead', async () => {
  process.env.ENABLE_PLAZA = 'false';
  try {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN, '/');

    const plazaTabHidden = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('hidden'));
    assert.ok(plazaTabHidden, 'Plaza tab should be hidden in the main app when the flag is off');
    const rataActive = await page.$eval('[data-tab="rata"]', (el) => el.classList.contains('active'));
    assert.ok(rataActive, 'A Rata should be the landing tab instead of Plaza when Plaza is disabled');

    await page.goto(`${base}/settings.html`);
    await page.waitForSelector('#admin-content:not(.hidden)', { timeout: 5000 });
    const plazaAdminTabHidden = await page.$eval('[data-atab="plaza"]', (el) => el.classList.contains('hidden'));
    assert.ok(plazaAdminTabHidden, 'Plaza admin tab should be hidden even for the owner when the flag is off');

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
  await page.waitForSelector('#tutorial-overlay:not(.hidden)', { timeout: 5000 });
  const langStepVisible = await page.$eval('#tutorial-lang-step', (el) => !el.classList.contains('hidden'));
  assert.ok(langStepVisible, 'tutorial should ask for a language before showing content');

  // Picking English should render the actual tour content in English.
  await page.click('#tutorial-lang-en');
  await page.waitForSelector('#tutorial-content-step:not(.hidden)', { timeout: 5000 });
  const firstTitle = await page.$eval('#tutorial-title', (el) => el.textContent);
  assert.ok(firstTitle.length > 0, 'first tutorial step has no title');
  assert.match(firstTitle, /welcome/i, 'choosing English did not render the tour in English');
  let activeDots = await page.$$eval('.tutorial-dots .dot.active', (els) => els.length);
  assert.equal(activeDots, 1, 'exactly one dot should be active at a time');

  // Step through every step via "next" (6 total steps, so 5 clicks to
  // reach the last one; the final "finish" click happens after the loop).
  for (let i = 0; i < 5; i++) {
    const titleBefore = await page.$eval('#tutorial-title', (el) => el.textContent);
    await page.click('#tutorial-next');
    await page.waitForTimeout(100);
    const titleAfter = await page.$eval('#tutorial-title', (el) => el.textContent);
    assert.notEqual(titleAfter, titleBefore, `step ${i + 2} did not render new content`);
  }

  // Last step's button finishes the tutorial instead of advancing further.
  await page.click('#tutorial-next');
  await page.waitForSelector('#tutorial-overlay.hidden', { state: 'attached', timeout: 5000 });

  // Reloading (new "session") must not show it again - it's tied to the account.
  await page.reload();
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(300);
  const stillHidden = await page.$eval('#tutorial-overlay', (el) => el.classList.contains('hidden'));
  assert.ok(stillHidden, 'tutorial reappeared after being completed once');

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
