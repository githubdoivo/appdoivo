import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from './db.js';
import { authenticate, requireAdmin, requireOwner } from './auth.js';
import { loginRateLimit } from './rateLimit.js';
import { generateUserToken, getSetting, setSetting } from './db.js';
import { hashToken, encryptToken, decryptToken } from './tokens.js';
import { today, nightStatus, getTimezone } from './time.js';
import { NIGHTS, isNight, DEFAULT_NIGHT } from './nights.js';
import {
  revealRandomConsequence,
  currentConsequence,
  pendingCount,
  mySuggestionToday,
} from './consequences.js';
import {
  contestantsForNight,
  myVoteForNight,
  myContestantForNight,
  registerContestant,
  castVote,
  resultsForNight,
  visibleResultsForNight,
  resetResultsPhase,
  advanceResultsPhase,
  getResultsPhase,
} from './votes.js';
import {
  getPublicKey,
  isPushConfigured,
  saveSubscription,
  removeSubscription,
  broadcast,
} from './push.js';
import { listMessages, postMessage, resetPseudonym, wallPseudonymDirectory } from './chat.js';
import { searchUnclaimedUsers, claimKey } from './keyClaim.js';
import { listPlazaPosts, createPlazaPost, deletePlazaPost, castPlazaVote } from './plaza.js';

const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: appVersion } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

/* ---------------------------------- Auth --------------------------------- */

// App version shown as a small on-screen reference (see version.js), so QA
// vs prod mismatches are obvious when reporting a bug. Public - no need to
// be logged in to see it (the login screen shows it too).
router.get('/version', (req, res) => {
  res.json({ version: appVersion });
});

// Validates a token and returns the user.
// Keys are always lowercase (generated that way, and self-service changes
// are forced lowercase below) - normalizing the typed value here makes
// login case-insensitive in practice, so a phone keyboard auto-capitalizing
// the first letter doesn't lock someone out.
router.post('/auth/login', loginRateLimit, (req, res) => {
  const token = (req.body?.token || '').trim().toLowerCase();
  if (!token) return res.status(400).json({ error: 'Token em falta.' });
  const user = db.prepare('SELECT id, name, is_admin FROM users WHERE token_hash = ?').get(hashToken(token));
  if (!user) return res.status(401).json({ error: 'Token invalido.' });
  // Proves they know their key - same claimed-key stamp authenticate()
  // applies (see auth.js), so they stop showing up in the first-time
  // name-search flow (keyClaim.js) from here on.
  db.prepare("UPDATE users SET key_claimed_at = COALESCE(key_claimed_at, strftime('%Y-%m-%d %H:%M:%f', 'now')) WHERE id = ?").run(user.id);
  res.json({ id: user.id, name: user.name, isAdmin: !!user.is_admin });
});

// First-time key retrieval: lets someone who's never logged in find their
// own account by name and get their key, instead of the owner having to
// message everyone individually. Public and unauthenticated by necessity -
// they don't have a key yet. Search itself isn't rate-limited (it doesn't
// reveal a secret, just names of accounts nobody's claimed yet, and needs
// 3+ characters); claiming the actual key shares the login attempt budget,
// same as guessing a token would.
router.get('/auth/unclaimed-users', (req, res) => {
  res.json({ users: searchUnclaimedUsers(req.query.name) });
});

