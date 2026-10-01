# PR 說明稿：`local/integration` → `main`（草稿，尚未開 PR）

> **狀態**：說明稿（2026-09-27 起稿於 `dec/r7-test-hygiene`，r8～r10 逐版更新；〔2026-10-01〕改成 **`dec/integration-r11`** 的最終實況，可以直接當 PR 說明）。**還沒開 PR、還沒 push。**
> **比較範圍**：`origin/main`（`d1834ac`，PR #38 合入階段 5）→ `dec/integration-r11`。第 1 節與第 4 節的數字取**本稿這個 commit 的前一個 head `9137783`**（variant 補錄的兩支錯誤回放檔入庫那一版）；本稿這個 commit 只改說明稿與 `HANDOFF.md` 一句指向，多 1 個 commit、不多檔案。r11 含 r8 的全部、本機重錄第 2、3 步入庫、B1 收尾、重錄工具補強、第七輪 R7-1／R7-3／R7-4 的落實與 variant 補錄；**不含 B2**（第七輪 R7-5＝1，第 2.10 節）。
> **PR 的來源分支 `local/integration` 目前還在 `889d18f`**，比 `9137783` 少 104 個 commit（加上本稿這個 commit 是 105；`889d18f` 是它的祖先，反方向 0 個）；開 PR 前要先把 r11 併進去（第 5 節第 1、2 步）。
> **依據的 Owner 決定**：A8（只開一個 PR，`local/integration` → main）、A7（本機重錄後低於門檻時門檻數字不動、照實紅燈）、X1（**只限 eval 分數可以紅燈合併；unit、integration、e2e 必須綠；PR 說明列出未達項**）——[`docs/HANDOFF.md`](../HANDOFF.md) §0.00、§0.00a；第七輪 R7-1～R7-5——§0.00e。
> 本稿的事實來源：`git log`／`git diff --shortstat`／`git diff --name-status d1834ac 9137783`、[`docs/HANDOFF.md`](../HANDOFF.md) §0.00～§0.00e 與 §0.4、[`docs/local-mode.md`](../local-mode.md) 各節（含 10.21～10.24）、各 migration 檔頭；第 0 節與第 4 節的數字是 2026-10-01 在 `dec/integration-r11`（`9137783`）上照 `ci.yml` 的 env 實跑的結果（5433 的全新 UTF8 測試庫）。

---

## PR 標題（建議）

`本機模式、章節重整、錯題重練、桌面啟動器與桌面版 B1，第一～七輪 Owner 決策（local/integration → main）`

## 0. 開 PR 之前一定要成立的事（r11 現況：只剩最後兩列）

> 〔2026-10-01 r11〕Owner 2026-09-27～28 錄完 10.21 第 2、3 步（入庫 `e9d4aa6`），2026-10-01 用 `record_local.bat variant --only-missing` 補錄 variant 缺的 2 筆（入庫 `9137783`）。下表的「現況」是 `dec/integration-r11`（`9137783`）照 `ci.yml` 的 env 實跑的結果（5433 的全新 UTF8 測試庫）。

