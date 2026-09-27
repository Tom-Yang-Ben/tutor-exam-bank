# 本機模式（Local-first）契約與使用說明

> 版本 1.0（2026-09-25，主控凍結）。分支 `local/base`，基底是 `stage5/chapters`（522f81c）。
> 本檔是 L1～L4 四條平行工作的**凍結介面**。各 WS 發現契約有問題，寫在自己的回報裡，不要自行改契約；由主控裁決，登錄在第 9 條（LM-n）。
> 〔修訂 2026-09-26 決策單〕依 Owner 2026-09-25「出題系統決策單」第一輪答覆，在第 6 條第 3 點、LM-12、LM-14、10.5、10.7 就地加註（A7：門檻不動、未達就紅燈；C：刪 Gemini cassette 暫緩；B18、B21）；總表見 [`HANDOFF.md`](HANDOFF.md) §0.00。
> 〔2026-09-26 `dec/local-vision-timeout`〕Owner 實機重錄時看圖拆題一塊超過 30 分而逾時：10.5、10.8、10.9、10.10 就地加註，新增 10.11（逾時清單、進度、`npm run local:bench-vision`、加速選項）。第 0～9 條沒有改。
> 〔2026-09-26 `dec/local-classify-nlq-prep`〕classify／nlq 重錄前修正：新增 10.15（原編 10.12，整合時改號；重現 2026-09-25 的失敗、逐題歸因、章節的程式後處理、決策草稿 LC-1～LC-4）。其餘各條沒有改。2026-09-27 依審查意見修正（`dec/local-classify-nlq-prep-fix`）：`exp_log_third` 不再把首數、尾數、位數的第一冊題改成第三冊；10.15 註明 nlq 的改善來自既有的證據檢查；LC-3、LC-4 的措辭與代價更正。
> 〔Owner 決策單 2026-09-26 第四輪〕依 Owner 2026-09-26「上線與本機速度決策單」答覆（分支 `dec/r4-decisions`）：第 2 條的表、LM-12、10.7 第 9 點、10.11 的逾時表（#4、#6）、加速選項表與 (a)(c) 的細節就地加註（V1～V5）；程式改了兩處（V3 本機拆題逾時只重試 1 次、V4 舊流程 `/analyze-pdf` 本機預設每塊 2 頁），其餘預設值不變。總表見 [`HANDOFF.md`](HANDOFF.md) §0.00b。
> 〔OCR 為主 2026-09-26〕Owner 實測看圖拆題 1 頁 54 分鐘後，決定這台電腦的拆題改成「OCR 為主」（分支 `dec/local-ocr-first`）：新增設定 `LOCAL_EXTRACT_MODE`（`cross` 預設＝第 4 條原本的交叉驗證，一個字都沒改；`ocr`＝只用 PaddleOCR＋文字模型）、複核原因 `ocr_only`（migration 0019）、依 OCR 版面配附圖；CI 與重錄改照 `ocr`。說明全部在 **10.12**；第 0～9 條沒有改（第 0 條「交叉驗證」與第 4 條仍是 `cross` 模式的契約，`ocr` 模式是它旁邊多的一條路，建議主控另登 LM 條目）。
> 〔Owner 第五輪 D-3 核准 2026-09-27，`dec/r6-defaults`〕`LOCAL_EXTRACT_MODE` 的**程式預設改成 `ocr`**（只在拆題模型是 ollama 時有作用；Gemini 不受影響），要交叉驗證的在 `.env` 明寫 `cross`。第 0 條「交叉驗證」與第 4 條從此是「明寫 `cross`」時的契約，內容一個字都沒改；本機模式沒寫這一行時走 10.12 的 `ocr`。見 **10.19**。
> 〔2026-09-26 `dec/local-embed-thresholds`〕V5 的分析：新增 10.13（原編 10.12，整合時改號；三個餘弦門檻依本機向量的分布、選項與建議，**待 Owner 核准，未改任何門檻**）、`npm run embed:thresholds`；10.7 第 9 點加一句指過去。第 0～9 條沒有改。
> 〔2026-09-26 `dec/local-thinking-speed`〕新增 10.14（原編 10.12，整合時改號；拆題以外的時間花在哪裡、加速選項 a～e，**待 Owner 決定，預設未改**）：可選設定 `OLLAMA_NO_THINK`、`OLLAMA_MAX_OUTPUT_<AGENT>`、`OLLAMA_NUM_CTX_<AGENT>`（都不寫＝與之前逐位元相同）、`npm run local:bench-text`、`npm run perf:local` 第 1.2～1.5、4 段。第 0～9 條沒有改。
> 〔2026-09-26 `dec/local-thinking-speed-fix`，審查修正〕10.14 的「冷的讀 prompt 約 17 token/秒」其實是部分快取，改用只推冷呼叫的方法（約 8 token/秒）並重算受影響的估計；「分類的快取每題被擠掉」改成條件句（回放檔顯示 Ollama 至少留著 3 份快取）；公式反斜線的支數改稱「至少」；驗算不一致不重跑的建議改成先收集資料。`perf:local` 加第 1.5 段的公式閘門統計、第 1.6 段溫度 0 的重現性、`--backfill`；`report:jobs` 加「answer_mismatch 之後原地重跑的結果」；啟動時印出生效的本機調整、名稱寫錯時警告。10.5 的逐題步驟一併更正。
> 〔整合 2026-09-26 `dec/integration-r5`〕三條分支（`dec/local-ocr-first-fix`、`dec/local-embed-thresholds-fix`、`dec/local-thinking-speed-fix`）各自新增了「10.12」。依併入順序保留全部內容、重新編號：**10.12** 只用 OCR 拆題、**10.13** 三個餘弦門檻、**10.14** 拆題以外的時間與加速選項；程式註解、測試、其他文件裡指到這三節的地方一併改號。三節裡「待 Owner 決定」的事項另有一份總表：[`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md)。
> 〔整合審查 2026-09-27 `dec/integration-r5-fix`〕10.12 第 6 點補一條：OCR 整理的 num_ctx 預算與截斷判斷改用實際送出的值，認得 10.14 的 `OLLAMA_NUM_CTX_EXTRACT_OCR`、`OLLAMA_MAX_OUTPUT_EXTRACT_OCR`（兩條分支各自沒錯、合在一起才對不上）。之後併 `dec/local-classify-nlq-prep-fix` 時，它的「10.12 classify／nlq 重錄前修正」要改號為 **10.15**。
> 〔整合 2026-09-27 `dec/integration-final5`〕`dec/integration-r5-fix`（`ed93665`）依序併入 `dec/local-classify-nlq-prep-fix`、`dec/latex-escape-repair-fix`、`dec/phys-spoken-reviewed`、`dec/cleanup-exam-legacy`。只有第一條新增了一節（原編 10.12），依併入順序改號為 **10.15**（classify／nlq 重錄前修正）；它的程式註解、eval 訊息、fixture 說明與測試一併改號，`test/unit/localModeSections.test.js` 加入 10.15。其餘三條沒有新增節：LaTeX 修復的說明在 [`llm.md`](llm.md) 第 10 節與 10.8 疑難排解一列，舊版原型移除只在 10.4、10.7 就地加註。10.13、10.14、10.15 裡寫「`dec/latex-escape-repair` 還沒併／在做」的地方就地加註，原文保留。
> 〔Owner 第五輪 2026-09-27 `dec/r6-templates`〕依第五輪決策單 LC-1＝2、L-2＝1、V5-6＝2 改分類 schema 的欄位順序、公式規範與變式 prompt：新增 10.16「第五輪 A 模板與 schema」（節號暫編），10.13 的 V5-6、10.15 的 LC-1 就地加註。
> 〔整合 2026-09-27 `dec/integration-r6`〕`local/integration-r5`（`a670783`）依序以 `--no-ff` 併入第五輪五組：`dec/r6-templates-fix`（A）、`dec/r6-local-tuning-fix`（B）、`dec/r6-gates-fix`（C）、`dec/r6-defaults-fix`（D）、`dec/r6-docs-kc-fix`（E）。五組各自暫編的「10.16」依併入順序改號為 **10.16（A 模板與 schema）、10.17（B 本機呼叫調整）、10.18（C 閘門與計分）、10.19（D 預設值與門檻）、10.20（E 文件與知識點）**，交互參照（文件、程式註解、測試）一併改號；新增最後一節 **10.21 重錄計畫**（Owner 電腦要依序跑的重錄步驟）。

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
| LM-9 | 契約外仍寫死 Gemini 的地方 | 全部改讀 `config/models.js`：`scripts/backfill_embeddings.js`（EMBED_MODEL）、`eval/lib/pipelineDriver.js`（extract、ocrStructure、一塊頁數與 runner 同規則）、`workers/jobRunner.js`（估價用 `parseModel().id`，`ollama:qwen3:8b` 不再被截成 `8b`；模組缺失時的退路字面值）。刻意不改：`services/legacy/analyzePdf.js`（凍結快照）、`scripts/spike_genai.js`、舊版 `exam/`。〔2026-09-27 `dec/cleanup-exam-legacy`〕舊版 `exam/` 已從主線移除，原始碼保留在 tag [`v1-mysql`](https://github.com/Tom-Yang-Ben/tutor-exam-bank/tree/v1-mysql/exam)，這一項已不適用 |
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
- **CI 讀哪一組回放檔不看 `.env`**，看 `.github/workflows/ci.yml` 的 `MODEL_EXTRACT`／`MODEL_VERIFY`／`EMBED_MODEL`／`MODEL_NLQ`。要讓 CI 也回到 Gemini，改那四行並用 Gemini 重錄（會花錢）；~~舊的 Gemini 回放檔若還沒被 `cassettes:prune` 刪掉，可以直接沿用（見 10.7）。~~
  〔修訂 2026-09-27 `dec/cleanup-exam-legacy`〕**舊的 Gemini 回放檔大多已經不能直接沿用**。2026-09-27 以 `eval/lib/cassetteAudit.js` 的 `auditKeys`（用現在的模板與 schema 重算每支 cassette 的鍵）對 `889d18f` 盤點，並用上面這組 Gemini 設定、CI 的回放模式（`LLM_MODE=replay`、`EMBED_MODE=fixture`）把五個 eval 各跑一次，結果如下（Gemini 回放檔一支都沒刪，照決策單 C 暫緩）：

  | 回放檔（Gemini） | 鍵還有效 | 切回 Gemini 時 | 原因 |
  |---|---|---|---|
  | `classify`（`classify.v1`） | 0／181 | **要重錄**：classify suite 92 筆全部 replay miss | 模板已升 `classify.v2`（本機錄的 `classify.v1` 92 支也一樣失效） |
  | `nlq`（`nlq.v1`） | 0／16 | **要重錄**：nlq 的 LLM 路徑 8 句全部 replay miss；規則路徑不呼叫 LLM，不受影響 | 模板已升 `nlq.v2`（本機錄的 8 支也一樣失效） |
  | `variant`（`variant.v1`） | 0／87 | **要重錄** | 這批最晚一支錄於 2026-09-24 22:05（UTC），早於 `522f81c`（章節白名單依冊別分組），鍵已對不上；本機 9/25 錄的 60 支有效 |
  | `extract`（`extract.v2`） | 0／1 | **要重錄**：pipeline 的 extract 一開始就 replay miss，e2e 用同一份樣卷、同一組呼叫 | 2026-09-15 錄的，之後模板或 schema 改過 |
  | `verify`（`verify.v1`） | 58／58 | 鍵有效，但實際讀不讀得到要看上游：題幹來自 extract（pipeline／e2e）或出變式（variant），上游重錄後題幹只要差一個字就是新鍵 | — |
  | `lint`（`lint.v2`） | 1／1 | 同 verify | — 〔Owner 2026-09-27 O-5 選 2，`dec/r6-lint-v3`〕模板已升 `lint.v3`，這 1 支的鍵也失效（0／1），切回 Gemini 時跟著 pipeline／variant 重錄 |
  | 向量檔 `embeddings.gemini-embedding-001.768.json` | 62 題缺 5 題（id 51、53、54、55、62） | **要補向量**：retrieval 與 variant 在第一步就停，nlq 的 `recall10` 是 n/a；`npm run cassettes:rerecord` 的第一步（`eval/record_embeddings.js --only-missing`）只補缺的、只呼叫 embedding，費用很小 | 向量檔以 `embed_text` 的雜湊當鍵：#62 是 `49256a0` 新增的干擾題，#51、#53、#54、#55 在同一個 commit 改了章（章名在 `embed_text` 裡），檔裡沒有這 5 段新文字的 Gemini 向量 |

  所以切回 Gemini 後要用 Gemini 做的是：補 5 題向量，重錄 classify、nlq、variant、pipeline＋e2e，也就是 `npm run cassettes:rerecord` 的全部步驟。還能用的只有 verify、lint 那 59 支的鍵，但 `LLM_MODE=record` 每一次呼叫都會真的打模型、同鍵覆寫（`services/llm/index.js`），重錄 pipeline 時它們還是會被重新呼叫，**省不到錢**。要估費用，先把 `ci.yml` 那四行改成 Gemini，再跑 `npm run cassettes:rerecord -- --dry-run` 看盤點。這張表是 2026-09-27 的快照，之後再改模板或 schema 就會變；重算方法：在 `exam_pro/` 執行 `node -e "const a=require('./eval/lib/cassetteAudit');for(const e of a.auditKeys(a.inventory().entries))console.log(e.keyValid?'有效':'失效',e.agent,e.model,e.template)"`。

### 10.5 預期速度與品質

**速度（粗估，未實測；依 i5-8265U、8B Q4 模型「每秒約 3 個字生成、15 個字讀 prompt」推算）**：

| 動作 | 粗估 |
|---|---|
| PaddleOCR 辨識一塊（2 頁，含公式） | 2～5 分鐘 |
| 視覺模型拆一塊（2 頁） | ~~15～30 分鐘~~ **Owner 實機超過 30 分鐘**（2026-09-26 重錄時被 `OLLAMA_TIMEOUT_MS` 的 30 分切掉）；一頁實際多久用 `npm run local:bench-vision` 量（10.8、10.11） |
| OCR 結果整理成題目 | 10～20 分鐘〔10.14 以實測速度估：一塊（2 頁）約 15 分〕 |
| 每一題的分類／lint／驗算 | 各幾分鐘；驗算開思考，最久。三者都用 `qwen3:8b`（LM-15），拆完題之後不必再換載模型。〔2026-09-26 實測，10.14；審查修正〕分類 51 秒（前綴快取是熱的、few-shot 同一科每題相同）～約 7 分（整段 prompt 都冷；`FEATURE_SIMILAR` 開、前綴熱時約 4～5 分）；lint 只有規則修不好的題（約 10%～20%）才呼叫 LLM，一次 8～10 分；驗算每題 3～6 分；一份 10 題卷的這三步合計約 41 分～3 小時（原本寫「3 分半」「2 小時 25 分」是把部分快取的讀速當成冷的，低估了） |
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
6. `npm run cassettes:prune` 會把原本 Gemini 錄的回放檔列為「CI 不再讀到」。**還想保留讓 CI 切回 Gemini 的可能，就先不要 `--apply`**（刪掉之後要切回就得再用 Gemini 重錄、花錢）；確定不回頭再刪。〔修訂 2026-09-27〕保留下來的 Gemini 回放檔大多已經讀不到（見 10.4 的表）：就算不刪，切回 Gemini 也還是要重錄 classify、nlq、variant、pipeline＋e2e，並補 5 題向量。刪不刪由 Owner 決定（決策單 C 暫緩）。
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

   每行是一個藍本與「最近、第 2 近」的餘弦；第 2 個數字 ≥ 門檻的藍本才算覆蓋。要不要依本機向量重新校準 `VARIANT_RETRIEVE_SIM_MIN`（以及跑題的 `VARIANT_OFFTOPIC_SIM_MIN` 0.90、去重的 `DEDUP_DUP_THRESHOLD` 0.97，同樣是照 Gemini 定的）由 Owner 裁決。〔Owner 決策單 2026-09-26 第四輪 V5〕Owner 選 1：要重新校準——重錄之後用本機向量跑分布分析，提出三個門檻的新值與依據，Owner 核准後才改；**這次不改任何門檻**（`.env.example`、程式預設、`eval/thresholds.json` 都不動）。〔2026-09-26 `dec/local-embed-thresholds`〕分析與選項見 **10.13**（上面那行 `node -e` 換成 `npm run embed:thresholds`，一次列完三個門檻要看的數字）。

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
| 題幹裡的公式少了一截（`rac{1}{2}`、` imes`、`ullet`），或 variant 回放報二、三十次「embedding fixture 查無此文本」 | 模型在 JSON 裡的 LaTeX 只寫一個反斜線，`\frac` 的 `\f`、`\times` 的 `\t` 被當成控制字元。`dec/latex-escape-repair` 起 `services/llm` 在交給 agent 之前補回去（回放也補）；在那之前錄的向量與下游 cassette 是對著壞字串錄的，題幹修好後對不上 | 不必改設定。要讓 variant 的 eval 重新量得到：`scripts\windows\record_local.bat variant` 整步重錄（只補向量不夠）。規則、救不回來的情形與實測數字見 [`docs/llm.md`](llm.md) 第 10 節 |
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

### 10.12 只用 OCR 拆題（`LOCAL_EXTRACT_MODE=ocr`；2026-09-26 Owner 選「OCR 為主」，`dec/local-ocr-first`）

**發生了什麼**：Owner 的電腦（純 CPU、只有內顯、16 GB）量了看圖拆題：`qwen3-vl:8b` 看 1 頁 200 DPI 的樣卷，載入 1 分 18 秒、讀 prompt（6,248 token）23 分 32 秒、輸出（1,786 token）28 分 40 秒（約每秒 1 個 token），**共 54 分鐘，而且輸出的 JSON 不合法**。對照：文字模型 `qwen3:8b` 輸出約每秒 2 個 token（verify、lint 的回放檔實測），PaddleOCR PP-StructureV3 整份樣卷（1 頁）約 4 分鐘（含載入）。一份 4 頁卷光看圖就要 3.5 小時以上。**Owner 決定：這台電腦的拆題改成 OCR 為主**——不看圖，只用 PaddleOCR 加文字模型整理；接受代價：沒有兩條路可以互相比對，所以**每一題都要人工確認**；附圖位置抓不到的另外補圖（B20 的舊題補附圖工具 `figures:backfill`）。

#### 1. 兩種模式

| | `cross`（第 4 條的交叉驗證；〔Owner 第五輪 D-3〕要明寫，原本是程式預設） | `ocr`（Owner 的電腦用這個；〔Owner 第五輪 D-3 2026-09-27〕程式預設，10.19） |
|---|---|---|
| 一塊（2 頁）做什麼 | PaddleOCR → 看圖模型拆一次 → 文字模型整理 OCR 拆一次 → 兩版逐題比對 | PaddleOCR → 文字模型整理 OCR（`extract_ocr`），**不呼叫看圖模型、不轉圖** |
| 用到的模型 | `qwen3-vl:8b`＋`qwen3:8b` | 只有 `qwen3:8b`（拆題這一步用不到 `qwen3-vl:8b`） |
| 題目最後停在哪 | 兩版一致的題照常入庫；不一致或只有一版的停在 `extract_disagree`（「拆題交叉驗證不一致」） | **每一題**走完分類、lint、原卷比對、驗算、去重之後都停在 `ocr_only`（「只用 OCR 拆題」），一題都不自動入庫；更嚴重的原因先發生時以那個原因為準（與 `extract_disagree` 相同） |
| 每題的 `cross_check` | `agree`／`disagree`／`vision_only`／`ocr_only`，採用哪一版 | 固定 `{ status:'ocr_only', similarity:null, alt_question_text:null, picked:'ocr' }`（沿用同一個形狀），另帶 `extract_mode:'ocr'` |
| 附圖 | 看圖模型回報的框 | 依 PaddleOCR 的版面位置配（下面第 4 點）；配不到的題標「疑似有圖未配到」 |
| 預估時間（4 頁卷的拆題這一步） | 看圖 ≥ 3.5 小時＋OCR＋OCR 整理 | 約 1～1.5 小時（第 5 點） |

`extract_ocr` 的請求在兩種模式下**逐位元相同**（同一個模板、模型、輸出上限、回放檔的鍵），所以兩種模式讀同一支回放檔；`cross` 模式的程式一個字都沒改。Gemini 模式（`MODEL_EXTRACT=gemini:…`）完全不讀這個設定。

#### 2. 怎麼切換（Owner 要做的）

1. 更新程式後**先 `npm run migrate`**（到 `0019_ocr_only_review.sql`：複核原因多一個 `ocr_only`）。沒套 0019 就開 `ocr` 模式時，工作佇列**暫停、不認領任何工作**（上傳的卷會排隊、不會開始拆題），伺服器視窗印一次「……請在 exam_pro 執行 npm run migrate」；套完之後下一輪就自己恢復，不必重啟。〔審查 2026-09-26〕以前是每一題走到最後寫複核原因時被資料庫擋下、每輪重試、每次多一筆事件與一行錯誤，沒有上限（`workers/jobRunner.js` 的 `ocrOnlySchemaProblem`，查的是約束本身）。
2. `exam_pro\.env` 加一行（`.env.example` 已經寫好）：

   ```dotenv
   LOCAL_EXTRACT_MODE=ocr
   ```

   〔Owner 第五輪 D-3 2026-09-27〕程式預設已改成 `ocr`，Owner 的 `.env` 沒有這一行也走 `ocr`；寫上去（與 `.env.example` 一致）也沒關係。
   `OCR_ENGINE` 不要寫 `none`（不寫＝`paddle`）；`JOB_PDF_CHUNK_PAGES` 照舊不寫（本機 2 頁）；V1 放寬的 `OLLAMA_TIMEOUT_MS=5400000`、`JOB_NODE_TIMEOUT_MS=7200000` 留著（`ocr` 模式一塊約 35～45 分，綽綽有餘）。
3. 重啟伺服器（`npm start`）。之後上傳的卷就走 `ocr`；已經在跑的 job 不受影響（模式是每一塊拆題時讀的）。
4. 要改回交叉驗證：~~刪掉那一行（或寫 `cross`）~~〔Owner 第五輪 D-3〕把那一行改成 `LOCAL_EXTRACT_MODE=cross`（刪掉會回到預設 `ocr`），重啟。

**矛盾設定**：`LOCAL_EXTRACT_MODE=ocr` 與 `OCR_ENGINE=none` 同時寫，伺服器（與 `node workers/jobRunner.js`）**啟動時就報錯停下**，訊息寫明要刪哪一行（`config/localExtractMode.js`；只在拆題模型是 ollama 時檢查，Gemini 模式不受影響）。沒有經過工作排程的呼叫端（eval、舊的 `/analyze-pdf`）遇到同一個矛盾，拆題那一塊回錯誤、訊息相同。`LOCAL_EXTRACT_MODE` 亂寫（例如 `vision`）＝~~`cross`~~〔Owner 第五輪 D-3〕預設 `ocr`，伺服器視窗警告一次（與 `OCR_ENGINE` 同一個規則）。〔Owner 第五輪 D-3〕預設改成 `ocr` 之後，**只寫 `OCR_ENGINE=none`、沒寫 `LOCAL_EXTRACT_MODE`** 也是這個矛盾，同樣啟動就報錯，訊息講明「沒寫＝預設 ocr；要只用看圖模型就加一行 `LOCAL_EXTRACT_MODE=cross`」（10.19 第 1 點）。

#### 3. 代價與複核怎麼做

- **每一題都要人工確認**：複核頁的原因選單多一項「只用 OCR 拆題」，說明句是「只用 OCR 拆題，請核對題目與公式。」對照原卷改對題幹、選項、答案與公式再核准。OCR 最常錯的是公式：樣卷的 OCR 把 $\log_2 8+\log_2 4$ 讀成「log_28+log_24」、向量符號讀成亂碼；文字模型只修「明顯的」辨識錯誤（`extract_ocr` 的模板），修不回來的就要在複核時改。
- **沒有交叉比對的品質訊號**：`cross` 模式「兩版一致」的題可以自動入庫，`ocr` 模式沒有第二版可以比，所以一律停下。原卷文字層比對（`source_check`，docs/source-check.md）、公式 lint、驗算、去重照舊都會跑，攔得下的照舊攔下（那時複核原因是那一項）。
- 複核頁的補圖提示：原因不是 `ocr_only`（例如先被答案比對攔下）的卡片，補圖提示也會接在原因後面。

#### 4. 附圖：依 PaddleOCR 的版面位置配

`ocr_pdf.py` 現在會把 PP-StructureV3 版面分析偵測到、在 markdown 裡變成「[圖]」的區塊（`image`、`chart`、`seal`，依閱讀順序）與它們的框一起回報（`pages[].figures`；辨識設定與 markdown 一個字都沒改，所以 OCR 回放檔的鍵 `ocr.v1` 不變）。`agents/extractOcrFigures.js` 把第 k 個「[圖]」對到第 k 個框，再決定屬於哪一題：

- 題目的範圍＝這一題的題號行（或題幹起點）到下一題的題號行（或題幹起點）；題幹在 OCR 文字裡的位置用原卷比對同一套中文字 5-gram 定位。題號行認得「12.」「12、」「## 1 ．」「( )3.」「第 3 題」「第三題」。
  - 〔審查 2026-09-26〕兩種情況不往前找題號行：題號與題幹在同一行（「3. 一個質量…」）時起點就是那個題號；**上一題定位不到**（中文字少於 12 個的「2. 如圖，求 ∠A 的度數。」）時起點就是題幹起點，不往前找——以前會把本題的起點拉回上一題的題號行，上一題的圖於是自動配給本題、沒有任何提示。
- **配**：同一頁、在這一題的範圍內（題號與題幹之間、題幹旁、緊接在題幹之後都算），而且範圍內只有這一張。配到的題寫 `figure_page`／`figure_box`，裁圖照舊在 PDF 刪檔前由 `services/figureService` 做，複核頁會顯示裁好的圖並提醒「附圖是依 OCR 的版面位置自動配的，請確認裁到的是這一題的圖」。
- **寧可不配**（改標提示）：跨頁（題目從上一頁開始、圖在下一頁頁首）；兩題之間有一題定位不到（前後兩個方向都算）；範圍內兩張以上（不猜哪一張，也不把兩張框在一起）；圖在題幹之後、這一題沒提到圖，而下一題寫「如圖」，或上一題寫「如圖」卻沒有自己的圖（版面閱讀順序把上一題右側的圖排到本題文字之後）；圖在題幹之後、中間隔著一行題號行（圖在一題**模型沒拆到**的題裡：漏拆、或輸出被截斷少了後面幾題）；這一塊的 `extract_ocr` 可能被截斷（第 6 點的粗估放不下 `OLLAMA_NUM_CTX`，或輸出用滿 8192 的上限）時**整塊一張都不自動配**；某一頁的框數與「[圖]」數對不上（那一頁整頁不配）。卷首的校徽、標題圖不屬於任何題，不配也不提示。印章不是附圖。
- **已知限制**：題號寫成「(1)」「（2）」的卷認不出題號行——學測式的卷「(1)～(5)」是選項、題組的「(1)(2)」是小題，當成題號會把題組的圖切掉；這種卷的圖若排在題號與題幹之間、題幹又沒寫「如圖」，會配給上一題。每一題都進人工複核，複核頁有「請確認裁到的是這一題的圖」這句。
- **提示**（`payload.extract.figure_hint`）：複核說明加「疑似有圖未配到，可用 figures:backfill 補（原因）」。原因是「範圍內有 N 張圖」「附近偵測到圖但配不準」或「題幹提到圖（如圖、附圖、下圖、右圖、圖中…），但版面上沒有配到」。
- **怎麼補**：核准入庫之後，用舊題補附圖工具 `npm run figures:backfill -- --dir "<原卷資料夾>"`（docs/figures.md「舊題補附圖」；預設不呼叫模型，產生提議檔給你確認再 `--apply`）。
- 做到哪一種：**拿得到版面位置**（PaddleX 3.7.2 的 `parsing_res_list`，程式照它的原始碼寫；在這台雲端環境沒有 PaddleOCR 可以實跑，只用鴨子型別的假區塊測過 `page_figures`，Owner 電腦上第一次跑時請看一張有圖的卷對不對）。讀不到版面（舊版 `ocr_pdf.py`、2026-09-25 錄的樣卷 OCR 回放檔沒有 `figures`）時，退回「題幹提到圖就提示」。

#### 5. 預估時間（依上面的實測數字推，還沒在 `ocr` 模式下整份實測）

| 步驟 | 依據 | 一塊（2 頁） |
|---|---|---|
| PaddleOCR | 樣卷 1 頁約 4 分鐘（含載入 1～2 分） | 約 5～8 分 |
| OCR 整理（`extract_ocr`，`qwen3:8b`） | 讀 prompt 很快（分類讀 2,495 token＋寫 56 token 共 41.5 秒，10.11）；輸出約每秒 2 token；樣卷 1 頁 10 題的 JSON 約 1,800 token（看圖版實測 1,786）→ 1 頁約 15 分 | 約 25～35 分（題目多、公式多的卷更久） |
| 合計（拆題） | | **約 30～45 分**；4 頁卷 2 塊約 1～1.5 小時（`cross` 光看圖就 ≥ 3.5 小時） |
| 之後每題的分類、lint、驗算 | 兩種模式相同（`qwen3:8b`） | 每題幾分鐘；驗算開思考最久 |

`JOB_NODE_TIMEOUT_MS=7200000`（2 小時）、`OLLAMA_TIMEOUT_MS=5400000`（90 分）足夠。輸出上限 8192 token（`LOCAL_MAX_OUTPUT_TOKENS`）以每秒 2 token 算最長約 68 分，也在 90 分以內。

#### 6. 一次讀多少（`OLLAMA_NUM_CTX=16384`）與思考

- `extract_ocr` **不開思考**（沒帶 `thinkingBudget`，`services/llm/ollama.js` 送 `think:false`；單元測試釘住）。
- 一次呼叫讀：系統提示＋轉接層附加的 schema 說明（約 0.7k token）＋模板（白名單、題型、公式規範，約 1.6k）＋這一塊的 OCR 文字；再加輸出上限 8192 要放得進 16384，所以 **OCR 文字大約只能到 5～6k token**（兩頁各約 2.5～3k）。樣卷 1 頁的 OCR 文字約 970 字（約 0.5k token），一般考卷兩頁放得下；**題目很密、公式或表格很多（OCR 的表格是 HTML，很佔 token）的卷可能放不下**——放不下時 Ollama 會截掉前面的內容或截斷輸出（拆出來的題少、JSON 不完整）。
- 提醒在兩個地方：① 伺服器視窗：每一塊送出前粗估（中文字一字一 token、其餘每 3 字元一 token），可能放不下時印一行「OCR 整理這一塊估計要讀約 N token……可在 .env 把 JOB_PDF_CHUNK_PAGES 設成 1，或調高 OLLAMA_NUM_CTX」，拆題事件的 `cross_check.ctx_budget` 也記下估計值；照常送出（由你決定要不要調）。② `npm run perf:local` 的 3.4 段：用回放檔裡 `extract_ocr` 實際讀得最多的一次＋8192 對照 `OLLAMA_NUM_CTX`。〔審查 2026-09-26〕粗估放不下（或輸出用滿上限）的那一塊，附圖一張都不自動配、只標提示（第 4 點），`npm run report:jobs` 的「OCR 版面配圖」一節會數到它。
- 要調的話：`JOB_PDF_CHUNK_PAGES=1`（每次讀一半，但一塊的固定開銷多付一次、跨頁題變多，10.11 (a)）或 `OLLAMA_NUM_CTX=20480`（記憶體要夠；16 GB 放一個 8B 模型通常可以）。
- 〔整合審查 2026-09-27 `dec/integration-r5-fix`〕10.14 的逐步驟設定也算數：上面兩處提醒與「可能被截斷就不自動配圖」的判斷，用的是這一次**實際送給 Ollama** 的值（與 `services/llm/index.js` 同一條規則：`services/llm/localTuning.js` 的 `resolveOllamaOverrides`）——`OLLAMA_NUM_CTX_EXTRACT_OCR`（化學版可另寫 `_CHEM`）有寫就用它、沒寫才是全域 `OLLAMA_NUM_CTX`；`OLLAMA_MAX_OUTPUT_EXTRACT_OCR` 比 8192 小時，輸出上限與「用滿上限＝可能截斷」都照它算。警告叫你調的也是實際生效的那一個變數。所以「只加大 OCR 整理」可以寫 `OLLAMA_NUM_CTX_EXTRACT_OCR=20480`（其他步驟的記憶體不變，但同一個模型換 num_ctx 會多換載一次，10.14 (d)）；「全域降到 8192、OCR 整理保留 16384」也不會被誤判成每塊都截斷。整合當下的 `dec/integration-r5` 只看全域 `OLLAMA_NUM_CTX` 與固定的 8192，這兩種寫法都會誤判（每塊標截斷、附圖不自動配、警告誤報）。

#### 7. CI 與重錄

- `.github/workflows/ci.yml` 的 integration job 加 `LOCAL_EXTRACT_MODE: ocr`，`eval/.env.replay` 寫同一個值（本機手動跑 e2e／eval、主控的 `ci.sh` 與 CI 一致；兩處一起改，單元測試釘住）。重錄工具的子行程照 `ci.yml`（`eval/lib/suiteProcess.js` 的 `CI_OPTIONAL_KEYS`），`.env` 裡的 `LOCAL_EXTRACT_MODE` 不帶進去（`LOCAL_SHIELD`）。
- **盤點會變的地方**：pipeline 與 e2e 只需要 `ocr` 與 `extract_ocr`（加上後面的分類、lint、驗算），**不再需要 `extract_vision`**；錄前檢查不要求下載 `qwen3-vl:8b`；時間粗估的拆題鏈少一步（`estimateLocalTime` 的 `mode`）；盤點表的「CI 的設定」一行多印 `LOCAL_EXTRACT_MODE=ocr`，並註明 `extract_vision` 的回放檔不會被讀到。以前錄的 `extract_vision` 回放檔（若有）會被 `cassettes:prune` 列為 CI 不再讀到——還想保留改回 `cross` 的可能就先不要 `--apply`。
- 目前 CI 的回放缺口（本分支 `ci.sh` 實測）：pipeline 的 replay miss 從 `extract_vision`（`85ab9965…`）變成 `extract_ocr`（`a47b37a0…`），筆數一樣是 1；e2e 同樣是那一塊拆不出來（3 項紅）。樣卷的 OCR 回放檔（2026-09-25 錄的）照舊命中。重錄 `record_local.bat pipeline,e2e` 只要 OCR（幾分鐘）＋`extract_ocr`（約 15 分）＋每題的後續節點，**不必跑 54 分鐘的看圖**；錄製模式下 OCR 會重跑一次，順便把版面圖框錄進回放檔。
- **e2e 在 `ocr` 模式（〔審查 2026-09-26〕採選項 ①；測試契約變更，待 Owner 裁決）**：`test/e2e/pipeline.e2e.test.js` 的「部分入庫：至少一題進 questions」與「部分是真的：…沒有任何一題入庫」要求至少一題**自動**入庫、複核原因只認九個舊值；`ocr` 模式設計上一題都不自動入庫，這兩項在 `ocr` 模式結構上不可能綠，依 X1（e2e 必須綠）不能就這樣合併。原本列給 Owner 的三個選項：① e2e 在 `ocr` 模式改成「全部停在複核，經複核 API 核准一題後入庫」；② e2e 固定用 `cross`（重錄 e2e 就要在 Owner 的電腦跑一頁 54 分鐘的看圖，9/26 實測輸出的 JSON 還不合法；審查意見認為錄不出來、不可行）；③ 維持現狀、另行裁決 X1。審查建議 ①，本分支照 ① 做、和 `ci.yml` 的 `LOCAL_EXTRACT_MODE: ocr` 一起進：
  - 交叉驗證（`cross`）與 Gemini 模式跑的仍是原本那兩項，**一個字都沒改**（`testCross`）。
  - `ocr` 模式改跑兩項（`testOcr`；檔頭有說明）：**①a** 一題都不自動入庫——每一列都在終態、沒有 `saved`、`question_id` 都是空的；`needs_review` 的原因只能是九個舊值加 `ocr_only`（不會有 `extract_disagree`）；樣卷沒有 `transcription_mismatch`（原本那一項的斷言照搬）；至少一題走完全部閘門停在 `ocr_only`，而且 payload 看得到 dedup0、classify、lint、source_check、verify、dedup1 六個閘門都跑過（原本「部分是真的」守的主張：閘門沒被跳過）；`GET /api/jobs/:id` 的 `counts.saved` 是 0。**①b** 用複核頁送出的欄位（`public/js/review.js` 的 `payloadToQuestion`，同一支函式）`POST /api/review/:jqId/approve` 核准第一個 `ocr_only` 的題 → 回 200、只有這一題進 `questions`、origin=pdf、章節在白名單內、題幹與答案非空（原本「部分入庫」的四個斷言照搬）、那一列變 `saved`、`counts.saved` 變 1 且四個 counts 相加仍等於總列數。
  - 驗證方式：本機沒有 `extract_ocr` 的回放檔，所以另用一支不進版控的預載腳本把 `extract_ocr` 的回應換成手寫的樣卷題目（其餘節點用 `test/fixtures/fakeAgents`、原卷比對用真的），`pipeline.e2e.test.js` 在 `ocr` 模式 8 項全綠；把 `crossCheckStopReason` 的 `ocr_only` 暫時拿掉（會自動入庫）時 ①a、①b 兩項都紅。
  - 目前 CI（沒有 `extract_ocr` 的回放檔）e2e 仍是 3 項紅、原因仍是 replay miss `extract_ocr/a47b37a0…`：「runner 把這個 job 跑完」照舊，另外兩項從舊的「部分入庫」「部分是真的」換成 ①a、①b。`LOCAL_EXTRACT_MODE=cross npm run test:e2e` 的結果與 889d18f 相同（同樣 3 項、miss `extract_vision/85ab9965…`）。
- **eval:pipeline 的 `saved_rate` 在 `ocr` 模式固定是 0（設計如此）**：`eval/lib/pipelineDriver.js` 走同一個 `crossCheckStopReason`，每一題走完閘門都停在 `ocr_only`，`thresholds.json` 的 0.87 門檻因此在 `ocr` 模式重錄之後**一定紅**（依 A7／X1 可以紅燈合併，但 PR 要列為未達項）。`gate_pass_rate` 與 `answer_agree_rate` 仍有意義。要怎麼解讀請 Owner 決定：例如另外算「人工核准前的通過率」（走完全部閘門、只因 `ocr_only` 停下的比例）當 `ocr` 模式的替代指標，或在 `ocr` 模式把 `saved_rate` 印成 n/a；門檻數字不動（`thresholds.json` 只升不降）。
- `cross` 模式仍由單元與整合測試（假模型）完整覆蓋：`test/unit/extractLocal*.test.js`、`test/integration/localExtract.pg.test.js` 一則都沒少；`ocr` 模式另有 `test/unit/extractOcrOnly.test.js`、`extractOcrFigures.test.js`、`localExtractMode.test.js`、`ocrFigures.test.js`、`reviewOcrOnly.test.js`、`localPerfReportOcr.test.js` 與 `test/integration/localExtractOcr.pg.test.js`（真的 PostgreSQL＋真的 `agents/extract.js`＋假 OCR 與假模型：每題停在 `ocr_only`、附圖在 PDF 刪檔前裁好、人工核准照常入庫）。

#### 8. 實作位置

| 檔案 | 做什麼 |
|---|---|
| `config/localExtractMode.js`（新） | 解析 `LOCAL_EXTRACT_MODE`、矛盾設定的訊息與丟錯 |
| `workers/jobRunner.js` | `loadLocalExtractModeConfig`、`createRunner` 啟動時檢查矛盾、`ctx.config.localExtract`、`crossCheckStopReason` 回 `ocr_only`；〔審查 2026-09-26〕`ocrOnlySchemaProblem`（沒套 0019 時 tick 不認領、只報一次錯） |
| `agents/extract.js` | `runLocalOcrOnly`（只做 OCR → `extract_ocr`）、`ocrStructureRequest`、context 粗估 |
| `agents/extractOcrFigures.js`（新） | 依 OCR 版面把附圖配到題目、補圖提示（〔審查 2026-09-26〕題目起點的三條規則、⑤ 對稱、⑥ 沒拆到的題、⑦ 截斷時整塊不配、「第 n 題」） |
| `ocr_service/ocr_pdf.py`、`services/ocr/index.js` | 回報與錄製版面圖框（`figures`）；`ocr.v1` 的鍵不變 |
| `utils/sourceCheck.js` | 多匯出 `locateOne`、`cjkIndex`（行為不變） |
| `migrations/0019_ocr_only_review.sql`（新）、`controllers/reviewController.js` | 複核原因 `ocr_only` |
| `public/js/review.js` | 標籤「只用 OCR 拆題」、說明句、補圖提示 |
| `.github/workflows/ci.yml`、`eval/.env.replay`、`eval/lib/suiteProcess.js`、`eval/lib/localMode.js`、`eval/lib/cassettePlan.js`、`eval/tools/rerecord_all.js` | CI 與重錄照 `ocr` |
| `eval/tools/local_perf_report.js` | `ocr` 模式的拆題鏈、每塊頁數、3.4 段 context 檢查 |
| `scripts/report_jobs.js` | 〔審查 2026-09-26〕「OCR 版面配圖」一節（extract 事件的 `cross_check.figures`：配到幾張、幾題有提示、讀不到版面、截斷） |
| `test/e2e/pipeline.e2e.test.js` | 〔審查 2026-09-26〕`ocr` 模式的 ①a／①b（第 7 點） |

### 10.13 三個餘弦門檻依本機向量重新校準（V5；2026-09-26，`dec/local-embed-thresholds`）——**待 Owner 核准，未改任何門檻**

> 本節只提建議與證據。`.env.example`、程式預設、`eval/thresholds.json` 一個都沒改；`test/unit/embedThresholds.test.js` 釘住現值（0.80／0.90／0.97／0.90）。Owner 核准哪一個選項之後才另開分支改。
>
> 〔Owner 第五輪核准 2026-09-27，`dec/r6-defaults`〕V5-1＝2（0.72）、V5-2＝2（0.87，**仍是暫定**，variant 重錄後依 O-4 抽查再定案）、V5-3＝3（0.99）、V5-4＝1（維持 0.90）、V5-5＝1（只改本機模式的預設）、O-2＝1（`KNN_VOTE_SIM` 維持 0.90）已落實，見 **10.19**；`eval/thresholds.json` 沒動。下面的「現行」是核准前的值（Gemini 的值沒變）。
>
> 〔審查修正 2026-09-26 `dec/local-embed-thresholds-fix`〕① V5-3 的「換句話說」一欄原本寫成「現行門檻抓到幾組」，其實產品不拿同一藍本的變式互相比（dedup1 排除整個家族），改標成代理，另列產品缺口 **V5-6**；② V5-2 改依不同題幹計，並標成**暫定**（等 LaTeX 反斜線修好、variant 重錄後重跑再定，先後順序寫在 V5-5）；③ 反斜線受損的證據（第 4 點）改由工具算出、可以重跑；④ 報告第 5 節「重複不入庫」的措辭改成「進複核（`review_reason='duplicate'`）」。

**怎麼重跑**（只讀檔、不呼叫模型、不連網、幾秒）：在 `exam_pro` 執行 `npm run embed:thresholds`（`-- --out data\local_ai\embed_thresholds.md` 另存一份）。本節的數字都出自它，兩個例外寫明出處：17,292 秒引自 10.7 第 8 點；variant eval 的 `gate_pass_rate` n/a 引自 `npm run eval -- --suite variant`（CI 的同一步）。「換了概念／同概念改寫」「兄弟變式是不是同一題」是 **Claude 的初判，不是量測**：存在 `exam_pro/eval/tools/embed_threshold_labels.json`，以題幹的 sha256 對上（重錄之後題幹變了就對不上，報告會列「未標註」，要重新標），計數一律由工具算。完整報告（含 60 題生成題逐題清單）是 [`local-embed-thresholds-report.md`](local-embed-thresholds-report.md)：資料是 `local/integration`（889d18f）錄的，2026-09-26 以本分支的工具重新產生。

#### 1. 用了哪些資料、怎麼算

照 `docs/variants.md` 第 3 節（當初依 Gemini 分布定門檻）的同一套方法，換成本機向量檔 `embeddings.ollama-qwen3-embedding-0.6b.768.json` 重算，Gemini 的向量檔做對照：

- **fixture 題對**：62 題兩兩配對，依結構標註分四組——同概念換數字（同 `variant_group`）、同章不同概念、跨章同科、跨科；門檻掃描的「不同章誤收」照 3.2 的算法（分母＝跨章同科＋跨科）。
- **變式 golden 30 個藍本**：與 `retrieved_coverage` 相同的候選條件（同科、同難度、排除自己），看最近與第 2 近是哪一題、幾分。
- **已錄的 60 支 `qwen3:8b` 變式 cassette**：把回應餵回 `agents/generateVariant.js`、向量查向量檔——就是跑題檢查在 CI 回放時看到的分數。
- **去重**：dedup golden（Owner 已定案）的 7 組換數字與 7 組不同題、生成題與 fixture 最近的一題（不同家族，產品會比）；同一藍本兩題生成題之間只當「換句話說」的餘弦代理（產品不比，見 V5-3、V5-6）。

**限制（先講清楚）**：

1. Gemini 向量檔少了 5 題（#51、#53、#54、#55、#62：CR-8 改標與新增之後沒有用 Gemini 重錄），兩個模型並排時只用兩邊都有的 57 題。
2. 樣本小、題目是自製的：每個概念只有一對換數字題；60 支生成題裡有餘弦的 55 支只有 41 段不同的題幹（14 個藍本的兩題逐字相同）。V5-2、V5-3 的生成題數字依**不同題幹**計（報告 4.3、5.3；逐支的數字在報告 4.1）。
3. **生成題「有沒有跑題」沒有人工標註**。下面「換了概念／同概念改寫」是 Claude 逐題讀過的初判，請 Owner 抽查（報告 4.2 有逐題清單與初判欄）。
4. **`qwen3:8b` 的輸出有「JSON 跳脫吃掉 LaTeX」的問題**，60 支變式裡 37 支題幹受損（Gemini 7/60）：跑題餘弦是拿壞掉的文字算的，而且有 5 支補回反斜線之後會先被文字閘門擋（第 4 點）。所以 V5-2 的生成題證據要等修好、重錄之後重算。
5. **去重的證據最薄**：真正「同一題、不同來源或排版」的本機向量沒有錄過（dedup golden 的 8 組 resend 題幹沒有向量），只能拿同一藍本兩題生成題裡的「同一題換句話說」當代理——而產品根本不比這種兄弟變式（V5-3）。

#### 2. 分布一眼看（共同 57 題）

| 題對 | 本機 min | p5 | p50 | p95 | max | Gemini min | p5 | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 同概念換數字（19 對） | 0.8981 | 0.9069 | 0.9676 | 0.9968 | 0.9981 | 0.9279 | 0.9413 | 0.9647 | 0.9865 | 0.9884 |
| 同章不同概念（126） | 0.5750 | 0.6402 | 0.7804 | 0.8932 | 0.9040 | 0.7837 | 0.7972 | 0.8702 | 0.9102 | 0.9219 |
| 跨章同科（651） | 0.3989 | 0.4397 | 0.5380 | 0.7798 | 0.9583 | 0.7134 | 0.7301 | 0.7819 | 0.8678 | 0.9685 |
| 跨科（800） | 0.3244 | 0.3857 | 0.4703 | 0.5515 | 0.6600 | 0.6556 | 0.6937 | 0.7310 | 0.7651 | 0.8240 |

白話：本機向量把「不相干的題」推得很開（跨科中位數 0.73 → 0.47），所以**分辨「同章／跨章」的門檻可以比 Gemini 低**；但「同概念換數字」的上半段更貼近 1（本機 p75 0.99、Gemini 0.97），所以**分辨「換數字」與「重複」的門檻要比 Gemini 高**。跨章最高的 0.958 是 fixture 刻意放的 2D／3D 內積對照組，兩個模型都一樣，門檻擋不掉。

#### 3. 決策題（每題選一個）

**V5-1　`VARIANT_RETRIEVE_SIM_MIN`（現行 0.80）——老師按「出變式」時，庫裡相似到幾分的現成題可以直接拿來用、不必叫模型現做**

| 選項 | 30 個藍本裡「直接有 2 題可用」 | 推薦出去的 2 題是什麼（同概念／同章／2D·3D 對照／其他章） | 多抓／少抓 |
|---|---:|---|---|
| 1. 維持 0.80 | 7（0.2333） | 5／2／7／0 | 最純；其餘 23 個藍本都要現做 |
| **2. 改 0.72（建議）** | **15（0.50）** | 11／11／7／**1** | 免生成的藍本多一倍；多推的主要是**同章不同概念**（例：斜面摩擦 → 同章的圓周運動張力、自由落體 → 同章的等加速位移），1 題跨到相鄰章（#55 庫侖定律 → #58 電場作功，0.770） |
| 3. 改 0.77（較保守） | 9（0.30） | 7／4／7／0 | 不推任何其他章的題 |

- 依據：0.70 → 0.72 覆蓋少 5 個藍本，但推薦出去的「其他章」從 5 題降到 1 題；0.72 到 0.76 之間只少 3 個藍本、其他章仍是 1 題（報告 3.1）。fixture 題對在 0.72：同章不同概念 83.7% ≥ 門檻、跨章同科 10.9%（Gemini 在 0.80 是 93.7%、34.3%）——等於保留 Gemini 時代「同章題會被推薦」的程度，跨章只剩三分之一。
- 不建議照 Gemini 的等效值（0.60～0.66，報告 2.3）：覆蓋 22～23 個，但推薦出去有 8～9 題是其他章的題（例：牛頓第二定律的藍本推直線運動題）。
- 代價：本機現做一題變式，光生成的中位數就是 162 秒（`qwen3:8b` cassette 的 latencyMs，報告 4），還要再跑分類、lint、驗算（10.7 第 8 點：上次重錄 variant 整步 17,292 秒、60 題）——覆蓋率在本機是「省時間」，不是省錢。0.72 會把同章不同觀念的題當成「相似題」推給老師（Gemini 時代 0.80 也是這樣：推薦出去的有同章 12 題、其他章 10 題）。CI 的 `retrieved_coverage` 門檻 0.8367 不動：0.72 時 0.50 仍紅燈（現在 0.2333 也紅）；要過 0.8367 得降到 0.54 以下、推薦 14 題其他章的題，不建議。

**V5-2　`VARIANT_OFFTOPIC_SIM_MIN`（現行 0.90）——模型現做的變式與藍本低於幾分就算「跑題」，退回重做一次（再不過就放棄這一題）——暫定：等 LaTeX 反斜線修回（另一條分支 `dec/latex-escape-repair` 在做；〔整合 2026-09-27 `dec/integration-final5`〕已併入，剩重錄 variant）與 variant 重錄後重跑 `embed:thresholds` 再定**

下表的生成題欄位是用**受損的文字**算的（60 支裡 37 支題幹少了反斜線，第 4 點），修好、重錄之後數字會變；只有最後一欄（fixture 題對，與報告 2.3 的等效值同一批資料）與反斜線無關。先後順序見 V5-5。

| 選項 | 擋下（41 段不同題幹） | 擋下的：換了概念／同概念改寫／補回反斜線後文字閘門就擋（Claude 初判＋工具重算） | 放過的換了概念 | 兩題都沒過的藍本（現況 → 補回反斜線後） | fixture：同章不同概念／跨章同科被放過 |
|---|---:|---|---:|---:|---|
| 1. 維持 0.90（最嚴） | 19 | 8／10／1 | 0 | 14 → 15（/30） | 3.1%／1.3% |
| **2. 改 0.87（暫定建議）** | **10** | **6／4／0** | 2 | 7 → 9（/30） | 9.3%／1.3% |
| 3. 改 0.80（較寬） | 7 | 5／2／0 | 3 | 5 → 7（/30） | 32.6%／3.8% |

（數字出自報告 4.3。另 5 支先被文字閘門擋下，沒有餘弦；逐支計〔同一藍本兩題逐字相同算兩次〕的舊數字在報告 4.1：0.90 擋 24/55、0.87 擋 12/55、0.80 擋 7/55。「補回反斜線後」那一欄把第 4 點那 5 支當成沒過文字閘門，其餘餘弦仍是受損文字的。Gemini 在 0.90 時是同章不同概念 11.9%、跨章同科 1.8%。）

- 依據：0.87 在 fixture 上與 Gemini 時代的 0.90 一樣嚴（同章不同概念被放過的比例對齊，等效值 0.8671；報告 2.3）——**這是 V5-2 唯一與反斜線受損無關的證據**。實錄的 `qwen3:8b` 變式（受損文字）裡，0.90 擋下的 19 段有 10 段是好好的同概念改寫，例如「已知 log 2 求 2^50 幾位數 → 已知 log 3 求 3^60 幾位數」0.856、「400° 的同界角 → 500° 的同界角」0.849／0.883、「F=ma 換成腳踏車情境」0.893／0.895；另 1 段 var-016（θ 在第二象限 → 第三象限，兩支逐字相同）0.877，初版把它算成「擋錯的好題」，但補回反斜線之後它只改了一個字、本來就會被文字閘門擋（`too_close`，報告 7.3），不算擋錯。0.87 以下擋的 10 段有 6 段真的換了概念，例如「sin²+cos² 恆等式 → 用 30° 的三角比求斜坡高度、水平投影」0.753／0.733、「對數相加 → 指數函數求值」0.788。0.87 會放過的換概念 2 段是把「內積」改成「外積」（var-009 兩支逐字相同 0.886、var-005#1 0.888）——本機向量分不出內積與外積。
- 代價：首輪 `VARIANT_AUTO_APPROVE=false`，閘門全過也要老師核准才入庫，所以放過的換概念題會出現在複核佇列、由老師退回；擋錯的好題會重做一次（本機生成中位數 162 秒）、再不過就少一題。CI 的 variant eval：`gate_pass_rate` **目前就已經是 n/a**（`npm run eval -- --suite variant`：`retrieved_coverage` 0.2333、2 筆 variant replay miss、1 筆 dedup1 查不到向量），與這個門檻無關；改門檻之後新放行的題也沒有錄過分類／lint／驗算的回放檔，所以之後重錄 variant 時（上次 17,292 秒）要一起補齊，不必為了改門檻另外錄一次。

**V5-3　`DEDUP_DUP_THRESHOLD`（現行 0.97）——新題與題庫裡（同科）最像的一題超過幾分就當「重複」停在複核（`review_reason='duplicate'`；不會刪，老師決定）。變式 job 不跟同一藍本的變式比（家族排除，見下面第 1 點與 V5-6）**

| 選項 | 62 題裡 20 對「換數字的同一題」被判重複 | dedup golden 7 組換數字（Owner 定案：不算重複）被判重複 | 生成題被判成 fixture 的重複（41 段不同題幹） | 「同一題換句話說」的餘弦 ≥ 門檻（**代理**：8 組兄弟變式；產品不比兄弟，實際 0 組） |
|---|---:|---:|---:|---:|
| 1. 維持 0.97（多抓） | 10/20 | 3/7（nc-03、nc-05、nc-06） | 1（var-028，兩支逐字相同 → #54，0.974） | 6/8 |
| 2. 改 0.98（折衷） | 9/20 | 2/7 | 0 | 5/8 |
| **3. 改 0.99（建議）** | **4/20** | **1/7**（nc-05，0.998） | 0 | 4/8 |

（Gemini 在 0.97 時是 6/19、golden 2/7；本機的等效值 0.989。第 3 欄逐支計是 2/55；var-028 補回反斜線後會先被文字閘門擋〔`numbers_only`〕，修好之後到不了 dedup1。）

1. **最後一欄是代理，不是產品行為**。它取同一藍本的兩題生成題裡 Claude 初判為「同一題」的 8 組（var-001 0.998、var-030 0.995、var-021 0.993、var-008 0.990、var-025 0.982〔「被釋放」與「被拋出」〕、var-026 0.974、var-029 0.947、var-015 0.929；報告 5.4）。初版列 7 組，這次逐題重看：var-015 兩題題幹與答案都相同、只換了兩個誘答選項，一併算「同一題」。**產品不會拿這種兄弟變式互相比**：變式 job 的 dedup1 排除藍本整個家族——`workers/jobRunner.js` 給 dedup1 的 input 帶 `exclude_family_root`，`agents/dedup.js` 的候選 SQL 加 `AND COALESCE(variant_of, id) <> 家族根`，變式存檔時 `variant_of`＝家族根（自動入庫走 `jobRunner.js` 的 `saveNode`，老師核准走 `controllers/reviewController.js`，兩邊相同）。所以不管門檻定多少，這 8 組實際都是 0 組被抓；只有逐字相同（正規化後）的會被 dedup0 的 L0 雜湊擋下（同一個 job 較早的題，或已入庫的題；另 14 個藍本就是這樣）。這一欄只拿來看「同一題換句話說」在本機向量下大約幾分；產品真正會比的是**不同家族**的同一題（另一份考卷印的同一題、別的藍本的變式剛好寫成同一題），那種情形目前沒有本機實測（限制第 5 點）。兄弟變式幾乎一樣卻都能進庫是另一個產品缺口，列成 V5-6。
2. **數字不同的真變式**也有高分：var-002 兩題（初始 100 個 vs 125 個細菌）0.995；fixture 的換數字題對最高 0.998。**本機向量下「換數字」與「換句話說」的分數完全重疊，任何門檻都分不乾淨**，只能選偏哪一邊。
- 依據：0.99 讓「換數字被當重複」不高於 Gemini 時代（本機 4/20，Gemini 0.97 時 6/19；分位對應的等效值 0.989），也最貼近 Owner 自己定案的 dedup golden（7 組只錯 1 組）。這兩項證據都是 fixture 與 golden 的向量（手寫題幹，沒有反斜線受損），現在就能答。
- 代價：0.99 會放過 0.97～0.99 之間的**不同家族**的同一題（照代理的分數，var-025 0.982、var-026 0.974 這種換句話說就落在這一段）：它不會停在 `duplicate` 的複核，只被標成「變式」照常往下走——上傳考卷的題若其他閘門都過（本機還要兩版拆題一致）就直接入庫，變式 job 的題仍要老師核准（`VARIANT_AUTO_APPROVE=false`）。0.97 則讓一半的換數字題進複核佇列（本機拆題的複核佇列本來就長）。**資料不夠下定論**：沒有「同一題、不同來源／排版」的實測（第 5 點）。

**V5-4　`DEDUP_VARIANT_THRESHOLD`（現行 0.90，只是「是某題的變式」標記，不擋題）——建議維持**

- 本機 0.90 時：dedup golden 7 組換數字有 6 組 ≥ 0.90（#1×#2 是 0.8981，差 0.002）；7 組不同題有 4 組被標成變式（2D／3D 內積 3 組兩個模型都一樣；#1×#7 本機 0.9037）。改 0.89（等效值 0.8981）救得回 #1×#2、救不了 #1×#7，同章不同概念被標「變式」的比例從 3.1% 升到 6.2%。只影響標記，不值得動。
- 選項：1. 維持 0.90（建議）；2. 改 0.89。

**V5-5　核准之後怎麼改（與 V5-1～V5-3 一起答）**

| 選項 | 做法 | 代價 |
|---|---|---|
| **1. 只改本機模式的預設（建議）** | `EMBED_MODEL` 是 `ollama:` 時用新值，Gemini 維持 0.80／0.90／0.97（與 `LOCAL_PDF_CHUNK_PAGES` 同一種寫法） | 程式多一層判斷；切回 Gemini 不必記得改門檻 |
| 2. 全部改成新值 | 直接改程式預設與 `.env.example` | 簡單；切回 Gemini 時要自己在 `.env` 改回舊值 |

不論選哪個：**Owner 的 `.env` 若明寫了這幾行（`.env.example` 有寫 `VARIANT_RETRIEVE_SIM_MIN=0.80`、`VARIANT_OFFTOPIC_SIM_MIN=0.90`、`DEDUP_DUP_THRESHOLD=0.97`、`DEDUP_VARIANT_THRESHOLD=0.90`），程式預設改了也不會生效**，要一起刪掉或改掉；舊名 `VARIANT_SIM_MIN=0.80` 也要刪——兩個新變數都沒寫時，它會同時被當成檢索下限與跑題閾值。要改的程式位置：`services/variantService.js`（檢索）、`workers/jobRunner.js` 的 `loadStage3Config`（跑題、去重）、`agents/generateVariant.js` 與 `agents/dedup.js` 的保底值、`eval/lib/suiteVariant.js` 與 `eval/lib/pipelineDriver.js` 的預設、`.env.example`；釘住現值的測試跟著改（只改數字，不放寬）。

**先後順序（V5-2 為什麼是暫定）**

1. **現在就能答**：V5-1、V5-3、V5-4——依據是 fixture 題對的向量、變式 golden 的檢索與 dedup golden，都是手寫的題幹，沒有反斜線受損（V5-3 的「換句話說」代理是受損文字的向量，只當參考）。V5-6 與門檻無關，也可以現在答。
2. **V5-2 等三步**：① LaTeX 反斜線修好（另一條分支 `dec/latex-escape-repair`，第 4 點；〔整合 2026-09-27 `dec/integration-final5`〕已併入）→ ② 重錄 variant（LLM 與向量都要；上次 17,292 秒；V5-6 若選 2，prompt 的修改併進這一次重錄，不必錄兩次）→ ③ `npm run embed:thresholds` 重跑，照報告 4.3 的表再答 V5-2（重錄後題幹變了，`embed_threshold_labels.json` 的初判對不上，報告會列「未標註」，要重新標）。屆時 fixture 的等效值 0.8671 不變；生成題那幾欄會變——至少 var-016、var-028、var-029#2 會先被文字閘門擋（報告 7.3），其餘的跑題餘弦改用修好的文字重算。
3. 核准的值照本題的選項 1 或 2 落實；V5-2 在第 2 步做完之前不動（現行 0.90 照舊）。

**V5-6　同一藍本的兄弟變式幾乎一樣，卻都能走到最後（產品缺口，與門檻無關；新題）**

〔Owner 2026-09-27 選 2〕已落實於 `dec/r6-templates`（`variant.v2`）。見 本檔「第五輪 A 模板與 schema（2026-09-27）」一節。

發生了什麼（報告 5.4；已錄的 `qwen3:8b` 變式，每個藍本錄 idx 1、2 兩題，等於老師一次要 2 題）：

- 30 個藍本裡 **14 個的兩題逐字相同**：同一個 job 的第 2 題被 dedup0 的 L0 雜湊擋下、以 `duplicate` 進複核——這一種有抓到。
- **另外 8 個藍本的兩題是同一題**（Claude 初判：換句話說或只換誘答），餘弦 0.929～0.998：dedup1 排除整個家族（V5-3 第 1 點），**任何門檻都不比**，其他閘門都過的話兩題都走到最後、停在 `awaiting_approval` 等老師核准；兩題都核准就一起入庫（`variant_of` 相同）。將來若開 `VARIANT_AUTO_APPROVE`，就是直接一起入庫。
- 對照：Gemini 錄的變式，兩題都算得出餘弦的 25 組裡沒有一組逐字相同。原因推論（沒有另外做實驗）：本機的 Ollama 呼叫一律 `temperature: 0`（`services/llm/ollama.js` 的 `chatBody`），而變式的 prompt 不含 idx（`agents/generateVariant.js` 的 `buildPrompt`；idx 只在回放檔的鍵裡），同一個 job 依序生成第 1、2 題，拿到的是同一份 prompt、同一組錨點鄰居。
- 範圍：一次要 1 題（預設 `count`＝1）時沒有兄弟；老師選 2～3 題，或之後對同一藍本再按一次「出變式」（另一個 job、同一份 prompt）才會有。後者連 L0 都只比得到已入庫的題——前一次的變式還在複核佇列、沒核准時，逐字相同也抓不到（dedup0 只比 `questions` 與同一個 job 較早的題）。
- 已有的緩衝：組卷的家族互斥（同一家族一張卷最多一題），兩題不會出在同一張卷；但不同卷之間，同一個學生可能先後寫到「同一題」（兩題的 id 不同，「已作答過」的排除擋不到）。

| 選項 | 做法 | 好處 | 代價 |
|---|---|---|---|
| 1. 維持現狀 | 不改；老師核准時自己看出兩題一樣、退回一題 | 不改程式、不重錄 | 複核頁沒有「這兩題一樣」的提示（兩題的原因都是 `awaiting_approval`），要老師自己比對；兩題都核准，題庫就多一題重複；開 `VARIANT_AUTO_APPROVE` 之前一定要再處理 |
| **2. 從生成端讓兄弟不一樣（建議）** | 變式的 prompt 模板加一段「這是第 N 題」與同一個 job 已生成的題幹（可再加同家族已入庫、待核准的變式），要求換情境與數字 | 對準原因（兩題同一份 prompt）；不必另定「多像算重複」的門檻 | 模板改了，回放檔的鍵就變：variant 的回放檔（`qwen3:8b` 60 支、Gemini 87 支）全部要重錄（上次 17,292 秒）——建議與反斜線修好後的那次重錄併成一次（上面的先後順序）；要多查一次同家族的題；溫度 0 下仍可能寫得很像，不保證完全不重複，還是要老師核准把關 |
| 3. dedup1 加兄弟比對 | 變式 job 的 dedup1 另算「與同家族其他變式（同一個 job 較早的題＋已入庫的；不含藍本）」的最高餘弦，超過某個值就在複核頁標「與第 N 題幾乎一樣」（只標記），或當 `duplicate` 進複核 | 事後攔，跨 job 也涵蓋；LLM 的回放檔不必重錄 | 要再定一個「幾乎一樣」的門檻：本機向量下換數字的真變式（var-002 兩題 0.995）比有的同一題（var-015 0.929）還高，**定多少都有誤報或漏報**；選「擋」的話換數字的好變式會被當重複——裁決 S3-14 當初排除家族就是為了避免這個；較早的兄弟還在複核佇列時向量不在 `questions`，要另外存或重算；`jobRunner.js`、`agents/dedup.js`、複核頁與 variant suite、e2e 的測試都要改 |

建議 2（跟反斜線修好後的重錄一起做）；3 等 2 做完看還剩多少兄弟重複再決定。做之前維持 1 也可以：首輪每一題變式都要老師核准。

#### 4. LaTeX 反斜線被 JSON 跳脫吃掉（R6 的證據；修補在 `dec/latex-escape-repair`）

模型在 JSON 字串裡寫 `\times` 而不是 `\\times`，`JSON.parse` 就把 `\t` 變成定位字元、只剩 `imes`（`\b`、`\f`、`\r` 同理；`\n` 開頭的 `\neq`、`\nu`、`\norm` 變成換行）。`services/llm/ollama.js` 與 `services/llm/gemini.js` 都是把模型的文字直接 `JSON.parse`，**兩邊目前都沒有修補**。下表出自報告第 7 節（`npm run embed:thresholds`，只讀已錄的回放檔；「帶控制字元」只數 `\t`、`\b`、`\f`、`\r` 四種，是下限）：

| 看什麼 | `qwen3:8b`（本機） | Gemini |
|---|---|---|
| 分類 classify 的回放檔，回應帶控制字元 | 10/92，**只壞在 `rationale`**（說明文字），章節沒有受損 | 0/181（`gemini-3.5-flash`） |
| 變式 variant 的回放檔（全部已錄的） | 49/60：`answer_text` 39、`question_text` 37、`figure_desc` 9 | 11/87（`gemini-3.1-pro-preview`）：`question_text` 8、`answer_text` 6 |
| 本節分析的 60 支變式，題幹受損 | 37/60；最常壞的是 `\tilde` 24、`\boldsymbol` 23、`\theta` 16、`\times` 15 次 | **7/60**（藍本題號#idx）：#7#1 `\frac`、#7#2 `\times`、#19#2 `\theta`、#29#2 `\rd`（模型原本想寫哪個指令看不出來）、#31#1 `\theta`、#55#1 `\times`／`\text`／`\boldsymbol`、#57#1 `\times` |
| 驗算 verify 的回放檔 | 1/20（`steps_summary`） | 1/58（`steps_summary`） |
| 拆題的回放檔 | 本機看圖拆題還沒錄成（10.11） | extract 1/1（`gemini-3.5-flash`：`question_text`、`answer_text`） |
| 補回反斜線後，文字閘門就擋的變式 | **5 支**：var-016 兩支（#31，只把「第二象限」改成「第三象限」）`too_close`、var-028 兩支（#55，只換數字）`numbers_only`、var-029#2（#57）`too_close` | 0 支 |

對門檻分析的影響：跑題（V5-2）的 37/60 支向量是拿壞掉的文字算的，上面 5 支補回之後根本到不了跑題檢查，所以 V5-2 暫定、照 V5-5 的先後順序重算；去重（V5-3）只有「生成題被判成 fixture 的重複」那一欄受影響（唯一的 var-028 補回後先被文字閘門擋）；檢索（V5-1）與 V5-4 只用 fixture 題，不受影響。

給 R6 的補充：Gemini 也真的受損（上表 7/60 題幹、variant 回放檔 11/87），`gemini.js` 同樣沒有修補。R6 的選項若寫「Gemini 路徑不動」，要一併寫明代價：切回 Gemini 時這些題照樣壞掉；或把 `gemini.js` 一起納入修補。補回的規則以產品的修補為準；報告用的 `scanEscapeDamage`（`eval/lib/embedThresholds.js`）只是分析用的估計：控制字元後面緊接英文字母才補回，換行只補 `$…$` 裡面的。

#### 5. 資料不夠的地方與之後可以補的

- **去重**：補錄 dedup golden 8 組 resend 題幹的本機向量（只呼叫 `qwen3-embedding:0.6b`，幾秒；要在 Owner 電腦上跑），才量得到「格式不同的同一題」在本機是幾分。正式題庫換完向量（10.6）之後，複核佇列裡原因是「重複」的題，其處理紀錄（payload 的 `dedup1.top`）也記了實際分數，累積幾週可以再校一次。
- **跑題**：照 V5-5 的先後順序，反斜線修好、重錄 variant 之後重跑 `npm run embed:thresholds`，重新標初判（`embed_threshold_labels.json`）；生成題的「跑題與否」若 Owner 願意逐題標（報告 4.2 那 55 支），門檻就不必靠 Claude 的初判。
- **檢索**：fixture 每個概念只有一對換數字題，覆蓋率要靠「第 2 近」是同章或別章的題才算得上——真實題庫同一觀念的題多，實際覆蓋率會不同（`docs/variants.md` 第 4 節最後的警告同樣適用）。
- 本節沒有分析 `KNN_VOTE_SIM`（0.90，kNN 投票短路分類）：它也是照 Gemini 定的。本機下同章不同概念 ≥ 0.90 只有 3.1%，短路會更少發生（多呼叫幾次 LLM 分類，慢但不會更不準）；要的話另開一題。

### 10.14 拆題以外的時間花在哪裡、加速選項（2026-09-26，`dec/local-thinking-speed`；**待 Owner 決定，預設未改**）

> 〔第五輪 B，2026-09-27，`dec/r6-local-tuning`〕Owner 已決定本節的選項：(b) 知識點標註不思考、(c2) 驗算上限 3072、截斷不重試已做成**本機模式的程式預設**，其餘維持；見 10.17。下面「預設未改」「待 Owner 決定」是 2026-09-26 當時的狀態。

> 本節的程式只加了「可以開、預設關」的設定與兩個量測工具：`.env` 不寫任何新設定時，送給 Ollama 的內容與之前逐位元相同（`test/unit/localTuning.test.js`）。拆題本身（OCR 為主）在另一條分支，本節不動〔整合：見 10.12〕。
>
> 〔審查修正 2026-09-26，`dec/local-thinking-speed-fix`〕原本寫的「冷的讀 prompt 約 17 token/秒」其實大多是**部分快取**（連送兩次的第一次，前面多半剛送過同一個 agent 的上一題，Ollama 只讀了後半段）；改用「這個 agent 第一次出現」的呼叫推，約 **8 token/秒**，受影響的估計（冷的分類、OCR 整理、知識點標註與補標、合計、選項 a／c 扣掉的讀 prompt）都重算了。「分類的快取每題都被擠掉」改成條件句（回放檔顯示 Ollama 至少留著 3 份 prompt 快取）。**本節每個數字都能用 `npm run perf:local` 重跑**，旁邊註明第幾段；Owner 自己量的（看圖 1 頁）另註出處。

#### 1. 實測：時間花在哪裡（2026-09-25 本機重錄的回放檔，`npm run perf:local` 第 1、1.2～1.6 段）

資料：commit `f77d1a3` 的本機回放檔（`qwen3:8b` 184 支、PaddleOCR 1 支；錄於 2026-09-25 22:19～09-26 04:42）。這批回放檔沒有 Ollama 的分段時間（`usage.timing` 是之後才加的），讀 prompt 與輸出的速度用推算的（第 1.3 段）：輸出用「同一段 prompt 連送兩次」（變式題 idx 1、2 送的是同一段 prompt，第二次吃到 Ollama 的 prompt 快取、幾乎只剩輸出）；冷的讀 prompt 只用「這個 agent 第一次出現」的呼叫。

| 步驟（agent） | 支數 | 讀 token（p50；範圍） | 寫 token（含思考；p50；範圍） | 延遲 p50／p90／最長 | 思考 |
|---|---:|---|---|---|---|
| 分類 `classify` | 92 | 3,600（2,480～3,689） | 62（48～111） | 51 秒／1 分 4 秒／8 分 38 秒 | 不思考 |
| 公式 LLM 重寫 `lint` | 4 | 845（838～961） | 866（805～1,036） | 8 分 22 秒／10 分／10 分 | **思考，約占輸出 71%** |
| 驗算 `verify` | 20 | 311（299～346） | 465（286～1,285） | 3 分 18 秒／6 分 14 秒／10 分 46 秒 | **思考，約占輸出 81%** |
| 出變式 `variant` | 60 | 1,952（1,750～2,028） | 199（129～454） | 2 分 41 秒／4 分 3 秒／5 分 56 秒 | 不思考 |
| 查題 `nlq` | 8 | 1,439 | 51（50～73） | 25 秒／3 分 26 秒／3 分 26 秒 | 不思考 |
| PaddleOCR `ocr` | 1 | — | — | 4 分 33 秒（1 頁） | — |

- **速度**（第 1.3 段）：`qwen3:8b` 輸出約 **2.06 token/秒**（17 對連送兩次的中位數；驗算的延遲對輸出 token 迴歸得 1.92 token/秒、r² 0.98）；**冷的讀 prompt 約 8.0 token/秒**——只用「這個 agent 第一次出現、前一支是別的 agent」的呼叫：查題第一支（讀 1,437、寫 50、206 秒 → 7.9）、出變式第一支（讀 1,889、寫 254、356 秒 → 8.1）。同一個 agent 換一科的第一支（分類第一題物理 9.3、變式第一題物理 11.3）系統提示詞與欄位說明仍在快取、偏快，只列出不採用；分類第一支（含模型載入）、lint 與驗算第一支（讀不到 1,000 token，兩個大數相減雜訊太大）不採用。
  - 原本的「約 17」是連送兩次的**第一次**推的：15 對（讀 1,000 token 以上）裡有 14 對，前面剛送過同一個 agent 的 prompt（同一科的上一題：系統提示詞、欄位說明、章節白名單都相同，只差藍本題以後的部分），Ollama 只讀了後半段——那是**部分快取**的讀速（第 1.3 段另列 17.4，標明偏快，不拿來估冷的時間）。
  - 所以輸出一個 token 約 0.5 秒、讀一個約 0.125 秒：時間仍然主要花在輸出，但讀得多的步驟冷的時候也不便宜（分類約 3,100 token → 約 6 分半只花在讀）。
  - 限制：只有 2 支冷的樣本；若那兩支剛好碰上換載模型（向量模型把 qwen3:8b 擠出記憶體），時間含載入、讀速被低估。用新版重錄（有 Ollama 的分段時間，第 1.1 段）之後就不必推算。
- **Ollama 同時留著好幾份 prompt 快取**（第 1.3 段）：同一段變式 prompt 中間夾了 1～2 支 lint 或驗算再送一次，共 **15 次，第二次全是熱的**（例：220→114、269→157、196→82、268→142、219→96 秒；扣掉輸出幾乎不剩時間）。其中一次中間夾了 lint＋驗算兩種別的前綴仍是熱的 → **至少 3 份**（多個並行槽；假設 Ollama 換出最久沒用的那一份）。這影響 (d)(e) 的記憶體帳，也影響第 5 點的分類順序。
- **思考占多少**（第 1.4 段）：Ollama 把思考與回答算在同一個輸出 token 數裡，回放檔只存回答。用 160 支不思考的回放檔擬合「輸出 token ≈ 0.88 × 中文字數 ＋ 0.50 × 其他字數」（平均誤差 5%），套到 lint 與驗算的回答上：lint 平均 930 token 裡約 662 是思考（每次約 5 分 20 秒）、驗算平均 549 token 裡約 445 是思考（每次約 3 分 36 秒）。知識點標註（`kc_tag`，也會思考）沒有本機回放檔，只能照這兩個的比例推。
- **lint 什麼時候才呼叫 LLM**：`agents/lint.js` 三層，① `formulaFix` 規則修、② `formulaLint` 硬閘門，**② 還有 `sev:'error'` 才走 ③ LLM 重寫**（`lint.v2`，思考開）；重寫後再過一次 ①②，仍不過就 `formula_unparsable`，狀態機原地重跑最多 2 次（每次都再呼叫一次 LLM）。對既有資料跑 ①②（第 1.5 段）：fixture 62 題 10 題、Gemini 拆的 10 題 1 題、Gemini 出的變式 87 題 1 題、`qwen3:8b` 出的變式 60 題 11 題要走 ③——取 **約 10%～20%**。
- **驗算哪些題會跑**：證明題以外**每一題**（`agents/verify.js`）。比對結果 uncertain 時同一個節點再採樣一次（本機 18 題有 2 題，11%）；判定不一致（`answer_mismatch`）時狀態機**整個節點原地重跑一次**（`pipeline/stateMachine.js` 的 `maxRetries.verify=1`）——所以一題不一致的驗算最多 4 次呼叫。重跑會不會換到別的答案：驗算的輸入不變、溫度 0，但 Ollama 在 CPU 上不保證逐字重現（第 1.6 段：同一段變式 prompt 送兩次的 30 對只有 12 對逐字相同）；本機的 `answer_mismatch` 重跑還沒有任何資料，只有 2 支 uncertain 的第 2 次採樣（最終答案都與第 1 次相同，**n=2**）。見第 5 點。
- **分類什麼時候才呼叫 LLM、要多久**：拆題給的章節在白名單內而且信心 ≥ 0.8 就不呼叫（`agents/classify.js` 第一層）。本機拆題（OCR 為主）的信心分數還沒有資料，估計只能寫 0～10 次。每次多久看 prompt 快取（第 4 段分類那一列）：
  - 回放檔的 51 秒：錄製時**沒有資料庫**，few-shot 全部來自設定檔的例句（同一科每題相同），同一科連續送、prompt 只差最後的題目，前綴快取是熱的。正式上傳 `FEATURE_SIMILAR` 關時 few-shot 是題庫各章的前兩題（同一科每題也相同），快取還在就接近這個數字；
  - `FEATURE_SIMILAR` 開時 few-shot 是**向量近鄰、每題不同**：前綴（系統提示詞、欄位說明、白名單、界線規則）熱的也要重讀 few-shot 以後的約 58%～68%，每題約 **4～5 分**；
  - 快取被擠掉（`OLLAMA_NUM_PARALLEL=1` 只剩一份、或 `OLLAMA_MAX_LOADED_MODELS=1` 讓向量模型把 qwen3:8b 擠出記憶體）時整段都冷，每題約 **7 分**（第一支回放檔含模型載入是 8 分 38 秒）。

**一份 10 題、4 頁的卷（每塊 2 頁、OCR 為主，不含看圖拆題；`npm run perf:local` 第 4 段）**：

| 步驟 | 呼叫次數 | 每次 | 合計 | 依據 |
|---|---:|---|---|---|
| PaddleOCR | 2 塊 | 約 9 分 | 約 18 分 | 回放檔 1 支（1 頁 4 分 33 秒，含每次啟動 Python 與載入 OCR 模型）× 2 頁 |
| OCR 結果整理成題目（`qwen3:8b`） | 2 塊 | 約 15 分 | 約 30 分 | **估計**（沒有本機回放檔）：每塊讀約 3,760 token（固定的提示詞約 2,560，照 `agents/extract.js` 組出來換算；OCR 文字每頁約 600，照 ocr 回放檔換算）、寫約 890 token（每題約 180，照 Gemini 拆題回放檔的回答換算） |
| 分類 | 0～10 | 51 秒（熱）～約 7 分（整段冷） | 0～1 小時 10 分 | 呼叫比例沒有本機資料；`FEATURE_SIMILAR` 開、前綴熱時每次約 4 分 16 秒～4 分 55 秒 |
| lint 的 LLM 重寫 | 1～2 | 8 分 22 秒～10 分 | 8～20 分 | 觸發 10%～20% |
| 驗算 | 10～14.4 | 3 分 18 秒～6 分 14 秒 | 33 分～1 小時 30 分 | uncertain 11%、不一致 0～30% 時重跑 |
| **合計** | | | **約 1 小時 29 分～3 小時 48 分** | 低＝p50、次數少；高＝p90、次數多、分類整段冷 |
| （知識點標註，預設關） | 10 | 約 7 分 40 秒（估計） | 約 1 小時 17 分 | 開了 `FEATURE_KC_TAGGING` 才有；既有約 200 題跑 `kc:backfill` 約 25 小時 40 分（題數用 `--backfill` 改，實際題數看 `npm run kc:backfill -- --dry-run`） |

沒算進去的：看圖拆題（Owner 用 `npm run local:bench-vision` 實測一頁讀 6,248 token 用 23 分 32 秒、寫 1,786 token 用 28 分 40 秒，另一條分支處理〔整合：見 10.11、10.12〕）、模型換載（下面 (e)）、排隊、人工複核。**拆題以外（分類＋lint＋驗算）約 41 分～3 小時**（高＝10 題都要分類、每題整段冷；照第 4 段的每次時間算，快取還在時：`FEATURE_SIMILAR` 開約 2 小時 40 分、關約 2 小時），**其中驗算占五到八成**，其次是分類（快取被擠掉或 few-shot 每題不同時）與 lint。

#### 2. 加速選項（預設都沒有改；每一項都待 Owner 決定）

| 選項 | 怎麼開（`exam_pro\.env`） | 一份卷省多少（估；`perf:local` 第 4.1 段） | 代價與風險 | 要重錄嗎 |
|---|---|---|---|---|
| (a) lint 不思考 | `OLLAMA_NO_THINK=lint` | 每次 4 分 38 秒～5 分 48 秒；一份卷 5～12 分 | 重寫的品質可能變差：改不好時多跑一輪 ③（狀態機最多重跑 2 次），反而更久；lint 的工作是「只改公式寫法」，比驗算單純，風險較小 | 不必（鍵不含思考設定） |
| (b) 知識點標註不思考 | `OLLAMA_NO_THINK=kc_tag` | 每題約 3 分 20 秒（估計）；開自動標註時一份卷約 33 分；既有約 200 題 `kc:backfill` 約省 11 小時（約 25 小時 40 分 → 14 小時 40 分） | 標錯的比例可能上升；信心低於 `KC_TAG_MIN_CONFIDENCE` 的不會寫入，留給老師手標。沒有本機實測，**先用 bench 量幾題** | 不必 |
| (c1) 驗算不思考 | `OLLAMA_NO_THINK=verify` | 每次 2 分 8 秒～4 分 31 秒；一份卷 21 分～1 小時 5 分（省最多） | **驗算是獨立檢查**：不思考時 8B 模型自己算錯的題變多 → 假的「不一致」變多（停在複核、而且不一致會整個節點再跑一次，省下的時間被吃回一部分）；更糟的是自己算錯卻剛好與抄錯的答案相同的機會也變大。等於降低「拆題 ≠ 驗算」這道防線的強度 | 不必 |
| (c2) 驗算只降輸出上限 | `OLLAMA_MAX_OUTPUT_VERIFY=3072` | 平常 0（實測最多 1,285 token） | 只縮短「思考繞圈」的最壞情況：沒有上限時一次最多寫 8,192 token ≈ 66 分，超過 Owner `.env` 的 `OLLAMA_TIMEOUT_MS`（90 分，V1）之前都不會停，錯誤還會重試 3 次（最壞約 4.4 小時）；上限 3072 時最壞約 25 分 × 4 次。代價：真的需要長推理的難題被截斷 → JSON 不完整 → 重試後進複核。**截斷的回應也會重試**（見下面「截斷不重試」）。Qwen3 官方模型卡建議思考模式**不要用溫度 0（greedy）**，否則可能無止境重複；本機 20 支驗算沒有觀察到繞圈 | 不必 |
| (d) `num_ctx` 16384 → 8192 | `OLLAMA_NUM_CTX=8192`，拆題保留大的：`OLLAMA_NUM_CTX_EXTRACT_VISION=16384`、`OLLAMA_NUM_CTX_EXTRACT_OCR=16384`（家教也建議 `OLLAMA_NUM_CTX_TUTOR=16384`） | 不一定：只有記憶體不夠、系統在換頁時才會變快 | `qwen3:8b`／`qwen3-vl:8b` 的 KV cache 每個 token 144 KB（f16）：16384 約 **2.25 GB**、8192 約 **1.13 GB**，**每個並行槽各一份**（第 1.2 段；回放檔推至少 3 個槽 → 16384 時至少約 6.8 GB、4 個槽約 9 GB，見 (e)）。文字步驟實測讀＋寫最多 3,771 token（分類），8192 放得下；**看圖拆題 1 頁就約 8,000 token**（Owner 用 bench 量的），一塊 2 頁一定放不下；OCR 整理一塊估計讀＋寫約 4,650（10 題卷）～4,950（20 題 6 頁，第 4 段），8192 放得下，但 OCR 文字多的頁或寫到輸出上限時會超過，所以這兩個保留 16384。同一個模型換 num_ctx 時 Ollama 會重新載入模型（幾十秒；OCR 整理與分類都用 `qwen3:8b`，一份卷多一次換載） | 不必 |
| (e) Ollama 伺服器與其他程式 | 不是本系統的設定（Windows 的使用者環境變數，改完從工作列結束 Ollama 再開） | 不一定；**可能是每秒只有 2 個 token 的主因，建議最先看** | 見下面的說明與量法 | 不必 |

**截斷不重試（和 (c2) 一起考慮；本分支沒有改）**：Ollama 寫到輸出上限（`num_predict`）時回 `done_reason: length`，JSON 不完整 → 驗算回 `schema_invalid` 錯誤 → 狀態機規則 6 退避重跑最多 3 次（`maxErrorRetries`）。溫度 0 下同一題再跑，輸出長度多半差不多（第 1.6 段：同一段變式 prompt 送兩次，30 對裡 25 對輸出 token 數相差不到 10%；但只有 12 對逐字相同，所以不是一定），思考繞圈的題很可能又寫到上限、白等 3 次。可以決定「本機模式被截斷的回應不重試、直接進複核」：要讓 verify、lint 把 `finishReason` 帶給 runner，只在拆題模型是 ollama 時生效（Gemini 模式照舊 3 次），並補單元測試。待 Owner 決定後再做。

**(e) 的細節（只寫建議與怎麼量；都在 Owner 的電腦上）**

- **記憶體帳**：`qwen3:8b` 權重約 5.2 GB ＋ KV cache 每個槽 2.25 GB（16384）× 槽數 ＋ 計算緩衝約 0.5 GB；回放檔推至少 3 個槽（第 1.3 段）→ Ollama 本身就可能 **12～15 GB**；Windows 本身約 3 GB；Docker Desktop 的 WSL2 虛擬機預設最多可吃到**實體記憶體的一半（8 GB）**；Chrome 每個分頁數百 MB；VS Code 約 1 GB。16 GB 很可能不夠，一旦換頁，每秒 2 個 token 會再往下掉。CPU 上輸出速度主要受記憶體頻寬限制：粗估雙通道 DDR4-2400 跑 8B Q4 模型每秒 3～4 個 token，**只插一條記憶體（單通道）約減半**；實測 2.06，可能是單通道、降頻（筆電 15 W 長時間滿載）或換頁，要量才知道（工作管理員 → 效能 → 記憶體的「已使用的插槽」看得到是不是單通道；單通道的話 2 token/秒就是這台電腦的正常值，下面的設定幫不了太多）。
- **`OLLAMA_NUM_PARALLEL`**：回放檔的證據（第 1.3 段）：同一段變式 prompt 中間夾了 1～2 支 lint 或驗算再送一次，**15 次第二次全是熱的**，最多夾了兩種別的前綴 → Ollama 至少開了 **3 個並行槽**（Ollama 有些版本在記憶體夠時會自動開 4 個）。**每個槽各佔一份 num_ctx 的 KV cache**：3 個槽 × 16384 約 6.8 GB、4 個槽約 9 GB——這可能正是換頁與每秒 2 個 token 的主因，**先照下面「怎麼量」第 2 步看 `server.log` 的 parallel 設定**。設 `OLLAMA_NUM_PARALLEL=1` 可以省下 4.5～6.8 GB；代價是只剩一份 prompt 快取：一題接一題時，分類的長 prompt 會被驗算擠掉、每題都冷（每題約 7 分，而不是 51 秒～5 分，見第 1 點），要一併考慮第 5 點的分類順序。先量再決定。
- **`OLLAMA_MAX_LOADED_MODELS`**：10.2 第 4 步建議 1。代價：每題入庫前後都要算一次向量（`qwen3-embedding:0.6b`），設 1 時可能每題都把 `qwen3:8b` 擠出記憶體、下一題分類要重新載入，prompt 快取也跟著清空（每題整段冷）。embedding 模型只有約 0.6 GB，設 2 讓它與 `qwen3:8b` 並存通常放得下，但拆題時 `qwen3-vl:8b` 與 `qwen3:8b` 也可能同時載入（兩個約 11 GB）。OCR 為主之後看圖拆題變少，可以重新評估。
- **`OLLAMA_KEEP_ALIVE`**：本系統每次呼叫都帶 `.env` 的 `OLLAMA_KEEP_ALIVE`（預設 10m），**會蓋過** Windows 環境變數裡的同名設定；向量那一支不帶，照 Ollama 伺服器的預設（5 分）。一份卷內各呼叫間隔都在幾分鐘內，10m 夠用；老師在複核頁停很久之後再上傳，第一次要重新載入。
- **`num_thread`**：Ollama 預設用實體核心數（i5-8265U 是 4）。用 bench 比 `--num-thread 3／4／8`：8（含超執行緒）在 llama.cpp 上通常不會更快；3 可能讓 Docker／Chrome 比較不卡。本系統沒有對應的 `.env` 設定（要常駐的話另外決定）。
- **關掉 Chrome、VS Code；限制 Docker 的記憶體**：PostgreSQL 在 Docker 裡，處理考卷時 Docker 不能關；可以在 `%UserProfile%\.wslconfig` 寫 `[wsl2]` 與 `memory=4GB`，`wsl --shutdown` 後重開 Docker Desktop，把 WSL2 的上限從 8 GB 降下來。
- **怎麼量**：
  1. 跑一次 `npm run local:bench-text -- --agent verify`（下面），同時開「工作管理員 → 效能 → 記憶體」看「使用中」與「認可」是否逼近 16 GB，「資源監視器 → 記憶體」的「硬錯誤/秒」持續幾百以上就是在換頁。
  2. **（建議先做這一步）** `ollama ps` 看目前載入哪些模型、各佔多少（新版還有 CONTEXT 欄）；`%LOCALAPPDATA%\Ollama\server.log` 搜 `parallel`、`n_ctx`、`KvSize` 看並行槽數與實際的 context 大小（context 是 num_ctx 的 3～4 倍、parallel 是 3～4，就是上面說的多個槽），搜 `loading model` 數一份卷裡換載幾次。
  3. 關掉 Chrome／VS Code（或改 `.wslconfig`、`OLLAMA_NUM_PARALLEL=1`）後同一個指令再量一次，比「輸出 token/秒」。

#### 3. 怎麼量：`npm run local:bench-text`（文字模型量一次）

用 `eval/fixtures/questions.public.json` 的一題，照正式流程組出請求（系統提示詞、提示詞、schema、輸出上限、思考與 agent 自己的一模一樣；**分類例外**，見下面 `--agent`），**只呼叫一次** `qwen3:8b`，印出載入、讀 prompt、輸出（含思考）各花多久、每秒幾個 token、思考約占多少、回答對不對（驗算對照 fixture 的答案、分類對照 fixture 的章節），以及一份 10 題卷這一步大約多久。不寫回放檔、不碰資料庫、不改 `.env`；預設先卸載模型（時間含載入、prompt 是冷的），逾時 60 分。不加參數＝正式上傳現在的樣子（會套用 `.env` 裡已經寫的本機調整）。

在 `exam_pro` 資料夾開**命令提示字元（cmd）**，一次一行，每行幾分鐘到十幾分鐘：

```bat
cd /d C:\你的路徑\tutor-exam-bank\exam_pro
npm run local:bench-text -- --agent lint
npm run local:bench-text -- --agent lint --no-think
npm run local:bench-text -- --agent verify
npm run local:bench-text -- --agent verify --no-think
npm run local:bench-text -- --agent verify --num-ctx 8192
npm run local:bench-text -- --agent classify --num-thread 3
npm run local:bench-text -- --agent kc_tag --no-think
npm run local:bench-text -- --agent verify --id 7 --no-think
```

**PowerShell** 直接呼叫 node（`--` 可能被 `npm.ps1` 吃掉）：

```powershell
Set-Location C:\你的路徑\tutor-exam-bank\exam_pro
node eval/tools/local_bench_text.js --agent lint
node eval/tools/local_bench_text.js --agent lint --no-think
node eval/tools/local_bench_text.js --agent verify --num-ctx 8192
```

- `--agent`：`lint`（挑第一題規則修不好的）、`verify`（第一題計算題）、`classify`（第一題；強制走 LLM 那一層）、`kc_tag`（第一題有知識點清單的章）。`--id <題號>` 換題；判斷品質（尤其驗算）請多量幾題。
  - 〔審查修正〕**`classify` 的 prompt 與正式上傳不同**：量測不碰資料庫，few-shot 全部來自設定檔的例句（同一科每題相同，與 eval 的分類回放檔同一種 prompt）；正式上傳時 few-shot 由題庫組（`FEATURE_SIMILAR` 開時是向量近鄰、每題不同），長度與內容都不一樣，讀 prompt 的秒數只能參考（報告裡也會印這段注意事項）。
- `--no-think`／`--think`、`--num-ctx <N>`、`--max-output <N>`、`--num-thread <N>`：只影響這一次。`--warm` 不先卸載（看「prompt 剛讀過」有多快）。
- 比較：同一題換一個參數再跑一次，把兩段「══ 文字模型量測」貼在一起：看「輸出」的 token 數與秒數少了多少、回答是否還對。
- 重錄之後的整體數字：`npm run perf:local`（第 1.2 段 token 分布、num_ctx 與 KV cache 的記憶體，1.3 速度與快取份數，1.4 思考比例，1.5 公式反斜線與公式閘門，1.6 溫度 0 的重現性，第 4 段一份卷的估計與既有題庫補標；`--questions 20 --pages 6` 改卷的大小、`--backfill <題數>` 改補標的題數）。

#### 4. 設定的細節（給維護者）

- `services/llm/localTuning.js`：`OLLAMA_NO_THINK`（逗號分隔，`all`＝全部；寫基本名稱連化學版一起，例 `lint` 也管 `lint_chem`；只會關、不會開）、`OLLAMA_MAX_OUTPUT_<AGENT>`（只降不升）、`OLLAMA_NUM_CTX_<AGENT>`（蓋過 `OLLAMA_NUM_CTX`）。會思考的 agent：`verify`、`lint`（與化學版）、`kc_tag`、`tutor`、`voice`（`THINKING_AGENTS`，單元測試對照各模組的常數並掃原始碼）。
- 只在 vendor 是 `ollama`、`LLM_MODE` 是 live／record 時由 `services/llm/index.js` 套用；Gemini 路徑與回放一個字都不讀。**cassette 的鍵不含思考、輸出上限與 num_ctx**，開關不會讓既有回放檔失效（單元測試拿 repo 裡本機錄的驗算回放檔證明）。錄製時有套用，就在回放檔的 `request.ollamaOverrides` 記下實際送出的值，`perf:local` 把「（不思考）」另列一組；第 4 段的「現狀」照 `.env` 的 `OLLAMA_NO_THINK` 挑思考版或不思考版的回放檔（挑的那一版沒有就用另一版並加註；都沒有就列進「算不出來」，不會悄悄少算）。
- 〔審查修正〕**啟動時印出生效的本機調整**：`services/llm/index.js` 載入時（`LLM_MODE` 是 live／record）印一行「[ollama] 本機調整…：不思考：verify…」；名稱寫錯（例 `OLLAMA_NO_THINK=verfy`、`OLLAMA_NUM_CTX_EXTRCT_OCR`）、值不是正整數、寫了沒有作用的（本來就不思考的 agent、輸出上限沒有比原本小）各印一行警告——之前這些會被靜默忽略。認得的 agent 名稱在 `KNOWN_AGENTS`（單元測試掃原始碼確認沒有漏列）。
- 重錄（`record_local.bat`）：這三個設定與 `VISION_MAX_EDGE_PX` 同一個做法——**錄製時照 `.env` 帶進去**（錄的就是平常用的設定，eval 量到的就是那個品質），回放時一律擋掉（`eval/lib/suiteProcess.js` 的 `LOCAL_TUNING_PATTERN`）。所以開了 `OLLAMA_NO_THINK=verify` 再重錄，variant suite 的驗算閘門通過率量到的就是不思考的版本。
- 〔審查修正〕`perf:local` 的推算方法（`eval/tools/local_perf_report.js` 的 `estimateSpeeds`、`SPEED_RULES`）：前綴＝agent＋模板（分類與出變式再加科目，看回答的章節）；冷的讀速只用這一批裡這個 agent 第一次出現的呼叫（排除這一批的第一支、離上一支超過 5 分鐘的、讀不到 1,000 token 的、輸出占延遲一半以上的）；中間夾了別的呼叫再送一次的同一段 prompt 用來推快取份數。第 1.5 段的公式閘門與第 1.6 段的重現性看全部回放檔（不看 `--vendor`／`--since`）。OCR 整理的固定提示詞與每頁 OCR 文字、每題輸出每次重算（`extractOcrTokenEstimate`）。

#### 5. 另外發現、本分支沒有改的（待 Owner 決定）

- **公式的反斜線被 JSON 吃掉（品質問題，不是速度問題）**：模型在 JSON 字串裡把 LaTeX 寫成單一反斜線時，`\frac`、`\times`、`\theta`、`\text`、`\rightarrow`、`\beta`、`\neq`、`\nu`、`\nabla` 的 `\f`、`\t`、`\r`、`\b`、`\n` 是合法的 JSON 跳脫，解析後變成換頁、tab、歸位、退格、換行字元（`\frac{1}{2}` → 換頁＋`rac{1}{2}`、`\neq` → 換行＋`eq`）；`\circ` 這種不合法的跳脫則被 Ollama 的 JSON 文法硬改成別的字（回放檔裡有「歸位字元＋`circ`」），不一定留下控制字元。本機回放檔（第 1.5 段；`\n` 開頭的指令也算、避開真的換行，仍是**下限**）：變式 60 支**至少** 49 支、分類 92 支**至少** 10 支、驗算 20 支**至少** 1 支。**60 支變式裡有 38 支帶著這種壞公式通過了公式閘門**（例 `\times` → tab＋`imes`，規則層看不出來），會入庫、匯出 Word 時公式是壞的；對照 Gemini 出的變式 87 支有 11 支有控制字元、10 支照樣通過閘門。會觸發 lint LLM 的 11 支與 4 支 lint 輸入也都有這種字元，但把控制字元修回之後它們仍有別的錯（11／11、4／4 仍不過；例如系統不支援的 `\textbf`、`\bullet`，少反斜線的 `sqrt`），所以 lint 那幾次 9 分鐘的呼叫**不是**主要由它造成。修法可以是在 Ollama 轉接層解析 JSON 前修回（只修「控制字元＋已知 LaTeX 指令」），或在 `formulaFix` 加一條規則；後者會讓 lint 的回放檔鍵改變、要重錄。`npm run perf:local` 第 1.5 段會持續計數。〔整合：同一件事的另一份計數（`npm run embed:thresholds` 報告第 7 節）與給 R6 的補充見 10.13 第 4 點；產品端的修補在 `dec/latex-escape-repair`，本次整合沒有併入。〕〔整合 2026-09-27 `dec/integration-final5`〕已併入（`services/llm/latexEscapeRepair.js`，[`llm.md`](llm.md) 第 10 節）；replay 也修，所以 variant 回放的變式題幹變成新字串，向量檔查不到的從 1 次變 29 次，要整步重錄 variant 才恢復（[`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md) O-1 選項 1 的代價）。
- **驗算「不一致」時整個節點重跑一次**：原本建議「本機溫度 0、重跑多半得到同一個答案，可以考慮把 `maxRetries.verify` 設 0」，**證據不夠**：本機的 `answer_mismatch` 重跑沒有任何資料，只有 2 支 uncertain 的第 2 次採樣（最終答案都與第 1 次相同，**n=2**）；而且溫度 0 在 Ollama 上不能逐字重現（第 1.6 段：30 對同一段變式 prompt 只有 12 對輸出逐字相同），重跑可能換到不同的答案、救回一題。**建議先照現狀上傳幾份卷**，用 `npm run report:jobs -- --since=7d` 看「verify 的驗證關係」裡新加的幾列（answer_mismatch 之後原地重跑：重跑後通過／仍不一致／其他）再決定：重跑後通過的很少，再把本機模式的重跑關掉（或重跑時換一種問法）；不少就維持。
- **思考模式用溫度 0**：`services/llm/ollama.js` 一律送 `temperature:0`。Qwen3 官方模型卡對思考模式的建議是溫度 0.6、top_p 0.95、top_k 20，並寫明不要用 greedy（可能品質下降、無止境重複）。改取樣參數不影響回放檔的鍵，但輸出更不可重現（現在溫度 0 也只有一部分逐字相同，第 1.6 段）；若 (c1) 不採用、繼續讓驗算思考，可以一併考慮。
- **分類的 prompt 快取與處理順序**〔審查修正：原本寫「分類的長 prompt 每題都被擠掉」，與回放檔矛盾〕：回放檔顯示 Ollama 至少留著 3 份 prompt 快取（第 1.3 段：15 次同一段變式 prompt 中間夾了 1～2 支 lint 或驗算再送一次，第二次全是熱的）。所以在 Owner 目前的設定下，一題接一題（分類 → lint → 驗算 → 向量 → 下一題分類）時分類的前綴**多半不會**被擠掉；**只有** `OLLAMA_NUM_PARALLEL=1`（只剩一份，驗算一跑就擠掉）或 `OLLAMA_MAX_LOADED_MODELS=1`（向量模型把 qwen3:8b 擠出記憶體，快取跟著清空）時才會每題都冷。那時改成「整份卷先全部分類、再全部驗算」才有用：few-shot 同一科每題相同（`FEATURE_SIMILAR` 關）時每題約 51 秒而不是整段冷的約 7 分（差約 6 分；原本寫的「1 分 vs 3 分半」低估了一倍多）；`FEATURE_SIMILAR` 開時 few-shot 每題不同，只省得到共同前綴（系統提示詞、欄位說明、白名單、界線規則，約三到四成：每題約 7 分 → 4～5 分）。要改 runner 的認領順序。建議先照 (e) 看 `server.log` 的 parallel，決定 `OLLAMA_NUM_PARALLEL` 之後再決定這一項。

