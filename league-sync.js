// ============================================================
// league-sync.js — footgoal.co
// Syncs 8 football leagues from football-data.org
// to Supabase + Webflow CMS
// Runs every 15 minutes via GitHub Actions + cron-job.org
// Does NOT touch World Cup collections (handled by sync.js)
// ============================================================

// ── ENV ──────────────────────────────────────────────────────
const SUPABASE_URL    = 'https://rpvdbjydzcuygpsxhaij.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const WEBFLOW_TOKEN   = process.env.WEBFLOW_TOKEN;
const FOOTBALL_KEY    = process.env.FOOTBALL_API_KEY;

// ── WEBFLOW COLLECTION IDs ────────────────────────────────────
const WF = {
  LEAGUES:     '6a32a8954e8d7db479514a79',
  TEAMS:       '6a20064807685f373db26660',
  STANDINGS:   '6a200649847c9fcb9278de02',
  MATCHES:     '6a200649c668e2cb8f11e82b',
  TOP_SCORERS: '6a32a89633c9bd6bea624094',
};

// ── LEAGUE CONFIG ─────────────────────────────────────────────
// code        = football-data.org competition code
// webflow_id  = Webflow Leagues collection item ID (created earlier)
// season      = current season year
const LEAGUES = [
  // European leagues: season = year it STARTED (2024 = 2024/25, use 2025 for 2025/26)
  // Brazilian league: season = calendar year (2025 = current season running Mar-Dec 2025)
  { code: 'PL',  name: 'Premier League',       webflow_id: '6a32a9cb63396a5393212f3a', season: 2024 },
  { code: 'CL',  name: 'UEFA Champions League', webflow_id: '6a32a9cb63396a5393212f3c', season: 2024 },
  { code: 'PD',  name: 'La Liga',               webflow_id: '6a32a9cb63396a5393212f3e', season: 2024 },
  { code: 'BL1', name: 'Bundesliga',            webflow_id: '6a32a9cb63396a5393212f40', season: 2024 },
  { code: 'SA',  name: 'Serie A',               webflow_id: '6a32a9cb63396a5393212f42', season: 2024 },
  { code: 'DED', name: 'Eredivisie',            webflow_id: '6a32a9cb63396a5393212f44', season: 2024 },
  { code: 'FL1', name: 'Ligue 1',               webflow_id: '6a32a9cb63396a5393212f46', season: 2024 },
  { code: 'BSA', name: 'Brasileiro Série A',    webflow_id: '6a32a9cb63396a5393212f48', season: 2025 },
];

// Zone mappings per league — what positions qualify for what
const ZONE_MAP = {
  PL:  { 1: 'champions-league', 2: 'champions-league', 3: 'champions-league', 4: 'champions-league', 5: 'europa-league', 6: 'uecl', 18: 'relegation', 19: 'relegation', 20: 'relegation' },
  PD:  { 1: 'champions-league', 2: 'champions-league', 3: 'champions-league', 4: 'champions-league', 5: 'europa-league', 6: 'uecl', 18: 'relegation', 19: 'relegation', 20: 'relegation' },
  BL1: { 1: 'champions-league', 2: 'champions-league', 3: 'champions-league', 4: 'champions-league', 5: 'europa-league', 6: 'uecl', 16: 'relegation', 17: 'relegation', 18: 'relegation' },
  SA:  { 1: 'champions-league', 2: 'champions-league', 3: 'champions-league', 4: 'champions-league', 5: 'europa-league', 6: 'uecl', 18: 'relegation', 19: 'relegation', 20: 'relegation' },
  DED: { 1: 'champions-league', 2: 'europa-league', 3: 'uecl', 17: 'relegation', 18: 'relegation' },
  FL1: { 1: 'champions-league', 2: 'champions-league', 3: 'champions-league', 4: 'europa-league', 5: 'uecl', 16: 'relegation', 17: 'relegation', 18: 'relegation' },
  CL:  {},
  BSA: { 1: 'libertadores', 2: 'libertadores', 3: 'libertadores', 4: 'libertadores', 5: 'libertadores', 6: 'libertadores', 7: 'libertadores-q', 8: 'sudamericana', 9: 'sudamericana', 10: 'sudamericana', 11: 'sudamericana', 12: 'sudamericana', 17: 'relegation', 18: 'relegation', 19: 'relegation', 20: 'relegation' },
};

// Rate limit delay — football-data.org free = 10 calls/min
const DELAY_MS = 6500;

// ── HELPERS ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(str) {
  return str.toLowerCase()
    .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n')
    .replace(/ç/g, 'c').replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function getZone(leagueCode, position) {
  const map = ZONE_MAP[leagueCode] || {};
  return map[position] || 'none';
}

