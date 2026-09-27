# PR 說明稿：`local/integration` → `main`（草稿，尚未開 PR）

> **狀態**：說明稿（2026-09-27，分支 `dec/r7-test-hygiene`）。**還沒開 PR、還沒 push。**
> **比較範圍**：`origin/main`（`d1834ac`，PR #38 合入階段 5）→ `dec/integration-r7`（`6757e25`）。Owner 的重錄結果併入 `dec/integration-r7`、本分支再併入之後，開 PR 前要把第 4 節的數字換成那一版實測的值。
> **依據的 Owner 決定**：A8（只開一個 PR，`local/integration` → main）、A7（本機重錄後低於門檻時門檻數字不動、照實紅燈）、X1（**只限 eval 分數可以紅燈合併；unit、integration、e2e 必須綠；PR 說明列出未達項**）——[`docs/HANDOFF.md`](../HANDOFF.md) §0.00、§0.00a。
> 本稿的事實來源：`git log`／`git diff --stat d1834ac 6757e25`、[`docs/HANDOFF.md`](../HANDOFF.md) §0.00～§0.4、[`docs/local-mode.md`](../local-mode.md) 各節、各 migration 檔頭；第 4 節的數字是 2026-09-27 在 `dec/integration-r7` 上照 `ci.yml` 的 env 實跑的結果。

---

## PR 標題（建議）

`本機模式、章節重整、錯題重練與第一～五輪 Owner 決策（local/integration → main）`

## 0. 開 PR 之前一定要成立的事（目前**還沒**成立）

| 條件 | 現況（`6757e25`） | 等什麼 |
|---|---|---|
| e2e 12 項全綠（X1） | 9 過、**3 紅**：樣卷的 `extract_ocr` 回放檔（`extract_ocr/a5918283…`）不在 | [`local-mode.md`](../local-mode.md) 10.21 第 3 步 `record_local.bat pipeline,e2e` |
| unit、integration 全綠（X1） | 全綠（第 4 節） | 重錄檔併入後重跑一次確認；本分支的測試在 extract_ocr 錄好後會從 skip 轉成硬斷言（第 6 節） |
| eval 的 replay miss 與缺向量都是 0 | pipeline 1 筆、variant 60 筆 replay miss | 10.21 第 2 步（variant，Owner 電腦進行中）、第 3 步 |
| 未達門檻的 eval 列在本稿第 4.2 節 | variant `retrieved_coverage` 已知未達；pipeline 的兩項要錄完才知道 | 重錄後回填 |

---

## 1. 範圍一覽

- 185 個 commit（其中 44 個 merge），828 個檔案：**+96,549／−5,424 行**；新增 628、修改 191、刪除 9（刪除的 9 個都是舊版原型 `exam/`）。
- 行數的大宗是回放檔：`exam_pro/eval/cassettes/` 新增 416 支（classify 275、variant 87、verify 25、nlq 24、lint 4、ocr 1），另新增本機向量檔 `eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json`。
- 程式與文件的新檔集中在：`exam_pro/services/{llm,ocr}/`、`exam_pro/ocr_service/`、`exam_pro/services/retrain*.js`、`exam_pro/scripts/desktop/`、`exam_pro/eval/{lib,tools}/`、`exam_pro/migrations/0014～0020`、`docs/`（`local-mode.md`、`chapter-restructure.md`、`retrain-and-review.md`、`desktop-launcher.md`、`desktop-app-design.md` 等）、ADR-016～019。

## 2. 改動分類摘要

### 2.1 章節重整（2026-09-25；ADR-016、[`chapter-restructure.md`](../chapter-restructure.md)、裁決 CR-1～CR-9）

- 數學 34 → 52 章、物理 32 → 34 章，對齊 108 課綱龍騰版目錄；化學章名不動。定案清單 `config/chapterPlan.js`，`config/chapters.js` 直接引用它。
- 舊題搬章：`npm run chapters:migrate`（規則提議 → 老師確認 → `--apply`），處理紀錄寫進 migration 0014 的 `chapter_migration_log`。
- eval 素材依新白名單改標（`eval/CHAPTER_RELABEL-2026-09.md`，含 CR-8 之二的物理改標、新增干擾題 #61、#62）；白名單依冊別分組（CR-8 之三）；分類模板升 `classify.v2`（CR-9 與第三輪 K2、K3 的分類界線）。

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

