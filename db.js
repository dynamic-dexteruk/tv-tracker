// db.js — shared catalogue + per-user libraries
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'tvtracker.db');

const db = new sqlite3.Database(dbPath);

const init = () => {
  db.serialize(() => {
    // Master catalogue (shared across all users)
    db.run(`CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY,             -- TVMaze show id
      name TEXT NOT NULL,
      image TEXT,
      summary TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY,             -- TVMaze episode id
      show_id INTEGER NOT NULL,           -- FK to shows.id (TVMaze id)
      season INTEGER,
      number INTEGER,
      title TEXT,
      airdate TEXT,
      runtime INTEGER,
      FOREIGN KEY(show_id) REFERENCES shows(id)
    )`);

    // DEPRECATED (single-user): keep for migration only
    db.run(`CREATE TABLE IF NOT EXISTS watched (
      episode_id INTEGER PRIMARY KEY,
      watched_at TEXT
    )`);

    // Per-user library: which user has added which show
    db.run(`CREATE TABLE IF NOT EXISTS user_shows (
      user_id INTEGER NOT NULL,
      show_id INTEGER NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, show_id),
      FOREIGN KEY(show_id) REFERENCES shows(id)
    )`);

    // Per-user watched flags (episode-level)
    db.run(`CREATE TABLE IF NOT EXISTS user_watched (
      user_id INTEGER NOT NULL,
      episode_id INTEGER NOT NULL,
      watched_at TEXT,
      PRIMARY KEY (user_id, episode_id),
      FOREIGN KEY(episode_id) REFERENCES episodes(id)
    )`);

    // Users (auth)
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  });
};

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

module.exports = { db, init, run, all, get };
