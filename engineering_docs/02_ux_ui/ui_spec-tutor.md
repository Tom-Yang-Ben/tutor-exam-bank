# UI 規格書：AI 家教分頁 (UI Spec – Tutor) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-24 | **狀態:** 活躍（階段 5；實作於整合分支 `stage5/integration`，待併入 main）
> **Owner:** Ben（楊本顥）
> **語域:** L2
> **實例:** 每頁面一份（本篇對應 `<section id="tutor">`，位於 `view-tutor` 視圖，實作 `exam_pro/public/js/tutor.js`）
> **定位:** 本文件定義 AI 家教分頁的區塊、狀態與互動，含「按住說話」的逐字稿確認面板。API、脈絡組裝、成本與操作說明的權威文件是 [`docs/tutor.md`](../../docs/tutor.md)；決策見 [ADR-012](../03_architecture/adr/ADR-012-tutor-code-execution-spoken-text.md)（家教獨立於助教、code execution 驗算、口語版為講法依據）與 [ADR-013](../03_architecture/adr/ADR-013-push-to-talk-teacher-confirm.md)（按住說話、老師確認才送出、音訊不落地）。對話式助教（只讀工具）是另一個分頁，見 [`ui_spec-assistant.md`](./ui_spec-assistant.md)。

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

老師問高中數學、物理、化學的題目或觀念，AI 家教直接講解（direct）或一步一步引導（socratic）。產品主張：**AI 的答案要能被檢查**——每則回覆攤開模型用 code execution 跑過的程式與輸出，沒跑程式的明講「沒有驗算」，每則都標「AI 產生，請自行判斷」。語音只負責把話變成文字與公式，**老師按確認才送出**。`FEATURE_TUTOR` 關閉時整段不渲染；`FEATURE_VOICE` 關閉時不渲染按住說話。

| 導航 | 頁面 |
| :--- | :--- |
| 入口 | 頂欄「AI 家教」（`#tutor`，`data-feature="tutor"`；旗標關閉時 nav 連結隱藏） |
| 出口 | 無自動跳轉；家教不寫入任何資料（不出卷、不改題） |

## 2. 版面配置 (Layout)

```text
標題列（eyebrow AI Tutor ＋ h2「AI 家教」＋ 能力與隱私說明）
設定列（sm 四欄）：講解方式（直接講解｜引導式）｜科目 #tutorSubject｜學生 #tutorStudent｜題目 ID #tutorQuestionId
對話紀錄 #tutorLog（max-h 32rem 可捲動）：使用者氣泡 → 家教回覆（受限 Markdown＋數學式）→ 計算驗證 <details> → 依據列 → 「AI 產生，請自行判斷」＋本次花費
輸入框 #tutorInput（3 行，Ctrl／⌘＋Enter 送出）＋ LaTeX 即時預覽 #tutorPreview
動作列：🎙 按住說話 #tutorMic ＋ 說明 #tutorMicNote（FEATURE_VOICE）｜清除對話｜字數 N／1000｜送出 #tutorSend
語音逐字稿面板 #tutorVoiceReview（預設隱藏）：逐字稿 #tutorVoiceText ＋ 公式預覽 ＋ 歧義 chip ＋ 辨識出的公式 ＋ 確認送出 #tutorVoiceConfirm ／ 取消 #tutorVoiceCancel
```

## 3. 欄位與元件 (Fields / Components)

| 欄位 | 型態 | 來源（API 欄位） | 顯示規則 |
| :--- | :--- | :--- | :--- |
| 講解方式 | 兩鍵切換（`aria-pressed`） | 前端狀態 → `mode` | 直接講解（`direct`，預設）＝完整解題並給答案；引導式（`socratic`）＝一次只給一步 |
| 科目（#tutorSubject） | select | `GET /api/chapter-whitelist`（不寫死，含化學） | 「（不指定）」；有題目 ID 時以題目科目為準 |
| 學生（#tutorStudent） | select | `GET /api/students` → `items[]` | 「（不指定）」；標籤「學生（弱點會代號化後帶入）」 |
| 題目 ID（#tutorQuestionId） | text（numeric） | → `question_id` | placeholder「例如 12（留空＝不指定）」 |
| 輸入框（#tutorInput） | textarea | → `message` | `maxlength` 1000；下方字數「N／1000」；含 `$…$` 時 250 ms 後更新預覽（`renderMath`） |
| 使用者氣泡 | 靠右 | 本地輸入 | 純 textContent |
| 家教回覆 | 靠左 | `POST /api/tutor` → `reply` | **先整段 escape**，再轉受限 Markdown（段落、條列、粗體、行內與區塊程式碼；`#` 標題轉粗體段落；無連結、無圖片、無來自文字的屬性），最後 `renderMath`；被截斷時末段顯示「⚠ 回覆因長度上限被截斷」 |
| 計算驗證 | `<details>` | `verification.runs[]`（code、outcome、output） | summary「計算驗證：執行了 N 段程式（M 段未成功），點開看程式與輸出」；每段「第 i 段（結果）」＋程式碼與輸出（一律 textContent）；`verification.used = false` 時改顯示「⚠ 這則回覆沒有執行程式驗算，數值請自行核對。」 |
| 依據列 | 文字 | `context`（question_id、kc_codes、student_context） | 「依據：題目 #12｜知識點 MATH.向量內積.02、…｜已帶入學生弱點摘要（代號化）」；沒帶學生時末段為「沒有帶入學生資料」 |
| 花費列 | 文字 | `usage.costUsd` | 「AI 產生，請自行判斷。　本次約 US$…」 |
| 錯誤氣泡 | 靠左、rose 底 | 伺服器 `{message}` | 原樣顯示（429 預算用完、502 LLM 失敗等） |
| 按住說話（#tutorMic） | button（`aria-pressed`） | `navigator.mediaDevices.getUserMedia`＋`MediaRecorder` | 可用條件：安全來源（localhost 或 HTTPS）、瀏覽器支援錄音、桌機（`any-pointer: fine`）；不可用時不出現，#tutorMicNote 寫原因 |
| 逐字稿（#tutorVoiceText） | textarea | `POST /api/voice/transcribe` → `text` | 可直接修改；下方公式預覽 |
| 歧義 chip | chip 列 | `ambiguities[]`（spoken、options） | 「有幾段公式聽起來有兩種寫法，請點選正確的那一個：」；點選即替換逐字稿中的對應公式 |
| 辨識出的公式 | 清單 | `math_segments[]`（spoken、latex） | 「辨識出的公式：」＋口述與 LaTeX 對照 |

