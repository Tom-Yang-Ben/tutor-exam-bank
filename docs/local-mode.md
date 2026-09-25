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
| `MODEL_EXTRACT` | `ollama:qwen3-vl:8b` | 視覺＋文字模型。拆題（看頁面圖片）；語音沿用它（本機模式不提供語音） |
| `MODEL_VERIFY` | `ollama:qwen3:8b` | 純文字模型。驗算、出變式（沿用 verify 的 fallback）、**OCR 結果結構化** |
| `MODEL_TEXT` | 拆題模型是 `ollama` 時＝`MODEL_VERIFY`；否則＝`MODEL_EXTRACT` | 〔LM-15〕純文字工作：章節分類、公式重寫（lint）、知識點標註（`MODEL_KC_TAG` 未設時）、主控助教（`MODEL_ASSISTANT` 未設時）。Gemini 模式下與加這個設定之前完全相同 |
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

主控於整合（2026-09-25，分支 `local/integration`）時裁決。

| # | 事項 | 裁決 |
|---|---|---|
| LM-1 | L1：Node 內建 `fetch`（undici）在 300 秒沒有回應標頭時就放棄；Ollama `stream:false` 在算完之前什麼都不送，CPU 上超過 5 分鐘的呼叫一定失敗 | 改用 `node:http`（不新增依賴），逾時由 `OLLAMA_TIMEOUT_MS` 控制。第 3 條寫的「fetch」以本條為準 |
| LM-2 | L3：頁面還從 CDN 載入 `@tailwindcss/browser@4`，契約沒列 | 一併改成本機套件（`/vendor/tailwindcss`），否則離線時整頁沒有樣式 |
| LM-3 | L2：`extract_disagree` 被資料庫的 review_reason CHECK 擋下 | 核准 `migrations/0015_extract_disagree.sql`；`reviewController` 的 `REVIEW_REASONS` 加入此值（`variantPipeline.test.js` 的數量斷言 9 → 10）；複核頁加中文標籤、顏色與「另一版題幹」一行 |
| LM-4 | 圖片 part 的形狀：契約寫 `inlineData`，既有慣例（`gemini.js`、`cassette.summarizeParts`）是 `{imageBase64, mimeType}` | 採既有慣例；`agents/extract.js` 本機路徑改送 `{imageBase64, mimeType:'image/png'}`，cassette 的 request 摘要才記得到圖片。Ollama 轉接層兩種都收。鍵不含 parts，不受影響 |
| LM-5 | 本機模式的工作併發 | 拆題模型是 `ollama` 且沒明寫時 `JOB_CONCURRENCY=1`（runner 預設），`.env.example` 也寫 1 |
| LM-6 | L2 補的契約空白：化學 OCR 模板 `extract_ocr_chem.v1`；每題 `cross_check.picked`、outcome 的 `cross_check_summary`；採 OCR 版時圖表欄位仍取視覺版；`OCR_ENGINE` 非法值退回 `paddle` | 全部核准 |
| LM-7 | `services/nlqService.js` 沒設 `MODEL_NLQ` 時寫死 Gemini（會連外） | 預設改成 `ollama:qwen3:8b`；`eval/lib/localMode.js` 的 `NLQ_CODE_DEFAULT` 同步。執行期 `NLQ_TIMEOUT_MS` 仍是 4000（實際上只用規則解析，查詢不會卡一兩分鐘）；錄製時由 rerecord 帶長逾時 |
| LM-8 | 預設改本機後，專測 Gemini 路徑的整合測試（`chemistry.pg`、`jobs.pg`、`tutor.pg`）與 `agentExtract` 的一則單元測試走到本機路徑 | 這些測試在自己的行程內明寫 Gemini 模型（每個測試檔是獨立行程，不外溢）；斷言一條都不改。本機路徑由 `localExtract.pg.test.js`、`llmOllama*.test.js`、`extractLocal*.test.js` 覆蓋 |
| LM-9 | 契約外仍寫死 Gemini 的地方 | 全部改讀 `config/models.js`：`scripts/backfill_embeddings.js`（EMBED_MODEL）、`eval/lib/pipelineDriver.js`（extract、ocrStructure、一塊頁數與 runner 同規則）、`workers/jobRunner.js`（估價用 `parseModel().id`，`ollama:qwen3:8b` 不再被截成 `8b`；模組缺失時的退路字面值）。刻意不改：`services/legacy/analyzePdf.js`（凍結快照）、`scripts/spike_genai.js`、舊版 `exam/` |
| LM-10 | L1 的實作判斷：schema 欄位說明附加到 system（Ollama 看不到 schema 的 description）；模型不支援 thinking 時去掉 `think` 重試一次；`OLLAMA_HOST=0.0.0.0`／`::` 視為本機；embedding 與 LLM 共用 Ollama 併發桶；估價以 `ollama:` 前綴或 `name:tag` 判定為本機 | 全部核准。已知風險：Ollama 沒有 thinking 預算，`num_predict` 含思考 token，結構化輸出可能被截斷——出現 `MAX_TOKENS` 時先調大 `maxOutputTokens` |
| LM-11 | 家教：本機模板 `tutor.*.local.v1` 只改「驗算」那幾句；回覆仍宣稱跑過程式時附更正提醒 | 核准；Gemini 路徑不動 |
| LM-12 | 已知限制（不在這一輪處理） | ①一塊 2 頁會切到跨頁的題，兩個引擎看到同一個被切斷的題可能「一致」而自動入庫——之後可加一頁前瞻；②45 分鐘節點逾時在 i5-8265U 上可能不夠（`JOB_NODE_TIMEOUT_MS` 可調大）；③相似度門檻 0.85 會讓複核比例偏高，本機重錄後再校準；④PaddleOCR 在含中文的 Windows 路徑可能載不到模型，`OCR_MODEL_HOME` 設成純英文路徑；⑤舊的同步 `/analyze-pdf` 在本機模式不實用；⑥PaddleOCR 還沒在實機跑過（雲端 container 下載不到模型），第一次在 Owner 電腦上執行 `setup_local_ai.bat` 才算驗證 |
| LM-13 | Windows 腳本的行尾；L3 的離線檢查沒進 `check:html` | `.gitattributes` 加 `exam_pro/scripts/windows/*.bat -text`（CRLF 原樣進出，不受 autocrlf 影響）；`check:html` 串上 `scripts/check_html_offline.js`（`evalStage3.test.js` 的 scripts 斷言同步） |
| LM-14 | 門檻與 cassette 清理 | `eval/thresholds.json` 的數字不動；本機重錄後若低於門檻，由 Owner 另行裁決（多半依本機模型重建基準）。本機重錄後 `cassettes:prune` 會把 Gemini 的 cassette 列為過期：確定不切回 Gemini 之前不要 `--apply` |
| LM-15 | 16 GB 的電腦同時只放得下一個 8B 模型；分類、lint、知識點標註、主控助教原本沿用「extract 模型」（視覺的 qwen3-vl），一份考卷的流程會在 qwen3-vl 與 qwen3:8b 之間來回換載（每次 1～2 分鐘） | Owner 2026-09-25 選方案 A：新增 `MODEL_TEXT`（`config/models.js` 的 getter），拆題模型是 `ollama` 時預設＝`MODEL_VERIFY`，否則＝`MODEL_EXTRACT`。`agents/classify.js`、`agents/lint.js` 讀 `ctx.config.models.text`（沒給退回 `extract`）；`tagKc` 的退回順序 `kcTag → text → extract`；`MODEL_KC_TAG`、`MODEL_ASSISTANT` 未設時沿用 `MODEL_TEXT`。runner、eval 的 ctx 都帶 `text`。Gemini 模式下 `MODEL_TEXT`＝`MODEL_EXTRACT`，cassette 的鍵與費用一字不差；本機的分類／lint cassette 反正要重錄（LM-14），這時改不浪費任何錄製。`MODEL_VOICE` 維持沿用 `MODEL_EXTRACT`（語音要聽音訊，且只在 Gemini 可用）。代價：分類與驗算同一個模型——分類不是驗算的獨立檢查，不影響「拆題 ≠ 驗算」的異級驗證 |
| LM-16 | 第一次在 Owner 的 Windows 實機跑 `setup_local_ai.bat`（Python 3.12.10）：模型都下載完了，第 6 步 `--warmup` 辨識自檢頁時丟 `NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support [pir::ArrayAttribute<pir::DoubleAttribute>]`（onednn_instruction.cc），結束碼 5 | PaddlePaddle 3.3.0／3.3.1 在 CPU＋oneDNN 路徑的框架錯誤（Paddle issue #77340、PaddleOCR issue #18162；修正已併入開發分支、尚未發布）。`requirements.txt` 改固定 `paddlepaddle==3.2.2`（上游建議的版本，保留 oneDNN 的速度）；`paddleocr`／`paddlex` 版本不變，所以 OCR cassette 的鍵（`paddleocr@3.7.0`）不變。`ocr_pdf.py` 碰到這個錯誤時在訊息裡附上處理方式。不採「關掉 oneDNN」：CPU 上會慢很多。PyPI 出了含修正的版本再評估升級 |

