# 桌面應用程式設計稿：B（Electron 桌面殼）＋ D2（原生 PostgreSQL、拿掉 Docker）

> **狀態：設計稿與決策草稿，尚未實作。** 分支 `dec/desktop-app-design`，基底 `local/integration-r6`（`0ba9bc6`）。這次只改文件，沒有產品程式。
> **版本**：第一版草稿是 `325c52b`（作者中斷時留下）；本版是逐節自我檢查、查證後的正式版。這次改了什麼，列在文末「自我檢查紀錄」。
> **Owner 的決定（2026-09-27）**：先做 A（啟動器）；B 與 D2 同時開始規劃，先不實作。A 在另一條分支 `dec/desktop-launcher` 上實作，目前有一個**未審查、未合併**的進行中 commit `d730422`（第 6.1 節列出它已經有的模組）。B1 開工前要先和 A 對齊（第 6.1 節）。
> **名詞**：
> - **A**：啟動器。雙擊一個檔案，它會開 Docker Desktop、開資料庫、檢查 Ollama、開伺服器和瀏覽器。
> - **B**：Electron 桌面殼（本文件）。
> - **D1**：繼續用 Docker 跑資料庫，由啟動器或 app 代為啟動。
> - **D2**：改用 Windows 原生的 PostgreSQL 16，平常不需要 Docker（本文件）。
>
> D1、D2 的定義以本文件為準。
> **查證標記**：
> - 〔查證 Sn〕：有來源，見第 9 條。
> - 〔未查證〕：查不到或不確定。
> - 〔推論〕：從文件或程式推得，沒有實測。
> - 〔要實測〕：只能在 Owner 的電腦上確認。
>
> 查證日期是 2026-09-27。
> **不變的原則**：
> - CI（`.github/workflows/ci.yml`）與錄製工具（`scripts/windows/record_local.bat`、`npm run cassettes:rerecord`）一律不改。
> - golden、cassette、`eval/thresholds.json` 都不動。
> - 網頁版（`npm start` 加瀏覽器）保留，預設行為不變。
> - 新的路徑設定沒寫的時候，一切照舊，所以現有的單元、整合、e2e 測試不必改。

---

## 0. 先回答 Owner 的三個問題

**問：做成應用程式以後，是不是就不必走網頁前端，點一下桌面圖示就能開啟整個系統？**

可以做到點一下圖示就跳出一個視窗直接操作。不必先開 Docker Desktop，不必開命令列，也不必打開瀏覽器輸入網址。

不過要先講清楚：視窗裡顯示的**還是現在這套前端**（`exam_pro/public` 的 HTML/JS），只是改由 app 自帶的 Chromium 顯示，不再用 Chrome。這也是這條路便宜的原因：前端幾乎不用改，要改的是三件事：誰負責把後端和資料庫開起來、資料放在哪裡、怎麼安裝和更新。

**問：要轉換或會變動的東西有哪些？**

分成四期（第 6 條），逐檔清單在第 3 條。

| 期別 | 做什麼 | 做完後 Owner 看得到的差別 | 估計工時 |
|---|---|---|---|
| B1 | Electron 殼加內嵌後端（資料庫仍在 Docker） | 雙擊圖示就出現視窗，有系統匣圖示。關視窗的行為照 DA-2 決定。Docker Desktop 還是要在跑，但由 app 代為啟動 | 約 50h，約 6～6.5 人日 |
| B2 | 路徑與設定搬出程式資料夾（`%LOCALAPPDATA%`／`%APPDATA%`，見 DA-1） | 程式和資料分開放，更新程式時不會動到題庫附圖、考卷 PDF 或備份 | 約 32h，約 4 人日 |
| D2 | 原生 PostgreSQL 16 加 pgvector，把資料搬過去 | 不必開 Docker Desktop，省下 WSL2 虛擬機吃掉的記憶體 | 約 43～51h，約 5.5～6.5 人日（含 pgvector 的取得） |
| B3 | 打包成安裝檔 | 有正式的安裝和解除安裝，也有開始選單捷徑 | 約 18～21h，約 2.5 人日 |

一人日以 8h 計。四期合計約 143～154h，也就是約 **18～19.5 人日**，包含單元測試與文件（第 6.6 節有逐期的算法）。Owner 自己要花的時間另外算：D2 的演練加搬家約 2～3 小時，B3 在自己電腦上試裝約 1 小時。

**問：Docker 的部分怎麼辦？**

- **B1 期間**：資料庫還在 Docker，由 app（或沿用 A 的邏輯）代為開 Docker Desktop 並執行 `docker compose up -d --wait`。
- **D2 之後**：正式庫改成原生 PostgreSQL，平常用 app 完全不需要 Docker。

建議（DA-7）：Docker Desktop **保留安裝，但不要開機自動啟動**，只在三種情況才開：

- 錄製 cassette：`record_local.bat` 用 Docker 的 5433 測試庫，和 CI 是同一顆映像。
- 在自己電腦上跑整合測試。
- 需要退回舊庫。

舊庫的 Docker volume 至少保留 30 天，當作回退用的備援（也就是 D1 狀態）。

為什麼不能只靠 Docker 自己的省資源模式：Docker Desktop 的 Resource Saver 在 WSL 2 上只會暫停 Docker 引擎，**不會減少記憶體用量**（〔查證 S30b〕）。要拿回記憶體，只能讓 Docker Desktop 不要開著。

---

## 1. 目標與範圍

### 1.1 目標

1. **一個圖示開全部**：雙擊之後依序啟動 PostgreSQL、檢查 Ollama、開後端，再開視窗。畫面上看得到每一步的狀態，任何一步失敗都會寫明原因和處置方法，不會留下一片白畫面。
2. **單一使用者、單機、離線**：執行期間不連到本機以外的地方，和 `docs/local-mode.md` 第 1 條一致。安裝階段例外，包括裝 Ollama 模型、PaddleOCR、編 pgvector。
3. **資料與程式分開**：更新或重裝程式不會動到資料。資料在哪裡、怎麼備份，都有一處說得清楚。
4. **保留網頁版**：`npm start` 加瀏覽器的用法不變，當作維護與除錯的後門。將來要用平板從區網連進來，也保留這個可能（DA-11），但預設不開。

### 1.2 不做（非目標）

- 多使用者、登入與角色、雲端部署、macOS 或 Linux 安裝檔。
- 把 Ollama 或模型包進安裝檔：三個模型約 12 GB，Ollama 本身也是獨立安裝的 Windows 程式。
- 把 PaddleOCR 的 Python 環境包進安裝檔：約 2～3 GB，而且 electron-builder 的 NSIS 安裝檔超過 2 GB 會壞掉（〔查證 S8〕）。
- 改前端架構：不做打包器，也不改成 React 之類的框架。
- 改任何 API 契約、資料表結構或 migration 內容。

### 1.3 現況（改之前）

Owner 的電腦：Windows 11 筆電，i5-8265U 等級、只有內顯、16 GB 記憶體。帳號資料夾是 `C:\Users\Administrator`（`docs/HANDOFF.md` 的 repo 路徑）。

目前的啟動順序：

1. 開 Docker Desktop。
2. 在 `exam_pro` 執行 `npm run db:up`，也就是 `docker compose up -d --wait`，啟動 `pgvector/pgvector:pg16`，埠 5442。
3. 確認 Ollama 在跑（Windows 原生，`http://localhost:11434`）。
4. 執行 `npm start`：Express 5，埠 3000；背景拆題的工作以 `JOB_RUNNER=inline` 跑在同一個 Node 行程。
5. 開瀏覽器到 `localhost:3000`。

另外幾件相關的現況：

- PaddleOCR 的 Python 環境在 `exam_pro/ocr_service/.venv`，由 `setup_local_ai.bat` 建立。
- 每天 02:00 由 Windows 工作排程器的「題庫每日備份」跑 `備份資料庫.bat`，借用容器裡的 `pg_dump`（`engineering_docs/06_ops/deployment_and_operations.md` §6）。
- 這台電腦**另外有一個原生的 PostgreSQL 17 服務占著 5432**（`exam_pro/docker-compose.yml` 檔頭的註解）。但 `scripts/backup.js` 的檔頭記載 `where pg_dump` 沒有結果，所以 PG17 的工具**不在 `PATH` 裡**；它的 `bin` 資料夾在哪裡〔要實測〕。
- 啟動用的 `.bat`（`exam_pro\啟動資料庫.bat`、`備份資料庫.bat` 等）都在版控裡。

---

## 2. 架構

### 2.1 目標架構一覽

```
┌─────────────────────────── Electron app（desktop/） ───────────────────────────┐
│ 主行程 main.js                                                                │
│   ├─ 單一實例鎖、系統匣、視窗、關閉行為、日誌檔                                   │
│   ├─ 設定：讀 %APPDATA%\TutorExamBank\.env ＋ 執行期算出的值（埠、DATABASE_URL…）  │
│   ├─ pgManager：原生 PostgreSQL 的 initdb／啟動／健康檢查／停止（D2 之後）         │
│   ├─ 健康檢查：Ollama（/api/version、/api/tags）、OCR 的 python 是否存在          │
│   └─ backendHost：用 utilityProcess 開後端（DA-3），監看、崩潰時重開               │
│                                                                                 │
│ 後端行程（exam_pro/server.js 匯出的 startServer）                                  │
│   └─ Express（只綁 127.0.0.1）＋ inline jobRunner ＋ 靜態 public/、/vendor、/figures │
│                                                                                 │
│ 視窗（Chromium renderer）                                                         │
│   └─ 載入 http://127.0.0.1:<埠>/ —— 就是現在那一套 public/，一行不改               │
└─────────────────────────────────────────────────────────────────────────────────┘
        │ SQL（127.0.0.1:<PG 埠>）           │ HTTP（127.0.0.1:11434）      │ spawn
        ▼                                     ▼                              ▼
  PostgreSQL 16＋pgvector（原生，D2）     Ollama（Windows 原生，不包）     PaddleOCR（venv，不包）
  B1 期間仍是 Docker 的 5442
```

程式碼放在 repo 最上層新開的 `desktop/` 資料夾（和 `exam_pro/` 同一層），有自己的 `package.json` 和 lock 檔，`electron` 和 `electron-builder` 都只列在這裡。這樣 `exam_pro` 的 `npm ci`、`package-lock.json` 與 CI 都不受影響。Electron 的執行檔壓縮後約 158 MB（〔查證 S36〕），放進 `exam_pro` 的相依套件會讓 CI 每次都下載它。

### 2.2 Electron 版本與 Node 相容性

- 目前的穩定版：
  - Electron 44 是 2026-08-25 發布的穩定版（〔查證 S1〕）。44.0.0 內建 Node v24.18.1（〔查證 S1〕）；目前最新的 44.4.5（2026-09-23）內建 Node 24.21.0、Chromium 152（〔查證 S2〕）。npm 上的 `electron` 最新版也是 44.4.5；`electron-builder` 是 26.15.3，`electron-updater` 是 6.8.9（〔查證 S38〕，2026-09-27 查 npm）。
  - Electron 45 預定 2026-10-20 發布穩定版，46 預定 2027-01-05，兩者都內建 Node v24.21.0（〔查證 S1〕）。
- 支援期：官方只支援最新的三個穩定大版本（〔查證 S3〕），每 8 週出一個大版本，所以一個大版本大約只有半年支援。Electron 44 的支援到 2027-03-02 結束（〔查證 S1〕）。
- 和專案的相容性：專案現在用 Node 24（README、`setup_local_ai.bat`），CI 矩陣是 22 和 24；`exam_pro/package.json` 沒有寫 `engines`。Electron 44／45 內建的 Node 24.x 是同一個大版本，`package-lock.json` 裡每個相依套件的 `engines` 都滿足：sharp 要 `>=20.9.0`，`@google/genai` 要 `>=20.0.0`，`@node-rs/jieba` 要 `>= 10`。**建議 B1 固定用 Electron 44.4.x 以上**，它的 Node（24.21.0）和 Owner 電腦上的 Node 24 同一條線〔Owner 電腦的確切小版本要實測〕。
- 原生模組：
  - `sharp` 和 `@node-rs/jieba` 都是 Node-API 模組，不必替 Electron 重新編譯。sharp 官方說 Node-API v9 的執行環境就能跑（〔查證 S9〕）。
  - 兩者都要從 asar 解開放在外面（2.9 節）。
  - 兩者靠 npm 的 optional dependency 安裝平台專用的二進位檔，例如 `@img/sharp-win32-x64` 和 `@node-rs/jieba-win32-x64-msvc`。在 Linux 上裝只會拿到 linux-x64（本 worktree 的 `npm ci` 裝的就是 `@img/sharp-linux-x64`、`@img/sharp-libvips-linux-x64` 和 `@node-rs/jieba-linux-x64-gnu`）。sharp 官方有跨平台安裝的旗標（`npm install --cpu=x64 --os=…`，〔查證 S9〕），但 `@node-rs/jieba` 等其他套件是否同樣適用〔未查證〕。**最簡單的做法是打包時的 `npm ci` 在 Windows 上跑**，而 B3 本來就在 Owner 的電腦上 build（DA-6、DA-9）。
- `mupdf` 是 ESM 加 WASM，由 `services/mupdf.js` 用 `import('mupdf')` 動態載入。在 Electron 的 Node 環境可以動態 import ESM；但在 asar 裡能不能讀到 WASM 檔〔要實測〕，保守做法是一併解開放在外面。

### 2.3 `server.js` 改成可以呼叫的模組

基底 `0ba9bc6` 的 `exam_pro/server.js`（16 行）在載入時會做三件事，而且都沒有回傳控制權：

- 呼叫 `dotenv.config()`，從目前工作目錄讀 `.env`。
- 呼叫 `app.listen(PORT)`，沒有指定 host，所以綁在所有網路介面。
- 呼叫 `startInlineRunner()`，而且丟掉回傳的 runner。

A 的進行中 commit（`d730422`）已經把 `server` 和 `runner` 留下來，交給 `services/launcherControl.js` 做「優雅關閉」（第 6.1 節）。B1 要在 A 合併之後的版本上改，不要各改一份。

改法：

```js
// exam_pro/server.js（草案；介面在 B1 凍結）
async function startServer({ port = 0, host = '127.0.0.1', onLog } = {}) → {
    url,            // 'http://127.0.0.1:53124'
    port,           // 實際綁到的埠（port=0 時由系統挑）
    runner,         // startInlineRunner() 的回傳值（JOB_RUNNER=off 時為 null）
    close(opts)     // 停止認領新工作 → 等在途節點（或放棄，見下面第 3 點）→ server.close() → pool.end()
}
if (require.main === module) { require('dotenv').config(); /* 照舊：listen(PORT)，行為完全不變 */ }
```

- `node server.js` 和 `npm start` 的行為一個字都不變：一樣讀 `.env`、一樣聽 `PORT`、一樣綁所有網路介面。改不改綁定位址由 DA-11 決定。
- `startServer()` 本身**不讀 `.env`**。環境變數由呼叫它的人事先放好，因為 `config/db.js`、`config/features.js`、`routes/index.js` 都在 require 的當下讀 `process.env`（`config/db.js:26-31` 缺 `DATABASE_URL` 會直接丟錯）。
- **「中止在途節點」不能直接用現有的 abort**。現況與陷阱：
  1. `runner.stop()` 只會停止計時器（`workers/jobRunner.js:1833-1835`），不會中止還在跑的節點。
  2. 每個節點本來就有自己的 AbortController（`invokeNode`，`workers/jobRunner.js:826`），逾時時會 abort（`:870`）；`services/ocr/index.js` 收到 signal 會殺掉 python 子行程。
  3. **但被 abort 的節點會被歸類成 `timeout`**（`classifyError`，`:890-895`：`AbortError` 一律算逾時），照一般錯誤寫進 `job_events`，事件表會多出假的逾時。後果分兩種：
     - 題目層的節點（分類、驗算等）：算一次 error、累加 `retries` 後放掉租約（`:1214-1243`），error 最多重試 3 次（`maxErrorRetries`，`pipeline/stateMachine.js:64-68`），用完就以 `provider_error` 進人工複核。也就是**關三次 app 就可能把一題送進複核**。
     - 拆題的一塊（`runExtractChunk`，`:1336-1427`）更糟：逾時會在同一個迴圈裡**立刻重試**，本機模式逾時只重試 1 次（Owner 第四輪 V3，`:1408-1412`），第二次又被關閉流程中止的話，**整份卷就變成 `failed`**。
  4. 所以要加的是另一條路：`shutdown({ abandon: true })` 先標記「正在關閉」，再 abort 在途節點；runner 看到這個標記時**不寫 outcome、不動 `retries`**，只放掉租約。`job_questions` 已經有現成的寫法可以照抄：工作單位沒寫回狀態就結束時，`finally` 會執行 `UPDATE job_questions SET locked_until = NULL`（`:1265-1269`）。拆題工作（`jobs` 表，`runExtractJob`）也要同樣處理。這樣下次開 app 立刻就能重新認領，從那個節點的開頭重跑，不必等 180 秒的租約。
  5. 反過來說，**直接結束行程不會吃掉重試次數**：沒寫 outcome，只是租約要等到期。A 的關閉通道在寬限時間到了就直接結束（`d730422` 的 `launcherControl.js` 檔頭），就是這種情形。
