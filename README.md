# 權利 vs 權力｜3分鐘極限挑戰

國中公民限時答題競賽。學生用自己的手機、平板或電腦，輸入學號登入，3 分鐘內判斷每一題是「權利」還是「權力」。伺服器即時計分，保留每人最高分並顯示 Top 10 榮譽榜；結算畫面是一張有「優／甲／乙／丙／丁」等第的成績單。教師後台可以查看成績、題目答對率，並匯出 CSV。

- **架設在 Cloudflare 免費方案**（Workers ＋ D1 資料庫），有固定網址、不會休眠，不需要自己的伺服器。
- **防作弊**：答案只存在伺服器，學生的瀏覽器拿不到；作答時間、分數、冷卻都由伺服器計算。
- **程式碼放在 GitHub**：每次更新 GitHub，Cloudflare 會自動重新部署。

---

## 一、第一次部署（約 10 分鐘，只需要做一次）

### 1. 建立 D1 資料庫

1. 登入 [Cloudflare](https://dash.cloudflare.com)。
2. 左側選單「Storage & databases」→「D1 SQL database」→「Create database」。
3. 名稱填 `rights-power-db`，按「Create」。
4. 進入剛建立的資料庫，複製右側的 **Database ID**（一串像 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 的文字）。
5. 把 `wrangler.jsonc` 裡的 `REPLACE_WITH_D1_DATABASE_ID` 換成這串 ID，存檔並更新到 GitHub。

### 2. 從 GitHub 建立 Worker

1. 左側選單「Workers & Pages」→「Create application」→「Import a repository」（或「Connect to Git」）。
2. 連結 GitHub 帳號，選擇 `rights-power-game` 這個 repository。
3. 專案名稱保持 `rights-power-game`（必須和 `wrangler.jsonc` 的 `name` 一樣）。
4. Build command 留空；Deploy command 保持 `npx wrangler deploy`。
5. 按「Deploy」，等它跑完（約 1～2 分鐘）。

### 3. 設定後台密碼

1. 進入剛建立的 Worker →「Settings」→「Variables and Secrets」→「Add」。
2. Type 選 **Secret**，名稱填 `ADMIN_PASSWORD`，值填你的後台密碼（至少 8 個字元）。
3. 按「Deploy」儲存。

### 4. 完成

Worker 頁面上會顯示網址，例如 `https://rights-power-game.你的名稱.workers.dev`。

- 學生遊戲：`https://…workers.dev/`
- 教師後台：`https://…workers.dev/admin`

到教師後台匯入學生名單與題庫，就可以開始使用。

---

## 二、匯入學生名單

在教師後台 →「匯入名單／題庫」上傳 CSV（第一列是欄位名稱）：

| 學號 | 姓名 | 班級 | 座號 |
|---|---|---|---|
| 70101 | 王小明 | 701 | 1 |

- 必填：**學號、姓名、班級**；座號可省略。學號開頭的 0 不會不見。
- 學號已存在時會更新姓名與班級，成績不受影響。
- 勾選「停用不在這份名單裡的學生」適合換新學年；停用的學生不能登入、不會出現在榮譽榜，但成績保留。
- **名單含學生個資，請不要上傳到 GitHub**（只要在後台匯入即可）。`.gitignore` 已設定：放在 `private/` 資料夾、或檔名含「名單」的 CSV 都不會被 Git 上傳。

---

## 三、題庫格式

`samples/questions.csv` 是已整理好的 200 題（權利、權力各 100 題，難度 80／80／40），可直接在後台匯入，或下載後修改再匯入。原稿在 `scripts/bank-source.py`。

| 欄位 | 必填 | 說明 |
|---|---|---|
| 題號 | 建議 | 每題唯一的代號（如 Q001）。系統用題號辨認同一題，修改內容再匯入時統計會延續。 |
| 題目 | ✔ | 200 字以內。 |
| 答案 | ✔ | 只能填「權利」或「權力」。 |
| 難度 | 建議 | 1＝基本辨識、2＝生活情境、3＝概念判斷。沒填視為 2。 |
| 類別 | | 自由填寫。 |
| 解析 | | 結算畫面的「訂正錯題」會顯示，強烈建議填寫。 |

- 修改流程：後台「下載目前題庫」→ Excel 修改 → 另存「CSV UTF-8」→ 再匯入（一般 Big5 的 CSV 也讀得懂）。
- 預設會停用不在檔案裡的題目（以檔案為準）；停用的題目不再出題，統計保留。
- 檔案中只要有一列錯誤，整份都不會匯入，畫面會列出第幾列有問題。
- 內容沒變的題目重新匯入時不會寫入資料庫（節省免費額度）。

**避免被規律猜中**：匯入時會自動檢查權利／權力比例、各難度題數，以及「政府、警察…＝權力」「人民、學生…＝權利」「依法＝某一種答案」這類容易被猜中的規律，並提出警告。

---

## 四、調整遊戲規則（config.js）

所有數值集中在 `config.js`，每一項都有中文註解。修改後更新到 GitHub，Cloudflare 會自動重新部署（進行中的對局沿用開局時的設定）。

| 想調整 | 修改 |
|---|---|
| 遊戲時間 | `game.durationSeconds`（秒） |
| 答對基本分、答錯扣分 | `scoring.correctBase`、`scoring.wrongPenalty` |
| 速度獎勵 | `scoring.speedBonus`（`max`＝最高加分、`lossPerSecond`＝每秒遞減） |
| 連對獎勵 | `scoring.combo.milestones`、`scoring.combo.repeat` |
| 連錯暫停 | `cooldown.triggerAtConsecutiveWrong`、`cooldown.seconds` |
| 難度比例 | `selection.difficultyMix`（預設每 10 題 4 易、4 中、2 難） |
| 按鈕固定或隨機 | `selection.shuffleButtons`（`false`＝固定左權利、右權力） |
| 成績單等第門檻與評語 | `grades` |
| 成績單標題 | `reportCardTitle` |
| 榮譽榜名次 | `leaderboard.size` |

### 成績單等第

依「本次分數」與「正確率」判定，**兩個條件都達到**才給該等第：

| 等第 | 分數 | 正確率 |
|---|---|---|
| 優 | ≥ 5,000 | ≥ 80% |
| 甲 | ≥ 3,500 | ≥ 75% |
| 乙 | ≥ 2,000 | ≥ 70% |
| 丙 | ≥ 1,000 | ≥ 60% |
| 丁 | 其他 | |

正確率門檻是為了避免「不看題目、快速亂按」的學生拿到高等第（模擬中，每題 0.7 秒亂按的中位數約 6,200 分）。若也不希望亂猜的人登上榮譽榜，可把 `scoring.wrongPenalty` 從 50 改成 100。

---

## 五、教師後台

網址 `/admin`，用 `ADMIN_PASSWORD` 登入（8 小時有效；連續輸錯 10 次會暫時鎖定）。

- **學生成績**：最高分、最佳等第、遊玩次數、正確率、平均作答秒數；點學生可看每一局。
- **題目統計**：每題作答次數、答對率；可只看答對率低於 60% 的題目。
- **班級篩選**：右上角選班級，統計與匯出都會跟著篩選。
- **匯出 CSV**：學生成績總表、每局成績、作答明細、題目統計、學生名單、題庫。
- **清除成績**：新學期或新一輪比賽前使用；刪除所有遊玩紀錄與榮譽榜，名單和題庫保留。清除前請先匯出。

---

## 六、免費額度

Cloudflare 免費方案每天可寫入 10 萬列資料。實測模擬 150 位學生各玩一局（每局約 58 題），每局約寫入 125 列，因此：

- **每天大約可以玩 800 局**（150 人每人約 5 局）。
- 超過時，當天會暫停到隔天早上 8 點（台灣時間）自動恢復，已存的成績不會遺失；遊戲會顯示「今天的免費使用量已達上限」。
- 學生登入、作答等請求每天上限 10 萬次，一般使用遠遠用不完。
- 可在 Cloudflare 後台的 D1 資料庫頁面查看每天的用量。

---

## 七、檔案結構

```
config.js              ← 遊戲規則設定
schema.sql             ← 資料庫結構（第一次使用時自動建立）
wrangler.jsonc         ← Cloudflare 設定（Worker 名稱、D1 資料庫 ID）
src/worker.js          ← Cloudflare Worker 入口
lib/
  app.js               ← API 路由
  game.js              ← 開局、出題、判分、結算、榮譽榜
  scoring.js           ← 計分公式
  grading.js           ← 成績單等第
  sequence.js          ← 出題順序
  importers.js         ← 名單與題庫匯入、題庫檢查
  admin.js             ← 後台統計與匯出
  admin-auth.js        ← 後台密碼驗證
  store.js             ← 資料庫介面（D1／本機 SQLite 共用）
public/                ← 學生遊戲畫面與教師後台網頁
samples/               ← 範例名單（虛構）與 200 題題庫
test/                  ← 自動測試（npm test，需要 Node.js 22.13 以上）
```

### 資料表

| 資料表 | 內容 |
|---|---|
| `students` | 學號、姓名、班級、座號、是否啟用 |
| `questions` | 題號、題目、答案、難度、類別、解析、是否啟用 |
| `game_sessions` | 每一局的分數、答對數、最高連對、是否破紀錄，以及每一題的作答紀錄（`log`） |
| `best_scores` | 每位學生的最佳成績（榮譽榜使用） |
| `question_stats` | 每一題依班級累計的作答次數、答對次數 |

---

## 八、注意事項

- **學號就是登入憑證**：知道同學學號的人可以用他的名義玩。因為只保留最高分，冒名者無法拉低別人成績，但可能幫別人刷高分；後台的「每局成績」可看出每局時間。也可以在名單中改用不易猜測的代碼讓學生登入。
- 本機測試：`npm test`（Node.js 22.13 以上）；本機試跑 Cloudflare 版本：`npm install` 後執行 `npm run dev`，並在專案資料夾放一個 `.dev.vars` 檔，內容 `ADMIN_PASSWORD=你的密碼`。