---

## 10. 使用說明（L4，給 Owner）

> 本條以後是使用說明，不是契約；第 0～9 條的凍結介面以上面為準。速度的數字是依硬體規格推的**粗估，尚未在 Owner 的電腦上實測**，實測後請更新本條。

### 10.1 本機模式是什麼、代價是什麼

所有 AI 步驟都在這台電腦上跑：拆題（PaddleOCR 與視覺模型交叉驗證）、分類、公式 lint、驗算、出變式、找相似題的向量，全部由 Ollama 上的 Qwen3 系列模型與本機 PaddleOCR 完成。執行期**不連外、不產生任何費用**，題目與學生資料也不會離開這台電腦。

代價有三個，先講清楚：

1. **很慢**：i5-8265U 沒有獨立顯卡，模型只能用 CPU 跑，每秒只生成幾個字。一份考卷從上傳到拆完可能要好幾個小時（見 10.5）。
2. **品質低於 Gemini**：8B 的本機模型在公式轉 LaTeX、章節分類、獨立驗算上都比 Gemini Flash／Pro 弱。系統用「PaddleOCR 與視覺模型各拆一次、互相比對」補回一部分可靠度，但兩版不一致的題**一律停在人工複核**（`extract_disagree`），不會自動入庫。預期複核佇列會比以前長。
3. **少兩個功能**：語音提問關閉（`FEATURE_VOICE=true` 也不會掛載）；AI 家教沒有「用程式驗算」，回答不會宣稱已驗算。

