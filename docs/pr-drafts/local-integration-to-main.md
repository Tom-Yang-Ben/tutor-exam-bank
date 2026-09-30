# PR 說明稿：`local/integration` → `main`（草稿，尚未開 PR）

> **狀態**：說明稿（2026-09-27，分支 `dec/r7-test-hygiene`；審查修正 `dec/r7-test-hygiene-fix`；〔2026-09-27〕和第六輪的落實一起併入 **`dec/integration-r8`**，本稿的數字已改成 r8 實跑的值）。**還沒開 PR、還沒 push。**
> **比較範圍**：`origin/main`（`d1834ac`，PR #38 合入階段 5）→ `dec/integration-r8`（四支 merge 的 head `77d5f12`；原本是 `dec/integration-r7` 的 `6757e25`）。r8 已含本分支（`dec/r7-test-hygiene-fix`）與第六輪的落實（`dec/r7-decisions-host-fix`、`dec/r7-checkpoints-fix`、`dec/r7-electron-b1-fix`）。Owner 的重錄結果併入之後，開 PR 前要把第 1 節與第 4 節的數字換成那一版實測的值。
> **PR 的來源分支 `local/integration` 目前還在 `889d18f`**，比 `dec/integration-r8` 少 82 個 commit（`889d18f` 是它的祖先；r7 時是 68 個）；開 PR 前要先把最後那一版併進去（第 5 節第 4 步）。
> **依據的 Owner 決定**：A8（只開一個 PR，`local/integration` → main）、A7（本機重錄後低於門檻時門檻數字不動、照實紅燈）、X1（**只限 eval 分數可以紅燈合併；unit、integration、e2e 必須綠；PR 說明列出未達項**）——[`docs/HANDOFF.md`](../HANDOFF.md) §0.00、§0.00a。
> 本稿的事實來源：`git log`／`git diff --stat d1834ac 6757e25`、[`docs/HANDOFF.md`](../HANDOFF.md) §0.00～§0.4、[`docs/local-mode.md`](../local-mode.md) 各節、各 migration 檔頭；第 4 節的數字是 2026-09-27 在 `dec/integration-r8`（`77d5f12`）上照 `ci.yml` 的 env 實跑的結果（r7 的數字留在各格註記）。

---

## PR 標題（建議）

`本機模式、章節重整、錯題重練與第一～五輪 Owner 決策（local/integration → main）`

## 0. 開 PR 之前一定要成立的事（目前**還沒**成立）

> 〔2026-10-01 `dec/r9-record-tooling`，照實更新〕Owner 2026-09-27～28 在自己的電腦錄完 10.21 第 2、3 步，已入庫於 `dec/integration-r9`（`7dca34a`；錄製檔 `e9d4aa6`）。下表的「現況」是 `7dca34a` 照 `ci.yml` 的 env 實跑的結果（5433 的全新 UTF8 測試庫）；本分支（重錄工具補強，[`local-mode.md`](../local-mode.md) 10.23）的回放結果與它逐字相同。

| 條件 | 現況（r9 `7dca34a`，2026-10-01 實跑） | 等什麼 |
|---|---|---|
| e2e 12 項全綠（X1；另有 2 項交叉驗證是固定的 SKIP，第 6 節） | ✅ 14 項：**12 過**、0 紅、2 SKIP（樣卷的 `extract_ocr.v2` 已錄，r8 的 3 紅已解） | — |
| unit、integration 全綠（X1） | ✅ unit 4,169 則：4,168 過、0 失敗、1 略過（ocr 模式固定略過的交叉驗證那一則）；integration 646 則全過 | — |
| 錄好後若 unit／e2e 因本機模型的拆題品質變紅，先有 Owner 決定再處理 | 錄完沒紅：**TH-1 不必答**（第 7 節；第 6 節那三處已轉成硬斷言並通過） | — |
| eval 的 replay miss 與缺向量都是 0 | 缺向量 0；replay miss 只剩 **variant 2 筆**：var-008#1 的變式生成（`variant/66f37e00…`，錄製時超過 `OLLAMA_TIMEOUT_MS` 90 分逾時）、var-015#1 的驗算（`verify/d5d8d07d…`，推測寫到輸出上限 3072 被截斷）。兩筆都是「錄製時丟錯 → 寫回放檔之前就中止 → 沒有回放檔」（[`local-mode.md`](../local-mode.md) 10.23 第 1 點）。其他 suite 照 CI 的順序跑都是 0（`cassettes:rerecord --dry-run` 全部 suite 一起盤點時 e2e 會多 2 筆 classify miss，是盤點工具先跑 retrieval／nlq、測試庫殘留 fixture 題造成的，CI 不會；10.23 第 5 點第 5 步） | Owner 電腦 `scripts\windows\record_local.bat variant --only-missing`：只補那 2 筆、其他 58 支不重跑，合計約 2～2.5 小時，最壞約 3.5 小時；逾時或被截斷時照實錄成「錯誤回放檔」，回放記成那一題沒通過、不再是 miss（10.23 第 5 點〔要實測〕） |
| 未達門檻的 eval 列在本稿第 4.2 節 | 已列：variant `retrieved_coverage` 0.5000 < 0.8367、pipeline `gate_pass_rate` 0.8000 < 0.97（都是實錄結果）；variant 的 `gate_pass_rate` 要等上一列補錄後才有數字 | 補錄後回填 variant 的 `gate_pass_rate` |
| `local/integration` 是最後那一版 | 在 `889d18f`，比 r9 `7dca34a` 少 92 個 commit | 第 5 節第 4 步 |

