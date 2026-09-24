# UI 規格書：學生分頁 (UI Spec – Students) - 家教專用數理題庫系統

> **版本:** v1.1 | **更新:** 2026-09-24 | **狀態:** 活躍
> 🛠 **2026-09-24 修訂**（階段 5 整合回填，分支 `stage5/int-docs`；權威文件 [`docs/grading-and-profile.md`](../../docs/grading-and-profile.md)）：批改卡補錯因 chip、部分給分、學生答案與註記、看答案與詳解（FR-021）；弱點面板補「錯因分布」表、最近錯題列出錯因與部分給分（FR-022）；管理面板補學生檔案（FR-023）；學科篩選改讀 `GET /api/chapter-whitelist`（含化學，FR-026）；同視圖下方新增的補救卷區塊另見 [`ui_spec-remedial.md`](./ui_spec-remedial.md)。修改處以〔修訂 2026-09-24〕行內標記。
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（`ui_spec-<page>.md`）
> 本文件定義學生分頁（`exam_pro/public/js/students.js`，掛入 `index.html` 的空錨點 `<section id="students">`）的區塊、狀態與互動：學生管理（改名／合併／刪除）、試卷列表與批改、弱點面板。「找相似／出變式」的後續請求歸 [ui_spec-variants.md](./ui_spec-variants.md)；組卷入口歸 [ui_spec-main.md](./ui_spec-main.md)。

## 目錄

