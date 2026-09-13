#!/usr/bin/env node
/**
 * Checks, against the real API, that translations come back in European
 * Portuguese rather than Brazilian.
 *
 *   node scripts/check-translation.mjs
 *
 * Not part of `npm test` on purpose: the suite must never reach the API, so
 * it can only guard the instruction (see the prompt test in api.test.js).
 * This is the other half - it guards the actual output, and costs about a
 * tenth of a cent to run.
 *
 * Needs ANTHROPIC_API_KEY, which it reads from .env like the app does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const key = env.match(/^ANTHROPIC_API_KEY="?([^"\n]+)/m)?.[1];
if (!key) {
  console.error('no ANTHROPIC_API_KEY in .env - nothing to check against');
  process.exit(1);
}
process.env.ANTHROPIC_API_KEY = key;

const { translateText } = await import(path.join(ROOT, 'src/translate.js'));

// Each line is a sentence whose translation differs between Portugal and
// Brazil. `want` must appear; any of `avoid` failing the check means the
// model has drifted.
const CASES = [
  { en: 'you have to drink a glass of water', want: /tens de|tens que/i, avoid: [/você/i] },
  { en: 'give your mobile phone to someone',  want: /telemóvel/i,        avoid: [/celular/i] },
  { en: 'go to the bathroom and sing',        want: /casa de banho/i,    avoid: [/banheiro/i] },
  { en: 'share your juice with the team',     want: /sumo/i,             avoid: [/suco/i, /equipe\b/i] },
  { en: 'show everyone your screen',          want: /ecrã/i,             avoid: [/\btela\b/i] },
  { en: "you're dancing on the table now",    want: /estás a dançar/i,   avoid: [/dançando/i] },
  { en: 'take the bus home',                  want: /autocarro/i,        avoid: [/ônibus/i] },
];

let bad = 0;
for (const c of CASES) {
  const out = (await translateText(c.en, 'pt')) ?? '';
  const missing = !c.want.test(out);
  const wrong = c.avoid.filter((re) => re.test(out));
  const ok = !missing && wrong.length === 0;
  if (!ok) bad += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${out || '(no translation)'}`);
  if (missing) console.log(`         expected something matching ${c.want}`);
  for (const re of wrong) console.log(`         found brazilian form ${re}`);
}

console.log(bad === 0
  ? `\nall ${CASES.length} came back in european portuguese`
  : `\n${bad} of ${CASES.length} drifted - check the house rules in src/translate.js`);
process.exit(bad === 0 ? 0 : 1);
