# 測試追蹤簿 (QA Tracker) - 家教專用數理題庫系統

> **版本:** v1.3 | **更新:** 2026-09-15 | **狀態:** 活躍
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
> 🛠 **2026-09-16 修訂**（feat/follow-up-protect-badge，FR-019 PR3）：§1 新增 TC-019-6～7。②執行證據之全域測試數未改（由主線合併時統一更新）。修改處以〔修訂 2026-09-16〕行內標記。

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
| TC-020-1 | FR-020 | 比對器純函式：正規化（`\frac` 負號、`\pm` 不算、array 欄位格式、sin/cos 保留、NFKC、PUA 對映、題號與配分移除）、依序定位（選項歸屬、題幹相同的兩題、共用詞組不從上一題起算、題組重疊標 shared、low_anchor／not_found／no_text_layer）、比對（多負號、漏字母、無負號字形不觸發、附圖題不比字母、等價改寫 match、定位錯段 skipped）、agent 合約（off／shadow／enforce、內部例外不 throw）（`exam_pro/test/unit/sourceCheck.test.js`）；公開樣卷＋extract.v2 cassette 10 題 0 誤報、漏一個字母即 mismatch（`exam_pro/test/unit/sourceCheckSample.test.js`）〔修訂 2026-09-15f〕 | U | 通過 |
| TC-020-2 | FR-020 | 管線接線：source_check 回 transcription_mismatch → needs_review、verify 不跑、job_events 有 source_check 列；零成本節點在當日止血時仍推進；單 job 預算用盡時 source_check／dedup0／dedup1 的 fail 保留原本原因、不進 retry 清單〔修訂 2026-09-16〕；GET /api/review?reason=transcription_mismatch；approve 入庫且事件記 source_recheck／stem_edited、不重跑閘門；0009 新值可寫入、亂值撞 CHECK；抽文字層失敗只記 status=error（`exam_pro/test/integration/jobs.pg.test.js`「runner — source_check 節點與 0009」）〔修訂 2026-09-15f〕 | I | 通過 |
| TC-020-3 | FR-020 | 樣卷端到端：每題 payload.extract.source_text 落地、無任何 transcription_mismatch（`exam_pro/test/e2e/pipeline.e2e.test.js`）；eval pipeline 的 source_check 5 pass／5 skipped、saved_rate 門檻不掉〔修訂 2026-09-15f〕 | E＋EV | 通過 |

## 2. 執行證據

### 2.1 測試數量與執行條件

| 層級 | 數量 | 位置 | 執行條件 |
|---|---:|---|---|
| 單元 | 1,567 | exam_pro/test/unit/ | 不連網、不連庫、零 secrets；`npm test` 可完整重現〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕 |
| 整合 | 297 | exam_pro/test/integration/ | tmpfs 測試庫（5433，`_test` 後綴強制）〔修訂 2026-09-15e〕〔修訂 2026-09-15f〕 |
| e2e | 11 | exam_pro/test/e2e/ | HTTP 全路徑（上傳→部分入庫；組卷→Word 公式） |

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

## 3. 追溯

- 上游：FR-001～016、FR-017～018、FR-019〔修訂 2026-09-15e〕、FR-020〔修訂 2026-09-15f〕／NFR-003、NFR-004（[engineering_tracker](../03_architecture/engineering_tracker.md)）；DEC-005、DEC-006 之業務驗收（[requirements_tracker](../01_requirements/requirements_tracker.md) §1）。
- 下游：Gate 簽核證據（[requirements_tracker](../01_requirements/requirements_tracker.md) §3）；門檻失守處置（[../06_ops/runbook-eval-threshold-fail.md](../06_ops/runbook-eval-threshold-fail.md)）。
