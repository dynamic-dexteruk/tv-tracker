// app.js — per-user libraries (shared catalogue), auth, multi-version search
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

init();

app.use(helmet({ contentSecurityPolicy: false }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax', httpOnly: true, secure: false }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.title = 'TV Tracker';
  res.locals.user = req.session.user || null;
  res.locals.allowRegister = ALLOW_REGISTRATION;
  next();
});

// ---- TVMaze helpers ----
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

// Insert show/episodes (shared), then link to user's library
async function addShowToUserLibrary(showObj, userId) {
  await run(
    `INSERT OR IGNORE INTO shows (id, name, image, summary) VALUES (?, ?, ?, ?)`,
    [showObj.id, showObj.name, showObj.image?.medium || showObj.image?.original || null, showObj.summary || null]
  );

  const episodes = await tmEpisodes(showObj.id);
  const insertEp = `INSERT OR IGNORE INTO episodes
      (id, show_id, season, number, title, airdate, runtime)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;

  for (const ep of episodes) {
    await run(insertEp, [
      ep.id, showObj.id, ep.season ?? null, ep.number ?? null, ep.name ?? '',
      ep.airdate ?? null, ep.runtime ?? null
    ]);
  }

  // Link the show to this specific user
  await run(`INSERT OR IGNORE INTO user_shows (user_id, show_id) VALUES (?, ?)`, [userId, showObj.id]);
}

// ---- Auth ----
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
}

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

// ---- App (per-user library) ----

// Home: list only the shows this user added
app.get('/', requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const shows = await all(`
    SELECT s.id, s.name, s.image,
      (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS total_eps,
      (SELECT COUNT(*) FROM episodes e
         LEFT JOIN user_watched uw
           ON uw.episode_id = e.id AND uw.user_id = ?
       WHERE e.show_id = s.id AND uw.watched_at IS NOT NULL) AS watched_eps
    FROM shows s
    JOIN user_shows us ON us.show_id = s.id
    WHERE us.user_id = ?
    ORDER BY s.name
  `, [uid, uid]);

  res.render('index', { shows, title: 'Your Shows — TV Tracker' });
});

// Add show — search/select (multi-version support) and link to this user
app.get('/add', requireAuth, (req, res) => {
  res.render('add', { title: 'Add Show — TV Tracker' });
});

app.post('/add', requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const name = (req.body.name || '').trim();
    const chosenId = req.body.showId ? parseInt(req.body.showId, 10) : null;

    if (chosenId) {
      const show = await tmGetShow(chosenId);
      await addShowToUserLibrary(show, uid);
      return res.redirect(`/show/${show.id}`);
    }

    if (!name) return res.status(400).send('Show name required');

    const results = await tmSearchShows(name);
    if (results.length === 0) return res.status(404).send('No matches found on TVMaze.');
    if (results.length > 1) return res.render('choose', { results, query: name, title: `Choose “${name}”` });

    const show = results[0].show;
    await addShowToUserLibrary(show, uid);
    res.redirect(`/show/${show.id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to add show.');
  }
});

// Show page: episodes + watched flags for THIS user only
app.get('/show/:id', requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const showId = parseInt(req.params.id, 10);

  // Ensure the user actually has this show in their library
  const owns = await get(`SELECT 1 FROM user_shows WHERE user_id = ? AND show_id = ?`, [uid, showId]);
  if (!owns) return res.status(403).send('This show is not in your library.');

  const show = await get(`SELECT * FROM shows WHERE id = ?`, [showId]);
  if (!show) return res.status(404).send('Show not found');

  const episodes = await all(`
    SELECT e.*,
           (uw.watched_at IS NOT NULL) AS watched
    FROM episodes e
    LEFT JOIN user_watched uw
      ON uw.episode_id = e.id AND uw.user_id = ?
    WHERE e.show_id = ?
    ORDER BY e.season, e.number
  `, [uid, showId]);

  const total = episodes.length;
  const watched = episodes.filter(e => e.watched).length;
  const pct = total ? Math.round((watched / total) * 100) : 0;

  res.render('show', { show, episodes, total, watched, pct, title: `${show.name} — TV Tracker` });
});

// Remove show from THIS user's library (does not delete global copy)
app.post('/show/:id/delete', requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const showId = parseInt(req.params.id, 10);
  try {
    await run(
      `DELETE FROM user_watched
         WHERE user_id = ?
           AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?)`,
      [uid, showId]
    );
    await run(`DELETE FROM user_shows WHERE user_id = ? AND show_id = ?`, [uid, showId]);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to remove show from your library.');
  }
});

// Toggle watched for THIS user only
app.post('/episode/:id/toggle', requireAuth, async (req, res) => {
  const uid = req.session.user.id;
  const epId = parseInt(req.params.id, 10);

  const row = await get(`SELECT watched_at FROM user_watched WHERE user_id = ? AND episode_id = ?`, [uid, epId]);
  if (!row) {
    await run(`INSERT INTO user_watched (user_id, episode_id, watched_at) VALUES (?, ?, datetime('now'))`, [uid, epId]);
    return res.json({ watched: true });
  }
  if (row.watched_at) {
    await run(`UPDATE user_watched SET watched_at = NULL WHERE user_id = ? AND episode_id = ?`, [uid, epId]);
    return res.json({ watched: false });
  } else {
    await run(`UPDATE user_watched SET watched_at = datetime('now') WHERE user_id = ? AND episode_id = ?`, [uid, epId]);
    return res.json({ watched: true });
  }
});

app.listen(PORT, () => console.log(`TV Tracker running on http://localhost:${PORT}`));