router.post('/auth/claim-key', loginRateLimit, (req, res) => {
  const result = claimKey(Number(req.body?.userId));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Everything below requires authentication.
router.use(authenticate);

router.get('/me', (req, res) => {
  res.json({
    ...req.user,
    adminPromotionEnabled: process.env.ENABLE_ADMIN_PROMOTION === 'true',
    plazaEnabled: process.env.ENABLE_PLAZA === 'true',
  });
});

router.post('/me/tutorial-seen', (req, res) => {
  db.prepare('UPDATE users SET tutorial_seen = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Remembers the user's last-selected app language, so push notifications can
// be sent in it later (see broadcast() in push.js).
router.post('/me/lang', (req, res) => {
  const lang = req.body?.lang === 'en' ? 'en' : 'pt';
  db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.user.id);
  res.json({ ok: true });
});

// Self-service key change - open to every logged-in user, not admin-gated.
// Requires the current key as an extra confirmation layer beyond the bearer
// token itself (e.g. a device left logged in shouldn't let a stranger
// silently take over the account). New key must be letters/numbers only.
router.post('/me/change-token', (req, res) => {
  const currentToken = String(req.body?.currentToken || '').toLowerCase();
  // Keys are always lowercase (see /auth/login) - forcing it here too means
  // the stored key stays canonical regardless of how it was typed/pasted.
  const newToken = String(req.body?.newToken || '').trim().toLowerCase();

  const user = db.prepare('SELECT token_hash FROM users WHERE id = ?').get(req.user.id);
  if (hashToken(currentToken) !== user.token_hash) {
    return res.status(401).json({ error: 'Chave atual incorreta.' });
  }
  if (!/^[a-z0-9]+$/.test(newToken)) {
    return res.status(400).json({ error: 'A nova chave só pode ter letras e números.' });
  }
  if (newToken.length < 4) {
    return res.status(400).json({ error: 'A nova chave deve ter pelo menos 4 caracteres.' });
  }

  const newHash = hashToken(newToken);
  const collision = db.prepare('SELECT id FROM users WHERE token_hash = ? AND id != ?').get(newHash, req.user.id);
  if (collision) {
    return res.status(409).json({ error: 'Essa chave já está em uso. Escolhe outra.' });
  }

  db.prepare("UPDATE users SET token_hash = ?, token_enc = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?")
    .run(newHash, encryptToken(newToken), req.user.id);
  res.json({ ok: true });
});

/* ---------------------------------- Plaza --------------------------------- */
// Owner/admin-authored feed shown on the Plaza tab - the app's landing
// page. Two post types: a plain note (welcome message, wifi password,
// house rules, release notes) and a poll (e.g. picking a dinner spot),
// most-recent-first. Any admin can post, not just the owner.
//
// Gated behind ENABLE_PLAZA - it's being reworked from a single pinned
// note into this real posts feed, so it stays QA-only (see fly.qa.toml)
// until that's ready, rather than living on prod mid-rebuild. Same
// on/off-by-env-var pattern as ENABLE_ADMIN_PROMOTION/SEED_DEMO.

router.get('/plaza-posts', (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'Not found.' });
  res.json({ posts: listPlazaPosts(req.user.id) });
});

router.post('/admin/plaza-posts', requireAdmin, async (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'Not found.' });
  const result = createPlazaPost(req.user.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
  const isPoll = req.body?.type === 'poll';
  await broadcast({
    title: { pt: 'Plaza', en: 'Plaza' },
    body: isPoll
      ? { pt: 'nova sondagem na Plaza - vem votar.', en: 'new poll on the Plaza - come vote.' }
      : { pt: 'o anfitrião deixou uma nova nota na Plaza.', en: 'your host left a new note on the Plaza.' },
    tag: 'plaza-note',
    url: '/?tab=plaza',
  });
});

router.delete('/admin/plaza-posts/:id', requireAdmin, (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'Not found.' });
  const result = deletePlazaPost(Number(req.params.id));
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

router.post('/plaza-posts/:id/vote', (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'Not found.' });
  const result = castPlazaVote(req.user.id, Number(req.params.id), Number(req.body?.optionId));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ posts: listPlazaPosts(req.user.id) });
});

/* ------------------------------ Consequences ----------------------------- */