### 10.15 classify／nlq 重錄前修正（2026-09-26，`dec/local-classify-nlq-prep`；原編 10.12，整合時改號）

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
   | `exp_log_third` | 指數與對數 → 指數函數與對數函數 | 底數不是 10 的 log、`\ln`；舊題搬章規則表（`config/chapterMigrationRules.js`）裡第三冊的關鍵字（指數函數、換底、指數方程式…，直接引用、不另抄）；指數或真數含未知數，而且要「解」或「求 x／x 的值」——但題幹有第一冊的題材（首數、尾數、位數、科學記號、常用對數）時這一項不算（「已知 log x＝−2.3，求 x 的首數」「若 3^x 為 20 位數，求 x 的範圍」是 A5 的第一冊題）；前兩項明確證據不受影響 | A5 |
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
6. **回歸資料與工具**：`exam_pro/eval/fixtures/local_raw_2026-09-25.json`（`f77d1a3` 那 100 支 cassette 的 `response.data` 逐字照抄；cassette 本身不動、不搬，之後被 `cassettes:prune` 刪掉也還在）；`test/unit/localV1Regression.test.js` 逐題釘住下面第 4 點的結果；`node eval/tools/local_v1_counterfactual.js`（`--no-post` 重現 0.837／0.7419、`--raw-merge` 另印 nlq 的舊合併；設了 `TEST_DATABASE_URL` 會量 recall10）。規則的正反例與「不誤觸」檢查在 `test/unit/chapterPostRules.test.js`：知識點的名稱與說明、各章例句、fixture 62 題、classify golden 92 題裡屬於規則 from 那一章的文字，規則一律不得觸發。〔審查修正 2026-09-27〕這組「不誤觸」文字**沒有涵蓋**寫成 $\log x$ 或 $a^{x}$ 形式的第一冊題（golden 的 5 題第一冊 fx-005、fx-006、fx-008、dr-003、dr-021 都不是這種寫法），審查時實測「已知 $\log x=-2.3$，求 x 的首數與尾數」等 4 句會被 `exp_log_third` 從第一冊改成第三冊；已在「未知數＋求 x」那一項前先排除第一冊題材，4 句列為 `chapterPostRules.test.js` 的反例。改完後反事實量測不變（90/92、0.908）。「不誤觸」只證明這幾百則文字不誤觸，不代表正式題庫的寫法都不會。

