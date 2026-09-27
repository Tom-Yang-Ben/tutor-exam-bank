# 桌面啟動器：點一下桌面圖示就開起出題系統

> 〔2026-09-27，分支 `dec/desktop-launcher`〕Owner 決定先做 **A（啟動器）**；B（Electron 桌面殼）與 D2（原生 PostgreSQL、拿掉 Docker）同時開始規劃、先不實作（設計稿在分支 `dec/desktop-app-design` 的 `docs/desktop-app-design.md`）。
> 本文件第 1～6 節給 Owner（怎麼裝、怎麼開、怎麼關、出錯看哪裡），第 7 節給維護者，第 8 節是待 Owner 確認的事。

## 1. 這是什麼

以前每次要：開 Docker Desktop → 在 `exam_pro` 執行 `npm run db:up` → 確認 Ollama 在跑 → `npm start` → 開瀏覽器打 `localhost:3000`。

現在點桌面的 **「出題系統」** 圖示，啟動器會照同樣的順序自動做完，最後開一個**獨立的視窗**（Microsoft Edge 的 app 模式：沒有網址列與分頁，看起來像一般程式）。用完點 **「關閉出題系統」**。

- 系統本身**完全沒有改變**：畫面、資料庫、`.env` 都是同一份；`npm start`、`npm run dev`、`record_local.bat` 照舊可以用。
- 已經開著時再點一次圖示，只會再開一個視窗，不會重複啟動。
- 系統的網頁仍然是 `http://localhost:3000`，用一般瀏覽器打開也可以。

## 2. 第一次：建立桌面圖示

