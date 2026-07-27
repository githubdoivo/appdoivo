import app, { seedResult } from './app.js';
import { startScheduler } from './scheduler.js';
import { seedDemo } from './seedDemo.js';

// Start the scheduler (consequence reveal every 3 hours).
startScheduler();

// QA-only: the DB is ephemeral there (resets on every deploy/restart), so
// auto-load a template of mock data on every boot instead of starting bare.
// Never set in production - real data must never be touched by this.
if (process.env.SEED_DEMO === 'true') {
  seedDemo();
  console.log('[seed-demo] Demo data loaded (SEED_DEMO=true).');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  App running at http://localhost:${PORT}`);
  if (seedResult.created) {
    console.log('\n  ================ ADMIN TOKEN (keep it!) ================');
    console.log(`  ${seedResult.token}`);
    console.log('  =======================================================\n');
  } else {
    console.log('  (Admin already existed. See the token with: npm run admin-token)\n');
  }
});