// Suggest one consequence per day.
router.post('/consequences', (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Escreve uma consequencia.' });
  if (text.length > 200) return res.status(400).json({ error: 'Maximo 200 caracteres.' });

  const existing = mySuggestionToday(req.user.id);
  if (existing) return res.status(409).json({ error: 'Ja sugeriste uma consequencia hoje.' });

  // Explicit millisecond-precision timestamp rather than relying on the
  // table's own DEFAULT - that only takes effect for tables created fresh
  // after this fix, and would silently stay at second-only precision (see
  // GET /admin/consequences's sort) on any database that already existed.
  db.prepare(
    "INSERT INTO consequences (user_id, text, day, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(req.user.id, text, today());
  res.status(201).json({ ok: true });
});

// Currently revealed consequence (everyone sees the same one) + state.
router.get('/consequences/current', (req, res) => {
  res.json({
    current: currentConsequence(),
    pending: pendingCount(),
    mySuggestion: mySuggestionToday(req.user.id),
  });
});

/* --------------------------------- Votes --------------------------------- */

router.get('/votes/status', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const status = nightStatus(night);
  const { phase, results } = status === 'closed'
    ? visibleResultsForNight(night)
    : { phase: null, results: null };
  res.json({
    night,
    status,
    // Whether this night has ever gone through registration/open at least
    // once - lets the frontend tell "hasn't started yet" (status defaults
    // to 'closed' before anything happens) apart from "voting closed after
    // running" (status is 'closed' again, but this time for real).
    started: getSetting(`voting_started_${night}`) === '1',
    contestants: contestantsForNight(night),
    myVote: myVoteForNight(req.user.id, night),
    myContestant: myContestantForNight(req.user.id, night),
    results,
    resultsPhase: phase,
  });
});

// Self-registration for Best Look: everyone (not just admins) can enter
// their own persona/creature-of-the-night, optionally teamed up with
// another user (picked via /users/basic) - see registerContestant() for
// the duo-matching and vote-merging rules.
router.post('/outfit/register', (req, res) => {
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  const result = registerContestant(req.user.id, night, req.body?.name || '', req.body?.partnerUserId);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

// Minimal user list (id + name only, no tokens/roles) for the "team up with"
// picker on Best Look registration - every logged-in user can see it.
router.get('/users/basic', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name FROM users WHERE id != ? ORDER BY name COLLATE NOCASE'
  ).all(req.user.id);
  res.json(rows);
});

router.post('/votes', (req, res) => {
  const contestantId = Number(req.body?.contestantId);
  const night = req.body?.night;
  if (!contestantId) return res.status(400).json({ error: 'Escolhe um concorrente.' });
  const result = castVote(req.user.id, contestantId, night);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true });
});

/* ---------------------------------- Chat ---------------------------------- */
// Open, ephemeral group chat - keeps only the last 15 messages, no time
// expiry (see src/chat.js).

router.get('/chat/messages', (req, res) => {
  res.json({ messages: listMessages() });
});

router.post('/chat/messages', async (req, res) => {
  const result = postMessage(req.user.id, req.body?.text);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true });
  // Announce by pseudonym only - same golden rule as the rest of the Wall,
  // nobody but the owner learns who's behind a post. Skip the poster's own
  // device, they don't need telling about their own message.
  await broadcast({
    title: { pt: 'Wall', en: 'Wall' },
    body: { pt: `${result.pseudonym} acabou de afixar algo novo na wall.`, en: `${result.pseudonym} just pinned something new into the wall.` },
    tag: 'wall',
    url: '/?tab=chat',
  }, { excludeUserId: req.user.id });
});

/* ---------------------------------- Push --------------------------------- */

router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: getPublicKey(), enabled: isPushConfigured() });
});

router.post('/push/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Subscricao invalida.' });
  saveSubscription(req.user.id, sub);
  res.status(201).json({ ok: true });
});

router.post('/push/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) removeSubscription(endpoint);
  res.json({ ok: true });
});

/* --------------------------------- Admin --------------------------------- */

router.use('/admin', requireAdmin);

// Golden rule: nobody but the owner can see OTHER users' access keys, so
// every mutation below (create/rename/regenerate/promote/remove) is locked
// down beyond plain admin. The list itself is the one exception: a regular
// admin can see it too, filtered down to just their own row - lets them get
// familiar with the Users tab/their own entry without exposing anyone
// else's secrets.
router.get('/admin/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, name, token_enc, is_admin, is_owner, created_at FROM users ORDER BY is_owner DESC, name COLLATE NOCASE ASC'
  ).all();
  const visible = req.user.isOwner ? users : users.filter((u) => u.id === req.user.id);
  res.json(visible.map((u) => ({
    id: u.id,
    name: u.name,
    token: decryptToken(u.token_enc),
    is_admin: !!u.is_admin,
    is_owner: !!u.is_owner,
    created_at: u.created_at,
  })));
});

