import { getSetting } from './db.js';

/** Configured timezone. */
export function getTimezone() {
  return getSetting('timezone', 'Europe/Lisbon');
}

/**
 * Returns the "voting day" (YYYY-MM-DD) in the configured timezone.
 * The day only changes at the rollover hour (default 6am), not at midnight, so
 * an event that runs past midnight still counts as the same day.
 */
export function today(tz = getTimezone()) {
  const rollover = Number(getSetting('day_rollover_hour', 6));
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  if (currentHour(tz) < rollover) {
    // Before the rollover it still belongs to the previous day.
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

/** Returns the current hour (0-23) in the configured timezone. */
export function currentHour(tz = getTimezone()) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return parseInt(h, 10) % 24;
}

/** Status of a night's Best Outfit, controlled by the admin:
 * 'registration' (contestants can enter) | 'open' (voting) | 'closed' (results). */
export function nightStatus(night) {
  const status = getSetting(`voting_status_${night}`, 'closed');
  return status === 'registration' || status === 'open' ? status : 'closed';
}