| 條件 | 現況（r11 `9137783`，2026-10-01 實跑） | 等什麼 |
|---|---|---|
| e2e 12 項全綠（X1；另有 2 項交叉驗證是固定的 SKIP，第 6 節） | ✅ 14 項：**12 過**、0 紅、2 SKIP | — |
| unit、integration 全綠（X1） | ✅ unit 4,225 則：4,224 過、0 失敗、1 略過（ocr 模式固定略過的交叉驗證那一則）；integration 653 則全過 | — |
| `desktop` 的 `npm test` 全綠（第七輪 R7-3＝1 起是 CI 的第三個 job） | ✅ 126 則全過 | — |
| 錄好後若 unit／e2e 因本機模型的拆題品質變紅，先有 Owner 決定再處理 | ✅ 錄完沒紅：**TH-1 不必答**（第 7 節；第 6 節那三處已轉成硬斷言並通過） | — |
| eval 的 replay miss 與缺向量都是 0 | ✅ 五個 eval 的 replay miss、缺向量都是 0。variant 原本缺的 2 筆補錄時都被截斷，照實存成**錯誤回放檔**（var-008#1 的變式生成 `variant/66f37e00…`、var-015#1 的驗算 `verify/d5d8d07d…`；[`local-mode.md`](../local-mode.md) 10.23 第 3 點），回放記成那一題沒通過、不是 miss。（`cassettes:rerecord -- --dry-run` 全部 suite 一起盤點時 e2e 那一列會多 2 筆 miss，是盤點工具先跑其他 suite、測試庫殘留 fixture 題造成的，CI 的 e2e 不會；10.23 第 5 點第 5 步。2026-10-01 在另一個全新庫重跑盤點，結果同此） | — |
| 未達門檻的 eval 列在本稿第 4.2 節 | ✅ 定案兩項：pipeline `gate_pass_rate` 0.8000 < 0.97、variant `retrieved_coverage` 0.5000 < 0.8367（門檻不動，A7）；variant 的 `gate_pass_rate` 0.4500 已達門檻 0.22 | — |
| `local/integration` 是最後那一版 | 在 `889d18f`，比 r11 `9137783` 少 104 個 commit（加上本稿這個 commit 是 105） | 第 5 節第 1、2 步 |
| Owner 同意推送 | 推送時機由 Owner 決定 | 第 5 節第 4 步 |

---

## 1. 範圍一覽

> 以下是 `d1834ac..9137783`（`dec/integration-r11` 在本稿這個 commit 之前的 head）的數字；本稿這個 commit 再多 1 個 commit，檔案數不變、只有說明稿與 `HANDOFF.md` 的行數變。歷史：r8（`77d5f12`）時是 199 個 commit、870 個檔案、+105,512／−5,561 行。`local/integration` 併好之後，**推送前對 `origin/main` 再重算一次**（`git rev-list --count`、`--merges`、`git diff --shortstat`、`git diff --name-status` 各跑一次）；它的內容與 r11 相同時，只有 commit 數會多（Owner 電腦上的回放檔 commit 與合併 commit）。

- 221 個 commit（其中 55 個 merge），995 個檔案：**+116,403／−5,642 行**；新增 787、修改 199、刪除 9（刪除的 9 個都是舊版原型 `exam/`）。
- 行數的大宗是回放檔：`exam_pro/eval/cassettes/` 新增 530 支（classify 277、variant 147、verify 72、nlq 24、lint 8、extract_ocr 1、ocr 1；其中 variant、verify 各 1 支是錯誤回放檔），另新增本機向量檔 `eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json` 與本機原始回應 `eval/fixtures/local_raw_2026-09-25.json`。
- 程式與文件的新檔集中在：`exam_pro/services/{llm,ocr}/`、`exam_pro/ocr_service/`、`exam_pro/services/retrain*.js`、`exam_pro/scripts/desktop/`、`desktop/`（Electron 桌面版 B1）、`exam_pro/eval/{lib,tools}/`、`exam_pro/migrations/0014～0020`、`docs/`（`local-mode.md`、`chapter-restructure.md`、`retrain-and-review.md`、`desktop-launcher.md`、`desktop-app-design.md` 等）、ADR-016～019；`exam_pro/test/` 新增 116 個檔。

## 2. 改動分類摘要

### 2.1 章節重整（2026-09-25；ADR-016、[`chapter-restructure.md`](../chapter-restructure.md)、裁決 CR-1～CR-9）

