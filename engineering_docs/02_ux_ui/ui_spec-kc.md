# UI 規格書：知識點分頁 (UI Spec – Knowledge Components) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-24 | **狀態:** 活躍（階段 5；實作於整合分支 `stage5/integration`，待併入 main）
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（`ui_spec-<page>.md`）
> 本文件定義知識點分頁（`exam_pro/public/js/kc.js`，掛入 `index.html` 的空錨點 `<section id="kc">`，位於 `view-kc` 視圖）的區塊、狀態與互動：依科目／冊／章瀏覽知識點、就地編輯與審定口語版、朗讀、「題目 → 知識點」人工標註小工具。資料模型、載入規則與 API 的權威文件是 [`docs/knowledge-components.md`](../../docs/knowledge-components.md)；決策見 [ADR-011](../03_architecture/adr/ADR-011-knowledge-component-model.md)。本檔只整理前端，不重述規則。

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

讓 Owner 逐章審定 AI 草擬的知識點，尤其是「口語版」——上課講給學生聽的說法，也是 AI 家教講解的依據。審定方式是「讀一遍、聽一遍（朗讀）、改到順口、按審定通過」。另附一個小工具，讓老師替單一題目指定知識點（人工標註優先於 AI）。`FEATURE_KC` 關閉時整段不渲染。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 頂欄「知識點」（`#kc`，`data-feature="kc"`；旗標關閉時 nav 連結隱藏） |
| 出口 | 無自動跳轉；知識點資料由補救卷（`ui_spec-remedial.md`）與 AI 家教（`ui_spec-tutor.md`）讀取 |

## 2. 版面配置 (Layout)

```text
標題列（eyebrow Knowledge Components ＋ h2「知識點」＋ 說明文）
篩選列：科目 #kcSubject ｜ 冊 #kcVolume ｜ 章 #kcChapter ｜ 狀態 #kcStatus ｜ 重新整理 #kcRefresh
摘要 #kcSummary（「數學：共 N 個知識點，已審定 M 個；這裡顯示 K 個。」）
清單 #kcList：依章分組（章名＋「已審定 m／n」）→ 知識點卡片（lg 兩欄）
題目 → 知識點 #kcTool：題號輸入 #kcQid ＋ 載入 #kcQLoad → 題目資訊 #kcQInfo → 目前標註 #kcQCurrent → 勾選區 #kcQPicker（同章在前、同科其他章收合）→ 已選數 #kcQCount → 儲存標註 #kcQSave
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 科目（#kcSubject） | select | `GET /api/chapter-volumes` 的鍵（不寫死） | 預設第一科；切換科目時重讀該科知識點（有快取） |
| 冊／章（#kcVolume、#kcChapter） | select | `chapter-volumes` 的冊與章 | 「全部冊」「全部章」；選冊後章清單只列該冊 |
| 狀態（#kcStatus） | select | 固定值：全部／草稿／已審定 | 只影響前端篩選 |
| 知識點卡片 | card | `GET /api/kc?subject=` → `items[]` | 頂端 `code`、狀態徽章（草稿／已審定）、「已標 N 題」；四個可編輯欄位；先備清單；按鈕列（朗讀、儲存修改、審定通過／改回草稿） |
| 名稱 | input | `name` | 1–30 字 |
| 說明（課綱式的精確敘述） | textarea | `description` | 1–200 字 |
| 口語版（直接對學生說、唸得出來） | textarea＋計數器 | `spoken_text` | 計數器「N 字（40–300）」；含 LaTeX 時加「⚠ 有 LaTeX，唸不出來」並轉紅 |
| 108 課綱學習內容代碼 | input | `curriculum_code` | placeholder「沒把握就留空（不得編造）」 |
| 先備 | 文字列 | `prereqs[]`（code、name） | 無先備顯示「（無）」；跨科先備照列 |
| 已標題數 | 文字（卡片頂端） | `question_count` | 「已標 N 題」，只數未封存題 |
| 題目資訊（#kcQInfo） | 文字 | `GET /api/questions/:id/kcs?detail=1` → `question` | `#id｜科目｜章｜題型｜難度 n`（封存題加「｜已封存」）＋題幹（經 `renderMath`） |
| 目前標註（#kcQCurrent） | chip 列 | 同上 → `items[]` | 「目前標註：」＋每個知識點（AI 標註帶信心分數）；沒有時「（尚未標註）」 |
| 勾選區（#kcQPicker） | checkbox 清單 | 該科 `GET /api/kc` | 同章知識點在前，其他章收在「同科其他章（n 章）」；草稿名稱後加「（草稿）」、滑過顯示 code；該章沒有知識點時提示「「章名」還沒有知識點；可以從同科其他章選。」 |
| 已選數（#kcQCount） | 文字 | 前端狀態 | 「已選 n／5」 |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 切換科目／冊／章／狀態 | select change | 科目改變重讀 `GET /api/kc?subject=`；其餘只重畫清單與摘要 | 單人系統，`x-api-key` |
| 重新整理 | #kcRefresh | 強制重讀目前科目 | 同上 |
| 儲存修改 | 卡片「儲存修改」 | `PATCH /api/kc/:id`，只送改過的欄位；成功以伺服器回的列重畫該卡並 toast「已儲存：名稱」 | 同上 |
| 審定通過／改回草稿 | 卡片切換鈕 | `PATCH /api/kc/:id`，`status` 連同**尚未儲存的修改**一起送出；toast「已審定：名稱」 | 同上（Owner 審定） |
| 朗讀／停止 | 卡片「朗讀」 | 瀏覽器 `speechSynthesis`（zh-TW）朗讀口語版；再按一次停止；朗讀前把 x²、H₂O、√、θ、π、≤、≥、≠、≈、×、÷、→ 轉成文字 | 同上 |
| 載入題目 | #kcQLoad 或 Enter（組字中不觸發） | `GET /api/questions/:id/kcs?detail=1`，畫出題目、目前標註與勾選區 | 同上 |
| 儲存標註 | #kcQSave | `PUT /api/questions/:id/kcs`（勾選的 0–5 個，`src='human'` 取代全部標註）；成功後重畫目前標註 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| Loading | #kcSummary | 「讀取中…」 |
| Empty（該科沒有知識點） | #kcSummary | 「數學還沒有知識點（先執行 npm run kc:load 載入種子檔）。」 |
| Empty（篩選後沒有） | #kcList 內嵌 | 「沒有符合篩選條件的知識點。」 |
| Error（讀不到科目） | #kcSummary | 「讀不到科目清單（/api/chapter-volumes），請重新整理頁面。」 |
| Error（儲存） | 卡片內錯誤列 | 伺服器 `{message}` 原樣，或「儲存失敗（HTTP n）」；按鈕恢復可按 |
| Error（題號） | toast | 「請輸入正整數題號。」；404 時顯示伺服器訊息 |
| 旗標關閉 | 整段不渲染（非隱藏） | console info「[kc] FEATURE_KC 未開啟：知識點分頁不渲染。」 |
| 瀏覽器不支援朗讀 | 「朗讀」按鈕不出現 | — |
| Success | toast＋卡片重畫＋摘要更新 | 「已儲存：…」「已審定：…」；標註「已儲存題目 #id 的知識點（人工標註）。」 |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 儲存修改／審定 | 底色變化 | 沒有任何修改時「儲存修改」disabled；請求期間該卡全部按鈕 disabled | — | 錯誤寫在卡片錯誤列，不清掉使用者輸入 |
| 朗讀 | 底色變化 | — | 朗讀中按鈕文字變「停止」 | 另一張卡開始朗讀時，前一張自動回到「朗讀」 |
| 儲存標註 | 色階加深 | 未載入題目前 disabled | — | toast 原樣顯示 `{message}`（別科知識點、超過 5 個等） |
| 勾選區 | — | — | — | 勾第 6 個時自動取消並 toast「一題最多標 5 個知識點。」；計數器顯示已選數 |

