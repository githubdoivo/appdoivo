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
import { listMessages, postMessage } from './chat.js';

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
router.post('/auth/login', loginRateLimit, (req, res) => {
  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Token em falta.' });
  const user = db.prepare('SELECT id, name, is_admin FROM users WHERE token_hash = ?').get(hashToken(token));
  if (!user) return res.status(401).json({ error: 'Token invalido.' });
  res.json({ id: user.id, name: user.name, isAdmin: !!user.is_admin });
});

// Everything below requires authentication.
router.use(authenticate);

router.get('/me', (req, res) => {
  res.json({ ...req.user, adminPromotionEnabled: process.env.ENABLE_ADMIN_PROMOTION === 'true' });
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
  const currentToken = String(req.body?.currentToken || '');
  const newToken = String(req.body?.newToken || '').trim();

  const user = db.prepare('SELECT token_hash FROM users WHERE id = ?').get(req.user.id);
  if (hashToken(currentToken) !== user.token_hash) {
    return res.status(401).json({ error: 'Chave atual incorreta.' });
  }
  if (!/^[A-Za-z0-9]+$/.test(newToken)) {
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

/* ------------------------------ Consequences ----------------------------- */

// Suggest one consequence per day.
router.post('/consequences', (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Escreve uma consequencia.' });
  if (text.length > 200) return res.status(400).json({ error: 'Maximo 200 caracteres.' });

  const existing = mySuggestionToday(req.user.id);
  if (existing) return res.status(409).json({ error: 'Ja sugeriste uma consequencia hoje.' });

  db.prepare(
    'INSERT INTO consequences (user_id, text, day) VALUES (?, ?, ?)'
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
    contestants: contestantsForNight(night),
    myVote: myVoteForNight(req.user.id, night),
    results,
    resultsPhase: phase,
  });
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
// Open, ephemeral group chat - messages expire after 5 minutes or once
// there are more than 20, whichever comes first (see src/chat.js).

router.get('/chat/messages', (req, res) => {
  res.json({ messages: listMessages() });
});

router.post('/chat/messages', (req, res) => {
  const result = postMessage(req.user.id, req.body?.text);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true });
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

// Golden rule: nobody but the owner can see other users' access keys, so
// user management (which exposes them) is locked down beyond plain admin.
router.use('/admin/users', requireOwner);

// Users
router.get('/admin/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, name, token_enc, is_admin, is_owner, created_at FROM users ORDER BY is_owner DESC, updated_at DESC'
  ).all();
  res.json(users.map((u) => ({
    id: u.id,
    name: u.name,
    token: decryptToken(u.token_enc),
    is_admin: !!u.is_admin,
    is_owner: !!u.is_owner,
    created_at: u.created_at,
  })));
});

router.post('/admin/users', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome em falta.' });
  const token = generateUserToken(name);
  const info = db.prepare(
    "INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(name, hashToken(token), encryptToken(token));
  res.status(201).json({ id: info.lastInsertRowid, name, token });
});

// Issues a brand-new access key for a user (e.g. they think it leaked).
// Invalidates the previous key immediately - the caller is responsible for
// getting the new one to them.
router.post('/admin/users/:id/regenerate-token', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilizador nao encontrado.' });
  const token = generateUserToken(user.name);
  db.prepare("UPDATE users SET token_hash = ?, token_enc = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?")
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
  const rows = db.prepare(`
    SELECT name, wall_pseudonym
    FROM users
    WHERE wall_pseudonym IS NOT NULL
    ORDER BY name ASC
  `).all();
  res.json(rows.map((r) => ({ name: r.name, pseudonym: r.wall_pseudonym })));
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

// Votes for a night (full admin view)
router.get('/admin/votes', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const rows = db.prepare(`
    SELECT v.id, v.night, u.name AS voter, c.name AS contestant, v.created_at
    FROM votes v
    JOIN users u ON u.id = v.user_id
    JOIN contestants c ON c.id = v.contestant_id
    WHERE v.night = ?
    ORDER BY v.created_at
  `).all(night);
  res.json({ night, votes: rows, results: resultsForNight(night) });
});

// Consequences (full view)
router.get('/admin/consequences', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.text, c.day, c.status, c.revealed_at, u.name AS author
    FROM consequences c JOIN users u ON u.id = c.user_id
    ORDER BY c.status = 'pending' DESC, c.created_at DESC
  `).all();
  res.json(rows);
});

// Reveal a consequence manually (for testing).
router.post('/admin/consequences/reveal', async (req, res) => {
  const revealed = await revealRandomConsequence();
  if (!revealed) return res.status(404).json({ error: 'Nao ha consequencias pendentes - ja foi tudo revelado.' });
  res.json({ ok: true, revealed });
});

// Contestants for a night
router.get('/admin/contestants', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const rows = db.prepare(
    'SELECT id, name, night FROM contestants WHERE night = ? ORDER BY name'
  ).all(night);
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

// Per-night voting control (Best Outfit): status + open / close / reset.
router.get('/admin/voting', (req, res) => {
  res.json({
    nights: NIGHTS.map((night) => ({
      night,
      status: nightStatus(night),
      resultsPhase: getResultsPhase(night),
    })),
  });
});

router.post('/admin/voting/:night/open', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  setSetting(`voting_status_${night}`, 'open');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'open' });
});

// Closing just stops voting - it does NOT reveal anything yet. The admin
// reveals results in stages afterwards via /reveal-next.
router.post('/admin/voting/:night/close', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  setSetting(`voting_status_${night}`, 'closed');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'closed' });
});

// Advances the results reveal one stage: hidden -> third -> second -> first
// -> all. The "winner" notification only fires once everyone can be seen.
router.post('/admin/voting/:night/reveal-next', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  const phase = advanceResultsPhase(night);
  if (phase === 'all') {
    await broadcast({
      title: { pt: 'resultados revelados', en: 'results revealed' },
      body: { pt: 'já podes ver quem venceu o Best Outfit!', en: 'you can now see who won Best Outfit!' },
      tag: 'results',
      url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
    });
  }
  res.json({ ok: true, night, resultsPhase: phase });
});

router.post('/admin/voting/:night/reset', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  db.prepare('DELETE FROM votes WHERE night = ?').run(night);
  setSetting(`voting_status_${night}`, 'open');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'open' });
});

export default router;
