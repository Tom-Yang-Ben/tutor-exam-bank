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
- **舊題不自動補圖**：管線只替新拆的題裁圖。舊題由老師另外跑 `npm run figures:backfill`（提議 → 確認 → 套用），見下方「舊題補附圖」〔修訂 2026-09-26，Owner 決策單 2026-09-25 B20〕。
- `data/figures/` **不進版控**、不設清理排程：檔名 `<jobId>-<idx>.png` 是確定性的，崩潰重跑會覆寫同檔不堆積；刪 job 不會刪圖（questions 可能還引用著）。
- 舊的 `/analyze-pdf` 相容流程（`services/aiService.js`）不裁圖：它沒有 job 生命週期可掛。

## Word 匯出（2026-09-16 實作）

`services/wordService.js` 的 `generateExamPaperDocx` 對 `question_img` 分兩條路：

| `question_img` 形狀 | 做法 |
| :--- | :--- |
| `/figures/<檔名>`（管線裁圖） | 直接讀 `data/figures/` 內的本機檔，以 docx `ImageRun` 嵌在題幹段落之後、置中 |
| `http(s)://…` | 沿用既有 SSRF 白名單＋下載（不變，固定 300×200） |

- **路徑安全**：`resolveFigurePath` 兩道檢查——檔名白名單 `^/figures/[A-Za-z0-9_-]+\.(png|jpe?g)$`（**不分大小寫**，`.PNG`／`.JPG` 也接受；比對前先去掉前後空白；不含 `/`、`\`、`..`、URL 編碼），再確認 `path.resolve` 後的上層目錄就是附圖目錄（這道獨立生效：白名單日後放寬也擋得住跳目錄，有單元測試釘住）。不合法的路徑**不讀檔**。
- **尺寸**：`sharp` 讀原圖像素；裁圖是 144 DPI（`RENDER_SCALE`＝2），換回 96 DPI 即原卷上的實際大小（×2/3），超過 A4 預設版面可用寬 600 px 或高 800 px 才等比例縮小；不放大、不變形。
- **失敗不擋整份**：檔案不存在、不是圖、格式不支援、路徑不合法——該題題幹後放一行「（附圖遺失）」，伺服器 `console.warn`（帶 `question_id`，只記檔名不記完整路徑），其餘題照常匯出。
- 題幹裡的 `[附圖描述：…]` 文字照舊保留（verify／檢索仍需要，Word 內與圖並存）。

仍未做（本次範圍外）：`/analyze-pdf` 舊流程不裁圖。舊題補圖見下一節〔修訂 2026-09-26〕。

## 舊題補附圖（2026-09-26 實作）〔Owner 決策單 2026-09-25 B20〕

2026-08-27 前入庫的題沒有附圖（roadmap 待決策第 19 項）。Owner 選「做」：用原卷 PDF 重跑裁圖、對到題庫裡沒有附圖的題，**寫進題庫前每一題都由老師確認**。流程與章節搬遷（`npm run chapters:migrate`）相同：提議檔 → 老師刪掉不要的列 → 套用。

### 老師的操作步驟

1. 先啟動資料庫（雙擊 `exam_pro\啟動資料庫.bat`）。
2. 把放原卷 PDF 的資料夾（例如桌面上的「各校考卷」）**拖到** `exam_pro\scripts\windows\backfill_figures.bat` 的圖示上放開（或雙擊它，畫面問的時候把資料夾拖進視窗、按 Enter）。子資料夾裡的 PDF 也會掃。這一步**只產生提議，不寫資料庫、不呼叫任何 AI 模型**。
3. 跑完會自動打開預覽頁 `preview.html`：每一列是「裁出來的圖」與「題目」並排。橘底的列分數低於 0.8（圖跨兩題、頁首接續上一頁、或題幹在原卷只找到一部分），請特別看。
4. 用 Excel 開同一個資料夾的 `proposals.csv`，**不要套用的題把整列刪掉**，其他欄位不用改；存檔時選「CSV UTF-8（逗號分隔）」（選一般 CSV 也可以，工具會自動辨識 Big5）。
5. 在 `exam_pro` 資料夾開命令列，執行畫面最後印出的那一行：`npm run figures:backfill -- --apply "<提議檔路徑>"`。
6. 題庫頁、複核頁與 Word 匯出就會出現附圖。之後再跑第 2 步，補過的題不會再列出；刪掉的列下次會再列出來（想永遠跳過就每次刪掉）。

提議檔、預覽頁、暫存圖都留在 `exam_pro\data\figure-backfill\<時間>\`（`data/` 不進版控），log 在 `exam_pro\data\figure-backfill\dry-run_<時間>.log`。

### 指令

| 指令 | 做什麼 |
| :--- | :--- |
| `npm run figures:backfill -- --dir "<資料夾>"` | ＝ `--dry-run`（預設）：只讀資料庫，產生 `data/figure-backfill/<日期>/` 底下的 `proposals.csv`、`preview.html` 與暫存圖 `q<題號>.png`（同一天第二次改用 `<日期>-2`，絕不覆寫） |
| `… --out-dir "<資料夾>"` | 提議檔改放指定資料夾（裡面已有 `proposals.csv` 就拒絕）；雙擊腳本用這個固定輸出位置 |
| `… --use-llm [--subject-group math_physics\|chemistry]` | 另外呼叫拆題模型框圖，見下方「--use-llm」；**預設不呼叫任何 LLM** |
| `npm run figures:backfill -- --apply "<proposals.csv>"` | 套用老師確認過的提議檔（單一交易） |
| 加 `--test` | 改打 `TEST_DATABASE_URL`（庫名必須以 `_test` 結尾） |

提議檔欄位（順序凍結；`--apply` 以表頭名稱找欄，只讀「題號」與「圖檔暫存路徑」）：`題號, 科目, 章, 題幹前60字, 來源PDF, 頁碼, 圖檔暫存路徑, 比對分數, 依據`。

### 哪張圖屬於哪一題（`utils/figureLayout.js`，純函式）

新管線靠拆題模型在同一次呼叫裡回框（上方「管線」第 2 環節）；舊題沒有那一次呼叫，所以預設改用**確定性的版面規則**（`services/pdfLayout.js` 以 mupdf 讀出每頁的字行位置與圖形元素）：

1. **找圖**：向量線條／填色與點陣圖，相距 6pt 內併成一張。不算圖的：寬或高不到 24pt（底線、分隔線）、蓋住六成以上頁面（底圖、頁框、掃描頁）、白色填色、表格（只有水平／垂直線、橫豎各兩條以上貫穿、框內有字——表格依本文件是題目文字）、行內算式（圖框三成以上被一般文字行蓋住）。圖旁 10pt 內的標註併進裁切範圍：短字（頂點 A、B，座標軸 x、y，選項代號）與刻度列（沒有中文字、落在圖的寬度內的一行，例：「0 1 2 3 4 t(s)」）；題號不併。
2. **定位題目**：與原卷比對（`docs/source-check.md`）同一套中文字 5-gram，題幹在原卷文字層的覆蓋率 ≥ 0.8 才算找到；題幹末尾的「[附圖描述：…]」先去掉。中文字少於 12 字的題不比。
3. **分題**：題號行（`12.`、`12、`、`( )12.`）、大題標題（`二、`）、題組說明與定位到的題目起點把卷面切成段；圖屬於**垂直方向重疊最多**的那一段（雙欄卷分左右欄），該欄第一段之前的圖接續上一欄／上一頁最後一段。段的主人是定位在那裡的候選題；沒有主人的段（題庫沒有、已有附圖、或找不到題幹）上的圖不提議。
4. **同一題有多張圖**：同一頁的併成一張（一題只有一個 `question_img`），分在不同頁時取面積最大的那頁。
5. **中文字一樣、只差數字的兩題**（例：同一題的兩個版本都入了庫）定位到同一處時，數字與字母較相符的那題留下。

**比對分數**＝題幹覆蓋率 × 版面係數（圖整張或六成以上在該題範圍內＝1；跨兩題＝重疊比例 ÷ 0.6；頁首接續上一頁＝0.9）。**依據**欄寫給老師看：題幹覆蓋率、版面（在範圍內／大半在範圍內／跨兩題／頁首接續）、併了幾張圖、扁長（可能是算式圖片）、原卷與入庫紀錄相符（`jobs.pdf_sha256`，新管線入庫的題才有）、來源註記（`questions.source_detail`）與檔名相符、題幹有沒有提到圖。

**候選題**：`question_img` 為空的題，含已封存（題幹欄加「（已封存）」），**不含變式題**（不在原卷上、數字改過）。題目當初若由資料夾裡某一份 PDF 拆出（`jobs.pdf_sha256` 相符），只在那一份找。多份卷都有提議時取一：入庫紀錄相符 → 來源註記相符 → 分數高 → 路徑。

### --use-llm（只在明確加旗標時才呼叫模型）

確定性規則用不上的卷——**掃描檔（沒有文字層）**，以及「題幹提到圖、原卷也找到了題目，卻沒偵測到圖」的卷——加 `--use-llm` 時照新管線呼叫 `agents/extract.js`（`MODEL_EXTRACT`；本機模式是 OCR＋視覺模型、在 CPU 上很慢；切塊設定與管線相同），拿模型回的 `figure_page`＋`figure_box` 裁圖（換算與邊距同新管線的 `boxToPixels`），以模型抄的題幹對題庫（中文字 5-gram 相似度 ≥ 0.8）。卷別預設依定位到的題判斷（多數是化學就用化學卷的 prompt），判斷不出來當數學／物理；可用 `--subject-group` 指定。同一題兩種方法都有提議時用確定性的（向量外框比模型框準）。雙擊腳本不帶這個旗標。

### 寫入（`--apply`）

- **單一交易**：先逐列驗證（題號、沒有重複列、暫存圖存在且是 PNG、**圖檔必須在提議檔所在的資料夾裡**——提議檔是可以改的文字檔，不能讓它把任意檔案複製進對外供圖的目錄），任何一列不過整批不寫；題號不存在 → 回滾；中途失敗 → 回滾並刪掉這次新放的圖檔。整個提議資料夾搬過位置也可以，會以檔名在提議檔旁邊找回暫存圖。
- 暫存圖複製成 `data/figures/backfill-<題號>-<圖檔 sha256 前 8 碼>.png`，`questions.question_img` 寫 `/figures/<檔名>`——與新管線入庫的形狀相同，Word 匯出的白名單（`resolveFigurePath`）直接認得。
- **已經有附圖的題略過並警告**：是本工具先前套用的同一張圖＝重跑同一份提議檔（冪等，圖檔被刪過會補回）；不是的，列出題號與題庫現值，以題庫現值為準。
- **沒有新 migration**：`question_img` 本身就是「補過了」的標記（之後的 dry-run 不再列出、重跑不重寫），提議檔與暫存圖留在 `data/figure-backfill/` 當紀錄。

### 已知限制

- **未以真實原卷校準**（原卷不進 repo）；上面的門檻是依版面常識定的，CI 以自製小 PDF 驗證。第一次實跑後請記下提議數與老師刪掉的列數，作為調整依據。
- 掃描檔、以及文字被轉成曲線的 PDF 沒有文字層，確定性規則用不上（只能 `--use-llm`）。
- 又細又扁的圖（例：只有一條線與刻度的數線，高不到 24pt）會被當成底線而漏掉；只有水平／垂直線、框內又有字的圖（例：加了外框的長條圖）可能被當成表格而漏掉——這兩種題幹若提到圖，dry-run 會列在「題幹提到圖、原卷也找到了，卻沒有偵測到圖的題」；圖旁 10pt 內的短句（例：題幹最後一行「求 k。」）可能被併進裁切範圍——預覽頁看得出來，刪列即可。
- 題組的共同附圖只會落在題組說明那一段（通常沒有主人，不提議）；各小題需要時請個別處理。
- 一題只補一張圖（`question_img` 單欄）。
- **題庫頁目前不能清除或更換附圖**（`PUT /api/questions/:id` 不改 `question_img`）：套錯的題要請維護者清掉該題的 `question_img`。所以 `--apply` 之前請務必看過預覽頁。

程式：`scripts/backfill_figures.js`（CLI、提議檔、套用）、`utils/figureLayout.js`（版面規則，純函式）、`services/pdfLayout.js`（mupdf 讀版面、依框裁圖）、`scripts/windows/backfill_figures.bat`（雙擊只跑 dry-run）。測試：`test/unit/figureBackfill.test.js`、`test/integration/figureBackfill.pg.test.js`（自製小 PDF：`test/fixtures/figureBackfillPdf.js`）。

## Cassette

改了 extract 的 prompt 與 schema → `promptTemplateHash`／`schemaHash` 都變，**extract 的舊 cassette 全部失效**（鍵算法見 `docs/llm.md` 第 3 節）。重錄：

```powershell
node scripts/record_cassettes.js --agent extract   # 需真金鑰；只錄公開樣卷
```

`figure_page`／`figure_box`／`figure_img` 都是選填且 `cacheKeyParts` 沒變，classify／verify／lint 的 cassette 不受影響。樣卷 `eval/fixtures/sample_exam.pdf` 是純文字排版、沒有附圖，錄出來的 cassette 自然不含框欄位——這正是「選填」要保證的相容性。
