// The smallest possible browser test: launch WebKit, open the login screen,
// stop. No session, no database, no API call beyond the one /me that the
// login screen itself makes.
//
// It exists to answer one question the main suite cannot: when 55 UI tests
// fail on CI at the 25s ceiling, is the app slow or is the browser simply
// not usable on that runner? If this fails too, nothing in application code
// is going to fix it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { webkit } from 'playwright';

process.env.TOKEN_SECRET ||= 'test-secret-not-used-anywhere-real';
process.env.DB_FILE = join(tmpdir(), `appdoivo-smoke-${process.pid}.sqlite`);

const { default: app } = await import('../src/app.js');

let server; let base; let browser;
const T = process.env.CI ? 25000 : 5000;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

test('the server answers without a browser in the picture', async () => {
  const started = Date.now();
  const res = await fetch(`${base}/api/version`);
  assert.equal(res.status, 200);
  console.log(`[smoke] /api/version in ${Date.now() - started}ms`);
});

test('WebKit launches', async () => {
  const started = Date.now();
  browser = await webkit.launch();
  console.log(`[smoke] webkit.launch in ${Date.now() - started}ms`);
});

test('a blank page loads in that browser', async () => {
  const page = await browser.newPage();
  const started = Date.now();
  await page.goto('about:blank');
  console.log(`[smoke] about:blank in ${Date.now() - started}ms`);
  await page.close();
});

test('the login screen paints', async () => {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[smoke] console error:', m.text()); });
  page.on('pageerror', (e) => console.log('[smoke] page error:', e.message));
  page.on('requestfailed', (r) => console.log('[smoke] request failed:', r.url(), r.failure()?.errorText));

  let started = Date.now();
  await page.goto(base + '/');
  console.log(`[smoke] goto / in ${Date.now() - started}ms`);

  started = Date.now();
  await page.waitForSelector('#login:not(.hidden)', { timeout: T });
  console.log(`[smoke] #login visible in ${Date.now() - started}ms`);
  await page.close();
});
