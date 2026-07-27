import cron from 'node-cron';
import { revealRandomConsequence } from './consequences.js';
import { getTimezone } from './time.js';

/**
 * Starts the scheduled jobs:
 *  - Every 3 hours (minute 0) between 16:00 and 04:00: reveals a random
 *    consequence and notifies. No reveals 05:00-15:00. Hourly was too much
 *    to keep track of, so this is spaced out.
 * The Wall has no time-based expiry (just the 20-most-recent cap, applied
 * inline on every post/read in chat.js), so it needs no scheduled job.
 * (Voting is controlled manually by the admin, not on a schedule.)
 */
export function startScheduler() {
  const tz = getTimezone();

  // Every 3 hours, at minute 0: 16,19,22,1,4 (crosses midnight).
  cron.schedule('0 16,19,22,1,4 * * *', async () => {
    try {
      const revealed = await revealRandomConsequence();
      if (revealed) {
        console.log(`[cron] Consequence revealed: "${revealed.text}"`);
      } else {
        console.log('[cron] No pending consequences to reveal.');
      }
    } catch (err) {
      console.error('[cron] Error in hourly job:', err);
    }
  }, { timezone: tz });

  console.log(`[cron] Scheduler active (timezone ${tz}).`);
}