- 數學 34 → 52 章、物理 32 → 34 章，對齊 108 課綱龍騰版目錄；化學章名不動。定案清單 `config/chapterPlan.js`，`config/chapters.js` 直接引用它。
- 舊題搬章：`npm run chapters:migrate`（規則提議 → 老師確認 → `--apply`），處理紀錄寫進 migration 0014 的 `chapter_migration_log`。
- eval 素材依新白名單改標（`eval/CHAPTER_RELABEL-2026-09.md`，含 CR-8 之二的物理改標、新增干擾題 #61、#62）；白名單依冊別分組（CR-8 之三）；分類模板升 `classify.v2`（CR-9 與第三輪 K2、K3 的分類界線）。
- **本 PR 改過的 golden 與 fixture**（`git diff --stat d1834ac 9137783 -- exam_pro/eval/golden`：4 個檔，+117／−123 行；commit `4d26c21`、`4f3b7bb`、`49256a0`）。內容都是章名改標與新增干擾題，逐題的新舊章名與理由見對照表 [`eval/CHAPTER_RELABEL-2026-09.md`](../../exam_pro/eval/CHAPTER_RELABEL-2026-09.md)（第 1 節總覽、第 2 節 CH-B、第 8 節 CR-8 之二）；**`eval/thresholds.json` 從 `d1834ac` 以來一個數字都沒動**。
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
- LC-2（Owner 2026-09-27 改答）：加平方關係、廣義角、摩擦係數、等速圓周運動的運動學四條規則，依審查收窄規則 1、3、4 的誤觸；誤觸檢查工具 `eval/tools/chapter_rules_scan.js`。replay 91/92、macro-F1 0.9744（10.22）。〔r9〕重錄入庫後語料變多（variant 回放檔多 59 題、pipeline 的 `classify.v2` 多 2 筆），誤觸檢查釘住的語料數字跟著更新（掃描文字 1,108 → 1,167 等，`d14f18b`）；誤觸 0、改錯 0 的斷言不變。
- LC-1：分類輸出改成「理由 → 章節 → 信心」；LC-4：nlq 的 llm 路徑、期望多章的句子放寬計分（門檻數字不動）。

### 2.8 查題、相似題與門檻

- 查題（NLQ）證據檢查、平面／空間對齊與 `nlq.v2` 模板（[`docs/retrieval.md`](../retrieval.md) §9）；B5：助教與 NLQ 的 LLM 輔路徑支援化學。
- 第五輪 V5-1～V5-5、O-2：五個餘弦門檻依向量模型取預設（`config/similarityThresholds.js`；本機 `VARIANT_RETRIEVE_SIM_MIN` 0.72、`VARIANT_OFFTOPIC_SIM_MIN` 0.87 暫定、`DEDUP_DUP_THRESHOLD` 0.99，Gemini 模式照舊）；V5-6：同一藍本的兄弟變式從生成端就不一樣（`variant.v2`）。`eval/thresholds.json` 一個數字都沒動。

### 2.9 第一輪決策的其他項目

- B7：確認出卷時伺服器端檢查承上題整組（半組回 400＋`incomplete_groups`）；B10：承上題湊不滿改成直接報錯（`FOLLOW_UP_SHORTFALL_POLICY`，預設 `error`）；B20：舊題補附圖工具 `npm run figures:backfill`（預設只列出、逐題確認後才 `--apply`）；B21：舊流程 `/analyze-pdf` 補裁圖。

### 2.10 桌面啟動器 A（2026-09-27；[`desktop-launcher.md`](../desktop-launcher.md)）、第六輪決策的落實與桌面版 B1（含收尾、desktop 進 CI；B2 不在本 PR）

- `exam_pro/scripts/desktop/`、`exam_pro/scripts/windows/install_desktop_shortcut.bat`：點「出題系統」依序開 Docker Desktop、資料庫、檢查 Ollama、開伺服器與獨立視窗；「關閉出題系統」先讓背景工作收尾再停。
- 後端只改三處：`GET /api/health`（不需金鑰，本機以外每分鐘 60 次）、`/api/launcher` 關閉通道（環境裡有 `LAUNCHER_CONTROL_TOKEN` 才掛載）、聽不了連接埠時印出原因並以結束碼 1 結束。`npm start`／`npm run dev` 其餘行為不變。
- 〔2026-09-27 改寫，r8〕Owner 第六輪已答 DL-1～DL-5、DA-1～DA-14（[`HANDOFF.md`](../HANDOFF.md) §0.00d），r8 帶進這幾項落實：
  - DL-4＝2：啟動器 `jobsWhileRecording` 預設改 `pause`（錄製中開的後端暫停背景工作）；DA-11＝1：後端改聽 `.env` 的 `HOST`，**預設 `127.0.0.1`**（原本聽全部介面；要給區網用要明寫 `HOST=0.0.0.0`）；DA-14／DA-9 的唯讀檢查工具 `wsl_memory_check.bat`（`dec/r7-decisions-host-fix`）。
  - DA-13＝2：整份卷的拆題與變式生成加逐塊／逐題的檢查點（沿用 `job_events`，**沒有新 migration**）；中斷或「失敗後重試」只重做被中斷的那一塊，變式只補還沒建成的題；檢查點對不上時 job 直接 `failed` 並說明（`dec/r7-checkpoints-fix`，[`desktop-launcher.md`](../desktop-launcher.md) 7.3）。
  - B1：`desktop/`（Electron 44 殼，`utilityProcess.fork` 開 `exam_pro/startServer.js`，只綁 `127.0.0.1`、資料庫仍用 Docker）、`exam_pro/scripts/windows/install_desktop_app.bat`；`npm start` 照舊（`server.js` 只加 `HOST`）。Windows 上的行為**待 Owner 驗收**（[`desktop-app-design.md`](../desktop-app-design.md) 6.2）。
