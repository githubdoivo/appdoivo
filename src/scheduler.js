import cron from 'node-cron';
import { revealRandomConsequence } from './consequences.js';
import { pruneMessages } from './chat.js';
import { getTimezone } from './time.js';

/**
 * Starts the scheduled jobs:
 *  - Every 2 hours (minute 0) between 16:00 and 04:00: reveals a random
 *    consequence and notifies. No reveals 05:00-15:00. Hourly was too much
 *    to keep track of, so this is spaced out to every other hour.
 *  - Every minute: expires chat messages older than 5 minutes, even when
 *    nobody's posting (postMessage/listMessages also prune on their own,
 *    this just keeps things tidy between activity).
 * (Voting is controlled manually by the admin, not on a schedule.)
 */
export function startScheduler() {
  const tz = getTimezone();

  // Every 2 hours, at minute 0: 16,18,20,22,0,2,4 (crosses midnight).
  cron.schedule('0 16,18,20,22,0,2,4 * * *', async () => {
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

  cron.schedule('* * * * *', () => {
    try {
      pruneMessages();
    } catch (err) {
      console.error('[cron] Error pruning chat messages:', err);
    }
  }, { timezone: tz });

  console.log(`[cron] Scheduler active (timezone ${tz}).`);
}
