// Pulls weekly player stats and the schedule from the nflverse data releases,
// trims them to the offensive skill positions and returns compact JSON.
//
// The raw season file carries ~150 columns for every player including linemen
// and specialists, which is far too large to hand back through a Lambda. The
// trimming happens here so the browser only ever sees what it needs.

const RELEASES = 'https://github.com/nflverse/nflverse-data/releases/download';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);

// Only what the model actually uses. Everything else is dropped.
const KEEP = [
  'player_id', 'player_display_name', 'player_name', 'position', 'position_group',
  'season', 'week', 'season_type', 'team', 'opponent_team',
  'attempts', 'completions', 'passing_yards', 'passing_tds', 'passing_interceptions',
  'carries', 'rushing_yards', 'rushing_tds',
  'targets', 'receptions', 'receiving_yards', 'receiving_tds',
];

// --- season -----------------------------------------------------------------

// An NFL season is labelled by the year it starts in. January and February
// belong to the previous season's playoffs.
function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 2 ? y : y - 1;
}

// --- CSV --------------------------------------------------------------------

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

  if (!rows.length) return { header: [], records: [] };

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

  return { header, records };
}

function num(v) {
  if (v === undefined || v === '' || v === 'NA') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v) {
  if (v === undefined || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- fetching ---------------------------------------------------------------

async function fetchText(url, ms = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'timed out' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

// nflverse has renamed these files before, so try the known variants in turn
// and report which one answered rather than failing on a guess.
async function fetchFirst(candidates, attempts) {
  for (const url of candidates) {
    try {
      const text = await fetchText(url);
      attempts.push({ url, ok: true });
      return { url, text };
    } catch (err) {
      attempts.push({ url, ok: false, message: err.message });
    }
  }
  return null;
}

function playerStatUrls(season) {
  return [
    `${RELEASES}/player_stats/player_stats_${season}.csv`,
    `${RELEASES}/stats_player/stats_player_week_${season}.csv`,
    `${RELEASES}/player_stats/stats_player_week_${season}.csv`,
  ];
}

const SCHEDULE_URLS = [
  'https://github.com/nflverse/nfldata/raw/master/data/games.csv',
  `${RELEASES}/schedules/games.csv`,
  `${RELEASES}/schedules/schedules.csv`,
];

// --- shaping ----------------------------------------------------------------

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
    team,
    opp,
    att: num(r.attempts),
    cmp: num(r.completions),
    pyd: num(r.passing_yards),
    ptd: num(r.passing_tds),
    car: num(r.carries),
    ryd: num(r.rushing_yards),
    rtd: num(r.rushing_tds),
    tgt: num(r.targets),
    rec: num(r.receptions),
    cyd: num(r.receiving_yards),
    ctd: num(r.receiving_tds),
  };
}

function toGame(r) {
  const week = num(r.week);
  const season = num(r.season);
  if (!week || !season) return null;
  if (r.game_type && r.game_type !== 'REG') return null;

  return {
    id: r.game_id,
    season,
    week,
    date: r.gameday || null,
    time: r.gametime || null,
    home: (r.home_team || '').toUpperCase(),
    away: (r.away_team || '').toUpperCase(),
    homeScore: numOrNull(r.home_score),
    awayScore: numOrNull(r.away_score),
    // Negative spread means the home side is favoured.
    spread: numOrNull(r.spread_line),
    total: numOrNull(r.total_line),
  };
}

// --- handler ----------------------------------------------------------------

exports.handler = async (event) => {
  const season = Number(event?.queryStringParameters?.season) || currentSeason();
  const back = Math.min(Math.max(Number(event?.queryStringParameters?.back) || 1, 0), 3);

  const seasons = [];
  for (let i = 0; i <= back; i++) seasons.push(season - i);

  const attempts = [];
  const errors = [];
  const stats = [];
  const sources = {};

  await Promise.all(seasons.map(async (yr) => {
    const got = await fetchFirst(playerStatUrls(yr), attempts);
    if (!got) {
      errors.push({ dataset: 'player_stats', season: yr, message: 'no candidate URL responded' });
      return;
    }
    sources['player_stats_' + yr] = got.url;
    for (const rec of parseCsv(got.text, KEEP).records) {
      const row = toStatRow(rec);
      if (row) stats.push(row);
    }
  }));

  let games = [];
  const sched = await fetchFirst(SCHEDULE_URLS, attempts);
  if (sched) {
    sources.schedules = sched.url;
    games = parseCsv(sched.text).records
      .map(toGame)
      .filter(Boolean)
      .filter((g) => seasons.includes(g.season));
  } else {
    errors.push({ dataset: 'schedules', message: 'no candidate URL responded' });
  }

  stats.sort((a, b) => a.season - b.season || a.week - b.week);
  games.sort((a, b) => a.season - b.season || a.week - b.week);

  for (const a of attempts) if (!a.ok) console.error('fetch failed', a.url, a.message);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': stats.length
        ? 'public, max-age=10800, stale-while-revalidate=86400'
        : 'no-store',
    },
    body: JSON.stringify({
      fetchedAt: new Date().toISOString(),
      season,
      seasons,
      sources,
      stats,
      games,
      errors,
      attempts: attempts.filter((a) => !a.ok),
    }),
  };
};
