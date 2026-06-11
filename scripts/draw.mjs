// Seeded, auditable sweepstake draw.
//
//   node scripts/draw.mjs
//
// Reads data/participants.json (players + seed), splits the 48 teams into
// 6 tiers of 8 by FIFA ranking, and gives every participant exactly one
// team per tier. Works for any headcount: with more than 8 people, teams
// within a tier are shared by multiple owners, never differing by more
// than one owner per team. Re-running with the same seed and the same
// player list (order included) reproduces the identical draw, so the draw
// can be independently verified by anyone.
//
// Each player's emoji is the flag of their "who will win" pick. Players
// who didn't pick get a neutral ⚽.
//
// Writes data/draw.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { teams } = JSON.parse(readFileSync(join(root, 'data', 'teams.json'), 'utf8'));
const { players: entries, seed, sample } = JSON.parse(readFileSync(join(root, 'data', 'participants.json'), 'utf8'));

if (!Array.isArray(entries) || entries.length < 2) {
  console.error('participants.json needs at least 2 players');
  process.exit(1);
}

// ── flag emoji from ISO code (regional indicator pairs; GB subdivisions use tag sequences) ──
const SPECIAL_FLAGS = {
  'gb-eng': '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
  'gb-sct': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
};
const flagEmoji = iso => SPECIAL_FLAGS[iso] ||
  [...iso.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');

// ── resolve "who will win" picks to team ids ──
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, ' ').trim();
const byName = new Map(teams.map(t => [norm(t.name), t]));
byName.set('turkey', byName.get(norm('Türkiye')));
byName.set('bosnia', teams.find(t => t.id === 'bosnia'));
byName.set('bosnia and herzegovina', teams.find(t => t.id === 'bosnia'));

function resolvePick(pick) {
  if (!pick) return null;
  const t = byName.get(norm(pick));
  if (!t) {
    console.error(`Unrecognised pick "${pick}" — fix participants.json`);
    process.exit(1);
  }
  return t;
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

const usedIds = new Set();
const slug = name => {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'p';
  let id = base, n = 2;
  while (usedIds.has(id)) id = base + n++;
  usedIds.add(id);
  return id;
};

const players = shuffle(entries).map(e => {
  const pickTeam = resolvePick(e.pick);
  return {
    id: slug(e.name),
    name: e.name,
    pick: pickTeam ? pickTeam.id : null,
    emoji: pickTeam ? flagEmoji(pickTeam.iso) : '⚽',
    teams: [],
  };
});

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

// Guarantee no two players share an identical 6-team lineup. Vanishingly
// unlikely by chance, but if it happens it's repaired deterministically by
// swapping same-tier teams with another player — this preserves both the
// one-team-per-tier structure and the per-team owner counts.
const sig = p => p.teams.map(t => t.id).join('|');
let guard = 0;
while (guard < 1000) {
  const seen = new Set();
  let dup = null;
  for (const p of players) {
    const s = sig(p);
    if (seen.has(s)) { dup = p; break; }
    seen.add(s);
  }
  if (!dup) break;
  const tier = guard % 6;
  const partner = players[(players.indexOf(dup) + 1 + guard) % players.length];
  if (partner !== dup) {
    [dup.teams[tier], partner.teams[tier]] = [partner.teams[tier], dup.teams[tier]];
  }
  guard++;
}
if (guard >= 1000) {
  console.error('Could not make all lineups unique');
  process.exit(1);
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
const counts = {};
players.forEach(p => p.teams.forEach(t => counts[t.id] = (counts[t.id] || 0) + 1));
const spread = Object.values(counts);
console.log(`Owners per team: min ${Math.min(...spread)}, max ${Math.max(...spread)}`);
console.log(`No pick (neutral ⚽): ${players.filter(p => !p.pick).map(p => p.name).join(', ')}`);
console.log(`Unique lineups: ${new Set(players.map(sig)).size}/${players.length}${guard ? ` (after ${guard} repair swaps)` : ''}`);
