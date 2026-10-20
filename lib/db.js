'use strict';
const fs = require('node:fs');
const path = require('node:path');

// node:sqlite 目前仍標示為「實驗性」，載入時會印出警告；只把這一則濾掉，避免嚇到使用者。
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (msg && /SQLite is an experimental feature/i.test(msg)) return;
  return origEmit.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = origEmit;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  return db;
}

// 交易：全部成功才寫入，任何錯誤就整批復原。注意：不可巢狀呼叫。
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

module.exports = { openDatabase, tx };
