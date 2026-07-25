// Populates demo data: contestants, votes, consequences. Idempotent - only
// adds data for tables that are still empty, so it's safe to call on every
// boot (used automatically in QA via SEED_DEMO=true, see server.js).
import db, { generateUserToken, setSetting } from './db.js';
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

const CONSEQUENCES_PENDING = [
  'Troca de peça de roupa com a pessoa à tua esquerda durante 30 minutos.',
  'Fala só a cantar até à próxima consequência.',
  'Deixa alguém redesenhar a tua sobrancelha com um lápis.',
  'Faz uma pose de estátua sempre que alguém disser o teu nome.',
  'Dá um elogio sincero a cada pessoa da sala.',
];

export function seedDemo() {
  const day = today();

  // 1) Contestants per night (Best Outfit) -----------------------------------
  const insC = db.prepare('INSERT INTO contestants (name, night) VALUES (?, ?)');
  for (const night of NIGHTS) {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM contestants WHERE night = ?').get(night).n;
    if (existing === 0) {
      for (const name of NAMES) insC.run(name, night);
      console.log(`[seed-demo] Added ${NAMES.length} contestants for night "${night}".`);
    }
  }

  // 2) Demo users --------------------------------------------------------------
  const nonAdmin = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 0').get().n;
  const demoUsers = [];
  if (nonAdmin < 25) {
    const insU = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin) VALUES (?, ?, ?, 0)');
    for (let i = 1; i <= 30; i++) {
      const name = `Convidado ${i}`;
      const tok = generateUserToken(name);
      const info = insU.run(name, hashToken(tok), encryptToken(tok));
      demoUsers.push(info.lastInsertRowid);
    }
    console.log('[seed-demo] Created 30 demo users (Convidado 1..30).');
  } else {
    db.prepare('SELECT id FROM users WHERE is_admin = 0').all().forEach((u) => demoUsers.push(u.id));
  }

  // 3) Demo votes per night (weighted distribution) -----------------------------
  for (const night of NIGHTS) {
    const contestants = db.prepare('SELECT id, name FROM contestants WHERE night = ?').all(night);
    const votesExist = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE night = ?').get(night).n;
    if (votesExist === 0 && contestants.length) {
      const weighted = [];
      contestants.forEach((c, i) => {
        const w = Math.max(1, Math.round(8 * Math.random()) + (i % 5 === 0 ? 6 : 0));
        for (let k = 0; k < w; k++) weighted.push(c.id);
      });
      const insV = db.prepare('INSERT OR IGNORE INTO votes (user_id, contestant_id, night) VALUES (?, ?, ?)');
      for (const uid of demoUsers) {
        const cid = weighted[Math.floor(Math.random() * weighted.length)];
        insV.run(uid, cid, night);
      }
      const total = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE night = ?').get(night).n;
      console.log(`[seed-demo] Recorded ${total} demo votes in night "${night}".`);
    }
  }

  // 4) Consequences --------------------------------------------------------------
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

  // 5) Voting status for the preview -----------------------------------------------
  // Night 1 closed (shows results), night 2 open (shows voting).
  setSetting(`voting_status_${NIGHTS[0]}`, 'closed');
  if (NIGHTS[1]) setSetting(`voting_status_${NIGHTS[1]}`, 'open');
}