---

## 1. 範圍一覽

> 以下是 `d1834ac..77d5f12`（`dec/integration-r8` 四支 merge 的 head）的數字；r7（`6757e25`）時是 185 個 commit、828 個檔案、+96,549／−5,424 行。重錄結果併進去之後會變：**開 PR 前依 `local/integration` 推送前的最後 head 重算**（`git rev-list --count`、`git diff --shortstat`、`git diff --name-status` 各跑一次，對 `origin/main`）。

- 199 個 commit（其中 48 個 merge），870 個檔案：**+105,512／−5,561 行**；新增 668、修改 193、刪除 9（刪除的 9 個都是舊版原型 `exam/`）。
- 行數的大宗是回放檔：`exam_pro/eval/cassettes/` 新增 416 支（classify 275、variant 87、verify 25、nlq 24、lint 4、ocr 1），另新增本機向量檔 `eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json`。
- 程式與文件的新檔集中在：`exam_pro/services/{llm,ocr}/`、`exam_pro/ocr_service/`、`exam_pro/services/retrain*.js`、`exam_pro/scripts/desktop/`、`desktop/`（Electron 桌面版 B1）、`exam_pro/eval/{lib,tools}/`、`exam_pro/migrations/0014～0020`、`docs/`（`local-mode.md`、`chapter-restructure.md`、`retrain-and-review.md`、`desktop-launcher.md`、`desktop-app-design.md` 等）、ADR-016～019。

## 2. 改動分類摘要

### 2.1 章節重整（2026-09-25；ADR-016、[`chapter-restructure.md`](../chapter-restructure.md)、裁決 CR-1～CR-9）

- 數學 34 → 52 章、物理 32 → 34 章，對齊 108 課綱龍騰版目錄；化學章名不動。定案清單 `config/chapterPlan.js`，`config/chapters.js` 直接引用它。
- 舊題搬章：`npm run chapters:migrate`（規則提議 → 老師確認 → `--apply`），處理紀錄寫進 migration 0014 的 `chapter_migration_log`。
- eval 素材依新白名單改標（`eval/CHAPTER_RELABEL-2026-09.md`，含 CR-8 之二的物理改標、新增干擾題 #61、#62）；白名單依冊別分組（CR-8 之三）；分類模板升 `classify.v2`（CR-9 與第三輪 K2、K3 的分類界線）。
- **本 PR 改過的 golden 與 fixture**（`git diff --stat d1834ac 6757e25 -- exam_pro/eval/golden`：4 個檔，+117／−123 行；commit `4d26c21`、`4f3b7bb`、`49256a0`）。內容都是章名改標與新增干擾題，逐題的新舊章名與理由見對照表 [`eval/CHAPTER_RELABEL-2026-09.md`](../../exam_pro/eval/CHAPTER_RELABEL-2026-09.md)（第 1 節總覽、第 2 節 CH-B、第 8 節 CR-8 之二）；**`eval/thresholds.json` 從 `d1834ac` 以來一個數字都沒動**。
  - `exam_pro/eval/golden/classify.json`：改標，並新增 `cls-fx-061`、`cls-fx-062`（共 92 筆）
  - `exam_pro/eval/golden/nlq.json`：改寫查詢、改期望章節、調整 `relevant`
  - `exam_pro/eval/golden/variant.json`：藍本章名改成與 fixture 一致
  - `exam_pro/eval/golden/pdf_sample/f1a15d77….json`（樣卷答案卷）：3 題的章名；樣卷 PDF 與 sha256 不變
  - fixture（不是 golden，一併列出）：`exam_pro/eval/fixtures/questions.public.json` 在同三個 commit 改標，並新增 #61、#62（共 62 題）；`exam_pro/eval/fixtures/embeddings.gemini-embedding-001.768.json` 只多了 45 個向量（`04e9bd3` 的 Gemini 重錄），原有的向量沒變

### 2.2 本機模式（2026-09-25；ADR-017 提議中、[`local-mode.md`](../local-mode.md) 第 0～9 條與 10.1～10.10）