## 4. 使用者操作 (Actions)

| 操作 | 觸發 | 結果 | 權限 |
| :--- | :--- | :--- | :--- |
| 送出提問 | 「送出」或 Ctrl／⌘＋Enter | `POST /api/tutor`（body `{message, mode, subject?, student_id?, question_id?, history}`，history 帶最近 8 則訊息）；回覆氣泡、計算驗證、依據、花費依序追加並捲到底 | 單一使用者（x-api-key） |
| 切換講解方式 | 兩鍵切換 | 只改下一則的 `mode` | 同上 |
| 清除對話 | 「清除對話」 | 清空紀錄與 history；toast「已清除對話（家教不會記得之前說過的內容）。」 | 同上 |
| 按住說話 | 按住 #tutorMic（或焦點在按鈕上按住空白鍵）說話、放開 | 錄音（最長 60 秒；短於 0.6 秒視為誤觸不上傳）→ `POST /api/voice/transcribe`（multipart `audio`＋`subject`）→ 開啟逐字稿面板 | 同上 |
| 點選歧義 | chip | 逐字稿中的公式換成選中的寫法 | 同上 |
| 確認送出 | #tutorVoiceConfirm | 以逐字稿內容走「送出提問」；**成功才關閉面板**，失敗（上一則還在等、題目 ID 不合法、家教回錯、連線失敗）時逐字稿保留，可修正後再按 | 同上 |
| 取消 | #tutorVoiceCancel | 關閉面板、什麼都不送 | 同上 |

## 5. UI 狀態 (States)

| 狀態 | 呈現 | 文案 |
| :--- | :--- | :--- |
| 初始 | 紀錄區置中提示 | 「「直接講解」會完整解題；「引導式」一次只給一步，讓學生自己先試。」 |
| Loading | 送出鈕 disabled；語音確認鈕在請求期間 disabled | — |
| Busy（上一則未回） | toast，不送出 | 「上一則還在等家教回覆，回覆之後再送出。」 |
| Success | 回覆氣泡＋計算驗證＋依據＋花費 | `reply` |
| 未驗算 | 回覆下方警示 | 「⚠ 這則回覆沒有執行程式驗算，數值請自行核對。」 |
| 截斷 | 回覆末段 | 「⚠ 回覆因長度上限被截斷：後面的內容（包括最後的「驗算」結論）可能不完整…」 |
| Error（HTTP 非 2xx） | 錯誤氣泡 | 伺服器 `{message}`（例：「今天的 AI 家教預算已用完…」「AI 家教暫時無法回應：…」） |
| 錄音中 | #tutorMic 轉 rose 色並閃動 | —；若在麥克風權限對話框期間就放開，當作沒錄並 toast「按住按鈕說話，說完再放開。」 |
| 錄音太短／沒內容 | toast | 「錄音太短了：按住按鈕說話，說完再放開。」「沒有聽到內容，請再錄一次。」 |
| 麥克風權限被拒 | toast | 「麥克風權限被拒絕：請在網址列左側的網站設定允許麥克風。」 |
| 麥克風不可用 | 不渲染按鈕，#tutorMicNote 說明 | 「按住說話只能在 localhost 或 HTTPS 網址下使用…」「這個瀏覽器不支援錄音（getUserMedia／MediaRecorder），請改用新版 Chrome、Edge 或 Firefox。」「按住說話本階段只支援桌機（手機與平板之後再開放）。」 |
| 旗標關閉 | FEATURE_TUTOR 關：整段不渲染；FEATURE_VOICE 關：無按住說話與逐字稿面板 | — |

## 6. 互動規格 (Interaction Spec)

