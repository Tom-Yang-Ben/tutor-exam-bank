# ADR-010: 化學走「卷別分流」(Subject-Group Routing for Chemistry) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受（實作於 `stage5/ws-b`；需求側 DEC-019 待 Owner 簽核）
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「題庫加入化學時，為何以上傳時指定的卷別分流、讓數學／物理凍結舊模板與 schema，而不是直接把化學併進同一組 prompt 與 enum」；API、排版子集、答案比對與操作說明歸 [`docs/chemistry.md`](../../../docs/chemistry.md)，介面凍結歸 `docs/interfaces-stage5.md` 第 3.2、3.3、4.2 條。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 題庫原本只有數學與物理（66 章）。DEC-019 要求加入高中化學（108 課綱，44 章），並讓化學題走完同一條拆題管線、之後的相似題、變式、NLQ、組卷、批改與 Word 匯出都能用。拆題管線的每個 LLM 節點都以 cassette 回放（[ADR-006](./ADR-006-cassette-record-replay.md)），cassette 鍵含 schemaHash 與模板雜湊；CI 的五個 eval 與既有測試必須在不重錄的情況下維持全綠。
- **問題**: 化學要用到的 prompt（化學式寫法、化學章節白名單）與 schema 值域（subject、chapter 的 enum）都不同於數學／物理。怎麼加入化學，才不會讓既有 cassette 全數失效、也不讓數學／物理題的拆題品質因為 prompt 變長或值域變大而漂移？
- **驅動因素/約束**:
  - schema 的 `subject`／`chapter` enum 進了 schemaHash：值域多一科，數學／物理的每一支 cassette 都失效，重錄要真的 LLM、要錢，且重錄後的輸出與原本不保證相同（eval 數字會跳）。
  - Gemini 的 structured output 無法「依 subject 切換 chapter enum」（[ADR-005](./ADR-005-server-side-whitelist-validation.md)），值域越大、跨科錯配的機會越多，只能靠伺服器端 `isValidChapter` 擋。
  - 一份考卷幾乎不會同時有化學與數學：老師上傳時就知道這份是哪一科。
  - Word 匯出是自製的 LaTeX→OMML 解析器（[ADR-004](./ADR-004-custom-latex-ooxml-over-pandoc.md)），化學式需要 mhchem 的 `\ce{…}`。

## 2. 考量的選項

### 選項一: 化學直接併進同一組 prompt 與 schema（單一路徑，110 章）
- **描述**: `config/chapters.js` 加入化學後，所有 agent 繼續讀 `SUBJECTS`／`CHAPTERS`，prompt 列三科白名單、enum 變成 110 章；SYSTEM 改成「數學、物理與化學家教」。
- **優點**: 只有一條路徑，程式最少；混科考卷也能拆。
- **缺點**: 全部既有 cassette 失效、五個 eval 必須重錄（違反第 1.1 條）；數學／物理的 prompt 變長、enum 變大，拆題與分類品質可能退步卻無法用既有 golden 對照（對照基準也一起變了）；化學式規範混進數理 prompt，數理題的 LaTeX 風格可能被污染。
- **成本/複雜度**: 低（程式）／高（重錄與回歸風險）

### 選項二: 依題目科目自動判斷（先拆題、再依 subject 選模板）
- **描述**: extract 維持單一路徑，但讓模型先判斷科目；後續節點依 subject 選化學或數理模板。
- **優點**: 老師不必選卷別。
- **缺點**: extract 本身就是要用哪一組 prompt 與 schema 的那一步——它的 enum 若不含化學就拆不出化學題，含了就回到選項一的 cassette 問題；要不然就得先多一次「判斷科目」的呼叫，每份卷多付一次錢，判斷錯時整份卷走錯模板。
- **成本/複雜度**: 中

### 選項三: 卷別分流（採用）
- **描述**: 上傳時指定 `subject_group`（`math_physics` 預設／`chemistry`），存在 `jobs.subject_group`。數學／物理沿用凍結的 agent 名、模板、SYSTEM 與 schema，**一個字都不動**；化學另立 agent 名（`extract_chem`、`classify_chem`、`lint_chem`、`verify_chem`、`variant_chem`，也是 cassette 子目錄名）、模板（註冊字串＝SYSTEM＋`'\n---\n'`＋模板）與 schema 變體（`buildSchema(name, { group: 'chemistry' })`：subject＝化學、chapter＝44 章）。逐題節點以題目科目為準（比卷別精準），extract 只看卷別。會進既有 LLM 呼叫的白名單文字改讀 `LEGACY_*`（併入化學之前的兩科 66 章，逐字相同）。
- **優點**: 既有 cassette、eval 數字與測試全部不變；化學的值域只有 44 章、只有一科，跨科錯配在 schema 層就擋掉；化學 prompt 可以專心寫化學式、結構式、實驗裝置的規範；新的模板把 SYSTEM 納入 cassette 鍵，順手避開既有模板「SYSTEM 不在鍵內」的缺口。
- **缺點**: 老師要多選一個欄位，選錯要重傳（冪等鍵因此改為 `(pdf_sha256, subject_group)`）；混科考卷只能擇一；每個 agent 多一組 SYSTEM／模板要維護；化學路徑沒有 cassette 與 CI eval，要另外錄製才量得到分數。
- **成本/複雜度**: 中