- L1 Ollama 轉接層（`services/llm/ollama.js`）：沒設 `MODEL_*` 時一律是本機模型（拆題 `qwen3-vl:8b`、文字工作 `qwen3:8b`、向量 `qwen3-embedding:0.6b`）；Gemini 保留，改 `.env` 即可切回。LM-15：分類、lint、知識點標註等純文字工作改用 `MODEL_TEXT`，16 GB 的電腦不必在兩個模型之間換載。
- L2 本機 OCR：PaddleOCR（`ocr_service/ocr_pdf.py`、`services/ocr/`，LM-16 釘 PaddlePaddle 3.2.2）與拆題交叉驗證（`agents/extractCrossCheck.js`，不一致停在複核 `extract_disagree`，migration 0015）。
- L3 前端離線化（`npm run check:html` 多一支 `scripts/check_html_offline.js`）。
- L4 eval、CI 與 Windows 腳本：`ci.yml` 的模型改成本機（CI 仍只讀回放檔與向量檔，不裝 Ollama、不裝 Python）；`setup_local_ai.bat`、`record_local.bat`、`npm run cassettes:rerecord`／`cassettes:prune`、`ocr:selftest`。
- 本機速度與逾時：看圖拆題逾時的處理與量測（10.11，`local:bench-vision`）、實際速度報告 `npm run perf:local`（10.10）、拆題以外的時間與加速選項（10.14，`local:bench-text`）、第五輪 B 的逐步驟呼叫調整（10.17：知識點標註關思考 C-b、驗算輸出上限 3072 C-c、本機被截斷的回應不重試直接進複核 C-f＋migration 0020）；第四輪 V3（本機拆題逾時只重試 1 次）、V4（`/analyze-pdf` 本機預設每塊 2 頁）。

### 2.3 OCR 為主（2026-09-26；10.12，第五輪 D-1～D-3）

- 新設定 `LOCAL_EXTRACT_MODE`（`config/localExtractMode.js`）：`ocr`＝只跑 PaddleOCR＋`qwen3:8b` 整理（`extract_ocr`），不呼叫看圖模型；**第五輪 D-3 起程式預設就是 `ocr`**（10.19），`ci.yml` 與 `eval/.env.replay` 也明寫 `ocr`。
- 每題停在人工複核 `ocr_only`（migration 0019、複核頁說明）；附圖依 PaddleOCR 的版面位置配（`agents/extractOcrFigures.js`），配不到的題標補圖提示。
- 測試契約變更（D-1 同意）：e2e 在 ocr 模式驗「全部停在複核 → 經複核 API 核准一題入庫」（①a／①b）；`eval:pipeline` 的 `saved_rate` 在 ocr 模式印 n/a、不比門檻，另報「人工核准前的通過率」（D-2，10.18 第 5 點）。

### 2.4 錯題重練與間隔複習（FR-036～040；ADR-018、ADR-019、[`retrain-and-review.md`](../retrain-and-review.md)）

- 資料層拆「派題」與「作答」（migration 0016；`attempts` 改成唯讀相容檢視），排程項目（0017）、移出的來源（0018）。
- 固定關卡排程純函式（`services/retrainSchedule.js`）、API-1～13、批改卡「要重練」勾選、出卷附帶重練題與重練卷、Word 答案區標「（重練）」、學生分頁的錯題重練卡與重練成效表（`public/js/retrain.js`）。
- 旗標 `FEATURE_RETRAIN` 預設關；**旗標關閉也必須 migrate 到 0018**（第 3 節）。Owner 第三輪 R1～R12、第四輪 T1～T3 的答覆都已落實。

### 2.5 知識點（第二、三輪審定單；第五輪 K-P）

- 三科種子檔依審定單改寫：數學 253、物理 198（口語版依 P20 全面重寫）、化學 237，共 688 個（`config/kc/*.json`，`npm run kc:validate` 通過），另有代碼對照表 `config/kc/code-maps/`。
- K-P：物理 198 條維持草稿（`draft`），但允許 `kc:load` 載入（程式本來就不擋，加測試釘住）。逐條 `approved` 仍只有數學 4 條。

### 2.6 LaTeX 修復與公式閘門（[`docs/llm.md`](../llm.md) 第 10 節；10.16、10.18）

- `services/llm/latexEscapeRepair.js`：解析完 JSON、交給 agent 之前補回被 JSON 跳脫吃掉的反斜線（`\f`、`\t`、`\b` 這類）；依主控指示併入（O-1 加註，不是 Owner 裁決）。
- L-2：模板明講「JSON 字串裡的反斜線寫兩個」，相關模板一起升版（`extract.v3`、`extract_vision.v2`、`extract_ocr.v2`、`variant.v2` 等，10.16 第 2 點）；O-5：lint 第三層也加，`lint.v3`／`lint_chem.v2`。
- L-1：公式閘門擋下換行以外的控制字元；L-3：解析器支援 `\bullet`、`\textbf`。

### 2.7 分類界線規則（10.15、10.18 第 3 點、10.22）

- `utils/chapterPostRules.js`：`generateJson` 之後的程式後處理，**不進回放檔的鍵**（模板、schema、`cacheKeyParts` 不變，改規則不必重錄）。章名容錯、分類與查題的程式界線規則（10.15）；LC-3：界線規則也套在零成本閘門。
- LC-2（Owner 2026-09-27 改答）：加平方關係、廣義角、摩擦係數、等速圓周運動的運動學四條規則，依審查收窄規則 1、3、4 的誤觸；誤觸檢查工具 `eval/tools/chapter_rules_scan.js`。replay 91/92、macro-F1 0.9744（10.22）。
- LC-1：分類輸出改成「理由 → 章節 → 信心」；LC-4：nlq 的 llm 路徑、期望多章的句子放寬計分（門檻數字不動）。