router.use('/admin/users', requireOwner);

router.post('/admin/users', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome em falta.' });
  const token = generateUserToken(name);
  const info = db.prepare(
    "INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(name, hashToken(token), encryptToken(token));
  res.status(201).json({ id: info.lastInsertRowid, name, token });
});

// Fixes a typo or updates a display name - there was previously no way to
// correct a user's name after creation short of deleting and recreating them
// (which would also generate them a new access key).
router.patch('/admin/users/:id/name', (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome em falta.' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilizador nao encontrado.' });
  db.prepare("UPDATE users SET name = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(name, id);
  res.json({ ok: true, id, name });
});

// Issues a brand-new access key for a user (e.g. they think it leaked, or
// someone else claimed it by mistake via the first-time name-search flow).
// Invalidates the previous key immediately, AND reopens that same
// name-search flow for them (key_claimed_at back to NULL) - so recovering
// from a wrongly-claimed key is just "tell the owner, get regenerated,
// find your name again," not the owner manually messaging a new key.
router.post('/admin/users/:id/regenerate-token', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilizador nao encontrado.' });
  const token = generateUserToken(user.name);
  db.prepare("UPDATE users SET token_hash = ?, token_enc = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), key_claimed_at = NULL WHERE id = ?")
    .run(hashToken(token), encryptToken(token), id);
  res.json({ ok: true, id, name: user.name, token });
});

