-- ============================================================
--  資料庫結構（SQLite／Cloudflare D1 共用）。啟動時自動建立，可重複執行。
--  為了符合 Cloudflare 免費額度（每天 10 萬列寫入），設計重點是「每答一題只寫 1 列」：
--    · 每題作答紀錄存在 game_sessions.log（JSON 陣列），不另外開一列
--    · 排行榜讀 best_scores、題目統計讀 question_stats，都是小表，讀取量很低
-- ============================================================

-- 學生名單（由 CSV 匯入）
CREATE TABLE IF NOT EXISTS students (
  student_id  TEXT PRIMARY KEY,           -- 學號（文字，保留開頭的 0）
  name        TEXT NOT NULL,
  class_name  TEXT NOT NULL,
  seat_no     TEXT,
  active      INTEGER NOT NULL DEFAULT 1, -- 0 = 停用（不能登入、不列入排行榜）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- 題庫（由 CSV 匯入；以「題號 code」識別同一題）
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,
  answer      TEXT NOT NULL CHECK (answer IN ('權利','權力')),
  difficulty  INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
  category    TEXT,
  explanation TEXT,
  active      INTEGER NOT NULL DEFAULT 1, -- 0 = 停用（不會出題，但保留統計）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 每一局遊戲
CREATE TABLE IF NOT EXISTS game_sessions (
  id              INTEGER PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,     -- 隨機字串，同時是這局的通行憑證
  student_id      TEXT NOT NULL,
  status          TEXT NOT NULL,            -- active / finished
  started_at      INTEGER NOT NULL,
  plays_at        INTEGER NOT NULL,         -- 第一題開放作答、開始計時
  ends_at         INTEGER NOT NULL,
  finished_at     INTEGER,
  score           INTEGER NOT NULL DEFAULT 0,
  answered_count  INTEGER NOT NULL DEFAULT 0,
  correct_count   INTEGER NOT NULL DEFAULT 0,
  wrong_count     INTEGER NOT NULL DEFAULT 0,
  combo           INTEGER NOT NULL DEFAULT 0,
  max_combo       INTEGER NOT NULL DEFAULT 0,
  wrong_streak    INTEGER NOT NULL DEFAULT 0,
  total_ms        INTEGER NOT NULL DEFAULT 0, -- 所有作答秒數加總（毫秒）
  sequence        TEXT NOT NULL,            -- 題目順序（JSON 陣列，questions.id）
  seq_index       INTEGER NOT NULL DEFAULT 0,
  question_shown_at INTEGER NOT NULL,       -- 目前這題可作答的時間（冷卻時延後）
  layout          TEXT NOT NULL,            -- rl = 權利在左、lr = 權力在左
  layout_run      INTEGER NOT NULL DEFAULT 1,
  -- 作答紀錄：每題一筆 [題目id, 選擇(0=權利,1=權力), 對錯(1/0), 毫秒, 得分變化, 排列(0=rl,1=lr), 冷卻毫秒, 時間戳]
  log             TEXT NOT NULL DEFAULT '[]',
  prev_best       INTEGER,
  is_new_record   INTEGER NOT NULL DEFAULT 0,
  config_snapshot TEXT NOT NULL             -- 開局當下的設定（JSON）
);
CREATE INDEX IF NOT EXISTS idx_sessions_student ON game_sessions(student_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_status_end ON game_sessions(status, ends_at);

-- 每位學生的最佳成績（排行榜用；同分時保留較早的那一局）
CREATE TABLE IF NOT EXISTS best_scores (
  student_id    TEXT PRIMARY KEY,
  score         INTEGER NOT NULL,
  accuracy      INTEGER NOT NULL,           -- 0–100
  answered      INTEGER NOT NULL,
  correct       INTEGER NOT NULL,
  max_combo     INTEGER NOT NULL,
  finished_at   INTEGER NOT NULL,
  session_token TEXT NOT NULL
) WITHOUT ROWID;

-- 題目作答統計（依班級累計；局結束時寫入）
CREATE TABLE IF NOT EXISTS question_stats (
  question_id INTEGER NOT NULL,
  class_name  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  total_ms    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, class_name)
) WITHOUT ROWID;