### 2.8 查題、相似題與門檻

- 查題（NLQ）證據檢查、平面／空間對齊與 `nlq.v2` 模板（[`docs/retrieval.md`](../retrieval.md) §9）；B5：助教與 NLQ 的 LLM 輔路徑支援化學。
- 第五輪 V5-1～V5-5、O-2：五個餘弦門檻依向量模型取預設（`config/similarityThresholds.js`；本機 `VARIANT_RETRIEVE_SIM_MIN` 0.72、`VARIANT_OFFTOPIC_SIM_MIN` 0.87 暫定、`DEDUP_DUP_THRESHOLD` 0.99，Gemini 模式照舊）；V5-6：同一藍本的兄弟變式從生成端就不一樣（`variant.v2`）。`eval/thresholds.json` 一個數字都沒動。

### 2.9 第一輪決策的其他項目

- B7：確認出卷時伺服器端檢查承上題整組（半組回 400＋`incomplete_groups`）；B10：承上題湊不滿改成直接報錯（`FOLLOW_UP_SHORTFALL_POLICY`，預設 `error`）；B20：舊題補附圖工具 `npm run figures:backfill`（預設只列出、逐題確認後才 `--apply`）；B21：舊流程 `/analyze-pdf` 補裁圖。

### 2.10 桌面啟動器 A（2026-09-27；[`desktop-launcher.md`](../desktop-launcher.md)）、第六輪決策的落實與桌面版 B1

- `exam_pro/scripts/desktop/`、`exam_pro/scripts/windows/install_desktop_shortcut.bat`：點「出題系統」依序開 Docker Desktop、資料庫、檢查 Ollama、開伺服器與獨立視窗；「關閉出題系統」先讓背景工作收尾再停。
- 後端只改三處：`GET /api/health`（不需金鑰，本機以外每分鐘 60 次）、`/api/launcher` 關閉通道（環境裡有 `LAUNCHER_CONTROL_TOKEN` 才掛載）、聽不了連接埠時印出原因並以結束碼 1 結束。`npm start`／`npm run dev` 其餘行為不變。
- 〔2026-09-27 改寫，r8〕Owner 第六輪已答 DL-1～DL-5、DA-1～DA-14（[`HANDOFF.md`](../HANDOFF.md) §0.00d），r8 帶進這幾項落實：
  - DL-4＝2：啟動器 `jobsWhileRecording` 預設改 `pause`（錄製中開的後端暫停背景工作）；DA-11＝1：後端改聽 `.env` 的 `HOST`，**預設 `127.0.0.1`**（原本聽全部介面；要給區網用要明寫 `HOST=0.0.0.0`）；DA-14／DA-9 的唯讀檢查工具 `wsl_memory_check.bat`（`dec/r7-decisions-host-fix`）。
  - DA-13＝2：整份卷的拆題與變式生成加逐塊／逐題的檢查點（沿用 `job_events`，**沒有新 migration**）；中斷或「失敗後重試」只重做被中斷的那一塊，變式只補還沒建成的題；檢查點對不上時 job 直接 `failed` 並說明（`dec/r7-checkpoints-fix`，[`desktop-launcher.md`](../desktop-launcher.md) 7.3）。
  - B1：`desktop/`（Electron 44 殼，`utilityProcess.fork` 開 `exam_pro/startServer.js`，只綁 `127.0.0.1`、資料庫仍用 Docker）、`exam_pro/scripts/windows/install_desktop_app.bat`；`npm start` 照舊（`server.js` 只加 `HOST`）。Windows 上的行為**待 Owner 驗收**（[`desktop-app-design.md`](../desktop-app-design.md) 6.2）。B2、D2、B3 仍只有設計稿。

### 2.11 其他

- 舊版原型 `exam/` 從主線移除，原始碼保留在 tag `v1-mysql`（README 改引用）。
- 回放檔與向量檔入版控：2026-09-24 Gemini 重錄（`04e9bd3`）、2026-09-25 本機重錄（`f77d1a3`）、2026-09-27 本機重錄第 1 步（`7536493`：`classify.v2` 92 支、`nlq.v2` 8 支）。舊模板與 Gemini 的回放檔先不刪（`cassettes:prune` 只列、不 `--apply`，10.21 第 4 步第 6 點）。

## 3. migration 0014～0020 的升級注意事項

`origin/main` 到 0013 為止，本 PR 帶進 0014～0020。依 [`HANDOFF.md`](../HANDOFF.md) §0.4 第 6 項，**Owner 的正式庫 2026-09-26 已升到 0018**（升級前後的作答快照逐欄相同），0014～0018 不要重做；0019、0020 依 10.21 第 0 步第 2 點要套，是否已套請先以 `node migrate.js status` 確認。從 0013 以前一路升上來的庫，照 [`deployment_and_operations.md`](../../engineering_docs/06_ops/deployment_and_operations.md) §3.4～§3.6 從頭走。

