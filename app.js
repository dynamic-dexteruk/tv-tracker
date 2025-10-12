// app.js
const express = require('express');
const path = require('path');
const axios = require('axios');
const expressLayouts = require('express-ejs-layouts');
const { init, run, all, get } = require('./db');

const app = express();
const PORT = process.env.PORT || 3002; // change if needed

init();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// default page title for all views
app.use((req, res, next) => {
  res.locals.title = 'TV Tracker';
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: fetch show by name via TVmaze singlesearch (with embedded episodes)
async function fetchShowByName(name){
  const url = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(name)}&embed=episodes`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data; // includes _embedded.episodes
}

// Helper: fetch all episodes for a show id (fallback)
async function fetchEpisodes(showId){
  const url = `https://api.tvmaze.com/shows/${showId}/episodes`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

// Home: list shows
app.get('/', async (req, res) => {
  const shows = await all(`SELECT s.id, s.name, s.image,
    (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS total_eps,
    (SELECT COUNT(*) FROM episodes e JOIN watched w ON w.episode_id = e.id WHERE e.show_id = s.id AND w.watched_at IS NOT NULL) AS watched_eps
    FROM shows s ORDER BY s.name`);
  res.render('index', { shows, title: 'Your Shows — TV Tracker' });
});

// Add show form
app.get('/add', (req, res) => {
  res.render('add', { title: 'Add Show — TV Tracker' });
});

// Add show handler: by name
app.post('/add', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).send('Show name required');

    const show = await fetchShowByName(name);

    // Upsert show
    await run(
      `INSERT OR IGNORE INTO shows (id, name, image, summary) VALUES (?, ?, ?, ?)`,
      [show.id, show.name, show.image?.medium || show.image?.original || null, show.summary || null]
    );

    // Episodes: use embedded if present else fetch
    const episodes = show._embedded?.episodes?.length ? show._embedded.episodes : await fetchEpisodes(show.id);

    // Insert episodes (ignore if already cached)
    const insertEp = `INSERT OR IGNORE INTO episodes (id, show_id, season, number, title, airdate, runtime)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    for (const ep of episodes) {
      await run(insertEp, [
        ep.id,
        show.id,
        ep.season || null,
        ep.number || null,
        ep.name || '',
        ep.airdate || null,
        ep.runtime || null
      ]);
    }

    res.redirect(`/show/${show.id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to add show. Try a different title.');
  }
});

// Show detail + episodes list
app.get('/show/:id', async (req, res) => {
  const showId = parseInt(req.params.id, 10);
  const show = await get(`SELECT * FROM shows WHERE id = ?`, [showId]);
  if (!show) return res.status(404).send('Show not found');

  const episodes = await all(
    `SELECT e.*, (w.watched_at IS NOT NULL) AS watched
     FROM episodes e
     LEFT JOIN watched w ON w.episode_id = e.id
     WHERE e.show_id = ?
     ORDER BY e.season, e.number`,
    [showId]
  );

  const total = episodes.length;
  const watched = episodes.filter(e => e.watched).length;
  const pct = total ? Math.round((watched / total) * 100) : 0;

  res.render('show', { show, episodes, total, watched, pct, title: `${show.name} — TV Tracker` });
});

app.post('/show/:id/delete', async (req, res) => {
  const showId = parseInt(req.params.id, 10);
  try {
    await run(`DELETE FROM watched WHERE episode_id IN (SELECT id FROM episodes WHERE show_id = ?)`, [showId]);
    await run(`DELETE FROM episodes WHERE show_id = ?`, [showId]);
    await run(`DELETE FROM shows WHERE id = ?`, [showId]);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to delete show.');
  }
});

// Toggle watched (AJAX)
app.post('/episode/:id/toggle', async (req, res) => {
  const epId = parseInt(req.params.id, 10);
  const row = await get(`SELECT watched_at FROM watched WHERE episode_id = ?`, [epId]);
  if (!row) {
    await run(`INSERT INTO watched (episode_id, watched_at) VALUES (?, datetime('now'))`, [epId]);
    return res.json({ watched: true });
  }
  if (row.watched_at) {
    await run(`UPDATE watched SET watched_at = NULL WHERE episode_id = ?`, [epId]);
    return res.json({ watched: false });
  } else {
    await run(`UPDATE watched SET watched_at = datetime('now') WHERE episode_id = ?`, [epId]);
    return res.json({ watched: true });
  }
});

app.listen(PORT, () => console.log(`TV Tracker running on http://localhost:${PORT}`));
