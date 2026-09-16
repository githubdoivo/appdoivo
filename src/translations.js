import { createHash } from 'node:crypto';
// Storage for machine translations of text the guests and admins write.
// Reading and writing only - the API call itself lives in translate.js, so
// this module stays usable (and testable) with no network and no API key.
import db from './db.js';

// The languages the app itself ships in (see i18n.js). A translation is
// only ever produced for a language someone could actually be reading in.
export const LANGS = ['pt', 'en'];

// Two tries, then it stays failed. A translation is a nicety; retrying it
// forever against a paid API because one string upsets a classifier is not.
export const MAX_ATTEMPTS = 2;

/**
 * The rows a reader needs, as a Map keyed "type:id:field" -> text, for one
 * language. Only 'ok' rows are returned: a queued or failed translation is
 * indistinguishable from no translation at all, which is what makes the
 * fallback to the original automatic rather than something every call site
 * has to remember.
 *
 * One query for a whole feed rather than one per post - the Wall renders
 * every post at once, and a per-row lookup there is a query per post per
 * option per link.
 */
export function translationsFor(entityType, ids, lang) {
  const map = new Map();
  if (!LANGS.includes(lang) || !ids.length) return map;
  const rows = db.prepare(`
    SELECT entity_id, field, text FROM translations
    WHERE entity_type = ? AND lang = ? AND status = 'ok' AND text IS NOT NULL
      AND entity_id IN (${ids.map(() => '?').join(',')})
  `).all(entityType, lang, ...ids);
  for (const r of rows) map.set(`${entityType}:${r.entity_id}:${r.field}`, r.text);
  return map;
}

/** Convenience for a single row - same rules as translationsFor(). */
export function translationOf(entityType, entityId, field, lang) {
  return translationsFor(entityType, [entityId], lang).get(`${entityType}:${entityId}:${field}`) ?? null;
}

/**
 * Queues every language this text is not already written in. Called on the
 * write path, so it must never throw into a request that has otherwise
 * succeeded: a post is published whether or not its translation was even
 * queued successfully.
 *
 * sourceLang is what the author actually wrote in - detected, not assumed
 * from their app language, because someone reading the app in English may
 * well write their dare in Portuguese. Translating pt->pt produces mush.
 */
/**
 * Queues a translation - but only when there is actually something new to
 * translate.
 *
 * The ON CONFLICT clause used to reset every re-queued row to pending with
 * attempts back to 0, which reads as "this was edited, do it again". That is
 * right for an edit and expensive nonsense for everything else: re-queueing
 * an unchanged sentence discarded a finished translation and bought it
 * again. seedDemo re-queues its whole demo set on every boot, so on QA that
 * happened on every deploy.
 *
 * Comparing a hash of the source text tells the two cases apart. Same text
 * and a finished row: leave it alone. Different text: the translation is
 * stale and is correctly thrown away.
 */
export function queue(entityType, entityId, field, sourceLang, sourceText = null) {
  try {
    const hash = sourceText == null ? null : createHash('sha256').update(String(sourceText)).digest('hex').slice(0, 32);
    const existing = db.prepare(
      'SELECT lang, status, source_hash FROM translations WHERE entity_type = ? AND entity_id = ? AND field = ?'
    ).all(entityType, entityId, field);
    const insert = db.prepare(`
      INSERT INTO translations (entity_type, entity_id, field, lang, status, source_hash)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(entity_type, entity_id, field, lang) DO UPDATE SET
        status = 'pending', text = NULL, attempts = 0, source_hash = excluded.source_hash
    `);
    for (const lang of LANGS) {
      if (lang === sourceLang) continue;
      const row = existing.find((r) => r.lang === lang);
      // Already done, from exactly this text - nothing to buy.
      if (row && row.status === 'ok' && hash && row.source_hash === hash) continue;
      // Already given up on, from exactly this text - retrying it on every
      // subsequent write is how a permanent failure became a recurring bill.
      if (row && row.status === 'failed' && hash && row.source_hash === hash) continue;
      insert.run(entityType, entityId, field, lang, hash);
    }
  } catch {
    // Queueing is best-effort by design - see the note above.
  }
}

/** Everything still waiting, oldest first, bounded so one pass is one batch. */
export function pending(limit = 25) {
  return db.prepare(`
    SELECT id, entity_type, entity_id, field, lang, attempts
    FROM translations
    WHERE status = 'pending' AND attempts < ?
    ORDER BY id ASC LIMIT ?
  `).all(MAX_ATTEMPTS, limit);
}

export function markOk(id, text) {
  db.prepare("UPDATE translations SET status = 'ok', text = ?, attempts = attempts + 1 WHERE id = ?").run(text, id);
}

export function markFailed(id) {
  db.prepare(`
    UPDATE translations
    SET attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END
    WHERE id = ?
  `).run(id);
}

/** Drops rows whose subject is gone - called by the feature wipes. */
export function wipeFor(entityType, entityId = null) {
  if (entityId === null) {
    db.prepare('DELETE FROM translations WHERE entity_type = ?').run(entityType);
  } else {
    db.prepare('DELETE FROM translations WHERE entity_type = ? AND entity_id = ?').run(entityType, entityId);
  }
}

export function wipeAll() {
  db.prepare('DELETE FROM translations').run();
}
