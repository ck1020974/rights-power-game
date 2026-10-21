'use strict';
// 教師後台：統計查詢與 CSV 匯出（只在通過後台驗證後才會被呼叫）。
const { toCsv } = require('./csv');
const { gradeFor } = require('./grading');

function createAdmin({ store, config }) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const time = (ms) => (ms ? fmt.format(new Date(ms)) : '');
  const natural = (a, b) => String(a).localeCompare(String(b), 'zh-Hant', { numeric: true });
  const cls = (c) => (c ? String(c) : null);

  async function classes() {
    return (await store.all('SELECT DISTINCT class_name FROM students')).map((r) => r.class_name).sort(natural);
  }

  async function overview(className) {
    const c = cls(className);
    const students = await store.first('SELECT COUNT(*) AS n FROM students WHERE active = 1 AND (? IS NULL OR class_name = ?)', c, c);
    const games = await store.first(`SELECT COUNT(DISTINCT g.student_id) AS players, COUNT(*) AS sessions, COALESCE(SUM(g.answered_count), 0) AS answers
      FROM game_sessions g JOIN students s ON s.student_id = g.student_id
      WHERE g.status = 'finished' AND g.answered_count > 0 AND (? IS NULL OR s.class_name = ?)`, c, c);
    const questions = await store.first('SELECT COUNT(*) AS n FROM questions WHERE active = 1');
    return { students: students.n, players: games.players, sessions: games.sessions, answers: games.answers, questions: questions.n };
  }

  async function students(className) {
    const c = cls(className);
    const rows = await store.all(`
      SELECT st.student_id, st.name, st.class_name, st.seat_no, st.active,
             b.score AS best_score, b.accuracy AS best_acc, b.max_combo AS best_combo,
             p.plays, p.answered, p.correct, p.total_ms, p.last_played
      FROM students st
      LEFT JOIN best_scores b ON b.student_id = st.student_id
      LEFT JOIN (
        SELECT student_id, COUNT(*) AS plays, SUM(answered_count) AS answered, SUM(correct_count) AS correct,
               SUM(total_ms) AS total_ms, MAX(finished_at) AS last_played
        FROM game_sessions WHERE status = 'finished' AND answered_count > 0 GROUP BY student_id
      ) p ON p.student_id = st.student_id
      WHERE (? IS NULL OR st.class_name = ?)`, c, c);
    return rows
      .map((r) => ({
        studentId: r.student_id, name: r.name, className: r.class_name, seatNo: r.seat_no, active: !!r.active,
        bestScore: r.best_score || 0, plays: r.plays || 0, answered: r.answered || 0, correct: r.correct || 0,
        accuracy: r.answered ? r.correct / r.answered : null,
        avgSeconds: r.answered ? r.total_ms / r.answered / 1000 : null,
        bestCombo: r.best_combo || 0, lastPlayed: r.last_played || null,
        bestGrade: r.best_score != null && r.plays ? gradeFor(r.best_score, r.best_acc, config.grades).label : null,
      }))
      .sort((a, b) => natural(a.className, b.className) || natural(a.seatNo ?? '', b.seatNo ?? '') || natural(a.studentId, b.studentId));
  }

  async function studentSessions(studentId) {
    const rows = await store.all(`SELECT token, finished_at, score, answered_count, correct_count, max_combo, is_new_record, total_ms
      FROM game_sessions WHERE student_id = ? AND status = 'finished' AND answered_count > 0 ORDER BY finished_at DESC`, String(studentId));
    return rows.map((r) => ({
      id: r.token, finishedAt: r.finished_at, score: r.score, answered: r.answered_count, correct: r.correct_count,
      accuracy: r.answered_count ? r.correct_count / r.answered_count : null,
      maxCombo: r.max_combo, isNewRecord: !!r.is_new_record, avgSeconds: r.answered_count ? r.total_ms / r.answered_count / 1000 : null,
    }));
  }

  async function questions(className) {
    const c = cls(className);
    const rows = await store.all(`
      SELECT q.id, q.code, q.text, q.answer, q.difficulty, q.category, q.active,
             COALESCE(x.attempts, 0) AS attempts, COALESCE(x.correct, 0) AS correct, x.total_ms
      FROM questions q
      LEFT JOIN (
        SELECT question_id, SUM(attempts) AS attempts, SUM(correct) AS correct, SUM(total_ms) AS total_ms
        FROM question_stats WHERE (? IS NULL OR class_name = ?) GROUP BY question_id
      ) x ON x.question_id = q.id
      ORDER BY q.code`, c, c);
    return rows.map((r) => ({
      id: r.id, code: r.code, text: r.text, answer: r.answer, difficulty: r.difficulty, category: r.category,
      active: !!r.active, attempts: r.attempts, correct: r.correct,
      accuracy: r.attempts ? r.correct / r.attempts : null,
      avgSeconds: r.attempts ? r.total_ms / r.attempts / 1000 : null,
    }));
  }

  // 作答明細：分頁回傳原始紀錄，由後台網頁組成 CSV（避免伺服器一次處理太多資料）
  async function answerPage(className, cursor = 0, limit = 150) {
    const c = cls(className);
    const rows = await store.all(`SELECT g.id, g.token, g.student_id, s.name, s.class_name, g.finished_at, g.log
      FROM game_sessions g JOIN students s ON s.student_id = g.student_id
      WHERE g.status = 'finished' AND g.answered_count > 0 AND g.id > ? AND (? IS NULL OR s.class_name = ?)
      ORDER BY g.id LIMIT ?`, Number(cursor) || 0, c, c, limit);
    return {
      next: rows.length === limit ? rows[rows.length - 1].id : null,
      // log 直接以字串回傳，網頁端再解析，伺服器不用逐筆處理
      sessions: rows.map((r) => ({ id: r.token, studentId: r.student_id, name: r.name, className: r.class_name, finishedAt: time(r.finished_at), log: r.log })),
    };
  }

  const pct = (x) => (x == null ? '' : Math.round(x * 1000) / 10);
  const sec = (x) => (x == null ? '' : Math.round(x * 100) / 100);
  const yn = (v) => (v ? '是' : '否');

  // 回傳 { filename, body } 或 null
  async function exportCsv(kind, className) {
    const c = cls(className);
    const tag = c ? `_${c}` : '';
    const date = time(Date.now()).slice(0, 10);
    switch (kind) {
      case 'students':
        return {
          filename: `學生成績總表${tag}_${date}.csv`,
          body: toCsv(['學號', '姓名', '班級', '座號', '最高分', '最佳等第', '遊玩次數', '總作答題數', '總答對題數', '總正確率(%)', '平均作答秒數', '最佳局最高連對', '最近遊玩時間'],
            (await students(c)).map((s) => [s.studentId, s.name, s.className, s.seatNo, s.bestScore, s.bestGrade ?? '', s.plays, s.answered, s.correct, pct(s.accuracy), sec(s.avgSeconds), s.bestCombo, time(s.lastPlayed)])),
        };
      case 'sessions': {
        const rows = await store.all(`SELECT g.token, g.student_id, s.name, s.class_name, g.finished_at, g.score, g.answered_count, g.correct_count, g.max_combo, g.is_new_record
          FROM game_sessions g JOIN students s ON s.student_id = g.student_id
          WHERE g.status = 'finished' AND g.answered_count > 0 AND (? IS NULL OR s.class_name = ?) ORDER BY g.finished_at`, c, c);
        return {
          filename: `每局成績${tag}_${date}.csv`,
          body: toCsv(['場次ID', '學號', '姓名', '班級', '結束時間', '分數', '等第', '作答題數', '答對題數', '正確率(%)', '最高連對', '刷新個人紀錄'],
            rows.map((g) => {
              const acc = g.answered_count ? Math.round((g.correct_count / g.answered_count) * 100) : 0;
              return [g.token, g.student_id, g.name, g.class_name, time(g.finished_at), g.score, gradeFor(g.score, acc, config.grades).label,
                g.answered_count, g.correct_count, pct(g.correct_count / g.answered_count), g.max_combo, yn(g.is_new_record)];
            })),
        };
      }
      case 'question-stats':
        return {
          filename: `題目作答統計${tag}_${date}.csv`,
          body: toCsv(['題號', '題目', '答案', '難度', '類別', '啟用', '作答次數', '答對次數', '答對率(%)', '平均作答秒數'],
            (await questions(c)).map((q) => [q.code, q.text, q.answer, q.difficulty, q.category, yn(q.active), q.attempts, q.correct, pct(q.accuracy), sec(q.avgSeconds)])),
        };
      case 'questions':
        return {
          filename: `題庫_${date}.csv`,
          body: toCsv(['題號', '題目', '答案', '難度', '類別', '解析'],
            (await store.all('SELECT code, text, answer, difficulty, category, explanation FROM questions WHERE active = 1 ORDER BY code'))
              .map((q) => [q.code, q.text, q.answer, q.difficulty, q.category, q.explanation])),
        };
      case 'students-list':
        return {
          filename: `學生名單_${date}.csv`,
          body: toCsv(['學號', '姓名', '班級', '座號'],
            (await store.all('SELECT student_id, name, class_name, seat_no FROM students WHERE active = 1')).sort((a, b) => natural(a.class_name, b.class_name) || natural(a.seat_no ?? '', b.seat_no ?? ''))
              .map((s) => [s.student_id, s.name, s.class_name, s.seat_no])),
        };
      default:
        return null;
    }
  }

  // 清除成績（新學期或新一輪比賽）：名單與題庫保留
  async function resetScores() {
    const n = await store.first('SELECT COUNT(*) AS n FROM game_sessions');
    await store.batch([['DELETE FROM game_sessions', []], ['DELETE FROM best_scores', []], ['DELETE FROM question_stats', []]]);
    return { deletedSessions: n.n };
  }

  return { classes, overview, students, studentSessions, questions, answerPage, exportCsv, resetScores, time };
}

module.exports = { createAdmin };
