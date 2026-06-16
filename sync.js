const SUPABASE_URL = 'https://rpvdbjydzcuygpsxhaij.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const STANDINGS_COLLECTION = '69cb7c96b9d6bf4780c3453e';
const MATCHES_COLLECTION = '69d602cd83a7134a6382aede';

const NAME_MAP = {
  'Turkey': 'Türkiye', 'Curaçao': 'Curacao', 'Congo DR': 'DR Congo',
  'Cape Verde Islands': 'Cabo Verde', 'Bosnia-Herzegovina': 'Bosnia and Herzegovina',
  'South Korea': 'Korea Republic', "Côte d'Ivoire": 'Ivory Coast',
};

async function footballFetch(path) {
  const res = await fetch(`https://api.football-data.org/v4${path}`, { headers: { 'X-Auth-Token': FOOTBALL_API_KEY } });
  if (!res.ok) throw new Error(`Football API error: ${res.status}`);
  return res.json();
}

async function supabaseUpsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(data)
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Supabase error: ${err}`); }
  console.log(`✅ Supabase: upserted ${Array.isArray(data) ? data.length : 1} to ${table}`);
}

async function getWebflowItems(collectionId) {
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items?limit=100`, { headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'accept': 'application/json' } });
  const data = await res.json();
  return data.items;
}

async function updateWebflowItem(collectionId, itemId, fieldData) {
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ fieldData })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(err); }
  return res.json();
}

async function publishItems(collectionId, itemIds) {
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/publish`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ itemIds })
  });
  return res.json();
}

async function syncStandings(standings) {
  console.log('🌐 Updating Webflow standings...');
  const items = await getWebflowItems(STANDINGS_COLLECTION);
  const byName = {};
  for (const item of items) { byName[item.fieldData.name.trim().toLowerCase()] = item; }

  const updatedIds = [];
  const seen = new Set();
  for (const row of standings) {
    const apiName = NAME_MAP[row.team_name] || row.team_name;
    const key = apiName.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const item = byName[key];
    if (!item) { console.warn(`⚠️ No standing match: "${row.team_name}"`); continue; }
    try {
      await updateWebflowItem(STANDINGS_COLLECTION, item.id, {
        played: row.played_games, won: row.won, drawn: row.draw, lost: row.lost,
        'goals-for': row.goals_for, 'goals-against': row.goals_against,
        points: row.points, mp: row.played_games
      });
      updatedIds.push(item.id);
      console.log(`✅ Standing: ${apiName} Pts:${row.points}`);
      await new Promise(r => setTimeout(r, 1100));
    } catch (err) { console.error(`❌ Standing ${row.team_name}: ${err.message}`); }
  }
  if (updatedIds.length > 0) { await publishItems(STANDINGS_COLLECTION, updatedIds); console.log(`✅ Published ${updatedIds.length} standings`); }
}

async function syncMatches(apiMatches) {
  console.log('⚽ Updating Webflow match scores...');
  const items = await getWebflowItems(MATCHES_COLLECTION);

  const byTeams = {};
  for (const item of items) {
    const t1 = (item.fieldData['team-1-name'] || '').trim().toLowerCase();
    const t2 = (item.fieldData['team-2-name'] || '').trim().toLowerCase();
    if (t1 && t2 && t1 !== 'tbd' && t2 !== 'tbd') {
      const key = [t1, t2].sort().join('|');
      byTeams[key] = item;
    }
  }

  const updatedIds = [];
  for (const m of apiMatches) {
    if (m.status !== 'FINISHED') continue;
    const homeName = (NAME_MAP[m.homeTeam.name] || m.homeTeam.name).trim().toLowerCase();
    const awayName = (NAME_MAP[m.awayTeam.name] || m.awayTeam.name).trim().toLowerCase();
    const key = [homeName, awayName].sort().join('|');
    const item = byTeams[key];
    if (!item) { console.warn(`⚠️ No match item for: ${m.homeTeam.name} vs ${m.awayTeam.name}`); continue; }

    const cmsT1 = (item.fieldData['team-1-name'] || '').trim().toLowerCase();
    const isHomeTeam1 = cmsT1 === homeName;
    const homeScore = m.score?.fullTime?.home ?? null;
    const awayScore = m.score?.fullTime?.away ?? null;

    try {
      await updateWebflowItem(MATCHES_COLLECTION, item.id, {
        'team-1-score': String(isHomeTeam1 ? homeScore : awayScore),
        'team-2-score': String(isHomeTeam1 ? awayScore : homeScore),
        'past-matches': true,
        'match-status': 'Finished'
      });
      updatedIds.push(item.id);
      console.log(`✅ Match: ${m.homeTeam.name} ${homeScore}-${awayScore} ${m.awayTeam.name}`);
      await new Promise(r => setTimeout(r, 1100));
    } catch (err) { console.error(`❌ Match ${m.homeTeam.name} vs ${m.awayTeam.name}: ${err.message}`); }
  }
  if (updatedIds.length > 0) { await publishItems(MATCHES_COLLECTION, updatedIds); console.log(`✅ Published ${updatedIds.length} match scores`); }
}

async function main() {
  console.log('🔄 Starting footgoal.co sync...');

  console.log('📊 Fetching WC standings...');
  const standingsData = await footballFetch('/competitions/WC/standings?season=2026');
  const teamsMap = new Map();
  const standings = [];
  for (const standing of standingsData.standings) {
    for (const entry of standing.table) {
      const team = entry.team;
      if (!teamsMap.has(team.id)) teamsMap.set(team.id, { id: team.id, name: team.name, short_name: team.shortName, tla: team.tla, crest: team.crest });
      standings.push({ competition_code: 'WC', season: 2026, group_name: standing.group, team_id: team.id, team_name: team.name, team_crest: team.crest, position: entry.position, played_games: entry.playedGames, won: entry.won, draw: entry.draw, lost: entry.lost, goals_for: entry.goalsFor, goals_against: entry.goalsAgainst, goal_difference: entry.goalDifference, points: entry.points, updated_at: new Date().toISOString() });
    }
  }
  await supabaseUpsert('teams', Array.from(teamsMap.values()));
  await supabaseUpsert('standings', standings);

  console.log('⚽ Fetching WC matches...');
  const matchData = await footballFetch('/competitions/WC/matches?season=2026');
  const matchesMap = new Map();
  for (const m of matchData.matches) {
    matchesMap.set(m.id, { id: m.id, competition_code: 'WC', season: 2026, matchday: m.matchday, stage: m.stage, group_name: m.group, status: m.status, utc_date: m.utcDate, home_team_id: m.homeTeam.id, home_team_name: m.homeTeam.name, home_team_crest: m.homeTeam.crest, away_team_id: m.awayTeam.id, away_team_name: m.awayTeam.name, away_team_crest: m.awayTeam.crest, home_score: m.score?.fullTime?.home ?? null, away_score: m.score?.fullTime?.away ?? null, winner: m.score?.winner ?? null, updated_at: new Date().toISOString() });
  }
  await supabaseUpsert('matches', Array.from(matchesMap.values()));

  await syncStandings(standings);
  await syncMatches(matchData.matches);

  console.log('🎉 Sync complete!');
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
