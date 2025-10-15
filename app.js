// app.js — TV Tracker (group by seasons, TVmaze import, SQLite persistence)
const express = require('express');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const layouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3002;

// ---------- Basic setup ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(layouts); // If you don't use a layout, remove this line and the layout option in res.render
app.set('layout', 'layout'); // expects views/layout.ejs
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- SQLite (file in ./data) ----------
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new sqlite3.Database(path.join(dataDir, 'tvtracker.db'));

const run = (sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, function (err) { err ? rej(err) : res(this); }));
const all = (sql, params = []) =>
  new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
const get = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tvmaze_id INTEGER UNIQUE,
    title TEXT NOT NULL,
    image TEXT,
    summary TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id INTEGER NOT NULL,
    tvmaze_id INTEGER,
    season INTEGER,
    number INTEGER,
    name TEXT,
    airdate TEXT,
    watched INTEGER DEFAULT 0,
    UNIQUE(show_id, season, number),
    FOREIGN KEY(show_id) REFERENCES shows(id) ON DELETE CASCADE
  )`);
}

// ---------- TVmaze helpers ----------
async function searchTvmaze(query) {
  const url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return (data || []).map(r => {
    const s = r.show || {};
    return {
      tvmaze_id: s.id,
      title: s.name,
      image: s.image ? (s.image.medium || s.image.original) : '',
      summary: s.summary || ''
    };
  });
}

async function fetchTvmazeEpisodes(tvmazeId) {
  const url = `https://api.tvmaze.com/shows/${tvmazeId}/episodes`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return (data || []).map(e => ({
    tvmaze_id: e.id,
    season: e.season || 0,
    number: e.number || 0,
    name: e.name || `Episode ${e.number}`,
    airdate: e.airdate || ''
  }));
}

/**
 * Upsert a show and its episodes into the DB.
 * Returns the local show_id.
 */
async function ensureShow(tvmazeId) {
  let show = await get(`SELECT * FROM shows WHERE tvmaze_id = ?`, [tvmazeId]);
  if (!show) {
    // Look up show info from search endpoint (quick + enough data)
    const info = (await searchTvmaze(String(tvmazeId)))[0];
    // If search by ID fails to match, fall back to /shows/:id
    let title = info?.title || '';
    let image = info?.image || '';
    let summary = info?.summary || '';
    if (!title) {
      const { data: s } = await axios.get(`https://api.tvmaze.com/shows/${tvmazeId}`, { timeout: 15000 });
      title = s?.name || '';
      image = s?.image ? (s.image.medium || s.image.original) : '';
      summary = s?.summary || '';
    }
    const ins = await run(`INSERT INTO shows (tvmaze_id, title, image, summary) VALUES (?,?,?,?)`,
      [tvmazeId, title, image, summary]);
    show = { id: ins.lastID, tvmaze_id: tvmazeId, title, image, summary };
  }

  // Episodes
  const episodes = await fetchTvmazeEpisodes(tvmazeId);
  for (const e of episodes) {
    await run(
      `INSERT OR IGNORE INTO episodes (show_id, tvmaze_id, season, number, name, airdate, watched)
       VALUES (?,?,?,?,?,?,0)`,
      [show.id, e.tvmaze_id, e.season, e.number, e.name, e.airdate]
    );
  }
  return show.id;
}

// ---------- Routes ----------

// Home: list shows with overall progress
app.get('/', async (req, res) => {
  const shows = await all(`SELECT * FROM shows ORDER BY title COLLATE NOCASE ASC`);
  // compute progress for each show
  const rows = [];
  for (const s of shows) {
    const counts = await get(
      `SELECT COUNT(*) AS total, SUM(watched) AS watched
       FROM episodes WHERE show_id = ?`,
      [s.id]
    );
    const total = counts?.total || 0;
    const watched = counts?.watched || 0;
    const pct = total ? Math.round((watched / total) * 100) : 0;
    rows.push({ ...s, total, watched, pct });
  }
  res.render('index', { title: 'TV Tracker', shows: rows, layout: 'layout' });
});

// Search TVmaze (JSON) — can be used by your Add form autocomplete
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = await searchTvmaze(q);
    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'search failed' });
  }
});

// Add show by TVmaze ID (from a form or button)
app.post('/add', async (req, res) => {
  try {
    const tvmazeId = parseInt(req.body.tvmaze_id || req.body.tvmazeId, 10);
    if (!tvmazeId) return res.status(400).send('tvmaze_id required');
    const showId = await ensureShow(tvmazeId);
    res.redirect(`/show/${showId}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to add show');
  }
});

// Show page — GROUPED BY SEASON with per-season stats
app.get('/show/:id', async (req, res) => {
  const showId = parseInt(req.params.id, 10);
  const show = await get(`SELECT * FROM shows WHERE id = ?`, [showId]);
  if (!show) return res.status(404).send('Show not found');

  const episodes = await all(
    `SELECT id, name, season, number, airdate, watched
     FROM episodes
     WHERE show_id = ?
     ORDER BY season ASC, number ASC`,
    [showId]
  );

  // Group by season
  const seasonsMap = new Map();
  for (const ep of episodes) {
    if (!seasonsMap.has(ep.season)) seasonsMap.set(ep.season, []);
    seasonsMap.get(ep.season).push(ep);
  }

  const seasons = [...seasonsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, eps]) => {
      const total = eps.length;
      const watched = eps.filter(e => !!e.watched).length;
      const pct = total ? Math.round((watched / total) * 100) : 0;
      return { seasonNumber, total, watched, pct, episodes: eps };
    });

  const overallTotal = episodes.length;
  const overallWatched = episodes.filter(e => !!e.watched).length;
  const overallPct = overallTotal ? Math.round((overallWatched / overallTotal) * 100) : 0;

  res.render('show', {
    title: `${show.title} — TV Tracker`,
    show,
    seasons,
    overall: { total: overallTotal, watched: overallWatched, pct: overallPct },
    layout: 'layout'
  });
});

// Toggle watched (AJAX)
app.post('/episodes/toggle', async (req, res) => {
  try {
    const { episodeId, watched } = req.body;
    if (!episodeId) return res.status(400).json({ error: 'episodeId required' });
    await run(`UPDATE episodes SET watched = ? WHERE id = ?`, [watched ? 1 : 0, parseInt(episodeId, 10)]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update episode' });
  }
});

// Delete a show (and all its episodes)
app.post('/show/:id/delete', async (req, res) => {
  try {
    const showId = parseInt(req.params.id, 10);
    await run(`DELETE FROM episodes WHERE show_id = ?`, [showId]);
    await run(`DELETE FROM shows WHERE id = ?`, [showId]);
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to delete show');
  }
});

// ---------- Start ----------
initDb()
  .then(() => app.listen(PORT, () => console.log(`TV Tracker running on http://localhost:${PORT}`)))
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
