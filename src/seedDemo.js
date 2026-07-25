// Populates demo users + consequences. Idempotent - only adds data for
// tables that are still empty, so it's safe to call on every boot (used
// automatically in QA via SEED_DEMO=true, see server.js).
//
// Contestants are intentionally NOT seeded here - they're event-specific
// and should always start empty on every deploy, added fresh by the admin.
// Only the user list is a stable template (real names), so QA login
// credentials are always ready without losing/regenerating them.
import db, { generateUserToken } from './db.js';
import { hashToken, encryptToken } from './tokens.js';
import { today } from './time.js';

const NAMES = [
  'Alice Moreira', 'Bruno Teixeira', 'Carla Mendes', 'Daniel Sousa',
  'Elisa Carvalho', 'Fábio Nunes', 'Gabriela Pinto', 'Hugo Ribeiro',
  'Leonor Matos', 'Marta Freitas', 'Ivo Lopes', 'Nádia Barros',
  'Paula Neves', 'Tiago Fonseca', 'Sofia Gaspar', 'Vasco Dias',
  'Vera Lobo', 'Xavier Salgado', 'Zé Monteiro', 'Inácio Pires', 'Simão Valente',
];

const CONSEQUENCES_PENDING = [
  'Troca de peça de roupa com a pessoa à tua esquerda durante 30 minutos.',
  'Fala só a cantar até à próxima consequência.',
  'Deixa alguém redesenhar a tua sobrancelha com um lápis.',
  'Faz uma pose de estátua sempre que alguém disser o teu nome.',
  'Dá um elogio sincero a cada pessoa da sala.',
];

export function seedDemo() {
  const day = today();

  // 1) Demo users ------------------------------------------------------------
  // Displayed name keeps accents (NAMES as-is); the access key is always
  // stripped of them by generateUserToken, e.g. "Carla Mendes" -> "carlamendes1234".
  const nonAdmin = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 0').get().n;
  const demoUsers = [];
  if (nonAdmin < NAMES.length) {
    const insU = db.prepare("INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%f', 'now'))");
    for (const name of NAMES) {
      const tok = generateUserToken(name);
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
      'Imita o animal que a pessoa à tua frente escolher, durante 1 minuto.',
      day, 'used'
    ).lastInsertRowid;
    db.prepare("UPDATE consequences SET revealed_at = datetime('now') WHERE id = ?").run(revealedId);
    // several pending
    CONSEQUENCES_PENDING.forEach((text, i) => {
      insCons.run(demoUsers[(i + 1) % demoUsers.length], text, day, 'pending');
    });
    console.log(`[seed-demo] Added 1 revealed consequence and ${CONSEQUENCES_PENDING.length} pending.`);
  }
}
