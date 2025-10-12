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
db.run(`CREATE TABLE IF NOT EXISTS shows (
id INTEGER PRIMARY KEY, -- TVmaze show id
name TEXT NOT NULL,
image TEXT,
summary TEXT
)`);


db.run(`CREATE TABLE IF NOT EXISTS episodes (
id INTEGER PRIMARY KEY, -- TVmaze episode id
show_id INTEGER NOT NULL, -- TVmaze show id
season INTEGER,
number INTEGER,
title TEXT,
airdate TEXT,
runtime INTEGER,
FOREIGN KEY(show_id) REFERENCES shows(id)
)`);


db.run(`CREATE TABLE IF NOT EXISTS watched (
episode_id INTEGER PRIMARY KEY, -- equals TVmaze ep id
watched_at TEXT -- ISO timestamp when toggled on (NULL means not watched)
)`);
});
};


const run = (sql, params=[]) => new Promise((resolve, reject) => {
db.run(sql, params, function(err){
if (err) return reject(err);
resolve(this);
});
});


const all = (sql, params=[]) => new Promise((resolve, reject) => {
db.all(sql, params, (err, rows) => {
if (err) return reject(err);
resolve(rows);
});
});


const get = (sql, params=[]) => new Promise((resolve, reject) => {
db.get(sql, params, (err, row) => {
if (err) return reject(err);
resolve(row);
});
});


module.exports = { db, init, run, all, get };