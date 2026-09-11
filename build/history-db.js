// Persistent price-history store. Keeps every fetched daily close/dividend in a local
// SQLite file so a daily build only has to ask Yahoo for the days since the last run,
// instead of re-downloading years of history every time.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'history.sqlite');

function open() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prices (
      symbol TEXT NOT NULL,
      t INTEGER NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS dividends (
      symbol TEXT NOT NULL,
      t INTEGER NOT NULL,
      amount REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
  `);
  return db;
}

function lastTimestamp(db, symbol) {
  const row = db.prepare('SELECT MAX(t) AS t FROM prices WHERE symbol = ?').get(symbol);
  return row && row.t != null ? row.t : null;
}

function upsertPrices(db, symbol, points) {
  const stmt = db.prepare('INSERT OR REPLACE INTO prices (symbol, t, close) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const p of rows) stmt.run(symbol, p.t, p.c);
  });
  tx(points);
}

function upsertDividends(db, symbol, dividends) {
  const stmt = db.prepare('INSERT OR REPLACE INTO dividends (symbol, t, amount) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const d of rows) stmt.run(symbol, d.t, d.amount);
  });
  tx(dividends);
}

function getHistory(db, symbol, sinceT) {
  const rows = sinceT
    ? db.prepare('SELECT t, close AS c FROM prices WHERE symbol = ? AND t >= ? ORDER BY t ASC').all(symbol, sinceT)
    : db.prepare('SELECT t, close AS c FROM prices WHERE symbol = ? ORDER BY t ASC').all(symbol);
  return rows;
}

function getDividends(db, symbol, sinceT) {
  const rows = sinceT
    ? db.prepare('SELECT t, amount FROM dividends WHERE symbol = ? AND t >= ? ORDER BY t ASC').all(symbol, sinceT)
    : db.prepare('SELECT t, amount FROM dividends WHERE symbol = ? ORDER BY t ASC').all(symbol);
  return rows;
}

module.exports = { open, lastTimestamp, upsertPrices, upsertDividends, getHistory, getDividends, DB_PATH };
