'use strict';
// 讀取 config.js 並檢查數值是否合理，避免設定打錯字造成遊戲異常。
const raw = require('../config');

function fail(msg) {
  throw new Error(`config.js 設定錯誤：${msg}`);
}
function num(value, name, { min = 0, nullable = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    fail(`${name} 必須是 ≥ ${min} 的數字（目前是 ${JSON.stringify(value)}）`);
  }
}
function deepFreeze(o) {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
  return Object.freeze(o);
}

function validate(c) {
  num(c.game?.durationSeconds, 'game.durationSeconds', { min: 10 });
  num(c.game?.startCountdownSeconds, 'game.startCountdownSeconds');
  num(c.game?.graceMs, 'game.graceMs');
  num(c.scoring?.correctBase, 'scoring.correctBase');
  num(c.scoring?.speedBonus?.max, 'scoring.speedBonus.max');
  num(c.scoring?.speedBonus?.lossPerSecond, 'scoring.speedBonus.lossPerSecond');
  num(c.scoring?.wrongPenalty, 'scoring.wrongPenalty');
  num(c.scoring?.minScore, 'scoring.minScore', { min: -1e9, nullable: true });
  const ms = c.scoring?.combo?.milestones;
  if (!ms || typeof ms !== 'object') fail('scoring.combo.milestones 必須是物件，例如 { 3: 10 }');
  for (const [k, v] of Object.entries(ms)) {
    if (!Number.isInteger(Number(k)) || Number(k) < 1) fail(`combo.milestones 的題數 "${k}" 必須是正整數`);
    num(v, `combo.milestones[${k}]`);
  }
  const r = c.scoring.combo.repeat;
  if (r) {
    num(r.after, 'combo.repeat.after');
    num(r.every, 'combo.repeat.every', { min: 1 });
    num(r.bonus, 'combo.repeat.bonus');
  }
  num(c.cooldown?.triggerAtConsecutiveWrong, 'cooldown.triggerAtConsecutiveWrong');
  num(c.cooldown?.seconds, 'cooldown.seconds');
  const mix = c.selection?.difficultyMix;
  if (!mix || !Object.values(mix).some((n) => n > 0)) fail('selection.difficultyMix 至少要有一個難度的題數大於 0');
  for (const [k, v] of Object.entries(mix)) {
    if (![1, 2, 3].includes(Number(k))) fail(`difficultyMix 的難度 "${k}" 只能是 1、2、3`);
    num(v, `difficultyMix[${k}]`);
  }
  num(c.selection?.maxSameAnswerInRow, 'selection.maxSameAnswerInRow', { min: 1 });
  num(c.selection?.maxSameLayoutInRow, 'selection.maxSameLayoutInRow', { min: 1 });
  if (typeof c.selection.shuffleButtons !== 'boolean') fail('selection.shuffleButtons 只能是 true 或 false');
  if (!Array.isArray(c.grades) || !c.grades.length) fail('grades 至少要有一個等第');
  c.grades.forEach((g, i) => {
    if (!g || typeof g.label !== 'string' || !g.label) fail(`grades 第 ${i + 1} 個等第缺少 label`);
    num(g.minScore, `grades[${g.label}].minScore`, { min: -1e9 });
    num(g.minAccuracy, `grades[${g.label}].minAccuracy`);
    if (g.minAccuracy > 100) fail(`grades[${g.label}].minAccuracy 不能超過 100`);
    if (i > 0 && (g.minScore > c.grades[i - 1].minScore || g.minAccuracy > c.grades[i - 1].minAccuracy)) {
      fail(`grades 要由高到低排列：「${g.label}」的門檻不能高於「${c.grades[i - 1].label}」`);
    }
  });
  if (!Array.isArray(c.testAccounts) || c.testAccounts.some((x) => typeof x !== 'string' || !x.trim())) {
    fail('testAccounts 必須是學號清單，例如 [\'LJ140000\']；不需要測試帳號請寫 []');
  }
  num(c.leaderboard?.size, 'leaderboard.size', { min: 1 });
  try {
    new Intl.DateTimeFormat('zh-TW', { timeZone: c.timezone });
  } catch {
    fail(`timezone "${c.timezone}" 不是有效的時區名稱`);
  }
  num(c.limits?.loginPerMinutePerIp, 'limits.loginPerMinutePerIp', { min: 1 });
  num(c.limits?.adminLoginFailures, 'limits.adminLoginFailures', { min: 1 });
  num(c.limits?.adminLoginWindowMinutes, 'limits.adminLoginWindowMinutes', { min: 1 });
}

function loadConfig(c = raw) {
  const copy = JSON.parse(JSON.stringify(c));
  validate(copy);
  return deepFreeze(copy);
}

module.exports = loadConfig();
