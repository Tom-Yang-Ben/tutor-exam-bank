# 測試追蹤簿 (QA Tracker) - 家教專用數理題庫系統

> **版本:** v1.4 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（本檔為發布快照；`qa_tracker.xlsx` 由本檔轉出，人工維護欄位以本檔為準）
> **定位:** 本文件回答「每條 FR 由哪些測試案例覆蓋、執行證據與 eval 門檻為何」；需求與 Gate 見 [requirements_tracker](../01_requirements/requirements_tracker.md)，模組落點見 [engineering_tracker](../03_architecture/engineering_tracker.md)。

> 🛠 **2026-08-29 修訂**（PR #3–#7 程式碼同步）：§1 新增 TC-009-3（矩陣原生 OMML 二維排版）、TC-017-1（source_type 端到端）、TC-018-1（bbox 附圖裁切）；§2.1 測試數 單元 1,415→1,445、整合 259→260；CI 全綠 commit 0ff47b4→f8f6574（§1 導語與 §2.1 各一處）。本輪所有修改處均以〔修訂 2026-08-29〕行內標記。
> 🛠 **2026-09-15d 修訂**（測試數同步）：②執行證據 單元 1,445→1,476、整合同步至 262（main f2af3c2 實測，2026-09-15 晚間）。修改處以〔修訂 2026-09-15d〕行內標記。
> 🛠 **2026-09-15e 修訂**（feat/follow-up-links）：§1 新增 TC-019-1～TC-019-4（承上題綁定）；§2.1 單元 1,476→1,499（本分支實測）；整合數待本分支新增案例於測試庫實跑後更新。修改處以〔修訂 2026-09-15e〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/follow-up-links 審查修正）：TC-019-* 狀態改為實跑結果並補跨塊塊尾被丟、刪除前題 409、綁定失敗不影響複核／管線、變式題不綁等案例；TC-019-5 新增；§2.1 單元 1,499→1,507、整合 262→290、e2e 11（本分支實跑）。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15f 修訂**（feat/source-check）：§1 新增 TC-020-1～3（原卷文字層比對）、TC-006-1 原因八種→九種；②執行證據 單元 1,476→1,534、整合 262→269（feat/source-check 實測）；§3 上游補 FR-020。修改處以〔修訂 2026-09-15f〕行內標記。
> 🛠 **2026-09-15 合併同步**（feat/follow-up-links 併入 feat/source-check）：②執行證據 單元 1,565（其後原卷比對審查修正補 2 項單元測試，現況 1,567）／整合 297／e2e 11（合併後實跑）；§3 上游補 FR-019。上列兩分支修訂列所載之各分支實測數與範圍為當時紀錄，保留不改。合併重算處以〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕雙標記。
> 🛠 **2026-09-15g 修訂**（feat/follow-up-paper-group，FR-019 PR2）：§1 新增 TC-019-8（組卷整組抽取，單元 19 項＋整合 8 項；審查修正後裝箱改子集和）。§2 全域執行證據數由主線合併時統一更新，本分支不動。修改處以〔修訂 2026-09-15g〕行內標記。
> 🛠 **2026-09-16 修訂**（feat/follow-up-protect-badge，FR-019 PR3）：§1 新增 TC-019-6～7。②執行證據之全域測試數未改（由主線合併時統一更新）。修改處以〔修訂 2026-09-16〕行內標記。
> 🛠 **2026-09-16b 修訂**（主線同步，PR #30–#33 合併後）：②執行證據同步為單元 1,613／整合 317／e2e 11（PR #30–#33 併入 main 後 CI 實測）。修改處以〔修訂 2026-09-16b〕行內標記。
> 🛠 **2026-09-24 修訂**（階段 5 整合回填，分支 `stage5/int-docs`）：§1 新增 TC-021-1～TC-035-2（依各 WS 回報的測試檔整理，對應 FR-021～035）；§2.1 測試數寫為「整合分支 stage5/integration：unit 2258、integration 481、e2e 11，五個 eval 全綠」，主控合併後更新；§2.2 補化學 classify eval（不進 CI、尚未錄製）；§3 追溯。狀態「通過（stage5/integration CI）」指整合分支 @ `6f8e671` 完整 `ci.sh` 全綠（主控實跑），尚未併入 main、尚未在 GitHub Actions 上跑。修改處以〔修訂 2026-09-24〕行內標記。
> 🛠 **2026-09-26 合併回填**（分支 `dec/docs-backfill-round1-merged`；Owner 決策單 2026-09-25 B7、B10 已合入 `local/integration` `7dc14a0`）：§1 TC-019-8 的題數改為測試檔現況並標出哪些項屬新列；新增 TC-019-9（承上組湊不滿預設 400 與建議題數，B10）、TC-019-10（`confirm-paper` 承上題整組檢查，B7）；TC-032-1 加註。題數以 `node --test` 逐檔實跑計數（`paperGroups.test.js` 23、`followUpShortfallPolicy.test.js` 6、`followUpPaperCheck.test.js` 11、`remedialValidation.test.js` 23、`paperGroups.pg.test.js` 19，全數通過）。§2 全域測試數未改（由主線合併時統一更新）。修改處以〔修訂 2026-09-26 合併回填〕行內標記。

