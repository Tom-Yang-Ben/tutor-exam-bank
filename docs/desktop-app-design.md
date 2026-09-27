# 桌面應用程式設計稿：B（Electron 桌面殼）＋ D2（原生 PostgreSQL、拿掉 Docker）

> **狀態：設計稿，尚未實作；〔2026-09-27〕第 8 條的 14 題決策 Owner 已全部答覆（第六輪），依答案確定的段落改成「定案」語氣、原文脈絡保留。** 分支 `dec/desktop-app-design-fix`（接在 `dec/desktop-app-design` 的 `c3cd57f` 之後），基底 `local/integration-r6`（`0ba9bc6`）。只改文件，沒有產品程式。
> **版本**：第一版草稿是 `325c52b`（作者中斷時留下）；`c3cd57f` 是逐節自我檢查、查證後的正式版（改了什麼見文末「自我檢查紀錄」）；本版依審查意見再修一次，逐條的查證結果與改法見文末「審查修正紀錄」。〔2026-09-27〕第六輪決策的登錄見文末「第六輪決策登錄紀錄」，其審查小修見「審查修正紀錄（`dec/r7-decisions-host-fix`）」。
> **Owner 的決定（2026-09-27）**：先做 A（啟動器）；B 與 D2 同時開始規劃，先不實作。A 在另一條分支 `dec/desktop-launcher` 上實作，目前有一個**未審查、未合併**的進行中 commit `d730422`（第 6.1 節列出它已經有的模組）。B1 開工前要先和 A 對齊（第 6.1 節）。
> **〔2026-09-27，分支 `dec/r7-electron-b1`，審查修正 `dec/r7-electron-b1-fix`〕B 部分的現況：B1 已實作（待 Owner 驗收）；B2、D2、B3 仍是設計稿。** 上面「狀態」那一行的「尚未實作」寫在 B1 之前，現在只對 B2、D2、B3 成立。B1 依第六輪答案 DA-2＝3、DA-3＝2、DA-6＝1、DA-11＝1 做完，做了什麼、雲端驗了什麼、Owner 的驗收步驟都在第 6.2 節；本文件其他各節的「現況」仍是 B1 之前的描述。
> **名詞**：
> - **A**：啟動器。雙擊一個檔案，它會開 Docker Desktop、開資料庫、檢查 Ollama、開伺服器和瀏覽器。
> - **B**：Electron 桌面殼（本文件）。
> - **D1**：繼續用 Docker 跑資料庫，由啟動器或 app 代為啟動。
> - **D2**：改用 Windows 原生的 PostgreSQL 16，平常不需要 Docker（本文件）。
>
> D1、D2 的定義以本文件為準。
> **〔Owner 第六輪決策 2026-09-27，分支 `dec/r7-decisions-host`〕** DA-1～DA-14 的答案逐題登錄在第 8 條（一覽表多一欄「Owner 2026-09-27」，各題開頭加註〔Owner 2026-09-27 選 N〕），一覽表也在 `docs/HANDOFF.md` §0.00d。十四題之中，十三題選的就是本文件的建議；DA-12 原本建議「演練時比對後再定」，Owner 直接定 ICU（選 2）。**程式這次只落實 DA-11 的網頁版那一半**（後端改聽 `HOST`、預設 `127.0.0.1`，`exam_pro/config/listenHost.js`）；B、D2 的其餘部分仍未實作。還沒定的只剩兩件：DA-9 的前提（Smart App Control 是否關閉，Owner 確認）與 DA-14 的量測結果（Owner 自己做，第 10 節）。第 10 節是給 Owner 的操作說明（WSL 記憶體上限、`wsl_memory_check.bat`）。
> **查證標記**：
> - 〔查證 Sn〕：有來源，見第 9 條。
> - 〔未查證〕：查不到或不確定。
> - 〔推論〕：從文件或程式推得，沒有實測。
> - 〔要實測〕：只能在 Owner 的電腦上確認。
>
> 查證日期是 2026-09-27。
> **不變的原則**：
> - CI（`.github/workflows/ci.yml`）與錄製工具（`scripts/windows/record_local.bat`、`npm run cassettes:rerecord`）一律不改。`docker-compose.yml` 的測試庫 `postgres_test` 不動；D2 切換時正式庫 `postgres` 服務要加 profile，才不會被 `docker compose up` 帶起來（第 3 條第 23 項）。CI 不用 compose，不受影響。
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
| B1 | Electron 殼加內嵌後端（資料庫仍在 Docker） | 雙擊圖示就出現視窗，有系統匣圖示。關視窗的行為照 DA-2（〔定案〕選 3：有工作縮到系統匣並通知，沒工作直接結束）。Docker Desktop 還是要在跑，但由 app 代為啟動 | 約 58～60h，約 7.5 人日（含 DA-13 的逐塊檢查點 5～7h） |
| B2 | 路徑與設定搬出程式資料夾（〔定案 DA-1＝2〕設定在 `%APPDATA%`，資料庫、附圖、日誌在 `%LOCALAPPDATA%`，備份在「文件\TutorExamBank\backups」） | 程式和資料分開放，更新程式時不會動到題庫附圖、考卷 PDF 或備份 | 約 33～35h，約 4～4.5 人日 |
| D2 | 原生 PostgreSQL 16 加 pgvector，把資料搬過去 | 不必開 Docker Desktop，省下 WSL2 虛擬機吃掉的記憶體（省多少先照 DA-14 量） | 約 48～57h，約 6～7 人日（含 pgvector 的取得與舊庫防護） |
| B3 | 打包成安裝檔 | 有正式的安裝和解除安裝，也有開始選單捷徑 | 約 23～26h，約 3～3.5 人日 |

一人日以 8h 計。四期合計約 162～178h，也就是約 **20～22.5 人日**，包含單元測試與文件（第 6.6 節有逐期的算法）。這個數字**沒有緩衝**；〔要實測〕的項目很多，建議另加 20～30%，也就是約 195～232h、**24.5～29 人日**（第 6.6 節列出沒算進去的風險）。Owner 自己要花的時間另外算：DA-14 的 WSL 記憶體上限與量測約 0.5 小時，D2 的演練加搬家約 2～3 小時，B3 在自己電腦上試裝約 1 小時，B3 重建 OCR 的 Python 環境約 30～60 分鐘（重新下載 2～3 GB，視網速〔推論〕）。

**問：Docker 的部分怎麼辦？**

- **B1 期間**：資料庫還在 Docker，由 app（或沿用 A 的邏輯）代為開 Docker Desktop 並執行 `docker compose up -d --wait`。
- **D2 之後**：正式庫改成原生 PostgreSQL，平常用 app 完全不需要 Docker。切換時一定要讓 `docker compose up` 不再帶起舊的正式庫（第 3 條第 23 項）。`record_local.bat`、`啟動資料庫.bat` 每次都會跑 `docker compose up`；沒有這道防護，舊庫會在 5442 復活，變成兩份正式庫（R-19）。

~~建議（DA-7）~~〔Owner 2026-09-27 DA-7 選 2，定案〕：Docker Desktop **保留安裝，但不要開機自動啟動**，只在三種情況才開：

- 錄製 cassette：`record_local.bat` 用 Docker 的 5433 測試庫，和 CI 是同一顆映像。
- 在自己電腦上跑整合測試。
- 需要退回舊庫。

舊庫的 Docker volume 至少保留 30 天，當作回退用的備援（也就是 D1 狀態）。

Docker 自己的省資源模式不省記憶體：Resource Saver 在 WSL 2 上只會暫停 Docker 引擎，**不會減少記憶體用量**，Docker 的文件改建議開 WSL 的 `autoMemoryReclaim`（〔查證 S30b〕）。但這不代表「只能讓 Docker Desktop 不要開著」（第一版正式稿這樣寫，講過頭了）：WSL 的 `.wslconfig` 可以給虛擬機設記憶體上限（`[wsl2] memory=`，預設是實體記憶體的一半，也就是 8 GB），也可以讓它自動歸還快取（`[experimental] autoMemoryReclaim`，〔查證 S29〕），約 0.5 小時就能做完。**建議先做這一步並量測，再決定 D2 值不值得花約 48～57 小時**（DA-14）。〔Owner 2026-09-27 DA-14 選 1，定案〕Owner 自己設 `memory=3GB`、`autoMemoryReclaim=dropCache` 並量測，步驟與檢查工具在第 10 節；D2 做不做，等量測結果再定。

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
- Windows 11 的 Smart App Control（SAC）是開、評估還是關〔要實測：「Windows 安全性 → 應用程式與瀏覽器控制 → Smart App Control」〕。它開著時，本機 build 的未簽章 exe 會被擋（DA-9、R-5）。〔2026-09-27〕DA-9 定案選 1（不簽章），前提是 SAC 關閉；`wsl_memory_check.bat` 會一併讀出 SAC 的狀態（第 10 節），Owner 看畫面或 log 確認。
- WSL 的版本與 `.wslconfig` 有沒有設記憶體上限〔要實測：`wsl --version`、`%UserProfile%\.wslconfig`〕（DA-14）。〔2026-09-27〕`wsl_memory_check.bat` 讀出這兩項並寫進 log（第 10 節）。

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
│   └─ backendHost：用 utilityProcess 開後端（DA-3 定案），監看、崩潰時重開          │
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
if (require.main === module) { require('dotenv').config(); /* 照舊：listen(PORT, HOST)（〔DA-11〕HOST 預設 127.0.0.1） */ }
```

- `node server.js` 和 `npm start` 的行為一個字都不變：一樣讀 `.env`、一樣聽 `PORT`、一樣綁所有網路介面。改不改綁定位址由 DA-11 決定。
  〔Owner 2026-09-27 DA-11 選 1，定案，已實作〕網頁版改用 `HOST` 設定、**預設 `127.0.0.1`**（分支 `dec/r7-decisions-host`：`server.js` 呼叫 `app.listen(PORT, HOST)`，判斷集中在 `exam_pro/config/listenHost.js`，A 的啟動器用同一支決定連哪個位址）。所以「一樣綁所有網路介面」這句已不成立：B1 改 `server.js` 時以這一版為基底，`require.main === module` 的分支沿用 `HOST`；`startServer()` 由桌面版呼叫時一律傳 `host: '127.0.0.1'`（桌面版只綁本機，不讀 `HOST`）。
- `startServer()` 本身**不讀 `.env`**。環境變數由呼叫它的人事先放好，因為 `config/db.js`、`config/features.js`、`routes/index.js` 都在 require 的當下讀 `process.env`（`config/db.js:26-31` 缺 `DATABASE_URL` 會直接丟錯）。
- **「中止在途節點」不能直接用現有的 abort**。現況與陷阱：
  1. `runner.stop()` 只會停止計時器（`workers/jobRunner.js:1833-1835`），不會中止還在跑的節點。
  2. 每個節點本來就有自己的 AbortController（`invokeNode`，`workers/jobRunner.js:826`），逾時時會 abort（`:870`）；`services/ocr/index.js` 收到 signal 會殺掉 python 子行程。
  3. **但被 abort 的節點會被歸類成 `timeout`**（`classifyError`，`:890-895`：`AbortError` 一律算逾時），照一般錯誤寫進 `job_events`，事件表會多出假的逾時。後果分兩種：
     - 題目層的節點（分類、驗算等）：算一次 error、累加 `retries` 後放掉租約（`:1214-1243`），error 最多重試 3 次（`maxErrorRetries`，`pipeline/stateMachine.js:64-68`），用完就以 `provider_error` 進人工複核。也就是**關三次 app 就可能把一題送進複核**。
     - 拆題的一塊（`runExtractChunk`，`:1336-1427`）更糟：逾時會在同一個迴圈裡**立刻重試**，本機模式逾時只重試 1 次（Owner 第四輪 V3，`:1408-1412`），第二次又被關閉流程中止的話，**整份卷就變成 `failed`**。
  4. 所以要加的是另一條路：`shutdown({ abandon: true })` 先標記「正在關閉」，再 abort 在途節點；runner 看到這個標記時**不寫 outcome、不動 `retries`、不寫 `job_events`、迴圈不重試**，只放掉租約。要涵蓋三種工作單位：
     - 題目層（`runJobQuestion`）：已經有現成的寫法可以照抄。工作單位沒寫回狀態就結束時，`finally` 會執行 `UPDATE job_questions SET locked_until = NULL`（`:1265-1269`）。
     - 拆題（`runExtractJob`／`runExtractChunk`）：放掉 `jobs.locked_until`，`state` 留在 `extracting`。
     - 變式（`runGenerateJob`／`runGenerateOne`，`:1513` 起）：它同樣呼叫 `invokeNode`，被 abort 時一樣記成 `timeout`、退避後重試（`:1665-1669`），全部題都沒建成時整份變式 job 會 `failed`（`:1545-1548`）。第一版正式稿漏了這一條。

     這樣下次開 app 立刻就能重新認領，不必等 180 秒的租約。
     **重跑點要分清楚**（第一版正式稿寫成一律「從那個節點的開頭重跑」，只對題目層成立）：
     - 題目層：從被放棄的那個節點重跑，前面已完成的節點不重跑。
     - 拆題 job：`runExtractJob` 每次都從**第 1 塊**跑到最後一塊（`:1311`），中間沒有逐塊的檢查點。本機模式一塊只有 2 頁（`LOCAL_PDF_CHUNK_PAGES`，`:191`），6～8 頁的卷就有 3～4 塊。在第 3 塊放棄的話，重開後前兩塊（本機每塊可能數十分鐘）會整個重跑，也會重新裁圖、重寫 extract 事件。已建的題靠 `insertJobQuestions` 的 `ON CONFLICT (job_id, idx) DO NOTHING`（`:1490-1494`）防重複，但只在重拆出**相同的 idx** 時有效。本機模型重拆出不同的題數或編號時會多出列：題幹完全相同的，會被 `agents/dedup.js:96-108` 的「同一份任務較早的題」比對擋下；文字略有差異的，可能多一題進後續流程〔推論〕。
     - 變式 job：從第 1 題重新生成（`:1540`）。已建的 idx 靠 `insertVariantQuestion` 的 `ON CONFLICT`（`:1701`）不會重複，但模型還是會再跑一次。
     - 〔2026-09-27 更新：DA-13＝2 已實作，分支 `dec/r7-checkpoints`、`dec/r7-checkpoints-fix`〕上面兩點是實作前的行為。現在拆題從被中斷的那一塊接著拆：已拆完的塊有檢查點（該塊 pass／skipped 的 extract 事件），不再呼叫 OCR 與模型；被中斷那一塊的題目列與檢查點在同一個交易，不會混出重複列。變式只補還沒建成的題（`job_questions` 沒有的 idx，含中斷點之前沒過閘門的），建好一題時「建列＋寫 pass 事件」也在同一個交易。第 36 項與 R-20 由這兩條分支處理，細節見 `docs/desktop-launcher.md` 7.3。**和第 36 項不同、待 Owner 確認**：每塊頁數在兩輪之間變了時，已從第 1 頁連續拆完的部分照跳，其餘頁用新頁數切、塊號接在舊的最大塊號之後（只比頁碼範圍、照新切法從第 1 塊重拆的話，新題號會和已建好的列撞號）；檢查點不是從第 1 頁起連續的一串時不自動重拆，job 直接 `failed`。

     這個重跑點今天就存在：`npm start` 的視窗被關、當機、nodemon 重啟都一樣（`workers/jobRunner.js` 檔頭第 18-19 行），不是桌面版才有。要不要加逐塊檢查點，讓拆題與變式從還沒完成的那一塊或那一題接著跑，列成 DA-13。
  5. 反過來說，**直接結束行程不會吃掉重試次數**：沒寫 outcome，只是租約要等到期。A 的關閉通道在寬限時間到了就直接結束（`d730422` 的 `launcherControl.js` 檔頭），就是這種情形。重跑點和上一點相同；A 的檔頭寫「從那一格重跑」，對拆題與變式 job 不成立，A 合併前要一起更正（第 6.1 節）。
- 子行程會不會變孤兒：
  - Node（libuv）在 Windows 上以非 detached 方式 spawn 的子行程，會被放進一個「父行程結束就全部終止」的 job object（〔查證 S41〕）。但同一個 job 設了 `SILENT_BREAKAWAY_OK`，子行程再開的孫行程不在這個 job 裡。
  - `services/ocr/index.js` spawn 的是 venv 的 `Scripts\python.exe`。它在 Windows 上是**轉導器**（redirector）：Python 3.7.2 起，venv 改用轉導器，不再複製直譯器本身（〔查證 S44b〕）。真正跑 OCR 的直譯器是它再開出來的**孫行程**，所以 libuv 的保證管不到它。
  - 孫行程會跟著結束，靠的是轉導器自己建的 job：CPython 的 `PC/launcher.c`（3.12，`run_child`）與 `PC/venvlauncher.c`（main）都會建一個設了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job，把直譯器放進去（〔查證 S44〕）。所以鏈條是：後端結束 → 轉導器被 libuv 的 job 終止 → 轉導器握著的 job 關閉 → 直譯器被終止。abort 時 `child.kill()` 殺掉的也是轉導器，走同一條鏈。
  - 結論：**〔推論〕python 不會變成孤兒**，但這是 Python 啟動器的實作，不是 libuv 的保證。以 B1 驗收第 5 點（工作管理員裡沒有殘留的 python）實測為準。第一版草稿「會變成孤兒」的推論仍然不成立，只是理由改成這一條。
  - 所以要不要「放棄在途節點」，考量的是上一點的重試次數與關閉速度，不是孤兒行程。
- Ollama 那一端：後端結束時連線中斷，Ollama 是否會立刻停止生成〔未查證〕。最壞情況是它把這一次生成跑完才釋放 CPU。

### 2.4 視窗

- `BrowserWindow` 載入 `http://127.0.0.1:<後端埠>/`，也就是現在的首頁，由 `serveIndex` 注入旗標和 API 金鑰（`app.js:122-155`）。
- 設定用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，不需要 preload。前端只用 `fetch`，完全不用 Node 的功能。
- 為什麼不用自訂協定（例如 `app://`）：Electron 的安全指引建議用自訂協定取代 `file://`（〔查證 S12〕），但我們兩者都不用。前端到處都用相對路徑 `fetch('/api/...')`，還有 multipart 上傳、`/figures`、`/vendor`，用自訂協定就得把全部請求轉手給 Express，工多又容易出錯。改走本機迴路的 http，再用下面三點把風險收小。
  1. 後端只綁 `127.0.0.1`，區網連不到（〔DA-11 定案〕桌面版不提供區網模式）。
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
| 資料夾 | `%LOCALAPPDATA%\TutorExamBank\pgdata16\`，**路徑只用英數字**（DA-1 定案） | Windows 上 PostgreSQL 碰到非 ASCII 路徑有已知問題：二進位檔所在路徑含非 ASCII 字元時 initdb 會失敗（PG13，〔查證 S27〕）；PG17 的 EDB 安裝程式在使用者暫存路徑含中文時，initdb 找不到密碼檔（〔查證 S28〕） |
| initdb | `initdb -D <pgdata> -U exam -E UTF8 --auth=scram-sha-256 --pwfile=<暫存檔> <locale 參數>`。~~locale 參數照 DA-12 在演練時決定。~~〔Owner 2026-09-27 DA-12 選 2，定案〕locale 參數是 `--locale-provider=icu --icu-locale=<值>`；`<值>` 的候選（例 `und`、`zh-Hant-TW`、`en-US`）在 D2 第 0 步演練時依 4.3 節最後一列比對後記錄。密碼檔放在 `pgdata` 旁邊用完就刪，不放 `%TEMP%` | Windows 上 UTF-8 可以搭配任何 locale（〔查證 S24〕）。排序規則的差異見 R-3 |
| 設定 | 在 `postgresql.conf` 追加：`listen_addresses = '127.0.0.1'`、`port = <DA 選的埠>`、`maintenance_work_mem = 256MB`（和 `docker-compose.yml` 的 `command` 相同）、`timezone = 'Asia/Taipei'`（和 compose 的 `TZ` 相同）、`logging_collector = on`（日誌寫在 `pgdata\log`） | 時區不同會影響重練排程的「日期」計算，搬家後要比對 `SHOW timezone` |
| 啟動 | **一定用 `pg_ctl start -w -D <pgdata> -l <日誌檔>`，不可直接執行 `postgres.exe`**。從 Node 執行 `pg_ctl` 時，stdio 設成 `'ignore'` 或導到檔案，並等 `'exit'` 事件，不要等 `'close'` | PostgreSQL 不肯在有系統管理員權限的帳號下執行（〔查證 S25〕），`pg_ctl` 會先降權再啟動（〔查證 S26〕）。Owner 的帳號資料夾叫 `Administrator`，如果真的是內建的 Administrator 帳號，所有行程都帶系統管理員權限〔要實測〕。stdio 的理由〔推論〕：用 pipe 時，常駐的 postgres 可能繼承這些 handle，pipe 一直不關，`'close'` 事件就永遠等不到 |
| 健康檢查 | 先跑 `pg_isready -h 127.0.0.1 -p <埠>`，再用 `pg` 連線執行 `SELECT 1`。啟動逾時 60 秒；失敗時把 `pgdata\log` 的最後 30 行顯示在狀態畫面 | 異常關機後的崩潰回復可能要多幾秒 |
| 埠 | 平時預設 **5442**：D2 切換完成、Docker 停掉之後，沿用舊的埠號，`.env` 和文件都不必改。和 Docker 並行演練期間用 **5452**。啟動前先檢查埠有沒有被占用；被占用時，如果回應的是我們自己的叢集（`SELECT system_identifier FROM pg_control_system()` 和記下的值相同）就直接沿用，否則報錯，不會自動換埠，免得和舊的 Docker 庫搞混。**「記下的值」由 pgManager 自己寫**：第一次 initdb 後啟動成功時，把 `system_identifier` 與 `data_directory` 記進 `state.json`；D2 的演練與切換都用 pgManager 的命令列建叢集（第 3 條第 25 項、4.2 節第 0 步），不手動 initdb，否則沒有這筆紀錄，app 會把自己的叢集當成別人的而報錯。**沿用 5442 的前提**是舊的 Docker 正式庫不會再被 `docker compose up` 帶起來（第 3 條第 23 項）；否則 app 沒開時舊庫會在 5442 復活，下次開 app 時這一列會報「不是自己的叢集」，而在那之前網頁版、維護工具都已經寫進舊庫（R-19） | 5432 被 Owner 的 PG17 服務占著。自動換埠會讓 `DATABASE_URL` 每次不同，排查時很難看懂，所以寧可報錯。另一個做法是原生庫改用新的埠、不動 compose，比較見第 3 條第 23 項 |
| 停止 | 結束 app 時，照 2.8 節的順序最後執行 `pg_ctl stop -m fast -w`。Windows 關機、重開或登出時，在 `query-session-end` 延遲一下並盡快停止（〔查證 S16〕） | 就算被強制中斷，PostgreSQL 下次啟動也會用 WAL 自動回復〔推論〕。**app 當掉時 PostgreSQL 不會跟著結束**：`pg_ctl` 是 app 的子行程，但 postgres 是 `pg_ctl` 再開出來的孫行程，不在 libuv 那個「父行程結束就終止」的 job 裡（〔查證 S41〕的 `SILENT_BREAKAWAY_OK`，〔推論〕）。下次開 app 時由上面「埠」那一列的判斷認出是自己的叢集並沿用 |
| 誰來管 | app 管理：開 app 才啟動，結束 app 就停止，不裝 Windows 服務（〔DA-4 選 1，定案〕） | 備份的時機跟著改（定案）：每天第一次開啟、結束前有寫入、migrate 前各備份一次，停用 02:00 排程（DA-4） |

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
  - **U1 期間（B1～D2，從 repo 啟動）`OCR_PYTHON` 沿用 repo 裡既有的 `exam_pro\ocr_service\.venv`**，不必重建。
  - **B3 的安裝版**才在 `%LOCALAPPDATA%\TutorExamBank\ocr-venv` 另建一份，`OCR_PYTHON` 指向它的 `Scripts\python.exe`。venv 不能直接搬或複製：Python 官方說 venv 裡寫死了直譯器的絕對路徑，本質上不可攜，要在新位置重建（〔查證 S44b〕）。重建要重新下載 PaddleOCR 的套件與模型約 2～3 GB，再跑一次 121 秒的自我檢查，Owner 約要 30～60 分鐘〔推論，視網速〕，算在第 0 條的 Owner 時間裡。
  - 網頁版沒寫 `OCR_PYTHON` 時照舊用 `exam_pro\ocr_service\.venv`（`services/ocr/index.js:105-126`）。
- 安裝（B3）：讓 `setup_local_ai.bat` 可以用環境變數指定 venv 和 log 的位置，沒設時行為完全不變，由首次啟動精靈代為執行（第 3 條第 15 項）。**注意它有兩個隱藏的依賴**：要有 `node` 在 `PATH` 裡（`:46-47`），而且用 `eval\tools\tee_run.js` 把輸出同時寫進 log（`:48`）。
  - 這支 `.bat` 和它用到的檔都要解開放在 asar 外面（2.9 節）：它會先 `cd /d "%~dp0..\.."`，cmd 進不了 asar。
  - 它要的 `node` 用 Owner 電腦上已經裝好的 Node。**不能**放一支 `node.cmd` 墊片來代替：`.bat` 裡的 `%TEE% …` 是直接呼叫、沒有 `call`，從批次檔直接呼叫另一支 `.cmd` 之後不會回到原來的批次檔〔推論，依 cmd 的 `call` 規則〕。
  - 要拿掉對系統 Node 的依賴，就把同一套步驟改寫成 Node 版本，由 app 自己執行（約 +4h，不在合計內）。
- 自我檢查（`ocr_pdf.py --selftest`）在 Owner 的電腦上要 121 秒（專案文件 `local-mode-status-2026-09-25`：2026-09-25 裝好時的 OCR 自檢耗時），**不在每次啟動時跑**，只在安裝時和系統匣選單的「OCR 自我檢查」才跑。啟動時只檢查 `python.exe` 存不存在。

### 2.8 單一實例、系統匣與關閉行為

- **單一實例**：用 `app.requestSingleInstanceLock()`。第二次雙擊時，由第一個 app 收到 `second-instance` 事件，把視窗叫到前面（〔查證 S15〕）。這把鎖管不到 `npm start`：兩者同時開、又連到同一個庫時，會有兩個 runner 一起認領工作。資料不會壞，因為用租約防止重複認領；但並行數會加倍、記憶體吃緊。
  - **怎麼偵測**：app 在開後端**之前**，先查 `pg_stat_activity` 有沒有 `application_name = 'tutor-exam-bank'` 的連線（第 3 條第 35 項讓用 `config/db.js` 的後端與工具都帶這個名稱）。有的話，再打 `http://127.0.0.1:3000/api/health`（A 的 healthController）分辨是不是網頁版開著，然後警告。行程一結束，它的連線就斷了，`pg_stat_activity` 不會留下已經死掉的行程〔推論〕。
  - **不用租約判斷**：第一版正式稿打算看「有沒有還沒到期的租約」（`locked_until > now()`），但 app 當機後 180 秒內重開時，上一個行程留下的租約還沒到期，會被誤判成別人在跑。