其他功能（題庫管理、組卷、Word 匯出、學生與批改、知識點、補救卷）都與模型無關，行為不變。

| 功能 | 本機模式下 |
|---|---|
| PDF 拆題 | PaddleOCR（文字＋公式）與 `qwen3-vl:8b`（看頁面圖片）各拆一次、交叉比對；一次 2 頁 |
| 分類、lint、知識點標註、主控助教 | `qwen3:8b`（`MODEL_TEXT`，未設時＝`MODEL_VERIFY`；LM-15） |
| 驗算、出變式、OCR 結果整理 | `qwen3:8b`（`MODEL_VERIFY`） |
| 找相似、hybrid 檢索的向量 | `qwen3-embedding:0.6b`（768 維，與資料庫的 `vector(768)` 相同） |
| 自然語言查題 | 實際上只用規則：本機模型在 4 秒的逾時內回不來（要用 LLM 輔路徑見 10.3 的 `NLQ_TIMEOUT_MS`） |
| 語音提問 | 關閉 |
| AI 家教 | 可用，但沒有程式驗算、每次回答要幾分鐘 |

### 10.2 安裝（第一次；大部分時間在下載）

需要：Node.js 24 與 Docker Desktop（原本就有）、約 **15 GB** 可用磁碟空間、安裝時可連網。

