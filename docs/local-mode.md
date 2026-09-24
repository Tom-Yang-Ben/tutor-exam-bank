# 本機模式（Local-first）契約與使用說明

> 版本 1.0（2026-09-25，主控凍結）。分支 `local/base`，基底是 `stage5/chapters`（522f81c）。
> 本檔是 L1～L4 四條平行工作的**凍結介面**。各 WS 發現契約有問題，寫在自己的回報裡，不要自行改契約；由主控裁決，登錄在第 9 條（LM-n）。

## 0. Owner 裁決（2026-09-25，對話中）

- 目標：系統的**每一個步驟、每一個功能都在 Owner 自己的電腦上跑**，執行時**不連外**，**不產生任何費用**。
- 硬體：Intel Core i5-8265U（4 核 8 緒、無獨立顯卡）、16 GB RAM，Windows。模型只能用 CPU 跑，一次只載入一個大模型。
- PDF 拆題：**PaddleOCR 與視覺模型交叉驗證**。
- 語音提問：本機模式**先關掉**。
- AI 家教：不加本機計算工具（Owner 沒選）；`codeExecution` 在本機模式下直接忽略。
- Gemini：**保留、可在 `.env` 切回**；**預設走本機**。

## 1. 原則

1. **執行期零外連**：`MODEL_*` 與 `EMBED_MODEL` 都是 `ollama:` 時，Node 伺服器、工作排程、前端網頁都不得連到本機以外的主機。開發期（`npm install`、`ollama pull`、安裝 PaddleOCR、`git push`）可以連網。
2. **Gemini 路徑逐位元不變**：`MODEL_*` 設成 `gemini:` 時，送出的 prompt、schema、cassette 鍵都與本分支之前相同。既有測試不得放寬。
3. **只有一個轉接點**：所有 LLM 與 embedding 呼叫照舊經過 `services/llm`（`generateJson`／`generateText`／`embed`）。新增 `ollama` 供應商，不在 agent 裡直接打 HTTP。
4. **record／replay 機制不變**：cassette 鍵公式、`LLM_MODE`、`EMBED_MODE` 的語意都不改。CI 永遠是 replay＋fixture、不連網。新增的本機 OCR 也要走同一套 record／replay，CI 不需要裝 Python。
5. **慢是預期的**：CPU 上的 8B 模型每秒只有幾個 token。所有逾時、租約、併發的預設值都要能撐過「一個節點跑二十分鐘」，而且不能因為慢被誤判成失敗。
6. **誠實的品質訊號**：交叉驗證不一致的題**不得自動入庫**，一律停在人工複核。

## 2. 設定（`.env`；預設值寫在程式裡，`.env.example` 由 L4 統一補齊）

