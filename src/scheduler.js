import cron from 'node-cron';
import { revealRandomConsequence } from './consequences.js';
import { getTimezone } from './time.js';

/**
 * Starts the scheduled jobs:
 *  - Every hour (minute 0) between 16:00 and 03:00: reveals a random
 *    consequence and notifies. No reveals 04:00-15:00.
 * (Voting is controlled manually by the admin, not on a schedule.)
 */
export function startScheduler() {
  const tz = getTimezone();

  // Every hour, at minute 0, hours 16-23 and 0-3 (crosses midnight).
  cron.schedule('0 16-23,0-3 * * *', async () => {
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
