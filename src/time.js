import { getSetting } from './db.js';

// The event is always in Portugal - not user-configurable (a bad free-text
// value here used to crash every Intl.DateTimeFormat call keyed off it).
const TIMEZONE = 'Europe/Lisbon';

/** Configured timezone. */
export function getTimezone() {
  return TIMEZONE;
}

// The single place the app reads the wall clock. Everything time-dependent
// goes through here rather than calling Date.now() directly, so a test can
// hold the clock still for the duration of one assertion.
//
// This exists because several behaviours only appear at particular hours -
// Memo's window closes at 02:00 while the day rolls over at 06:00, and what
// happens between those two is a real bug that no test could reach while
// every test ran at whatever time the suite happened to start. A suite that
// only fails between 02:00 and 06:00 is worse than no coverage: it looks
// green all day and goes red on whoever is still working at 3am.
let readClock = () => Date.now();

/** Current time in ms since the epoch. Prefer this over Date.now(). */
export function now() {
  return readClock();
}

/**
 * Tests only: pin the clock to a fixed instant, or pass a function for
 * something more elaborate. Returns a restore function - always call it,
 * ideally in a finally, or every later test inherits the pinned time.
 *
 *   const restore = setClockForTests('2026-09-18T03:00:00Z');
 *   try { ... } finally { restore(); }
 */
export function setClockForTests(at) {
  const previous = readClock;
  readClock = typeof at === 'function' ? at : () => new Date(at).getTime();
  return () => { readClock = previous; };
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
  }).format(new Date(now()));

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
  }).format(new Date(now()));
  return parseInt(h, 10) % 24;
}

/**
 * Formats a "YYYY-MM-DD HH:MM:SS[.mmm]" DB timestamp (always stored in UTC,
 * see strftime('...', 'now') in db.js) as "HH:MM" in the configured
 * timezone. Without this, displaying the raw stored value shows UTC time
 * as if it were already local - off by an hour for Portugal whenever DST
 * is in effect.
 */
export function formatTimeInZone(dbTimestamp, tz = getTimezone()) {
  const iso = `${String(dbTimestamp).replace(' ', 'T')}Z`;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Status of a night's Best Look, controlled by the admin:
 * 'registration' (contestants can enter) | 'open' (voting) | 'closed' (results). */
export function nightStatus(night) {
  const status = getSetting(`voting_status_${night}`, 'closed');
  return status === 'registration' || status === 'open' ? status : 'closed';
}