| 變數 | 本機模式預設 | 說明 |
|---|---|---|
| `MODEL_EXTRACT` | `ollama:qwen3-vl:8b` | 視覺＋文字模型。拆題（看頁面圖片）、分類、lint 等沿用「extract 模型」的節點 |
| `MODEL_VERIFY` | `ollama:qwen3:8b` | 純文字模型。驗算、出變式（沿用 verify 的 fallback）、**OCR 結果結構化** |
| `MODEL_OCR_STRUCTURE` | 未設時＝`MODEL_VERIFY` | 把 PaddleOCR 的文字整理成拆題 JSON 的模型 |
| `MODEL_TUTOR`、`MODEL_VOICE`、`MODEL_VARIANT` 等 | 沿用現有 fallback 規則 | 規則本身不改，只是 fallback 的終點變成本機預設 |
| `EMBED_MODEL` | `ollama:qwen3-embedding:0.6b` | 有 `vendor:` 前綴才走該供應商；**沒有前綴的舊值（如 `gemini-embedding-001`）一律視為 Gemini**，舊 `.env` 不必改就維持原行為 |
| `EMBED_DIM` | `768` | 不變（`vector(768)`）。Qwen3-Embedding 支援自訂維度（MRL），送 `dimensions: 768`；回傳維度不符就截前 768 維再 L2 正規化 |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | 只允許 localhost／127.0.0.1／::1，其他主機名啟動時警告（原則 1） |
| `OLLAMA_CONCURRENCY` | `1` | throttle 的併發桶；CPU 只能一次跑一個 |
| `OLLAMA_RPM` | 不限 | 沿用 throttle 的 `<VENDOR>_RPM` 機制；未設＝不限 |
| `OLLAMA_TIMEOUT_MS` | `1800000`（30 分） | 單次呼叫逾時 |
| `OLLAMA_NUM_CTX` | `16384` | `options.num_ctx`；白名單＋例句＋題目要放得下 |
| `OLLAMA_KEEP_ALIVE` | `10m` | 模型在記憶體保留多久 |
| `OCR_ENGINE` | `paddle` | `paddle`＝本機 PaddleOCR；`none`＝不做 OCR（只跑視覺模型，交叉驗證停用，所有題都標 `vision_only`） |
| `OCR_PYTHON` | Windows：`exam_pro\ocr_service\.venv\Scripts\python.exe`；其他：`exam_pro/ocr_service/.venv/bin/python` | 跑 `ocr_pdf.py` 的 Python |
| `OCR_DPI` | `200` | PDF 頁面轉圖片的解析度 |
| `OCR_TIMEOUT_MS` | `1800000` | 單次 OCR 逾時 |
| `JOB_PDF_CHUNK_PAGES` | 拆題模型是 `ollama` 時預設 `2` | 一次送給視覺模型幾頁 |
| `JOB_NODE_TIMEOUT_MS` | 拆題模型是 `ollama` 時預設 `2700000`（45 分） | 明寫在 `.env` 的值一律優先 |
| `JOB_LEASE_MS` | 必須大於節點逾時，或在節點執行中續約 | 不得讓長節點的租約過期而被別的槽重跑（S5-40） |

## 3. L1：Ollama 轉接層（`services/llm`、`config`）

**檔案**：`services/llm/ollama.js`（新）、`services/llm/index.js`、`services/llm/throttle.js`、`services/llm/fixture.js`、`config/models.js`、`config/pricing.js`、`services/voiceService.js`、`services/tutorService.js`（只在必要時）、`routes/index.js`（語音掛載那一段）、`services/embedService.js`（只在必要時）、新的 `test/unit/llmOllama*.test.js`。

1. `config/models.js`：`VENDORS` 加 `ollama`；`parseModel('ollama:qwen3:8b')` → `{vendor:'ollama', id:'qwen3:8b'}`（只切第一個冒號）。`DEFAULT_EXTRACT`、`DEFAULT_VERIFY` 改成第 2 條的本機預設。`warnIfSameModel` 的邏輯不變。
2. `ollama.generateJson({ model:id, system, parts, schema, maxOutputTokens, thinkingBudget, signal })`：
   - `POST {OLLAMA_HOST}/api/chat`，`stream:false`，`format:<JSON schema>`，`options:{ temperature:0, num_ctx, num_predict:maxOutputTokens }`，`keep_alive`。
   - `messages`：`system`＋一則 `user`。`parts` 裡的 `{text}` 串成內容；`{inlineData:{mimeType:'image/*', data}}` 放進 `images`（base64）。遇到 `application/pdf` 或音訊一律丟 `errorClass:'unsupported_input'`（PDF 由 L2 的本機路徑處理）。
   - `think`：`thinkingBudget > 0` 時 `true`，否則 `false`。回應裡的 thinking 不進 `data`。
   - 回傳形狀與 `gemini.generateJson` 完全相同：`{ data, usage:{tokenIn:prompt_eval_count, tokenOut:eval_count, tokenThinking:0, tokenCached:0}, latencyMs, raw }`。JSON 解析失敗照 Gemini 路徑的同一種錯誤類別處理（呼叫端的重試與記帳規則不變）。
   - schema：Gemini 專用的欄位（例如 `nullable`、`propertyOrdering`）若 Ollama 不接受，在轉接層轉成標準 JSON Schema，**不改 `agents/schemas` 本身**。
   - 錯誤：連不上 → `errorClass:'provider_error'`，訊息寫「Ollama 沒有在執行，請先開啟 Ollama」；模型不存在 → `provider_error`，訊息附上 `ollama pull <id>`；逾時或被中止 → `timeout`、不重試。