function getFormString(form) {
  if (!form) return '';
  // football-data.org returns form as 'W,D,L,W,W' — convert to 'WDLWW'
  return form.replace(/,/g, '').slice(-5);
}

// ── FOOTBALL-DATA.ORG API ─────────────────────────────────────
async function footballFetch(path) {
  await sleep(DELAY_MS); // respect rate limit
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { 'X-Auth-Token': FOOTBALL_KEY }
  });
  if (res.status === 429) {
    console.warn('⏳ Rate limited — waiting 60s...');
    await sleep(60000);
    return footballFetch(path);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Football API ${res.status}: ${txt}`);
  }
  return res.json();
}

// ── SUPABASE ──────────────────────────────────────────────────
async function supabaseUpsert(table, data) {
  if (!data || (Array.isArray(data) && data.length === 0)) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${table}: ${err}`);
  }
  const count = Array.isArray(data) ? data.length : 1;
  console.log(`  ✅ Supabase: upserted ${count} rows to ${table}`);
}

// ── WEBFLOW API ───────────────────────────────────────────────
async function wfGetAllItems(collectionId) {
  let items = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?limit=${limit}&offset=${offset}`,
      { headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`Webflow GET items: ${res.status}`);
    const data = await res.json();
    items = items.concat(data.items || []);
    if (items.length >= (data.pagination?.total || 0)) break;
    offset += limit;
  }
  return items;
}

async function wfCreateItem(collectionId, fieldData) {
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({ fieldData, isDraft: true })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webflow CREATE: ${err}`);
  }
  return res.json();
}

async function wfUpdateItem(collectionId, itemId, fieldData) {
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({ fieldData })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webflow PATCH: ${err}`);
  }
  return res.json();
}

async function wfPublishItems(collectionId, itemIds) {
  if (!itemIds || itemIds.length === 0) return;
  // Publish in batches of 100
  for (let i = 0; i < itemIds.length; i += 100) {
    const batch = itemIds.slice(i, i + 100);
    const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/publish`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({ itemIds: batch })
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`  ⚠️ Publish warning: ${err}`);
    }
  }
}

// ── CORE SYNC FUNCTIONS ───────────────────────────────────────

// Build an index of existing Webflow items by a key field
// Returns Map<keyValue, item>
function indexBy(items, fieldName) {
  const map = new Map();
  for (const item of items) {
    const val = item.fieldData?.[fieldName];
    if (val != null) map.set(String(val), item);
  }
  return map;
}

// ── SYNC TEAMS ────────────────────────────────────────────────
async function syncTeams(league, apiTeams) {
  console.log(`  👕 Syncing ${apiTeams.length} teams for ${league.name}...`);

  const existing = await wfGetAllItems(WF.TEAMS);
  const bySlug = indexBy(existing, 'slug');
  const updatedIds = [];

  // Supabase rows
  const supaRows = [];

  for (const t of apiTeams) {
    const slug = slugify(t.name);
    const fieldData = {
      name: t.name,
      slug,
      'short-name': t.tla || t.shortName || t.name.substring(0, 3).toUpperCase(),
      league: league.webflow_id,
      city: t.venue || '',
      founded: t.founded || null,
      stadium: t.venue || '',
    };

    // Badge — football-data provides crest URL
    if (t.crest) {
      fieldData['badge'] = { url: t.crest };
    }

    supaRows.push({
      api_id: t.id,
      competition_code: league.code,
      name: t.name,
      short_name: t.tla || t.shortName,
      slug,
      crest: t.crest,
      venue: t.venue,
      founded: t.founded,
      updated_at: new Date().toISOString()
    });

    const existing_item = bySlug.get(slug);
    try {
      if (existing_item) {
        await wfUpdateItem(WF.TEAMS, existing_item.id, fieldData);
        updatedIds.push(existing_item.id);
      } else {
        const created = await wfCreateItem(WF.TEAMS, fieldData);
        updatedIds.push(created.id);
        console.log(`    ➕ Created team: ${t.name}`);
      }
      await sleep(1200);
    } catch (err) {
      console.error(`    ❌ Team ${t.name}: ${err.message}`);
    }
  }

  await supabaseUpsert('league_teams', supaRows);
  console.log(`  ✅ Teams done: ${updatedIds.length} items`);
  return updatedIds;
}

