# UI 規格書：補救卷與題庫覆蓋率 (UI Spec – Remedial & Coverage) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-24 | **狀態:** 活躍（階段 5；實作於整合分支 `stage5/integration`，待併入 main）
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（本篇涵蓋同一個 module `exam_pro/public/js/remedial.js` 建立的兩個子區塊：學生視圖內的 `<section id="remedial">` 與題庫視圖內的 `<section id="coverage">`）
> **定位:** 本文件定義「依弱點出補救卷」與「題庫覆蓋率」兩個區塊的版面、狀態與互動，以及「找相似 → 加入補救卷」的跨區塊事件。選題規則、API 與操作說明的權威文件是 [`docs/remedial.md`](../../docs/remedial.md)；決策見 [ADR-014](../03_architecture/adr/ADR-014-remedial-paper-wilson-quota.md)。學生分頁本體見 [`ui_spec-students.md`](./ui_spec-students.md)，「找相似」結果列見 [`ui_spec-variants.md`](./ui_spec-variants.md)。

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

把「看完弱點面板」接到「下一份卷」：按一下就有補救卷草稿，草稿說得出為什麼選這些題（目標單位、掌握度下界、難度範圍），確認前一個位元組都不寫；題庫覆蓋率讓老師看見哪一章、哪個難度沒題可出。`FEATURE_REMEDIAL` 關閉時兩個區塊都整段不渲染。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 補救卷：學生視圖（`#students` 之後的 `#remedial`，`VIEW_FOR_ANCHOR.remedial = 'view-students'`；需同時開 `FEATURE_STUDENTS` 才有學生分頁）；覆蓋率：題庫管理視圖（`#variants` 之後的 `#coverage`，`VIEW_FOR_ANCHOR.coverage = 'view-library'`）；「找相似」結果列的「加入補救卷」按鈕（需 `FEATURE_STUDENTS`＋`FEATURE_VARIANTS`＋`FEATURE_SIMILAR`） |
| 出口 | 確認後的 Word 下載（既有 `POST /api/download-word`）；草稿不足時建議到覆蓋率補題 |

## 2. 版面配置 (Layout)