- 〔r9〕B1 收尾（`dec/r8-b1-abandon-fix`）：「現在放棄」改走 `jobRunner` 的 `shutdown({ abandon })`——中止在途節點、不記事件也不改重試次數，只放掉**自己的**租約（租約憑證比對，別的後端接手後寫的租約清不到），重開時立刻接手、照 DA-13 的檢查點續做；被強制結束才要等租約到期。連帶的行為變更：啟動器 A 的「否＝最多等 2 分鐘」時限到了也**先放棄**再結束。另：replay miss 的訊息依模式（本機／Gemini）指向正確的重錄方式。驗收步驟補在 `desktop-app-design.md` 6.2 第 13、14 步〔要實測〕。
- 〔r11〕`desktop/` 納入 CI 與 Dependabot（第七輪 R7-3＝1、R7-4＝B，HANDOFF §0.00e）：`ci.yml` 多一個 `desktop` job（Node 24，`npm ci --ignore-scripts`、不下載 Electron，跑 `npm test`）；`dependabot.yml` 加 `/desktop`，**不分組**（每個版本各開一個 PR）。真的 Electron 的冒煙測試（`npm run smoke`）仍不在 CI。
- **不在本 PR**：B2（`dec/r8-b2-paths-fix`，`3a57d62`）依第七輪 R7-5＝1，等 Owner 驗收完 A（啟動器）與 B1（桌面版）再送，沒有併進任何整合分支；D2、B3 仍只有設計稿。

### 2.11 重錄入庫與第七輪（r9～r11，2026-09-27～10-01）

- 本機重錄第 2、3 步入庫（`e9d4aa6`）：新增 `variant.v2` 59 支、verify 46 支、classify 2 支、lint 4 支與樣卷的 `extract_ocr.v2`，更新 verify 2 支、ocr 1 支與本機向量檔（e2e 用的向量）；e2e 的 3 紅因此解掉，第 6 節那三處轉成硬斷言並通過。
- 重錄工具補強（`dec/r9-record-tooling-fix`，[`local-mode.md`](../local-mode.md) 10.23）：`record_local.bat <suite> --only-missing`（＝`cassettes:rerecord -- --only-missing`）只補錄缺的回放檔與向量；錄製時被截斷或單次逾時照實存成**錯誤回放檔**，回放照樣丟同一個錯、記成那一題沒通過（不是 replay miss）；完整重錄把原本正常的回放檔覆寫成錯誤回放檔時另印警告。盤點表與 eval 報表多「錯誤回放檔」一欄。
- 第七輪 R7-1＝4（`dec/r10-variant-cap-fix`，10.24）：變式生成的本機輸出上限改成**程式預設 1024**（`OLLAMA_MAX_OUTPUT_VARIANT` 可覆寫，寫 8192 以上＝取消）；本機被截斷的變式**不重試**，放棄那一題並在 `generate` 事件記 `truncated`、實際送出的上限。Gemini 路徑與 replay 不讀這個設定；回放檔的鍵沒變，既有回放檔的回放結果與之前逐字相同。
- variant 補錄（R7-2＝2，`9137783`）：Owner 2026-10-01 在 `.env` 寫 `OLLAMA_MAX_OUTPUT_VARIANT=1024` 後用 `record_local.bat variant --only-missing` 補錄 var-008#1（變式生成）與 var-015#1（驗算），兩筆都被截斷，存成錯誤回放檔；variant 的 replay miss 從 2 變 0、`gate_pass_rate` 有了數字（第 4.2 節）。