1. **安裝 Ollama**：到 <https://ollama.com/download> 下載 Windows 版安裝（免費）。裝好後會在背景執行，工作列右下角出現羊駝圖示。
2. **安裝 Python 3.11 或 3.12（64 位元）**：<https://www.python.org/downloads/windows/>，安裝時勾選「Add python.exe to PATH」。（Windows 內建的 `python` 只是 Microsoft Store 的捷徑，不算安裝。）
3. **雙擊 `exam_pro\scripts\windows\setup_local_ai.bat`**。它會依序：
   1. 檢查 Ollama 已安裝而且在執行；
   2. `ollama pull` 三個模型：`qwen3-vl:8b`、`qwen3:8b`、`qwen3-embedding:0.6b`（合計約 12 GB）；
   3. 檢查 Python（先找 `py -3` 再找 `python`；要 3.9 以上、64 位元）；
   4. 建立 `exam_pro\ocr_service\.venv`；
   5. `pip install -r exam_pro\ocr_service\requirements.txt`（PaddlePaddle CPU 版、PaddleOCR、PyMuPDF）；
   6. `ocr_pdf.py --warmup`（下載 PaddleOCR 的模型）；
   7. `ocr_pdf.py --selftest`（確認都已就緒）。

   任何一步失敗都會寫明原因並停下；重跑是安全的，已完成的步驟會很快跳過。完整輸出在 `exam_pro\data\local_ai\setup_<時間>.log`（`data\` 不進版控）。之後隨時可以用 `npm run ocr:selftest` 單獨檢查 OCR。
4. **（建議）讓 Ollama 一次只放一個大模型**：「開始」搜尋「編輯您帳戶的環境變數」→ 新增 `OLLAMA_MAX_LOADED_MODELS`，值 `1` → 從工作列圖示結束 Ollama 再重新開啟。16 GB 記憶體同時放兩個 8B 模型會很吃緊。
5. **改 `.env`**（10.3），然後重啟伺服器（`npm start`）。
6. **既有題庫換向量**（10.6，一次性，免費但慢）。
7. （選做）**以本機模型重錄 CI 的回放檔**（10.7）。

### 10.3 `.env` 範例

`exam_pro\.env.example` 已經是本機模式的預設，新裝的直接複製即可。**已經在用的 `.env` 通常明寫了 Gemini 的值，要自己改**——至少這幾行：

```dotenv
# 真的呼叫模型（範本預設 replay／fixture 只回放，什麼模型都不呼叫）
LLM_MODE=live
EMBED_MODE=live

# 模型（docs/local-mode.md 第 2 條）
MODEL_EXTRACT=ollama:qwen3-vl:8b
MODEL_VERIFY=ollama:qwen3:8b
MODEL_NLQ=ollama:qwen3:8b            # 不可留空：留空時程式預設是 Gemini，會連外
EMBED_MODEL=ollama:qwen3-embedding:0.6b
EMBED_DIM=768
GEMINI_API_KEY=                      # 本機模式不需要

# Ollama 與本機 OCR（以下都是預設值，可以不寫）
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_CONCURRENCY=1
OLLAMA_TIMEOUT_MS=1800000
OLLAMA_NUM_CTX=16384
OLLAMA_KEEP_ALIVE=10m
OCR_ENGINE=paddle
OCR_DPI=200
OCR_TIMEOUT_MS=1800000

# 一次處理一份 PDF（CPU 一次只跑得動一個模型）
JOB_CONCURRENCY=1

# 語音在本機模式下不提供
FEATURE_VOICE=false
```

另外**刪掉（或在前面加 `#`）這兩行**——舊範本把它們寫死成 Gemini 用的值，明寫的值會蓋掉本機預設，結果是一次送 20 頁給視覺模型、每個節點 2 分鐘就逾時，本機拆題一定失敗：

```dotenv
#JOB_PDF_CHUNK_PAGES=20      ← 不寫時：本機 2 頁、Gemini 20 頁
#JOB_NODE_TIMEOUT_MS=120000  ← 不寫時：本機 45 分、Gemini 2 分
```

想讓自然語言查題真的用上 LLM 輔路徑，把 `NLQ_TIMEOUT_MS` 改成 `120000`（每次查詢要等一兩分鐘；預設 4000 等於只用規則）。

### 10.4 切回 Gemini

改這幾行就好，其他設定不用動：

```dotenv
GEMINI_API_KEY=你的金鑰
MODEL_EXTRACT=gemini:gemini-3.5-flash
MODEL_VERIFY=gemini:gemini-3.1-pro-preview
MODEL_NLQ=gemini:gemini-3.5-flash
EMBED_MODEL=gemini-embedding-001
JOB_CONCURRENCY=2                    # 選填
```