#### 4. 預期重錄後的改善（反事實量測，不是重錄後的分數）

把「模型的回答」固定成 2026-09-25 的原始回應、其餘全用現行程式跑（`local_v1_counterfactual.js`）：

| suite | 指標 | 2026-09-25 | 同一份回答＋現行程式 | 門檻 |
|---|---|---:|---:|---:|
| classify | accuracy | 0.837 | **0.9783**（90/92） | 0.87 |
| classify | macro-F1 | 0.7419 | **0.908** | 0.8956 |
| nlq llm | filters_exact | 0.625 | **0.75**（6/8） | 0.72 |
| nlq llm | recall10 | 0.75 | **0.875**（7/8） | 0.845 |

- classify 改對的 13 題全是程式規則（每題的規則見第 2 點），原本答對的 77 題一題都沒被改錯。剩 cls-fx-046、cls-dr-008 兩題只能靠 v2 模板規則（物理 6、數學 7）讓模型自己改。**推定**會改善的依據：v1 模板完全沒有這兩組界線；Gemini 用 v1 就答對了這兩題。反面的依據：物理相鄰章的對錯在兩個模型之間並不一致（Gemini 錯、qwen3 對的有 cls-fx-041、fx-047、fx-048、dr-013），重錄後可能此消彼長。
- **nlq llm 欄的 0.75（6/8）與 recall10 0.875 不是本分支的功勞**：040 改對、042 改對一半，都來自 `local/integration` 本來就有的 v2 伺服器端檢查（`dec/x-nlq-improve` 的 `mergeLlm` 證據檢查與 `alignChapterDimension`）；本分支只是用原始回應逐句驗證。本分支加在 nlq 的界線規則（`alignChapters`）套在 repo 裡全部 24 支 nlq cassette（本機 8 支、Gemini 16 支）的回答上，**一句都沒有改到**（審查時量測、修正時重跑確認）；它目前只是預防，效果要重錄後才看得到。重錄後若模型把 nlq-040 回成第三冊、nlq-039 回成靜電學，會被 `exp_log_first`／`field_potential` 改回來。
- 重錄時間：classify 送出的文字從 4,079／2,604 字（數學／物理，含 SYSTEM）變成 4,418／2,946 字（多 8～13%），nlq 從 1,003 字變成 2,800 字（`nlq.v2` 的規則、範例與三科白名單；兩者都不含 Ollama 附加的欄位說明）。以 2026-09-25 的實測粗估：classify 約 1.5 小時、nlq 約 5～10 分鐘。