- 子行程會不會變孤兒：Node（libuv）在 Windows 上以非 detached 方式 spawn 的子行程，會被放進一個「父行程結束就全部終止」的 job object（〔查證 S41〕）。`services/ocr/index.js` 用 `shell: false`、沒有 detached，所以**後端行程一結束，python 就會被 Windows 直接終止**，第一版草稿「會變成孤兒」的推論不對。但這條保證只涵蓋直接的子行程，孫行程不受影響（同一個 job 設了 `SILENT_BREAKAWAY_OK`）。所以要不要「放棄在途節點」的考量是上一點的重試次數與關閉速度，不是孤兒行程。
- Ollama 那一端：後端結束時連線中斷，Ollama 是否會立刻停止生成〔未查證〕。最壞情況是它把這一次生成跑完才釋放 CPU。

### 2.4 視窗

- `BrowserWindow` 載入 `http://127.0.0.1:<後端埠>/`，也就是現在的首頁，由 `serveIndex` 注入旗標和 API 金鑰（`app.js:122-155`）。
- 設定用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，不需要 preload。前端只用 `fetch`，完全不用 Node 的功能。
- 為什麼不用自訂協定（例如 `app://`）：Electron 的安全指引建議用自訂協定取代 `file://`（〔查證 S12〕），但我們兩者都不用。前端到處都用相對路徑 `fetch('/api/...')`，還有 multipart 上傳、`/figures`、`/vendor`，用自訂協定就得把全部請求轉手給 Express，工多又容易出錯。改走本機迴路的 http，再用下面三點把風險收小。
  1. 後端只綁 `127.0.0.1`，區網連不到。
  2. `will-navigate` 只允許同一個來源；`setWindowOpenHandler` 一律拒絕開新視窗，要開外部網址時交給 `shell.openExternal`。現在的前端沒有任何外部連結（`public/` 裡找不到 `href="http`）。
  3. 權限處理器（第 3 條第 6 項）只放行麥克風，而且只放行我們自己的來源。
- 前端只用到 `confirm()`（`public/index.html:1070`、`:1080`），Electron 會跳原生對話框。前端沒有用到 Electron 不支援的 `window.prompt()`。
- `localStorage` 會隨來源（含埠號）分開存放；前端目前完全沒用 `localStorage`，所以埠號換了也不會掉資料。

### 2.5 原生 PostgreSQL 的管理（D2）

| 項目 | 設計 | 依據、風險 |
|---|---|---|
| 二進位檔 | EDB 提供的 Windows x86-64 PostgreSQL 16 zip。寫這份文件時 PG16 只列 16.15 一個版本（〔查證 S18〕）。只取 `bin/`、`lib/`、`share/`，不要 pgAdmin、StackBuilder 和文件。B3 用 `extraResources` 把它包進安裝檔；B3 之前先解壓到 `%LOCALAPPDATA%\TutorExamBank\pgsql16\`。**下載後自己算 SHA-256 記在文件裡**：EDB 沒有公布這個 zip 的雜湊值，2026-09-12 有人在 EDB 的 repo 開 issue 要求，到寫這份文件時沒有回應（〔查證 S18b〕） | EDB 的原話是：這些壓縮檔是「our PostgreSQL installers」安裝的檔案，「provided as a convenience for expert users」，一般人應該用安裝程式（〔查證 S18〕）。我們需要的正好是不裝 Windows 服務、由 app 自己管的形式。大小：16.1 的 zip 約 330 MB，其中 pgAdmin 4 解開後約 760 MB（〔查證 S18c〕，第三方腳本的說明）；只取執行需要的部分會小很多，確切數字〔要實測〕 |
| pgvector | 版本要和 Docker 裡那一版**完全相同**：先在舊庫查 `SELECT extversion FROM pg_extension WHERE extname='vector'`。映像標籤 `pg16` 目前對應 0.8.6（〔查證 S20〕），CI 每次都拉最新的 `pg16`，所以 CI 已經是 0.8.6；但 Owner 拉映像的時間比較早，實際版本**要查**。版本比 0.8.6 舊時的處理見 4.1 節。取得方式見 DA-5；pgvector 官方的 Windows 說明只有 Visual Studio 加 `nmake /F Makefile.win` 的編譯流程（〔查證 S19〕） | 第 7 條 R-1 |
| pg_trgm | 屬於 contrib（Additional Supplied Modules），是 trusted 擴充（〔查證 S23〕）。EDB 說 zip 就是安裝程式裝的那些檔案（〔查證 S18〕），所以〔推論〕應該有 `share/extension/pg_trgm.control` 和 `lib/pg_trgm.dll`；解壓後確認〔要實測〕 | migration 0002 會 `CREATE EXTENSION pg_trgm`。專案只用它建 `idx_questions_text_trgm` 索引（`migrations/0002_vector.sql:25`），程式裡沒有 `similarity()` 之類的呼叫 |
| 資料夾 | `%LOCALAPPDATA%\TutorExamBank\pgdata16\`，**路徑只用英數字**（DA-1） | Windows 上 PostgreSQL 碰到非 ASCII 路徑有已知問題：二進位檔所在路徑含非 ASCII 字元時 initdb 會失敗（PG13，〔查證 S27〕）；PG17 的 EDB 安裝程式在使用者暫存路徑含中文時，initdb 找不到密碼檔（〔查證 S28〕） |
| initdb | `initdb -D <pgdata> -U exam -E UTF8 --auth=scram-sha-256 --pwfile=<暫存檔> <locale 參數>`。locale 參數照 DA-12 在演練時決定。密碼檔放在 `pgdata` 旁邊用完就刪，不放 `%TEMP%` | Windows 上 UTF-8 可以搭配任何 locale（〔查證 S24〕）。排序規則的差異見 R-3 |
| 設定 | 在 `postgresql.conf` 追加：`listen_addresses = '127.0.0.1'`、`port = <DA 選的埠>`、`maintenance_work_mem = 256MB`（和 `docker-compose.yml` 的 `command` 相同）、`timezone = 'Asia/Taipei'`（和 compose 的 `TZ` 相同）、`logging_collector = on`（日誌寫在 `pgdata\log`） | 時區不同會影響重練排程的「日期」計算，搬家後要比對 `SHOW timezone` |
| 啟動 | **一定用 `pg_ctl start -w -D <pgdata> -l <日誌檔>`，不可直接執行 `postgres.exe`** | PostgreSQL 不肯在有系統管理員權限的帳號下執行（〔查證 S25〕），`pg_ctl` 會先降權再啟動（〔查證 S26〕）。Owner 的帳號資料夾叫 `Administrator`，如果真的是內建的 Administrator 帳號，所有行程都帶系統管理員權限〔要實測〕 |
| 健康檢查 | 先跑 `pg_isready -h 127.0.0.1 -p <埠>`，再用 `pg` 連線執行 `SELECT 1`。啟動逾時 60 秒；失敗時把 `pgdata\log` 的最後 30 行顯示在狀態畫面 | 異常關機後的崩潰回復可能要多幾秒 |
| 埠 | 平時預設 **5442**：D2 切換完成、Docker 停掉之後，沿用舊的埠號，`.env` 和文件都不必改。和 Docker 並行演練期間用 **5452**。啟動前先檢查埠有沒有被占用；被占用時，如果回應的是我們自己的叢集（`SELECT system_identifier FROM pg_control_system()` 和記下的值相同）就直接沿用，否則報錯，不會自動換埠，免得和舊的 Docker 庫搞混 | 5432 被 Owner 的 PG17 服務占著。自動換埠會讓 `DATABASE_URL` 每次不同，排查時很難看懂，所以寧可報錯 |
| 停止 | 結束 app 時，照 2.8 節的順序最後執行 `pg_ctl stop -m fast -w`。Windows 關機、重開或登出時，在 `query-session-end` 延遲一下並盡快停止（〔查證 S16〕） | 就算被強制中斷，PostgreSQL 下次啟動也會用 WAL 自動回復〔推論〕。**app 當掉時 PostgreSQL 不會跟著結束**：`pg_ctl` 是 app 的子行程，但 postgres 是 `pg_ctl` 再開出來的孫行程，不在 libuv 那個「父行程結束就終止」的 job 裡（〔查證 S41〕的 `SILENT_BREAKAWAY_OK`，〔推論〕）。下次開 app 時由上面「埠」那一列的判斷認出是自己的叢集並沿用 |
| 誰來管 | app 管理：開 app 才啟動，結束 app 就停止，不裝 Windows 服務（DA-4） | 備份的時機跟著改，見 DA-4 |

### 2.6 Ollama

- **不包進 app，也不由 app 管理它的生死。** Ollama 是 Owner 另外安裝的 Windows 程式，安裝時會自動加入開機啟動，在工作列右下角常駐。
- 啟動時檢查：
  1. `GET http://127.0.0.1:11434/api/version`。有設 `OLLAMA_HOST` 就照它。
  2. 不通的話，先找 Ollama 裝在哪裡：`setup_local_ai.bat` 的找法是先看 `PATH` 裡有沒有 `ollama`，再看 `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`（`setup_local_ai.bat:52-55`）。找得到的話，狀態畫面提供「啟動 Ollama」按鈕，找不到就提示先雙擊 `setup_local_ai.bat`。啟動方式沿用 A 的做法：A 的決策邏輯分成「開工作列的 Ollama app」和「`ollama serve`」兩種（`d730422` 的 `scripts/desktop/lib/plan.js`），B1 不另寫一套。
  3. `GET /api/tags` 和 `.env` 裡的 `MODEL_*`、`EMBED_MODEL` 比對，缺模型就警告，但不擋，因為沒上傳考卷時也能用題庫和組卷。
- 結束 app 時不關 Ollama（別的程式也可能在用）。可以另外做一個選項「結束時請 Ollama 立刻釋放模型」：對已載入的模型送 `keep_alive: 0`，立刻還給系統約 5～6 GB 記憶體（〔推論〕，依 `docs/local-mode.md` 10.14 (e) 的記憶體帳：`qwen3:8b` 權重約 5.2 GB，另加 KV cache）。預設關閉。
- Ollama 的環境變數（`OLLAMA_MAX_LOADED_MODELS`、`OLLAMA_NUM_PARALLEL`）是 Windows 使用者層級的設定，app 不碰。

### 2.7 PaddleOCR

- **Python 環境不包進 app。** 平常拆題時 app 照現在的方式 spawn `ocr_pdf.py`（`services/ocr/index.js`），只改路徑：
  - `ocr_service/ocr_pdf.py` 和 `requirements.txt` 必須放在 asar **外面**，因為外部的 python 讀不到 asar 裡的檔案（〔推論〕：Electron 只替自己的 Node 修補了 `fs`）。
  - `OCR_PYTHON` 在桌面版預設指向 `%LOCALAPPDATA%\TutorExamBank\ocr-venv\Scripts\python.exe`（B2）。
  - 網頁版沒寫 `OCR_PYTHON` 時照舊用 `exam_pro\ocr_service\.venv`（`services/ocr/index.js:105-126`）。
- 安裝：B2 讓 `setup_local_ai.bat` 可以用環境變數指定 venv 和 log 的位置，沒設時行為完全不變。B3 的首次啟動精靈可以代為執行它。**注意它有兩個隱藏的依賴**：要有 `node` 在 `PATH` 裡（`:46-47`），而且用 `eval\tools\tee_run.js` 把輸出同時寫進 log（`:48`）。安裝版的 staging 會排除 `eval/`（2.9 節），所以精靈要嘛把 `tee_run.js` 一起帶上，要嘛改用同一套步驟的 Node 版本（第 3 條第 15 項）。
- 自我檢查（`ocr_pdf.py --selftest`）在 Owner 的電腦上要 121 秒（專案文件 `local-mode-status-2026-09-25`：2026-09-25 裝好時的 OCR 自檢耗時），**不在每次啟動時跑**，只在安裝時和系統匣選單的「OCR 自我檢查」才跑。啟動時只檢查 `python.exe` 存不存在。

### 2.8 單一實例、系統匣與關閉行為

- **單一實例**：用 `app.requestSingleInstanceLock()`。第二次雙擊時，由第一個 app 收到 `second-instance` 事件，把視窗叫到前面（〔查證 S15〕）。這把鎖管不到 `npm start`：兩者同時開、又連到同一個庫時，會有兩個 runner 一起認領工作。資料不會壞，因為用租約防止重複認領；但並行數會加倍、記憶體吃緊。app 啟動時先檢查同一個庫裡有沒有別人持有、而且還沒到期的租約（`jobs`／`job_questions` 的 `locked_until > now()`，runner 在節點執行中會定期續租），有的話就警告〔推論〕。
- **系統匣選單**：開啟視窗；狀態（PostgreSQL、Ollama、背景工作 N 件）；立即備份；開啟資料夾（資料、備份、日誌）；OCR 自我檢查；維護命令列（第 3 條第 21 項）；結束。
- **關閉視窗**：照 DA-2。建議做法：有工作在處理時縮到系統匣繼續跑，並跳通知說明；沒有工作時直接結束。
- **結束的順序**：
  1. runner 停止認領新工作。
  2. 在途節點最多等 10 秒；等不到就依使用者的選擇（DA-2）：繼續等，或「放棄」。放棄走 2.3 節的 `shutdown({ abandon: true })`：abort 在途節點（OCR 子行程被殺掉），**不寫 outcome、不動重試次數**，只放掉租約。
  3. 關閉 HTTP 伺服器。
  4. 關閉 `pool`。
  5. 需要時做結束前備份（DA-4）。
  6. 執行 `pg_ctl stop -m fast`。
  7. 結束 app。

  被放棄的節點下次開 app 會立刻被重新認領，從那個節點的開頭重跑。如果是當機或被強制結束（沒走到第 2 步），租約要等 `JOB_LEASE_MS`（預設 180 秒，`workers/jobRunner.js:111`）到期才會被認領，同樣不會吃掉重試次數。本機的 OCR 整理一個節點可能要十幾到幾十分鐘，所以放棄之前一定要問使用者。

  這個順序和 A 的關閉通道（`d730422` 的 `services/launcherControl.js`：停止認領 → `server.close()` → 等在途工作到寬限時間 → 關 `pool` → 結束）是同一套想法；B1 要沿用同一份程式，只是 B 多了第 5、6 步，以及「放棄」這個選項。
- **開機自動啟動**：預設關閉，可以在設定裡用 `app.setLoginItemSettings` 打開（〔查證 S15〕）。
- **日誌**：桌面版沒有伺服器視窗，所以把後端的 stdout 和 stderr 寫到 `%LOCALAPPDATA%\TutorExamBank\logs\server-YYYYMMDD.log`，保留 14 天。現在印在伺服器視窗、要使用者採取行動的訊息，改成在狀態畫面或系統匣通知顯示。例子有兩個：「請先 `npm run migrate`」（`local-mode.md` 10.12 第 2 小節第 1 點、10.17），以及舊範本門檻的提醒（`workers/jobRunner.js:1825-1827`）。A 的 `/api/health` 已經會回報 migration 版本（`d730422` 的 `utils/migrationStatus.js`），狀態畫面直接用它。