- `JOB_PDF_CHUNK_PAGES`、`JOB_NODE_TIMEOUT_MS` 保持不寫，拆題模型是 Gemini 時自動回到 20 頁、2 分鐘。`OLLAMA_*`、`OCR_*` 在 Gemini 模式下不會被讀到，留著無妨。
- **換 embedding 模型（不論哪個方向）都要重算全部題目的向量**：照 10.6 的步驟再跑一次。只換 `MODEL_*`、不換 `EMBED_MODEL` 則不必。
- 也可以只把某一個節點切回 Gemini（例如只改 `MODEL_VERIFY`），那一個節點就會連外、花錢，其餘仍在本機。
- `MODEL_TEXT`（分類、公式重寫等純文字工作）不寫時自動跟著走：拆題模型改回 Gemini 就等於 `MODEL_EXTRACT`。若 `.env` 裡明寫了 `MODEL_TEXT=ollama:…`，要一併刪掉或改掉，否則這幾個節點仍在本機。
- 語音提問只在 `MODEL_VOICE`（未設時沿用 `MODEL_EXTRACT`）是 `gemini:` 時可用。
- **CI 讀哪一組回放檔不看 `.env`**，看 `.github/workflows/ci.yml` 的 `MODEL_EXTRACT`／`MODEL_VERIFY`／`EMBED_MODEL`／`MODEL_NLQ`。要讓 CI 也回到 Gemini，改那四行並用 Gemini 重錄（會花錢）；舊的 Gemini 回放檔若還沒被 `cassettes:prune` 刪掉，可以直接沿用（見 10.7）。

### 10.5 預期速度與品質

**速度（粗估，未實測；依 i5-8265U、8B Q4 模型「每秒約 3 個字生成、15 個字讀 prompt」推算）**：

| 動作 | 粗估 |
|---|---|
| PaddleOCR 辨識一塊（2 頁，含公式） | 2～5 分鐘 |
| 視覺模型拆一塊（2 頁） | 15～30 分鐘 |
| OCR 結果整理成題目 | 10～20 分鐘 |
| 每一題的分類／lint／驗算 | 各幾分鐘；驗算開思考，最久。三者都用 `qwen3:8b`（LM-15），拆完題之後不必再換載模型 |
| **一份 4 頁、20 題的考卷，上傳到全部處理完** | **數小時**；建議晚上上傳、隔天看複核佇列 |
| 一段文字的向量 | 約 1 秒；既有題庫 1,000 題換向量約 20～40 分鐘 |
| 整套重錄 CI 回放檔（10.7） | 可能要一整天（20～30 小時），可以分次錄 |

重錄（10.7）之後可以用 `npm run perf:local` 量這台電腦的實際速度（10.10），再回來把上表的粗估換成實測值。

模型第一次載入（或 `OLLAMA_KEEP_ALIVE` 過期後再載入）要多等 1～2 分鐘。處理期間電腦會變慢，但可以照常使用；請接上電源、把睡眠設成「永不」。

**品質**：

- 公式、題幹的抄錯率會比 Gemini 高；交叉驗證只保證「兩版不一致的題會被攔下來」，不保證「兩版一致的題一定對」——複核時仍要抽看。
- 交叉驗證不一致（`extract_disagree`）的題**一律停在人工複核**；另一版的題幹保留在該題的處理紀錄（payload 的 `alt_question_text`），複核時對照原卷改對再核准。
- 章節分類、獨立驗算的準確率預期低於 Gemini；五個 eval 的門檻（`eval/thresholds.json`）是用 Gemini 量的，本機重錄後很可能有幾項未達。**門檻數字不會自動放寬**，由 Owner 另行裁決（多半是依本機模型重建基準；第 6 條第 3 點）。
- 知識點自動標註、AI 家教的品質同樣會下降；家教沒有程式驗算。

### 10.6 上線步驟：既有題庫換成本機的向量

換 `EMBED_MODEL` 之後，資料庫裡既有題目的向量還是舊模型算的，找相似題與 hybrid 檢索會對不上（新舊模型的向量不能互相比）。在正式庫做一次（免費，但 CPU 上要一段時間）：

1. `npm run db:backup`（先備份）。
2. `.env` 設好 10.3 的值（`EMBED_MODE=live`、`EMBED_MODEL=ollama:qwen3-embedding:0.6b`），確認 Ollama 在執行。
3. `npm run embed:backfill -- --dry-run` 看要算幾題 → `npm run embed:backfill`（全量對帳：`embedding_model` 與現在的模型不同的題都會重算；可中斷重跑）。
4. `npm run search:reindex -- --dry-run` → `npm run search:reindex`。
5. 重啟伺服器。

在第 3 步跑完之前，不要用找相似題與變式題的檢索（結果沒有意義）。切回 Gemini 的 embedding 時同樣要再做一次。

### 10.7 以本機模型重錄 CI 的回放檔（`record_local.bat`）

