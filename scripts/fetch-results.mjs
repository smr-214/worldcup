// Pulls World Cup 2026 fixtures & results from football-data.org (free tier)
// and writes data/results.json in the shape the leaderboard consumes.
//
//   FOOTBALL_DATA_TOKEN=xxx node scripts/fetch-results.mjs
//
// Run on a schedule by .github/workflows/update-results.yml — no manual
// result entry anywhere.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { teams } = JSON.parse(readFileSync(join(root, 'data', 'teams.json'), 'utf8'));

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) {
  console.error('FOOTBALL_DATA_TOKEN not set — get a free key at https://www.football-data.org/client/register');
  process.exit(1);
}

// Map football-data.org team names to our ids. Aliases cover the naming
// variants the API has used across tournaments; anything unmatched is
// logged loudly so it shows up in the Action log instead of silently
// dropping a team's results.
const ALIASES = {
  france: ['france'], spain: ['spain'], argentina: ['argentina'],
  england: ['england'], portugal: ['portugal'], brazil: ['brazil'],
  netherlands: ['netherlands', 'holland'], morocco: ['morocco'],
  belgium: ['belgium'], germany: ['germany'], croatia: ['croatia'],
  colombia: ['colombia'], senegal: ['senegal'], mexico: ['mexico'],
  usa: ['usa', 'united states', 'united states of america'],
  uruguay: ['uruguay'], japan: ['japan'], switzerland: ['switzerland'],
  iran: ['iran', 'ir iran', 'iran ir'], austria: ['austria'],
  ecuador: ['ecuador'], southkorea: ['south korea', 'korea republic', 'korea'],
  australia: ['australia'], egypt: ['egypt'], canada: ['canada'],
  ivorycoast: ['ivory coast', 'cote divoire', 'cote d ivoire'],
  qatar: ['qatar'], algeria: ['algeria'], sweden: ['sweden'],
  tunisia: ['tunisia'], czechia: ['czechia', 'czech republic'],
  turkey: ['turkiye', 'turkey'], norway: ['norway'], scotland: ['scotland'],
  drcongo: ['dr congo', 'congo dr', 'democratic republic of the congo'],
  bosnia: ['bosnia and herzegovina', 'bosnia herzegovina', 'bosnia'],
  panama: ['panama'], saudi: ['saudi arabia'], southafrica: ['south africa'],
  iraq: ['iraq'], uzbekistan: ['uzbekistan'], paraguay: ['paraguay'],
  ghana: ['ghana'], jordan: ['jordan'], capeverde: ['cape verde', 'cabo verde'],
  curacao: ['curacao'], haiti: ['haiti'], newzealand: ['new zealand'],
};

const normalize = s => s
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
  .replace(/[^a-z ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const nameToId = new Map();
for (const [id, names] of Object.entries(ALIASES)) {
  for (const n of names) nameToId.set(n, id);
}

const unmatched = new Set();
function teamId(apiTeam) {
  if (!apiTeam || !apiTeam.name) return null;
  const n = normalize(apiTeam.name);
  if (nameToId.has(n)) return nameToId.get(n);
  // fallback: containment either way (handles e.g. "Korea Republic KOR")
  for (const [alias, id] of nameToId) {
    if (n.includes(alias) || alias.includes(n)) return id;
  }
  unmatched.add(apiTeam.name);
  return null;
}

const STAGE_MAP = {
  GROUP_STAGE: 'group',
  LAST_32: 'r32', ROUND_OF_32: 'r32',
  LAST_16: 'r16', ROUND_OF_16: 'r16',
  QUARTER_FINALS: 'qf',
  SEMI_FINALS: 'sf',
  THIRD_PLACE: 'third', THIRD_PLACE_PLAYOFF: 'third',
  FINAL: 'final',
};

const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
  headers: { 'X-Auth-Token': TOKEN },
});
if (!res.ok) {
  // process.exitCode (not process.exit) — exiting mid-teardown of the fetch
  // socket trips a libuv assertion on Windows and clobbers the exit code.
  console.error(`football-data.org returned ${res.status}: ${await res.text()}`);
  process.exitCode = 1;
  throw new Error(`HTTP ${res.status}`);
}
const data = await res.json();

// Scores must be finite numbers or null — the site interpolates them into
// HTML, so this also guarantees nothing string-shaped from the API can
// reach the page.
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

const matches = (data.matches || []).map(m => {
  const stage = STAGE_MAP[m.stage];
  if (!stage) { console.warn(`Skipping unknown stage: ${m.stage}`); return null; }
  const home = teamId(m.homeTeam);
  const away = teamId(m.awayTeam);
  const live = m.status === 'FINISHED' || m.status === 'IN_PLAY' || m.status === 'PAUSED';
  return {
    stage,
    group: m.group ? String(m.group).replace('GROUP_', '').slice(0, 2) : null,
    utcDate: m.utcDate,
    status: m.status,            // SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED ...
    home, away,                  // null until the API knows the team (e.g. unplayed knockout slots)
    hs: live ? num(m.score?.fullTime?.home) : null,
    as: live ? num(m.score?.fullTime?.away) : null,
    duration: m.score?.duration || 'REGULAR',           // REGULAR | EXTRA_TIME | PENALTY_SHOOTOUT
    penHome: num(m.score?.penalties?.home),
    penAway: num(m.score?.penalties?.away),
    winner: m.score?.winner || null,                    // HOME_TEAM | AWAY_TEAM | DRAW
  };
}).filter(Boolean);

if (unmatched.size) {
  console.warn(`UNMATCHED TEAM NAMES (fix ALIASES): ${[...unmatched].join(' | ')}`);
}

// Only rewrite the file when the data actually changed, so the scheduled
// Action doesn't create a no-op commit (and Pages rebuild) every run.
const outPath = join(root, 'data', 'results.json');
let existing = null;
try { existing = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
const finishedCount = matches.filter(m => m.status === 'FINISHED').length;
if (existing && JSON.stringify(existing.matches) === JSON.stringify(matches)) {
  console.log(`No changes (${matches.length} matches, ${finishedCount} finished)`);
} else {
  const out = {
    updated: new Date().toISOString(),
    source: 'football-data.org',
    matches,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${matches.length} matches (${finishedCount} finished)`);
}
