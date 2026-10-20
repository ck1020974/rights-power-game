'use strict';
// 用假的時鐘跑完整 API 流程（不需要真的等 3 分鐘）
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/load-config');
const { openDatabase } = require('../lib/db');
const { createApp } = require('../lib/app');
const { importStudents, importQuestions } = require('../lib/importers');

let clock = 1_800_000_000_000;
let server;
let base;
let db;

test.before(async () => {
  db = openDatabase(':memory:');
  const root = path.join(__dirname, '..', 'samples');
  importStudents(db, fs.readFileSync(path.join(root, 'students.sample.csv'), 'utf8'));
  importQuestions(db, fs.readFileSync(path.join(root, 'questions.csv'), 'utf8'));
  const app = createApp({ db, config, adminPassword: 'teacher-pass', now: () => clock });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(p, body, headers = {}) {
  const res = await fetch(base + p, body === undefined ? { headers } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const answerOf = (qid) => db.prepare('SELECT answer FROM questions WHERE id = ?').get(qid).answer;
const flip = (a) => (a === '權利' ? '權力' : '權利');

test('找不到學號', async () => {
  const r = await call('/api/login', { studentId: '99999' });
  assert.equal(r.status, 404);
});

test('完整一局：計分、冷卻、時間到、個人紀錄、排行榜', async () => {
  const s = (await call('/api/game/start', { studentId: '70101' })).data;
  assert.equal(s.waitMs, 3000);
  assert.ok(!('answer' in s.question), '題目不能附帶答案');
  assert.deepEqual(s.question.choices, ['權利', '權力'], '按鈕固定：左權利、右權力');

  // 開場倒數中不能作答
  let r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: s.question.id, choice: '權利' });
  assert.equal(r.data.code, 'NOT_READY');

  clock += 3000 + 1000; // 倒數結束，1 秒後作答
  let q = s.question;
  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: answerOf(q.id) });
  assert.equal(r.data.correct, true);
  assert.equal(r.data.score, 140);
  q = r.data.next;
  assert.deepEqual(q.choices, ['權利', '權力'], '下一題按鈕仍固定');

  // 再對 2 題（第 3 題拿 Combo +10），各 0 秒
  for (let i = 0; i < 2; i++) {
    r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: answerOf(q.id) });
    q = r.data.next;
  }
  assert.equal(r.data.score, 140 + 150 + 150 + 10);
  assert.equal(r.data.combo, 3);

  // 連錯兩題 → 冷卻 2 秒
  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: flip(answerOf(q.id)) });
  q = r.data.next;
  assert.equal(r.data.cooldownMs, 0);
  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: flip(answerOf(q.id)) });
  q = r.data.next;
  assert.equal(r.data.cooldownMs, 2000);
  assert.equal(r.data.score, 450 - 100);
  const blocked = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: '權利' });
  assert.equal(blocked.data.code, 'NOT_READY', '冷卻中不能作答');
  clock += 2000;

  // 舊題目重送會被拒絕
  const stale = await call('/api/game/answer', { sessionId: s.sessionId, questionId: -1, choice: '權利' });
  assert.equal(stale.data.code, 'STALE');

  // 時間到（+寬限）之後作答不算分
  clock += 180_000 + 2000;
  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: answerOf(q.id) });
  assert.equal(r.data.finished, true);
  const fin = (await call('/api/game/finish', { sessionId: s.sessionId })).data;
  assert.equal(fin.score, 350);
  assert.equal(fin.answeredCount, 5);
  assert.equal(fin.correctCount, 3);
  assert.equal(fin.accuracy, 60);
  assert.equal(fin.maxCombo, 3);
  assert.equal(fin.isNewRecord, false, '第一局不顯示 NEW RECORD');
  assert.equal(fin.isFirstGame, true);
  assert.equal(fin.review.length, 2, '錯題回顧');
  assert.equal(fin.grade.label, '丁', '分數 350 → 丁');
  assert.ok(fin.grade.next && fin.grade.next.label === '丙');

  // 第二局：較低分 → 不破紀錄，最高分仍為 350
  const s2 = (await call('/api/game/start', { studentId: '70101' })).data;
  clock += 3000;
  await call('/api/game/answer', { sessionId: s2.sessionId, questionId: s2.question.id, choice: answerOf(s2.question.id) });
  clock += 180_000;
  const fin2 = (await call('/api/game/finish', { sessionId: s2.sessionId })).data;
  assert.equal(fin2.isNewRecord, false);
  assert.equal(fin2.bestScore, 350);

  // 第三局：更高分 → NEW RECORD
  const s3 = (await call('/api/game/start', { studentId: '70101' })).data;
  clock += 3000;
  let qq = s3.question;
  for (let i = 0; i < 5; i++) {
    const a = await call('/api/game/answer', { sessionId: s3.sessionId, questionId: qq.id, choice: answerOf(qq.id) });
    qq = a.data.next;
  }
  clock += 180_000;
  const fin3 = (await call('/api/game/finish', { sessionId: s3.sessionId })).data;
  assert.equal(fin3.isNewRecord, true);
  assert.equal(fin3.previousBest, 350);

  // 排行榜：每人只出現一次，不含學號
  const lb = (await call('/api/leaderboard')).data;
  assert.equal(lb.entries.length, 1);
  assert.equal(lb.entries[0].bestScore, fin3.score);
  assert.ok(!JSON.stringify(lb).includes('70101'), '排行榜不能出現學號');
});

test('重新開局會結束上一局未完成的遊戲', async () => {
  const a = (await call('/api/game/start', { studentId: '70201' })).data;
  const b = (await call('/api/game/start', { studentId: '70201' })).data;
  assert.notEqual(a.sessionId, b.sessionId);
  const r = await call('/api/game/resume', { sessionId: a.sessionId });
  assert.equal(r.data.finished, true);
});

test('教師後台需要登入與自訂標頭', async () => {
  assert.equal((await call('/api/admin/students')).status, 401);
  assert.equal((await call('/api/admin/export/students.csv')).status, 401);
  const noHeader = await call('/api/admin/login', { password: 'teacher-pass' });
  assert.equal(noHeader.status, 403);
  const bad = await call('/api/admin/login', { password: 'nope' }, { 'X-Requested-With': 'rp-admin' });
  assert.equal(bad.status, 401);
  const ok = await call('/api/admin/login', { password: 'teacher-pass' }, { 'X-Requested-With': 'rp-admin' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);

  const st = await call('/api/admin/students?class=701', undefined, { Cookie: cookie });
  assert.equal(st.status, 200);
  assert.ok(st.data.students.every((s) => s.className === '701'));
  const me = st.data.students.find((s) => s.studentId === '70101');
  assert.equal(me.plays, 3);

  const qs = await call('/api/admin/questions', undefined, { Cookie: cookie });
  const attempted = qs.data.questions.filter((q) => q.attempts > 0);
  assert.ok(attempted.length > 0);

  for (const kind of ['students', 'sessions', 'answers', 'question-stats', 'questions', 'students-list']) {
    const res = await fetch(`${base}/api/admin/export/${kind}.csv`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, kind);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], `${kind} 有 BOM`);
  }
});

test('靜態檔案不能讀到專案目錄外', async () => {
  const r = await fetch(`${base}/..%2fconfig.js`);
  assert.equal(r.status, 404);
  const ok = await fetch(`${base}/`);
  assert.equal(ok.status, 200);
});