#### 5. 還剩什麼風險

1. **餘裕很小**。classify 的 macro-F1 只算 golden 裡出現的 13 章，有幾章只有 1～3 題：反事實 0.908 對門檻 0.8956，重錄後多錯 1 題「題數很少的章」就可能掉到門檻下。nlq 的 llm 欄只有 8 句，filters_exact 0.75 對 0.72、recall10 0.875 對 0.845，**各只有一句的餘裕**。
2. **模板變了，原本答對的題可能變錯**。反事實量測假設模型回答不變，但 v2 的界線規則、例句與 nlq 的範例都會改變回答。界線規則有反方向的保護（`exp_log_first`、`dimension_plane`、`coulomb`、`relative_2d`），但只在證據明確時才生效。
3. **規則是看著這 15 題寫的**。證據字照錯題的型態挑，同一批題上的改善（13/15）會高估對新題的效果；已用知識點、例句、fixture 做「不誤觸」檢查，但正式題庫的寫法更雜。規則也會改變**正式上傳**時第二層的分類結果（改過的題在 `payload.classify.adjustments` 查得到）。
4. **零成本閘門沒有套**：拆題模型（qwen3-vl）給的高信心章節不經第二層，相鄰章的錯照樣入庫（LC-3）。classify suite 刻意跳過閘門，量不到這一塊。〔Owner 2026-09-27 選 LC-3＝2，`dec/r6-gates` 已改成閘門也套，見 10.18 第 3 點〕
5. **信心沒有鑑別力**：本機模型幾乎只給 0.95 與 1，「信心低就送人工」這條路在本機模式等於不存在（第 2 點最後）。
6. **nlq-036** 的計分與模板規則 6 互相拉扯（LC-4），重錄後這一句很可能仍算錯，吃掉 nlq llm 欄唯一的一句餘裕。
7. **反斜線損壞**：`dec/latex-escape-repair` 還在審查。不影響這兩個 suite 的分數（只壞在 classify 的 `rationale`），但沒併之前，複核頁看到的分類理由仍會有「rac」「an」這種殘字。〔整合 2026-09-27 `dec/integration-final5`〕已併入：classify 的 `rationale` 回放時也會補回反斜線；`chapter` 欄不受影響，這兩個 suite 的分數不變。〔整合審查 2026-09-27 `dec/integration-final5-fix`〕加註移到本點末尾（原文不動）。`test/unit/localV1Regression.test.js` 的替身與 `eval/tools/local_v1_counterfactual.js` 的 `installRawLlm` 原本直接回傳原始回應、沒經過 LaTeX 修復，現在回傳前都先過 `latexEscapeRepair.applyToResult`，與正式回放路徑一致。實測：修復改動 10 支 classify 的 `rationale`，`chapter` 與 nlq 8 支都不變，分數與既有斷言不受影響；其中 cls-fx-027 有一處 `\f` 後接 `dg` 判不出指令，留在 `latexRepair.unresolved`，那一支的理由仍有一個控制字元。
8. 圓周運動與 K3 兩題（cls-fx-046、cls-dr-008）只能靠模型（LC-1、LC-2）。