3. `ollama.generateText(...)`：同上但不送 `format`。`tools.codeExecution` 直接忽略，`codeRuns:[]`；`done_reason:'length'` 對應成 `finishReason:'MAX_TOKENS'`。
4. `ollama.embed({ model:id, texts, dim })`：`POST /api/embed`，`{ model, input:texts, dimensions:dim, truncate:true }`；回傳維度 ≠ `dim` 時截前 `dim` 維。L2 正規化照舊在 `index.js` 做。
5. `services/llm/index.js`：`generateJson`、`generateText` 依 vendor 分派（`gemini` → gemini.js，`ollama` → ollama.js，其他照舊丟錯）。`embed` 依 `EMBED_MODEL` 分派（第 2 條的前綴規則）。record／replay 分支、cassette 鍵、meta 一律不變（`modelId` 就是 `qwen3:8b` 這種 id）。
6. `services/llm/fixture.js`：embedding fixture 檔名 `embeddings.<model>.<dim>.json` 的 `<model>` 要把 `:`、`/`、`\` 換成 `-`（Windows 檔名不能有冒號）。Gemini 的檔名結果不變。
7. `config/pricing.js`：`ollama` 的任何模型單價一律 0；未知的 ollama 模型不得丟錯或警告成「沒有價格」。
8. throttle：vendor `ollama` 的併發桶讀 `OLLAMA_CONCURRENCY`（預設 1）。
9. 語音：`MODEL_VOICE` 解析出來不是 `gemini` 時，即使 `FEATURE_VOICE=true` 也**不掛載**語音路由，啟動時印一行警告「本機模式不提供語音」；前端若有「語音是否可用」的判斷，要能看出這個狀態（沒有的話回 L3）。
10. 家教：`codeRuns` 為空時，不得在回答或 UI 上宣稱「已用程式驗算」。

## 4. L2：本機 OCR 與拆題交叉驗證（`ocr_service`、`services/ocr`、`agents/extract`）

**檔案**：`exam_pro/ocr_service/**`（新）、`services/ocr/**`（新）、`agents/extract.js`、`agents/extractCrossCheck.js`（新）、`workers/jobRunner.js`、`public/` 裡 review_reason 的中文標籤對照（只改那一處）、新的 `test/unit/ocr*.test.js`、`test/unit/extractLocal*.test.js`。

1. `exam_pro/ocr_service/`：
   - `requirements.txt`：PaddlePaddle（CPU 版）、PaddleOCR 3.x、PyMuPDF。固定版本號。
   - `ocr_pdf.py`（CLI）：`--pdf <path> --from N --to M --dpi 200 --out <dir>`。用 PyMuPDF 把頁面轉 PNG 存到 `<dir>`；用 PaddleOCR（版面分析＋文字＋**公式轉 LaTeX**，支援**繁體中文**）逐頁辨識。stdout 只印一個 JSON：`{ engine:'paddleocr', engine_version, dpi, pages:[{ page, image:<絕對路徑>, markdown }] }`，markdown 內公式用 `$…$`。錯誤印到 stderr、非 0 結束。
   - `--selftest`：不需要任何輸入檔，確認套件與模型都已就緒（模型不在就明確失敗），印 `{ok:true, engine_version}`。
   - 執行期**不得下載任何東西**：模型在安裝時下載（L4 的安裝腳本會呼叫 `ocr_pdf.py --warmup`），`--warmup` 由 L2 實作。
   - 全部只用 CPU。
2. `services/ocr/index.js`：`ocrPdf({ pdfBytes, pdfSha256, fromPage, toPage, signal })` → `{ engine, engineVersion, pages:[{ page, markdown, imagePath|null }] }`。
   - 模式跟 `LLM_MODE`：`live` 呼叫 `ocr_pdf.py`；`record` 呼叫後寫 cassette（agent `ocr`，鍵＝`cassetteKey({agent:'ocr', modelId:'paddleocr@<engine_version>', template:'ocr.v1', cacheKeyParts:{ pdfSha256, fromPage, toPage, dpi }})`，**只存 markdown，不存圖片**）；`replay` 讀 cassette、miss 的訊息格式與 LLM 相同，`imagePath` 一律 `null`。
   - 暫存圖片放系統暫存目錄，用完刪除。
3. `agents/extract.js`：`MODEL_EXTRACT` 的 vendor 是 `ollama` 時走**本機路徑**，否則原路徑逐位元不變：
   1. `ocr = ocrPdf(本塊)`（`OCR_ENGINE=none` 時略過）。
   2. **視覺版**：`llm.generateJson({ model:MODEL_EXTRACT, parts:[本機模板文字, ...本塊每頁 PNG（inlineData image/png）], schema:同一份, agent:'extract_vision'（化學 'extract_vision_chem'）, template:'extract_vision.v1'（化學 '…_chem.v1'）, cacheKeyParts:{ template, chunkNo, pdfSha256 } })`。replay 時沒有圖片也要能跑（parts 只剩文字，鍵不含圖片）。
   3. **OCR 版**：`llm.generateJson({ model:MODEL_OCR_STRUCTURE, parts:[本機模板文字＋OCR markdown], schema:同一份, agent:'extract_ocr'（化學 '…_chem'）, template:'extract_ocr.v1', cacheKeyParts:{ template, chunkNo, pdfSha256, ocrSha256 } })`。
   4. `extractCrossCheck.crossCheck(visionQs, ocrQs)`（純函式）：依順序＋題幹相似度對齊（`utils/normalizeStem` 正規化後的字元 bigram Jaccard）。每題得到 `cross_check:{ status:'agree'|'disagree'|'vision_only'|'ocr_only', similarity, alt_question_text }`。合併規則：兩版都在時，採**公式能通過 `parseLatexStrict` 的那一版**；兩版都通過則採視覺版；另一版的題幹放 `alt_question_text`。門檻（預設 0.85）寫成常數並在檔頭說明。
   5. 回傳的 outcome 形狀與原路徑相同（`questions`、`rejected`、`chunk_no`、`page_range`、`pdf_sha256`），每題多一個 `cross_check` 欄位；元素驗證規則不變。
4. `workers/jobRunner.js`：
   - 新 review_reason：`extract_disagree`（加進白名單常數與前端中文標籤：「拆題交叉驗證不一致」）。`cross_check.status ≠ 'agree'` 的題照常走完後續節點，但**最後一律停在 `needs_review('extract_disagree')`**（除非更嚴重的原因先發生），絕不自動入庫；`alt_question_text` 保留在 payload 給複核頁顯示。
   - 第 2 條的長節點預設（逾時、租約、`JOB_PDF_CHUNK_PAGES`）在這裡落地；租約若本來就會在節點執行中續約，寫測試證明；不會的話補上續約。
5. `eval/lib/pipelineDriver.js` 呼叫的是同一個 extract agent，不需另外改；若需要，只能做最小改動並在回報說明。

## 5. L3：前端離線化（`public`、`app.js`）

**檔案**：`public/**`、`app.js`（或掛靜態檔的那一支）、`scripts/check_html*.js`、`package.json` 的 dependencies（只加 `mathjax`、`gsap`、字型套件）。

1. MathJax（含 mhchem）、gsap 改從本機載入：以 `npm` 套件提供，express 掛在 `/vendor/...`。版本與目前 CDN 上用的主版本相同，設定（ui/safe、URL 'none'）逐字保留。
2. Google Fonts 拿掉：改用本機字型套件，或系統字型堆疊（`"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif`）。挑一個並在回報說明理由（套件大小 vs 外觀）。
3. `public/` 底下的 HTML／JS／CSS **不得再出現任何 `http://`、`https://` 資源網址**（說明文字裡的連結除外），並加一則單元測試或 `check:html` 規則鎖住。
4. 語音按鈕：伺服器沒有掛語音路由時（第 3 條第 9 點），前端不顯示語音按鈕或顯示「本機模式不提供語音」。

## 6. L4：eval、CI、腳本、文件

**檔案**：`.github/workflows/ci.yml`、`exam_pro/eval/**`（`lib/pipelineDriver.js` 除外，見第 4 條第 5 點）、`exam_pro/scripts/record_*.js`、`exam_pro/scripts/windows/*.bat`（新）、`exam_pro/.env.example`、`exam_pro/package.json` 的 scripts、`docs/**`（本檔第 0～9 條除外）、`engineering_docs/**`、`README.md`、`exam_pro/README.md`。

1. `ci.yml`：`MODEL_EXTRACT`、`MODEL_VERIFY`、`EMBED_MODEL` 改成第 2 條的本機預設；CI 仍是 replay＋fixture，不裝 Ollama、不裝 Python。
2. `eval/tools/rerecord_all.js`：
   - 模型都是 `ollama:` 時不要求 `GEMINI_API_KEY`。
   - 錄前檢查：Ollama 連得上（`GET /api/tags`）、需要的模型都已下載（列出缺的並提示 `ollama pull`）、`OCR_ENGINE=paddle` 時 `ocr_pdf.py --selftest` 通過、測試庫已套 migration（既有檢查）。
   - 盤點：ollama 的費用一律 $0，改印**預估時間**（依呼叫數與本機實測速度粗估，寫明是粗估）。
   - 錄製順序與既有步驟相同；新增的 cassette 目錄（`ocr`、`extract_vision`、`extract_ocr`）納入盤點與 `cassettes:prune`。
3. embedding fixture：`record_embeddings.js` 等支援 `ollama:` 模型與第 3 條第 6 點的檔名；`thresholds.json` 的 `_measured_with` 之類的欄位只在錄完後由主控更新。**門檻數字不動**；本機重錄後低於門檻，由 Owner 另行裁決（多半是依本機模型重建基準）。
4. Windows 一鍵腳本（`exam_pro\scripts\windows\`，雙擊即可，輸出寫 log）：
   - `setup_local_ai.bat`：檢查 Ollama 已安裝並在執行 → `ollama pull` 三個模型 → 建 `ocr_service\.venv` 並 `pip install -r requirements.txt` → `ocr_pdf.py --warmup` → `--selftest`。
   - `record_local.bat`：`npm run db:up` → `npm run migrate:test` → `npm run cassettes:rerecord`（自動輸入 yes）。
   - `switch_to_gemini.bat`／`switch_to_local.bat` **不做**（改 `.env` 由 Owner 自己來；文件寫清楚要改哪幾行）。
5. 文件：
   - 本檔第 10 條以後補「使用說明」：安裝步驟、`.env` 範例、切回 Gemini 的方法、預期速度與品質、疑難排解。
   - `engineering_docs` 新增 ADR-017（本機優先推論）。
   - `docs/HANDOFF.md`、`deployment_and_operations.md` 的上線步驟：換 embedding 模型後要在本機 `embed:backfill` 全部題目、再 `search:reindex`（免費但慢）。
   - `.env.example` 補齊第 2 條全部變數。

## 7. 檔案所有權

第 3～6 條每條開頭列的檔案只歸該 WS。**任何 WS 都不得修改本檔第 0～9 條**。`.env.example`、`package.json` 的 scripts 只歸 L4；L1～L3 需要新 script 或新變數時寫在回報，由 L4 或主控加。L3 需要的 dependencies 由 L3 自己加（`package.json` 的 `dependencies` 區塊）。

## 8. 驗收

- `npm test` 全綠（既有測試不得放寬；新增的測試要覆蓋第 3～5 條的每一點）。
- `npm run check:html` 綠。
- 整合測試綠（主控以 `ci.sh` 跑）。
- 以 `MODEL_EXTRACT=gemini:gemini-3.5-flash`、`MODEL_VERIFY=gemini:gemini-3.1-pro-preview` 跑既有的 Gemini 相關測試，送出的 prompt、schema、cassette 鍵與本分支之前相同。
- e2e 與 eval 在本機重錄之前只會因為缺 cassette／缺向量而失敗。

## 9. 裁決紀錄

（LM-n 記於此。）
