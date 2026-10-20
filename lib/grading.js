'use strict';
// 成績單等第：分數與正確率都要達到門檻（設定在 config.js 的 grades）

/**
 * @param {number} score
 * @param {number} accuracy 0–100
 * @param {Array} grades 由高到低
 * @returns {{ label, comment, next: null | { label, needScore, needAccuracy } }}
 */
function gradeFor(score, accuracy, grades) {
  const idx = grades.findIndex((g) => score >= g.minScore && accuracy >= g.minAccuracy);
  const i = idx === -1 ? grades.length - 1 : idx;
  const g = grades[i];
  let next = null;
  if (i > 0) {
    const up = grades[i - 1];
    next = {
      label: up.label,
      needScore: score >= up.minScore ? null : up.minScore,
      needAccuracy: accuracy >= up.minAccuracy ? null : up.minAccuracy,
    };
  }
  return { label: g.label, comment: g.comment || '', next };
}

module.exports = { gradeFor };