// ── SYNC STANDINGS ────────────────────────────────────────────
async function syncStandings(league, apiStandings) {
  console.log(`  📊 Syncing standings for ${league.name}...`);

  // Get current Webflow teams to build name→id map
  const wfTeams = await wfGetAllItems(WF.TEAMS);
  const teamBySlug = indexBy(wfTeams, 'slug');
  const teamByName = new Map();
  for (const t of wfTeams) {
    if (t.fieldData?.name) teamByName.set(t.fieldData.name.toLowerCase(), t);
  }

  const wfStandings = await wfGetAllItems(WF.STANDINGS);

  // Index existing standings by "league-teamslug" composite key
  const standingIndex = new Map();
  for (const s of wfStandings) {
    const teamRef = s.fieldData?.team;
    const leagueRef = s.fieldData?.league;
    if (teamRef && leagueRef === league.webflow_id) {
      standingIndex.set(teamRef, s);
    }
  }

  const updatedIds = [];
  const supaRows = [];

  for (const entry of apiStandings) {
    const teamName = entry.team.name;
    const teamSlug = slugify(teamName);
    const zone = getZone(league.code, entry.position);
    const form = getFormString(entry.form);

    // Find matching Webflow team
    const wfTeam = teamBySlug.get(teamSlug) || teamByName.get(teamName.toLowerCase());
    if (!wfTeam) {
      console.warn(`    ⚠️ No Webflow team found for: ${teamName}`);
      continue;
    }

    supaRows.push({
      competition_code: league.code,
      team_id: entry.team.id,
      team_name: teamName,
      position: entry.position,
      played: entry.playedGames,
      won: entry.won,
      drawn: entry.draw,
      lost: entry.lost,
      goals_for: entry.goalsFor,
      goals_against: entry.goalsAgainst,
      goal_difference: entry.goalDifference,
      points: entry.points,
      form,
      zone,
      updated_at: new Date().toISOString()
    });

    const fieldData = {
      name: `${teamName} - ${league.name}`,
      slug: `${teamSlug}-${league.code.toLowerCase()}-standing`,
      team: wfTeam.id,
      league: league.webflow_id,
      position: entry.position,
      played: entry.playedGames,
      won: entry.won,
      drawn: entry.draw,
      lost: entry.lost,
      'goals-for': entry.goalsFor,
      'goals-against': entry.goalsAgainst,
      'goal-difference': entry.goalDifference,
      points: entry.points,
      form,
      zone,
    };

    const existingStanding = standingIndex.get(wfTeam.id);
    try {
      if (existingStanding) {
        await wfUpdateItem(WF.STANDINGS, existingStanding.id, fieldData);
        updatedIds.push(existingStanding.id);
      } else {
        const created = await wfCreateItem(WF.STANDINGS, fieldData);
        updatedIds.push(created.id);
        console.log(`    ➕ Created standing: ${teamName}`);
      }
      await sleep(1200);
    } catch (err) {
      console.error(`    ❌ Standing ${teamName}: ${err.message}`);
    }
  }

  await supabaseUpsert('league_standings', supaRows);
  console.log(`  ✅ Standings done: ${updatedIds.length} items`);
  return updatedIds;
}

