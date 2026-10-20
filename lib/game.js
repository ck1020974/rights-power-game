'use strict';
// 遊戲核心：登入、開局、逐題判分、結算、排行榜。所有判分與計時都在伺服器完成。
const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const { tx } = require('./db');
const { applyAnswer } = require('./scoring');
const { buildSequence, nextLayout, choicesFor } = require('./sequence');
const { normalizeStudentId } = require('./importers');
const { gradeFor } = require('./grading');

const READY_TOLERANCE_MS = 150; // 網路抖動容許：題目開放前 150ms 內送達的答案仍接受
const MAX_SEQUENCE = 400;

function createGame({ db, config, now = Date.now, rnd = Math.random }) {
  const st = {
    student: db.prepare('SELECT * FROM students WHERE student_id = ?'),
    activeQuestions: db.prepare('SELECT id, difficulty, answer FROM questions WHERE active = 1'),
    question: db.prepare('SELECT * FROM questions WHERE id = ?'),
    session: db.prepare('SELECT * FROM game_sessions WHERE id = ?'),
    openSessions: db.prepare("SELECT id FROM game_sessions WHERE student_id = ? AND status = 'active'"),
    expired: db.prepare("SELECT id FROM game_sessions WHERE status = 'active' AND ends_at < ?"),
    best: db.prepare("SELECT MAX(score) AS best, COUNT(*) AS plays FROM game_sessions WHERE student_id = ? AND status = 'finished' AND answered_count > 0"),
    bestExcluding: db.prepare("SELECT MAX(score) AS best, COUNT(*) AS plays FROM game_sessions WHERE student_id = ? AND status = 'finished' AND answered_count > 0 AND id != ?"),
    insertSession: db.prepare(`INSERT INTO game_sessions
      (id, student_id, status, started_at, plays_at, ends_at, sequence, seq_index, question_shown_at, layout, layout_run, config_snapshot)
      VALUES (?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, 1, ?)`),
    updateSession: db.prepare(`UPDATE game_sessions SET score = ?, answered_count = ?, correct_count = ?, wrong_count = ?,
      combo = ?, max_combo = ?, wrong_streak = ?, sequence = ?, seq_index = ?, question_shown_at = ?, layout = ?, layout_run = ? WHERE id = ?`),
    finishSession: db.prepare("UPDATE game_sessions SET status = 'finished', finished_at = ?, prev_best = ?, is_new_record = ? WHERE id = ?"),
    insertAnswer: db.prepare(`INSERT INTO answers
      (session_id, student_id, question_id, seq_no, chosen, correct, response_ms, layout, base_points, speed_points,
       combo_points, penalty_points, score_delta, score_after, combo_after, cooldown_ms, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    review: db.prepare(`SELECT a.seq_no, a.chosen, q.text, q.answer, q.explanation
      FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE a.session_id = ? AND a.correct = 0 ORDER BY a.seq_no`),
    rank: db.prepare(`WITH ranked AS (
        SELECT b.student_id, RANK() OVER (ORDER BY b.score DESC) AS rank
        FROM v_best_sessions b JOIN students s ON s.student_id = b.student_id
        WHERE b.score > 0 AND s.active = 1)
      SELECT rank FROM ranked WHERE student_id = ?`),
    classes: db.prepare('SELECT DISTINCT class_name FROM students WHERE active = 1'),
  };

  const natural = (a, b) => String(a).localeCompare(String(b), 'zh-Hant', { numeric: true });

  function getStudent(rawId) {
    const id = normalizeStudentId(rawId);
    const student = id ? st.student.get(id) : null;
    if (!student || !student.active) throw new HttpError(404, '找不到這個學號，請確認後再輸入', 'STUDENT_NOT_FOUND');
    return student;
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

  function login(rawId) {
    const student = getStudent(rawId);
    const { best, plays } = st.best.get(student.student_id);
    return { student: { name: student.name, className: student.class_name }, bestScore: best || 0, plays: plays || 0 };
  }

  function questionPayload(session, seq) {
    const q = st.question.get(seq[session.seq_index]);
    return { id: q.id, no: session.answered_count + 1, text: q.text, choices: choicesFor(session.layout) };
  }

  function snapshot(s, student, t) {
    const seq = JSON.parse(s.sequence);
    const { best } = st.best.get(s.student_id);
    return {
      sessionId: s.id,
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
      question: questionPayload(s, seq),
    };
  }

  // 按鈕排列：固定時永遠是「權利在左」（rl）
  function layoutAfter(prev, run, cfg) {
    if (!cfg.selection.shuffleButtons) return { layout: 'rl', run: 1 };
    return nextLayout(prev, run, cfg.selection.maxSameLayoutInRow, rnd);
  }

  function sequenceOptions(extra = {}) {
    return {
      mix: config.selection.difficultyMix,
      balanceAnswers: config.selection.balanceAnswers,
      maxSameAnswerInRow: config.selection.maxSameAnswerInRow,
      rnd,
      ...extra,
    };
  }

  function start(rawId) {
    const student = getStudent(rawId);
    const t = now();
    const pool = st.activeQuestions.all();
    if (pool.length < 2) throw new HttpError(503, '題庫還沒有準備好，請通知老師匯入題目', 'NO_QUESTIONS');
    return tx(db, () => {
      for (const open of st.openSessions.all(student.student_id)) finalize(open.id, t);
      const sequence = buildSequence(pool, sequenceOptions({ length: Math.min(pool.length, MAX_SEQUENCE) }));
      const playsAt = t + config.game.startCountdownSeconds * 1000;
      const endsAt = playsAt + config.game.durationSeconds * 1000;
      const { layout } = layoutAfter(null, 0, config);
      const id = crypto.randomBytes(16).toString('hex');
      st.insertSession.run(id, student.student_id, t, playsAt, endsAt, JSON.stringify(sequence), playsAt, layout, JSON.stringify(config));
      return snapshot(st.session.get(id), student, t);
    });
  }

  function resume(sessionId) {
    const t = now();
    return tx(db, () => {
      const s = st.session.get(String(sessionId || ''));
      if (!s) throw new HttpError(404, '找不到這場遊戲', 'NO_SESSION');
      if (s.status === 'finished') return { finished: true };
      const cfg = JSON.parse(s.config_snapshot);
      if (t > s.ends_at + cfg.game.graceMs) {
        finalize(s.id, t);
        return { finished: true };
      }
      return snapshot(s, st.student.get(s.student_id), t);
    });
  }

  function answer({ sessionId, questionId, choice }) {
    if (choice !== '權利' && choice !== '權力') throw new HttpError(400, '選項不正確', 'BAD_CHOICE');
    const t = now();
    return tx(db, () => {
      const s = st.session.get(String(sessionId || ''));
      if (!s) throw new HttpError(404, '找不到這場遊戲', 'NO_SESSION');
      if (s.status === 'finished') return { finished: true };
      const cfg = JSON.parse(s.config_snapshot);
      if (t > s.ends_at + cfg.game.graceMs) {
        finalize(s.id, t);
        return { finished: true };
      }
      let seq = JSON.parse(s.sequence);
      const qid = seq[s.seq_index];
      if (Number(questionId) !== qid) throw new HttpError(409, '題目已更新，請重新同步', 'STALE');
      if (t < s.question_shown_at - READY_TOLERANCE_MS) {
        throw new HttpError(409, '還不能作答', 'NOT_READY', { waitMs: s.question_shown_at - t });
      }

      const q = st.question.get(qid);
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

      st.insertAnswer.run(
        s.id, s.student_id, qid, answered, choice, correct ? 1 : 0, responseMs, s.layout,
        result.parts.base, result.parts.speed, result.parts.combo, result.parts.penalty,
        result.delta, ns.score, ns.combo, result.cooldownMs, t,
      );

      const timeUp = t >= s.ends_at;
      let next = null;
      let nextIndex = s.seq_index + 1;
      let layout = s.layout;
      let run = s.layout_run;
      let shownAt = s.question_shown_at;
      if (!timeUp) {
        if (nextIndex >= seq.length) {
          const pool = st.activeQuestions.all();
          seq = seq.concat(buildSequence(pool, sequenceOptions({ length: Math.min(pool.length, MAX_SEQUENCE), avoidFirstId: qid })));
        }
        const nl = layoutAfter(s.layout, s.layout_run, cfg);
        layout = nl.layout;
        run = nl.run;
        shownAt = t + result.cooldownMs;
      }
      st.updateSession.run(ns.score, answered, correctCount, wrongCount, ns.combo, ns.maxCombo, ns.wrongStreak,
        JSON.stringify(seq), nextIndex, shownAt, layout, run, s.id);
      if (!timeUp) {
        next = questionPayload({ ...s, seq_index: nextIndex, answered_count: answered, layout }, seq);
      }

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
    });
  }

  // 把一局標記為結束，並判斷是否刷新個人紀錄（需在交易內呼叫）
  function finalize(sessionId, t) {
    const s = st.session.get(sessionId);
    if (!s || s.status === 'finished') return s;
    const prior = st.bestExcluding.get(s.student_id, s.id);
    const prevBest = prior.plays > 0 ? prior.best : null;
    const isNew = s.answered_count > 0 && prevBest !== null && s.score > prevBest;
    st.finishSession.run(Math.min(t, s.ends_at), prevBest, isNew ? 1 : 0, s.id);
    return st.session.get(sessionId);
  }

  function buildResult(s) {
    const prev = s.prev_best;
    const rank = s.answered_count > 0 ? st.rank.get(s.student_id) : null;
    const accuracy = s.answered_count ? Math.round((s.correct_count / s.answered_count) * 100) : 0;
    const cfg = JSON.parse(s.config_snapshot);
    const grades = cfg.grades || config.grades;
    return {
      grade: s.answered_count ? gradeFor(s.score, accuracy, grades) : null,
      reportCardTitle: cfg.reportCardTitle || config.reportCardTitle,
      finishedAt: s.finished_at,
      sessionId: s.id,
      score: s.score,
      answeredCount: s.answered_count,
      correctCount: s.correct_count,
      wrongCount: s.wrong_count,
      accuracy,
      maxCombo: s.max_combo,
      previousBest: prev ?? 0,
      bestScore: Math.max(prev ?? 0, s.score),
      isNewRecord: !!s.is_new_record,
      isFirstGame: prev === null && s.answered_count > 0,
      rank: rank ? rank.rank : null,
      review: st.review.all(s.id).map((r) => ({ no: r.seq_no, text: r.text, chosen: r.chosen, correctAnswer: r.answer, explanation: r.explanation })),
    };
  }

  function finish(sessionId) {
    const t = now();
    return tx(db, () => {
      const s0 = st.session.get(String(sessionId || ''));
      if (!s0) throw new HttpError(404, '找不到這場遊戲', 'NO_SESSION');
      return buildResult(finalize(s0.id, t));
    });
  }

  function sweepExpired() {
    const t = now();
    const grace = config.game.graceMs;
    const rows = st.expired.all(t - grace);
    if (!rows.length) return 0;
    tx(db, () => rows.forEach((r) => finalize(r.id, t)));
    return rows.length;
  }

  function leaderboard(className) {
    sweepExpired();
    const classes = st.classes.all().map((r) => r.class_name).sort(natural);
    const filter = className && classes.includes(className) ? className : null;
    const rows = db.prepare(`
      SELECT RANK() OVER (ORDER BY b.score DESC) AS rank, s.name, s.class_name, b.score
      FROM v_best_sessions b JOIN students s ON s.student_id = b.student_id
      WHERE b.score > 0 AND s.active = 1 ${filter ? 'AND s.class_name = ?' : ''}
      ORDER BY b.score DESC, b.finished_at ASC, s.student_id ASC
      LIMIT ?`).all(...(filter ? [filter] : []), config.leaderboard.size);
    return {
      classes,
      className: filter,
      entries: rows.map((r) => ({ rank: r.rank, name: r.name, className: r.class_name, bestScore: r.score })),
    };
  }

  return { publicConfig, login, start, resume, answer, finish, sweepExpired, leaderboard };
}

module.exports = { createGame };