## 7. 驗證規則 (Validation)

前端檢查與伺服器 `utils/kcSeed.js` 的 `checkKcField` 同規則（先擋一次，伺服器是最終閘門）。

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| 名稱 | trim 後 1–30 字 | 「名稱要 1–30 字。」 | 儲存／審定 |
| 說明 | trim 後 1–200 字 | 「說明要 1–200 字。」 | 同上 |
| 口語版 | 40–300 字、不得含 LaTeX（`$` 或 `\` 開頭的指令） | 「口語版要 40–300 字（目前 N 字）。」／「口語版不能有 LaTeX（$ 或 \ 開頭的指令）：要能直接唸出來。」 | 同上 |
| 課綱代碼 | ≤40 字或留空 | 「課綱代碼最多 40 字；不確定就留空。」 | 同上 |
| 狀態 | draft／approved | 「狀態只能是草稿或已審定。」 | 同上 |
| 題號 | 正整數 | 「請輸入正整數題號。」 | 載入 |
| 勾選數 | 0–5 個 | 「一題最多標 5 個知識點。」（該勾選被取消） | 勾選 |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 卡片 `lg` 兩欄、以下單欄；篩選列 `flex-wrap`。
- **鍵盤操作:** 全部原生 `<select>`／`<input>`／`<textarea>`／`<button>`；題號輸入 Enter 載入（組字中不觸發，避免注音選字誤觸）。
- **ARIA / 對比:** 各輸入皆有 `aria-label`（名稱、說明、口語版、課綱代碼、題號）；伺服器回來的文字一律 `textContent` 或表單 `value`，不進 `innerHTML`；狀態以徽章文字＋顏色雙重編碼。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| SSOT | `exam_pro/public/js/kc.js`（骨架全由 JS 建立；`index.html` 僅空錨點與 `VIEW_FOR_ANCHOR.kc` 一行掛鉤〔stage5 WS-C〕） |
| 元件對照 | 經 `window.ExamApp` 橋接 `apiFetch`／`showToast`／`renderMath`；橋接缺席時停手並印一行錯誤 |
| 本機預覽 | `?kc=1` 手動開旗標（本機驗收用） |
| 測試 | `test/unit/kcUi.test.js`（純函式、檔案契約、miniDom 渲染：旗標、卡片、篩選、編輯、審定、朗讀、題目→知識點） |
| 已知限制 | 只在 miniDom 驗證，未在真瀏覽器開過；`speechSynthesis` 的 zh-TW 聲音品質因瀏覽器與作業系統差很多；草稿列的修改在重新 `kc:load` 時可能被種子檔覆寫，卡片上沒有提示（確定要保留請審定，或重載時用 `--file` 只載單科） |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-028（知識點瀏覽、編輯、審定、朗讀）、FR-029（人工標註）；ACPT-028-1～3、ACPT-029-1 |
| 對應決策 | DEC-015 |
| 對應 ADR | [ADR-011](../03_architecture/adr/ADR-011-knowledge-component-model.md) |
| 對應情境 | 無（SCN-001～016 皆不落於本頁） |
| 下游 | `../03_architecture/engineering_tracker.md`（FR-028／029 列）、`../05_qa/qa_tracker.md`（TC-028-*、TC-029-*） |