router.delete('/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilizador nao encontrado.' });
  // Only the owner is protected from removal. A promoted admin is still
  // just a regular user with an extra role, so they stay deletable.
  if (user.is_owner) return res.status(400).json({ error: 'Nao podes remover o dono da conta.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Promotes or revokes admin status. Disabled outside environments that opt
// in via ENABLE_ADMIN_PROMOTION. Always keeps at least one admin, and the
// owner can never be demoted, by themselves or anyone else. The golden
// rule (only the owner sees access keys) is enforced separately below
// regardless of this flag.
router.patch('/admin/users/:id/admin', (req, res) => {
  if (process.env.ENABLE_ADMIN_PROMOTION !== 'true') {
    return res.status(403).json({ error: 'Funcionalidade desativada neste ambiente.' });
  }

  const id = Number(req.params.id);
  const isAdmin = !!req.body?.isAdmin;
  const user = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilizador nao encontrado.' });

  if (!isAdmin && user.is_owner) {
    return res.status(400).json({ error: 'Nao podes remover o admin principal.' });
  }

  if (!isAdmin && user.is_admin) {
    const { c: adminCount } = db.prepare('SELECT count(*) c FROM users WHERE is_admin = 1').get();
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Tem de existir sempre pelo menos um admin.' });
    }
  }

  db.prepare("UPDATE users SET is_admin = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(isAdmin ? 1 : 0, id);
  res.json({ ok: true, is_admin: isAdmin });
});

/* ---------------------------------- Wall ---------------------------------- */
// Owner-only: the Wall is anonymous to everyone else, including other
// admins - only the owner can see who's behind each pseudonym.

router.get('/admin/wall-pseudonyms', requireOwner, (req, res) => {
  res.json(wallPseudonymDirectory());
});

// Owner-only: re-rolls a user's Wall pseudonym to a fresh random one, at
// most once a day (see resetPseudonym() in chat.js) - the old one stays in
// their history, it's just no longer the one new posts use.
router.post('/admin/users/:id/wall-pseudonym/reset', requireOwner, (req, res) => {
  const result = resetPseudonym(Number(req.params.id));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Owner-only: wipe game content (contestants, votes, consequences) to start
// a fresh event, without touching user accounts/keys. Production data is
// otherwise permanent (persistent volume, never reset on deploy).
router.post('/admin/reset-content', requireOwner, (req, res) => {
  db.prepare('DELETE FROM contestants').run(); // cascades to votes
  db.prepare('DELETE FROM consequences').run();
  for (const night of NIGHTS) setSetting(`voting_status_${night}`, 'closed');
  res.json({ ok: true });
});

// Votes for a night. Same golden rule as the Wall's real-name mapping:
// only the owner sees who voted for whom - a regular admin only gets the
// aggregate tally/ranking, the same numbers that go public on the Best
// Outfit page once results are revealed. No individual-vote data should
// leak to a role that isn't the owner.
router.get('/admin/votes', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const results = resultsForNight(night);
  if (!req.user.isOwner) {
    return res.json({ night, results });
  }
  const rows = db.prepare(`
    SELECT v.id, v.night, u.name AS voter, c.name AS contestant, v.created_at
    FROM votes v
    JOIN users u ON u.id = v.user_id
    JOIN contestants c ON c.id = v.contestant_id
    WHERE v.night = ?
    ORDER BY v.created_at
  `).all(night);
  res.json({ night, votes: rows, results });
});

// Consequences (full view)
router.get('/admin/consequences', (req, res) => {
  // Most recently touched first - a pending one sorts by when it was
  // suggested, but the moment it's revealed it jumps to the top too
  // (revealed_at, once set, is always more recent than created_at).
  const rows = db.prepare(`
    SELECT c.id, c.text, c.day, c.status, c.revealed_at, u.name AS author
    FROM consequences c JOIN users u ON u.id = c.user_id
    ORDER BY COALESCE(c.revealed_at, c.created_at) DESC
  `).all();
  res.json(rows);
});

// Reveal a consequence manually (for testing).
router.post('/admin/consequences/reveal', async (req, res) => {
  const revealed = await revealRandomConsequence();
  if (!revealed) return res.status(404).json({ error: 'Nao ha consequencias pendentes - ja foi tudo revelado.' });
  res.json({ ok: true, revealed });
});

// Contestants for a night. registered_by/partner_name are set only for
// self-registered entries (see registerContestant() in votes.js) - admin-
// added contestants leave both null, so the owner can tell them apart.
router.get('/admin/contestants', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const rows = db.prepare(`
    SELECT c.id, c.name, c.night, u1.name AS registered_by, u2.name AS partner_name
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? ORDER BY c.name COLLATE NOCASE
  `).all(night);
  res.json({ night, contestants: rows });
});

router.post('/admin/contestants', (req, res) => {
  const name = (req.body?.name || '').trim();
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  if (!name) return res.status(400).json({ error: 'Nome em falta.' });
  const info = db.prepare(
    'INSERT INTO contestants (name, night) VALUES (?, ?)'
  ).run(name, night);
  res.status(201).json({ id: info.lastInsertRowid, name, night });
});

// Renames a contestant (e.g. fixing a typo in a self-registered entry, or
// just reviewing/cleaning up submissions before opening voting).
router.patch('/admin/contestants/:id', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome em falta.' });
  if (name.length > 60) return res.status(400).json({ error: 'Maximo 60 caracteres.' });
  const info = db.prepare('UPDATE contestants SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Concorrente nao encontrado.' });
  res.json({ ok: true });
});

