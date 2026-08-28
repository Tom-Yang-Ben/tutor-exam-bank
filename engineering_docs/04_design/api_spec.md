# API 設計規範 (API Specification) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-08-29 | **狀態:** 活躍 | **OpenAPI 定義:** [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例。本文件維護 API 設計約定、認證／CORS／限流政策、錯誤語意、端點總表與狀態碼慣例；單一端點的請求／回應 schema 細節歸 [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)，路由掛載的單一真相為 `exam_pro/routes/index.js` 與 `exam_pro/app.js`。

> 🛠 **2026-08-29 修訂**（PR #6/#7 程式碼同步）：§2.1 `GET /api/questions` 篩選參數補 `source_type`；§5.1 端點總表補 `GET /api/chapter-volumes`（三層選單資料源）；`POST /api/generate-paper` 說明補 `source_types` 題源過濾；§7 上游 FR 範圍延伸至 FR-017。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。

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
| **版本控制** | 無 URL 版本段；演進採 append-only 路由區塊（階段 1–4 各自的凍結區塊，rebase 衝突兩邊保留） |
| **掛載方式** | 全部路由掛在 `/api` 之下，統一先過 `apiKeyAuth`（`exam_pro/app.js`）；`FEATURE_*` 旗標關閉的路由「不掛載」，請求落到 Express 預設 404 |

## 2. 通用行為

### 2.1 分頁與篩選

`GET /api/questions` 與 `GET /api/jobs/:id/questions` 支援 `page`／`limit` 分頁（頁碼式，非游標式）；前者另支援 `subject`／`chapter`／`question_type`／`q`（關鍵字）／`source_type`（題源標記單值，FR-017；非法值靜默忽略不套用，`questionController.js`）篩選〔修訂 2026-08-29〕。`GET /api/review` 僅提供 `reason` 篩選與 `limit` 上限（預設一次最多 50 筆，無頁碼）。其餘列表端點（`/students`、`/students/:id/papers`）回傳全量或依 controller 內建條件，無分頁參數。

### 2.2 旗標控制掛載

| 旗標（`exam_pro/config/features.js`，預設全關） | 控制的路由群 |
| :--- | :--- |
| `FEATURE_PIPELINE` | **不控制任何路由掛載**——jobs／review 八支恆掛載（`routes/index.js` WS2-A 區塊無旗標包裹）；本旗標僅切換前端上傳入口與複核分頁渲染 |
| `FEATURE_SIMILAR` | 相似題檢索 |
| `FEATURE_VARIANTS` | 變式題 |
| `FEATURE_NLQ` | 自然語言查題 |
| `FEATURE_STUDENTS` | 學生試卷／弱點／批改四支 |
| `FEATURE_ASSISTANT` | 對話式助教 |

旗標關閉時路由不存在（非 403），行為與不存在的路徑一致——Express 預設 404。此規則適用於 SIMILAR／VARIANTS／NLQ／STUDENTS／ASSISTANT 五個旗標；PIPELINE 為唯一例外（管線屬階段 2 核心，路由恆掛載）。

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
- **路由專屬錯誤處理的唯一例外**：`POST /api/jobs` 掛 `handleUploadError` 四參數中介軟體，把 multer 的 `LIMIT_FILE_SIZE` 轉成凍結的 413（裁決見 `docs/interfaces-stage2.md` 第 6.1 條）；`/analyze-pdf` 保留既有行為，同錯誤落到全域中樞成 500。
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

## 5. API 端點總表

端點細節（請求／回應 schema）歸 [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)；本表僅列路由、FR 對應與掛載條件。

### 5.1 核心區（恆常掛載）

