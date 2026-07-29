// The event is always in Portugal, not user-configurable (mirrors
// getTimezone() in src/time.js server-side). DB timestamps are always
// stored in UTC (see strftime('...', 'now') in db.js) - displaying the raw
// string as-is is only correct when Lisbon happens to be at UTC+0 (WET,
// winter); during WEST (UTC+1, summer DST) it shows an hour early.
const TIMEZONE = 'Europe/Lisbon';

function toUtcDate(dbTimestamp) {
  return new Date(`${String(dbTimestamp).replace(' ', 'T')}Z`);
}

/**
 * "YYYY-MM-DD[ HH:MM:SS]" -> "DD-MM-YYYY". A bare date (no time part, e.g.
 * Rata's "voting day" from today() server-side) is already a Lisbon-local
 * calendar date with nothing to convert, so it's just reformatted as-is;
 * a full timestamp gets its date reread in Lisbon time first, since a late
 * UTC timestamp can fall on the next calendar day there.
 */
export function formatEuDate(dbDateOrTimestamp) {
  const str = String(dbDateOrTimestamp);
  if (!str.includes(' ')) {
    const [y, m, d] = str.split('-');
    return `${d}-${m}-${y}`;
  }
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(toUtcDate(str)).split('-');
  return `${d}-${m}-${y}`;
}

/** "YYYY-MM-DD HH:MM:SS" UTC timestamp -> "DD-MM-YYYY HH:MM" in Lisbon time. */
export function formatEuDateTime(dbTimestamp) {
  return `${formatEuDate(dbTimestamp)} ${formatTimeInZone(dbTimestamp)}`;
}

/** "YYYY-MM-DD HH:MM:SS" UTC timestamp -> "HH:MM" in Lisbon time. */
export function formatTimeInZone(dbTimestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(toUtcDate(dbTimestamp));
}

/** "YYYY-MM-DD HH:MM:SS" UTC timestamp -> "HH" (hour only) in Lisbon time. */
export function formatHourInZone(dbTimestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', hour12: false,
  }).format(toUtcDate(dbTimestamp));
}
