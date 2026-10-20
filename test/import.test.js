'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { importStudents, importQuestions } = require('../lib/importers');
const { parseCsv, csvCell } = require('../lib/csv');

test('CSV：引號、逗號、換行、BOM、Tab', () => {
  const p = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nok"\r\n');
  assert.deepEqual(p.rows, [['a', 'b'], ['x, y', 'say "hi"\nok']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
});

test('範例名單與題庫可以匯入', () => {
  const db = openDatabase(':memory:');
  const root = path.join(__dirname, '..', 'samples');
  const s = importStudents(db, fs.readFileSync(path.join(root, 'students.sample.csv'), 'utf8'));
  assert.ok(s.ok, s.errors.join());
  assert.equal(s.inserted, 12);
  const q = importQuestions(db, fs.readFileSync(path.join(root, 'questions.csv'), 'utf8'));
  assert.ok(q.ok, q.errors.join());
  assert.equal(q.total, 200);
});

test('學號保留開頭的 0，重複學號整批拒絕', () => {
  const db = openDatabase(':memory:');
  const r = importStudents(db, '學號,姓名,班級\n00123,甲,701\n00123,乙,701\n');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /重複/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 0);
  const ok = importStudents(db, '學號,姓名,班級\n00123,甲,701\n');
  assert.ok(ok.ok);
  assert.equal(db.prepare('SELECT student_id FROM students').get().student_id, '00123');
});

test('題庫：答案寫錯會被擋下；重新匯入以題號更新並停用缺少的題目', () => {
  const db = openDatabase(':memory:');
  const bad = importQuestions(db, '題號,題目,答案,難度\nA1,某題,權里,1\n');
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /權利.*權力/);
  const v1 = importQuestions(db, '題號,題目,答案,難度\nA1,第一題,權利,1\nA2,第二題,權力,2\n');
  assert.ok(v1.ok);
  const v2 = importQuestions(db, '題號,題目,答案,難度\nA1,第一題（修正）,權利,1\n');
  assert.ok(v2.ok);
  assert.equal(v2.updated, 1);
  assert.equal(v2.deactivated, 1);
  const a2 = db.prepare("SELECT active FROM questions WHERE code='A2'").get();
  assert.equal(a2.active, 0);
});

test('題庫分析會提醒「政府＝權力」的規律', () => {
  const db = openDatabase(':memory:');
  let csv = '題號,題目,答案,難度\n';
  for (let i = 0; i < 20; i++) csv += `G${i},政府做了某件事${i},權力,1\n`;
  for (let i = 0; i < 20; i++) csv += `P${i},人民做了某件事${i},權利,1\n`;
  const r = importQuestions(db, csv);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.includes('政府')));
  assert.ok(r.warnings.some((w) => w.includes('人民')));
});

test('題庫分析會提醒「依法」集中在同一種答案', () => {
  const db = openDatabase(':memory:');
  let csv = '題號,題目,答案,難度\n';
  for (let i = 0; i < 12; i++) csv += `Y${i},某機關依法做了事${i},權力,1\n`;
  for (let i = 0; i < 12; i++) csv += `N${i},某人做了事${i},權利,1\n`;
  const r = importQuestions(db, csv);
  assert.ok(r.warnings.some((w) => w.includes('依法')));
});