### 2.12 其他

- 舊版原型 `exam/` 從主線移除，原始碼保留在 tag `v1-mysql`（README 改引用）。
- 回放檔與向量檔入版控：2026-09-24 Gemini 重錄（`04e9bd3`）、2026-09-25 本機重錄（`f77d1a3`）、2026-09-27 本機重錄第 1 步（`7536493`：`classify.v2` 92 支、`nlq.v2` 8 支）、2026-09-27～28 第 2、3 步（`e9d4aa6`）、2026-10-01 variant 補錄（`9137783`，2 支錯誤回放檔）。舊模板與 Gemini 的回放檔先不刪（`cassettes:prune` 只列、不 `--apply`，10.21 第 4 步第 6 點）。

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

量測環境：`dec/integration-r11`（`9137783`），2026-10-01；PostgreSQL 16＋pgvector（埠 5433、全新 UTF8 測試庫：C.UTF-8、template0，用完刪掉），env 照 `.github/workflows/ci.yml`（`LLM_MODE=replay`、`EMBED_MODE=fixture`、`MODEL_EXTRACT=ollama:qwen3-vl:8b`、`MODEL_VERIFY=ollama:qwen3:8b`、`LOCAL_EXTRACT_MODE=ocr`、`EMBED_MODEL=ollama:qwen3-embedding:0.6b`、`MODEL_NLQ=ollama:qwen3:8b`）。歷史：r8（`77d5f12`）時 e2e 是 9 過、3 紅（樣卷的 `extract_ocr.v2` 還沒錄），第 2、3 步入庫（r9）後轉綠。

### 4.1 必須綠的項目（X1：unit、integration、e2e；另列 `check:html`、migrate、`desktop`）

| 步驟 | 結果 | 說明 |
|---|---|---|
| unit（`npm test`） | ✅ 4,225 則：4,224 過、0 失敗、1 略過 | 略過的是 ocr 模式固定略過的交叉驗證那一則（第 6 節） |
| `npm run check:html` | ✅ | |
| `desktop`：`npm test` | ✅ 126 則全過 | 第七輪 R7-3＝1 起在 CI 的 `desktop` job 跑（Node 24，不下載 Electron）。真的 Electron 的冒煙測試 `npm run smoke` 不在 CI；Windows 專屬項目見 `desktop-app-design.md` 6.2 |
| `npm run migrate:test` | ✅ 到 0020 | |
| integration | ✅ 653 則全過 | |
| e2e | ✅ **14 項：12 過、0 紅、2 SKIP** | 2 項 SKIP 是 ocr 模式固定的交叉驗證（第 6 節）；「沒有任何一筆 replay miss」那一項通過 |

### 4.2 eval（X1：只限這裡可以帶紅燈合併，列出未達項）

| suite | 結果 | 量測值（門檻） | 原因與後續 |
|---|---|---|---|
| retrieval | ✅ | hybrid Recall@5 1.0000（0.97）、純向量 1.0000、LIKE 0.8750 | — |
| classify | ✅ | accuracy 0.9891（0.87，91/92）、macro-F1 0.9744（0.8956） | 2026-09-27 本機重錄第 1 步＋LC-2 四條規則；仍錯 cls-fx-051 |
| nlq | ✅ | rules：coverage 0.84、filters_exact 1、recall10 1；llm：filters_exact 1（放寬計分，LC-4）、recall10 1 | llm 欄的 rule_coverage 本來就是 n/a |
| pipeline | ❌（門檻） | replay miss 0、缺向量 0；`gate_pass_rate`（classify 零成本閘門通過率）0.8000（**0.97，未達**）、`answer_agree_rate` 0.9000（0.87）；`saved_rate` n/a（ocr 模式不比門檻，D-2）；人工核准前的通過率 0.9000（9／10 題，只報告） | 10.21 第 3 步的**實錄結果**（`e9d4aa6`）。門檻不動、照實紅燈（A7），列為未達項；不是錄製失敗，不重錄 |
| variant | ❌（門檻） | replay miss 0、缺向量 0、錯誤回放檔 2 支；`retrieved_coverage` 0.5000（**0.8367，未達**）；`gate_pass_rate` 0.4500（0.22，達標） | 錯誤回放檔是 var-008#1 的變式生成（`variant/66f37e00…`）與 var-015#1 的驗算（`verify/d5d8d07d…`）：原本是 replay miss（錄製時逾時與被截斷，當時的工具沒有留下回放檔，[`local-mode.md`](../local-mode.md) 10.23 第 1 點），2026-10-01 Owner 以 `.env` 的 `OLLAMA_MAX_OUTPUT_VARIANT=1024` 用 `record_local.bat variant --only-missing` 補錄，兩筆都被截斷，照實存成錯誤回放檔（`9137783`），回放記成那兩題沒通過。`retrieved_coverage` 0.5 是 V5-1 之後的已知狀況、與重錄無關；門檻不動、照實紅燈（A7），列為未達項 |

