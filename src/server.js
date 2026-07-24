import app, { seedResult } from './app.js';
import { startScheduler } from './scheduler.js';

// Start the scheduler (hourly consequence reveal).
startScheduler();

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
