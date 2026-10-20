'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const { comboBonus, speedBonus, applyAnswer } = require('../lib/scoring');

const { scoring, cooldown } = config;

test('速度獎勵：max(0, 50 − 10 × 秒數)', () => {
  assert.equal(speedBonus(0, scoring.speedBonus), 50);
  assert.equal(speedBonus(1000, scoring.speedBonus), 40);
  assert.equal(speedBonus(2500, scoring.speedBonus), 25);
  assert.equal(speedBonus(5000, scoring.speedBonus), 0);
  assert.equal(speedBonus(9000, scoring.speedBonus), 0);
});

test('Combo：3→10、5→20、10→50，之後每 5 題 +30', () => {
  const got = {};
  for (let i = 1; i <= 30; i++) got[i] = comboBonus(i, scoring.combo);
  assert.equal(got[1] + got[2] + got[4], 0);
  assert.equal(got[3], 10);
  assert.equal(got[5], 20);
  assert.equal(got[10], 50);
  assert.equal(got[15], 30);
  assert.equal(got[20], 30);
  assert.equal(got[25], 30);
  assert.equal(got[11] + got[12] + got[13] + got[14], 0);
});

test('答對、答錯、冷卻與歸零', () => {
  let s = { score: 0, combo: 0, maxCombo: 0, wrongStreak: 0 };
  let r = applyAnswer(s, { correct: true, responseMs: 1000 }, scoring, cooldown);
  assert.equal(r.delta, 140);
  s = r.state;
  r = applyAnswer(s, { correct: false, responseMs: 1000 }, scoring, cooldown);
  assert.equal(r.state.score, 90);
  assert.equal(r.state.combo, 0);
  assert.equal(r.cooldownMs, 0);
  r = applyAnswer(r.state, { correct: false, responseMs: 1000 }, scoring, cooldown);
  assert.equal(r.state.score, 40);
  assert.equal(r.cooldownMs, 2000, '連錯 2 題觸發冷卻');
  r = applyAnswer(r.state, { correct: false, responseMs: 1000 }, scoring, cooldown);
  assert.equal(r.state.score, 0, '分數不會低於 0');
  assert.equal(r.cooldownMs, 2000, '第 3 次連錯仍然冷卻');
  r = applyAnswer(r.state, { correct: true, responseMs: 6000 }, scoring, cooldown);
  assert.equal(r.state.wrongStreak, 0, '答對後連錯歸零');
  assert.equal(r.delta, 100);
});

test('連對 10 題的總分', () => {
  let s = { score: 0, combo: 0, maxCombo: 0, wrongStreak: 0 };
  for (let i = 0; i < 10; i++) s = applyAnswer(s, { correct: true, responseMs: 5000 }, scoring, cooldown).state;
  assert.equal(s.score, 1000 + 10 + 20 + 50);
  assert.equal(s.maxCombo, 10);
});