1. 到 `exam_pro\scripts\windows\`，雙擊 **`install_desktop_shortcut.bat`**。
2. 視窗顯示「已建立：…\出題系統.lnk」「已建立：…\關閉出題系統.lnk」，按任意鍵關閉。
3. 桌面出現兩個圖示：藍底考卷加黃色勾勾的「出題系統」，以及加了紅色停止標誌的「關閉出題系統」。

- 只要做一次。**搬動專案資料夾、或重新安裝 Node.js 到別的位置之後**，再雙擊一次（會覆蓋舊的圖示）。
- 要移除兩個圖示：在命令提示字元執行 `install_desktop_shortcut.bat --remove`，或直接把圖示拖到資源回收筒。
- 桌面被 OneDrive 接管也沒關係，圖示會建在 Windows 認定的桌面。

## 3. 每次怎麼開

點 **「出題系統」**。先出現一個「出題系統啟動中」的小視窗，列出六個步驟與進度：

| 步驟 | 做什麼 | 大約多久 |
| :--- | :--- | :--- |
| 檢查系統狀態 | 系統已經在跑 → 直接開畫面，後面都不做；3000 埠被別的程式佔了 → 停下來說是哪個程式 | 1 秒 |
| 資料庫（Docker） | 資料庫連得上就跳過；否則開 Docker Desktop、等它就緒，再執行 `docker compose up -d --wait`（等同 `npm run db:up`） | Docker 沒開時 1～3 分鐘 |
| 本機 AI（Ollama） | `.env` 的模型是 `ollama:` 才需要；沒在跑就幫你開 | 幾秒 |
| 資料庫版本 | 檢查有沒有還沒套用的 migration（**只提示，不會自動升級**） | 1 秒 |
| 啟動後端 | 在背景執行 `node server.js`（沒有黑色視窗） | 10～20 秒 |
| 開啟操作畫面 | 同一個視窗直接轉到系統首頁 | — |

- **一切正常**：視窗自己轉到系統畫面，不必按任何東西。
- **有「注意事項」**（黃色框）：系統可以用，但某些功能會失敗，例如「Ollama 沒有在執行……上傳考卷拆題會失敗」。看完按 **「我知道了，進入出題系統」**。
- **失敗**（紅色框）：寫著原因與處理方式。照做之後**再點一次圖示**就好，已經開好的部分不會重做。

資料庫有沒套用的 migration 時，畫面只會提醒，**不會自動升級**。升級要照 [`deployment_and_operations.md`](../engineering_docs/06_ops/deployment_and_operations.md) §3.3、§3.6 的流程：停服務 → 備份 → `npm run migrate` → 前後快照比對。

## 4. 怎麼關

點 **「關閉出題系統」**：

- 沒有背景工作在跑 → 幾秒內關閉後端，跳出「出題系統已關閉」（6 秒後自己消失）。
- **有背景工作在跑**（例如上傳的考卷還在拆題）→ 先問你：
  - **是**：等它們跑完再關（最多 6 小時；本機 AI 一步可能要數十分鐘）。
  - **否**：最多等 2 分鐘就關；沒跑完的那一步，下次開啟時會**自動從那一步重跑**，已經完成的不會重做、也不會重複扣用量。
  - **取消**：不關。
- Docker Desktop 與 Ollama **預設不關**（下次開比較快）。要一起關，見第 6 節的 `stopDocker`、`stopOllama`。

**只關掉系統的視窗，後端不會停**（背景拆題可能還在跑）。要停後端請用「關閉出題系統」。之後再點「出題系統」會直接開視窗。這是目前的預設，列在第 8 節 DL-2 待你確認。

「關閉出題系統」只會關由圖示開的後端。如果是在命令提示字元用 `npm start` 開的，它會請你到那個視窗按 `Ctrl+C`，不會強制結束。

關機或重新開機前沒有先關也沒關係：背景工作的保證與當機相同，下次開啟時沒跑完的那一步會自動重跑。

## 5. 出錯時看哪裡

全部在 `exam_pro\data\logs\`（依日期分檔）：

| 檔案 | 內容 |
| :--- | :--- |
| `launcher-日期.log` | 啟動器與關閉捷徑的每一步、每個判斷的結果、警告與錯誤。**先看這個** |
| `server-日期.log` | 後端（`node server.js`）的輸出，就是以前 `npm start` 視窗裡的那些字。每次由圖示啟動會先寫一行 `===== … 桌面啟動器啟動後端 =====` |
| `ollama-日期.log` | 只有找不到 Ollama 的系統匣程式、改用 `ollama serve` 開的時候才有 |

`exam_pro\data\launcher\server.json` 存著「關閉出題系統」用的一次性權杖，不要傳給別人。

常見狀況：

| 畫面上的訊息 | 怎麼處理 |
| :--- | :--- |
| 連接埠 3000 被其他程式佔用 | 訊息會寫是哪個程式與 PID。是 `node.exe` 的話，多半是另一個還開著的 `npm start` 視窗：關掉它再點圖示 |
| 找不到 Docker Desktop | 從開始選單開 Docker Desktop；裝在別的位置就在第 6 節的設定檔寫 `dockerDesktopPath` |
| Docker Desktop 太久沒有就緒 | 看右下角鯨魚圖示；有錯誤視窗照它的指示（常見是 `wsl --update`），再點一次圖示 |
| 資料庫容器啟動失敗 | 多半是 5442／5433 埠被本機的 PostgreSQL 佔用；雙擊 `exam_pro\啟動資料庫.bat` 看完整訊息 |
| 錄製進行中，而且資料庫連不上 | 偵測到 `record_local.bat` 在跑：啟動器不動 Docker 與資料庫。等錄完再點圖示 |
| 後端啟動後立刻結束 | 紅框裡有 log 最後幾行；多半是 `.env` 的設定矛盾，照訊息改好再點圖示 |
| 注意事項：Ollama 沒有在執行…拆題會失敗 | 從開始選單開 Ollama；右下角出現羊駝圖示後拆題就恢復，**不必重開系統** |
| 注意事項：Ollama 還沒下載這些模型 | 雙擊 `exam_pro\scripts\windows\setup_local_ai.bat` |
| 注意事項：資料庫有 N 支 migration 還沒套用 | 照第 3 節最後一段的升級流程 |
| 跳出「出題系統的程式異常結束」 | 啟動器本身出錯了：把當天的 `launcher-日期.log` 交給維護的人 |
| 圖示點了沒反應、跳出「找不到 Node.js」 | 重新雙擊 `install_desktop_shortcut.bat` |

## 6. 設定（通常不必改）

要改才建立 **`exam_pro\data\launcher\config.json`**（範本：`exam_pro\scripts\desktop\config.example.json`，複製過去、只留要改的那幾行）。寫錯的那一項會用預設值，並在啟動畫面的注意事項裡說明。系統本身的設定（埠、資料庫、模型、`OLLAMA_HOST`、`API_KEY`）一律照 `exam_pro\.env`，這裡不重複。

| 設定 | 預設 | 說明 |
| :--- | :--- | :--- |
| `dockerDesktopPath` | `C:\Program Files\Docker\Docker\Docker Desktop.exe` | Docker Desktop 主程式 |
| `dockerCliPath` | 空白＝自動 | `docker` 指令；自動＝PATH 上的，找不到再用 Docker Desktop 旁的 `resources\bin\docker.exe` |
| `dockerReadyTimeoutSec` | 240 | 開了 Docker Desktop 之後最多等幾秒 |
| `composeTimeoutSec` | 900 | `docker compose up -d --wait` 最多幾秒（第一次要下載映像） |
| `dbReadyTimeoutSec` | 60 | 容器起來之後最多等資料庫接受連線幾秒 |
| `ollamaAppPath` | 空白＝自動 | 自動＝`%LOCALAPPDATA%\Programs\Ollama\ollama app.exe` → `ollama.exe serve` → PATH 上的 `ollama serve` |
| `ollamaReadyTimeoutSec` | 60 | 開了 Ollama 之後最多等幾秒（等不到只警告，不擋開機） |
| `serverReadyTimeoutSec` | 120 | 後端啟動後最多等幾秒 |
| `browser` | `auto` | `auto`＝Edge → Chrome → 預設瀏覽器；也可以寫 `edge`、`chrome`、`default` |
| `browserPath` | 空白＝自動 | `browser` 是 `edge` 或 `chrome` 時，指定主程式的位置 |
| `browserProfileDir` | 空白＝`%LOCALAPPDATA%\TutorExamBank\browser-profile` | app 視窗專用的瀏覽器設定檔資料夾 |
| `browserArgs` | `[]` | 額外的瀏覽器參數，例如 `["--start-maximized"]`（視窗一開就最大化） |
| `stopDocker` | `no` | 關閉時要不要一併關 Docker：`no`／`containers`（停資料庫容器，資料都在）／`desktop`（再結束 Docker Desktop） |
| `stopOllama` | `false` | 關閉時要不要一併結束 Ollama |
| `stopGraceSec` | 120 | 關閉時最多等背景工作幾秒（選「否」、或不問的時候） |
| `askBeforeStopWithJobs` | `true` | 有背景工作時先問要不要等 |

偵測到本機重錄正在執行時，就算設了 `stopDocker`／`stopOllama` 也不會關（錄製要用測試庫與 Ollama）。

app 視窗用**獨立的瀏覽器設定檔**：不影響平常用的 Edge（書籤、登入、擴充功能都分開，平常的 Edge 開著也沒關係）。Word 檔照樣下載到「下載」資料夾；視窗大小與縮放比例會被記住。

## 7. 給維護者：運作細節

### 7.1 決策順序與程式位置

```
桌面捷徑 → wscript.exe scripts\desktop\run_hidden.vbs launch "<node.exe>"   （隱藏視窗，不留黑色主控台）
         → node scripts\desktop\launch.js
              lib/plan.js      nextAction(facts) → 下一步（純函式；各種狀態組合由單元測試釘住）
              lib/actions.js   每一步的 I/O（全部經注入的 sys）
              lib/launcher.js  迴圈：nextAction → 執行 → 併回 facts → …，直到 open-app／finish／fail；單一執行個體鎖
              lib/system.js    唯一碰作業系統的地方（execFile、spawn、http、pg、fs）；測試換成假的
