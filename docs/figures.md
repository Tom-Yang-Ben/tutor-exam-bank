# 考卷附圖：辨識、裁切、入庫（figures）

2026-08-25 與使用者定案方向、2026-08-27 實作。目標：PDF 拆題時把附圖裁成圖檔存庫，並正確對應到所屬題目。

## 設計

Gemini 原生支援 bounding box 輸出（`[ymin, xmin, ymax, xmax]`，0–1000 正規化、頁面左上角為原點）。extract 節點在**同一次**拆題呼叫裡順便回框——不增加任何 LLM 呼叫成本；圖檔由程式端渲染＋裁切。題圖對應天然成立：框掛在 extract 回傳的題目物件上。

## 管線（五個環節）

| 環節 | 檔案 | 做什麼 |
| :--- | :--- | :--- |
| 1. Schema | `agents/schemas/extract.json` | 題目物件加**選填** `figure_page`（塊內頁碼，≥1）＋`figure_box`（4 整數，0–1000）；`figure_desc` 保留——verify 與向量檢索看不到圖，仍需文字描述 |
| 2. Agent | `agents/extract.js` | prompt【附圖與幾何圖形】段要求回頁碼與框；`normalizeElement` 把不成對或幾何不合法（ymin≥ymax 等）的框整組拿掉（**框壞掉只少圖、不少題**）；`validateElements` 把塊內頁碼換算成絕對頁碼（`chunk.fromPage + figure_page - 1`），超出本塊範圍＝模型數錯頁，整組丟掉 |
| 3. 裁圖 | `services/figureService.js`（由 `workers/jobRunner.js` 的 `attachFigureImages` 在 extract pass 後、**PDF 刪檔前**呼叫） | `mupdf`（npm WASM 版，Windows 免編譯）以 2x（≈144 DPI）渲染頁面 → `sharp` 依框裁切（四周各加框寬高 2.5% 邊距，夾在頁面內）→ 存 `data/figures/<jobId>-<idx>.png`，`figure_img` 寫回題目物件、隨 `payload.extract` 入列。純程式步驟、零模型成本；同頁多圖只渲染一次。任何失敗只記 warn，不讓拆題重來 |
| 4. 入庫 | `workers/jobRunner.js` 的 `saveNode`；`controllers/reviewController.js` 的 approve（既有） | `payload.extract.figure_img` 寫入 `questions.question_img`（欄位 0001 就有，**免 migration**）；`figure_desc` 併題幹的既有行為保留當備援。approve 路徑：`payloadToQuestion` 把 `figure_img` 放進 `question_img`，隨 body 送到既有的 `body.question_img` |
| 5. 顯示 | `app.js`（`/figures` 靜態掛載）；`public/js/review.js`；`public/index.html` | 複核卡片顯示裁圖（老師順便複核框的準度）；題庫列表卡片有 `question_img` 就顯示 |

## 邊界與已知限制

- **bbox 對 PDF 輸入「大致準」**：第一版靠複核畫面兜底；若偏太多，升級路徑是「帶圖頁面單獨渲染成 PNG 再做一次定位呼叫」（尚未實作，也未必需要）。
- **舊題不自動補圖**：要補得對原 PDF 重跑管線，或人工在 `questions.question_img` 填圖片 URL。
- `data/figures/` **不進版控**、不設清理排程：檔名 `<jobId>-<idx>.png` 是確定性的，崩潰重跑會覆寫同檔不堆積；刪 job 不會刪圖（questions 可能還引用著）。
- Word 匯出（`services/wordService.js`）只抓 **http(s) 公開 URL** 的圖（SSRF 白名單），`/figures/...` 相對路徑會被跳過——匯出的 Word 目前**不含**管線裁的圖，題幹裡的 `[附圖描述：…]` 文字是備援。要進 Word 需另外把本機路徑讀檔嵌入（尚未實作）。
- 舊的 `/analyze-pdf` 相容流程（`services/aiService.js`）不裁圖：它沒有 job 生命週期可掛。

## Cassette

改了 extract 的 prompt 與 schema → `promptTemplateHash`／`schemaHash` 都變，**extract 的舊 cassette 全部失效**（鍵算法見 `docs/llm.md` 第 3 節）。重錄：

```powershell
node scripts/record_cassettes.js --agent extract   # 需真金鑰；只錄公開樣卷
```

`figure_page`／`figure_box`／`figure_img` 都是選填且 `cacheKeyParts` 沒變，classify／verify／lint 的 cassette 不受影響。樣卷 `eval/fixtures/sample_exam.pdf` 是純文字排版、沒有附圖，錄出來的 cassette 自然不含框欄位——這正是「選填」要保證的相容性。
