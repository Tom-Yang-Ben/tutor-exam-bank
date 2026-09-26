# 本機模式（Local-first）契約與使用說明

> 版本 1.0（2026-09-25，主控凍結）。分支 `local/base`，基底是 `stage5/chapters`（522f81c）。
> 本檔是 L1～L4 四條平行工作的**凍結介面**。各 WS 發現契約有問題，寫在自己的回報裡，不要自行改契約；由主控裁決，登錄在第 9 條（LM-n）。
> 〔修訂 2026-09-26 決策單〕依 Owner 2026-09-25「出題系統決策單」第一輪答覆，在第 6 條第 3 點、LM-12、LM-14、10.5、10.7 就地加註（A7：門檻不動、未達就紅燈；C：刪 Gemini cassette 暫緩；B18、B21）；總表見 [`HANDOFF.md`](HANDOFF.md) §0.00。
> 〔2026-09-26 `dec/local-vision-timeout`〕Owner 實機重錄時看圖拆題一塊超過 30 分而逾時：10.5、10.8、10.9、10.10 就地加註，新增 10.11（逾時清單、進度、`npm run local:bench-vision`、加速選項）。第 0～9 條沒有改。
> 〔2026-09-26 `dec/local-classify-nlq-prep`〕classify／nlq 重錄前修正：新增 10.12（重現 2026-09-25 的失敗、逐題歸因、章節的程式後處理、決策草稿 LC-1～LC-4）。其餘各條沒有改。
> 〔Owner 決策單 2026-09-26 第四輪〕依 Owner 2026-09-26「上線與本機速度決策單」答覆（分支 `dec/r4-decisions`）：第 2 條的表、LM-12、10.7 第 9 點、10.11 的逾時表（#4、#6）、加速選項表與 (a)(c) 的細節就地加註（V1～V5）；程式改了兩處（V3 本機拆題逾時只重試 1 次、V4 舊流程 `/analyze-pdf` 本機預設每塊 2 頁），其餘預設值不變。總表見 [`HANDOFF.md`](HANDOFF.md) §0.00b。

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
| `JOB_PDF_CHUNK_PAGES` | 拆題模型是 `ollama` 時預設 `2` | 一次送給視覺模型幾頁。〔Owner 決策單 2026-09-26 第四輪 V4〕舊流程 `/analyze-pdf` 也照這個預設（同一個常數 `LOCAL_PDF_CHUNK_PAGES`），原本沒寫時是 20 頁 |
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
3. embedding fixture：`record_embeddings.js` 等支援 `ollama:` 模型與第 3 條第 6 點的檔名；`thresholds.json` 的 `_measured_with` 之類的欄位只在錄完後由主控更新。**門檻數字不動**；本機重錄後低於門檻，由 Owner 另行裁決~~（多半是依本機模型重建基準）~~。〔修訂 2026-09-26 決策單 A7〕Owner 2026-09-25 已裁決：門檻數字不動，未達就讓它紅燈、之後改善，**不**依本機模型重建基準（見 LM-14）。
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
| LM-12 | 已知限制（不在這一輪處理） | ①一塊 2 頁會切到跨頁的題，兩個引擎看到同一個被切斷的題可能「一致」而自動入庫——之後可加一頁前瞻；②45 分鐘節點逾時在 i5-8265U 上可能不夠（`JOB_NODE_TIMEOUT_MS` 可調大）；③相似度門檻 0.85 會讓複核比例偏高，本機重錄後再校準；④PaddleOCR 在含中文的 Windows 路徑可能載不到模型，`OCR_MODEL_HOME` 設成純英文路徑；⑤舊的同步 `/analyze-pdf` 在本機模式不實用；⑥PaddleOCR 還沒在實機跑過（雲端 container 下載不到模型），第一次在 Owner 電腦上執行 `setup_local_ai.bat` 才算驗證。〔修訂 2026-09-26 決策單 B18／B21〕Owner 2026-09-25 決策單：本機拆題的限制等上傳幾份卷後再看（待決）；⑤的 `/analyze-pdf` 保留並補裁圖（由 `dec/b21-legacy-analyze-pdf-figures` 實作），本機模式下仍慢。〔Owner 決策單 2026-09-26 第四輪 V1～V4〕②：Owner 的 `.env` 直接放寬（V1，10.11）、本機拆題逾時只重試 1 次（V3）；⑤：`/analyze-pdf` 本機模式沒寫 `JOB_PDF_CHUNK_PAGES` 時改為每塊 2 頁（V4）——仍是同步請求，一塊一塊依序跑，4 頁卷仍要等兩塊的時間 |
| LM-13 | Windows 腳本的行尾；L3 的離線檢查沒進 `check:html` | `.gitattributes` 加 `exam_pro/scripts/windows/*.bat -text`（CRLF 原樣進出，不受 autocrlf 影響）；`check:html` 串上 `scripts/check_html_offline.js`（`evalStage3.test.js` 的 scripts 斷言同步） |
| LM-14 | 門檻與 cassette 清理 | `eval/thresholds.json` 的數字不動；本機重錄後若低於門檻，由 Owner 另行裁決~~（多半依本機模型重建基準）~~。本機重錄後 `cassettes:prune` 會把 Gemini 的 cassette 列為過期：確定不切回 Gemini 之前不要 `--apply`。〔修訂 2026-09-26 決策單 A7〕Owner 2026-09-25 決策單：**門檻數字不動，未達就讓它紅燈，之後再改善**；不依本機模型重建基準。帶著紅燈的 PR（`local/integration` → main，A8）能不能合併，在第二輪 X1 待答。〔整合 2026-09-26〕X1 已答（見 [`HANDOFF.md` §0.00a](HANDOFF.md#000a-owner-決策單第二三輪2026-09-26修訂-2026-09-26-決策單第二三輪)）：只有 eval 分數可以紅燈合併，unit、integration、e2e 必須綠，PR 說明列出未達項。〔修訂 2026-09-26 決策單 C〕刪 Gemini cassette（`cassettes:prune -- --apply`）在本機模式下暫緩 |
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
| 視覺模型拆一塊（2 頁） | ~~15～30 分鐘~~ **Owner 實機超過 30 分鐘**（2026-09-26 重錄時被 `OLLAMA_TIMEOUT_MS` 的 30 分切掉）；一頁實際多久用 `npm run local:bench-vision` 量（10.8、10.11） |
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
- 章節分類、獨立驗算的準確率預期低於 Gemini；五個 eval 的門檻（`eval/thresholds.json`）是用 Gemini 量的，本機重錄後很可能有幾項未達。**門檻數字不會自動放寬**~~，由 Owner 另行裁決（多半是依本機模型重建基準；第 6 條第 3 點）~~。〔修訂 2026-09-26 決策單 A7〕Owner 2026-09-25 已決定：門檻數字不動，未達的 eval 就讓 CI 紅燈，之後再改善品質；不依本機模型重建基準（LM-14）。帶紅燈的 PR 能不能合併在第二輪 X1 待答。
  〔整合 2026-09-26〕X1 已答（見 [`HANDOFF.md` §0.00a](HANDOFF.md#000a-owner-決策單第二三輪2026-09-26修訂-2026-09-26-決策單第二三輪)）：只有 eval 分數可以紅燈合併，unit、integration、e2e 必須綠，PR 說明列出未達項。
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
7. 回放驗證有門檻未達時，照 10.5 最後一點：不放寬，交給 Owner 裁決。〔修訂 2026-09-26 決策單 A7〕Owner 已裁決：門檻不放寬、照實紅燈，之後改善；帶紅燈的 PR 能否合併等第二輪 X1。
   〔整合 2026-09-26〕X1 已答（見 [`HANDOFF.md` §0.00a](HANDOFF.md#000a-owner-決策單第二三輪2026-09-26修訂-2026-09-26-決策單第二三輪)）：只有 eval 分數可以紅燈合併，unit、integration、e2e 必須綠，PR 說明列出未達項。
8. **〔2026-09-26 修正〕variant 那一步最後報「dedup1 取不到變式題的向量（EMBED_MODE=fixture）：embedding fixture 查無此文本」、`gate_pass_rate` n/a**：舊版 `eval/lib/suiteVariant.js` 的 dedup1 寫死去讀向量檔，不看 `EMBED_MODE`（訊息裡的「EMBED_MODE=fixture」也是寫死的字，子行程其實是 record）。平常查得到，是因為出變式的跑題檢查剛剛才把**同一段文字**錄進檔；classify 換了章、或 lint 改寫了題幹（例：模型寫 `\overrightarrow`、lint 改成 `\vec`）的那幾題，dedup1 要的那一段沒有人錄過。`dec/fix-variant-embed-record` 已修正：錄製時 dedup1 也呼叫 embedding 模型並寫進向量檔。

   **第 4 步錄好的 cassette 不必重錄**。拉到修正版後只補向量（只呼叫 `qwen3-embedding:0.6b`，LLM 全部回放，幾分鐘）。Ollama 開著，在 `exam_pro\` 開命令提示字元（cmd）逐行執行：

   ```bat
   git pull
   set MODEL_
   set EMBED_MODEL
   set LLM_MODE=replay
   set EMBED_MODE=record
   node eval\run.js --suite variant
   set LLM_MODE=
   set EMBED_MODE=
   npm run cassettes:rerecord -- --dry-run --suites variant
   ```

   - `set MODEL_`、`set EMBED_MODEL` 應回「環境變數 … 沒有定義」：模型不必設，程式預設就是 `ci.yml` 的本機模型。有列出東西的話先 `set 那個名字=` 清掉，否則錄出來的鍵 CI 讀不到。
   - `node eval\run.js --suite variant` 會印幾十行 `[embed:record] 已寫入 … 筆向量`；最後**不應再有**「查不到變式題的向量」，`gate_pass_rate` 應是數字。結束碼仍可能是 1——那是 `retrieved_coverage` 低於門檻（第 9 點），與這個問題無關。
   - 最後一行是 CI 的設定（回放）：盤點表 variant 那一列的「缺 cassette」「缺向量」都應是 0。
   - 若出現 `cassette replay miss`（例如 pull 下來的版本改了 prompt），改成整步重錄：`scripts\windows\record_local.bat variant`（variant 的 LLM 全部重跑，上次花了 17292 秒）。
   - 補好後 `git add eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json`（連同第 4 步錄好、還沒 commit 的 `eval/cassettes`），commit、push。
   - PowerShell 的寫法：`$env:LLM_MODE='replay'; $env:EMBED_MODE='record'; node eval/run.js --suite variant; Remove-Item Env:LLM_MODE, Env:EMBED_MODE`。
9. **`retrieved_coverage` 遠低於門檻（本機重錄實測 0.2333，門檻 0.8367）與第 8 點無關**：這個數字零 LLM、零 embedding 呼叫，只拿 fixture 60 題已錄好的向量算「同科、同難度、餘弦 ≥ `VARIANT_RETRIEVE_SIM_MIN`（0.80）的題有沒有 2 題」。0.80 是照 Gemini 向量的餘弦分布定的（`docs/variants.md` 第 3 節：同概念換數字最低 0.93、跨章中位數 0.78）；換成 `qwen3-embedding:0.6b` 分布就不同，同一個門檻只剩 7／30 個藍本過。依 LM-14 門檻不動、照實紅燈。之後要評估時可以先看分布（只讀向量檔，不改任何設定）：

   ```bat
   node -e "const s=require('./eval/lib/suiteVariant'),f=require('./eval/lib/fixtures').loadFixture(),e=require('./eval/lib/embeddings').loadEmbeddings({questions:f.questions});for(const x of s.loadVariantGolden({fixtureById:f.byId}).entries){const h=s.retrieveInMemory({source:f.byId.get(x.source_question_id),questions:f.questions,vectorOf:e.vectorOf,simMin:-1});console.log(x.id,x.chapter,h.slice(0,2).map(r=>r.cosine.toFixed(3)).join(' '))}"
   ```

   每行是一個藍本與「最近、第 2 近」的餘弦；第 2 個數字 ≥ 門檻的藍本才算覆蓋。要不要依本機向量重新校準 `VARIANT_RETRIEVE_SIM_MIN`（以及跑題的 `VARIANT_OFFTOPIC_SIM_MIN` 0.90、去重的 `DEDUP_DUP_THRESHOLD` 0.97，同樣是照 Gemini 定的）由 Owner 裁決。〔Owner 決策單 2026-09-26 第四輪 V5〕Owner 選 1：要重新校準——重錄之後用本機向量跑分布分析，提出三個門檻的新值與依據，Owner 核准後才改；**這次不改任何門檻**（`.env.example`、程式預設、`eval/thresholds.json` 都不動）。

### 10.8 疑難排解

| 看到什麼 | 原因 | 怎麼辦 |
|---|---|---|
| 「Ollama 沒有在執行，請先開啟 Ollama」、`ECONNREFUSED 127.0.0.1:11434` | Ollama 沒開，或 `OLLAMA_HOST` 指錯 | 從「開始」選單開啟 Ollama，等工作列出現羊駝圖示；`.env` 的 `OLLAMA_HOST` 應是 `http://127.0.0.1:11434` |
| 訊息附上 `ollama pull <模型>`、「模型不存在」 | 模型沒下載，或 `.env` 的模型名打錯 | 照訊息執行 `ollama pull …`，或重跑 `setup_local_ai.bat`；`ollama list` 看已下載的模型 |
| 電腦卡住、Ollama 回「model requires more system memory」、硬碟燈狂閃 | 記憶體不足（同時載入兩個 8B 模型，或瀏覽器分頁太多） | 設 `OLLAMA_MAX_LOADED_MODELS=1`（10.2 第 4 步）；`.env` 設 `OLLAMA_KEEP_ALIVE=2m`、`OLLAMA_NUM_CTX=8192`、`JOB_CONCURRENCY=1`；處理期間關掉不用的程式。仍不夠時才考慮換小一號的模型（例如 4B；換模型＝CI 回放檔要重錄） |
| 拆題的節點 `error:timeout` | `.env` 還留著舊的 `JOB_NODE_TIMEOUT_MS=120000`，或考卷太長；**或看圖拆題一塊就超過 `OLLAMA_TIMEOUT_MS` 的 30 分**（Owner 實機 2026-09-26 就是這樣） | 刪掉那一行（本機預設 45 分）；仍逾時先照下面「看圖拆題太慢或逾時：先量一頁」量，再照 10.11 決定：調高 `OLLAMA_TIMEOUT_MS` **與** `JOB_NODE_TIMEOUT_MS`（只調一個沒用）、縮圖或一塊 1 頁 |
| 重錄第 5 步 pipeline 印「extract 未通過：timeout」、整步約 2000 秒、結束碼 1；第 6 步 e2e 接著報 `replay 找不到 cassette（agent=extract_vision …）` | 舊版重錄照 `.env` 的 `OLLAMA_TIMEOUT_MS`（30 分）錄 pipeline，看圖拆題超過 30 分就被切掉，`extract_vision` 的回放檔沒錄到，e2e 回放時自然找不到 | 拉新版（`dec/local-vision-timeout` 之後）：重錄 pipeline 與 e2e 兩步時單次呼叫與節點逾時自動放寬到 3 小時、每 5 分鐘印一次輸出進度，**不必改 `.env`**。只重錄這兩步：`scripts\windows\record_local.bat pipeline,e2e`（錄製模式下 OCR 也會重跑一次、覆寫原本的回放檔，幾分鐘）。3 小時還不夠就在 `.env` 加 `RERECORD_OLLAMA_TIMEOUT_MS=21600000`（6 小時，只影響重錄） |
| 伺服器視窗很久沒有動靜，不知道是慢還是卡住 | 預設不串流，Ollama 算完之前什麼都不回 | `.env` 加 `OLLAMA_PROGRESS_MS=300000`（每 5 分鐘印一行「已輸出 N token」或「還沒輸出第一個 token：讀圖中」），重啟伺服器；token 數持續不增加、工作管理員裡 Ollama 的 CPU 也掉下來才是卡住 |
| `setup_local_ai.bat` 停在第 5 步（pip install） | Python 版本太新而 PaddlePaddle 還沒有對應套件、網路中斷、防毒軟體攔截 | 改裝 Python 3.11 或 3.12（64 位元），刪掉 `exam_pro\ocr_service\.venv` 後重跑；錯誤細節在 log 的最後幾十行 |
| 第 6 或第 7 步出現 `ConvertPirAttribute2RuntimeAttribute not support` | 裝到了 PaddlePaddle 3.3.x（已知的框架錯誤，LM-16） | 確認 `exam_pro\ocr_service\requirements.txt` 寫的是 `paddlepaddle==3.2.2`，重跑 `setup_local_ai.bat`（第 5 步會自動換版本） |
| 停在第 6 或第 7 步（`--warmup`／`--selftest`） | OCR 模型沒下載完整 | 重跑 `setup_local_ai.bat`；`npm run ocr:selftest` 單獨檢查。暫時修不好可以在 `.env` 設 `OCR_ENGINE=none`：只用視覺模型拆題、交叉驗證停用，所有題都停在人工複核 |
| 「找不到 OCR 用的 Python」 | `.venv` 還沒建，或 `.env` 的 `OCR_PYTHON` 指錯 | 重跑 `setup_local_ai.bat`；`OCR_PYTHON` 不設就用 `.venv` 那一支 |
| 很多題停在複核、原因是「拆題交叉驗證不一致」 | 預期中的行為（第 1 條第 6 點） | 在複核頁對照原卷改對後核准 |
| 語音按鈕不見了 | 本機模式不提供語音 | 預期中的行為；要用語音只能切回 Gemini（10.4） |
| GitHub Actions 的 e2e／eval 紅燈，訊息是 replay miss 或缺向量 | `ci.yml` 已改本機模型，回放檔還沒以本機模型重錄 | 照 10.7 重錄 |
| 重錄 variant 時大部分題都有「已寫入 2 筆向量」，最後卻報「dedup1 取不到變式題的向量（EMBED_MODE=fixture）」、`gate_pass_rate` n/a | 2026-09-26 之前的版本 dedup1 寫死讀向量檔（已修正） | 拉新版後照 10.7 第 8 點只補向量，不必重錄 LLM |
| `.bat` 視窗裡中文變亂碼 | 主控台字型不支援 | 不影響執行；log 檔是 UTF-8，用記事本開 |
| 頁面沒有樣式、公式不排版、字型怪怪的，瀏覽器主控台有 500／CORS 錯誤 | 用 `http://127.0.0.1:3000` 開頁面；字型、MathJax、Tailwind 改由本機伺服器提供後要過 `ALLOWED_ORIGINS` | 一律用 `.env` 的 `ALLOWED_ORIGINS` 裡的網址開（預設 `http://localhost:3000`） |
| 拆題被切在兩頁中間的題，兩個引擎都拆成殘缺的一題卻自動入庫 | 一塊 2 頁的已知限制（LM-12 ①） | 複核時留意跨頁題；可在 `.env` 把 `JOB_PDF_CHUNK_PAGES` 設大一點（每塊更慢） |

**看圖拆題太慢或逾時：先量一頁（`npm run local:bench-vision`）**

只呼叫一次視覺模型看 1 頁，印出讀圖（prompt eval）與輸出各花幾秒、幾個 token、每秒幾個 token，並推估「一塊 1 頁／一塊 2 頁／一份 4 頁卷」的看圖拆題要多久、目前的逾時夠不夠。不寫回放檔、不碰資料庫、不改 `.env`；量測自己的逾時是 3 小時（`--timeout-min` 可改），不會被 `.env` 的 30 分切掉。Ollama 要開著，一頁可能要半小時以上，期間電腦會很忙。

在 `exam_pro` 資料夾開**命令提示字元（cmd）**：

```bat
cd /d C:\你的路徑\tutor-exam-bank\exam_pro
npm run local:bench-vision
npm run local:bench-vision -- --pdf "C:\考卷\第一次段考.pdf" --pages 1 --dpi 200
npm run local:bench-vision -- --max-edge 1600
npm run local:bench-vision -- --baseline
```

**PowerShell** 直接呼叫 node（PowerShell 經 `npm.ps1` 呼叫 npm 時，`--` 可能被吃掉，後面的參數就變成 npm 自己的設定；直接用 node 最穩，結果完全相同）：

```powershell
Set-Location C:\你的路徑\tutor-exam-bank\exam_pro
node eval/tools/local_bench_vision.js
node eval/tools/local_bench_vision.js --pdf 'C:\考卷\第一次段考.pdf' --pages 1 --dpi 200
node eval/tools/local_bench_vision.js --max-edge 1600
node eval/tools/local_bench_vision.js --baseline
```

- 第一行（不加參數）量 `eval\fixtures\sample_exam.pdf` 第 1 頁、200 DPI，就是重錄時逾時的那一份。
- `--pdf … --pages 1`：量自己的考卷（`--from 3` 從第 3 頁開始；`--pages` 最多 4，一次送出，等於拆一塊）。
- `--max-edge 1600`：同一頁先把圖片長邊縮到 1600 像素再送（10.11 的選項 b），和不縮的結果比讀圖秒數，也看看拆出來的題目還對不對。
- `--baseline`：多量一次「只有文字、輸出 1 個 token」（多 2～5 分鐘），把讀 prompt 拆成固定的提示詞與每頁圖片，推估比較準。
- 預設會先請 Ollama 卸載模型再量，時間含模型載入（正式拆題時每一塊都要重新載入視覺模型）；`--warm` 不卸載。
- 畫面每 60 秒印一行進度（`--progress-sec` 可改）。最後的表格與「建議」只是數字，要不要改 `.env` 照 10.11 由你決定。
- 量完把最後那一段（從「══ 看圖拆題量測」開始）貼給維護的人，就能換掉 10.5 的粗估。

### 10.9 維護者備註（L4 的實作）

- 錄前檢查、時間粗估與「這一輪用到哪些模型」的判斷在 `exam_pro/eval/lib/localMode.js`；`npm run cassettes:rerecord`（`eval/tools/rerecord_all.js`）與 `npm run ocr:selftest`（`eval/tools/ocr_selftest.js`）共用。每次秒數的預設值與依據寫在該檔的 `SEC_PER_CALL`。
- 錄製子行程照 `ci.yml`：`MODEL_EXTRACT`／`MODEL_VERIFY`，以及有寫的 `EMBED_MODEL`、`MODEL_NLQ`、`OCR_ENGINE`、`OCR_DPI`（`eval/lib/suiteProcess.js` 的 `CI_OPTIONAL_KEYS`）。錄製時另外放行 `OLLAMA_*`、`OCR_PYTHON`、`OCR_TIMEOUT_MS`（〔2026-09-26〕加上 `OLLAMA_PROGRESS_MS`、`VISION_MAX_EDGE_PX`），並帶 `JOB_NODE_TIMEOUT_MS=2700000`、`NLQ_TIMEOUT_MS=1800000`（只影響逾時，不進 cassette 的鍵）。〔2026-09-26 `dec/local-vision-timeout`〕pipeline 與 e2e 兩步再蓋上 `OLLAMA_TIMEOUT_MS`＝max(3 小時, `.env` 的值)、`JOB_NODE_TIMEOUT_MS`＝`E2E_NODE_TIMEOUT_MS`＝3 小時、`OLLAMA_PROGRESS_MS`＝5 分（`.env` 沒寫時）；`RERECORD_OLLAMA_TIMEOUT_MS`／`RERECORD_NODE_TIMEOUT_MS` 可覆寫（`eval/lib/localMode.js` 的 `longCallRecordEnv`、`eval/tools/rerecord_all.js` 的 `stepExtraEnv`，經 `ciEnv` 的 `extra` 帶進子行程，與既有做法相同）。回放（CI 與錄完的驗證）不帶這些。
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
   - **各 agent 的延遲與速度**：每一步錄了幾支、延遲的 p50（一半的呼叫不超過它）、p90（九成的呼叫不超過它）、max，每秒輸出幾個 token，平均讀／寫幾個 token；`ocr`、`extract_vision`、`extract_ocr` 另有「每頁秒數」。支數旁標「樣本少：p90 等於最大值」（少於 10 支：百分位數取實際量到的某一次，9 支以內的 p90 就是最慢的那一次）的只能參考，多錄幾份卷再看。
   - **重錄各步驟的總耗時**（有給 `--log` 才有）：每個 suite 花了多久、結束碼；「沒有結束紀錄」是中途被關掉。也會數 log 裡的逾時訊息——逾時的呼叫不會留下回放檔，上一段看不到它們。
   - **建議**：只是數字與理由，要不要改由你決定。
     - 逾時：`OLLAMA_TIMEOUT_MS`、`OCR_TIMEOUT_MS`、`JOB_NODE_TIMEOUT_MS` 的安全值＝max(3 × p90, 2 × max)，進位到整分鐘；標「不夠」的照建議寫進 `.env`。拆題的一個節點是一塊的 OCR、看圖拆題、OCR 整理三步相加，驗算最多採樣兩次。
     - `RERECORD_TIME_SCALE`：實測秒數 ÷ 粗估秒數（`eval/lib/localMode.js` 的 `SEC_PER_CALL`）。寫進 `.env` 之後，下次 `npm run cassettes:rerecord -- --dry-run` 的預估時間就會照實測縮放；各步驟的倍率差很多時，改列個別的 `RERECORD_SEC_PER_CALL_<AGENT>`。
     - `JOB_PDF_CHUNK_PAGES`：依每頁秒數，在目前的逾時與 `OLLAMA_NUM_CTX` 下一塊最多放得下幾頁。比現在的 2 頁小就調小（或先調高逾時）；比 2 大表示可以放寬，但一塊更久、失敗時要重跑的也多。
       每頁秒數是把錄到的時間按頁平均，模型載入、系統提示詞這些固定開銷也攤進去了：估比錄製時**多**的頁數偏保守，估比錄製時**少**的頁數會**低估**（固定開銷不會跟著頁數減半）。所以建議的頁數比錄製時少（例如錄的是 2 頁、建議 1 頁）時，實際一塊會比報告估的久，報告會另外提醒；改了之後上傳幾份卷，用 `npm run report:jobs -- --since=7d` 看 extract 節點實際花多久。報告寫「每塊 1 頁也達不到 max(3 × p90, 2 × max) 的安全餘裕」時，意思是餘裕不夠、不是一定會逾時：它會列出實際錄到的每塊最長時間，對照目前的逾時，先調高逾時再重跑本工具。
3. 要知道的限制：
   - 延遲是牆鐘時間，含模型載入與排隊；輸出速度的分母含讀題目的時間，比「純生成」低。
   - **正式上傳的考卷不會留下回放檔**（`LLM_MODE=live`）。上傳幾份之後要看正式使用時各節點花多久，用 `npm run report:jobs -- --since=7d`（各節點的 p50／p95）。
   - `.env` 的 `JOB_NODE_TIMEOUT_MS` 只影響正式上傳；重錄時固定 45 分、pipeline 與 e2e 兩步 3 小時（10.9），建議值超過 45 分時報告會提醒。eval 的 suite 其實不對節點計時，重錄時真正會切斷呼叫的是 `OLLAMA_TIMEOUT_MS` 與 `OCR_TIMEOUT_MS`。
   - 〔2026-09-26〕新版錄的回放檔多記了 Ollama 自己量的分段時間（`response.usage.timing`：載入、讀 prompt〔含看圖〕、輸出的毫秒數），報告第 1.1 段分開列出「每頁讀圖幾秒」「純輸出每秒幾個 token」「排隊與傳輸」；之前錄的沒有這一段，只能看第 1 段的總延遲。
4. 量完之後，請把 10.5 表格裡的粗估換成實測值（或把報告交給維護的人更新）。

### 10.11 看圖拆題的逾時、進度與加速選項（2026-09-26，`dec/local-vision-timeout`）

**發生了什麼**：Owner 實機（i5-8265U、16 GB、純 CPU；`qwen3-vl:8b` 看圖、`qwen3:8b` 文字、PaddleOCR 3.7）重錄第 5 步 pipeline：OCR 很快就錄好，接著看圖拆題（`extract_vision`，一塊 2 頁、每頁 200 DPI 的 PNG）跑了約 30 分鐘後「extract 未通過：timeout」，整步 2075 秒、結束碼 1。`.env` 是 `OLLAMA_TIMEOUT_MS=1800000`、`OLLAMA_NUM_CTX=16384`、`OCR_TIMEOUT_MS=1800000`。`extract_vision` 的回放檔沒錄到，第 6 步 e2e 就 replay miss。對照：分類（`qwen3:8b`）一次讀 2,495 token、寫 56 token 共 41.5 秒。10.5 原本估「視覺模型拆一塊 15～30 分鐘」，實際超過 30 分鐘——所以**平常上傳 PDF 拆題在這台電腦上也會逾時**，不只是重錄。

#### 1. 看圖拆題這條路上會切斷它的逾時

| # | 逾時 | 目前的值 | 管哪一段 | 程式 |
|---|---|---|---|---|
| 1 | `OLLAMA_TIMEOUT_MS` | 1800000（30 分），`.env` 可改 | **單次** Ollama 呼叫；從拿到併發槽起算（排隊不算）。Owner 這次就是被它切掉的 | `services/llm/ollama.js` 的 `callApi` |
| 2 | `OCR_TIMEOUT_MS` | 1800000（30 分） | 單次 PaddleOCR（一塊的 OCR） | `services/ocr/index.js` |
| 3 | 節點逾時 `JOB_NODE_TIMEOUT_MS` | 拆題模型是 ollama 且 `.env` 沒寫時 2700000（45 分，`LOCAL_NODE_TIMEOUT_MS`） | 正式上傳時**一塊**的拆題節點＝OCR＋看圖＋OCR 整理**依序**跑，含排隊等 Ollama；到時間整個節點中止（還在跑的 Ollama 呼叫一起中止） | `workers/jobRunner.js` 的 `invokeNode` |
| 4 | 錯誤重試 | 逾時算「錯誤」，退避後重試 3 次（`DEFAULT_LIMITS.maxErrorRetries`） | 同一塊最多跑 4 次才讓整份卷 `failed`；每次都被 #1 在 30 多分鐘時切掉，一塊就白跑兩個多小時。〔Owner 決策單 2026-09-26 第四輪 V3〕Owner 選 2：拆題模型是 ollama 時，錯誤類別是 `timeout` 的只重試 1 次（共跑 2 次，常數 `LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES`）；其他錯誤類別仍重試 3 次、逾時也算進這 3 次；Gemini 模式不變。`jobs.error` 會多註明「（本機模式逾時只重試 1 次）」。只管拆題一塊；逐題的節點（分類、lint、驗算…）照狀態機原本的規則 | `workers/jobRunner.js` 的 `runExtractChunk` |
| 5 | 整份卷 | **沒有**總逾時；租約 `JOB_LEASE_MS`（3 分）在節點執行中每 30 秒續租，不會切斷 | 一塊一塊依序拆，拆完才逐題分類、lint、驗算 | `workers/jobRunner.js` |
| 6 | 舊流程 `/analyze-pdf`（`FEATURE_PIPELINE=false` 時的上傳） | 沒有節點逾時，只受 #1；伺服器與瀏覽器都沒有回應逾時 | ⚠️ 每塊頁數讀 `JOB_PDF_CHUNK_PAGES`，**沒寫時是 20 頁**（不是本機的 2 頁）：4 頁卷一次送 4 頁，比管線更容易被 #1 切掉（LM-12 ⑤）。〔Owner 決策單 2026-09-26 第四輪 V4〕Owner 選 1：拆題模型是 ollama 且 `.env` 沒明寫（或不是正整數）時改為 2 頁，與管線共用 `workers/jobRunner.js` 的 `LOCAL_PDF_CHUNK_PAGES`；Gemini 模式仍是 20 頁；明寫的值照舊優先 | `services/aiService.js` |
| 7 | eval 的 pipeline suite（重錄第 5 步） | `thresholds.nodeTimeoutMs` 讀 `JOB_NODE_TIMEOUT_MS`（重錄時 2700000），但**只記在報表、不計時**（`signal: undefined`） | 所以重錄時真正會切斷的是 #1 與 #2 | `eval/lib/pipelineDriver.js` |
| 8 | 重錄的子行程 | 沒有逾時（`runNode`）；錄前檢查另有 OCR 自我檢查 600 秒、Ollama 連線 5 秒 | — | `eval/lib/suiteProcess.js`、`eval/lib/localMode.js` |
| 9 | e2e 測試本身 | runner 的節點逾時寫死 30 秒（LLM 一律回放；重錄第 6 步錄 dedup1 向量時 embedding 呼叫也受它限）；`node --test` 沒設逾時；`drain` 最多 120 輪 | 〔本分支〕改讀 `E2E_NODE_TIMEOUT_MS`，沒設時仍是 30 秒（CI 不變） | `test/e2e/pipeline.e2e.test.js` |
| 10 | Ollama 排隊 | `OLLAMA_CONCURRENCY=1`：排隊時間不算 #1，但算 #3 | — | `services/llm/throttle.js` |

只把 #1 調大沒用：#3 的 45 分一到，整個節點照樣中止；兩個要一起調（見下面的選項 c）。

#### 2. 本分支已經改的（不必做決定；預設行為一個都沒改）

- **重錄一次就錄成**：`npm run cassettes:rerecord`（`record_local.bat`）錄 pipeline 與 e2e 兩步時，單次 Ollama 呼叫逾時＝max(3 小時, `.env` 的值)、節點逾時 3 小時（`RERECORD_OLLAMA_TIMEOUT_MS`／`RERECORD_NODE_TIMEOUT_MS` 可改），並每 5 分鐘印一次輸出進度（10.9）。只影響逾時與 log：不改 `.env`、不進回放檔的鍵、CI 回放完全不受影響。
- **看得到進度**：`.env` 設 `OLLAMA_PROGRESS_MS`（毫秒，例 `300000`）就改用串流，每隔這麼久印一行：「排隊中」「已 12 分：還沒輸出第一個 token——載入模型、讀 prompt（看圖）中」「已 40 分：已輸出 800 token，最近 5 分多了 150 token」「已經 10 分沒有新 token——可能卡住」，結束時印載入、讀 prompt、輸出各花多久。讀 prompt（看圖）那一段 Ollama 不回報進度，只看得到經過時間。拆出來的結果、用量與回放檔內容和不串流時完全相同（`test/unit/llmOllamaStream.test.js`）。不設＝與之前相同。
- **分段時間進回放檔**：Ollama 回報的載入／讀 prompt／輸出時間記在 `usage.timing`、寫進錄製的回放檔（鍵不變；回放時不帶出來），`npm run perf:local` 第 1.1 段據此算每頁讀圖秒數與純輸出速度（10.10）。
- **先量再決定**：`npm run local:bench-vision`（10.8 有 cmd 與 PowerShell 的指令）。
- **選項 b 的設定**：`VISION_MAX_EDGE_PX`，預設不縮（下面）。

#### 3. 加速選項（預設都不改；請 Owner 決定）

| 選項 | 怎麼做 | 好處 | 代價 | 要重錄嗎 |
|---|---|---|---|---|
| (a) 一塊 1 頁 | `.env` 加 `JOB_PDF_CHUNK_PAGES=1` | 每一次看圖呼叫只看 1 頁，比較容易在逾時內做完；失敗時重跑的少 | 跨頁題變多（4 頁卷的切點從 1 處變 3 處）；每一塊都要重讀固定的提示詞、重新載入視覺模型，**整份卷的總時間通常不會變短** | 多頁 PDF 的回放檔要（塊號、頁碼範圍變了）；CI 的樣卷只有 1 頁、而且重錄不讀 `.env` 的這個值，所以只改 `.env` 不影響 CI |
| (b) 送出前縮圖 | `.env` 加 `VISION_MAX_EDGE_PX=1600` | 讀圖（prompt eval）變快：讀圖的 token 數大致跟像素成正比，A4＠200 DPI（1654×2339）縮到長邊 1600 約剩 47% 的像素 | 小字、上下標、分式、根號、化學式下標可能看不清 → 視覺版抄錯、交叉驗證不一致（停人工複核）的題變多 | 不必（鍵不含圖片） |
| (c) 放寬逾時 | `.env` 調大 `OLLAMA_TIMEOUT_MS` **與** `JOB_NODE_TIMEOUT_MS` | 不改拆題方式、不影響品質 | 真的卡住時要等更久才發現；逾時會重試 3 次（最壞 4 × 節點逾時）；一份卷在背景跑更久。〔第四輪 V3〕本機模式逾時改為只重試 1 次（最壞 2 × 節點逾時） | 不必 |
| (d) 獨立顯示卡 | 換／加硬體，程式不用改 | 讀圖與輸出通常都快很多，逾時與頁數可能都不必動 | 要花錢；筆電多半不能加；顯示卡記憶體要放得下模型 | 不必（重錄出來的內容可能與 CPU 錄的有細微差異） |

〔Owner 決策單 2026-09-26 第四輪〕**Owner 的選擇**（背景與選項原文在決策單；總表 [`HANDOFF.md`](HANDOFF.md) §0.00b）：

| 題號 | Owner 選擇 | 落實 |
|---|---|---|
| V1 | 選 2「直接放寬」＝選項 (c)：單次呼叫 90 分鐘、一塊 2 小時 | **只改 Owner 的 `.env`**：`OLLAMA_TIMEOUT_MS=5400000`、`JOB_NODE_TIMEOUT_MS=7200000`；程式預設（30 分、45 分）不變。(a)(b) 這次不採用（`JOB_PDF_CHUNK_PAGES` 不寫、`VISION_MAX_EDGE_PX` 不設）。照 (c) 的算法，一份 4 頁卷（2 塊）看圖這一步最壞約 2 × 2 小時；逾時的最壞情形見 V3 |
| V2 | 選 3：沒有獨立顯示卡，只有內顯 | (d) 不適用；Ollama 用 CPU 跑（i5-8265U 的 Intel 內顯 Ollama 預設不會用，見下面 (d)） |
| V3 | 選 2：本機模式逾時只重試 1 次 | 程式（`dec/r4-decisions`）：上面逾時表 #4；配合 V1，一塊真的做不完時最壞 2 × 2 小時＝4 小時就讓整份卷 `failed`（原本 4 × 節點逾時） |
| V4 | 選 1：舊流程 `/analyze-pdf` 本機預設每塊 2 頁 | 程式（`dec/r4-decisions`）：上面逾時表 #6 |
| V5 | 選 1：三個餘弦門檻依本機向量重新校準 | 重錄之後提出新值與依據給 Owner 核准；這次不改（10.7 第 9 點） |

另外 U3 選 2：Owner 的電腦更新後**先只跑 1 頁的看圖量測**（`npm run local:bench-vision`，10.8），其餘重錄等看完數字再決定。

**(a) 一塊 1 頁（`JOB_PDF_CHUNK_PAGES=1`）的細節**

- 每一塊的時間≈載入模型＋讀固定的提示詞＋1 頁（圖片＋輸出），比 2 頁的一塊短，但不是一半：固定的部分每塊都要付一次，4 頁卷的看圖總時間通常反而變長（bench 的「一塊 1 頁」×4 與「一份 4 頁卷」可以直接比）。
- 跨頁題：每一頁的交界都切開。LM-12 ①：被切斷的題兩個引擎看到的是同一段殘缺，可能「一致」而自動入庫；後半段在下一塊開頭會被當成「延續過來的殘段」丟掉（本機模板的【頁面邊界】規則）。跨頁的附圖也拆不到。
- 回放檔：塊號（`cacheKeyParts.chunkNo`）與頁碼範圍跟著變——多頁 PDF 的 OCR（鍵含 `fromPage／toPage`）、`extract_vision`／`extract_ocr`（鍵含 `chunkNo`，後者還有 OCR 文字的 `ocrSha256`）都是新鍵，對應的回放檔要重錄（例如 `eval/private` 裡 `compare:pipeline` 用的多頁考卷；eval 的 pipeline 驅動只拆第 1 塊，塊變小就只量得到第 1 頁）。CI 用的 `sample_exam.pdf` 只有 1 頁，鍵不變；重錄時 `.env` 的 `JOB_PDF_CHUNK_PAGES` 被擋掉（照 CI＝本機預設 2 頁），所以只改 `.env` 不會動到 CI。要連重錄一起改得改程式預設 `LOCAL_PDF_CHUNK_PAGES`（第 2 條的契約值，另行裁決）。
- 舊流程 `/analyze-pdf` 讀同一個變數；`.env` 明寫 1 之後它也一次 1 頁（沒寫時是 20 頁，上表 #6）。〔第四輪 V4〕沒寫時改為：本機模式 2 頁（與管線相同）、Gemini 模式 20 頁。

**(b) 送出前縮圖（`VISION_MAX_EDGE_PX`）的細節**

- 只縮送給視覺模型的那幾張 PNG（等比例、只縮不放；本來就不超過的原樣送）。PaddleOCR 用自己的原圖、附圖裁切另外從 PDF 渲染、`figure_box` 是 0–1000 的正規化座標，都不受影響。
- 預期效果來自「讀圖的 token 數大致與像素數成正比」（Qwen-VL 系列的動態解析度）；若 Ollama 本身已經把大圖縮到它的上限，效果會小很多——**以 bench 實測為準**：`npm run local:bench-vision -- --max-edge 1600` 與不加參數各量一次，比讀 prompt 的秒數，也看拆出來的題目（公式、上下標）是否一樣。1600 不夠快可以試 1400，更小就要很小心。
- 不必重錄：回放檔的鍵不含圖片。但重錄時 `.env` 的這個值會帶進去（圖片不在鍵裡，錄的就是你平常用的設定），CI 的 eval 分數量到的就是縮圖版的品質。
- 單元測試證明：沒設（或 0、亂填）時送出的位元組與之前完全相同、縮圖函式一次都不呼叫；開了之後鍵、OCR、OCR 版的請求都不變（`test/unit/visionMaxEdge.test.js`）。

**(c) 放寬逾時：放寬到多少、一份卷跑多久可以接受**

- 依 bench 的「一塊 N 頁（目前的 `JOB_PDF_CHUNK_PAGES`）」估計 T：`OLLAMA_TIMEOUT_MS` ≥ 2T（bench 會印出建議值，與 `perf:local` 同一條「2 × 最長」規則，進位到分）；`JOB_NODE_TIMEOUT_MS` ≥ `OLLAMA_TIMEOUT_MS`＋OCR＋OCR 整理（重錄後 `perf:local` 看得到；沒數字時先多抓 1 小時）。例：T＝1 小時 → `OLLAMA_TIMEOUT_MS=7200000`、`JOB_NODE_TIMEOUT_MS=10800000`。
- 代價一：卡住的呼叫要等到逾時才失敗，而且逾時會退避重試 3 次（上表 #4），一塊真的做不完時最壞要 4 × 節點逾時才讓整份卷 `failed`（節點 3 小時＝最壞 12 小時）。要不要改成「本機拆題逾時不重試」是另一個決定，本分支沒改。〔Owner 決策單 2026-09-26 第四輪 V3〕Owner 選「逾時只重試 1 次」（`dec/r4-decisions` 已改）：本機模式一塊真的做不完時最壞 2 × 節點逾時（Owner 的 `.env` 放寬到 2 小時後＝4 小時）。
- 代價二：一份卷在背景跑更久。4 頁卷＝2 塊 ×（OCR＋看圖＋OCR 整理）＋每題的分類、lint、驗算；拿 bench 的數字代入，看圖一步就可能要兩小時以上，整份可能要大半天。請 Owner 決定「晚上上傳、隔天看複核佇列」能不能接受，還是要搭配 (a)／(b)／(d)。
- 期間伺服器行程要一直開著、電腦不能睡眠（`JOB_RUNNER=inline` 時 worker 就在伺服器行程裡）。
- 建議同時設 `OLLAMA_PROGRESS_MS=300000`，才分得出慢還是卡住。

**(d) 有獨立顯示卡時的差別**

- Ollama 偵測到支援的 NVIDIA（CUDA）或 AMD（ROCm）顯示卡會**自動**把模型放上去，程式與 `.env` 都不必改。`ollama ps` 的 PROCESSOR 欄會寫 `100% GPU`（放不下時是「xx%/yy% CPU/GPU」）。i5-8265U 的 Intel 內顯 Ollama 預設不會用。
- 顯示卡記憶體要放得下模型與上下文（`qwen3-vl:8b` 在 6 GB 上下，`OLLAMA_NUM_CTX` 越大要越多）；只放得下一部分時，其餘層在 CPU 上跑，加速有限。
- 換了硬體之後用 bench 重量一次：逾時、每塊頁數、縮圖多半都可以回到預設。GPU 與 CPU 的數值不完全相同，之後重錄的回放檔內容可能與 CPU 錄的有細微差異（鍵不變，CI 照樣回放）。

**建議的決定順序（只是建議）**〔Owner 決策單 2026-09-26 第四輪〕已由 Owner 決定：先照 V1 放寬 `.env`、先量 1 頁（U3），見本節第 3 點的「Owner 的選擇」：① 先照 10.8 量一頁，把結果貼回來；② 讀 prompt（看圖）占大半 → 試 (b) `--max-edge 1600` 再量，題目沒變差就在 `.env` 開；③ 一塊仍超過 30 分 → (c) 依 bench 的建議同時調 `OLLAMA_TIMEOUT_MS` 與 `JOB_NODE_TIMEOUT_MS`；④ 單次呼叫仍太長、或 bench 提醒 `OLLAMA_NUM_CTX` 放不下 → (a)；⑤ 有預算換硬體 → (d)。重錄 CI 的回放檔不受這些選項影響（(b) 除外：錄的是你開著的設定），拉新版後直接 `record_local.bat pipeline,e2e` 即可。

### 10.12 classify／nlq 重錄前修正（2026-09-26，`dec/local-classify-nlq-prep`）

**為什麼現在改**：classify 已升為 `classify.v2`（CR-9、A5、K2／K3 的界線規則）、nlq 已升為 `nlq.v2`（B5 化學、`dec/x-nlq-improve`），兩者在 repo 裡**一支 cassette 都沒有**（本機、Gemini 都沒有），`eval:classify` 92 筆、`eval:nlq` llm 欄 8 句全部 replay miss。這是改模板與後處理最便宜的時機：現在改什麼都不會讓任何已錄的 cassette 失效。目標是 Owner 在自己的電腦上**只錄一次**就過門檻（`eval/thresholds.json` 不動）。

#### 1. 重現 2026-09-25 的失敗（`f77d1a3`，本機 cassette）

在另一個 worktree（`git worktree add … f77d1a3`，用完已移除）以 replay 跑兩個 suite，環境照 `ci.yml`：`LLM_MODE=replay`、`EMBED_MODE=fixture`、`MODEL_EXTRACT=ollama:qwen3-vl:8b`、`MODEL_VERIFY=ollama:qwen3:8b`（`MODEL_TEXT` 不設：本機模式自動等於 `MODEL_VERIFY`，分類的鍵才會是 `qwen3:8b`）、`EMBED_MODEL=ollama:qwen3-embedding:0.6b`、`MODEL_NLQ=ollama:qwen3:8b`；recall10 另外要測試庫（`TEST_DATABASE_URL`）。100 支 cassette 全部命中，沒有 miss。

| suite | 欄 | 指標 | 2026-09-25 本機 | 門檻 | |
|---|---|---|---:|---:|---|
| classify | — | accuracy | 0.837（77/92） | 0.87 | 未達 |
| classify | — | macro-F1 | 0.7419 | 0.8956 | 未達 |
| nlq | rules | rule_coverage／filters_exact／recall10 | 0.84／1／1 | 0.81／0.97／0.97 | 達到 |
| nlq | llm | filters_exact | 0.625（5/8） | 0.72 | 未達 |
| nlq | llm | recall10 | 0.75（6/8） | 0.845 | 未達 |

對照：同一份 golden 用 Gemini（`gemini-3.5-flash`、`classify.v1`，2026-09-24 錄的）是 79/91，**指數與對數那 8 題 Gemini 也全錯**——那一組是 v1 模板沒寫界線造成的，不只是本機模型的問題。

#### 2. 逐題歸因

類別：(a) 反斜線損壞造成；(b) 模型錯，v2 的規則／模板已處理；(c) 模型錯，v2 沒處理；(d) golden 本身有爭議；(e) 其他（逾時、格式不合）。
「v2 的依據」是 `agents/classify.js` 的 `SUBJECT_RULES`（數學 5～7、物理 5～8）或 `services/nlqService.js` 的模板與 `mergeLlm`；「程式保證」是指本分支的後處理（第 3 點）在**同一份模型回答**上就把它改對，不必賭重錄時模型有沒有照規則走。「模型回答」是 cassette 的原始 `response.data`。

**classify（15 題，全部 (b)）**

| 題號 | golden | 模型回答（信心） | v2 的依據 | 程式保證 |
|---|---|---|---|---|
| cls-fx-001、fx-002、fx-007、dr-001、dr-020 | 指數函數與對數函數 | 指數與對數（0.95） | 數學 5（A5）：底數不是 10 的對數、換底屬第三冊。題幹是 `\log_{2}`、`\log_{3}`、`\log_{5}` | 是（`exp_log_third`，證據＝底數） |
| cls-fx-003、fx-004、dr-002 | 指數函數與對數函數 | 指數與對數（0.95） | 數學 5（A5）：指數方程式屬第三冊。題幹「解方程式 $2^{x+1}=32$」「試求未知數 $x$」 | 是（`exp_log_third`，證據＝變數指數＋解／求 x） |
| cls-fx-022 | 空間向量內積 | 向量內積（0.95） | 數學 6：空間向量（三維坐標）屬第四冊。題幹 $A(1,2,2)$、$(1,0,0)$ | 是（`dimension_space`，證據＝三維坐標） |
| cls-dr-007 | 空間向量內積 | 向量內積（1，＝decoy） | 數學 6。題幹「在空間中」、$(1,2,3)$ | 是（`dimension_space`） |
| cls-fx-046 | 平面運動 | 摩擦力與向心力（0.95） | 物理 6（第 8.0 節）：圓周運動只問速率、速度方向、向心加速度的歸平面運動。理由寫「關鍵在於向心力與加速度的關係」 | **否（推定）**：選項 (D)「合力為零」是力的字眼，字面規則分不出來（決策草稿 LC-2） |
| cls-fx-050 | 直線運動 | 物體的運動（速度與加速度）（0.95） | 物理 5（第 8.0 節）：需要代入等加速度公式的歸直線運動。理由自己寫了「需應用加速度與位移的關係式」 | 是（`free_fall_computation`，證據＝自由落下＋求） |
| cls-fx-052 | 直線運動 | 平面運動（0.95） | 物理 8（K2）：一維的相對速度歸直線運動。題幹只有東、西 | 是（`relative_1d`） |
| cls-dr-008 | 直角三角形的邊角關係 | 三角函數的疊合（0.95） | 數學 7（K3）：只用到平方關係的歸第二冊。理由談的是題目裡沒有的 $\tan\theta$，而且 `\tan` 的反斜線被吃掉 | **否（推定）**（決策草稿 LC-2） |
| cls-dr-030 | 電場與電位 | 靜電學（0.95，＝decoy） | 物理 7（第 8.0 節、第 8.6 節第 5 點）：問電力線與等位面的歸電場與電位 | 是（`field_potential`，證據＝等位面） |

**nlq llm 欄（3 句錯）**

| 句 | 錯在哪（模型回答） | 類別 | v2 的依據 | 程式保證 |
|---|---|---|---|---|
| nlq-040 | 句子沒講題型，回了 `["計算"]` | (b) | `mergeLlm` 的證據檢查：句子沒有題型字眼就不採用；模板規則 4 | 是（v2 已有，本分支以原始回應逐句驗證） |
| nlq-042 | 回〔向量的加減與係數積、空間向量內積〕＋`["計算"]` | (b)，部分推定 | `alignChapterDimension`（句子寫「平面上」→ 空間向量內積換成向量內積）、證據檢查（計算）；多列的〔向量的加減與係數積〕靠模板規則 6「通常一章」與【容易混淆的章】 | 部分：換章與題型已保證，多列的一章是推定 |
| nlq-036 | 回〔直線運動〕，期望〔摩擦力與向心力、牛頓運動定律〕 | (b) 推定；另有 (d) | 模板【容易混淆的章】的力學一條（受力、合力→牛頓運動定律；斜面上的受力→摩擦力與向心力） | 否。而且 golden 要「兩章都回」，與模板規則 6「通常一章」方向相反（決策單 A3 待決，決策草稿 LC-4） |

recall10 錯的 2 句（036、042）都是章節篩錯、把相關題排除（`docs/retrieval.md` 9.1），不是檢索本身的問題。

**各類別總數**：

- (a) 反斜線損壞：**0 題**。92 支 classify 回答有 10 支的 `rationale` 帶控制字元（`\frac`→換頁、`\tan`→定位、`\bullet`→退格；錯題裡的 dr-001、dr-008 也是），但 `chapter` 欄受 schema 的 enum 約束（Ollama 以它做文法約束），一支都沒壞；nlq 8 支沒有。修補在 `dec/latex-escape-repair`（審查中，本分支沒併；它改的是 `services/llm/index.js`，與本分支的檔案不重疊）。
- (b)：classify 15 題、nlq 3 句（其中 nlq-036 另有 (d)）。
- (c)：0。
- (d)：沒有哪一題的錯是 golden 造成的。要 Owner 看的只有 nlq-036 的計分（A3，LC-4），以及 golden 裡三則還掛著「請開發者確認／裁決」的 note——cls-dr-030（等位面；第 8.0 節已裁決，標籤不必改，note 沒清）、cls-dr-018（三維向量的點積歸空間向量內積）、cls-dr-028（自由落體歸直線運動）。三題的標籤都符合現行規則，dr-018、dr-028 模型也答對。golden 本分支一個字都沒改。
- (e)：0。沒有逾時、沒有 JSON 解析失敗、沒有章名格式問題（失敗的呼叫不會留下 cassette，而 golden 每一題都有 cassette）。延遲：classify 中位數 51 秒（最早錄的那一支 518 秒，是載入模型），整段約 83 分鐘；nlq 中位數 27 秒（最早那一支 206 秒），整段約 4 分鐘。
- 另一個觀察：92 題的信心**只有 0.95 與 1 兩種值**（85 支、7 支），錯的 15 題也是 0.95～1——本機模型的信心分不出對錯。classify 模板規則 4 說「低於門檻會送人工複核」，但程式其實沒有依第二層的信心分流（`pipeline/stateMachine.js` 只看 outcome.kind）；本分支不改，記在這裡。

#### 3. 本分支改了什麼（都不必 Owner 決定）

**模板、schema、識別名一個字都沒改**（`classify.v2`、`nlq.v2` 照舊；`agents/schemas/*.json` 沒動），所以 cassette 的鍵與 `local/integration` 完全相同（`eval:classify`／`eval:nlq` 回放時印出的 miss 鍵逐字相同）；classify／nlq 相關的測試裡釘住雜湊的只有 `agentClassify.test.js` 的 `SUBJECT_RULES` 雜湊，也不受影響（其餘測試的鍵都是執行時現算）。改的是 `generateJson` **之後**的程式：

1. **相鄰兩章的界線規則**（新檔 `exam_pro/utils/chapterPostRules.js`，classify 與 nlq 共用）。題幹或查詢句裡有 Owner 書面規則寫明的證據時，把模型挑的章換成相鄰的另一章；證據不明確（兩種線索都有、或一種都沒有）就不換。每條規則只管一對章：

   | 規則 | 模型挑 → 換成 | 證據（都要在題幹裡找得到） | 出處 |
   |---|---|---|---|
   | `exp_log_third` | 指數與對數 → 指數函數與對數函數 | 底數不是 10 的 log、`\ln`；舊題搬章規則表（`config/chapterMigrationRules.js`）裡第三冊的關鍵字（指數函數、換底、指數方程式…，直接引用、不另抄）；指數或真數含未知數，而且要「解」或「求 x／x 的值」 | A5 |
   | `exp_log_first` | 指數函數與對數函數 → 指數與對數 | 首數、尾數、位數、科學記號、常用對數，而且沒有任何第三冊的證據，也沒有函數、圖形、方程式、不等式 | A5 |
   | `dimension_space`／`dimension_plane` | 向量內積 ↔ 空間向量內積、直線方程式 ↔ 空間直線方程式 | 三維／二維坐標 `(a,b,c)`／`(a,b)`；「空間」「三維」「z 軸」／「平面向量」「坐標平面」「二維」；互相矛盾時不換。題幹的「平面上」不算（空間單元常寫「直線在平面上」） | 數學 6、章名本身 |
   | `field_potential` | 靜電學 → 電場與電位 | 等位面、等位線、電力線、電場線、電位差、電位能、作功；有「庫侖」就不換 | 第 8.0 節第一條、第 8.6 節第 5 點 |
   | `coulomb` | 電場與電位 → 靜電學 | 有「庫侖」，而且沒有電場、電位與上一列的字 | 第 8.0 節第一條 |
   | `relative_1d`／`relative_2d` | 平面運動 ↔ 直線運動 | 「相對」＋方向字只在一條水平軸（只有東西、或只有南北），或同向／反向／迎面 → 一維；兩條軸以上、夾角／分量／偏、渡河／雨滴／水流 → 二維；只有上下一條軸不判斷 | K2 |
   | `free_fall_computation` | 物體的運動（速度與加速度）→ 直線運動 | 自由落體、上拋／下拋，題幹有數字，而且要求數值（求、多少、多久、幾秒…） | 第 8.0 節第三條 |

   刻意**不寫**的：圓周運動的運動學／受力、K3 的平方關係／疊合、必修運動學／直線運動的一般情形——這幾組要看「解題要不要求力、要不要代公式」，字面線索不可靠，留給模板規則與模型（LC-2）。
2. **classify 的接線**（`agents/classify.js` 的 `postProcessChapter`）：只套在第二層（`source='llm'`）；零成本閘門與 kNN 投票不套（kNN 的票來自人工標籤；閘門見 LC-3）。換過章的題，`outcome.data` 多一個 `adjustments`（規則、原本的章、證據），`rationale` 前面加一句「〔界線規則：模型選「…」，依題幹的「…」改為「…」〕」，複核的人才看得懂為什麼理由寫的是另一章。沒換的題 `outcome.data` 與改版前逐鍵相同；信心照模型給的。
3. **nlq 的接線**（`services/nlqService.js` 的 `mergeLlm`，帶原句時）：在平面／空間對齊之後再套同一張規則表（平面／空間那兩條略過，nlq 有自己的 `alignChapterDimension`）；換過去的那一章模型已經列了就不換。調整記在 `adjustments`（不進 200 回應的凍結形狀）。
4. **名稱容錯**（qwen3 常見格式問題的防線）：模型回的章名與白名單只差空白、「」引號、全形／半形（NFKC）或開頭多了「第三冊」時，對回白名單那一章（恰好一章才對；對不到照舊 `chapter_invalid`，feedback 用模型原字）；nlq 的題型「計算題」「填充」照規則層的 `TYPE_ALIASES` 對回白名單。2026-09-25 的 100 支本機回答**一支都不需要**它（Ollama 與 Gemini 都以 enum 約束）；這是給 Gemini 拆掉 enum 的退路（`schemaFallback`）與不支援文法約束的模型用的。
5. **eval 報表**：`eval:classify` 多一行「程式後處理改了 N 題的章（改完與 golden 相同 M 題）」並在逐題表列出規則；`eval:nlq` 的逐句多 `adjustments`。重錄後看得出分數有多少是程式補的、多少是模型自己答對的。
6. **回歸資料與工具**：`exam_pro/eval/fixtures/local_raw_2026-09-25.json`（`f77d1a3` 那 100 支 cassette 的 `response.data` 逐字照抄；cassette 本身不動、不搬，之後被 `cassettes:prune` 刪掉也還在）；`test/unit/localV1Regression.test.js` 逐題釘住下面第 4 點的結果；`node eval/tools/local_v1_counterfactual.js`（`--no-post` 重現 0.837／0.7419、`--raw-merge` 另印 nlq 的舊合併；設了 `TEST_DATABASE_URL` 會量 recall10）。規則的正反例與「不誤觸」檢查在 `test/unit/chapterPostRules.test.js`：知識點的名稱與說明、各章例句、fixture 62 題、classify golden 92 題裡屬於規則 from 那一章的文字，規則一律不得觸發。

#### 4. 預期重錄後的改善（反事實量測，不是重錄後的分數）

把「模型的回答」固定成 2026-09-25 的原始回應、其餘全用現行程式跑（`local_v1_counterfactual.js`）：

| suite | 指標 | 2026-09-25 | 同一份回答＋現行程式 | 門檻 |
|---|---|---:|---:|---:|
| classify | accuracy | 0.837 | **0.9783**（90/92） | 0.87 |
| classify | macro-F1 | 0.7419 | **0.908** | 0.8956 |
| nlq llm | filters_exact | 0.625 | **0.75**（6/8） | 0.72 |
| nlq llm | recall10 | 0.75 | **0.875**（7/8） | 0.845 |

- classify 改對的 13 題全是程式規則（每題的規則見第 2 點），原本答對的 77 題一題都沒被改錯。剩 cls-fx-046、cls-dr-008 兩題只能靠 v2 模板規則（物理 6、數學 7）讓模型自己改。**推定**會改善的依據：v1 模板完全沒有這兩組界線；Gemini 用 v1 就答對了這兩題。反面的依據：物理相鄰章的對錯在兩個模型之間並不一致（Gemini 錯、qwen3 對的有 cls-fx-041、fx-047、fx-048、dr-013），重錄後可能此消彼長。
- nlq 的 040 改對、042 改對一半，都是 `dec/x-nlq-improve` 已在 v2 的伺服器端檢查（本分支只是用原始回應逐句驗證）；本分支的界線規則在這 8 句上沒有觸發（它們的錯不屬於那幾組）。重錄後若模型把 nlq-040 回成第三冊、nlq-039 回成靜電學，會被 `exp_log_first`／`field_potential` 改回來。
- 重錄時間：classify 送出的文字從 4,079／2,604 字（數學／物理，含 SYSTEM）變成 4,418／2,946 字（多 8～13%），nlq 從 1,003 字變成 2,800 字（`nlq.v2` 的規則、範例與三科白名單；兩者都不含 Ollama 附加的欄位說明）。以 2026-09-25 的實測粗估：classify 約 1.5 小時、nlq 約 5～10 分鐘。

#### 5. 還剩什麼風險

1. **餘裕很小**。classify 的 macro-F1 只算 golden 裡出現的 13 章，有幾章只有 1～3 題：反事實 0.908 對門檻 0.8956，重錄後多錯 1 題「題數很少的章」就可能掉到門檻下。nlq 的 llm 欄只有 8 句，filters_exact 0.75 對 0.72、recall10 0.875 對 0.845，**各只有一句的餘裕**。
2. **模板變了，原本答對的題可能變錯**。反事實量測假設模型回答不變，但 v2 的界線規則、例句與 nlq 的範例都會改變回答。界線規則有反方向的保護（`exp_log_first`、`dimension_plane`、`coulomb`、`relative_2d`），但只在證據明確時才生效。
3. **規則是看著這 15 題寫的**。證據字照錯題的型態挑，同一批題上的改善（13/15）會高估對新題的效果；已用知識點、例句、fixture 做「不誤觸」檢查，但正式題庫的寫法更雜。規則也會改變**正式上傳**時第二層的分類結果（改過的題在 `payload.classify.adjustments` 查得到）。
4. **零成本閘門沒有套**：拆題模型（qwen3-vl）給的高信心章節不經第二層，相鄰章的錯照樣入庫（LC-3）。classify suite 刻意跳過閘門，量不到這一塊。
5. **信心沒有鑑別力**：本機模型幾乎只給 0.95 與 1，「信心低就送人工」這條路在本機模式等於不存在（第 2 點最後）。
6. **nlq-036** 的計分與模板規則 6 互相拉扯（LC-4），重錄後這一句很可能仍算錯，吃掉 nlq llm 欄唯一的一句餘裕。
7. **反斜線損壞**：`dec/latex-escape-repair` 還在審查。不影響這兩個 suite 的分數（只壞在 classify 的 `rationale`），但沒併之前，複核頁看到的分類理由仍會有「rac」「an」這種殘字。
8. 圓周運動與 K3 兩題（cls-fx-046、cls-dr-008）只能靠模型（LC-1、LC-2）。

#### 6. 決策草稿（請 Owner 決定；本分支都沒有做）

每一題都可以單獨看；「建議」只是建議。

**LC-1　分類時要不要讓模型「先寫理由、再定章節」**

背景：分類模型輸出的 JSON 欄位順序是「章節 → 信心 → 理由」，本機的 qwen3:8b 又沒有開思考，等於先下結論、再補理由。2026-09-25 錯的 15 題裡，有的理由其實寫對了方向（自由落體題寫「需應用加速度與位移的關係式」，照 Owner 的規則該歸直線運動，章節卻填了必修的「物體的運動」）。本分支已用程式規則補上其中 13 題；剩下的圓周運動（運動學／受力）與三角（平方關係／疊合）兩類，只能靠模型照 prompt 裡的規則判斷。問題：重錄前要不要改變輸出方式，讓模型先寫理由再選章？

| 選項 | 代價 |
|---|---|
| 1. 不改（現狀） | 圓周運動、三角這兩類與以後的新題仍是「先猜章」；這兩題若重錄後仍錯，macro-F1 會停在門檻邊緣（反事實 0.908，門檻 0.8956） |
| 2. **（建議）** 把 `agents/schemas/classify.json` 的欄位順序改成「理由 → 章節 → 信心」 | 這份 schema 化學分類（`classify_chem.v1`）也在用，化學分類的 cassette 鍵會跟著變（repo 裡目前沒有化學分類的 cassette；Owner 私有層若有，要重錄）；Gemini 模式的輸出順序也跟著變；輸出的 token 數大致不變、時間幾乎不變；有沒有效要重錄才知道 |
| 3. 分類時開 qwen3 的思考模式 | 每題多輸出數百到上千個 token，以這台電腦每秒約 3 個 token 估，每題多 2～5 分鐘：92 題重錄多 3～8 小時，正式上傳時每題分類也一樣變慢 |

建議選 2：不增加時間，只動一行 schema 與對應測試（仍在還沒錄過的 `classify.v2` 內，不必升版），直接處理「先下結論」的問題；化學分類目前沒有 cassette，換鍵的實際代價是零。選 3 效果可能更好，但這台電腦上的時間成本太高。

**LC-2　物理「圓周運動」與三角「平方關係」要不要也加程式規則或送人工**

背景：分類的程式規則只收「題幹裡看得到明確證據」的界線（對數的底數、坐標維度、等位面、一維相對速度、自由落體數值題）。另外兩組 Owner 已定的界線要理解題意才分得出來：①圓周運動只問速率、速度方向、向心加速度（平面運動）vs 需要求向心力、張力、摩擦力（摩擦力與向心力）；②只用到銳角的平方、商數、餘角關係（直角三角形的邊角關係）vs 要化成 r sin(x＋φ)（三角函數的疊合）。2026-09-25 這兩組各錯 1 題，模型給的信心都是 0.95。問題：這兩類要怎麼處理？

| 選項 | 代價 |
|---|---|
| 1. **（建議）** 不加，交給模板規則與模型（現狀） | 重錄後若仍錯，classify 的 macro-F1 可能在門檻下；正式使用時這兩類的錯章直接入庫 |
| 2. 加關鍵字規則直接改章 | 這兩組看的是「要不要求力」「要不要疊合」，字面線索不可靠（例：選項出現「合力為零」的圓周運動觀念題其實是運動學）；改錯的題會安靜地入庫；規則是看著這 2 題寫的，對新題的效果未知 |
| 3. 加「送人工」：題幹同時有兩章的線索時，分類回失敗、該題停在複核佇列 | 要新增一種複核原因（或沿用 chapter_invalid），狀態機與複核頁要跟著改；複核量增加；eval 裡這類題算成「沒有章節」＝錯，救不了分數 |

建議選 1：字面規則在這兩組的誤判風險高於它能救的題數；送人工要動狀態機與複核頁，又救不了 eval。先重錄，看模板規則在這兩類有沒有效，再決定。

**LC-3　程式界線規則要不要也套在「零成本閘門」**

背景：分類分兩層。拆題模型給的章節在白名單內、而且信心 ≥ 0.8 時直接採用（零成本閘門，不呼叫分類模型）；否則才由分類模型判斷（第二層）。本分支的程式界線規則（指數／對數分冊、平面／空間、靜電學／電場與電位、一維相對速度、自由落體數值題）只套在第二層。本機的拆題模型（qwen3-vl:8b）一樣可能把 log₂ 的題標成第一冊，而且信心通常很高，會直接從閘門通過。問題：要不要把同一套規則也套在閘門上？

| 選項 | 代價 |
|---|---|
| 1. 只套第二層（現狀） | 拆題模型的相鄰章錯誤照樣入庫；classify 的 eval 量不到這一塊（它刻意跳過閘門） |
| 2. **（建議）** 閘門也套：規則判定為另一章時直接改章（仍記為閘門通過，附上 adjustments） | 正式入庫結果多一個會被程式改動的地方；pipeline eval 與 e2e 的結果可能跟著變（要重跑確認；不影響 cassette 的鍵，不必重錄） |
| 3. 閘門遇到規則衝突就不直接通過，改走第二層分類模型（之後再套規則） | 衝突的題多一次分類呼叫（本機每題約 50 秒）；pipeline 的 classify cassette 要多錄這幾題 |

建議選 2：規則只看題幹，與章節是哪個模型猜的無關；選 3 最後得到的章節與選 2 相同（規則會把第二層的答案再改一次），卻多花一次呼叫與錄製。kNN 投票（人工標籤多數決）維持不套用。

**LC-4　nlq-036「斜面上物體受力平衡的題目」怎麼計分（決策單 A3 的後續）**

背景：這一句的 golden 期望章是〔摩擦力與向心力、牛頓運動定律〕兩章（2026-09-25 以「放寬」從一章改成兩章），但計分（`filters_exact`）要求「兩章都回、而且只回這兩章」才算對。`nlq.v2` 的模板規則 6 要模型「通常只回一章」（為了修 nlq-042 多列一章），兩者方向相反：模型只回〔摩擦力與向心力〕時檢索找得到相關題，這一句仍算錯。自然語言查題的 LLM 欄只有 8 句、門檻 0.72，一句就是 0.125。問題：重錄後這一句怎麼計分？

| 選項 | 代價 |
|---|---|
| 1. 維持（兩章全對才算） | 這一句大概率算錯，LLM 欄只剩一句的餘裕（反事實 6/8＝0.75） |
| 2. golden 改回單一章〔摩擦力與向心力〕 | 推翻 2026-09-25 的放寬；回〔牛頓運動定律〕或兩章都回的答案都算錯 |
| 3. **（建議）** 期望章有兩章以上的句子，改成「回的章都在期望內、至少一章」就算對（改 `eval/lib/suiteNlq.js` 的 `filtersExact`；目前只影響 nlq-036） | 計分規則改變，要在 `thresholds.json` 旁註明；以後新增多章期望的句子也照這個規則 |

建議選 3：最符合當初「放寬」的本意（兩章都是合理答案），也與模板規則 6 一致；不必改 golden 的期望章、不必重錄。A3 原本說「重錄完看分數再決定」，也可以先重錄、看這一句的實際回答再選。

#### 7. 重錄後怎麼看

照 10.7 重錄 classify 與 nlq（`record_local.bat classify,nlq`）之後：

- `npm run eval:classify`：看 accuracy／macro-F1，以及「程式後處理改了 N 題的章」那一行——N 很大表示模型仍常挑到相鄰章，分數主要是程式補的；逐題的規則在報表的逐題表。
- `npm run eval:nlq`：llm 欄的逐句 `adjustments`（哪幾句被證據檢查、平面／空間、界線規則動過）。
- 兩個 suite 若只差一題未達，先看是不是 LC-2、LC-4 那幾題，再回來決定 LC-1～LC-4。