**開 PR 時要列的未達項（定案）**：
1. pipeline `gate_pass_rate` 0.8000 < 0.97（實錄；`answer_agree_rate` 0.9000 已達）
2. variant `retrieved_coverage` 0.5000 < 0.8367（variant 的 `gate_pass_rate` 0.4500 已達 0.22）

兩項都依 X1 帶紅燈合併、依 A7 門檻不動；其餘三個 eval（retrieval、classify、nlq）全過。

### 4.3 在 GitHub Actions 上會看到什麼

- `ci.yml` 的 integration job 依序跑 migrate → 整合測試 → e2e → 檢索 eval → 分類 eval → **管線 eval** → 查題 eval → 變式 eval，各步驟都沒有 `continue-on-error`。所以管線 eval 未達門檻時**這一步失敗、整個 integration job 是紅的**，後面的查題 eval 與變式 eval 兩步**不會執行**（只有「上傳 eval 報表」是 `if: always()`，報表照樣上傳）。上面 4.1、4.2 是在本機把每一步都跑完的結果。
- 依 X1 這是可以帶著合併的紅燈（只紅在 eval），但從 PR 頁面只看得到「integration 紅」，要點進 job 的紀錄確認紅在哪一步（第 5 節第 4 步）。本 PR **不改** `ci.yml`；要不要讓 eval 的紅燈不擋 job、或讓後面的 eval 照跑，是另外的 Owner 決定。

## 5. 合併前後 Owner 要做的事

**開 PR 之前**（其餘條件都已成立，見第 0 節）

1. **Owner 電腦：先 commit 補錄留下的兩支錯誤回放檔**。Owner 電腦現在的 HEAD 是 r10 的合併 `50f4a3e`（Owner 電腦上的 commit），2026-10-01 補錄寫出的 `exam_pro/eval/cassettes/variant/66f37e00….json` 與 `exam_pro/eval/cassettes/verify/d5d8d07d….json` 還沒 commit。r11 的 `9137783` 入庫的是同一次補錄的這兩支；先在 Owner 電腦 commit，下一步合併時兩邊新增同一個檔、內容相同，不會衝突（內容不同時 git 會報衝突：停下來比對，不要直接選一邊）。
2. **把 r11 併進 `local/integration`**（Owner 電腦上用 bat 做）：合併 `dec/integration-r11`（含本稿這個 commit）→ 讓 `local/integration` 指到合併後那一版。確認：`git diff dec/integration-r11 local/integration` 應該是空的（兩邊內容相同，只差 Owner 那一個 commit 與合併 commit；不空就先停下來看是什麼）；`git log --oneline origin/main..local/integration` 看得到 r11 的 `9137783`、`8d92d6a`、`9cc7bb8`、`f1a791c`、`b4d6709`、`30b44ba`。沒有這一步推上去的會是 `889d18f` 的舊版（比 r11 少 104 個 commit）。
3. 照第 1 節的說明對 `origin/main` 重算一次範圍數字（內容與 r11 相同時只有 commit 數變），必要時改第 1 節。第 4 節的數字不必重跑（內容相同）；要重跑時照 `ci.yml` 的 env、全新 UTF8 測試庫。
4. 由 Owner 的電腦把 `local/integration` 推上 GitHub（**推送時機由 Owner 決定**），以本稿開 PR 到 main，PR 說明列第 4.2 節的兩個未達項；等 GitHub Actions 的 unit、integration、desktop 三個 job 跑完。unit、desktop 兩個 job 必須綠；**integration job 預期是紅的**（第 4.3 節：紅在「管線 eval」那一步），要在 job 的紀錄裡確認它前面的 migrate、整合測試、e2e、檢索 eval、分類 eval 都是綠的，紅的只有管線 eval。

