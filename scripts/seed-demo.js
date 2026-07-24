// Populates demo data: contestants, votes, consequences.
// Usage: node scripts/seed-demo.js
import 'dotenv/config';
import db, { generateToken, setSetting } from '../src/db.js';
import { hashToken, encryptToken } from '../src/tokens.js';
import { today } from '../src/time.js';
import { NIGHTS } from '../src/nights.js';

const day = today();

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

// 1) Contestants per night (Best Outfit) ------------------------------------
const insC = db.prepare('INSERT INTO contestants (name, night) VALUES (?, ?)');
for (const night of NIGHTS) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM contestants WHERE night = ?').get(night).n;
  if (existing === 0) {
    for (const name of NAMES) insC.run(name, night);
    console.log(`Added ${NAMES.length} contestants for night "${night}".`);
  } else {
    console.log(`There are already ${existing} contestants in night "${night}", none were added.`);
  }
}

// 2) Demo users -------------------------------------------------------------
const nonAdmin = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 0').get().n;
const demoUsers = [];
if (nonAdmin < 25) {
  const insU = db.prepare('INSERT INTO users (name, token_hash, token_enc, is_admin) VALUES (?, ?, ?, 0)');
  for (let i = 1; i <= 30; i++) {
    const tok = generateToken();
    const info = insU.run(`Convidado ${i}`, hashToken(tok), encryptToken(tok));
    demoUsers.push(info.lastInsertRowid);
  }
  console.log('Created 30 demo users (Convidado 1..30).');
} else {
  db.prepare('SELECT id FROM users WHERE is_admin = 0').all().forEach((u) => demoUsers.push(u.id));
  console.log(`Reused ${demoUsers.length} existing users.`);
}

// 3) Demo votes per night (weighted distribution) ---------------------------
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
    console.log(`Recorded ${total} demo votes in night "${night}".`);
  } else {
    console.log(`There are already ${votesExist} votes in night "${night}", none were added.`);
  }
}

// 4) Consequences -----------------------------------------------------------
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
  console.log(`Added 1 revealed consequence and ${CONSEQUENCES_PENDING.length} pending.`);
} else {
  console.log(`There are already ${consExist} consequences, none were added.`);
}

// 5) Voting status for the preview ------------------------------------------
// Night 1 closed (shows results), night 2 open (shows voting).
setSetting(`voting_status_${NIGHTS[0]}`, 'closed');
if (NIGHTS[1]) setSetting(`voting_status_${NIGHTS[1]}`, 'open');
console.log(`Night "${NIGHTS[0]}" closed and night "${NIGHTS[1] ?? '-'}" open for the demo.`);

console.log('\nDemo data ready.');
