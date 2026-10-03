# docs/student-report.md — 學習報告（老師版、家長版）

> 〔dec/r16-remedial〕Owner 2026-10-03：學生頁要能產一份學習報告，給自己看，也能印給家長。
> 程式：`exam_pro/services/studentReportService.js`（組裝、建議規則、HTML）、`exam_pro/services/studentReportDocx.js`（Word）、
> `exam_pro/controllers/reportController.js`；畫面在 `exam_pro/public/js/students.js` 的「學習報告」那一列。

---

## 1. 一句話

**選一位學生，按「列印報告」或「下載 Word」，就有一份這段期間的學習報告；不呼叫 LLM，同一天、同一份資料產生的報告逐字相同。**

- 給老師（`teacher`）：保留錯因代碼、錯誤率、樣本不足標記，建議寫「該做什麼」。
- 給家長（`parent`）：白話、不出現內部代碼（錯因代碼、建議代碼、題號、知識點代碼、`low_sample` 之類的鍵都沒有），
  數字寫成「6 題錯 4 題」，建議寫「接下來會怎麼加強」。
- 學生姓名會出現在報告裡（報告留在本機）；不送進任何 LLM，不寫 log。

---

## 2. API：`GET /api/students/:id/report?days=&audience=&format=`

掛在 `FEATURE_STUDENTS` 之後（學生分頁的一部分；關閉時不掛載，落到 Express 預設 404）。只讀、不寫庫。

| 參數 | 規則 | 預設 |
|---|---|---|
| `days` | 1–365 的整數：看近幾天（派題日在時間窗內的作答） | 30 |
| `audience` | `teacher`／`parent` | `teacher` |
| `format` | `json`／`html`（可列印的完整頁，`text/html`）／`docx`（Word 下載，`Content-Disposition: attachment; filename*=UTF-8''學習報告-<姓名>(<起>_<迄>)[（家長版）].docx`） | `json` |

同名參數給兩次、值不在範圍 → 400；`:id` 不是正整數或學生不存在 → 404。

老師版（`format=json`）：

```json
{ "student": { "id": 3, "name": "王小明" }, "audience": "teacher", "generated_on": "2026-10-03",
  "period": { "days": 30, "from": "2026-09-03", "to": "2026-10-03" }, "min_n": 5,
  "summary": { "papers": 3, "assigned": 20, "graded": 18, "correct": 11.5, "correct_rate": 0.6389 },
  "weakest_chapters": [{ "chapter": "向量內積", "graded": 8, "wrong": 5, "wrong_rate": 0.625, "low_sample": false }],
  "error_types": [{ "code": "concept", "label": "觀念不清", "count": 4, "share": 0.5 }],
  "weekly_trend": [{ "week_start": "2026-09-21", "graded": 6, "wrong": 1, "correct_rate": 0.8333 }],
  "retrain": { "active": 4, "mastered": 2, "stuck": 1, "first_retrain": { "graded": 3, "correct": 2, "rate": 0.6667 }, "spaced": { "graded": 0, "correct": 0, "rate": null }, "due_now": 2 },
  "remedial_effect": { "papers": 1, "counts": { "improved": 1, "no_change": 0, "worse": 0, "insufficient_data": 0, "pending": 0 },
                       "units": [{ "name": "向量內積", "status": "improved", "before_rate": 0.2, "after_rate": 0.8, "after_graded": 4, "low_sample": true }] },
  "suggestions": [{ "code": "weak_chapter", "text": "「向量內積」錯誤率 63%（批改 8 題、錯 5 題）：建議用「依弱點出補救卷」出一份補救卷。" }] }
```

家長版只留：`student.name`、`audience`、`generated_on`、`period`、`summary`（`papers`、`graded`、`correct_rate`）、
`weakest_chapters`（`chapter`、`graded`、`wrong`）、`error_types`（`label`、`count`）、`weekly_trend`（`week_start`、`graded`、`correct_rate`）、
`retrain`（`practicing`、`mastered`）、`remedial_effect.units`（`name`、`result`：進步／持平／退步／資料不足；還沒批改完的不列）、
`suggestions`（`text`；只列有家長版說法的建議）。

---

## 3. 每一節怎麼算

