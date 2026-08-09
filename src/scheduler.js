import cron from 'node-cron';
import { revealRandomConsequence } from './consequences.js';
import { getTimezone } from './time.js';
import { getDueSlots, markSlotNotified, memoScheduleActive } from './memo.js';
import { broadcast } from './push.js';

/**
 * Starts the scheduled jobs:
 *  - Every 3 hours (minute 0) between 16:00 and 04:00: reveals a random
 *    consequence and notifies. No reveals 05:00-15:00. Hourly was too much
 *    to keep track of, so this is spaced out.
 * The Wall has no time-based expiry or cap at all. Plaza (the open group
 * chat) has its own 15-most-recent cap, applied inline on every post/read
 * in chat.js, so neither needs a scheduled job.
 * (Voting is controlled manually by the admin, not on a schedule.)
 *  - Every minute (only while ENABLE_MEMO is set): broadcasts a push
 *    notification to every guest for any Memo slot whose random time has
 *    arrived. Slots are shared - one schedule for the whole party per day,
 *    like the real BeReal (see ensureTodaysSlots() in memo.js) - so a single
 *    due slot means everyone gets notified together, not one push per user.
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
        // Silent until MEMO_START_DATE (see memoScheduleActive()) - the owner's
        // manual trigger is unaffected, so prod stays testable meanwhile.
        if (!memoScheduleActive()) return;
        for (const slot of getDueSlots()) {
          markSlotNotified(slot.id);
          await broadcast({
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
