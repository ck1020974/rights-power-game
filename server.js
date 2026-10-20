'use strict';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`需要 Node.js 22.13 以上版本（目前是 ${process.versions.node}）。請到 https://nodejs.org 下載 LTS 版本。`);
  process.exit(1);
}

require('./lib/env').load();
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const config = require('./lib/load-config');
const { openDatabase } = require('./lib/db');
const { createApp } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

const db = openDatabase(path.join(DATA_DIR, 'game.db'));
const app = createApp({
  db,
  config,
  adminPassword: process.env.ADMIN_PASSWORD,
  trustProxy: process.env.TRUST_PROXY === '1',
  cookieSecure: process.env.COOKIE_SECURE === '1',
});

const server = http.createServer(app.handler);
server.requestTimeout = 60_000;
server.listen(PORT, HOST, () => {
  const counts = {
    students: db.prepare('SELECT COUNT(*) AS n FROM students WHERE active = 1').get().n,
    questions: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE active = 1').get().n,
  };
  console.log('\n權利 vs 權力｜3分鐘極限挑戰 已啟動');
  console.log(`  本機：        http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  區域網路：    http://${i.address}:${PORT}   （同一個 Wi-Fi 的學生可用這個網址）`);
  }
  console.log(`  教師後台：    /admin`);
  console.log(`  資料庫：      ${path.join(DATA_DIR, 'game.db')}`);
  console.log(`  目前資料：    學生 ${counts.students} 人、啟用題目 ${counts.questions} 題`);
  if (!app.auth.enabled) console.warn('\n  ⚠ 尚未設定 ADMIN_PASSWORD（至少 8 個字元），教師後台目前無法登入。');
  if (!counts.questions) console.warn('  ⚠ 題庫是空的，請先匯入題目（見 README），或執行 npm run demo 載入範例資料。');
  if (!counts.students) console.warn('  ⚠ 學生名單是空的，請先匯入名單。');
  console.log('');
});

const timer = setInterval(() => {
  try {
    app.sweep();
  } catch (e) {
    console.error('[sweep]', e);
  }
}, 30_000);
timer.unref();

function shutdown() {
  console.log('正在關閉…');
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