**合併之後（正式庫與日常使用）**

5. 正式庫：`node migrate.js status` 看到哪一支；沒到 0020 就照第 3 節升級（先停服務、先備份）；清 `.env` 裡的舊門檻四行。`.env` 裡 2026-10-01 為補錄加的 `OLLAMA_MAX_OUTPUT_VARIANT=1024` 那一行**可以刪**：值與程式預設相同（R7-1，10.24 第 5 點），刪不刪送出的都一樣，只差啟動訊息列在「生效的」還是「本機預設」。
6. 知識點：`npm run kc:load -- --dry-run` 看過再載入（三科；物理維持草稿，K-P）；之後 B12 的 20 題試標（`kc:backfill -- --limit 20`）。
7. （要用時）桌面圖示：雙擊 `exam_pro\scripts\windows\install_desktop_shortcut.bat`（啟動器 A）；桌面版 B1 另用 `install_desktop_app.bat`，照 `desktop-app-design.md` 6.2 驗收（含 B1 收尾的第 13、14 步）；`.env` 原本靠「聽全部介面」給區網用的話要加 `HOST=0.0.0.0`（DA-11）；`FEATURE_RETRAIN=true` 後在瀏覽器實際走一遍錯題重練（這些畫面只以 miniDom 與一次性冒煙測過）。
8. desktop 進 CI 之後 Owner 要做的：`desktop-app-design.md` 6.2「Owner 同意時要做的」第 2～5 點（main 要不要把 `desktop` 設成必要檢查、Dependabot 的 Electron PR 怎麼處理等）。
9. 10.21 第 4 步其餘各點：`perf:local`（三次重錄的 log）、`embed:thresholds` → Claude 重標初判 → O-4 抽查 10～15 支 → 定案 V5-2（現在的 0.87 是暫定）；`cassettes:prune` 只列、不 `--apply`。第 5 步 C-e 量測在電腦閒著時做。
10. 仍待 Owner 的：DEC-013 核准欄明示簽核；A3（nlq-036 計分）、B18、B19、ADR-017 定案條件（§3.1）；**B2 等 Owner 驗收 A 與 B1 之後再送**（R7-5＝1，`dec/r8-b2-paths-fix`），D2、B3 照設計稿另排；DA-9 的前提（Smart App Control 關閉）與 DA-14 的 `.wslconfig` 由 Owner 確認。

## 6. 隨本 PR 一起送的測試整理（`dec/r7-test-hygiene`＋審查修正 `dec/r7-test-hygiene-fix`）

> 〔2026-10-01 r11〕本節是 2026-09-27 的紀錄，內容保留。樣卷的 `extract_ocr.v2` 錄好（`e9d4aa6`）之後，下面最後一點說的三處已轉成硬斷言，在 r11 全部通過（第 4.1 節：unit 只剩 ocr 模式固定的 1 則略過、e2e 12 過）；第 7 節 TH-1 因此不必答。

只改測試與文件（`eval/CHAPTER_RELABEL-2026-09.md` 一處註記、`docs/local-mode.md` 10.21 第 3 步的頁數與時間、本說明稿），沒有動產品程式、`eval/lib`、`eval/thresholds.json`、golden、既有回放檔、模板、schema 或 `cacheKeyParts`；斷言沒有放寬。