#### 6. 決策草稿（請 Owner 決定；本分支都沒有做）

每一題都可以單獨看；「建議」只是建議。

**LC-1　分類時要不要讓模型「先寫理由、再定章節」**

〔Owner 2026-09-27 選 2〕已落實於 `dec/r6-templates`：`agents/schemas/classify.json` 的 properties、`propertyOrdering`、`required` 都改成「理由 → 章節 → 信心」，化學分類共用同一份 schema 一併生效；Ollama 與 Gemini 兩條路徑送出的 schema 都照這個順序（單元測試釘住）。見 本檔「第五輪 A 模板與 schema（2026-09-27）」一節。

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

> 〔Owner 2026-09-27 選 1〕不加；只記錄、不改程式（登錄於 [`HANDOFF.md`](HANDOFF.md) §0.00c，`dec/r6-docs-kc`）。

**LC-3　程式界線規則要不要也套在「零成本閘門」**

背景：分類分兩層。拆題模型給的章節在白名單內、而且信心 ≥ 0.8 時直接採用（零成本閘門，不呼叫分類模型）；否則才由分類模型判斷（第二層）。本分支的程式界線規則（指數／對數分冊、平面／空間、靜電學／電場與電位、一維相對速度、自由落體數值題）只套在第二層。本機的拆題模型（qwen3-vl:8b）一樣可能把 log₂ 的題標成第一冊，而且信心通常很高，會直接從閘門通過。問題：要不要把同一套規則也套在閘門上？

| 選項 | 代價 |
|---|---|
| 1. 只套第二層（現狀） | 拆題模型的相鄰章錯誤照樣入庫；classify 的 eval 量不到這一塊（它刻意跳過閘門） |
| 2. **（建議）** 閘門也套：規則判定為另一章時直接改章（仍記為閘門通過，附上 adjustments） | 正式入庫結果多一個會被程式改動的地方；pipeline eval 與 e2e 的結果可能跟著變（要重跑確認；不影響 cassette 的鍵，不必重錄） |
| 3. 閘門遇到規則衝突就不直接通過，改走第二層分類模型（之後再套規則） | 衝突的題多一次分類呼叫（本機每題約 50 秒）；pipeline 的 classify cassette 要多錄這幾題 |

建議選 2：規則只看題幹，與章節是哪個模型猜的無關；選 3 多花一次呼叫與錄製，多數情況最後得到的章與選 2 相同，但不保證——第二層的分類模型可能挑任何一章，界線規則只在它挑的剛好是規則的起點章時才會動，若第二層挑了其他章，結果以第二層為準。kNN 投票（人工標籤多數決）維持不套用。

〔Owner 2026-09-27 選 2〕已落實於 `dec/r6-gates`（10.18 第 3 點）。

**LC-4　nlq-036「斜面上物體受力平衡的題目」怎麼計分（決策單 A3 的後續）**

背景：這一句的 golden 期望章是〔摩擦力與向心力、牛頓運動定律〕兩章（2026-09-25 以「放寬」從一章改成兩章），但計分（`filters_exact`）要求「兩章都回、而且只回這兩章」才算對。`nlq.v2` 的模板規則 6 要模型「通常只回一章」（為了修 nlq-042 多列一章），兩者方向相反：模型只回〔摩擦力與向心力〕時檢索找得到相關題，這一句仍算錯。自然語言查題的 LLM 欄只有 8 句、門檻 0.72，一句就是 0.125。問題：重錄後這一句怎麼計分？

| 選項 | 代價 |
|---|---|
| 1. 維持（兩章全對才算） | 這一句大概率算錯，LLM 欄只剩一句的餘裕（反事實 6/8＝0.75） |
| 2. golden 改回單一章〔摩擦力與向心力〕 | 推翻 2026-09-25 的放寬；回〔牛頓運動定律〕或兩章都回的答案都算錯 |
| 3. **（建議）** 只對走 LLM 輔路徑（`expect_path` 為 `llm`）、期望章有兩章以上的句子，改成「回的章都在期望內、至少一章」就算對（改 `eval/lib/suiteNlq.js` 的 `filtersExact`；目前只影響 nlq-036） | **這是放寬計分**：同一個 0.72 門檻變得比較容易過，llm 欄的分數與 2026-09-25 以前不能直接比；要在 `thresholds.json` 旁註明；以後新增的多章期望 llm 句也照這個規則。規則路徑不受影響——golden 裡另一句多章期望的 nlq-050（規則路徑，期望〔向量內積、空間向量內積〕）仍要兩章全對；若不限 `llm`，nlq-050 只回一章也會算對，規則層的檢查會跟著變鬆 |

〔Owner 2026-09-27 選 3〕已落實於 `dec/r6-gates`（10.18 第 4 點）。

建議選 3：最符合當初「放寬」的本意（兩章都是合理答案），也與模板規則 6 一致；不必改 golden 的期望章、不必重錄；限定 `llm` 的句子，規則層（決定性的程式）的檢查不跟著變鬆。代價是放寬計分，Owner 若認為門檻不該被實質降低，就選 1 或 2。A3 原本說「重錄完看分數再決定」，也可以先重錄、看這一句的實際回答再選。

#### 7. 重錄後怎麼看

照 10.7 重錄 classify 與 nlq（`record_local.bat classify,nlq`）之後：

- `npm run eval:classify`：看 accuracy／macro-F1，以及「程式後處理改了 N 題的章」那一行——N 很大表示模型仍常挑到相鄰章，分數主要是程式補的；逐題的規則在報表的逐題表。
- `npm run eval:nlq`：llm 欄的逐句 `adjustments`（哪幾句被證據檢查、平面／空間、界線規則動過）。
- 兩個 suite 若只差一題未達，先看是不是 LC-2、LC-4 那幾題，再回來決定 LC-1～LC-4。
- 〔Owner 2026-09-27 選 LC-3＝2、LC-4＝3〕已落實於 `dec/r6-gates`，見 10.18。

### 10.16 第五輪 A 模板與 schema（2026-09-27）

> 分支 `dec/r6-templates`，從 `local/integration-r5`（`a670783`）開。節號暫編 10.16，〔整合 2026-09-27 dec/integration-r6〕併入順序第一，維持 10.16。依第五輪決策單落實三題：**LC-1＝2**（分類先寫理由）、**L-2＝1**（prompt 要求 JSON 字串裡的反斜線寫兩個）、**V5-6＝2**（同一藍本的兄弟變式從生成端就不一樣）。`eval/thresholds.json`、golden、既有 cassette 都沒改。三題都改了模板或 schema，對應的 cassette 要重錄，第 4 點逐一列出。

#### 1. LC-1＝2：分類的欄位順序改成「理由 → 章節 → 信心」（Owner 第五輪 LC-1 核准）

- `agents/schemas/classify.json`：`properties` 的鍵序、`propertyOrdering`、`required` 三處都改成 `rationale → chapter → confidence`。`rationale` 的說明只在開頭加「先寫這一欄，再選章節：」，其餘沿用原文（審查修正時刪掉一句 Owner 沒核准的新要求，見本節第 6 點），`chapter` 的說明改成「依上面的理由選出……」。值域、型別、`additionalProperties` 都沒動。
- **化學分類共用這份 schema**（`buildSchema('classify', { group: 'chemistry' })` 讀同一個檔，只換 chapter 的值域），所以一併生效。
- **兩條路徑都照這個順序**：
  - Ollama：`services/llm/ollama.js` 的 `toOllamaSchema` 依 `propertyOrdering` 重排 `properties` 後當成 `format` 送出。Ollama 依 `properties` 的順序產生 JSON 文法，模型只能先寫 `rationale`。系統提示裡的欄位說明（`schemaGuide`）也照這個順序列。
  - Gemini：`responseJsonSchema` 就是這份 schema 本身，`properties` 的鍵序與 `propertyOrdering` 都是理由在前。schema 被拒、拆掉 enum 重送的退路（`stripEnums`）也保留這個順序。
  - `test/unit/r6Templates.test.js` 用假傳輸與假 client 釘住兩條路徑實際送出的內容，數學／物理與化學各一次。
- 分類的 prompt 模板一個字都沒改。`classify.v2` 還沒錄過，不升版；`classify_chem.v1` 的模板也沒變，不升版。schema 的雜湊進 cassette 的鍵，兩者的鍵都會自動換掉，不會讀到舊答案。

#### 2. L-2＝1：公式規範明講「JSON 字串裡的反斜線要寫成兩個」（Owner 第五輪 L-2 核准）

- `agents/promptParts.js` 新增 `jsonBackslashRule()`。`LATEX_RULES` 加第 (5) 條，`CHEM_LATEX_RULES` 加第 (6) 條，是同一段文字，化學只把正例換成 `\ce`。原本的 (1)～(4)／(1)～(5) 一字未改。模型看到的文字：

  > 你的輸出是 JSON：上面寫的是 LaTeX 本身，寫進 JSON 字串時，每一個反斜線都要寫成兩個。正確（JSON 原文）："$\\frac{1}{2}$"、"$\\theta$"、"$\\sqrt{2}\\times 3$"；LaTeX 的換列 \\ 在 JSON 裡要寫成 "\\\\"。錯誤："$\frac{1}{2}$"——只寫一個反斜線時，\f、\t、\n、\r、\b 會被 JSON 讀成換頁、定位、換行、歸位、退格字元（\frac 變成「換頁＋rac」，公式就壞了），\c、\s 這類則會讓 JSON 不合法。

