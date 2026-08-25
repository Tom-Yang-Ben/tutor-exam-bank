# 使用者驗收測試計畫 (UAT Plan) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3
> **實例:** 每驗收輪次一份；本份為 **Pilot 輪**，藍本為 `exam_pro/README.md`「交付前驗收清單（陌生人驗收）」A／B／C 三段。
> 本文件回答「交付前如何以陌生人視角走完整套系統、各情境的可觀察通過準則、最近一次驗收結果」；不含測試案例明細（歸 [`test_plan.md`](./test_plan.md) 與 [`qa_tracker.md`](./qa_tracker.md)）、不含上線切換與回滾程序（歸 `../06_ops/`）。

## 目錄

- [1. 驗收範圍與參與者](#1-驗收範圍與參與者)
- [2. 驗收情境](#2-驗收情境)
- [3. 問題分級與處理](#3-問題分級與處理)
- [4. 簽核與最近一次驗收紀錄](#4-簽核與最近一次驗收紀錄)
- [5. 追溯](#5-追溯)

## 1. 驗收範圍與參與者

| 項目 | 內容 |
| :--- | :--- |
| **驗收範圍** | 核心交付流程：從零重建環境 → 題庫管理 → 智慧組卷（避免重複出題）→ 匯出 Word 原生方程式（DEC-001、DEC-002、DEC-003；FR-007、FR-008、FR-009）。旗標功能（FEATURE_* 預設全關）不在 Pilot 輪範圍。 |
| **驗收原則** | 「陌生人驗收」：從乾淨目錄、只用版控裡的檔案、照 README 走一遍；不得沿用既有 `node_modules` 與 `.env`。前端為零打包器單頁 HTML，檔案截斷時伺服器仍回 200，僅此法可攔截。 |
| **參與者** | Ben（楊本顥）——單人使用、單人維運，兼任執行者與簽核人。 |
| **環境與資料** | 全新 clone 目錄；Docker 起 PostgreSQL 16 + pgvector（開發埠 5442）；示範資料為 `exam_pro/seed_questions.js` 自製 30 題（4 章各 7~8 題）；不含真題庫（DEC-009）。 |
| **時程** | 每次交付前執行一輪，10 步全綠始得交付；任一步紅燈即中止。 |

## 2. 驗收情境

以真實交付流程為單位，分 A（從零重建）／B（自動化把關）／C（人工驗收）三段依序執行：

### 2.1 A 段——從零重建（驗證「版控裡的檔案足以跑起來」）

| ID | 業務情境 | 通過準則（可觀察） | 對應 FR／ACPT |
| :--- | :--- | :--- | :--- |
| SCN-001 | `git clone` 至全新目錄後 `npm install` | 安裝成功無 `ERR!`（`multer@1.x` deprecated 警告為已知，不影響啟動） | NFR-003 |
| SCN-002 | 由 `.env.example` 產生 `.env` 並填入金鑰 | `.env.example` 每個欄位皆有對應值；`.env` 不在版控中 | NFR-001 |
| SCN-003 | `docker compose up -d --wait` 後 `npm run migrate` | `node migrate.js status` 顯示 migrations 皆已套用（0001–0005） | DEC-004、NFR-006 |
| SCN-004 | `node seed_questions.js --apply` 灌入示範題 | 顯示「新增 30 題」且分佈為 4 章各 7~8 題；任一章 < 5 題自動中止 | FR-007／ACPT-007-1 |

### 2.2 B 段——自動化把關（先讓機器擋掉低級錯誤）

| ID | 業務情境 | 通過準則（可觀察） | 對應 FR／ACPT |
| :--- | :--- | :--- | :--- |
| SCN-005 | `npm test` 單元測試 | 全數通過（2026-08-24 現況 1,415 passed / 0 failed）；不連網、不連庫、零 secrets | NFR-003、NFR-004 |
| SCN-006 | 靜態檔完整性（截斷檔自檢） | `public/index.html` 結尾為 `</script></body></html>`；抽出 inline script 經 `node --check` 通過 | FR-007 |
| SCN-007 | `npm start` 啟動伺服器 | 終端印出啟動成功訊息與 `http://localhost:3000` | NFR-001 |

### 2.3 C 段——人工驗收（F12 全程開著）

| ID | 業務情境 | 通過準則（可觀察） | 對應 FR／ACPT |
| :--- | :--- | :--- | :--- |
| SCN-008 | 開啟首頁並檢視 F12 Console | 零 error、零 warning；Network 無 4xx／5xx | FR-007 |
| SCN-009 | 主流程：題庫清單 → 手動新增一題 → 智慧組卷（抽題數維持預設 5）→ 下載 Word 考卷 | 清單顯示筆數與分頁；組卷回 200 而非 400；`.docx` 成功下載、Word 可開啟、公式為可編輯的原生方程式而非亂碼 | FR-007、FR-008／ACPT-008-1、FR-009／ACPT-009-1 |
| SCN-010 | 避免重複出題：同一學生同章連續抽題 | 剩餘題數不足時回 400；縮減抽題數後回 200；換一位學生抽 5 題回 200 | DEC-003、FR-008／ACPT-008-2 |

> SCN-009 的最後一步（下載 Word）最容易被跳過卻最容易壞：`downloadWordFile()` 位於 `index.html` 最尾端，檔案一旦截斷它是第一個消失的函式，而前面九步全部綠燈。

## 3. 問題分級與處理

| 等級 | 定義 | 處理 |
| :--- | :--- | :--- |
| A－阻擋 | 交付流程走不下去（安裝失敗、頁面 script 全滅、組卷 400、Word 亂碼） | 修復後整輪重驗，UAT 不通過 |
| B－重要 | 有替代做法但影響使用（如需手動繞過某步驟） | 修復或列入下一階段，記入 `docs/HANDOFF.md` |
| C－建議 | 體驗改善 | 進需求候選，由 Owner 裁定是否納入 roadmap |

## 4. 簽核與最近一次驗收紀錄

| 項目 | 內容 |
| :--- | :--- |
| **結果** | 通過（Pilot 輪，2026-08-01；三項 A 級問題於驗收中修復後複驗通過） |
| **簽核人／日期** | Ben（楊本顥）／2026-08-01 |
| **證據** | `exam_pro/README.md`「最近一次驗收紀錄」一節；簽核結果回寫 [`../01_requirements/requirements_tracker.md`](../01_requirements/requirements_tracker.md) ③Gate，證據依 SCN ID 進 [`qa_tracker.md`](./qa_tracker.md) ②執行證據 |

Pilot 輪（2026-08-01）逐項結果：

| 情境 | 結果 |
| :--- | :--- |
| SCN-001～004 | 通過：全新目錄 + 全新 `npm install`＋由 `.env.example` 產生 `.env`＋獨立驗收資料庫＋種子 30 題（當時資料層仍為 MySQL；階段 1 換底後 SCN-003 改為 `docker compose up` + `npm run migrate`） |
| SCN-005 | 通過：當時 40 passed / 0 failed（`npm ci` 亦驗證 lock file 可獨立還原）；另做突變測試——`shuffle` 改回舊寫法 5 個測試轉紅、還原後回到全綠 |
| SCN-006～008 | 通過：Console 0 error、0 warning；章節下拉 35 項、題庫清單 10 張卡＋「共 30 題」＋分頁正常 |
| SCN-009 | 通過：4 章組卷全部 200，題型與難度排序正確；`/api/download-word` 200，`.docx` 解壓 22 項無損毀、含 33 個 `<m:oMath>` |
| SCN-010 | 通過：同一學生同章再抽 5 題 → 400（剩 3 題，符合預期）；改抽 3 題 → 200；換一位學生抽 5 題 → 200 |
| 驗收中修復 | ① `index.html` 曾截斷於 `downloadWordFile()` 中段，已補回尾段（SCN-006 的由來）② 種子題庫原為 30 章各 1 題、預設抽 5 題必回 400，已改為 4 章各 7~8 題（SCN-004 的由來）③ 抽題洗牌原用 `sort(() => 0.5 - Math.random())`，已改為 Fisher-Yates 並以一萬次分佈測試釘住 |

> **下一輪（PostgreSQL 16 換底＋階段 2–4 旗標功能納入範圍的完整重跑）：尚未執行。**
> 現況如實記錄：Pilot 輪（2026-08-01）僅覆蓋 MySQL 時代的核心流程（FR-007／008／009），階段 1–4 的新功能（管線、RAG 三落點、學生管理、助教）**未經任何 UAT 輪次**；[requirements_tracker ③Gate](../01_requirements/requirements_tracker.md) 對階段 1–4 的核准證據為 CI（單元 1,415／整合 259／e2e 11）＋五個 eval suite＋階段試用，**不含 UAT 重跑**。Owner 於 2026-08-25 裁示**不執行**下一輪 UAT——Gate 證據基礎即維持上述 CI＋eval＋階段試用；若日後情況改變（例如對外交付前），依 §2 情境重跑並於本節登錄逐項結果。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 上游 | DEC-001、DEC-002、DEC-003、DEC-004、DEC-009；FR-007、FR-008、FR-009；NFR-001、NFR-003、NFR-004、NFR-006；ACPT-007-1、ACPT-008-1、ACPT-008-2、ACPT-009-1 |
| 簽核回寫 | [`../01_requirements/requirements_tracker.md`](../01_requirements/requirements_tracker.md) ③Gate |
| 證據 | [`qa_tracker.md`](./qa_tracker.md) ②執行證據（SCN-001～SCN-010） |
