import webpush from 'web-push';
import db from './db.js';

let configured = false;

/** Configures web-push with the VAPID keys from the environment. */
export function initPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY missing. Push disabled. Run "npm run genkeys".');
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function isPushConfigured() {
  return configured;
}

export function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/** Saves a user's push subscription. */
export function saveSubscription(userId, subscription) {
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, subscription)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription
  `).run(userId, subscription.endpoint, JSON.stringify(subscription));
}

/** Removes a subscription by its endpoint. */
export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/** Picks the localized string for a field that may be `{ pt, en }` or a plain string. */
function localize(field, lang) {
  if (field && typeof field === 'object') return field[lang] || field.pt || field.en;
  return field;
}

/**
 * Sends a notification to every subscriber, in each recipient's own
 * `lang` (last language they selected in the app; defaults to 'pt').
 * `payload.title`/`payload.body` may be a plain string (sent as-is to
 * everyone) or `{ pt, en }` to localize per recipient. Cleans up invalid
 * subscriptions.
 */
export async function broadcast(payload) {
  if (!configured) return { sent: 0, failed: 0 };
  const rows = db.prepare(`
    SELECT s.endpoint, s.subscription, u.lang
    FROM push_subscriptions s
    JOIN users u ON u.id = s.user_id
  `).all();
  let sent = 0;
  let failed = 0;

  await Promise.all(rows.map(async (row) => {
    const lang = row.lang === 'en' ? 'en' : 'pt';
    const body = JSON.stringify({
      ...payload,
      title: localize(payload.title, lang),
      body: localize(payload.body, lang),
    });
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), body);
      sent++;
    } catch (err) {
      failed++;
      // 404/410 = expired subscription; remove it
      if (err.statusCode === 404 || err.statusCode === 410) {
        removeSubscription(row.endpoint);
      }
    }
  }));

  return { sent, failed };
}
