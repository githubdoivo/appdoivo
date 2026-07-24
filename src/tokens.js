// Encryption and indexing of user tokens.
//
// Goal: if the database leaks (backup, accidental commit, etc.), the tokens are
// not exposed in plain text. You need the TOKEN_SECRET (kept in .env, outside
// the DB) to read them.
//
// - hashToken:   deterministic HMAC-SHA256 -> used to look up the user at
//                login (not reversible).
// - encryptToken/decryptToken: reversible AES-256-GCM -> the admin panel can
//                still show/copy each user's key.
import { createHmac, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

let secret = process.env.TOKEN_SECRET;
if (!secret) {
  secret = randomBytes(32).toString('hex');
  console.warn(
    '[security] TOKEN_SECRET not set in .env - using an ephemeral secret. ' +
    'Tokens will stop matching after a restart. Set TOKEN_SECRET in production.'
  );
}

const KEY = createHash('sha256').update(secret).digest(); // 32 bytes for AES-256

/** Deterministic token index (to look up at login). Not reversible. */
export function hashToken(token) {
  return createHmac('sha256', secret).update(String(token)).digest('hex');
}

/** Encrypts the token for storage in the DB (format iv:tag:ciphertext, base64). */
export function encryptToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypts an encrypted token (so the admin panel can show the key). */
export function decryptToken(enc) {
  const [ivB, tagB, ctB] = String(enc).split(':');
  const iv = Buffer.from(ivB, 'base64');
  const tag = Buffer.from(tagB, 'base64');
  const ct = Buffer.from(ctB, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
