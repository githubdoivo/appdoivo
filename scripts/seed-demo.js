// CLI entry point for local/manual use: node scripts/seed-demo.js
// (Runs automatically on boot in QA via SEED_DEMO=true - see src/server.js.)
import 'dotenv/config';
import { seedDemo } from '../src/seedDemo.js';

seedDemo();
console.log('\nDemo data ready.');
