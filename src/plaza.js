import db from './db.js';

const MAX_TEXT_LENGTH = 500;
const MAX_OPTION_LENGTH = 60;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

/**
 * The full Plaza feed, most-recent-first. Each post carries its author's
 * name and, for polls, every option with its live vote tally and whichever
 * option (if any) userId has picked - so the frontend can highlight it and
 * offer "change your vote" instead of "vote" once someone already has.
 */
export function listPlazaPosts(userId) {
  const posts = db.prepare(`
    SELECT p.id, p.type, p.text, p.created_at, u.name AS author
    FROM plaza_posts p
    JOIN users u ON u.id = p.author_id
    ORDER BY p.created_at DESC, p.id DESC
  `).all();

  const optionsStmt = db.prepare(`
    SELECT o.id, o.label, COUNT(v.id) AS votes
    FROM plaza_poll_options o
    LEFT JOIN plaza_poll_votes v ON v.option_id = o.id
    WHERE o.post_id = ?
    GROUP BY o.id
    ORDER BY o.position ASC, o.id ASC
  `);
  const myVoteStmt = db.prepare('SELECT option_id FROM plaza_poll_votes WHERE post_id = ? AND user_id = ?');

  return posts.map((p) => {
    if (p.type !== 'poll') return p;
    const options = optionsStmt.all(p.id);
    const myVote = myVoteStmt.get(p.id, userId);
    return { ...p, options, myOptionId: myVote ? myVote.option_id : null };
  });
}

/**
 * Creates a note or a poll. Notes ignore `options`; polls require 2-6
 * non-empty option labels. Returns { ok, post } or { error }.
 */
export function createPlazaPost(authorId, { type, text, options }) {
  const trimmedText = String(text ?? '').trim();
  if (!trimmedText) return { error: 'Escreve o texto da publicação.' };
  if (trimmedText.length > MAX_TEXT_LENGTH) return { error: `Máximo ${MAX_TEXT_LENGTH} caracteres.` };

  if (type !== 'note' && type !== 'poll') return { error: 'Tipo de publicação inválido.' };

  let cleanOptions = [];
  if (type === 'poll') {
    cleanOptions = Array.isArray(options)
      ? options.map((o) => String(o ?? '').trim()).filter(Boolean)
      : [];
    if (cleanOptions.length < MIN_OPTIONS) return { error: `Uma sondagem precisa de pelo menos ${MIN_OPTIONS} opções.` };
    if (cleanOptions.length > MAX_OPTIONS) return { error: `Máximo ${MAX_OPTIONS} opções.` };
    if (cleanOptions.some((o) => o.length > MAX_OPTION_LENGTH)) return { error: `Cada opção: máximo ${MAX_OPTION_LENGTH} caracteres.` };
  }

  const info = db.prepare('INSERT INTO plaza_posts (type, author_id, text) VALUES (?, ?, ?)')
    .run(type, authorId, trimmedText);
  const postId = info.lastInsertRowid;

  if (type === 'poll') {
    const insOption = db.prepare('INSERT INTO plaza_poll_options (post_id, label, position) VALUES (?, ?, ?)');
    cleanOptions.forEach((label, i) => insOption.run(postId, label, i));
  }

  return { ok: true, id: postId };
}

/** Removes a post (options/votes cascade). Returns { ok } or { error }. */
export function deletePlazaPost(id) {
  const post = db.prepare('SELECT id FROM plaza_posts WHERE id = ?').get(id);
  if (!post) return { error: 'Publicação não encontrada.' };
  db.prepare('DELETE FROM plaza_posts WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * Casts (or changes) a vote on a poll. One vote per user per post - voting
 * again just moves it to the new option. Returns { ok } or { error }.
 */
export function castPlazaVote(userId, postId, optionId) {
  const post = db.prepare('SELECT id, type FROM plaza_posts WHERE id = ?').get(postId);
  if (!post) return { error: 'Publicação não encontrada.' };
  if (post.type !== 'poll') return { error: 'Esta publicação não é uma sondagem.' };

  const option = db.prepare('SELECT id FROM plaza_poll_options WHERE id = ? AND post_id = ?').get(optionId, postId);
  if (!option) return { error: 'Opção inválida.' };

  db.prepare(`
    INSERT INTO plaza_poll_votes (post_id, option_id, user_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, post_id) DO UPDATE SET option_id = excluded.option_id, created_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
  `).run(postId, optionId, userId);
  return { ok: true };
}
