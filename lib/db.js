'use strict';
// Node.js 版：用內建 SQLite 開檔（Cloudflare 版改用 D1，見 src/worker.js）
const fs = require('node:fs');
const path = require('node:path');
const { sqliteStore } = require('./store');

const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (msg && /SQLite is an experimental feature/i.test(msg)) return;
  return origEmit.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = origEmit;

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

async function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  const cols = db.prepare("SELECT name FROM pragma_table_info('game_sessions')").all().map((r) => r.name);
  if (cols.length && !cols.includes('log')) {
    throw new Error(`資料庫是舊版格式：${file}\n請先備份後刪除這個檔案，再重新啟動並匯入名單與題庫。`);
  }
  const store = sqliteStore(db);
  await store.migrate(SCHEMA);
  return store;
}

module.exports = { openStore, SCHEMA };
