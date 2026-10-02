# exam_pro · 出題系統本體

[![CI](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml/badge.svg)](https://github.com/Tom-Yang-Ben/tutor-exam-bank/actions/workflows/ci.yml)

這份文件給想自己裝起來用的人。系統是什麼、架構怎麼設計、評測數字是多少，請看[根目錄 README](../README.md)。預設是**本機模式**：AI 步驟都跑在這台電腦上（Ollama＋PaddleOCR），執行時不連外，也不花 API 費用。

## 前置需求

- **Node.js 24**（CI 也會用 22 跑一次）
- **Docker Desktop**（Windows 要用 WSL2 後端）：資料庫跑在容器裡，映像是 `pgvector/pgvector:pg16`
- **本機模式**另外要裝：[Ollama](https://ollama.com/download) 與 Python 3.11 或 3.12（64 位元），還要約 15 GB 的磁碟空間
- （選用）[Gemini API 金鑰](https://aistudio.google.com/apikey)：只有切回 Gemini 時才需要

## 安裝

```bash
cd exam_pro
npm install
cp .env.example .env
npm run db:up            # 開發庫在 5442 埠（volume），測試庫在 5433 埠（tmpfs），都只綁 127.0.0.1
npm run migrate          # 套用 migrations/（只會往前套，已套用的重跑不會有動作）
node seed_questions.js --apply   # （選做）題庫是空的時候，灌入 30 題自製示範題
```

**本機模型（第一次使用）**：在 Windows 上雙擊 `scripts\windows\setup_local_ai.bat`。它會依序檢查 Ollama、下載三個模型（約 12 GB）、建立 PaddleOCR 的虛擬環境，最後做自我檢查；log 存在 `data\local_ai\`。之後想單獨檢查 OCR，可以執行 `npm run ocr:selftest`。

## `.env` 重點

完整的變數表在 [`deployment_and_operations.md`](../engineering_docs/06_ops/deployment_and_operations.md) §3.2，`.env.example` 也逐項寫了註解。下面只列最重要的幾個：

| 變數 | 說明 | 預設 |
|---|---|---|
| `LLM_MODE` ／ `EMBED_MODE` | 範本預設只讀回放檔，**要真的呼叫模型時，兩個都要改成 `live`** | `replay` ／ `fixture` |
| `MODEL_EXTRACT` ／ `MODEL_VERIFY` ／ `EMBED_MODEL` | 模型設定，格式是 `vendor:model-id`。切回 Gemini 就改成 `gemini:…`，再填上 `GEMINI_API_KEY`（見 [`docs/local-mode.md`](../docs/local-mode.md) 10.4） | `ollama:qwen3-vl:8b` ／ `ollama:qwen3:8b` ／ `ollama:qwen3-embedding:0.6b` |
| `LOCAL_EXTRACT_MODE` | `ocr`：只用 OCR 拆題，每一題都停在人工複核；`cross`：OCR 和看圖模型交叉比對（只用 CPU 時非常慢） | `ocr` |
| `HOST` | 後端監聽的位址。不寫就只接受這台電腦的連線；要讓平板連進來，見[區網存取](#區網存取) | `127.0.0.1` |
| `DATABASE_URL` ／ `TEST_DATABASE_URL` | 正式庫／測試庫的連線字串。測試庫的庫名**必須以 `_test` 結尾**，否則 migrate 和測試會拒絕執行 | 5442 ／ 5433 |
| `API_KEY` | 存取 API 用的金鑰，留空就不檢查。**這把金鑰會被注入首頁，不能當作存取控制**（見[安全](#安全)） | 空 |
| `FEATURE_*` | 功能旗標，**預設全關**。建議一次只開一個，開完重啟再試用。主要有：`PIPELINE`（上傳拆題）、`STUDENTS`、`SIMILAR`、`NLQ`、`VARIANTS`、`ASSISTANT`、`KC`、`REMEDIAL`、`RETRAIN`、`TUTOR`、`VOICE`（只能在 Gemini 模式用） | `false` |

如果題庫原本是用 Gemini 的向量建的，換到本機模型之後要重算一次：先 `npm run embed:backfill`，再 `npm run search:reindex`。

不改 `.env` 也能逐次切換：上傳考卷的「辨識方式」、AI 家教與助教的「回答方式」都可選本機或 Gemini（Gemini 要先填 `GEMINI_API_KEY`；向量不跟著換），說明見 [`docs/local-mode.md`](../docs/local-mode.md) 10.26。

## 啟動

```bash
npm start        # http://localhost:3000
npm run dev      # 開發用（nodemon 改檔自動重啟）
```

- **桌面啟動器 A**：雙擊一次 `scripts\windows\install_desktop_shortcut.bat`，桌面會出現「出題系統」和「關閉出題系統」兩個圖示。點「出題系統」會依序開 Docker、資料庫、Ollama 和後端，最後開出操作視窗（[`docs/desktop-launcher.md`](../docs/desktop-launcher.md)）。
- **Electron 桌面版 B1（待驗收）**：雙擊一次 `scripts\windows\install_desktop_app.bat`，第一次執行會下載 Electron，之後點「出題系統（桌面版）」就會在同一個視窗裡開好整套系統。有背景工作時關掉視窗，系統會縮到系統匣繼續跑。驗收步驟見 [`docs/desktop-app-design.md`](../docs/desktop-app-design.md) 第 6.2 節。

## 常用指令

| 指令 | 用途 |
|---|---|
| `npm test` | 單元測試：不連資料庫、不連網，也不需要 `.env` |
| `npm run check:html` | 檢查前端 inline script 的語法、前端接點，並確認沒有引用外部資源 |
| `npm run db:up` → `npm run migrate:test` | 起測試庫（5433）並套用 migration，接著用下方兩行跑整合測試與 e2e |
| `npm run eval -- --suite <retrieval\|classify\|pipeline\|nlq\|variant>` | 讀回放檔量測指標，報表寫到 `eval/reports/`（[`eval/README.md`](./eval/README.md)） |
| `npm run migrate` ／ `node migrate.js status` | 套用 migration ／ 查看每一支的套用狀態 |
| `npm run db:backup` | 用 `pg_dump` 備份到 `backups/`，結果記在 `backups/backup.log` |
| `npm run cassettes:rerecord -- --only-missing` | 用本機模型只補錄缺少的回放檔（加 `--dry-run` 只做盤點，不呼叫模型）；Windows 可改用 `scripts\windows\record_local.bat` |
| `npm run embed:backfill` ／ `npm run search:reindex` | 重算題目向量 ／ 重建全文索引 |
| `npm run perf:local` | 統計本機模型錄製回放檔時的實際耗時（只讀檔案，不呼叫模型） |

整合測試與 e2e 在本機上要多帶一個 `--env-file=.env`，原因見[常見問題](#常見問題)第 1 條：

```bash
node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/integration/**/*.test.js"
node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/e2e/**/*.test.js"
```

## Windows 維運 `.bat` 一覽

| 檔案 | 作用 |
|---|---|
| `啟動資料庫.bat` | 先檢查 Docker，再起資料庫容器並套用 migrations |
| `備份資料庫.bat` | 備份資料庫到 `backups\`；失敗時視窗會留著，方便看錯誤 |
| `回填向量.bat` | 補算題目向量（依 `.env` 的 `EMBED_MODEL`），中斷後可以接著跑 |
| `執行公式健檢.bat` ／ `預覽公式修正.bat` ／ `套用公式修正.bat` | 掃描公式問題並產生報告 ／ 預覽修正內容 ／ 套用修正（套用前會先備份） |
| `scripts\windows\setup_local_ai.bat` | 一鍵安裝本機模式（模型、PaddleOCR、自我檢查） |
| `scripts\windows\record_local.bat` | 用本機模型重錄 CI 的回放檔（可加 `--only-missing`） |
| `scripts\windows\install_desktop_shortcut.bat` | 建立桌面啟動器 A 的圖示（加 `--remove` 移除） |
| `scripts\windows\install_desktop_app.bat` | 安裝 Electron 桌面版 B1 的圖示（`--reinstall` 重裝、`--remove` 移除） |
| `scripts\windows\backfill_figures.bat` | 幫舊題補附圖（只產生提議，不寫入；說明見 [`docs/figures.md`](../docs/figures.md)） |
| `scripts\windows\wsl_memory_check.bat` | 檢查 WSL／Docker 的記憶體與 Smart App Control（只讀，不改任何設定） |

> 備份檔（`*_backup_*.json`）和公式報告裡都有題庫資料，已經由 `.gitignore` 排除，請勿外流。

## API

所有路由都在 `/api` 底下；設定了 `API_KEY` 時，請求要帶 `x-api-key` 標頭。除了核心路由，其他路由都要打開對應的 `FEATURE_*` 旗標才會掛載。

- 端點總表、認證、限流與錯誤語意：[`engineering_docs/04_design/api_spec.md`](../engineering_docs/04_design/api_spec.md)
- 請求和回應的格式：[`engineering_docs/04_design/openapi-exam-pro-v1.yaml`](../engineering_docs/04_design/openapi-exam-pro-v1.yaml)
- 路由掛載的單一真相：[`routes/index.js`](./routes/index.js)

## 安全

- `.env` 裡有金鑰，已經由 `.gitignore` 排除。如果金鑰曾經外流，請到 Google AI Studio 重新產生。
- 要對外部署時，一定要設定 `ALLOWED_ORIGINS`、`NODE_ENV=production`，並在前面加一層反向代理做驗證（見下方 `API_KEY` 的能力邊界）。
- 匯入題目的著作權仍屬原著作權人，請先確認自己有合法權源（[`NOTICE`](../NOTICE)）。

### 區網存取

`.env` 不寫 `HOST` 時，後端只監聽 `127.0.0.1`，只有這台電腦連得到。想在課堂上用平板打開時，在 `.env` 加一行 `HOST=0.0.0.0`，重新啟動後端，並把下面三件事一起做完：

1. **Windows 防火牆只允許「私人網路」**：第一次啟動時，Windows 會詢問是否允許 Node.js 通過防火牆，只勾「私人網路」，不要勾公用網路。目前連線的 Wi-Fi 也要在設定裡設成私人網路。
2. **把平板用的網址加進 `ALLOWED_ORIGINS`**：例如 `http://localhost:3000,http://192.168.1.23:3000`（IP 用 `ipconfig` 查）。沒加的話，從平板送出的操作會被 CORS 擋下來。
3. **`API_KEY` 不是存取控制**：同一個網路裡，任何打得開首頁的人都拿得到它。只在自己家或信得過的網路使用；用完把 `HOST` 那一行刪掉，再重新啟動。

區網位址不是 HTTPS，所以瀏覽器不會開放麥克風（「按住說話」不能用）。

### `API_KEY` 的能力邊界

為了讓同源的前端自動帶上金鑰，`app.js` 回應首頁時會把 `API_KEY` 直接寫進 HTML。所以任何打得開 `/` 的人都拿得到這把金鑰，它只擋得住「沒載入首頁就直接打 API」的請求。要對外公開時，請改用反向代理驗證（Basic Auth、OAuth、IP 白名單）或真正的登入機制，不要依賴 `API_KEY`。

## 常見問題

1. **本機跑 `npm run test:integration` 全綠，但其實一條都沒跑？** 這兩支 npm script 是給 CI 用的，只載入 `eval/.env.replay`，沒有 `TEST_DATABASE_URL`，所以整層都會被跳過。本機請用上面[常用指令](#常用指令)裡的 `node --env-file=.env …` 那兩行，並且保留 `--test-concurrency=1`（各測試檔共用同一個測試庫）。
2. **連資料庫出現「密碼驗證失敗」？** 開發庫用的是 **5442** 埠，不是 5432。如果電腦上另外裝了原生的 PostgreSQL，它會占用 5432 埠。請確認 `.env` 的 `DATABASE_URL` 指向 5442。
3. **更新程式之後出現 500，或工作佇列暫停？** 新版本通常會帶來新的 migration。請先停掉服務，執行 `npm run db:backup`，再執行 `npm run migrate`，最後才啟動。就算 `FEATURE_RETRAIN` 是關的，錯題重練的 migration（0016～0018）也一定要套。完整步驟見 [`deployment_and_operations.md`](../engineering_docs/06_ops/deployment_and_operations.md) §3.6。
4. **上傳考卷後，每一題都停在複核？** 這是 `LOCAL_EXTRACT_MODE=ocr` 的設計：只用 CPU 時，看圖拆題太慢，所以改成只用 OCR 拆題，再由老師逐題核准。想讓 OCR 和看圖模型交叉比對，就改成 `cross`（見 [`docs/local-mode.md`](../docs/local-mode.md) 10.12）。
5. **本機模式很慢或出錯，要從哪裡查？** 先看 [`docs/local-mode.md`](../docs/local-mode.md) 10.8 的疑難排解，再用 `npm run perf:local` 看實測的速度；要切回 Gemini，照 10.4 做。