### 2.9 打包重點（B3）

- 用 electron-builder 的 NSIS target，選 per-user 安裝，不需要系統管理員權限。這兩項都是預設：`oneClick: true`、`perMachine: false`（〔查證 S7〕）。
- `deleteAppDataOnUninstall` 維持預設的 false，解除安裝時不刪資料（〔查證 S7〕）。
- asar 開著，但下面這些要解開放在外面：
  - `**/node_modules/sharp/**` 和 `**/node_modules/@img/**`：sharp 官方指示（〔查證 S9〕）。
  - `**/node_modules/@node-rs/**`、`**/node_modules/mupdf/**`、`exam_pro/ocr_service/**`：〔推論〕，要在 B3 實測。
- PostgreSQL 的二進位檔用 `extraResources` 放。
- 打包前先跑一支 staging 腳本：從 `git ls-files` 取出 `exam_pro` 會用到的檔案，排除 `eval/`、`test/`、`docs/` 和 cassette（例外：`eval/tools/tee_run.js` 要留給 `setup_local_ai.bat`，2.7 節），然後在 Windows 上執行 `npm ci --omit=dev`，最後才交給 electron-builder。
- 大小估計〔未查證，B3 實測〕：Electron 本體的 zip 是 158 MB（〔查證 S36〕）；本 worktree 用 `npm ci` 裝完的 `node_modules` 是 193 MB（Linux 版，Windows 版的平台二進位不同），其中只供開發用的相依套件很少（nodemon、pdfkit、supertest）；PostgreSQL 16 的 EDB zip 連 pgAdmin 在內約 330 MB（〔查證 S18c〕，16.1 的數字），只取執行必要的部分估計數十 MB 到一百多 MB〔推論〕。安裝檔壓縮後估計 **150～250 MB**，遠低於 NSIS 的 2 GB 上限（〔查證 S8〕：超過時 electron-builder 不會報錯，只會產生壞掉的安裝檔）。

---

## 3. 要改的地方（逐檔盤點）

工時以小時（h）計，包含對應的單元測試，由 Claude 協作開發估計，不含 Owner 操作的時間。「期別」欄指在哪一期改。**預設不變**的意思是：新的環境變數沒寫時，行為和現在逐字相同，CI、現有測試、`npm start` 都不受影響。

