'use strict';
// 用假的時鐘跑完整 API 流程（不需要真的等 3 分鐘）
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp } = require('./helpers');

let clock = 1_800_000_000_000;
let ctx;
const call = (...a) => ctx.call(...a);
const answerOf = async (qid) => (await ctx.store.first('SELECT answer FROM questions WHERE id = ?', qid)).answer;
const flip = (a) => (a === '權利' ? '權力' : '權利');

test.before(async () => {
  ctx = await makeApp({ clock: () => clock });
});

test('找不到學號', async () => {
  const r = await call('/api/login', { studentId: '99999' });
  assert.equal(r.status, 404);
});

test('完整一局：計分、冷卻、時間到、個人紀錄、排行榜', async () => {
  const s = (await call('/api/game/start', { studentId: '70101' })).data;
  assert.equal(s.waitMs, 3000);
  assert.ok(!('answer' in s.question), '題目不能附帶答案');
  assert.deepEqual(s.question.choices, ['權利', '權力'], '按鈕固定：左權利、右權力');

  let r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: s.question.id, choice: '權利' });
  assert.equal(r.data.code, 'NOT_READY', '開場倒數中不能作答');

  clock += 3000 + 1000;
  let q = s.question;
  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: await answerOf(q.id) });
  assert.equal(r.data.correct, true);
  assert.equal(r.data.score, 140);
  q = r.data.next;
  assert.deepEqual(q.choices, ['權利', '權力'], '下一題按鈕仍固定');

  for (let i = 0; i < 2; i++) {
    r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: await answerOf(q.id) });
    q = r.data.next;
  }
  assert.equal(r.data.score, 140 + 150 + 150 + 10);
  assert.equal(r.data.combo, 3);

  // 同一題重送（連點）不會重複計分
  const dup = await call('/api/game/answer', { sessionId: s.sessionId, questionId: s.question.id, choice: '權利' });
  assert.equal(dup.data.code, 'STALE');

  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: flip(await answerOf(q.id)) });
  q = r.data.next;
  assert.equal(r.data.cooldownMs, 0);
  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: flip(await answerOf(q.id)) });
  q = r.data.next;
  assert.equal(r.data.cooldownMs, 2000, '連錯 2 題觸發冷卻');
  assert.equal(r.data.score, 450 - 100);
  const blocked = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: '權利' });
  assert.equal(blocked.data.code, 'NOT_READY', '冷卻中不能作答');
  clock += 2000;

  clock += 180_000 + 2000;
  r = await call('/api/game/answer', { sessionId: s.sessionId, questionId: q.id, choice: await answerOf(q.id) });
  assert.equal(r.data.finished, true, '時間到之後作答不算分');
  const fin = (await call('/api/game/finish', { sessionId: s.sessionId })).data;
  assert.equal(fin.score, 350);
  assert.equal(fin.answeredCount, 5);
  assert.equal(fin.correctCount, 3);
  assert.equal(fin.accuracy, 60);
  assert.equal(fin.maxCombo, 3);
  assert.equal(fin.isNewRecord, false, '第一局不顯示 NEW RECORD');
  assert.equal(fin.isFirstGame, true);
  assert.equal(fin.review.length, 2, '錯題回顧');
  assert.ok(fin.review[0].explanation, '錯題附解析');
  assert.equal(fin.grade.label, '丁', '分數 350 → 丁');
  assert.equal(fin.rank, 1);

  // 每答一題只寫一筆紀錄到 log
  const row = await ctx.store.first('SELECT log FROM game_sessions WHERE token = ?', s.sessionId);
  assert.equal(JSON.parse(row.log).length, 5);

  // 再結算一次不會重複統計
  await call('/api/game/finish', { sessionId: s.sessionId });
  const stat = await ctx.store.first('SELECT SUM(attempts) AS n FROM question_stats');
  assert.equal(stat.n, 5);

  // 第二局：較低分 → 不破紀錄
  const s2 = (await call('/api/game/start', { studentId: '70101' })).data;
  clock += 3000;
  await call('/api/game/answer', { sessionId: s2.sessionId, questionId: s2.question.id, choice: await answerOf(s2.question.id) });
  clock += 180_000;
  const fin2 = (await call('/api/game/finish', { sessionId: s2.sessionId })).data;
  assert.equal(fin2.isNewRecord, false);
  assert.equal(fin2.bestScore, 350);

  // 第三局：更高分 → NEW RECORD
  const s3 = (await call('/api/game/start', { studentId: '70101' })).data;
  clock += 3000;
  let qq = s3.question;
  for (let i = 0; i < 5; i++) {
    const a = await call('/api/game/answer', { sessionId: s3.sessionId, questionId: qq.id, choice: await answerOf(qq.id) });
    qq = a.data.next;
  }
  clock += 180_000;
  const fin3 = (await call('/api/game/finish', { sessionId: s3.sessionId })).data;
  assert.equal(fin3.isNewRecord, true);
  assert.equal(fin3.previousBest, 350);

  const lb = (await call('/api/leaderboard')).data;
  assert.equal(lb.entries.length, 1, '排行榜每人只出現一次');
  assert.equal(lb.entries[0].bestScore, fin3.score);
  assert.ok(!JSON.stringify(lb).includes('70101'), '排行榜不能出現學號');
});

