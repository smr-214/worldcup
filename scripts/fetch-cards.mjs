// Red-card tally for the Red Mist award, via API-Football (free tier
// includes match events; football-data.org's free tier does not).
//
//   APIFOOTBALL_KEY=xxx node scripts/fetch-cards.mjs
//
// Counts red cards (incl. second yellows, which API-Football reports as
// "Red Card" events) per national team across all finished matches, and
// maintains cumulative totals in data/extras.json:
//
//   { "redCards": { "<teamId>": n }, "tallied": ["af-<fixtureId>", ...] }
//
// "tallied" prevents double-counting a fixture across runs. Run by
// .github/workflows/update-cards.yml — fully cloud-side, no manual entry.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { teams } = JSON.parse(readFileSync(join(root, 'data', 'teams.json'), 'utf8'));

const KEY = process.env.APIFOOTBALL_KEY;
if (!KEY) {
  // Exit 0 so scheduled runs don't show as failures before the secret is set.
  console.warn('APIFOOTBALL_KEY not set — skipping card tally. Get a free key at https://dashboard.api-football.com');
  process.exit(0);
}

const API = 'https://v3.football.api-sports.io';
const LEAGUE = 1;       // FIFA World Cup
const SEASON = 2026;

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers: { 'x-apisports-key': KEY } });
  if (!res.ok) throw new Error(`API-Football ${path} → HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors && Object.keys(body.errors).length) {
    throw new Error(`API-Football ${path} → ${JSON.stringify(body.errors)}`);
  }
  return body.response;
}

// Map API-Football team names to our team ids (same alias strategy as
// fetch-results.mjs; unmatched names are logged loudly, never guessed).
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
const normalize = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameToId = new Map();
for (const [id, names] of Object.entries(ALIASES)) for (const n of names) nameToId.set(n, id);
const unmatched = new Set();
function teamId(name) {
  const n = normalize(name || '');
  if (nameToId.has(n)) return nameToId.get(n);
  for (const [alias, id] of nameToId) if (n.includes(alias) || alias.includes(n)) return id;
  unmatched.add(name);
  return null;
}

const extrasPath = join(root, 'data', 'extras.json');
const extras = JSON.parse(readFileSync(extrasPath, 'utf8'));
extras.redCards = extras.redCards || {};
extras.tallied = extras.tallied || [];
const tallied = new Set(extras.tallied);

const FINISHED = new Set(['FT', 'AET', 'PEN']);
const fixtures = await get(`/fixtures?league=${LEAGUE}&season=${SEASON}`);
const newlyFinished = fixtures.filter(f =>
  FINISHED.has(f.fixture?.status?.short) && !tallied.has(`af-${f.fixture.id}`));

if (!newlyFinished.length) {
  console.log(`No newly finished fixtures to tally (${extras.tallied.length} already done)`);
  process.exit(0);
}

let added = 0;
for (const f of newlyFinished) {
  const events = await get(`/fixtures/events?fixture=${f.fixture.id}`);
  const reds = events.filter(e => e.type === 'Card' && /red/i.test(e.detail || ''));
  for (const e of reds) {
    const id = teamId(e.team?.name);
    if (id) { extras.redCards[id] = (extras.redCards[id] || 0) + 1; added++; }
  }
  tallied.add(`af-${f.fixture.id}`);
  console.log(`${f.teams?.home?.name} vs ${f.teams?.away?.name}: ${reds.length} red card(s)`);
}

if (unmatched.size) console.warn(`UNMATCHED TEAM NAMES (fix ALIASES): ${[...unmatched].join(' | ')}`);

extras.tallied = [...tallied].sort();
writeFileSync(extrasPath, JSON.stringify(extras, null, 2) + '\n');
console.log(`Tallied ${newlyFinished.length} fixture(s), ${added} red card(s) added. Totals: ${JSON.stringify(extras.redCards)}`);
