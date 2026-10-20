'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSequence, nextLayout } = require('../lib/sequence');

function bank(n = 200) {
  const qs = [];
  for (let i = 1; i <= n; i++) qs.push({ id: i, difficulty: (i % 10) < 4 ? 1 : (i % 10) < 8 ? 2 : 3, answer: i % 2 ? '權利' : '權力' });
  return qs;
}

test('不重複，且涵蓋整個題庫', () => {
  const qs = bank();
  const seq = buildSequence(qs, {});
  assert.equal(seq.length, 200);
  assert.equal(new Set(seq).size, 200);
});

test('前 40 題的難度比例接近 4:4:2，答案接近各半，不連續 4 題同答案', () => {
  const qs = bank();
  const byId = new Map(qs.map((q) => [q.id, q]));
  for (let trial = 0; trial < 50; trial++) {
    const seq = buildSequence(qs, {}).slice(0, 40).map((id) => byId.get(id));
    const d = { 1: 0, 2: 0, 3: 0 };
    let r = 0;
    let run = 1;
    let maxRun = 1;
    seq.forEach((q, i) => {
      d[q.difficulty]++;
      if (q.answer === '權利') r++;
      if (i) { run = q.answer === seq[i - 1].answer ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
    });
    assert.deepEqual(d, { 1: 16, 2: 16, 3: 8 });
    assert.equal(r, 20);
    assert.ok(maxRun <= 3, `連續同答案 ${maxRun}`);
  }
});

test('題庫難度不足時仍能出題（不當機）', () => {
  const qs = bank(30).map((q) => ({ ...q, difficulty: 1 }));
  const seq = buildSequence(qs, { length: 30 });
  assert.equal(new Set(seq).size, 30);
});

test('按鈕排列不會同一邊連續超過 3 次', () => {
  let prev = null;
  let run = 0;
  let maxRun = 0;
  let cur = 0;
  let last = null;
  for (let i = 0; i < 2000; i++) {
    const r = nextLayout(prev, run, 3, () => 0.1);
    prev = r.layout;
    run = r.run;
    cur = r.layout === last ? cur + 1 : 1;
    last = r.layout;
    maxRun = Math.max(maxRun, cur);
  }
  assert.ok(maxRun <= 3);
});