| 檔案 | 內容 | 注意 |
|---|---|---|
| 0014 `chapter_migration_log` | 章節重整的搬章處理紀錄（`chapters:migrate --apply` 寫入） | 只新增表；之後照 `chapter-restructure.md` 第 6.1 節做搬章、`embed:backfill`、`search:reindex` |
| 0015 `extract_disagree` | 複核原因多 `extract_disagree`（交叉驗證不一致） | 以完整值域重建 CHECK |
| 0016 派題與作答拆表 | 新表 `assignments`、`attempt_records`，既有 `attempts` 逐列搬過去、id 保留，自我檢查通過才刪舊表；`attempts` 改成**唯讀檢視** | **唯一不是純新增的一支**：0016 之前的程式寫 `attempts` 會失敗，要退回舊程式必須連資料庫一起用備份還原。升級照 §3.6：停服務 → 更新程式 → `npm run db:backup` → `node scripts/snapshot_attempt_views.js --out=before.json` → `npm run migrate` → `--out=after.json` → `--compare before.json after.json` **回 0 才啟動** |
| 0017 `retrain_items` | 重練排程項目，`assignments` 加重練欄位與兩個複合外鍵 | 不搬、不建任何資料（R11 選 3） |
| 0018 `retired_by_unflag` | 排程項目記下「移出是因為勾選消失」 | **`FEATURE_RETRAIN` 關閉也必須套到 0018**：批改、刪卷、刪學生、合併學生都會讀寫 `retrain_items`，沒套會 500 |
| 0019 `ocr_only` | 複核原因多 `ocr_only` | ocr 模式（現在是預設）沒套 0019 時，佇列暫停、只報一次錯 |
| 0020 `output_truncated` | 複核原因多 `output_truncated`（本機回應寫到輸出上限，C-f） | 以完整值域重建 CHECK；可重複套用 |

- 全部在 `migrate.js` 裡一支一交易；0015、0019、0020 可重複套用（`DROP CONSTRAINT IF EXISTS` 再 `ADD`），0018 冪等。
- 升級時同步清 `.env`：舊範本明寫的 `VARIANT_RETRIEVE_SIM_MIN=0.80`、`VARIANT_OFFTOPIC_SIM_MIN=0.90`、`DEDUP_DUP_THRESHOLD=0.97`、`VARIANT_SIM_MIN` 要刪掉，不然正式上傳用的是舊值（10.21 第 0 步第 3 點、10.19）。`LOCAL_EXTRACT_MODE` 不寫也是 `ocr`。

## 4. CI 現況（依 X1）

量測環境：`dec/integration-r8`（`77d5f12`；r7 `6757e25` 的數字留在說明欄），PostgreSQL 16＋pgvector（埠 5433、全新 UTF8 測試庫），env 照 `.github/workflows/ci.yml`（`LLM_MODE=replay`、`EMBED_MODE=fixture`、`MODEL_EXTRACT=ollama:qwen3-vl:8b`、`MODEL_VERIFY=ollama:qwen3:8b`、`LOCAL_EXTRACT_MODE=ocr`、`EMBED_MODEL=ollama:qwen3-embedding:0.6b`、`MODEL_NLQ=ollama:qwen3:8b`）。
〔2026-10-01〕第 0 節與 4.2 已改成 `dec/integration-r9`（`7dca34a`）實跑的值；4.1 的表仍是 r8 的數字（r9：unit 4,169 則 4,168 過、1 略過，integration 646 則全過，e2e 14 項 12 過、2 SKIP；`check:html`、migrate 同樣通過；`desktop` 這一次沒有重跑），開 PR 前依最後一版重填。

### 4.1 必須綠的項目（X1：unit、integration、e2e；另列 `check:html`、migrate）

| 步驟 | 結果 | 說明 |
|---|---|---|
| unit（`npm test`） | ✅ 4,149 則：4,146 過、0 失敗、3 略過 | 另有整組略過的 describe（等回放檔，第 6 節）；r7 時 4,046 則：4,044 過、2 略過 |
| `npm run check:html` | ✅ | |
| `desktop`：`npm test`、`npm run smoke` | ✅ 120 則全過；冒煙 54/54（xvfb 上真的 Electron 44.4.5） | 不在 GitHub Actions 裡（`ci.yml` 只跑 `exam_pro`）；Windows 專屬項目見 `desktop-app-design.md` 6.2 |
| `npm run migrate:test` | ✅ 到 0020 | |
| integration | ✅ 641 則全過 | r8 多的 12 則來自 `listenHost`（DA-11）與檢查點（DA-13）。r7 時 629 則；〔審查修正 2026-09-27〕審查時在另一個全新庫回報 631 則全過；`dec/r7-test-hygiene-fix` 在全新庫連跑兩次（中間跑過 e2e）都是 629，差 2 則的原因沒查到。兩次都沒有失敗；以 Owner 重跑那一版的數字為準 |
| e2e | ❌ **14 項：9 過、3 紅、2 SKIP** | 2 項 SKIP 是 ocr 模式固定的交叉驗證（第 6 節）。三項紅都是拆題停在 replay miss `extract_ocr/a5918283…`（樣卷的 `extract_ocr.v2` 回放檔還沒錄）。**依 X1 這一項必須綠，第 3 步錄完之前不能開 PR** |

