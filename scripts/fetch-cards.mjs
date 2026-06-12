// Red-card tally for the Red Mist award, via ESPN's public scoreboard JSON
// (keyless; football-data.org's free tier has no cards, API-Football's
// free plan doesn't cover the 2026 season).
//
//   node scripts/fetch-cards.mjs
//
// One request fetches every tournament match with card events embedded.
// A dismissal is counted when either:
//   - a detail is flagged redCard: true (straight red, most second yellows), or
//   - one player collects two yellowCard details in the same match and has
//     no redCard detail (ESPN sometimes logs second-yellow dismissals as
//     two yellows only — verified against the 2022 tournament).
//
// Also tallies penalty goals scored in normal play (scoringPlay +
// penaltyKick, excluding shoot-out attempts).
//
// Maintains cumulative totals in data/extras.json:
//   { "redCards": { "<teamId>": n }, "penGoals": { "<teamId>": n },
//     "tallied": ["espn-<eventId>", ...] }
// "tallied" prevents double-counting a match across runs. Run by
// .github/workflows/update-cards.yml — fully cloud-side, no manual entry.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=300';

// Map ESPN team display names to our team ids; unmatched names are logged
// loudly, never guessed.
const ALIASES = {
  france: ['france'], spain: ['spain'], argentina: ['argentina'],
  england: ['england'], portugal: ['portugal'], brazil: ['brazil'],
  netherlands: ['netherlands', 'holland'], morocco: ['morocco'],
  belgium: ['belgium'], germany: ['germany'], croatia: ['croatia'],
  colombia: ['colombia'], senegal: ['senegal'], mexico: ['mexico'],
  usa: ['usa', 'united states', 'united states of america'],
  uruguay: ['uruguay'], japan: ['japan'], switzerland: ['switzerland'],
  iran: ['iran', 'ir iran'], austria: ['austria'],
  ecuador: ['ecuador'], southkorea: ['south korea', 'korea republic'],
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
extras.penGoals = extras.penGoals || {};
extras.tallied = extras.tallied || [];
const tallied = new Set(extras.tallied);

const res = await fetch(URL);
if (!res.ok) {
  console.error(`ESPN scoreboard → HTTP ${res.status}`);
  process.exitCode = 1;
  throw new Error(`HTTP ${res.status}`);
}
const data = await res.json();

let newMatches = 0, added = 0;
for (const ev of data.events || []) {
  const key = `espn-${ev.id}`;
  if (ev.status?.type?.state !== 'post' || tallied.has(key)) continue;
  const comp = ev.competitions?.[0] || {};

  // ESPN team id → our team id, via the competitors' display names
  const espnToOurs = {};
  for (const c of comp.competitors || []) {
    const id = teamId(c.team?.displayName);
    if (id) espnToOurs[c.team?.id] = id;
  }

  // straight reds + flagged second yellows
  const details = comp.details || [];
  const redAthletes = new Set();
  for (const d of details.filter(d => d.redCard === true)) {
    const ours = espnToOurs[d.team?.id];
    if (ours) { extras.redCards[ours] = (extras.redCards[ours] || 0) + 1; added++; }
    (d.athletesInvolved || []).forEach(a => redAthletes.add(a.id));
  }
  // two yellows to one player with no red logged = second-yellow dismissal
  const yellowsByAthlete = {};
  for (const d of details.filter(d => d.yellowCard === true && !d.redCard)) {
    for (const a of d.athletesInvolved || []) {
      yellowsByAthlete[a.id] = yellowsByAthlete[a.id] || { n: 0, teamEspn: d.team?.id };
      yellowsByAthlete[a.id].n++;
    }
  }
  for (const [athleteId, y] of Object.entries(yellowsByAthlete)) {
    if (y.n >= 2 && !redAthletes.has(athleteId)) {
      const ours = espnToOurs[y.teamEspn];
      if (ours) { extras.redCards[ours] = (extras.redCards[ours] || 0) + 1; added++; }
    }
  }

  // penalty goals in normal play (shoot-out attempts excluded)
  for (const d of details.filter(d => d.scoringPlay === true && d.penaltyKick === true && !d.shootout)) {
    const ours = espnToOurs[d.team?.id];
    if (ours) extras.penGoals[ours] = (extras.penGoals[ours] || 0) + 1;
  }

  tallied.add(key);
  newMatches++;
  console.log(`${ev.name}: tallied`);
}

if (unmatched.size) console.warn(`UNMATCHED TEAM NAMES (fix ALIASES): ${[...unmatched].join(' | ')}`);

if (!newMatches) {
  console.log(`No newly finished matches (${extras.tallied.length} already tallied)`);
} else {
  extras.tallied = [...tallied].sort();
  writeFileSync(extrasPath, JSON.stringify(extras, null, 2) + '\n');
  console.log(`Tallied ${newMatches} match(es), ${added} red card(s) added. Totals: ${JSON.stringify(extras.redCards)}`);
}