- **系統匣選單**：開啟視窗；狀態（PostgreSQL、Ollama、背景工作 N 件）；立即備份；開啟資料夾（資料、備份、日誌）；OCR 自我檢查；維護命令列（第 3 條第 21 項）；結束。
- **關閉視窗**：照 DA-2。建議做法：有工作在處理時縮到系統匣繼續跑，並跳通知說明；沒有工作時直接結束。〔Owner 2026-09-27 DA-2 選 3，定案〕照這個做法；從系統匣選「結束」而有工作時，問「等處理完再結束／現在放棄」，對話框寫明重跑範圍（DA-13 定案做了檢查點：題目層從那個節點、拆題從沒完成的那一塊、變式從沒完成的那一題接著跑）。
- **結束的順序**：
  1. runner 停止認領新工作。
  2. 在途節點最多等 10 秒；等不到就依使用者的選擇（DA-2 定案）：繼續等，或「放棄」。放棄走 2.3 節的 `shutdown({ abandon: true })`：abort 在途節點（OCR 子行程被殺掉），**不寫 outcome、不動重試次數**，只放掉租約。
  3. 關閉 HTTP 伺服器。
  4. 關閉 `pool`。
  5. 需要時做結束前備份（DA-4）。
  6. 執行 `pg_ctl stop -m fast`。
  7. 結束 app。

  被放棄的工作下次開 app 會立刻被重新認領：題目層從那個節點重跑；拆題 job 從第 1 塊整份重拆，變式 job 從第 1 題重來（2.3 節第 4 點，除非 DA-13 選做逐塊檢查點）。〔DA-13 選 2，定案〕檢查點做了之後（第 3 條第 36 項），拆題改從沒完成的那一塊、變式改從沒完成的那一題接著跑。如果是當機或被強制結束（沒走到第 2 步），租約要等 `JOB_LEASE_MS`（預設 180 秒，`workers/jobRunner.js:111`）到期才會被認領，重跑點相同，同樣不會吃掉重試次數。本機的 OCR 整理一塊可能要十幾到幾十分鐘，拆題後段被放棄可能白費一小時以上，所以放棄之前一定要問使用者。

  這個順序和 A 的關閉通道（`d730422` 的 `services/launcherControl.js`：停止認領 → `server.close()` → 等在途工作到寬限時間 → 關 `pool` → 結束）是同一套想法；B1 要沿用同一份程式，只是 B 多了第 5、6 步，以及「放棄」這個選項。
- **開機自動啟動**：預設關閉，可以在設定裡用 `app.setLoginItemSettings` 打開（〔查證 S15〕）。
- **日誌**：桌面版沒有伺服器視窗，所以把後端的 stdout 和 stderr 寫到 `%LOCALAPPDATA%\TutorExamBank\logs\server-YYYYMMDD.log`，保留 14 天。現在印在伺服器視窗、要使用者採取行動的訊息，改成在狀態畫面或系統匣通知顯示。例子有兩個：「請先 `npm run migrate`」（`local-mode.md` 10.12 第 2 小節第 1 點、10.17），以及舊範本門檻的提醒（`workers/jobRunner.js:1825-1827`）。A 的 `/api/health` 已經會回報 migration 版本（`d730422` 的 `utils/migrationStatus.js`），狀態畫面直接用它。

### 2.9 打包重點（B3）

- 用 electron-builder 的 NSIS target，選 per-user 安裝，不需要系統管理員權限。這兩項都是預設：`oneClick: true`、`perMachine: false`（〔查證 S7〕）。
- `deleteAppDataOnUninstall` 維持預設的 false，解除安裝時不刪資料（〔查證 S7〕）。
- asar 開著，但下面這些要解開放在外面：
  - `**/node_modules/sharp/**` 和 `**/node_modules/@img/**`：sharp 官方指示（〔查證 S9〕）。
  - `**/node_modules/@node-rs/**`、`**/node_modules/mupdf/**`、`exam_pro/ocr_service/**`：〔推論〕，要在 B3 實測。
  - `exam_pro/scripts/windows/setup_local_ai.bat` 與 `exam_pro/eval/tools/tee_run.js`：cmd 不能 `cd` 進 asar，外部的 node 也讀不到 asar（〔查證 S49〕：外部程式要讀的檔只能用 unpack 放在 `app.asar.unpacked`）。
- **維護工具怎麼在安裝版執行**（第 3 條第 21 項）：用 app 自己的 exe 加 `ELECTRON_RUN_AS_NODE=1` 當 node（VS Code 的 `code.cmd` 就是這樣做，〔查證 S47〕）。
  - 前提：Electron 的 `runAsNode` fuse 維持預設的開啟（〔查證 S48〕），打包時不要關掉它。
  - run-as-node 模式能不能讀 asar 裡的腳本，Electron 文件沒寫（〔查證 S49〕）〔要實測〕。VS Code 的 app 本身放在 `resources\app`，不在 asar 裡，所以不能拿它當證據。讀不到的話，就把 `exam_pro` 整個改放在 asar 外面（`extraResources`），代價是檔案數多、安裝與防毒掃描較慢，約 +2～4h（不在合計內）。
- PostgreSQL 的二進位檔用 `extraResources` 放。
- 打包前先跑一支 staging 腳本：從 `git ls-files` 取出 `exam_pro` 會用到的檔案，排除 `eval/`、`test/`、`docs/` 和 cassette（例外：`eval/tools/tee_run.js` 要留給 `setup_local_ai.bat`，2.7 節），然後在 Windows 上執行 `npm ci --omit=dev`，最後才交給 electron-builder。
- 大小估計〔未查證，B3 實測〕：Electron 本體的 zip 是 158 MB（〔查證 S36〕）；本 worktree 用 `npm ci` 裝完的 `node_modules` 是 193 MB（Linux 版，Windows 版的平台二進位不同），其中只供開發用的相依套件很少（nodemon、pdfkit、supertest）；PostgreSQL 16 的 EDB zip 連 pgAdmin 在內約 330 MB（〔查證 S18c〕，16.1 的數字），只取執行必要的部分估計數十 MB 到一百多 MB〔推論〕。安裝檔壓縮後估計 **150～250 MB**，遠低於 NSIS 的 2 GB 上限（〔查證 S8〕：超過時 electron-builder 不會報錯，只會產生壞掉的安裝檔）。

---

## 3. 要改的地方（逐檔盤點）

工時以小時（h）計，包含對應的單元測試，由 Claude 協作開發估計，不含 Owner 操作的時間。「期別」欄指在哪一期改。**預設不變**的意思是：新的環境變數沒寫時，行為和現在逐字相同，CI、現有測試、`npm start` 都不受影響。

