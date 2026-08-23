# 家教專用數學物理題庫系統（企業級重構版）

[![CI](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml/badge.svg)](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml)

以 **Node.js + Express + PostgreSQL 16（pgvector）+ Google Gemini** 打造的家教題庫與智慧組卷後端。
支援上傳考卷 PDF 由 AI 自動拆題入庫、依學生作答歷史智慧組卷、並匯出含數學公式排版的 Word 考卷。

---

## ✨ 功能特色

| 功能 | 說明 |
|------|------|
| 📄 **PDF 智慧解題** | 上傳考卷 PDF，Gemini 2.5 Flash 自動拆解題目、判斷學科／章節／難度，並將公式轉為 LaTeX |
| ✍️ **題庫管理** | 題目新增／編輯／刪除／搜尋／分頁，後端以「章節白名單」嚴格驗證 |
| 🧠 **智慧組卷** | 依「學生 × 章節」抽題，**Fisher-Yates 均勻隨機**（有一萬次分佈測試把關），自動記錄作答歷史避免重複出題（交易確保一致性）|
| 📥 **匯出 Word** | 依題型與難度排序，產生 `.docx` 考卷，內建 LaTeX → Word 數學公式轉換 |
| 🌱 **一鍵種子題庫** | `seed_questions.js` 內建 30 題自製示範題，**集中在 4 章、每章 7~8 題**，灌完即可直接用預設值組卷 |
| 🔒 **安全設計** | 參數化 SQL、CORS 白名單、圖片下載防 SSRF、可選 API Key 認證（timing-safe；能力邊界見[安全注意事項](#-安全注意事項)）|

---

## 📊 每個功能的「問題 → 決策 → 數字」

> **這張表是整份 README 的骨幹**（規劃 §4.3.6）。每個功能一列：
> **問題**＝改之前具體壞在哪（引程式碼行號或規劃章節，不寫「效能不好」這種話）；
> **決策**＝選了什麼做法、放棄了什麼；
> **數字**＝**只能來自 `eval/` 腳本的輸出**，並附量測日期、模型 ID 與 commit。
>
> 「數字」欄寫**「待 eval」**代表那個功能的量測腳本還沒有基準線——
> 不是忘了填，是**還沒有可以引用的數字**。在有數字之前，這一格不得填任何從別處抄來的比例、
> 也不得填「明顯變好」這種形容詞：那正是這張表要取代的東西。
> 補數字是 P-15b 的工作（`docs/roadmap-plan.md` §1 任務表），前提是對應的 suite 已有基準線。
>
> 量測環境一律是**公開層**（自製 fixture 與自編 golden、`LLM_MODE=replay`、`EMBED_MODE=fixture`），
> 不連外、不需要金鑰。私有層（真題庫）的數字不進版控。

| 功能 | 問題（引行號／章節） | 決策 | 數字（eval 輸出，含日期與模型 ID） |
|---|---|---|---|
| **LaTeX → Word 公式** | `utils/textFormatter.js:265-266、273-281` 對未知指令與解析失敗**靜默降級成純文字**，症狀只在 Word 打開時看得到（規劃 §3.2） | 手寫 LaTeX→OOXML 解析器 + 表格式單元測試；另有 strict 版本當閘門，降級改成可觀測 | `npm test` 的 `textFormatter` 40 項全綠；`test/e2e/paperWord.e2e.test.js` 斷言匯出的 `.docx` 真的含 `<m:oMath>`／`<m:f>`／`<m:sSup>`／`<m:rad>`（2026-08-23，不需模型） |
| **抽題隨機性** | 舊寫法 `sort(() => 0.5 - Math.random())` 分佈不均，而**隨機性錯了不會噴錯**，只讓某些題長期抽不到 | Fisher-Yates + 固定種子 PRNG 的一萬次卡方分佈測試；並測「檢定本身的鑑別力」 | 5 元素 10,000 次的位置卡方 0.5~4.0（臨界值 18.467）；改回舊寫法會有 5 項轉紅（`test/unit/shuffle.test.js`，2026-08-22） |
| **hybrid 檢索／`/similar`** | 組卷與找相似只有 `WHERE subject=? AND chapter=?` 加 `LIKE '%q%'`（`examController.js:30`、`questionController.js:108`）；「換個數字的同一題」找不到 | pgvector 768 維 + 應用層 jieba 分詞的全文，RRF 融合；同一段 SQL（`queries/hybrid.js`）服務 API 與 eval | Recall@5：`LIKE` 0.875 → hybrid **1.000**；MRR 純向量 0.988、hybrid 0.824（2026-08-22，`gemini-embedding-001`／768 維，commit `a02f7e4`，`npm run eval -- --suite retrieval`，對 `postgres_test`） |
| **拆題管線與硬閘門** | `services/aiService.js:4-49` 是一個巨型 prompt、無 schema、`JSON.parse` 完就回；一題壞掉整批 400（`questionController.js:77-79`） | `jobs` 狀態機 + 五個 sub-agent + 六道閘門，逐題推進、逐題重試、部分入庫 | saved_rate／gate_pass_rate／answer_agree_rate 的門檻已建立於 `eval/thresholds.json`；**README 引用的數字待 eval**（`npm run eval:pipeline`，P-15b） |
| **章節分類** | 章節白名單在 prompt 裡手抄一份（`aiService.js:14-27`），與 `config/chapters.js:4-31` 是兩份真相 | 零成本閘門先擋，過不了才呼叫第二層 LLM；`responseSchema` 直接鎖 enum，伺服器再驗一次 | accuracy／macro-F1 的門檻已建立於 `eval/thresholds.json`；**README 引用的數字待 eval**（`npm run eval:classify`，P-15b） |
| **答案驗證** | 拆題模型會把答案抄錯，而錯得像模像樣——沒有第二個來源就查不出來 | 另一個模型獨立重算，`utils/answerCompare.js` 比對；不一致就進複核，不自動覆蓋 | **待 eval**（answer_agree_rate 由 `npm run eval:pipeline` 產生，P-15b） |
| **去重** | 「去重只看 ID」：同一題換個數字、換個排版就當成新題 | 兩段式：`dedup0` 比正規化題幹的雜湊（零成本），`dedup1` 比向量餘弦 | **待 eval**（`npm run eval:pipeline` 的 needs_review 原因分佈，P-15b） |
| **人工複核佇列** | 舊流程的「人工複核」是**全人工、無差別**：老師逐題看 30 題，系統不說哪一題有疑慮（`public/index.html:885-919`） | 只把有疑慮的題送進佇列，每題附**機器產生的具體原因**（「驗證模型算出 (B)，拆題模型說 (C)」） | 八種 `review_reason` 各有一句具體說明，`test/unit/publicAssets.test.js` 逐一釘住（2026-08-22，不需模型） |
| **學生弱點面板** | 作答歷史塞在 `schema.sql:15` 的 `history_json` 裡、以姓名為 key；只記「出過」不記對錯，`GROUP BY chapter` 的錯誤率做不出來（規劃 §4.2） | `students`／`attempts` 正規化 + 即時 SQL 聚合（CTE 外包一層）；`graded < WEAKNESS_MIN_N` 標「樣本不足」 | 正確性由 `test/integration/students.pg.test.js` 保證（1,000 筆 fixture 逐欄比對 + `EXPLAIN` 含 `idx_attempts_student_date`）；**面板本身沒有 eval 分數，這一列的「數字」就是那支 db-test** |
| **批改回填** | `routes/index.js` 十支路由沒有任何一支能把「第 3 題答錯」寫回去（規劃 §4.2） | `PATCH /api/papers/:id/results` 單一交易、全有全無；三態（對／錯／未批），`null` 是真的要送出去的值 | **待 eval**（無 eval 指標；正確性由整合測試與 `test/e2e/paperWord.e2e.test.js` 的 attempts 斷言保證） |
| **組卷家族互斥** | 變式題入庫後是一般題，同一家族可能被抽進同一張卷 | `utils/pickOnePerFamily.js`：每個 `COALESCE(variant_of, id)` 家族只留一題，抽題語意從「每題等機率」改成「**每家族等機率**」 | **待 eval**（分佈測試比照 `shuffle.test.js`，由 WS-A 提供） |
| **相似題／變式題** | 錯題之後沒有「同概念、難度 +1」的下一題可出 | **先檢索、再生成、生成也走同一組閘門**；首輪一律停在 `needs_review('awaiting_approval')` 等人核准 | **待 eval**（suite 已合入、量得出 `retrieved_coverage`，但 `gate_pass_rate` 仍是 n/a——`eval/cassettes/variant/` 尚未錄製；`eval/thresholds.json` 的 `variant` 節全是 `null`＝尚未建立基準線，P-15b 補） |
| **檢索式 few-shot 分類** | 分類 agent 的範例是寫死的，與題庫實際長相脫節 | 範例改從向量最近鄰取，且**只有人工確認過的標籤有投票權**（`chapter_src='human'`）——自動標籤餵回自動投票是閉環放大器 | **待 eval**（短路率與 accuracy 的變化由 `npm run eval:classify` 量，P-15b） |
| **自然語言查題** | 老師必須記得白名單裡「摩擦力與向心力」這種精確名稱（`config/chapters.js:21`）才篩得到題 | 規則為主、LLM 為輔、受限 JSON、SQL 固定；四級回退階梯，任一層失敗都有退路；`filters` 回寫下拉讓人看得見機器的理解 | **待 eval**（suite 與 cassette 都已合入、`npm run eval:nlq` 三個指標都量得出來；`eval/thresholds.json` 的 `nlq` 節仍全是 `null`＝基準線尚未定案，P-15b 補） |
| **前端（三個新分頁）** | 前端是單一 1,100+ 行的 `public/index.html`，曾因截斷出過事故（commit `6ada1ce`）；再塞 400 行面板同類事故會重演 | vanilla + ES module，經 `window.ExamApp` 橋接；`index.html` 只加五個插入點，舊程式一行不改 | `npm run check:html` 對 6 段程式碼做 `node --check` 並斷言階段 2／3 的四個注入點；`test/unit/stage3Ui.test.js` 56 項（契約）＋ `stage3Render.test.js` 32 項（用 `test/unit/lib/miniDom.js` 真的把三個 module 跑起來渲染一遍）（2026-08-24，不需模型） |
| **端到端** | 單元與整合測試各自綠燈，不代表**接線**沒斷（controller、runner、multipart、docx 之間） | `test/e2e/` 兩條：上傳 PDF → 部分入庫；組卷 → Word 含 `<m:oMath>` | 11 項全綠（`npm run test:e2e`，2026-08-23，對 `postgres_test`、`LLM_MODE=replay` 讀 `eval/cassettes/`，零 replay miss） |

**怎麼補「待 eval」那幾格**（P-15b）：

```bash
npm run eval -- --suite retrieval     # 檢索三欄對照（已有基準線）
npm run eval:classify                 # 章節分類（已有基準線）
npm run eval:pipeline                 # 整條管線（已有基準線）
npm run eval:nlq                      # 自然語言查題（suite 已合入，cassette 已錄）
npm run eval:variant                  # 變式題（suite 已合入；gate_pass_rate 待 cassette）
npm run eval:trend                    # 印出與上一次的差值
```

每支都會把報表寫進 `eval/reports/<suite>-<日期>-<sha>.json`，裡面帶**完整的量測環境**
（模型 ID、cassette 目錄、golden 檔與筆數、轉接層是否還有 stub）。
填進上表時**連同這些欄位一起引用**——沒有量測環境的數字不能拿來互相比較，
而「用 stub 跑」與「用真 agent 跑」的數字長得一模一樣。

> ⚠️ **本機跑需要資料庫的那幾格**（上表的 hybrid 列、學生弱點面板列、端到端列）
> **不能**用 `npm run test:integration`／`npm run test:e2e`：
> 這兩個 script 只帶 `--env-file=eval/.env.replay`（CI 語意，`TEST_DATABASE_URL` 由 workflow 提供），
> 在本機會**整層 skip 而且是綠的**——看起來跑過了，其實一條都沒跑（裁決 S3-R7）。
> 本機一律多帶一個 `--env-file=.env`：
>
> ```bash
> docker compose up -d --wait     # 先起 postgres_test（埠 5433）
> node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/integration/**/*.test.js"
> node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/e2e/**/*.test.js"
> node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite retrieval   # 對真 PG 量 hybrid
> ```

---

## 🖼 成果展示

### 匯出的 Word 考卷

[`sample_exam.docx`](sample_exam.docx) 是系統**實際產出、未經手動編輯**的考卷，可直接下載開啟：

- 來源：種子題庫的「物理 · 牛頓運動定律」，以預設值抽 5 題組卷後匯出
- 題目依**題型**（單選→多選→填空→計算→證明）再依**難度**排序，並自動附上作答資訊列與參考答案區
- 內含 **33 個 Word 原生數學公式**（`<m:oMath>`，其中 9 個分數、13 個上標）——是**可用 Word 公式編輯器點開修改的真公式**，不是截圖貼上

### 介面截圖

> 🚧 UI 美化完成後補上，屆時放在 `docs/` 並改為圖片連結。

| 檔名 | 應呈現的畫面 |
|------|--------------|
| `docs/screenshot-manager.png` | 題庫管理：清單、篩選、分頁與「共 N 題」計數 |
| `docs/screenshot-generate.png` | 智慧組卷：填入學生／章節／抽題數後的題目預覽與下載按鈕 |
| `docs/screenshot-word.png` | 匯出的 `.docx` 在 Word 中開啟的實際排版（數學公式） |

---

## 🗂 專案結構

```
exam_pro/
├─ server.js              # 進入點：啟動 HTTP server
├─ app.js                 # Express 設定：CORS、靜態檔、金鑰注入、全域錯誤中樞
├─ config/
│   ├─ db.js              # PostgreSQL 連線池（匯出 {pool, query}，型別轉換集中於此）
│   ├─ features.js        # FEATURE_* 功能旗標（預設全關）
│   └─ chapters.js        # 數學/物理精細章節白名單 + 驗證函式
├─ middleware/
│   ├─ auth.js            # 可選的 x-api-key 認證（timingSafeEqual）
│   └─ rateLimit.js       # 記憶體型速率限制器（保護 AI 端點）
├─ routes/index.js        # API 路由表
├─ public/
│   └─ index.html         # 前端單頁介面（唯一對外靜態資產）
├─ controllers/           # 請求處理：question / exam / ai / word
├─ services/
│   ├─ aiService.js       # 呼叫 Gemini 解析 PDF
│   └─ wordService.js     # 產生 Word 考卷（含防 SSRF 圖片下載）
├─ utils/
│   ├─ textFormatter.js   # LaTeX → OOXML 數學公式解析器
│   └─ shuffle.js         # Fisher-Yates 洗牌（抽題的公平性核心）
├─ docker-compose.yml     # 本機 PostgreSQL 16 + pgvector（5442 開發 / 5433 測試）
├─ migrations/            # 只增不改的 SQL：0001_init、0002_vector、0004_origin_legacy（0003 保留給階段 2）
├─ migrate.js             # 極簡 migration 執行器（node migrate.js up [--test] | status）
├─ migrate/               # 一次性遷移工具（import_pg / verify / export_pg_delta；MySQL 匯出腳本已隨 D-X1 收尾退役）
├─ seed_questions.js      # 種子題庫：30 題自製示範題（4 章 × 7~8 題）
├─ sample_exam.docx       # 成果範例：實際匯出的 Word 考卷
├─ test/                  # 單元測試（node:test，無額外相依）
│   ├─ textFormatter.test.js  # 公式解析器
│   └─ shuffle.test.js        # 抽題隨機性：一萬次分佈測試
├─ 啟動資料庫.bat         # 雙擊即起容器 + 套 migrations（先檢查 Docker 是否啟動）
└─ *.bat / *_formulas.js  # 題庫維運工具（見下方）

../.github/workflows/ci.yml  # CI：push / PR 時在 Node 20.x、22.x 上跑 npm ci + npm test
```

---

## 🏗 系統架構

```mermaid
flowchart TD
    Browser["🌐 瀏覽器<br/>public/index.html<br/>Tailwind + MathJax"]

    subgraph Server["Express 伺服器 (Node.js)"]
        App["app.js<br/>CORS 白名單 · 靜態資產 · 金鑰注入 · 全域錯誤中樞"]
        subgraph MW["中介軟體"]
            Auth["auth.js<br/>x-api-key（timing-safe）"]
            RL["rateLimit.js<br/>AI 端點限流 10/min"]
        end
        Routes["routes/index.js<br/>/api 路由表"]
        subgraph Ctrl["Controllers"]
            QC["questionController<br/>題庫 CRUD / 批次入庫"]
            EC["examController<br/>智慧組卷（交易）"]
            AC["aiController<br/>PDF 上傳處理"]
            WC["wordController<br/>Word 匯出"]
        end
        subgraph Svc["Services / Utils"]
            AIS["aiService<br/>呼叫 Gemini 拆題"]
            WS["wordService<br/>產生 .docx（防 SSRF）"]
            TF["textFormatter<br/>LaTeX → OOXML 公式"]
        end
        Chapters["config/chapters.js<br/>章節白名單驗證"]
        DB["config/db.js<br/>PostgreSQL 連線池"]
    end

    Gemini["🤖 Google Gemini 2.5 Flash"]
    PG[("🗄 PostgreSQL 16 + pgvector<br/>questions · students<br/>exam_papers · attempts")]

    Browser -- "HTTP / x-api-key" --> App
    App --> Auth --> RL --> Routes
    Routes --> QC & EC & AC & WC
    QC --> Chapters
    AC --> AIS --> Gemini
    WC --> WS --> TF
    QC --> DB
    EC --> DB
    WC --> DB
    DB --> PG
```

**兩條主要資料流**

1. **AI 拆題入庫**：瀏覽器上傳 PDF → `aiController` → `aiService` 呼叫 Gemini 回傳 JSON → `questionController.batchSaveQuestions` 經**章節白名單**驗證後寫入 `questions`。
2. **智慧組卷 + 匯出**：`examController` 以 `NOT EXISTS (SELECT 1 FROM attempts …)` 濾掉該生寫過的題、抽題並在**同一交易**內建立 `exam_papers` 與 `attempts` → `wordController` / `wordService` 用 `textFormatter` 把 LaTeX 轉成 Word 數學公式，輸出 `.docx`。

---

## 🚀 安裝與啟動

### 1. 前置需求
- **Node.js 20+**（`@google/genai` 於 `package.json` 宣告 `engines: node >= 20`；CI 亦以 20.x / 22.x 驗證）
- **Docker Desktop**（WSL2 後端）——資料庫是容器裡的 PostgreSQL 16 + pgvector（2026-08-21 起正式使用；MySQL 已退役）
- 一組 [Google Gemini API 金鑰](https://aistudio.google.com/apikey)

### 2. 安裝相依套件
```bash
cd exam_pro
npm install
```

### 3. 設定環境變數
複製範本並填入實際值：
```bash
cp .env.example .env
```
| 變數 | 說明 | 預設 |
|------|------|------|
| `PORT` | 服務埠 | `3000` |
| `GEMINI_API_KEY` | Google Gemini 金鑰（**必填**）| — |
| `DATABASE_URL` | PostgreSQL 連線（階段 1 起的正式資料庫）| `postgres://exam:exam@localhost:5442/tutor_exam_bank` |
| `TEST_DATABASE_URL` | 整合測試專用的 PostgreSQL；**資料庫名必須以 `_test` 結尾**，否則 `migrate.js` 拒絕執行 | `postgres://exam:exam@localhost:5433/tutor_exam_bank_test` |
| `EMBED_MODEL` / `EMBED_DIM` / `EMBED_RPM` / `EMBED_BATCH` / `EMBED_MODE` | embedding 模型與限速；`EMBED_DIM` 在 I0 釘死為 **768** | gemini-embedding-001 / 768 / 60 / 32 / fixture |
| `LLM_MODE` | `live` / `record` / `replay`；CI 恆為 `replay` | `replay` |
| `FEATURE_SIMILAR` / `FEATURE_HYBRID_SEARCH` | 新功能旗標，預設全關 | `false` |
| `API_KEY` | 後端存取金鑰；留空則**停用**認證。⚠️ 此金鑰會被注入前端頁面，僅適用本機自用，**不可作為對外部署的存取控制**（見[安全注意事項](#-安全注意事項)）| 空 |
| `ALLOWED_ORIGINS` | 允許的前端來源（逗號分隔）| `http://localhost:3000` |
| `IMAGE_HOST_ALLOWLIST` | Word 匯圖時允許的圖片網域（逗號分隔，選填）| 空 |
| `NODE_ENV` | `production` 時錯誤不外洩細節 | `development` |

### 4. 啟動資料庫並套用 migrations

**Windows 直接雙擊 `啟動資料庫.bat`**（會先檢查 Docker 是否啟動、拉起容器、再套 migrations）。等價的手動指令：

```bash
docker compose up -d --wait   # postgres → 5442（named volume）、postgres_test → 5433（tmpfs）
npm run migrate               # 對 DATABASE_URL 套用 migrations/*.sql
npm run migrate:test          # 對 TEST_DATABASE_URL 套用（跑整合測試前）
node migrate.js status        # 看每一支的套用狀態
docker compose down           # 停止（加 -v 才會刪掉 pgdata）
```

- 映像固定為 `pgvector/pgvector:pg16`（官方 pgvector，內含 PG contrib 的 `pg_trgm`），本機、CI、正式環境同一顆。
- `migrate.js` 只前進、不做 down；每一支 SQL 與它的 `schema_migrations` 紀錄在同一交易內，重跑是 no-op。
- **中文路徑的 bind mount 已實測可用**（Docker Desktop 29.6.2 / WSL2，專案路徑含「期中專案」），`docker-compose.yml` 因此把 `./migrations` 唯讀掛進容器。萬一在別台機器上掛載失敗，退路是不經 `migrate.js` 直接餵檔：
  ```bash
  docker compose exec -T postgres psql -U exam -d tutor_exam_bank < migrations/0001_init.sql
  ```
- **開發埠是 5442，不是 5432**：這台開發機已安裝並啟動了原生的 PostgreSQL 17 服務（`postgresql-x64-17`）占用 5432。兩個行程同時 LISTEN 同一埠時，連線會被先啟動的那個接走，症狀是「密碼驗證失敗」這種看起來與 Docker 無關的錯誤。若日後停用該服務，要改回 5432 只需同步改 `docker-compose.yml` 與 `.env`／`docs/interfaces.md` 第 9 條。
- 舊的 MySQL 版 `schema.sql` 與 `migrate/export_mysql.js` 已於 D-X1 收尾（2026-08-21）移除；歷史版本見 git tag `v1-mysql`。

### 5. 啟動
```bash
npm start      # 正式
npm run dev    # 開發（nodemon 熱重載）
```
啟動後開啟 <http://localhost:3000>。

---

## 🧪 測試

```bash
npm test        # 單元測試（test/unit/），使用 Node 內建的 node:test，無額外相依套件
npm run check:html   # public/ 的 inline script 與 public/js/*.js 語法 + 前端接點檢查
```

每次 push 與 PR 都會由 [GitHub Actions](../.github/workflows/ci.yml) 在 Node 22.x / 24.x 上自動執行單元層，另有一個 `integration` job 起 `pgvector/pgvector:pg16` service 跑整合測試、**端到端測試**與五個 eval suite（badge 見本頁最上方）。
`npm test` **不連資料庫、不呼叫 Gemini、不需要任何 secrets**——任何人都能在不設定 `.env` 的情況下看到驗證結果。

### 需要資料庫的整合測試（`test/integration/`）

```bash
docker compose up -d --wait                                    # 起 postgres_test（埠 5433，tmpfs）
node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/integration/**/*.test.js"
```

- **一定要帶 `--test-concurrency=1`**：各檔案共用同一個測試庫並會 `TRUNCATE`，`node --test` 預設多檔並行會互相清掉對方的資料，出現「一起跑就紅、單跑就綠」的假失敗（`npm run test:integration` 已內建此旗標）。

- 這一層**只讀 `TEST_DATABASE_URL`，且資料庫名必須以 `_test` 結尾**（與 `migrate.js` 同一條防呆），
  因此永遠打不到真題庫；`npm test` 沒有預載 `.env`，整層會自動 skip。
- 涵蓋：migrations 從零套用、組卷連抽兩次不重疊、400/409 訊息逐字不變、
  attempts 寫入短少與拋錯時整筆交易回滾、`listQuestions` 的 `total` 型別、
  出過的題刪除時改為封存（`archived:true`）、新增／修改題目後的 `search_tsv` 同步。
- `npm run test:integration` 只帶 `eval/.env.replay`（沒有 `TEST_DATABASE_URL`），
  在本機會整層 skip——那支是給 CI 用的（CI 由 workflow 的 env 提供）。本機請用上面那行。
- ⚠️ Node 24 在 Windows 上 `node --test <目錄>` 會把目錄當成模組去 require 而失敗，
  一定要用上面的 glob 形式。

### 端到端測試（`test/e2e/`，E-X15）

```bash
docker compose up -d --wait                                    # 起 postgres_test（埠 5433）
node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/e2e/**/*.test.js"
```

兩條，量的都不是「某個函式對不對」，而是**接線有沒有斷**：

| # | 走的路 | 斷言 |
|---|---|---|
| ① | `POST /api/jobs` 上傳自製樣卷 → 真的 `workers/jobRunner.js` 走完狀態機 → `GET /api/jobs/:id` | `state=done`、四個 `counts` 相加等於 `job_questions` 總數、**部分入庫**（至少一題進 `questions` 且章節在白名單內）、沒過閘門的題停在 `needs_review` 並帶得出 `review_reason`、`payload` 只有凍結的那幾個鍵、**零 replay miss** |
| ② | `POST /api/generate-paper` → `POST /api/download-word` | 回應帶 `paper_id`、`attempts` 真的被寫出來（未批改）、把 `.docx` 解壓後 `word/document.xml` 含 `<m:oMath>`／`<m:f>`／`<m:sSup>`／`<m:rad>` |

- 與 `npm run eval:pipeline` **不重疊**：那支用 `eval/lib/pipelineDriver.js` 量分數，全程不經 HTTP、不碰 `jobs`／`job_questions` 兩張表。
  eval 全綠而 e2e 紅，代表管線本身沒事、是 controller 或 runner 接錯了——這正是 e2e 存在的理由。
- 同樣**不連外**：`LLM_MODE=replay` 讀 `eval/cassettes/`、`EMBED_MODE=fixture`。沒有金鑰、沒有網路。
  `LLM_MODE` 不是 `replay` 時 ① 會直接丟錯而不是靜默改打 Gemini。
- ② 的三題自製題題幹帶 `[E2E-WORD]` 記號，並先把「這一章裡不是自己的題」記成該生已寫過——
  測試庫是共用的，不這樣做的話抽到的三題不見得是自己插的那三題，`<m:f>` 的斷言就變成擲骰子。
- `npm run test:e2e` 與整合測試一樣只帶 `eval/.env.replay`，本機沒設 `TEST_DATABASE_URL` 會整層 skip。

單元測試集中在兩支模組，共同點是**壞掉不會噴錯**：

### 1. `utils/textFormatter.js` — LaTeX → Word OOXML 解析器

本專案唯一手寫的解析器，有兩個特性讓它最需要防線：

1. **輸入不可控**：題目文字來自 Gemini 的自由輸出，未知指令、不成對的 `$`、中英數混排都可能出現。
2. **會靜默失敗**：解析失敗時走 `try/catch` 降級成純文字而**不丟例外**，症狀只會在 Word 開起來時顯現為公式跑位。沒有測試就完全看不見退化。

涵蓋的契約：

| 分類 | 驗證內容 |
|---|---|
| 結構對應 | `\frac`→`m:f`、`x^2`→`m:sSup`、`\sqrt`→`m:rad`、`\sum`/`\int`→`m:nary`、`\lim`→`m:limLow`、巢狀分數 |
| 符號轉換 | 希臘字母、運算關係符號、函數名不被拆成單一變數、`\vec` 重音 |
| 中英混排 | 中文留在 `w:r`、公式進 `m:oMath`，**中文不得被吞進公式**（否則 Word 會用數學斜體排中文）|
| 健壯性 | 未知指令降級、不成對 `$`、未閉合 `{`、空參數、emoji 與控制字元清除、真實題目格式 |

### 2. `utils/shuffle.js` — 抽題的隨機性（一萬次分佈測試）

智慧組卷的隨機抽題決定了題目對學生的曝光是否公平，但**隨機性錯了不會噴錯、不會當機**——
它只會讓某些題目長期抽不到。功能測試（回 200 嗎？有 5 題嗎？）完全測不出這件事，只有統計檢定能釘住。

| 分類 | 驗證內容 |
|---|---|
| 基本契約 | 不修改原陣列、回傳新陣列、空／單元素邊界、1000 次輸出皆為合法排列（不重複不遺漏）、物件參考保留 |
| 位置分佈 | 5 元素抽 **10,000 次**，每個位置的元素次數做卡方檢定（自由度 4，臨界值 18.467）；另有「每格偏差 < ±10%」的人眼可讀版本 |
| 完整排列分佈 | 4 元素抽 **10,000 次**，24 種排列必須全部出現且卡方值 < 49.728（只看位置邊際分佈可能漏掉偏差）|
| 真實亂數 | 改用 `Math.random` 仍須通過寬鬆門檻，防止有人把亂數來源寫死 |
| **檢定的鑑別力** | 刻意保留舊寫法 `sort(() => 0.5 - Math.random())`，證明同一套檢定確實會把它判為不均勻 |

分佈測試預設注入**固定種子的 PRNG**（mulberry32）。若直接用 `Math.random`，均勻分佈本身也有極小機率超過臨界值，
會讓 CI 隨機轉紅；固定種子後結果完全可重現——**CI 紅燈就一定是程式改壞了，不是運氣不好**。

> 最後那一列才是重點。一個永遠會過的測試等於沒有測試，所以測試自己的鑑別力也要被驗證。
> 實測把 `shuffle` 改回舊寫法，40 個測試中會有 **5 個轉紅**（位置卡方值從 0.5~4.0 暴增到 1414，
> 最常見與最罕見排列的次數從相差 1.25 倍變成相差 13.7 倍）——這條防線是驗證過的，不是宣稱的。

### 3. 檢索 eval — `LIKE` vs 純向量 vs hybrid 三欄對照（`eval/`）

**問題**：組卷與「找相似題」原本只有 `WHERE subject=? AND chapter=?` 加 `LIKE '%關鍵字%'`，
「換個數字的同一題」在不同 PDF 裡會被當成新題，也做不出「同概念、難度 +1」的推薦。
**決策**：PostgreSQL + pgvector 存 768 維向量（Gemini Embedding），檢索改為 metadata 篩選 → 向量 + 全文（應用層 jieba 分詞）RRF 融合，同一段 SQL（`queries/hybrid.js`）同時服務 API 與 eval。
**數字**（公開層：自製 fixture 60 題、人工定案 golden 40 筆；2026-08-22，`gemini-embedding-001`／768 維，commit `a02f7e4`，CI 的 `integration` job 對真 PG 量測）：

| 檢索方式 | Recall@5 | Recall@10 | MRR |
|---|---:|---:|---:|
| `LIKE`（舊基準） | 0.875 | 0.950 | 0.768 |
| 純向量 | **1.000** | **1.000** | **0.988** |
| hybrid（RRF） | **1.000** | **1.000** | 0.824 |

```bash
node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite retrieval   # 本機重現（對 postgres_test）
npm run eval:baseline                                                           # 重寫門檻初值（只升不降）
```

怎麼讀這張表：

- **hybrid 的 Recall@5 比 `LIKE` 高 12.5 個百分點**，Roadmap 規格 1 要求的「hybrid ≥ LIKE」成立；`eval/thresholds.json` 以第一次量測 −0.03 為門檻、之後只升不降（ratchet），任何改動讓三欄掉到門檻下 CI 就轉紅。
- **hybrid 的 MRR 反而低於純向量**（0.824 vs 0.988）：RRF 把關鍵字側名次混進來後，正確題偶爾從第 1 名掉到第 2–3 名。這是規劃 §2.6.5 預留的決策點（「加權優於 RRF > 3 點 Recall@5 才切換」）——在私有 golden（真題庫）上量過再決定，先不動。
- 公開 fixture 小而乾淨，數字好看不代表真題庫表現；私有層（`eval/private/`，不進版控）的數字由開發者本機跑後另行記錄。CI 只守「不退步」。
- 與 prod 同一段 SQL：eval 的 pg engine 只調 `hnsw.ef_search`，量到的就是 `/api/questions/:id/similar` 走的路徑；eval **只連 `TEST_DATABASE_URL`**（`_test` 後綴強制），不會碰正式庫。

---

## ✅ 交付前驗收清單（「陌生人驗收」）

> **為什麼需要這份清單**：本專案的前端是**單一靜態 `public/index.html`**，沒有打包器、沒有編譯期。
> 檔案就算被截斷在函式中段，伺服器仍會照常回 200，症狀只會在瀏覽器 F12 顯示 `SyntaxError`，
> 而且**整支內嵌 script 會全部不執行**（下拉選單空白、按鈕沒反應）。
> 「在我電腦上是好的」擋不住這種問題——只有**從乾淨目錄、只用版控裡的檔案、照 README 走一遍**才擋得住。
> 因此每次交付前一律跑完以下 10 步，任何一步紅燈就不算完成。

### A. 從零重建（驗證「版控裡的檔案足以跑起來」）

| # | 步驟 | 通過標準 |
|---|------|----------|
| 1 | 取得乾淨副本：`git clone <repo> fresh && cd fresh/exam_pro` | **不可**沿用既有 `node_modules` / `.env`；`.env` 本來就不在版控中 |
| 2 | `npm install` | 安裝成功，無 `ERR!`（`multer@1.x` 的 deprecated 警告為已知，不影響啟動）|
| 3 | `cp .env.example .env` 並填入 `GEMINI_API_KEY`、`DB_PASSWORD` | `.env.example` 的每個欄位都有對應值 |
| 4 | `docker compose up -d --wait` 後 `npm run migrate` | `node migrate.js status` 顯示 `0001_init.sql`、`0002_vector.sql` 皆已套用 |
| 5 | `node seed_questions.js --apply` | 顯示「新增 30 題」且分佈為 4 章各 7~8 題（任一章 < 5 題會自動中止）|

### B. 自動化把關（先讓機器擋掉低級錯誤）

| # | 步驟 | 通過標準 |
|---|------|----------|
| 6 | `npm test` | **40 passed / 0 failed / 1 skipped**（skip 的是需要 PG 的整合測試；CI 亦會在 push 後自動跑一次，見 README 上方 badge）|
| 7 | 靜態檔完整性：確認 `public/index.html` 結尾為 `</script></body></html>`，且 `<div>`、`<script>` 開闔數相等 | 檔案未被截斷（詳見下方「截斷檔自檢」）|
| 8 | `npm start` | 終端印出 `🚀 家教題庫後端系統已成功安全啟動：http://localhost:3000` |

### C. 人工驗收（F12 全程開著）

| # | 步驟 | 通過標準 |
|---|------|----------|
| 9 | 開 <http://localhost:3000>，**F12 → Console** | **零 error、零 warning**；Network 無 4xx／5xx |
| 10 | 走完主流程：① 題庫清單顯示筆數與分頁 → ② 手動新增一題 → ③ 智慧組卷（**抽題數維持預設 5 不要改**）→ ④ **點「下載標準 Word 考卷檔」** | 組卷回 200 而非 400；`.docx` 成功下載、可用 Word 開啟、數學公式為**可編輯公式**而非亂碼 |

> 第 10 步的 ④ 是最容易被跳過、卻最容易壞的一步——`downloadWordFile()` 位於 `index.html` **最尾端**，
> 檔案一旦被截斷，它就是第一個消失的函式，而前面九步**全部都會是綠燈**。

### 截斷檔自檢（30 秒）

```bash
# 1) 尾端必須是完整的收尾標籤
tail -5 public/index.html          # 應看到 </script>、</body>、</html>

# 2) 內嵌 JS 必須能被解析（把 <script> 內容抽出來丟給 node 檢查）
node -e "const fs=require('fs');const h=fs.readFileSync('public/index.html','utf8');\
const b=[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n');\
fs.writeFileSync('.tmp_inline.js',b)" && node --check .tmp_inline.js && echo "JS OK" && rm .tmp_inline.js
```

`node --check` 通過 ≠ 功能正確，但**截斷、少括號、少收尾標籤這類會讓整頁死掉的問題，它 100% 攔得下來**，
而且不需要開瀏覽器。建議在每次修改 `index.html` 後、commit 前跑一次。

### 最近一次驗收紀錄

| 項目 | 結果 |
|---|---|
| 日期 | 2026-08-01 |
| 方式 | 只複製版控追蹤的檔案至全新目錄 → 全新 `npm install` → 由 `.env.example` 產生 `.env` → `schema.sql` 建立獨立驗收資料庫（**當時仍是 MySQL**，階段 1 換底後改為 `docker compose up` + `npm run migrate`）→ 種子 30 題 |
| `npm test` | 40 passed / 0 failed（`npm ci` 亦驗證過 lock file 可獨立還原，且測試不需 `.env`）|
| 突變測試 | 把 `shuffle` 改回 `sort(() => 0.5 - Math.random())` → 5 個測試轉紅、退出碼 1；還原後回到 40/40 |
| 首頁載入 | Console **0 error、0 warning**；章節下拉 35 項、題庫清單 10 張卡＋「共 30 題」＋分頁正常 |
| 智慧組卷（預設 5 題）| **4 章全部 200**；題型排序（單選→計算）與難度排序（1,2,2,3,3）皆正確 |
| 避免重複出題 | 同一學生同章再抽 5 題 → 400（剩 3 題，符合預期）；改抽 3 題 → 200；換一位學生抽 5 題 → 200 |
| 匯出 Word | `/api/download-word` 200，`Content-Type: …wordprocessingml.document`；`.docx` 解壓 22 項無損毀、含 33 個 `<m:oMath>`（見 [`sample_exam.docx`](sample_exam.docx)）|
| 已修復 | ① `public/index.html` 曾截斷於 `downloadWordFile()` 的 `const url = …` 之後，已補回函式尾段與 `</script></body></html>`　② 種子題庫原為「30 章各 1 題」，預設抽 5 題必回 400，已改為 4 章各 7~8 題並加上單章密度自我檢查　③ 抽題洗牌原用 `sort(() => 0.5 - Math.random())`（分佈不均勻），已改為 Fisher-Yates 並以一萬次分佈測試釘住 |

---

## 🔌 API 一覽

所有路由掛在 `/api` 之下；若設定了 `API_KEY`，需帶 `x-api-key` 標頭。

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/questions` | 題庫列表（支援 `subject/chapter/question_type/q/page/limit` 篩選分頁）|
| POST | `/api/questions` | 新增單題 |
| PUT | `/api/questions/:id` | 更新題目 |
| DELETE | `/api/questions/:id` | 刪除題目。**已有學生作答紀錄者改為封存**（`archived_at`），回 `{message, id, archived:true}`；封存的題不再出現在題庫列表與組卷候選中 |
| POST | `/api/batch-save-questions` | 批次入庫（AI 解析結果）。**部分入庫**：通過驗證的題照樣寫入，回 `{message, saved_count, rejected:[{idx, reason}]}`；`?strict=1` 則維持舊的「一題不合格就整批 400」行為 |
| GET | `/api/chapters` | 題庫中實際存在的章節 |
| GET | `/api/chapter-whitelist` | 完整章節白名單（前端下拉選單）|
| POST | `/api/generate-paper` | 智慧組卷（`student_name/subject/chapter/count`）。回應含 `paper_id`（`exam_papers.id`）|
| POST | `/api/analyze-pdf` | 上傳 PDF（`multipart/form-data`, 欄位 `pdf`）解析題目 |
| POST | `/api/download-word` | 依 `question_ids` 產生 Word 考卷 |

---

## 🛠 題庫維運工具（Windows `.bat`）

雙擊即可執行，修正類工具含「先預覽、再套用」雙段流程並自動備份：

| 批次檔 | 作用 |
|--------|------|
| `執行公式健檢.bat` | 掃描題庫公式問題 → 產生 `公式健檢報告.html` |
| `預覽公式修正.bat` / `套用公式修正.bat` | 公式自動修正（套用前備份為 `formulas_backup_*.json`）|

灌入示範題（題庫為空時）：

```bash
node seed_questions.js          # 預覽：只列清單與各章題數，不寫入
node seed_questions.js --apply  # 實際寫入（交易保護；同題幹已存在則跳過）
```

種子題的分佈是**刻意設計**的——30 題集中在 4 章，每章 7~8 題：

| 學科 | 章節 | 題數 |
|------|------|------|
| 數學 | 指數與對數 | 8 |
| 數學 | 三角函數的定義 | 7 |
| 物理 | 牛頓運動定律 | 8 |
| 物理 | 動量守恆與碰撞 | 7 |

> **為什麼不是「每章 1 題、涵蓋 30 章」**：智慧組卷會先濾掉該學生寫過的題，
> 若剩餘題數 < 抽題數就回 `400`（`controllers/examController.js`）。前端預設抽題數是 **5**
> （`public/index.html` 的 `#count`），所以「每章 1 題」的題庫**看起來涵蓋很廣，但招牌功能一按就失敗**。
> 題庫的可用性不取決於總題數，而取決於**單章密度**。
> 每章 7~8 題還留有餘裕：同一位學生抽完 5 題後仍可再抽 3 題，能實際演示「避免重複出題」。
>
> `seed_questions.js` 內建這條防線——**任一章題數低於 5 就直接中止並列出該章**，不會讓失衡的題庫灌進資料庫。

> ⚠️ `*_backup_*.json` 與 `公式*.html` 產物內含題庫資料，已在 `.gitignore` 排除，請勿外流。

---

## 🛣 下一階段

Agent 管線（狀態機 + 五個 sub-agent）、RAG（相似題／檢索式分類／自然語言查題）、資料層（MySQL → PostgreSQL + pgvector、`attempts` 表、檢索 eval）的設計規格、建議順序與驗收指標，統一維護在專案根目錄 [`README.md` 的 Roadmap 章節](../README.md#-roadmap)，完整規劃（作法／理由／替代方案／排程）在 [`docs/roadmap-plan.md`](../docs/roadmap-plan.md)。
**進度**：階段 1 資料層**已完成並於 2026-08-21 切換上線**——PostgreSQL 16 + pgvector（Docker，埠 5442）、`students`/`attempts` 取代 `history_json`、embedding 與 `search_tsv` 已回填、hybrid 檢索與 `GET /api/questions/:id/similar`（`FEATURE_SIMILAR=true`）、eval 體系與 CI integration job。切換紀錄：MySQL 匯出 70 題／126 卷／143 作答／5 學生，`migrate/verify.js` 七項全過，冒煙測試（列表／兩次組卷不重疊／Word 公式／`/similar`）全過；tag `v1-mysql`，MySQL 服務停用保留 14 天（回滾界線見 `docs/cutover-runbook.md` §3）。檢索三欄對照見上方「測試 › 3」。階段 2、3 尚未開工。

---

## 🔐 安全注意事項

- **`.env` 內含真實金鑰，切勿進版控或分享**（已由 `.gitignore` 排除）。若金鑰曾外流，請至 Google AI Studio **重新產生**。
- 對外部署時務必設定 `ALLOWED_ORIGINS`，並將 `NODE_ENV=production`。
- 資料庫帳號建議改用最小權限帳號，勿用 root。
- 匯入的題目著作權屬原著作權人，請確認已取得合法權源，詳見專案根目錄 [`NOTICE`](../NOTICE)。

### ⚠️ `API_KEY` 的能力邊界（請務必理解）

為了讓同源前端能自動帶上 `x-api-key`，`app.js` 會在回應首頁時把金鑰**直接注入 HTML**：

```js
// app.js — serveIndex()
const key = process.env.API_KEY || '';
res.type('html').send(html.replace('__API_KEY__', key));
```

這代表**任何能開啟 `/` 的人，都會直接取得 `API_KEY`**。

因此 `API_KEY` 只擋得住「未載入首頁就直接打 API」的存取，**不等同真正的存取控制**。
在「單人、本機、`localhost` 自用」的前提下這是合理的取捨；但若要**對外公開部署**，必須改用下列任一方式，不可依賴 `API_KEY`：

- 置於反向代理之後，由代理層負責驗證（Basic Auth / OAuth / IP 白名單）
- 導入真正的使用者登入與 session／JWT 機制
- 或至少改為「金鑰不注入前端、由使用者手動輸入並存於 `sessionStorage`」