CI 不裝 Ollama、不裝 Python，只讀 repo 裡錄好的回放檔（cassette）與向量檔。回放檔的鍵含模型名稱，`ci.yml` 改成本機模型之後，舊的 Gemini 回放檔一支都讀不到——**在 Owner 重錄之前，CI 的 e2e 與五個 eval 會因為缺回放檔、缺向量而紅燈**（第 8 條的預期）。

1. 確認 10.2 的安裝已完成、Docker Desktop 在執行、`exam_pro\.env` 有 `TEST_DATABASE_URL`。
2. **雙擊 `exam_pro\scripts\windows\record_local.bat`**：`npm run db:up` → `npm run migrate:test` → `npm run cassettes:rerecord`（自動輸入 yes）。輸出同時寫進 `exam_pro\data\local_ai\record_<時間>.log`。
3. 開始錄之前，工具會：
   - 以回放模式盤點每個 suite 缺多少回放檔，印出**預估時間**（本機模型費用一律 $0）；時間是「呼叫次數 × 每次秒數」的保守粗估，錄完後看 log 裡每一步實際花的秒數，可以在 `.env` 設 `RERECORD_TIME_SCALE`（整體倍率，例 `0.5`）或 `RERECORD_SEC_PER_CALL_<AGENT>`（例 `RERECORD_SEC_PER_CALL_VERIFY=400`）讓下次的估計準一點（該設多少，`npm run perf:local` 會算給你，見 10.10）；
   - 做錄前檢查，任一項沒過就停、一次都不錄：Ollama 連得上而且三個模型都在（缺的會列出 `ollama pull` 指令）、PaddleOCR 自我檢查通過、測試庫已套 migration；
   - 模型一律照 `ci.yml`，`.env` 的 `MODEL_*` 不會帶進去（照 `.env` 錄的鍵 CI 讀不到）。
