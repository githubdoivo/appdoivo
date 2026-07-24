import { Router } from 'express';
import db from './db.js';
import { authenticate, requireAdmin } from './auth.js';
import { loginRateLimit } from './rateLimit.js';
import { generateToken, getSetting, setSetting } from './db.js';
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
} from './votes.js';
import {
  getPublicKey,
  isPushConfigured,
  saveSubscription,
  removeSubscription,
  broadcast,
} from './push.js';

const router = Router();

/* ---------------------------------- Auth --------------------------------- */

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
  res.json(req.user);
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
  res.json({
    night,
    status,
    contestants: contestantsForNight(night),
    myVote: myVoteForNight(req.user.id, night),
    results: status === 'closed' ? resultsForNight(night) : null,
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

// Users
router.get('/admin/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, name, token_enc, is_admin, created_at FROM users ORDER BY is_admin DESC, name'
  ).all();
  res.json(users.map((u) => ({
    id: u.id,
    name: u.name,
    token: decryptToken(u.token_enc),
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  })));
});

router.post('/admin/users', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome em falta.' });
  const token = generateToken();
  const info = db.prepare(
    'INSERT INTO users (name, token_hash, token_enc, is_admin) VALUES (?, ?, ?, 0)'
  ).run(name, hashToken(token), encryptToken(token));
  res.status(201).json({ id: info.lastInsertRowid, name, token });
});

router.delete('/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilizador nao encontrado.' });
  if (user.is_admin) return res.status(400).json({ error: 'Nao podes remover o admin.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
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
    nights: NIGHTS.map((night) => ({ night, status: nightStatus(night) })),
  });
});

router.post('/admin/voting/:night/open', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  setSetting(`voting_status_${night}`, 'open');
  res.json({ ok: true, night, votingStatus: 'open' });
});

router.post('/admin/voting/:night/close', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  setSetting(`voting_status_${night}`, 'closed');
  await broadcast({
    title: 'período de votação encerrado',
    body: 'we got a winner!',
    tag: 'results',
    url: '/',
  });
  res.json({ ok: true, night, votingStatus: 'closed' });
});

router.post('/admin/voting/:night/reset', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'Noite invalida.' });
  db.prepare('DELETE FROM votes WHERE night = ?').run(night);
  setSetting(`voting_status_${night}`, 'open');
  res.json({ ok: true, night, votingStatus: 'open' });
});

export default router;