| 節 | 來源 | 規則 |
|---|---|---|
| 期間 | 本地時區的今天往前 `days` 天 | 查詢用與弱點面板相同的 `assigned_at >= CURRENT_DATE - days` |
| 批改量 | 檢視 `attempts` | 只算每題**第一次**作答（R10）；答對＝`COALESCE(score, result)` 的總和；`papers`＝這些作答分布在幾張卷 |
| 最弱的章節 | `weaknessService.buildByChapter`（同弱點面板） | 有批改的章，依錯誤率由高到低最多 5 章；錯＝`result = 0`；`low_sample`＝批改 < `WEAKNESS_MIN_N` |
| 錯因分布 | `weaknessService.buildByErrorType`（同弱點面板） | `share` 的分母是時間窗內的錯題數；標籤讀 `config/errorTypes.js` |
| 每週趨勢 | `weaknessService.buildTrendWeekly` | 每週（週一起）批改量與答對率 |
| 錯題重練 | `retrainStatsService.stats`（同「重練成效」） | **只有 `FEATURE_RETRAIN` 開啟才列**，否則 `null` |
| 補救成效 | `remedialEffectService.loadRemedialEffect`（`docs/remedial.md` 第 10 節） | **只有 `FEATURE_REMEDIAL` 開啟才列**，否則 `null`；每個單位只看最新那一份補救卷；還沒套 0022 的庫這一節是 `null`，報告照出 |

---

## 4. 建議的規則（`buildSuggestions`；順序固定，最多 6 條）

| 代碼 | 什麼時候出現 | 老師版 | 家長版 |
|---|---|---|---|
| `no_data` | 時間窗內沒有任何批改（出現時只有這一條） | 先批改最近的卷 | 這段期間還沒有批改完成的練習 |
| `weak_chapter` | 樣本夠（≥ `WEAKNESS_MIN_N`）且錯誤率 ≥ **0.4** 的章，最多 2 章 | 建議出補救卷 | 「X」還不太穩，接下來會加強 |
| `error_focus:<代碼>` | 錯因第一名至少 **2** 次、占錯題 ≥ **40%**、而且不同票 | 錯因 + `config/remedialErrorStrategy.js` 的理由與補救卷的調整 | 每種錯因一句白話（`PARENT_ERROR_TEXT`） |
| `trend_up`／`trend_down` | 至少 2 週各批改 ≥ **3** 題；最近一週的答對率比之前各週合計高（低）≥ **0.10** | 維持／檢查是不是太快 | 有在進步／會再多留意 |
| `retrain_stuck` | 重練有卡關的題（`FEATURE_RETRAIN`） | 換方式講解或改用變式 | 會換個方式說明 |
| `retrain_due` | 有到期的重練題 | 下次出卷附上 | （不列：操作指示） |
| `remedial_improved`／`remedial_worse` | 補救成效有進步／退步的單位（`FEATURE_REMEDIAL`） | 補救有效／回頭檢查先備觀念 | 已經有進步／還需要再加強 |
| `need_more_data` | 有錯題、但批改不到 `WEAKNESS_MIN_N` 題的章 | 錯誤率只供參考 | （不列） |

門檻都是 `studentReportService.js` 的具名常數（`WEAK_RATE`、`DOMINANT_MIN_COUNT`、`DOMINANT_MIN_SHARE`、`TREND_MIN_GRADED`、`TREND_DELTA`、`MAX_SUGGESTIONS`），**待 Owner 確認**。

---

## 5. 畫面與輸出

- 學生分頁的弱點面板最下方多一列「學習報告」：選期間與「老師版／家長版」，按「**列印報告**」開新視窗（伺服器產的 HTML，
  內嵌樣式、不連外部資源、`@media print` 版面），用瀏覽器的列印即可；按「**下載 Word**」存 .docx。
  報告用 `apiFetch` 取回再交給瀏覽器（金鑰標頭照常帶得到）；瀏覽器擋彈出視窗時會提示。
- **期間是報告自己的選單**（`public/js/students.js` 的 `REPORT_DAYS_OPTIONS`，預設 `REPORT_DEFAULT_DAYS` = 30，
  與伺服器端 `DEFAULT_DAYS` 相同），**不跟著上方面板的「近 N 天」**。面板預設 365 天（裁決 S4-4：家教是長期視角），
  但報告要講的是近況，一份「近一年總結」當月度回報會被整年的資料稀釋；兩個用途各自一個選單，畫面與助教（不帶 `days`）
  看到的也就是同一個期間。
- Word 用與考卷匯出同一套 `docx` 套件與排版慣例（標題置中、Heading 1 分節、表格），內容與 HTML 一致。考卷匯出的
  `generateExamPaperDocx` 是專為題目與答案區寫的，報告另寫 `studentReportDocx.js`，沒有改考卷匯出的任何一行。

---

## 6. 測試

| 層 | 檔案 | 驗什麼 |
|---|---|---|
| 單元 | `test/unit/studentReport.test.js` | 報告形狀與確定性、每一條建議規則的觸發與不觸發、最多 6 條、家長版沒有內部代碼、HTML 跳脫與不連外、Word 內容、查詢參數、R10、前端網址、報告期間選單的預設與伺服器端一致 |
| 整合 | `test/integration/studentReport.pg.test.js` | 老師版與家長版（真資料、R10）、html、docx、補救成效與重練兩節跟著旗標、400／404、旗標關閉；助教的補救卷工具（假 LLM） |
"""