| # | 檔案／位置 | 現況 | 改法 | 期別 | 工時 |
|---|---|---|---|---|---|
| 1 | `exam_pro/server.js`（基底 16 行；A 的 `d730422` 已改成留下 `server`、`runner` 並交給 `launcherControl`） | 載入時就 `dotenv.config()`、`app.listen(PORT)`（綁所有網路介面）。〔DA-11 定案，`dec/r7-decisions-host`〕改成 `app.listen(PORT, HOST)`、`HOST` 預設 `127.0.0.1` | 照 2.3 節匯出 `startServer()`；`require.main === module` 時保留原本的行為。**在 A 合併之後的版本上改** | B1 | 3h |
| 2 | `workers/jobRunner.js`（`stop()` 在 `:1833-1835`、`invokeNode` 在 `:825-887`、拆題迴圈 `runExtractChunk` 在 `:1336-1427`、變式 `runGenerateJob`／`runGenerateOne` 在 `:1513-1672`、租約釋放在 `:1265-1269`） | `stop()` 只清計時器；每個節點雖然有自己的 AbortController，但被 abort 會記成 `timeout`、吃掉重試次數；拆題與變式的迴圈還會立刻重試 | 新增 `shutdown({ abandon, waitMs })`：先標記正在關閉，再 abort 在途節點；被這樣中止的節點**不寫 outcome、不動 `retries`、不寫 `job_events`、拆題與變式的迴圈不重試**，只放掉 `job_questions`／`jobs` 的 `locked_until`（2.3 節第 3、4 點）。題目層、拆題、變式三種工作單位都要走這條路。單元與整合測試要逐一釘住三種單位：「shutdown 中止後 `retries` 不變、沒有新的 `job_events`、job 不會變 `failed`、`locked_until` 已清空」 | B1 | 10h |
| 3 | `app.js:31-43` 的 CORS（`ALLOWED_ORIGINS`，預設 `http://localhost:3000`） | 瀏覽器對同源請求，只要方法不是 GET 或 HEAD 就會帶 `Origin` 標頭（〔查證 S42〕）。來源不在清單時 `cors()` 丟錯，結果是 500。視窗如果載入 `http://127.0.0.1:<埠>`，每一個 POST 都會失敗〔推論〕（今天在瀏覽器打開 `http://127.0.0.1:3000` 應該也是同樣情形） | 由桌面版在執行期把 `http://127.0.0.1:<埠>,http://localhost:<埠>` 設進 `ALLOWED_ORIGINS`；程式不改，網頁版預設不變。B1 驗收要實際測一次上傳和組卷的 POST | B1 | 1h |
| 4 | `middleware/auth.js` 與 `app.js:122-153` 的 `serveIndex` 金鑰注入 | 沒設 `API_KEY` 就不檢查；設了就注入首頁，所以任何能打開首頁的人都拿得到金鑰（`roadmap-plan.md` 擱置區第 8 項：它不是存取控制） | 桌面版在第一次啟動時產生一組隨機金鑰存進設定，每次啟動時設進 `API_KEY`。本機其他程式要打 API 就得先讀首頁，門檻稍微提高。後端只綁 127.0.0.1，所以區網碰不到。程式不改。~~區網模式另外處理（DA-11）~~〔DA-11 選 1，定案〕桌面版不做區網模式；要用平板時開網頁版並設 `HOST=0.0.0.0`（`exam_pro/README.md`「區網存取」），或走 Tailscale | B1 | 1h |
| 5 | Word 下載（`public/index.html:1888-1917`、`public/js/remedial.js:976-990`、`public/js/retrain.js:989-1000`，都是 Blob 加 `<a download>`） | 在瀏覽器裡直接下載到「下載」資料夾 | 前端不改。Electron 沒有指定存檔路徑時，會照一般流程處理，通常是跳出「另存新檔」對話框（〔查證 S14〕）。主行程在 `will-download` 用 `setSaveDialogOptions` 把預設資料夾設為「文件\出卷」，並記住上次用的資料夾。B1 驗收要確認對話框預填的檔名就是前端 `download` 屬性給的檔名（例如「XX 段考（學生版）.docx」）〔要實測〕 | B1 | 3h |
| 6 | 家教的「按住說話」麥克風（`public/js/tutor.js:157-168`、`:300-315`、`:496`） | 只在安全來源（localhost 或 HTTPS）才顯示按鈕 | `http://127.0.0.1` 在 Chromium 裡屬於安全來源，`isSecureContext` 為真，前端不改〔推論〕。Electron 預設會**自動核准所有權限請求**（〔查證 S12〕），所以要用 `setPermissionRequestHandler`／`setPermissionCheckHandler` 只放行「自己的來源、`media`、audio」，其他一律拒絕（〔查證 S13〕）。Windows 的「隱私權 → 麥克風 → 允許桌面應用程式存取」要打開。**注意**：語音路由只在 `MODEL_VOICE` 是 Gemini 時才掛上（`app.js` 的 `VOICE_ROUTE`），本機模式本來就不提供語音 | B1 | 2h |
| 7 | `desktop/`（新增） | 不存在 | `main.js`（單一實例、視窗、系統匣、關閉行為、狀態畫面、日誌）、`lib/backendHost.js`（utilityProcess，DA-3 定案：`utilityProcess.fork`）、`lib/config.js`（讀 `.env` 加執行期的值）、`lib/health.js`（Ollama、Docker、OCR）。**B1 期間**仍要用 Docker 的庫，Docker Desktop 的啟動和 `docker compose up -d --wait` 沿用 A 的邏輯（第 6.1 節：A 的 `plan.js` 是純函式，可以直接 `require`；如果 A 合併時它還在，本項約可省 4h） | B1 | 26h |
| 8 | `desktop/` 的測試 | 無 | 純函式（埠、設定合併、來源清單、結束順序的狀態機）用 `node --test` 測，不需要 Electron。**先只在本機跑**；要進 CI 得改 `ci.yml`，要 Owner 同意 | B1 | 6h |
| 9 | `exam_pro/config/paths.js`（新增） | 路徑散在各檔，而且各自以 `__dirname` 或目前工作目錄為基準 | 集中成單一來源：`APP_DATA_DIR`（沒寫時等於 `exam_pro/`，也就是預設不變）→ `dataDir()`、`uploadsDir()`、`figuresDir()`、`jobsDir()`、`backupsDir()`。資料夾結構刻意保留 `data/`，所以 `APP_DATA_DIR\data\jobs\<id>.pdf` 和資料庫裡存的相對路徑 `data/jobs/<id>.pdf` 對得上，**不必改資料庫** | B2 | 4h |
| 10 | `app.js:9-27`（uploads）、`routes/index.js:7-10`（multer 的 `dest: 'uploads/'`） | 建目錄和 multer 用的是**目前工作目錄**，開機清理用的卻是 `__dirname/uploads`，兩者不一致。現在沒出事，只是因為 `npm start` 剛好在 `exam_pro` 執行 | 三處都改用 `paths.uploadsDir()` | B2 | 2h |
| 11 | `app.js:177-179`、`services/figureService.js:16`（`wordService.js:6`、`scripts/backfill_figures.js:1074` 都沿用它的 `FIGURES_DIR`） | 固定是 `exam_pro/data/figures` | 改用 `paths.figuresDir()`，沿用的地方自然跟著改。資料庫的 `question_img` 存的是網址 `/figures/<檔名>`，不必改 | B2 | 1h |
| 12 | `controllers/jobController.js:27-31`、`workers/jobRunner.js:43-49`（`resolveJobPath`） | PDF 存在 `exam_pro/data/jobs`，相對路徑以 `exam_pro/` 為基準解析。拆題完成後 worker 會刪檔、把 `jobs.pdf_path` 清成 NULL（根目錄 `.gitignore` 的說明），所以這裡平常只有排隊中或拆到一半的 PDF | 相對路徑改以 `APP_DATA_DIR` 為基準；絕對路徑照舊。測試裡有 7 個檔（18 處，都在 integration、e2e 與假 agent）假設 `APP_DIR/data/jobs`，因為預設不變所以都不用改；另外加一則 `APP_DATA_DIR` 指向暫存目錄的測試 | B2 | 3h |
| 13 | `.env` 的讀取：`server.js:1`、`migrate.js:12`、`scripts/` 底下 15 支、根目錄的 `audit_formulas.js`／`fix_formulas.js`／`seed_questions.js` 等，都用不帶路徑的 `dotenv.config()` 讀**目前工作目錄**的 `.env`；`services/ocr/cli.js:37` 則固定讀 `exam_pro/.env` | 全部依賴「在 `exam_pro` 資料夾執行」 | 桌面版：主行程用 `dotenv.parse` 讀 `%APPDATA%\TutorExamBank\.env`（〔DA-1、DA-8 定案〕Gemini 金鑰照舊明文寫在這一份），疊上執行期的值（`PORT`、`DATABASE_URL`、`ALLOWED_ORIGINS`、`API_KEY`、`APP_DATA_DIR`、`OCR_PYTHON`）後，傳給後端行程的 `env`。桌面版的 `.env` 由 `.env.example` **全量產生**（每個鍵都寫出來，空值也寫），減少「桌面版沒寫、repo 的 `.env` 有寫」的鍵被 dotenv 補進來的機會（dotenv 預設不覆寫已經存在的變數；第 21 項）。命令列腳本不改，從維護命令列（第 21 項）執行。**要檢查兩個預設值**：`LLM_MODE` 沒寫時是 `replay`（`services/llm/index.js:101`），`EMBED_MODE` 沒寫時是 `fixture`（`:92-97`，會讀 `eval/fixtures`）。安裝版不帶 `eval/`，所以桌面版的設定缺 `LLM_MODE=live` 或 `EMBED_MODE=live` 時都要擋下並說明，不能靜靜地跑成回放或 fixture 模式 | B2 | 4h |
| 14 | `services/ocr/index.js:39-42`（`OCR_DIR = APP_DIR/ocr_service`）與 `:105-126`（預設的 python） | 腳本放在程式資料夾裡；打包後會在 asar 裡，外部的 python 讀不到 | `ocr_service/**` 解開放在 asar 外面；`SCRIPT_PATH` 在打包環境指向 `app.asar.unpacked`。`OCR_PYTHON` 由桌面版設定：U1 期間沿用 repo 的 venv，B3 才指向新建的 `ocr-venv`（2.7 節）。`requirements.txt` 用來當 cassette 鍵的版本來源，在 asar 外面照樣讀得到 | B2 | 3h |
| 15 | `scripts/windows/setup_local_ai.bat:22-31`（另外 `:46-48` 要求 `node` 在 `PATH`、用 `eval\tools\tee_run.js` 寫 log） | venv 固定建在 `exam_pro\ocr_service\.venv`，log 寫在 `exam_pro\data\local_ai` | 新增可選的環境變數 `SETUP_VENV_DIR`、`SETUP_LOG_DIR`，沒設時完全照舊。B3 的首次啟動精靈帶這兩個變數去呼叫它：這支 `.bat` 與 `tee_run.js` 要解開放在 asar 外面，`node` 用 Owner 電腦上已經裝好的 Node，不能用 `node.cmd` 墊片（2.7、2.9 節）。U1 期間 venv 留在 repo，所以這一項從 B2 移到 B3 | B3 | 4h |
| 16 | `scripts/windows/record_local.bat` | 用 Docker 的 5433 測試庫（`TEST_DATABASE_URL`）與 repo 裡的 `node_modules`。但它的第 1 步 `npm run db:up`（`:49-53`）就是 `docker compose up -d --wait`，會把 5442 的正式庫 `postgres` 服務一起啟動；`:44` 還要求 `exam_pro\.env` 存在 | **不改**（原則）。D2 之前和今天一樣。**D2 之後要靠第 23 項**，讓 `db:up` 不再帶起舊的正式庫。沒有第 23 項的話（第一版正式稿寫「互不干擾」，不成立）：<br>① app 開著時，5442 已經被原生庫占用，舊庫起不來，`db:up` 失敗就中止錄製（`:124-126`）。兩個行程能不能同時聽 `127.0.0.1:5442`，在 Windows 上〔要實測〕；README 記過 5432 上「先啟動的那個吃掉連線」的情形，那更糟。<br>② app 沒開時，舊庫在 5442 復活。之後網頁版、維護工具、`啟動資料庫.bat` 的 migrate 都會寫進舊庫，變成兩份分歧的正式庫（R-19）。<br>有了第 23 項，錄製只碰 5433，才和桌面版互不干擾 | — | 0 |
| 17 | `.github/workflows/ci.yml` | 兩個 job：unit 與 integration（加上 e2e 和 eval） | **不改**。第 9～14 項新增的單元測試放在 `exam_pro/test/unit/`，自然會在現有的 unit job 裡跑 | — | 0 |
| 18 | 資料搬遷工具（新增，`desktop/scripts/migrate-data.js` 或 `exam_pro/scripts/`） | 無 | 把 `exam_pro\data\figures`、`data\jobs`、`backups\` 複製到新位置：先試跑列出清單，逐檔比對 sha256 後才算完成，舊檔**不刪**（等 Owner 自己確認）。資料庫不必改（第 9 項） | B2 | 6h |
| 19 | `scripts/backup.js:38`（預設 `exam_pro/backups`）與 `:63-90`（借容器裡的 `pg_dump`） | 只會用 Docker；附圖目錄沒有備份（擱置區第 6 項）。docker 模式**完全不看 `DATABASE_URL` 的主機與埠**（`:80-86` 只用使用者與庫名），一律 `docker compose exec postgres pg_dump` | ① 新增原生模式：設了 `PG_BIN`，或 `BACKUP_MODE=native`／`auto`，就用 `<PG_BIN>\pg_dump.exe -Fc --no-owner --no-acl`，檔頭一樣驗 `PGDMP`。預設仍是 docker，行為不變；**D2 切換時桌面版與 repo 的 `.env` 都設 `BACKUP_MODE=native`**（4.2 節第 6 步）。<br>② **docker 模式加一道檢查**：先用 `DATABASE_URL` 連線查 `SELECT system_identifier FROM pg_control_system()`，再用 `docker compose exec -T <服務> psql -tAc` 查容器裡的同一個值，兩者不同就拒絕備份、寫 `LAST_FAILED.txt`。否則 D2 之後只要舊容器在跑、`BACKUP_MODE` 沒設，`備份資料庫.bat` 就會把舊庫備份下來並記成 OK。只比埠不夠：原生庫沿用 5442，和舊容器對外的埠一樣。<br>③ **順便把 `data/figures` 壓成同一個時間戳的 zip**，補上擱置區第 6 項的缺口。壓縮用 Windows 內建的 `tar.exe`（bsdtar，Windows 10 build 17063 起內建；`tar -a -cf <檔>.zip -C <figures> .` 依副檔名產生 zip，〔查證 S50〕），Windows 版實際產出的 zip〔要實測〕，不行就退回 PowerShell 的 `Compress-Archive`。不直接用 `docx` 間接帶進來的 `jszip`（沒有列在 `package.json`，`docx` 換版就可能消失），也不新增相依（會改 lock 檔）。<br>④ 匯出 `runBackup()` 給 app 呼叫。`log`／`LAST_FAILED.txt` 的規則不變 | D2 | 9～10h |
| 20 | `migrate.js`（全檔 73 行，CLI 用 `process.exit`） | 只能從命令列執行 | 抽出 `runMigrations({ connectionString, log }) → { applied, pending }`，CLI 外殼照舊。app 啟動時如果有待套的 migration，依序做：自動備份 → 快照 → 套用 → 快照 → 比對（第 5.3 節），不一致就停下並保留備份 | D2 | 6h |
| 21 | 命令列維護工具（`backfill_*`、`kc:load`、`report:jobs`、`chapters:migrate`、公式健檢三支等，會寫 `data/` 底下）；`exam_pro` 根目錄的 `回填向量.bat`、`執行公式健檢.bat`、`預覽公式修正.bat`、`套用公式修正.bat`，以及 `scripts/windows/backfill_figures.bat` | 在 `exam_pro` 用 `npm run …` 或雙擊 `.bat` 執行，資料庫由 Docker 常駐 | 系統匣選單加「維護命令列」：開一個 cmd，做到三件事。<br>① **怎麼執行**：安裝版的 `exam_pro` 在 `app.asar` 裡，cmd 不能 `cd` 進去，系統的 node 讀不到 asar，安裝版也沒有 npm，所以第一版正式稿「工作目錄是 `resources` 裡的 `exam_pro`」行不通。改成提供兩支小檔：`tutor-node.cmd` 照 VS Code 的 `code.cmd` 做法（〔查證 S47〕），`set ELECTRON_RUN_AS_NODE=1` 後用 app 自己的 exe 執行腳本；`tool.cmd <npm script 名稱>` 從 `exam_pro/package.json` 的 `scripts` 取出 `node <檔>` 形式的指令來跑，舊的 `npm run backfill:figures` 改打 `tool backfill:figures`。前提與未知見 2.9 節（`runAsNode` fuse 要開著；run-as-node 讀不讀得到 asar〔要實測〕）。上面那幾支 `.bat` 在安裝版不提供，改成 `tool` 的子命令。開發版（U1）也走 `tutor-node.cmd`，不依賴系統的 node。<br>② **設定只有一份**：cmd 的工作目錄設在桌面版 `.env` 所在的資料夾，讓不帶路徑的 `dotenv.config()` 讀到的就是它；另外把桌面版 `.env` 的全部鍵與執行期的值（`APP_DATA_DIR`、`DATABASE_URL`、PG16 的 `bin` 加進 `PATH`）注入環境變數。dotenv 預設不覆寫已經存在的變數，所以 repo 的 `.env` 補不進來（例外是 `services/ocr/cli.js` 固定讀 `exam_pro/.env`，它只能補桌面版沒寫的鍵，第 13 項的全量產生就是為了這個）。空值的鍵在 Windows 的環境區塊裡能不能保留〔要實測〕。開啟時比對 repo 的 `exam_pro\.env`，有桌面版沒有的鍵就列出警告。**不採用**「把 repo 的 `.env` 改名」：`record_local.bat` 找不到 `exam_pro\.env` 就停（`record_local.bat:44`），錄製還要用它。腳本本身都用 `__dirname` 找路徑，不依賴工作目錄。<br>③ 資料庫會一直開著，直到 app 結束 | B2 | 6～8h |
| 22 | `package.json:49-51`（`db:up`／`db:down`／`db:backup`） | `db:up`／`db:down` 呼叫 docker compose，`db:up` 會啟動 compose 裡的所有服務 | **不改**。但 D2 切換之後效果會變：第 23 項讓 `db:up`／`db:down` 只管 `postgres_test`，舊的 `postgres` 要指名才會動。Docker 路線（D1 回退、錄製、整合測試）照樣用。`db:backup` 照第 19 項，D2 之後設 `BACKUP_MODE=native` | — | 0 |
| 23 | `docker-compose.yml` | 5442 正式庫與 5433 測試庫，`docker compose up` 兩個都會啟動；`postgres` 設了 `restart: unless-stopped` | `postgres_test` 不改。`postgres` 服務加 `profiles: ["prod"]`，**同一次變更**在 repo 的 `exam_pro\.env` 加一行 `COMPOSE_PROFILES=prod`（還有 `.env.example` 與 README 的說明）。Compose 會從專案資料夾的 `.env` 讀這類預先定義的變數（〔查證 S46〕），所以合併之後、切換之前，`docker compose up` 的行為不變；A 與 B1 代開 Docker 的邏輯也不受影響。D2 第 6 步刪掉這一行，之後 `docker compose up`（`db:up`、`record_local.bat`、`啟動資料庫.bat`、A 與 app 代開 Docker 的邏輯）就只啟動測試庫。明確指定服務名（`docker compose start postgres`）時不受 profile 限制（〔查證 S46〕），回退時用得到。CI 用 `services:`、不用 compose，不受影響。**要實測**：從 `.env` 讀 `COMPOSE_PROFILES` 的行為，文件只寫了「`.env` 可以設預先定義的變數」，沒有逐項寫明（4.2 節第 0 步驗）。<br>**為什麼不能只加 profile、要配那一行**（審查建議的首選少了這一步）：只加 profile 的話，compose 檔一合併，`db:up` 就不再啟動正式庫。這時還沒切換，B1、B2 的 app 與 A 仍在用 Docker 的正式庫，會全部連不上。要嘛像這裡用 `.env` 的一行控制，要嘛把 compose 的變更留到切換當天才合併。<br>**另一個做法**是原生庫改用新的埠（例如 5462），並改 `.env` 的 `DATABASE_URL`，compose 不動。不採用，理由有二：舊庫每次 `db:up` 都會復活，整天的錄製期間白吃記憶體；而且一直留著一個會被連錯的舊庫。第 19 項的檢查兩種做法都要 | D2 | 1h |
| 24 | `啟動資料庫.bat`、`備份資料庫.bat`、工作排程器的「題庫每日備份」（02:00） | 依賴 Docker；`啟動資料庫.bat` 在 `docker compose up -d --wait`（`:17`）之後接著對正式庫 `npm run migrate`（`:28`） | 網頁版照舊可以用。D2 之後：`啟動資料庫.bat` 先顯示「正式庫已改由 app 管理」，只啟動測試庫，**不再對正式庫跑 migrate**（正式庫的 migrate 走第 5.3 節的升級流程，要先備份與快照）；`備份資料庫.bat` 照第 19 項；排程改成 DA-4 的方案，~~建議~~〔DA-4 選 1，定案〕停用 02:00 那一個，改由 app 在每天第一次開啟時、結束前（有寫入時）和 migrate 前備份 | D2 | 3h |
| 25 | pgManager（新增，`desktop/lib/pgManager.js`） | 無 | 照 2.5 節處理 initdb、`pg_ctl` 啟停、健康檢查、`postgresql.conf`、埠的判斷；把 pgvector 的 `vector.dll`、`vector.control`、`vector--*.sql` 放進 `lib/` 與 `share/extension/`。第一次 initdb 後啟動成功時，把 `system_identifier` 與 `data_directory` 記進 `state.json`。另外提供命令列 `desktop/scripts/pg.js`（`init`／`start`／`stop`／`status`／`set-port`），D2 的演練與切換都用它（4.2 節），不手動 initdb。`pg_ctl` 的 stdio 用 `'ignore'` 或導到檔案，等 `'exit'`（2.5 節） | D2 | 14h |
| 26 | pgvector 的 Windows 二進位 | 無 | 照 DA-5 取得（〔選 2，定案〕另一支只能手動觸發的 GitHub Actions，在 Windows runner 對同版 EDB PG16 編 pgvector，產出 zip 與 SHA-256；`ci.yml` 不改）；只接受有 SHA256 和建置紀錄的檔案 | D2 | 4～12h |
| 27 | 通用快照比對腳本（新增，`scripts/snapshot_db.js`） | 只有 `scripts/snapshot_attempt_views.js`，專為 0016 前後的作答檢視設計 | 輸出第 4.3 節列的版本、列數、逐表雜湊、向量雜湊、索引、行為檢查；`--compare a.json b.json` 相同時回 0。D2 搬家與每次升級都用它 | D2 | 5h |
| 28 | 文件：`deployment_and_operations.md` §3、§6、`runbook-pg-down.md`、`exam_pro/README.md` 快速開始、`local-mode.md` 10.2 | 以 Docker 為前提 | 補上桌面版的啟動、備份、回退與疑難排解 | D2／B3 | 6h |
| 29 | 打包：staging 腳本、`electron-builder.yml`、圖示、捷徑、`tutor-node.cmd`／`tool.cmd`（第 21 項） | 無 | 照 2.9 節。`runAsNode` fuse 維持預設的開啟；`setup_local_ai.bat`、`tee_run.js` 解開放在 asar 外面 | B3 | 11h |
| 30 | 首次啟動精靈 | 無 | 偵測 repo 裡的舊資料時提議執行第 18 項；檢查 Ollama 和 OCR；沒有叢集時執行 initdb；D2 之前或之後各自的分支流程 | B3 | 6h |
| 31 | 升級流程 | 無 | app 版本變動時執行第 20 項的流程（第 5.3 節） | B3 | 2h |
| 32 | `.gitignore` | — | 加上 `desktop/dist/`、`desktop/out/`、staging 目錄 | B1 | 0.2h |
| 33 | 維護工具寫進程式資料夾的輸出：<br>・`scripts/backfill_figures.js:76`（`data/figure-backfill/`）<br>・`scripts/migrate_chapters.js:66`（`DEFAULT_OUT_DIR`，產出 `data/chapter-migration-<日期>.csv`）<br>・公式健檢三支：`執行公式健檢.bat`／`預覽公式修正.bat`／`套用公式修正.bat` 經 `scripts/formulas.js` 執行 `audit_formulas.js`、`fix_formulas.js`，把 `公式健檢報告.html`（`audit_formulas.js:111`）、`公式修正預覽.html`（`fix_formulas.js:127`），以及**套用修正前的資料備份** `formulas_backup_<時間>.json`（`fix_formulas.js:130-132`）寫進 `__dirname`，也就是 `exam_pro/` 本身<br>・`回填向量.bat` 執行的 `scripts/backfill_embeddings.js:102-105`，把失敗清單寫到 `eval/local/backfill_failed.json`<br>・`setup_local_ai.bat` 與 `record_local.bat` 的 `data\local_ai\`、`data\rerecord\`（Owner 手動放的量測 log 與 `.env` 備份） | 都以 `exam_pro/` 為基準 | 會被 Owner 從桌面版維護命令列執行的（前四項）都改用 `paths.dataDir()`。安裝版的程式資料夾更新時會整個替換，寫在那裡的檔會不見；在 asar 裡則根本寫不進去。其中 `formulas_backup_*.json` 是資料備份，最不能丟。`record_local.bat` 照原則不改（它只在 repo checkout 裡跑）；`data\local_ai\`、`data\rerecord\` 屬於 repo 的開發與錄製紀錄，不搬 | B2 | 3h |
| 34 | A 的啟動器寫的檔（`d730422`）：`data/launcher/config.json`、`data/launcher/server.json`（關閉捷徑讀的權杖）、`data/logs/server-<日期>.log` | 以 `exam_pro/` 為基準 | 桌面版不用 A 的 `server.json` 權杖（主行程直接握著後端）；`config.json` 的設定項目併進桌面版的 `settings.json`；日誌照 2.8 節寫到 `%LOCALAPPDATA%`。要在 A 合併後依它的實際檔名再核對一次 | B2 | 1h |
| 35 | `config/db.js:31`（`new Pool({ connectionString, max: 10 })`） | 連線沒有帶 `application_name`，從 `pg_stat_activity` 分不出是誰連進來 | 加上 `application_name`，預設 `'tutor-exam-bank'`；用的是 `config/db.js` 的後端與工具都會帶這個名稱。只多一個連線參數，查詢行為不變。app 開後端之前據此偵測有沒有別的後端連著同一個庫（2.8 節），取代第一版正式稿「看租約」的做法 | B1 | 1h |
| 36 | 拆題與變式的逐塊檢查點（DA-13；~~選 2 時才做，合計照建議算進去~~〔Owner 2026-09-27 選 2，定案〕要做，合計已算進去） | `runExtractJob` 每次從第 1 塊跑起（`workers/jobRunner.js:1311`），`runGenerateJob` 每次從第 1 題跑起（`:1540`） | **拆題**：跑每一塊之前，查這份 job 有沒有同一個頁碼範圍（`detail.page_range`）已經 `pass` 或 `skipped` 的 extract 事件，有就跳過。比對頁碼範圍，不比塊號，因為本機與 Gemini 模式的塊大小不同，換模式後切法會變。**變式**：`job_questions` 已經有那個 idx 的題就跳過。「失敗後按重試」（`POST /api/jobs/:id/retry`，`controllers/jobController.js:291`）也會跟著變成從沒完成的塊接著跑；既有整合測試對重試後事件數的斷言要逐一確認〔要查〕 | B1 | 5～7h |

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
| `record_local.bat` 與 CI | 16、17，都不改（16 要靠第 23 項才和 D2 互不干擾） |
| `docker-compose.yml` | 23（D2 切換時正式庫加 profile） |

**盤點時發現、和桌面版無關但值得知道的四件事**：

1. `npm start` 目前綁在**所有網路介面**（`server.js` 呼叫 `app.listen(PORT)` 時沒有指定 host），而且金鑰會注入首頁。資料庫早就只綁 127.0.0.1（`docker-compose.yml` 的 `ports` 註解），網頁伺服器還沒有。同一個 Wi-Fi 的其他裝置實際上打不打得開，還要看 Windows Defender 防火牆：`node.exe` 第一次監聽所有網路介面時，Windows 會跳出是否允許存取的對話框，當時的選擇決定了輸入規則〔要實測〕。要不要改列在 DA-11。〔DA-11 選 1，已改〕`server.js` 改聽 `HOST`、預設 `127.0.0.1`（`dec/r7-decisions-host`）；要區網存取時設 `HOST=0.0.0.0` 並照 `exam_pro/README.md`「區網存取」處理防火牆、`ALLOWED_ORIGINS` 與 `API_KEY`。
2. 第 10 項提到的 uploads 路徑不一致。
3. 關伺服器時如果讓在途節點被 abort，會被記成逾時、吃掉重試次數（2.3 節）。題目層、拆題、變式三種工作單位都一樣。今天的 `npm start` 關視窗是直接結束行程，不會踩到；但任何人之後要做「優雅關閉並中止」都要避開這個陷阱。
4. 當機或關掉 `npm start` 之後，拆題 job 會從第 1 塊整份重拆、變式 job 從第 1 題重來（2.3 節第 4 點）。今天就是這樣，DA-13 可以改善（〔定案〕選 2：要做，第 36 項）。

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
2. 準備好 PostgreSQL 16 和同版 pgvector（DA-5），用 `desktop/scripts/pg.js init --port 5452`（第 3 條第 25 項）建原生叢集。它會執行 initdb、寫 `postgresql.conf`，第一次啟動成功後把 `system_identifier` 與 `data_directory` 記進 `state.json`。**不要手動 initdb**：手動建的叢集沒有這筆紀錄，之後 app 會把它當成別人的叢集而報錯（2.5 節「埠」那一列）。~~locale 照 DA-12 的候選各建一個庫。~~〔DA-12 選 2，定案〕只建 ICU（`--locale-provider=icu`）的庫：`--icu-locale` 的候選各建一個，照 4.3 節最後一列比對後選定並記錄。
3. **演練**：
   1. 取最新一份 `npm run db:backup` 的 `.dump`，還原成 `tutor_exam_bank_rehearsal`。
   2. 用第 27 項的 `snapshot_db.js` 比對 Docker 庫和演練庫（4.3 節）。兩張快照要**在同一天、相隔不久時拍**（4.3 節最後一段）。
   3. 記下還原時間。
   4. 用網頁版指到演練庫（暫時把 `DATABASE_URL` 改到 5452），開題庫列表、找相似、自然語言查題、匯出一份 Word，確認附圖顯示正常。
   5. 演練完刪掉演練庫。

   擱置區第 6 項「備份還原演練」從來沒實跑過，這一步正好把它做掉。
4. **確認舊庫防護已就位**（第 3 條第 23 項）：合併 profile 那一版之後，確認 `exam_pro\.env` 有 `COMPOSE_PROFILES=prod` 時，`docker compose up -d --wait` 仍會啟動 `exam_pg`（`docker ps -a --filter name=exam_pg`），也就是切換前的行為沒變〔要實測〕。

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
3. 結束 app：從系統匣選「結束」。上一點確認過沒有工作，所以會直接結束（DA-2）；再到工作管理員確認 app 的後端行程已經不在，runner 跟著停。依 6.6 節，D2 在 B1、B2 之後，這時 Owner 平常用的是 app，不是 `npm start`（第一版正式稿還寫「關掉 `npm start` 的視窗」）。如果另外開著網頁版，也要關掉它的視窗。Docker 的舊庫這時還要用；如果 app 結束時把它一起停了，用 `docker compose start postgres` 開回來。

**第 2 步：備份**

1. 執行 docker 模式的備份（在 repo 的 `exam_pro` 執行 `npm run db:backup`），確認備份資料夾的 `backup.log` 最後一行是 `OK`，而且有複製到 OneDrive。B2 之後備份在 DA-1 選的位置。
2. 把 `data\figures` 另外壓一份 zip。D2 不會動到檔案，這一步只是保險。

**第 3 步：快照 A**

在 Docker 庫跑兩支快照：

```
node scripts/snapshot_db.js --out=before-d2.json
node scripts/snapshot_attempt_views.js --out=before-d2-attempts.json
```

第 3 步和第 5 步的快照要在**同一天、相隔不久**時拍（4.3 節最後一段）：`snapshot_attempt_views.js` 的弱點查詢以 `CURRENT_DATE` 往前算 90／365 天，跨過午夜就會出現假差異。

**第 4 步：還原到原生庫（5452）**

```
createdb -h 127.0.0.1 -p 5452 -U exam -T template0 -E UTF8 --locale-provider=icu --icu-locale=<演練選定的值> tutor_exam_bank
pg_restore -h 127.0.0.1 -p 5452 -U exam --no-owner --no-acl -d tutor_exam_bank <第 2 步的 .dump>
```

全程用 PG16 的**絕對路徑**執行。現在 `PATH` 裡沒有 PG 工具（1.3 節），但這台電腦裝了 PG17 的服務，之後如果有人把 PG17 的 `bin` 加進 `PATH`，不小心用到的話，`pg_restore` 雖然讀得了 16 的 dump，但這不是我們要的版本組合。

**第 5 步：快照 B 與比對**

1. 把 `DATABASE_URL` 指到 5452，對原生庫跑同樣兩支快照，輸出 `after-d2*.json`。
2. 用 `--compare` 比對，要相同（判讀方式見 4.3 節）。
3. 用 `node migrate.js status` 確認兩邊的 migration 狀態相同。

**第 6 步：切換**

1. **先讓 `docker compose up` 不再帶起舊庫**（第 3 條第 23 項、R-19）：刪掉 repo 裡 `exam_pro\.env` 的 `COMPOSE_PROFILES=prod` 這一行，再停掉 Docker 的 `postgres` 服務（`docker compose stop postgres`，**不要用 `down -v`**）。
2. 用 `desktop/scripts/pg.js set-port 5442` 把原生庫的埠改回 **5442** 並重新啟動，pgManager 的紀錄跟著更新。
3. 設定改成原生模式：桌面版設 `DB_MODE=native`、`BACKUP_MODE=native`、`PG_BIN`；repo 的 `exam_pro\.env` 也設 `BACKUP_MODE=native` 與 `PG_BIN`（給 `備份資料庫.bat` 與網頁版後門）。`DATABASE_URL` 不必改，還是 5442。
4. **驗證防護**：
   - 執行一次 `npm run db:up`，`docker ps -a --filter name=exam_pg` 要顯示 `exam_pg` 是停止的，只有 `exam_pg_test` 在跑〔要實測〕。
   - 用 `BACKUP_MODE=docker` 執行一次備份，要被拒絕：舊容器沒在跑時是「服務沒有在執行」；硬把它開起來時，是第 19 項的 `system_identifier` 檢查擋下。
5. 開 app 做冒煙測試：題庫列表、找相似、組卷並下載 Word、學生分頁、弱點面板。

**第 7 步：收尾**

1. Docker Desktop 改成不隨開機啟動（DA-7 定案）。
2. 停用工作排程器的「題庫每日備份」，改由 app 備份（DA-4 定案）。
3. 確認 `啟動資料庫.bat` 已經是 D2 版（第 3 條第 24 項）：只啟動測試庫、不對正式庫跑 migrate。
4. 在 `HANDOFF.md` 記錄搬家時間與快照檔的位置。

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
| 作答檢視 | `snapshot_attempt_views.js --compare` | 應該相同。**例外**：弱點表在錯誤率與批改數都相同時，用章名、題型等欄位的預設排序規則排（`services/weaknessService.js:61` 的 `<分組欄> ASC`），而這支腳本沒有把弱點表重新排序（`:105-107`）。中文的排序規則不同時，同分的列順序可能不一樣（R-3）。這種差異要逐筆確認只是順序不同。學生本身依 `id` 排（`:99`），不受影響。**時間窗**：弱點查詢以 `CURRENT_DATE - days` 為起點（`services/weaknessService.js:34-36`，預設 90 與 365 天，`snapshot_attempt_views.js:103`），每週趨勢也跟著這個窗走，所以兩張快照要在同一天、相隔不久時拍，否則跨日會出現假差異 |
| 排序與三字組 | `SELECT string_agg(chapter, '|' ORDER BY chapter) FROM (SELECT DISTINCT chapter FROM questions) t`；`SELECT show_trgm('牛頓第二定律 f=ma')` | 用來挑 DA-12 的 locale（〔定案〕ICU；這一列改用來挑 `--icu-locale` 的值）。不同的話只記錄 |

### 4.4 回退方案

- **切換後還沒有新寫入**：
  1. 結束 app，原生庫跟著停。**順序不能反**：原生庫還在 5442 時就啟動舊庫，兩個行程會搶同一個埠。
  2. 在 repo 的 `exam_pro\.env` 加回 `COMPOSE_PROFILES=prod`，再執行 `docker compose start postgres`。指名服務時不受 profile 限制（〔查證 S46〕）；加回那一行，是為了讓之後的 `db:up`、A 或 app 代開 Docker 的邏輯照舊帶起它。Docker 的 volume 在第 6 步只是停用，資料原封不動。
  3. 設定改回 Docker 模式：桌面版 `DB_MODE=docker`；桌面版與 repo 的 `.env` 都拿掉 `BACKUP_MODE=native`。
  4. 原生庫的埠改回 5452（`pg.js set-port 5452`），或乾脆不啟動它。

  約 5 分鐘。
- **切換後已經有新寫入**（新題、批改、重練）：
  1. 先把原生庫 `pg_dump -Fc` 出來，再結束 app。
  2. 照上一點的第 2、3 步把舊庫開回來，在 Docker 庫 `dropdb` 再 `createdb`。
  3. 用 `pg_restore --no-owner --no-acl` 還原進去。
  4. 再跑一次 4.3 節的比對。

  同樣是 16 對 16，約 15～30 分鐘。
- 附圖和 PDF 都在磁碟上，D2 不會動到，回退時也不用處理。
- Docker 的 volume **至少保留 30 天**才能刪除（DA-7 定案），刪除前再做一次 dump 放進備份資料夾。

### 4.5 停機時間與時機

- 估計停機 **30～45 分鐘**，從第 1 步到第 6 步，多數時間花在比對和冒煙測試；dump 和還原本身以秒計〔推論〕。演練時量到的時間會取代這個估計。
- 時機（DA-10，〔Owner 2026-09-27 選 2，定案〕B2 完成、演練通過之後）：挑一個**沒有重錄、也沒有要上傳考卷**的空檔，例如週末早上。重錄跑一整天，而且吃 CPU 和記憶體，和搬家同時進行的話，量到的時間與比對都會失真，也增加出錯時要排查的變數。

---

## 5. 更新方式

### 5.1 三種做法的比較

| 做法 | 怎麼更新 | 優點 | 代價與限制 |
|---|---|---|---|
| U1：維持 git 加 bundle，從 repo 啟動 Electron | 照現在的方式更新 repo（git pull 或 bundle），`desktop/` 裡的 `npm ci` 跟著跑；桌面捷徑指向 repo 裡的 Electron | 不必打包，B1、B2 就能用；和開發流程完全一致 | Owner 的電腦要有 Node 和 npm（本來就有）；更新時要記得跑 `npm ci` |
| U2：手動安裝檔 | 在 Owner 的電腦上用 B3 的指令 build 出新的安裝檔，雙擊覆蓋安裝 | 程式和 repo 分開，新舊版本清楚；資料在 `%LOCALAPPDATA%`，不受影響 | 每次 build 要幾分鐘，還要在 Windows 上跑 `npm ci`（2.2 節）；本機 build 的檔案不帶網路標記，推論不會觸發 SmartScreen，但 **Smart App Control 不看網路標記**，它開著時未簽章的 exe 會被擋（DA-9） |
| U3：electron-updater 自動更新 | app 啟動時檢查 GitHub Releases，有新版就下載並安裝 | 最省事；NSIS target 支援自動更新（〔查證 S4〕） | **repo 是私有的**。從私有 repo 更新要在使用者電腦上設 `GH_TOKEN`，並打開 `private` 選項；官方文件說這個 token「絕不要寫進設定檔」（〔查證 S5〕）。舊版官方 wiki 說私有 repo 更新「只適用非常特殊的情況」，而且受 GitHub API 每小時 5000 次的限制，每次檢查最多用 3 次（〔查證 S6〕，這段在現行文件裡找不到，現況〔未查證〕）。也就是說，Owner 的電腦上要長期放一把能讀私有 repo 的 token。另一條路是自己架 generic HTTP 伺服器，但檔案要手動上傳（〔查證 S4〕），對一個人來說太重 |

建議（DA-6）：B1 到 D2 用 **U1**，B3 之後用 **U2**，**不做 U3**。

〔Owner 2026-09-27 DA-6 選 1，定案〕維持 git＋bundle，從 repo 啟動 Electron（**U1**）；不做 U3。建議裡「B3 之後改 U2」這一半，這次的答案沒有選：B3 開工前再問 Owner 一次（DA-6 的註記）。

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
4. **不要中止在途節點**：A 目前是寬限時間到了就直接結束，不會吃掉重試次數；以後誰要加「中止」都要照 2.3 節的做法。**A 的 `launcherControl.js` 檔頭要一起更正**：它寫逾時結束後「從那一格重跑」，只對題目層成立；拆題 job 會從第 1 塊整份重拆、變式 job 從第 1 題重來（2.3 節第 4 點）。A 合併前要改掉這句，DL-1 也要用正確的代價來討論。〔2026-09-27 已更正：`dec/desktop-launcher-fix2` 改成照工作單位說重跑點，`dec/r7-checkpoints`（DA-13）之後改成從中斷的那一塊接著拆、變式只補還沒建成的題。〕

A 的程式在合併前還可能改，以上以 `d730422` 為準，B1 開工時要再核對一次。

### 6.2 B1：殼加內嵌後端（仍用 Docker 的庫）——已實作（待 Owner 驗收）

> **狀態（2026-09-27，分支 `dec/r7-electron-b1`，基底 `dec/integration-r7` 的 `6757e25`）**：已實作，雲端（Linux）能驗的都驗過了，**Windows 上的行為待 Owner 照下面的驗收步驟確認**。依據：Owner 第六輪決策 DA-2＝3（看狀況）、DA-3＝2（`utilityProcess.fork`）、DA-6＝1（從 repo 啟動 Electron，U1）、DA-11＝1（桌面版只綁 127.0.0.1）；A 的 DL-1＝1（每次問）、DL-3＝1（結束時 Docker Desktop 與 Ollama 都不關，桌面版也一樣）、DL-4＝2（錄製中暫停背景工作）沿用 A 的設定。
> 原分支 `dec/r7-electron-b1` 有兩個 commit：`d9aac68` 是前一位實作者中斷時留下的進行中版本；接手的 `6017300` 檢查過整份、補完 README 與文件，並修了四件事（見本節最後「接手時的修正」）。審查後的修正版 `dec/r7-electron-b1-fix` 把這兩個 commit 壓成一個 `feat(desktop)` commit（內容與 `6017300` 相同；`d9aac68` 的 `wip` 類型與結尾格式不合 commit 規範），再加一個依審查修正的 commit（見本節最後「審查後的修正」）。
> 原本的規劃（範圍：第 1～8、32、35、36 項；約 58～60h）見本節最後「原規劃」。

**做了什麼、在哪裡**

| 項目 | 檔案 | 說明 |
|---|---|---|
| Electron 殼 | `desktop/`（`package.json`、`package-lock.json`、`main.js`、`backend-entry.js`、`lib/*.js`） | `electron` 只列在 `desktop/package.json` 的 devDependencies，鎖定 **44.4.5**（2.2 節）。`exam_pro` 的 `package.json`／lock 一個字都沒改，CI 的 `npm ci` 不會多下載 Electron。**Electron 44 起 `npm ci` 不會下載執行檔**（npm 套件沒有 postinstall，第一次執行才下載，2026-09-27 實測），所以一鍵腳本在 `npm ci` 之後另外執行 `node_modules\electron\install.js` |
| 可以呼叫的後端（第 1 項） | `exam_pro/startServer.js`（新） | `startServer({ port, host = '127.0.0.1' }) → { url, port, runner, status(), close({graceMs}) }`：不讀 `.env`；**聽到埠之後才啟動 runner**；關閉用 A 的 `launcherControl.createLifecycle`（同一份狀態機）。**`server.js` 沒有改**（`npm start` 逐位元不變）：同時進行中的 DA-11 分支要改 `server.js` 的綁定位址，兩邊不改同一支檔；之後要合成一份時，讓 `server.js` 的 `require.main` 分支呼叫 `startServer({ port: PORT, host: HOST })` 即可 |
| 後端子行程（DA-3＝2） | `desktop/backend-entry.js`、`desktop/lib/backendHost.js`、`desktop/lib/backendProtocol.js` | 主行程用 `utilityProcess.fork` 開 `backend-entry.js`（工作目錄 `exam_pro`），它呼叫 `startServer({ host: '127.0.0.1' })`。主行程與後端之間走 utilityProcess 的訊息通道（ready／status／shutdown），不開 A 的 HTTP 關閉通道、也不用權杖（子行程的環境拿掉 `LAUNCHER_CONTROL_TOKEN`）。後端的 stdout／stderr 寫進 `exam_pro\data\logs\desktop-server-日期.log` |
| 環境變數（第 3、13 項） | `desktop/lib/config.js` | 基底＝`exam_pro\.env` 的值被系統環境變數蓋過（與 `npm start` 相同，沿用 A 的 `effectiveEnv`；B1 仍用 repo 的 `.env`，搬到 `%APPDATA%` 是 B2／DA-8）；執行期疊上 `PORT`（主行程先挑一個 127.0.0.1 的空埠）與 `ALLOWED_ORIGINS=http://127.0.0.1:<埠>,http://localhost:<埠>`（同源 POST 才過得了 CORS）；錄製中而且設定要暫停時加 `JOB_RUNNER=off`（DL-4） |
| 啟動前的檢查（沿用 A） | `desktop/lib/startup.js`、`desktop/lib/statusUi.js`、`desktop/lib/wording.js` | 直接用 A 的 `plan.js`（決策）、`actions.js`（Docker／資料庫、Ollama、migration、錄製偵測）、`probes.js`、`statusServer.js`＋`status.html`（啟動畫面，顯示在同一個 Electron 視窗裡）。只換掉「後端怎麼開」那幾步；埠的檢查換成「主行程挑一個 127.0.0.1 的空埠」，被搶走時換埠重開（最多再 2 次）。健康檢查自己的後端一律問 `127.0.0.1`（`OWN_BACKEND_HOST`），不照 `.env` 的 `HOST`（DA-11 網頁版那一半合併後 A 的健康檢查會看 `HOST`）。A 的文字裡「再點一次『出題系統』圖示」「關閉出題系統」換成桌面版的說法（單元測試把 A 的每一種失敗與警告都跑一遍，確認沒有留下 A 專用的說法）。A 的啟動設定 `exam_pro\data\launcher\config.json` 兩邊共用 |
| 單一實例 | `desktop/main.js` | `app.requestSingleInstanceLock()`；第二次開啟只把原本的視窗叫到前面（縮在系統匣時也會叫回來） |
| 關閉行為（DA-2＝3） | `desktop/lib/decisions.js`（規則，純函式）、`desktop/main.js`（照做） | 見下方「關閉行為」 |
| Word 下載（第 5 項） | `desktop/lib/downloads.js` | `will-download` 不指定存檔路徑、只給 `setSaveDialogOptions`：第一次預設在「文件\出卷」（沒有就建立），之後記住上次存檔的資料夾；檔名用前端 `download` 屬性給的，Windows 不能用的字元換成「_」；`.docx` 列「Word 文件」 |
| 麥克風（第 6 項） | `desktop/lib/security.js` | `setPermissionRequestHandler`／`setPermissionCheckHandler` 只放行「自己的來源＋`media`＋只要聲音」，攝影機與其他權限一律拒絕（Electron 預設是全部核准）。另外：導覽只允許自己的來源，開新視窗一律拒絕，外部 http(s) 交給預設瀏覽器 |
| 執行期零外連（1.1 第 2 點） | `desktop/lib/security.js`、`desktop/main.js` | Chromium 預設會從 Google 的 CDN（`redirector.gvt1.com`）下載拼字字典，**視窗設了 `spellcheck:false`、session 關掉拼字檢查也照樣會連**（2026-09-27 在 Linux 實測）。session 關掉拼字檢查，並把字典的下載網址指到本機迴路上沒有人聽的埠（`http://127.0.0.1:9/`）。冒煙測試把 Chromium 的代理指到本機的陷阱，五個情境都驗「一筆往外的連線都沒有」 |
| 另一個後端的警告（第 35 項） | `exam_pro/config/db.js`、`desktop/lib/startup.js` | 連線池帶 `application_name: 'tutor-exam-bank'`（只多一個連線參數）。桌面版開後端之前查 `pg_stat_activity`（同一個庫、不算自己）有沒有這個名稱的連線，並對 `.env` 的 `PORT` 做健康檢查；有的話啟動畫面列一條注意事項（不擋） |
| 捷徑（DA-6＝1） | `exam_pro/scripts/windows/install_desktop_app.bat` | 雙擊：第一次在 `desktop` 執行 `npm ci` 並下載 Electron，再由 Electron 自己（`shell.writeShortcutLink`）在桌面建立「出題系統（桌面版）」：目標 `desktop\node_modules\electron\dist\electron.exe`、參數是 `desktop` 資料夾、帶 AppUserModelID `TutorExamBank.Desktop`（工作列分組與釘選對得上）。`--reinstall` 重裝 Electron（`desktop\package-lock.json` 有變時）；`--remove` 移除。A 的兩個捷徑與 `install_desktop_shortcut.bat` 不變 |
| 其他 | `.gitignore`（第 32 項） | 加上 `desktop/dist/`、`desktop/out/`、`desktop/staging/` |

B1 刻意**不搬任何資料**：記錄檔放 `exam_pro\data\logs\`（`desktop-日期.log`、`desktop-server-日期.log`，和 A 的放一起，保留 14 天；B2 一起搬）；Chromium 的設定檔（快取等）與 `desktop-state.json`（上次存檔的資料夾、視窗大小）放 `%LOCALAPPDATA%\TutorExamBank\electron`（DA-1＝2 的 Local 那一邊，路徑只有英數字）。

**關閉行為（DA-2＝3）**

- **按右上角 X**：
  - 還在啟動或啟動失敗 → 直接結束。
  - 問後端的在途工作數（launcherControl 的同一個數字）：**有工作 → 縮到系統匣繼續跑**，跳通知「出題系統仍在背景處理」；問不到（後端正忙，3 秒沒回）→ 同樣縮到系統匣（寧可多留，不要誤關長時間的工作）；**沒有工作 → 直接結束**（優雅關閉：停止認領 → 關 HTTP → 剛認領到的最多等 10 秒 → 關連線池）。
  - 縮到系統匣之後，在途工作歸零並**持續 10 秒**才算「處理完」（runner 每 2 秒認領一次，單題的下一步要等下一輪，只看一次歸零會在兩步之間誤判），跳通知「背景工作都處理完了」，**約 8 秒後自動結束**。〔實作時的解讀〕DA-2＝3 的「完成時再通知」之後沒有寫要不要結束；這裡照「沒工作直接結束」與設計稿「沒事時就該把後端關掉」的理由，視窗已經關了就當作要結束。期間點系統匣圖示或再開一次捷徑把視窗叫回來，就取消這個自動結束；通知跳出後那幾秒又認領到工作，也不結束、繼續等。
- **系統匣選「結束」**：沒有工作 → 直接結束。有工作（或問不到）→ 對話框「等處理完再結束／現在放棄／取消」：
  - **等處理完再結束**：不再認領新工作，等在途的做完（最多 6 小時，與 A 的「是」相同）；拆題是整份卷算一件，正在拆的卷會拆到完，排隊中的留到下次。**單題的檢查只做完正在跑的那一步**：jobRunner 的單題一次只跑一個節點（`runJobQuestion`），`runner.stop()` 之後不再認領，後面的步驟（例如 lint、驗算、入庫）下次開啟才接著做；剛拆出來或剛生成的題目也是下次開啟才開始檢查。對話框照這個寫（〔審查修正〕原本只講了拆題與排隊中的工作）。等的時候系統匣選單多一個「現在放棄」。
  - **現在放棄**：後端馬上結束，**不關連線池、不寫結果**——與當機、A 的「時限到了直接結束」同一條既有的路，不記成失敗、不動重試次數；租約（`JOB_LEASE_MS`，預設 3 分鐘；在途時每 30 秒續一次，所以從放棄那一刻算起最多約 3 分鐘）到期後重新認領，馬上重開的話要先等一下。重跑範圍照現行 `workers/jobRunner.js`：單題的檢查從中斷那一步接著做；整份卷的拆題、變式生成從頭再跑一次。對話框直接引用 A 的 `UNFINISHED_WORK_NOTE`（`exam_pro/scripts/desktop/lib/plan.js`），**DA-13 的逐塊檢查點（另一條分支 `dec/r7-checkpoints`）合併時，更新那一句，桌面版的對話框就跟著變**。
  - 設計稿 2.3 節第 4 點的 `shutdown({ abandon: true })`（abort 在途節點、立刻放掉租約，下次開啟不必等 3 分鐘）要改 `workers/jobRunner.js`，**不在這一版**：B1 的「放棄」走既有的直接結束，代價只是下次開啟要等租約到期。第 3 條第 2 項的單元與整合測試因此也還沒有。
- **後端異常結束**（不是桌面版要它結束的）：10 分鐘內第一次 → 通知並自動重開（畫面回到啟動畫面，換一個埠）；再一次 → 停下來，啟動畫面顯示「後端一直異常結束」與記錄檔最後幾行。視窗已經關掉（在系統匣等處理完）時不重開，直接結束並通知。
- **Windows 登出或關機**：不擋、不問，後端直接結束（與當機同一條路）。**只有 `session-end`（`WM_ENDSESSION`，確定要結束）才算**；`query-session-end`（`WM_QUERYENDSESSION`）只是問問看，可能被別的程式擋下或被使用者取消，而取消時 Electron 不會再發任何事件，所以只寫記錄檔、不改變關視窗的行為（`lib/decisions.js` 的 `sessionEndingAfter`）。〔審查修正〕原本 `query-session-end` 就把旗標設成「正在關機」而且不會復原：關機被取消後回來、有工作時按 X，會直接放棄在途工作，不縮到系統匣、不通知、不問。真的登出或關機時 Windows 不送 `WM_CLOSE`〔推論〕，所以不靠 `close` 事件判斷。
- 通知用系統匣氣球（`tray.displayBalloon`，Windows 10／11 會轉成通知）。**〔要實測〕不需要開始功能表捷徑就跳得出來**：主行程用 `app.setAppUserModelId('TutorExamBank.Desktop')` 設了 AppUserModelID，這個 AUMID 只登錄在桌面捷徑上（開始功能表沒有捷徑）；Windows 10／11 把 `Shell_NotifyIcon` 的氣球轉成通知時和 AUMID 怎麼互動，沒有查證〔未查證〕。驗收第 4 步是這件事的測試；看不到通知的話，DA-2＝3 的「縮到系統匣並通知」「處理完再通知」在 Windows 上就不成立，退路依序是：① 在開始功能表也建一個帶同一個 AUMID 的捷徑（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\`，一鍵腳本加一行），再測一次；② 還是不行，拿掉 `setAppUserModelId` 再測一次（代價：工作列分組、釘選可能和桌面捷徑對不上）。兩種都要改程式，由下一位實作者依驗收結果做。

**和原規劃的差異**

| 原規劃 | 這一版 | 理由 |
|---|---|---|
| 第 1 項：`server.js` 匯出 `startServer()` | 另開 `exam_pro/startServer.js`，`server.js` 不動 | 不和 DA-11（網頁版改用 `HOST`）的分支改同一支檔；兩邊共用 `app.js`、jobRunner、launcherControl、listenFailure |
| 第 2 項：jobRunner 的 `shutdown({ abandon })` | 沒做；「放棄」走既有的直接結束 | 任務要求「依現行 jobRunner 的行為」寫重跑範圍；jobRunner 同時被 DA-13 的分支改。差別只有下次開啟要等租約（約 3 分鐘） |
| 第 4 項：桌面版自動產生 `API_KEY` | 沒做；照 `.env` 的 `API_KEY`（沒設就不檢查，與現在相同） | 後端只綁 127.0.0.1、埠每次不同，區網碰不到；自動產生金鑰改變的是 `/api` 的行為，留給 B2 和設定檔一起做 |
| 第 36 項：逐塊檢查點（DA-13） | 不在這條分支 | 另一條分支 `dec/r7-checkpoints` |
| 後端的埠 | 每次開啟由主行程挑一個 127.0.0.1 的空埠 | 和同時開著的網頁版（3000）不會搶；前端沒用 `localStorage`，換埠不掉資料（2.4 節） |
| 記錄檔在 `%LOCALAPPDATA%\…\logs`（2.8 節） | B1 放 `exam_pro\data\logs\desktop-*.log` | 搬路徑是 B2（第 34 項），和 A 的記錄檔一起搬 |
| 系統匣選單的立即備份、OCR 自我檢查、維護命令列（2.8 節） | 只有：開啟、狀態、開啟記錄檔／資料／備份資料夾、結束（等處理完時多「現在放棄」） | 立即備份是 D2（第 19 項）、維護命令列是 B2（第 21 項）；OCR 自我檢查要 121 秒，B1 先不放 |

**自動化驗收（雲端，2026-09-27，接手後在最終版本上重跑；審查修正版 `dec/r7-electron-b1-fix` 再重跑一次，除了 e2e 都照做）**

- `exam_pro`：`npm test` 4,055 則，4,053 過、2 略過、0 失敗（略過的兩則是基底就有的「回放檔還沒錄」）。新增 `test/unit/desktopStartServer.test.js`：`startServer({port:0})` 回傳實際的埠且連得上、只綁 127.0.0.1；`close()` 後 runner 已停、埠已放掉、連線池已關；`close({graceMs:0})` 在途還在時不關連線池直接結束；聽不了埠時 reject 而且不啟動 runner；`config/db.js` 的 `application_name`。`npm run check:html` 全綠。
- `desktop`：`npm test`（`node --test`，不需要 Electron）120 則全過（審查修正前 115 則）：關閉／系統匣／第二次開啟／異常結束的規則、權限與導覽、拼字字典不外連、下載的預設值、環境變數、A 的文字換成桌面版說法、主行程↔後端的訊息（假的 utilityProcess）、啟動流程（真的 A 的 plan＋假的 I/O）、一鍵腳本的格式。**不在 CI**：要進 CI 得改 `ci.yml`，要 Owner 同意（第 3 條第 8 項）。
- `desktop`：`npm run smoke`——在 Linux 的 xvfb 上跑**真的 Electron 44.4.5**（utilityProcess 裡是 Node 24.21.0），五個情境 54 項全過（審查修正前 53 項）：
  - basic：啟動畫面轉到 `http://127.0.0.1:<埠>/`、同源 POST 沒被 CORS 擋、健康檢查 ok、**utilityProcess 裡載得起後端的 `sharp`、`@node-rs/jieba`、`mupdf`**（`test/smoke/native-probe.js`：sharp 產生並讀回 PNG、jieba 切出「二次函數／圖形／頂點」、mupdf 打開自製樣卷；Linux 版二進位，R-6 的 Windows 版在驗收第 4 步）、權限（麥克風 granted，攝影機／定位／通知 denied；假裝置下攝影機 NotAllowedError、麥克風拿得到）、Blob 下載走 `will-download`（中文檔名、「文件/出卷」、Word 文件）、導覽到 `file:` 與本機別的埠被擋、`window.open` 不開視窗、第二個實例結束並叫出第一個、沒有工作時關視窗就結束。
  - busy：有 2 件在途時先假裝一次被取消的關機（只送 `query-session-end`）→ 關視窗 → 仍縮到系統匣＋通知 → 歸零 10 秒後「處理完了」→ 約 8 秒後結束。
  - wait／abandon：系統匣「結束」→ 對話框（三個按鈕、A 的重跑範圍那一句、租約）→ 等處理完／現在放棄都正常結束。
  - crash：後端被殺 → 自動重開（換埠）→ 再被殺 → 顯示「後端一直異常結束」。
  - 每個情境都驗：沒有殘留的後端子行程；Chromium 一筆往外的連線都沒有（外連陷阱）。
  - 另外驗過：`.env` 的 `PORT` 上開著網頁版（另一個 `node server.js`）時啟動，注意事項有「另一個後端」那一條（`other-backend`）。
- 整合測試：本機 5433 的全新 UTF8 庫（照 `ci.yml` integration job 的環境變數）`npm run test:integration` 629 則全過。同一個庫接著跑 e2e：12 則 9 過 3 失敗，三則都是 **replay miss**（`agent=extract_ocr`：自製樣卷的 OCR 拆題回放檔在基底 `6757e25` 本來就沒有，單元測試的回放那兩則也因此略過；Owner 正在重錄），與這條分支無關（這條分支沒有改模板、schema、prompt 或 cacheKeyParts）。五個 eval 沒有跑（這條分支沒有碰 agent 與回放檔）。
- **和同一輪其他分支的相容**：在暫存的 worktree 把這條分支和 `dec/r7-decisions-host`（DA-11 網頁版改聽 `HOST`、DL-4 預設改 `pause`）、`dec/r7-checkpoints-fix`（`10f7acd`，DA-13 的檢查點）合在一起（只有那兩條之間的 `docs/desktop-launcher.md` 有衝突，與本分支無關），`desktop` 的 `npm test`、`exam_pro` 的 `desktop*`／`listenHost` 單元測試（270 則）、冒煙測試都全過。為此：對話框的重跑範圍只引用 A 的 `UNFINISHED_WORK_NOTE`、測試不寫死「從頭再跑一次」；`desktopStartServer.test.js` 對 `server.js` 的檢查同時接受 `app.listen(PORT, …)` 與 `app.listen(PORT, HOST, …)`。
- 冒煙測試發現的兩件 Linux 專屬的事：① Linux 的 Chromium 用 locale 的編碼當檔名編碼，**C locale 下中文的下載檔名會退回「download」**（改成 UTF-8 locale 就正常）。Windows 的路徑是 UTF-16，應該不受影響〔推論〕，列在驗收第 3 步。② 在 Electron 裡載入 sharp 時，Linux 會印 `SharpElectronLinux` 警告與一串 GLib 訊息（sharp 官方說 Linux 上 Electron 自帶的函式庫可能和 sharp 不合），但產生與讀回 PNG 都正常；Windows 沒有這個問題〔推論，依 sharp 文件〕，一樣以驗收第 4 步的裁圖為準。

**接手時的修正（`d9aac68` 之後）**

1. **拼字字典外連**（上表「執行期零外連」）：前一版每次開啟都會嘗試連 `redirector.gvt1.com`，違反本機模式的零外連；加了外連陷阱之後冒煙測試才抓得到。
2. **自己後端的健康檢查固定問 127.0.0.1**：DA-11 網頁版那一半合併後，A 的健康檢查會照 `.env` 的 `HOST` 決定連哪個位址；桌面版的後端不管 `HOST` 一律只聽 127.0.0.1，兩者不能混用。
3. **對話框的租約說法**：原本寫「下次開啟後約 3 分鐘才會重新接手」，實際是從放棄那一刻起算、最多約 3 分鐘（租約每 30 秒續一次），改成「要等租約到期才會重新接手（從現在算起最多 3 分鐘，馬上重開的話會先等一下）」。
4. **測試不寫死會被其他分支改掉的字句**（上面「和同一輪其他分支的相容」）；冒煙測試多了 `native-probe.js` 與外連陷阱。另外補了 README 兩處的啟動說明。

**審查後的修正（`dec/r7-electron-b1-fix`）**

1. **關機被取消之後按 X 會直接放棄在途工作**（違反 DA-2＝3）：`query-session-end` 設了「正在關機」的旗標之後沒有地方復原，而關機被取消時 Electron 不會再發事件。改成只有 `session-end` 才設（上方「關閉行為」的「Windows 登出或關機」）。規則寫成 `lib/decisions.js` 的純函式 `sessionEndingAfter`，單元測試走一遍「問了→取消→有工作按 X＝縮到系統匣」；冒煙測試的 busy 情境在關視窗之前先送一次 `query-session-end`（假裝關機被取消），驗證真的 Electron 裡還是縮到系統匣。
2. **「等處理完再結束」的說法**：補上「單題的檢查只做完正在跑的那一步，後面的步驟下次開啟再接著做；剛拆出來或剛生成的題目也是下次開啟才開始檢查」，單元測試同時釘住 jobRunner 的 `stop()` 只清認領的計時器（它改了，這句話就要跟著改）。
3. **commit 規範**：`d9aac68`（`wip` 類型、結尾兩行之間多一個空行）與 `6017300` 壓成一個 `feat(desktop)` commit，內容與 `6017300` 相同。
4. **文件**：檔頭加註 B 部分的現況（B1 已實作待驗收、B2／D2／B3 仍是設計稿）；通知那一句標〔要實測〕並寫出退路。檔頭第一行「狀態」沒有改：同一輪的 `dec/r7-decisions-host-fix` 也改寫那一行，兩邊都改會在合併時衝突，所以只改本分支自己加的那一行，說明「尚未實作」現在只對 B2、D2、B3 成立。兩條都合併之後要把第一行改成一句也可以，見下方「留給之後」。
5. **小地方**：`install_desktop_app.bat` 安裝失敗時，先提「桌面版還開著、`electron.exe` 被鎖住（EBUSY／EPERM），先從系統匣結束」，再提網路；`main.js` 只在 `!app.isPackaged`（從 repo 執行）時載入冒煙測試的掛勾，而且包在 `try` 裡，B3 的安裝版不帶 `test/` 也不會因為環境變數而啟動失敗。
6. **驗證**：`desktop` 的 `npm test` 120 則、冒煙測試 54 項全過。把 `query-session-end` 暫時改回舊寫法再跑 busy 情境，12 項有 6 項失敗（關視窗變成直接結束、不縮到系統匣、不通知），就是審查說的情境，所以新的檢查抓得到這個錯。`exam_pro` 的 `npm test`（4,055 則：4,053 過、2 略過，與基底相同）、`check:html`、5433 全新 UTF8 庫的 `test:integration`（629 則）全過。e2e 沒有重跑：這一版只改了 `desktop/`、文件與 `.bat` 的文字，`exam_pro` 的程式一行都沒動。和 `dec/r7-decisions-host-fix`（`42c6476`）、`dec/r7-checkpoints-fix`（`f27b15f`）試合併：本分支和兩條各自合都沒有衝突；三條合在一起（那兩條之間在 `docs/desktop-launcher.md` 的衝突與本分支無關）之後，`desktop` 的 `npm test` 120 則、`exam_pro` 的 `desktop*`／`listenHost` 單元測試 273 則、冒煙測試 54 項全過。

**留給之後（要 Owner 同意或下一輪決定）**

- **`desktop/` 不在 CI、也不在 dependabot 的範圍**（R-7）：Electron 44 的安全更新現在只能靠人工追。要改 `.github/workflows/ci.yml`（加一個跑 `desktop` 的 `npm test` 的 job，不需要 Electron 執行檔）與 `.github/dependabot.yml`（現在只有 `/exam_pro` 的 npm 與 GitHub Actions；再加一組 `package-ecosystem: npm`、`directory: /desktop`），需要 Owner 同意，建議和 B3 一起做或列進下一輪的待決事項。
- 兩條分支（本分支與 `dec/r7-decisions-host-fix`）都合併之後，檔頭第一行可以合成一句：「狀態：B 部分 B1 已實作（待驗收），B2／D2／B3 仍是設計稿；第 8 條的 14 題決策 Owner 已全部答覆（第六輪）……」，同時刪掉本分支加的那一行。

**雲端驗不到、要在 Windows 上確認的**：系統匣圖示與氣球通知（和 AUMID 的互動，上方「關閉行為」最後一點）、「另存新檔」對話框的預填（前端在 `a.click()` 之後立刻 `revokeObjectURL`，要確認對話框開著的期間 Blob 仍下載得完）、捷徑的建立與圖示、AUMID 的工作列分組、Electron 在 cmd 視窗印的中文、由 app 代開 Docker Desktop、`sharp`／`@node-rs/jieba` 的 Windows 版與 `mupdf` 在 utilityProcess 裡能不能載入（R-6）、OCR 的 python 會不會變孤兒（R-9）、Defender／Smart App Control 會不會擋未簽章的 `electron.exe`（R-5；DA-9 的前提是 SAC 關閉，尚待 Owner 確認）、登出與關機、真的麥克風。

**Owner 驗收步驟**（約 30～45 分鐘；每一步有問題就記下畫面與 `exam_pro\data\logs\desktop-日期.log`）

0. 前提：Smart App Control 是關的（「Windows 安全性 → 應用程式與瀏覽器控制 → Smart App Control」；DA-9 的前提）；Node.js 24 在 `PATH` 裡（一鍵腳本要用 `node`、`npm`）；`exam_pro` 已經 `npm install`；Docker Desktop 有裝。
1. **建立圖示**：雙擊 `exam_pro\scripts\windows\install_desktop_app.bat`。第一次會安裝並下載 Electron（100 多 MB，幾分鐘），最後看到「已建立：…\出題系統（桌面版）.lnk」「[OK] 完成」。桌面多一個「出題系統（桌面版）」；A 的「出題系統」「關閉出題系統」還在。〔確認：cmd 視窗裡的中文沒有變亂碼；Defender 沒有跳出攔截〕
2. **開啟**：先把 Docker Desktop 整個結束，再雙擊「出題系統（桌面版）」。同一個視窗先出現啟動畫面（六個步驟），Docker Desktop 被代開、資料庫起來，最後自動轉到系統首頁（有黃色注意事項時按「我知道了，進入出題系統」）。六個分頁都能用；右下角系統匣有出題系統的圖示；工作列只有一個按鈕。
3. **Word 下載**：組一份卷、下載 Word → 跳「另存新檔」，預設在「文件\出卷」，檔名就是頁面給的（例如「XX 段考（學生版）.docx」，**不是「download」**）；存好後再下載一次，預設資料夾變成上次存的地方。打開 Word 檔確認內容正常。其中一次讓「另存新檔」對話框開著 30 秒以上再按「存檔」，確認檔案一樣完整（前端點下載後馬上釋放 Blob 網址）。
4. **上傳與背景工作**：上傳最小的樣卷，讓拆題開始跑（確認 mupdf、sharp 在桌面版裡正常：拆題有進度、附圖裁得出來；再用題庫的搜尋確認 jieba 正常）。拆題在跑的時候按右上角 X：視窗消失，右下角跳通知「出題系統仍在背景處理」；點系統匣圖示，視窗回來。再按一次 X，等拆題和後續的檢查都跑完：跳「背景工作都處理完了」，約 8 秒後系統匣圖示消失（app 結束）。**兩個通知都沒有跳出來**的話，記下來（記錄檔裡有「[通知]」那一行代表程式有送出），照上方「關閉行為」最後一點的退路處理。
5. **放棄與重跑點**：再上傳一次，在拆題途中從系統匣選「結束」：對話框有三個按鈕，文字寫著重跑範圍與「從現在算起最多 3 分鐘」；選「現在放棄」→ app 馬上結束。重開桌面版，放棄後最多約 3 分鐘（租約到期）那份卷從第 1 塊重拆（DA-13 合併後改成從沒完成的那一塊接著拆）。也在分類、驗算等**單題的步驟**執行中放棄一次：重開後那一題從同一個步驟重跑。兩種都確認：複核頁沒有多出逾時的紀錄、job 沒有變 `failed`。再測一次「等處理完再結束」：系統匣留著、選單多了「現在放棄」，處理完就自己結束。在單題的步驟執行中選「等處理完再結束」時，只會做完正在跑的那一步就結束；重開後那一題從下一步接著做（對話框有寫）。
6. **沒有殘留**：從系統匣結束後，工作管理員 → 詳細資料：沒有殘留的 `electron.exe`（桌面版的）、`node.exe`、`python.exe`。**OCR 正在跑時**選「現在放棄」也測一次（python 會不會跟著結束，R-9）。
7. **另一個後端**：開著網頁版（在 `exam_pro` 執行 `npm start`）時開桌面版，啟動畫面的注意事項有「網頁版（npm start）或桌面啟動器 A 的後端正在 http://localhost:3000 執行…」。關掉網頁版；在工作管理員強制結束桌面版的 `electron.exe` 之後馬上重開，**不會**出現這一條。
8. **第二次開啟**：桌面版開著時再雙擊一次圖示，只會把原本的視窗叫到前面（縮在系統匣時也會叫回來），不會開第二個。
9. **麥克風**（Gemini 模式而且開了語音時才需要；本機模式沒有語音，可以跳過）：家教的「按住說話」可以錄音；Windows「設定 → 隱私權與安全性 → 麥克風 →『讓桌面應用程式存取您的麥克風』」要打開。
10. **登出或關機**：桌面版開著時直接登出或關機，不會被它擋住。**關機被取消之後**也測一次：先開一個會問「要不要存檔」的程式、留著沒存的內容（例如 Word 新文件打幾個字；Windows 11 的新版記事本會自動保留內容，不一定擋得住），讓拆題在跑，然後選關機；出現「這些應用程式正在阻止關機」時按「取消」（沒有出現這個畫面就改用別的程式再試，這一步的重點是「關機被取消」）。回到桌面後按桌面版右上角的 X：要縮到系統匣並跳「出題系統仍在背景處理」，**不能**直接結束（記錄檔有「Windows 詢問要不要登出或關機」那一行，後面接的是「關視窗：{"action":"hide"…}」）。
11. **記錄檔**：系統匣「開啟記錄檔資料夾」打得開，裡面有 `desktop-日期.log`、`desktop-server-日期.log`。
12. **錄製中**：`record_local.bat` 在跑時開桌面版，照 A 的 `jobsWhileRecording` 設定（DL-4＝2 的預設改成 `pause` 之後）暫停背景工作，啟動畫面有對應的注意事項。

更新方式（DA-6＝1，U1）：`git pull` 之後，`exam_pro\package-lock.json` 有變就在 `exam_pro` 執行 `npm ci`；`desktop\package-lock.json` 有變就雙擊 `install_desktop_app.bat --reinstall`（命令提示字元裡加參數；桌面版要先從系統匣結束，否則 `electron.exe` 被鎖住、安裝會失敗）。

**原規劃**（B1 開工前的版本，保留對照）：

- **範圍**：第 1～8、32、35、36 項（第 36 項照 DA-13 的建議算進去）。
- **工時**：3＋10＋1＋1＋3＋2＋26＋6＋0.2＋1＋(5～7)，約 58～60h，約 **7.5 人日**。A 的 `plan.js` 合併後可以直接用時，約少 4h；DA-13 選 1 時少 5～7h。
- **自動化驗收**（原文）：`npm test`、`check:html` 全綠；`startServer({port:0})`、`close()` 的單元測試；`shutdown({abandon:true})` 對題目層、拆題、變式三種工作單位各一則（**這一版沒做 abandon，所以沒有**）；做了第 36 項的話拆題與變式的檢查點測試（在 DA-13 的分支）；`desktop/` 的 `node --test`；5433 全新 UTF8 庫上的整合測試。
- **手動驗收**（原文的 8 點已併進上面的 Owner 驗收步驟：1→第 2 步、2→第 3 步、3→第 4 步、4→第 4、5 步、5→第 6 步、6→第 7 步、7→第 8 步、8→第 9 步）。

### 6.3 B2：路徑與設定搬到 `%LOCALAPPDATA%`／`%APPDATA%`

- **範圍**：第 9～14、18、21、33、34 項（第 15 項移到 B3：U1 期間 OCR 的 venv 留在 repo，2.7 節）。
- **工時**：4＋2＋1＋3＋4＋3＋6＋(6～8)＋3＋1，約 33～35h，約 **4～4.5 人日**。
- **自動化驗收**：
  - 沒設 `APP_DATA_DIR` 時，所有既有測試不改一個字就全綠。這條測的是預設不變。
  - 新增一個整合測試，把 `APP_DATA_DIR` 指向暫存目錄，跑完「上傳 → PDF 落地 → 裁圖 → Word 附圖」。只在本機跑。
  - 新增 `paths.js` 的單元測試。
  - 搬遷工具的單元測試涵蓋：試跑、sha256 不一致時報錯、目的檔已存在且內容不同時拒絕。
  - 桌面版設定缺 `LLM_MODE=live` 或 `EMBED_MODE=live` 時，app 擋下並說明（第 13 項）。
- **手動驗收**：
  1. 執行搬遷工具，報告的檔案數和 sha256 全部一致。
  2. app 改讀新位置後，舊題的附圖照樣顯示，Word 匯出有圖，舊 job 的 PDF 可以重試。
  3. 把 repo 裡的 `data\` 改名（不要刪），app 還是正常，證明已經不依賴舊位置。
  4. 從維護命令列執行 `tool report:jobs` 與 `tool` 的公式健檢，都成功；報告與 `formulas_backup_*.json` 寫在資料資料夾裡，不在 repo。把 repo `.env` 的 `DATABASE_URL` 暫時改錯，維護命令列照樣連得上，證明它讀的是桌面版的設定（第 21 項）。

### 6.4 D2：原生 PostgreSQL 與搬家

- **範圍**：第 19、20、23～28 項，加上第 4 條的演練與搬家。
- **工時**：(9～10)＋6＋1＋3＋14＋5＋6＝44～45h，再加第 26 項 pgvector 的取得 4～12h（視 DA-5 的選擇），合計約 48～57h，約 **6～7 人日**。比 `c3cd57f` 多的 5～6h 是舊庫防護（第 19、23、24 項）與 pgManager 的命令列（第 25 項）。Owner 的操作約 2～3 小時；如果要先把 Docker 庫的 pgvector 升到 0.8.6（4.1 節），另加約 15 分鐘。
- **前提**：DA-14 量測之後仍決定要做 D2。
- **自動化驗收**：
  - `backup.js` 原生模式的參數組成、檔頭驗證和附圖 zip 有單元測試。
  - `backup.js` docker 模式在 `system_identifier` 不同時拒絕備份、寫 `LAST_FAILED.txt`，有單元測試（第 19 項）。
  - `runMigrations()` 的函式版在 5433 全新測試庫上跑出和 CLI 相同的結果。
  - `snapshot_db.js --compare` 對同一個庫比兩次回 0，對故意改過一列的庫回 1。
- **手動驗收**：
  1. 演練時 4.3 節每一項都照判讀標準通過，記下還原時間。
  2. 正式搬家後重跑一次，同樣通過。
  3. 原生模式的 `npm run db:backup` 產出 `PGDMP` 檔頭的 dump，而且**把這份 dump 還原到一個新庫再比對一次**，確認備份真的能還原。
  4. 關機再開機後，app 能正常啟動 PostgreSQL。用工作管理員強制結束 app 之後，`postgres.exe` 應該還在跑（2.5 節「停止」那一列）；再開 app 時要認出是自己的叢集並沿用，不會報埠衝突。再把 `postgres.exe` 也強制結束一次，重開 app 後 PostgreSQL 要能自動回復。
  5. **舊庫不會復活**（R-19）：切換後在 app 沒開時執行 `record_local.bat` 的第 1 步（`npm run db:up`），只有 `exam_pg_test` 起來，`exam_pg` 仍是停止的；接著用 `BACKUP_MODE=docker` 執行 `備份資料庫.bat`，要被拒絕、`backup.log` 記的是失敗而不是 OK。

### 6.5 B3：打包安裝檔

- **範圍**：第 15、29～31 項。
- **工時**：4＋11＋6＋2＝23h，加上打包後的冒煙測試與 asar 問題的排除 0～3h，約 23～26h，約 **3～3.5 人日**。第 29 項比 `c3cd57f` 多 1h，用來把 `setup_local_ai.bat`、`tee_run.js` 解開放在 asar 外面，並接上 `tutor-node.cmd`。
- **驗收**：
  1. 在 Owner 的電腦上 build 出安裝檔，記錄大小。
  2. 以一般使用者安裝，不需要系統管理員權限。
  3. 開始選單和桌面有捷徑。
  4. 首次啟動精靈能找到既有資料。
  5. 解除安裝後 `%LOCALAPPDATA%\TutorExamBank` 仍在。
  6. 重新安裝後資料都在。
  7. 把版本號加 1 再 build 一次並覆蓋安裝，5.3 節的升級流程會跑完，而且有留下備份。
  8. Defender 與 Smart App Control 都沒有攔截；如果被攔截，記錄訊息並照 DA-9 處理。
  9. 安裝版的維護命令列能執行 `tool report:jobs`（第 21 項；也驗證 run-as-node 讀得到 asar 裡的腳本，讀不到就照 2.9 節把 `exam_pro` 移出 asar）。
  10. 首次啟動精靈建好 `ocr-venv`，OCR 自我檢查通過（第 15 項）。

### 6.6 總表

| 期別 | 開發工時 | 前置條件 | 可以單獨交付嗎 |
|---|---|---|---|
| B1 | 約 58～60h（約 7.5 人日，含 DA-13 的 5～7h） | A 合併（沿用它的檢查邏輯與關閉通道）、DA-2、DA-3、DA-11、DA-13（四題 2026-09-27 都已答） | 可以：Owner 從此雙擊圖示使用，Docker 仍由 app 代開 |
| B2 | 約 33～35h（4～4.5 人日） | B1、DA-1、DA-8（兩題已答） | 可以 |
| D2 | 約 48～57h（6～7 人日，含 pgvector 與舊庫防護） | B2（路徑穩定後再搬）、DA-14 的量測結果（**等 Owner 量**）、DA-4、DA-5、DA-7、DA-12（四題已答） | 可以：也能不經 B，改由 A 的啟動器去開原生 PostgreSQL（〔推論〕，A 要加約 0.5 人日） |
| B3 | 約 23～26h（3～3.5 人日） | B2、D2、DA-6、DA-9（已答；DA-9 的前提 SAC 關閉待 Owner 確認；DA-6 的「B3 之後改不改 U2」B3 開工前再問） | 可以 |
| 合計（不含緩衝） | **約 162～178h，約 20～22.5 人日** | | |
| 合計（加 20～30% 緩衝） | **約 195～232h，約 24.5～29 人日** | | |

**為什麼要加緩衝**：下面這些〔要實測〕或〔未查證〕的項目，一旦結果不利，工時會超出上面的範圍，而上面的數字都沒有替它們預留：

- mupdf 的 WASM 在 asar 裡讀不讀得到（2.2 節），以及 run-as-node 讀不讀得到 asar 裡的腳本（2.9 節）。讀不到時要把 `exam_pro` 移出 asar，約 +2～4h。
- pgvector 的取得（DA-5）：GitHub Actions 卡關時改走 conda-forge，4～12h 的範圍可能不夠。
- Smart App Control 開著時（DA-9）：要嘛 Owner 關掉它，要嘛多出簽章的流程與費用。〔DA-9 選 1 的前提就是 SAC 關閉；第 10 節的檢查會讀出狀態〕
- `pg_ctl` 在 Owner 的帳號下能不能正常降權啟動（R-2）。
- Windows 內建 `tar` 產生 zip 的實際行為（第 19 項），以及從 `.env` 讀 `COMPOSE_PROFILES` 的實際行為（第 23 項）。
- 拿掉對系統 Node 的依賴、把 `setup_local_ai.bat` 改寫成 Node 版（2.7 節），約 +4h，只有真的要時才做。

〔2026-09-27〕14 題的答案裡，13 題就是上面工時所依據的建議，DA-12 直接定 ICU 也不影響工時；DA-11 網頁版那一半（約 1h，不在上面的合計裡）已在 `dec/r7-decisions-host` 做完。所以工時與緩衝都不變。

Owner 自己的時間另外算：DA-14 的上限與量測約 0.5 小時；D2 的演練加搬家約 2～3 小時；B3 試裝約 1 小時；B3 重建 OCR 的 venv 約 30～60 分鐘（2.7 節）。

---

## 7. 風險與未知

| # | 風險或未知 | 可能性、影響 | 對策 | 怎麼確認 |
|---|---|---|---|---|
| R-1 | pgvector 的 Windows 二進位不好取得。官方的 Windows 說明只有 Visual Studio 加 `nmake` 的編譯流程（〔查證 S19〕），沒有官方預先編好的檔案 | 中、中：卡住 D2 | DA-5：用 GitHub Actions 的 Windows runner 編；退路是 conda-forge，它的 win-64 pgvector 0.8.6 就是對 PostgreSQL 16（libpq 16.15）編的（〔查證 S21、S21b〕）；第三方的預先編譯檔（例如 S22）看不到建置紀錄，不建議拿來跑正式庫 | D2 第 0 步：`CREATE EXTENSION vector` 成功，4.3 節的向量雜湊相同 |
| R-2 | 在系統管理員帳號下 PostgreSQL 起不來 | 中、高 | 一律用 `pg_ctl` 啟動（〔查證 S25、S26〕） | 在 Owner 的帳號下實際執行 `pg_ctl start`〔要實測〕 |
| R-3 | 排序規則與字元分類不同。Docker 庫〔推論〕是 Debian glibc 的 `en_US.utf8`（4.1 節，〔查證 S39、S40〕），要以第 0 步查到的 `datcollate` 為準；Windows 原生庫是 Windows 或 ICU 的 locale | 中、低：資料不會壞 | 影響範圍〔推論〕：① `ORDER BY` 中文欄位的順序，包括學生名單（`studentController.js:190`、`assistantService.js:109`）、弱點表同分時的次序（`weaknessService.js:61`）和分類 few-shot 的章節順序（`agents/classify.js:438`）。few-shot 順序只影響正式環境 prompt 裡例題的排列；cassette 的鍵用的是由小到大排好的 `fewShotIds`，錄製時 `ctx.db` 也一律是 null（裁決 S2-8，`agents/classify.js:35-36`），**所以不會讓 CI 的回放對不上**。② pg_trgm 只從「英數字」抽三字組（〔查證 S23〕），中文字算不算英數字要看 locale 的字元分類；抽不到三字組時，索引搜尋會退化成掃過整個索引（〔查證 S23〕）。專案只用它建 `ILIKE` 的索引，沒有用 `similarity()`（2.5 節），所以**結果一樣正確，只差速度** | DA-12：演練時比對章名排序和 `show_trgm` |
| R-4 | 非 ASCII 路徑 | 中、高 | PostgreSQL 的二進位、資料夾和密碼檔都放在純英數的路徑（〔查證 S27、S28〕） | initdb 成功 |
| R-5 | Defender、防毒軟體或 Smart App Control 擋下程式：沒簽章的 Electron exe、由 app spawn 的 `postgres.exe` 和 `python.exe`、自己編的 `vector.dll` | Defender 誤判：中、中。**SAC 開著時：高、高**。SAC 不看網路標記，無法預測安全性的 exe 沒有受信任的簽章就擋（〔查證 S45〕）；已有 Electron 專案回報本機 build 的未簽章 exe 被擋（〔查證 S45b〕）。U1 的 `electron.exe` 與自編的 `vector.dll` 會不會被擋〔未查證〕 | ~~DA-9：先看 SAC 的狀態再選。~~〔DA-9 選 1，定案〕不簽章、只在 Owner 電腦 build；前提 SAC 關閉（Owner 用第 10 節的檢查確認，開著就回到 DA-9 選 4）。必要時把 `%LOCALAPPDATA%\TutorExamBank\pgdata16` 加入 Defender 的排除清單，減少即時掃描拖慢資料庫，要不要排除由 Owner 決定 | B1 開工前看 SAC 狀態；B1、D2 的冒煙測試；B3 驗收第 8 點 |
| R-6 | Electron 的 Node 和原生模組：`sharp`、`@node-rs/jieba` 是 Node-API 模組，不必重新編譯，但要解開放在 asar 外（〔查證 S9〕）；`mupdf`（ESM 加 WASM）在 asar 裡能不能載入不確定；平台專用的二進位最簡單是在 Windows 上 `npm ci` 取得（2.2 節） | 中、中 | 2.2、2.9 節；B1 先在不包 asar 的開發模式確認三者都能動，B3 再確認打包後也能動 | B1、B3 的冒煙測試：拆題會用到 mupdf 和 sharp，查題會用到 jieba |
| R-7 | Electron 的支援期短：只支援最新三個大版本，約半年（〔查證 S1、S3〕） | 高、低：單機、只載入自己的頁面 | 每半年升一次大版本；升級也走 5.3 節的流程 | — |
| R-8 | 記憶體：D2 的主要效益，但省多少不確定 | 中、正面 | D2 之後 WSL2 虛擬機不開。但比較的基準應該是「D1 加上 WSL 記憶體上限」（DA-14），不是預設的上限：WSL2 預設最多吃實體記憶體的一半，也就是 8 GB，可以用 `.wslconfig` 的 `memory=` 壓低，也可以開 `autoMemoryReclaim` 歸還快取（〔查證 S29〕；Docker 在 WSL 2 下的記憶體上限也是改 `.wslconfig`，見 S30）。Docker 的 Resource Saver 在 WSL 2 上只暫停引擎、不減記憶體，Docker 的文件改建議開 `autoMemoryReclaim`（〔查證 S30b〕）。社群回報 Docker Desktop 閒置時約 3 GB、vmmem 約 2.5 GB（〔查證 S31〕，2023 年、非官方數字，沒有設上限）。Electron 本身的主行程、視窗和 GPU 行程約一兩百 MB（〔未查證〕），大約是一個 Chrome 分頁的量級。對 `local-mode.md` 10.14 (e) 的記憶體帳（Owner 第五輪 C-e：先量再決定，10.17）應該是淨省，省多少要量 | 先照 DA-14 設上限並量測（〔選 1，定案〕第 10 節）；做 D2 的話，搬家前後各在工作管理員記一次「使用中」的記憶體〔要實測〕 |
| R-9 | 關閉時留下孤兒行程：Python 或 PostgreSQL | 低、中 | python：venv 的 `Scripts\python.exe` 是轉導器（〔查證 S44b〕），後端的直接子行程是轉導器，真正的直譯器是孫行程，不在 libuv 的 job 裡（〔查證 S41〕的 `SILENT_BREAKAWAY_OK`）。它會跟著結束，靠的是轉導器自己建的 kill-on-close job（〔查證 S44〕）。所以「不會變孤兒」是〔推論〕，而且依賴 Python 啟動器的實作（2.3 節）。postgres 則刻意讓它在 app 當掉時繼續跑，下次開 app 沿用（2.5 節）。啟動時如果發現上次沒有正常結束（`postmaster.pid` 還在，但行程不在），交給 `pg_ctl` 處理 | B1 驗收第 5 點（OCR 執行中結束也要測）；D2 驗收第 4 點 |
| R-10 | app 關著的時候沒有備份 | 中、中 | DA-4（〔選 1，定案〕）：資料只有在 app 開著時才會變動，所以改成「每天第一次開啟時」和「結束前、有寫入時」備份 | D2 驗收 |
| R-11 | NSIS 超過 2 GB 會壞掉（〔查證 S8〕） | 低 | 不包 venv 和模型（1.2 節） | B3 記錄大小 |
| R-12 | mupdf 是 AGPL：只自用不觸發義務；安裝檔一旦交給別人就算散布（`roadmap-plan.md` 擱置區第 7 項） | 低 | 安裝檔只在 Owner 的電腦上 build 和安裝，不上傳到公開的 Release | — |
| R-13 | 完全拿掉 Docker 會讓 `record_local.bat` 和本機整合測試不能用 | ~~看 DA-7 的選擇~~〔DA-7 選 2〕不會發生 | 〔定案〕保留 Docker 但不開機啟動 | — |
| R-14 | 網頁版和桌面版同時開、連同一個庫，runner 會加倍 | 低、中 | 2.8 節的偵測與警告：看 `pg_stat_activity` 的 `application_name`（第 3 條第 35 項），不看租約（當機後 180 秒內重開會誤判） | B1 驗收第 6 點 |
| R-15 | 開機時 Ollama 還沒起來，app 先打開 | 中、低 | 健康檢查每 5 秒重試一次、最多 60 秒；逾時只警告，不影響題庫和組卷 | B1 驗收 |
| R-16 | 我查不到、不確定的事 | — | 列在這裡，實作時逐項確認 | 見第 9 條最後的「查不到或不確定的事」 |
| R-17 | 「關閉時中止在途節點」被記成逾時，吃掉重試次數（2.3 節第 3 點） | 高（照直覺寫就會踩到）、高：題目被送進人工複核，拆題中的整份卷可能直接 `failed`，事件表多出假逾時 | 2.3 節第 4 點的 `abandon` 路徑；單元與整合測試釘住（6.2 節），題目層、拆題迴圈、變式生成三條路都要測 | B1 自動化驗收 |
| R-18 | A 和 B 都改 `server.js`、`app.js`，而且 A 的 `d730422` 還沒審查 | 中、低：合併衝突與重工 | 先合併 A，B1 在它上面改（6.1 節） | B1 開工時核對 A 的最終版本 |
| R-19 | D2 之後舊的 Docker 正式庫被 `docker compose up` 帶起來。`record_local.bat`、`啟動資料庫.bat`、A 或 app 代開 Docker 的邏輯都會跑它：app 開著時錄製失敗；app 沒開時舊庫在 5442 復活，網頁版、維護工具、migrate 都寫進舊庫，形成兩份分歧的正式庫；`backup.js` 的 docker 模式還會把舊庫備份下來並記成 OK | 高（每次錄製都會跑 `db:up`）、高 | 第 3 條第 23 項（profile 加上 `COMPOSE_PROFILES`）；第 19 項（備份前比對 `system_identifier`）；第 24 項（`啟動資料庫.bat` 不再 migrate 正式庫）；2.5 節的埠判斷（遇到不是自己的叢集就報錯、不沿用） | D2 驗收第 5 點 |
| R-20 | 放棄或中斷之後，拆題從第 1 塊整份重拆、變式從第 1 題重來（2.3 節第 4 點） | 中、中：本機模式可能白費一小時以上；重拆出不同編號時可能多出重複的題目列 | DA-13 的逐塊檢查點；DA-2 讓「放棄」一定要先問（兩題都定案：DA-13 選 2、DA-2 選 3） | B1 驗收第 4 點 |
| R-21 | 安裝版的維護工具與 `setup_local_ai.bat` 在 asar 裡不能執行：cmd 不能 `cd` 進 asar，系統的 node 讀不到 asar，安裝版沒有 npm | 高（照第一版正式稿的寫法一定會踩到）、中 | 第 3 條第 21 項的 `tutor-node.cmd`（run-as-node）；`setup_local_ai.bat`、`tee_run.js`、`ocr_service` 解開放在 asar 外面（2.9 節）；run-as-node 讀不到 asar 時把 `exam_pro` 整個放在 asar 外 | B3 驗收第 9、10 點 |

---

## 8. 決策草稿（〔2026-09-27〕Owner 第六輪已全部答覆）

每一題都可以單獨看懂。~~**還沒有任何一題的答案落實在程式裡。**~~〔2026-09-27〕Owner 第六輪已答全部 14 題：下表最後一欄是答案，各題開頭另加一段「〔Owner 2026-09-27 選 N〕定案」，原本的背景、選項與建議保留。落實在程式裡的只有 DA-11 的網頁版那一半（`dec/r7-decisions-host`）；其餘在 B1、B2、D2、B3 實作時照答案做。「何時」指的是最晚要答的時間點。第 3、6 條的工時是照每一題的「建議」估的；選項裡寫的「+Nh」是和最省事的選項相比多出來的工時，選了建議以外的選項時再照它調整總數。

| 編號 | 題目 | 什麼時候要答 | 建議 | Owner 2026-09-27 |
|---|---|---|---|---|
| DA-1 | 資料夾放在哪裡 | B2 開工前 | 2：設定和資料分開，路徑只用英數字 | 選 2：設定放 `%APPDATA%`，資料庫、附圖、日誌放 `%LOCALAPPDATA%`，備份放「文件\TutorExamBank\backups」 |
| DA-2 | 關閉視窗時，背景工作怎麼辦 | B1 開工前 | 3：有工作時縮到系統匣，沒工作時直接結束 | 選 3：看狀況（有工作縮到系統匣並通知，沒工作直接結束；從系統匣結束時問等完或放棄，寫明重跑範圍） |
| DA-3 | 後端跑在哪一個行程 | B1 開工前 | 2：utilityProcess | 選 2：`utilityProcess.fork` |
| DA-4 | 原生 PostgreSQL 由誰管理、什麼時候備份 | D2 開工前 | 1：由 app 管理，app 負責備份 | 選 1：app 管理；每天第一次開啟、結束前有寫入、migrate 前備份；停用 02:00 排程 |
| DA-5 | pgvector 的 Windows 二進位從哪裡來 | D2 開工前 | 2：另開一支只能手動觸發的 GitHub Actions | 選 2：手動觸發的 GitHub Actions，在 Windows runner 對 EDB PG16 編 pgvector，產出 zip 與 SHA-256 |
| DA-6 | 更新方式 | B3 開工前（B1 起就先照建議） | B1～D2 用 1、B3 起用 2，不做自動更新 | 選 1：維持 git＋bundle，從 repo 啟動 Electron（U1）（B3 之後改不改 U2，B3 開工前再問） |
| DA-7 | Docker 是否完全移除 | D2 搬家前 | 2：保留但不開機啟動，當作備援（前提：DA-14 量完仍決定做 D2） | 選 2：保留安裝但不自動啟動（D1 備援），舊 volume 至少留 30 天 |
| DA-8 | Gemini 金鑰怎麼保管 | B2 開工前 | 1，重新啟用 Gemini 時改 2 | 選 1：照舊明文寫在 `.env`，搬到 `%APPDATA%\TutorExamBank\.env` |
| DA-9 | 要不要簽章 | 看 SAC 狀態：B1 開工前；選項：B3 開工前 | 先看 Smart App Control：關著選 1（不簽章）；開著建議 4（關掉 SAC），不想降低防護就選 3 | 選 1：不簽章，只在 Owner 電腦 build（**前提 SAC 關閉，待 Owner 確認**，第 10 節） |
| DA-10 | 什麼時候搬家 | 演練通過後 | 2：重錄結束、當週沒有要上傳的考卷時 | 選 2：B2 完成且演練通過後挑空檔 |
| DA-11 | 要不要保留區網存取 | B1 開工前 | 1：桌面版只綁本機；網頁版的綁定位址另外決定 | 選 1：桌面版只綁 127.0.0.1；網頁版改用 `HOST`、預設 127.0.0.1（**網頁版已實作**） |
| DA-12 | 原生庫的 locale（排序規則） | D2 演練時 | 演練時比對後再定 | 選 2：ICU（`--locale-provider=icu`） |
| DA-13 | 要不要做拆題與變式的逐塊檢查點 | B1 開工前（和 DA-2 一起） | 2：拆題逐塊、變式逐題都做 | 選 2：拆題逐塊、變式逐題都做 |
| DA-14 | 要不要先限制 WSL 的記憶體，量完再決定 D2 做不做 | 現在就能做；D2 開工前看結果 | 1：現在就設上限並量測 | 選 1：Owner 設 `memory=3GB`、`autoMemoryReclaim=dropCache` 並量測（Owner 自己做，第 10 節） |

### DA-1　資料夾放在哪裡

> 〔Owner 2026-09-27 選 2〕**定案**：設定（`.env`、`settings.json`）放 `%APPDATA%\TutorExamBank`；資料庫（`pgdata16`）、附圖、考卷 PDF、`uploads`、日誌放 `%LOCALAPPDATA%\TutorExamBank`；備份放「文件\TutorExamBank\backups」（`BACKUP_COPY_DIR` 照舊複製到 OneDrive）。資料夾名稱一律英數字 `TutorExamBank`。B2 照這個做。

- **背景**：現在所有資料都在 repo 的 `exam_pro` 底下：附圖 `data\figures`（唯一需要長期保存的檔案）、考卷 PDF `data\jobs`（拆題完成就刪，平常只有排隊中的）、上傳暫存 `uploads`（每小時清一次）、備份 `backups`（每份 dump 另外複製一份到 OneDrive）。A 的啟動器還會加上 `data\launcher`、`data\logs`。資料庫在 Docker 的 volume 裡。repo 放在桌面上（`C:\Users\Administrator\Desktop\tutor-exam-bank`，`docs/HANDOFF.md`）。做成 app 以後，程式會裝在 `%LOCALAPPDATA%\Programs\...`，更新時整個替換，所以資料一定要搬出來。另外，PostgreSQL 在 Windows 上碰到非 ASCII 路徑有已知問題（〔查證 S27、S28〕），而資料庫的資料夾絕對不能放在 OneDrive 同步的資料夾裡，同步程式會在資料庫寫到一半時鎖住或複製檔案〔推論〕。
- **問題**：設定、資料庫、附圖、備份要放在哪裡？
- **選項**：
  1. **全部放在 `%APPDATA%\TutorExamBank`**（Roaming）：只有一個地方，好找。代價：Roaming 是設計給「跟著網域帳號漫遊」的小型設定，放資料庫和附圖不合慣例；這台電腦沒有加入網域，所以實際上沒有漫遊的問題。工時沒有差別。
  2. **設定和資料分開**：
     - `%APPDATA%\TutorExamBank`：只放 `.env` 和 `settings.json`。
     - `%LOCALAPPDATA%\TutorExamBank`：放 `pgdata16`、`data\figures`、`data\jobs`、`uploads`、`logs`，以及 B3 起的 `ocr-venv`（U1 期間 venv 留在 repo，2.7 節）。
     - 備份預設放在 `文件\TutorExamBank\backups`，`BACKUP_COPY_DIR` 照舊複製到 OneDrive。

     代價：要知道兩個地方，所以系統匣選單會提供「開啟資料夾」。工時沒有差別。
  3. **放在使用者自選的資料夾**（例如 `D:\TutorExamBank`，全部在一起）：方便整包帶走或備份。代價：這台筆電大概只有一顆硬碟；首次啟動精靈要多一步讓使用者選資料夾（+2h）；選到含中文或 OneDrive 的路徑時要擋下來。
  4. **維持在 repo 的 `exam_pro` 底下**（不做 B2）：零工時。代價：B3 的安裝版就無法使用，因為程式資料夾會被更新替換；而且資料跟著 repo 走，git 操作失誤的風險一直都在。
- **建議**：**2**，資料夾名稱一律用英數字 `TutorExamBank`，app 的顯示名稱仍然可以是中文。`%LOCALAPPDATA%` 不會被 OneDrive 的「已知資料夾移動」同步（那個功能只移動桌面、文件、圖片）〔推論〕，所以資料庫放在這裡最安全；備份放在「文件」底下看得到，也方便另外複製。
- **何時**：B2 開工前。

### DA-2　關閉視窗時，背景工作怎麼辦

> 〔Owner 2026-09-27 選 3〕**定案**：看狀況。有工作在處理時按 X 縮到系統匣繼續跑並跳通知；沒有工作時直接結束；從系統匣選「結束」而有工作時，問「等處理完再結束／現在放棄」，對話框寫明重跑範圍（DA-13 定案要做檢查點：題目層從那個節點、拆題從沒完成的那一塊、變式從沒完成的那一題接著跑）。和 A 的 DL-1（Owner 選 1：每次問）一致。B1 照這個做（約 +4h，已在合計內）。

- **背景**：上傳考卷之後，拆題在後端的背景工作裡跑。本機模式下一份卷要跑幾十分鐘到幾小時：OCR 整理一塊（2 頁）就可能十幾到幾十分鐘，分類和驗算每題也要數分鐘。後端和視窗在同一個 app 裡，app 結束，工作就停。被中斷的工作下次開 app 會重跑，資料不會壞，也不會被算成一次失敗（2.3 節的做法），但已經跑的時間就白費了。**重跑點依工作而不同**（2.3 節第 4 點；第一版正式稿寫成一律「從那個節點的開頭重跑」，低估了代價）：
  - 分類、驗算等題目層的節點：從那個節點重跑。
  - 拆題：從**第 1 塊**整份重拆。6～8 頁的卷有 3～4 塊，後段被中斷可能白費一小時以上。
  - 變式：從第 1 題重新生成。

  DA-13 的逐塊檢查點可以把拆題與變式的損失縮到「只重跑被中斷的那一塊」。A 的啟動器有同一個問題（A 的待決事項 DL-1），兩邊的答案要一致。〔2026-09-27 更新：DA-13＝2 已實作（`dec/r7-checkpoints`），拆題改成從被中斷的那一塊重拆，變式只補還沒建成的題；上面兩點是實作前的行為。〕
- **問題**：按視窗右上角的 X 時要怎麼做？
- **選項**：
  1. **X 就是結束程式**，有工作在跑時先問「還有 N 份在處理，確定要結束嗎？」：最直覺。代價：不小心按到就會中斷長時間的工作；每次都要回答對話框。工時最少。
  2. **X 一律縮到系統匣**，要結束得從系統匣選「結束」，有工作時再問一次：這是 Docker Desktop、Slack 的做法，工作不會被誤關。代價：就算沒有工作，PostgreSQL 和後端也一直常駐（約數百 MB），Owner 可能以為已經關了。約 +2h。
  3. **看狀況**：有工作在處理時縮到系統匣繼續跑，並跳通知「還有 N 份在處理，程式縮到右下角繼續跑，處理完會通知你」；沒有工作時直接結束。從系統匣選「結束」且有工作時，會問「等處理完再結束／現在放棄」。放棄不算失敗，但對話框要寫明重跑點：「下次開 app 會接著做；拆題從沒完成的那一塊接著拆」（DA-13 已實作；文字直接用 A 的 `UNFINISHED_WORK_NOTE`，`exam_pro/scripts/desktop/lib/plan.js`，變式的說法是「只補還沒建成的題」）。代價：行為隨狀況改變，第一次要看懂通知。約 +4h（「放棄」本身的工時已算在第 3 條第 2 項）。
- **建議**：**3**。16 GB 的記憶體很吃緊（`local-mode.md` 10.14 (e) 的記憶體帳），沒事時就該把 PostgreSQL 和後端都關掉；有工作時被誤關的損失又太大（拆題後段被中斷，可能是一小時以上的 CPU 時間）。處理完的通知也順便解決「不知道什麼時候拆完」的問題。
- **何時**：B1 開工前。

### DA-3　後端跑在哪一個行程

> 〔Owner 2026-09-27 選 2〕**定案**：用 `utilityProcess.fork` 開後端；後端崩潰時主行程還在，顯示原因並自動重開。直接在主行程 `require` 保留當除錯的退路。B1 照這個做（+6h，已在合計內）。

- **背景**：後端是 Express，背景工作 runner 跑在同一個行程裡。拆題時 Node 端會做一些吃 CPU 的事：mupdf 用 WASM 同步把頁面渲染成圖、JSON 處理、jieba 分詞。Electron 的主行程負責視窗、系統匣和對話框；主行程一卡住，這些都會跟著卡。Electron 官方建議把吃 CPU、容易崩潰的元件放進 utility process（〔查證 S10、S11〕）。
- **問題**：`startServer()` 要在哪裡執行？
- **選項**：
  1. **直接在主行程 `require` 並執行**：最簡單，除錯最方便。代價：渲染頁面時系統匣和選單可能停頓；後端一崩潰整個 app 就關掉。
  2. **utilityProcess**（`utilityProcess.fork`，完整的 Node 環境，可以用原生模組，〔查證 S10〕）：後端崩潰時主行程還在，可以顯示錯誤、自動重開後端，視窗不必關；日誌也容易接到檔案。代價：+6h（環境變數傳遞、崩潰重開、日誌）。
  3. **`child_process.fork` 並設 `ELECTRON_RUN_AS_NODE`**：效果和 2 相近，是舊做法；官方現在推薦 utilityProcess。代價和 2 相當。
- **建議**：**2**。多花不到一天，換來「後端出事時視窗還在、看得到原因」。這和 2.3 節的模組化不衝突：同一個 `startServer()`，主行程要直接呼叫也可以，保留選項 1 當作除錯時的退路。
- **何時**：B1 開工前。

### DA-4　原生 PostgreSQL 由誰管理、什麼時候備份

> 〔Owner 2026-09-27 選 1〕**定案**：原生 PostgreSQL 由 app 管理（開 app 才啟動、結束 app 就停止，不裝 Windows 服務）。備份時機：每天第一次開啟（距上一份成功的備份超過 20 小時）、結束前（這次有寫入時）、migrate 前；工作排程器的 02:00「題庫每日備份」停用（4.2 節第 7 步）。

- **背景**：現在 PostgreSQL 在 Docker 裡，Docker Desktop 開著就一直在跑；每天 02:00 由工作排程器備份（借用容器裡的 `pg_dump`）。換成原生 PostgreSQL 之後，要決定它什麼時候開著。題庫只有在 Owner 使用系統時才會變動（上傳、複核、批改、組卷都在 app 裡）。
- **問題**：原生 PostgreSQL 要常駐嗎？備份什麼時候做？
- **選項**：
  1. **由 app 管理**：開 app 才啟動，結束 app 就停止。備份改由 app 做：每天第一次開啟時，距離上一份成功的備份超過 20 小時就先備份；結束前如果這次有寫入（比對 `pg_stat_database` 的寫入計數）再備份一次；migrate 前也一定備份（5.3 節）。工作排程器的 02:00 停用。命令列維護工具從系統匣的「維護命令列」執行。代價：不開 app 就連不到資料庫；結束時多幾秒。工時已算在 D2 的第 19、25 項。
  2. **裝成 Windows 服務**（`pg_ctl register`，開機就啟動，閒置時約數十 MB〔未查證〕）：行為和現在 Docker 常駐一樣，02:00 排程和命令列工具都照舊。代價：註冊服務要系統管理員權限；服務帳號（NetworkService）要能讀寫資料夾，權限要另外設；安裝檔要改成全機安裝。約 +6h。
  3. **沿用這台電腦已經裝好的 PostgreSQL 17 服務（5432）**：不用另外裝 PostgreSQL。代價：大版本從 16 跳到 17，和 CI（pg16 映像）不同；還是要編 17 版的 pgvector；那個服務原本是做什麼用的、密碼是什麼都不確定（`docker-compose.yml` 的註解只說它占著埠）；兩個用途共用一個服務，彼此牽制。
- **建議**：**1**。它讓「資料會變的時候就有備份」變成必然：資料只在 app 開著時才會變，而 app 開著時就會備份。常駐服務在 16 GB 的筆電上是多一個長期吃記憶體的東西，換來的只是「02:00 備份」這個已經沒必要的時段。命令列工具很少用，走維護命令列就夠了。
- **何時**：D2 開工前。

### DA-5　pgvector 的 Windows 二進位從哪裡來

> 〔Owner 2026-09-27 選 2〕**定案**：另開一支只能手動觸發（`workflow_dispatch`）的 GitHub Actions，在 Windows runner 下載同版的 EDB PG16 zip、編同版 pgvector，產出 zip 與 SHA-256（連同自己下載到的 EDB zip 的雜湊）當 artifact；`ci.yml` 不改。建議裡的退路（卡關超過半天改走 3、最後才 1）這次沒有另外答，要改走退路時再問 Owner。

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

> 〔Owner 2026-09-27 選 1〕**定案**：維持 git＋bundle，從 repo 啟動 Electron（5.1 節 U1）；不做自動更新（U3）。建議原本是「B1～D2 用 1、B3 起用 2」，這次的答案只選了 1：B3 的安裝檔做完之後要不要改成 U2（手動安裝檔覆蓋安裝），**B3 開工前再問 Owner 一次**；在那之前一律 U1。

- **背景**：現在用 git（或 bundle）更新 repo，再照 README 的步驟升級，包括備份、migrate、快照比對。app 化之後可以繼續這樣做，也可以改成安裝檔或自動更新。repo 是私有的。
- **問題**：app 化之後怎麼更新？
- **選項**：
  1. **維持 git 加 bundle，從 repo 啟動 Electron**（5.1 節 U1）：不必打包，和開發流程一致。代價：要有 Node 和 npm；更新時要記得跑 `npm ci`。零額外工時。
  2. **手動安裝檔**（U2）：在 Owner 的電腦上 build，雙擊覆蓋安裝，資料不受影響。代價：每次 build 要幾分鐘；需要 B3 的打包工作（已經算在 B3 裡）。
  3. **electron-updater 從私有 GitHub Releases 自動更新**（U3）：代價是 Owner 的電腦上要長期放一把能讀私有 repo 的 `GH_TOKEN`，官方明說不要寫進設定檔（〔查證 S5〕），舊版文件說私有 repo 只適用非常特殊的情況（〔查證 S6〕）；另外約 +1 人日。
- **建議**：B1～D2 用 **1**，B3 之後用 **2**，**不做 3**。只有一位使用者、一台電腦，自動更新省下的只是「雙擊一次安裝檔」；換來的是一把長期存在的 repo token。不論用哪種方式，升級時都一定走 5.3 節的「備份 → migrate → 快照比對」。
- **何時**：B3 開工前，B1 起先照建議執行。

### DA-7　Docker 是否完全移除（保留 D1 當備援？）

> 〔Owner 2026-09-27 選 2〕**定案**：Docker Desktop 保留安裝、不開機自動啟動，當 D1 備援；只在錄製、跑整合測試、回退時手動開。舊的 5442 volume 至少保留 30 天，刪除前再 dump 一次。前提照舊：DA-14 量完仍決定做 D2。

- **背景**：D2 之後，平常用 app 已經不需要 Docker。但 Docker 還有三個用途：
  - 錄製 cassette 的 `record_local.bat` 用 Docker 的 5433 測試庫，和 CI 同一顆 `pgvector/pgvector:pg16` 映像。
  - 在本機跑整合測試。
  - 萬一原生庫出問題時的回退。

  Docker Desktop 的 WSL2 虛擬機預設最多可以吃到實體記憶體的一半，可以用 `.wslconfig` 設上限（〔查證 S29〕，DA-14）；社群回報閒置時約 2.5～3 GB（〔查證 S31〕，非官方數字，沒有設上限）。它的 Resource Saver 在 WSL 2 上不會減少記憶體（〔查證 S30b〕）。「登入時自動啟動 Docker Desktop」的預設值是關閉（〔查證 S30〕），Owner 的電腦目前是否打開〔要實測〕。
- **問題**：D2 之後，Docker Desktop 要怎麼處理？
- **選項**：
  1. **完全解除安裝**：省磁碟、省記憶體，開機也比較快。代價：`record_local.bat` 和本機整合測試要改成用原生測試庫，這違反「錄製工具不變」的原則，也讓錄製環境和 CI 從此不同（排序規則等，R-3）；回退舊庫時要重新安裝 Docker。改錄製工具約 +1 人日。
  2. **保留安裝，但不開機自動啟動，平常不開（D1 當備援）**：正式庫用原生；只有錄製、跑整合測試、回退時才手動開。舊的 5442 volume 至少保留 30 天，刪除前再做一次 dump。代價：
     - 切換時一定要讓 `docker compose up` 不再帶起舊庫（第 3 條第 19、23、24 項，約 3～4h，已算在 D2）。否則錄製或 `啟動資料庫.bat` 會讓舊庫在 5442 復活，變成兩份正式庫（R-19）。第一版正式稿把這個選項寫成「零工時」，不對。
     - 磁碟空間還在；要記得錄製前先開 Docker（`record_local.bat` 本來就會檢查並提示）。
  3. **暫時不搬**（只做 B，資料庫繼續用 Docker，由 app 代開）：零風險，也不必做舊庫防護。代價：Docker Desktop 要常駐，開機要等它；它開著時的記憶體上限預設是 8 GB，照 DA-14 設上限可以壓低，但壓不到零；D2 延後。
- **建議**：**2**，前提是 DA-14 量測之後仍決定做 D2。記憶體的效益在平常使用時就拿到了；錄製和 CI 維持同一顆映像，「在我電腦上會過」這一整類問題不會回來（`ci.yml` 的註解）；回退路線隨時都在。如果 DA-14 量出來 Docker 在上限下已經吃得很少，選 3 也合理。
- **何時**：D2 搬家前（第 4.2 節第 7 步）。

### DA-8　Gemini 金鑰怎麼保管

> 〔Owner 2026-09-27 選 1〕**定案**：金鑰照舊以明文寫在 `.env`，但這份 `.env` 搬到 `%APPDATA%\TutorExamBank\.env`（確認不在 OneDrive 同步範圍、不打包進備份）。建議裡「重新啟用 Gemini 時改 2（`safeStorage`）」這一半這次沒有答，屆時再問。

- **背景**：Gemini 的金鑰現在以明文寫在 `exam_pro\.env`，但本機模式之後系統預設不用 Gemini（預付額度已經用完），所以金鑰可能是空的。app 化之後 `.env` 會搬到 `%APPDATA%`。Electron 內建的 `safeStorage` 在 Windows 上用 DPAPI 加密：可以擋住同一台電腦的其他使用者，但擋不住同一個使用者身分下的其他程式；而且要等 app 就緒後才能使用（〔查證 S17〕）。
- **問題**：金鑰要怎麼存？
- **選項**：
  1. **照舊以明文寫在 `.env`**，只是換了位置（`%APPDATA%\TutorExamBank\.env`），並確認這個資料夾不在 OneDrive 同步範圍內、也不會被打包進備份：零工時。代價：任何能讀這個檔案的人或程式都拿得到。
  2. **用 `safeStorage`（DPAPI）加密保存**：在設定畫面輸入，主行程解密後只放進後端行程的環境變數；`.env` 裡不再寫這一行。代價：約 +6h（設定畫面、遷移既有的值）；網頁版（`npm start`）讀不到加密的值，要另外設。
  3. **完全不存**：每次要用 Gemini 時在畫面上貼上，只放在記憶體裡。代價：每次重開 app 都要再貼一次；背景工作在夜間重試時會拿不到金鑰。
- **建議**：先用 **1**，**等 Owner 決定重新啟用 Gemini 時改成 2**。現在沒有在用，花一天保護一把空的金鑰不划算；一旦要用，金鑰會帶來真實的費用，就值得加密，也可以一併處理擱置區第 5 項（備份加密）。
- **何時**：B2 開工前（決定 `.env` 的位置時）。

### DA-9　要不要簽章

> 〔Owner 2026-09-27 選 1〕**定案**：不簽章，只在 Owner 的電腦上 build 與安裝。**前提是 Smart App Control 關閉，尚待 Owner 確認**：第 10 節的 `wsl_memory_check.bat` 會讀出 SAC 的狀態（`Get-MpComputerStatus` 與登錄值）；讀出來是開啟或評估模式時，先不要改，回到本題重新選（10.4 節；建議 4：關掉 SAC）。下面選項 1 與建議裡的「或評估模式下沒有擋」是答覆前的原文，以這段定案為準。

- **背景**：
  - 從網路下載、帶有「網路標記」的程式，執行時 SmartScreen 會依信譽決定要不要警告；沒有信譽的檔案會跳警告（〔查證 S32、S34〕）。微軟的簽章選項說明把「不簽章」列為 SmartScreen 會強烈攔截、不建議公開散布（〔查證 S35〕）。
  - 2024 年起，EV 憑證不再能直接略過 SmartScreen，和 OV 一樣要慢慢累積信譽；微軟自己說只為了避開 SmartScreen 而多付 EV 的錢（每年 400 美元以上）已經不值得（〔查證 S33、S35〕）。
  - 微軟的 Artifact Signing（原名 Trusted Signing，約每月 9.99 美元）目前只開放美國、加拿大、歐盟、英國的組織，個人開發者只限美國和加拿大（〔查證 S35〕；另見 S37，微軟問答區 2026-03 的回答說個人開發者的新申請已暫停）；Owner 在台灣，以個人身分用不了。
  - 在自己電腦上 build 出來的檔案沒有網路標記，〔推論〕不會觸發 SmartScreen 的信譽檢查；Defender 的特徵掃描則照常進行。
  - **Windows 11 的 Smart App Control（SAC）是另一回事**（第一版正式稿漏了）：
    - 它不看網路標記。微軟的 app 信譽服務無法預測安全性的 app 與二進位檔，只有帶「Trusted Root Program 內的 CA 簽發的憑證」簽章才放行（〔查證 S45〕）。
    - 已有 Electron 專案回報：本機 build 出來、沒有簽章的 exe 被 SAC 擋下（〔查證 S45b〕）。
    - electron-builder 會替 `electron.exe` 改名並改資源，原本的簽章不會留下〔推論〕。U1 期間從 repo 跑的 `electron.exe`、DA-5 選項 2 自己編的 `vector.dll` 會不會被擋〔未查證〕。
    - 微軟的說明寫到，SAC 先以評估模式執行；判斷它會常常打擾這位使用者時，就自動關掉（〔查證 S45〕）。Owner 的電腦長期跑開發工具，可能已經被關掉，但要實際看。
    - 2026-04 的累積更新 KB5083769 之後，SAC 可以在「Windows 安全性」裡隨時開關；在那之前，關掉就要重灌才能再打開（〔查證 S45c〕，第三方整理的微軟說明）。
    - Owner 的電腦上 SAC 是開、評估還是關〔要實測：「Windows 安全性 → 應用程式與瀏覽器控制 → Smart App Control」〕。
- **問題**：安裝檔和 exe 要不要簽章？
- **選項**：
  1. **不簽章，只在 Owner 的電腦上 build 和安裝**：零成本。**前提：SAC 是關閉的**，或評估模式下沒有擋。代價：解除安裝的清單和檔案內容裡顯示「未知的發行者」；萬一 Defender 誤判，要手動放行（R-5）。
  2. **自簽憑證**，並匯入 Owner 電腦的信任存放區：顯示得出發行者名稱。代價：約 2h；對 SmartScreen 的信譽沒有幫助；憑證的私鑰要自己保管；自簽憑證不在 Trusted Root Program 裡，SAC 開著時〔推論〕沒有用。
  3. **購買 OV 或 EV 程式碼簽章憑證**：換到另一台電腦或給別人用時，信譽可以慢慢累積；是 Trusted Root Program 的 CA 簽發的，SAC 開著時也放行（〔查證 S45〕）。代價：每年要付費，OV 約 150～300 美元、EV 400 美元以上（〔查證 S35〕）；每次 build 都要簽；EV 也不能直接略過 SmartScreen（〔查證 S33、S35〕）；給別人用會碰到 mupdf 的 AGPL（R-12）。微軟的 Artifact Signing 個人只開放美、加，Owner 用不了（背景第 3 點）。
  4. **SAC 開著時，把它關掉**，然後照選項 1：零成本，約 5 分鐘。代價：少一層「擋下不認識的程式」的防護；Owner 的 Windows 還沒裝 KB5083769 的話，關掉之後要重灌才能再打開（〔查證 S45c〕）。
- **建議**：**先看 SAC 的狀態**。
  - 關著（或評估模式下沒有擋）：選 **1**。只有一位使用者、在同一台電腦上 build 和安裝，簽章要解決的「陌生人下載後信不信任」問題根本不存在。將來真的要給別人用，要先處理的是 AGPL 授權（擱置區第 7 項），不是簽章。
  - 開著：建議 **4**。Owner 的電腦本來就在跑 Node 的原生模組、PaddleOCR 與 Docker 這類開發工具；為了一個自用的 app 每年付 150～300 美元，還要每次 build 都簽，不划算。不想降低防護，就選 **3**。
- **何時**：SAC 的狀態 B1 開工前就要看，因為 U1 的 `electron.exe` 也可能被擋；選項在 B3 開工前定。

### DA-10　什麼時候搬家（D2 正式切換）

> 〔Owner 2026-09-27 選 2〕**定案**：B2 完成、D2 演練通過之後，挑一個沒有重錄、當週也沒有要上傳考卷的空檔搬家。前提照舊：DA-14 量完仍決定做 D2。

- **背景**：搬家要停止寫入約 30～45 分鐘（4.5 節），而且前後要做快照比對。目前還有重錄在排程上（`local-mode.md` 10.21），重錄會跑一整天、吃滿 CPU 和記憶體；上傳考卷也會寫入正式庫。這一題的前提是 DA-14 量測之後仍決定做 D2。
- **問題**：D2 的正式切換要挑什麼時候做？
- **選項**：
  1. **準備好就立刻搬，不等 B**：先由 A 的啟動器改去開原生 PostgreSQL（〔推論〕，約 +0.5 人日），早點拿到記憶體的效益。代價：B2 還沒做完，路徑還在 repo 裡，之後 B2 還要再搬一次檔案（資料庫不必再搬）。
  2. **B2 完成、演練通過之後，挑一個沒有重錄、當週也沒有要上傳考卷的空檔**，例如週末早上：路徑已經穩定，只搬一次。代價：記憶體的效益要等比較久。
  3. **等 B3 的安裝檔完成，安裝和搬家同一天做**：一次到位。代價：一天之內變動太多，出問題時難判斷是安裝還是搬家造成的；效益最晚拿到。
- **建議**：**2**。一次只換一件事（先換路徑，再換資料庫，最後換安裝方式），每一步都有自己的驗收和回退路線；避開重錄，是為了讓比對和計時都可信。
- **何時**：D2 演練通過之後。

### DA-11　要不要保留區網存取（網頁版）

> 〔Owner 2026-09-27 選 1〕**定案**：桌面版（B）只綁 `127.0.0.1`；網頁版改用 `HOST` 設定、預設 `127.0.0.1`。**網頁版這一半已實作**（分支 `dec/r7-decisions-host`）：`exam_pro/config/listenHost.js`＋`server.js` 的 `app.listen(PORT, HOST)`；A 的啟動器、關閉捷徑與 `/api/health` 的本機判斷用同一套規則（`HOST` 只聽某個區網位址、或 `127.0.0.1` 以外的 `127.x` 時，app 視窗的 `http://localhost` 連不到，啟動器停下說明）；`.env.example`、`exam_pro/README.md`「區網存取」、`deployment_and_operations.md` §3.2、§4.1 寫明要區網存取時設 `HOST=0.0.0.0`，並處理防火牆（只允許私人網路）、`ALLOWED_ORIGINS` 與 `API_KEY`。要在課堂穩定用平板，仍照建議走 Tailscale 加 HTTPS。

- **背景**：
  - `npm start` 目前綁在所有網路介面（`server.js`），同一個 Wi-Fi 裡的平板或手機**可能**打得開題庫（〔2026-09-27〕已改成預設只聽 `127.0.0.1`，見本題開頭的定案）。實際能不能連，還要看 Windows Defender 防火牆：`node.exe` 第一次監聽所有網路介面時，Windows 會跳出是否允許存取的對話框，當時的選擇決定了輸入規則〔要實測：「控制台 → Windows Defender 防火牆 → 允許應用程式通過」看 Node.js 那一列〕。
  - 金鑰會注入首頁，所以它不是存取控制（擱置區第 8 項）。
  - 在非 HTTPS 的區網位址下，瀏覽器不會開放麥克風（`public/js/tutor.js:157-168`）。
  - 2026-09-24 的 gap analysis 曾建議：要在課堂上用平板時，改走 Tailscale 取得 HTTPS。
- **問題**：桌面版的後端要不要開放區網連線？網頁版要不要一起收緊？
- **選項**：
  1. **桌面版只綁 127.0.0.1**；網頁版的綁定位址另外決定，可以選維持現狀，也可以改成用 `HOST` 環境變數設定、預設 127.0.0.1（約 1h）：最安全。代價：要用平板時得另外開網頁版，或走 Tailscale。
  2. **桌面版在設定裡提供「區網模式」**：綁 0.0.0.0，而且一定要設密碼（Basic Auth，或不把金鑰注入首頁、改用登入頁），`ALLOWED_ORIGINS` 加上區網位址。代價：約 1～1.5 人日；區網下麥克風仍然不能用；要多維護一套登入邏輯。
  3. **維持現狀**（網頁版綁所有網路介面、沒有密碼）：零工時。代價：防火牆放行 Node.js 時，同一個網路裡的任何人都能打開題庫和學生資料。
- **建議**：**1**，網頁版也改成預設 127.0.0.1；要用平板時再照 gap analysis 走 Tailscale 加 HTTPS。桌面版本來就不需要被別台機器連。網頁版目前能不能從同一個網路打開，取決於當初防火牆對話框的選擇，Owner 可能沒意識到這件事（資料庫早就只綁 127.0.0.1，網頁伺服器還沒有）。改成只綁本機之後，就不必依賴防火牆的設定。
- **何時**：B1 開工前。網頁版的部分可以提早放進 A 一起做。

### DA-12　原生庫的 locale（排序規則）

> 〔Owner 2026-09-27 選 2〕**定案**：原生庫用 ICU（`initdb`／`createdb` 帶 `--locale-provider=icu --icu-locale=<值>`）。建議原本是「演練時比對後再定」，Owner 直接定 ICU。`--icu-locale` 的值與 Docker 庫（glibc `en_US.utf8`〔推論〕）的排序差異，在 D2 第 0 步演練時照 4.3 節最後一列比對並記錄；影響只到排序與 `ILIKE` 的速度（R-3）。

- **背景**：Docker 的 PostgreSQL 用 Linux 的 locale，原生庫用 Windows 或 ICU 的 locale，兩者對中文的排序可能不同。受影響的有：學生名單的順序、分類時例題的排列順序，以及 pg_trgm 能不能替中文建三字組索引，這一項只影響 `ILIKE` 的速度，不影響結果（R-3）。**CI 和 cassette 不受影響**：CI 仍用 Linux 映像，cassette 的鍵也和順序無關。Windows 上 UTF-8 可以搭配任何 locale（〔查證 S24〕）。
- **問題**：initdb 和 createdb 要用哪一種 locale？
- **選項**：
  1. **`--locale=C`**：和作業系統無關，按位元組排序，行為最可預測。代價：中文按編碼順序排，不是按筆畫或注音；pg_trgm 可能完全抽不出中文三字組，`ILIKE` 用不到索引（〔推論〕），題量小時感覺不到。
  2. **ICU**（`--locale-provider=icu --icu-locale=<候選>`）：跨平台一致，Unicode 定序。代價：和 Docker 的 glibc 排序可能仍有細節差異；pg_trgm 的字元分類仍看 `LC_CTYPE`〔推論〕。
  3. **Windows 的 locale**（例如 `English_United States` 或 `Chinese (Traditional)_Taiwan`）：最接近這台電腦的慣例。代價：行為依 Windows 版本而定，換電腦就可能不同。
- **建議**：**演練時比對後再定**。第 0 步三種各建一個庫，比對 4.3 節最後一列（章名排序、學生名排序、`show_trgm`），選「和 Docker 庫最接近、而且 `show_trgm` 抽得出中文」的那一種。三種都差不多時選 2，因為它最不依賴作業系統。這一題沒有實測資料就定，只會是猜測。
- **何時**：D2 第 0 步的演練時。

### DA-13　要不要做拆題與變式的逐塊檢查點

> 〔Owner 2026-09-27 選 2〕**定案**：拆題逐塊、變式逐題的檢查點都做（第 3 條第 36 項，約 5～7h，已在 B1 的合計內；也可以更早做，網頁版一樣受益）。這次沒有實作。

- **背景**：放棄、當機、斷電、Windows 更新重開機，或 `npm start` 的視窗被關之後，拆題 job 會從第 1 塊整份重拆（`runExtractJob` 每次都從頭跑，`workers/jobRunner.js:1311`），變式 job 會從第 1 題重新生成（`:1540`）。本機模式一塊 2 頁、每塊可能數十分鐘；6～8 頁的卷在後段被中斷，白跑的時間可能超過一小時。重拆出不同的題數或編號時，還可能多出重複的題目列（2.3 節第 4 點）。這不是桌面版才有的問題，今天的網頁版一樣；桌面版的「放棄」（DA-2）只是讓它多一種觸發方式。
- **問題**：要不要讓拆題與變式從「還沒完成的那一塊或那一題」接著跑？
- **選項**：
  1. **不做**：維持現況。零工時。代價：如上，中斷得越晚，損失越大。
  2. **拆題逐塊、變式逐題都做**（第 3 條第 36 項）：拆題在跑每一塊之前，查這份 job 有沒有同一個頁碼範圍已經 `pass` 或 `skipped` 的 extract 事件，有就跳過；變式跳過 `job_questions` 已經有那個 idx 的題。約 5～7h，放在 B1（也可以更早做，網頁版一樣受益）。代價：
     - 改的是 runner 的核心迴圈。
     - 「失敗後按重試」也會跟著變成從沒完成的塊接著跑，而不是今天的整份重拆。多數時候這是好事，但行為確實變了。
     - 既有整合測試對重試後事件數的斷言要逐一確認〔要查〕。
  3. **只做拆題**：約 4～6h。代價：變式照舊從第 1 題重來。變式一份通常只有幾題，損失較小。
- **建議**：**2**。DA-2 選 3 之後，「按錯 X」的情形已經擋掉了；真正會觸發重跑的，多半是當機、斷電、Windows 更新重開機這類沒得選的中斷。筆電上一份卷就要拆一整個下午，被中斷一次就可能白費一小時以上。多花不到一天，網頁版也一起受益。
- **何時**：B1 開工前，和 DA-2 一起定。

### DA-14　要不要先限制 WSL 的記憶體，量完再決定 D2 做不做

> 〔Owner 2026-09-27 選 1〕**定案**：Owner 自己在 `%UserProfile%\.wslconfig` 設 `[wsl2] memory=3GB`、`[experimental] autoMemoryReclaim=dropCache` 並量測。步驟、**什麼時候不可以 `wsl --shutdown`**、閒置／上傳／重錄三種情況的檢查工具 `wsl_memory_check.bat`，都在第 10 節。D2 做不做，等量測結果再定。

- **背景**：
  - D2 的主要效益是記憶體：不開 Docker Desktop，就沒有 WSL2 虛擬機。但 D2 要約 48～57h 的開發，加上 Owner 2～3 小時的演練與搬家。
  - Docker 自己的 Resource Saver 在 WSL 2 上不省記憶體，Docker 的文件改建議開 WSL 的 `autoMemoryReclaim`（〔查證 S30b〕）。
  - 微軟的 `.wslconfig` 有兩個相關設定（〔查證 S29〕）：
    - `[wsl2] memory=`：虛擬機的記憶體上限，預設是 Windows 總記憶體的 50%，這台是 8 GB。
    - `[experimental] autoMemoryReclaim`：`disabled`／`gradual`／`dropCache`。文件寫現行預設是 `dropCache`（立刻歸還快取）；Owner 的 WSL 版本是不是已經用這個預設〔要實測：`wsl --version`〕。
  - 題庫的資料只有約 1 MB（2026-09-25 的備份 0.99 MB），兩個 PostgreSQL 容器本身用不到多少記憶體〔推論〕。
  - 第一版正式稿第 0 條寫「要拿回記憶體，只能讓 Docker Desktop 不要開著」，講過頭了，也讓 D2 少了一個便宜的比較對象。
  - B1、B2 期間（可能好幾週）Docker 本來就要開著，上限在這段期間就有用。
- **問題**：要不要先在 `.wslconfig` 設上限並量測，再決定 D2 值不值得做？
- **選項**：
  1. **現在就設上限並量測**：在 `%UserProfile%\.wslconfig` 寫 `[wsl2]` 底下 `memory=3GB`，`[experimental]` 底下 `autoMemoryReclaim=dropCache`（明寫，不依賴版本的預設）。結束 Docker Desktop，執行 `wsl --shutdown`，再開 Docker Desktop（〔查證 S29〕：改了要重開 WSL 才生效）。在工作管理員記三組數字：Docker 開著閒置時、上傳一份卷時、重錄時的 `vmmem`（或 `VmmemWSL`）與「使用中」的記憶體。D2 開工前依結果決定。代價：
     - 約 0.5h，Owner 自己做。
     - Docker Desktop 仍要常駐，開機仍要等它。
     - 上限對這台電腦上所有 WSL 發行版都有效。
     - 設太低時，重錄或拉映像可能失敗，調高到 4GB 再試〔要實測〕。
  2. **不設，直接照計畫做 D2**：零工時。代價：D2 的效益沒有可比的基準；B1、B2 期間 Docker 照舊最多可以吃到 8 GB。
  3. **設上限，而且不做 D2**：省下 D2 的 48～57h 與 Owner 的搬家時間，也不必做舊庫防護。代價：
     - Docker Desktop 永遠要開。
     - B3 的安裝版仍依賴 Docker Desktop 與 repo 裡的 compose 檔，B3 要另外設計（例如只支援從 repo 跑，也就是 U1），第 6 條的分期要重排。
- **建議**：**1**。半小時換一個真實的數字，D2 值不值得做，就不必再靠社群回報的 2.5～3 GB（〔查證 S31〕，沒有設上限）來猜。B1、B2 期間本來就要開 Docker，上限在這段期間就能省記憶體。量出來如果 `vmmem` 在上限下只剩幾百 MB，D2 的效益就只剩「開機不必等 Docker、少一個常駐程式」，那時再考慮選 3。
- **何時**：現在就能做（A 期間）；D2 開工前看量測結果定案。

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
| S29 | `.wslconfig`：`[wsl2] memory` 是 WSL 2 虛擬機的記憶體上限，預設是 Windows 總記憶體的 50%；`[experimental] autoMemoryReclaim` 可設 `disabled`／`gradual`／`dropCache`，預設 `dropCache`（快取立刻歸還）；改了可能要 `wsl --shutdown` 才生效 | https://learn.microsoft.com/en-us/windows/wsl/wsl-config |
| S30 | Docker Desktop 設定：WSL 2 下的記憶體上限在 `.wslconfig` 設；「Start Docker Desktop when you sign in」預設關閉 | https://docs.docker.com/desktop/settings-and-maintenance/settings/ |
| S30b | Resource Saver：預設開啟、閒置 5 分鐘啟動；在 WSL 2 上只暫停 `docker-desktop` 發行版裡的引擎，「does not reduce Docker's memory utilization」；要降記憶體，改建議開 WSL 的 `autoMemoryReclaim` | https://docs.docker.com/desktop/use-desktop/resource-saver/ |
| S31 | 社群回報 Docker Desktop 閒置時約 3 GB、vmmem 約 2.5 GB（非官方數字） | https://forums.docker.com/t/docker-desktop-idle-memory-usage/138540 |
| S32 | SmartScreen：沒有信譽的檔案或 app 會被標成較高風險並跳警告 | https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/ |
| S33 | EV 憑證不再保證能避開 SmartScreen 警告 | https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings |
| S34 | 網路標記（Mark-of-the-Web）與 SmartScreen 的關係 | https://textslashplain.com/2016/04/04/downloads-and-the-mark-of-the-web/ |
| S35 | 微軟〈Code signing options for Windows app developers〉：沒信譽的新檔案會跳 SmartScreen 警告；EV 的自動信任 2024 年取消，只為避開 SmartScreen 付 EV 的錢（每年 400 美元以上）不值得；OV 每年約 150～300 美元（依 CA 與等級）；不簽章會被強烈攔截、不建議公開散布；Artifact Signing 約每月 9.99 美元，組織限美、加、歐盟、英國，個人限美、加。這一頁只談 SmartScreen，沒有談 Smart App Control | https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options |
| S36 | `electron-v44.4.5-win32-x64.zip` 的大小是 158,184,819 bytes（2026-09-27 以 HEAD 請求取得 Content-Length） | https://github.com/electron/electron/releases/download/v44.4.5/electron-v44.4.5-win32-x64.zip |
| S37 | 微軟問答區（2026-03-06）：Trusted Signing 的個人身分只開放美國與加拿大，其他地區的個人申請暫停（回答是自動產生的，只當補充） | https://learn.microsoft.com/en-nz/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident |
| S38 | npm registry（2026-09-27）：`electron` latest 44.4.5、`electron-builder` latest 26.15.3、`electron-updater` 6.8.9 | https://www.npmjs.com/package/electron 、https://www.npmjs.com/package/electron-builder 、https://www.npmjs.com/package/electron-updater |
| S39 | 官方 postgres 映像（16）的 Dockerfile：產生 `en_US.UTF-8` 並設 `ENV LANG en_US.utf8` | https://github.com/docker-library/postgres/blob/master/16/bookworm/Dockerfile |
| S40 | pgvector 的 Dockerfile：`FROM postgres:$PG_MAJOR-$DEBIAN_CODENAME` | https://github.com/pgvector/pgvector/blob/master/Dockerfile |
| S41 | libuv `src/win/process.c`：非 detached 的子行程放進設了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job，「if this process exits it is closed and all the processes it contains are killed」；同時設 `SILENT_BREAKAWAY_OK`，所以子行程再開的行程不受影響 | https://github.com/libuv/libuv/blob/v1.x/src/win/process.c |
| S42 | MDN〈Origin〉：跨來源請求都帶 `Origin`；同源請求除了 GET、HEAD 以外也都帶 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin |
| S43 | GitHub Actions 標準 runner 每分鐘價格：Linux 2 核 0.006 美元、Windows 2 核 0.010 美元、macOS 0.062 美元 | https://docs.github.com/en/billing/reference/actions-minute-multipliers |
| S44 | CPython 的 venv 轉導器：`run_child` 建一個設了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（與 `SILENT_BREAKAWAY_OK`）的 job，把真正的直譯器放進去（3.12 在 `PC/launcher.c`，以 `VENV_REDIRECT` 編成轉導器；main 分支拆成 `PC/venvlauncher.c`） | https://github.com/python/cpython/blob/3.12/PC/launcher.c 、https://github.com/python/cpython/blob/main/PC/venvlauncher.c |
| S44b | Python `venv` 文件：3.7.2 起 Windows 的 `python[w].exe` 用轉導器取代複製的直譯器；venv「Not considered as movable or copyable」、「inherently non-portable」，要搬就在新位置重建 | https://docs.python.org/3/library/venv.html |
| S45 | 微軟〈Smart App Control〉開發者說明：app 信譽服務無法預測時，只有 Trusted Root Program 內 CA 簽發的憑證簽章才放行；有評估、開啟、關閉三種狀態；判斷會常打擾使用者時自動關閉 | https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview |
| S45b | Electron 專案的 issue：「Smart App Control blocks locally built Hermes Desktop executable as unsigned」（本機產生的 `win-unpacked` exe 因為無法驗證發行者被擋） | https://github.com/NousResearch/hermes-agent/issues/70544 |
| S45c | 第三方整理：2026-04-14 的 KB5083769（組建 26100.8246／26200.8246）之後，SAC 可以在「Windows 安全性」裡隨時開關，不必重灌（引用微軟的 SAC 常見問題；微軟支援頁在這個環境回 403，沒能直接讀） | https://blog-en.topedia.com/2026/04/smart-app-control-in-windows-11-can-now-be-re-enabled-without-reinstalling/ |
| S46 | Docker Compose：沒有 `profiles` 的服務一律啟用；可用 `--profile` 或 `COMPOSE_PROFILES` 啟用 profile；明確指定服務名時不必先啟用它的 profile。預先定義的環境變數（含 `COMPOSE_PROFILES`）可以用工作目錄的 `.env` 設定（文件沒有逐項寫明，要實測） | https://docs.docker.com/compose/how-tos/profiles/ 、https://docs.docker.com/compose/how-tos/environment-variables/envvars/ |
| S47 | VS Code 的 `code.cmd`：`set ELECTRON_RUN_AS_NODE=1` 後用 app 的 exe 執行 `resources\app\out\cli.js`（它的 app 不在 asar 裡） | https://github.com/microsoft/vscode/blob/main/resources/win32/bin/code.cmd |
| S48 | Electron fuses：`runAsNode` 預設開啟，決定是否理會 `ELECTRON_RUN_AS_NODE`；關掉時 `child_process.fork` 會丟錯，建議改用 utility process | https://www.electronjs.org/docs/latest/tutorial/fuses |
| S49 | Electron asar：外部程式要讀的檔要用 unpack 放在 `app.asar.unpacked`；asar 裡的二進位只能用 `execFile` 執行；文件沒寫 run-as-node 模式能不能讀 asar | https://www.electronjs.org/docs/latest/tutorial/asar-archives |
| S50 | bsdtar 手冊：`-a` 依副檔名決定格式，`tar -a -cf archive.zip …` 產生 zip；微軟：Windows 10 build 17063 起內建 bsdtar 的 `tar` | https://man.freebsd.org/cgi/man.cgi?query=bsdtar 、https://devblogs.microsoft.com/commandline/tar-and-curl-come-to-windows/ |

另外引用了兩份專案文件（不是網路來源）：`local-mode-status-2026-09-25`（OCR 自檢 121 秒、2026-09-25 備份檔 0.99 MB、198 題）與 `owner-decisions-2026-09-26`（第四輪 V3：本機模式逾時只重試 1 次）。

**查不到或不確定的事**（實作時要補）：

| 事項 | 狀態 | 什麼時候確認 |
|---|---|---|
| EDB 壓縮檔的實際大小與 contrib 的內容 | 下載點被這個環境的代理擋下。已知：EDB 說 zip 就是安裝程式裝的檔案（S18），16.1 的 zip 約 330 MB（S18c）。contrib 在不在〔推論〕在 | D2 第 0 步解壓後 |
| conda-forge 上 postgresql 16.15 的 win-64 套件 | 網頁清單沒列出；〔推論〕存在，因為 win-64 的 pgvector 就是對 libpq 16.15 建的（S21b） | 選 DA-5 的 3 時用 `micromamba search` |
| Visual Studio Build Tools 的確切大小 | 查不到可靠數字 | 選 DA-5 的 1 時 |
| Electron 的實際記憶體用量 | 沒有可靠的官方數字 | B1 冒煙測試時在工作管理員記錄 |
| Owner 電腦上 Smart App Control 的狀態；它會不會擋 U1 的 `electron.exe` 與自編的 `vector.dll` | 狀態只能在 Owner 的電腦上看（〔2026-09-27〕`wsl_memory_check.bat` 讀得出來，第 10 節）；後兩者沒查到文件（S45 只說未簽章又沒有信譽的會被擋） | 狀態：B1 開工前（DA-9 定案選 1 的前提）；後兩者：B1、D2 的冒煙測試 |
| Owner 的 WSL 版本、`autoMemoryReclaim` 的實際預設，以及設了上限之後 Docker 的實際記憶體 | 微軟文件寫現行預設是 `dropCache`（S29），舊版可能不同；〔DA-14 定案〕`.wslconfig` 明寫 `dropCache`，不依賴預設 | DA-14（`wsl_memory_check.bat` 記下 `wsl --version`、`.wslconfig`、vmmem，第 10 節） |
| Compose 從專案的 `.env` 讀 `COMPOSE_PROFILES` 的實際行為 | 文件只寫「`.env` 可以設預先定義的變數」，沒有逐項寫明（S46） | D2 第 0 步第 4 點、第 6 步第 4 點 |
| 原生庫與 Docker 同時要聽 `127.0.0.1:5442` 時，是報錯還是兩邊都聽得到 | 沒查；README 記過 5432 上「先啟動的那個吃掉連線」 | 有第 3 條第 23 項之後不該發生；回退時照 4.4 節的順序 |
| Electron run-as-node 模式能不能讀 asar 裡的腳本 | 文件沒寫（S49） | B3 驗收第 9 點 |
| Windows 內建 `tar` 實際產出的 zip | bsdtar 手冊有 `-a`（S50），Windows 版沒實測 | D2 實作第 19 項時 |
| 從 Node 以 pipe 方式執行 `pg_ctl start` 會不會讓 `'close'` 等不到 | 〔推論〕，沒實測 | D2 實作第 25 項時（直接用 `'ignore'`，不必等結果） |
| 空值的環境變數在 Windows 的環境區塊裡能不能保留 | 沒查 | B2 實作第 21 項時 |
| Node.js 在 Windows Defender 防火牆的輸入規則 | 只能在 Owner 的電腦上看。〔DA-11 定案〕預設只聽 127.0.0.1，平常不必看；設 `HOST=0.0.0.0` 時照 `exam_pro/README.md`「區網存取」確認只允許私人網路 | ~~DA-11 決定前~~ 設 `HOST=0.0.0.0` 時 |
| Blob 下載時 Electron 另存新檔對話框預填的檔名 | 文件沒寫（S14） | B1 手動驗收第 2 點 |
| 後端結束、連線中斷時，Ollama 會不會立刻停止生成 | 沒查到文件 | B1 驗收「放棄」時觀察 Ollama 的 CPU |
| Electron 主行程結束時，utility process 會不會一起結束 | 文件沒寫（S10） | B1 驗收第 5 點 |
| `@node-rs/jieba` 能不能用 npm 的 `--os`／`--cpu` 旗標跨平台安裝 | 沒查 | 只有要在 Linux 上打 Windows 包時才需要 |
| Owner 的 Windows 帳號是不是內建的 Administrator、Owner 電腦上的 Node 小版本、PG17 的 `bin` 在哪裡、Docker Desktop 是否設為登入時啟動 | 只能在 Owner 的電腦上看 | B1 開工前 |
| Docker 庫實際的 pgvector 版本與 collation | 只能在 Owner 的電腦上查（〔推論〕是 `en_US.utf8`，S39、S40） | D2 第 0 步 |

---

## 10. Owner 手動操作：WSL 記憶體上限（DA-14）與 Smart App Control（DA-9）

> 〔2026-09-27，Owner 第六輪 DA-14＝1、DA-9＝1〕這一節給 Owner 照著做，**全部由 Owner 自己在自己的電腦上操作**；AI 不在任何電腦上執行這些步驟。
> 檢查工具 `exam_pro\scripts\windows\wsl_memory_check.bat` **只讀取與記錄**：讀 `.wslconfig`、記憶體、Docker Desktop（含 `docker info` 的總記憶體）與 Ollama 的狀態、Smart App Control，不改任何設定、不執行 `wsl --shutdown`、不開關任何程式，所以重錄或上傳進行中也可以跑。它要等 2026-09-27 這一輪重錄跑完、合併之後才會出現在 Owner 的電腦上；**重錄進行中不要為了拿它而更新 repo**（10.3 節）。

### 10.1 先記住：什麼時候**不可以** `wsl --shutdown`

`wsl --shutdown` 會把整個 WSL 虛擬機關掉。Docker Desktop 跑在裡面，所以**正式庫（5442）與測試庫（5433）會一起被切斷**。

- **重錄進行中（`record_local.bat`、`cassettes:rerecord`）不可以**：測試庫放在記憶體裡（tmpfs），一切斷，錄到一半的東西全部作廢，重錄要從頭再跑（8～12 小時）。
- **上傳考卷、拆題、變式生成進行中不可以**：後端連不到資料庫，進行中的工作會失敗或整份重跑。
- 平常組卷、批改時也會被切斷一次；10.2 節全部做完約 5～10 分鐘，挑沒在用系統的時候做。

動手之前確認兩件事都沒有在跑：

1. **重錄**：錄製的視窗已經關掉；或跑一次 `wsl_memory_check.bat`，log 的「[本機重錄]」寫「沒有偵測到」。
2. **背景工作**：點「關閉出題系統」。沒有背景工作時它會直接關；如果跳出「背景有 N 件工作正在跑」，按「取消」，等它們做完再來（`docs/desktop-launcher.md` 第 4 節）。

### 10.2 設定上限（只做一次，約 10 分鐘）

1. **設定前先量一次**：雙擊 `wsl_memory_check.bat`，按 `1`（閒置）。log 會原樣記下現在的 `.wslconfig`（等於備份一份）與設定前的記憶體。
2. 確認 10.1 節的兩件事都沒有在跑，然後點「關閉出題系統」。
3. 按 `Win`＋`R`，輸入 `notepad %UserProfile%\.wslconfig`，按 Enter。檔案不存在時記事本會問要不要建立，選「是」。
4. 讓檔案裡有下面這幾行（檔案本來就有 `[wsl2]` 或 `[experimental]` 時，把那一行放進原本的區段，**不要**重複寫區段名稱；其他原有的行不動）：

   ```ini
   [wsl2]
   memory=3GB

   [experimental]
   autoMemoryReclaim=dropCache
   ```

   存檔：「檔案 → 儲存」。如果是「另存新檔」，「存檔類型」選「所有檔案」、編碼選「UTF-8」，檔名要是 `.wslconfig`（不能變成 `.wslconfig.txt`）。
5. 結束 Docker Desktop：右下角的鯨魚圖示按右鍵 →「Quit Docker Desktop」，等圖示消失。
6. 開「命令提示字元」，輸入 `wsl --shutdown`，按 Enter（沒有任何輸出是正常的）。想確認的話再輸入 `wsl -l -v`，每一列都要是 `Stopped`。
7. 等約 10 秒，從開始選單開 Docker Desktop，等鯨魚圖示變成正常（滑過去顯示 Engine running）。
8. 點「出題系統」，確認系統照常開起來。
9. **設定後再量一次**：`wsl_memory_check.bat` 按 `1`。看 log 的三個地方：
   - 「[.wslconfig]」的「判讀」要是 `memory = 3GB`、`autoMemoryReclaim = dropCache`（檔案寫對了）。
   - **「[.wslconfig 是否生效]」是直接證據**：`Docker 看到的記憶體`（`docker info` 的 `MemTotal`，也就是 WSL 虛擬機的總記憶體）要**不超過 3 GB**，判讀寫「上限已生效」；略小於 3 GB 是正常的（核心會先保留一部分）〔要實測：實際會小多少〕。寫「上限還沒生效」就是第 5～7 步沒有做完，WSL 還是舊的那一個；寫「讀不到」就等 Docker Desktop 的鯨魚圖示顯示 Engine running 再量一次。
   - 「[WSL 虛擬機]」一段只是輔助（比 `.wslconfig` 的修改時間與虛擬機的啟動時間）：出現「新設定還沒生效」同樣表示第 5～7 步沒做完；寫「讀不到虛擬機的啟動時間，無法用時間判斷」時**不代表已生效**（一般權限可能讀不到 vmmem 的啟動時間），以上一點的 Docker 記憶體為準。

- **設太低的症狀**：Docker Desktop 起不來、資料庫容器啟動失敗、重錄或上傳時容器被系統結束。處理：把 `memory=3GB` 改成 `memory=4GB`，在 10.1 節允許的時候照第 5～8 步再做一次〔要實測〕。
- **要恢復原狀**：刪掉這幾行（或整個 `.wslconfig`），照第 5～8 步再做一次。
- 這個上限對這台電腦上所有的 WSL 發行版都有效（不只 Docker）。

### 10.3 三種情況各量一次

| 情況 | 什麼時候跑 | 按 |
| :--- | :--- | :--- |
| 閒置 | Docker 開著、出題系統開著，但沒有上傳、沒有重錄，放著 5 分鐘之後 | `1` |
| 上傳 | 上傳一份考卷、拆題跑到一半的時候（本機拆一份卷要 1 小時以上，中間任何時候都可以） | `2` |
| 重錄 | `record_local.bat` 正在跑的時候。**只讀取，不會打斷重錄**；但重錄中不可以做 10.2 節的任何一步 | `3` |

- 怎麼跑：雙擊 `exam_pro\scripts\windows\wsl_memory_check.bat`，按 `1`、`2` 或 `3`。大約 10～60 秒，畫面印出結果，同時附加到 `exam_pro\data\logs\wsl_check-日期.log`（同一天跑幾次都接在後面）。
- log 記的東西：`.wslconfig` 的內容與判讀、vmmem／VmmemWSL 的記憶體、Docker 看到的總記憶體（`docker info` 的 `MemTotal`，和 `.wslconfig` 的 `memory` 比對）、總計／可用／使用中、Docker 容器各自的記憶體、Ollama 載入了哪些模型、node 與 python 的合計、有沒有偵測到重錄、`wsl --version`、Smart App Control。
- 建議的順序：設上限**前**閒置一次（10.2 節第 1 步）→ 設上限**後**閒置一次（第 9 步）→ 上傳一次 → 重錄一次。
- **重錄進行中不要更新 repo**（`git pull`、切分支都不要）：重錄的後段會重新載入工作樹裡的程式（e2e 會 `require` `app.js`），跑到一半換版本，錄出來的東西可能作廢。這個工具要等 2026-09-27 這一輪重錄跑完、合併之後才拿得到，這一輪量不到；想要「設上限**前**的重錄」當對照，就在**下一輪**重錄、還沒設上限時按 `3` 量一次（只讀取），設上限要等那一輪跑完。
- 量完把 log 交給維護的人（或貼進對話）。D2（原生 PostgreSQL）值不值得花約 48～57 小時，就看這幾組數字（DA-14）。

### 10.4 Smart App Control（DA-9 的前提）

DA-9 選 1（不簽章、只在自己電腦 build）的前提是 **Smart App Control 關閉**。`wsl_memory_check.bat` 的 log 最後一段「[Smart App Control]」會列兩個讀法：

- `Get-MpComputerStatus：SmartAppControlState = …`：`Off`＝關閉、`On`＝開啟、`Eval`＝評估模式。
- `登錄 VerifiedAndReputablePolicyState = …`：`0`＝關閉、`1`＝開啟、`2`＝評估模式。
- 讀不到的那一個會寫「讀不到」與原因（例如 Defender 被別的防毒軟體取代）。兩個都讀不到時，到「Windows 安全性 → 應用程式與瀏覽器控制 → Smart App Control 設定」用眼睛看。

判讀：

- **關閉**：DA-9 的前提成立，什麼都不用做。
- **開啟或評估模式**：**先不要改**，把 log 交給維護的人，回到 DA-9 重新選（建議 4：關掉 SAC；Windows 還沒裝 KB5083769 的話，關掉之後要重灌才能再打開，S45c）。

### 10.5 DA-11 之後在 Windows 上看一次

更新到含 `dec/r7-decisions-host` 的版本之後，後端預設只聽 `127.0.0.1`：

1. 點「出題系統」，app 視窗要照常開起來（網址仍是 `http://localhost:3000/`；Edge 會自己改試 `127.0.0.1`〔推論，這一步就是在驗證它〕）。打不開時把最新的 `exam_pro\data\logs\launcher-日期.log` 交給維護的人。
2. `npm start` 的視窗會印「已成功安全啟動：http://localhost:3000（只接受這台電腦的連線；HOST=127.0.0.1）」。
3. 平板、手機預設連不到。真的要用時才在 `.env` 設 `HOST=0.0.0.0`，照 `exam_pro\README.md`「區網存取」處理防火牆（只允許私人網路）、`ALLOWED_ORIGINS` 與 `API_KEY`。
4. 〔要實測〕**同一個埠還有別的程式在聽**時，後端改綁 `127.0.0.1` 之後不一定報「埠被佔用」（`docs/desktop-launcher.md` 7.3 節最後一點）：
   - Windows 的相容例外：別的程式已經聽 `0.0.0.0:3000` 時，`npm start` 照樣綁得上 `127.0.0.1:3000` 並印「已成功安全啟動」。這台電腦開 `localhost` 會到出題系統，區網連 3000 埠卻會到那個程式。
   - 別的程式只聽 IPv6（`[::1]:3000`）時，兩邊不衝突；瀏覽器開 `localhost` 先試 `::1`，就會打開那個程式的畫面。
   - 桌面圖示擋得住第一種（開後端之前先問 `127.0.0.1:3000`，有別的程式回應就報「埠被佔用」），擋不住第二種；直接 `npm start` 兩種都擋不住。
   - 症狀：`npm start` 印成功，app 視窗或瀏覽器打開的卻不是出題系統。查法：命令提示字元執行 `netstat -ano | findstr ":3000"`，`LISTENING` 的列出現兩個以上的 PID，就是有別的程式也在聽 3000 埠；關掉那個程式，或在 `.env` 改 `PORT`，再把 log 交給維護的人。

---

## 自我檢查紀錄（2026-09-27）

第一版草稿 `325c52b` 是作者中斷時留下的，沒有自我檢查。這一版逐節對照需求、重讀程式與來源，改了下面這些地方：

**事實更正（草稿寫錯的）**

1. **關閉時中止節點會吃掉重試次數**（2.3 節、第 3 條第 2 項、R-17）：草稿要「用 AbortController 中止在途節點」，但現有程式把 abort 記成 `timeout`、寫進事件表、累加重試次數；拆題迴圈甚至會立刻重試，本機模式下可能讓整份卷 `failed`。改成另開 `abandon` 路徑，不寫 outcome、只放掉租約。
2. **python 不會變成孤兒行程**（2.3 節、R-9）：草稿推論 Windows 不會跟著結束子行程。libuv 原始碼顯示非 detached 的子行程會被放進「父行程結束就終止」的 job（S41）。相反地，postgres 是孫行程，app 當掉時會繼續跑，這一點補進 2.5 節與 D2 驗收。（審查後更正：venv 的 python 是轉導器，真正的直譯器是孫行程，結論改標〔推論〕，理由改成轉導器自己的 job，見下方「審查修正紀錄」第 7 條。）
3. **`setup_local_ai.bat` 找的是 `ollama.exe`，不是 `ollama app.exe`**（2.6 節）。
4. **「約 60 支測試假設 `data/jobs`」**：實際是 7 個測試檔、18 處（第 3 條第 12 項）。
5. **作答快照的排序例外**：`snapshot_attempt_views.js` 的學生依 `id` 排，會受排序規則影響的是弱點表同分時的次序；另外它的作答雜湊跟著伺服器 `timezone` 走（4.3 節）。
6. **`PATH` 裡沒有 PG17 的工具**（1.3 節、4.2 節第 4 步），依 `backup.js` 檔頭。
7. **D2 工時重複計算**：草稿把 pgvector 的取得算在第 26 項，又在 D2 另計一次。B2 的小計也和逐項加總對不上。重算後合計約 18～19.5 人日（第 0、6 條）。（審查後又改成約 20～22.5 人日、另加緩衝，見「審查修正紀錄」。）
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

---

## 審查修正紀錄（2026-09-27，`dec/desktop-app-design-fix`）

審查的對象是 `c3cd57f`，結論是「需修改後再合併」，共 10 條：高嚴重度 1 條、中度 4 條、低度 5 條。每一條都先回到程式或來源查證，再決定怎麼改。

- 10 條的主張都屬實。
- 其中 3 條的建議改法有缺口或行不通（第 1、3d、4 條），改用別的做法，理由寫在該列。

| # | 嚴重度 | 審查意見 | 查證結果 | 怎麼改 |
|---|---|---|---|---|
| 1 | 高 | D2 之後舊 Docker 庫在 5442 復活，形成兩份正式庫 | 屬實。`record_local.bat:49-53` 與 `啟動資料庫.bat:17` 都跑 `docker compose up -d --wait`，會連 `postgres` 一起啟動；`backup.js:80-86` 的 docker 模式不看 `DATABASE_URL` 的主機與埠 | ① 第 23 項：加 `profiles: ["prod"]`，**再配一行 `COMPOSE_PROFILES=prod`**，切換當天刪掉。審查建議只加 profile，但 compose 檔一合併，切換前的 app 與 A 就連不上正式庫，所以要多這一行。<br>② 第 19 項：檢查改成比 `system_identifier`。審查建議比埠，但原生庫沿用 5442，比埠擋不住。<br>③ 第 24 項：`啟動資料庫.bat` 不再 migrate 正式庫。<br>④ 連帶改了第 16、22 項、2.5 節、4.2 節第 0、6、7 步、4.4 節、DA-7、R-19、D2 驗收第 5 點。D2 +3～4h |
| 2 | 中 | 放棄或當機後的重跑點說錯；abandon 漏了變式 job | 屬實。`runExtractJob` 每次從第 1 塊跑（`:1311`），`runGenerateJob` 每次從第 1 題跑（`:1540`）；變式同樣經過 `invokeNode`，被 abort 會記成 `timeout` | 2.3 節第 4 點、2.8 節、DA-2、B1 手動驗收第 4 點改寫重跑點；第 2 項納入變式（+2h）；新增 DA-13、第 36 項（逐塊檢查點，5～7h）與 R-20；6.1 節提醒 A 的 `launcherControl.js` 檔頭要一起更正 |
| 3a | 中 | `EMBED_MODE` 預設是 `fixture`，和 `LLM_MODE` 是同一個陷阱 | 屬實（`services/llm/index.js:92-97`） | 第 13 項兩個都擋（+1h，含 `.env` 全量產生） |
| 3b | 中 | 公式健檢三支、`回填向量.bat` 的輸出沒列進盤點 | 屬實（`audit_formulas.js:111`、`fix_formulas.js:127-132`、`backfill_embeddings.js:102-105`） | 第 21、33 項補上（+1h） |
| 3c | 中 | 安裝版的維護命令列在 asar 裡行不通 | 屬實 | 第 21 項改用 `tutor-node.cmd`（run-as-node，照 VS Code 的做法）；2.9 節補上 fuse 與 asar 的前提；新增 R-21。3h 改成 6～8h |
| 3d | 中 | U1 期間 repo 的 `.env` 會變成第二份設定來源 | 屬實（`scripts/` 底下 15 支；dotenv 預設讀工作目錄的 `.env`，不覆寫已經存在的變數） | 維護命令列的工作目錄設在桌面版 `.env` 的資料夾，並注入全部鍵。審查建議的另一條路「把 repo 的 `.env` 改名」不採用：`record_local.bat:44` 找不到 `exam_pro\.env` 就停 |
| 4 | 中 | 少了「D1 加上限制 WSL 記憶體」這個便宜的選項，第 0 條講過頭 | 屬實（S29、S30b）。補一點：微軟文件寫 `autoMemoryReclaim` 的現行預設已經是 `dropCache`，真正有差的是 `memory=` 上限；審查建議的 `gradual` 反而比預設保守 | 新增 DA-14；改寫第 0 條、R-8、DA-7 選項 3、DA-10；D2 的前提加上 DA-14 的量測結果 |
| 5 | 中 | DA-9 與 R-5 漏了 Smart App Control | 屬實（S45、S45b）。另外查到 2026-04 的 KB5083769 之後，SAC 可以隨時開關（S45c） | DA-9 新增選項 4（關 SAC），選項 1 補上前提，建議改成先看 SAC 狀態；另改 1.3 節、R-5、5.1 節 U2、B3 驗收第 8 點、第 9 條 |
| 6 | 低 | OV 的價格其實寫在 S35 裡 | 屬實（每年 150～300 美元） | DA-9 選項 3、S35；第 9 條「查不到」的清單移除這一列 |
| 7 | 低 | 「python 是直接子行程」不精確 | 屬實。另外查了 CPython 原始碼：轉導器確實建了 kill-on-close 的 job（S44），所以結論仍然成立，但要標〔推論〕 | 2.3 節、R-9、自我檢查紀錄第 2 條；B1 驗收第 5 點加測「OCR 執行中結束」 |
| 8 | 低 | D2 的操作程序有幾處對不上 | 四點都屬實：① 第 1 步還寫 `npm start`；② 手動 initdb 沒記 `system_identifier`；③ 弱點查詢以 `CURRENT_DATE` 為起點（`weaknessService.js:34-36`）；④ `pg_ctl` 的 stdio | 4.2 節第 0、1、3 步；第 25 項新增 `pg.js` 命令列（+2h）；4.3 節「作答檢視」那一列；2.5 節「啟動」那一列 |
| 9 | 低 | 工時沒有緩衝、沒算重建 venv、壓縮工具沒寫 | 屬實。`exam_pro` 只有 `docx` 間接帶進來的 `jszip` | 6.6 節加 20～30% 緩衝，並列出沒算進去的風險；U1 期間沿用 repo 的 venv、B3 才重建（2.7 節），第 15 項移到 B3；第 19 項改用 Windows 內建的 `tar` |
| 10 | 低 | 租約偵測在當機後會誤判；區網能不能連要看防火牆 | 屬實 | 2.8 節改看 `pg_stat_activity` 的 `application_name`，新增第 35 項（+1h）；第 3 條「四件事」第 1 點與 DA-11 補上防火牆 |

**工時的變化**：合計從約 143～154h（18～19.5 人日）變成約 162～178h（20～22.5 人日），不含緩衝；加 20～30% 緩衝約 195～232h（24.5～29 人日）。逐期：

- B1 +8～10h：第 2 項 +2h、第 35 項 +1h、第 36 項 +5～7h。
- B2 +1～3h：第 13 項 +1h、第 21 項 +3～5h、第 33 項 +1h；第 15 項的 4h 移到 B3。
- D2 +5～6h：舊庫防護 +3～4h、pgManager 的命令列 +2h。
- B3 +5h：第 15 項 4h、第 29 項 +1h。

**要轉給 A 的一點**：`d730422` 的 `services/launcherControl.js` 檔頭寫逾時結束後「從那一格重跑」，對拆題與變式 job 不成立，A 合併前要一起更正（6.1 節第 4 點）。

---

## 第六輪決策登錄紀錄（2026-09-27，`dec/r7-decisions-host`）

Owner 2026-09-27 在第六輪決策單答了本文件的 DA-1～DA-14（與 `docs/desktop-launcher.md` 的 DL-1～DL-5，共 19 題；一覽表在 `docs/HANDOFF.md` §0.00d）。這一版只做登錄與「定案」語氣的改寫，原本的背景、選項、建議與查證都保留：

- 第 8 條：一覽表加「Owner 2026-09-27」一欄；每題開頭加一段〔Owner 2026-09-27 選 N〕**定案**。
- 依答案改成定案語氣的段落：檔頭、第 0 條（B1、B2 列、DA-7、DA-14）、1.3 節（SAC、WSL）、2.1 節、2.3 節（`server.js` 已改聽 `HOST`）、2.4 節、2.5 節（資料夾、initdb 的 ICU、誰來管）、2.8 節（關閉視窗、放棄後的重跑點）、第 3 條第 4、7、13、24、26、36 項與「四件事」第 1、4 點、4.2 節（第 0、4、7 步）、4.3 節最後一列、4.4、4.5 節、5.1 節、6.6 節（前置條件、工時說明）、第 7 條 R-5、R-8、R-10、R-13、R-20、第 9 條的三列「查不到」。
- 新增第 10 節：Owner 手動操作（`.wslconfig` 的 `memory=3GB`、`autoMemoryReclaim=dropCache`，`wsl --shutdown` 什麼時候不可以做，三種情況的 `wsl_memory_check.bat`，SAC 的判讀，DA-11 之後的驗收）。
- 程式：只有 DA-11 的網頁版那一半（`exam_pro/config/listenHost.js`、`server.js`、啟動器的連線位址與 `host-unsupported`、`/api/health` 的本機判斷）與第 10 節的唯讀檢查工具（`scripts/windows/wsl_memory_check.bat` → `scripts/desktop/wsl_memory_check.js`）。B、D2 的其餘部分都還沒實作；工時不變（6.6 節）。
- 還要 Owner 回答或確認的：DA-9 的前提（SAC 關閉，10.4 節）、DA-14 的量測結果（10.3 節）；B3 開工前再問 DA-6 的「B3 之後改不改 U2」、要改走退路時再問 DA-5、重新啟用 Gemini 時再問 DA-8 的 `safeStorage`（這三項是建議裡的後半，這次的答案沒有涵蓋）。

---

## 審查修正紀錄（2026-09-27，`dec/r7-decisions-host-fix`）

審查的對象是 `94eda86`（`dec/r7-decisions-host`），結論是「通過，附小修建議」，共 8 條。每一條都先回到程式、文件或來源查證，再決定怎麼改：

| # | 嚴重度 | 審查意見 | 查證結果 | 怎麼改 |
|---|---|---|---|---|
| 1 | 中低 | 10.3 節與 ownerSteps 叫 Owner「趁這一輪重錄在跑時先量」，和交付時程對不上 | 屬實。本分支要等這一輪重錄跑完、`dec/integration-r7` 合併之後才送到 Owner 電腦；重錄中更新 repo 會讓後段重新載入的程式換版本 | 10.3 節刪掉那一句，改寫成「重錄進行中不要更新 repo；設上限前的重錄對照組在下一輪量」；第 10 節開頭補一句同樣的提醒；ownerSteps 同步改 |
| 2 | 低 | 讀不到 vmmem 的啟動時間時，檢查什麼都不印，10.2 第 9 步卻把「沒出現『還沒生效』」當成生效的證據 | 屬實（`formatReport` 只在 `started` 有值時才比較） | 讀不到啟動時間、或讀不到 `.wslconfig` 修改時間時明寫「無法用時間判斷」；時間比較改用 `Date.parse`，判斷得出「已生效」時也寫一行。新增唯讀的直接證據 `docker info --format {{.MemTotal}}`，和 `.wslconfig` 的 `memory` 比對（新段落「[.wslconfig 是否生效]」）；指令白名單測試加上這一條（參數逐字比對）。10.2 第 9 步改成以 Docker 記憶體為準 |
| 3 | 低 | Winsock 的相容例外可能讓 `npm start` 不再報 `EADDRINUSE` | 屬實（文件與原始碼層級）：微軟〈Using SO_REUSEADDR and SO_EXCLUSIVEADDRUSE〉的表格，先以預設選項綁萬用位址、再以預設選項綁特定位址 → Success；libuv `src/win/tcp.c` 的註解寫明兩個選項都不設。另外找到一個相關缺口：別的程式只聽 `[::1]` 時，綁 `127.0.0.1` 在任何作業系統都不衝突 | 只記錄〔要實測〕：`docs/desktop-launcher.md` 7.3 節、本文件 10.5 節第 4 點（症狀與 `netstat` 查法）。**沒有加自動檢查**：Linux 的測試重現不了 Winsock 的行為，而啟動器開後端之前的健康檢查已經擋住第一種情況；要補強時再在後端起來後用 `netstat` 找同一埠的其他 PID |
| 4 | 低 | DA-9 定案多加了「或評估模式下沒有擋」 | 屬實，而且和 10.4 節「開啟或評估模式 → 先不要改」衝突 | 定案只寫「SAC 關閉」，並寫明開啟或評估模式都回到 DA-9；選項 1 與建議裡的原文保留，註明以定案為準 |
| 5 | 低 | 第 8 條開頭的「還沒有任何一題的答案落實在程式裡」沒劃掉 | 屬實 | 加刪除線 |
| 6 | 低 | `HOST=127.0.0.2` 這類值被當成支援：健康檢查成功、app 視窗卻打不開 | 屬實（app 視窗的網址固定是 `http://localhost:<埠>/`，`localhost` 只對應 `127.0.0.1` 與 `::1`） | `config/listenHost.js` 的 `localProbeHost` 只把 `127.0.0.1`、`localhost`、`::1`、`::ffff:127.0.0.1` 與萬用位址當成支援，其他 `127.x` 回 `null`（啟動器與關閉捷徑報 `host-unsupported`）；啟動訊息對這類位址印實際的網址。`hostScope` 與 `/api/health` 的 127.0.0.0/8 本機判斷不變 |
| 7 | 低 | 舊範本整份複製成 `config.json` 時，`"jobsWhileRecording": "run"` 會蓋過新預設 | 屬實（`lib/config.js` 只在沒寫時用預設） | `docs/desktop-launcher.md` 第 6 節加一句；ownerSteps 加一步請 Owner 確認 |
| 8 | 資訊 | 實作說明寫 integration 635 個，實際是 631 個 | 屬實：本分支重跑，數字見 `dec/r7-decisions-host-fix` 的 commit 訊息 | 更正回報；程式不改 |