### 2.10 桌面啟動器 A（2026-09-27；[`desktop-launcher.md`](../desktop-launcher.md)）與 B＋D2 設計稿

- `exam_pro/scripts/desktop/`、`scripts/windows/install_desktop_shortcut.bat`：點「出題系統」依序開 Docker Desktop、資料庫、檢查 Ollama、開伺服器與獨立視窗；「關閉出題系統」先讓背景工作收尾再停。
- 後端只改三處：`GET /api/health`（不需金鑰，本機以外每分鐘 60 次）、`/api/launcher` 關閉通道（環境裡有 `LAUNCHER_CONTROL_TOKEN` 才掛載）、聽不了連接埠時印出原因並以結束碼 1 結束。`npm start`／`npm run dev` 其餘行為不變。
- `docs/desktop-app-design.md`（B Electron 桌面殼＋D2 原生 PostgreSQL）**只有設計稿、沒有程式**。Owner 2026-09-27 第六輪已答 DL-1～DL-5、DA-1～DA-14；其中 DL-4 選 2（錄製中暫停背景工作），`dec/integration-r7` 的預設仍是 `run`——第六輪的落實不在本 PR。

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

量測環境：`dec/integration-r7`（`6757e25`），PostgreSQL 16＋pgvector（埠 5433、全新 UTF8 測試庫），env 照 `.github/workflows/ci.yml`（`LLM_MODE=replay`、`EMBED_MODE=fixture`、`MODEL_EXTRACT=ollama:qwen3-vl:8b`、`MODEL_VERIFY=ollama:qwen3:8b`、`LOCAL_EXTRACT_MODE=ocr`、`EMBED_MODEL=ollama:qwen3-embedding:0.6b`、`MODEL_NLQ=ollama:qwen3:8b`）。

### 4.1 必須綠的三項

| 步驟 | 結果 | 說明 |
|---|---|---|
| unit（`npm test`） | ✅ 4,046 則：4,044 過、0 失敗、2 略過 | 另有整組略過的 describe（等回放檔）；本分支之後的數字見第 6 節 |
| `npm run check:html` | ✅ | |
| `npm run migrate:test` | ✅ 到 0020 | |
| integration | ✅ 629 則全過 | |
| e2e | ❌ **12 項：9 過、3 紅** | 三項都是拆題停在 replay miss `extract_ocr/a5918283…`（樣卷的 `extract_ocr.v2` 回放檔還沒錄）。**依 X1 這一項必須綠，第 3 步錄完之前不能開 PR** |

### 4.2 eval（X1：只限這裡可以帶紅燈合併，列出未達項）

| suite | 結果 | 量測值（門檻） | 原因與後續 |
|---|---|---|---|
| retrieval | ✅ | hybrid Recall@5 1.0000（0.97）、純向量 1.0000、LIKE 0.8750 | — |
| classify | ✅ | accuracy 0.9891（0.87，91/92）、macro-F1 0.9744（0.8956） | 2026-09-27 本機重錄第 1 步＋LC-2 四條規則；仍錯 cls-fx-051 |
| nlq | ✅ | rules：coverage 0.84、filters_exact 1、recall10 1；llm：filters_exact 1（放寬計分，LC-4）、recall10 1 | llm 欄的 rule_coverage 本來就是 n/a |
| pipeline | ❌ | replay miss 1 筆（`extract_ocr`）；分數全部 n/a | 等 10.21 第 3 步。錄完後 `saved_rate` 在 ocr 模式印 n/a、不比門檻（D-2）；`gate_pass_rate`（0.97）、`answer_agree_rate`（0.87）照比，**錄完才知道會不會未達** |
| variant | ❌ | replay miss 60 筆（`variant.v2`）；`retrieved_coverage` 0.5000（**0.8367，未達**）；`gate_pass_rate` n/a | 等 10.21 第 2 步（Owner 電腦進行中）。`retrieved_coverage` 0.5 是 V5-1 之後的已知狀況、與重錄無關，**重錄後仍會未達**（門檻不動，A7）；`gate_pass_rate`（0.22）錄完才知道 |

**開 PR 時要列的未達項**（重錄後回填）：variant `retrieved_coverage` 0.5000 < 0.8367（確定）；pipeline 的 `gate_pass_rate`、`answer_agree_rate` 與 variant 的 `gate_pass_rate` 視重錄結果。