- **受影響的 agent 與模板**（都含這段規範；都錄過或可能在 Owner 私有層錄過，照慣例全部升版）：

  | agent | 模板（舊 → 新） | 誰用 |
  |---|---|---|
  | `extract` | `extract.v2` → `extract.v3` | Gemini 拆題（數學／物理） |
  | `extract_chem` | `extract_chem.v1` → `extract_chem.v2` | Gemini 拆題（化學） |
  | `extract_vision` | `extract_vision.v1` → `extract_vision.v2` | 本機看圖拆題（交叉驗證模式） |
  | `extract_vision_chem` | `extract_vision_chem.v1` → `extract_vision_chem.v2` | 同上，化學 |
  | `extract_ocr` | `extract_ocr.v1` → `extract_ocr.v2` | 本機 OCR 整理（OCR 為主與交叉驗證都用） |
  | `extract_ocr_chem` | `extract_ocr_chem.v1` → `extract_ocr_chem.v2` | 同上，化學 |
  | `variant` | `variant.v1` → `variant.v2` | 變式（也含 V5-6 的改動） |
  | `variant_chem` | `variant_chem.v1` → `variant_chem.v2` | 變式，化學（也含 V5-6） |

  沒有用到這段規範、這次**沒有改**的：`classify`、`classify_chem`、`lint`、`lint_chem`、`verify`、`verify_chem`、`nlq`、知識點標註、家教。其中 `lint` 的第三層是請模型重寫公式，它有自己的規則文字，沒有共用 `LATEX_RULES`；要不要也加這條，要 Owner 另外決定（加了就是 `lint.v3`／`lint_chem.v2` 並重錄）。已列為待決題 O-5（[`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md)）。
  〔Owner 2026-09-27 O-5 選 2，已落實於 `dec/r6-lint-v3`（從 `local/integration-r6` `6222475` 開）〕`agents/lint.js` 第三層的「要求」段落最後加一條，文字直接呼叫同一個 `jsonBackslashRule()`（不另寫措辭）：數學／物理是第 5 條、正例同 `LATEX_RULES` (5)；化學是第 6 條、正例同 `CHEM_LATEX_RULES` (6)（`\ce`）。原本的 1～4／1～5 條與兩份 SYSTEM 一字未改。模板升版 `lint.v2` → `lint.v3`、`lint_chem.v1` → `lint_chem.v2`，cassette 的鍵跟著換（repo 內 `lint.v2` 5 支、`lint_chem.v1` 0 支對不上），在 10.21 第 2、3 步重錄 variant 與 pipeline 時一起錄，不另外跑。`test/unit/r6Templates.test.js` 的「O-5 選 2」一組釘住：版號與舊版號不再註冊、規則是 lint 自己段落的最後一條且與 `LATEX_RULES` (5)／`CHEM_LATEX_RULES` (6) 逐字相同、模型照做（JSON 原文一律兩個反斜線）時 `latexEscapeRepair` 不動且 lint 放行、原文不變。
- **事後修復保留當第二道防線**（`services/llm/latexEscapeRepair.js`，`docs/llm.md` 第 10 節），程式沒改。模型照做時，JSON 原文是 `\\frac`，解析後就是正確的 `\frac`，修復必須是 no-op。`test/unit/r6Templates.test.js` 驗了三層：
  1. 規則裡的每個正例當 JSON 字串解析，得到單一反斜線的 LaTeX，`repairString` 一字不改，`applyToResult` 回傳原物件（沒有 `latexRepair` 鍵）。
  2. 假 Ollama 與假 Gemini 回一份「每個反斜線都寫兩個」的 JSON，內容含 b f n r t 開頭的指令、`\circ`、`\ce`、表格換列 `\\` 與真的換行。`services/llm.generateJson` 回的 data 等於原意，沒有 `latexRepair`。
  3. repo 內全部 cassette（五百多支）：把修好的內容當作模型照做的輸出，再寫成 JSON、解析一次，修復一處都不動。帶著救不回來的字元（例如換頁＋`dg`）的幾支除外。
  反例 `"$\frac{1}{2}$"` 解析後確實帶換頁字元，修復會補回。也就是說，規則寫的是事實，模型沒照做時修復照樣接手。

#### 3. V5-6＝2：同一藍本的兄弟變式從生成端就不一樣（Owner 第五輪 V5-6 核准）

- **呼叫方式（改之前）**：`workers/jobRunner.js` 的 `runGenerateJob` 本來就依序跑 idx 1→N，一題一次呼叫，不是平行。每次的 prompt 除了鍵裡的 idx 以外完全相同，溫度 0 下常常生出同一題（10.13 V5-6）。eval（`eval/lib/suiteVariant.js`）也是依序跑 idx 1、2。
- **prompt**（`agents/generateVariant.js`，`variant.v2`／`variant_chem.v2`）：
  - 規則加一條：數學／物理是第 6 條，化學是第 7 條。內容是「同一道藍本這次要出好幾題……若下面列有『這次已經出好的題目』，這一題必須換一個和它們都不同的情境、換一組不同的數字，不能只改問法或只換一兩個數字」。
  - 接著是「【這是這次要出的第 N 題（共 M 題）】」，再列兄弟區塊「【這次已經出好的題目（同一道藍本），這一題的情境與數字必須和它們都不一樣】」，依 idx 列出，每題最多 400 字、壓成一行。第 1 題沒有兄弟，不出現這個區塊。
  - 這兩段**放在規則之後，不放開頭**。兄弟之間，prompt 從系統提示、白名單、藍本、鄰居到規則都逐字相同，本機 Ollama 的 prompt 快取可以重用。放在第一行的話，第 2 題從第一行就分岔，白名單要整段重讀（這台電腦冷讀約每秒 8 個 token）。
- **兄弟從哪裡來**：runner 每生一題之前，用 `readVariantSiblings` 從 `job_questions` 讀回同一個 job 裡 idx 較小、已建好的列（`payload.extract.question_text`），再連同 `total: requested.count` 傳給 agent。沒通過生成節點的題不算兄弟。租約過期、整份 job 被重新認領時，前一輪已建好的列也算兄弟；`ON CONFLICT` 沒建成的那一題，兄弟就是 DB 裡既有的那一列。eval 照同樣的規則：前面 `kind: 'pass'` 的才算兄弟，`total` 是 2。
- **cassette 的鍵**：原本五個鍵後面多 `total` 與 `siblings`。`siblings` 是兄弟題幹全文 sha256 的前 16 碼，依 idx 排。題幹原文不進鍵（cassette 只存摘要，NOTICE 第 4 條）。前面兄弟不同的兩次請求，鍵一定不同，replay 不會撞同一捲帶；`feedback` 仍不進鍵。重錄時第 2 題的鍵含第 1 題**錄到的**題幹雜湊，回放時第 1 題讀回同一份回應，所以鍵對得上。
- **還沒處理的**：同一藍本「另開一個 job 再出一次」時沒有兄弟（兄弟只在同一個 job 裡），仍靠 dedup0 的 L0 雜湊（只比已入庫的題）與老師把關。溫度 0 下也不保證兩題一定不同，重錄後要看 10.13 的「換句話說」代理有沒有下降。

#### 4. 重錄影響（每一項都要重錄；本分支沒有錄任何 cassette）

| agent | 模板版本 | 為什麼鍵變了 | 要不要重錄 |
|---|---|---|---|
| `classify` | `classify.v2`（不升版，還沒錄過） | schema 欄位順序（LC-1） | 要。本來就要錄（92 筆全 miss 是既有狀態）；pipeline／e2e 裡沒過零成本閘門的題的 classify cassette 也一樣 |
| `classify_chem` | `classify_chem.v1`（模板沒變，不升版） | schema 欄位順序（LC-1） | repo 裡沒有；Owner 私有層若有，要重錄 |
| `variant` | `variant.v1` → `variant.v2` | 模板（L-2＋V5-6）、鍵多 `total`／`siblings` | **要**：本機 60 支、Gemini 87 支全部對不上。整步重錄（LLM 與向量，`record_local.bat variant`，上次 17,292 秒）。variant 題幹變了，下游 lint／verify 的 cassette 與向量檔也跟著重錄 |
| `variant_chem` | `variant_chem.v1` → `variant_chem.v2` | 同上 | repo 裡沒有；私有層若有，要重錄 |
| `extract_ocr` | `extract_ocr.v1` → `extract_ocr.v2` | 模板（L-2） | 要。pipeline／e2e 本來就缺這支（既有的 miss），錄的時候照 v2 錄 |
| `extract_vision` | `extract_vision.v1` → `extract_vision.v2` | 模板（L-2） | 只有交叉驗證模式用；repo 裡沒有。要切回交叉驗證時再錄 |
| `extract` | `extract.v2` → `extract.v3` | 模板（L-2） | repo 裡 1 支（Gemini 樣卷）對不上；CI 現在走 OCR 為主，不讀它。切回 Gemini 時要重錄。`sourceCheckSample` 單元測試與 `calibrate_source_check` 讀的是那支檔案本身（依 `meta.template` 找），不受影響 |
| `extract_chem`、`extract_vision_chem`、`extract_ocr_chem` | 各 +1（v2） | 模板（L-2） | repo 裡沒有；私有層若有，要重錄 |
| `lint`、`verify`、`nlq`、知識點標註、家教 | 不變 | — | 鍵沒變；只有吃到新 variant 題幹的那幾支會 miss（上面 variant 那一列）〔Owner 2026-09-27 O-5 選 2，`dec/r6-lint-v3`〕`lint` 另升 `lint.v3`、`lint_chem` 升 `lint_chem.v2`（上面第 2 點的加註）：lint 的鍵全部換掉，隨 variant、pipeline 一起重錄 |

建議順序：classify 與 nlq（10.15 的 `record_local.bat classify,nlq`）→ variant 整步（LLM＋向量）→ pipeline＋e2e（OCR 為主，錄 `extract_ocr.v2`）。L-2 與 V5-6 都落在 variant，同一次重錄就好，不必錄兩次（O-1、V5-6 的原建議）。

#### 5. 測試與 eval（replay）

- 單元 3,640（3,638 過、2 略過；基準 3,611 → 新增 `test/unit/r6Templates.test.js` 29 項，另外 5 支單元測試與 1 支整合測試原本釘的是舊版號，改成新版號），`check:html` 通過，integration 618 全過（全新 UTF8 測試庫、埠 5433；基準 615，`variants.pg.test.js` 新增 3 項：依序帶兄弟、重新認領時兄弟取 DB 既有列、第 1 題沒建成時沒有兄弟）。`localModeSections` 的標題檢查放寬為「10.12～10.15 之後只能接暫編的 10.16 第五輪節」。
- eval 在 replay 下與基準 `a670783` 逐項比對（同一台機器、同一組 CI 環境變數）：

  | suite | 基準 `a670783` | 本分支 | 差別的原因 |
  |---|---|---|---|
  | retrieval | 通過 | 通過（相同） | — |
  | classify | 92／92 replay miss，n/a | 92／92 replay miss，n/a | 鍵換了（schema），但 `classify.v2` 本來就沒錄過，不是新造成的 miss |
  | pipeline | 缺 `extract_ocr`（鍵 `a47b37a0…`） | 缺 `extract_ocr`（鍵 `a5918283…`） | 本來就缺；鍵因 `extract_ocr.v2` 換了 |
  | nlq | 8 筆 replay miss | 相同 | — |
  | variant | `retrieved_coverage` 0.2333；replay miss 2、缺向量 29，`gate_pass_rate` n/a | `retrieved_coverage` 0.2333；**replay miss 60**，`gate_pass_rate` n/a | **本分支新造成**：`variant.v2` 讓 60 次生成全部對不上（原本 58 次讀得到），要整步重錄。分數欄仍是 n/a（原本就是） |
  | classify_chem | 沒有 cassette，略過 | 相同 | — |
  | e2e（`npm run test:e2e`，12 項） | 3 項紅（缺 `extract_ocr`） | 同樣 3 項紅（缺 `extract_ocr`，鍵 `a5918283…`） | 本來就缺；鍵因 `extract_ocr.v2` 換了 |

#### 6. 審查修正（`dec/r6-templates-fix`，2026-09-27）

審查意見 4 條（都是 minor），逐條驗證後處理如下：

1. **LC-1 的 `rationale` 說明多了一句新要求**（「規則裡若有相鄰兩章的界線，寫出你依哪一條判斷」）——屬實。Owner 核准的是「先寫理由再選章」的欄位順序，沒有核准新的輸出要求，所以**刪掉這一句**，只留開頭的「先寫這一欄，再選章節：」，其餘回到 `a670783` 的原文。欄位順序、`chapter` 的「依上面的理由選出……」不變。schema 雜湊又換了一次，但 `classify.v2` 還沒錄過、repo 裡沒有 `classify_chem` cassette，不多造成重錄；`classify.v2` 不升版。
2. **lint 第三層有一段意思相同的公式規則，沒有加 L-2 那條**——屬實（`agents/lint.js` 的 `lint.v2`、`lint_chem.v1` 各自寫規則，不共用 `LATEX_RULES`）。Owner 的原話是「`LATEX_RULES` 或等效共用段落」，lint 那段算不算「等效」要 Owner 裁定，這個分支不改。已在 `owner-pending-decisions-r5.md` 新增 **O-5**。repo 內 `lint.v2` cassette 5 支、`lint_chem.v1` 0 支。〔Owner 2026-09-27 O-5 選 2〕已落實於 `dec/r6-lint-v3`（本節第 2 點的加註）。
3. **`localModeSections` 的標題檢查放寬了**——屬實，但這一輪每組都要加暫編的 10.16 節，不放寬就過不了；10.12～10.15 的原檢查沒有降低。依審查建議**這個分支不改**，整合重編節號時改回逐一列出每個節號與標題。〔整合 2026-09-27 `dec/integration-r6`：已改回逐一列出 10.12～10.20 每一節的節號與標題。〕
4. **`generateVariant.js` 註解版號過時；`calibrate_source_check.js` 綁死 `extract.v2`**——註解屬實，已改成 `variant_chem.v2`（只是註解，不進模板雜湊）。`calibrate_source_check.js`（與 `test/unit/sourceCheckSample.test.js`）依 `meta.template === 'extract.v2'` 找樣卷 cassette：repo 裡現在就是那一支，行為正確，依審查建議**現在不改程式**，只在工具裡加註「切回 Gemini、用 `extract.v3` 重錄並刪掉舊檔時，這裡與 `sourceCheckSample` 測試要一起改」。

驗證：unit、`check:html`、integration（5433 全新 UTF8 測試庫，用完已刪）都重跑通過。

### 10.17 第五輪 B 本機呼叫調整（2026-09-27）

> 分支 `dec/r6-local-tuning`（從 `local/integration-r5` `a670783` 開）。節號原暫編 10.16，〔整合 2026-09-27 dec/integration-r6〕依併入順序改號為 10.17。
> 依據：[`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md) C 系列，Owner 2026-09-27 第五輪的選擇。C-b、C-c、C-f 照做（程式改動，**Owner 第五輪核准**）；C-a、C-d、C-e、C-g、C-h、C-i 只記錄、不改程式。

#### 1. 做了什麼（三項，都只在本機模式生效）

「本機模式」＝這一次呼叫的模型是 `ollama:…`（`services/llm/index.js` 的 `adapterOpts` 依 vendor 分派；runner 看這個節點實際呼叫的模型）。Gemini 路徑與回放（replay）一個字都不讀。

| 題號 | Owner 的選擇 | 程式預設 | 怎麼覆寫（`exam_pro\.env`） |
|---|---|---|---|
| C-b | 2 知識點標註不思考 | `OLLAMA_NO_THINK` **沒寫或空字串**＝`kc_tag`（`services/llm/localTuning.js` 的 `LOCAL_DEFAULTS.noThink`） | 寫了就**整個取代**預設：`OLLAMA_NO_THINK=none`＝kc_tag 照舊思考；`OLLAMA_NO_THINK=lint,kc_tag`＝兩個都關（只寫 `lint` 的話 kc_tag 會恢復思考） |
| C-c | 2 驗算只降輸出上限 | `OLLAMA_MAX_OUTPUT_VERIFY` 沒寫＝3072，`verify` 與 `verify_chem` 都是（`LOCAL_DEFAULTS.maxOutput`）；**思考照舊** | 寫別的值就照寫的（只降不升照舊）；寫 `8192`（程式原本的上限）＝取消預設；化學版可另寫 `OLLAMA_MAX_OUTPUT_VERIFY_CHEM` |
| C-f | 2 截斷不重試、進複核 | Ollama 回 `done_reason: length`（`finishReason='MAX_TOKENS'`）而 JSON 不完整時，classify／lint／verify 不退避重跑，**一次就** `needs_review('output_truncated')` | 沒有開關（與第四輪 V3「本機逾時只重試 1 次」同一個慣例）；Gemini 模式照舊重試 3 次 |

C-f 的細節：

- 節點：`agents/verify.js`、`agents/lint.js`、`agents/classify.js` 的 error outcome 多帶 `finishReason`（供應商有回報才帶；沒有時 outcome 與之前逐鍵相同）。`agents/tagKc.js` 也帶，但知識點標註不在狀態機裡（入庫後的掛鉤），只記下來。
- 狀態機（`pipeline/stateMachine.js`）規則 6a：error、`finishReason='MAX_TOKENS'`、`limits.retryTruncated === false` → `needs_review('output_truncated')`，計數器不動。`retryTruncated` 沒給＝照舊重試，`DEFAULT_LIMITS` 沒有多欄位。預算用盡仍先是 `budget_exceeded`。
- runner（`workers/jobRunner.js`）：`meteredLlm` 記下這個節點最後一次呼叫的模型（`meter.lastModel`；失敗時也有），是 `ollama:…` 才給 `retryTruncated:false`。`job_events` 照實記 `error_class='schema_invalid'`（JSON 確實不完整），`detail.finish_reason` 另記截斷——`report:jobs` 的 review_reason 分佈會多一列 `output_truncated`。`detail.finish_reason` **只在這次呼叫的模型是 `ollama:…` 時記**（本機沒被截斷的 error 也記，例 `STOP`）；Gemini 的 `schema_invalid` 雖然也帶 finishReason（`services/llm/gemini.js`），Gemini 路徑的事件 detail 照舊、不多這一欄。其餘事件（沒有 finishReason 的 error、pass、fail、skipped）的 detail 與之前相同。
- 複核原因選**新值** `output_truncated`（migration `0020_output_truncated_review.sql`，照 0009／0015／0019 以完整值域重建 CHECK、可重複套用），不沿用 `schema_invalid`：後者的說明是「JSON 損壞，重跑通常就會過」，對截斷的題正好相反。複核頁標籤「本機模型回應被截斷」。classify、lint、verify 被截斷都進這個原因，而複核頁拿不到是哪一步（error 路徑不寫 payload），所以說明句不綁特定步驟：叫老師自己核對；驗算被截斷可調高 `OLLAMA_MAX_OUTPUT_VERIFY`（本機預設 3072，最高到原本的 8192）後重跑；分類（沒設上限）與題目檢查（已是原本的 8192）的 `OLLAMA_MAX_OUTPUT_<步驟>` 只降不升、調不高，被截斷多半是上下文長度不夠（`OLLAMA_NUM_CTX_CLASSIFY`／`_LINT`），或 `.env` 自己把上限調低過。要知道是哪一步，看 `job_events` 那一題最後一筆 error 事件的 `node`。
- **資料庫還沒套 0020**（Owner 忘了 `npm run migrate`）：runner 寫之前查一次約束，不接受 `output_truncated` 就退回原本的原因（`schema_invalid`）、仍然不重試，伺服器視窗印一次「先 npm run migrate」。不會撞 CHECK、也不會卡住佇列（與 0019 的處理不同：ocr 模式每題都會用到 `ocr_only`，所以整個佇列先停；截斷很少見，不值得為它停佇列）。**已知的過渡落差**：這段期間以 `schema_invalid` 進複核的本機題，其實是被截斷、一次都沒重試；複核頁對 `schema_invalid` 的說明（「重試已用盡。重跑這一題通常就會過」）對它們不成立，重跑多半還是會截斷。伺服器視窗那一行訊息也寫明這點；套上 0020 之後新進複核的題就是 `output_truncated`（已經進複核的舊題不會自動改原因）。
- **範圍限制**：截斷不重試只接在狀態機的節點（classify、lint、verify）。**變式產生（`runGenerateOne`）與拆題分塊（`runExtractChunk`）不在範圍內**——兩者各有自己的重試迴圈（`DEFAULT_LIMITS.maxErrorRetries`），本機被截斷時仍照舊重試最多 3 次（拆題分塊的逾時另有第四輪 V3 的 1 次上限）。知識點標註（kc_tag）不在狀態機裡，只把 finishReason 帶出來、不影響重試。

啟動時（`LLM_MODE` 是 live／record、文字模型是 ollama）印的那一行多列本機預設，例：

```
[ollama] 本機調整（docs/local-mode.md 第 10.14 條；只在模型是 ollama:… 時套用）：不思考：kc_tag（本機預設，Owner 第五輪 C-b；OLLAMA_NO_THINK 有寫就整個取代）；輸出上限：verify、verify_chem 3072（本機預設，Owner 第五輪 C-c；OLLAMA_MAX_OUTPUT_VERIFY 可覆寫）
```

`npm run local:bench-text` 的「思考」「輸出上限」會標「本機預設」或「.env 的 …」；`npm run perf:local` 第 4 段的「現狀」把 kc_tag 當成不思考。

#### 2. 回放檔（cassette）要不要重錄

- **鍵不變**：cassette 的鍵是 agent／modelId／模板雜湊／schemaHash／cacheKeyParts（`services/llm/cassette.js`），思考開關（`think`）與輸出上限（`num_predict`）**都不在鍵裡**；本分支沒有改任何模板、schema、prompt。所以既有回放檔全部照樣命中，`npm run eval` 在回放下與 `a670783` 相同（第 4 點）。
- **內容**：錄製時會把實際送出的值記在 `request.ollamaOverrides`（例 `{ "numPredict": 3072 }`、`{ "think": false }`），不在鍵裡。
  - verify（`verify.v1`、`qwen3:8b` 20 支）：錄的時候上限 8192，但實際最多寫 1,285 token，**沒有一支超過 3072**，照新預設重錄預期結果相同。不必為了這個重錄；下次照 10.7 整步重錄時自然會帶上新的上限。
  - kc_tag：repo 裡沒有任何 kc_tag 回放檔（B12 試標還沒做），沒有東西要重錄；之後錄的就是不思考的版本。
  - C-f 不影響回放：回放讀不到「被截斷的錯誤」（cassette 只存成功的回應）。

#### 3. 同時記錄、不改程式的決定

| 題號 | Owner 的選擇 | 現狀／說明 |
|---|---|---|
| C-a | 1 lint 維持思考 | `OLLAMA_NO_THINK` 的預設不含 lint |
| C-d | 1 `num_ctx` 維持 16384 | `.env.example` 的 `OLLAMA_NUM_CTX=16384` 不動；C-e 量完若確定在換頁再回頭看 |
| C-e | 2 先量再決定 | 在 Owner 的電腦上量，見下面第 5 點 |
| C-g | 1 驗算不一致維持重跑一次 | `DEFAULT_LIMITS.maxRetries.verify=1` 不動（注意：這是 `answer_mismatch` 的重跑，與 C-f 的截斷無關） |
| C-h | 1 溫度 0 | `services/llm/ollama.js` 照舊送 `temperature: 0` |
| C-i | 1 分類一題接一題 | runner 的認領順序不動 |

#### 4. 測試與 eval

- 單元：`test/unit/localTruncation.test.js`（新：狀態機規則 6a、四個節點帶 finishReason、Ollama `done_reason=length` 經 services/llm 送出 3072、runner 假 db 的本機／Gemini／沒套 0020 三種情況、複核頁標籤）；`test/unit/localTuning.test.js`、`localBenchText.test.js`、`localPerfThinking.test.js` 補本機預設與覆寫（原本「什麼都沒寫＝與之前逐位元相同」的斷言改在「取消預設」的設定上做，斷言本身不變）；複核原因白名單的三則枚舉照 LM-3 先例由 11 個更新為 12 個。
- 整合：`test/integration/localTruncation.pg.test.js`（真 PostgreSQL：0019 為止拒絕 `output_truncated`、套 0020 後接受、再套一次不動；runner＋真的 verify agent 在本機模型截斷時一次就停在 `output_truncated`，Gemini 時照舊重試）。
- eval（回放）：與 `local/integration-r5`（`a670783`）逐 suite 比對相同，本分支沒有新造成的 replay miss（第 2 點）。

#### 5. C-e 要量什麼（在 Owner 的電腦上，約 30 分）

照 10.14「(e) 的細節 → 怎麼量」，順序：

1. `ollama ps`：看載入了哪些模型、各佔多少記憶體（新版有 CONTEXT 欄，應是 16384）。
2. `%LOCALAPPDATA%\Ollama\server.log` 搜 `parallel`（並行槽數；3～4 就是 10.14 說的多份 KV cache）、`n_ctx`（實際 context＝num_ctx×槽數）、`loading model`（一份卷換載幾次）。
3. 開著「工作管理員 → 效能 → 記憶體」（使用中、認可、**已使用的插槽**看是不是單通道）與「資源監視器 → 記憶體」（硬錯誤/秒），同時跑：

   ```bat
   cd /d C:\你的路徑\tutor-exam-bank\exam_pro
   npm run local:bench-text -- --agent verify
   ```

   不加參數＝正式上傳現在的樣子，已經帶本機預設的上限 3072（報告的「輸出上限」一欄會寫「本機預設」）。要比「降 num_ctx」或「不思考」時同一題再跑 `--num-ctx 8192`、`--no-think`；要比加預設之前的樣子加 `--max-output 8192`。這幾個參數 `local:bench-text` 都支援（`test/unit/localBenchText.test.js` 釘住）。
4. 把 1～3 的結果（parallel、n_ctx、記憶體使用中／認可、硬錯誤/秒、bench 的「輸出 token/秒」）貼回來，再決定 C-e 的 3／4 與 C-d、C-i。

#### 6. 審查修正（2026-09-27，`dec/r6-local-tuning-fix`）

審查（approve、4 個小問題）逐條驗證都成立，修正如下（仍是 Owner 第五輪 C-f 核准的範圍，沒有新決定）：

1. 複核頁 `output_truncated` 的說明句原本寫死「驗算上限 3072 token」與「調高 `OLLAMA_MAX_OUTPUT_VERIFY`」，classify／lint 被截斷時建議是錯的 → 改成不綁步驟的寫法（第 1 點 C-f 細節）。複核頁拿不到節點，所以沒有依節點分列；也沒有為此在 payload 多寫鍵（payload 的鍵是凍結的）。
2. `job_events.detail.finish_reason` 原本不分供應商都寫，Gemini 的 error 事件也會多這一欄 → 改成只在本機模型時寫，Gemini 路徑的事件與之前相同（單元與整合測試都改成斷言 Gemini 事件**沒有**這一欄）。
3. 變式產生與拆題分塊不在截斷不重試的範圍內 → 寫進第 1 點 C-f 細節的「範圍限制」。程式不改（Owner 核准的是狀態機節點）。
4. 沒套 0020、退回 `schema_invalid` 時複核頁說明與實情不符 → 程式行為不改（過渡情況），在伺服器視窗訊息 `OUTPUT_TRUNCATED_SCHEMA_MESSAGE` 與第 1 點 C-f 細節註明。

### 10.18 第五輪 C 閘門與計分（2026-09-27）

分支 `dec/r6-gates`（從 `local/integration-r5` `a670783` 開；節號原暫編 10.16，〔整合 2026-09-27 dec/integration-r6〕依併入順序改號為 10.18）。五題都照 Owner 第五輪的決定做，程式、測試與 commit 都標「Owner 第五輪 <題號> 核准」。**`eval/thresholds.json`、golden、既有 cassette 一個位元都沒動**；沒有改任何模板、schema 或 prompt。

#### 1. L-1＝1：公式閘門擋下換行以外的控制字元（Owner 第五輪 L-1 核准）

