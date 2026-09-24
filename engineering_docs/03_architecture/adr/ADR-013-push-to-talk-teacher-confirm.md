# ADR-013: 語音輸入採按住說話、老師確認才送出、音訊不落地 (Push-to-Talk with Teacher Confirmation) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受（實作於 `stage5/ws-e`；需求側 DEC-018 待 Owner 簽核，「語音先限桌機」選項 a 由 Owner 2026-09-24 於對話中選定）
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「口述提問為何做成按住說話＋逐字稿確認、而非即時語音或直接送出，以及錄音為何不落地」；API 與操作說明歸 [`docs/tutor.md`](../../../docs/tutor.md) 第 2.4、3.2 節，介面合約歸 `docs/interfaces-stage5.md` 第 4.5 條第 3、4 點；家教本身的決策歸 [ADR-012](./ADR-012-tutor-code-execution-spoken-text.md)。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: DEC-018 要求「我可以直接用說的問問題」，並訂明「按住說話後轉成文字與數學式，老師確認後才送出，第一階段只在桌機使用」（缺口 G08）。系統原本沒有任何音訊輸入：`gemini.toContents` 只收文字與 PDF，前端沒有麥克風程式碼。
- **問題**: 口述數學式本身有結構歧義——「x 平方加一分之一」可以是 $\frac{1}{x^2+1}$ 也可以是 $x^2+\frac{1}{1}$，「根號 x 加一」可以是 $\sqrt{x+1}$ 也可以是 $\sqrt{x}+1$。轉寫模型再好也只能猜；把猜的結果直接送進家教，錯的題目只會換來更快、更流暢的錯誤講解（缺口分析引述的 Speech-to-LaTeX 研究，最佳模型的等式字元錯誤率仍約 17.5%，且沒有中文資料集）。另要決定：轉寫用什麼、錄音怎麼保存、在哪些裝置開放。
- **驅動因素/約束**:
  - LLM 呼叫只經 `services/llm`；不新增 npm 依賴；單機、無 GPU。
  - 錄音是比文字更敏感的個資（聲紋、可能講出學生姓名），而姓名遮罩只能作用在文字上（DEC-009）。
  - 瀏覽器只在安全環境（localhost 或 HTTPS）開放 `getUserMedia`。
  - 會花錢：要有限流與成本上限，並與家教共用每日預算。

## 2. 考量的選項

### 選項一: 即時雙向語音（Gemini Live API）
- **描述**: 瀏覽器以 WebSocket 與 Live API 持續串流音訊，模型即時回話。
- **優點**: 最接近真人對話；延遲低。
- **缺點**: 沒有「確認」的時機——說出口的歧義公式直接進入對話；需要 ephemeral token、session 續接（純音訊 session 有時間上限）、另一套 cassette 做法；與 code execution 驗算、姓名遮罩的整合都要重做。
- **成本/複雜度**: 高

### 選項二: 瀏覽器內建語音辨識（Web Speech API `SpeechRecognition`）
- **描述**: 用瀏覽器的語音轉文字，再把文字送給家教。
- **優點**: 零伺服器成本、即時顯示。
- **缺點**: 只產出一般文字，數學式要另外轉 LaTeX（又回到歧義問題）；各瀏覽器支援度不一（Firefox 未預設提供）；Chrome 的實作同樣把音訊送到雲端，並沒有比較私密；不經 `services/llm`，無法 record/replay 測試。
- **成本/複雜度**: 低

### 選項三: 本機語音辨識模型（例如專攻台灣華語的開源 ASR）
- **描述**: 在伺服器端跑開源 ASR，再以 LLM 轉 LaTeX。
- **優點**: 錄音完全不出境。
- **缺點**: 需要 GPU 或可觀的 CPU 時間；多一個 Python 執行環境；仍然要第二步把口述數學轉成 LaTeX。
- **成本/複雜度**: 高

