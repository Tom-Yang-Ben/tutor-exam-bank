# ADR-015: 批改細節以 attempts 加欄與伺服器端白名單記錄，文字詳解分來源並以 verify 摘要零成本回填 - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-24 | **狀態:** 提議（實作於 `stage5/ws-a`；需求側 DEC-015、DEC-017 待 Owner 簽核）
> **Owner:** Ben（楊本顥） | **決策狀態:** 提議（AI 依 `docs/interfaces-stage5.md` 第 4.1 條實作；AI 不代填核准）
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答兩件事：①「為什麼錯」要怎麼記，才能讓診斷、補救卷與 AI 家教都讀得到；②題目詳解從哪裡來、怎麼標示可信度。API、訊息與操作說明歸 [`docs/grading-and-profile.md`](../../../docs/grading-and-profile.md)，欄位定義歸 `exam_pro/migrations/0010`、`0011`。
> **編號說明:** `docs/interfaces-stage5.md` 第 6 條只分配了 ADR-010～013，沒有 WS-A 的編號；本檔取下一個未用的 014，整合階段可重編。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 2026-09-24 缺口分析的結論是「瓶頸在資料模型，不在 AI」。批改只記 0／1（缺口 G03），答不出「為什麼錯」；學生檔案只有姓名（G09）；題目沒有詳解（G05），但 verify 節點其實已經為每一題獨立解過一次、答案也比對過，那份 `steps_summary` 只存在 `job_questions.payload` 裡，沒有進題庫。
- **問題**:
  1. 錯因、部分給分、學生答案要記在哪裡、用什麼值域，才能讓弱點面板（WS-A）、知識點弱點與補救卷（WS-D）、AI 家教（WS-E）直接讀，而且不破壞既有的弱點 SQL 與 1,000 筆 fixture 的整合測試？
  2. 詳解的來源有模型也有老師，可信度不同；要怎麼補齊既有題目、怎麼讓讀的人知道這段詳解能不能直接給學生看？
- **驅動因素/約束**:
  - 既有 cassette 一律不得失效（第 1.1 條），任何新 LLM 呼叫都要花錢、要錄 cassette。
  - 弱點面板的五條 SQL 是凍結的（參數順序、CTE 形狀），`result` 的語意不能變。
  - 單人使用、資料量小；錯因白名單一定會再長（化學加入時已經多一個）。
  - 家教的批改習慣是「只圈錯的」，空白題過去會被「未批全部標為對」記成答對（DIAG-12）。

## 2. 考量的選項

### 問題一：批改細節

#### 選項 A：attempts 加欄，錯因用 TEXT[]、合法值由伺服器白名單驗證（採用）
- **描述**: `attempts` 加 `score NUMERIC(3,2)`、`error_types TEXT[]`、`response`、`teacher_note`；`result` 不變。錯因代碼放 `config/errorTypes.js`，PATCH 驗證、`GET /api/error-types` 給前端。「未作答」＝`result = 0` 且含 `blank`。
- **優點**: 舊查詢全部相容（只加欄）；一次 UPDATE 寫完；錯因分布一條 `unnest` 聚合；白名單改動不需要 migration，延續 ADR-005 的伺服器端白名單模式。
- **缺點**: DB 層不擋白名單外的值（直接改 DB 可以寫進怪代碼）；一題多錯因使比例加總可能超過 100%，要在畫面上說明。
- **成本/複雜度**: 低

#### 選項 B：另開 attempt_errors 關聯表（一列一個錯因）
- **描述**: `attempt_errors(attempt_id, code)`，外鍵到錯因字典表。
- **優點**: DB 層有參照完整性；可以替每個錯因加欄位（例如嚴重度）。
- **缺點**: 批改一次要寫兩張表、刪卷與合併學生要多處理一張表；錯因字典表每加一個代碼要一支 migration；弱點查詢要多一次 JOIN。以家教的資料量換不到實際好處。
- **成本/複雜度**: 中

#### 選項 C：錯因寫進 CHECK 約束
- **描述**: `error_types <@ ARRAY[...]` 的 CHECK。
- **優點**: DB 層擋值域。
- **缺點**: 每加一個代碼要 DROP／ADD CHECK；化學加入時就會撞上。與 `questions.chapter` 放棄 CHECK 的理由相同。
- **成本/複雜度**: 低（但改動成本高）

### 問題二：詳解來源

