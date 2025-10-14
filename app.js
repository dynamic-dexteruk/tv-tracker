// app.js — TV Tracker (search supports reboots; auth; sessions; delete; toggle)
const express = require('express');
const path = require('path');
const axios = require('axios');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const helmet = require('helmet');

const { init, run, all, get } = require('./db');

const app = express();
const PORT = process.env.PORT || 3002;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-this';
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION || 'true').toLowerCase() === 'true';

// ----- Boot -----
init();

app.use(helmet({ contentSecurityPolicy: false })); // keep simple; tighten later

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: 'lax',
    httpOnly: true,
    secure: false // set to true when only serving via HTTPS behind Nginx + app.set('trust proxy', 1)
  }
}));

// Views / static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Shared locals
app.use((req, res, next) => {
  res.locals.title = 'TV Tracker';
  res.locals.user = req.session.user || null;
  res.locals.allowRegister = ALLOW_REGISTRATION;
  next();
});

// ----- TVMaze helpers -----
async function tmSearchShows(term) {
  const { data } = await axios.get(
    `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(term)}`,
    { timeout: 15000 }
  );
  return data; // [{score, show:{...}}, ...]
}

async function tmGetShow(showId) {
  const { data } = await axios.get(`https://api.tvmaze.com/shows/${showId}`, { timeout: 15000 });
  return data;
}

async function tmEpisodes(showId) {
  const { data } = await axios.get(`https://api.tvmaze.com/shows/${showId}/episodes`, { timeout: 20000 });
  return data;
}

// Insert show + episodes into DB (idempotent via INSERT OR IGNORE)
async function addShowAndEpisodes(showObj) {
  await run(
    `INSERT OR IGNORE INTO shows (id, name, image, summary) VALUES (?, ?, ?, ?)`,
    [
      showObj.id,
      showObj.name,
      showObj.image?.medium || showObj.image?.original || null,
      showObj.summary || null
    ]
  );

  const episodes = await tmEpisodes(showObj.id);
  const insertEp = `INSERT OR IGNORE INTO episodes
      (id, show_id, season, number, title, airdate, runtime)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;

  for (const ep of episodes) {
    await run(insertEp, [
      ep.id,
      showObj.id,
      ep.season ?? null,
      ep.number ?? null,
      ep.name ?? '',
      ep.airdate ?? null,
      ep.runtime ?? null
    ]);
  }
}

// ----- Auth middleware -----
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
}

// ----- Auth routes -----
app.get('/auth/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Log in — TV Tracker' });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await get(`SELECT * FROM users WHERE username = ?`, [username]);
  if (!user) return res.status(401).send('Invalid username or password');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).send('Invalid username or password');
  req.session.user = { id: user.id, username: user.username };
  res.redirect('/');
});

app.get('/auth/register', (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(403).send('Registration is disabled.');
  if (req.session.user) return res.redirect('/');
  res.render('register', { title: 'Register — TV Tracker' });
});

app.post('/auth/register', async (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(403).send('Registration is disabled.');
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send('Missing fields');

  const exists = await get(`SELECT 1 FROM users WHERE username = ?`, [username]);
  if (exists) return res.status(400).send('Username is taken');

  const hash = await bcrypt.hash(password, 12);
  await run(`INSERT INTO users (username, password_hash) VALUES (?, ?)`, [username, hash]);
  const user = await get(`SELECT id, username FROM users WHERE username = ?`, [username]);
  req.session.user = user;
  res.redirect('/');
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

// ----- App routes (protected) -----

// Home: list shows
app.get('/', requireAuth, async (req, res) => {
  const shows = await all(`
    SELECT s.id, s.name, s.image,
      (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS total_eps,
      (SELECT COUNT(*) FROM episodes e
         JOIN watched w ON w.episode_id = e.id
       WHERE e.show_id = s.id AND w.watched_at IS NOT NULL) AS watched_eps
    FROM shows s
    ORDER BY s.name
  `);
  res.render('index', { shows, title: 'Your Shows — TV Tracker' });
});

// Add show — GET form
app.get('/add', requireAuth, (req, res) => {
  res.render('add', { title: 'Add Show — TV Tracker' });
});

// Add show — POST search/select (supports reboots & multiple matches)
app.post('/add', requireAuth, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const chosenId = req.body.showId ? parseInt(req.body.showId, 10) : null;

    // If a specific show was chosen in the chooser view, add it directly
    if (chosenId) {
      const show = await tmGetShow(chosenId);
      await addShowAndEpisodes(show);
      return res.redirect(`/show/${show.id}`);
    }

    // Otherwise, search for matches
    if (!name) return res.status(400).send('Show name required');
    const results = await tmSearchShows(name);

    if (results.length === 0) {
      return res.status(404).send('No matches found on TVMaze.');
    }

    if (results.length > 1) {
      // Let the user pick (e.g. Doctor Who 1963 / 2005 / 2023)
      return res.render('choose', { results, query: name, title: `Choose “${name}”` });
    }

    // Exactly one match → add it
    const show = results[0].show;
    await addShowAndEpisodes(show);
    res.redirect(`/show/${show.id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to add show.');
  }
});

// Show detail + episodes list
app.get('/show/:id', requireAuth, async (req, res) => {
  const showId = parseInt(req.params.id, 10);
  const show = await get(`SELECT * FROM shows WHERE id = ?`, [showId]);
  if (!show) return res.status(404).send('Show not found');

  const episodes = await all(`
    SELECT e.*, (w.watched_at IS NOT NULL) AS watched
    FROM episodes e
    LEFT JOIN watched w ON w.episode_id = e.id
    WHERE e.show_id = ?
    ORDER BY e.season, e.number
  `, [showId]);

  const total = episodes.length;
  const watched = episodes.filter(e => e.watched).length;
  const pct = total ? Math.round((watched / total) * 100) : 0;

  res.render('show', { show, episodes, total, watched, pct, title: `${show.name} — TV Tracker` });
});

// Delete entire show (episodes + watched flags cascade)
app.post('/show/:id/delete', requireAuth, async (req, res) => {
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

// Toggle watched (AJAX; public/app.js updates the DOM instantly)
app.post('/episode/:id/toggle', requireAuth, async (req, res) => {
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
