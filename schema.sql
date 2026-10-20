-- ============================================================
--  資料庫結構（SQLite）。伺服器啟動時會自動建立，可重複執行。
--  資料檔位置：data/game.db（可用環境變數 DATA_DIR 更改）
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
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_name);

-- 題庫（由 CSV 匯入；以「題號 code」識別同一題）
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,
  answer      TEXT NOT NULL CHECK (answer IN ('權利','權力')),
  difficulty  INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
  category    TEXT,
  explanation TEXT,
  active      INTEGER NOT NULL DEFAULT 1, -- 0 = 停用（不會出題，但保留作答紀錄）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 每一局遊戲
CREATE TABLE IF NOT EXISTS game_sessions (
  id              TEXT PRIMARY KEY,        -- 隨機字串，同時是該局的通行憑證
  student_id      TEXT NOT NULL REFERENCES students(student_id),
  status          TEXT NOT NULL CHECK (status IN ('active','finished')),
  started_at      INTEGER NOT NULL,        -- 按下開始的時間（毫秒）
  plays_at        INTEGER NOT NULL,        -- 第一題開放作答、開始計時的時間
  ends_at         INTEGER NOT NULL,
  finished_at     INTEGER,
  score           INTEGER NOT NULL DEFAULT 0,
  answered_count  INTEGER NOT NULL DEFAULT 0,
  correct_count   INTEGER NOT NULL DEFAULT 0,
  wrong_count     INTEGER NOT NULL DEFAULT 0,
  combo           INTEGER NOT NULL DEFAULT 0,
  max_combo       INTEGER NOT NULL DEFAULT 0,
  wrong_streak    INTEGER NOT NULL DEFAULT 0,
  sequence        TEXT NOT NULL,           -- 本局題目順序（JSON 陣列，內容為 questions.id）
  seq_index       INTEGER NOT NULL DEFAULT 0,
  question_shown_at INTEGER NOT NULL,      -- 目前這題「可作答」的時間（冷卻時會延後）
  layout          TEXT NOT NULL,           -- 目前這題按鈕排列：rl=權利在左／lr=權力在左
  layout_run      INTEGER NOT NULL DEFAULT 1,
  prev_best       INTEGER,                 -- 本局結束時，先前的歷史最高分（首次遊玩為 NULL）
  is_new_record   INTEGER NOT NULL DEFAULT 0,
  config_snapshot TEXT NOT NULL            -- 開始當下使用的設定（JSON）
);
CREATE INDEX IF NOT EXISTS idx_sessions_student ON game_sessions(student_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_status_end ON game_sessions(status, ends_at);

-- 每一題的作答紀錄
CREATE TABLE IF NOT EXISTS answers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL REFERENCES game_sessions(id),
  student_id     TEXT NOT NULL,
  question_id    INTEGER NOT NULL REFERENCES questions(id),
  seq_no         INTEGER NOT NULL,         -- 本局第幾題（從 1 開始）
  chosen         TEXT NOT NULL,            -- 學生選的答案
  correct        INTEGER NOT NULL,         -- 1 = 答對
  response_ms    INTEGER NOT NULL,         -- 作答時間（毫秒，伺服器計算）
  layout         TEXT NOT NULL,            -- 當時按鈕排列
  base_points    INTEGER NOT NULL DEFAULT 0,
  speed_points   INTEGER NOT NULL DEFAULT 0,
  combo_points   INTEGER NOT NULL DEFAULT 0,
  penalty_points INTEGER NOT NULL DEFAULT 0,
  score_delta    INTEGER NOT NULL,         -- 實際加減的分數
  score_after    INTEGER NOT NULL,
  combo_after    INTEGER NOT NULL,
  cooldown_ms    INTEGER NOT NULL DEFAULT 0,
  answered_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id);
CREATE INDEX IF NOT EXISTS idx_answers_student ON answers(student_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);

-- 每位學生的最佳一局（同分時，較早達成的排前面）。排行榜與後台都用這個 view。
DROP VIEW IF EXISTS v_best_sessions;
CREATE VIEW v_best_sessions AS
SELECT * FROM (
  SELECT gs.*,
         ROW_NUMBER() OVER (
           PARTITION BY gs.student_id
           ORDER BY gs.score DESC, gs.finished_at ASC
         ) AS rn
  FROM game_sessions gs
  WHERE gs.status = 'finished' AND gs.answered_count > 0
)
WHERE rn = 1;

PRAGMA user_version = 1;