#### 選項 D：`solution_text` ＋ `solution_src`（verify／teacher／ai），verify 摘要零成本回填（採用）
- **描述**: 管線 save 節點在 `verify.compare = 'agree'` 且摘要非空時寫入 `solution_src = 'verify'`；既有題目以 `scripts/backfill_solutions.js` 從 payload 回填，不呼叫 LLM；老師在編輯視窗寫或改時標 `teacher`，且不被回填覆寫。
- **優點**: 零模型成本、零 cassette 影響；只收「與答案比對一致」的摘要，至少答案是對的；來源欄讓批改卡、Word、AI 家教都能標示「未經人工審閱」。
- **缺點**: 摘要限 400 字、偏精簡，不是教學級詳解；證明題與比對不一致的題沒有詳解；入庫後改過題目的題無法回填。
- **成本/複雜度**: 低

#### 選項 E：另請 LLM 為每題生成教學級詳解
- **描述**: 新 agent 讀題目與答案，產出分步詳解。
- **優點**: 品質較好、可以涵蓋證明題。
- **缺點**: 每題一次呼叫的成本；需要新的 cassette 與 eval 才能量品質；與「先用已有資料」的快贏定位相反。保留為之後的 `ai` 來源。
- **成本/複雜度**: 中～高

## 3. 決策

**選擇**: 問題一採選項 A；問題二採選項 D。

**理由**:
- 選項 A 讓既有的弱點 SQL、`result` 語意與整合測試完全不動，新聚合（錯因分布）只在 `weaknessService.js` 檔尾加一支，沿用凍結的參數順序；白名單在伺服器端與 ADR-005 一致，且化學只需要多一列設定。
- 不變量「錯因只存在於 `result = 0` 的列」由 PATCH 強制（錯改對時自動清空），聚合查詢再加 `result = 0` 作第二道，讀的人（WS-D、WS-E）不必自己猜。
- 選項 D 把已經付過錢的驗算結果收進題庫，並用來源欄誠實標示可信度；`teacher` 永不被機器覆寫，回填可以重複跑、有 `--dry-run` 與 `--limit`。判定規則只有一份（`workers/jobRunner.js` 的 `buildSolutionFields`），save 與回填不會走鐘。

## 4. 後果

- **正面**: 「為什麼錯」開始累積成資料，錯因分布即時可看；補救卷與 AI 家教有 `COALESCE(score, result)`、`error_types`、`solution_text` 可讀；Word 可出學生版與詳解版；不需要任何新的 LLM 呼叫或 cassette。
- **負面**: DB 層不擋白名單外的錯因代碼（面板以 `label = null` 原樣顯示，讓人看得見）；錯因比例可超過 100%，需要說明；verify 摘要未經人工審閱，發給學生前要讀過；`recent_wrong` 的批改細節多一次查詢（凍結 SQL 的代價）。
- **影響範圍**: `exam_pro/config/errorTypes.js`、`exam_pro/config/studentProfile.js`、`exam_pro/controllers/paperController.js`、`studentController.js`、`studentAdminController.js`、`questionController.js`、`wordController.js`、`exam_pro/services/weaknessService.js`（檔尾）、`wordService.js`、`exam_pro/workers/jobRunner.js`（save）、`exam_pro/scripts/backfill_solutions.js`、`exam_pro/public/js/students.js`、`exam_pro/public/index.html`。
- **重新評估觸發**: 需要替錯因加屬性（嚴重度、對應迷思）或依錯因出題（缺口 G16）時，評估改為選項 B；老師回報 verify 摘要常不足以教學，或證明題詳解需求變高時，啟用選項 E 的 `ai` 來源；錯題重練（DEC-003 例外、缺口 G11）拆分「派題」與「作答」時，批改細節欄隨作答紀錄一起搬遷。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-015、DEC-017；缺口分析 G03、G05、G09（DIAG-1、DIAG-11、DIAG-12、TEACH-1、TEACH-2、TEACH-11） |
| 影響範圍 | `docs/grading-and-profile.md`、`docs/interfaces-stage5.md` 第 2、3.1、4.1 條、`exam_pro/migrations/0010_attempt_detail_student_profile.sql`、`0011_chemistry_solution_subject_group.sql` |
| 取代關係 | 無；延續 [ADR-005](./ADR-005-server-side-whitelist-validation.md) 的伺服器端白名單模式，並遵守 [ADR-006](./ADR-006-cassette-record-replay.md) 的 cassette 不失效前提 |