## 目錄

- [1. 測試案例骨架](#1-測試案例骨架)
- [2. 執行證據](#2-執行證據)
- [3. 追溯](#3-追溯)

## 1. 測試案例骨架

TC 依 FR 分組（`TC-<FR 號>-<序>`）；層級：U=單元、I=整合、E=e2e、EV=eval。全數通過（CI 全綠 @ f8f6574〔修訂 2026-08-29〕）。

| TC | 對應 FR | 驗證重點 | 層級 | 狀態 |
|---|---|---|---|---|
| TC-001-1 | FR-001 | jobs／job_questions 狀態機合法轉移；非法轉移拒絕 | U | 通過 |
| TC-001-2 | FR-001 | 上傳 PDF→部分入庫全路徑（90 題中 3 題進複核、87 題入庫語意） | E＋EV | 通過 |
| TC-002-1 | FR-002 | 章節白名單驗證；kNN 投票短路條件（近 5 鄰 4 同章、相似度 ≥0.90） | U | 通過 |
| TC-002-2 | FR-002 | 分類品質對 golden（accuracy／macro-F1） | EV | 通過 |
| TC-003-1 | FR-003 | LaTeX 白名單語法收斂；`\frac{}{}` 強制 | U | 通過 |
| TC-004-1 | FR-004 | 雙模型答案比對；不一致時進重試／needs_review | U＋EV | 通過 |
| TC-005-1 | FR-005 | 正規化雜湊去重→向量餘弦去重兩段順序與閾值 | U＋I | 通過 |
| TC-006-1 | FR-006 | needs_review 九種原因歸類〔修訂 2026-09-15f〕；review approve/reject | I＋E | 通過 |
| TC-007-1 | FR-007 | batch-save 白名單硬驗證（章節、question_type 五種、difficulty 1–5） | U＋I | 通過 |
| TC-008-1 | FR-008 | NOT EXISTS attempts 排除已作答（同學生二次組卷零重複） | I | 通過 |
| TC-008-2 | FR-008 | 草稿→確認與作答歷史同交易，失敗全數回滾 | I | 通過 |
| TC-008-3 | FR-008 | pickOnePerFamily 家族互斥：每 `COALESCE(variant_of, id)` 家族至多一題、家族間等機率 | U | 通過 |
| TC-008-4 | FR-008 | 抽題隨機性突變測試（Fisher-Yates；固定種子一萬次卡方 0.5–4.0，改回舊寫法 5 項轉紅） | U | 通過 |
| TC-009-1 | FR-009 | LaTeX→OOXML tokenizer＋遞迴下降；未知指令降級為純文字 | U | 通過 |
| TC-009-2 | FR-009 | 組卷→Word 匯出全路徑，docx 原生 Math 物件 | E | 通過 |
| TC-009-3 | FR-009 | 矩陣類環境原生 OMML 二維排版：bmatrix／pmatrix／matrix／plain TeX `\matrix{}`（含 `\cr`）→ `m:d`＞`m:m`＞`m:mr`（`exam_pro/test/unit/textFormatter.test.js:237-285`）；矩陣類語法不再擋入庫（`exam_pro/test/unit/formulaGate.test.js:192-197`）〔修訂 2026-08-29〕 | U | 通過 |
| TC-010-1 | FR-010 | hybrid（RRF k=60）檢索品質對 golden 40 筆 | EV | 通過 |
| TC-011-1 | FR-011 | 檢索優先 ≥0.80、池不足才生成、偏題閘門 ≥0.90 | U＋EV | 通過 |
| TC-012-1 | FR-012 | 規則解析（章節／難度／學生）、四級回退、解析結果回寫 | U＋EV | 通過 |
| TC-013-1 | FR-013 | 弱點面板五條純函式 SQL 之結果正確性 | U＋I | 通過 |
| TC-014-1 | FR-014 | 學生建立／改名／合併／刪除；merge 併名 | I | 通過 |
| TC-015-1 | FR-015 | 批改讀取與 results 寫回 | I | 通過 |
| TC-016-1 | FR-016 | 受限 JSON 決策迴圈、args_json 解析驗證、工具唯讀、步數上限截斷 | U＋I | 通過 |
| TC-017-1 | FR-017 | source_type 端到端：建題→列表篩選→組卷 `source_types` 過濾（非法值 400、空陣列不限制）→改標（`exam_pro/test/integration/controllers.pg.test.js:121-174`）；SOURCE_TYPES 五值凍結且與 migrations/0006 CHECK 一致（`exam_pro/test/unit/chapterVolumes.test.js:51-66`）〔修訂 2026-08-29〕 | U＋I | 通過 |
| TC-018-1 | FR-018 | bbox 附圖裁切：boxToPixels 座標換算、預設邊距 2.5%、退化框回 null（`exam_pro/test/unit/figureService.test.js:12-40`）；figure_page 絕對頁碼換算、figure_page＋figure_box 防呆、附圖描述歸位 figure_desc（`exam_pro/test/unit/agentExtract.test.js:184-253`）〔修訂 2026-08-29〕 | U | 通過 |
| TC-018-2 | FR-018 | Word 匯出嵌入本機附圖（ACPT-018-3）：`/figures/` 路徑白名單與 path traversal 拒絕、144→96 DPI 等比例縮放夾頁寬、docx 內 `word/media` PNG＋`<w:drawing>`＋rels 關聯、缺圖／壞圖／越界路徑放「（附圖遺失）」不失敗（`exam_pro/test/unit/wordFigures.test.js`）；e2e 附圖題斷言併入 TC-009-2〔修訂 2026-09-16〕 | U＋E | 通過（本機） |
| TC-019-1 | FR-019 | 承上題偵測與前題解析純函式：isFollowUp（開頭／中間／承上一題／簡體為真，「承第 3 題」為假）、findPredecessorRow（同塊連號、同塊空號 extract_gap、跨塊取上一塊最後一題、first_in_job）、resolveQuestionId（saved、dedup0 庫內／同 job 遞迴、dedup1 top[0]、pending、rejected、深度上限）；跨塊塊尾被丟（chunk_elements）、整份第一題位置 > 1、舊資料 extract 事件 rejected fallback、buildChunkInfo〔修訂 2026-09-15f〕（`exam_pro/test/unit/followUp.test.js`）〔修訂 2026-09-15e〕 | U | 通過（本分支 31 項實跑〔修訂 2026-09-15f〕） |
| TC-019-2 | FR-019 | runner 終態後重算：前題正常入庫、子題先入庫補綁、前題撞庫內題／同 job 題／語意重複皆解析到實際題號、學科不同不綁、變式 job no-op；上一塊塊尾被丟不綁（含舊資料 fallback）、runner 拆題寫 chunk_elements、linkFollowUps 丟錯只 warn 且狀態照常推進〔修訂 2026-09-15f〕（`exam_pro/test/integration/followUp.pg.test.js`）〔修訂 2026-09-15e〕 | I | 通過（本分支實跑）〔修訂 2026-09-15f〕 |
| TC-019-3 | FR-019 | 人工複核重算：前題待複核→approve 補綁 src=review、重複暫綁→approve 成新題改綁、merge_into 綁目標、reject 非重複前題不綁、GET /api/review/:jqId 的 follow_up 區塊（含 extract_gap、variant_job）；human 不覆寫、成環擋下、補強規則只補空、同 job 撞題跳過補強、approve 時綁定在 SAVEPOINT 內丟錯仍 200（同檔）〔修訂 2026-09-15f〕 | I | 通過（本分支實跑）〔修訂 2026-09-15f〕 |
| TC-019-4 | FR-019 | 0008 結構（兩欄、具名 CHECK、部分索引、FK NO ACTION 允許整組同句刪除）（`exam_pro/test/integration/schema.test.js`）；回填腳本 dry-run 不寫入且重跑報告相同、正式跑冪等、孤兒清單（`followUp.pg.test.js`）〔修訂 2026-09-15e〕；另於正式庫複本實跑：dry-run 將綁 7 題、回滾後 0 筆，正式跑 7 題、再跑 0 題〔修訂 2026-09-15f〕 | I | 通過（本分支實跑）〔修訂 2026-09-15f〕 |
| TC-019-5 | FR-019 | DELETE /api/questions/:id：刪承上題的前題 → 409 帶 `children`、先刪承上題再刪前題成功；匯入任務產生的題 → 409 請改用封存（原為 500）（`followUp.pg.test.js`「刪除前題（M2）」）〔修訂 2026-09-15f〕 | I | 通過（本分支實跑） |
| TC-019-6 | FR-019 | DELETE 保護與整組處理：變式藍本 → 409 帶 `job_ids`（原為 500，修前實跑重現）；`?group=1` 三層鏈無引用整組硬刪、孫題有作答整組封存、組內有變式／匯入任務引用整組封存、從中間題開始只處理後代、已封存後代一併處理、找不到 404；未帶 group 時前題有作答且承上題在庫 → 409 不封存；匯入任務產生的前題有在庫承上題 → 仍回 `children` 409（不受 FK 檢查順序影響）；整組處理鎖組員期間並行綁到較深組員的承上題一併納入（review 修正，兩項修前實跑重現失敗）；GET /api/questions 回 `follows_question_id`／`has_follow_ups`（`followUp.pg.test.js`「刪除／封存保護與整組處理（PR3）」）〔修訂 2026-09-16〕 | I | 通過（feat/follow-up-protect-badge 實跑） |
| TC-019-7 | FR-019 | 承上題不得當變式藍本：`requestVariants` 回 409 `reason:'follow_up_blueprint'`、先於向量檢查、不檢索不建 job，前題照常 202（`variantService.test.js`、`variants.pg.test.js`）〔修訂 2026-09-16〕 | U＋I | 通過（feat/follow-up-protect-badge 實跑） |
| TC-019-8 | FR-019 | 組卷整組抽取（ACPT-019-5／019-7）：分組（多層鏈、分岔、指向批外、環不死迴圈）、整組納入且相鄰、組內任一題不可用整組不抽、塞不下跳組補單題、有組合能剛好湊滿就一定湊滿（組大小 [3,2,2] 要 4、300 個種子）、湊不滿取最大可達且依洗牌順序優先、actual=0、家族互斥與組相撞、無綁定時與舊版 pickOnePerFamily→slice 固定種子結果相同、packUnits 隨機 2000 例對照暴力解且貪婪能湊滿時選法相同、組為單位排序（`exam_pro/test/unit/paperGroups.test.js`，19 項；〔修訂 2026-09-26 合併回填〕檔案現為 23 項，另 4 項屬 TC-019-9）；generate-paper dry_run／真出卷整組相鄰與 exam_papers 順序、隨機 25 次無孤兒承上題、已作答／exclude_ids／封存／章節／source_types 五種不可用整組不抽、少出題 200 附 shortfall／note 且 attempts 照實際題數（〔修訂 2026-09-26 合併回填 B10〕改在 `FOLLOW_UP_SHORTFALL_POLICY=note` 下逐字照驗）、湊不出任何題 400、政策切 error 回 400、confirm-paper 排序、助教 preview_paper 同行為且不寫庫（`exam_pro/test/integration/paperGroups.pg.test.js`，8 項；〔修訂 2026-09-26 合併回填〕檔案現為 19 項，另 5 項屬 TC-019-9、6 項屬 TC-019-10）〔修訂 2026-09-15g〕 | U＋I | 通過（feat/follow-up-paper-group 實跑；〔修訂 2026-09-26 合併回填〕`local/integration` 7dc14a0 重跑通過） |
| TC-019-9〔修訂 2026-09-26 合併回填〕 | FR-019、FR-032 | 承上組湊不滿題數預設報錯（Owner 決策單 2026-09-25 B10；ACPT-019-7、ACPT-032-1～2）：`FOLLOW_UP_SHORTFALL_POLICY` 未設與空白都是 error、note／error 不分大小寫、每次讀當下的環境變數、非法值退回 error 且同一個錯值只警告一次、匯出的政策是唯讀屬性（`exam_pro/test/unit/followUpShortfallPolicy.test.js`，6 項）；pickPaperUnits 回報各可用組題數、`nearestReachableCounts` 建議上下兩個湊得滿的題數、不超過上限、往下的建議等於 packUnits 會抽的題數且隨機 2000 例對照暴力解（`paperGroups.test.js`，4 項）；blueprint 逐列建議題數、非 note 一律當 error、往上的建議不讓整張卷超過 50 題、訊息句型（`remedialValidation.test.js`，3 項，另 1 項既有的政策開關測試依決策改斷言預設值）；預設 400 說出哪一章要幾題、最多湊到幾題、改成幾題且 dry_run 與真出卷都不寫庫、建議題數（組大小 3＋2 要 4 → 3 或 5）、非法值退回 error 並只警告一次、blueprint 預設 400 逐列建議（切回 note 照舊 200 附 note）、blueprint 往上建議受 50 題上限且承上組塞不進時不回「庫存不足」（`paperGroups.pg.test.js`，5 項）；助教 preview_paper 預設回同一句錯誤訊息（併在 TC-019-8 的 preview_paper 那一項） | U＋I | 通過（`local/integration` 7dc14a0 實跑） |
| TC-019-10〔修訂 2026-09-26 合併回填〕 | FR-008、FR-019、FR-031 | `confirm-paper` 伺服器端檢查承上題整組（Owner 決策單 2026-09-25 B7；裁決 S5-28 改判）：整組都在（順序隨意）→ 空、沒有承上組的卷不受影響、缺鏈尾／鏈首／中間、分岔只放一個承上題不算整組、多組依組首 id 排序、原因優先序（已封存 > 該生已寫過 > 沒放進卷）、資料有環不死迴圈、未綁定的「承上題」自成一組、400 訊息句型與原因標籤凍結（`exam_pro/test/unit/followUpPaperCheck.test.js`，11 項）；預覽→確認整組都在照常 200 且回應鍵不變、缺一題（鏈尾、前題）→ 400 列出缺題且不寫卷不寫 attempts 不含學生姓名、分岔與多組逐組列出、組內題已封存或該生已寫過 → 400 標原因（卷內本身有封存題仍回原訊息）、順序被拆開不擋且伺服器重排、沒有承上題的卷不受影響（`paperGroups.pg.test.js`，6 項） | U＋I | 通過（`local/integration` 7dc14a0 實跑） |
| TC-020-1 | FR-020 | 比對器純函式：正規化（`\frac` 負號、`\pm` 不算、array 欄位格式、sin/cos 保留、NFKC、PUA 對映、題號與配分移除）、依序定位（選項歸屬、題幹相同的兩題、共用詞組不從上一題起算、題組重疊標 shared、low_anchor／not_found／no_text_layer）、比對（多負號、漏字母、無負號字形不觸發、附圖題不比字母、等價改寫 match、定位錯段 skipped）、agent 合約（off／shadow／enforce、內部例外不 throw）（`exam_pro/test/unit/sourceCheck.test.js`）；公開樣卷＋extract.v2 cassette 10 題 0 誤報、漏一個字母即 mismatch（`exam_pro/test/unit/sourceCheckSample.test.js`）〔修訂 2026-09-15f〕 | U | 通過 |
| TC-020-2 | FR-020 | 管線接線：source_check 回 transcription_mismatch → needs_review、verify 不跑、job_events 有 source_check 列；零成本節點在當日止血時仍推進；單 job 預算用盡時 source_check／dedup0／dedup1 的 fail 保留原本原因、不進 retry 清單〔修訂 2026-09-16〕；GET /api/review?reason=transcription_mismatch；approve 入庫且事件記 source_recheck／stem_edited、不重跑閘門；0009 新值可寫入、亂值撞 CHECK；抽文字層失敗只記 status=error（`exam_pro/test/integration/jobs.pg.test.js`「runner — source_check 節點與 0009」）〔修訂 2026-09-15f〕 | I | 通過 |
| TC-020-3 | FR-020 | 樣卷端到端：每題 payload.extract.source_text 落地、無任何 transcription_mismatch（`exam_pro/test/e2e/pipeline.e2e.test.js`）；eval pipeline 的 source_check 5 pass／5 skipped、saved_rate 門檻不掉〔修訂 2026-09-15f〕 | E＋EV | 通過 |
| TC-021-1 | FR-021 | 錯因白名單十碼、標籤、適用科目逐字凍結，`isValidErrorType`／`labelOf`（`test/unit/errorTypes.test.js`）；PATCH 解析：既有六個 400 訊息與順序不變、新規則不搶先、四個可選鍵的「沒送／null」（`test/unit/gradingDetail.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI） |
| TC-021-2 | FR-021 | PATCH 四鍵的寫入、不動、清空、錯→對清錯因、取消批改、每個 400 與 ROLLBACK、化學錯因限化學題、100 筆上限；GET /api/papers/:id 新欄位；`/api/error-types` 與旗標關閉 404（`test/integration/grading.pg.test.js`）〔修訂 2026-09-24〕 | I | 通過（stage5/integration CI） |
| TC-021-3 | FR-021 | 批改卡以 miniDom 實際渲染：錯因 chip 依科目過濾與上限、載入失敗退回只記對錯、部分給分、學生答案與註記、答案與詳解展開、送出的 PATCH body（`test/unit/gradingUi.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI）；真瀏覽器未驗 |
| TC-022-1 | FR-022 | `buildByErrorType` 參數順序與凍結規則（`gradingDetail.test.js`）；錯因分布的分母、排序、四捨五入、科目與時間窗、只算答錯、封存題（`grading.pg.test.js`）；weakness 頂層六鍵與 recent_wrong 欄位逐欄斷言（`test/integration/students.pg.test.js`，〔stage5 WS-A〕四處形狀修改）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI） |
| TC-023-1 | FR-023 | 白名單、`parseProfile` 的「沒送／送 null」、每個 400、code point 計數（`test/unit/studentProfile.test.js`）；選項端點（旗標關閉也在）、POST／PATCH 子集更新與每個 400／404／409、清單欄位順序、合併（`test/integration/studentProfile.pg.test.js`）；管理面板檔案表單（`gradingUi.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI） |
| TC-024-1 | FR-024 | `buildSolutionFields`、`normalizeSolutionText`、回填規劃（來源、原因分類、edited、多列、limit、不 require LLM）（`test/unit/solutionText.test.js`）；題目 POST／PUT／列表／詳情的詳解欄位與來源規則、save 節點寫詳解（一致／證明題／空摘要）、回填 dry-run／正式／重跑／limit／CLI 輸出（`test/integration/solutions.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI）；未對正式庫回填 |
| TC-025-1 | FR-025 | Word 三種版本的 document.xml（`solutionText.test.js`）與 API 400（`solutions.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI）；Word 實機未開 |
| TC-026-1 | FR-026 | 白名單三科、`LEGACY_*`、`SUBJECT_GROUPS`、`buildSchema` 卷別、promptParts、NLQ 規則路徑與化學分流（點名數理或帶數理名詞的句子照舊走 LLM）（`test/unit/chemistryConfig.test.js`）；五個 agent 的化學路徑，以及數學／物理請求（agent 名、模板、SYSTEM、schema 實例、prompt）與 base 相同（`test/unit/chemistryAgents.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI） |
| TC-026-2 | FR-026 | `subject_group` 的 400／預設／冪等鍵；化學卷用真的 agents（replay）走完入庫；題庫列表與手動新增；NLQ 規則路徑；組卷→批改→弱點；化學變式（`test/integration/chemistry.pg.test.js`）〔修訂 2026-09-24〕 | I | 通過（stage5/integration CI） |
| TC-026-3 | FR-026 | `search:reindex`：舊詞典切的 `search_tsv` 查不到新 token、dry-run 不寫、重算後查得到、重跑 0 題、封存與 NULL 也補、`--limit`、與 POST／PUT 寫入值逐字相同（`test/unit/reindexSearchTsv.test.js`、`test/integration/searchReindex.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI）；正式庫尚未執行 |
| TC-026-4 | FR-026 | 化學 classify eval 骨架：golden 硬閘門、沒有 cassette 印「尚未錄製，略過」並 exit 0、假 cassette 完整回放 accuracy 1、不完整回放 n/a（`test/unit/evalClassifyChem.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI）；**真實分數未量測**（待 Owner 錄製） |
| TC-026-5 | FR-026、NFR-009 | 不重錄任何 cassette，五個 eval suite 全綠且量測值與 `stage5/base` 相同（WS-B 回報；CI replay）〔修訂 2026-09-24〕 | EV | 通過（stage5/integration CI） |
| TC-027-1 | FR-027 | mhchem 子集每一種記法與 `ceToComparable`（`test/unit/chemFormula.test.js`）；打包成 .docx 後的 OMML、`\mathrm` 正體、parseLatexStrict 無事件、formulaLint 放行（`test/unit/textFormatterChem.test.js`）；化學卷 Word 匯出（`chemistry.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI）；Word 實機未開 |
| TC-027-2 | FR-027 | `eval/golden/answer_chem.json` 90 案例、單位與化學式的介入邊界（℃／K 的 273 慣例、`^{\circ}\mathrm{C}`、「A 點」不是安培）、`utils/units.js`（`test/unit/answerCompareChem.test.js`）；既有 `answer.json` 250 案例不變（既有 answerCompare 測試）；verify 的單位與化學式比對（`chemistry.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI） |
| TC-028-1 | FR-028 | 參數驗證、載入計畫、環偵測、PATCH SQL、`checkKcField` 與 `validateSeeds` 逐樣本判定一致（`test/unit/kcService.test.js`）；CLI 參數與 package.json scripts（`kcCli.test.js`）；fixture 合法與 4 條 approved 口語版逐字（`kcFixtures.test.js`）；repo 內 `config/kc/*.json` 全部通過驗證（`kcSeed.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI） |
| TC-028-2 | FR-028 | 載入規則逐條（已審定受保護、`--force`、先備同步、DB 全體環檢查、23505 指名錯誤、載入中審定的 FOR UPDATE 排隊）、CLI 子行程載入涵蓋數學全部章節的種子檔、不合法檔整批拒絕（`test/integration/kcLoad.pg.test.js`）〔修訂 2026-09-24〕 | I | 通過（stage5/integration CI） |
| TC-028-3 | FR-028 | 知識點四支 API、旗標關閉 404、400／404、限流（`test/integration/kc.pg.test.js`）；前端純函式、檔案契約、miniDom 渲染（旗標、卡片、篩選、編輯、審定、朗讀）（`test/unit/kcUi.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI）；真瀏覽器與 speechSynthesis 未驗 |
| TC-029-1 | FR-029 | agent `kc_tag`：模板字串含 SYSTEM、動態 schema、prompt 保留 `$$`、佔位字串一次替換、cacheKeyParts、ajv 擋清單外 code、thinking 預算成對（`test/unit/kcTagAgent.test.js`）；`tagQuestion` 門檻、human 優先、no_kcs、交易順序、交易內再查 human、費用預估含 thinking（`test/unit/kcTagService.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI）；未對真 Gemini 執行 |
| TC-029-2 | FR-029、NFR-007 | runner 掛鉤：旗標關閉完全不呼叫、開啟時失敗不影響 job、budgetCheck（job_budget／daily_budget／查帳失敗）不呼叫 LLM（`test/unit/kcRunnerHook.test.js`）；tagQuestion 真 DB＋假 LLM、backfill 挑題與 CLI dry-run／replay miss、當日 `job_events` 花費超過上限不標（`test/integration/kcTagging.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI） |
| TC-029-3 | FR-029 | PUT 人工標註：同科檢查、0–5 個、kc_id 超過 int4 回 400、human 取代全部列（`kc.pg.test.js`、`kcService.test.js`）；題目→知識點小工具（`kcUi.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI） |
| TC-030-1 | FR-030 | Wilson 下界（n=0、全對、全錯、小數樣本）、SQL 參數順序、排序與 low_sample、toApiRow（`test/unit/kcWeakness.test.js`）；kc 加權、Wilson 排序、時間窗與科目（`test/integration/remedial.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI） |
| TC-031-1 | FR-031 | 最大餘數配額、splitCount、難度區間、chooseUnits、先備挑選（含跨科）、buildPlan 併桶 notes、草稿組裝、items 承上組資訊、`lookupItems`（`test/unit/remedialService.test.js`）；補救卷 body（含 mix 總和溢位）、加題查詢 ids（`test/unit/remedialValidation.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI） |
| TC-031-2 | FR-031 | 旗標關閉 404；kc 基底／chapter 退回（含 notes）；各 bucket 配額；不足量；排除已作答／封存／跨科／題源；家族互斥；承上組整組與 items 組資訊；不寫庫並接 confirm-paper；加題查詢（組成員、封存與已寫過旗標、missing、400／404）（`remedial.pg.test.js`）〔修訂 2026-09-24〕 | I | 通過（stage5/integration CI） |
| TC-031-3 | FR-031 | 前端：旗標關閉不渲染、草稿、刪題加題、`remedial:add`、確認並下載、承上題整組（「承上 #x」、「刪這組」、整組加入或拒絕、不混科、確認前擋缺前題的承上題）、variants.js 掛鉤在旗標開關兩種情況（`test/unit/remedialUi.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI）；真瀏覽器未驗 |
| TC-032-1 | FR-032 | blueprint 驗證與承上題政策開關（`remedialValidation.test.js`）；互斥 400、逐列不足、全空 400、跨列家族互斥與不重複、承上題整組與真出卷、單章路徑收到非字串 chapter 仍是 400（`remedial.pg.test.js`）；單章路徑回應不變由既有 controllers／paperGroups 整合與 e2e 守〔修訂 2026-09-24〕；〔修訂 2026-09-26 合併回填 B10〕`remedialValidation.test.js` 現為 23 項，政策開關那一項改驗預設 `error`，另 3 項 blueprint 建議題數測試與 `paperGroups.pg.test.js` 的 blueprint 預設報錯歸 TC-019-9 | U＋I | 通過（stage5/integration CI；〔修訂 2026-09-26 合併回填〕`local/integration` 7dc14a0 重跑通過） |
| TC-033-1 | FR-033 | 白名單每章都列、舊章節、unseen 的 null／數字、知識點排序、SQL builder（`test/unit/coverageService.test.js`）；覆蓋率 400／404／內容（`remedial.pg.test.js`）〔修訂 2026-09-24〕 | U＋I | 通過（stage5/integration CI） |
| TC-034-1 | FR-034 | `generateText`：`toContents` 既有三種 part 逐字不變＋音訊／圖片、`parseTextResponse` 配對、`readFinishReason`、送出的 config（含 `thinkingConfig`）、`generateJson` config 回歸、replay 命中／miss／壞檔、record→replay 一輪、三個模型 getter（`test/unit/llmGenerateText.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI） |
| TC-034-2 | FR-034、NFR-007、NFR-008 | 輸入驗證 400 先於 DB 與 LLM、脈絡組裝（approved 優先、draft 標註、退回同章、學生前 5 與錯因）、姓名不出現在 system／parts／cacheKeyParts、兩模式模板、驗算回傳、截斷提醒、成本與每日預算 429 與隔日歸零、LLM 失敗 502、DB 錯誤不冒充 502（`test/unit/tutorService.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI） |
| TC-034-3 | FR-034、NFR-001 | 受限 Markdown 的 XSS 案例與格式、巢狀佔位符完整還原、截斷提醒在 `<pre>` 外、miniDom：旗標關閉不渲染、送出與回覆呈現、確認送出失敗時逐字稿保留（`test/unit/tutorUi.test.js`）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI）；真瀏覽器未驗 |
| TC-034-4 | FR-034 | 三種旗標組合 404、400／404（含 ID 超過 int4）、LLM_MODE=replay＋暫存 cassette 跑通一輪並斷言 DB 組出的 prompt 無姓名、退回同章知識點、cassette 記 MAX_TOKENS 時附截斷提醒、replay miss 502、預算 429、兩個限流 env（`test/integration/tutor.pg.test.js`）〔修訂 2026-09-24〕 | I | 通過（stage5/integration CI）；**未呼叫真 Gemini**，家教 eval 未做 |
| TC-035-1 | FR-035 | 大小、mime（含 `;codecs=`）、科目、送出的 parts 與 cacheKeyParts、ajv 再驗與正規化、共用預算、multer／busboy 錯誤轉譯、buffer 清除（`test/unit/voiceService.test.js`）；錄音→逐字稿→點 chip→按確認才送出、取消不送、麥克風不可用時隱藏並說明（`tutorUi.test.js`，假 MediaRecorder）〔修訂 2026-09-24〕 | U | 通過（stage5/integration CI） |
| TC-035-2 | FR-035、NFR-008 | voice 的 400（沒檔、欄位名、mime、multipart 壞掉）與 413、錄音不寫進 `uploads/`、模型輸出不合 schema 502（`tutor.pg.test.js`）〔修訂 2026-09-24〕 | I | 通過（stage5/integration CI）；Gemini 收 audio/webm 未實機驗證 |

## 2. 執行證據

### 2.1 測試數量與執行條件

| 層級 | 數量 | 位置 | 執行條件 |
|---|---:|---|---|
| 單元 | 1,613 | exam_pro/test/unit/ | 不連網、不連庫、零 secrets；`npm test` 可完整重現〔修訂 2026-09-16b〕 |
| 整合 | 317 | exam_pro/test/integration/ | tmpfs 測試庫（5433，`_test` 後綴強制）〔修訂 2026-09-16b〕 |
| e2e | 11 | exam_pro/test/e2e/ | HTTP 全路徑（上傳→部分入庫；組卷→Word 公式） |

〔修訂 2026-09-24〕上表為 main（PR #30–#33 合併後）的數字。階段 5：**整合分支 stage5/integration：unit 2258、integration 481、e2e 11，五個 eval 全綠**（主控合併後更新數字）。階段 5 新增 29 支單元測試檔與 10 支整合測試檔（清單見 §1 TC-021-*～TC-035-*）；e2e 未新增。

CI（`.github/workflows/ci.yml`）：unit（Node 22/24 矩陣）＋integration（pgvector service→migrations→整合→e2e→五個 eval suite）；全程零金鑰、零網路、零成本（cassette replay；replay miss 於 main 視為錯誤）。CI badge 見 repo 根 `README.md`；全綠 @ f8f6574（PR #7 merge）〔修訂 2026-08-29〕。

### 2.2 eval 五個 suite（golden＋ratchet：首測 −0.03、只升不降）

| Suite | 指標 | 實測值 | 門檻 |
|---|---|---:|---:|
| retrieval（golden 40 筆） | Recall@5（hybrid RRF） | 1.000 | ≥0.97 |
| retrieval | MRR（hybrid；純向量 0.9575 供對照） | 0.824 | ≥0.695 |
| classify | accuracy／macro-F1 | 0.9000／0.9256 | ≥0.87／≥0.8956 |
| pipeline | saved_rate | 0.90 | ≥0.87 |
| pipeline | gate_pass_rate | 1.00 | ≥0.97 |
| pipeline | answer_agree_rate | 0.90 | ≥0.87 |
| nlq（golden 50 句） | 規則 coverage／filters_exact／recall@10 | 0.84／1.000／1.000 | ≥0.81／≥0.97／≥0.97 |
| variant | retrieved_coverage | 0.8667 | ≥0.8367 |
| variant | gate_pass_rate（閾值 0.92→0.90 沿革見裁決 S3-R29） | 0.25 | ≥0.22 |

任何改動使指標低於門檻，CI 轉紅（`exam_pro/eval/thresholds.json`）。

〔修訂 2026-09-24〕階段 5 沒有新增 CI 門檻，也沒有重錄任何 cassette（NFR-009）；五個 suite 的量測值與 `stage5/base` 相同（WS-B 回報）。另有一支**不進 CI** 的 `npm run eval:classify-chem`（化學 classify，golden 24 筆自撰、`needs_human_confirm` 全為 true）：目前沒有 cassette，執行時印「尚未錄製，略過」並 exit 0；錄製與是否併入 CI 需另開裁決（`docs/chemistry.md` §6）。AI 家教、`kc_tag` 標註準確率都尚無 eval suite。

## 3. 追溯

- 上游：FR-001～016、FR-017～018、FR-019〔修訂 2026-09-15e〕、FR-020〔修訂 2026-09-15f〕、FR-021～035〔修訂 2026-09-24〕／NFR-003、NFR-004、NFR-007～009〔修訂 2026-09-24〕（[engineering_tracker](../03_architecture/engineering_tracker.md)）；ACPT-021-*～035-* 的可觀察判準見 [srs §6.1](../01_requirements/srs.md)〔修訂 2026-09-24〕；DEC-005、DEC-006 之業務驗收（[requirements_tracker](../01_requirements/requirements_tracker.md) §1）。
- 下游：Gate 簽核證據（[requirements_tracker](../01_requirements/requirements_tracker.md) §3）；門檻失守處置（[../06_ops/runbook-eval-threshold-fail.md](../06_ops/runbook-eval-threshold-fail.md)）。
