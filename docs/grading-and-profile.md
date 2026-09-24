# docs/grading-and-profile.md — 批改細節、學生檔案與文字詳解

> 版本 v1.0 | 2026-09-24 | 分支 `stage5/ws-a` | 對應：`docs/interfaces-stage5.md` 第 4.1 條（WS-A）、缺口 G03／G05／G09、DEC-015、DEC-017、ADR-015
> 本檔是 WS-A 三項功能的權威文件：API、資料、設計取捨與給老師的操作說明。共用文件（`engineering_docs/**` 的 api_spec、openapi、db_design、各 tracker，`README.md`，`docs/HANDOFF.md`）由整合階段依本檔回填，WS-A 沒有動。
> migrations 沒有新增：用的是 `stage5/base` 已建好的 `0010`（attempts 批改細節、students 檔案欄位）與 `0011`（questions 文字詳解）。WS-A 也沒有新的環境變數與功能旗標（第 1.3 條：WS-A 屬既有核心流程的延伸）。

## 目錄

- [1. 三件事一句話](#1-三件事一句話)
- [2. 給老師的操作說明](#2-給老師的操作說明)
- [3. API](#3-api)
- [4. 資料](#4-資料)
- [5. 設計取捨](#5-設計取捨)
- [6. 與契約不同或契約沒寫的地方](#6-與契約不同或契約沒寫的地方)
- [7. 測試](#7-測試)
- [8. 檔案清單](#8-檔案清單)

## 1. 三件事一句話

| 缺口 | 做了什麼 | 為什麼 |
| :--- | :--- | :--- |
| G03 批改只有 0/1 | 批改時可以記錯因（可複選）、部分給分、學生實際答案與老師註記；弱點面板多一張「錯因分布」 | 知道「錯幾題」之外，還要知道「為什麼錯」（DEC-015） |
| G09 學生檔案只有姓名 | 學生多了年級、類組、目標考試、學校、教材版本與備註 | 診斷與出題要知道學生的應學範圍（DEC-017） |
| G05 題目沒有詳解 | 題目多一段文字詳解：管線驗算時已經解出來的摘要自動寫入、老師可以在編輯視窗寫或改；Word 可以匯出學生版與詳解版 | verify 節點本來就為每一題解過一次、而且與答案比對過，只是沒存進題庫（DEC-017） |

## 2. 給老師的操作說明

### 2.1 批改：記下為什麼錯

1. 到「學生」分頁，選學生，點試卷標題展開批改區（或組卷後按「立即批改」）。
2. 每一題照舊按「對／錯／未批」。按「**錯**」之後，下面會出現一排**錯因**小方塊，可以點好幾個（最多 5 個）：觀念不清、方法選錯、計算錯誤、審題錯誤、單位或有效數字、公式記錯、粗心抄錯、未作答、時間不足；化學題另外有「化學式或係數」。
   - 學生**空白沒寫**的題，請按「錯」再點「未作答」。不要用下面那顆「未批的全部標為對」，它會把空白題也記成對。
3. **計算題與證明題**批改後會出現「部分給分 ___ %」。填 0～100 的整數，例如寫對一半就填 50；留空表示只看對錯。
4. 「學生答案與註記」可以記下學生實際寫的答案（例如選了 (B)）和你的一句話註記（例如「移項忘了變號」），各 500 字內。已經有內容的題會自動展開。
5. 「看答案與詳解」可以對照標準答案與文字詳解；詳解下面會標示來源（驗算模型產生的摘要或老師寫的）。
6. 按「**儲存批改**」。只會送出改過的題，整批一次寫入，有任何一題不合法就整批不寫，畫面會說明是哪一題。

幾條會自動發生的規則：

- 把「錯」改成「對」或「未批」，那一題的錯因會自動清掉（答對的題不該有錯因）。
- 改成「未批」（取消批改）時，部分給分也會清掉；學生答案與註記保留。
- 「化學式或係數」只能標在化學題上。

### 2.2 看錯因分布

弱點面板在章節、題型、難度三張表下面多了「**錯因分布**」：每個錯因標了幾題、占這段期間錯題的幾成。一題可以標好幾個錯因，所以比例加起來可能超過 100%；錯了但沒標錯因的題也算在分母裡。最近錯題清單也會列出每題標過的錯因與部分給分。

### 2.3 編輯學生檔案

「學生」分頁右上的「⚙ 管理學生」→ 每位學生那一列的「**檔案**」→ 填年級（高一～高三）、類組、目標考試（可複選）、學校、教材版本、備註 →「儲存檔案」。只會送出改過的欄位；清空欄位＝清掉那一項。學生名字後面會顯示一行摘要，例如「高二・自然組・學測／分科・示範高中・龍騰版」。

### 2.4 題目的文字詳解

- **新上傳的考卷**：拆題管線驗算時，驗算模型會自己把題目解一次；它算出來的答案與拆出來的答案**一致**時，它的解題摘要會自動存成這題的詳解（來源標示「驗算」）。不一致、無法判定或證明題不會存。
- **以前入庫的題**：執行一次回填（不花錢、不呼叫 AI）：

  ```bash
  cd exam_pro
  npm run solution:backfill -- --dry-run      # 先看會補幾題、略過幾題、為什麼略過
  npm run solution:backfill -- --limit 20     # 先小批補 20 題，打開幾題看看
  npm run solution:backfill                   # 全部補
  ```

  可以重複跑：已經有詳解的題（尤其是你寫的）一律不動；入庫之後你改過題幹或答案的題不會補（那份摘要解的是改之前的題目）。從複核佇列核准入庫的題也要靠這支補。
- **自己寫或修改**：題庫管理 → 題目的「✏️ 編輯」→ 最下面的「文字詳解」，公式照樣用 `$...$`，下方有即時預覽。改寫之後來源會變成「老師撰寫」；清空就是刪掉詳解。只改別的欄位、沒動詳解時，詳解與來源都不會變——**例外**：詳解來源是「驗算」而你改了題幹或答案，那段驗算摘要會一併清掉（它解的是改之前的題目）；需要的話請在同一個視窗重寫詳解。題庫列表上有詳解的題會多一個「有詳解」標籤。

> 驗算摘要是模型寫的，限 400 字、偏精簡，而且**沒有經過人工審閱**。發給學生之前，建議先在編輯視窗讀過一遍。

### 2.5 Word 匯出版本

組卷確認後，「下載 Word 考卷」旁邊多了版本選單：

| 版本 | 內容 | 檔名 |
| :--- | :--- | :--- |
| 標準版（預設，與以前相同） | 題目＋卷末參考答案 | `卷名.docx` |
| 學生版 | 只有題目，不附答案 | `卷名（學生版）.docx` |
| 詳解版 | 題目＋卷末每題答案，答案後面接詳解；詳解裡的公式同樣是 Word 原生方程式。沒有詳解的題標「（本題尚無文字詳解）」 | `卷名（詳解版）.docx` |

## 3. API

全部掛在 `apiKeyAuth` 之後。既有端點的形狀、錯誤訊息與檢查順序都沒有改，下面只列新增或擴充的部分。

### 3.1 `PATCH /api/papers/:id/results`（擴充；`FEATURE_STUDENTS`）

`results[i]` = `{ question_id, result, score?, error_types?, response?, note? }`

| 鍵 | 規則 | 沒送 | 送 `null` |
| :--- | :--- | :--- | :--- |
| `result` | 0／1／null，必填（語意不變） | 400（既有） | 取消批改：`graded_at`、`score`、`error_types` 一併清掉，`response`、`note` 保留 |
| `score` | 0～1、最多兩位小數；只能搭配 `result` 為 0 或 1 | 不動 | 清空 |
| `error_types` | `config/errorTypes.js` 的代碼陣列；不重複、最多 5 個、只能在 `result = 0` 時非空、代碼要適用該題科目；存成白名單順序 | 不動（但 `result` ≠ 0 時一律清空） | 清空（等於 `[]`） |
| `response` | 字串 ≤500 字（以 code point 計，trim；空字串＝null） | 不動 | 清空 |
| `note` | 同上，寫進 `attempts.teacher_note` | 不動 | 清空 |

新增的 400 訊息（既有六個之後才檢查；同一份 body 違反既有規則時仍回既有訊息）：

| 情況 | message |
| :--- | :--- |
| score 型別或值域 | `score 必須是 0～1、最多兩位小數的數字，或 null。` |
| score 搭配 result null | `score 只能搭配 result 為 0 或 1。` |
| error_types 不是陣列 | `error_types 必須是陣列或 null。` |
| 白名單外的代碼 | `error_types 含有不在白名單內的代碼：<code>。` |
| 重複 | `error_types 不可重複。` |
| 超過 5 個 | `error_types 最多 5 個。` |
| result ≠ 0 卻有錯因 | `error_types 只能在 result 為 0（答錯）時填寫。` |
| response／note | `response 必須是字串或 null，且不得超過 500 字。`／`note 必須是字串或 null，且不得超過 500 字。` |
| 科目不適用（交易內查題目科目，排在「不在這張試卷內」之後） | `題目 <id> 是<科目>題，不能標記「<標籤>」（<code>）。` |

仍是單一交易、全有全無；回應仍是 `{ updated }`。

### 3.2 `GET /api/papers/:id`（擴充；`FEATURE_STUDENTS`）

`questions[]` 每題多：`subject`、`chapter`、`answer_text`、`solution_text`、`solution_src`、`score`（數字或 null）、`error_types`（陣列，沒有 attempts 列時為 `[]`）、`response`、`teacher_note`。`solution_src` 是契約以外多帶的一欄（見第 6 條）。

### 3.3 `GET /api/students/:id/weakness`（擴充；`FEATURE_STUDENTS`）

- 既有五個鍵之後多一個 `by_error_type: [{ error_type, label, count, share }]`。
  - 分母＝時間窗與科目篩選內 `result = 0` 的作答數（沒標錯因的錯題也算）；`share` 四捨五入到小數第 4 位，分母為 0 時 null。
  - 只看 `result = 0` 的列；排序 `count DESC, error_type ASC`（`error_type` 以 `COLLATE "C"` 比，與機器的 collation 無關）。
  - `label` 由 `config/errorTypes.js` 的 `labelOf` 補上；資料庫裡有白名單外的代碼時 `label` 為 null，列照樣回。
  - 不排除已封存題（同既有五張表）。
- `recent_wrong[]` 每列在既有四欄之後多 `error_types`、`score`。
- SQL：`services/weaknessService.js` 檔尾新增 `buildByErrorType(opts)`，參數 `$1 = studentId、$2 = days、$3 = subject`，沿用 `AGG_WHERE` 與 CTE 外包。`recent_wrong` 的 SQL 是凍結的，批改細節由 controller 以 `(student_id, question_id)` 另查一次補上（見第 5.3 條）。

### 3.4 `GET /api/error-types`（新增；`FEATURE_STUDENTS`，關閉時不掛載）

```json
{ "items": [{ "code": "concept", "label": "觀念不清", "subjects": null }, …, { "code": "chem_equation", "label": "化學式或係數", "subjects": ["化學"] }], "max_per_attempt": 5 }
```

批改卡的錯因 chip 從這裡讀，前端不另抄一份清單。

### 3.5 學生檔案（核心區，不吃旗標）

- `GET /api/students`：每列在 `id, name, papers, graded_ratio` 之後多 `grade, track, target_exams, school, textbook_version, note`。
- `POST /api/students`：`name` 必填（規則與訊息不變），另可帶檔案欄位的任意子集。回 201 與完整一列（`id, name` ＋六欄）。
- `PATCH /api/students/:id`：`name` 與六個檔案欄位的任意子集，沒送的不動；有送 `name` 時規則與訊息照舊（400／409）。一個可改的欄位都沒送回 400 `至少要提供一個要修改的欄位（name、grade、track、target_exams、school、textbook_version、note）。`。回 200 與完整一列。
- `GET /api/student-profile-options`（新增）：`{ grades, tracks, target_exams, textbook_versions, school_max_length, note_max_length }`，學生檔案表單的選項。

白名單（`config/studentProfile.js`）：

| 欄位 | 合法值 | 400 message |
| :--- | :--- | :--- |
| `grade` | 10、11、12（數字）或 null | `grade 只接受 10、11、12 或 null。` |
| `track` | 自然組、社會組、未分組，或 null（空字串＝null） | `track 只接受 自然組、社會組、未分組 或 null。` |
| `target_exams` | 學測、分科、統測、段考、其他 的子集（null＝`[]`；存成白名單順序） | `target_exams 必須是 … 的子集。`／`target_exams 不可重複。` |
| `school` | ≤50 字或 null（trim；空字串＝null） | `school 必須是字串或 null，且不得超過 50 字。` |
| `textbook_version` | 龍騰、翰林、南一、泰宇、三民、全華、康熹、其他，或 null | `textbook_version 只接受 … 或 null。` |
| `note` | ≤500 字或 null | `note 必須是字串或 null，且不得超過 500 字。` |

### 3.6 文字詳解

- `GET /api/questions`（列表）每題多 `solution_text`、`solution_src`。
- `GET /api/questions/:id`（新增，核心區）：題目詳情，含詳解；**已封存的題也查得到**（帶 `archived_at`）。不回 `embedding`、`search_tsv`。`:id` 不是正整數回 400 `無效的題目 ID`，不存在回 404 `找不到該題目`。
- `POST /api/questions`：可帶 `solution_text`（≤4000 字或 null）。非空 → `solution_src = 'teacher'`；沒帶或空白 → 兩欄 NULL。
- `PUT /api/questions/:id`：**沒帶 `solution_text` 鍵＝不動**，唯一的例外見下一點。帶了：null 或空白 → 兩欄 NULL；與現值（trim 後）逐字相同 → 保留原來源；其他 → 寫入並標 `teacher`。
- 〔整合階段新增〕**沒帶 `solution_text`、現有詳解的來源是 `verify`，而 `question_text` 或 `answer_text` 真的改了**（與舊值比較；送來的值先 trim，`answer_text` 空白照舊存成「略」）→ 兩欄一併清成 NULL。那份驗算摘要解的是改之前的題目、比對的是改之前的答案，留著會讓批改卡與 Word 詳解版把舊解法接在新答案後面（與回填腳本略過 `edited` 同一個理由，第 5.5 條）。`teacher` 來源不動（老師自己決定要不要改詳解）；有帶 `solution_text` 時照上一點的規則走。
- 400：`詳解最多 4000 字。`、`詳解必須是文字或 null。`（驗證在開交易之前）。

### 3.7 `POST /api/download-word`（擴充）

body 多一個 `edition`：沒送（或 null）＝`standard`（現行行為），`student`、`solution`；其他值（含空字串）回 400 `edition 只接受 standard、student、solution。`。既有的 `question_ids` 檢查排在它前面。

### 3.8 `npm run solution:backfill -- [--dry-run] [--limit N] [--test] [--report <檔案>]`

見第 2.4 條與第 5.5 條。印出掃描題數、回填題數、依原因分類的略過題數與題號。

## 4. 資料

| 表.欄 | 寫入者（本 WS） | 說明 |
| :--- | :--- | :--- |
| `attempts.score` NUMERIC(3,2) | PATCH results | 部分給分 0～1；NULL＝沒給分，由 `result` 決定對錯 |
| `attempts.error_types` TEXT[] | PATCH results | 錯因代碼；`result ≠ 0` 時恆為 `{}`；未作答＝`result = 0` 且含 `blank` |
| `attempts.response`、`teacher_note` | PATCH results | 各 ≤500 字 |
| `students.grade`、`track`、`target_exams`、`school`、`textbook_version`、`note` | POST／PATCH students | 全部可為 NULL（`target_exams` 為空陣列）；既有學生不必回填 |
| `questions.solution_text`、`solution_src` | save 節點（verify）、POST／PUT（teacher）、回填腳本（verify） | 兩欄同 NULL 或同非 NULL（`questions_solution_pair_check`）；`ai` 保留給之後 |

給其他 WS 讀的語意（第 2 條）：

- 「答對程度」可以用 `COALESCE(score, result)`（WS-D 的知識點弱點就是這樣算）。`score` 只在老師有給部分分數時才非 NULL。
- `error_types` 只會出現在 `result = 0` 的列；要算錯因請一律加 `result = 0`，不要假設別人也守這條。
- `solution_text` 可能是 NULL，也可能是模型寫、未經審閱的摘要（`solution_src = 'verify'`）。拿去給學生看或餵給家教時要標示來源。

## 5. 設計取捨

### 5.1 錯因白名單放 config、前端從 API 讀

同 `config/chapters.js`：白名單會長，改一次不該需要一支 migration；伺服器是唯一的驗證點。代碼**只能新增、不能改名或刪除**——舊資料裡的代碼改名後會變成「不認得的代碼」。前端的 chip 清單從 `GET /api/error-types` 讀；`students.js` 裡的 `MOCK.errorTypes` 只是 `?mock=1` 排版用的節錄，正式路徑不會讀到。

### 5.2 PATCH 用 jsonb_to_recordset，並以 has_* 分開「沒送」與「清空」

`error_types` 本身是陣列，PG 的多維陣列要求每列等長，既有的「每欄一個陣列參數 + unnest」裝不下「這題 2 個錯因、那題 0 個」。改成一個 jsonb 參數、`jsonb_to_recordset` 展開，每列帶 `has_score`、`has_error_types`、`has_response`、`has_note` 旗標——`COALESCE` 分不出「沒送」與「送 null」。仍是一句 UPDATE，不逐題來回。錯因依白名單順序存：同一組錯因不論老師先點哪個，存進去都一樣，前端比對「有沒有改」才不會誤判。

### 5.3 recent_wrong 的批改細節另查一次

契約只允許在 `weaknessService.js` 檔尾新增 `buildByErrorType`，`buildRecentWrong` 的 SQL 凍結。所以 controller 在六條聚合查完之後，以 `(student_id, question_id)`（唯一鍵）把那 ≤20 題的 `error_types`、`score` 補上。多一次來回，但凍結的 SQL 與它的單元測試完全不動。

### 5.4 錯 → 對時自動清錯因（沒送 error_types 也清）

契約說「可選鍵沒送就不動」，同時說「error_types 只能在 result = 0 時非空」。兩者在「只送 `result: 1` 把錯改成對」時會衝突：不動就會留下「答對卻有錯因」的列，錯因分布會把對的題算進去。這裡讓不變量優先：`result ≠ 0` 時 `error_types` 一律清空。`score`、`response`、`note` 則照「沒送不動」。詳見第 6 條。

### 5.5 詳解來源分權、回填不覆寫也不猜

- 來源三種：`verify`（管線驗算、與答案比對一致的摘要）、`teacher`（老師寫或改）、`ai`（保留）。老師 PUT 的文字與現值相同時保留原來源：在編輯視窗改了別的欄位按儲存，不該讓一段模型寫的詳解被標成「老師寫的」。前端也只在老師真的動過詳解欄時才送 `solution_text`（列表資料可能比回填舊，沒改卻送會把新回填的詳解洗掉）。
- save 節點與回填腳本共用 `workers/jobRunner.js` 的 `buildSolutionFields`：`payload.verify.compare === 'agree'` 且 `steps_summary` trim 後非空、≤4000 字。判定看 `compare` 不看 outcome（payload 只留得下 data）。超長不截斷：截一半的詳解比沒有更會誤導。
- 回填只補 `solution_text IS NULL` 的題（UPDATE 本身也帶這個條件，與老師同時存檔不會互蓋）；**題幹或答案在入庫後被改過**的題不補——摘要解的是改之前的題目。一題對到多列 `job_questions` 時取 id 最小且可用的一列。整批一個交易，`--dry-run` 在交易內真的跑完再 ROLLBACK，報的數字包含上述閘門的效果。
- 複核佇列核准入庫（`reviewController.approve`）不寫詳解：契約只授權 save 節點（第 4.1 條「僅 save 時寫詳解」），核准入庫的題靠回填腳本補（腳本對「核准時改過題幹或答案」的題同樣會略過）。

### 5.6 Word 版本

`standard` 走原本的產生路徑（逐位元相同的段落序列）；`student` 連分頁帶答案區一起不產生；`solution` 在每題答案後接詳解，詳解走同一支 `buildParagraphComponents`，公式轉 OMML。版本名以白名單驗證，controller 回 400、`generateExamPaperDocx` 再丟一次錯（第二道）。訂正卷（只收該生錯題）不在本階段範圍（缺口表 TEACH-11 的 correction 版本），沒有做。

### 5.7 學生檔案：PATCH 從「改名」變成「部分更新」

`name` 從必填變成「有送才改」，但只送 `name` 的既有請求行為與訊息完全不變（前端的改名按鈕照舊只送 `name`）。回應從 `{ id, name }` 擴成完整一列（只多不少）。欄位名只會來自 `PROFILE_FIELDS` 白名單，動態組 SET 不會有注入問題。

## 6. 與契約不同或契約沒寫的地方

| # | 項目 | 做法 | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | 錯 → 對且沒送 `error_types` | 自動清空錯因 | 「沒送不動」與「只能在 result = 0 時非空」衝突時，以不變量為準（第 5.4 條） |
| 2 | `GET /api/papers/:id` 多帶 `solution_src` | 契約以外多一欄（只多不少） | 批改卡要標示詳解是模型寫的還是老師寫的 |
| 3 | 新增 `GET /api/questions/:id`、`GET /api/student-profile-options`、`GET /api/error-types` | 三支唯讀端點，掛在 `routes/index.js` 檔尾的 WS-A 區塊 | 契約寫了「題目詳情」但既有程式沒有這支；另兩支讓前端不必另抄白名單（第 4.1 條第 7 項的提示） |
| 4 | `POST`／`PATCH /api/students` 的回應多帶檔案欄位 | 只多不少 | 前端儲存後不必再打一次清單 |
| 5 | `PATCH /api/students/:id` 空 body 的訊息 | 由「學生姓名必填…」改為「至少要提供一個要修改的欄位（…）」 | name 已不是必填；只送 name 的請求行為與訊息不變 |
| 6 | PUT 帶與現值相同的詳解 | 保留原來源（不改成 teacher） | 第 5.5 條 |
| 7 | 回填略過「入庫後題幹或答案被改過」的題 | 列為 `edited` | 避免把舊題目的解法貼到新題目上 |
| 8 | ADR 編號 | ADR-015 | 契約第 6 條沒有分配 WS-A 的 ADR 編號；取下一個未用的號碼，整合時可重編 |
| 9 | 既有測試的修改 | `test/integration/students.pg.test.js` 四處形狀斷言加上新欄位（標〔stage5 WS-A〕） | 契約刻意擴充了 `GET /api/students` 每列、`recent_wrong` 每列與 weakness 的頂層鍵；斷言仍是逐欄 deepEqual，另外多釘了既有欄位的順序，沒有放寬 |
| 10 | 〔整合階段〕PUT 改了題幹或答案、沒帶詳解、來源是 `verify` | 兩欄清成 NULL（第 3.6 條） | WS-A 審查 low：舊摘要解的是舊題目。`test/integration/solutions.pg.test.js` 原本斷言「改題幹、沒帶詳解 → verify 維持」的那一條因此改寫（標〔stage5 整合〕），「題幹與答案沒變 → 不動」照舊斷言 |

## 7. 測試

| 層 | 檔案 | 內容 |
| :--- | :--- | :--- |
| 單元 | `test/unit/errorTypes.test.js` | 十個代碼、標籤、適用科目逐字凍結；`isValidErrorType`、`labelOf` |
| 單元 | `test/unit/studentProfile.test.js` | 白名單、`parseProfile` 的「沒送／送 null」、每個 400、code point 計數 |
| 單元 | `test/unit/gradingDetail.test.js` | PATCH 解析（既有六個訊息與順序不變、新規則不搶先、四個可選鍵）、`buildByErrorType` 的凍結規則、controller 後處理 |
| 單元 | `test/unit/solutionText.test.js` | `buildSolutionFields`、`normalizeSolutionText`、回填的參數與規劃（來源、原因分類、edited、多列、limit、不 require LLM）、Word 三種版本的 document.xml |
| 單元 | `test/unit/gradingUi.test.js` | `students.js` 的新純函式；以 miniDom 跑起學生分頁驗錯因 chip（依科目、上限、載入失敗）、部分給分、註記、答案與詳解、送出的 PATCH body、錯因分布表、最近錯題、學生檔案表單 |
| 整合 | `test/integration/grading.pg.test.js` | PATCH 四個鍵的寫入、不動、清空、錯→對、取消批改、每個 400 與 ROLLBACK、化學錯因、100 筆；GET 明細新欄位；錯因分布的分母、排序、四捨五入、科目與時間窗、只算答錯、封存；`/api/error-types` 與旗標 404 |
| 整合 | `test/integration/studentProfile.pg.test.js` | 選項端點（旗標關閉也在）、POST／PATCH 的子集更新與每個 400／404／409、清單的欄位順序、合併 |
| 整合 | `test/integration/solutions.pg.test.js` | 題目 POST／PUT／列表／詳情的詳解欄位與來源規則、save 節點寫詳解（一致／證明題／空摘要）、回填（dry-run、正式、重跑、limit、CLI 輸出）、Word 三種版本與 400 |

執行：`/home/claude/ci.sh <worktree>/exam_pro <測試庫>`（unit、check:html、migrate、integration、e2e、五個 eval）。沒有新的 cassette，也沒有任何 LLM 呼叫。

## 8. 檔案清單

新增：`exam_pro/config/errorTypes.js`、`exam_pro/config/studentProfile.js`、`exam_pro/scripts/backfill_solutions.js`、本檔、`engineering_docs/03_architecture/adr/ADR-015-grading-detail-and-solution-provenance.md`、上表八支測試。

修改：`controllers/paperController.js`、`controllers/studentController.js`、`controllers/studentAdminController.js`、`controllers/questionController.js`、`controllers/wordController.js`、`services/weaknessService.js`（只在檔尾新增）、`services/wordService.js`、`workers/jobRunner.js`（只在 save 寫詳解）、`routes/index.js`（檔尾 WS-A 區塊）、`public/js/students.js`、`public/index.html`（題目編輯 modal 的詳解欄、題庫列表的「有詳解」標籤、Word 版本選單）、`package.json`（`solution:backfill`）、`test/integration/students.pg.test.js`（第 6 條第 9 項）。
