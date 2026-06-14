// Pulls World Cup 2026 fixtures & results from ESPN's public scoreboard
// (keyless, live — no API token, no free-tier delay) and writes
// data/results.json in the shape the leaderboard consumes.
//
//   node scripts/fetch-results.mjs
//
// Same source as scripts/fetch-cards.mjs, so results and cards stay
// consistent. Run on a schedule by .github/workflows/update-results.yml —
// no manual result entry anywhere. Set RESULTS_OUT to write elsewhere
// (used for parity testing).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { teams } = JSON.parse(readFileSync(join(root, 'data', 'teams.json'), 'utf8'));
const teamById = Object.fromEntries(teams.map(t => [t.id, t]));

// ESPN display names → our team ids (anything unmatched is logged loudly).
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
const normalize = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameToId = new Map();
for (const [id, names] of Object.entries(ALIASES)) for (const n of names) nameToId.set(n, id);
// ESPN lists unplayed knockout slots with placeholder names like
// "Group A Winner", "Round of 32 1 Winner", "Semifinal 1 Loser" — expected,
// resolve to null (TBD) without logging.
const PLACEHOLDER = /winner|loser|\bplace\b|round of|quarterfinal|semifinal|\bgroup [a-l]\b/i;
const unmatched = new Set();
function teamId(name) {
  const n = normalize(name);
  if (!n) return null;
  if (nameToId.has(n)) return nameToId.get(n);
  for (const [alias, id] of nameToId) if (n.includes(alias) || alias.includes(n)) return id;
  if (!PLACEHOLDER.test(name)) unmatched.add(name);
  return null;
}

// ESPN season.slug → our stage. Order matters: "quarterfinals"/"semifinals"
// both contain "final", so check those before the bare final.
function stageFromSlug(slug) {
  const s = (slug || '').toLowerCase();
  if (s.includes('group')) return 'group';
  if (s.includes('32')) return 'r32';
  if (s.includes('16')) return 'r16';
  if (s.includes('quarter')) return 'qf';
  if (s.includes('semi')) return 'sf';
  if (s.includes('third') || s.includes('3rd')) return 'third';
  if (s.includes('final')) return 'final';
  return null;
}

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=400');
if (!res.ok) {
  console.error(`ESPN scoreboard returned ${res.status}`);
  process.exitCode = 1;
  throw new Error(`HTTP ${res.status}`);
}
const data = await res.json();

const matches = (data.events || []).map(ev => {
  const stage = stageFromSlug(ev.season?.slug);
  if (!stage) { console.warn(`Skipping event with unknown stage slug: ${ev.season?.slug} (${ev.name})`); return null; }
  const comp = ev.competitions?.[0] || {};
  const homeC = (comp.competitors || []).find(c => c.homeAway === 'home');
  const awayC = (comp.competitors || []).find(c => c.homeAway === 'away');
  const home = teamId(homeC?.team?.displayName);
  const away = teamId(awayC?.team?.displayName);

  const st = ev.status?.type || {};
  let status;
  if (st.state === 'post' || st.completed) status = 'FINISHED';
  else if (st.state === 'in') status = 'IN_PLAY';
  else status = 'TIMED';
  const live = status === 'FINISHED' || status === 'IN_PLAY';

  const hs = live ? num(parseInt(homeC?.score, 10)) : null;
  const as = live ? num(parseInt(awayC?.score, 10)) : null;

  let winner = null;
  if (status === 'FINISHED') {
    if (homeC?.winner) winner = 'HOME_TEAM';
    else if (awayC?.winner) winner = 'AWAY_TEAM';
    else winner = 'DRAW';
  }

  const sname = st.name || '';
  let duration = 'REGULAR', penHome = null, penAway = null;
  if (/PEN/i.test(sname)) {
    duration = 'PENALTY_SHOOTOUT';
    const note = (comp.notes || []).map(n => n.headline || n.text || '').find(t => /penalt/i.test(t)) || '';
    const mm = note.match(/(\d+)\s*-\s*(\d+)/);          // "<winner> win A-B on penalties"
    if (mm) {
      const hi = Math.max(+mm[1], +mm[2]), lo = Math.min(+mm[1], +mm[2]);
      if (homeC?.winner) { penHome = hi; penAway = lo; } else { penHome = lo; penAway = hi; }
    }
  } else if (/AET|EXTRA/i.test(sname)) {
    duration = 'EXTRA_TIME';
  }

  return {
    stage,
    group: stage === 'group' && home && teamById[home] ? teamById[home].group : null,
    utcDate: ev.date ? new Date(ev.date).toISOString().replace('.000Z', 'Z') : null,
    status,
    home, away,
    hs, as, duration, penHome, penAway, winner,
  };
}).filter(Boolean);

// Stable order so the no-op check below is deterministic.
matches.sort((a, b) => (a.utcDate || '').localeCompare(b.utcDate || '') || (a.home || '').localeCompare(b.home || ''));

if (unmatched.size) {
  console.warn(`UNMATCHED TEAM NAMES (fix ALIASES): ${[...unmatched].join(' | ')}`);
}

const outPath = join(root, 'data', process.env.RESULTS_OUT || 'results.json');
let existing = null;
try { existing = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}

// Sticky scores: never let a real score we've already recorded be replaced
// by a null (defends against any transient feed gap; once a match has a
// score it doesn't change).
if (existing && Array.isArray(existing.matches)) {
  const key = m => `${m.stage}|${m.home}|${m.away}|${m.utcDate}`;
  const prior = new Map(existing.matches.map(m => [key(m), m]));
  for (const m of matches) {
    if (m.hs == null) {
      const p = prior.get(key(m));
      if (p && p.hs != null) {
        m.status = p.status; m.hs = p.hs; m.as = p.as;
        m.duration = p.duration; m.penHome = p.penHome; m.penAway = p.penAway; m.winner = p.winner;
        console.warn(`Kept prior score for ${m.home} v ${m.away} (feed returned null)`);
      }
    }
  }
}

const finishedCount = matches.filter(m => m.status === 'FINISHED').length;
if (existing && JSON.stringify(existing.matches) === JSON.stringify(matches)) {
  console.log(`No changes (${matches.length} matches, ${finishedCount} finished)`);
} else {
  writeFileSync(outPath, JSON.stringify({ updated: new Date().toISOString(), source: 'espn', matches }, null, 2) + '\n');
  console.log(`Wrote ${matches.length} matches (${finishedCount} finished)`);
}
