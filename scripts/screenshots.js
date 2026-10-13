// Regenerates the README screenshots and the walkthrough recording in docs/.
// Boots the app on a throwaway database with the demo seed, drives it with
// Playwright WebKit on an iPhone 13 profile, and writes:
//   docs/screenshots/*.jpg   - one per screen
//   docs/demo.mp4, demo.gif  - a short walkthrough (needs ffmpeg)
//
//   npm run screenshots
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { webkit, devices } from 'playwright';

const tmp = mkdtempSync(join(tmpdir(), 'appdoivo-shots-'));
process.env.DB_FILE = join(tmp, 'app.sqlite');
process.env.TOKEN_SECRET ||= 'screenshots-only-secret';
process.env.ADMIN_NAME = 'Host';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_PLAZA = 'true';
process.env.ENABLE_MEMO = 'true';

const { default: app, seedResult } = await import('../src/app.js');
const { seedDemo } = await import('../src/seedDemo.js');
const { generateDemoUserToken } = await import('../src/db.js');
seedDemo();

const OUT = join(process.cwd(), 'docs');
const SHOTS = join(OUT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const server = createServer(app).listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const OWNER = seedResult.token;
const GUEST = generateDemoUserToken('Alice Moreira');

async function api(method, path, token, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// Snatch with voting open, so the screenshot shows the contestant list.
await api('POST', '/admin/voting/furnished/open', OWNER, { force: true });
for (const token of [OWNER, GUEST]) await api('POST', '/me/tutorial-seen', token);

const browser = await webkit.launch();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(context, token, lang = 'en') {
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate(([tok, l]) => {
    localStorage.setItem('appivo_lang', l);
    if (tok) localStorage.setItem('appivo_token', tok);
  }, [token, lang]);
  return page;
}

async function tab(page, name) {
  await page.click(`.tab[data-tab="${name}"]`);
  await page.waitForSelector(`#tab-${name}:not(.hidden)`);
  await pause(600);
}

// --- Screenshots -----------------------------------------------------------
{
  const context = await browser.newContext({ ...devices['iPhone 13'] });

  const login = await newPage(context, null);
  await login.reload();
  await login.waitForSelector('#token-input');
  await pause(500);
  await login.screenshot({ path: join(SHOTS, '1-login.jpg'), quality: 80 });

  const page = await newPage(context, GUEST);
  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)');
  await pause(800);
  await page.screenshot({ path: join(SHOTS, '2-wall.jpg'), quality: 80 });
  for (const [i, name] of [[3, 'rata'], [4, 'outfit'], [5, 'chat']]) {
    await tab(page, name);
    await page.screenshot({ path: join(SHOTS, `${i}-${name}.jpg`), quality: 80 });
  }

  const admin = await newPage(context, OWNER);
  await admin.goto(base + '/settings.html');
  await admin.waitForSelector('#admin-content:not(.hidden)');
  await admin.click('.tab[data-atab="outfit"]');
  await admin.waitForSelector('#atab-outfit:not(.hidden)');
  await pause(800);
  await admin.screenshot({ path: join(SHOTS, '6-admin.jpg'), quality: 80 });
  await context.close();
}

// --- Walkthrough recording ---------------------------------------------------
{
  const videoDir = join(tmp, 'video');
  const { viewport } = devices['iPhone 13'];
  const context = await browser.newContext({ ...devices['iPhone 13'], recordVideo: { dir: videoDir, size: viewport } });
  const page = await newPage(context, null);
  await page.reload();
  await page.waitForSelector('#token-input');
  await pause(800);
  await page.type('#token-input', GUEST, { delay: 70 });
  await pause(400);
  await page.click('#login-submit-btn');
  await page.waitForSelector('#app:not(.hidden)');
  await pause(1800);
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'smooth' }));
  await pause(1200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  for (const name of ['rata', 'outfit', 'chat']) {
    await tab(page, name);
    await pause(1600);
  }
  await page.click('#theme-toggle');
  await pause(1500);
  await page.click('#lang-toggle');
  await pause(1500);
  await tab(page, 'plaza');
  await pause(1200);
  await context.close();

  const [file] = readdirSync(videoDir);
  const webm = join(videoDir, file);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', join(OUT, 'demo.mp4')]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf',
      'fps=12,scale=300:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      join(OUT, 'demo.gif')]);
  } catch {
    renameSync(webm, join(OUT, 'demo.webm'));
    console.log('ffmpeg not found - kept the raw docs/demo.webm instead.');
  }
}

await browser.close();
server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote screenshots to ${SHOTS} and the walkthrough to ${OUT}.`);