```

順序：健康檢查（已在跑且資料庫正常 → 直接開 app 視窗）→ 啟動畫面 → `.env`／`node_modules`／`DATABASE_URL` → 錄製偵測 → 資料庫（連得上就不碰 Docker；錄製中又連不上 → 報錯、不動 Docker；否則 `docker info` →（需要時）開 Docker Desktop、輪詢就緒 → `docker compose up -d --wait` → 等資料庫）→ Ollama（`.env` 的模型有 `ollama:` 才做；失敗只警告）→ migration（只讀、只提示）→ 背景啟動 `node server.js` → 等健康檢查 → 啟動頁轉到系統首頁。

- **後端怎麼開**：`spawn(node.exe, [server.js], {detached:true, windowsHide:true})`，stdout／stderr 附加到 `data\logs\server-日期.log`。環境＝啟動器自己的環境（與在命令提示字元 `npm start` 相同，後端照舊自己讀 `.env`）**只多一個** `LAUNCHER_CONTROL_TOKEN`（64 個十六進位字元的一次性權杖），同一份寫進 `data\launcher\server.json`。
- **錄製偵測**：PowerShell `Get-CimInstance Win32_Process` 列出 node／cmd 的命令列，看有沒有 `record_local.bat`、`cassettes:rerecord`、`rerecord_all.js`、`eval:record`、`record_embeddings.js`、`record_cassettes.js`（`lib/windows.js` 的 `RECORDING_PATTERNS`）。重錄工具本身沒有鎖檔，所以不改它、只看程序。錄製中：資料庫本來就開著 → 照常起後端（它用 5442 的開發庫，錄製用 5433 的測試庫），加一條「會搶 CPU」的注意事項；資料庫沒開 → 報錯，不執行 `docker compose`（避免重建到 tmpfs 的測試庫）。讀不到程序清單 → 不當成錄製中，但加一條注意事項。
- **Ollama 需不需要**：`lib/models.js` 依 `.env` 算各角色實際的模型（與 `config/models.js` 同一條預設與退回鏈，單元測試逐一比對），有任何一個會用到的是 `ollama:` 才需要。`LOCAL_EXTRACT_MODE=ocr`（預設）不要求看圖模型。`OLLAMA_HOST` 指向別台電腦時不去開本機的 Ollama。
- **不自動升級**：只下 `SELECT version FROM schema_migrations`，與 `migrations/*.sql` 比對（`utils/migrationStatus.js`，與 `migrate.js` 同一條排序規則）。
- **同時點兩次**：`data\launcher\launch.lock` 記著第一個啟動器的 PID 與啟動頁網址；第二個只把那個啟動頁再開一次就結束。鎖超過 20 分鐘或 PID 不在就視為殘留。
- **結束碼**：預期中的失敗由啟動頁或訊息框說明，啟動器以 0 結束；未預期的例外寫進 `launcher-日期.log` 並以 1 結束，`run_hidden.vbs` 看到非 0 會跳訊息框指向 log 資料夾。

### 7.2 啟動畫面為什麼這樣做

選項比較過三種，都不必安裝新套件：

| 做法 | 優點 | 缺點 |
| :--- | :--- | :--- |
| **本機啟動頁**（採用） | 進度、注意事項、錯誤與處置步驟都能完整顯示；完成時**同一個視窗**直接轉到系統首頁，Owner 從頭到尾只看到一個視窗 | 啟動器要多開一個只聽 127.0.0.1 的小伺服器（Node 內建 `http`，`lib/statusServer.js`） |
| PowerShell 通知（toast／氣球提示） | 簡單 | 一次只能講一兩句；可能被「專注輔助」擋掉；看不到處置步驟 |
| 只用訊息框 | 最簡單 | 每一步都要按確定，或完全看不到進度 |

- `lib/statusServer.js`：`127.0.0.1` 的隨機埠，只有 `GET /`（`scripts/desktop/status.html`）與 `GET /state`（JSON）。`Host` 標頭不是 `127.0.0.1`／`localhost` 加這個埠就回 403（擋 DNS rebinding）。內容只有啟動進度，沒有題庫資料或金鑰。
- `status.html` 每 0.7 秒讀一次 `/state`；完成且沒有注意事項 → `location.replace(系統網址)`；有注意事項 → 顯示按鈕；失敗 → 紅框。不引用任何外部資源（單元測試用 `scripts/check_html_offline.js` 同一套規則檢查）。
- 啟動器確認啟動頁拿到最終狀態才結束。啟動頁沒載入（或被關掉）時的退路：完成 → 直接開 app 視窗，有注意事項另跳訊息框；失敗 → 系統訊息框（PowerShell `WScript.Shell.Popup`，以 `-EncodedCommand` 傳，中文不會變亂碼）。
- app 視窗：`msedge.exe --app=http://localhost:3000/ --user-data-dir=%LOCALAPPDATA%\TutorExamBank\browser-profile\edge --no-first-run --no-default-browser-check`；沒有 Edge 用 Chrome 的同一組參數；都沒有用預設瀏覽器（`rundll32 url.dll,FileProtocolHandler`）。網址一定用 `localhost`（`ALLOWED_ORIGINS` 預設只放 `http://localhost:3000`）。

### 7.3 健康檢查與關閉通道（後端只改這兩處）

**`GET /api/health`**（`controllers/healthController.js`，`app.js` 3a）：

```json
200 {"service":"tutor-exam-bank","status":"ok","version":"1.0.0","db":{"ok":true},
     "migrations":{"applied":"0020_output_truncated_review.sql","latest":"0020_output_truncated_review.sql","pending":[],"unknown":[]}}
503 {"service":"tutor-exam-bank","status":"degraded","version":"1.0.0","db":{"ok":false},"migrations":null}
```

- **刻意掛在 `apiKeyAuth` 之前**：啟動器與關閉捷徑要先認出「3000 埠上是不是這套系統」才決定開視窗、報埠衝突或送關閉；`.env` 的 `API_KEY` 可能在後端啟動後被改過，帶金鑰去問會被 401 擋住而分不出是誰在聽。
- 不洩漏資料：只有服務名稱、版本、資料庫連不連得上、migration 檔名；連線錯誤的原文（可能含帳號）一律不回。首頁本來就不經 `apiKeyAuth`（它把 `API_KEY` 注入頁面），這支不會讓「沒金鑰能拿到的東西」變多。只有 GET、不寫資料庫、資料庫查詢最多等 2 秒、`Cache-Control: no-store`。
- 其他 `/api` 路由照舊要金鑰（單元與整合測試都有斷言）。

**`/api/launcher/status`、`POST /api/launcher/shutdown`**（`services/launcherControl.js`，`app.js` 3b、`server.js` 最後一行）：

- **只有環境裡有 `LAUNCHER_CONTROL_TOKEN` 的後端（由啟動器開的）才掛**；`npm start`、`npm run dev`、CI、測試都沒有這個變數，請求落到既有的 `/api` 路由（404），行為逐位元不變。`server.js` 只是把 `server` 與 `runner` 的參照交給它。
- 照慣例掛在 `apiKeyAuth` 之後（設了 `API_KEY` 就要 `x-api-key`），另外要 `x-launcher-token`（timing-safe 比對，錯了 403）。
- 為什麼要這條通道：Windows 沒有 SIGTERM，背景（沒有主控台）的 `node server.js` 收不到 Ctrl+C。
- 關閉順序：`runner.stop()`（不再認領新工作，不打斷在途的）→ `server.close()` → 等在途工作歸零（或到 `grace_ms`）→ 在途歸零才關連線池 → `exit(0)`。時限到了還有在途工作就**不關連線池、直接結束**：先關池的話在途工作接下來的查詢會失敗、被記成一次節點錯誤；直接結束則那一列停在原狀態，租約（`JOB_LEASE_MS`，預設 3 分）到期後下次開機重新認領、從那一格重跑——與當機、nodemon 重啟同一條既有保證（`workers/jobRunner.js` 檔頭）。

### 7.4 不影響既有行為

- `npm start`／`npm run dev`：多了 `/api/health`（新的 GET，不需金鑰）；沒有 `LAUNCHER_CONTROL_TOKEN`，其餘逐位元不變。
- CI：不裝、不跑任何 Windows 的東西；新增的單元測試都在雲端 Linux 上跑（Windows 指令經可注入的 `sys` 換成假的）。沒有新增相依套件。
- `record_local.bat`、`cassettes:rerecord`：程式一個字都沒改；啟動器偵測到它們在跑時不動 Docker 與資料庫，關閉捷徑也不關 Docker／Ollama。
- 啟動器從不執行 `npm run migrate`、`docker compose down`、`docker compose stop`（後者只在 Owner 設了 `stopDocker` 時由關閉捷徑執行）。

### 7.5 檔案與測試

| 檔案 | 用途 |
| :--- | :--- |
| `exam_pro/scripts/windows/install_desktop_shortcut.bat` → `scripts/desktop/install_shortcuts.js` | 建立／移除兩個桌面捷徑（PowerShell 的 `WScript.Shell.CreateShortcut`，`-EncodedCommand`） |
| `exam_pro/scripts/desktop/run_hidden.vbs` | 捷徑的入口：隱藏視窗執行 node 並等它結束。**只用 ASCII**（wscript 以 ANSI 讀 `.vbs`），中文訊息以 UTF-16 十六進位存、`U()` 解碼 |
| `exam_pro/scripts/desktop/launch.js`、`stop.js`、`lib/*.js`、`status.html` | 啟動器、關閉捷徑、啟動頁 |
| `exam_pro/scripts/desktop/assets/*.ico`、`tools/make_icons.js` | 兩個圖示（自己畫的 SVG 幾何圖形，用既有的 `sharp` 點陣化；改圖示才要重跑） |
| `exam_pro/scripts/desktop/config.example.json` | 第 6 節的設定範本 |
| `exam_pro/controllers/healthController.js`、`utils/migrationStatus.js`、`services/launcherControl.js` | 第 7.3 節 |

單元測試（`npm test`）：`desktopLauncherPlan`（決策的各種狀態組合）、`desktopLauncherRun`（用假的 Windows 筆電把整個啟動流程跑一遍：冷開機、Docker 沒開／沒裝／逾時、錄製中、埠被佔、後端當掉、Ollama 各種狀況、啟動頁沒回應的退路、單一執行個體）、`desktopLauncherStop`、`desktopLauncherControl`（關閉通道與 `app.js` 的掛載順序）、`desktopHealth`、`desktopLauncherWindows`、`desktopLauncherConfig`、`desktopLauncherScripts`（`.bat`／`.vbs`／`.ico`／`status.html`／捷徑內容）。整合測試：`test/integration/health.pg.test.js`（真的資料庫）。

## 8. 待 Owner 確認事項

**DL-1　關閉時有背景工作在跑，怎麼處理**（目前：每次問）

| 選項 | 代價 |
| :--- | :--- |
| 1. 每次問：是＝等跑完、否＝最多等 2 分鐘、取消（**目前**） | 多一次點擊；有工作時才會問 |
| 2. 一律等跑完（`askBeforeStopWithJobs:false`＋`stopGraceSec:21600`） | 本機 AI 一步可能數十分鐘，按了關閉後端卻還在跑 |
| 3. 一律只等 2 分鐘（`askBeforeStopWithJobs:false`） | 沒跑完的那一步下次重跑，本機模式可能白費數十分鐘的 CPU |

**DL-2　只關掉系統視窗時，後端要不要跟著停**（目前：不停）

| 選項 | 代價 |
| :--- | :--- |
| 1. 不停，要停用「關閉出題系統」（**目前**） | 忘了關時後端與資料庫一直佔記憶體（後端約 200～400 MB） |
| 2. 視窗關掉、而且沒有背景工作時自動停 | 要多一個在背景盯著視窗的小程式（約 0.5 人日）；Edge 的 app 視窗沒有「關閉」事件可接，只能輪詢，較不可靠 |
| 3. 等 B（Electron 桌面殼）再做：關視窗縮到系統匣、有工作時提示 | 現在沒有；B 的設計稿 DA-2 已列入 |

**DL-3　「關閉出題系統」要不要一併關 Docker Desktop／Ollama**（目前：都不關）

| 選項 | 代價 |
| :--- | :--- |
| 1. 都不關（**目前**） | Docker Desktop 的 WSL 虛擬機約佔 1～2 GB 記憶體；Ollama 閒置 10 分鐘後會自己卸下模型，本體很小 |
| 2. 停資料庫容器（`stopDocker:"containers"`） | 省下資料庫的記憶體；Docker Desktop 本身還在 |
| 3. 連 Docker Desktop 一起結束（`stopDocker:"desktop"`）＋`stopOllama:true` | 記憶體省最多；下次開啟要多等 1～3 分鐘；舊版 Docker Desktop 不支援 `docker desktop stop`（會提示手動結束） |

表中的記憶體數字是一般情況的估計，**沒有在 Owner 的電腦上實測**；要決定 DL-2、DL-3 之前，可以在工作管理員看「VmmemWSL」（或「Vmmem」，Docker 的虛擬機）與「node.exe」實際佔多少。

DL-1、DL-3 都只改設定、不改程式：Owner 決定後照選項寫進 `exam_pro\data\launcher\config.json`（選目前的預設就什麼都不用寫）。DL-2 的選項 2 要另外實作。
