# 資訊架構 (Information Architecture) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L2（橋接）
> **實例:** 單例（全站一份）
>
> **MECE 邊界**：本文件只談**全站結構**——單頁殼與分頁錨點總覽、導覽、URL／錨點規則、旗標控制的顯示、跨分頁資料載體。
> 單頁規格歸各 `ui_spec-*.md`；後端 API 合約歸 `exam_pro/routes/index.js` 與 04_backend 文件；旗標的伺服器端掛載策略歸 03_architecture 文件（單一真相為 `exam_pro/config/features.js`）。

設計原則（質化）：全站為單一 HTML 殼（`exam_pro/public/index.html`），零打包器；每個分頁一個錨點 `<section>`、一個主要目標；旗標關閉的分頁整段不渲染（非隱藏）；導覽深度 1 層（頂欄錨點直達）。

---

## 目錄

- [1. 頁面總覽（單頁殼＋分頁錨點）](#1-頁面總覽單頁殼分頁錨點)
- [2. 導覽結構](#2-導覽結構)
- [3. URL 結構與路由表](#3-url-結構與路由表)
- [4. 旗標控制的顯示](#4-旗標控制的顯示)
- [5. 跨分頁資料模型](#5-跨分頁資料模型)
- [6. 檢查清單](#6-檢查清單)
- [7. 追溯](#7-追溯)

## 1. 頁面總覽（單頁殼＋分頁錨點）

全站僅一條頁面路由 `/`，由 `app.js` 的 `serveIndex` 送出 `exam_pro/public/index.html`；「分頁」是同頁內依 DOM 順序排列的錨點區塊，捲動導覽（`scroll-behavior: smooth`＋`scroll-mt-24` 補償 sticky 頂欄）。

| # | 錨點 | 分頁名稱 | 主要職責（單一） | 內容來源 | 對應 FR |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | `#top` | Hero／工作流導引 | 三步工作流說明與入口 CTA | index.html 靜態 | — |
| 1 | `#create` | 建立題目 | 手動建題＋PDF 上傳拆題 job | index.html inline script | FR-001、FR-007 |
| 2 | `#paper` | 智慧組卷 | 選學生／章節→草稿→確認→Word 匯出 | index.html inline script | FR-008、FR-009、FR-014（快速建學生） |
| 3 | `#review` | 人工複核佇列 | needs_review 逐題核可／退回 | `public/js/review.js` | FR-006 |
| 4 | `#students` | 學生管理 | 學生 CRUD／併名、試卷批改、弱點面板 | `public/js/students.js` | FR-013、FR-014、FR-015 |
| 5 | `#variants` | 變式題 | 檢索優先出變式、偏題閘門 | `public/js/variants.js` | FR-010、FR-011 |
| 6 | `#nlq` | 自然語言查題 | 中文查詢→解析→回寫題庫篩選 | `public/js/nlq.js` | FR-012 |
| 7 | `#assistant` | 對話式助教 | 主控 LLM＋只讀工具問答、dry-run 出卷預覽 | `public/js/assistant.js` | FR-016 |
| 8 | `#library` | 題庫管理 | 題目列表、篩選、檢視、維護 | index.html inline script | FR-007 |

**總計:** 1 條頁面路由、9 個錨點區塊。#3–#7 在殼內僅是空 `<section>`（index.html 545、552–554、558 行），內容全部由對應 ES module 動態建立；`#nlq` 位於 `#library` 之前（其間僅隔 `#assistant`），對應階段 3 規劃「題庫管理搜尋框旁」的落點。各分頁欄位與互動細節見 [`ui_spec-main.md`](./ui_spec-main.md)、[`ui_spec-review.md`](./ui_spec-review.md)、[`ui_spec-students.md`](./ui_spec-students.md)、[`ui_spec-nlq.md`](./ui_spec-nlq.md)、[`ui_spec-variants.md`](./ui_spec-variants.md)、[`ui_spec-assistant.md`](./ui_spec-assistant.md)。

---

## 2. 導覽結構

| 項目 | 連結 | 顯示條件 |
| :--- | :--- | :--- |
| 品牌標誌（Tutor Question Lab） | `#top` | 永遠顯示 |
| 建立題目 | `#create` | 永遠顯示（md 以上斷點；行動裝置隱藏整條導覽） |
| 智慧組卷 | `#paper` | 同上 |
| 學生 | `#students` | 同上（旗標關閉時錨點仍在，捲至空區塊） |
| 助教 | `#assistant` | 同上（同前） |
| 題庫管理 | `#library` | 同上 |
| Hero CTA「開始建立題目」／「瀏覽現有題庫」 | `#create`／`#library` | 永遠顯示 |

- 頂欄為 sticky（`z-40`），各錨點以 `scroll-mt-24` 避免標題被遮擋；`#review`、`#variants`、`#nlq` 不設頂欄導覽項，由流程入口到達（複核佇列由拆題結果進入、變式與查題內嵌於題庫脈絡）。
- 麵包屑：無（單頁、深度 1 層，無需求）。
- 返回機制：瀏覽器 back 依 hash 歷史回捲；無顯式 back button。

---

## 3. URL 結構與路由表

前端無 client-side router：URL 僅 `/`＋hash 錨點（`/#paper` 可分享、可書籤）。資料操作全部走 `/api/*`，`app.js` 對 `/api` 全域套用 `apiKeyAuth`（x-api-key，timing-safe，NFR-001）；金鑰由 `serveIndex` 以 `__API_KEY__` 佔位注入 `<meta name="api-key">`。API 全表以 `exam_pro/routes/index.js` 為準（核心區＋各階段 append-only 區塊），下表列 IA 相關對應：

| 分頁錨點 | 主要 API | 認證 | 旗標 | 限流 |
| :--- | :--- | :--- | :--- | :--- |
| `#create` | `POST /api/jobs`、`GET /api/jobs/:id(/questions)`、`POST /api/questions`、`POST /api/analyze-pdf`（舊流程） | x-api-key | 無（jobs 前端入口受 FEATURE_PIPELINE 控制） | 10/min（jobs、analyze-pdf） |
| `#paper` | `GET /api/students`、`POST /api/generate-paper`、`POST /api/confirm-paper`、`POST /api/download-word`、`DELETE /api/papers/:id` | x-api-key | 無（核心功能不掛旗標，裁決 S4-2） | — |
| `#review` | `GET /api/review`、`GET /api/review/:jqId`、`POST /api/review/:jqId/approve|reject` | x-api-key | FEATURE_PIPELINE | — |
| `#students` | `GET /api/students/:id/papers|weakness`、`GET/PATCH /api/papers/:id(/results)`、`POST/PATCH/DELETE /api/students*` | x-api-key | FEATURE_STUDENTS（管理五支為核心區） | — |
| `#variants` | `POST /api/questions/:id/variants`；`GET /api/questions/:id/similar` | x-api-key | FEATURE_VARIANTS；FEATURE_SIMILAR（兩支獨立開關，裁決 S3-R25） | 10/min；60/min |
| `#nlq` | `POST /api/questions/search-nl` | x-api-key | FEATURE_NLQ | 30/min |
| `#assistant` | `POST /api/assistant` | x-api-key | FEATURE_ASSISTANT | 10/min |
| `#library` | `GET /api/questions`、`PUT/DELETE /api/questions/:id`、`GET /api/chapters`、`POST /api/batch-save-questions` | x-api-key | 無 | — |

單人使用、單一角色（家教老師本人），無角色矩陣；URL 與 hash 不含 token 或內部 ID。

---

## 4. 旗標控制的顯示

旗標（`exam_pro/config/features.js`，預設全關）同時控制**前後端兩層**，語意一致：

| 旗標 | meta 注入點（serveIndex replaceAll） | 前端行為（關閉時） | 後端行為（關閉時） |
| :--- | :--- | :--- | :--- |
| FEATURE_PIPELINE | `<meta name="feature-pipeline">` | review.js 整段不渲染，`#review` 維持空 section | jobs／review 路由仍掛載（管線屬階段 2 核心） |
| FEATURE_STUDENTS | `<meta name="feature-students">` | students.js 整段不渲染 | 四支學生檢視／批改路由不掛載→404 |
| FEATURE_NLQ | `<meta name="feature-nlq">` | nlq.js 整段不渲染 | search-nl 不掛載→404 |
| FEATURE_VARIANTS | `<meta name="feature-variants">` | variants.js 整段不渲染 | variants 不掛載→404 |
| FEATURE_SIMILAR | `<meta name="feature-similar">` | 學生分頁「找相似」入口不渲染 | similar 不掛載→404 |
| FEATURE_ASSISTANT | `<meta name="feature-assistant">` | assistant.js 整段不渲染 | /api/assistant 不掛載→404 |

規則：各 module 以 `parseBool` 讀 meta；佔位字串未被替換時判為 false＝安全預設（旗標讀法見 interfaces-stage2.md 第 8 條；「不得只是隱藏，須整段不渲染」見 interfaces-stage3.md 第 7.2 條）。後端一律「不掛載→Express 預設 404」，不回傳旗標狀態。

---

## 5. 跨分頁資料模型

| 來源 | 目標 | 載體 | 資料內容 | 為何選此載體 |
| :--- | :--- | :--- | :--- | :--- |
| 伺服器（serveIndex） | 全部 module | `<meta>` 標籤（7 個注入點） | api-key、六個 FEATURE_* | 零打包器下唯一的伺服器→前端組態通道；module 各自讀取、互不耦合 |
| 頂欄／Hero | 各分頁 | URL hash（`#paper` 等） | 目標區塊 | 可分享、可書籤、back 自然 |
| `#nlq` 解析結果 | `#library` 篩選列 | DOM 回寫（filter 控件） | 學科／章節／題型／關鍵字 | 解析結果即篩選狀態，回寫後沿用既有查詢流程（FR-012） |
| `#paper` 草稿 | 確認出卷 | in-page state（resultBox） | 草稿題目清單 | 草稿為過渡狀態，確認（confirm-paper）才與作答歷史同交易入庫（NFR-006） |
| `#create` 拆題 job | `#review` | 伺服器狀態（jobs／job_questions） | needs_review 佇列 | 跨分頁共享的真相在 DB，前端不傳遞 |

載體選擇原則：可分享的位置狀態放 hash；伺服器組態走 meta 注入；業務狀態一律以 API／DB 為真相，不建前端全域 store。

---

## 6. 檢查清單

- [x] 每個分頁錨點在 §1 有單一職責，且有對應 `ui_spec-*.md`
- [x] 每支 API 的認證與旗標已明確（§3、§4）
- [x] 導覽深度 1 層，sticky 頂欄錨點直達
- [x] URL／hash 語義化、可分享、不含機密
- [x] 旗標關閉時前端整段不渲染、後端 404，兩層語意一致（§4）
- [x] 跨分頁資料載體符合 §5 原則

---

## 7. 追溯

| 項目 | ID／文件 |
| :--- | :--- |
| 上游需求決策 | DEC-001、DEC-005、DEC-006、DEC-007、DEC-009 |
| 上游功能需求 | FR-001、FR-006、FR-007、FR-008、FR-009、FR-010、FR-011、FR-012、FR-013、FR-014、FR-015、FR-016 |
| 上游非功能需求 | NFR-001（x-api-key／CORS）、NFR-006（草稿→確認同交易） |
| 下游文件 | `ui_spec-main.md`、`ui_spec-review.md`、`ui_spec-students.md`、`ui_spec-nlq.md`、`ui_spec-variants.md`、`ui_spec-assistant.md` |
| 來源碼 | `exam_pro/public/index.html`（殼與錨點）、`exam_pro/routes/index.js`（路由全表）、`exam_pro/config/features.js`（旗標） |