- `utils/formulaLint.js` 的 `ISSUE_RULES` **最後面**加一條 `control_char`（`error`）。這個名字會永久進 `job_events.detail` 與 `report:jobs`，之後不能改。訊息寫出是哪個字元（例「換頁 U+000C」）與「多半是 LaTeX 的反斜線被 JSON 吃掉」。
- 範圍：C0 控制字元 U+0000～U+001F 與 U+007F（與 `latexEscapeRepair.hasNonNewlineControl`、`docs/llm.md` 第 10 節「帶控制字元」的定義相同，但 Windows 換行 `\r\n` 裡的歸位不算；`hasNonNewlineControl` 是回歸量測用的計數，連這個歸位也算進去）。**例外只有換行**：U+000A，以及 Windows 換行 `\r\n` 裡的歸位；單獨的歸位照擋（`\rho` 被吃掉＝歸位＋`ho`），定位也擋（`\times`、`\theta`）。同一條規則最多回報 5 筆（`MAX_PER_RULE`）。
- 走到哪裡：題幹（含選項，選項寫在 `question_text` 裡）與答案經 `agents/lint.js` 的 `gate` → 有 `control_char` 就是 error → **送第三層公式重寫**（`cacheKeyParts.issues` 帶 `control_char`）；重寫後還有控制字元照樣 `fail(formula_unparsable)`。複核頁送出（`reviewController`）也用同一個 `formulaLint`，所以老師核准時仍帶控制字元會被擋（可勾「接受純文字降級」）。**手動貼上的定位字元（tab）也算**：例如老師從 Word 貼上用 tab 對齊的選項排版，送出會回 400，要先把 tab 換成空白，或勾「接受純文字降級」；拆題模型（含 Gemini）的輸出若帶 tab，也會多走一次 lint 重寫。repo 內現有的 Gemini extract、verify 回放檔經 `latexEscapeRepair` 修過之後控制字元都是 0，目前資料不受影響。〔審查意見補充，`dec/r6-gates-fix`〕
- 詳解：verify 在 lint **之後**才跑，詳解沒有公式重寫可以送。`workers/jobRunner.js` 的 `buildSolutionFields` 與 `scripts/backfill_solutions.js` 改成「詳解還有換行以外的控制字元就不寫」（兩欄 NULL；回填腳本的略過原因記 `control_char`）。判準共用 `formulaLint` 新匯出的 `findControlChars`。
- 量測（repo 內現有 cassette，經 `latexEscapeRepair` 修過之後跑 `lint.gate`；工具就是 `test/unit/latexEscapeRepair.test.js` 第 5 組）：

  | | 本機 variant 60 支（qwen3:8b，2026-09-25） | Gemini variant 87 支 |
  |---|---|---|
  | 改之前（`a670783`） | 47 過／13 擋；帶控制字元卻通過 3 支 | 86 過／1 擋；帶控制字元卻通過 0 |
  | 只做 L-1 | **44 過／16 擋**（與 `docs/llm.md` 第 10 節的估計相同：剩下「換頁＋`dg`」的 3 支 `38d651f8`、`85e979cf`、`aabdbb41` 改成擋下） | **86／1 不變**（剩下那支本來就被擋） |
  | 只做 L-3 | 53 過／7 擋；帶控制字元卻通過 3 支 | 86／1 |
  | L-1＋L-3（本分支） | **50 過／10 擋**；帶控制字元卻通過 **0** | 86／1；0 |

  修復**之前**的原始回應也一起算：本機 49 過 → 11 過、Gemini 86 → 76 過（帶控制字元的一支都過不了）。剩下擋下的 10 支：`\root` 2 支、`\norm` 2 支、`\big`／`\bigg` 2 支（解析器不支援，`unknown_command`）、「換頁＋`dg`」3 支（`control_char`）、`$` 不成對 1 支。

#### 2. L-3＝1：解析器支援 `\bullet`、`\textbf`（Owner 第五輪 L-3 核准）

- `utils/textFormatter.js`：`\bullet` 加進 **`EXTRA_SYMBOLS`**（只給 Word 匯出，排成 U+2219 `∙`）；`\textbf{…}` 是 `parseCommand` 的特判（與 `\mathbf` 相同只取內容，不另設粗體），列進 `PARSER_COMMANDS`。**沒有動 `SYMBOLS`**，`utils/embedText.js` 也沒動。
- 既有題目的 `embed_text` 不變：`test/unit/formulaBulletTextbf.test.js` 把含 `\bullet`、`\textbf` 的三句在 `a670783` 算出的 `embed_text` 寫死比對，並確認 fixture 62 題的 `sha256(embed_text)` 仍全部查得到本機向量檔。
- `services/llm/latexEscapeRepair.js` 的 `UNSUPPORTED_LATEX_COMMANDS` 移出這兩個（修復表照樣認得：`supportedCommandNames()` 涵蓋）。
- 效果：還原出 `\bullet`／`\textbf` 的 6 支本機變式（`288f5abc`、`42633f8b`、`578ea572`、`fc040873`、`7bdc13c6`、`c55a3ee6`）改為通過閘門、不必走 lint 重寫。`docs/llm.md` 第 10 節原本寫「4 支由通過變擋下」，另外 2 支（`7bdc13c6`、`c55a3ee6`）是修復前就被擋、修復後仍因這兩個指令被擋的。

#### 3. LC-3＝2：界線規則也套在分類的零成本閘門（Owner 第五輪 LC-3 核准）

- `agents/classify.js`：拆題模型的章在白名單內、信心 ≥ `CLASSIFY_MIN_CONF` 時，先用同一張界線規則表（`utils/chapterPostRules.js` 的 `boundaryTarget`）看題幹；規則判定要換章就**直接改章，仍記為閘門通過**（`source:'gate'`、不呼叫 LLM），`data.adjustments` 記規則、原本的章與證據，`rationale` 前面加「〔界線規則：拆題模型給「…」，依題幹的「…」改為「…」〕」。沒觸發的題 `outcome.data` 與改版前逐鍵相同。kNN 投票照舊不套。入庫的 `chapter_src` 仍是 `ai`（`gate` → `ai`，對照表不變）。
- 不誤觸（`node eval/tools/local_v1_counterfactual.js --gate`，新選項；單元測試釘住同樣的數字）：
  - ① classify golden 92 題以「拆題模型給對的章、信心 1」走閘門：**被改 0 題**。fixture 62 題以自己的章走閘門：被改 0 題。
  - ② 以 2026-09-25 分類模型的原始回答**代用**成拆題模型的章（拆題模型的章沒有錄過）：閘門前 77／92 對 → 閘門後 90／92 對，改對 13 題、**改錯 0 題**（就是 10.15 第 2 點那 13 題）。
  - classify suite 本身刻意跳過閘門，反事實量測仍是 0.9783（90/92）、macro-F1 0.908，不變。
- 不影響任何 cassette 的鍵（閘門不呼叫 LLM）；pipeline eval 與 e2e 的閘門結果可能跟著變，要等 `extract_ocr` 錄好才看得到。

#### 4. LC-4＝3：nlq 的多章期望放寬計分（Owner 第五輪 LC-4 核准）

- `eval/lib/suiteNlq.js` 的 `filtersExact(expect, got, { expectPath })`：**只有** `expect_path` 為 `llm`、期望兩章以上的句子，`chapters` 一欄改成「回的章都在期望內、至少一章」就算對；其餘三欄照舊 exact。rules 路徑（例：nlq-050 期望〔向量內積、空間向量內積〕）與單章期望照舊兩章全對。不傳 `expectPath` 時與改版前逐位元相同（`localV1Regression` 的既有斷言不變）。目前 golden 只有 **nlq-036** 套用。
- 報表註明：`eval:nlq` 的警告多一行「llm 欄 filters_exact 為放寬計分（Owner 第五輪 LC-4 核准）…與 2026-09-25 以前的分數不可直接比」，報表 JSON 的 `meta.scoring` 記計分規則與套用的句子，逐句的 `perEntry[].lenient` 標出用了放寬規則的句子。**門檻 0.72 不動。**
- 反事實量測：同一份 2026-09-25 回答仍是 6/8（nlq-036 回的是期望外的〔直線運動〕，放寬後照樣錯）；放寬只在重錄後模型回〔摩擦力與向心力〕或〔牛頓運動定律〕其中一章時才有差。

#### 5. D-2＝3：pipeline eval 在 OCR 模式把 saved_rate 印成 n/a、加替代指標（Owner 第五輪 D-2 核准）

- OCR 模式的判斷（`eval/lib/suitePipeline.js` 的 `isOcrOnlyRun`）：拆題模型是 ollama 而且 `LOCAL_EXTRACT_MODE=ocr`（與 runner 相同），或任何一題的 `payload.extract.extract_mode` 是 `ocr`。
- `saved_rate`：OCR 模式印 `n/a`（報表註明「OCR 模式每題都停在人工複核，設計上恆為 0，不比門檻（Owner 第五輪 D-2）」），**不比門檻**。做法是 suite 回報 `notApplicable`，`eval/lib/thresholds.js` 的 `compareSuite` 只認白名單 `NOT_APPLICABLE_ALLOWED`（目前只有 `pipeline.pipeline.saved_rate`；其他組合丟錯），略過的列在「未設門檻（只報告不擋）」那一行。交叉驗證與 Gemini 模式照舊比 0.87。`thresholds.json` 不動；`--write-baseline` 遇到 n/a 照舊保留原值。
- 替代指標「**人工核准前的通過率**」＝ `needs_review` 且原因 `ocr_only` 的題 ÷ 全部題（走完全部閘門、只因「只用 OCR 拆題」停下）。印在報表「結果分佈」、存在報表 JSON 的 `ocrOnly.pre_approval`；**不進 `measured`、不設門檻**，累積兩三次實測後再請 Owner 定。OCR 模式卻有題自動入庫時另印警告。
- 現在 `extract_ocr` 還沒錄，pipeline 一輪都跑不起來，兩個欄位都是 n/a（0／0）。

#### 6. 測試與 eval（2026-09-27）

- `npm test` 3645 過、0 失敗、2 略過（新增 `formulaControlChar`、`formulaBulletTextbf`、`evalPipelineOcrMode` 三個檔，並擴充 `chapterPostRules`、`nlqSuite`、`localV1Regression`）；`check:html` 通過；`test:integration` 615 過（5433 上另建的 UTF8 測試庫，用完刪掉）。
- 為了這五題改了的既有斷言（都是 Owner 核准的合約變更，不是放寬）：`latexEscapeRepair.test.js` 第 5 組的閘門數字（見第 1 點的表）；`chapterPostRules.test.js` 原本釘「零成本閘門不套用」；`classifyKnn.test.js` 的「閘門優先」一案（題幹是二維坐標，閘門現在把「空間向量內積」改成「向量內積」，另外斷言 `adjustments`）；`localPerfThinking.test.js` 注入的「公式寫錯」題由 `\textbf` 改成仍不支援的 `\vecc`（斷言不變）；`localModeSections.test.js` 原本釘「只有 10.12～10.15 四節」，改成前四節不變、末尾允許第五輪的 10.18（整合重編時一併改）。
- eval replay（CI 的本機模型設定）與 `a670783` 比對：classify、variant、retrieval 輸出相同；nlq 只多放寬計分那一行警告；pipeline 只多 D-2 的兩處說明。**本分支沒有造成新的 replay miss**：classify 92／92、nlq 8、variant 2 次生成＋29 次缺向量、pipeline 的 `extract_ocr` 都是基準本來就有的。
- 重錄影響：沒有改模板、schema、prompt。L-1 會讓 lint 的 `cacheKeyParts.issues` 在輸入帶控制字元時多一個 `control_char`、L-3 讓帶 `\bullet`／`\textbf` 的題不再呼叫 lint——repo 裡 4 支本機 lint 回放檔（2026-09-25）的輸入是修復前的原始字串，`latexEscapeRepair` 併入後本來就對不上，本分支沒有讓任何原本讀得到的回放檔失效。variant 照 O-1 本來就要整步重錄（連帶 lint、verify），不必為本分支另外錄；classify、nlq、pipeline 的回放鍵不變。

#### 7. 審查意見修正（`dec/r6-gates-fix`，2026-09-27）

審查結論是通過，3 條 minor 都先驗證再改，只動文件與註解，程式行為、測試斷言都沒變：

- 第 1 點「範圍與 `hasNonNewlineControl` 相同」不精確（確認屬實）：`hasNonNewlineControl` 用 `/[\x00-\x09\x0B-\x1F\x7F]/`，`\r\n` 的歸位也算；`control_char`（`CONTROL_CHAR_RE`）把它排除。第 1 點與 `utils/formulaLint.js` 的 JSDoc 都改成「相同，但 `\r\n` 裡的歸位不算」。
- `latexEscapeRepair.test.js` 第 5 組 Gemini 那一案的註解寫「11 支」（確認屬實）：斷言是修前 86 → 76，少的是「修前帶控制字元而通過」的 10 支（與改之前的 `passedWithCtrl[0]＝10` 相同），註解改成 10 支；斷言不動。
- 複核頁會擋手動貼上的 tab（確認屬實，在 Owner L-1 核准範圍內，行為不改）：第 1 點補一句說明，並記下目前 Gemini extract、verify 回放檔修復後控制字元為 0。

### 10.19 第五輪 D 預設值與門檻（2026-09-27，`dec/r6-defaults`；Owner 第五輪 D-3、V5-1～V5-5、O-2 核准）

> 節號原暫編 10.16，〔整合 2026-09-27 dec/integration-r6〕依併入順序改號為 10.19。本節只改「沒寫 `.env` 時的預設」：`eval/thresholds.json`、golden、既有 cassette 一個都沒動。

#### 1. D-3＝2：`LOCAL_EXTRACT_MODE` 的程式預設改成 `ocr`（Owner 第五輪 D-3 核准）

- `config/localExtractMode.js` 的 `DEFAULT_LOCAL_EXTRACT_MODE` 由 `cross` 改成 `ocr`：沒寫、空白、亂寫（警告一次）都是 `ocr`；**只有明寫 `cross` 才是交叉驗證**。只在拆題模型是 ollama 時有作用（`agents/extract.js` 的本機路徑才讀）；Gemini 模式完全不讀它，行為一個字都沒變。
- 一致的地方：`.env.example`（仍寫 `LOCAL_EXTRACT_MODE=ocr`，說明改成「與程式預設相同，要交叉驗證就明寫 cross」）、`eval/lib/localMode.js` 的 `effectiveModels`（`ci.yml` 沒寫＝`ocr`，重錄計畫不再下載看圖模型）、`rerecord_all` 的「CI 沒寫時實際用什麼」、`npm run perf:local` 3.4 段的說明、10.12 第 1、2 點與矛盾設定一段。`ci.yml` 與 `eval/.env.replay` 照舊明寫 `ocr`（CI 讀哪一組回放檔在 workflow 檔上看得見），所以 **CI 的回放與重錄內容完全不變**。
- **啟動訊息**：`jobRunner 啟動` 那一行（`npm start` 與 `node workers/jobRunner.js`）多兩個欄位：拆題模型是 ollama 時 `local_extract_mode`（例：「ocr（只用 PaddleOCR＋文字模型拆題，每題停在人工複核；程式預設，要交叉驗證就在 .env 明寫 LOCAL_EXTRACT_MODE=cross）」），以及 `thresholds`（第 2 點的五個門檻、哪幾個是 `.env` 明寫的）。
- **矛盾設定多一種**：只寫 `OCR_ENGINE=none`、沒寫 `LOCAL_EXTRACT_MODE` 以前是「只看圖、不做 OCR」，現在等於 `ocr`＋`none`。仍然不猜（不自動退回看圖：在沒有獨立顯示卡的電腦上一頁幾十分鐘，會被當成當機），**啟動時就報錯**，訊息講明「.env 沒寫 LOCAL_EXTRACT_MODE，程式預設是 ocr……要只用看圖模型、不做 OCR，加一行 LOCAL_EXTRACT_MODE=cross」。重錄工具（`recordingPlan` 的 `configError`）同一條規則。
- **受影響的測試**：原本靠「沒寫＝cross」測交叉驗證的單元測試（`extractLocal`、`visionMaxEdge`、`legacyAnalyzePdfFigures`、`extractLocalRunner`、`localMode`、`rerecordAll`、`localPerfReport`、`textModelLm15`）改成**明寫 `cross`**，斷言一個字都沒改；釘預設的測試（`localExtractMode.test.js`）改釘 `ocr`，另加：沒寫＋`OCR_ENGINE=none` 啟動就報錯、明寫 `cross` 照常建立、舊流程 `/analyze-pdf` 沒寫時只呼叫 `extract_ocr`、`perf:local` 沒寫與明寫 `ocr` 的報告逐字相同。
- `test/unit/evalPipeline.test.js` 那兩則「replay 找不到 cassette 就 skip」的：單元測試的環境沒有 `LOCAL_EXTRACT_MODE`，以前走 `cross`、缺的是 `extract_vision`（在這台電腦上錄不出來，等於永遠 skip）；改了預設之後走 `ocr`、缺的是 `extract_ocr`，**與 CI 同一支回放檔**，樣卷的 `extract_ocr` 錄好之後就會自動轉成硬斷言。〔審查更正 `dec/r6-defaults-fix`〕原本這裡寫「兩則在 `ocr` 模式下斷言的都成立，不必改」，**是錯的**：「10 題全部走到終態」那一則成立（`ocr_only` 的複核是終態），但「同一份 PDF 跑第二次」那一則有 `assert.ok(s1.saved > 0)`，`ocr` 模式每題停在 `ocr_only`、`saved` 恆為 0，錄好之後一定紅（`dup === s1.saved` 也退化成 0＝0）。已照第 4 點改。

#### 2. V5-1～V5-5、O-2：五個餘弦門檻依向量模型取預設（Owner 第五輪 V5-1、V5-2、V5-3、V5-4、V5-5、O-2 核准）

集中在一支 `config/similarityThresholds.js`（`resolveSimilarityThresholds`）：`EMBED_MODEL` 是 `ollama:`（含沒寫＝本機預設）用本機值，沒有前綴的 `gemini-embedding-001` 或 `gemini:…` 用 Gemini 值。優先順序：`.env` 明寫 > 舊名 `VARIANT_SIM_MIN`（只給兩個變式門檻）> 依模型的預設。`workers/jobRunner.js`（`loadConfig`、`loadStage3Config`；回傳形狀不變）、`services/variantService.js`（`simMin`）、`eval/lib/suiteVariant.js`、`eval/lib/pipelineDriver.js`、`npm run embed:thresholds` 的「現行值」都從這裡讀，不再各寫一份 0.97／0.80。

| 變數 | 題號 | 本機（`ollama:`） | Gemini | 說明 |
|---|---|---:|---:|---|
| `VARIANT_RETRIEVE_SIM_MIN` | V5-1＝2 | **0.72**（原 0.80） | 0.80 | 找現成相似題：fixture 上 7／30 → 15／30 個藍本有 2 題可推 |
| `VARIANT_OFFTOPIC_SIM_MIN` | V5-2＝2 | **0.87**（原 0.90，**暫定**） | 0.90 | 變式跑題；反斜線修好、variant 重錄後依 O-4 抽查再定案 |
| `DEDUP_DUP_THRESHOLD` | V5-3＝3 | **0.99**（原 0.97） | 0.97 | 重複題：dedup golden 換數字錯 3／7 → 1／7 |
| `DEDUP_VARIANT_THRESHOLD` | V5-4＝1 | 0.90 | 0.90 | 維持 |
| `KNN_VOTE_SIM` | O-2＝1 | 0.90 | 0.90 | 維持 |

- `.env.example` 這五行（與舊名 `VARIANT_SIM_MIN`）改成註解並寫明兩組預設：**明寫就一律照寫的值、不分模型**。Owner 的 `.env` 若是照舊範本建的（明寫 0.80／0.90／0.97／0.90、`VARIANT_SIM_MIN=0.80`），新預設不會生效——升級時把這幾行刪掉；啟動訊息的 `thresholds` 會把 `.env` 明寫的標成「（.env）」，一眼看得出來。
- `agents/dedup.js`、`agents/generateVariant.js`、`agents/classify.js` 裡的 `DEFAULT_*` 沒改：那是「ctx 沒帶門檻」時的保底（agent 不讀 `process.env`、也不知道向量模型；runner 與 eval 一律會帶），不是產品預設。
- `npm run embed:thresholds` 重跑、覆寫 [`local-embed-thresholds-report.md`](local-embed-thresholds-report.md)：只有「現行值」相關的幾行變了——開頭一行改列兩組預設、第 3 節「現行 0.72：覆蓋 15/30（0.5000）」、第 4、5 節標題、5.1 表本機欄依 0.99 重判（dd-nc-03、dd-nc-06 由 duplicate 改判 variant）；2.3 與第 6 節的「Gemini 現行門檻的等效值」照舊用 Gemini 的值，數字不變。
- 新測試 `test/unit/similarityThresholds.test.js`：兩組預設、依向量模型判斷（看的是向量模型、不是拆題模型）、優先順序、壞值、runner／variantService／embed:thresholds 讀到同一組數字（兩種模式）、eval 兩支不再寫死、啟動訊息。釘現值的既有測試（`jobRunner`、`variantPipeline`、`variantService`、`embedThresholds`）改成本機新值，並加上 Gemini 仍是舊值的斷言（只改數字、加覆蓋，不放寬）。

#### 3. 回放檔與 eval（replay，與 `local/integration-r5`（`a670783`）同機比對）

- **沒有任何模板、schema、prompt 改動**：沒有 agent 的回放檔鍵改變，不必為這次改動升版或重錄。
- retrieval、classify、nlq：報表與基準逐字相同（classify、nlq 本來就因缺 `classify.v2`／`nlq.v2` 的回放檔紅燈，不算）。pipeline：與基準相同（仍缺 `extract_ocr/a47b37a0…`，本來就缺）。
- variant：`retrieved_coverage` 0.2333 → **0.5000**（V5-1；門檻 0.8367 不動，仍未達）；replay miss 2 → **6**：多出的 4 筆都是 `verify`，來自 var-004、var-015、var-017——跑題門檻 0.87 之後，這幾題原本停在 `off_topic` 的變式現在過了跑題、往下走到驗算，而驗算這一步從來沒錄過（模板沒改，是「新走到的呼叫」）。這 4 筆是**本分支新造成、要重錄**的；照 V5-2 的先後順序，併進反斜線修好後那一次 variant 重錄即可（`record_local.bat variant`），不必另外錄。另外 29 筆「向量檔查無此文本」與 2 筆 `variant` miss 與基準相同。
- e2e 不受影響：`ci.yml` 明寫 `ocr`，預設改了也是同一條路。

#### 4. 審查修正（2026-09-27，`dec/r6-defaults-fix`）

- **`evalPipeline.test.js`「同一份 PDF 跑第二次」加 `ocr` 分支（測試契約變更，比照 D-1 列給 Owner：`owner-pending-decisions-r5.md` D-1 內文）**。比照 e2e 的 ①a／①b（`test/e2e/pipeline.e2e.test.js` 檔頭）：
  - 交叉驗證（明寫 `LOCAL_EXTRACT_MODE=cross`）與 Gemini 拆題：跑原本那一則，**一個字都沒改**（含 `s1.saved > 0`）。
  - `ocr` 模式（`npm test` 沒寫＝預設）：改跑另一則——第一輪 `saved`＝0、每題 `extract_mode` 都是 `ocr`、沒有 `extract_disagree`、**至少一題**走完全部閘門（六個閘門的 payload 都在）停在 `ocr_only`；模擬老師在複核頁核准這些題（把它們的 `text_hash` 放進 `dbHashes`，與 driver 對「已入庫」的同一條規則），第二輪**核准過的每一題**都被 dedup0 攔成 `duplicate`（`hit.scope＝db`）、沒核准的題（例如驗算不一致）逐題與第一輪相同、`saved` 仍是 0。
  - 模式用與 driver 相同的設定來源判斷（`MODEL_EXTRACT` 是 ollama＋`resolveLocalExtractMode()`），不看結果；`ocr` 那一則逐題斷言 `extract_mode === 'ocr'`，判斷與實際路徑不一致時直接紅。
  - 驗證：兩則目前仍因缺 `extract_ocr/a47b37a0…` skip（與基準相同）。另外用「把 LLM agent 換成確定性假件」的 preload 讓它們跑成硬斷言：`ocr`（沒寫）與明寫 `cross` 兩種模式、有無一題驗算不一致，四種組合全綠；同一個 preload 下，`510f4ea` 原本那一則在 `ocr` 模式確實紅在「第一輪至少要有入庫的題」——審查的判斷屬實。假件只在驗證時用，沒有進 repo。
