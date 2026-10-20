'use strict';
/**
 * ============================================================
 *  遊戲設定檔：所有可調整的數值都集中在這裡
 *  修改後存檔，重新啟動伺服器（npm start）即可生效。
 *  已經在進行中的對局，會沿用開始當下的設定，不受影響。
 * ============================================================
 */
module.exports = {
  // ── 時間 ─────────────────────────────────────────
  game: {
    durationSeconds: 180, // 遊戲時間（秒）：3 分鐘
    startCountdownSeconds: 3, // 按下「開始」後的 3-2-1 倒數（不計入遊戲時間）
    graceMs: 1000, // 時間到之後，仍接受「網路延遲中」的最後一個答案（毫秒）
  },

  // ── 計分 ─────────────────────────────────────────
  scoring: {
    correctBase: 100, // 答對基本分
    // 速度獎勵 = max(0, max - lossPerSecond × 作答秒數)，四捨五入成整數
    speedBonus: { max: 50, lossPerSecond: 10 }, // 5 秒後不再加分
    wrongPenalty: 50, // 答錯扣分
    minScore: 0, // 總分下限（避免出現負分）；設成 null 代表允許負分

    // 連續答對（Combo）獎勵：連對到「該題數」的那一題，額外加分
    combo: {
      milestones: { 3: 10, 5: 20, 10: 50 }, // 連對 3 題 +10、5 題 +20、10 題 +50
      repeat: { after: 10, every: 5, bonus: 30 }, // 10 題之後，每再連對 5 題（15、20、25…）+30
    },
  },

  // ── 冷卻（連續答錯的暫停）────────────────────────
  cooldown: {
    triggerAtConsecutiveWrong: 2, // 連續答錯幾題後暫停（答對會歸零）；設 0 代表關閉
    seconds: 2, // 暫停秒數（遊戲倒數照常進行）
  },

  // ── 出題方式 ─────────────────────────────────────
  selection: {
    // 難度比例：每「一輪」出題的各難度題數（1=基本辨識、2=生活情境、3=概念判斷）
    // 4:4:2 表示每 10 題裡約有 4 題簡單、4 題中等、2 題較難
    difficultyMix: { 1: 4, 2: 4, 3: 2 },
    balanceAnswers: true, // 每一輪盡量讓「權利／權力」各佔一半
    maxSameAnswerInRow: 3, // 同一個正確答案最多連續出現幾題
    // 答案按鈕位置：false = 固定（左「權利」、右「權力」）；true = 每題隨機左右交換
    shuffleButtons: false,
    maxSameLayoutInRow: 3, // （隨機時）同一種左右位置最多連續幾題
  },

  // ── 成績單等第 ───────────────────────────────────
  // 由高到低判斷：「分數」與「正確率」兩個條件都達到，才給該等第。
  // 加上正確率門檻，是為了避免學生靠「亂按、快速猜」拿到高等第。
  grades: [
    { label: '優', minScore: 5000, minAccuracy: 80, comment: '觀念清楚、判斷迅速，表現非常優秀！' },
    { label: '甲', minScore: 3500, minAccuracy: 75, comment: '大多能正確分辨，表現很好！再穩一點就能更上一層樓。' },
    { label: '乙', minScore: 2000, minAccuracy: 70, comment: '基本概念已具備，建議看看訂正錯題再挑戰。' },
    { label: '丙', minScore: 1000, minAccuracy: 60, comment: '部分題目容易混淆，先想清楚「是誰在做、做的是什麼」。' },
    { label: '丁', minScore: 0, minAccuracy: 0, comment: '先複習權利與權力的差別，看完訂正錯題再試一次吧！' },
  ],
  reportCardTitle: '公民科 學習成績單',

  // ── 其他 ─────────────────────────────────────────
  leaderboard: { size: 10 }, // 排行榜顯示名次數
  timezone: 'Asia/Taipei', // 匯出資料的時間顯示時區

  // 防濫用（以來源 IP 計算；全校共用同一個對外 IP 時請放寬）
  limits: {
    loginPerMinutePerIp: 120, // 每分鐘最多嘗試輸入學號的次數
    adminLoginFailures: 10, // 教師後台：連續輸入錯誤密碼幾次後暫時鎖定
    adminLoginWindowMinutes: 15, // 上述鎖定的計算視窗（分鐘）
  },
};
