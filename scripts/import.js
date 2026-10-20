'use strict';
// 用法：
//   npm run import:students -- 學生名單.csv
//   npm run import:questions -- 題庫.csv [--keep-missing]
//   npm run demo                      （載入 samples/ 裡的範例名單與題庫）
require('../lib/env').load();
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { importStudents, importQuestions } = require('../lib/importers');

const root = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const [kind, file, ...flags] = process.argv.slice(2);

function show(label, r) {
  console.log(`\n【${label}】${r.ok ? '匯入成功' : '匯入失敗（沒有寫入任何資料）'}`);
  if (r.ok) {
    console.log(`  共 ${r.total} 筆：新增 ${r.inserted}、更新 ${r.updated}、停用 ${r.deactivated}`);
    if (r.byAnswer) console.log(`  答案分布：權利 ${r.byAnswer['權利']}、權力 ${r.byAnswer['權力']}；難度 1/2/3 = ${r.byDifficulty[1]}/${r.byDifficulty[2]}/${r.byDifficulty[3]}`);
  }
  r.errors.forEach((e) => console.log(`  ✗ ${e}`));
  r.warnings.forEach((w) => console.log(`  ! ${w}`));
  return r.ok;
}

function read(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch (e) {
    console.error(`讀不到檔案：${f}（${e.code}）`);
    process.exit(1);
  }
}

const db = openDatabase(path.join(DATA_DIR, 'game.db'));
let ok = true;
if (kind === 'students') {
  if (!file) (console.error('請指定 CSV 檔案路徑'), process.exit(1));
  ok = show('學生名單', importStudents(db, read(file), { deactivateMissing: flags.includes('--deactivate-missing') }));
} else if (kind === 'questions') {
  if (!file) (console.error('請指定 CSV 檔案路徑'), process.exit(1));
  ok = show('題庫', importQuestions(db, read(file), { deactivateMissing: !flags.includes('--keep-missing') }));
} else if (kind === 'demo') {
  ok = show('範例學生名單', importStudents(db, read(path.join(root, 'samples', 'students.sample.csv'))));
  ok = show('範例題庫', importQuestions(db, read(path.join(root, 'samples', 'questions.csv')))) && ok;
} else {
  console.error('用法：node scripts/import.js <students|questions|demo> [檔案]');
  process.exit(1);
}
db.close();
process.exit(ok ? 0 : 1);