## 5. 合併前後 Owner 要做的事

**開 PR 之前**

1. 完成 [`local-mode.md`](../local-mode.md) 10.21 第 2 步（variant）與第 3 步（pipeline＋e2e）；成功與否以回放驗證表的 replay miss 與缺向量兩欄為準，只有門檻欄 ❌ 時不要重跑。
2. 第 4 步：`npm run cassettes:rerecord -- --dry-run` 確認五個 eval 與 e2e 的 replay miss、缺向量都是 0；`git add eval/cassettes eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json`、commit。
3. 重錄結果併入 `dec/integration-r7` 之後，再併入本分支（`dec/r7-test-hygiene`），重跑 unit、`check:html`、integration、e2e 與五個 eval：unit、integration、e2e 必須全綠；把第 4 節換成那一版的數字與未達項。
4. 由 Owner 的電腦把 `local/integration` 推上 GitHub（推送時機由 Owner 決定），以本稿開 PR 到 main，等 GitHub Actions 的 unit 與 integration 兩個 job 跑完。

**合併之後（正式庫與日常使用）**

5. 正式庫：`node migrate.js status` 看到哪一支；沒到 0020 就照第 3 節升級（先停服務、先備份）；清 `.env` 裡的舊門檻四行。
6. 知識點：`npm run kc:load -- --dry-run` 看過再載入（三科；物理維持草稿，K-P）；之後 B12 的 20 題試標（`kc:backfill -- --limit 20`）。
7. （要用時）桌面圖示：雙擊 `exam_pro\scripts\windows\install_desktop_shortcut.bat`；`FEATURE_RETRAIN=true` 後在瀏覽器實際走一遍錯題重練（這些畫面只以 miniDom 與一次性冒煙測過）。
8. 10.21 第 4 步其餘各點：`perf:local`（三次重錄的 log）、`embed:thresholds` → Claude 重標初判 → O-4 抽查 10～15 支 → 定案 V5-2（現在的 0.87 是暫定）；`cassettes:prune` 只列、不 `--apply`。第 5 步 C-e 量測在電腦閒著時做。
9. 仍待 Owner 的：DEC-013 核准欄明示簽核；A3（nlq-036 計分）、B18、B19、ADR-017 定案條件（§3.1）；第六輪（桌面版 DL／DA）的落實另開分支。

## 6. 隨本 PR 一起送的測試整理（`dec/r7-test-hygiene`）

只改測試與文件（`eval/CHAPTER_RELABEL-2026-09.md` 一處註記、本說明稿），沒有動產品程式、`eval/thresholds.json`、golden、既有回放檔、模板、schema 或 `cacheKeyParts`；斷言沒有放寬。

- 原本在本機模式下**永遠 skip 或空轉**的測試改成真的在測：`cassetteReplay`（classify 組改用 `MODEL_TEXT` 算鍵並回放 classify.v2；extract 組改驗 `extract_ocr`）、`evalPipeline` 兩則（只在「唯一的 miss 就是樣卷的 extract_ocr」時 skip，其他 replay miss 一律紅）、`evalVariant`／`evalStage3`（改讀 CI 的向量檔，runVariantSuite 一組不再永遠 skip；「沒有 cassette 時」改用空的暫存目錄真的驗）、移除等於沒做事的 `test/fixtures/planChapters.preload.js`、`answerGolden` 的裁決探針改成硬斷言，以及幾處「資料不在就 return」改成明確 skip 或斷言。
- 本分支實跑（同第 4 節的環境）：unit 4,058 則，4,056 過、0 失敗；剩下的 skip 全部只等同一支回放檔——樣卷的 `extract_ocr.v2`（10.21 第 3 步），skip 訊息指名這一步：`cassetteReplay` 的 extract_ocr 組（整組）與 `evalPipeline` 的兩則。`check:html` 過、integration 629 全過。
- **第 3 步錄好之後這三處會自動轉成硬斷言**：`cassetteReplay` 要求樣卷每一題都過 ajv、至少 8 題、兩科都有、每題標 `ocr_only`；`evalPipeline` 要求 10 題都走到終態、ocr 模式一題都不自動入庫。那時若出現下游（分類、lint、驗算）的 replay miss，這兩支會**紅燈而不是 skip**——代表 unit 環境（沒有資料庫）與錄製時算出的鍵不同，要先查清楚再合併。
