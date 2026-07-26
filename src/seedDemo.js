// Populates demo users + consequences + contestants. Idempotent - only adds
// data for tables that are still empty, so it's safe to call on every boot
// (used automatically in QA via SEED_DEMO=true, see server.js). Contestants
// are normally event-specific and only ever added manually by the owner -
// that's still true in production (SEED_DEMO is never set there). QA is the
// one exception: 5 contestants per night are seeded automatically from the
// demo user template, so Best Outfit is testable without manual setup.
import db, { generateDemoUserToken } from './db.js';
import { hashToken, encryptToken } from './tokens.js';
import { today } from './time.js';
import { NIGHTS } from './nights.js';

const NAMES = [
  'Alice Moreira', 'Bruno Teixeira', 'Carla Mendes', 'Daniel Sousa',
  'Elisa Carvalho', 'Fábio Nunes', 'Gabriela Pinto', 'Hugo Ribeiro',
  'Leonor Matos', 'Marta Freitas', 'Ivo Lopes', 'Nádia Barros',
  'Paula Neves', 'Tiago Fonseca', 'Sofia Gaspar', 'Vasco Dias',
  'Vera Lobo', 'Xavier Salgado', 'Zé Monteiro', 'Inácio Pires', 'Simão Valente',
];

// The rata is a passable, anonymous token - whoever ends up holding it when
// a consequence is revealed might not be near anyone else at that moment.
// So these never assume a specific person is present nearby (no "to your
// left/right/in front of you" - the game doesn't work that way).
const CONSEQUENCES_PENDING = [
  'Give the closest person a pedicure.',
  'Confess the last time you lied.',
  'Let the nearest person pick an accessory for you to wear the rest of the night.',
  'Sit on someone\'s lap until the next consequence drops.',
  'Use your best pickup line on a stranger in the room.',
];

export function seedDemo() {
  const day = today();

  // 1) Demo users ------------------------------------------------------------
  // Displayed name keeps accents (NAMES as-is); the access key is always
  // stripped of them, e.g. "Carla Mendes" -> "carlamendes1234". Uses the
  // deterministic generateDemoUserToken (not the random generateUserToken)
  // so a tester's key stays the same across every QA reseed/deploy.
  const nonAdmin = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 0').get().n;
  const demoUsers = [];
  if (nonAdmin < NAMES.length) {
    const insU = db.prepare("INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%f', 'now'))");
    for (const name of NAMES) {
      const tok = generateDemoUserToken(name);
      const info = insU.run(name, hashToken(tok), encryptToken(tok));
      demoUsers.push(info.lastInsertRowid);
    }
    console.log(`[seed-demo] Created ${NAMES.length} demo users.`);
  } else {
    db.prepare('SELECT id FROM users WHERE is_admin = 0').all().forEach((u) => demoUsers.push(u.id));
  }

  // 2) Consequences ------------------------------------------------------------
  const consExist = db.prepare('SELECT COUNT(*) AS n FROM consequences').get().n;
  if (consExist === 0 && demoUsers.length) {
    const insCons = db.prepare('INSERT INTO consequences (user_id, text, day, status) VALUES (?, ?, ?, ?)');
    // one already revealed (shows up as the "current consequence")
    const revealedId = insCons.run(
      demoUsers[0],
      'Do your best animal impression for 1 minute - you choose which animal.',
      day, 'used'
    ).lastInsertRowid;
    db.prepare("UPDATE consequences SET revealed_at = datetime('now') WHERE id = ?").run(revealedId);
    // several pending
    CONSEQUENCES_PENDING.forEach((text, i) => {
      insCons.run(demoUsers[(i + 1) % demoUsers.length], text, day, 'pending');
    });
    console.log(`[seed-demo] Added 1 revealed consequence and ${CONSEQUENCES_PENDING.length} pending.`);
  }

  // 3) Contestants (QA convenience only - prod never sets SEED_DEMO, so the
  // owner always adds contestants manually there) -----------------------------
  const contestantCount = db.prepare('SELECT COUNT(*) AS n FROM contestants').get().n;
  if (contestantCount === 0) {
    const insContestant = db.prepare('INSERT INTO contestants (name, night) VALUES (?, ?)');
    NIGHTS.forEach((night, i) => {
      NAMES.slice(i * 5, i * 5 + 5).forEach((name) => insContestant.run(name, night));
    });
    console.log(`[seed-demo] Registered 5 contestants for each night (${NIGHTS.join(', ')}).`);
  }
}
