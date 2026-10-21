'use strict';
// 簡單的固定視窗限流（記憶體內，盡力而為；Cloudflare 上每台機器各自計算）
function createLimiter(windowMs, max, clock = Date.now) {
  const hits = new Map();
  const sweep = () => {
    const t = clock();
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
  };
  return {
    // 回傳 true 代表「已超過上限」
    hit(key) {
      sweep();
      const t = clock();
      const rec = hits.get(key);
      if (!rec || t - rec.start >= windowMs) {
        hits.set(key, { start: t, n: 1 });
        return false;
      }
      rec.n++;
      return rec.n > max;
    },
    blocked(key) {
      const rec = hits.get(key);
      return !!rec && clock() - rec.start < windowMs && rec.n >= max;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createLimiter };