| 元素 | Hover | Disabled | Loading | 錯誤反應 |
| :--- | :--- | :--- | :--- | :--- |
| 送出 | 色階加深 | 等待回覆期間 disabled | — | 錯誤以氣泡入列，保留上下文；失敗輪不寫入 history |
| 按住說話 | 底色變化 | 不可用時不渲染 | 錄音中閃動 | 轉寫失敗 toast 原樣顯示 `{message}`（「語音轉寫失敗（n）」）；連線失敗「連線失敗，語音沒有送出。」 |
| 確認送出 | 色階加深 | 請求期間 disabled | — | 失敗時面板與逐字稿保留（不需重錄，避免再付一次語音費） |
| 歧義 chip | 邊框變色 | — | — | 逐字稿已被改到找不到該段公式時 toast「逐字稿裡找不到這段公式（可能已經改過），請直接在上面的文字框修改。」 |

## 7. 驗證規則 (Validation)

| 欄位 | 規則 | 錯誤訊息 | 觸發時機 |
| :--- | :--- | :--- | :--- |
| message | trim 後非空，≤1000 字（與 `services/tutorService.js` 一致） | 「一次最多 1000 字（目前 N 字）。」 | 送出 |
| 題目 ID | 空或 1–2147483647 的正整數（int4 上限，與後端一致） | 「題目 ID 要是正整數（或留空）。」 | 送出 |
| history | 前端只帶最近 8 則訊息（`HISTORY_KEEP`；一問一答算兩則）、每則 ≤4000 字 | 無（前端先切，後端超過 8 輪回 400） | 送出 |
| 錄音 | 60 秒內自動停止；< 0.6 秒不上傳；mime 取瀏覽器支援且後端接受的第一個（webm／ogg／mp4） | 見 §5 | 錄音 |
| 逐字稿 | 非空 | 「逐字稿是空的。」 | 確認送出 |

## 8. 響應式與無障礙 (Responsive / A11y)

- **斷點行為:** 設定列 `sm` 四欄、以下單欄；氣泡 `max-w-[85%]`；紀錄區固定最大高度捲動。按住說話只在桌機（`any-pointer: fine`）顯示，文字家教在手機上照常可用。
- **鍵盤操作:** Ctrl／⌘＋Enter 送出（組字中不觸發）；按住說話可用鍵盤（焦點在按鈕上按住空白鍵）；`<details>` 原生可操作。
- **ARIA / 對比:** 紀錄區與預覽 `aria-live="polite"`；講解方式與按住說話以 `aria-pressed` 標示狀態；輸入框、逐字稿、各選單皆有 `aria-label`；伺服器回來的文字一律 textContent，唯一例外是回覆的受限 Markdown（先 escape 再轉換，XSS 案例有單元測試）。

## 9. 設計交付 (Design Handoff)

| 項目 | 連結／位置 |
| :--- | :--- |
| SSOT | `exam_pro/public/js/tutor.js`（骨架全由 JS 建立；`index.html` 僅空錨點與 `VIEW_FOR_ANCHOR.tutor` 一行掛鉤〔stage5 WS-E〕） |
| 元件對照 | 經 `window.ExamApp` 橋接 `apiFetch`／`showToast`／`renderMath` |
| 測試 | `test/unit/tutorUi.test.js`（renderMarkdown 的 XSS 與巢狀佔位符、麥克風可用性、歧義替換；miniDom 實跑：旗標關閉不渲染、送出與回覆呈現、錄音→逐字稿→chip→按確認才送出、取消不送、確認失敗保留逐字稿） |
| 已知限制 | 只在 miniDom＋假 MediaRecorder 驗證，**未在真瀏覽器錄過音**；Gemini 是否接受 Chrome 錄的 audio/webm 未實機驗證（官方清單有列，退路是前端轉 16 kHz WAV）；對話不存 DB、重整即歸零；題目附圖不送給家教（prompt 提醒看不到圖）；MathJax 未載入 `ui/safe`，受 LLM 影響的數學式理論上可產生 `javascript:` 連結（全站既有風險，裁決 S5-35）；`docs/tutor.md` 操作說明寫「記得最近 8 輪對話」，實際是 8 則訊息（約 4 次問答） |

## 10. 追溯

| 項目 | ID |
| :--- | :--- |
| 對應需求 | FR-034（AI 家教）、FR-035（按住說話）；ACPT-034-1～4、ACPT-035-1～2；NFR-001（受限 Markdown）、NFR-007（預算）、NFR-008（錄音不落地、姓名不出境） |
| 對應決策 | DEC-018（語音先限桌機、計算驗證選 code execution） |
| 對應 ADR | [ADR-012](../03_architecture/adr/ADR-012-tutor-code-execution-spoken-text.md)、[ADR-013](../03_architecture/adr/ADR-013-push-to-talk-teacher-confirm.md) |
| 對應情境 | 無（SCN-001～016 皆不落於本頁） |
| 下游 | `../03_architecture/engineering_tracker.md`（FR-034／035 列）、`../05_qa/qa_tracker.md`（TC-034-*、TC-035-*） |