| # | 檔案／位置 | 現況 | 改法 | 期別 | 工時 |
|---|---|---|---|---|---|
| 1 | `exam_pro/server.js`（基底 16 行；A 的 `d730422` 已改成留下 `server`、`runner` 並交給 `launcherControl`） | 載入時就 `dotenv.config()`、`app.listen(PORT)`（綁所有網路介面） | 照 2.3 節匯出 `startServer()`；`require.main === module` 時保留原本的行為。**在 A 合併之後的版本上改** | B1 | 3h |
| 2 | `workers/jobRunner.js`（`stop()` 在 `:1833-1835`、`invokeNode` 在 `:825-887`、拆題迴圈 `runExtractChunk` 在 `:1336-1427`、租約釋放在 `:1265-1269`） | `stop()` 只清計時器；每個節點雖然有自己的 AbortController，但被 abort 會記成 `timeout`、吃掉重試次數，拆題迴圈還會立刻重試 | 新增 `shutdown({ abandon, waitMs })`：先標記正在關閉，再 abort 在途節點；被這樣中止的節點**不寫 outcome、不動 `retries`、拆題迴圈不重試**，只放掉 `job_questions`／`jobs` 的 `locked_until`（2.3 節第 3、4 點）。單元測試要釘住「shutdown 中止後 `retries` 不變、沒有新的 `job_events`、job 不會變 `failed`」 | B1 | 8h |
| 3 | `app.js:31-43` 的 CORS（`ALLOWED_ORIGINS`，預設 `http://localhost:3000`） | 瀏覽器對同源請求，只要方法不是 GET 或 HEAD 就會帶 `Origin` 標頭（〔查證 S42〕）。來源不在清單時 `cors()` 丟錯，結果是 500。視窗如果載入 `http://127.0.0.1:<埠>`，每一個 POST 都會失敗〔推論〕（今天在瀏覽器打開 `http://127.0.0.1:3000` 應該也是同樣情形） | 由桌面版在執行期把 `http://127.0.0.1:<埠>,http://localhost:<埠>` 設進 `ALLOWED_ORIGINS`；程式不改，網頁版預設不變。B1 驗收要實際測一次上傳和組卷的 POST | B1 | 1h |
| 4 | `middleware/auth.js` 與 `app.js:122-153` 的 `serveIndex` 金鑰注入 | 沒設 `API_KEY` 就不檢查；設了就注入首頁，所以任何能打開首頁的人都拿得到金鑰（`roadmap-plan.md` 擱置區第 8 項：它不是存取控制） | 桌面版在第一次啟動時產生一組隨機金鑰存進設定，每次啟動時設進 `API_KEY`。本機其他程式要打 API 就得先讀首頁，門檻稍微提高。後端只綁 127.0.0.1，所以區網碰不到。程式不改。區網模式另外處理（DA-11） | B1 | 1h |
| 5 | Word 下載（`public/index.html:1888-1917`、`public/js/remedial.js:976-990`、`public/js/retrain.js:989-1000`，都是 Blob 加 `<a download>`） | 在瀏覽器裡直接下載到「下載」資料夾 | 前端不改。Electron 沒有指定存檔路徑時，會照一般流程處理，通常是跳出「另存新檔」對話框（〔查證 S14〕）。主行程在 `will-download` 用 `setSaveDialogOptions` 把預設資料夾設為「文件\出卷」，並記住上次用的資料夾。B1 驗收要確認對話框預填的檔名就是前端 `download` 屬性給的檔名（例如「XX 段考（學生版）.docx」）〔要實測〕 | B1 | 3h |
| 6 | 家教的「按住說話」麥克風（`public/js/tutor.js:157-168`、`:300-315`、`:496`） | 只在安全來源（localhost 或 HTTPS）才顯示按鈕 | `http://127.0.0.1` 在 Chromium 裡屬於安全來源，`isSecureContext` 為真，前端不改〔推論〕。Electron 預設會**自動核准所有權限請求**（〔查證 S12〕），所以要用 `setPermissionRequestHandler`／`setPermissionCheckHandler` 只放行「自己的來源、`media`、audio」，其他一律拒絕（〔查證 S13〕）。Windows 的「隱私權 → 麥克風 → 允許桌面應用程式存取」要打開。**注意**：語音路由只在 `MODEL_VOICE` 是 Gemini 時才掛上（`app.js` 的 `VOICE_ROUTE`），本機模式本來就不提供語音 | B1 | 2h |
| 7 | `desktop/`（新增） | 不存在 | `main.js`（單一實例、視窗、系統匣、關閉行為、狀態畫面、日誌）、`lib/backendHost.js`（utilityProcess，DA-3）、`lib/config.js`（讀 `.env` 加執行期的值）、`lib/health.js`（Ollama、Docker、OCR）。**B1 期間**仍要用 Docker 的庫，Docker Desktop 的啟動和 `docker compose up -d --wait` 沿用 A 的邏輯（第 6.1 節：A 的 `plan.js` 是純函式，可以直接 `require`；如果 A 合併時它還在，本項約可省 4h） | B1 | 26h |
| 8 | `desktop/` 的測試 | 無 | 純函式（埠、設定合併、來源清單、結束順序的狀態機）用 `node --test` 測，不需要 Electron。**先只在本機跑**；要進 CI 得改 `ci.yml`，要 Owner 同意 | B1 | 6h |
| 9 | `exam_pro/config/paths.js`（新增） | 路徑散在各檔，而且各自以 `__dirname` 或目前工作目錄為基準 | 集中成單一來源：`APP_DATA_DIR`（沒寫時等於 `exam_pro/`，也就是預設不變）→ `dataDir()`、`uploadsDir()`、`figuresDir()`、`jobsDir()`、`backupsDir()`。資料夾結構刻意保留 `data/`，所以 `APP_DATA_DIR\data\jobs\<id>.pdf` 和資料庫裡存的相對路徑 `data/jobs/<id>.pdf` 對得上，**不必改資料庫** | B2 | 4h |
| 10 | `app.js:9-27`（uploads）、`routes/index.js:7-10`（multer 的 `dest: 'uploads/'`） | 建目錄和 multer 用的是**目前工作目錄**，開機清理用的卻是 `__dirname/uploads`，兩者不一致。現在沒出事，只是因為 `npm start` 剛好在 `exam_pro` 執行 | 三處都改用 `paths.uploadsDir()` | B2 | 2h |
| 11 | `app.js:177-179`、`services/figureService.js:16`（`wordService.js:6`、`scripts/backfill_figures.js:1074` 都沿用它的 `FIGURES_DIR`） | 固定是 `exam_pro/data/figures` | 改用 `paths.figuresDir()`，沿用的地方自然跟著改。資料庫的 `question_img` 存的是網址 `/figures/<檔名>`，不必改 | B2 | 1h |
| 12 | `controllers/jobController.js:27-31`、`workers/jobRunner.js:43-49`（`resolveJobPath`） | PDF 存在 `exam_pro/data/jobs`，相對路徑以 `exam_pro/` 為基準解析。拆題完成後 worker 會刪檔、把 `jobs.pdf_path` 清成 NULL（根目錄 `.gitignore` 的說明），所以這裡平常只有排隊中或拆到一半的 PDF | 相對路徑改以 `APP_DATA_DIR` 為基準；絕對路徑照舊。測試裡有 7 個檔（18 處，都在 integration、e2e 與假 agent）假設 `APP_DIR/data/jobs`，因為預設不變所以都不用改；另外加一則 `APP_DATA_DIR` 指向暫存目錄的測試 | B2 | 3h |
| 13 | `.env` 的讀取（`server.js:1`、`migrate.js:12`、約 20 支 `scripts/*.js`，都讀目前工作目錄的 `.env`） | 全部依賴「在 `exam_pro` 資料夾執行」 | 桌面版：主行程用 `dotenv.parse` 讀 `%APPDATA%\TutorExamBank\.env`，疊上執行期的值（`PORT`、`DATABASE_URL`、`ALLOWED_ORIGINS`、`API_KEY`、`APP_DATA_DIR`、`OCR_PYTHON`）後，傳給後端行程的 `env`。命令列腳本不改，從維護命令列（第 21 項）執行時由環境變數帶入。**要檢查 `LLM_MODE=live`**：沒寫時程式預設是 `replay`（`services/llm/index.js:101`），而安裝版不帶 `eval/cassettes`，所以桌面版的設定缺這一行時要擋下並說明，不能靜靜地跑成回放模式 | B2 | 3h |
| 14 | `services/ocr/index.js:39-42`（`OCR_DIR = APP_DIR/ocr_service`）與 `:105-126`（預設的 python） | 腳本放在程式資料夾裡；打包後會在 asar 裡，外部的 python 讀不到 | `ocr_service/**` 解開放在 asar 外面；`SCRIPT_PATH` 在打包環境指向 `app.asar.unpacked`。`OCR_PYTHON` 由桌面版設定（2.7 節）。`requirements.txt` 用來當 cassette 鍵的版本來源，在 asar 外面照樣讀得到 | B2 | 3h |
| 15 | `scripts/windows/setup_local_ai.bat:22-31`（另外 `:46-48` 要求 `node` 在 `PATH`、用 `eval\tools\tee_run.js` 寫 log） | venv 固定建在 `exam_pro\ocr_service\.venv`，log 寫在 `exam_pro\data\local_ai` | 新增可選的環境變數 `SETUP_VENV_DIR`、`SETUP_LOG_DIR`，沒設時完全照舊。B3 的首次啟動精靈帶這兩個變數去呼叫它（staging 保留 `tee_run.js`，2.9 節），或改用同一套步驟的 Node 版本 | B2 | 4h |
| 16 | `scripts/windows/record_local.bat` | 用 Docker 的 5442 和 5433，也用 repo 裡的 `node_modules` | **不改**（原則）。桌面版和它互不干擾：它在 repo checkout 裡跑，用的是 Docker 的測試庫 | — | 0 |
| 17 | `.github/workflows/ci.yml` | 兩個 job：unit 與 integration（加上 e2e 和 eval） | **不改**。第 9～14 項新增的單元測試放在 `exam_pro/test/unit/`，自然會在現有的 unit job 裡跑 | — | 0 |
| 18 | 資料搬遷工具（新增，`desktop/scripts/migrate-data.js` 或 `exam_pro/scripts/`） | 無 | 把 `exam_pro\data\figures`、`data\jobs`、`backups\` 複製到新位置：先試跑列出清單，逐檔比對 sha256 後才算完成，舊檔**不刪**（等 Owner 自己確認）。資料庫不必改（第 9 項） | B2 | 6h |
| 19 | `scripts/backup.js:38`（預設 `exam_pro/backups`）與 `:63-90`（借容器裡的 `pg_dump`） | 只會用 Docker；附圖目錄沒有備份（擱置區第 6 項） | 新增原生模式：設了 `PG_BIN`，或 `BACKUP_MODE=native`／`auto`，就用 `<PG_BIN>\pg_dump.exe -Fc --no-owner --no-acl`，檔頭一樣驗 `PGDMP`。預設仍是 docker，行為不變。**順便把 `data/figures` 壓成同一個時間戳的 zip**，補上擱置區第 6 項的缺口。並匯出 `runBackup()` 給 app 呼叫。`log`／`LAST_FAILED.txt` 的規則不變 | D2 | 8h |
| 20 | `migrate.js`（全檔 73 行，CLI 用 `process.exit`） | 只能從命令列執行 | 抽出 `runMigrations({ connectionString, log }) → { applied, pending }`，CLI 外殼照舊。app 啟動時如果有待套的 migration，依序做：自動備份 → 快照 → 套用 → 快照 → 比對（第 5.3 節），不一致就停下並保留備份 | D2 | 6h |
| 21 | 命令列維護工具（`backfill_*`、`kc:load`、`report:jobs`、`chapters:migrate`、`scripts/backfill_figures.js:76`、`scripts/migrate_chapters.js:66` 等，會寫 `data/` 底下） | 在 `exam_pro` 用 `npm run …` 執行，資料庫由 Docker 常駐 | 系統匣選單加「維護命令列」：開一個 cmd，已經設好 `APP_DATA_DIR`、`DATABASE_URL`、`PATH`（包含 PG16 的 `bin`），工作目錄是 `exam_pro`（開發版在 repo 裡，安裝版在 `resources` 裡）。資料庫會一直開著，直到 app 結束 | B2 | 3h |
| 22 | `package.json:49-51`（`db:up`／`db:down`／`db:backup`） | `db:up`／`db:down` 呼叫 docker compose | **不改**：Docker 路線（D1、錄製、整合測試）照樣用；`db:backup` 走第 19 項的自動判斷 | — | 0 |
| 23 | `docker-compose.yml` | 5442 正式庫與 5433 測試庫 | **不改**：D2 之後 `postgres` 服務停用但 volume 保留（DA-7）；`postgres_test` 照舊給錄製與整合測試用 | — | 0 |
| 24 | `啟動資料庫.bat`、`備份資料庫.bat`、工作排程器的「題庫每日備份」（02:00） | 依賴 Docker | 網頁版照舊可以用。D2 之後排程改成 DA-4 的方案，建議停用 02:00 那一個，改由 app 在每天第一次開啟時和結束前備份 | D2 | 2h |
| 25 | pgManager（新增，`desktop/lib/pgManager.js`） | 無 | 照 2.5 節處理 initdb、`pg_ctl` 啟停、健康檢查、`postgresql.conf`、埠的判斷；把 pgvector 的 `vector.dll`、`vector.control`、`vector--*.sql` 放進 `lib/` 與 `share/extension/` | D2 | 12h |
| 26 | pgvector 的 Windows 二進位 | 無 | 照 DA-5 取得；只接受有 SHA256 和建置紀錄的檔案 | D2 | 4～12h |
| 27 | 通用快照比對腳本（新增，`scripts/snapshot_db.js`） | 只有 `scripts/snapshot_attempt_views.js`，專為 0016 前後的作答檢視設計 | 輸出第 4.3 節列的版本、列數、逐表雜湊、向量雜湊、索引、行為檢查；`--compare a.json b.json` 相同時回 0。D2 搬家與每次升級都用它 | D2 | 5h |
| 28 | 文件：`deployment_and_operations.md` §3、§6、`runbook-pg-down.md`、`exam_pro/README.md` 快速開始、`local-mode.md` 10.2 | 以 Docker 為前提 | 補上桌面版的啟動、備份、回退與疑難排解 | D2／B3 | 6h |
| 29 | 打包：staging 腳本、`electron-builder.yml`、圖示、捷徑 | 無 | 照 2.9 節 | B3 | 10h |
| 30 | 首次啟動精靈 | 無 | 偵測 repo 裡的舊資料時提議執行第 18 項；檢查 Ollama 和 OCR；沒有叢集時執行 initdb；D2 之前或之後各自的分支流程 | B3 | 6h |
| 31 | 升級流程 | 無 | app 版本變動時執行第 20 項的流程（第 5.3 節） | B3 | 2h |
| 32 | `.gitignore` | — | 加上 `desktop/dist/`、`desktop/out/`、staging 目錄 | B1 | 0.2h |
| 33 | 維護工具寫在 `data/` 底下的預設位置：`scripts/backfill_figures.js:76`（`data/figure-backfill/`）、`scripts/migrate_chapters.js:66`（`DEFAULT_OUT_DIR`，產出 `data/chapter-migration-<日期>.csv`）、`setup_local_ai.bat` 與 `record_local.bat` 的 `data\local_ai\`、`data\rerecord\`（Owner 手動放的量測 log 與 `.env` 備份） | 都以 `exam_pro/` 為基準 | 會被 Owner 從桌面版維護命令列執行的兩支（前兩支）改用 `paths.dataDir()`；安裝版的程式資料夾更新時會整個替換，寫在那裡的提議檔會不見。`record_local.bat` 照原則不改（它只在 repo checkout 裡跑）；`data\local_ai\`、`data\rerecord\` 屬於 repo 的開發與錄製紀錄，不搬 | B2 | 2h |
| 34 | A 的啟動器寫的檔（`d730422`）：`data/launcher/config.json`、`data/launcher/server.json`（關閉捷徑讀的權杖）、`data/logs/server-<日期>.log` | 以 `exam_pro/` 為基準 | 桌面版不用 A 的 `server.json` 權杖（主行程直接握著後端）；`config.json` 的設定項目併進桌面版的 `settings.json`；日誌照 2.8 節寫到 `%LOCALAPPDATA%`。要在 A 合併後依它的實際檔名再核對一次 | B2 | 1h |

**對照 Owner 指定要看的項目**：

| 項目 | 見第幾項 |
|---|---|
| 寫死的 `data/figures`、uploads、backups、logs | 9～12、19、33、34，第 2.8 節（logs） |
| `.env` 的讀取 | 13 |
| `scripts/backup.js` 借用容器的 `pg_dump` | 19 |
| `package.json` 的 `db:*` scripts | 22 |
| `ocr_service` 的路徑 | 14 |
| Word 下載 | 5 |
| 麥克風權限 | 6 |
| auth 中介軟體 | 4 |
| migration 流程 | 20、31（A 的 `utils/migrationStatus.js` 已經有只讀的比對，見第 6.1 節） |
| `setup_local_ai.bat` | 15 |
| `record_local.bat` 與 CI | 16、17，都不改 |

**盤點時發現、和桌面版無關但值得知道的三件事**：

1. `npm start` 目前綁在**所有網路介面**（`server.js` 呼叫 `app.listen(PORT)` 時沒有指定 host），而且金鑰會注入首頁，所以同一個 Wi-Fi 裡的其他裝置打得開題庫。資料庫早就只綁 127.0.0.1（`docker-compose.yml` 的 `ports` 註解），網頁伺服器還沒有。要不要改列在 DA-11。
2. 第 10 項提到的 uploads 路徑不一致。
3. 關伺服器時如果讓在途節點被 abort，會被記成逾時、吃掉重試次數（2.3 節）。今天的 `npm start` 關視窗是直接結束行程，不會踩到；但任何人之後要做「優雅關閉並中止」都要避開這個陷阱。

---

## 4. D2 資料搬家計畫（Docker 正式庫 → 原生 PostgreSQL 16）

### 4.1 前提

- 同一個大版本：來源是 Docker 的 `pgvector/pgvector:pg16`，目的地是 EDB 的 16.x。`pg_restore` 可以讀同一版或更舊版本產生的 dump。
- 同一版 pgvector：先在 Docker 庫查 `SELECT extversion FROM pg_extension WHERE extname='vector'`，目的地裝同一版。Dump 裡的 `CREATE EXTENSION vector` 不帶版本，所以還原時會用目的地安裝的預設版本；兩邊同版就不會有「還原後才升級」這一步。
- **Docker 庫的 pgvector 比 0.8.6 舊時**（建議做法，〔推論〕）：先在 Docker 上把它升到 0.8.6，再搬家。步驟是備份 → 快照 → `docker compose pull postgres` 後重建容器（volume 不動）→ `ALTER EXTENSION vector UPDATE;`（pgvector 官方的升級方式，〔查證 S19〕）→ 快照比對。好處有三個：Windows 端只要準備 0.8.6 一個版本；conda-forge 與第三方都有 0.8.6 的 Windows 版（DA-5）；也和 CI 每次拉到的 `pg16`（0.8.6，〔查證 S20〕）一致。代價是多一次正式庫的變動，約 15 分鐘，要和 D2 分開做、各自驗收。
- Docker 庫的 locale：pgvector 的映像建在官方 `postgres` 映像上（〔查證 S40〕），官方映像設 `ENV LANG en_US.utf8`（〔查證 S39〕），`docker-compose.yml` 的 `POSTGRES_INITDB_ARGS` 只指定編碼，所以〔推論〕Docker 庫的 `datcollate`／`datctype` 是 `en_US.utf8`。第 0 步照樣要實際查。
- 資料量：2026-09-25 的備份檔是 0.99 MB（198 題；專案文件 `local-mode-status-2026-09-25`）。以這個量級來說，dump 和還原都是幾秒到一分鐘的事〔推論〕。

### 4.2 步驟

**第 0 步：準備與演練（不用停機，約 1～2 小時，可以分幾天做）**

1. 在 Docker 庫記下基準資訊：

   ```sql
   SELECT version();
   SELECT extname, extversion FROM pg_extension;
   SHOW timezone;
   SELECT datcollate, datctype, datlocprovider FROM pg_database WHERE datname = current_database();
   SELECT pg_size_pretty(pg_database_size(current_database()));
   ```
2. 準備好 PostgreSQL 16 和同版 pgvector（DA-5），在 **5452** 執行 initdb。locale 照 DA-12 的候選各建一個庫。
3. **演練**：
   1. 取最新一份 `npm run db:backup` 的 `.dump`，還原成 `tutor_exam_bank_rehearsal`。
   2. 用第 27 項的 `snapshot_db.js` 比對 Docker 庫和演練庫（4.3 節）。
   3. 記下還原時間。
   4. 用網頁版指到演練庫（暫時把 `DATABASE_URL` 改到 5452），開題庫列表、找相似、自然語言查題、匯出一份 Word，確認附圖顯示正常。
   5. 演練完刪掉演練庫。

   擱置區第 6 項「備份還原演練」從來沒實跑過，這一步正好把它做掉。

**第 1 步：停止寫入（正式搬家當天，停機從這裡開始）**

1. 確認**沒有重錄正在進行**：`record_local.bat` 的視窗已經關掉，也就是沒有 `cassettes:rerecord` 在跑。
2. 確認**沒有上傳或拆題進行中**：`npm run report:jobs`，或下面三個數字都要是 0（狀態名稱取自 `migrations/0003_jobs.sql` 與 `pipeline/stateMachine.js` 的 `TERMINAL_STATES`）；另外複核頁沒有正在編輯的題目。

   ```sql
   SELECT (SELECT count(*) FROM jobs WHERE state NOT IN ('done','failed'))                              AS jobs_open,
          (SELECT count(*) FROM job_questions WHERE state NOT IN ('saved','needs_review','rejected'))   AS jq_open,
          (SELECT count(*) FROM jobs WHERE locked_until > now())
        + (SELECT count(*) FROM job_questions WHERE locked_until > now())                              AS leased;
   ```

   變式生成停在「等待核准」的題是 `needs_review`（`review_reason='awaiting_approval'`，`workers/jobRunner.js:1116`），屬於終態，不會算進 `jq_open`，不必先處理。
3. 關掉 `npm start` 的視窗，runner 會跟著停。

**第 2 步：備份**

1. 執行 `npm run db:backup`（Docker 模式），確認 `backups\backup.log` 最後一行是 `OK`，而且有複製到 OneDrive。
2. 把 `data\figures` 另外壓一份 zip。D2 不會動到檔案，這一步只是保險。

**第 3 步：快照 A**

在 Docker 庫跑兩支快照：

```
node scripts/snapshot_db.js --out=before-d2.json
node scripts/snapshot_attempt_views.js --out=before-d2-attempts.json
```

**第 4 步：還原到原生庫（5452）**

```
createdb -h 127.0.0.1 -p 5452 -U exam -T template0 -E UTF8 <DA-12 選的 locale 參數> tutor_exam_bank
pg_restore -h 127.0.0.1 -p 5452 -U exam --no-owner --no-acl -d tutor_exam_bank <第 2 步的 .dump>
```

全程用 PG16 的**絕對路徑**執行。現在 `PATH` 裡沒有 PG 工具（1.3 節），但這台電腦裝了 PG17 的服務，之後如果有人把 PG17 的 `bin` 加進 `PATH`，不小心用到的話，`pg_restore` 雖然讀得了 16 的 dump，但這不是我們要的版本組合。

**第 5 步：快照 B 與比對**

1. 把 `DATABASE_URL` 指到 5452，對原生庫跑同樣兩支快照，輸出 `after-d2*.json`。
2. 用 `--compare` 比對，要相同（判讀方式見 4.3 節）。
3. 用 `node migrate.js status` 確認兩邊的 migration 狀態相同。

**第 6 步：切換**

1. 原生庫的埠改回 **5442**：先停掉 Docker 的 `postgres` 服務（`docker compose stop postgres`，**不要用 `down -v`**），再把原生庫的 `port` 改成 5442 並重新啟動。
2. `.env` 的 `DATABASE_URL` 不必改（還是 5442）。
3. 開 app 或網頁版做冒煙測試：題庫列表、找相似、組卷並下載 Word、學生分頁、弱點面板。

**第 7 步：收尾**

1. Docker Desktop 改成不隨開機啟動（DA-7）。
2. 停用工作排程器的「題庫每日備份」，改由 app 備份（DA-4）。
3. 在 `HANDOFF.md` 記錄搬家時間與快照檔的位置。

### 4.3 比對的項目與判讀

`snapshot_db.js` 的所有雜湊都要**在同一個 session 先執行 `SET TimeZone='Asia/Taipei'`**，並用 `COLLATE "C"` 排序，確保兩邊不同的排序規則不會讓相同的資料算出不同的雜湊。現有的 `snapshot_attempt_views.js` 沒有這樣做：它的作答摘要是把 `assigned_at` 等時間欄位轉成文字再算 md5（`scripts/snapshot_attempt_views.js:92-97`），文字格式跟著伺服器的 `timezone` 走，所以**兩邊的 `SHOW timezone` 必須先比對相同**，否則雜湊一定不同。它原本是為 0016 前後比對寫的，檔頭「有重練資料時比對沒有意義」的限制是指套 migration 前後資料會變；D2 比的是同一份資料的兩個副本，這個限制不適用。

| 類別 | 查詢（草案） | 判讀 |
|---|---|---|
| 版本與設定 | `version()`、`pg_extension`（vector、pg_trgm 的版本）、`SHOW timezone`、`server_encoding`、`schema_migrations` 的完整清單 | vector 版本、時區、encoding、migration 清單要相同；PG 的小版本和 collation 可以不同，但要記錄 |
| 每張表的列數 | 對 `information_schema.tables`（public、BASE TABLE）逐表 `count(*)` | 全部相同 |
| 逐表內容雜湊 | `SELECT md5(string_agg(t::text, E'\n' ORDER BY t::text COLLATE "C")) FROM <表> t` | 全部相同。這一項涵蓋題目、作答、派題、重練、知識點、jobs 等所有表 |
| 題目摘要 | `count(*)`、`count(*) FILTER (WHERE archived_at IS NULL)`、`count(embedding)`、`count(question_img)`、`count(search_tsv)`，以及依 `embedding_model` 分組的計數 | 相同。這些數字給人看，雜湊負責嚴格比對 |
| 向量 | `md5(string_agg(id || ':' || embedding::text, '|' ORDER BY id))` | 相同。兩邊同版 pgvector，文字格式一致〔推論〕 |
| 附圖 | `question_img` 的相異數，以及對應檔案在磁碟上是否存在 | D2 不動檔案，數字應該完全不變 |
| 索引 | `pg_index` 裡的 `indisvalid` 全部為真；HNSW、GIN 兩種索引都在 | 全部有效 |
| 行為：精確近鄰 | 關掉索引掃描（`SET enable_indexscan=off; SET enable_bitmapscan=off`），挑 5 題各查距離最近的 10 題 | id 與距離逐項相同 |
| 行為：HNSW 近似 | 同樣查詢但開著索引 | **可以有小差異**：HNSW 是近似搜尋，還原時索引會重建。差異只記錄，不視為失敗 |
| 作答檢視 | `snapshot_attempt_views.js --compare` | 應該相同。**例外**：弱點表在錯誤率與批改數都相同時，用章名、題型等欄位的預設排序規則排（`services/weaknessService.js:61` 的 `<分組欄> ASC`），而這支腳本沒有把弱點表重新排序（`:105-107`）。中文的排序規則不同時，同分的列順序可能不一樣（R-3）。這種差異要逐筆確認只是順序不同。學生本身依 `id` 排（`:99`），不受影響 |
| 排序與三字組 | `SELECT string_agg(chapter, '|' ORDER BY chapter) FROM (SELECT DISTINCT chapter FROM questions) t`；`SELECT show_trgm('牛頓第二定律 f=ma')` | 用來挑 DA-12 的 locale。不同的話只記錄 |

### 4.4 回退方案

- **切換後還沒有新寫入**：
  1. 結束 app。
  2. `docker compose start postgres`。Docker 的 volume 在第 6 步只是停用，資料原封不動。
  3. 原生庫的埠改回 5452，或乾脆不啟動它。

  約 5 分鐘。
- **切換後已經有新寫入**（新題、批改、重練）：
  1. 先把原生庫 `pg_dump -Fc` 出來。
  2. 在 Docker 庫 `dropdb` 再 `createdb`。
  3. 用 `pg_restore --no-owner --no-acl` 還原進去。
  4. 再跑一次 4.3 節的比對。

  同樣是 16 對 16，約 15～30 分鐘。
- 附圖和 PDF 都在磁碟上，D2 不會動到，回退時也不用處理。
- Docker 的 volume **至少保留 30 天**才能刪除（DA-7），刪除前再做一次 dump 放進備份資料夾。

### 4.5 停機時間與時機

- 估計停機 **30～45 分鐘**，從第 1 步到第 6 步，多數時間花在比對和冒煙測試；dump 和還原本身以秒計〔推論〕。演練時量到的時間會取代這個估計。
- 時機（DA-10）：挑一個**沒有重錄、也沒有要上傳考卷**的空檔，例如週末早上。重錄跑一整天，而且吃 CPU 和記憶體，和搬家同時進行的話，量到的時間與比對都會失真，也增加出錯時要排查的變數。

---

## 5. 更新方式

### 5.1 三種做法的比較

| 做法 | 怎麼更新 | 優點 | 代價與限制 |
|---|---|---|---|
| U1：維持 git 加 bundle，從 repo 啟動 Electron | 照現在的方式更新 repo（git pull 或 bundle），`desktop/` 裡的 `npm ci` 跟著跑；桌面捷徑指向 repo 裡的 Electron | 不必打包，B1、B2 就能用；和開發流程完全一致 | Owner 的電腦要有 Node 和 npm（本來就有）；更新時要記得跑 `npm ci` |
| U2：手動安裝檔 | 在 Owner 的電腦上用 B3 的指令 build 出新的安裝檔，雙擊覆蓋安裝 | 程式和 repo 分開，新舊版本清楚；資料在 `%LOCALAPPDATA%`，不受影響 | 每次 build 要幾分鐘，還要在 Windows 上跑 `npm ci`（2.2 節）；本機 build 的檔案不帶網路標記，推論不會觸發 SmartScreen（DA-9） |
| U3：electron-updater 自動更新 | app 啟動時檢查 GitHub Releases，有新版就下載並安裝 | 最省事；NSIS target 支援自動更新（〔查證 S4〕） | **repo 是私有的**。從私有 repo 更新要在使用者電腦上設 `GH_TOKEN`，並打開 `private` 選項；官方文件說這個 token「絕不要寫進設定檔」（〔查證 S5〕）。舊版官方 wiki 說私有 repo 更新「只適用非常特殊的情況」，而且受 GitHub API 每小時 5000 次的限制，每次檢查最多用 3 次（〔查證 S6〕，這段在現行文件裡找不到，現況〔未查證〕）。也就是說，Owner 的電腦上要長期放一把能讀私有 repo 的 token。另一條路是自己架 generic HTTP 伺服器，但檔案要手動上傳（〔查證 S4〕），對一個人來說太重 |

建議（DA-6）：B1 到 D2 用 **U1**，B3 之後用 **U2**，**不做 U3**。

### 5.2 版本號

- `desktop/package.json` 的 `version` 就是 app 的版本。
- `exam_pro/package.json` 維持 1.0.0 不動，因為動它會改到 lock 檔。
- app 啟動時，把「app 版本加上 `git rev-parse --short HEAD`（開發版）或 build 時寫入的 commit」記進 `%LOCALAPPDATA%\TutorExamBank\state.json`。和上次的值不同時，就視為升級。

### 5.3 升級時的固定流程（U1、U2 都一樣）

這是把現在手動的升級步驟（`engineering_docs/06_ops/deployment_and_operations.md` §3.6：停服務 → 備份 → 快照 → migrate → 快照 → 比對，回 0 才啟動）自動化。A 的啟動器刻意只偵測、不自動升級（`d730422` 的 `utils/migrationStatus.js` 檔頭）；B 照這次的需求改成自動，但任何一步不過就停下，不自動還原。偵測待套的 migration 直接用 A 的 `compareMigrations()`。

1. 偵測到版本改變，**或者**有待套的 migration，就進入升級模式；此時視窗只顯示進度，不開放操作。
2. **自動備份**：跑第 19 項的 `runBackup()`，失敗就停下，不往下做。
3. **快照 A**：跑 `snapshot_db.js`。
4. **migrate**：跑 `runMigrations()`，任何一支失敗就整支回滾（`migrate.js` 本來就這樣做），流程停下，並顯示剛才那份備份的位置。
5. **快照 B 與比對**：migration 本來就可能改資料，所以這裡只比「不該變的」：
   - 每張既有表的列數**不能變少**。
   - `questions` 的核心欄位雜湊（題幹、答案、章節、向量）不能變。
   - 例外：migration 檔頭宣告了會改哪張表的哪些欄位時，那些欄位不比。檔頭宣告的格式在 D2 定。

   比對不一致就停下，保留備份，不自動還原，由 Owner 決定。
6. 通過之後才開始接受操作，並在日誌記錄這次升級。

---

## 6. 分期、工時與驗收

### 6.1 開工前要和 A 對齊的事

A 的啟動器要處理四件事：啟動 Docker Desktop、執行 `db:up`、檢查 Ollama、開 `npm start` 和瀏覽器。B1 應該**沿用同一套檢查邏輯和錯誤訊息**，才不會出現兩份說法不一致的提示。

A 的進行中 commit `d730422`（未審查、未合併；A 的文件 `docs/desktop-launcher.md` 還沒寫出來）已經把這些寫成可以 `require` 的 Node 模組，第一版草稿擔心的「A 全寫在 `.bat` 裡」沒有發生：

| A 的模組 | 做什麼 | B 怎麼用 |
|---|---|---|
| `exam_pro/scripts/desktop/lib/plan.js` | 純函式 `nextAction(facts)`：健康檢查 → 基本檢查 → 偵測錄製 → Docker 與資料庫 → Ollama → migration → 後端，每一步的錯誤訊息與處置提示 | B1 的狀態畫面直接用它決定下一步與錯誤文字；D2 之後把「Docker 與資料庫」那一段換成 pgManager |
| `exam_pro/controllers/healthController.js`（`GET /api/health`，掛在 `apiKeyAuth` 之前） | 回報服務名稱、版本、資料庫連不連得上、migration 檔名 | 辨認埠上的是不是自己的後端；狀態畫面的 migration 提示 |
| `exam_pro/services/launcherControl.js`（`/api/launcher/*`，要 `LAUNCHER_CONTROL_TOKEN`） | 優雅關閉：停止認領 → `server.close()` → 等在途工作到寬限時間 → 關 `pool` → 結束 | B 的主行程直接握著後端，不必走 HTTP；但關閉的狀態機要共用同一份（2.8 節），「放棄」選項加在這裡（第 3 條第 2 項） |
| `exam_pro/utils/migrationStatus.js` | 只讀比對「程式帶的」與「資料庫已套的」migration | 5.3 節的升級偵測 |

要和 A 對齊的四件事：

1. **合併順序**：A 先合併，B1 再在它上面改 `server.js`、`app.js`，不要兩邊各改一份（R-18）。
2. **關閉行為**：A 的待決事項 DL-1（本機模式一個節點可能跑數十分鐘，關閉時要等多久）和 DA-2 是同一個問題，兩邊的答案要一致。
3. **路徑**：A 把設定、權杖和日誌寫在 `exam_pro/data/launcher/`、`exam_pro/data/logs/`，B2 要把它們一起搬（第 3 條第 34 項）。
4. **不要中止在途節點**：A 目前是寬限時間到了就直接結束，不會吃掉重試次數；以後誰要加「中止」都要照 2.3 節的做法。

A 的程式在合併前還可能改，以上以 `d730422` 為準，B1 開工時要再核對一次。

### 6.2 B1：殼加內嵌後端（仍用 Docker 的庫）

- **範圍**：第 1～8、32 項。
- **工時**：3＋8＋1＋1＋3＋2＋26＋6＋0.2，約 50h，約 **6～6.5 人日**。A 的 `plan.js` 合併後可以直接用時，約少 4h。
- **自動化驗收**：
  - `exam_pro` 的 `npm test`、`npm run check:html` 全綠。CI 不改，所以一樣綠。
  - 新增的單元測試涵蓋：`startServer({port:0})` 回傳實際的埠且可以連線；`close()` 之後埠已釋放、runner 已停；`shutdown({abandon:true})` 會觸發節點的 signal，而且**那一列的 `retries` 不變、沒有新增 `job_events`、`locked_until` 已清空**。
  - `desktop/` 的 `node --test` 全綠（只在本機跑）。
  - 整合測試 `npm run test:integration` 在本機一個全新的 UTF8 測試庫（5433）上全綠。
- **手動驗收**（Owner）：
  1. 雙擊捷徑，Docker 沒開時由 app 代開，最後視窗出現，六個分頁都能用。
  2. 組卷後下載 Word，跳出「另存新檔」，預填的檔名正確。
  3. 上傳最小的樣卷，工作開始跑。
  4. 關閉視窗時，行為符合 DA-2。拆題中選「放棄」後重開，那一題從同一個節點重跑，複核頁沒有多出逾時的紀錄。
  5. 從系統匣結束後，工作管理員裡沒有殘留的 `node`、`python`、Electron 行程（B1 期間 PostgreSQL 還在 Docker，不在此列）。
  6. 第二次雙擊只會叫出原本那個視窗。
  7. Gemini 模式下麥克風可用（本機模式本來就沒有語音，可以跳過）。

### 6.3 B2：路徑與設定搬到 `%LOCALAPPDATA%`／`%APPDATA%`

- **範圍**：第 9～15、18、21、33、34 項。
- **工時**：4＋2＋1＋3＋3＋3＋4＋6＋3＋2＋1，約 32h，約 **4 人日**。
- **自動化驗收**：
  - 沒設 `APP_DATA_DIR` 時，所有既有測試不改一個字就全綠。這條測的是預設不變。
  - 新增一個整合測試，把 `APP_DATA_DIR` 指向暫存目錄，跑完「上傳 → PDF 落地 → 裁圖 → Word 附圖」。只在本機跑。
  - 新增 `paths.js` 的單元測試。
  - 搬遷工具的單元測試涵蓋：試跑、sha256 不一致時報錯、目的檔已存在且內容不同時拒絕。
- **手動驗收**：
  1. 執行搬遷工具，報告的檔案數和 sha256 全部一致。
  2. app 改讀新位置後，舊題的附圖照樣顯示，Word 匯出有圖，舊 job 的 PDF 可以重試。
  3. 把 repo 裡的 `data\` 改名（不要刪），app 還是正常，證明已經不依賴舊位置。

### 6.4 D2：原生 PostgreSQL 與搬家

- **範圍**：第 19、20、24～28 項，加上第 4 條的演練與搬家。
- **工時**：8＋6＋2＋12＋5＋6＝39h，再加第 26 項 pgvector 的取得 4～12h（視 DA-5 的選擇），合計約 43～51h，約 **5.5～6.5 人日**（第一版草稿把 pgvector 另外又算一次，重複了）。Owner 的操作約 2～3 小時；如果要先把 Docker 庫的 pgvector 升到 0.8.6（4.1 節），另加約 15 分鐘。
- **自動化驗收**：
  - `backup.js` 原生模式的參數組成、檔頭驗證和附圖 zip 有單元測試。
  - `runMigrations()` 的函式版在 5433 全新測試庫上跑出和 CLI 相同的結果。
  - `snapshot_db.js --compare` 對同一個庫比兩次回 0，對故意改過一列的庫回 1。
- **手動驗收**：
  1. 演練時 4.3 節每一項都照判讀標準通過，記下還原時間。
  2. 正式搬家後重跑一次，同樣通過。
  3. 原生模式的 `npm run db:backup` 產出 `PGDMP` 檔頭的 dump，而且**把這份 dump 還原到一個新庫再比對一次**，確認備份真的能還原。
  4. 關機再開機後，app 能正常啟動 PostgreSQL。用工作管理員強制結束 app 之後，`postgres.exe` 應該還在跑（2.5 節「停止」那一列）；再開 app 時要認出是自己的叢集並沿用，不會報埠衝突。再把 `postgres.exe` 也強制結束一次，重開 app 後 PostgreSQL 要能自動回復。

### 6.5 B3：打包安裝檔

- **範圍**：第 29～31 項。
- **工時**：10＋6＋2＝18h，加上打包後的冒煙測試與 asar 問題的排除 0～3h，約 18～21h，約 **2.5 人日**。
- **驗收**：
  1. 在 Owner 的電腦上 build 出安裝檔，記錄大小。
  2. 以一般使用者安裝，不需要系統管理員權限。
  3. 開始選單和桌面有捷徑。
  4. 首次啟動精靈能找到既有資料。
  5. 解除安裝後 `%LOCALAPPDATA%\TutorExamBank` 仍在。
  6. 重新安裝後資料都在。
  7. 把版本號加 1 再 build 一次並覆蓋安裝，5.3 節的升級流程會跑完，而且有留下備份。
  8. Defender 沒有攔截；如果被攔截，記錄訊息並照 DA-9 處理。

### 6.6 總表

| 期別 | 開發工時 | 前置條件 | 可以單獨交付嗎 |
|---|---|---|---|
| B1 | 約 50h（6～6.5 人日） | A 合併（沿用它的檢查邏輯與關閉通道） | 可以：Owner 從此雙擊圖示使用，Docker 仍由 app 代開 |
| B2 | 約 32h（4 人日） | B1 | 可以 |
| D2 | 約 43～51h（5.5～6.5 人日，含 pgvector） | B2（路徑穩定後再搬）、DA-4、DA-5、DA-12 | 可以：也能不經 B，改由 A 的啟動器去開原生 PostgreSQL（〔推論〕，A 要加約 0.5 人日） |
| B3 | 約 18～21h（2.5 人日） | B2、D2 | 可以 |
| 合計 | **約 143～154h，約 18～19.5 人日** | | |

---

## 7. 風險與未知

| # | 風險或未知 | 可能性、影響 | 對策 | 怎麼確認 |
|---|---|---|---|---|
| R-1 | pgvector 的 Windows 二進位不好取得。官方的 Windows 說明只有 Visual Studio 加 `nmake` 的編譯流程（〔查證 S19〕），沒有官方預先編好的檔案 | 中、中：卡住 D2 | DA-5：用 GitHub Actions 的 Windows runner 編；退路是 conda-forge，它的 win-64 pgvector 0.8.6 就是對 PostgreSQL 16（libpq 16.15）編的（〔查證 S21、S21b〕）；第三方的預先編譯檔（例如 S22）看不到建置紀錄，不建議拿來跑正式庫 | D2 第 0 步：`CREATE EXTENSION vector` 成功，4.3 節的向量雜湊相同 |
| R-2 | 在系統管理員帳號下 PostgreSQL 起不來 | 中、高 | 一律用 `pg_ctl` 啟動（〔查證 S25、S26〕） | 在 Owner 的帳號下實際執行 `pg_ctl start`〔要實測〕 |
| R-3 | 排序規則與字元分類不同。Docker 庫〔推論〕是 Debian glibc 的 `en_US.utf8`（4.1 節，〔查證 S39、S40〕），要以第 0 步查到的 `datcollate` 為準；Windows 原生庫是 Windows 或 ICU 的 locale | 中、低：資料不會壞 | 影響範圍〔推論〕：① `ORDER BY` 中文欄位的順序，包括學生名單（`studentController.js:190`、`assistantService.js:109`）、弱點表同分時的次序（`weaknessService.js:61`）和分類 few-shot 的章節順序（`agents/classify.js:438`）。few-shot 順序只影響正式環境 prompt 裡例題的排列；cassette 的鍵用的是由小到大排好的 `fewShotIds`，錄製時 `ctx.db` 也一律是 null（裁決 S2-8，`agents/classify.js:35-36`），**所以不會讓 CI 的回放對不上**。② pg_trgm 只從「英數字」抽三字組（〔查證 S23〕），中文字算不算英數字要看 locale 的字元分類；抽不到三字組時，索引搜尋會退化成掃過整個索引（〔查證 S23〕）。專案只用它建 `ILIKE` 的索引，沒有用 `similarity()`（2.5 節），所以**結果一樣正確，只差速度** | DA-12：演練時比對章名排序和 `show_trgm` |
| R-4 | 非 ASCII 路徑 | 中、高 | PostgreSQL 的二進位、資料夾和密碼檔都放在純英數的路徑（〔查證 S27、S28〕） | initdb 成功 |
| R-5 | Defender 或防毒軟體誤判：沒簽章的 Electron exe、由 app spawn 的 `postgres.exe` 和 `python.exe` | 中、中 | DA-9；必要時把 `%LOCALAPPDATA%\TutorExamBank\pgdata16` 加入 Defender 的排除清單，減少即時掃描拖慢資料庫。要不要排除由 Owner 決定 | B3 驗收第 8 點 |
| R-6 | Electron 的 Node 和原生模組：`sharp`、`@node-rs/jieba` 是 Node-API 模組，不必重新編譯，但要解開放在 asar 外（〔查證 S9〕）；`mupdf`（ESM 加 WASM）在 asar 裡能不能載入不確定；平台專用的二進位最簡單是在 Windows 上 `npm ci` 取得（2.2 節） | 中、中 | 2.2、2.9 節；B1 先在不包 asar 的開發模式確認三者都能動，B3 再確認打包後也能動 | B1、B3 的冒煙測試：拆題會用到 mupdf 和 sharp，查題會用到 jieba |
| R-7 | Electron 的支援期短：只支援最新三個大版本，約半年（〔查證 S1、S3〕） | 高、低：單機、只載入自己的頁面 | 每半年升一次大版本；升級也走 5.3 節的流程 | — |
| R-8 | 記憶體 | 低、正面 | D2 之後 WSL2 虛擬機不開。WSL2 預設最多吃實體記憶體的一半，也就是 8 GB（〔查證 S29〕；Docker 在 WSL 2 下的記憶體上限也是改 `.wslconfig`，見 S30）。Docker 的 Resource Saver 在 WSL 2 上只暫停引擎、不減記憶體（〔查證 S30b〕）。社群回報 Docker Desktop 閒置時約 3 GB、vmmem 約 2.5 GB（〔查證 S31〕，2023 年、非官方數字）。Electron 本身的主行程、視窗和 GPU 行程約一兩百 MB（〔未查證〕），大約是一個 Chrome 分頁的量級。對 `local-mode.md` 10.14 (e) 的記憶體帳（Owner 第五輪 C-e：先量再決定，10.17）應該是淨省 | 搬家前後各在工作管理員記一次「使用中」的記憶體〔要實測〕 |
| R-9 | 關閉時留下孤兒行程：Python 或 PostgreSQL | 低、中 | python 是後端的直接子行程，後端一結束就會被 Windows 終止（2.3 節，〔查證 S41〕）；postgres 則刻意讓它在 app 當掉時繼續跑，下次開 app 沿用（2.5 節）。啟動時如果發現上次沒有正常結束（`postmaster.pid` 還在，但行程不在），交給 `pg_ctl` 處理 | B1、D2 驗收 |
| R-10 | app 關著的時候沒有備份 | 中、中 | DA-4：資料只有在 app 開著時才會變動，所以改成「每天第一次開啟時」和「結束前、有寫入時」備份 | D2 驗收 |
| R-11 | NSIS 超過 2 GB 會壞掉（〔查證 S8〕） | 低 | 不包 venv 和模型（1.2 節） | B3 記錄大小 |
| R-12 | mupdf 是 AGPL：只自用不觸發義務；安裝檔一旦交給別人就算散布（`roadmap-plan.md` 擱置區第 7 項） | 低 | 安裝檔只在 Owner 的電腦上 build 和安裝，不上傳到公開的 Release | — |
| R-13 | 完全拿掉 Docker 會讓 `record_local.bat` 和本機整合測試不能用 | 看 DA-7 的選擇 | 建議保留 Docker 但不開機啟動 | — |
| R-14 | 網頁版和桌面版同時開、連同一個庫，runner 會加倍 | 低、中 | 2.8 節的偵測與警告 | B1 驗收 |
| R-15 | 開機時 Ollama 還沒起來，app 先打開 | 中、低 | 健康檢查每 5 秒重試一次、最多 60 秒；逾時只警告，不影響題庫和組卷 | B1 驗收 |
| R-16 | 我查不到、不確定的事 | — | 列在這裡，實作時逐項確認 | 見第 9 條最後的「查不到或不確定的事」 |
| R-17 | 「關閉時中止在途節點」被記成逾時，吃掉重試次數（2.3 節第 3 點） | 高（照直覺寫就會踩到）、高：題目被送進人工複核，拆題中的整份卷可能直接 `failed`，事件表多出假逾時 | 2.3 節第 4 點的 `abandon` 路徑；單元測試釘住（6.2 節），題目層與拆題迴圈兩條路都要測 | B1 自動化驗收 |
| R-18 | A 和 B 都改 `server.js`、`app.js`，而且 A 的 `d730422` 還沒審查 | 中、低：合併衝突與重工 | 先合併 A，B1 在它上面改（6.1 節） | B1 開工時核對 A 的最終版本 |

---

## 8. 決策草稿

每一題都可以單獨看懂。**還沒有任何一題的答案落實在程式裡。**「何時」指的是最晚要答的時間點。第 3、6 條的工時是照每一題的「建議」估的；選項裡寫的「+Nh」是和最省事的選項相比多出來的工時，選了建議以外的選項時再照它調整總數。

| 編號 | 題目 | 什麼時候要答 | 建議 |
|---|---|---|---|
| DA-1 | 資料夾放在哪裡 | B2 開工前 | 2：設定和資料分開，路徑只用英數字 |
| DA-2 | 關閉視窗時，背景工作怎麼辦 | B1 開工前 | 3：有工作時縮到系統匣，沒工作時直接結束 |
| DA-3 | 後端跑在哪一個行程 | B1 開工前 | 2：utilityProcess |
| DA-4 | 原生 PostgreSQL 由誰管理、什麼時候備份 | D2 開工前 | 1：由 app 管理，app 負責備份 |
| DA-5 | pgvector 的 Windows 二進位從哪裡來 | D2 開工前 | 2：另開一支只能手動觸發的 GitHub Actions |
| DA-6 | 更新方式 | B3 開工前（B1 起就先照建議） | B1～D2 用 1、B3 起用 2，不做自動更新 |
| DA-7 | Docker 是否完全移除 | D2 搬家前 | 2：保留但不開機啟動，當作備援 |
| DA-8 | Gemini 金鑰怎麼保管 | B2 開工前 | 1，重新啟用 Gemini 時改 2 |
| DA-9 | 要不要簽章 | B3 開工前 | 1：不簽章，只在自己電腦上 build |
| DA-10 | 什麼時候搬家 | 演練通過後 | 2：重錄結束、當週沒有要上傳的考卷時 |
| DA-11 | 要不要保留區網存取 | B1 開工前 | 1：桌面版只綁本機；網頁版的綁定位址另外決定 |
| DA-12 | 原生庫的 locale（排序規則） | D2 演練時 | 演練時比對後再定 |

### DA-1　資料夾放在哪裡

- **背景**：現在所有資料都在 repo 的 `exam_pro` 底下：附圖 `data\figures`（唯一需要長期保存的檔案）、考卷 PDF `data\jobs`（拆題完成就刪，平常只有排隊中的）、上傳暫存 `uploads`（每小時清一次）、備份 `backups`（每份 dump 另外複製一份到 OneDrive）。A 的啟動器還會加上 `data\launcher`、`data\logs`。資料庫在 Docker 的 volume 裡。repo 放在桌面上（`C:\Users\Administrator\Desktop\tutor-exam-bank`，`docs/HANDOFF.md`）。做成 app 以後，程式會裝在 `%LOCALAPPDATA%\Programs\...`，更新時整個替換，所以資料一定要搬出來。另外，PostgreSQL 在 Windows 上碰到非 ASCII 路徑有已知問題（〔查證 S27、S28〕），而資料庫的資料夾絕對不能放在 OneDrive 同步的資料夾裡，同步程式會在資料庫寫到一半時鎖住或複製檔案〔推論〕。
- **問題**：設定、資料庫、附圖、備份要放在哪裡？
- **選項**：
  1. **全部放在 `%APPDATA%\TutorExamBank`**（Roaming）：只有一個地方，好找。代價：Roaming 是設計給「跟著網域帳號漫遊」的小型設定，放資料庫和附圖不合慣例；這台電腦沒有加入網域，所以實際上沒有漫遊的問題。工時沒有差別。
  2. **設定和資料分開**：
     - `%APPDATA%\TutorExamBank`：只放 `.env` 和 `settings.json`。
     - `%LOCALAPPDATA%\TutorExamBank`：放 `pgdata16`、`data\figures`、`data\jobs`、`uploads`、`logs`、`ocr-venv`。
     - 備份預設放在 `文件\TutorExamBank\backups`，`BACKUP_COPY_DIR` 照舊複製到 OneDrive。

     代價：要知道兩個地方，所以系統匣選單會提供「開啟資料夾」。工時沒有差別。
  3. **放在使用者自選的資料夾**（例如 `D:\TutorExamBank`，全部在一起）：方便整包帶走或備份。代價：這台筆電大概只有一顆硬碟；首次啟動精靈要多一步讓使用者選資料夾（+2h）；選到含中文或 OneDrive 的路徑時要擋下來。
  4. **維持在 repo 的 `exam_pro` 底下**（不做 B2）：零工時。代價：B3 的安裝版就無法使用，因為程式資料夾會被更新替換；而且資料跟著 repo 走，git 操作失誤的風險一直都在。
- **建議**：**2**，資料夾名稱一律用英數字 `TutorExamBank`，app 的顯示名稱仍然可以是中文。`%LOCALAPPDATA%` 不會被 OneDrive 的「已知資料夾移動」同步（那個功能只移動桌面、文件、圖片）〔推論〕，所以資料庫放在這裡最安全；備份放在「文件」底下看得到，也方便另外複製。
- **何時**：B2 開工前。

### DA-2　關閉視窗時，背景工作怎麼辦

- **背景**：上傳考卷之後，拆題在後端的背景工作裡跑。本機模式下一份卷要跑幾十分鐘到幾小時：OCR 整理一個節點就可能十幾到幾十分鐘，分類和驗算每題也要數分鐘。後端和視窗在同一個 app 裡，app 結束，工作就停。被中斷的節點下次開 app 會**從那個節點的開頭重跑**，資料不會壞，也不會被算成一次失敗（2.3 節的做法），但已經跑的時間就白費了。A 的啟動器有同一個問題（A 的待決事項 DL-1），兩邊的答案要一致。
- **問題**：按視窗右上角的 X 時要怎麼做？
- **選項**：
  1. **X 就是結束程式**，有工作在跑時先問「還有 N 份在處理，確定要結束嗎？」：最直覺。代價：不小心按到就會中斷長時間的工作；每次都要回答對話框。工時最少。
  2. **X 一律縮到系統匣**，要結束得從系統匣選「結束」，有工作時再問一次：這是 Docker Desktop、Slack 的做法，工作不會被誤關。代價：就算沒有工作，PostgreSQL 和後端也一直常駐（約數百 MB），Owner 可能以為已經關了。約 +2h。
  3. **看狀況**：有工作在處理時縮到系統匣繼續跑，並跳通知「還有 N 份在處理，程式縮到右下角繼續跑，處理完會通知你」；沒有工作時直接結束。從系統匣選「結束」且有工作時，會問「等處理完再結束／現在放棄（不算失敗；下次開 app 從那一步的開頭重跑）」。代價：行為隨狀況改變，第一次要看懂通知。約 +4h（「放棄」本身的工時已算在第 3 條第 2 項）。
- **建議**：**3**。16 GB 的記憶體很吃緊（`local-mode.md` 10.14 (e) 的記憶體帳），沒事時就該把 PostgreSQL 和後端都關掉；有工作時被誤關的損失又太大（可能是一小時的 CPU 時間）。處理完的通知也順便解決「不知道什麼時候拆完」的問題。
- **何時**：B1 開工前。

### DA-3　後端跑在哪一個行程

- **背景**：後端是 Express，背景工作 runner 跑在同一個行程裡。拆題時 Node 端會做一些吃 CPU 的事：mupdf 用 WASM 同步把頁面渲染成圖、JSON 處理、jieba 分詞。Electron 的主行程負責視窗、系統匣和對話框；主行程一卡住，這些都會跟著卡。Electron 官方建議把吃 CPU、容易崩潰的元件放進 utility process（〔查證 S10、S11〕）。
- **問題**：`startServer()` 要在哪裡執行？
- **選項**：
  1. **直接在主行程 `require` 並執行**：最簡單，除錯最方便。代價：渲染頁面時系統匣和選單可能停頓；後端一崩潰整個 app 就關掉。
  2. **utilityProcess**（`utilityProcess.fork`，完整的 Node 環境，可以用原生模組，〔查證 S10〕）：後端崩潰時主行程還在，可以顯示錯誤、自動重開後端，視窗不必關；日誌也容易接到檔案。代價：+6h（環境變數傳遞、崩潰重開、日誌）。
  3. **`child_process.fork` 並設 `ELECTRON_RUN_AS_NODE`**：效果和 2 相近，是舊做法；官方現在推薦 utilityProcess。代價和 2 相當。
- **建議**：**2**。多花不到一天，換來「後端出事時視窗還在、看得到原因」。這和 2.3 節的模組化不衝突：同一個 `startServer()`，主行程要直接呼叫也可以，保留選項 1 當作除錯時的退路。
- **何時**：B1 開工前。

### DA-4　原生 PostgreSQL 由誰管理、什麼時候備份

- **背景**：現在 PostgreSQL 在 Docker 裡，Docker Desktop 開著就一直在跑；每天 02:00 由工作排程器備份（借用容器裡的 `pg_dump`）。換成原生 PostgreSQL 之後，要決定它什麼時候開著。題庫只有在 Owner 使用系統時才會變動（上傳、複核、批改、組卷都在 app 裡）。
- **問題**：原生 PostgreSQL 要常駐嗎？備份什麼時候做？
- **選項**：
  1. **由 app 管理**：開 app 才啟動，結束 app 就停止。備份改由 app 做：每天第一次開啟時，距離上一份成功的備份超過 20 小時就先備份；結束前如果這次有寫入（比對 `pg_stat_database` 的寫入計數）再備份一次；migrate 前也一定備份（5.3 節）。工作排程器的 02:00 停用。命令列維護工具從系統匣的「維護命令列」執行。代價：不開 app 就連不到資料庫；結束時多幾秒。工時已算在 D2 的第 19、25 項。
  2. **裝成 Windows 服務**（`pg_ctl register`，開機就啟動，閒置時約數十 MB〔未查證〕）：行為和現在 Docker 常駐一樣，02:00 排程和命令列工具都照舊。代價：註冊服務要系統管理員權限；服務帳號（NetworkService）要能讀寫資料夾，權限要另外設；安裝檔要改成全機安裝。約 +6h。
  3. **沿用這台電腦已經裝好的 PostgreSQL 17 服務（5432）**：不用另外裝 PostgreSQL。代價：大版本從 16 跳到 17，和 CI（pg16 映像）不同；還是要編 17 版的 pgvector；那個服務原本是做什麼用的、密碼是什麼都不確定（`docker-compose.yml` 的註解只說它占著埠）；兩個用途共用一個服務，彼此牽制。
- **建議**：**1**。它讓「資料會變的時候就有備份」變成必然：資料只在 app 開著時才會變，而 app 開著時就會備份。常駐服務在 16 GB 的筆電上是多一個長期吃記憶體的東西，換來的只是「02:00 備份」這個已經沒必要的時段。命令列工具很少用，走維護命令列就夠了。
- **何時**：D2 開工前。

### DA-5　pgvector 的 Windows 二進位從哪裡來

- **背景**：原生 PostgreSQL 要能 `CREATE EXTENSION vector`，得有一份 Windows 版的 pgvector（`vector.dll` 加上 `share/extension` 裡的控制檔與 SQL）。pgvector 官方的 Windows 說明只有「用 Visual Studio 的 C++ 工具執行 `nmake /F Makefile.win`」這條編譯路線（〔查證 S19〕），沒有官方預先編好的檔案。版本要和 Docker 庫完全相同（2.5 節；Docker 庫比 0.8.6 舊時，建議先升到 0.8.6，見 4.1 節）。DLL 必須和我們用的 PostgreSQL 16 二進位相容。
- **問題**：`vector.dll` 要怎麼取得？
- **選項**：
  1. **在 Owner 的電腦上裝 Visual Studio Build Tools 自己編**：照官方流程做，最直接。代價：Build Tools 要好幾 GB 的磁碟〔未查證確切大小〕，第一次約 1～2 小時；官方說明要用系統管理員身分開編譯用的命令列（〔查證 S19〕）；每次升級 pgvector 都要再編一次；Owner 的電腦要多裝一套大工具。約 4h。
  2. **另開一支只能手動觸發（`workflow_dispatch`）的 GitHub Actions**：在 Windows runner 上下載同一版的 EDB PG16 zip，編同版的 pgvector，產出 zip 和 SHA-256 當作 artifact。**不改 `ci.yml`**，是另一個 workflow 檔。代價：約 4～6h 寫 workflow（加上試跑，第 3 條第 26 項估 4～12h）；Windows runner 每分鐘 0.010 美元，Linux 是 0.006 美元（〔查證 S43〕），一次十幾分鐘，超出免費額度時也只是幾毛美元；EDB 沒有公布 zip 的雜湊（〔查證 S18b〕），workflow 要把自己下載到的 zip 雜湊記下來；要從 GitHub 下載 artifact 放到 Owner 的電腦。好處是建置紀錄留在自己的 repo（私有，只有自己看得到），可以重現，升級時按一下就能重編。
  3. **改用 conda-forge 的 postgresql 16 加 pgvector**：conda-forge 的 win-64 pgvector 0.8.6（也有 0.8.5）就是對 PostgreSQL 16 編的：它的 recipe 在 Windows 把建置用的 postgresql 固定在 17 以下（〔查證 S21〕），發布的套件依賴 libpq 16.15（〔查證 S21b〕）。兩者都由 conda-forge 的 CI 編好，不必自己編。代價：用的是 conda-forge 的 PostgreSQL，不是 EDB 的，2.5 節的取得與資料夾做法要改（conda 的 Windows 套件放在 `Library\bin` 之類的位置）；要多一個 micromamba；conda-forge 的 postgresql 16.15 win-64 套件本身在網頁清單上沒看到（清單只列最近幾版），〔推論〕它存在（pgvector 要靠它建置），要用 `micromamba search` 實際確認；conda 版有沒有帶 contrib 的 pg_trgm〔未查證〕。約 4～6h。
  4. **用第三方預先編好的檔案**（例如 GitHub 上的 `andreiramani/pgvector_pgsql_windows`，發布到 0.8.6、涵蓋 PG13～18，〔查證 S22〕）：最快，約 1h。代價：非官方，發布頁看不到建置方式與建置紀錄（〔查證 S22〕）。把來路不明的 DLL 載入存學生資料的資料庫，不建議。
- **建議**：**2**，**3** 當作第一個退路，**1** 當作最後的退路。2 一次寫好，之後每次升級都能重現；不必在 Owner 的電腦上裝大型工具；DLL 的來源和建置紀錄都在自己的 repo 裡，而且和 2.5 節選的 EDB 二進位是同一套。3 的證據比第一版草稿寫的強（確定是對 PG16 編的），如果 2 的 workflow 卡關超過半天，就改走 3。
- **何時**：D2 開工前。

### DA-6　更新方式

- **背景**：現在用 git（或 bundle）更新 repo，再照 README 的步驟升級，包括備份、migrate、快照比對。app 化之後可以繼續這樣做，也可以改成安裝檔或自動更新。repo 是私有的。
- **問題**：app 化之後怎麼更新？
- **選項**：
  1. **維持 git 加 bundle，從 repo 啟動 Electron**（5.1 節 U1）：不必打包，和開發流程一致。代價：要有 Node 和 npm；更新時要記得跑 `npm ci`。零額外工時。
  2. **手動安裝檔**（U2）：在 Owner 的電腦上 build，雙擊覆蓋安裝，資料不受影響。代價：每次 build 要幾分鐘；需要 B3 的打包工作（已經算在 B3 裡）。
  3. **electron-updater 從私有 GitHub Releases 自動更新**（U3）：代價是 Owner 的電腦上要長期放一把能讀私有 repo 的 `GH_TOKEN`，官方明說不要寫進設定檔（〔查證 S5〕），舊版文件說私有 repo 只適用非常特殊的情況（〔查證 S6〕）；另外約 +1 人日。
- **建議**：B1～D2 用 **1**，B3 之後用 **2**，**不做 3**。只有一位使用者、一台電腦，自動更新省下的只是「雙擊一次安裝檔」；換來的是一把長期存在的 repo token。不論用哪種方式，升級時都一定走 5.3 節的「備份 → migrate → 快照比對」。
- **何時**：B3 開工前，B1 起先照建議執行。

### DA-7　Docker 是否完全移除（保留 D1 當備援？）

- **背景**：D2 之後，平常用 app 已經不需要 Docker。但 Docker 還有三個用途：
  - 錄製 cassette 的 `record_local.bat` 用 Docker 的 5433 測試庫，和 CI 同一顆 `pgvector/pgvector:pg16` 映像。
  - 在本機跑整合測試。
  - 萬一原生庫出問題時的回退。

  Docker Desktop 的 WSL2 虛擬機預設最多可以吃到實體記憶體的一半（〔查證 S29〕），社群回報閒置時約 2.5～3 GB（〔查證 S31〕，非官方數字）；它的 Resource Saver 在 WSL 2 上不會減少記憶體（〔查證 S30b〕）。「登入時自動啟動 Docker Desktop」的預設值是關閉（〔查證 S30〕），Owner 的電腦目前是否打開〔要實測〕。
- **問題**：D2 之後，Docker Desktop 要怎麼處理？
- **選項**：
  1. **完全解除安裝**：省磁碟、省記憶體，開機也比較快。代價：`record_local.bat` 和本機整合測試要改成用原生測試庫，這違反「錄製工具不變」的原則，也讓錄製環境和 CI 從此不同（排序規則等，R-3）；回退舊庫時要重新安裝 Docker。改錄製工具約 +1 人日。
  2. **保留安裝，但不開機自動啟動，平常不開（D1 當備援）**：正式庫用原生；只有錄製、跑整合測試、回退時才手動開。舊的 5442 volume 至少保留 30 天，刪除前再做一次 dump。代價：磁碟空間還在；要記得錄製前先開 Docker（`record_local.bat` 本來就會檢查並提示）。零工時。
  3. **暫時不搬**（只做 B，資料庫繼續用 Docker，由 app 代開）：零風險。代價：Docker 的記憶體一直都在；也就是 D2 延後。
- **建議**：**2**。記憶體的效益在平常使用時就拿到了；錄製和 CI 維持同一顆映像，「在我電腦上會過」這一整類問題不會回來（`ci.yml` 的註解）；回退路線隨時都在。
- **何時**：D2 搬家前（第 4.2 節第 7 步）。

### DA-8　Gemini 金鑰怎麼保管

- **背景**：Gemini 的金鑰現在以明文寫在 `exam_pro\.env`，但本機模式之後系統預設不用 Gemini（預付額度已經用完），所以金鑰可能是空的。app 化之後 `.env` 會搬到 `%APPDATA%`。Electron 內建的 `safeStorage` 在 Windows 上用 DPAPI 加密：可以擋住同一台電腦的其他使用者，但擋不住同一個使用者身分下的其他程式；而且要等 app 就緒後才能使用（〔查證 S17〕）。
- **問題**：金鑰要怎麼存？
- **選項**：
  1. **照舊以明文寫在 `.env`**，只是換了位置（`%APPDATA%\TutorExamBank\.env`），並確認這個資料夾不在 OneDrive 同步範圍內、也不會被打包進備份：零工時。代價：任何能讀這個檔案的人或程式都拿得到。
  2. **用 `safeStorage`（DPAPI）加密保存**：在設定畫面輸入，主行程解密後只放進後端行程的環境變數；`.env` 裡不再寫這一行。代價：約 +6h（設定畫面、遷移既有的值）；網頁版（`npm start`）讀不到加密的值，要另外設。
  3. **完全不存**：每次要用 Gemini 時在畫面上貼上，只放在記憶體裡。代價：每次重開 app 都要再貼一次；背景工作在夜間重試時會拿不到金鑰。
- **建議**：先用 **1**，**等 Owner 決定重新啟用 Gemini 時改成 2**。現在沒有在用，花一天保護一把空的金鑰不划算；一旦要用，金鑰會帶來真實的費用，就值得加密，也可以一併處理擱置區第 5 項（備份加密）。
- **何時**：B2 開工前（決定 `.env` 的位置時）。

### DA-9　要不要簽章

- **背景**：
  - 從網路下載、帶有「網路標記」的程式，執行時 SmartScreen 會依信譽決定要不要警告；沒有信譽的檔案會跳警告（〔查證 S32、S34〕）。微軟的簽章選項說明把「不簽章」列為 SmartScreen 會強烈攔截、不建議公開散布（〔查證 S35〕）。
  - 2024 年起，EV 憑證不再能直接略過 SmartScreen，和 OV 一樣要慢慢累積信譽；微軟自己說只為了避開 SmartScreen 而多付 EV 的錢（每年 400 美元以上）已經不值得（〔查證 S33、S35〕）。
  - 微軟的 Artifact Signing（原名 Trusted Signing，約每月 9.99 美元）目前只開放美國、加拿大、歐盟、英國的組織，個人開發者只限美國和加拿大（〔查證 S35〕；另見 S37，微軟問答區 2026-03 的回答說個人開發者的新申請已暫停）；Owner 在台灣，以個人身分用不了。
  - 在自己電腦上 build 出來的檔案沒有網路標記，〔推論〕不會觸發 SmartScreen 的信譽檢查；Defender 的特徵掃描則照常進行。
- **問題**：安裝檔和 exe 要不要簽章？
- **選項**：
  1. **不簽章，只在 Owner 的電腦上 build 和安裝**：零成本。代價：解除安裝的清單和檔案內容裡顯示「未知的發行者」；萬一 Defender 誤判，要手動放行（R-5）。
  2. **自簽憑證**，並匯入 Owner 電腦的信任存放區：顯示得出發行者名稱。代價：約 2h；對 SmartScreen 的信譽沒有幫助；憑證的私鑰要自己保管。
  3. **購買 OV 或 EV 程式碼簽章憑證**：換到另一台電腦或給別人用時，信譽可以慢慢累積。代價：每年要付費（EV 每年 400 美元以上，〔查證 S35〕；OV 的價格〔未查證〕）；EV 也不能直接略過 SmartScreen（〔查證 S33、S35〕）；給別人用會碰到 mupdf 的 AGPL（R-12）。
- **建議**：**1**。只有一位使用者、在同一台電腦上 build 和安裝，簽章要解決的「陌生人下載後信不信任」問題根本不存在。將來真的要給別人用，要先處理的是 AGPL 授權（擱置區第 7 項），不是簽章。
- **何時**：B3 開工前。

### DA-10　什麼時候搬家（D2 正式切換）

- **背景**：搬家要停止寫入約 30～45 分鐘（4.5 節），而且前後要做快照比對。目前還有重錄在排程上（`local-mode.md` 10.21），重錄會跑一整天、吃滿 CPU 和記憶體；上傳考卷也會寫入正式庫。
- **問題**：D2 的正式切換要挑什麼時候做？
- **選項**：
  1. **準備好就立刻搬，不等 B**：先由 A 的啟動器改去開原生 PostgreSQL（〔推論〕，約 +0.5 人日），早點拿到記憶體的效益。代價：B2 還沒做完，路徑還在 repo 裡，之後 B2 還要再搬一次檔案（資料庫不必再搬）。
  2. **B2 完成、演練通過之後，挑一個沒有重錄、當週也沒有要上傳考卷的空檔**，例如週末早上：路徑已經穩定，只搬一次。代價：記憶體的效益要等比較久。
  3. **等 B3 的安裝檔完成，安裝和搬家同一天做**：一次到位。代價：一天之內變動太多，出問題時難判斷是安裝還是搬家造成的；效益最晚拿到。
- **建議**：**2**。一次只換一件事（先換路徑，再換資料庫，最後換安裝方式），每一步都有自己的驗收和回退路線；避開重錄，是為了讓比對和計時都可信。
- **何時**：D2 演練通過之後。

### DA-11　要不要保留區網存取（網頁版）

- **背景**：
  - `npm start` 目前綁在所有網路介面（`server.js`），同一個 Wi-Fi 裡的平板或手機可以打開題庫。
  - 金鑰會注入首頁，所以它不是存取控制（擱置區第 8 項）。
  - 在非 HTTPS 的區網位址下，瀏覽器不會開放麥克風（`public/js/tutor.js:157-168`）。
  - 2026-09-24 的 gap analysis 曾建議：要在課堂上用平板時，改走 Tailscale 取得 HTTPS。
- **問題**：桌面版的後端要不要開放區網連線？網頁版要不要一起收緊？
- **選項**：
  1. **桌面版只綁 127.0.0.1**；網頁版的綁定位址另外決定，可以選維持現狀，也可以改成用 `HOST` 環境變數設定、預設 127.0.0.1（約 1h）：最安全。代價：要用平板時得另外開網頁版，或走 Tailscale。
  2. **桌面版在設定裡提供「區網模式」**：綁 0.0.0.0，而且一定要設密碼（Basic Auth，或不把金鑰注入首頁、改用登入頁），`ALLOWED_ORIGINS` 加上區網位址。代價：約 1～1.5 人日；區網下麥克風仍然不能用；要多維護一套登入邏輯。
  3. **維持現狀**（網頁版綁所有網路介面、沒有密碼）：零工時。代價：同一個網路裡的任何人都能打開題庫和學生資料。
- **建議**：**1**，網頁版也改成預設 127.0.0.1；要用平板時再照 gap analysis 走 Tailscale 加 HTTPS。桌面版本來就不需要被別台機器連；網頁版目前對同一個網路敞開，而 Owner 可能沒意識到這件事（資料庫早就只綁 127.0.0.1，網頁伺服器還沒有）。
- **何時**：B1 開工前。網頁版的部分可以提早放進 A 一起做。

### DA-12　原生庫的 locale（排序規則）

- **背景**：Docker 的 PostgreSQL 用 Linux 的 locale，原生庫用 Windows 或 ICU 的 locale，兩者對中文的排序可能不同。受影響的有：學生名單的順序、分類時例題的排列順序，以及 pg_trgm 能不能替中文建三字組索引，這一項只影響 `ILIKE` 的速度，不影響結果（R-3）。**CI 和 cassette 不受影響**：CI 仍用 Linux 映像，cassette 的鍵也和順序無關。Windows 上 UTF-8 可以搭配任何 locale（〔查證 S24〕）。
- **問題**：initdb 和 createdb 要用哪一種 locale？
- **選項**：
  1. **`--locale=C`**：和作業系統無關，按位元組排序，行為最可預測。代價：中文按編碼順序排，不是按筆畫或注音；pg_trgm 可能完全抽不出中文三字組，`ILIKE` 用不到索引（〔推論〕），題量小時感覺不到。
  2. **ICU**（`--locale-provider=icu --icu-locale=<候選>`）：跨平台一致，Unicode 定序。代價：和 Docker 的 glibc 排序可能仍有細節差異；pg_trgm 的字元分類仍看 `LC_CTYPE`〔推論〕。
  3. **Windows 的 locale**（例如 `English_United States` 或 `Chinese (Traditional)_Taiwan`）：最接近這台電腦的慣例。代價：行為依 Windows 版本而定，換電腦就可能不同。
- **建議**：**演練時比對後再定**。第 0 步三種各建一個庫，比對 4.3 節最後一列（章名排序、學生名排序、`show_trgm`），選「和 Docker 庫最接近、而且 `show_trgm` 抽得出中文」的那一種。三種都差不多時選 2，因為它最不依賴作業系統。這一題沒有實測資料就定，只會是猜測。
- **何時**：D2 第 0 步的演練時。

---

## 9. 查證來源（2026-09-27 讀取）

| 編號 | 內容 | 連結 |
|---|---|---|
| S1 | Electron 各大版本的穩定日期、支援結束日、內建的 Node 與 Chromium 版本（42～46；44.0.0 是 Node v24.18.1，45、46 是 v24.21.0） | https://releases.electronjs.org/schedule |
| S2 | 目前的穩定版 44.4.5（2026-09-23）：Node 24.21.0、Chromium 152 | https://releases.electronjs.org/ |
| S3 | 只支援最新三個穩定大版本；每 8 週出一個大版本 | https://www.electronjs.org/docs/latest/tutorial/electron-timelines |
| S4 | electron-updater：Windows 的 NSIS 支援自動更新；支援的更新來源（GitHub Releases、generic HTTP(S) 等，generic 要手動上傳） | https://www.electron.build/docs/features/auto-update/ |
| S5 | GithubOptions 的 `private`、`token`（token「Never specify it in the configuration files」） | https://www.electron.build/docs/api/builder-util-runtime.interface.githuboptions/ |
| S6 | 舊版 electron-builder wiki：私有 repo 更新「Only for very special cases」、GitHub API 每小時 5000 次、每次檢查最多 3 次（現行文件找不到這段） | https://github-wiki-see.page/m/gniezen/electron-builder/wiki/Auto-Update |
| S7 | NSIS 的預設值：`oneClick` true、`perMachine` false、`deleteAppDataOnUninstall` false | https://www.electron.build/docs/nsis/ |
| S8 | 超過 2 GB 的 app 會產生損壞的 NSIS 安裝檔 | https://github.com/electron-userland/electron-builder/issues/8399 |
| S9 | sharp：需要 Node-API v9（Node >= 20.9.0）；electron-builder 要 `asarUnpack` sharp 與 @img | https://sharp.pixelplumbing.com/install |
| S10 | `utilityProcess.fork`：有 Node 環境與 MessagePort，選項包括 env、cwd、stdio | https://www.electronjs.org/docs/latest/api/utility-process |
| S11 | 行程模型：utility process 適合放吃 CPU、容易崩潰的元件 | https://www.electronjs.org/docs/latest/tutorial/process-model |
| S12 | 安全指引：預設自動核准所有權限請求；本機頁面建議用自訂協定取代 `file://` | https://www.electronjs.org/docs/latest/tutorial/security |
| S13 | session：`setPermissionRequestHandler`／`setPermissionCheckHandler`；`media` 權限與 mediaType | https://www.electronjs.org/docs/latest/api/session |
| S14 | DownloadItem：沒有設存檔路徑時通常會跳出存檔對話框；`setSaveDialogOptions` | https://www.electronjs.org/docs/latest/api/download-item |
| S15 | app：`requestSingleInstanceLock`、`second-instance`、`userData` 位置、`setLoginItemSettings` | https://www.electronjs.org/docs/latest/api/app |
| S16 | BrowserWindow：Windows 的 `query-session-end`、`session-end`；`close` 事件可以取消 | https://www.electronjs.org/docs/latest/api/browser-window |
| S17 | `safeStorage`：Windows 用 DPAPI，擋同一台電腦的其他使用者，擋不住同一個使用者身分下的其他程式；app 就緒後才能用 | https://www.electronjs.org/docs/latest/api/safe-storage |
| S18 | EDB 的 PostgreSQL Windows x86-64 壓縮檔（PG16 只列 16.15）；「archives of the files installed by our PostgreSQL installers」「provided as a convenience for expert users」。實際的下載點（`sbp.enterprisedb.com`、`get.enterprisedb.com`）在這個環境被代理擋下（403），所以沒量到 zip 大小 | https://www.enterprisedb.com/download-postgresql-binaries |
| S18b | 2026-09-12 有人請 EDB 公布 `postgresql-16.15-1-windows-x64-binaries.zip` 的 SHA-256，讀取時沒有回應 | https://github.com/EnterpriseDB/edb-installers/issues/696 |
| S18c | 第三方安裝腳本的說明：`postgresql-16.1-1-windows-x64-binaries.zip` 約 330 MB；其中的 pgAdmin 4 解開後約 760 MB | https://github.com/darianmiller/install-postgres-on-windows |
| S19 | pgvector：Windows 用 VS C++ 工具加 `nmake /F Makefile.win` 安裝（範例 v0.8.6）；也可以用 Docker、conda-forge；升級用 `ALTER EXTENSION vector UPDATE` | https://github.com/pgvector/pgvector |
| S20 | Docker Hub `pgvector/pgvector` 的標籤：`0.8.6-pg16`、`pg16` 等 | https://hub.docker.com/r/pgvector/pgvector/tags |
| S21 | conda-forge 的 pgvector feedstock：建 osx_64 與 win_64；recipe 在 Windows 把 host 的 postgresql 固定在 `<17`（沒寫理由） | https://github.com/conda-forge/pgvector-feedstock 、https://github.com/conda-forge/pgvector-feedstock/blob/main/recipe/meta.yaml |
| S21b | conda-forge 的 win-64 套件 `pgvector-0.8.6-h2466b09_0.conda`（另有 0.8.5）依賴 `libpq >=16.15,<16.16.0a0`；Linux 與 macOS 版依賴 libpq 18.6 | https://prefix.dev/channels/conda-forge/packages/pgvector |
| S22 | 第三方的 Windows 預先編譯 pgvector（v0.8.6、PG13～18；說明只寫「native compiled in Microsoft Windows environment」，發布頁看不到建置方式與紀錄） | https://github.com/andreiramani/pgvector_pgsql_windows/releases |
| S23 | pg_trgm 屬於 Additional Supplied Modules，而且是 trusted 擴充 | https://www.postgresql.org/docs/16/pgtrgm.html |
| S24 | 「On Windows, however, UTF-8 encoding can be used with any locale.」 | https://www.postgresql.org/docs/16/multibyte.html |
| S25 | 不允許以系統管理員權限執行 PostgreSQL；工具程式在 Windows 上用 restricted token | https://paquier.xyz/postgresql-2/postgres-utilities-restricted-token/ |
| S26 | 在有系統管理員權限的工作階段中，直接 spawn `postgres.exe` 會失敗，改用 `pg_ctl start -w` 可以正常啟動 | https://github.com/iMelki/paperclip/issues/35 |
| S27 | Windows 上二進位路徑含非 ASCII 字元時 initdb 失敗（PG13.1） | https://www.postgresql.org/message-id/16926-e4ef345545d185ab@postgresql.org |
| S28 | PG17 的 EDB 安裝程式：暫存路徑含中文時 initdb 找不到密碼檔 | https://www.mail-archive.com/pgsql-hackers@lists.postgresql.org/msg192299.html |
| S29 | `.wslconfig` 的 `memory` 預設是 Windows 總記憶體的 50% | https://learn.microsoft.com/en-us/windows/wsl/wsl-config |
| S30 | Docker Desktop 設定：WSL 2 下的記憶體上限在 `.wslconfig` 設；「Start Docker Desktop when you sign in」預設關閉 | https://docs.docker.com/desktop/settings-and-maintenance/settings/ |
| S30b | Resource Saver：預設開啟、閒置 5 分鐘啟動；在 WSL 2 上只暫停 `docker-desktop` 發行版裡的引擎，**不減少記憶體** | https://docs.docker.com/desktop/use-desktop/resource-saver/ |
| S31 | 社群回報 Docker Desktop 閒置時約 3 GB、vmmem 約 2.5 GB（非官方數字） | https://forums.docker.com/t/docker-desktop-idle-memory-usage/138540 |
| S32 | SmartScreen：沒有信譽的檔案或 app 會被標成較高風險並跳警告 | https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/ |
| S33 | EV 憑證不再保證能避開 SmartScreen 警告 | https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings |
| S34 | 網路標記（Mark-of-the-Web）與 SmartScreen 的關係 | https://textslashplain.com/2016/04/04/downloads-and-the-mark-of-the-web/ |
| S35 | 微軟〈Code signing options for Windows app developers〉：沒信譽的新檔案會跳 SmartScreen 警告；EV 的自動信任 2024 年取消，只為避開 SmartScreen 付 EV 的錢（每年 400 美元以上）不值得；不簽章會被強烈攔截、不建議公開散布；Artifact Signing 約每月 9.99 美元，組織限美、加、歐盟、英國，個人限美、加 | https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options |
| S36 | `electron-v44.4.5-win32-x64.zip` 的大小是 158,184,819 bytes（2026-09-27 以 HEAD 請求取得 Content-Length） | https://github.com/electron/electron/releases/download/v44.4.5/electron-v44.4.5-win32-x64.zip |
| S37 | 微軟問答區（2026-03-06）：Trusted Signing 的個人身分只開放美國與加拿大，其他地區的個人申請暫停（回答是自動產生的，只當補充） | https://learn.microsoft.com/en-nz/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident |
| S38 | npm registry（2026-09-27）：`electron` latest 44.4.5、`electron-builder` latest 26.15.3、`electron-updater` 6.8.9 | https://www.npmjs.com/package/electron 、https://www.npmjs.com/package/electron-builder 、https://www.npmjs.com/package/electron-updater |
| S39 | 官方 postgres 映像（16）的 Dockerfile：產生 `en_US.UTF-8` 並設 `ENV LANG en_US.utf8` | https://github.com/docker-library/postgres/blob/master/16/bookworm/Dockerfile |
| S40 | pgvector 的 Dockerfile：`FROM postgres:$PG_MAJOR-$DEBIAN_CODENAME` | https://github.com/pgvector/pgvector/blob/master/Dockerfile |
| S41 | libuv `src/win/process.c`：非 detached 的子行程放進設了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job，「if this process exits it is closed and all the processes it contains are killed」；同時設 `SILENT_BREAKAWAY_OK`，所以子行程再開的行程不受影響 | https://github.com/libuv/libuv/blob/v1.x/src/win/process.c |
| S42 | MDN〈Origin〉：跨來源請求都帶 `Origin`；同源請求除了 GET、HEAD 以外也都帶 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin |
| S43 | GitHub Actions 標準 runner 每分鐘價格：Linux 2 核 0.006 美元、Windows 2 核 0.010 美元、macOS 0.062 美元 | https://docs.github.com/en/billing/reference/actions-minute-multipliers |

另外引用了兩份專案文件（不是網路來源）：`local-mode-status-2026-09-25`（OCR 自檢 121 秒、2026-09-25 備份檔 0.99 MB、198 題）與 `owner-decisions-2026-09-26`（第四輪 V3：本機模式逾時只重試 1 次）。

**查不到或不確定的事**（實作時要補）：

| 事項 | 狀態 | 什麼時候確認 |
|---|---|---|
| EDB 壓縮檔的實際大小與 contrib 的內容 | 下載點被這個環境的代理擋下。已知：EDB 說 zip 就是安裝程式裝的檔案（S18），16.1 的 zip 約 330 MB（S18c）。contrib 在不在〔推論〕在 | D2 第 0 步解壓後 |
| conda-forge 上 postgresql 16.15 的 win-64 套件 | 網頁清單沒列出；〔推論〕存在，因為 win-64 的 pgvector 就是對 libpq 16.15 建的（S21b） | 選 DA-5 的 3 時用 `micromamba search` |
| Visual Studio Build Tools 的確切大小 | 查不到可靠數字 | 選 DA-5 的 1 時 |
| OV 程式碼簽章憑證的價格 | 查不到可靠數字（EV 每年 400 美元以上，S35） | 只有 DA-9 改選 3 時才需要 |
| Electron 的實際記憶體用量 | 沒有可靠的官方數字 | B1 冒煙測試時在工作管理員記錄 |
| Blob 下載時 Electron 另存新檔對話框預填的檔名 | 文件沒寫（S14） | B1 手動驗收第 2 點 |
| 後端結束、連線中斷時，Ollama 會不會立刻停止生成 | 沒查到文件 | B1 驗收「放棄」時觀察 Ollama 的 CPU |
| Electron 主行程結束時，utility process 會不會一起結束 | 文件沒寫（S10） | B1 驗收第 5 點 |
| `@node-rs/jieba` 能不能用 npm 的 `--os`／`--cpu` 旗標跨平台安裝 | 沒查 | 只有要在 Linux 上打 Windows 包時才需要 |
| Owner 的 Windows 帳號是不是內建的 Administrator、Owner 電腦上的 Node 小版本、PG17 的 `bin` 在哪裡、Docker Desktop 是否設為登入時啟動 | 只能在 Owner 的電腦上看 | B1 開工前 |
| Docker 庫實際的 pgvector 版本與 collation | 只能在 Owner 的電腦上查（〔推論〕是 `en_US.utf8`，S39、S40） | D2 第 0 步 |

---

## 自我檢查紀錄（2026-09-27）

第一版草稿 `325c52b` 是作者中斷時留下的，沒有自我檢查。這一版逐節對照需求、重讀程式與來源，改了下面這些地方：

**事實更正（草稿寫錯的）**

1. **關閉時中止節點會吃掉重試次數**（2.3 節、第 3 條第 2 項、R-17）：草稿要「用 AbortController 中止在途節點」，但現有程式把 abort 記成 `timeout`、寫進事件表、累加重試次數；拆題迴圈甚至會立刻重試，本機模式下可能讓整份卷 `failed`。改成另開 `abandon` 路徑，不寫 outcome、只放掉租約。
2. **python 不會變成孤兒行程**（2.3 節、R-9）：草稿推論 Windows 不會跟著結束子行程。libuv 原始碼顯示非 detached 的子行程會被放進「父行程結束就終止」的 job（S41）。相反地，postgres 是孫行程，app 當掉時會繼續跑，這一點補進 2.5 節與 D2 驗收。
3. **`setup_local_ai.bat` 找的是 `ollama.exe`，不是 `ollama app.exe`**（2.6 節）。
4. **「約 60 支測試假設 `data/jobs`」**：實際是 7 個測試檔、18 處（第 3 條第 12 項）。
5. **作答快照的排序例外**：`snapshot_attempt_views.js` 的學生依 `id` 排，會受排序規則影響的是弱點表同分時的次序；另外它的作答雜湊跟著伺服器 `timezone` 走（4.3 節）。
6. **`PATH` 裡沒有 PG17 的工具**（1.3 節、4.2 節第 4 步），依 `backup.js` 檔頭。
7. **D2 工時重複計算**：草稿把 pgvector 的取得算在第 26 項，又在 D2 另計一次。B2 的小計也和逐項加總對不上。重算後合計約 18～19.5 人日（第 0、6 條）。
8. **A 已經有程式**：草稿寫「A 那條分支還沒有 commit」，現在有 `d730422`。第 6.1 節改寫成逐模組對齊，刪掉「A 寫成 `.bat` 就加 3h」。

**補上的遺漏**

- 盤點新增第 33 項（維護工具寫在 `data/` 的預設位置）、第 34 項（A 的 `data/launcher`、`data/logs`）；第 13 項補 `LLM_MODE` 預設是 `replay` 的陷阱；第 15 項補 `setup_local_ai.bat` 依賴 `node` 與 `eval\tools\tee_run.js`，staging 要保留它。
- 4.1 節補「Docker 庫的 pgvector 比 0.8.6 舊時先升級」與 Docker 庫 locale 的依據；4.2 節第 1 步寫出確切的查詢。
- 5.3 節對齊 `deployment_and_operations.md` §3.6 與 A 的 `migrationStatus.js`。
- R-18（A、B 同改 `server.js`、`app.js`）。

**查證後補上或改強的說法**

- Electron 44.0.0 內建的是 Node 24.18.1，44.4.5 才是 24.21.0（S1、S2）；npm 上的最新版本（S38）。
- EDB 沒有公布 zip 的雜湊（S18b）；16.1 的 zip 約 330 MB（S18c）。
- conda-forge 的 win-64 pgvector 確定是對 PG16 編的（S21、S21b），DA-5 的選項 3 從「不確定」變成可行的退路。
- Resource Saver 在 WSL 2 上不省記憶體（S30b）；Docker Desktop 預設不在登入時啟動（S30）。
- 簽章：改用微軟官方的說明頁（S35），原本的問答區連結降為補充（S37）；補上 EV 與 Artifact Signing 的價格與地區限制。
- GitHub Actions 的 Windows 分鐘價格（S43）；同源 POST 帶 `Origin` 的依據（S42）。
- pg_trgm 只從英數字抽三字組、抽不到時退化成掃整個索引（S23），並確認專案只用它建索引、沒有用 `similarity()`。
