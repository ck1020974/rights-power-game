'use strict';
// 教師後台：統計查詢與 CSV 匯出（只在通過後台驗證後才會被呼叫）。
const { csvLine } = require('./csv');
const { gradeFor } = require('./grading');

function createAdmin({ db, config }) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const time = (ms) => (ms ? fmt.format(new Date(ms)) : '');
  const natural = (a, b) => String(a).localeCompare(String(b), 'zh-Hant', { numeric: true });
  const cls = (c) => (c ? String(c) : null);

  function classes() {
    return db.prepare('SELECT DISTINCT class_name FROM students').all().map((r) => r.class_name).sort(natural);
  }

  function overview(className) {
    const c = cls(className);
    const one = (sql, ...p) => Object.values(db.prepare(sql).get(...p))[0];
    return {
      students: one('SELECT COUNT(*) FROM students WHERE active = 1 AND (? IS NULL OR class_name = ?)', c, c),
      players: one(`SELECT COUNT(DISTINCT g.student_id) FROM game_sessions g JOIN students s ON s.student_id = g.student_id
        WHERE g.status = 'finished' AND g.answered_count > 0 AND (? IS NULL OR s.class_name = ?)`, c, c),
      sessions: one(`SELECT COUNT(*) FROM game_sessions g JOIN students s ON s.student_id = g.student_id
        WHERE g.status = 'finished' AND g.answered_count > 0 AND (? IS NULL OR s.class_name = ?)`, c, c),
      answers: one(`SELECT COUNT(*) FROM answers a JOIN students s ON s.student_id = a.student_id
        WHERE (? IS NULL OR s.class_name = ?)`, c, c),
      questions: one('SELECT COUNT(*) FROM questions WHERE active = 1'),
    };
  }

  const STUDENT_SQL = `
    SELECT st.student_id, st.name, st.class_name, st.seat_no, st.active,
           COALESCE(b.score, 0) AS best_score,
           COALESCE(p.plays, 0) AS plays,
           COALESCE(p.answered, 0) AS answered,
           COALESCE(p.correct, 0) AS correct,
           p.avg_ms, p.last_played, b.max_combo AS best_combo,
           b.answered_count AS best_answered, b.correct_count AS best_correct
    FROM students st
    LEFT JOIN v_best_sessions b ON b.student_id = st.student_id
    LEFT JOIN (
      SELECT g.student_id, COUNT(*) AS plays, SUM(g.answered_count) AS answered, SUM(g.correct_count) AS correct,
             MAX(g.finished_at) AS last_played,
             (SELECT AVG(a.response_ms) FROM answers a WHERE a.student_id = g.student_id) AS avg_ms
      FROM game_sessions g WHERE g.status = 'finished' AND g.answered_count > 0 GROUP BY g.student_id
    ) p ON p.student_id = st.student_id
    WHERE (? IS NULL OR st.class_name = ?)
    ORDER BY st.class_name, st.seat_no, st.student_id`;

  function students(className) {
    const c = cls(className);
    return db.prepare(STUDENT_SQL).all(c, c).map((r) => ({
      studentId: r.student_id, name: r.name, className: r.class_name, seatNo: r.seat_no, active: !!r.active,
      bestScore: r.best_score, plays: r.plays, answered: r.answered, correct: r.correct,
      accuracy: r.answered ? r.correct / r.answered : null,
      avgSeconds: r.avg_ms == null ? null : r.avg_ms / 1000,
      bestCombo: r.best_combo || 0, lastPlayed: r.last_played,
      bestGrade: r.best_answered ? gradeFor(r.best_score, Math.round((r.best_correct / r.best_answered) * 100), config.grades).label : null,
    }));
  }

  function studentSessions(studentId) {
    return db.prepare(`
      SELECT g.id, g.finished_at, g.score, g.answered_count, g.correct_count, g.max_combo, g.is_new_record,
             (SELECT AVG(response_ms) FROM answers a WHERE a.session_id = g.id) AS avg_ms
      FROM game_sessions g WHERE g.student_id = ? AND g.status = 'finished' AND g.answered_count > 0
      ORDER BY g.finished_at DESC`).all(String(studentId)).map((r) => ({
      id: r.id, finishedAt: r.finished_at, score: r.score, answered: r.answered_count, correct: r.correct_count,
      accuracy: r.answered_count ? r.correct_count / r.answered_count : null,
      maxCombo: r.max_combo, isNewRecord: !!r.is_new_record, avgSeconds: r.avg_ms == null ? null : r.avg_ms / 1000,
    }));
  }

  const QUESTION_SQL = `
    SELECT q.id, q.code, q.text, q.answer, q.difficulty, q.category, q.active,
           COUNT(a.id) AS attempts, COALESCE(SUM(a.correct), 0) AS correct, AVG(a.response_ms) AS avg_ms
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.id
      AND (? IS NULL OR a.student_id IN (SELECT student_id FROM students WHERE class_name = ?))
    GROUP BY q.id ORDER BY q.code`;

  function questions(className) {
    const c = cls(className);
    return db.prepare(QUESTION_SQL).all(c, c).map((r) => ({
      id: r.id, code: r.code, text: r.text, answer: r.answer, difficulty: r.difficulty, category: r.category,
      active: !!r.active, attempts: r.attempts, correct: r.correct,
      accuracy: r.attempts ? r.correct / r.attempts : null,
      avgSeconds: r.avg_ms == null ? null : r.avg_ms / 1000,
    }));
  }

  // ── CSV 匯出（分批寫出，避免一次佔用大量記憶體）──────────
  function sendCsv(res, filename, headers, rowIterable) {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    res.write('﻿' + csvLine(headers));
    let buf = '';
    let n = 0;
    for (const row of rowIterable) {
      buf += csvLine(row);
      if (++n % 500 === 0) {
        res.write(buf);
        buf = '';
      }
    }
    res.end(buf);
  }

  const pct = (x) => (x == null ? '' : Math.round(x * 1000) / 10);
  const sec = (x) => (x == null ? '' : Math.round(x * 100) / 100);
  const yn = (v) => (v ? '是' : '否');

  function exportCsv(kind, className, res) {
    const c = cls(className);
    const tag = c ? `_${c}` : '';
    const date = time(Date.now()).slice(0, 10);
    switch (kind) {
      case 'students':
        return sendCsv(res, `學生成績總表${tag}_${date}.csv`,
          ['學號', '姓名', '班級', '座號', '最高分', '最佳等第', '遊玩次數', '總作答題數', '總答對題數', '總正確率(%)', '平均作答秒數', '最佳局最高Combo', '最近遊玩時間'],
          students(c).map((s) => [s.studentId, s.name, s.className, s.seatNo, s.bestScore, s.bestGrade ?? '', s.plays, s.answered, s.correct, pct(s.accuracy), sec(s.avgSeconds), s.bestCombo, time(s.lastPlayed)]));
      case 'sessions':
        return sendCsv(res, `每局成績${tag}_${date}.csv`,
          ['場次ID', '學號', '姓名', '班級', '結束時間', '分數', '作答題數', '答對題數', '正確率(%)', '最高Combo', '刷新個人紀錄'],
          mapIter(db.prepare(`SELECT g.*, s.name, s.class_name FROM game_sessions g JOIN students s ON s.student_id = g.student_id
            WHERE g.status = 'finished' AND g.answered_count > 0 AND (? IS NULL OR s.class_name = ?)
            ORDER BY g.finished_at`), [c, c],
          (g) => [g.id, g.student_id, g.name, g.class_name, time(g.finished_at), g.score, g.answered_count, g.correct_count,
            g.answered_count ? pct(g.correct_count / g.answered_count) : '', g.max_combo, yn(g.is_new_record)]));
      case 'answers':
        return sendCsv(res, `作答明細${tag}_${date}.csv`,
          ['場次ID', '學號', '姓名', '班級', '第幾題', '題號', '題目', '正確答案', '學生選擇', '是否答對', '作答秒數', '按鈕排列', '得分變化', '當下總分', '連對數', '冷卻毫秒', '作答時間'],
          mapIter(db.prepare(`SELECT a.*, s.name, s.class_name, q.code, q.text, q.answer FROM answers a
            JOIN students s ON s.student_id = a.student_id JOIN questions q ON q.id = a.question_id
            WHERE (? IS NULL OR s.class_name = ?) ORDER BY a.id`), [c, c],
          (a) => [a.session_id, a.student_id, a.name, a.class_name, a.seq_no, a.code, a.text, a.answer, a.chosen, yn(a.correct),
            sec(a.response_ms / 1000), a.layout === 'rl' ? '權利在左' : '權力在左', a.score_delta, a.score_after, a.combo_after, a.cooldown_ms, time(a.answered_at)]));
      case 'question-stats':
        return sendCsv(res, `題目作答統計${tag}_${date}.csv`,
          ['題號', '題目', '答案', '難度', '類別', '啟用', '作答次數', '答對次數', '答對率(%)', '平均作答秒數'],
          questions(c).map((q) => [q.code, q.text, q.answer, q.difficulty, q.category, yn(q.active), q.attempts, q.correct, pct(q.accuracy), sec(q.avgSeconds)]));
      case 'questions':
        return sendCsv(res, `題庫_${date}.csv`, ['題號', '題目', '答案', '難度', '類別', '解析'],
          db.prepare('SELECT code, text, answer, difficulty, category, explanation FROM questions WHERE active = 1 ORDER BY code').all()
            .map((q) => [q.code, q.text, q.answer, q.difficulty, q.category, q.explanation]));
      case 'students-list':
        return sendCsv(res, `學生名單_${date}.csv`, ['學號', '姓名', '班級', '座號'],
          db.prepare('SELECT student_id, name, class_name, seat_no FROM students WHERE active = 1 ORDER BY class_name, seat_no, student_id').all()
            .map((s) => [s.student_id, s.name, s.class_name, s.seat_no]));
      default:
        return false;
    }
  }

  function* mapIter(stmt, params, fn) {
    if (typeof stmt.iterate === 'function') for (const row of stmt.iterate(...params)) yield fn(row);
    else for (const row of stmt.all(...params)) yield fn(row);
  }

  return { classes, overview, students, studentSessions, questions, exportCsv, time };
}

module.exports = { createAdmin };
