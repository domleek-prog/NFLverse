// Fetches weekly player stats and the schedule from nflverse, trims them to
// the offensive skill positions, and writes data/data.json.
//
// Run by .github/workflows/update-data.yml on a schedule. Also runnable by
// hand: `node scripts/fetch-nfl.mjs`

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/data.json');

const RELEASES = 'https://github.com/nflverse/nflverse-data/releases/download';
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);

const KEEP = [
  'player_id', 'player_display_name', 'player_name', 'position', 'position_group',
  'season', 'week', 'season_type', 'team', 'opponent_team',
  'attempts', 'completions', 'passing_yards', 'passing_tds', 'passing_interceptions',
  'carries', 'rushing_yards', 'rushing_tds',
  'targets', 'receptions', 'receiving_yards', 'receiving_tds',
];

const SEASONS_BACK = Number(process.env.SEASONS_BACK || 1);

function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 2 ? y : y - 1;
}

function parseCsv(text, keep) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  row.push(field);
  rows.push(row);

  if (!rows.length) return [];

  const header = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  const wanted = keep
    ? header.map((h, i) => (keep.includes(h) ? i : -1)).filter((i) => i >= 0)
    : header.map((_, i) => i);

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r];
    if (!raw.some((v) => v !== '')) continue;
    const obj = {};
    for (const i of wanted) obj[header[i]] = (raw[i] ?? '').trim();
    records.push(obj);
  }
  return records;
}

const num = (v) => {
  if (v === undefined || v === '' || v === 'NA') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (v) => {
  if (v === undefined || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'nfl-matchup-updater (github actions)',
      'Accept': 'text/csv,text/plain,*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// nflverse has renamed these files before, so try the known variants and
// record which one answered.
async function fetchFirst(candidates, attempts) {
  for (const url of candidates) {
    try {
      const text = await fetchText(url);
      attempts.push({ url, ok: true });
      return { url, text };
    } catch (err) {
      attempts.push({ url, ok: false, message: err.message });
      console.warn(`  miss  ${url} — ${err.message}`);
    }
  }
  return null;
}

const playerStatUrls = (season) => [
  `${RELEASES}/player_stats/player_stats_${season}.csv`,
  `${RELEASES}/stats_player/stats_player_week_${season}.csv`,
  `${RELEASES}/player_stats/stats_player_week_${season}.csv`,
];

const SCHEDULE_URLS = [
  'https://github.com/nflverse/nfldata/raw/master/data/games.csv',
  `${RELEASES}/schedules/games.csv`,
  `${RELEASES}/schedules/schedules.csv`,
];

function toStatRow(r) {
  const pos = (r.position || '').toUpperCase();
  const group = (r.position_group || '').toUpperCase();
  if (!SKILL.has(pos) && !SKILL.has(group)) return null;
  if (r.season_type && r.season_type !== 'REG') return null;

  const team = (r.team || '').toUpperCase();
  const opp = (r.opponent_team || '').toUpperCase();
  if (!team || !opp) return null;

  return {
    id: r.player_id,
    name: r.player_display_name || r.player_name,
    pos: SKILL.has(pos) ? pos : group,
    season: num(r.season),
    week: num(r.week),
    team, opp,
    att: num(r.attempts), cmp: num(r.completions),
    pyd: num(r.passing_yards), ptd: num(r.passing_tds),
    car: num(r.carries), ryd: num(r.rushing_yards), rtd: num(r.rushing_tds),
    tgt: num(r.targets), rec: num(r.receptions),
    cyd: num(r.receiving_yards), ctd: num(r.receiving_tds),
  };
}

function toGame(r) {
  const week = num(r.week), season = num(r.season);
  if (!week || !season) return null;
  if (r.game_type && r.game_type !== 'REG') return null;
  return {
    id: r.game_id, season, week,
    date: r.gameday || null,
    time: r.gametime || null,
    home: (r.home_team || '').toUpperCase(),
    away: (r.away_team || '').toUpperCase(),
    homeScore: numOrNull(r.home_score),
    awayScore: numOrNull(r.away_score),
    spread: numOrNull(r.spread_line),
    total: numOrNull(r.total_line),
  };
}

async function main() {
  const season = Number(process.env.SEASON) || currentSeason();
  const seasons = [];
  for (let i = 0; i <= SEASONS_BACK; i++) seasons.push(season - i);

  console.log(`Season ${season}, loading ${seasons.join(', ')}`);

  const attempts = [];
  const errors = [];
  const sources = {};
  const stats = [];

  for (const yr of seasons) {
    const got = await fetchFirst(playerStatUrls(yr), attempts);
    if (!got) {
      errors.push({ dataset: 'player_stats', season: yr, message: 'no candidate URL responded' });
      continue;
    }
    sources['player_stats_' + yr] = got.url;
    let kept = 0;
    for (const rec of parseCsv(got.text, KEEP)) {
      const row = toStatRow(rec);
      if (row) { stats.push(row); kept++; }
    }
    console.log(`  ok    ${yr}: ${kept} skill-position player games`);
  }

  let games = [];
  const sched = await fetchFirst(SCHEDULE_URLS, attempts);
  if (sched) {
    sources.schedules = sched.url;
    games = parseCsv(sched.text).map(toGame).filter(Boolean)
      .filter((g) => seasons.includes(g.season));
    console.log(`  ok    schedule: ${games.length} games`);
  } else {
    errors.push({ dataset: 'schedules', message: 'no candidate URL responded' });
  }

  if (!stats.length) {
    console.error('No stats retrieved — leaving the existing data file alone.');
    process.exit(1);
  }

  stats.sort((a, b) => a.season - b.season || a.week - b.week);
  games.sort((a, b) => a.season - b.season || a.week - b.week);

  const payload = {
    fetchedAt: new Date().toISOString(),
    season, seasons, sources, stats, games, errors,
    attempts: attempts.filter((a) => !a.ok),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));

  const mb = (JSON.stringify(payload).length / 1048576).toFixed(2);
  console.log(`Wrote ${OUT} — ${stats.length} player games, ${games.length} games, ${mb} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
