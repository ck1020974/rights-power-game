'use strict';
// 出題順序：每局先產生一份「不重複、難度比例固定、權利/權力各半」的題目順序。
const ANSWERS = ['權利', '權力'];

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeQueues(questions, rnd) {
  const q = {};
  for (const d of [1, 2, 3]) q[d] = { 權利: [], 權力: [] };
  for (const item of shuffle(questions, rnd)) {
    if (q[item.difficulty] && q[item.difficulty][item.answer]) q[item.difficulty][item.answer].push(item);
  }
  return q;
}

// 產生一「輪」的格子：[{d, a}]，難度依 mix，答案盡量各半且不連續太多
// tail = { answer, run }：上一輪結尾的答案與連續次數，避免跨輪時連續太多同答案
function makeRound(mix, balance, maxRun, rnd, tail = null) {
  const diffs = [];
  for (const d of [1, 2, 3]) for (let i = 0; i < (mix[d] || 0); i++) diffs.push(d);
  const offset = rnd() < 0.5 ? 0 : 1;
  let slots = diffs.map((d, i) => ({ d, a: balance ? ANSWERS[(i + offset) % 2] : ANSWERS[rnd() < 0.5 ? 0 : 1] }));
  for (let tries = 0; tries < 60; tries++) {
    slots = shuffle(slots, rnd);
    let run = tail && slots.length && slots[0].a === tail.answer ? tail.run + 1 : 1;
    let ok = run <= maxRun;
    for (let i = 1; ok && i < slots.length; i++) {
      run = slots[i].a === slots[i - 1].a ? run + 1 : 1;
      if (run > maxRun) {
        ok = false;
        break;
      }
    }
    if (ok) break;
  }
  return slots;
}

function take(queues, d, a, avoidId) {
  const pop = (list) => {
    if (!list.length) return null;
    let idx = 0;
    if (avoidId != null && list[0].id === avoidId && list.length > 1) idx = 1;
    return list.splice(idx, 1)[0];
  };
  const other = a === '權利' ? '權力' : '權利';
  const order = [1, 2, 3].sort((x, y) => Math.abs(x - d) - Math.abs(y - d));
  for (const dd of order) {
    const hit = pop(queues[dd][a]);
    if (hit) return hit;
    if (dd === d) {
      const alt = pop(queues[dd][other]);
      if (alt) return alt;
    }
  }
  for (const dd of order) {
    const alt = pop(queues[dd][other]);
    if (alt) return alt;
  }
  return null;
}

/**
 * @param questions [{id, difficulty, answer}]
 * @param opts { mix, balanceAnswers, maxSameAnswerInRow, length, avoidFirstId, rnd }
 * @returns number[]  題目 id 順序
 */
function buildSequence(questions, opts = {}) {
  const { mix = { 1: 4, 2: 4, 3: 2 }, balanceAnswers = true, maxSameAnswerInRow = 3, rnd = Math.random, avoidFirstId = null } = opts;
  if (!questions.length) return [];
  const length = opts.length || questions.length;
  let queues = makeQueues(questions, rnd);
  const answerOf = new Map(questions.map((q) => [q.id, q.answer]));
  const seq = [];
  while (seq.length < length) {
    let tail = null;
    for (let i = seq.length - 1; i >= 0; i--) {
      const a = answerOf.get(seq[i]);
      if (!tail) tail = { answer: a, run: 1 };
      else if (a === tail.answer) tail.run++;
      else break;
    }
    const round = makeRound(mix, balanceAnswers, maxSameAnswerInRow, rnd, tail);
    if (!round.length) break;
    for (const slot of round) {
      if (seq.length >= length) break;
      const last = seq.length ? seq[seq.length - 1] : avoidFirstId;
      let item = take(queues, slot.d, slot.a, last);
      if (!item) {
        queues = makeQueues(questions, rnd); // 全部出完，重新洗牌繼續
        item = take(queues, slot.d, slot.a, last);
      }
      if (!item) return seq;
      seq.push(item.id);
    }
  }
  return seq;
}

// 決定下一題的按鈕左右位置：隨機，但同一種排列不會連續超過 maxRun 次
function nextLayout(prev, run, maxRun, rnd = Math.random) {
  let layout = rnd() < 0.5 ? 'rl' : 'lr';
  if (prev && layout === prev && run >= maxRun) layout = prev === 'rl' ? 'lr' : 'rl';
  return { layout, run: layout === prev ? run + 1 : 1 };
}

function choicesFor(layout) {
  return layout === 'rl' ? ['權利', '權力'] : ['權力', '權利'];
}

module.exports = { buildSequence, nextLayout, choicesFor, shuffle };