router.delete('/admin/contestants/:id', (req, res) => {
  db.prepare('DELETE FROM contestants WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Settings (timezone/rollover of the "day" used by A Rata)
router.get('/admin/settings', (req, res) => {
  res.json({
    timezone: getTimezone(),
    dayRolloverHour: Number(getSetting('day_rollover_hour', 6)),
  });
});

router.put('/admin/settings', (req, res) => {
  const { timezone, dayRolloverHour } = req.body || {};
  if (timezone !== undefined && String(timezone).trim()) {
    setSetting('timezone', String(timezone).trim());
  }
  if (dayRolloverHour !== undefined) {
    const h = Number(dayRolloverHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return res.status(400).json({ error: 'Hora de rollover invalida (0-23).' });
    setSetting('day_rollover_hour', h);
  }
  res.json({ ok: true });
});

// Per-night voting control (Best Look): status + open / close / reset.
router.get('/admin/voting', (req, res) => {
  res.json({
    nights: NIGHTS.map((night) => ({
      night,
      status: nightStatus(night),
      resultsPhase: getResultsPhase(night),
      // Lets the admin panel tell "never run yet" apart from "closed after
      // running" - both report status 'closed' otherwise (see /votes/status).
      started: getSetting(`voting_started_${night}`) === '1',
    })),
  });
});

const NIGHT_LABEL = { furnished: 'Furnished', swamp: 'Swamp' };

// Opens registration: contestants can self-enter (see POST /outfit/register).
// Voting options stay hidden from everyone until the admin explicitly moves
// on to /open, once they've reviewed/cleaned up the submissions. Wipes any
// votes already cast - reopening registration means a new round is starting
// (maybe a new contestant joins, maybe it's a full redo), so votes tied to
// the previous roster would otherwise linger and skew a later re-tally.
// Contestants themselves are untouched - the admin edits/removes those
// directly in the Contestants table.
router.post('/admin/voting/:night/registration', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  db.prepare('DELETE FROM votes WHERE night = ?').run(night);
  setSetting(`voting_status_${night}`, 'registration');
  setSetting(`voting_started_${night}`, '1');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'registration' });
  await broadcast({
    title: { pt: 'Best Look', en: 'Best Look' },
    body: { pt: `candidaturas abertas - já podes inscrever-te para a noite ${NIGHT_LABEL[night]}!`, en: `entries are open - you can now register for ${NIGHT_LABEL[night]} night!` },
    tag: 'outfit-registration',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

router.post('/admin/voting/:night/open', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  setSetting(`voting_status_${night}`, 'open');
  setSetting(`voting_started_${night}`, '1');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'open' });
  await broadcast({
    title: { pt: 'Best Look', en: 'Best Look' },
    body: { pt: `votação aberta - já podes votar na noite ${NIGHT_LABEL[night]}!`, en: `voting is open - you can now vote for ${NIGHT_LABEL[night]} night!` },
    tag: 'outfit-voting',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

// Closing just stops voting - it does NOT reveal anything yet. The admin
// reveals results in stages afterwards via /reveal-next.
router.post('/admin/voting/:night/close', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  setSetting(`voting_status_${night}`, 'closed');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'closed' });
  await broadcast({
    title: { pt: 'Best Look', en: 'Best Look' },
    body: { pt: `votação encerrada - a noite ${NIGHT_LABEL[night]} encerrou, os resultados vêm aí.`, en: `voting closed - ${NIGHT_LABEL[night]} night is done, results coming soon.` },
    tag: 'outfit-closed',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

const REVEAL_NOTIFY = {
  third: { pt: 'já sabes quem ficou em 3º lugar!', en: 'the 3rd place result is in!' },
  second: { pt: 'já sabes quem ficou em 2º lugar!', en: 'the 2nd place result is in!' },
  first: { pt: 'já sabes quem ficou em 1º lugar!', en: 'the 1st place result is in!' },
  all: { pt: 'já podes ver quem venceu o Best Look!', en: 'you can now see who won Best Look!' },
};

// Advances the results reveal one stage: hidden -> third -> second -> first
// -> all. Every stage past 'hidden' is worth telling people about - that's
// the whole point of staging it like an awards countdown.
router.post('/admin/voting/:night/reveal-next', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  const phase = advanceResultsPhase(night);
  res.json({ ok: true, night, resultsPhase: phase });
  if (REVEAL_NOTIFY[phase]) {
    await broadcast({
      title: { pt: 'Best Look', en: 'Best Look' },
      body: REVEAL_NOTIFY[phase],
      tag: 'results',
      url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
    });
  }
});

// Reset voting: wipes this night's votes and reopens voting, but keeps the
// contestant roster - for redoing a vote without making everyone re-enter.
router.post('/admin/voting/:night/reset', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  db.prepare('DELETE FROM votes WHERE night = ?').run(night);
  setSetting(`voting_status_${night}`, 'open');
  setSetting(`voting_started_${night}`, '1');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'open' });
});

// Reset all: wipes the contestant roster too (cascades to votes), and
// returns the night to its never-started state - a true blank slate, for
// when the whole night needs redoing from scratch, entries included.
router.post('/admin/voting/:night/reset-all', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  db.prepare('DELETE FROM contestants WHERE night = ?').run(night);
  setSetting(`voting_status_${night}`, 'closed');
  setSetting(`voting_started_${night}`, '0');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'closed' });
});

export default router;
