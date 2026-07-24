// Prints the admin user's token.
import 'dotenv/config';
import db from '../src/db.js';
import { decryptToken } from '../src/tokens.js';

const admin = db.prepare('SELECT name, token_enc FROM users WHERE is_admin = 1').get();
if (!admin) {
  console.log('No admin exists yet. Start the server once with "npm start".');
} else {
  console.log(`\nAdmin: ${admin.name}`);
  console.log(`Token: ${decryptToken(admin.token_enc)}\n`);
}