4. 太久的話可以分次錄：在 `exam_pro\scripts\windows\` 開命令列執行 `record_local.bat classify,nlq`（逗號分隔、不加空白；等於 `--suites classify,nlq`）；或 `npm run cassettes:rerecord -- --dry-run` 先看盤點。
5. 錄完：`git add eval/cassettes eval/fixtures/embeddings.*.json`，commit、push。本機的向量檔叫 `eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json`（模型名裡的 `:` 換成 `-`，Windows 檔名不能有冒號）。
6. `npm run cassettes:prune` 會把原本 Gemini 錄的回放檔列為「CI 不再讀到」。**還想保留讓 CI 切回 Gemini 的可能，就先不要 `--apply`**（刪掉之後要切回就得再用 Gemini 重錄、花錢）；確定不回頭再刪。
7. 回放驗證有門檻未達時，照 10.5 最後一點：不放寬，交給 Owner 裁決。

### 10.8 疑難排解

| 看到什麼 | 原因 | 怎麼辦 |
|---|---|---|
| 「Ollama 沒有在執行，請先開啟 Ollama」、`ECONNREFUSED 127.0.0.1:11434` | Ollama 沒開，或 `OLLAMA_HOST` 指錯 | 從「開始」選單開啟 Ollama，等工作列出現羊駝圖示；`.env` 的 `OLLAMA_HOST` 應是 `http://127.0.0.1:11434` |
| 訊息附上 `ollama pull <模型>`、「模型不存在」 | 模型沒下載，或 `.env` 的模型名打錯 | 照訊息執行 `ollama pull …`，或重跑 `setup_local_ai.bat`；`ollama list` 看已下載的模型 |
| 電腦卡住、Ollama 回「model requires more system memory」、硬碟燈狂閃 | 記憶體不足（同時載入兩個 8B 模型，或瀏覽器分頁太多） | 設 `OLLAMA_MAX_LOADED_MODELS=1`（10.2 第 4 步）；`.env` 設 `OLLAMA_KEEP_ALIVE=2m`、`OLLAMA_NUM_CTX=8192`、`JOB_CONCURRENCY=1`；處理期間關掉不用的程式。仍不夠時才考慮換小一號的模型（例如 4B；換模型＝CI 回放檔要重錄） |
| 拆題的節點 `error:timeout` | `.env` 還留著舊的 `JOB_NODE_TIMEOUT_MS=120000`，或考卷太長 | 刪掉那一行（本機預設 45 分）；仍逾時可調高 `JOB_NODE_TIMEOUT_MS` 與 `OLLAMA_TIMEOUT_MS` |
| `setup_local_ai.bat` 停在第 5 步（pip install） | Python 版本太新而 PaddlePaddle 還沒有對應套件、網路中斷、防毒軟體攔截 | 改裝 Python 3.11 或 3.12（64 位元），刪掉 `exam_pro\ocr_service\.venv` 後重跑；錯誤細節在 log 的最後幾十行 |
| 第 6 或第 7 步出現 `ConvertPirAttribute2RuntimeAttribute not support` | 裝到了 PaddlePaddle 3.3.x（已知的框架錯誤，LM-16） | 確認 `exam_pro\ocr_service\requirements.txt` 寫的是 `paddlepaddle==3.2.2`，重跑 `setup_local_ai.bat`（第 5 步會自動換版本） |
| 停在第 6 或第 7 步（`--warmup`／`--selftest`） | OCR 模型沒下載完整 | 重跑 `setup_local_ai.bat`；`npm run ocr:selftest` 單獨檢查。暫時修不好可以在 `.env` 設 `OCR_ENGINE=none`：只用視覺模型拆題、交叉驗證停用，所有題都停在人工複核 |
| 「找不到 OCR 用的 Python」 | `.venv` 還沒建，或 `.env` 的 `OCR_PYTHON` 指錯 | 重跑 `setup_local_ai.bat`；`OCR_PYTHON` 不設就用 `.venv` 那一支 |
| 很多題停在複核、原因是「拆題交叉驗證不一致」 | 預期中的行為（第 1 條第 6 點） | 在複核頁對照原卷改對後核准 |
| 語音按鈕不見了 | 本機模式不提供語音 | 預期中的行為；要用語音只能切回 Gemini（10.4） |
| GitHub Actions 的 e2e／eval 紅燈，訊息是 replay miss 或缺向量 | `ci.yml` 已改本機模型，回放檔還沒以本機模型重錄 | 照 10.7 重錄 |
| `.bat` 視窗裡中文變亂碼 | 主控台字型不支援 | 不影響執行；log 檔是 UTF-8，用記事本開 |
| 頁面沒有樣式、公式不排版、字型怪怪的，瀏覽器主控台有 500／CORS 錯誤 | 用 `http://127.0.0.1:3000` 開頁面；字型、MathJax、Tailwind 改由本機伺服器提供後要過 `ALLOWED_ORIGINS` | 一律用 `.env` 的 `ALLOWED_ORIGINS` 裡的網址開（預設 `http://localhost:3000`） |
| 拆題被切在兩頁中間的題，兩個引擎都拆成殘缺的一題卻自動入庫 | 一塊 2 頁的已知限制（LM-12 ①） | 複核時留意跨頁題；可在 `.env` 把 `JOB_PDF_CHUNK_PAGES` 設大一點（每塊更慢） |

### 10.9 維護者備註（L4 的實作）

