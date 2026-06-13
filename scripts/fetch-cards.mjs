// Card + penalty tally for the special prizes, via ESPN's public
// scoreboard JSON (keyless; football-data.org's free tier has no cards,
// API-Football's free plan doesn't cover the 2026 season).
//
//   node scripts/fetch-cards.mjs
//
// One request fetches every tournament match with card events embedded.
// Cards are counted PER PLAYER PER MATCH to avoid double-counting a
// second-yellow dismissal (ESPN logs that as one Yellow Card event for the
// first booking plus one Red Card event for the sending-off — verified
// against the 2022 tournament):
//   - if a player has any red, OR two yellows, in a match → 1 red, 0 yellows
//     for that player that match (the sending-off subsumes the booking);
//   - otherwise → their yellows count as yellows.
// So every sending-off is exactly one red and is never also counted as a
// yellow. Card score elsewhere = reds×2 + yellows×1.
//
// Also tallies penalty goals scored in normal play (scoringPlay +
// penaltyKick, excluding shoot-out attempts).
//
// Maintains cumulative totals in data/extras.json:
//   { "redCards": {…}, "yellowCards": {…}, "penGoals": {…},
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
extras.yellowCards = extras.yellowCards || {};
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

  // tally cards per player, then resolve each player's match once so a
  // second-yellow dismissal becomes a single red, never a yellow + red
  const details = comp.details || [];
  const perAthlete = {};   // athleteId → { teamEspn, yellows, reds }
  for (const d of details) {
    if (!d.yellowCard && !d.redCard) continue;
    for (const a of d.athletesInvolved || []) {
      const rec = perAthlete[a.id] || (perAthlete[a.id] = { teamEspn: d.team?.id, yellows: 0, reds: 0 });
      if (d.redCard) rec.reds++;
      else if (d.yellowCard) rec.yellows++;
    }
  }
  for (const rec of Object.values(perAthlete)) {
    const ours = espnToOurs[rec.teamEspn];
    if (!ours) continue;
    const sentOff = rec.reds > 0 || rec.yellows >= 2;   // second yellow ⇒ red
    if (sentOff) { extras.redCards[ours] = (extras.redCards[ours] || 0) + 1; added++; }
    else if (rec.yellows > 0) { extras.yellowCards[ours] = (extras.yellowCards[ours] || 0) + rec.yellows; added += rec.yellows; }
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
  console.log(`Tallied ${newMatches} match(es). Reds: ${JSON.stringify(extras.redCards)} Yellows: ${JSON.stringify(extras.yellowCards)}`);
}
