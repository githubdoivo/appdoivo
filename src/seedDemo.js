// Populates demo users + consequences + contestants. Idempotent - only adds
// data for tables that are still empty, so it's safe to call on every boot
// (used automatically in QA via SEED_DEMO=true, see server.js). Contestants
// are normally event-specific and only ever added manually by the owner -
// that's still true in production (SEED_DEMO is never set there). QA is the
// one exception: 5 contestants per night are seeded automatically from the
// demo user template, so Snatch is testable without manual setup.
import db, { generateDemoUserToken } from './db.js';
import { hashToken, encryptToken } from './tokens.js';
import { today } from './time.js';
import { NIGHTS } from './nights.js';

const NAMES = [
  'Alice Moreira', 'Bruno Teixeira', 'Carla Mendes', 'Daniel Sousa',
  'Elisa Carvalho', 'Fábio Nunes', 'Gabriela Pinto', 'Hugo Ribeiro',
  'Leonor Matos', 'Marta Freitas', 'Ivo Lopes', 'Nádia Barros',
  'Paula Neves', 'Rebeca Campos', 'Tiago Fonseca', 'Sofia Gaspar', 'Vasco Dias',
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
  // Keyed on is_owner (not is_admin) - the owner is the only row that never
  // came from this NAMES loop, and unlike is_admin it never changes for a
  // demo user afterwards (whether from the NAMES[0] pre-promotion below or
  // an ad hoc promotion during testing), so this stays an accurate "have I
  // already seeded" check no matter how many demo users get promoted later.
  const seededCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_owner = 0').get().n;
  const demoUsers = [];
  if (seededCount < NAMES.length) {
    const insU = db.prepare("INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))");
    NAMES.forEach((name, i) => {
      const tok = generateDemoUserToken(name);
      // QA's DB is ephemeral (resets every deploy) - without this, promoting
      // someone to admin to test admin-only flows gets wiped on the very
      // next deploy. NAMES[0] is always pre-promoted so there's a stable
      // non-owner admin tester available immediately after every reseed.
      const isAdmin = i === 0 ? 1 : 0;
      const info = insU.run(name, hashToken(tok), encryptToken(tok), isAdmin);
      demoUsers.push(info.lastInsertRowid);
    });
    console.log(`[seed-demo] Created ${NAMES.length} demo users (${NAMES[0]} pre-promoted to admin for testing).`);
  } else {
    db.prepare('SELECT id FROM users WHERE is_owner = 0').all().forEach((u) => demoUsers.push(u.id));
  }

  // 2) Consequences ------------------------------------------------------------
  const consExist = db.prepare('SELECT COUNT(*) AS n FROM consequences').get().n;
  if (consExist === 0 && demoUsers.length) {
    const insCons = db.prepare('INSERT INTO consequences (user_id, text, day, status) VALUES (?, ?, ?, ?)');
    // one already revealed (shows up as the "current consequence")
    const revealedId = insCons.run(
      demoUsers[0],
      'Act like a rat for 5 minutes.',
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