- 錄前檢查、時間粗估與「這一輪用到哪些模型」的判斷在 `exam_pro/eval/lib/localMode.js`；`npm run cassettes:rerecord`（`eval/tools/rerecord_all.js`）與 `npm run ocr:selftest`（`eval/tools/ocr_selftest.js`）共用。每次秒數的預設值與依據寫在該檔的 `SEC_PER_CALL`。
- 錄製子行程照 `ci.yml`：`MODEL_EXTRACT`／`MODEL_VERIFY`，以及有寫的 `EMBED_MODEL`、`MODEL_NLQ`、`OCR_ENGINE`、`OCR_DPI`（`eval/lib/suiteProcess.js` 的 `CI_OPTIONAL_KEYS`）。錄製時另外放行 `OLLAMA_*`、`OCR_PYTHON`、`OCR_TIMEOUT_MS`，並帶 `JOB_NODE_TIMEOUT_MS=2700000`、`NLQ_TIMEOUT_MS=1800000`（只影響逾時，不進 cassette 的鍵）。
- 本機拆題新增的三個 cassette 目錄（`ocr`、`extract_vision`、`extract_ocr`）納入盤點與 `cassettes:prune`；化學版（`*_chem`）照舊不碰。OCR 的回放由探針包住 `services/ocr` 的 `ocrPdf`（`eval/lib/cassetteProbe.js`）。
- Windows 腳本的輸出經 `eval/tools/tee_run.js` 同時印在畫面上並寫進 log（Windows 沒有 `tee`）。
- 向量檔名的模型段把 `:`、`/`、`\` 換成 `-`（`eval/lib/embeddings.js` 的 `safeModelName`，與第 3 條第 6 點同一條規則）。repo 內錄好的向量目前只有 Gemini 那一份，讀錄好資料的單元測試明寫模型（`test/unit/lib/recordedData.js` 的 `RECORDED_EMBED_MODEL`）；本機重錄進版控後可以改成本機模型。

### 10.10 怎麼量實際速度（`npm run perf:local`）

10.5 的速度是粗估。重錄（10.7）錄下的每一支回放檔都記了那一次呼叫實際花了多久、讀了與寫了多少 token，可以拿來算這台電腦真正的速度，再決定逾時與每塊頁數（Owner 決策單 B18「上傳幾份卷後再看」）。這個指令只讀檔案：不呼叫模型、不連網、不改任何設定。

1. 重錄完（錄到一半也可以）在 `exam_pro` 資料夾執行（log 檔名換成你那一份）：

   ```bat
   npm run perf:local -- --log data\local_ai\record_20260926_210000.log --out data\local_ai\perf.md
   ```

   - `--log`：`record_local.bat` 寫的 log，可以給好幾次；不給就只看回放檔。
   - `--since 2026-09-26`：只算這天 0 點以後錄的（重錄過好幾輪、只想看最新一輪時用；也可以寫 `2026-09-26T21:00`）。
   - `--vendor all`：連 Gemini 錄的一起列（預設只看本機：Ollama 模型＋PaddleOCR）。
   - `--out`：另存一份 Markdown（畫面上照樣印；`data\` 不進版控）。
2. 報告分三段：
   - **各 agent 的延遲與速度**：每一步錄了幾支、延遲的 p50（一半的呼叫不超過它）、p90（九成的呼叫不超過它）、max，每秒輸出幾個 token，平均讀／寫幾個 token；`ocr`、`extract_vision`、`extract_ocr` 另有「每頁秒數」。支數旁標「樣本少」（少於 5 支）的只能參考，多錄幾份卷再看。
   - **重錄各步驟的總耗時**（有給 `--log` 才有）：每個 suite 花了多久、結束碼；「沒有結束紀錄」是中途被關掉。也會數 log 裡的逾時訊息——逾時的呼叫不會留下回放檔，上一段看不到它們。
   - **建議**：只是數字與理由，要不要改由你決定。
     - 逾時：`OLLAMA_TIMEOUT_MS`、`OCR_TIMEOUT_MS`、`JOB_NODE_TIMEOUT_MS` 的安全值＝max(3 × p90, 2 × max)，進位到整分鐘；標「不夠」的照建議寫進 `.env`。拆題的一個節點是一塊的 OCR、看圖拆題、OCR 整理三步相加，驗算最多採樣兩次。
     - `RERECORD_TIME_SCALE`：實測秒數 ÷ 粗估秒數（`eval/lib/localMode.js` 的 `SEC_PER_CALL`）。寫進 `.env` 之後，下次 `npm run cassettes:rerecord -- --dry-run` 的預估時間就會照實測縮放；各步驟的倍率差很多時，改列個別的 `RERECORD_SEC_PER_CALL_<AGENT>`。
     - `JOB_PDF_CHUNK_PAGES`：依每頁秒數，在目前的逾時與 `OLLAMA_NUM_CTX` 下一塊最多放得下幾頁。比現在的 2 頁小就調小（或先調高逾時）；比 2 大表示可以放寬，但一塊更久、失敗時要重跑的也多。
3. 要知道的限制：
   - 延遲是牆鐘時間，含模型載入與排隊；輸出速度的分母含讀題目的時間，比「純生成」低。
   - **正式上傳的考卷不會留下回放檔**（`LLM_MODE=live`）。上傳幾份之後要看正式使用時各節點花多久，用 `npm run report:jobs -- --since=7d`（各節點的 p50／p95）。
   - `.env` 的 `JOB_NODE_TIMEOUT_MS` 只影響正式上傳；重錄時固定 45 分（10.9），建議值超過它時報告會提醒。
4. 量完之後，請把 10.5 表格裡的粗估換成實測值（或把報告交給維護的人更新）。