- **舊範本 `.env` 的啟動提醒**（`config/similarityThresholds.js` 的 `legacyTemplateWarning`）：向量模型是本機（`ollama:`，含沒寫），`.env` 卻明寫了**剛好等於 Gemini 舊預設、又不等於本機新預設**的值（`VARIANT_RETRIEVE_SIM_MIN=0.80`、`VARIANT_OFFTOPIC_SIM_MIN=0.90`、`DEDUP_DUP_THRESHOLD=0.97`），或舊名 `VARIANT_SIM_MIN` 正在生效時，`jobRunner 啟動` 之後多印一則 warn，點名這幾行、說明「刪掉後重啟才會用本機新預設」。「`.env` 明寫優先」的規則不變（不自動忽略）；`DEDUP_VARIANT_THRESHOLD`、`KNN_VOTE_SIM` 兩組預設都是 0.90，寫了也不影響，不點名；Gemini 向量不提醒。**交付 Owner 電腦時的檢查清單**：看伺服器視窗有沒有這則提醒，有就照它刪。
- **啟動訊息照 runner 實際的 config**：`thresholds` 改由 `effectiveSimilarityThresholds(config)` 組（`workers/jobRunner.js`）——`createRunner({config})` 覆寫的門檻照實印、標「（createRunner 設定）」；`local_extract_mode` 的「程式預設／明寫」也照 `createRunner` 當下的判斷（`opts.config` 給了或 `.env` 明寫都算明寫；明寫 `ocr` 不再說「程式預設」）。正式啟動（`npm start`、`node workers/jobRunner.js`）不帶這幾個 `opts.config` 鍵，印的與原本相同。
- 測試：`similarityThresholds.test.js` 加 5 則（`createRunner` 覆寫照實印、舊範本點名三個變數、只剩舊名也提醒、三種不提醒、`runner.start()` warn 一次且門檻仍照 `.env`）。
- 沒有改模板、schema、prompt、`eval/thresholds.json`、golden、cassette；回放檔鍵都沒變，不必升版或重錄（`dec/r6-defaults` 已知要重錄的 4 筆 `verify` 照舊，見第 3 點）。

### 10.20 第五輪 E 文件與知識點（2026-09-27）

> 分支 `dec/r6-docs-kc`（起點 `local/integration-r5`＝`a670783`）。節號原暫編 10.16，〔整合 2026-09-27 dec/integration-r6〕依併入順序改號為 10.20。落實 Owner 第五輪 K-P 核准（選 3）與 O-3 核准（選 2），並登錄第五輪全部答案；**只改文件與知識點載入的測試，程式、模板、schema、prompt、`eval/thresholds.json`、golden、cassette 都沒有動**。

#### 1. K-P：物理知識點維持草稿，但允許載入（Owner 第五輪 K-P 核准）

- 查了 `scripts/load_kc.js`（參數只有 `--file`／`--dry-run`／`--force`／`--test`，預設讀 `config/kc/` 全部 `*.json`）、`services/kcService.loadSeeds`（計畫只有 insert／update／unchanged／protected／edited，沒有「草稿不載入」）、`utils/kcSeed.js`（`status` 只要是 `draft` 或 `approved` 就通過）：**程式本來就沒有擋草稿，也沒有擋物理**。擋的只是 `HANDOFF.md` A10、B15 與 §0.2 第 7 項「物理先不跑 `kc:load`」這條操作規則。所以程式不改（其他科的行為自然也不變），只把規則解除、並加測試釘住「不擋」：
  - `test/unit/kcPhysicsDraftLoad.test.js`（4 案）：repo 的 `config/kc/物理.json` 198 條全部 `draft`、單科驗證零 error（指向數學的先備只算 warning）；三科一起驗證零 error、數學已審定數仍是 4；草稿列的載入計畫照常 insert／unchanged／update；`kc:load` 預設讀到物理、`--file` 指定物理照讀、參數沒有科目或狀態過濾。
  - `test/integration/kcLoadPhysicsDraft.pg.test.js`（2 案）：以子行程跑真的 `scripts/load_kc.js --test` 與真的種子檔——數學已在庫裡時 `--file` 只載入物理：exit 0、198 列全部 `draft`、數學的列不變；空庫只載物理會被擋，原因是物理有 6 條先備指向數學、解析不到（既有的先備規則，訊息不提草稿，測試也釘住）；三科一起載入：物理仍 198 列 `draft`，數學、化學的列數與已審定數照種子檔，物理 → 數學的跨科先備照種子檔寫入，重跑一次全部「內容相同」。
- 以後若有人加了「只載入已審定」或「跳過物理」之類的過濾，這兩個檔會紅。
- Owner 要做的：`local/integration` 併入後照 `HANDOFF.md` §0.2 第 7 項，先 `npm run kc:load -- --dry-run` 看數字，再 `npm run kc:load`（不加 `--file`＝三科一起載入，跨科先備一次解析）。**只載物理（`--file config/kc/物理.json`）要在數學已經載入之後**，否則會因上面那 6 條跨科先備整批拒絕、資料庫不動。物理 198 條進資料庫都是草稿，「知識點」分頁照常可以逐條改、逐條審定；載入不會覆寫老師改過的草稿（要 `--force` 才會）。

#### 2. O-3：ADR-017 改寫為 OCR 為主（Owner 第五輪 O-3 核准，選 2）

- `engineering_docs/03_architecture/adr/ADR-017-local-first-inference.md` 升 v1.1：本機拆題＝PaddleOCR＋文字模型整理（`extract_ocr`），看圖模型只在 `cross` 模式；新增「選項四：OCR 為主」與 **§3.1 定案條件**。**狀態維持「提議中／待數據定案」**。原文全部保留，改寫處就地加〔修訂 2026-09-27〕。
- 定案條件（摘要，全文在 ADR §3.1）：① 以本機模型、`ocr` 模式重錄 classify／nlq／variant／pipeline＋e2e，五個 eval 的分數與門檻對照；② 實際上傳幾份真卷（建議至少 3 份，份數由 Owner 定）後的每卷拆題時間（`perf:local`）、OCR 版面配圖統計（`report:jobs`）、複核時要改的題數比例與每題時間。數字齊了由 Owner 決定接受、回到 `cross`，或另開 ADR。
- `engineering_tracker.md` §3 的 ADR 索引就地加註。

#### 3. 第五輪全部答案的登錄

- `HANDOFF.md` 新增 **§0.00c 第五輪決策（2026-09-27）**：30 題逐題寫 Owner 選項與落實分支（A＝`dec/r6-templates`、B＝`dec/r6-local-tuning`、C＝`dec/r6-gates`、D＝`dec/r6-defaults`、E＝本分支；「只記錄」的 C-a、C-d、C-e、C-g、C-h、C-i、D-1、D-4、LC-2、O-4 不改程式）。
- `owner-pending-decisions-r5.md`：O-3 與只記錄的九題就地加「〔Owner 2026-09-27 選 N〕」；本表沒列的 K-P 在檔頭加註。其他四組負責的題由各自分支加註。本節 10.15 第 6 點 LC-2 下加同樣的註記。
- `kc-review-物理.md` 最後一節「仍待決」一行加註 K-P 的結果。

#### 4. 同批的文件清理（cleanup 審查留下的）

- `README.md`：連到 tag `v1-mysql` 的原型說明（開頭的專案說明、「exam → exam_pro 重構到底改了什麼」一節最後的註記）後補一句「tag 內的授權宣告以主線 `LICENSE` 為準」，註明只是釐清、不改變任何授權。**請 Owner 留意**：tag `v1-mysql`（2026-08-21）裡的 `LICENSE` 是 Apache-2.0，README「授權與著作權」一節也寫「2026-08-24 之前的歷史版本曾以 Apache-2.0 釋出，該授權僅及於該等歷史版本」；這句是照指示加的釐清，已經發出去的 Apache-2.0 授權一般無法事後收回，對外措辭若要更精確，建議再看一次。〔審查修正 2026-09-27〕已改成「主線現行版本以主線 `LICENSE` 為準；tag 內的歷史版本見授權與著作權一節」（見第 6 點），不再和該節衝突。
- `requirements_tracker.md` 第 32、63 行、`ux_research_and_journey.md` 第 25 行提到 `exam/` 的地方加〔修訂 2026-09-27〕「已自主線移除，見 tag `v1-mysql`」。

#### 5. 測試與 eval

- `test/unit/localModeSections.test.js`：標題清單多一節 10.20（本節），其餘斷言不變。
- 實測（5433 上新建的 UTF8 測試庫，用完刪除）：unit 3,615（3,613 過、2 略過；比 `a670783` 多 4 案）、`check:html`、migrate（到 0019）、integration 617 全過（多 2 案）。
- 本分支沒有改任何模板、schema、prompt 或 agent 程式，**沒有 cassette 的鍵會變、不需要重錄**。五個 eval 在 replay 下與 `local/integration-r5`（`a670783`）同一環境逐項比對，輸出除了延遲毫秒數以外完全相同：retrieval 過；classify 92、nlq 8、pipeline 1、variant 2 筆 replay miss 都是原本就缺的 cassette，沒有一筆是本分支造成的。

#### 6. 審查修正（分支 `dec/r6-docs-kc-fix`，從 `dec/r6-docs-kc` `563c6ed` 開）

審查（approve、4 條 minor）逐條先驗證再改：

1. **README 授權句和「授權與著作權」一節衝突——屬實，已改。** tag `v1-mysql` 的 commit 日期是 2026-08-21，裡面的 `LICENSE` 是 Apache-2.0、README 也寫程式碼採 Apache-2.0；主線 README「授權與著作權」一節說「2026-08-24 之前的歷史版本曾以 Apache-2.0 釋出，該授權僅及於該等歷史版本」。原句「tag 內的授權宣告以主線 `LICENSE` 為準」會被讀成推翻這一點。兩處（開頭的專案說明、「exam → exam_pro 重構到底改了什麼」一節的註記）改成「主線現行版本以主線 `LICENSE` 為準；tag 內的歷史版本見授權與著作權一節」：只指向 README 既有的 Owner 措辭，不新增任何法律主張、不改 `LICENSE`／`NOTICE`。**要不要再改措辭仍由 Owner 決定**。
2. **ADR-017 選項三把 `cross` 寫成「程式預設」——屬實，已改。** 改成「`LOCAL_EXTRACT_MODE=cross`（`cross` 模式）的做法（程式預設值由 D-3 處理，見 §3.1）」，和 §3.1「本 ADR 不重複規定數值」一致；`dec/r6-defaults`（D-3＝2）併入後不會過時。
3. **HANDOFF §0.2 第 7 項的註記範圍比 K-P 大——屬實，已改。** 改成只解除「物理先不跑」，數學與化學照第 7 項原有條件「併入 `local/integration` 之前不跑」。已核對：`dec/r2-math-kc3` 與 `dec/integration-all` 都是 `local/integration`（`889d18f`）的祖先，所以原條件已成立；這寫成〔現況 2026-09-27〕，不是本輪的新決定。§0.00 A9 列與 §0.00「知識點審定單」一點也加同樣的現況註記，三處一致。
4. **那一次無法重現的 integration 失敗——無法確認和本分支有關，照建議加防護。** `test/integration/kcLoadPhysicsDraft.pg.test.js` 的 `spawnSync` 加 `timeout: 120000`（`killSignal: SIGKILL`），失敗訊息改帶 `status`、`signal`、spawn 錯誤與子行程輸出；斷言本身一條都沒改、沒放寬。

- 沒有改任何程式、模板、schema、prompt、`eval/thresholds.json`、golden 或 cassette，**不需要重錄**。

### 10.21 重錄計畫（2026-09-27，第五輪之後）

> 〔整合 2026-09-27 `dec/integration-r6`〕第五輪五組（10.16～10.20）併進 `dec/integration-r6` 之後，要在 **Owner 的電腦**上重錄的回放檔全部整理在這裡，照順序做。分支本身沒有錄任何 cassette、沒有改 `eval/thresholds.json` 與 golden。
> 為什麼要重錄：classify 的 schema 改了欄位順序（10.16 第 1 點；`classify.v2` 本來就還沒錄）、`nlq.v2` 還沒錄（10.15）、`variant.v2` 的 prompt 加了兄弟題幹與 L-2 規則（10.16 第 2、3 點，60 支全部對不上）、`extract_ocr.v2` 加了 L-2 規則（pipeline／e2e 本來就缺這一支）、〔Owner 2026-09-27 O-5 選 2，`dec/r6-lint-v3`〕`lint.v3`／`lint_chem.v2` 也加了同一條規則（10.16 第 2 點的加註；lint 的鍵全部換掉，隨第 2、3 步一起錄）。
> 以下的指令都在 `exam_pro` 資料夾的命令提示字元（cmd）執行；`record_local.bat` 也可以在檔案總管雙擊（雙擊＝全部 suite 一次錄完，時間是下面四步相加）。

#### 0. 開始之前（約 15 分）

1. 拉到這次交付的版本，確認 `git log -1` 是整合後的那一個 commit。`package.json` 沒改，不必 `npm install`。
2. 正式庫套 migration 0020（本機被截斷的題進複核用的 `output_truncated`，10.17）：`npm run migrate`。只影響正式上傳；重錄用的測試庫由 `record_local.bat` 自己套。
3. `.env` 若照舊範本明寫了 `VARIANT_RETRIEVE_SIM_MIN=0.80`、`VARIANT_OFFTOPIC_SIM_MIN=0.90`、`DEDUP_DUP_THRESHOLD=0.97`、`VARIANT_SIM_MIN` 這幾行，刪掉（10.19 第 2 點；不刪的話正式上傳用的是舊值，伺服器視窗啟動時會提醒）。**重錄不受影響**：錄製子行程一律把這幾個變數清成空白、照程式預設（本機 0.72／0.87／0.99），與 CI 回放相同。
4. ~~**O-5 要先答**~~〔Owner 2026-09-27 O-5 選 2，已落實於 `dec/r6-lint-v3`〕O-5 已答（[`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md) O-5：lint 的模板也加「JSON 字串裡的反斜線寫兩個」，`lint.v3`／`lint_chem.v2`），這一步不必再做；確認拉下來的版本含 `dec/r6-lint-v3` 即可（第 1a 步）。原因照舊：lint 沒有自己的 suite，它的回放檔是在第 2 步 variant 與第 3 步 pipeline 裡順帶錄的；錄製模式每次都整步重呼叫模型，**variant 錄完才改 lint 的話，第 2、3 步要整個再錄一次**（再花 8～12 小時）。
5. 盤點（只回放、不連網、幾分鐘）：`npm run cassettes:rerecord -- --dry-run`。整合當天（CI 環境）的盤點：classify 92、nlq 8、variant 60、pipeline 1（`extract_ocr`）、e2e 1（同一支 `extract_ocr`）筆 replay miss，缺向量 0。
6. **先看懂「成功」長什麼樣**（第 1～3 步都用這個標準）：錄完工具會以回放模式把錄的 suite 各跑一次，印一張「回放驗證」表（suite｜結束碼｜replay miss｜缺向量｜門檻）。**錄製成功＝這次錄的每一列 replay miss 與缺向量兩欄都是 0**（e2e 那一列看 pass／fail）。
   - 「門檻」欄是 ❌ 時，那一列的結束碼會是 1（eval 未達門檻就回 1，與 CI 相同），所以視窗最後印的是「[!] 錄製或回放驗證沒有全過」、`record_local.bat` 的結束碼是 1，**不會**印「[OK] 重錄與回放驗證都通過」。**只有門檻欄 ❌、replay miss 與缺向量都是 0 時，這是預期的，錄製已經成功，不要重跑**；工具也會多印一行「回放檔已經錄齊……不要重錄」。門檻不放寬、照實紅燈（10.7 第 7 點），把 log 交給維護的人。
   - 只有 replay miss 或缺向量不是 0 時，才照視窗的提示重跑同一個指令。
   - 視窗錄完印的「下一步」會提到 `cassettes:prune`：只列、先不要 `--apply`（第 4 步第 6 點）。

#### 1. classify.v2＋nlq.v2（約 1.5～2 小時）

```bat
scripts\windows\record_local.bat classify,nlq
```

rerecord 依序跑（模式由工具設定，不必自己設環境變數）：
- `embeddings`：`LLM_MODE=replay`、`EMBED_MODE=live`（只補 fixture 題缺的向量；目前不缺，幾秒）
- `classify`：`LLM_MODE=record`、`EMBED_MODE=fixture`（92 題；10.15 估約 1.5 小時）
- `nlq`：`LLM_MODE=record`、`EMBED_MODE=record`（8 句，含查詢句的向量；約 5～10 分）

**怎麼確認成功**：以 log 最後的「回放驗證」表為準（第 0 步第 6 點）：classify、nlq 兩列的 replay miss 與缺向量都是 0。視窗最後印「[OK] 重錄與回放驗證都通過」只發生在兩列門檻也都 ✅ 時；classify 或 nlq 任一列門檻 ❌，視窗會印「[!] 錄製或回放驗證沒有全過」、結束碼 1——**只有門檻欄 ❌ 時這是預期的，不要重跑**（Owner 已裁決門檻不放寬、照實紅燈，10.7 第 7 點）。之後照 10.15 第 7 點「重錄後怎麼看」看 accuracy／macro-F1 與 nlq 的 llm 欄。

#### 1a. （條件步驟）O-5 選 2 時：先讓 lint.v3 進來，不另外錄

〔Owner 2026-09-27 O-5 選 2，已落實於 `dec/r6-lint-v3`〕條件已成立，本步改成：**確認拉下來的版本已含 `lint.v3`，不另外錄**。

- 確認方式（幾秒，只讀檔）：在 `exam_pro` 資料夾執行 `findstr /C:"const TEMPLATE = 'lint.v3'" agents\lint.js`，有印出一行就是新版（化學版是 `lint_chem.v2`，同一個檔）。沒有印出，就是還沒拉到 `dec/r6-lint-v3`，先拉到含它的版本再做第 2、3 步。
- `lint.v3`／`lint_chem.v2` 的回放檔會在第 2 步（變式的 lint）與第 3 步（樣卷的 lint）裡一起錄到，不必另外跑指令；錄完用第 4 步的盤點確認 lint 沒有 replay miss。repo 內 5 支 `lint.v2` 之後會出現在第 4 步第 6 點 `cassettes:prune` 的過期清單。
- ~~O-5 選 1（不加）：跳過本步，lint 維持 `lint.v2`；第 2、3 步照樣會補錄吃到新題幹的那幾支 `lint.v2`。~~（Owner 選了 2，不適用）

#### 2. variant 整步（variant.v2；LLM＋向量，連帶 classify／lint／verify；約 5～6 小時）

```bat
scripts\windows\record_local.bat variant
```

- `embeddings`：`LLM_MODE=replay`、`EMBED_MODE=live`
- `variant`：`LLM_MODE=record`、`EMBED_MODE=record`（30 個藍本 × 2 題＝60 次生成，每題再跑分類、lint（`lint.v3`）、驗算；生成題的向量同一步錄。上次 `variant.v1` 花 17,292 秒≈4.8 小時；`variant.v2` 的 prompt 多了兄弟題幹、第 2 題多讀幾百字，估 5～6 小時）

**怎麼確認成功**：以回放驗證表為準（第 0 步第 6 點）：variant 那一列 replay miss 0、缺向量 0，`gate_pass_rate` 是數字（不是 n/a）。**這一步視窗一定印「[!] 錄製或回放驗證沒有全過」、結束碼 1，不會印 [OK]**：`retrieved_coverage` 0.5000 低於門檻 0.8367 是已知狀況（10.19，V5-1 之後），與重錄無關，門檻欄必是 ❌、那一列結束碼必是 1。replay miss 與缺向量都是 0 就是成功，**不要重跑**（重跑要再花 5～6 小時，錄出來也一樣）。

#### 3. pipeline＋e2e（OCR 為主，`extract_ocr.v2`；約 2.5～5.5 小時）

```bat
scripts\windows\record_local.bat pipeline,e2e
```

- `pipeline`：`LLM_MODE=record`、`EMBED_MODE=fixture`（樣卷 10 題、4 頁：PaddleOCR → `extract_ocr.v2` 整理成題目〔2 塊約 1～1.5 小時，10.12〕→ 每題分類、lint（`lint.v3`）、驗算〔約 1.5～3.8 小時，10.14〕；工具自動把單次呼叫與節點逾時放寬到 3 小時、每 5 分印一次進度，10.11）
- `e2e-similar`：`LLM_MODE=replay`、`EMBED_MODE=record`（e2e 入庫時的向量，`FEATURE_SIMILAR=true`；LLM 全部回放上一步錄好的，幾分鐘）

`ci.yml` 寫的是 `LOCAL_EXTRACT_MODE: ocr`：只錄 `ocr` 與 `extract_ocr`，**不呼叫看圖模型**，錄前檢查也不要求 `qwen3-vl:8b`，但要 PaddleOCR 自我檢查通過。

**怎麼確認成功**：以回放驗證表為準（第 0 步第 6 點）：pipeline 那一列 replay miss 0、缺向量 0；門檻欄的 `saved_rate` 寫「n/a（不比門檻：OCR 模式…）」、不算 ❌（OCR 模式設計如此，D-2，10.18 第 5 點），pipeline 的 log 另有「人工核准前的通過率」一行是數字；e2e 那一列是 `pass 12／fail 0`（OCR 模式下 e2e 驗的是「每題停在複核 → 核准一題入庫」，10.12 第 7 點）。`gate_pass_rate`、`answer_agree_rate` 照舊比門檻：其中一項 ❌ 時視窗會印 [!]、結束碼 1，同第 0 步第 6 點，**不要重跑**。

#### 4. 全部錄完之後（只讀檔，不呼叫模型）

1. 盤點一次，確認五個 eval 與 e2e 的 replay miss、缺向量都是 0（幾分鐘）：

   ```bat
   npm run cassettes:rerecord -- --dry-run
   ```

2. `git add eval/cassettes eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json`，commit、push（或交給維護的人）。
3. 這台電腦的實際速度（幾秒；三次重錄的 log 都給，檔名換成你那三份）：

   ```bat
   npm run perf:local -- --log data\local_ai\record_<第1步>.log --log data\local_ai\record_<第2步>.log --log data\local_ai\record_<第3步>.log --since 2026-09-27 --out data\local_ai\perf.md
   ```

   看「建議」那一段的逾時與 `RERECORD_TIME_SCALE`；10.5 的粗估請換成這份的實測值。
4. 向量門檻重算（V5-2 定案的前置，幾秒）：

   ```bat
   npm run embed:thresholds -- --out data\local_ai\embed_thresholds.md
   ```

   variant 題幹換了，`embed_threshold_labels.json` 的初判對不上，報告會列「未標註」：把報告交給維護的人，由 Claude 重標初判。
5. **O-4 抽查**（Claude 重標之後；約 20～30 分）：Owner 抽 10～15 支，或只看「換了概念」與餘弦 0.85～0.92 之間的那幾支，把不同意的題號貼回來；之後才定案 V5-2（現在的 0.87 是暫定）。
6. 過期回放檔（只列、**不刪**）：

   ```bat
   npm run cassettes:prune
   ```

   清單會有舊模板或舊 schema 的 classify、`variant.v1`、`extract_ocr.v1`、`lint.v2`、看圖拆題與原本 Gemini 錄的檔。要不要刪由 Owner 決定（10.7 第 6 點：刪了就不能不花錢地切回 Gemini）；這一步不加 `--apply`。

#### 5. C-e 量測（與重錄分開做，約 30 分；10.17 第 5 點）

重錄期間 Ollama 很忙，量測請在重錄**之前或之後**、電腦閒著時做：

1. 先讓模型載入一次（例如先跑一次下面第 3 項），再執行 `ollama ps`：看載入的模型、各佔多少記憶體、CONTEXT 欄（應是 16384）。
2. 用記事本開 `%LOCALAPPDATA%\Ollama\server.log`（在檔案總管的網址列貼上這串即可），搜尋：
   - `parallel`：並行槽數（3～4 就是 10.14 (e) 說的多份 KV cache）；
   - `n_ctx`：實際的 context（＝num_ctx × 槽數，例 16384 × 4＝65536）；
   - `loading model`：一份卷換載幾次模型。
3. 開著「工作管理員 → 效能 → 記憶體」（使用中、認可、已使用的插槽）與「資源監視器 → 記憶體」（硬錯誤/秒），同時跑：

   ```bat
   npm run local:bench-text -- --agent verify
   ```

   不加參數＝正式上傳的設定（驗算上限 3072 是本機預設，C-c）。要比較時同一題再跑 `--num-ctx 8192`、`--no-think`、`--max-output 8192`。
4. 把 parallel、n_ctx、記憶體使用中／認可、硬錯誤/秒、bench 的「輸出 token/秒」貼回來，再決定 C-e 的後續與 C-d、C-i。

#### 6. 時間總表

| 步驟 | 指令 | 預估 |
|---|---|---|
| 0 | `npm run migrate`、清 `.env`、~~答 O-5~~（已答：選 2）、`--dry-run` 盤點 | 約 15 分 |
| 1 | `record_local.bat classify,nlq` | 1.5～2 小時 |
| 1a | 確認已含 lint.v3（O-5 選 2，已落實） | 幾秒（不另錄） |
| 2 | `record_local.bat variant` | 5～6 小時 |
| 3 | `record_local.bat pipeline,e2e` | 2.5～5.5 小時 |
| 4 | 盤點、commit、`perf:local`、`embed:thresholds`、O-4 抽查、`cassettes:prune`（只列） | 約 1 小時（O-4 另需 Claude 重標） |
| 5 | C-e 量測 | 約 30 分 |

合計約 10～15 小時的錄製，建議第 1 步白天做（順便確認流程），第 2、3 步各排一個晚上。工具在問 yes 之前印的「粗估」是保守上限（整合當天 `--dry-run --json` 的粗估：第 1 步 6.4～54.5、第 2 步 5.0～53.1、第 3 步 0.4～48.4 小時），以上表的實測推估為準；錄完用 `perf:local` 的 `RERECORD_TIME_SCALE` 校正。