### 4.2 eval（X1：只限這裡可以帶紅燈合併，列出未達項）

〔2026-10-01 `dec/r9-record-tooling`，照實更新〕量測環境改成 `dec/integration-r9`（`7dca34a`，已含 10.21 第 2、3 步的錄製檔 `e9d4aa6`），env 同上；本分支的回放結果與它逐字相同。

| suite | 結果 | 量測值（門檻） | 原因與後續 |
|---|---|---|---|
| retrieval | ✅ | hybrid Recall@5 1.0000（0.97）、純向量 1.0000、LIKE 0.8750 | — |
| classify | ✅ | accuracy 0.9891（0.87，91/92）、macro-F1 0.9744（0.8956） | 2026-09-27 本機重錄第 1 步＋LC-2 四條規則；仍錯 cls-fx-051 |
| nlq | ✅ | rules：coverage 0.84、filters_exact 1、recall10 1；llm：filters_exact 1（放寬計分，LC-4）、recall10 1 | llm 欄的 rule_coverage 本來就是 n/a |
| pipeline | ❌（門檻） | replay miss 0、缺向量 0；`gate_pass_rate`（classify 零成本閘門通過率）0.8000（**0.97，未達**）、`answer_agree_rate` 0.9000（0.87）；`saved_rate` n/a（ocr 模式不比門檻，D-2）；人工核准前的通過率 0.9000（9／10 題，只報告） | 10.21 第 3 步的**實錄結果**（`e9d4aa6`）。門檻不動、照實紅燈（A7），列為未達項；不是錄製失敗，不重錄 |
| variant | ❌ | replay miss **2 筆**（var-008#1 的變式生成、var-015#1 的驗算）；`retrieved_coverage` 0.5000（**0.8367，未達**）；`gate_pass_rate` n/a（有 miss 就不報分數） | 那 2 筆是錄製時逾時（90 分）與（推測）被截斷，當時的工具沒有留下回放檔（[`local-mode.md`](../local-mode.md) 10.23 第 1 點）。補錄：Owner 電腦 `record_local.bat variant --only-missing`（10.23 第 5 點〔要實測〕），只補那 2 筆；逾時或被截斷時照實錄成錯誤回放檔，回放記成那一題沒通過。補錄後 `gate_pass_rate`（0.22）才有數字（雲端以假模型模擬兩筆都失敗時是 0.4500＝27/60；Owner 實錄為準）。`retrieved_coverage` 0.5 是 V5-1 之後的已知狀況、與重錄無關，**補錄後仍會未達**（門檻不動，A7） |

**開 PR 時要列的未達項**：variant `retrieved_coverage` 0.5000 < 0.8367（確定）；pipeline `gate_pass_rate` 0.8000 < 0.97（實錄，確定；`answer_agree_rate` 0.9000 已達）；variant 的 `gate_pass_rate` 視補錄結果回填。

## 5. 合併前後 Owner 要做的事

**開 PR 之前**

1. 完成 [`local-mode.md`](../local-mode.md) 10.21 第 2 步（variant）與第 3 步（pipeline＋e2e）；成功與否以回放驗證表的 replay miss 與缺向量兩欄為準，只有門檻欄 ❌ 時不要重跑。
2. 第 4 步：`npm run cassettes:rerecord -- --dry-run` 確認五個 eval 與 e2e 的 replay miss、缺向量都是 0；`git add eval/cassettes eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json`、commit。
3. 重錄結果併入 `dec/integration-r8`（已含本分支與第六輪的落實；Owner 電腦上用 `step4_after_record.bat` 做）之後，重跑 unit、`check:html`、integration、e2e 與五個 eval：unit、integration、e2e 必須全綠；把第 1 節與第 4 節換成那一版的數字與未達項。unit 或 e2e 若因本機模型的拆題品質變紅，先答 TH-1（第 7 節）再處理。
4. **把最後那一版併進 `local/integration`**〔審查修正 2026-09-27〕：`local/integration` 現在在 `889d18f`，比 `dec/integration-r8` 少 82 個 commit，沒有這一步推上去的會是舊版。`git checkout local/integration` → `git merge --ff-only <第 3 步重跑全綠的那一版>`（`889d18f` 是祖先，應該能快轉；不能快轉代表 `local/integration` 另有 commit，先停下來看是什麼）→ `git log --oneline origin/main..local/integration` 確認看得到重錄的 commit 與本分支的 commit、`git rev-parse local/integration` 等於第 3 步那一版，再照第 1 節的說明重算範圍數字。
5. 由 Owner 的電腦把 `local/integration` 推上 GitHub（推送時機由 Owner 決定），以本稿開 PR 到 main，等 GitHub Actions 的 unit 與 integration 兩個 job 跑完。

**合併之後（正式庫與日常使用）**