// ── SYNC MATCHES ──────────────────────────────────────────────
async function syncMatches(league, apiMatches) {
  console.log(`  ⚽ Syncing ${apiMatches.length} matches for ${league.name}...`);

  // Get Webflow teams for reference
  const wfTeams = await wfGetAllItems(WF.TEAMS);
  const teamBySlug = indexBy(wfTeams, 'slug');
  const teamByName = new Map();
  for (const t of wfTeams) {
    if (t.fieldData?.name) teamByName.set(t.fieldData.name.toLowerCase(), t);
  }

  // Get existing matches for this league
  const wfMatches = await wfGetAllItems(WF.MATCHES);
  const matchByApiId = new Map();
  for (const m of wfMatches) {
    const apiId = m.fieldData?.['api-fixture-id'];
    if (apiId) matchByApiId.set(String(apiId), m);
  }

  const updatedIds = [];
  const supaRows = [];
  const now = new Date();
  let featuredMatchId = null;
  let featuredMatchDate = null;

  // Sort matches by date to find next upcoming
  const sortedMatches = [...apiMatches].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  for (const m of sortedMatches) {
    const matchDate = new Date(m.utcDate);
    const homeSlug = slugify(m.homeTeam.name);
    const awaySlug = slugify(m.awayTeam.name);

    const homeTeam = teamBySlug.get(homeSlug) || teamByName.get(m.homeTeam.name.toLowerCase());
    const awayTeam = teamBySlug.get(awaySlug) || teamByName.get(m.awayTeam.name.toLowerCase());

    // Determine status
    let status = 'NS';
    if (m.status === 'FINISHED') status = 'FT';
    else if (m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.status === 'HALFTIME') status = 'LIVE';

    // Round label — handle both matchday and knockout rounds
    let roundLabel = '';
    if (m.matchday) roundLabel = `Gameweek ${m.matchday}`;
    else if (m.stage) roundLabel = m.stage.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Featured match — next upcoming after now
    const isUpcoming = status === 'NS' && matchDate > now;
    if (isUpcoming && (!featuredMatchDate || matchDate < featuredMatchDate)) {
      featuredMatchDate = matchDate;
      featuredMatchId = String(m.id);
    }

    supaRows.push({
      api_id: m.id,
      competition_code: league.code,
      season: league.season,
      matchday: m.matchday,
      stage: m.stage,
      status,
      utc_date: m.utcDate,
      home_team_id: m.homeTeam.id,
      home_team_name: m.homeTeam.name,
      away_team_id: m.awayTeam.id,
      away_team_name: m.awayTeam.name,
      home_score: m.score?.fullTime?.home ?? null,
      away_score: m.score?.fullTime?.away ?? null,
      round_label: roundLabel,
      updated_at: new Date().toISOString()
    });

    const fieldData = {
      name: `${m.homeTeam.name} vs ${m.awayTeam.name}`,
      slug: `${homeSlug}-vs-${awaySlug}-${m.id}`,
      league: league.webflow_id,
      'home-team': homeTeam?.id || null,
      'away-team': awayTeam?.id || null,
      'match-date': m.utcDate,
      'round-label': roundLabel,
      'home-score': m.score?.fullTime?.home ?? null,
      'away-score': m.score?.fullTime?.away ?? null,
      status,
      venue: m.venue || '',
      'is-featured': false, // set properly below
      'api-fixture-id': m.id,
    };

    const existingMatch = matchByApiId.get(String(m.id));
    try {
      if (existingMatch) {
        await wfUpdateItem(WF.MATCHES, existingMatch.id, fieldData);
        updatedIds.push(existingMatch.id);
      } else {
        const created = await wfCreateItem(WF.MATCHES, fieldData);
        updatedIds.push(created.id);
        // Track created item ID for featured match logic
        if (String(m.id) === featuredMatchId) featuredMatchId = created.id;
      }
      await sleep(1200);
    } catch (err) {
      console.error(`    ❌ Match ${m.homeTeam.name} vs ${m.awayTeam.name}: ${err.message}`);
    }
  }

  // Set is-featured on the next upcoming match
  // First reset all matches for this league to is-featured: false
  // Then set the featured one to true
  if (featuredMatchId) {
    // Refresh match list to get correct IDs
    const refreshed = await wfGetAllItems(WF.MATCHES);
    const featuredItem = refreshed.find(m =>
      String(m.fieldData?.['api-fixture-id']) === featuredMatchId ||
      m.id === featuredMatchId
    );
    if (featuredItem) {
      try {
        await wfUpdateItem(WF.MATCHES, featuredItem.id, { 'is-featured': true });
        console.log(`  ⭐ Featured match set: ${featuredItem.fieldData?.name}`);
      } catch (err) {
        console.warn(`  ⚠️ Could not set featured match: ${err.message}`);
      }
    }
  }

  await supabaseUpsert('league_matches', supaRows);
  console.log(`  ✅ Matches done: ${updatedIds.length} items`);
  return updatedIds;
}

// ── SYNC TOP SCORERS ──────────────────────────────────────────
async function syncTopScorers(league, apiScorers) {
  console.log(`  🥅 Syncing top scorers for ${league.name}...`);

  const wfTeams = await wfGetAllItems(WF.TEAMS);
  const teamBySlug = indexBy(wfTeams, 'slug');
  const teamByName = new Map();
  for (const t of wfTeams) {
    if (t.fieldData?.name) teamByName.set(t.fieldData.name.toLowerCase(), t);
  }

  const wfScorers = await wfGetAllItems(WF.TOP_SCORERS);
  const scorerBySlug = indexBy(wfScorers, 'slug');

  const updatedIds = [];
  const supaRows = [];

  // Top 10 only
  const top10 = apiScorers.slice(0, 10);

  for (const s of top10) {
    const playerSlug = `${slugify(s.player.name)}-${league.code.toLowerCase()}`;
    const teamSlug = slugify(s.team?.name || '');
    const wfTeam = teamBySlug.get(teamSlug) || teamByName.get((s.team?.name || '').toLowerCase());

    supaRows.push({
      competition_code: league.code,
      player_id: s.player.id,
      player_name: s.player.name,
      team_name: s.team?.name,
      goals: s.goals,
      assists: s.assists || 0,
      nationality: s.player.nationality,
      season: league.season,
      updated_at: new Date().toISOString()
    });

    const fieldData = {
      name: s.player.name,
      slug: playerSlug,
      league: league.webflow_id,
      team: wfTeam?.id || null,
      goals: s.goals || 0,
      assists: s.assists || 0,
      nationality: s.player.nationality || '',
      season: String(league.season),
    };

    const existingScorer = scorerBySlug.get(playerSlug);
    try {
      if (existingScorer) {
        await wfUpdateItem(WF.TOP_SCORERS, existingScorer.id, fieldData);
        updatedIds.push(existingScorer.id);
      } else {
        const created = await wfCreateItem(WF.TOP_SCORERS, fieldData);
        updatedIds.push(created.id);
        console.log(`    ➕ Created scorer: ${s.player.name}`);
      }
      await sleep(1200);
    } catch (err) {
      console.error(`    ❌ Scorer ${s.player.name}: ${err.message}`);
    }
  }

  await supabaseUpsert('league_scorers', supaRows);
  console.log(`  ✅ Top scorers done: ${updatedIds.length} items`);
  return updatedIds;
}

