import cron from 'node-cron';
import { revealRandomConsequence } from './consequences.js';
import { getTimezone } from './time.js';
import { getDueSlots, markSlotNotified } from './memo.js';
import { notifyUser } from './push.js';

/**
 * Starts the scheduled jobs:
 *  - Every 3 hours (minute 0) between 16:00 and 04:00: reveals a random
 *    consequence and notifies. No reveals 05:00-15:00. Hourly was too much
 *    to keep track of, so this is spaced out.
 * The Wall has no time-based expiry or cap at all. Plaza (the open group
 * chat) has its own 15-most-recent cap, applied inline on every post/read
 * in chat.js, so neither needs a scheduled job.
 * (Voting is controlled manually by the admin, not on a schedule.)
 *  - Every minute (only while ENABLE_MEMO is set): fires the push
 *    notification for any Memo slot whose random time has arrived. Slots
 *    themselves are generated lazily per user (see ensureTodaysSlots() in
 *    memo.js) - this job only ever has to ask "is anything due right now?",
 *    same DB-driven-state-plus-periodic-sweep shape as the reveal job
 *    above, just on a tighter interval since each user's 5 times are
 *    independent instead of one shared schedule.
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
      console.error('[cron] Error in reveal job:', err);
    }
  }, { timezone: tz });

  if (process.env.ENABLE_MEMO === 'true') {
    cron.schedule('* * * * *', async () => {
      try {
        for (const slot of getDueSlots()) {
          markSlotNotified(slot.id);
          await notifyUser(slot.user_id, {
            title: { pt: 'memo', en: 'memo' },
            body: {
              pt: 'é agora - tens 15 minutos para captar este momento.',
              en: "it's now - you have 15 minutes to capture this moment.",
            },
            tag: 'memo',
            url: '/?tab=memo',
          });
        }
      } catch (err) {
        console.error('[cron] Error in memo notification job:', err);
      }
    }, { timezone: tz });
  }

  console.log(`[cron] Scheduler active (timezone ${tz}).`);
}
