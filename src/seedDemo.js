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
import { deflateSync } from 'node:zlib';
import { createPlazaPost } from './plaza.js';
import { postMessage } from './chat.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMO_DIR, ensureTodaysSlots } from './memo.js';

// Flat-colour stand-in photos for the seeded contestants, so QA shows what
// the voting list, the results podium and the published Wall post actually
// look like with images in them - an empty photo slot hides exactly the
// layout that most needs checking. Generated rather than committed as
// base64 blobs: ten of those would be ~9KB of unreadable noise in this file.
const DEMO_PHOTO_COLORS = [
  [214, 93, 84], [232, 168, 80], [120, 152, 204], [122, 178, 124], [178, 132, 196],
  [86, 170, 178], [226, 140, 168], [150, 150, 158], [198, 176, 96], [110, 132, 190],
];

/** A minimal single-colour PNG (portrait, same aspect as a real entry photo). */
function solidPhoto([r, g, b], width = 240, height = 320) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8-bit
  ihdr[9] = 2;  // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}


// Never include "Ivo Lopes" (or any name matching the real owner) here -
// a demo account sharing the owner's name showed up in the unclaimed-user
// search on QA, which is confusing/alarming even though it's just a
// regular demo user under the hood, not an actual owner-account exposure.
const NAMES = [
  'Alice Moreira', 'Bruno Teixeira', 'Carla Mendes', 'Daniel Sousa',
  'Elisa Carvalho', 'Fábio Nunes', 'Gabriela Pinto', 'Hugo Ribeiro',
  'Leonor Matos', 'Marta Freitas', 'Tomás Vieira', 'Nádia Barros',
  'Paula Neves', 'Rebeca Campos', 'Tiago Fonseca', 'Sofia Gaspar', 'Vasco Dias',
  'Vera Lobo', 'Xavier Salgado', 'Zé Monteiro', 'Inácio Pires', 'Simão Valente',
];

// The one demo user pre-promoted to admin on every fresh seed, so there's
// always a stable non-owner admin tester available without manually
// promoting someone after each QA reseed.
const PRESET_ADMIN_NAME = 'Elisa Carvalho';

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

/**
 * Each feature seeds on its own so the owner can populate just one from its
 * danger zone (see POST /admin/<feature>/seed-demo) and clear it again with
 * the wipe button right beside it - which is how a final check on prod gets
 * done with throwaway data instead of by inventing entries by hand.
 * Every one is a no-op when that feature already holds something, so
 * pressing twice cannot double up.
 */
export function seedDemoUsers() {
  const day = today();
  // 1) Demo users ------------------------------------------------------------
  // Displayed name keeps accents (NAMES as-is); the access key is always
  // stripped of them, e.g. "Carla Mendes" -> "carlamendes1234". Uses the
  // deterministic generateDemoUserToken (not the random generateUserToken)
  // so a tester's key stays the same across every QA reseed/deploy.
  // Keyed on is_owner (not is_admin) - the owner is the only row that never
  // came from this NAMES loop, and unlike is_admin it never changes for a
  // demo user afterwards (whether from the PRESET_ADMIN_NAME pre-promotion
  // below or an ad hoc promotion during testing), so this stays an accurate
  // "have I already seeded" check no matter how many demo users get
  // promoted later.
  const seededCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_owner = 0').get().n;
  const demoUsers = [];
  if (seededCount < NAMES.length) {
    const insU = db.prepare("INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))");
    NAMES.forEach((name) => {
      const tok = generateDemoUserToken(name);
      // QA's DB is ephemeral (resets every deploy) - without this, promoting
      // someone to admin to test admin-only flows gets wiped on the very
      // next deploy. PRESET_ADMIN_NAME is always pre-promoted so there's a
      // stable non-owner admin tester available immediately after every reseed.
      const isAdmin = name === PRESET_ADMIN_NAME ? 1 : 0;
      const info = insU.run(name, hashToken(tok), encryptToken(tok), isAdmin);
      demoUsers.push(info.lastInsertRowid);
    });
    console.log(`[seed-demo] Created ${NAMES.length} demo users (${PRESET_ADMIN_NAME} pre-promoted to admin for testing).`);
  } else {
    db.prepare('SELECT id FROM users WHERE is_owner = 0').all().forEach((u) => demoUsers.push(u.id));
  }


  return demoUsers;
}

export function seedDemoConsequences(demoUsers = seedDemoUsers()) {
  const day = today();
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

}