// ── UPDATE LEAGUE STATS ───────────────────────────────────────
async function updateLeagueStats(league, apiStandings, apiMatches) {
  const totalGoals = apiMatches
    .filter(m => m.status === 'FINISHED')
    .reduce((sum, m) => sum + (m.score?.fullTime?.home || 0) + (m.score?.fullTime?.away || 0), 0);

  const finishedMatches = apiMatches.filter(m => m.status === 'FINISHED').length;
  const goalsPerGame = finishedMatches > 0 ? (totalGoals / finishedMatches).toFixed(1) : '0.0';

  // Current matchday — highest matchday with at least one finished match
  const playedMatchdays = apiMatches
    .filter(m => m.status === 'FINISHED' && m.matchday)
    .map(m => m.matchday);
  const currentMatchday = playedMatchdays.length > 0 ? Math.max(...playedMatchdays) : 0;

  try {
    await wfUpdateItem(WF.LEAGUES, league.webflow_id, {
      'current-matchday': currentMatchday,
      'total-goals': totalGoals,
      'goals-per-game': goalsPerGame,
    });
    console.log(`  📈 League stats updated: MD${currentMatchday} | ${totalGoals} goals | ${goalsPerGame}/game`);
  } catch (err) {
    console.warn(`  ⚠️ League stats update failed: ${err.message}`);
  }
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('🔄 league-sync.js starting...');
  console.log(`⏰ ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  for (const league of LEAGUES) {
    console.log(`\n🏟️  Processing: ${league.name} (${league.code})`);

    try {
      // 1. Fetch teams
      console.log(`  📡 Fetching teams...`);
      const teamsData = await footballFetch(`/competitions/${league.code}/teams?season=${league.season}`);
      const teams = teamsData.teams || [];

      // 2. Fetch standings
      console.log(`  📡 Fetching standings...`);
      const standingsData = await footballFetch(`/competitions/${league.code}/standings?season=${league.season}`);
      // Use TOTAL type for leagues with multiple tables (e.g. CL group stage)
      const standingsTables = standingsData.standings || [];
      const totalStandings = standingsTables.find(s => s.type === 'TOTAL');
      const standingsToUse = totalStandings
        ? totalStandings.table
        : (standingsTables[0]?.table || []);

      // 3. Fetch matches
      console.log(`  📡 Fetching matches...`);
      const matchesData = await footballFetch(`/competitions/${league.code}/matches?season=${league.season}`);
      const matches = matchesData.matches || [];

      // 4. Fetch top scorers
      console.log(`  📡 Fetching top scorers...`);
      let scorers = [];
      try {
        const scorersData = await footballFetch(`/competitions/${league.code}/scorers?season=${league.season}&limit=10`);
        scorers = scorersData.scorers || [];
      } catch (err) {
        // Top scorers not available for all competitions (e.g. CL early stage)
        console.warn(`  ⚠️ Scorers not available: ${err.message}`);
      }

      // 5. Sync to Webflow + Supabase
      await syncTeams(league, teams);
      await syncStandings(league, standingsToUse);
      await syncMatches(league, matches);
      if (scorers.length > 0) await syncTopScorers(league, scorers);

      // 6. Update league stats
      await updateLeagueStats(league, standingsToUse, matches);

      console.log(`  🎉 ${league.name} complete`);

    } catch (err) {
      // Log error but continue with next league — don't let one failure stop the rest
      console.error(`  ❌ ${league.name} failed: ${err.message}`);
      console.error(err.stack);
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  console.log('\n🎉 league-sync.js complete!');
  console.log(`⏰ ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