- [1. 頁面目的 (Page Purpose)](#1-頁面目的-page-purpose)
- [2. 版面配置 (Layout)](#2-版面配置-layout)
- [3. 欄位與元件 (Fields / Components)](#3-欄位與元件-fields--components)
- [4. 使用者操作 (Actions)](#4-使用者操作-actions)
- [5. UI 狀態 (States)](#5-ui-狀態-states)
- [6. 互動規格 (Interaction Spec)](#6-互動規格-interaction-spec)
- [7. 驗證規則 (Validation)](#7-驗證規則-validation)
- [8. 響應式與無障礙 (Responsive / A11y)](#8-響應式與無障礙-responsive--a11y)
- [9. 設計交付 (Design Handoff)](#9-設計交付-design-handoff)
- [10. 追溯](#10-追溯)

## 1. 頁面目的 (Page Purpose)

把家教迴圈接起來：出卷 →（一週後）批改 → 弱點面板 → 錯題找相似／出變式。FEATURE_STUDENTS 關閉時整段不渲染（連空殼都不掛）。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 主頁導覽錨點 `#students`；組卷結果區「立即批改」（`examapp:grade-paper` 事件深連結，直接展開該卷） |
| 出口 | 「找相似／出變式」發 `examapp:variant-request` 事件交給 variants 分頁；同頁其他分頁；〔修訂 2026-09-24〕「找相似」結果列的「加入補救卷」按鈕由 variants.js 畫、事件 `remedial:add` 交給同視圖下方的補救卷區塊（`ui_spec-remedial.md`） |

## 2. 版面配置 (Layout)

```text
標題列 ─ 學生下拉＋學科篩選＋時間窗（近 N 天）＋重新整理＋⚙ 管理學生
#stuManage 管理面板（預設隱藏：每位學生一列 改名/併入/刪除/檔案〔修訂 2026-09-24〕；名字後一行檔案摘要）＋ #stuStatus 狀態列（載入/空/錯誤）
#stuPapers 試卷列表（卡片可展開 → 批改表單；每題：對/錯/未批 → 錯因 chip（按錯才出現）→ 部分給分（計算、證明題）→ 學生答案與註記 → 看答案與詳解〔修訂 2026-09-24〕）
#stuWeakness 弱點面板 ─ 三張表（章節/題型/難度，lg 三欄）→ 錯因分布表〔修訂 2026-09-24〕→ 每週趨勢 SVG → 最近錯題清單
（同視圖下方：#remedial 依弱點出補救卷，見 ui_spec-remedial.md〔修訂 2026-09-24〕）
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 學生（#stuStudent） | select | `GET /api/students` → `items[]` | `姓名（N 卷，已批 P%）`；姓名另存 `data-name`（顯示文字不可反推姓名） |
| 學科（#stuSubject） | select | 〔修訂 2026-09-24〕`GET /api/chapter-whitelist` 的科目（先用 `ExamApp.getChapterWhitelist`，沒有才自己打；不再寫死，含化學）＋「不分科」 | 只影響弱點查詢參數 |
| 時間窗（#stuDays） | select | 固定值 30／90／180／365 | 預設 365（裁決 S4-4：家教是長期視角） |
| 試卷卡 | card | `GET /api/students/:id/papers` | 標題＋`#paper_id`＋日期＋`已批改 g／t 題`＋徽章（已批完／待批改） |
| 批改列 | radiogroup | `GET /api/papers/:id` → `questions[]`（`result: 1/0/null`） | 每題三態按鈕：對／錯／未批；`null` 顯示「未批」 |
| 錯因 chip〔修訂 2026-09-24〕 | toggle 群組（`role="group"`） | `GET /api/error-types` → `items[]`（依題目 `subject` 過濾，`chem_equation` 只給化學題）；已存值 `questions[].error_types` | 只在該題為「錯」時出現；標題「錯因（可複選，最多 5 個）」；清單載入失敗時顯示「錯因清單載入失敗（GET /api/error-types），這次只能記對錯。」 |
| 部分給分〔修訂 2026-09-24〕 | number（%） | `questions[].score`（0–1，顯示為 0–100 的百分比） | 只在已批改的計算題、證明題出現；留空＝不給分 |
| 學生答案與註記〔修訂 2026-09-24〕 | 摺疊區＋兩個 textarea | `questions[].response`、`teacher_note` | 預設收合，已有內容時自動展開；placeholder「學生實際寫的答案或選的選項（選填，500 字內）」「老師註記（選填，500 字內）：例如「移項忘了變號」」 |
| 看答案與詳解〔修訂 2026-09-24〕 | 摺疊區 | `questions[].answer_text`、`solution_text`、`solution_src` | 「標準答案：…」「詳解：…」（經 `renderMath`）；沒有詳解時「這題還沒有文字詳解（可在題庫的編輯視窗補上）。」；另列「詳解來源：老師撰寫／管線驗算時由模型獨立解出、且與答案比對一致的摘要（未經人工審閱）」 |
| 錯因分布〔修訂 2026-09-24〕 | table＋CSS 橫條 | `weakness.by_error_type[]`（label、count、share） | 與三張表同一種橫條；說明「比例＝標了這個錯因的錯題 ÷ 這段期間的錯題數；一題可以標多個錯因，所以加總可能超過 100%。」；label 為 null 時原樣顯示代碼 |
| 學生檔案摘要〔修訂 2026-09-24〕 | 文字 | `GET /api/students` 每列的 grade、track、target_exams、school、textbook_version | 例「高二・自然組・學測／分科・示範高中・龍騰版」；沒填時「（未填檔案）」 |
| 學生檔案表單〔修訂 2026-09-24〕 | select／checkbox／input／textarea | 選項 `GET /api/student-profile-options` | 年級（高一～高三）、類組、目標考試（核取方塊可複選）、學校、教材版本、備註；各選單有「（未填）」 |
| 弱點表 ×3 | table＋CSS 橫條 | `GET /api/students/:id/weakness` → `by_chapter`／`by_type`／`by_difficulty` | `錯誤率%　(wrong/graded，出過 assigned)`；`wrong_rate === null` 顯示「—」（沒批改不等於全對）；`low_sample` 橫條轉灰＋琥珀標籤 |
| 每週趨勢 | inline SVG（無圖表函式庫） | `weakness.trend_weekly[]`（僅有資料的週，不補零） | 灰長條＝該週批改數、紅折線＝錯誤率；跳週段畫虛線；`graded=0` 的點折線斷開 |
| 最近錯題 | list | `weakness.recent_wrong[]` | 最多 20 題、由近到遠；每列附「找相似」（FEATURE_SIMILAR）與「出變式」（FEATURE_VARIANTS）——兩顆按鈕各看各的旗標（裁決 S3-R25）；〔修訂 2026-09-24〕另列「錯因：…」「部分給分 n%」（`error_types`、`score`） |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 切換學生／學科／時間窗 | select change | 重載試卷列表與弱點面板（兩支 API 並行） | 單人系統，`x-api-key` |
| 展開試卷 | 卡片標題列 | 首次展開才 `GET /api/papers/:id`（lazy），渲染批改表單 | 同上 |
| 批改單題 | 對／錯／未批 | 僅改前端狀態；「未批」是可送出的值（`result:null`＝取消批改） | 同上 |
| 未批的全部標為對 | 綠色按鈕 | 未批題整批設 1，已標的不動；仍走同一條 diff→PATCH 路徑 | 同上 |
| 儲存批改 | 儲存批改 | `PATCH /api/papers/:id/results`，只送改過的題（單一交易，全有全無）；成功更新徽章並刷新弱點面板；〔修訂 2026-09-24〕每題只送改過的鍵（`result` 必送，`score`／`error_types`／`response`／`note` 有改才送；清空送 `null`） | 同上 |
| 標錯因〔修訂 2026-09-24〕 | 按「錯」後點 chip | 前端狀態切換；改成「對」或「未批」時錯因自動清空、改成「未批」時部分給分也清空（與伺服器同一條規則） | 同上 |
| 填部分給分／學生答案／註記〔修訂 2026-09-24〕 | 輸入欄 | 前端狀態；隨「儲存批改」一起送 | 同上 |
| 看答案與詳解〔修訂 2026-09-24〕 | 摺疊鈕 | 展開標準答案與詳解（不打 API，資料已在試卷明細內） | 同上 |
| 編輯學生檔案〔修訂 2026-09-24〕 | 管理面板「檔案」→「儲存檔案」 | 首次展開打 `GET /api/student-profile-options`；儲存時 `PATCH /api/students/:id` 只送改過的欄位（清空＝送 null）；成功 toast「已更新「姓名」的檔案。」並更新摘要 | 同上 |
| 改名 | 管理面板 改名 | `PATCH /api/students/:id`；成功後面板與主檢視重載 | 同上 |
| 合併 | 併入下拉＋合併（按兩次確認） | `POST /api/students/:id/merge`；toast 回報搬移的作答／考卷數與衝突處理 | 同上 |
| 刪除 | 刪除（按兩次確認） | `DELETE /api/students/:id`（連作答紀錄與考卷，不可逆） | 同上 |
| 找相似／出變式 | 錯題列按鈕 | 發 `examapp:variant-request` CustomEvent（含 question_id／student_id／chapter／題幹），由 variants.js 接手 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| Loading | #stuStatus；試卷展開區 | 「載入中…」 |
| Empty（無學生） | 下拉佔位＋狀態列引導 | 「（還沒有任何學生）」「題庫裡還沒有學生。先用『智慧組卷』出一張卷，學生就會出現在這裡。」 |
| Empty（無試卷／無弱點資料／無錯題） | 各區塊內嵌空狀態 | 「這位學生還沒有任何試卷。」「這段時間窗內沒有已批改的作答（沒批改不等於全對）。…」「這段時間窗內沒有批改出來的錯題——可能是真的都對，也可能是還沒批改。」 |
| Empty（趨勢圖） | SVG 內置文字 | 「這段時間窗內沒有任何批改紀錄——出卷後記得回來批改，趨勢圖才有東西畫。」 |
| Error | #stuStatus 或 toast；API 錯誤字串凍結、一律原樣顯示 `{message}` | 「連線失敗，請稍後再試。」 |
| API 未上線 | 404 專屬文案 | 「學生 API 尚未上線（GET /api/students 回 404）。可加上 ?mock=1 用手寫假資料預覽版面。」 |
| 旗標關閉 | FEATURE_STUDENTS 關：整段不渲染；SIMILAR／VARIANTS 關：對應按鈕不畫＋附註 | 「FEATURE_SIMILAR 未開啟：『找相似』暫時不可用。」（VARIANTS 同式） |
| Success | toast＋徽章更新 | 「已儲存 N 題的批改結果。」「已合併：搬 X 筆作答、Y 張卷，衝突 Z 筆以本尊為準。」 |
| 錯因清單載入失敗〔修訂 2026-09-24〕 | 批改卡內灰字，錯因 chip 不畫 | 「錯因清單載入失敗（GET /api/error-types），這次只能記對錯。」 |
| Empty（錯因分布）〔修訂 2026-09-24〕 | 表格內嵌 | 「這段時間窗內的錯題還沒有標錯因。批改時按「錯」就能點選錯因，之後這裡會告訴你他最常錯在哪一類。」 |
| 檔案選項載入失敗〔修訂 2026-09-24〕 | 檔案區內紅字 | 「學生檔案選項載入失敗（GET /api/student-profile-options），請重新整理。」 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 儲存批改 | 色階加深 | 請求期間 disabled | — | toast 原樣顯示 `{message}`；無改動時提示「沒有任何改動。」 |
| 合併／刪除 | 底色變化 | — | — | 不可逆操作採「按第二次才執行」（4 秒後自動退回），不用 `window.confirm` |
| 三態批改按鈕 | 未選中者底色變化 | — | — | 選中態以色塊＋`aria-checked` 標示 |
| 找相似／出變式 | 底色變化 | 變式輪詢期間 variants.js 依 `data-variant-action` 整批停用 | — | 由 variants 分頁處理 |
| 立即批改深連結 | — | — | 卡片未渲染時先重載再自動展開並捲至該卷 | 快取無 `paper_id` 時 toast「這張卷還沒有 paper_id，請重新組卷一次。」 |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| 批改筆數 | 一次最多 100 筆（`MAX_PATCH`）；分批會破壞全有全無，前端直接擋下 | 「一次最多儲存 100 筆批改，這次有 N 筆。」 | 點擊儲存 |
| 新名字 | 非空且異於原名，否則不送 | （靜默不送） | 點擊改名 |
| 合併對象 | 必選 | 「先選要併入哪位學生。」 | 二次確認後 |
| 錯因〔修訂 2026-09-24〕 | 只在答錯時可選、每題最多 5 個（`max_per_attempt`）、只列該科適用的代碼 | 「一題最多標 5 個錯因。」 | 點 chip |
| 部分給分〔修訂 2026-09-24〕 | 0～100 的整數（%）或留空；送出時換算成 0～1 | 「部分給分請填 0～100 的整數（%），或留空表示不給分。」 | 輸入 |
| 學生答案／註記〔修訂 2026-09-24〕 | 各 ≤500 字 | 伺服器 400 原樣顯示 | 儲存批改 |
| 學生檔案〔修訂 2026-09-24〕 | 年級、類組、目標考試、教材版本只能選選單值；學校 ≤50 字、備註 ≤500 字 | 無改動時「沒有任何改動。」；其餘伺服器 400 原樣顯示 | 儲存檔案 |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 弱點三張表 `lg` 三欄、以下單欄；標題列與管理面板列 `flex-wrap`。
- **鍵盤操作:** 全部原生 `<button>`／`<select>`；試卷展開為整列按鈕。
- **ARIA / 對比:** 批改組 `role="radiogroup"`＋`aria-label`、選項 `role="radio"`＋`aria-checked`；趨勢 SVG `role="img"`＋`aria-label`，資料點附 `<title>`；`aria-*`／`role` 一律 `setAttribute` 設定；low_sample 以灰條＋文字標籤雙重編碼。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| SSOT | `exam_pro/public/js/students.js`（骨架全由 JS 建立；`index.html` 僅一個空錨點） |
| 元件對照 | 經 `window.ExamApp` 橋接沿用 `apiFetch`／`showToast`／`renderMath`／`escapeHtml`；`getPaperCache`／`showSection` 缺席時僅深連結失效、面板照常 |
| 本機預覽 | `?mock=1` 走檔內假資料（含空週虛線案例）；`?students=1` 等本機手動開旗標 |
| 已知限制 | 學生管理 API 屬核心區（不吃 FEATURE_STUDENTS），但管理面板放在本分頁，旗標關閉時無 UI 入口；〔修訂 2026-09-24〕階段 5 的批改卡、錯因分布與檔案表單只以 miniDom 驗證（`test/unit/gradingUi.test.js`），未在真瀏覽器開過；把「錯」改成「對」時部分給分不會自動清除（`result=1, score=0` 會被補救卷當成全錯），請同時改分數；「未批的全部標為對」會把空白題也記成對，空白題請按「錯」＋「未作答」；合併學生時來源學生的檔案不保留 |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-013（弱點五條 SQL 的呈現）、FR-014（建立在主頁；改名／合併／刪除在此）、FR-015（批改）；NFR-006（批改單一交易）；〔修訂 2026-09-24〕FR-021（批改細節）、FR-022（錯因分布）、FR-023（學生檔案） |
| 對應決策 | DEC-003（合併收攏作答紀錄，維持不重複出題）、DEC-006、DEC-007；DEC-015、DEC-017〔修訂 2026-09-24〕 |
| 對應 ADR | 無專屬 ADR；前端橋接規約沿用 [ADR-003](../03_architecture/adr/ADR-003-code-orchestrated-agent-pipeline.md) 時期的介面凍結制度 |
| 對應情境 | 無（SCN-001～016 皆不落於本頁；批改與弱點面板無對應邊界場景） |
