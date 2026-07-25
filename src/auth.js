import db from './db.js';
import { hashToken } from './tokens.js';

/**
 * Token authentication middleware.
 * Accepts "Authorization: Bearer <token>" or "?token=" (for the service worker).
 */
export function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const token = bearer || req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Token em falta.' });
  }

  const user = db.prepare('SELECT id, name, is_admin, is_owner, tutorial_seen, lang FROM users WHERE token_hash = ?').get(hashToken(token));
  if (!user) {
    return res.status(401).json({ error: 'Token invalido.' });
  }

  req.user = {
    id: user.id,
    name: user.name,
    isAdmin: !!user.is_admin,
    isOwner: !!user.is_owner,
    tutorialSeen: !!user.tutorial_seen,
    lang: user.lang,
  };
  next();
}

/** Middleware that requires admin privileges. */
export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }
  next();
}

/**
 * Middleware that requires owner privileges. Golden rule: nobody but the
 * owner may see other users' access keys, so anything that exposes them
 * (Manage Users) is gated behind this rather than plain requireAdmin.
 */
export function requireOwner(req, res, next) {
  if (!req.user?.isOwner) {
    return res.status(403).json({ error: 'Acesso restrito ao dono da conta.' });
  }
  next();
}