| 方法／路徑 | FR | 說明 |
| :--- | :--- | :--- |
| `GET /api/questions` | FR-007 | 題庫列表（篩選＋分頁） |
| `POST /api/questions`、`PUT /api/questions/:id`、`DELETE /api/questions/:id` | FR-007 | 題目 CRUD；出過的題刪除改封存 `archived:true` |
| `POST /api/batch-save-questions` | FR-007 | 批次入庫（白名單硬驗證、部分入庫；`?strict=1` 舊行為） |
| `GET /api/chapters`、`GET /api/chapter-whitelist` | FR-002 | 實際存在章節／完整白名單 |
| `GET /api/chapter-volumes` | FR-002、FR-007 | 分冊結構（科目→冊→單元），前端三層章節選單資料源；唯一真相 `config/chapters.js` 的 VOLUMES〔修訂 2026-08-29〕 |
| `GET /api/students` | FR-014 | 學生清單（裁決 S4-2：組卷下拉恆常需要，不吃旗標） |
| `POST /api/students`、`PATCH /api/students/:id`、`DELETE /api/students/:id` | FR-014 | 建立（唯一新學生入口，裁決 S4-1）／改名／刪除 |
| `POST /api/students/:id/merge` | FR-014 | 學生併名（衝突題保留目標側批改） |
| `POST /api/generate-paper` | FR-008 | 組卷草稿（`dry_run` 預覽、`exclude_ids` 換題；attempts 排除已作答；`source_types` 題源過濾——空陣列或未帶＝不限制、含非法值 400，FR-017〔修訂 2026-08-29〕） |
| `POST /api/confirm-paper` | FR-008 | 確認出卷（同一交易建卷＋attempts；預覽過期回 409） |
| `DELETE /api/papers/:id` | FR-008 | 刪卷連 attempts，題目回候選池（裁決 S4-3） |
| `POST /api/analyze-pdf` | FR-001 | 舊版單呼叫拆題（保留）；限流 10/min、PDF 上限 15 MB |
| `POST /api/download-word` | FR-009 | Word 匯出（LaTeX→OOXML，docx 原生 Math 物件） |
| `POST /api/jobs`（15 MB、超限 413；限流 10/min，與 `/analyze-pdf` 共用同一桶） | FR-001 | 建立拆題 job（恆掛載；FEATURE_PIPELINE 僅控制前端上傳入口） |
| `GET /api/jobs/:id`、`GET /api/jobs/:id/questions`、`POST /api/jobs/:id/retry` | FR-001 | job 狀態／逐題清單／斷點續跑（恆掛載） |
| `GET /api/review`、`GET /api/review/:jqId`、`POST /api/review/:jqId/approve`、`POST /api/review/:jqId/reject` | FR-006 | 人工複核佇列四支（恆掛載） |

### 5.2 旗標區

| 旗標 | 方法／路徑 | FR | 限流 |
| :--- | :--- | :--- | :--- |
| `FEATURE_SIMILAR` | `GET /api/questions/:id/similar` | FR-010 | 60/min |
| `FEATURE_VARIANTS` | `POST /api/questions/:id/variants` | FR-011 | 10/min（獨立桶） |
| `FEATURE_NLQ` | `POST /api/questions/search-nl` | FR-012 | 30/min |
| `FEATURE_STUDENTS` | `GET /api/students/:id/papers`、`GET /api/students/:id/weakness` | FR-013 | — |
| `FEATURE_STUDENTS` | `GET /api/papers/:id`、`PATCH /api/papers/:id/results` | FR-015 | — |
| `FEATURE_ASSISTANT` | `POST /api/assistant` | FR-016 | 10/min |

## 6. 狀態碼慣例

| 狀態碼 | 語意 | 實例 |
| :--- | :--- | :--- |
| 200 | 成功 | 各查詢／更新端點；`variants` 檢索命中（`mode:'retrieved'`） |
| 202 | 已受理，非同步處理中 | `POST /api/jobs`（回 `{job_id, existing}`）；`variants` 進入生成（`mode:'generating'`）；`POST /api/jobs/:id/retry` |
| 400 | 參數無效或業務前置條件不足 | 組卷剩餘題數少於抽題數（家族互斥後計算）；batch-save 白名單驗證失敗 |
| 401 | 認證失敗 | 缺少或錯誤的 `x-api-key`（僅 `API_KEY` 已設定時） |
| 404 | 資源不存在，或旗標關閉的路由未掛載 | `generate-paper` 以 `student_name` 查無學生（不自動建）；`FEATURE_*` 關閉時的對應路徑 |
| 409 | 狀態衝突 | `confirm-paper` 預覽過期／題目已被同學生作答；非 dry_run 組卷時題目被並發指派；`jobs/:id/retry` 狀態不允許；`variants` 來源題無 embedding |
| 413 | 上傳超限 | `POST /api/jobs` PDF 超過 15 MB（凍結於 `docs/interfaces-stage2.md` 第 6.1 條） |
| 429 | 超出限流 | §4 各限流器；回應帶 `Retry-After` |
| 500 | 未預期錯誤 | 全域錯誤中樞；production 不含 `error` 細節欄位 |
| 502 | 上游 LLM 失敗 | `POST /api/assistant` 主控模型呼叫失敗 |

## 7. 追溯

| 項目 | ID／文件 |
| :--- | :--- |
| 上游（需求決策） | DEC-008（AI 成本受控→限流政策）、DEC-009（僅 LLM 呼叫對外→本機部署前提） |
| 上游（功能需求） | FR-001～FR-017（§5 端點總表逐條對應；FR-017 題源標記由本輪補入〔修訂 2026-08-29〕） |
| 上游（非功能需求） | NFR-001（認證／CORS／production 不回細節）、NFR-002（各端點限流）、NFR-006（confirm-paper 同交易） |
| 契約 SSOT | [`openapi-exam-pro-v1.yaml`](./openapi-exam-pro-v1.yaml)；路由掛載真相 `exam_pro/routes/index.js`、`exam_pro/app.js` |
| 下游 | `../02_ux_ui/ui_spec-*.md`（各頁資料需求）、`../05_qa/test_plan.md`（整合案例 TC-*）、`../06_ops/runbook-llm-cost-quota.md`（429／成本上限處置） |
