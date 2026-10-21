'use strict';
// 測試用：在記憶體裡建立 SQLite 資料庫，直接呼叫 API 處理器（不用開伺服器）
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/load-config');
const { openStore } = require('../lib/db');
const { createApp } = require('../lib/app');
const { importStudents, importQuestions } = require('../lib/importers');

const SAMPLES = path.join(__dirname, '..', 'samples');

async function makeApp({ clock, password = 'teacher-pass', withData = true } = {}) {
  const store = await openStore(':memory:');
  if (withData) {
    await importStudents(store, fs.readFileSync(path.join(SAMPLES, 'students.sample.csv'), 'utf8'));
    await importQuestions(store, fs.readFileSync(path.join(SAMPLES, 'questions.csv'), 'utf8'));
  }
  const app = createApp({ store, config, adminPassword: password, now: clock || Date.now });
  async function call(p, body, headers = {}) {
    const init = body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
    const res = await app.handle(new Request(`https://game.test${p}`, init), { ip: '1.2.3.4' });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  return { app, store, call };
}

module.exports = { makeApp, SAMPLES };
