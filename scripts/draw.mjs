// Seeded, auditable sweepstake draw.
//
//   node scripts/draw.mjs
//
// Reads data/participants.json (names + seed), splits the 48 teams into
// 6 tiers of 8 by FIFA ranking, and gives every participant exactly one
// team per tier. Works for any headcount: with more than 8 people, teams
// within a tier are shared by multiple owners, never differing by more
// than one owner per team. Re-running with the same seed and the same
// name list (order included) reproduces the identical draw, so the draw
// can be independently verified by anyone.
//
// Writes data/draw.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { teams } = JSON.parse(readFileSync(join(root, 'data', 'teams.json'), 'utf8'));
const { names, seed, sample } = JSON.parse(readFileSync(join(root, 'data', 'participants.json'), 'utf8'));

if (!Array.isArray(names) || names.length < 2) {
  console.error('participants.json needs at least 2 names');
  process.exit(1);
}

// ── deterministic RNG (mulberry32 over a string hash) ──
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return h;
}
function mulberry32(a) {
  a = a >>> 0;
  return () => {
    a += 0x6D2B79F5; a >>>= 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(hashStr(seed || 'WC2026-OFFICE'));
const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const EMOJIS = ['⚽','🦁','🚀','🌟','🔥','🎯','🦅','🍀','🌈','🐯','🎸','🧊','🌶️','🦈','🎲','🪩','🥑','🐙','🛡️','🎷','🦄','🏄','🧨','🎺'];

const slug = (name, i) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '') || `p${i}`;

const players = shuffle(names).map((name, i) => ({
  id: slug(name, i),
  name,
  emoji: EMOJIS[i % EMOJIS.length],
  teams: [],
}));

// 6 tiers of 8 by FIFA ranking (tier 1 = ranks 1–8, … tier 6 = bottom 8)
const sorted = [...teams].sort((a, b) => a.rank - b.rank);
for (let tier = 0; tier < 6; tier++) {
  const tierTeams = sorted.slice(tier * 8, tier * 8 + 8);
  // Build an assignment pool of independently shuffled passes over the tier,
  // so ownership counts within a tier never differ by more than one.
  const pool = [];
  while (pool.length < players.length) pool.push(...shuffle(tierTeams));
  players.forEach((p, i) => p.teams.push({ id: pool[i].id, tier: tier + 1 }));
}

// Guard: nobody holds the same team twice (impossible by construction, but cheap to assert)
for (const p of players) {
  const ids = p.teams.map(t => t.id);
  if (new Set(ids).size !== ids.length) {
    console.error(`Duplicate team for ${p.name}: ${ids.join(', ')}`);
    process.exit(1);
  }
}

const out = {
  seed,
  sample: !!sample,
  generatedAt: new Date().toISOString(),
  players: players.sort((a, b) => a.name.localeCompare(b.name)),
};
writeFileSync(join(root, 'data', 'draw.json'), JSON.stringify(out, null, 2) + '\n');

console.log(`Draw complete — ${players.length} players, seed "${seed}"${sample ? ' (SAMPLE)' : ''}`);
for (const p of out.players) {
  const list = p.teams.map(t => `T${t.tier}:${t.id}`).join('  ');
  console.log(`  ${p.emoji} ${p.name.padEnd(12)} ${list}`);
}
