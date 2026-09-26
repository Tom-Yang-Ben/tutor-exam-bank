# API 設計規範 (API Specification) - 家教專用數理題庫系統

> **版本:** v1.4 | **更新:** 2026-09-24 | **狀態:** 活躍 | **OpenAPI 定義:** [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例。本文件維護 API 設計約定、認證／CORS／限流政策、錯誤語意、端點總表與狀態碼慣例；單一端點的請求／回應 schema 細節歸 [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)，路由掛載的單一真相為 `exam_pro/routes/index.js` 與 `exam_pro/app.js`。

> 🛠 **2026-08-29 修訂**（PR #6/#7 程式碼同步）：§2.1 `GET /api/questions` 篩選參數補 `source_type`；§5.1 端點總表補 `GET /api/chapter-volumes`（三層選單資料源）；`POST /api/generate-paper` 說明補 `source_types` 題源過濾；§7 上游 FR 範圍延伸至 FR-017。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。

> 🛠 **2026-08-29 修訂之二**（feat/source-detail）：questions／jobs 各端點的請求與回應加 `source_detail` 來源註記（自由文字 ≤100 字，FR-017 延伸）；§5.1 補 `POST /api/questions/batch-source` 批次補標端點。標記〔修訂 2026-08-29b〕。

> 🛠 **2026-09-15f 修訂**（feat/source-check，FR-020）：無新端點；`GET /api/review` 的 `reason` 值域加 `transcription_mismatch`（九個值）、`GET /api/review/:jqId` 的 payload 可含 `extract.source_text` 與 `source_check`、approve 事件 detail 加 `source_recheck`／`stem_edited`（§2.1、§5.1）。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-16 修訂**（feat/follow-up-protect-badge，FR-019 PR3）：§5.1 `GET /api/questions` 回應補承上題兩欄、`DELETE /api/questions/:id` 補 `?group=1` 與 409 情境。修改處以〔修訂 2026-09-16〕行內標記。

> 🛠 **2026-09-15g 修訂**（feat/follow-up-paper-group，FR-019 PR2）：無新端點；§5.1 `POST /api/generate-paper` 補承上題整組抽取、少出題時的 `shortfall`／`note` 與逐題 `follows_question_id`，`POST /api/confirm-paper` 補組內相鄰排序。修改處以〔修訂 2026-09-15g〕行內標記。

> 🛠 **2026-09-24 修訂**（階段 5 整合回填，分支 `stage5/int-docs`；FR-021～035）：依 `exam_pro/routes/index.js` 檔尾四個階段 5 區塊與各功能文件回填。新增端點 13 支：核心區 `GET /api/questions/:id`、`GET /api/student-profile-options`；`FEATURE_STUDENTS` 下 `GET /api/error-types`；`FEATURE_KC` 下 `GET /api/kc`、`PATCH /api/kc/:id`、`GET|PUT /api/questions/:id/kcs`；`FEATURE_REMEDIAL` 下 `GET /api/students/:id/weakness/kc`、`POST /api/students/:id/remedial-paper`、`GET /api/students/:id/remedial-paper/items`、`GET /api/coverage`；`FEATURE_TUTOR` 下 `POST /api/tutor`；`FEATURE_VOICE`＋`FEATURE_TUTOR` 下 `POST /api/voice/transcribe`。擴充既有端點 13 支（批改、試卷明細、弱點、學生列表／新增／修改、題目列表／新增／修改、組卷 `blueprint`、Word `edition`、jobs 建立與查詢的 `subject_group`）。§2.2 旗標表、§3 路由專屬錯誤處理、§4 限流表、§5、§6、§7 同步。OpenAPI 同輪更正兩處既有錯誤：`PATCH /papers/{id}/results` 的 body 鍵名依實作改為 `results`（原記 `items`）；`POST /questions/batch-source` 的 200 描述未加引號，使整份 YAML 無法解析（2026-08-29b 起），已加引號並以 PyYAML 解析驗證。修改處以〔修訂 2026-09-24〕行內標記。

> 🛠 **2026-09-26 合併回填**（分支 `dec/docs-backfill-round1-merged`；Owner 決策單 2026-09-25 B7、B10 已合入 `local/integration` `7dc14a0`）：無新端點。§5.1 `POST /api/generate-paper` 承上題湊不滿的政策改為預設 400（`FOLLOW_UP_SHORTFALL_POLICY` 環境變數，`note` 可切回）；`POST /api/confirm-paper` 補伺服器端承上題整組檢查（400＋`incomplete_groups`）；§6 的 400 列同步。OpenAPI 同輪更新並以 PyYAML 解析驗證。修改處以〔修訂 2026-09-26 合併回填〕行內標記。

## 目錄

- [1. 設計約定](#1-設計約定)
- [2. 通用行為](#2-通用行為)
- [3. 錯誤處理](#3-錯誤處理)
- [4. 安全性](#4-安全性)
- [5. API 端點總表](#5-api-端點總表)
- [6. 狀態碼慣例](#6-狀態碼慣例)
- [7. 追溯](#7-追溯)

## 1. 設計約定

| 項目 | 規範 |
| :--- | :--- |
| **風格** | RESTful（部分動作型端點沿用歷史命名，如 `/generate-paper`、`/batch-save-questions`） |
| **Base URL** | 開發環境 `http://localhost:3000/api`（單人本機部署，無 staging／production 網域） |
| **格式** | `application/json` (UTF-8)；請求體上限 2 MB（`express.json({ limit: '2mb' })`）；PDF 上傳走 `multipart/form-data`，上限 15 MB（multer） |
| **資源路徑** | 小寫複數名詞（`/questions`、`/students`、`/papers`、`/jobs`） |
| **欄位命名** | `snake_case`（如 `student_id`、`question_ids`、`saved_count`） |
| **認證** | 可選 API Key：`x-api-key` 標頭（`exam_pro/middleware/auth.js`，詳見 §4） |
| **版本控制** | 無 URL 版本段；演進採 append-only 路由區塊（階段 1–4 各自的凍結區塊，rebase 衝突兩邊保留；階段 5 為檔尾 WS-A／C／D／E 四個區塊〔修訂 2026-09-24〕） |
| **掛載方式** | 全部路由掛在 `/api` 之下，統一先過 `apiKeyAuth`（`exam_pro/app.js`）；`FEATURE_*` 旗標關閉的路由「不掛載」，請求落到 Express 預設 404 |

## 2. 通用行為

### 2.1 分頁與篩選

`GET /api/questions` 與 `GET /api/jobs/:id/questions` 支援 `page`／`limit` 分頁（頁碼式，非游標式）；前者另支援 `subject`／`chapter`／`question_type`／`q`（關鍵字）／`source_type`（題源標記單值，FR-017；非法值靜默忽略不套用，`questionController.js`）篩選〔修訂 2026-08-29〕。`GET /api/review` 僅提供 `reason` 篩選（九個 `review_reason` 值之一，非法值 400；〔修訂 2026-09-15f〕加 `transcription_mismatch`）與 `limit` 上限（預設一次最多 50 筆，無頁碼）。其餘列表端點（`/students`、`/students/:id/papers`）回傳全量或依 controller 內建條件，無分頁參數。〔修訂 2026-09-24〕階段 5 的列表端點皆無分頁：`GET /api/kc` 以 `subject`／`chapter`／`status` 篩選（同名參數給兩次回 400），依白名單順序排序；`GET /api/coverage` 以 `subject`／`student_id` 篩選；`GET /api/students/:id/weakness/kc` 沿用弱點面板的 `days`（1–365，預設 90）／`subject`。

### 2.2 旗標控制掛載

| 旗標（`exam_pro/config/features.js`，預設全關） | 控制的路由群 |
| :--- | :--- |
| `FEATURE_PIPELINE` | **不控制任何路由掛載**——jobs／review 八支恆掛載（`routes/index.js` WS2-A 區塊無旗標包裹）；本旗標僅切換前端上傳入口與複核分頁渲染 |
| `FEATURE_SIMILAR` | 相似題檢索 |
| `FEATURE_VARIANTS` | 變式題 |
| `FEATURE_NLQ` | 自然語言查題 |
| `FEATURE_STUDENTS` | 學生試卷／弱點／批改四支 |
| `FEATURE_ASSISTANT` | 對話式助教 |
| `FEATURE_STUDENTS`（階段 5 擴充）〔修訂 2026-09-24〕 | 另控制 `GET /api/error-types`（錯因白名單，FR-021） |
| `FEATURE_KC`〔修訂 2026-09-24〕 | 知識點四支：`GET /api/kc`、`PATCH /api/kc/:id`、`GET`／`PUT /api/questions/:id/kcs`（FR-028、FR-029） |
| `FEATURE_KC_TAGGING`〔修訂 2026-09-24〕 | **不控制任何路由**：只控制管線 save 節點 COMMIT 後是否呼叫自動標註（`workers/jobRunner.js` runKcTagHook） |
| `FEATURE_REMEDIAL`〔修訂 2026-09-24〕 | 知識點弱點、補救卷草稿、補救卷加題查詢、題庫覆蓋率四支（FR-030、FR-031、FR-033）；`POST /api/generate-paper` 的 `blueprint` **不吃**此旗標 |
| `FEATURE_TUTOR`〔修訂 2026-09-24〕 | `POST /api/tutor`（FR-034） |
| `FEATURE_VOICE`〔修訂 2026-09-24〕 | `POST /api/voice/transcribe`（FR-035）；**須同時開 `FEATURE_TUTOR`**，否則不掛載 |

旗標關閉時路由不存在（非 403），行為與不存在的路徑一致——Express 預設 404。此規則適用於 SIMILAR／VARIANTS／NLQ／STUDENTS／ASSISTANT 五個旗標，以及階段 5 的 KC／REMEDIAL／TUTOR／VOICE〔修訂 2026-09-24〕；PIPELINE 為唯一例外（管線屬階段 2 核心，路由恆掛載）。

### 2.3 冪等性與交易

未提供 `Idempotency-Key` 機制。寫入一致性由交易保證：`POST /api/confirm-paper` 在同一交易內建卷＋寫入 attempts（NFR-006）；`POST /api/batch-save-questions` 採部分入庫，回 `{saved_count, rejected:[{idx,reason}]}`，`?strict=1` 走全有全無舊行為。

## 3. 錯誤處理

錯誤回應主體為 `{ "message": "..." }`。未被路由層攔截的例外一律落到全域錯誤中樞（`exam_pro/app.js`）：

```js
app.use((err, req, res, next) => {
    const isDev = process.env.NODE_ENV !== 'production';
    res.status(err.status || 500).json({
        message: '後端伺服器內部發生未知錯誤',
        ...(isDev ? { error: err.message } : {})   // production 不回傳錯誤細節
    });
});
```

- **production 不洩漏細節**：`error` 欄位（原始 `err.message`）僅開發環境回傳（NFR-001）。
- **路由專屬錯誤處理的例外**：`POST /api/jobs` 掛 `handleUploadError` 四參數中介軟體，把 multer 的 `LIMIT_FILE_SIZE` 轉成凍結的 413（裁決見 `docs/interfaces-stage2.md` 第 6.1 條）；`/analyze-pdf` 保留既有行為，同錯誤落到全域中樞成 500。〔修訂 2026-09-24〕`POST /api/voice/transcribe` 掛 `tutorController.handleVoiceUploadError`：`LIMIT_FILE_SIZE`（>5 MB）→ 413，其他 MulterError 與 busboy 的 multipart 解析錯誤（沒有結尾 boundary、part header 壞掉、沒有 boundary、不支援的 content type、上傳中斷）→ 400，其餘錯誤交全域中樞。
- **階段 5 的錯誤語意**〔修訂 2026-09-24〕：AI 家教與語音的 LLM 端失敗（供應商錯誤、replay miss、逾時、模型輸出不合 schema）一律 502，訊息以「AI 家教暫時無法回應：」或語音轉寫的對應句開頭；每日預算用完與每分鐘限流皆為 429（訊息不同）；DB 錯誤不包成 502，交全域中樞回 500。
- CORS 白名單外的來源在 `cors` 中介軟體丟出 `Error('CORS 政策不允許此來源')`，同樣由全域中樞回應。

## 4. 安全性

| 機制 | 實作 | 出處 |
| :--- | :--- | :--- |
| API Key 認證 | `x-api-key` 標頭，`crypto.timingSafeEqual` 定時安全比較；`API_KEY` 未設定則停用認證（本機自用）；失敗回 401 | `exam_pro/middleware/auth.js`（NFR-001） |
| API Key 能力邊界 | 首頁會把金鑰注入 HTML，任何能開啟 `/` 的人即取得金鑰——僅擋「未載入首頁直接打 API」，**不可作為對外部署的存取控制**；對外部署須改用反向代理驗證或登入機制 | `exam_pro/README.md` 安全注意事項 |
| CORS | 僅允許 `ALLOWED_ORIGINS` 白名單（預設 `http://localhost:3000`）；無 `origin` 的請求（curl、同站 fetch）放行 | `exam_pro/app.js` |
| 限流 | 記憶體型固定時間窗，以 IP 為 key，每個限流器**獨立計數桶**（不共用 Map）；回應帶 `X-RateLimit-Limit`／`X-RateLimit-Remaining`，超限回 429＋`Retry-After`；單機實作，多實例部署須改 Redis 型方案 | `exam_pro/middleware/rateLimit.js`（NFR-002） |
| 靜態資產 | 只公開 `public/`，後端原始碼、schema、備份 JSON 不落入靜態路徑 | `exam_pro/app.js` |

各端點限流配置（皆為 60 秒窗）：

| 限流器 | 上限 | 套用端點 | 理由 |
| :--- | :--- | :--- | :--- |
| aiRateLimit | 10/min | `POST /api/analyze-pdf`、`POST /api/jobs`（共用同一桶） | 呼叫 Gemini 的高成本操作 |
| similarRateLimit | 60/min | `GET /api/questions/:id/similar` | 取既有 embedding，不呼叫 LLM，可放寬 |
| variantRateLimit | 10/min | `POST /api/questions/:id/variants` | 與 aiRateLimit 同級但獨立桶 |
| nlqRateLimit | 30/min | `POST /api/questions/search-nl` | 多數請求走規則解析不產生費用，與拆題額度分桶 |
| assistantRateLimit | 10/min | `POST /api/assistant` | 每次呼叫 LLM，防止連按送出累積費用 |
| kcRateLimit〔修訂 2026-09-24〕 | 120/min | 知識點四支（共用一桶） | 不呼叫 LLM，只是防呆；逐張審定口語版綽綽有餘 |
| tutorRateLimit〔修訂 2026-09-24〕 | 10/min（`TUTOR_RATE_LIMIT_PER_MIN`，非正整數退回 10） | `POST /api/tutor` | 每次呼叫 LLM；另有每日預算 `TUTOR_DAILY_BUDGET_USD`（NFR-007） |
| voiceRateLimit〔修訂 2026-09-24〕 | 10/min（`VOICE_RATE_LIMIT_PER_MIN`） | `POST /api/voice/transcribe` | 每次呼叫 LLM；成本併入家教的每日預算 |

〔修訂 2026-09-24〕`FEATURE_REMEDIAL` 的四支與 WS-A 的三支唯讀端點不套限流（只讀資料庫、不呼叫 LLM；裁決 S5-25）。

## 5. API 端點總表

端點細節（請求／回應 schema）歸 [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)；本表僅列路由、FR 對應與掛載條件。

### 5.1 核心區（恆常掛載）

| 方法／路徑 | FR | 說明 |
| :--- | :--- | :--- |
| `GET /api/questions` | FR-007 | 題庫列表（篩選＋分頁）；每題另回 `follows_question_id`（前題 id，非承上題為 `null`）與 `has_follow_ups`（有在庫承上題）（FR-019）〔修訂 2026-09-16〕；每題多 `solution_text`、`solution_src`（FR-024）〔修訂 2026-09-24〕 |
| `GET /api/questions/:id`〔修訂 2026-09-24〕 | FR-024 | 題目詳情（含詳解、`archived_at`；**封存題也查得到**；不回 embedding／search_tsv）；`:id` 非正整數 400 `無效的題目 ID`、不存在 404。註冊於 WS-A 區塊，路徑未限定數字——之後新增 `GET /api/questions/<字面>` 須註冊在它之前（裁決 S5-8） |
| `POST /api/questions`、`PUT /api/questions/:id`、`DELETE /api/questions/:id` | FR-007 | 〔修訂 2026-09-24〕POST／PUT 接受 `solution_text`（≤4000 字或 null；老師寫入標 `teacher`、清空兩欄 NULL；PUT 沒帶此鍵不動、與現值 trim 後相同保留原來源；FR-024）；科目白名單含「化學」（FR-026）。題目 CRUD；出過的題刪除改封存 `archived:true`；刪除承上題的前題回 409 帶 `children`、刪除匯入任務產生的題回 409 請改封存（FR-019）〔修訂 2026-09-15f〕；刪除變式藍本回 409 帶 `job_ids`、封存仍有在庫承上題的前題回 409 帶 `children`；`?group=1` 整組（此題＋全部後代承上題）單一交易處理，組內有作答或任務引用則整組封存（FR-019 PR3，細節見 `docs/interfaces-stage1.md` §12.1）〔修訂 2026-09-16〕 |
| `POST /api/batch-save-questions` | FR-007 | 批次入庫（白名單硬驗證、部分入庫；`?strict=1` 舊行為） |
| `POST /api/questions/batch-source` | FR-017 | 批次補標題源：`{question_ids(≤200), source_type?, source_detail?}` 至少一項；兩欄皆「帶了才改」、封存題不動〔修訂 2026-08-29b〕 |
| `GET /api/chapters`、`GET /api/chapter-whitelist` | FR-002 | 實際存在章節／完整白名單；〔修訂 2026-09-24〕白名單多「化學」44 章（FR-026） |
| `GET /api/chapter-volumes` | FR-002、FR-007 | 分冊結構（科目→冊→單元），前端三層章節選單資料源；唯一真相 `config/chapters.js` 的 VOLUMES〔修訂 2026-08-29〕；〔修訂 2026-09-24〕多「化學」六冊（排在物理之後；FR-026） |
| `GET /api/students` | FR-014 | 學生清單（裁決 S4-2：組卷下拉恆常需要，不吃旗標）；〔修訂 2026-09-24〕每列在 `id, name, papers, graded_ratio` 之後多 `grade, track, target_exams, school, textbook_version, note`（FR-023） |
| `POST /api/students`、`PATCH /api/students/:id`、`DELETE /api/students/:id` | FR-014 | 建立（唯一新學生入口，裁決 S4-1）／改名／刪除；〔修訂 2026-09-24〕POST／PATCH 接受六個檔案欄位的任意子集（PATCH 沒送不動；空 body 400「至少要提供一個要修改的欄位（…）」），回應改為完整一列（只增不減；FR-023） |
| `GET /api/student-profile-options`〔修訂 2026-09-24〕 | FR-023 | 學生檔案表單選項 `{grades, tracks, target_exams, textbook_versions, school_max_length, note_max_length}`（`config/studentProfile.js`；核心區不吃旗標） |
| `POST /api/students/:id/merge` | FR-014 | 學生併名（衝突題保留目標側批改） |
| `POST /api/generate-paper` | FR-008 | 組卷草稿（`dry_run` 預覽、`exclude_ids` 換題；attempts 排除已作答；`source_types` 題源過濾——空陣列或未帶＝不限制、含非法值 400，FR-017〔修訂 2026-08-29〕；承上題以組為單位整組抽、相鄰排列，組內任一題不可用整組不抽，湊不滿題數時~~預設 200 少出題並加 `shortfall`／`note`~~〔修訂 2026-09-26 合併回填 B10〕預設 400（`FOLLOW_UP_SHORTFALL_POLICY=error`：訊息說出哪一章要幾題、最多湊到幾題、建議改成幾題；設 `note` 才照舊 200 少出題並加 `shortfall`／`note`），`questions[]` 逐題加 `follows_question_id`，FR-019，契約見 `docs/interfaces-stage1.md` 第 7.1 條〔修訂 2026-09-15g〕）；〔修訂 2026-09-24〕另接受 `blueprint: [{chapter, count, difficulty_min?, difficulty_max?}]` 跨章配額（1–10 列、count 總和 ≤50；與 `chapter`／`count` 互斥，同送 400；回應多 `blueprint`、`shortfalls`，有不足時加 `note`；部分列不足仍 200、全部列抽不到才 400；〔修訂 2026-09-26 合併回填 B10〕承上組湊不滿的列在預設政策下整份 400 並逐列給建議題數；不吃旗標；FR-032，`docs/remedial.md` §2.3）；不帶 `blueprint` 時回應逐字不變 |
| `POST /api/confirm-paper` | FR-008 | 確認出卷（同一交易建卷＋attempts；預覽過期回 409；承上組依承接順序相鄰排序〔修訂 2026-09-15g〕；〔修訂 2026-09-26 合併回填 B7〕伺服器端檢查承上題整組：卷裡有某組的任一題、整組卻沒有全部在卷裡 → 400 `{message, incomplete_groups:[{group_ids, missing:[{question_id, reason}]}]}`，不寫卷、不寫 attempts；FR-019，契約見 `docs/interfaces-stage1.md` 第 7.1 條） |
| `DELETE /api/papers/:id` | FR-008 | 刪卷連 attempts，題目回候選池（裁決 S4-3） |
| `POST /api/analyze-pdf` | FR-001 | 舊版單呼叫拆題（保留）；限流 10/min、PDF 上限 15 MB |
| `POST /api/download-word` | FR-009、FR-018、FR-025、FR-027 | 〔修訂 2026-09-24〕body 多 `edition`：`standard`（預設，行為不變）／`student`（不附答案）／`solution`（答案後接詳解）；其他值（含空字串）400；`\ce{…}` 化學式轉原生 OMML、`\mathrm` 正體。Word 匯出（LaTeX→OOXML，docx 原生 Math 物件）；`question_img` 為 `/figures/<檔名>` 的題嵌入本機裁圖，讀不到時該題放「（附圖遺失）」、整份仍回 200（`docs/figures.md`）〔修訂 2026-09-16〕 |
| `POST /api/jobs`（15 MB、超限 413；限流 10/min，與 `/analyze-pdf` 共用同一桶；檔案內容缺 `%PDF-` 檔頭回 400〔修訂 2026-09-15c〕） | FR-001、FR-026 | 建立拆題 job（恆掛載；FEATURE_PIPELINE 僅控制前端上傳入口）；〔修訂 2026-09-24〕multipart 多 `subject_group`（`math_physics` 預設、空字串亦同／`chemistry`；其他值 400 `subject_group 只能是 math_physics 或 chemistry。`），冪等鍵改為 `(pdf_sha256, subject_group)`——換卷別重傳建新 job；回應形狀不變 |
| `GET /api/jobs/:id`、`GET /api/jobs/:id/questions`、`POST /api/jobs/:id/retry` | FR-001 | job 狀態／逐題清單／斷點續跑（恆掛載）；〔修訂 2026-09-24〕`GET /api/jobs/:id` 回應最後多 `subject_group`（FR-026） |
| `GET /api/review`、`GET /api/review/:jqId`、`POST /api/review/:jqId/approve`、`POST /api/review/:jqId/reject` | FR-006 | 人工複核佇列四支（恆掛載）；〔修訂 2026-09-15f〕FR-020 的「題幹與原卷不符」沿用同四支，approve 不重跑原卷比對、只在事件記 `source_recheck`／`stem_edited`（`docs/interfaces-stage2.md` 第 6.6 條） |

### 5.2 旗標區

| 旗標 | 方法／路徑 | FR | 限流 |
| :--- | :--- | :--- | :--- |
| `FEATURE_SIMILAR` | `GET /api/questions/:id/similar` | FR-010 | 60/min |
| `FEATURE_VARIANTS` | `POST /api/questions/:id/variants` | FR-011 | 10/min（獨立桶） |
| `FEATURE_NLQ` | `POST /api/questions/search-nl` | FR-012 | 30/min |
| `FEATURE_STUDENTS` | `GET /api/students/:id/papers`、`GET /api/students/:id/weakness` | FR-013 | — |
| `FEATURE_STUDENTS` | `GET /api/papers/:id`、`PATCH /api/papers/:id/results` | FR-015 | — |
| `FEATURE_ASSISTANT` | `POST /api/assistant` | FR-016 | 10/min |
| `FEATURE_STUDENTS`〔修訂 2026-09-24〕 | `PATCH /api/papers/:id/results`（`results[i]` 多 `score`／`error_types`／`response`／`note`，沒送不動、null 清空、錯改對清錯因；新增 9 種 400，見 `docs/grading-and-profile.md` §3.1）、`GET /api/papers/:id`（`questions[]` 多 subject、chapter、answer_text、solution_text、solution_src、score、error_types、response、teacher_note） | FR-021 | — |
| `FEATURE_STUDENTS`〔修訂 2026-09-24〕 | `GET /api/error-types`（新增）→ `{items:[{code,label,subjects}], max_per_attempt:5}` | FR-021 | — |
| `FEATURE_STUDENTS`〔修訂 2026-09-24〕 | `GET /api/students/:id/weakness`（擴充：頂層多 `by_error_type`，`recent_wrong[]` 多 `error_types`、`score`） | FR-022 | — |
| `FEATURE_KC`〔修訂 2026-09-24〕 | `GET /api/kc`、`PATCH /api/kc/:id` | FR-028 | 120/min |
| `FEATURE_KC`〔修訂 2026-09-24〕 | `GET /api/questions/:id/kcs`（`?detail=1` 另回 `{question, items}`）、`PUT /api/questions/:id/kcs` | FR-029 | 120/min（與上列同桶） |
| `FEATURE_REMEDIAL`〔修訂 2026-09-24〕 | `GET /api/students/:id/weakness/kc` | FR-030 | — |
| `FEATURE_REMEDIAL`〔修訂 2026-09-24〕 | `POST /api/students/:id/remedial-paper`（只產草稿）、`GET /api/students/:id/remedial-paper/items?ids=`（手動加題前查整組；只讀） | FR-031 | — |
| `FEATURE_REMEDIAL`〔修訂 2026-09-24〕 | `GET /api/coverage` | FR-033 | — |
| `FEATURE_TUTOR`〔修訂 2026-09-24〕 | `POST /api/tutor` | FR-034 | 10/min（可調） |
| `FEATURE_VOICE`＋`FEATURE_TUTOR`〔修訂 2026-09-24〕 | `POST /api/voice/transcribe`（multipart `audio`，memoryStorage、≤5 MB） | FR-035 | 10/min（可調） |

各端點的請求／回應形狀以 [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml) 為準；錯誤訊息逐字與選題規則的權威文件：`docs/grading-and-profile.md`（FR-021～025）、`docs/chemistry.md`（FR-026～027）、`docs/knowledge-components.md`（FR-028～029）、`docs/remedial.md`（FR-030～033）、`docs/tutor.md`（FR-034～035）〔修訂 2026-09-24〕。

## 6. 狀態碼慣例

| 狀態碼 | 語意 | 實例 |
| :--- | :--- | :--- |
| 200 | 成功 | 各查詢／更新端點；`variants` 檢索命中（`mode:'retrieved'`） |
| 202 | 已受理，非同步處理中 | `POST /api/jobs`（回 `{job_id, existing}`）；`variants` 進入生成（`mode:'generating'`）；`POST /api/jobs/:id/retry` |
| 400 | 參數無效或業務前置條件不足 | 組卷剩餘題數少於抽題數（家族互斥後計算）；〔修訂 2026-09-26 合併回填〕承上組湊不滿題數（B10 預設）、`confirm-paper` 的承上題組不完整（B7，帶 `incomplete_groups`）；batch-save 白名單驗證失敗；〔修訂 2026-09-24〕批改細節違反白名單、學生檔案值不合法、`edition`／`subject_group` 非法、`blueprint` 與 `chapter` 同送、知識點 PATCH 有不認得的鍵、PUT 別科知識點、錄音 mime 不合或 multipart 壞掉 |
| 401 | 認證失敗 | 缺少或錯誤的 `x-api-key`（僅 `API_KEY` 已設定時） |
| 404 | 資源不存在，或旗標關閉的路由未掛載 | `generate-paper` 以 `student_name` 查無學生（不自動建）；`FEATURE_*` 關閉時的對應路徑；〔修訂 2026-09-24〕補救卷／知識點弱點的學生不存在（`:id` 不合法亦 404）、`PATCH /api/kc/:id` 查無此列、家教指定的題目或學生不存在 |
| 409 | 狀態衝突 | `confirm-paper` 預覽過期／題目已被同學生作答；非 dry_run 組卷時題目被並發指派；`jobs/:id/retry` 狀態不允許；`variants` 來源題無 embedding |
| 413 | 上傳超限 | `POST /api/jobs` PDF 超過 15 MB（凍結於 `docs/interfaces-stage2.md` 第 6.1 條）；〔修訂 2026-09-24〕`POST /api/voice/transcribe` 錄音超過 5 MB |
| 429 | 超出限流 | §4 各限流器；回應帶 `Retry-After`；〔修訂 2026-09-24〕AI 家教＋語音當日預算用完（`TUTOR_DAILY_BUDGET_USD`，訊息「今天的 AI 家教預算已用完…」，不帶 `Retry-After`） |
| 500 | 未預期錯誤 | 全域錯誤中樞；production 不含 `error` 細節欄位 |
| 502 | 上游 LLM 失敗 | `POST /api/assistant` 主控模型呼叫失敗；〔修訂 2026-09-24〕`POST /api/tutor`、`POST /api/voice/transcribe` 的 LLM 端失敗或模型輸出不合 schema |

## 7. 追溯

| 項目 | ID／文件 |
| :--- | :--- |
| 上游（需求決策） | DEC-008（AI 成本受控→限流政策）、DEC-009（僅 LLM 呼叫對外→本機部署前提） |
| 上游（功能需求） | FR-001～FR-017（§5 端點總表逐條對應；FR-017 題源標記由本輪補入〔修訂 2026-08-29〕）；FR-021～FR-035（階段 5）〔修訂 2026-09-24〕 |
| 上游（非功能需求） | NFR-001（認證／CORS／production 不回細節）、NFR-002（各端點限流）、NFR-006（confirm-paper 同交易）；NFR-007（家教／語音每日預算）、NFR-008（錄音不落地）〔修訂 2026-09-24〕 |
| 契約 SSOT | [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)；路由掛載真相 `exam_pro/routes/index.js`、`exam_pro/app.js` |
| 下游 | `../02_ux_ui/ui_spec-*.md`（各頁資料需求）、`../05_qa/test_plan.md`（整合案例 TC-*）、`../06_ops/runbook-llm-cost-quota.md`（429／成本上限處置） |