export function seedDemoContestants(demoUsers = seedDemoUsers()) {
  const day = today();
  // 3) Contestants (QA convenience only - prod never sets SEED_DEMO, so the
  // owner always adds contestants manually there) -----------------------------
  const contestantCount = db.prepare('SELECT COUNT(*) AS n FROM contestants').get().n;
  if (contestantCount === 0) {
    // Solo demo entries have nobody to confirm with (see registerContestant()
    // in votes.js) - without confirmed_at set, they'd sit as permanently
    // unconfirmed, invisible on the voting list and blocking the admin from
    // ever opening voting on QA without hitting the force override.
    // Linked to the demo user of the same name, exactly like a real
    // self-registration. Unlinked entries are technically possible via the
    // API but never happen in practice, and they made Miss Congeniality look
    // broken on QA: it derives its candidates from the *people* behind each
    // entry (a duo splits into two), so entries attached to nobody produced
    // an empty candidate list under a full contestant list.
    const insContestant = db.prepare(
      "INSERT INTO contestants (name, night, user_id, confirmed_at, photo, photo_mime) VALUES (?, ?, ?, datetime('now'), ?, 'image/png')"
    );
    const userIdByName = new Map(
      db.prepare('SELECT id, name FROM users').all().map((u) => [u.name, u.id])
    );
    NIGHTS.forEach((night, i) => {
      NAMES.slice(i * 5, i * 5 + 5).forEach((name, j) => {
        insContestant.run(
          name, night, userIdByName.get(name) ?? null,
          solidPhoto(DEMO_PHOTO_COLORS[(i * 5 + j) % DEMO_PHOTO_COLORS.length])
        );
      });
    });
    console.log(`[seed-demo] Registered 5 contestants for each night (${NIGHTS.join(', ')}).`);
  }

}

export function seedDemoWall(demoUsers = seedDemoUsers()) {
  const day = today();
  // 4) Wall posts (QA convenience only - lets ENABLE_PLAZA be checked
  // without publishing anything by hand first) --------------------------------
  const plazaPostCount = db.prepare('SELECT COUNT(*) AS n FROM plaza_posts').get().n;
  if (plazaPostCount === 0 && demoUsers.length) {
    createPlazaPost(demoUsers[0], {
      type: 'announcement',
      text: 'Bem-vindos à festa! Password do wifi: party-wifi-2026.',
    });
    createPlazaPost(demoUsers[0], {
      type: 'poll',
      text: 'Qual foi o melhor momento da noite até agora?',
      options: ['A Rata', 'Best Look', 'A Plaza', 'Ainda não sei'],
    });
    console.log('[seed-demo] Added 1 Wall announcement and 1 poll.');
  }
}

export function seedDemoChat(demoUsers = seedDemoUsers()) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  if (existing > 0 || !demoUsers.length) return;
  // Enough voices to see the pseudonyms differ, which is the whole point of
  // this feed - the names are never the real ones.
  const lines = [
    'quem trouxe o gelo?',
    'a playlist está a carregar demasiado nos anos 2000 e ninguém se queixa',
    'alguém viu o meu casaco? preto, com um bolso rasgado',
    'confirmo que a sobremesa vale a pena esperar',
  ];
  lines.forEach((text, i) => postMessage(demoUsers[i % demoUsers.length], text));
  console.log(`[seed-demo] Added ${lines.length} Plaza messages.`);
}

export function seedDemoMemo(demoUsers = seedDemoUsers()) {
  const day = today();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM memo_uploads').get().n;
  if (existing > 0 || !demoUsers.length) return;

  // Needs slots to attach to, and needs them fired - an upload only makes
  // sense against a moment that actually happened.
  ensureTodaysSlots();
  const slots = db.prepare(
    'SELECT id FROM memo_slots WHERE day = ? ORDER BY scheduled_at LIMIT 2'
  ).all(day);
  if (!slots.length) return;
  db.prepare("UPDATE memo_slots SET notified_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id IN (" +
    slots.map(() => '?').join(',') + ')').run(...slots.map((s) => s.id));

  // Two moments from two different people, so the shared feed shows what it
  // is actually for: several guests on the same prompt, not one person's
  // roll. Real files on disk, because that is what the zip and the day
  // video read from - rows alone would make both fail on demo data.
  const ins = db.prepare(
    'INSERT INTO memo_uploads (slot_id, user_id, day, kind, mime_type, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  slots.forEach((slot, i) => {
    [demoUsers[i * 2 % demoUsers.length], demoUsers[(i * 2 + 1) % demoUsers.length]].forEach((userId, j) => {
      const png = solidPhoto(DEMO_PHOTO_COLORS[(i * 2 + j) % DEMO_PHOTO_COLORS.length], 480, 640);
      const name = `demo-${day}-${slot.id}-${userId}.png`;
      writeFileSync(join(MEMO_DIR, name), png);
      ins.run(slot.id, userId, day, 'photo', 'image/png', name, png.length);
    });
  });
  console.log(`[seed-demo] Added ${slots.length * 2} Memo uploads across ${slots.length} moments.`);
}

export function seedDemo() {
  const demoUsers = seedDemoUsers();
  seedDemoConsequences(demoUsers);
  seedDemoContestants(demoUsers);
  seedDemoWall(demoUsers);
  seedDemoChat(demoUsers);
}
