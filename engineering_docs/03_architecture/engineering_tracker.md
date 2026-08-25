# 工程追蹤簿 (Engineering Tracker) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（本檔為發布快照；`engineering_tracker.xlsx` 由本檔轉出，人工維護欄位以本檔為準）
> **定位:** 本文件回答「每條 FR/NFR 落在哪個模組、對應哪個 ADR、以何種方式驗證」；需求決策與 Gate 見 [requirements_tracker](../01_requirements/requirements_tracker.md)，測試執行證據見 [qa_tracker](../05_qa/qa_tracker.md)。

## 目錄

- [1. 功能需求 FR](#1-功能需求-fr)
- [2. 非功能需求 NFR](#2-非功能需求-nfr)
- [3. ADR 索引](#3-adr-索引)
- [4. 追溯](#4-追溯)

## 1. 功能需求 FR

全部狀態為「已實作」（四階段完成，CI 全綠 @ 0ff47b4）。模組路徑為 repo 相對路徑。

| ID | 摘要 | 狀態 | 模組路徑 | 對應 ADR | 驗證方式 |
|---|---|---|---|---|---|
| FR-001 | 考卷 PDF 上傳與非同步拆題 job（狀態機 queued→extracting→processing→done/failed） | 已實作 | exam_pro/workers/jobRunner.js、exam_pro/pipeline/stateMachine.js、exam_pro/agents/extract.js | ADR-003、ADR-006 | 單元＋整合＋e2e（上傳→部分入庫）＋eval pipeline |
| FR-002 | 章節分類（白名單→kNN 投票短路→LLM） | 已實作 | exam_pro/agents/classify.js、exam_pro/config/chapters.js、exam_pro/config/chapterExamples.js | ADR-005、ADR-002 | 單元＋eval classify（accuracy 0.9000） |
| FR-003 | 公式修復 lint（LaTeX 白名單語法收斂） | 已實作 | exam_pro/agents/lint.js、exam_pro/utils/formulaLint.js、exam_pro/utils/formulaFix.js | ADR-005 | 單元 |
| FR-004 | 獨立解題驗證（pro 與 flash 互相制衡、答案比對） | 已實作 | exam_pro/agents/verify.js、exam_pro/utils/answerCompare.js | ADR-003 | 單元＋eval pipeline（answer_agree_rate 0.90） |
| FR-005 | 兩段去重（正規化雜湊→向量餘弦） | 已實作 | exam_pro/agents/dedup.js、exam_pro/utils/normalizeStem.js | ADR-003、ADR-001 | 單元＋整合 |
| FR-006 | 部分入庫與人工複核佇列（needs_review 八種原因） | 已實作 | exam_pro/controllers/reviewController.js、exam_pro/public/js/review.js | ADR-005、ADR-003 | 整合＋e2e |
| FR-007 | 題庫管理（CRUD、分頁、batch-save 白名單硬驗證） | 已實作 | exam_pro/controllers/questionController.js、exam_pro/utils/questionValidation.js | ADR-005 | 單元＋整合 |
| FR-008 | 組卷（草稿→確認；NOT EXISTS attempts 排除；家族互斥） | 已實作 | exam_pro/controllers/examController.js、exam_pro/utils/pickOnePerFamily.js、exam_pro/utils/shuffle.js | ADR-001 | 單元＋整合＋e2e（組卷→Word 公式） |
| FR-009 | Word 匯出（自製 LaTeX→OOXML，docx 原生 Math 物件） | 已實作 | exam_pro/utils/textFormatter.js、exam_pro/services/wordService.js | ADR-004 | 單元＋e2e |
| FR-010 | 相似題檢索（hybrid RRF） | 已實作 | exam_pro/services/retrievalService.js、exam_pro/queries/hybrid.js | ADR-001、ADR-002、ADR-008 | eval retrieval（Recall@5 1.000） |
| FR-011 | 變式題（檢索優先 ≥0.80，池不足才生成，偏題閘門 ≥0.90） | 已實作 | exam_pro/services/variantService.js、exam_pro/agents/generateVariant.js、exam_pro/utils/variantTextGate.js | ADR-002、ADR-005、ADR-006 | eval variant（retrieved_coverage 0.8667） |
| FR-012 | 自然語言查題（規則主、LLM 輔、四級回退） | 已實作 | exam_pro/services/nlqService.js、exam_pro/utils/nlqHeuristics.js、exam_pro/config/chapterAliases.js | ADR-002、ADR-008 | eval nlq（規則 coverage 0.84） |
| FR-013 | 學生弱點面板（五條純函式 SQL） | 已實作 | exam_pro/services/weaknessService.js | ADR-001 | 單元＋整合 |
| FR-014 | 學生管理（建立／改名／合併／刪除） | 已實作 | exam_pro/controllers/studentAdminController.js | — | 整合 |
| FR-015 | 批改（GET /api/papers/:id、PATCH results） | 已實作 | exam_pro/controllers/paperController.js | — | 整合 |
| FR-016 | 對話式助教（主控 LLM ReAct 迴圈＋五個只讀工具、出卷僅 dry-run） | 已實作 | exam_pro/services/assistantService.js、exam_pro/public/js/assistant.js | ADR-007 | 單元＋整合（replay） |

## 2. 非功能需求 NFR

| ID | 摘要 | 狀態 | 模組路徑 | 對應 ADR | 驗證方式 |
|---|---|---|---|---|---|
| NFR-001 | 安全：x-api-key（timing-safe）、CORS 白名單、防 SSRF、正式環境不回傳錯誤細節 | 已實作 | exam_pro/middleware/、exam_pro/app.js、exam_pro/services/wordService.js（isSafeImageUrl） | ADR-005 | 單元 |
| NFR-002 | 成本：限流、RPM 節流、逐 token 計費、單 job／每日成本上限 | 已實作 | exam_pro/middleware/rateLimit.js、exam_pro/services/llm/throttle.js、exam_pro/config/pricing.js | ADR-003 | 單元＋job_events 成本紀錄 |
| NFR-003 | 可測試性：agent 純函式合約、cassette record/replay、CI 零金鑰零網路 | 已實作 | exam_pro/agents/、exam_pro/services/llm/、exam_pro/eval/cassettes/ | ADR-006 | 單元 1,415 項不連網不連庫；CI replay |
| NFR-004 | 品質門檻：eval golden＋ratchet（首測 −0.03、只升不降），低於門檻 CI 轉紅 | 已實作 | exam_pro/eval/run.js、exam_pro/eval/thresholds.json、exam_pro/eval/lib/ | ADR-006 | 五個 eval suite（[qa_tracker §2](../05_qa/qa_tracker.md)） |
| NFR-005 | 可靠性：SKIP LOCKED＋租約認領、斷點續跑、逾時退避重試、重試預算 | 已實作 | exam_pro/workers/jobRunner.js、exam_pro/pipeline/stateMachine.js | ADR-003 | 整合＋e2e |
| NFR-006 | 資料一致性：組卷與作答歷史同交易；migrations 只增不改（0001–0005） | 已實作 | exam_pro/controllers/examController.js、exam_pro/migrations/、exam_pro/migrate.js | ADR-001 | 整合 |

## 3. ADR 索引

一決策一檔，置於 [adr/](./adr/)；決策全文與替代方案評估以各 ADR 為準，本表僅列決定性因素。

| ADR | 決定性因素 |
|---|---|
| ADR-001-pgvector-over-dedicated-vector-db | 關聯條件（NOT EXISTS attempts 等）與向量檢索必須同一查詢 |
| ADR-002-hybrid-retrieval-rrf | jieba 應用層分詞＋RRF k=60；MRR 稀釋（0.9575→0.824）為已知代價 |
| ADR-003-code-orchestrated-agent-pipeline | 流程已知且固定，拒 LLM 編排與框架；PG 佇列原生持久化 |
| ADR-004-custom-latex-ooxml-over-pandoc | docx 原生 Math 物件；受控輸入域；零外部二進位相依 |
| ADR-005-server-side-whitelist-validation | prompt 不是保證；兩層防線；部分入庫 |
| ADR-006-cassette-record-replay | 鍵含模型 ID＋模板版本＋輸入雜湊；CI 確定性重播 |
| ADR-007-assistant-no-native-function-calling | responseJsonSchema 決策迴圈；args_json 字串傳參；空結果亦為答案 |
| ADR-008-app-layer-chinese-tokenizer | utils/tokenize.js 凍結為全案唯一分詞；換分詞器須整批重建索引 |

## 4. 追溯

- 上游：DEC-001～009（[requirements_tracker](../01_requirements/requirements_tracker.md) §1）；凍結介面與裁決（`docs/interfaces*.md`）。
- 下游：FR-001～016 → TC-＊與五個 eval suite（[qa_tracker](../05_qa/qa_tracker.md)）；FR-010～012、FR-016 → 各 ui_spec（[../02_ux_ui/](../02_ux_ui/)）；NFR-005、DEC-004 → runbook（[../06_ops/](../06_ops/)）。