6. 正式庫：`node migrate.js status` 看到哪一支；沒到 0020 就照第 3 節升級（先停服務、先備份）；清 `.env` 裡的舊門檻四行。
7. 知識點：`npm run kc:load -- --dry-run` 看過再載入（三科；物理維持草稿，K-P）；之後 B12 的 20 題試標（`kc:backfill -- --limit 20`）。
8. （要用時）桌面圖示：雙擊 `exam_pro\scripts\windows\install_desktop_shortcut.bat`（啟動器 A）；桌面版 B1 另用 `install_desktop_app.bat`，照 `desktop-app-design.md` 6.2 驗收；`.env` 原本靠「聽全部介面」給區網用的話要加 `HOST=0.0.0.0`（DA-11）；`FEATURE_RETRAIN=true` 後在瀏覽器實際走一遍錯題重練（這些畫面只以 miniDom 與一次性冒煙測過）。
9. 10.21 第 4 步其餘各點：`perf:local`（三次重錄的 log）、`embed:thresholds` → Claude 重標初判 → O-4 抽查 10～15 支 → 定案 V5-2（現在的 0.87 是暫定）；`cassettes:prune` 只列、不 `--apply`。第 5 步 C-e 量測在電腦閒著時做。
10. 仍待 Owner 的：DEC-013 核准欄明示簽核；A3（nlq-036 計分）、B18、B19、ADR-017 定案條件（§3.1）；TH-1（第 7 節，錄完沒紅就不必答）；第六輪已落實的是 DL-4、DA-11、DA-13 與 B1（第 2.10 節），B2、D2、B3 照設計稿另排；DA-9 的前提（Smart App Control 關閉）與 DA-14 的 `.wslconfig` 由 Owner 確認。

## 6. 隨本 PR 一起送的測試整理（`dec/r7-test-hygiene`＋審查修正 `dec/r7-test-hygiene-fix`）

只改測試與文件（`eval/CHAPTER_RELABEL-2026-09.md` 一處註記、`docs/local-mode.md` 10.21 第 3 步的頁數與時間、本說明稿），沒有動產品程式、`eval/lib`、`eval/thresholds.json`、golden、既有回放檔、模板、schema 或 `cacheKeyParts`；斷言沒有放寬。

- 原本在本機模式下**永遠 skip 或空轉**的測試改成真的在測：`cassetteReplay`（classify 組改用 `MODEL_TEXT` 算鍵並回放 classify.v2；extract 組改驗 `extract_ocr`）、`evalPipeline` 兩則（只在「唯一的 miss 就是樣卷的 extract_ocr」時 skip，其他 replay miss 一律紅）、`evalVariant`／`evalStage3`（改讀 CI 的向量檔，runVariantSuite 一組不再永遠 skip；「沒有 cassette 時」改用空的暫存目錄真的驗）、移除等於沒做事的 `test/fixtures/planChapters.preload.js`、`answerGolden` 的裁決探針改成硬斷言，以及幾處「資料不在就 return」改成明確 skip 或斷言。
- 審查修正（`dec/r7-test-hygiene-fix`）：
  - `cassetteReplay`：樣卷或答案卷壞掉時不再讓整支檔案在載入時爆掉——新增一則一定執行的「樣卷前提」（壞了就紅燈、丟出原錯誤），extract_ocr 兩組 skip 並指向它，classify 各組照常跑（實測：在樣卷尾端多寫一個位元組，只有「樣卷前提」紅、classify 三組照跑）。「classify 讀 `MODEL_TEXT` 的鍵」那一則移到不會 skip 的「classify 的回放鍵」組，並新增一則「回放檔在就命中、不在時 miss 的鍵等於預期鍵」（實測：暫時移走 #9 的 classify.v2 回放檔，classify 組 skip，這兩則照跑且通過）。
  - `evalVariant`：Gemini 的舊向量檔只在 CI 那一份齊全時才讀、讀不到就接住，只讓「向量不齊時拒絕執行」那一則 skip 並說明（實測：暫時移走那一份，其他各組照跑）。那一份不見時 `recordEmbeddings.test.js` 本來就會紅，不會悄悄過。
  - `evalPipeline` 與 e2e 的交叉驗證項目在 ocr 模式改成**明列 SKIP 並寫原因**（原本 `() => {}` 根本不註冊，報表看不到）：unit 多 1 則、e2e 多 2 則固定的 SKIP；e2e 的回放驗證表那一列因此是 `pass 12／fail 0／skipped 2`。
  - e2e「沒有任何一筆 replay miss」與 integration `retrievalEval` 的訊息不再叫人「執行 eval:record（需要金鑰）」，改指 10.21 第 3 步的重錄（只改訊息，斷言不動）；`localModeSections.test.js` 的節號登記表跟著登記 e2e 那支檔多指到 10.21。