## 3. 決策

**選擇**: 選項三——卷別分流。數學／物理凍結舊模板與 schema；化學另立 agent 名、模板與 schema 變體。

**理由**:
- 第 1.1 條「既有 cassette 一律不得失效」是硬約束，只有選項三在不重錄的情況下滿足它；分流之後，數學／物理的請求（agent 名、模板、SYSTEM、schema 實例、prompt 文字）與階段 5 之前逐欄相同，並由單元測試與 base 版逐字比對確認。
- 「這份卷是哪一科」老師在上傳時就知道，讓人給一個欄位，比讓模型多付一次錢去猜可靠；逐題節點再以題目本身的科目覆寫，讓化學題的變式不必另外標卷別。
- 化學式排版不另寫解析器：`\ce{…}` 先轉成等價的一般 LaTeX（`\mathrm` 化學式、下標、上標電荷、箭頭）再交給既有的遞迴下降解析器，延續 [ADR-004](./ADR-004-custom-latex-ooxml-over-pandoc.md)；`formulaLint` 的放行是解析器支援的結果，不是另開後門。
- 答案比對不因科目分兩套：單位與化學式的比對只在「兩邊都認得」時介入，其餘沿用既有規則，`eval/golden/answer.json` 的 250 個案例結果不變。

## 4. 後果

- **正面**: 既有 cassette、五個 eval 的數字、全部既有測試不變；化學題可走完整條管線並被下游功能使用；化學 schema 的值域小，跨科錯配在 schema 層就被擋；化學模板的 cassette 鍵含 SYSTEM。
- **負面**: 每個 LLM agent 多一組化學 SYSTEM／模板（五組）；化學路徑目前沒有 cassette，CI 量不到化學的拆題與分類品質，只有 `npm run eval:classify-chem`（不在 CI 清單，未錄製時略過）；NLQ 的 LLM 輔路徑與助教的工具說明書（都屬凍結的 SYSTEM／模板）仍只寫數學與物理；`\mathrm` 改為正體對所有科目生效（排版規範上是修正）；上傳多一個欄位、冪等鍵加入卷別。
- **影響範圍**: `exam_pro/config/chapters.js`、`config/chapterAliases.js`、`config/chapterExamples.js`、`agents/schemas/index.js`、`agents/promptParts.js`、`agents/extract.js`、`agents/classify.js`、`agents/lint.js`、`agents/verify.js`、`agents/generateVariant.js`、`agents/source_check.js`、`workers/jobRunner.js`、`controllers/jobController.js`、`services/variantService.js`、`services/nlqService.js`、`utils/nlqHeuristics.js`、`utils/tokenize.js`、`utils/chemFormula.js`（新）、`utils/units.js`（新）、`utils/textFormatter.js`、`utils/answerCompare.js`、`public/index.html`、`public/js/review.js`、`public/js/students.js`、`public/js/nlq.js`、`eval/classify_chem.js`（新）。
- **重新評估觸發**: 出現大量混科考卷（例如自然科綜合卷）；或數學／物理的 cassette 因其他原因必須全面重錄（屆時可評估把兩條路徑的 SYSTEM 納入鍵、統一成以科目為參數的單一模板）；或化學 eval 錄製後的分類正確率明顯低於數理（需檢討化學模板或章節切法）；或 Owner 定稿的章節表與草稿差異大到需要遷移已入庫的化學題。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-019、缺口 G01（claude.ai 專案文件 `claude/gap-analysis-2026-09-24.md`）、`docs/interfaces-stage5.md` 第 1.1、1.2、3.2、3.3、4.2 條 |
| 影響範圍 | `docs/chemistry.md`、`migrations/0011_chemistry_solution_subject_group.sql`（base 已建）、`docs/interfaces-stage5.md` |
| 取代關係 | 無；延伸 [ADR-003](./ADR-003-code-orchestrated-agent-pipeline.md)（同一條確定性管線、不同模板）、[ADR-004](./ADR-004-custom-latex-ooxml-over-pandoc.md)（化學式走同一個解析器）、[ADR-005](./ADR-005-server-side-whitelist-validation.md)（伺服器端白名單仍是最終閘門）、[ADR-006](./ADR-006-cassette-record-replay.md)（既有 cassette 不失效） |
