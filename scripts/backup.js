'use strict';
// 備份資料庫（伺服器執行中也可以備份）：npm run backup
require('../lib/env').load();
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../lib/db');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const target = path.join(dir, `game-${stamp}.db`);
const db = openDatabase(path.join(DATA_DIR, 'game.db'));
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log(`已備份到 ${target}`);
