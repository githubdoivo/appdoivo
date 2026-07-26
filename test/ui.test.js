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

  test(`main app (rata + best outfit + chat tabs) has no horizontal overflow on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await loginPage(context, ADMIN, '/');
    const rataOverflow = await horizontalOverflow(page);
    assert.ok(rataOverflow <= 1, `"a rata" tab overflows by ${rataOverflow}px on ${deviceName}`);

    await page.click('[data-tab="outfit"]');
    await page.waitForTimeout(150);
    const outfitOverflow = await horizontalOverflow(page);
    assert.ok(outfitOverflow <= 1, `"best outfit" tab overflows by ${outfitOverflow}px on ${deviceName}`);

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
  assert.doesNotMatch(bodyClasses, /theme-(rata|furnished|swamp|mural)/, `body should carry no night-theme class pre-login, got: "${bodyClasses}"`);

  await context.close();
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

test('access keys are censored by default and reveal on click, but the real value is always copyable', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: 5000 });

  const tokenEl = await page.$('.user-row-token');
  const realToken = await tokenEl.getAttribute('data-token');
  const shownBefore = await tokenEl.textContent();
  assert.notEqual(shownBefore, realToken, 'access key should be censored by default');
  assert.match(shownBefore, /^•+$/, 'censored key should render as dots');

  await tokenEl.click();
  const shownAfter = await tokenEl.textContent();
  assert.equal(shownAfter, realToken, 'clicking the censored key should reveal the real value');

  await tokenEl.click();
  const shownHiddenAgain = await tokenEl.textContent();
  assert.match(shownHiddenAgain, /^•+$/, 'clicking again should re-censor it');

  // Copy must work with the real value regardless of the censored/revealed
  // display state - it reads data-copy-user on the button, not the toggle.
  const copyBtn = await page.$('[data-copy-user]');
  const copyValue = await copyBtn.getAttribute('data-copy-user');
  assert.equal(copyValue, realToken, 'copy button should carry the real key even while censored');

  await context.close();
});

/* -------------- Golden rule: non-owner admin UI (regression) ------------- */

test('a non-owner admin only gets voting control and reveal-consequence, nothing else', async () => {
  const promoted = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'nonowneradmin' } });
  await api('PATCH', `/admin/users/${promoted.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, promoted.token, '/settings.html');

  const usersTabHidden = await page.$eval('[data-atab="users"]', (el) => el.classList.contains('hidden'));
  assert.ok(usersTabHidden, 'non-owner admin can see the Manage Users tab');

  const wallTabHidden = await page.$eval('[data-atab="wall"]', (el) => el.classList.contains('hidden'));
  assert.ok(wallTabHidden, 'non-owner admin can see the Wall tab');

  const timezoneCardHidden = await page.$eval('#timezone-card', (el) => el.classList.contains('hidden'));
  assert.ok(timezoneCardHidden, 'non-owner admin can see the timezone settings card');

  // Voting control (Best Outfit) and reveal-consequence (A Rata) stay available.
  await page.click('[data-atab="outfit"]');
  const votingControlsVisible = await page.$eval('#voting-open-btn', (el) => el.getBoundingClientRect().width > 0);
  assert.ok(votingControlsVisible, 'non-owner admin should still see Best Outfit voting control');

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

  for (const tab of ['users', 'outfit', 'rata', 'wall']) {
    const hidden = await page.$eval(`[data-atab="${tab}"]`, (el) => el.classList.contains('hidden'));
    assert.ok(hidden, `plain user should not see the ${tab} tab`);
  }
  const settingsTabHidden = await page.$eval('[data-atab="settings"]', (el) => el.classList.contains('hidden'));
  assert.ok(!settingsTabHidden, 'plain user should see the Settings tab');

  const panelVisible = await page.$eval('#atab-settings', (el) => !el.classList.contains('hidden'));
  assert.ok(panelVisible, 'the Settings panel should be the one shown by default for a plain user');

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

/* --------------------- Font loading (regression) -------------------- */
// A render-blocking CSS @import caused a visible reflow on font swap; fonts
// must load via a <link> in <head> instead, in parallel with styles.css.

test('fonts load via a <link> in <head>, not a render-blocking @import', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com/, 'no font <link> found in <head>');

  const css = await (await fetch(base + '/css/styles.css')).text();
  assert.doesNotMatch(css, /@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com/, 'styles.css still render-blocks on a Google Fonts @import');
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
