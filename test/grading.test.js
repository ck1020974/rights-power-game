'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/load-config');
const { gradeFor } = require('../lib/grading');

const g = (score, acc) => gradeFor(score, acc, config.grades);

test('分數與正確率都達標才給等第', () => {
  assert.equal(g(5000, 80).label, '優');
  assert.equal(g(8000, 78).label, '甲', '分數夠但正確率不到 80% → 甲');
  assert.equal(g(6000, 50).label, '丁', '亂猜高分也只有丁');
  assert.equal(g(3500, 75).label, '甲');
  assert.equal(g(2000, 70).label, '乙');
  assert.equal(g(1000, 60).label, '丙');
  assert.equal(g(999, 100).label, '丁', '1000 分以下是丁');
});

test('提示下一個等第還差什麼', () => {
  const r = g(4000, 76);
  assert.deepEqual(r.next, { label: '優', needScore: 5000, needAccuracy: 80 });
  const r2 = g(6000, 76);
  assert.deepEqual(r2.next, { label: '優', needScore: null, needAccuracy: 80 });
  assert.equal(g(6000, 95).next, null);
});
