'use strict';
// 遊戲核心：登入、開局、逐題判分、結算、排行榜。所有判分與計時都在伺服器完成。
// 寫入量設計（Cloudflare D1 免費額度）：每答一題只更新 game_sessions 一列。
const { HttpError } = require('./errors');
const { applyAnswer } = require('./scoring');
const { buildSequence, nextLayout, choicesFor } = require('./sequence');
const { normalizeStudentId } = require('./importers');
const { gradeFor } = require('./grading');

const READY_TOLERANCE_MS = 150; // 網路抖動容許：題目開放前 150ms 內送達的答案仍接受
const MAX_SEQUENCE = 400;
const CHOICE_CODE = { 權利: 0, 權力: 1 };

function randomToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// 開局時保存的設定（只留遊戲用得到的部分）
function snapshotConfig(config) {
  const { game, scoring, cooldown, selection, grades, reportCardTitle } = config;
  return JSON.stringify({ game, scoring, cooldown, selection, grades, reportCardTitle });
}

function createGame({ store, config, now = Date.now, rnd = Math.random }) {
  const natural = (a, b) => String(a).localeCompare(String(b), 'zh-Hant', { numeric: true });
  const TEST_IDS = new Set((config.testAccounts || []).map(normalizeStudentId));
  const isTest = (id) => TEST_IDS.has(id);
  const testStudent = (id) => ({ student_id: id, name: '測試帳號', class_name: '測試', active: 1 });

  // 依學號取得學生（測試帳號不在名單裡，直接產生一個虛擬學生）
  async function studentRow(id) {
    if (isTest(id)) return testStudent(id);
    return store.first('SELECT * FROM students WHERE student_id = ?', id);
  }

  async function getStudent(rawId) {
    const id = normalizeStudentId(rawId);
    const student = id ? await studentRow(id) : null;
    if (!student || !student.active) throw new HttpError(404, '找不到這個學號，請確認後再輸入', 'STUDENT_NOT_FOUND');
    return student;
  }

  async function bestOf(studentId) {
    if (isTest(studentId)) return { best: null, plays: 0 };
    const b = await store.first('SELECT score FROM best_scores WHERE student_id = ?', studentId);
    const p = await store.first(
      "SELECT COUNT(*) AS plays FROM game_sessions WHERE student_id = ? AND status = 'finished' AND answered_count > 0", studentId);
    return { best: b ? b.score : null, plays: p ? p.plays : 0 };
  }

  function publicConfig() {
    return {
      durationSeconds: config.game.durationSeconds,
      startCountdownSeconds: config.game.startCountdownSeconds,
      scoring: config.scoring,
      cooldown: config.cooldown,
      leaderboardSize: config.leaderboard.size,
    };
  }

  async function login(rawId) {
    const student = await getStudent(rawId);
    const { best, plays } = await bestOf(student.student_id);
    return { student: { name: student.name, className: student.class_name }, bestScore: best || 0, plays };
  }

  function layoutAfter(prev, run, cfg) {
    if (!cfg.selection.shuffleButtons) return { layout: 'rl', run: 1 };
    return nextLayout(prev, run, cfg.selection.maxSameLayoutInRow, rnd);
  }

  function sequenceOptions(cfg, extra = {}) {
    return {
      mix: cfg.selection.difficultyMix,
      balanceAnswers: cfg.selection.balanceAnswers,
      maxSameAnswerInRow: cfg.selection.maxSameAnswerInRow,
      rnd,
      ...extra,
    };
  }

  async function questionPayload(qid, no, layout) {
    const q = await store.first('SELECT id, text FROM questions WHERE id = ?', qid);
    return { id: q.id, no, text: q.text, choices: choicesFor(layout) };
  }

  async function snapshot(s, student, t) {
    const seq = JSON.parse(s.sequence);
    const { best } = await bestOf(s.student_id);
    return {
      sessionId: s.token,
      student: { name: student.name, className: student.class_name },
      bestScore: best || 0,
      serverNow: t,
      remainingMs: Math.max(0, s.ends_at - t),
      waitMs: Math.max(0, s.question_shown_at - t),
      score: s.score,
      combo: s.combo,
      maxCombo: s.max_combo,
      correctCount: s.correct_count,
      wrongCount: s.wrong_count,
      answeredCount: s.answered_count,
      question: await questionPayload(seq[s.seq_index], s.answered_count + 1, s.layout),
    };
  }

  const getSession = (token) => store.first('SELECT * FROM game_sessions WHERE token = ?', String(token || ''));

  async function start(rawId) {
    const student = await getStudent(rawId);
    const t = now();
    const pool = await store.all('SELECT id, difficulty, answer FROM questions WHERE active = 1');
    if (pool.length < 2) throw new HttpError(503, '題庫還沒有準備好，請通知老師匯入題目', 'NO_QUESTIONS');
    // 一般學號：重新開局時結束同一個人未完成的局（測試帳號多人共用，不互相結束）
    if (!isTest(student.student_id)) {
      const open = await store.all("SELECT * FROM game_sessions WHERE student_id = ? AND status = 'active'", student.student_id);
      for (const s of open) await finalize(s, t);
    }

    const sequence = buildSequence(pool, sequenceOptions(config, { length: Math.min(pool.length, MAX_SEQUENCE) }));
    const playsAt = t + config.game.startCountdownSeconds * 1000;
    const endsAt = playsAt + config.game.durationSeconds * 1000;
    const { layout } = layoutAfter(null, 0, config);
    const token = randomToken();
    await store.run(`INSERT INTO game_sessions
      (token, student_id, status, started_at, plays_at, ends_at, sequence, seq_index, question_shown_at, layout, layout_run, config_snapshot)
      VALUES (?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, 1, ?)`,
    token, student.student_id, t, playsAt, endsAt, JSON.stringify(sequence), playsAt, layout, snapshotConfig(config));
    return snapshot(await getSession(token), student, t);
  }

  async function resume(token) {
    const t = now();
    const s = await getSession(token);
    if (!s) throw new HttpError(404, '找不到這場遊戲', 'NO_SESSION');
    if (s.status === 'finished') return { finished: true };
    const cfg = JSON.parse(s.config_snapshot);
    if (t > s.ends_at + cfg.game.graceMs) {
      await finalize(s, t);
      return { finished: true };
    }
    return snapshot(s, await studentRow(s.student_id), t);
  }

  async function answer({ sessionId, questionId, choice }) {
    if (choice !== '權利' && choice !== '權力') throw new HttpError(400, '選項不正確', 'BAD_CHOICE');
    const t = now();
    const s = await getSession(sessionId);
    if (!s) throw new HttpError(404, '找不到這場遊戲', 'NO_SESSION');
    if (s.status === 'finished') return { finished: true };
    const cfg = JSON.parse(s.config_snapshot);
    if (t > s.ends_at + cfg.game.graceMs) {
      await finalize(s, t);
      return { finished: true };
    }
    let seq = JSON.parse(s.sequence);
    const qid = seq[s.seq_index];
    if (Number(questionId) !== qid) throw new HttpError(409, '題目已更新，請重新同步', 'STALE');
    if (t < s.question_shown_at - READY_TOLERANCE_MS) {
      throw new HttpError(409, '還不能作答', 'NOT_READY', { waitMs: s.question_shown_at - t });
    }

    const q = await store.first('SELECT answer FROM questions WHERE id = ?', qid);
    const correct = choice === q.answer;
    const responseMs = Math.max(0, t - s.question_shown_at);
    const result = applyAnswer(
      { score: s.score, combo: s.combo, maxCombo: s.max_combo, wrongStreak: s.wrong_streak },
      { correct, responseMs },
      cfg.scoring,
      cfg.cooldown,
    );
    const ns = result.state;
    const answered = s.answered_count + 1;
    const correctCount = s.correct_count + (correct ? 1 : 0);
    const wrongCount = s.wrong_count + (correct ? 0 : 1);
    const entry = [qid, CHOICE_CODE[choice], correct ? 1 : 0, responseMs, result.delta, s.layout === 'rl' ? 0 : 1, result.cooldownMs, t];

    const timeUp = t >= s.ends_at;
    let nextIndex = s.seq_index + 1;
    let layout = s.layout;
    let run = s.layout_run;
    let shownAt = s.question_shown_at;
    let seqChanged = false;
    if (!timeUp) {
      if (nextIndex >= seq.length) {
        const pool = await store.all('SELECT id, difficulty, answer FROM questions WHERE active = 1');
        seq = seq.concat(buildSequence(pool, sequenceOptions(cfg, { length: Math.min(pool.length, MAX_SEQUENCE), avoidFirstId: qid })));
        seqChanged = true;
      }
      const nl = layoutAfter(s.layout, s.layout_run, cfg);
      layout = nl.layout;
      run = nl.run;
      shownAt = t + result.cooldownMs;
    }
    // 樂觀鎖：只有 seq_index 還是原本那一題時才寫入，避免連點造成重複計分
    const upd = await store.run(`UPDATE game_sessions SET score = ?, answered_count = ?, correct_count = ?, wrong_count = ?,
        combo = ?, max_combo = ?, wrong_streak = ?, total_ms = total_ms + ?, sequence = ?, seq_index = ?,
        question_shown_at = ?, layout = ?, layout_run = ?, log = json_insert(log, '$[#]', json(?))
      WHERE id = ? AND seq_index = ? AND status = 'active'`,
    ns.score, answered, correctCount, wrongCount, ns.combo, ns.maxCombo, ns.wrongStreak, responseMs,
    seqChanged ? JSON.stringify(seq) : s.sequence, nextIndex, shownAt, layout, run, JSON.stringify(entry), s.id, s.seq_index);
    if (!upd.changes) throw new HttpError(409, '題目已更新，請重新同步', 'STALE');

    const next = timeUp ? null : await questionPayload(seq[nextIndex], answered + 1, layout);
    return {
      correct,
      correctAnswer: q.answer,
      points: { ...result.parts, delta: result.delta },
      comboBonus: result.parts.combo,
      score: ns.score,
      combo: ns.combo,
      maxCombo: ns.maxCombo,
      correctCount,
      wrongCount,
      answeredCount: answered,
      cooldownMs: result.cooldownMs,
      next,
      finished: timeUp,
      serverNow: t,
      remainingMs: Math.max(0, s.ends_at - t),
    };
  }

  // 結束一局：標記完成 → 更新最佳成績與題目統計。重複呼叫是安全的（只有第一次會生效）。
  async function finalize(s, t) {
    if (!s || s.status === 'finished') return;
    if (isTest(s.student_id)) {
      // 測試帳號：只標記完成，不更新榮譽榜與題目統計
      await store.run("UPDATE game_sessions SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'active'", Math.min(t, s.ends_at), s.id);
      return;
    }
    const prior = await store.first('SELECT score FROM best_scores WHERE student_id = ?', s.student_id);
    const prevBest = prior ? prior.score : null;
    const isNew = s.answered_count > 0 && prevBest !== null && s.score > prevBest;
    const finishedAt = Math.min(t, s.ends_at);
    const claim = await store.run(
      "UPDATE game_sessions SET status = 'finished', finished_at = ?, prev_best = ?, is_new_record = ? WHERE id = ? AND status = 'active'",
      finishedAt, prevBest, isNew ? 1 : 0, s.id);
    if (!claim.changes || s.answered_count === 0) return;

    const st = await store.first('SELECT class_name FROM students WHERE student_id = ?', s.student_id);
    const className = st ? st.class_name : '';
    const accuracy = Math.round((s.correct_count / s.answered_count) * 100);
    const ops = [[`INSERT INTO best_scores (student_id, score, accuracy, answered, correct, max_combo, finished_at, session_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id) DO UPDATE SET score = excluded.score, accuracy = excluded.accuracy, answered = excluded.answered,
          correct = excluded.correct, max_combo = excluded.max_combo, finished_at = excluded.finished_at, session_token = excluded.session_token
        WHERE excluded.score > best_scores.score`,
    [s.student_id, s.score, accuracy, s.answered_count, s.correct_count, s.max_combo, finishedAt, s.token]]];
    const agg = new Map();
    for (const [qid, , ok, ms] of JSON.parse(s.log)) {
      const a = agg.get(qid) || { n: 0, c: 0, ms: 0 };
      a.n++;
      a.c += ok;
      a.ms += ms;
      agg.set(qid, a);
    }
    for (const [qid, a] of agg) {
      ops.push([`INSERT INTO question_stats (question_id, class_name, attempts, correct, total_ms) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(question_id, class_name) DO UPDATE SET attempts = attempts + excluded.attempts,
          correct = correct + excluded.correct, total_ms = total_ms + excluded.total_ms`, [qid, className, a.n, a.c, a.ms]]);
    }
    await store.batch(ops);
  }

  async function buildResult(s) {
    const accuracy = s.answered_count ? Math.round((s.correct_count / s.answered_count) * 100) : 0;
    const cfg = JSON.parse(s.config_snapshot);
    let rank = null;
    const test = isTest(s.student_id);
    if (s.answered_count > 0 && !test) {
      const me = await store.first('SELECT score FROM best_scores WHERE student_id = ?', s.student_id);
      if (me && me.score > 0) {
        const r = await store.first(`SELECT COUNT(*) + 1 AS rank FROM best_scores b JOIN students st ON st.student_id = b.student_id
          WHERE st.active = 1 AND b.score > ?`, me.score);
        rank = r.rank;
      }
    }
    const wrong = JSON.parse(s.log).map((e, i) => ({ no: i + 1, qid: e[0], chosen: e[1] === 0 ? '權利' : '權力', ok: e[2] })).filter((e) => !e.ok);
    let review = [];
    if (wrong.length) {
      const ids = [...new Set(wrong.map((w) => w.qid))].slice(0, 90);
      const rows = await store.all(`SELECT id, text, answer, explanation FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
      const byId = new Map(rows.map((r) => [r.id, r]));
      review = wrong.filter((w) => byId.has(w.qid)).map((w) => {
        const q = byId.get(w.qid);
        return { no: w.no, text: q.text, chosen: w.chosen, correctAnswer: q.answer, explanation: q.explanation };
      });
    }
    const prev = s.prev_best;
    return {
      grade: s.answered_count ? gradeFor(s.score, accuracy, cfg.grades || config.grades) : null,
      reportCardTitle: cfg.reportCardTitle || config.reportCardTitle,
      finishedAt: s.finished_at,
      sessionId: s.token,
      score: s.score,
      answeredCount: s.answered_count,
      correctCount: s.correct_count,
      wrongCount: s.wrong_count,
      accuracy,
      maxCombo: s.max_combo,
      previousBest: prev ?? 0,
      bestScore: Math.max(prev ?? 0, s.score),
      isNewRecord: !!s.is_new_record,
      isFirstGame: !test && prev === null && s.answered_count > 0,
      isTest: test,
      rank,
      review,
    };
  }

  async function finish(token) {
    const t = now();
    let s = await getSession(token);
    if (!s) throw new HttpError(404, '找不到這場遊戲', 'NO_SESSION');
    if (s.status !== 'finished') {
      await finalize(s, t);
      s = await getSession(token);
    }
    return buildResult(s);
  }

  async function sweepExpired() {
    const t = now();
    const rows = await store.all("SELECT * FROM game_sessions WHERE status = 'active' AND ends_at < ? LIMIT 25", t - config.game.graceMs);
    for (const s of rows) await finalize(s, t);
    return rows.length;
  }

  async function leaderboard(className) {
    await sweepExpired();
    const classes = (await store.all('SELECT DISTINCT class_name FROM students WHERE active = 1')).map((r) => r.class_name).sort(natural);
    const filter = className && classes.includes(className) ? className : null;
    const rows = await store.all(`
      SELECT RANK() OVER (ORDER BY b.score DESC) AS rank, s.name, s.class_name, b.score
      FROM best_scores b JOIN students s ON s.student_id = b.student_id
      WHERE b.score > 0 AND s.active = 1 ${filter ? 'AND s.class_name = ?' : ''}
      ORDER BY b.score DESC, b.finished_at ASC, s.student_id ASC
      LIMIT ?`, ...(filter ? [filter] : []), config.leaderboard.size);
    return {
      classes,
      className: filter,
      entries: rows.map((r) => ({ rank: r.rank, name: r.name, className: r.class_name, bestScore: r.score })),
    };
  }

  return { publicConfig, login, start, resume, answer, finish, sweepExpired, leaderboard };
}

module.exports = { createGame };
