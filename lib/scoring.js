'use strict';
// 計分邏輯：純函式，所有數值都來自 config.js（或該局開始時保存的設定快照）。

// 連對到第 streak 題時的 Combo 額外加分（沒有獎勵則為 0）
function comboBonus(streak, combo) {
  if (!streak || streak < 1) return 0;
  const ms = combo.milestones || {};
  if (Object.prototype.hasOwnProperty.call(ms, String(streak))) return Number(ms[String(streak)]);
  const r = combo.repeat;
  if (r && r.every > 0 && streak > r.after && (streak - r.after) % r.every === 0) return Number(r.bonus);
  return 0;
}

// 速度獎勵 = max(0, max - lossPerSecond × 秒數)
function speedBonus(responseMs, sb) {
  const sec = Math.max(0, responseMs) / 1000;
  return Math.round(Math.max(0, sb.max - sb.lossPerSecond * sec));
}

/**
 * 套用一次作答。
 * state: { score, combo, maxCombo, wrongStreak }
 * 回傳: { state, parts:{base,speed,combo,penalty}, delta, cooldownMs }
 */
function applyAnswer(state, { correct, responseMs }, scoring, cooldown) {
  const next = { ...state };
  const parts = { base: 0, speed: 0, combo: 0, penalty: 0 };
  let cooldownMs = 0;

  if (correct) {
    next.combo = state.combo + 1;
    next.maxCombo = Math.max(state.maxCombo, next.combo);
    next.wrongStreak = 0;
    parts.base = scoring.correctBase;
    parts.speed = speedBonus(responseMs, scoring.speedBonus);
    parts.combo = comboBonus(next.combo, scoring.combo);
  } else {
    next.combo = 0;
    next.wrongStreak = state.wrongStreak + 1;
    parts.penalty = scoring.wrongPenalty;
    if (cooldown.triggerAtConsecutiveWrong > 0 && cooldown.seconds > 0 && next.wrongStreak >= cooldown.triggerAtConsecutiveWrong) {
      cooldownMs = Math.round(cooldown.seconds * 1000);
    }
  }

  const raw = state.score + parts.base + parts.speed + parts.combo - parts.penalty;
  next.score = scoring.minScore == null ? raw : Math.max(scoring.minScore, raw);
  return { state: next, parts, delta: next.score - state.score, cooldownMs };
}

module.exports = { comboBonus, speedBonus, applyAnswer };
