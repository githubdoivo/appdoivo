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
process.env.ENABLE_MEMO = 'true';

const { default: app, seedResult } = await import('../src/app.js');
const { default: db } = await import('../src/db.js');
const { MEMO_DIR } = await import('../src/memo.js');

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
// Bumped again (15000 -> 25000): 15000 was itself hit repeatedly on bad
// runs (every login-dependent test failing at ~15.6-15.9s, consistently,
// while the same commit had passed a different CI run minutes earlier) -
// not further evidence of a real bug, just this shared hardware needing
// still more headroom on its worse days.
const WAIT_TIMEOUT = process.env.CI ? 25000 : 5000;
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
  try { rmSync(MEMO_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
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

  test(`main app (plaza + rata + best look + chat + memo tabs) has no horizontal overflow on ${deviceName}`, async () => {
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

    await page.click('[data-tab="memo"]');
    await page.waitForTimeout(150);
    const memoOverflow = await horizontalOverflow(page);
    assert.ok(memoOverflow <= 1, `"memo" tab overflows by ${memoOverflow}px on ${deviceName}`);
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

/* ------------------- Brand logo fits the viewport (regression) ----------- */
// document-level scrollWidth (the check above) can pass even when the logo
// itself is too wide, because .topbar's flex-wrap just drops topbar-actions
// to its own line below - the page never scrolls horizontally, but the
// logo's own box still overflows past both edges. Check its own
// bounding rect directly, on the narrowest real device, since a fixed
// rem size that looks fine at a wide viewport can still not fit a phone.

for (const deviceName of IOS_DEVICES) {
  test(`brand logo never overflows the viewport on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await loginPage(context, ADMIN, '/');
    const { left, right, viewportWidth } = await page.evaluate(() => {
      const r = document.querySelector('.brand-name').getBoundingClientRect();
      return { left: r.left, right: r.right, viewportWidth: window.innerWidth };
    });
    assert.ok(left >= -1, `brand logo starts off the left edge (left=${left.toFixed(1)}) on ${deviceName}`);
    assert.ok(right <= viewportWidth + 1, `brand logo extends off the right edge (right=${right.toFixed(1)}, viewport=${viewportWidth}) on ${deviceName}`);
    await context.close();
  });
}

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

  // Manage Users is owner-only - a regular admin's own row is all the API
  // would ever return them anyway (see GET /admin/users), with no actions
  // on it either, so it would just be a read-only duplicate of the account
  // card already at the top of this page. Whole section hidden instead.
  await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('[data-atab="settings"]');
  await page.waitForTimeout(300);
  const usersManagementHidden = await page.$eval('#users-management', (el) => el.classList.contains('hidden'));
  assert.ok(usersManagementHidden, 'non-owner admin should not see Manage Users at all - it would just duplicate the account card');

  // The Plaza (pseudonym-unmasking) admin tab - internal id "wall", see
  // tab_chat in i18n.js - was opened up to admins temporarily for testing;
  // it's owner-only again now, whole tab hidden.
  const wallTabHidden = await page.$eval('[data-atab="wall"]', (el) => el.classList.contains('hidden'));
  assert.ok(wallTabHidden, 'non-owner admin should no longer see the Plaza admin tab');

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
  // Manage Users is owner-only (this target is admin, not owner) - check a
  // tab a regular admin does see instead, as the "currently admin" signal.
  assert.ok(await settingsPage.$eval('[data-atab="outfit"]', (el) => !el.classList.contains('hidden')), 'should start with admin tabs visible');

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

test('a notification click while the app is already open switches tabs via postMessage, not just navigate()', async () => {
  // iOS Safari's service worker Client.navigate() often silently no-ops
  // when the PWA is already in the foreground (a real WebKit limitation) -
  // sw.js also postMessage()s the deep link so the already-open page can
  // apply it itself (see the message listener in app.js). Simulate that
  // message directly, without any navigation, since there's no real
  // service worker controller to trigger it through in this test harness.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  const plazaActiveBefore = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActiveBefore, 'should start on Wall/plaza, same as any fresh login');

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'deep-link', url: '/?tab=rata' } })
    );
  });
  await page.waitForTimeout(200);

  const rataActive = await page.$eval('[data-tab="rata"]', (el) => el.classList.contains('active'));
  assert.ok(rataActive, 'the simulated postMessage should have switched to the Rata tab without a page reload');
  assert.equal(page.url(), `${base}/`, 'this path must not navigate/reload - only the in-page tab should change');
  await context.close();
});

test('opening the app always lands on Wall, whatever tab was last used', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.click('[data-tab="chat"]');
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(300);

  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'opening the app should land on Wall, like an app opening on its home tab');
  // The tab isn't remembered at all any more, so nothing should be left
  // behind to resume from either.
  const stored = await page.evaluate(() => localStorage.getItem('appivo_tab'));
  assert.equal(stored, null, 'the last-used tab should no longer be persisted');
  await context.close();
});

test('a first login lands on Wall by default', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'the default landing tab should be Wall');
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

  // Step through every step via "next" (9 total steps with Memo enabled -
  // see tutorialSteps() in app.js - so 8 clicks to reach the last one; the
  // final "finish" click happens after the loop).
  for (let i = 0; i < 8; i++) {
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

/* ------------------- Snatch: photo required at registration --------------- */

// Smallest possible real PNG (1x1 transparent pixel) - resizePhotoToJpeg()
// runs it through an actual <canvas>, so a fake/truncated buffer wouldn't
// decode; this needs to be genuinely valid, unlike api.test.js's fake-magic-
// bytes fixture which only has to pass the server's own check.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

/** Clicks a button that opens a file input (registerPhotoBtnSelector triggers
 * a hidden <input type=file> via .click(), same as a real tap would) and
 * feeds it a file through Playwright's native file-chooser interception -
 * exercising the actual click -> OS/browser picker -> change event path,
 * not just setInputFiles() on the underlying input directly. That
 * distinction matters here: the input is hidden off-screen for a styled
 * button to stand in for it (see .file-input-visually-hidden in
 * styles.css), and a hidden-via-display:none input silently failing to
 * open on iOS Safari when .click()'d programmatically is a real, previously
 * unrelated failure mode setInputFiles() can't detect since it bypasses the
 * click/open step entirely. */
async function pickPhotoViaButton(page, buttonSelector, file) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click(buttonSelector),
  ]);
  await chooser.setFiles(file);
}

test('Snatch registration warns on a missing name, requires a photo, previews it once attached via the real picker button, and blocks submitting without one', async () => {
  const night = 'furnished';
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo UI Tester' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="outfit"]');
  await page.waitForSelector('#register-form', { timeout: WAIT_TIMEOUT });

  // No name at all - this used to fail silently (a bare `return`, no
  // message), which reads exactly like a dead/disabled submit button.
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const nameAlertText = await page.textContent('.modal-message');
  assert.ok(/name|nome/i.test(nameAlertText), 'submitting without a name should say one is required, not silently do nothing');
  await page.click('.modal-actions button');

  // Name filled, no photo yet - submitting should warn, not register.
  await page.fill('#register-name', 'Ghost of Photos Past');
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const alertText = await page.textContent('.modal-message');
  assert.ok(/photo|foto/i.test(alertText), 'submitting without a photo should say one is required, not silently fail');
  await page.click('.modal-actions button');

  // The file input starts genuinely absent from the file chooser flow until
  // the styled "choose photo" button is clicked - it's the button, not the
  // input, a real tap lands on.
  await pickPhotoViaButton(page, '#register-photo-btn', { name: 'outfit.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.waitForSelector('#register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]', { timeout: WAIT_TIMEOUT });
  // The thumbnail alone is easy to miss on a small screen - a plain
  // confirmation line has to be there too.
  const previewText = await page.textContent('#register-photo-preview');
  assert.ok(/photo|foto/i.test(previewText), 'attaching a photo should say so in text, not just show a thumbnail');

  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('#register-area .highlight', { timeout: WAIT_TIMEOUT });
  const entryText = await page.textContent('#register-area .highlight');
  assert.ok(entryText.includes('Ghost of Photos Past'), 'entry should register once a photo is attached');

  // The registrant can always preview their own entry's photo.
  await page.waitForSelector('#register-area .entry-photo-preview', { timeout: WAIT_TIMEOUT });

  // Either half of a duo can swap the photo later via the same
  // button-triggers-hidden-input pattern - covered here too since it's the
  // exact mechanism that broke. Byte-for-byte replacement is already
  // covered server-side (api.test.js); what matters here is that the real
  // click -> file-chooser -> PUT round trip completes without erroring.
  await pickPhotoViaButton(page, '#change-photo-btn', { name: 'new-outfit.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible('.modal-overlay:not(.hidden)'), false, 'replacing the photo should not surface an error');
  const status = await api('GET', `/votes/status?night=${night}`, { token: user.token });
  assert.equal(status.myContestant.hasPhoto, true, 'the entry should still have a photo after replacing it');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('a Best Look poll tick landing while a photo is picked does not wipe the in-progress name/photo', async () => {
  // Reproduces a real bug: Best Look polls for updates every 4s
  // (outfitPollTimer), and picking a photo hands control to the OS
  // camera/library picker - which blurs focus, defeating the "skip while
  // typing" guard, and for however long the user is away. A poll landing
  // in that gap used to fully rebuild the blank registration form,
  // silently wiping the name field and the just-attached photo - reported
  // on a real iPhone as "erases the name box, photo doesn't upload,
  // nothing works". Attaching via setInputFiles() here (not the
  // button-triggering-a-filechooser dance used above) is deliberate: this
  // test is about surviving a poll tick mid-interaction, not about the
  // click-opens-a-picker mechanism the other test already covers.
  const night = 'furnished';
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Poll Race Tester' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="outfit"]');
  await page.waitForSelector('#register-form', { timeout: WAIT_TIMEOUT });

  await page.fill('#register-name', 'Surviving The Poll');
  // Blurring simulates the focus loss a real native picker sheet causes -
  // the activeElement guard alone no longer protects the form past this
  // point, same as it wouldn't on a real device.
  await page.evaluate(() => document.activeElement?.blur());
  // Longer than outfitPollTimer's 4000ms interval, so at least one poll
  // tick is guaranteed to land before checking the field survived it.
  await page.waitForTimeout(4500);
  assert.equal(await page.inputValue('#register-name'), 'Surviving The Poll', 'a poll tick should not wipe the name field');

  await page.setInputFiles('#register-photo-input', { name: 'outfit.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.waitForSelector('#register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(4500);
  assert.ok(
    await page.isVisible('#register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]'),
    'a poll tick should not clear the attached photo preview either'
  );

  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('#register-area .highlight', { timeout: WAIT_TIMEOUT });
  const entryText = await page.textContent('#register-area .highlight');
  assert.ok(entryText.includes('Surviving The Poll'), 'the entry should register with the name/photo that survived the poll');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('once results start revealing, "you voted for X" clears instead of sitting on top of the results list', async () => {
  const night = 'furnished';
  const voter = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Reveal Vote Tester' } });
  const contestantOwner = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Reveal Contestant Owner' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  // A direct API call (not going through the client's resize step - see
  // resizePhotoToJpeg()), so this needs to already look like a real JPEG to
  // the server's own magic-byte check, unlike PNG_1X1 above.
  const fakeJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  const reg = await api('POST', '/outfit/register', {
    token: contestantOwner.token,
    body: { name: 'Reveal Target', night, photoBase64: fakeJpeg },
  });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN });
  await api('POST', '/votes', { token: voter.token, body: { contestantId: reg.id, night } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, voter.token);
  await page.click('[data-tab="outfit"]');

  // Closed, not revealed yet - the "you voted for X" message is exactly
  // what tells the voter their vote landed, so it stays up here.
  await page.waitForSelector('#vote-area .highlight', { timeout: WAIT_TIMEOUT });
  assert.ok((await page.textContent('#vote-area .highlight')).includes('Reveal Target'), 'should show who was voted for before any reveal');

  // Advance through every reveal stage (hidden -> third -> second -> first
  // -> all) regardless of how many contestants exist.
  for (let i = 0; i < 4; i++) {
    await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  }
  await page.waitForSelector('#results-card:not(.hidden) .tier li', { timeout: WAIT_TIMEOUT });
  // The results list is now showing the same information - repeating it
  // in the vote area above is just clutter once that's true.
  const voteAreaEmpty = await page.evaluate(() => document.getElementById('vote-area').innerHTML.trim() === '');
  assert.ok(voteAreaEmpty, 'the "you voted for X" message should clear once results start revealing');
  // The whole votação card (not just the vote-area within it) is redundant
  // now too - it was still showing its "closed" status line on top of the
  // results card until this was fixed.
  assert.equal(await page.isVisible('#voting-card'), false, 'the votação card should hide entirely once results are revealed');
  // With only one contestant, they're both 1st place and the only result -
  // gold medal included.
  const firstResultText = await page.textContent('#results-list li');
  assert.ok(firstResultText.includes('🥇'), 'the winner should get a gold medal emoji in the reveal');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('the admin voting-advance button always confirms first - a misclick declined leaves the night untouched', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  await page.waitForSelector('#voting-advance-btn', { timeout: WAIT_TIMEOUT });

  // Declining the confirm on "open" should leave registration exactly as
  // it was - nothing about the night should have changed underneath.
  await page.click('#voting-advance-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button.ghost');
  const afterDecline = await api('GET', '/admin/voting', { token: ADMIN });
  assert.equal(afterDecline.nights.find((n) => n.night === night).status, 'registration', 'declining the confirm should not have opened voting');

  // Confirming should actually perform it.
  await page.click('#voting-advance-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button:not(.ghost)');
  await page.waitForFunction(
    () => document.getElementById('voting-state-label')?.classList.contains('is-open'),
    { timeout: WAIT_TIMEOUT }
  );
  const afterConfirm = await api('GET', '/admin/voting', { token: ADMIN });
  assert.equal(afterConfirm.nights.find((n) => n.night === night).status, 'open', 'confirming should have opened voting');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('the admin download-photos button shows progress, triggers a real download, and reports errors inline', async () => {
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  // Default night is furnished - switch to the empty one first to check
  // the error path before adding a photo to check the success path.
  await page.click('[data-night="swamp"]');
  await page.waitForTimeout(200);

  await page.click('#download-photos-btn');
  await page.waitForFunction(
    () => document.getElementById('download-photos-msg')?.textContent.length > 0,
    { timeout: WAIT_TIMEOUT }
  );
  const errorText = await page.textContent('#download-photos-msg');
  assert.ok(/photo|foto/i.test(errorText), 'a night with no photos yet should report that inline, not fail silently');
  assert.ok(await page.evaluate(() => document.getElementById('download-photos-msg').classList.contains('error')), 'the error state should be styled as an error');

  // Now with an actual photo, the button should trigger a real download.
  const owner = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Download Flow Persona' } });
  const fakeJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  await api('POST', '/outfit/register', { token: owner.token, body: { name: 'Download Flow Target', night, photoBase64: fakeJpeg } });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download-photos-btn'),
  ]);
  assert.equal(download.suggestedFilename(), `snatch-${night}-photos.zip`);
  // Hardcoded PT text rather than importing the client's t() into this
  // Node context - ADMIN's account language defaults to pt, same as every
  // other test in this file that checks rendered copy.
  await page.waitForFunction(
    () => document.getElementById('download-photos-msg')?.textContent === 'descarregado.',
    { timeout: WAIT_TIMEOUT }
  );
  assert.equal(await page.evaluate(() => document.getElementById('download-photos-msg').classList.contains('error')), false);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

/* ---------------------------------- Memo ----------------------------------- */
// 5x/day, at a random independent time per user, a slot opens for 15
// minutes to upload a photo/video. The scheduler cron isn't running in
// this test process (only app.js, not server.js) - slots are forced open
// the same way api.test.js does, with a direct DB write.

function markMemoSlotNotified(slotId, when = new Date()) {
  const ts = when.toISOString().replace('T', ' ').replace('Z', '');
  db.prepare('UPDATE memo_slots SET notified_at = ? WHERE id = ?').run(ts, slotId);
}

test('Memo: a guest can shoot an open moment, it shows in the shared feed, another guest can react, and the owner publishes its video to the Wall', async () => {
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo UI Tester' } });
  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo UI Bystander' } });
  const today = await api('GET', '/memo/today', { token: user.token });
  const slot = today.slots[0];
  markMemoSlotNotified(slot.id);

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="memo"]');
  await page.waitForSelector('#memo-dots', { timeout: WAIT_TIMEOUT });

  await page.waitForSelector(`[data-memo-upload-btn="${slot.id}"]`, { timeout: WAIT_TIMEOUT });
  await page.setInputFiles(`[data-memo-file-input="${slot.id}"]`, { name: 'moment.png', mimeType: 'image/png', buffer: PNG_1X1 });
  // The dot swaps from open to uploaded once the upload lands (see
  // renderMemoDots() in app.js) - waiting for the class change beats a
  // fixed sleep.
  await page.waitForSelector(`.memo-dot-uploaded`, { timeout: WAIT_TIMEOUT });

  // It shows up in today's shared feed for everyone, not just the uploader.
  await page.waitForSelector('#memo-feed-card:not(.hidden) [data-memo-react]', { timeout: WAIT_TIMEOUT });
  const uploadId = await page.getAttribute('[data-memo-react]', 'data-memo-react');

  const bystanderPage = await loginPage(context, bystander.token);
  await bystanderPage.click('[data-tab="memo"]');
  await bystanderPage.waitForSelector(`[data-memo-react="${uploadId}"]`, { timeout: WAIT_TIMEOUT });
  await bystanderPage.click(`[data-memo-react="${uploadId}"][data-emoji="🔥"]`);
  await bystanderPage.waitForFunction(
    (id) => document.querySelector(`[data-memo-react="${id}"][data-emoji="🔥"]`)?.textContent.includes('1'),
    uploadId,
    { timeout: WAIT_TIMEOUT }
  );

  const adminPage = await loginPage(context, ADMIN, '/settings.html');
  await adminPage.click('[data-atab="memo"]');
  await adminPage.waitForSelector('#memo-days-list', { timeout: WAIT_TIMEOUT });
  await adminPage.waitForFunction(
    () => /\d\/\d/.test(document.getElementById('memo-days-list')?.textContent || ''),
    { timeout: WAIT_TIMEOUT }
  );
  const [download] = await Promise.all([
    adminPage.waitForEvent('download'),
    adminPage.click('[data-memo-download-day]'),
  ]);
  assert.ok(download.suggestedFilename().endsWith('.zip'));

  // Publishing the day's video is a Wall admin action, not a Memo one -
  // see the "Vídeo do dia" card added to atab-plaza in settings.html.
  await adminPage.click('[data-atab="plaza"]');
  await adminPage.waitForSelector('#wall-memo-video-card:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await adminPage.waitForFunction(
    () => document.getElementById('wall-memo-video-day')?.options.length > 0,
    { timeout: WAIT_TIMEOUT }
  );
  await adminPage.setInputFiles('#wall-memo-video-input', {
    name: 'recap.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('fake mp4 bytes'),
  });
  await adminPage.waitForFunction(
    () => document.getElementById('wall-memo-video-msg')?.textContent.length > 0,
    { timeout: WAIT_TIMEOUT }
  );

  // Any logged-in guest (not just the uploader/admin) sees it on the Wall.
  await page.click('[data-tab="plaza"]');
  await page.waitForFunction(
    () => !document.getElementById('wall-video-card')?.classList.contains('hidden')
      && document.getElementById('wall-video-list')?.querySelector('video'),
    { timeout: WAIT_TIMEOUT }
  );

  await api('POST', '/admin/memo/wipe', { token: ADMIN });
  await context.close();
});

test('Memo is gated behind ENABLE_MEMO - hidden from the tab bar and the admin panel when disabled', async () => {
  process.env.ENABLE_MEMO = 'false';
  try {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN, '/');
    assert.equal(await page.isVisible('[data-tab="memo"]'), false);
    const adminPage = await loginPage(context, ADMIN, '/settings.html');
    assert.equal(await adminPage.isVisible('[data-atab="memo"]'), false);
    await context.close();
  } finally {
    process.env.ENABLE_MEMO = 'true';
  }
});
