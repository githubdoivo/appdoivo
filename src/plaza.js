import db from './db.js';

const linkItemsStmt = db.prepare(`
  SELECT id, emoji, label, url FROM plaza_link_items
  WHERE post_id = ?
  ORDER BY position ASC, id ASC
`);

const MAX_TEXT_LENGTH = 500;
const MAX_OPTION_LENGTH = 60;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_LINK_LABEL_LENGTH = 60;
// Room for a multi-codepoint emoji (skin tone, ZWJ sequence) without being
// a second label field in disguise.
const MAX_LINK_EMOJI_LENGTH = 16;
const MAX_LINK_URL_LENGTH = 500;
const MIN_LINKS = 1;
const MAX_LINKS = 12;

/**
 * Links are typed in by hand, so they arrive the way people write them -
 * "shorturl.at/abc", no scheme. Assume https rather than rejecting: http is
 * the only other thing that would work and nobody means it on purpose.
 * Anything that still won't parse, or isn't http(s) once it does, is
 * refused - `javascript:` in an href the whole party can tap is not a
 * theoretical worry.
 */
function normaliseUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LINK_URL_LENGTH) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

/**
 * The full Plaza feed. Pinned announcements come first (most-recently-
 * pinned first - multiple can be pinned at once), then everything else
 * most-recent-first. Each post carries its author's name and, for polls,
 * every option with its live vote tally and whichever option (if any)
 * userId has picked - so the frontend can highlight it and offer "change
 * your vote" instead of "vote" once someone already has.
 */