test('重新開局會結束上一局；時間到沒按結算也會自動結算', async () => {
  const a = (await call('/api/game/start', { studentId: '70201' })).data;
  clock += 3000;
  await call('/api/game/answer', { sessionId: a.sessionId, questionId: a.question.id, choice: await answerOf(a.question.id) });
  const b = (await call('/api/game/start', { studentId: '70201' })).data;
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal((await call('/api/game/resume', { sessionId: a.sessionId })).data.finished, true);
  clock += 3000;
  await call('/api/game/answer', { sessionId: b.sessionId, questionId: b.question.id, choice: await answerOf(b.question.id) });
  clock += 190_000; // 學生直接關掉網頁
  await call('/api/leaderboard'); // 讀排行榜時會自動結算過期的局
  const st = await ctx.store.first('SELECT status FROM game_sessions WHERE token = ?', b.sessionId);
  assert.equal(st.status, 'finished');
});

test('教師後台需要登入與自訂標頭', async () => {
  assert.equal((await call('/api/admin/students')).status, 401);
  assert.equal((await call('/api/admin/export/students.csv')).status, 401);
  assert.equal((await call('/api/admin/login', { password: 'teacher-pass' })).status, 403);
  const bad = await call('/api/admin/login', { password: 'nope' }, { 'X-Requested-With': 'rp-admin' });
  assert.equal(bad.status, 401);
  const ok = await call('/api/admin/login', { password: 'teacher-pass' }, { 'X-Requested-With': 'rp-admin' });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/, 'https 時加上 Secure');
  const cookie = setCookie.split(';')[0];
  const forged = cookie.replace(/\.[^.]+$/, '.forged');
  assert.equal((await call('/api/admin/students', undefined, { Cookie: forged })).status, 401, '偽造的通行證無效');

  const st = await call('/api/admin/students?class=701', undefined, { Cookie: cookie });
  assert.equal(st.status, 200);
  assert.ok(st.data.students.every((s) => s.className === '701'));
  const me = st.data.students.find((s) => s.studentId === '70101');
  assert.equal(me.plays, 3);
  assert.ok(me.bestGrade);

  const qs = await call('/api/admin/questions', undefined, { Cookie: cookie });
  assert.ok(qs.data.questions.some((q) => q.attempts > 0));

  const ans = await call('/api/admin/answers', undefined, { Cookie: cookie });
  assert.ok(ans.data.sessions.length >= 3);
  assert.ok(Array.isArray(JSON.parse(ans.data.sessions[0].log)));

  for (const kind of ['students', 'sessions', 'question-stats', 'questions', 'students-list']) {
    const res = await ctx.app.handle(new Request(`https://game.test/api/admin/export/${kind}.csv`, { headers: { Cookie: cookie } }), {});
    assert.equal(res.status, 200, kind);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], `${kind} 有 BOM`);
  }

  // 清除成績需要輸入確認文字
  const xhr = { Cookie: cookie, 'X-Requested-With': 'rp-admin' };
  assert.equal((await call('/api/admin/reset-scores', { confirm: '' }, xhr)).status, 400);
  const reset = await call('/api/admin/reset-scores', { confirm: '確認清除' }, xhr);
  assert.equal(reset.status, 200);
  assert.equal((await call('/api/leaderboard')).data.entries.length, 0);
  assert.equal((await ctx.store.first('SELECT COUNT(*) AS n FROM students')).n, 12, '名單保留');
});

test('沒設定密碼時後台不能登入', async () => {
  const c = await makeApp({ password: '', withData: false });
  const r = await c.call('/api/admin/login', { password: 'whatever1' }, { 'X-Requested-With': 'rp-admin' });
  assert.equal(r.status, 503);
});

test('非 /api/ 路徑交給靜態檔案', async () => {
  assert.equal(await ctx.app.handle(new Request('https://game.test/index.html'), {}), null);
});

test('測試帳號 LJ140000：多人同時玩、不上榮譽榜、不計入後台', async () => {
  const c = await makeApp({ clock: () => clock });
  const lg = await c.call('/api/login', { studentId: 'lj140000' });
  assert.equal(lg.status, 200, '小寫也能登入、不用匯入名單');
  assert.equal(lg.data.student.name, '測試帳號');
  const a = (await c.call('/api/game/start', { studentId: 'LJ140000' })).data;
  const b = (await c.call('/api/game/start', { studentId: 'LJ140000' })).data;
  clock += 3000;
  const ra = await c.call('/api/game/answer', { sessionId: a.sessionId, questionId: a.question.id, choice: '權利' });
  const rb = await c.call('/api/game/answer', { sessionId: b.sessionId, questionId: b.question.id, choice: '權利' });
  assert.ok(ra.status === 200 && rb.status === 200, '兩人同時玩互不干擾');
  clock += 181_000;
  const fin = (await c.call('/api/game/finish', { sessionId: a.sessionId })).data;
  assert.equal(fin.isTest, true);
  assert.equal(fin.rank, null);
  assert.ok(fin.grade, '仍有成績單等第');
  await c.call('/api/game/finish', { sessionId: b.sessionId });
  assert.equal((await c.call('/api/leaderboard')).data.entries.length, 0, '不上榮譽榜');
  assert.equal((await c.store.first('SELECT COUNT(*) AS n FROM question_stats')).n, 0, '不計入題目統計');
  const ok = await c.call('/api/admin/login', { password: 'teacher-pass' }, { 'X-Requested-With': 'rp-admin' });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const ov = (await c.call('/api/admin/overview', undefined, { Cookie: cookie })).data;
  assert.equal(ov.sessions, 0, '不計入後台遊玩次數');
});