### 選項四: 按住說話＋Gemini 音訊輸入（受限 JSON）＋逐字稿確認（採用）
- **描述**: 前端 MediaRecorder 錄一段；放開後上傳 `POST /api/voice/transcribe`；伺服器以 `MODEL_VOICE` 走 `generateJson`（parts 含音訊），回 `{ text, math_segments, ambiguities }`；前端顯示**可編輯**的逐字稿與公式預覽，歧義以 chip 讓老師點選，**老師按確認才送給家教**。
- **優點**: 歧義在送出前由人解決；沿用 `services/llm`（cassette、節流、成本估算）；輸出格式由 schema 鎖定並在伺服器端以 ajv 再驗；不需新依賴。
- **缺點**: 多一個確認步驟、非即時；錄音本身會送到 Gemini（無法遮罩）；依賴 Gemini 對瀏覽器錄音格式的支援。
- **成本/複雜度**: 中

## 3. 決策

**選擇**: 選項四，並附四項配套決策。

1. **確認不可省**——轉寫結果一律先進可編輯面板；歧義列成 chip（`options[0]` 是寫進逐字稿的那一個，點選即替換）；只有「確認送出」會呼叫家教，「取消」什麼都不送。前端測試以假 MediaRecorder 走完整流程，斷言確認之前 `/api/tutor` 呼叫次數為 0。
2. **音訊不落地**——`multer.memoryStorage()`（不沿用既有會寫 `uploads/` 的上傳設定），≤ 5 MB、單一檔案、五種 mime（比對前剝掉 `;codecs=` 參數）；請求結束即清掉 buffer；不寫 DB、不進 log；cassette（record 模式）只存位元組數與 sha256，鍵也只用錄音雜湊。整合測試斷言上傳前後 `uploads/` 檔案數不變。
3. **只在安全環境與桌機開放**——非 localhost／HTTPS、瀏覽器缺 `getUserMedia`／`MediaRecorder`、或沒有精準指標（`any-pointer: fine`，視為非桌機）時，隱藏按鈕並寫明原因（DEC-018 的 D3 = a）。一段最多 60 秒、短於 0.6 秒視為誤觸。
4. **成本與限流獨立於家教、預算共用**——`VOICE_RATE_LIMIT_PER_MIN`（預設 10）是獨立的限流桶；花費併入 `TUTOR_DAILY_BUDGET_USD`，模型輸出不合 schema（502）時這次的花費照樣記帳。

選項一列為第二段（需求穩定、確認流程有替代設計之後再評估）；選項二因無法產出 LaTeX、支援度不一而放棄；選項三留待「錄音不得出境」成為硬需求時再評估。

## 4. 後果

- **正面**: 老師可以用說的提問，且口述公式的歧義在送出前被人看過；錄音不留在本機任何地方；語音與家教共用同一套測試（replay）、成本與遮罩基礎設施。
- **負面**: 非即時、多一步確認；錄音本身會送到 Gemini，**學生姓名若被說出口無法遮罩**（操作說明要求不要在錄音中講學生全名；轉寫後的文字送給家教前會再遮罩）；Chrome 的 MediaRecorder 主要錄 `audio/webm`（opus），**Gemini 是否接受 `audio/webm` 尚未實機驗證**；`config/pricing.js` 沒有音訊輸入的分開單價，語音成本可能被低估；手機與平板暫不支援。
- **影響範圍**: `exam_pro/services/voiceService.js`、`exam_pro/controllers/tutorController.js`（`transcribe`、`handleVoiceUploadError`）、`exam_pro/routes/index.js`（memoryStorage 上傳）、`exam_pro/services/llm/gemini.js`（`toContents` 的音訊 part）、`exam_pro/services/llm/cassette.js`（音訊摘要）、`exam_pro/public/js/tutor.js`（按住說話與確認面板）。
- **重新評估觸發**: 實機驗證 Gemini 不接受 `audio/webm`（改錄其他格式或伺服器端轉檔）；老師回報確認步驟過於頻繁且歧義 chip 幾乎都選第一個（可考慮無歧義時一鍵送出）；需要在手機上使用；需要即時對話（選項一）；或錄音不得出境成為硬需求（選項三）。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-018（N5；語音先限桌機）、DEC-009；缺口 G08；`docs/interfaces-stage5.md` 第 4.5 條第 3、4 點 |
| 影響範圍 | [`docs/tutor.md`](../../../docs/tutor.md)、`docs/interfaces-stage5.md`、`../engineering_tracker.md`（整合階段回填） |
| 取代關係 | 無；建立在 [ADR-012](./ADR-012-tutor-code-execution-spoken-text.md) 的家教服務之上 |