export function listPlazaPosts(userId) {
  const posts = db.prepare(`
    SELECT p.id, p.type, p.text, p.pinned_at AS pinnedAt, p.created_at, u.name AS author
    FROM plaza_posts p
    JOIN users u ON u.id = p.author_id
    ORDER BY (p.pinned_at IS NULL) ASC, p.pinned_at DESC, p.created_at DESC, p.id DESC
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
    if (p.type === 'links') return { ...p, links: linkItemsStmt.all(p.id) };
    if (p.type !== 'poll') return p;
    const options = optionsStmt.all(p.id);
    const myVote = myVoteStmt.get(p.id, userId);
    return { ...p, options, myOptionId: myVote ? myVote.option_id : null };
  });
}

/**
 * Same feed as listPlazaPosts(), but for the admin Plaza page: polls also
 * carry a `voters` list (who picked what) instead of just the aggregate
 * tally. Unlike Best Look's voter log (owner-only - see /admin/votes),
 * this is open to any admin, not just the owner.
 */
export function listPlazaPostsForAdmin() {
  const posts = db.prepare(`
    SELECT p.id, p.type, p.text, p.pinned_at AS pinnedAt, p.created_at, u.name AS author
    FROM plaza_posts p
    JOIN users u ON u.id = p.author_id
    ORDER BY (p.pinned_at IS NULL) ASC, p.pinned_at DESC, p.created_at DESC, p.id DESC
  `).all();

  const optionsStmt = db.prepare(`
    SELECT o.id, o.label, COUNT(v.id) AS votes
    FROM plaza_poll_options o
    LEFT JOIN plaza_poll_votes v ON v.option_id = o.id
    WHERE o.post_id = ?
    GROUP BY o.id
    ORDER BY o.position ASC, o.id ASC
  `);
  const votersStmt = db.prepare(`
    SELECT u.name AS name, o.label AS option
    FROM plaza_poll_votes v
    JOIN users u ON u.id = v.user_id
    JOIN plaza_poll_options o ON o.id = v.option_id
    WHERE v.post_id = ?
    ORDER BY u.name COLLATE NOCASE
  `);

  return posts.map((p) => {
    if (p.type === 'links') return { ...p, links: linkItemsStmt.all(p.id) };
    if (p.type !== 'poll') return p;
    return { ...p, options: optionsStmt.all(p.id), voters: votersStmt.all(p.id) };
  });
}

const POST_TYPES = ['announcement', 'poll', 'links'];

/**
 * The rules a post's contents have to satisfy, shared by creating and
 * editing so the two can never drift apart - an edit that accepted what a
 * create refuses would be a way around the limits rather than a feature.
 * Returns { text, options, links } or { error }.
 */
function validatePostContent(type, { text, options, links }) {
  const trimmedText = String(text ?? '').trim();
  if (!trimmedText) return { error: 'err_post_text_required' };
  if (trimmedText.length > MAX_TEXT_LENGTH) return { error: 'err_post_too_long' };
  if (!POST_TYPES.includes(type)) return { error: 'err_invalid_post_type' };

  let cleanOptions = [];
  if (type === 'poll') {
    cleanOptions = Array.isArray(options)
      ? options.map((o) => String(o ?? '').trim()).filter(Boolean)
      : [];
    if (cleanOptions.length < MIN_OPTIONS) return { error: 'err_poll_min_options' };
    if (cleanOptions.length > MAX_OPTIONS) return { error: 'err_poll_max_options' };
    if (cleanOptions.some((o) => o.length > MAX_OPTION_LENGTH)) return { error: 'err_poll_option_too_long' };
  }

  let cleanLinks = [];
  if (type === 'links') {
    // A row needs both halves to mean anything, so a half-filled one is a
    // mistake worth naming rather than quietly dropping - except a wholly
    // empty row, which is just the spare input nobody typed into.
    const rows = (Array.isArray(links) ? links : [])
      .map((l) => ({
        emoji: String(l?.emoji ?? '').trim(),
        label: String(l?.label ?? '').trim(),
        url: String(l?.url ?? '').trim(),
      }))
      .filter((l) => l.emoji || l.label || l.url);
    if (rows.some((l) => !l.label || !l.url)) return { error: 'err_link_incomplete' };
    if (rows.length < MIN_LINKS) return { error: 'err_link_min_items' };
    if (rows.length > MAX_LINKS) return { error: 'err_link_max_items' };
    if (rows.some((l) => l.label.length > MAX_LINK_LABEL_LENGTH)) return { error: 'err_link_label_too_long' };
    if (rows.some((l) => [...l.emoji].length > MAX_LINK_EMOJI_LENGTH)) return { error: 'err_link_emoji_too_long' };
    cleanLinks = rows.map((l) => ({ emoji: l.emoji, label: l.label, url: normaliseUrl(l.url) }));
    if (cleanLinks.some((l) => !l.url)) return { error: 'err_link_invalid_url' };
  }

  return { text: trimmedText, options: cleanOptions, links: cleanLinks };
}

/**
 * Creates an announcement, a poll, or a list of links. Announcements ignore
 * both extras; polls require 2-6 non-empty option labels; links require at
 * least one label+URL pair. Returns { ok, id } or { error }.
 */
export function createPlazaPost(authorId, { type, text, options, links }) {
  const clean = validatePostContent(type, { text, options, links });
  if (clean.error) return clean;

  const info = db.prepare('INSERT INTO plaza_posts (type, author_id, text) VALUES (?, ?, ?)')
    .run(type, authorId, clean.text);
  const postId = info.lastInsertRowid;

  if (type === 'poll') {
    const insOption = db.prepare('INSERT INTO plaza_poll_options (post_id, label, position) VALUES (?, ?, ?)');
    clean.options.forEach((label, i) => insOption.run(postId, label, i));
  }

  if (type === 'links') {
    const insLink = db.prepare('INSERT INTO plaza_link_items (post_id, emoji, label, url, position) VALUES (?, ?, ?, ?, ?)');
    clean.links.forEach((l, i) => insLink.run(postId, l.emoji, l.label, l.url, i));
  }

  return { ok: true, id: postId };
}

/**
 * Edits a post already on the Wall - a typo in an announcement, a wrong
 * address in a link, an option nobody understood. The type is fixed at
 * creation and cannot change: a poll people have voted in is not an
 * announcement, and pretending otherwise would strand those votes.
 *
 * Poll options are matched by position rather than wiped and re-inserted,
 * so renaming one keeps the votes already cast for it - fixing a typo must
 * not quietly reset the tally. Options removed outright do lose theirs;
 * there is no honest way around that, and the frontend says so before it
 * sends. Links carry no votes, so they are simply replaced.
 *
 * Returns { ok, id } or { error }.
 */
export function updatePlazaPost(id, { text, options, links }) {
  const post = db.prepare('SELECT id, type FROM plaza_posts WHERE id = ?').get(id);
  if (!post) return { error: 'err_post_not_found' };
  // Snapshots and the day video are generated, not written - their text is
  // a JSON payload or a date, and editing it by hand only breaks them.
  if (!POST_TYPES.includes(post.type)) return { error: 'err_post_not_editable' };

  const clean = validatePostContent(post.type, { text, options, links });
  if (clean.error) return clean;

  db.prepare('UPDATE plaza_posts SET text = ? WHERE id = ?').run(clean.text, id);

  if (post.type === 'poll') {
    const existing = db.prepare(
      'SELECT id, position FROM plaza_poll_options WHERE post_id = ? ORDER BY position ASC, id ASC'
    ).all(id);
    const rename = db.prepare('UPDATE plaza_poll_options SET label = ? WHERE id = ?');
    const insert = db.prepare('INSERT INTO plaza_poll_options (post_id, label, position) VALUES (?, ?, ?)');
    const remove = db.prepare('DELETE FROM plaza_poll_options WHERE id = ?');
    clean.options.forEach((label, i) => {
      if (existing[i]) rename.run(label, existing[i].id);
      else insert.run(id, label, i);
    });
    // Votes on a removed option go with it (ON DELETE CASCADE).
    existing.slice(clean.options.length).forEach((o) => remove.run(o.id));
  }

  if (post.type === 'links') {
    db.prepare('DELETE FROM plaza_link_items WHERE post_id = ?').run(id);
    const insLink = db.prepare('INSERT INTO plaza_link_items (post_id, emoji, label, url, position) VALUES (?, ?, ?, ?, ?)');
    clean.links.forEach((l, i) => insLink.run(id, l.emoji, l.label, l.url, i));
  }

  return { ok: true, id };
}

/** Removes a post (options/votes cascade). Returns { ok } or { error }. */
export function deletePlazaPost(id) {
  const post = db.prepare('SELECT id FROM plaza_posts WHERE id = ?').get(id);
  if (!post) return { error: 'err_post_not_found' };
  db.prepare('DELETE FROM plaza_posts WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * Pins or unpins any post - announcement or poll - owner-only (enforced by
 * the route, see requireOwner on PATCH /admin/plaza-posts/:id/pin). Multiple
 * can be pinned at once, of either type; pinned_at both flags it and orders
 * pins by most-recently-pinned first (see listPlazaPosts()). Returns { ok }
 * or { error }.
 */
export function pinPlazaPost(id, pinned) {
  const post = db.prepare('SELECT id FROM plaza_posts WHERE id = ?').get(id);
  if (!post) return { error: 'err_post_not_found' };

  if (pinned) {
    db.prepare("UPDATE plaza_posts SET pinned_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(id);
  } else {
    db.prepare('UPDATE plaza_posts SET pinned_at = NULL WHERE id = ?').run(id);
  }
  return { ok: true };
}

/**
 * Casts a vote on a poll. One vote per user per post, permanently - a
 * second attempt is rejected rather than moving the existing vote. The
 * SELECT below is the friendly path (a clean error instead of a 500); the
 * UNIQUE index on (user_id, post_id) is what actually holds under two
 * simultaneous requests from the same user, caught below as a fallback.
 * Returns { ok } or { error }.
 */
export function castPlazaVote(userId, postId, optionId) {
  const post = db.prepare('SELECT id, type FROM plaza_posts WHERE id = ?').get(postId);
  if (!post) return { error: 'err_post_not_found' };
  if (post.type !== 'poll') return { error: 'err_not_a_poll' };

  const option = db.prepare('SELECT id FROM plaza_poll_options WHERE id = ? AND post_id = ?').get(optionId, postId);
  if (!option) return { error: 'err_invalid_option' };

  const existing = db.prepare('SELECT id FROM plaza_poll_votes WHERE user_id = ? AND post_id = ?').get(userId, postId);
  if (existing) return { error: 'err_already_voted_poll' };

  try {
    db.prepare('INSERT INTO plaza_poll_votes (post_id, option_id, user_id) VALUES (?, ?, ?)').run(postId, optionId, userId);
  } catch (err) {
    if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message)) {
      return { error: 'err_already_voted_poll' };
    }
    throw err;
  }
  return { ok: true };
}

/**
 * Publishes a Snatch night's result as a Wall post: the podium (with each
 * placing's contestant id, so the feed can show their photo) and, below it,
 * the Miss Congeniality winner.
 *
 * The whole thing is stored as a JSON snapshot in `text` rather than as a
 * live reference to the night. A Wall post is a record of what was
 * announced at the time - re-running or resetting the night afterwards
 * (see /admin/voting/:night/reset) must not silently rewrite a result the
 * whole party already saw. It also means rendering needs no extra
 * permission logic: whatever the owner chose to publish is public.
 */
export function createPodiumPost(authorId, { night, podium, congeniality }) {
  const payload = JSON.stringify({ night, podium, congeniality: congeniality ?? null });
  const info = db.prepare(
    "INSERT INTO plaza_posts (type, author_id, text) VALUES ('podium', ?, ?)"
  ).run(authorId, payload);
  return { ok: true, id: info.lastInsertRowid };
}

/**
 * Publishes a Memo day's video as a real Wall post, so it lives in the feed
 * with everything else and the owner can pin or delete it from the admin
 * history like any other post. It used to render in a card of its own, which
 * meant the one thing people most want pinned was the one thing that could
 * not be.
 *
 * `text` is just the day; the file itself stays in memo_recaps and is served
 * by GET /memo/recaps/:day, so deleting the post throws away the post, not
 * the video - republishing brings it back.
 *
 * Re-publishing the same day replaces its post rather than stacking a second
 * one, and keeps the pin if it had one.
 */
export function createVideoPost(authorId, day) {
  const existing = db.prepare("SELECT id, pinned_at FROM plaza_posts WHERE type = 'video' AND text = ?").get(day);
  if (existing) {
    db.prepare("UPDATE plaza_posts SET author_id = ?, created_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?")
      .run(authorId, existing.id);
    return { ok: true, id: existing.id, replaced: true };
  }
  const info = db.prepare("INSERT INTO plaza_posts (type, author_id, text) VALUES ('video', ?, ?)").run(authorId, day);
  return { ok: true, id: info.lastInsertRowid };
}
