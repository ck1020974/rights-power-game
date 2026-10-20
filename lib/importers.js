'use strict';
// 學生名單與題庫的 CSV 匯入（先完整檢查，有任何錯誤就整批不寫入）。
const { parseCsv, toRecords } = require('./csv');
const { tx } = require('./db');

const MAX_ROWS = 5000;

const STUDENT_COLUMNS = {
  student_id: ['學號', 'studentid', 'id', '學生編號'],
  name: ['姓名', '學生姓名'],
  class_name: ['班級', 'class', 'classname', '班'],
  seat_no: ['座號', 'seat', 'seatno'],
};

const QUESTION_COLUMNS = {
  code: ['題號', '編號', 'id', '題目編號'],
  text: ['題目', 'question', '題幹'],
  answer: ['答案', '正確答案'],
  difficulty: ['難度', 'level'],
  category: ['類別', '類型', '分類'],
  explanation: ['解析', '說明', '詳解'],
};

function normalizeStudentId(v) {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function normalizeAnswer(v) {
  const s = String(v ?? '').normalize('NFKC').trim().toLowerCase();
  if (s === '權利' || s === 'right' || s === 'rights') return '權利';
  if (s === '權力' || s === 'power') return '權力';
  return null;
}

function normalizeDifficulty(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (['1', '易', '簡單', '基礎', '基本'].includes(s)) return 1;
  if (['2', '中', '中等', '普通'].includes(s)) return 2;
  if (['3', '難', '困難', '進階'].includes(s)) return 3;
  return NaN;
}

function importStudents(db, csvText, { deactivateMissing = false, now = Date.now() } = {}) {
  const parsed = parseCsv(csvText);
  const { columns, records, unknown } = toRecords(parsed, STUDENT_COLUMNS);
  const errors = [];
  const warnings = [];
  for (const need of ['student_id', 'name', 'class_name']) {
    if (!columns.includes(need)) {
      const label = { student_id: '學號', name: '姓名', class_name: '班級' }[need];
      errors.push(`找不到「${label}」欄位，請確認第一列的欄位名稱`);
    }
  }
  if (records.length > MAX_ROWS) errors.push(`一次最多匯入 ${MAX_ROWS} 筆`);
  if (unknown.length) warnings.push(`忽略不認得的欄位：${unknown.join('、')}`);
  if (errors.length) return { ok: false, errors, warnings };

  const rows = [];
  const seen = new Map();
  for (const { line, values } of records) {
    const id = normalizeStudentId(values.student_id);
    const name = (values.name || '').trim();
    const className = (values.class_name || '').trim();
    if (!id && !name && !className) continue;
    if (!id) errors.push(`第 ${line} 列：缺少學號`);
    else if (id.length > 30) errors.push(`第 ${line} 列：學號太長`);
    if (!name) errors.push(`第 ${line} 列：缺少姓名`);
    if (!className) errors.push(`第 ${line} 列：缺少班級`);
    if (id) {
      if (seen.has(id)) errors.push(`第 ${line} 列：學號 ${id} 與第 ${seen.get(id)} 列重複`);
      else seen.set(id, line);
    }
    rows.push({ id, name, className, seat: (values.seat_no || '').trim() || null });
  }
  if (!rows.length && !errors.length) errors.push('檔案裡沒有任何學生資料');
  if (errors.length) return { ok: false, errors: errors.slice(0, 100), warnings, total: rows.length };

  const exists = db.prepare('SELECT student_id FROM students');
  const existing = new Set(exists.all().map((r) => r.student_id));
  const upsert = db.prepare(`
    INSERT INTO students (student_id, name, class_name, seat_no, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET name = excluded.name, class_name = excluded.class_name,
      seat_no = excluded.seat_no, active = 1, updated_at = excluded.updated_at`);
  let inserted = 0;
  let updated = 0;
  let deactivated = 0;
  tx(db, () => {
    for (const r of rows) {
      upsert.run(r.id, r.name, r.className, r.seat, now, now);
      if (existing.has(r.id)) updated++;
      else inserted++;
    }
    if (deactivateMissing) {
      const keep = new Set(rows.map((r) => r.id));
      const off = db.prepare('UPDATE students SET active = 0, updated_at = ? WHERE student_id = ? AND active = 1');
      for (const id of existing) if (!keep.has(id)) deactivated += Number(off.run(now, id).changes);
    }
  });
  const classes = [...new Set(rows.map((r) => r.className))];
  return { ok: true, total: rows.length, inserted, updated, deactivated, classes, errors: [], warnings };
}

// 題庫分析：提醒老師「題庫是否容易被規律猜中」
const GOV_WORDS = ['政府', '總統', '行政院', '立法院', '司法院', '法院', '法官', '警察', '縣長', '市長', '部長', '機關', '公務員', '國家', '議員', '檢察官', '稅務', '監察院', '考試院', '立法委員'];
const PEOPLE_WORDS = ['人民', '國民', '公民', '民眾', '學生', '我們', '選民', '市民', '消費者', '勞工', '員工', '兒童', '同學'];

function analyzeBank(rows) {
  const warnings = [];
  const byAnswer = { 權利: 0, 權力: 0 };
  const byDifficulty = { 1: 0, 2: 0, 3: 0 };
  for (const r of rows) {
    byAnswer[r.answer]++;
    byDifficulty[r.difficulty]++;
  }
  const total = rows.length;
  if (total < 100) warnings.push(`目前只有 ${total} 題，3 分鐘內較快的學生可能會看到重複題目（建議 200 題）`);
  const minShare = Math.min(byAnswer['權利'], byAnswer['權力']) / (total || 1);
  if (total >= 10 && minShare < 0.4) {
    warnings.push(`答案比例失衡：權利 ${byAnswer['權利']} 題、權力 ${byAnswer['權力']} 題，建議各佔約一半`);
  }
  for (const d of [1, 2, 3]) {
    if (byDifficulty[d] < 10 && total >= 30) warnings.push(`難度 ${d} 只有 ${byDifficulty[d]} 題，出題時難度比例可能無法維持`);
  }
  const has = (text, words) => words.some((w) => text.includes(w));
  let govOnly = 0;
  let govPower = 0;
  let peopleOnly = 0;
  let peopleRight = 0;
  for (const r of rows) {
    const g = has(r.text, GOV_WORDS);
    const p = has(r.text, PEOPLE_WORDS);
    if (g && !p) {
      govOnly++;
      if (r.answer === '權力') govPower++;
    } else if (p && !g) {
      peopleOnly++;
      if (r.answer === '權利') peopleRight++;
    }
  }
  if (govOnly >= 10 && govPower / govOnly > 0.85) {
    warnings.push(`提到「政府／機關／警察」等字樣的題目有 ${govOnly} 題，其中 ${Math.round((govPower / govOnly) * 100)}% 答案是權力，學生可能靠關鍵字猜答案，建議多放一些反例`);
  }
  if (peopleOnly >= 10 && peopleRight / peopleOnly > 0.85) {
    warnings.push(`提到「人民／學生／民眾」等字樣的題目有 ${peopleOnly} 題，其中 ${Math.round((peopleRight / peopleOnly) * 100)}% 答案是權利，學生可能靠關鍵字猜答案，建議多放一些反例`);
  }
  const yifa = rows.filter((r) => r.text.includes('依法'));
  if (yifa.length >= 10) {
    const p = yifa.filter((r) => r.answer === '權力').length / yifa.length;
    if (p > 0.8 || p < 0.2) {
      warnings.push(`有「依法」的 ${yifa.length} 題中，${Math.round(Math.max(p, 1 - p) * 100)}% 答案是${p > 0.5 ? '權力' : '權利'}，學生可能看到「依法」就猜答案，建議兩種答案都使用「依法」`);
    }
  }
  return { warnings, byAnswer, byDifficulty, total };
}

function importQuestions(db, csvText, { deactivateMissing = true, now = Date.now() } = {}) {
  const parsed = parseCsv(csvText);
  const { columns, records, unknown } = toRecords(parsed, QUESTION_COLUMNS);
  const errors = [];
  const warnings = [];
  if (!columns.includes('text')) errors.push('找不到「題目」欄位，請確認第一列的欄位名稱');
  if (!columns.includes('answer')) errors.push('找不到「答案」欄位，請確認第一列的欄位名稱');
  if (records.length > MAX_ROWS) errors.push(`一次最多匯入 ${MAX_ROWS} 筆`);
  if (unknown.length) warnings.push(`忽略不認得的欄位：${unknown.join('、')}`);
  const autoCode = !columns.includes('code');
  if (autoCode) warnings.push('檔案沒有「題號」欄位，系統依列的順序自動編號；之後若調整順序，統計會對應到不同的題目。建議加上題號欄位');
  if (!columns.includes('difficulty')) warnings.push('檔案沒有「難度」欄位，全部視為難度 2');
  if (errors.length) return { ok: false, errors, warnings };

  const rows = [];
  const codes = new Map();
  const texts = new Map();
  let n = 0;
  for (const { line, values } of records) {
    if (!values.text && !values.answer && !values.code) continue;
    n++;
    const code = autoCode ? `Q${String(n).padStart(3, '0')}` : (values.code || '').trim();
    const text = (values.text || '').trim();
    const answer = normalizeAnswer(values.answer);
    let difficulty = normalizeDifficulty(values.difficulty);
    if (!code) errors.push(`第 ${line} 列：缺少題號`);
    if (!text) errors.push(`第 ${line} 列：缺少題目`);
    else if (text.length > 200) errors.push(`第 ${line} 列：題目超過 200 字`);
    if (!answer) errors.push(`第 ${line} 列：答案必須是「權利」或「權力」（目前是「${values.answer || ''}」）`);
    if (Number.isNaN(difficulty)) {
      errors.push(`第 ${line} 列：難度只能填 1、2、3（目前是「${values.difficulty}」）`);
      difficulty = 2;
    }
    if (difficulty === null) difficulty = 2;
    if (code) {
      if (codes.has(code)) errors.push(`第 ${line} 列：題號 ${code} 與第 ${codes.get(code)} 列重複`);
      else codes.set(code, line);
    }
    if (text) {
      if (texts.has(text)) warnings.push(`第 ${line} 列與第 ${texts.get(text)} 列的題目文字完全相同`);
      else texts.set(text, line);
    }
    rows.push({ code, text, answer, difficulty, category: (values.category || '').trim() || null, explanation: (values.explanation || '').trim() || null });
  }
  if (!rows.length && !errors.length) errors.push('檔案裡沒有任何題目');
  if (errors.length) return { ok: false, errors: errors.slice(0, 100), warnings, total: rows.length };

  const existing = new Map(db.prepare('SELECT code, text, answer FROM questions').all().map((r) => [r.code, r]));
  const upsert = db.prepare(`
    INSERT INTO questions (code, text, answer, difficulty, category, explanation, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(code) DO UPDATE SET text = excluded.text, answer = excluded.answer, difficulty = excluded.difficulty,
      category = excluded.category, explanation = excluded.explanation, active = 1, updated_at = excluded.updated_at`);
  let inserted = 0;
  let updated = 0;
  let deactivated = 0;
  const changed = [];
  tx(db, () => {
    for (const r of rows) {
      const old = existing.get(r.code);
      if (old) {
        updated++;
        if (old.text !== r.text || old.answer !== r.answer) changed.push(r.code);
      } else inserted++;
      upsert.run(r.code, r.text, r.answer, r.difficulty, r.category, r.explanation, now, now);
    }
    if (deactivateMissing) {
      const keep = new Set(rows.map((r) => r.code));
      const off = db.prepare('UPDATE questions SET active = 0, updated_at = ? WHERE code = ? AND active = 1');
      for (const code of existing.keys()) if (!keep.has(code)) deactivated += Number(off.run(now, code).changes);
    }
  });
  if (changed.length) {
    warnings.push(`有 ${changed.length} 題的題目文字或答案被修改（${changed.slice(0, 5).join('、')}${changed.length > 5 ? '…' : ''}），這些題目的歷史作答統計會與新版內容混在一起`);
  }
  const analysis = analyzeBank(rows);
  warnings.push(...analysis.warnings);
  return { ok: true, total: rows.length, inserted, updated, deactivated, byAnswer: analysis.byAnswer, byDifficulty: analysis.byDifficulty, errors: [], warnings };
}

module.exports = { importStudents, importQuestions, normalizeStudentId, analyzeBank };
