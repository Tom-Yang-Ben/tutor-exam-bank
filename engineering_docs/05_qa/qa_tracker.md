# 測試追蹤簿 (QA Tracker) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 單例（本檔為發布快照；`qa_tracker.xlsx` 由本檔轉出，人工維護欄位以本檔為準）
> **定位:** 本文件回答「每條 FR 由哪些測試案例覆蓋、執行證據與 eval 門檻為何」；需求與 Gate 見 [requirements_tracker](../01_requirements/requirements_tracker.md)，模組落點見 [engineering_tracker](../03_architecture/engineering_tracker.md)。

## 目錄

- [1. 測試案例骨架](#1-測試案例骨架)
- [2. 執行證據](#2-執行證據)
- [3. 追溯](#3-追溯)

## 1. 測試案例骨架

TC 依 FR 分組（`TC-<FR 號>-<序>`）；層級：U=單元、I=整合、E=e2e、EV=eval。全數通過（CI 全綠 @ 0ff47b4）。

| TC | 對應 FR | 驗證重點 | 層級 | 狀態 |
|---|---|---|---|---|
| TC-001-1 | FR-001 | jobs／job_questions 狀態機合法轉移；非法轉移拒絕 | U | 通過 |
| TC-001-2 | FR-001 | 上傳 PDF→部分入庫全路徑（90 題中 3 題進複核、87 題入庫語意） | E＋EV | 通過 |
| TC-002-1 | FR-002 | 章節白名單驗證；kNN 投票短路條件（近 5 鄰 4 同章、相似度 ≥0.90） | U | 通過 |
| TC-002-2 | FR-002 | 分類品質對 golden（accuracy／macro-F1） | EV | 通過 |
| TC-003-1 | FR-003 | LaTeX 白名單語法收斂；`\frac{}{}` 強制 | U | 通過 |
| TC-004-1 | FR-004 | 雙模型答案比對；不一致時進重試／needs_review | U＋EV | 通過 |
| TC-005-1 | FR-005 | 正規化雜湊去重→向量餘弦去重兩段順序與閾值 | U＋I | 通過 |
| TC-006-1 | FR-006 | needs_review 八種原因歸類；review approve/reject | I＋E | 通過 |
| TC-007-1 | FR-007 | batch-save 白名單硬驗證（章節、question_type 五種、difficulty 1–5） | U＋I | 通過 |
| TC-008-1 | FR-008 | NOT EXISTS attempts 排除已作答；pickOnePerFamily 家族互斥 | U＋I | 通過 |
| TC-008-2 | FR-008 | 草稿→確認與作答歷史同交易，失敗全數回滾 | I | 通過 |
| TC-009-1 | FR-009 | LaTeX→OOXML tokenizer＋遞迴下降；未知指令降級為純文字 | U | 通過 |
| TC-009-2 | FR-009 | 組卷→Word 匯出全路徑，docx 原生 Math 物件 | E | 通過 |
| TC-010-1 | FR-010 | hybrid（RRF k=60）檢索品質對 golden 40 筆 | EV | 通過 |
| TC-011-1 | FR-011 | 檢索優先 ≥0.80、池不足才生成、偏題閘門 ≥0.90 | U＋EV | 通過 |
| TC-012-1 | FR-012 | 規則解析（章節／難度／學生）、四級回退、解析結果回寫 | U＋EV | 通過 |
| TC-013-1 | FR-013 | 弱點面板五條純函式 SQL 之結果正確性 | U＋I | 通過 |
| TC-014-1 | FR-014 | 學生建立／改名／合併／刪除；merge 併名 | I | 通過 |
| TC-015-1 | FR-015 | 批改讀取與 results 寫回 | I | 通過 |
| TC-016-1 | FR-016 | 受限 JSON 決策迴圈、args_json 解析驗證、工具唯讀、步數上限截斷 | U＋I | 通過 |

## 2. 執行證據

### 2.1 測試數量與執行條件

| 層級 | 數量 | 位置 | 執行條件 |
|---|---:|---|---|
| 單元 | 1,415 | exam_pro/test/unit/ | 不連網、不連庫、零 secrets；`npm test` 可完整重現 |
| 整合 | 259 | exam_pro/test/integration/ | tmpfs 測試庫（5433，`_test` 後綴強制） |
| e2e | 11 | exam_pro/test/e2e/ | HTTP 全路徑（上傳→部分入庫；組卷→Word 公式） |

CI（`.github/workflows/ci.yml`）：unit（Node 22/24 矩陣）＋integration（pgvector service→migrations→整合→e2e→五個 eval suite）；全程零金鑰、零網路、零成本（cassette replay；replay miss 於 main 視為錯誤）。CI badge 見 repo 根 `README.md`；全綠 @ 0ff47b4。

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

- 上游：FR-001～016／NFR-003、NFR-004（[engineering_tracker](../03_architecture/engineering_tracker.md)）；DEC-005、DEC-006 之業務驗收（[requirements_tracker](../01_requirements/requirements_tracker.md) §1）。
- 下游：Gate 簽核證據（[requirements_tracker](../01_requirements/requirements_tracker.md) §3）；門檻失守處置（[../06_ops/runbook-eval-threshold-fail.md](../06_ops/runbook-eval-threshold-fail.md)）。