```text
#remedial（學生視圖）
  標題列（「補」icon ＋ eyebrow Remedial paper ＋ h2「依弱點出補救卷」＋ 說明）
  控制列（lg 八欄）：學生 #remStudent｜科目 #remSubject｜題數（5–50）#remTotal｜看哪段批改 #remDays｜補救 % #remMixRemedial｜先備 % #remMixPrereq｜延伸 % #remMixExt｜產生草稿 #remGenerate
  狀態列 #remStatus
  知識點掌握度 #remKc（最弱 10 個，Wilson 下界由弱到強）
  草稿 #remDraft：抬頭（姓名・科目・草稿 N 題 ＋ 判斷基準標籤）→ 系統說明 #remNotes（黃框）→ 依 bucket 分組（補救／先備／延伸／手動加入：每組列目標、理由、要幾題、找到幾題 → 題目卡片）→ 加題列（#remAddId ＋ 加題 #remAddBtn）→ 確認出卷 #remConfirm
  結果 #remResult：出卷成功後的「下載 Word 考卷 (.docx)」#remDownload

#coverage（題庫管理視圖）
  標題列（「覆」icon ＋ eyebrow Coverage ＋ h2「題庫覆蓋率」＋ 說明）
  控制列：科目 #covSubject｜學生（選填）#covStudent｜重新整理 #covRefresh
  熱度表 #covTable：依冊分段，每列一章：難度 1–5 五欄＋合計（＋選學生時「還沒寫過」）
  知識點題數 #covKc：每章一個 <details>（「章：n 個知識點，m 個還沒有題」）→ 每個知識點「名稱（code）：n 題」
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 學生（#remStudent、#covStudent） | select | `GET /api/students` | 覆蓋率的學生為選填 |
| 科目（#remSubject、#covSubject） | select | `GET /api/chapter-whitelist`（不寫死，含化學） | — |
| 題數（#remTotal） | number | → `total` | 預設 20，範圍 5–50 |
| 看哪段批改（#remDays） | select | → `days` | 最近 30／90／180／365 天，預設 90 |
| 配比（三欄 %） | number | → `mix`（只看比例） | 預設 60／20／20；可填 3／1／1 或把先備、延伸填 0 |
| 知識點掌握度 | 清單 | `GET /api/students/:id/weakness/kc` → `rows[]`、`untagged_graded` | 標題「知識點掌握度（Wilson 下界，由弱到強；N 個知識點有作答）」；每列 下界％・名稱・章・批改 n・答對率；`low_sample` 加「樣本不足」；另提示「另有 N 題已批改但還沒標知識點…」 |
| 判斷基準標籤 | 徽章 | `basis` | 「以知識點判斷弱點」／「以章節判斷弱點」 |
| 系統說明 | 黃框清單 | `notes[]` | 原樣列出（例：先備配額併入補救、實際題數少於要求） |
| 目標列 | 文字 | `blueprint[]`（target.name、rationale、wanted、got） | 「・目標：理由　要 n 題、找到 m 題」；`got < wanted` 時紅字 |
| 題目卡片 | card | `items[]`（question_id、chapter、difficulty、question_text_preview、follows_question_id、group_ids） | 題號・章・難度；承上題標「承上 #x」、有承上題的前題標「有承上題」；同組卡片左側紫色邊線；刪除鈕在組內時為「刪這組」 |
| 熱度格 | 表格儲存格 | `GET /api/coverage` → `rows[].by_difficulty`、`total`、`unseen_by_student` | 0 題 rose（紅）、1–2 題 amber（黃）、3–5／6–9／10 以上綠色漸深；選學生時難度五欄變淡、「還沒寫過」欄加框 |
| 知識點題數 | `<details>` | `kc_rows[]` | 0 題的知識點紅字粗體 |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 產生草稿 | #remGenerate | 並行 `POST /api/students/:id/remedial-paper`（body `{subject, total, mix, days}`；前端不送 `source_types`）與 `GET …/weakness/kc`（掌握度）；**不出卷、不寫庫**，可重複按（每次隨機換一批） | 單人系統，`x-api-key` |
| 刪題／刪這組 | 卡片按鈕 | 從草稿移除該題；承上組整組移除（含鏈與分岔） | 同上 |
| 用題目 ID 加題 | #remAddBtn（可逗號分隔多個） | 先 `GET /api/students/:id/remedial-paper/items?ids=` 取整組 → 組內全可出才**整組**加入「手動加入」組；任一題封存、已寫過、別科、查不到或已在草稿則不加並逐項提示 | 同上 |
| 加入補救卷（跨區塊） | 「找相似」結果列按鈕（`public/js/variants.js`〔stage5 WS-D〕） | dispatch `document` 上的 `remedial:add`（`detail.question_id`，另帶 student_id、subject、chapter、difficulty、question_text）；remedial.js 監聽後走同一套整組加題規則；別科題 toast「補救卷不混科」 | 同上 |
| 確認出卷 | #remConfirm | 前端先擋「前題不在草稿的承上題」→ 既有 `POST /api/confirm-paper { student_id, question_ids }`（同交易建卷＋attempts）→ toast「補救卷已出卷，並記入作答歷史。」並顯示下載鈕 | 同上 |
| 下載 Word | #remDownload | 既有 `POST /api/download-word` | 同上 |
| 看覆蓋率 | #covSubject／#covStudent 變更或 #covRefresh | `GET /api/coverage?subject=&student_id=` 重畫熱度表與知識點題數 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| 初始（無草稿） | #remDraft 內嵌提示 | 「選好學生與科目後按「產生草稿」。也可以從「找相似」的結果按「加入補救卷」。」 |
| 無知識點作答 | #remKc | 「這段時間內沒有任何已標知識點的作答，補救卷會以章節為單位判斷弱點。」 |
| 空草稿（完全沒批改） | 草稿 0 題＋黃框 notes | 伺服器 `notes` 原樣 |
| 不足量 | 目標列紅字＋`notes` 最後一句 | 「本草稿實際 N 題（要求 M 題）。不足的部分可以用題目 ID 手動加題，或到「題庫覆蓋率」看哪一章該補題。」 |
| Error（API） | toast | 伺服器 `{message}` 原樣；連線失敗「與後端連線中斷」 |
| 確認 409 | toast | 伺服器訊息（部分題目已被指派給該學生：草稿產生後又被出了其中某題，重新產生草稿即可） |
| 覆蓋率 Loading／Error | #covTable | 「載入中…」／「覆蓋率載入失敗：…」 |
| 無知識點 | #covKc | 「還沒有載入任何知識點（FEATURE_KC 的知識點分頁載入後，這裡會列出每個知識點掛了幾題）。」 |
| 旗標關閉 | 兩區塊整段不渲染；「加入補救卷」按鈕不出現 | — |
| Success | toast＋結果區 | 「補救卷已出卷，並記入作答歷史。」 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 產生草稿 | 色階加深 | 請求期間 disabled | #remStatus「產生草稿中…」→「草稿已產生（尚未寫入）：N 題。」 | toast 原樣顯示 `{message}`；草稿區保留上一份 |
| 刪這組 | 底色變化 | — | — | — |
| 加題 | 底色變化 | — | 查詢期間 | 查詢失敗「無法確認題目資料（…），沒有加入。」；草稿在查詢期間被換掉「草稿在查詢期間換掉了，請再加一次。」 |
| 確認出卷 | 色階加深 | 請求期間 disabled | — | 草稿空、超過 50 題、有缺前題的承上題時不送出並 toast |
| 加入補救卷 | 底色變化 | FEATURE_REMEDIAL 關閉時不渲染 | — | 沒選學生「請先在「依弱點出補救卷」選學生，再加入題目。」；草稿屬另一位學生時提示先確認或清掉；已在草稿「#id 已在補救卷草稿裡。」 |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| 學生、科目 | 必選 | 「請先選學生。」「請先選科目。」 | 產生草稿 |
| 題數 | 5–50 的整數 | 「題數要是 5–50 的整數。」 | 產生草稿 |
| 配比 | 三個非負數、不能全是 0（總和也須有限） | 「配比要是三個非負數，而且不能全是 0。」 | 產生草稿 |
| 加題 ID | 正整數（int4 範圍）、可逗號分隔 | 「看不懂的題目 ID：…」 | 加題 |
| 草稿題數 | 1–50（confirm-paper 上限） | 「草稿是空的。」「一張卷最多 50 題，請先刪掉一些。」 | 確認出卷 |
| 承上題完整 | 草稿內承上題的前題必須也在草稿 | 「承上題不能沒有前題：#x（承上 #y）…」 | 確認出卷 |
| 不混科 | 加入題目的科目須與草稿相同 | 「#id 是化學題，目前的草稿是數學；補救卷不混科，沒有加入。」 | 加題、`remedial:add` |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 控制列 `grid-cols-2`→`sm:grid-cols-4`→`lg` 八欄；熱度表外層 `overflow-x-auto` 橫向捲動。
- **鍵盤操作:** 全部原生 `<select>`／`<input>`／`<button>`；知識點題數為原生 `<details>`。
- **ARIA / 對比:** 各控制項有 `aria-label`（學生、科目、題數、看多久以內的批改、三個配比）；熱度格以數字＋顏色雙重編碼（0 題同時是紅底與數字 0）；「樣本不足」以文字徽章標示；伺服器文字一律 textContent。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| SSOT | `exam_pro/public/js/remedial.js`（兩區塊骨架全由 JS 建立；`index.html` 只有兩個空錨點；子錨點的 `VIEW_FOR_ANCHOR` 由整合補上，裁決 S5-2） |
| 跨 module 事件 | `remedial:add`（`document` 上的 CustomEvent；發送端 `public/js/variants.js` 的「加入補救卷」按鈕，裁決 S5-26） |
| 元件對照 | 經 `window.ExamApp` 橋接 `apiFetch`／`showToast`／`renderMath` |
| 本機預覽 | `?remedial=1` 手動開旗標（本機驗收用；API 在旗標關閉時仍回 404） |
| 測試 | `test/unit/remedialUi.test.js`（檔案契約、純函式、miniDom：旗標關閉不渲染、產生草稿、前端擋不合法輸入、刪題加題、`remedial:add`、確認並下載、承上題整組、不混科、覆蓋率、variants.js 掛鉤） |
| 已知限制 | 未在真瀏覽器驗證（Tailwind 版面、MathJax 題幹預覽）；確認後的卷名沿用 confirm-paper 規則（取第一題的章節），補救卷看起來像單章卷；跨章配額（blueprint）只有 API，組卷分頁沒有對應畫面；直接呼叫 confirm-paper 仍可送出半組承上題（把關只在本頁，裁決 S5-28） |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-030（知識點掌握度）、FR-031（補救卷）、FR-033（題庫覆蓋率）；FR-032 blueprint 無前端；ACPT-030-1、ACPT-031-1～3、ACPT-033-1 |
| 對應決策 | DEC-016（依弱點出題、補救／先備／延伸配比）、DEC-003（確認後新題不重複出） |
| 對應 ADR | [ADR-014](../03_architecture/adr/ADR-014-remedial-paper-wilson-quota.md) |
| 對應情境 | 無（SCN-001～016 皆不落於本頁） |
| 下游 | `../03_architecture/engineering_tracker.md`（FR-030～033 列）、`../05_qa/qa_tracker.md`（TC-030-*～TC-033-*） |