- 原本在本機模式下**永遠 skip 或空轉**的測試改成真的在測：`cassetteReplay`（classify 組改用 `MODEL_TEXT` 算鍵並回放 classify.v2；extract 組改驗 `extract_ocr`）、`evalPipeline` 兩則（只在「唯一的 miss 就是樣卷的 extract_ocr」時 skip，其他 replay miss 一律紅）、`evalVariant`／`evalStage3`（改讀 CI 的向量檔，runVariantSuite 一組不再永遠 skip；「沒有 cassette 時」改用空的暫存目錄真的驗）、移除等於沒做事的 `test/fixtures/planChapters.preload.js`、`answerGolden` 的裁決探針改成硬斷言，以及幾處「資料不在就 return」改成明確 skip 或斷言。
- 審查修正（`dec/r7-test-hygiene-fix`）：
  - `cassetteReplay`：樣卷或答案卷壞掉時不再讓整支檔案在載入時爆掉——新增一則一定執行的「樣卷前提」（壞了就紅燈、丟出原錯誤），extract_ocr 兩組 skip 並指向它，classify 各組照常跑（實測：在樣卷尾端多寫一個位元組，只有「樣卷前提」紅、classify 三組照跑）。「classify 讀 `MODEL_TEXT` 的鍵」那一則移到不會 skip 的「classify 的回放鍵」組，並新增一則「回放檔在就命中、不在時 miss 的鍵等於預期鍵」（實測：暫時移走 #9 的 classify.v2 回放檔，classify 組 skip，這兩則照跑且通過）。
  - `evalVariant`：Gemini 的舊向量檔只在 CI 那一份齊全時才讀、讀不到就接住，只讓「向量不齊時拒絕執行」那一則 skip 並說明（實測：暫時移走那一份，其他各組照跑）。那一份不見時 `recordEmbeddings.test.js` 本來就會紅，不會悄悄過。
  - `evalPipeline` 與 e2e 的交叉驗證項目在 ocr 模式改成**明列 SKIP 並寫原因**（原本 `() => {}` 根本不註冊，報表看不到）：unit 多 1 則、e2e 多 2 則固定的 SKIP；e2e 的回放驗證表那一列因此是 `pass 12／fail 0／skipped 2`。
  - e2e「沒有任何一筆 replay miss」與 integration `retrievalEval` 的訊息不再叫人「執行 eval:record（需要金鑰）」，改指 10.21 第 3 步的重錄（只改訊息，斷言不動）；`localModeSections.test.js` 的節號登記表跟著登記 e2e 那支檔多指到 10.21。
- 本分支實跑（同第 4 節的環境，2026-09-27 審查修正後）：unit 4,061 則，4,058 過、0 失敗、3 則 SKIP（`evalPipeline` 等 extract_ocr 的兩則＋交叉驗證那一則）另有 `cassetteReplay` 的 extract_ocr 組整組 SKIP；等回放檔的只剩同一支——樣卷的 `extract_ocr.v2`（10.21 第 3 步），skip 訊息指名這一步。`check:html` 過、migrate 到 0020、integration 629 全過；e2e 14 項：9 過、3 紅（同第 4.1 節，`extract_ocr/a5918283…`）、2 項是上面說的交叉驗證 SKIP。
- **第 3 步錄好之後這三處會自動轉成硬斷言**〔2026-10-01：已轉成硬斷言並通過，上方註記〕：`cassetteReplay` 要求樣卷每一題都過 ajv、至少 8 題、兩科都有、每題標 `ocr_only`；`evalPipeline` 要求 10 題都走到終態、ocr 模式一題都不自動入庫。那時若出現下游（分類、lint、驗算）的 replay miss，這兩支會**紅燈而不是 skip**——代表 unit 環境（沒有資料庫）與錄製時算出的鍵不同，要先查清楚再合併。其中幾條其實是在量本機模型的拆題品質，可能因此變紅：怎麼處理見第 7 節 TH-1。

## 7. ~~待 Owner 決定：~~TH-1　錄好之後，單元測試與 e2e 因本機模型的拆題品質變紅時怎麼辦——**不必答（錄完沒紅）**

> 〔2026-10-01 r11〕**不必答**：第 2、3 步錄完（`e9d4aa6`）、variant 補錄（`9137783`）之後，unit 與 e2e 都沒有紅（第 4.1 節），下面的品質條件全部通過，斷言一條都沒改。以下保留做紀錄。
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