- 本分支實跑（同第 4 節的環境，2026-09-27 審查修正後）：unit 4,061 則，4,058 過、0 失敗、3 則 SKIP（`evalPipeline` 等 extract_ocr 的兩則＋交叉驗證那一則）另有 `cassetteReplay` 的 extract_ocr 組整組 SKIP；等回放檔的只剩同一支——樣卷的 `extract_ocr.v2`（10.21 第 3 步），skip 訊息指名這一步。`check:html` 過、migrate 到 0020、integration 629 全過；e2e 14 項：9 過、3 紅（同第 4.1 節，`extract_ocr/a5918283…`）、2 項是上面說的交叉驗證 SKIP。
- **第 3 步錄好之後這三處會自動轉成硬斷言**：`cassetteReplay` 要求樣卷每一題都過 ajv、至少 8 題、兩科都有、每題標 `ocr_only`；`evalPipeline` 要求 10 題都走到終態、ocr 模式一題都不自動入庫。那時若出現下游（分類、lint、驗算）的 replay miss，這兩支會**紅燈而不是 skip**——代表 unit 環境（沒有資料庫）與錄製時算出的鍵不同，要先查清楚再合併。其中幾條其實是在量本機模型的拆題品質，可能因此變紅：怎麼處理見第 7 節 TH-1。

## 7. 待 Owner 決定：TH-1　錄好之後，單元測試與 e2e 因本機模型的拆題品質變紅時怎麼辦

> 〔審查 2026-09-27，`dec/r7-test-hygiene` 的審查意見〕比照 D-1（測試契約變更要 Owner 同意）。**現在什麼都沒改**；錄完沒紅，這題就不必答。

- **背景**：樣卷的 `extract_ocr.v2` 回放檔錄好之後，第 6 節那三處從 skip 轉成硬斷言，而且 X1 規定 unit、e2e 必須綠才能開 PR。其中幾條是 Gemini 時代訂的契約，量的其實是**模型拆題拆得好不好**，會直接套在本機 `qwen3:8b` 的輸出上（2026-09-27 審查時用手寫的假回放檔確認過：轉換確實會發生，而且下游缺檔時是紅燈、不是 skip）：
  - `test/unit/cassetteReplay.test.js`（extract_ocr 組）：`rejected` 必須是空的（每一題都要過 ajv 與章節白名單——寫出白名單外的章名或少一個必填欄位，那一題就進 `rejected`）；至少 8 題（樣卷 10 題）；數學、物理兩科都要有；每題 `answer_text` 非空、題幹不殘留「[附圖描述」。
  - `test/unit/evalPipeline.test.js`：「10 題全部走到終態」要求拆出來**剛好** 10 題；「〔ocr 模式〕同一份 PDF 跑第二次」要求至少一題走完全部閘門停在 `ocr_only`（每一題都被分類、lint、驗算或原卷比對擋下時就紅）。
  - e2e 的 ①a／①b（D-1 已同意的契約）：至少一題停在 `ocr_only`、樣卷沒有 `transcription_mismatch`；①b 要有一題可以核准。
  - **不在本題範圍**（是接線與形狀，紅了就是缺陷，照一般方式修）：replay miss、`idx` 連號、`chunk_no`／`page_range`、不帶 `figure_desc`、每題標 `ocr_only`／`extract_mode`、一題都不自動入庫、counts 相加等於總列數。
- **問題**：錄完之後，如果紅的**只有**上面那幾條品質條件，要怎麼處理？
- **選項**：
  1. **維持斷言，當成拆題品質問題修到綠**：看是哪一條，改 `extract_ocr` 的模板或程式後處理（例如章名容錯）。改模板＝回放鍵變＝第 3 步要重錄（約 2～4.5 小時），修到綠才開 PR。契約不變；時程不確定，8B 模型可能修不動。
  2. **品質條件改由 eval 量，單元測試與 e2e 只守接線與形狀**：上面「不在本題範圍」那些照舊硬斷言；紅掉的那幾條品質條件改成由 `eval:pipeline` 報告（依 X1 eval 可以紅燈合併，PR 列未達項）。每條要怎麼改，會先列出逐條清單給 Owner 看過再動。約半天；不必重錄。代價：單元測試不再抓「拆題品質退步」，要看 eval 報表；這是放寬測試，所以要 Owner 同意。
  3. **維持斷言、讓它紅，另把 X1 改成這幾條可以紅燈合併**（比照 D-1 選項 3）：不花時間；unit／e2e 長期紅，真的壞掉時從紅燈看不出來。
  4. **暫緩開 PR**，等換更強的模型或有 GPU 的電腦再錄：契約不變；PR 無限期延後。
- **建議**：先錄、先看結果。真的只紅在品質條件時選 2：`cassetteReplay` 自己的註解就寫著「模型的抓題率是 eval 的事，不該讓模型少抓一題就把單元測試變紅」（卻又斷言至少 8 題），而且 ocr 模式每一題本來就停在人工複核，拆錯的題在複核頁攔得到；選 1 改模板要再錄一輪，也不保證修得動。
- **何時**：10.21 第 3 步錄完、重跑 unit 與 e2e 之後；開 PR 之前一定要定。**在那之前不要改這幾條斷言。**
- 出處：本稿第 6 節；`test/unit/cassetteReplay.test.js`、`test/unit/evalPipeline.test.js`、`test/e2e/pipeline.e2e.test.js`；D-1 見 [`owner-pending-decisions-r5.md`](../owner-pending-decisions-r5.md)。
