// db.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'tvtracker.db');

const db = new sqlite3.Database(dbPath);

const init = () => {
  db.serialize(() => {
    // Shows
    db.run(`CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT,
      summary TEXT
    )`);

    // Episodes
    db.run(`CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY,
      show_id INTEGER NOT NULL,
      season INTEGER,
      number INTEGER,
      title TEXT,
      airdate TEXT,
      runtime INTEGER,
      FOREIGN KEY(show_id) REFERENCES shows(id)
    )`);

    // Watched flags
    db.run(`CREATE TABLE IF NOT EXISTS watched (
      episode_id INTEGER PRIMARY KEY,
      watched_at TEXT
    )`);

    // Users (for login)
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
