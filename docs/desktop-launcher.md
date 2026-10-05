# 桌面啟動器：點一下桌面圖示就開起出題系統

> 〔2026-09-27，分支 `dec/desktop-launcher`〕Owner 決定先做 **A（啟動器）**；B（Electron 桌面殼）與 D2（原生 PostgreSQL、拿掉 Docker）同時開始規劃、先不實作（設計稿在分支 `dec/desktop-app-design` 的 `docs/desktop-app-design.md`）。
> 本文件第 1～6 節給 Owner（怎麼裝、怎麼開、怎麼關、出錯看哪裡），第 7 節給維護者，第 8 節是待 Owner 確認的事。
> 〔2026-09-27，分支 `dec/desktop-launcher-fix`〕依審查修正：瀏覽器、Docker Desktop、Ollama 與訊息框的視窗不再被藏起來（7.2）；後端聽不了連接埠時會說出原因並結束，不再變成看不到的背景程序（7.3、DL-5）；錄製中的背景工作可以設定暫停（DL-4）；健康檢查加上限流（7.3）；log 的找法（第 5 節）；VBScript 淘汰的風險（7.6）。
> 〔2026-09-27，分支 `dec/desktop-launcher-fix2`〕更正「關閉後沒跑完的工作會怎樣」：原本寫「從那一步重跑、已完成的不會重做」，只對**單題的檢查**成立；**整份卷的拆題、變式生成**是整份一件工作，下次開啟會從頭再跑一次（第 4 節、7.3、DL-1；依據 `workers/jobRunner.js`）。
> 〔2026-09-27，分支 `dec/r7-decisions-host`〕**Owner 第六輪決策已答**（第 8 節就地加註）：DL-1＝1 每次問、DL-2＝1 關視窗不停後端、DL-3＝1 都不關、DL-5＝1 保留聽埠失敗即結束，這四題就是原本的行為，程式不改；**DL-4＝2**：`jobsWhileRecording` 的預設從 `run` 改成 `pause`（錄製中開的後端暫停背景工作；第 6 節、7.1）。另依設計稿的 **DA-11＝1**，後端改聽 `.env` 的 `HOST`、**預設 `127.0.0.1`**，啟動器照它決定連哪個位址（第 5、6 節、7.3）。一覽表在 `docs/HANDOFF.md` §0.00d。
> 〔2026-09-27，分支 `dec/r7-decisions-host-fix`〕依審查修正：`HOST` 寫成 `127.0.0.1` 以外的 `127.x` 時，原本健康檢查連得到、判定成功，app 視窗的 `http://localhost` 卻打不開；現在和區網位址一樣一開始就停下說明（第 5、6 節）。舊範本複製成的 `config.json` 裡的 `"jobsWhileRecording": "run"` 會蓋過新預設（第 6 節）。改綁 `127.0.0.1` 之後，同一個埠的衝突在 Windows 上不一定報 `EADDRINUSE`〔要實測〕（7.3 節最後一點）。
> 〔2026-09-27，分支 `dec/r7-checkpoints`〕Owner 第六輪 DA-13＝2：整份卷的拆題、變式生成加了**逐塊／逐題的檢查點**。中斷後下次開啟只重做被中斷的那一塊／那一題，已經拆完的塊、建好的題不會重做（第 4 節、7.3、DL-1 的說明跟著改；上一則「從頭再跑一次」到此不再成立）。
> 〔2026-09-27，分支 `dec/r7-checkpoints-fix`〕依審查更正變式的說法：變式是「只補還沒建成的題」，不只中斷的那一題，中斷點之前沒通過檢查（沒過閘門）的題也會再生成一次；已經建好的題不重做。另補：拆題的檢查點對不上時不自動重拆、直接 `failed`（7.3）。

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

資料庫有沒套用的 migration 時，畫面只會提醒，**不會自動升級**。升級要照 [`deployment_and_operations.md`](./ops/deployment_and_operations.md) §3.3、§3.6 的流程：停服務 → 備份 → `npm run migrate` → 前後快照比對。

## 4. 怎麼關

點 **「關閉出題系統」**：

- 沒有背景工作在跑 → 幾秒內關閉後端，跳出「出題系統已關閉」（6 秒後自己消失）。
- **有背景工作在跑**（例如上傳的考卷還在拆題）→ 先問你：
  - **是**：等它們跑完再關（最多 6 小時）。拆題是整份卷算一件工作，所以正在拆題時要等整份卷拆完（本機拆一份卷可能要 1 小時以上）。
  - **否**：最多等 2 分鐘就關。〔2026-09-27，`dec/r8-b1-abandon`〕2 分鐘到了還有工作在跑，後端會先**中止**它們（不記成失敗或逾時、不用掉重試次數），放掉它們的租約再關，所以下次開啟**馬上**就會接著做（原本要等租約到期，約 3 分鐘）。〔要實測〕這一點還沒在 Windows 上試過，驗收步驟見 `docs/desktop-app-design.md` 6.2 節第 14 步（選「否」、等約 2 分鐘關閉、馬上重開，那份卷幾秒內就接著拆）。沒跑完的工作下次開啟時會自動接著做，但接得上的程度不一樣：
    - **單題的檢查**（分類、lint、驗算等，每題分好幾步）：從中斷的那一步接著做，前面做完的步驟不會重做。
    - **整份卷的拆題**：從中斷的那一塊重拆，已經拆完的塊不會重拆（本機一塊 2 頁，約 30～45 分鐘，最多白費這一塊）。
    - **變式生成**：只補還沒建成的題，已經建好的題不會重做。中斷的那一題、以及之前沒通過檢查的題會再生成一次（本機每題約 3 分鐘）。
    - 已經記下的用量不會遺失；用 Gemini 時，被中斷的那一塊／那一題重做時會再付一次費用（本機模式不花錢，只花時間）。
  - **取消**：不關。
- Docker Desktop 與 Ollama **預設不關**（下次開比較快；〔Owner 2026-09-27 DL-3 選 1〕定案）。要一起關，見第 6 節的 `stopDocker`、`stopOllama`。

**只關掉系統的視窗，後端不會停**（背景拆題可能還在跑）。要停後端請用「關閉出題系統」。之後再點「出題系統」會直接開視窗。~~這是目前的預設，列在第 8 節 DL-2 待你確認。~~〔Owner 2026-09-27 選 1〕定案：關視窗不停後端（第 8 節 DL-2）。

「關閉出題系統」只會關由圖示開的後端。如果是在命令提示字元用 `npm start` 開的，它會請你到那個視窗按 `Ctrl+C`，不會強制結束。

關機或重新開機前沒有先關也可以，結果和上面選「否」一樣（與當機相同）：單題的檢查從中斷那一步接著做；整份卷的拆題從中斷的那一塊重拆（本機拆一塊約 30～45 分鐘）；變式生成只補還沒建成的題。所以正在拆題時，等手上這一塊拆完再關機比較不浪費。〔2026-09-27，`dec/r8-b1-abandon`〕唯一的差別：直接關機（或當機）時沒有人放掉租約，下次開機要等租約到期（`JOB_LEASE_MS`，約 3 分鐘）才會接著做；選「否」則是後端自己放掉，開機就接著做。

## 5. 出錯時看哪裡

全部在 `exam_pro\data\logs\`，**依修改時間排序、看最新的那一個**：

| 檔案 | 內容 |
| :--- | :--- |
| `launcher-日期.log` | 啟動器與關閉捷徑的每一步、每個判斷的結果、警告與錯誤。**先看這個** |
| `server-日期.log` | 後端（`node server.js`）的輸出，就是以前 `npm start` 視窗裡的那些字。每次由圖示啟動會先寫一行 `===== … 桌面啟動器啟動後端 =====` |
| `ollama-日期.log` | 只有找不到 Ollama 的系統匣程式、改用 `ollama serve` 開的時候才有 |

檔名的日期是**那個程式開始執行的那天**，之後不會換檔：後端開著過夜，今天的訊息還是寫在昨天那個 `server-日期.log` 裡。所以不要照今天的日期找，看修改時間最新的那個；啟動畫面或訊息框的錯誤訊息裡，也會直接寫出那次實際寫的 log 路徑。

`exam_pro\data\launcher\server.json` 存著「關閉出題系統」用的一次性權杖，不要傳給別人。

常見狀況：

| 畫面上的訊息 | 怎麼處理 |
| :--- | :--- |
| 連接埠 3000 被其他程式佔用 | 訊息會寫是哪個程式與 PID。是 `node.exe` 的話，多半是另一個還開著的 `npm start` 視窗：關掉它再點圖示。啟動器剛開、卻用不到這個埠的後端，啟動器會自己結束它，不會留在背景 |
| 連接埠 3000 無法使用 | 埠沒被別的程式佔用、但沒有權限用（EACCES），多半是 Windows 保留了這一段埠（Hyper-V、WSL、Docker Desktop）。在命令提示字元執行 `netsh interface ipv4 show excludedportrange protocol=tcp`，看 3000 在不在列出的範圍內；在的話把 `exam_pro\.env` 的 `PORT` 改成範圍外的數字（`ALLOWED_ORIGINS` 跟著改），或重新開機再試 |
| 出題系統的後端沒有回應 | 之前由圖示開的後端還在，只是太忙沒回應（例如本機 AI 正在拆題）。等一兩分鐘再點圖示；一直這樣就先按「關閉出題系統」，還不行再照訊息到工作管理員結束那個 PID 的 `node.exe` |
| 找不到 Docker Desktop | 從開始選單開 Docker Desktop；裝在別的位置就在第 6 節的設定檔寫 `dockerDesktopPath` |
| Docker Desktop 太久沒有就緒 | 看右下角鯨魚圖示；有錯誤視窗照它的指示（常見是 `wsl --update`），再點一次圖示 |
| 資料庫容器啟動失敗 | 多半是 5442／5433 埠被本機的 PostgreSQL 佔用；雙擊 `exam_pro\啟動資料庫.bat` 看完整訊息 |
| 錄製進行中，而且資料庫連不上 | 偵測到 `record_local.bat` 在跑：啟動器不動 Docker 與資料庫。等錄完再點圖示 |
| 注意事項：偵測到本機重錄正在執行…這次開的後端暫停背景工作 | 〔DL-4 選 2，預設〕系統可以照常用，但上傳的考卷只會排隊、不會開始拆。錄完後點「關閉出題系統」、再點「出題系統」，排隊的工作就會開始 |
| .env 的 HOST 設定讓啟動器連不到後端 | `exam_pro\.env` 的 `HOST` 寫成某一個區網位址（例 `192.168.1.23`），或 `127.0.0.1` 以外的 `127.x`：後端只聽那個位址，app 視窗的 `http://localhost` 連不到（`localhost` 只對應 `127.0.0.1` 與 `::1`）。只給這台電腦用就刪掉 `HOST` 那一行（預設 `127.0.0.1`）；要讓平板連進來就寫 `HOST=0.0.0.0`，並照 `exam_pro\README.md`「區網存取」設定防火牆與 `ALLOWED_ORIGINS` |
| 後端啟動後立刻結束 | 紅框裡有 log 最後幾行；多半是 `.env` 的設定矛盾，照訊息改好再點圖示 |
| 注意事項：Ollama 沒有在執行…拆題會失敗 | 從開始選單開 Ollama；右下角出現羊駝圖示後拆題就恢復，**不必重開系統** |
| 注意事項：Ollama 還沒下載這些模型 | 雙擊 `exam_pro\scripts\windows\setup_local_ai.bat` |
| 注意事項：資料庫有 N 支 migration 還沒套用 | 照第 3 節最後一段的升級流程 |
| 跳出「出題系統的程式異常結束」 | 啟動器本身出錯了：把最新的 `launcher-日期.log` 交給維護的人 |
| 圖示點了沒反應、跳出「找不到 Node.js」 | 重新雙擊 `install_desktop_shortcut.bat` |
| 圖示點了沒反應，或跳出「Windows Script Host」的錯誤 | 兩個圖示都經過 Windows 內建的 VBScript（`wscript.exe`）。微軟已經把 VBScript 改成「選用功能」，預計之後會預設停用、再移除。到 **設定 → 系統 → 選用功能**，確認清單裡有 **VBScript**；沒有就用「新增選用功能」把它加回來，再點圖示（第 7.6 節） |

## 6. 設定（通常不必改）

要改才建立 **`exam_pro\data\launcher\config.json`**（範本：`exam_pro\scripts\desktop\config.example.json`，複製過去、只留要改的那幾行）。寫錯的那一項會用預設值，並在啟動畫面的注意事項裡說明。系統本身的設定（埠、資料庫、模型、`OLLAMA_HOST`、`API_KEY`）一律照 `exam_pro\.env`，這裡不重複。

〔2026-09-27，DA-11＝1〕後端聽的位址也在 `exam_pro\.env`：`HOST`，**不寫＝`127.0.0.1`**（只接受這台電腦的連線）。啟動器與關閉捷徑照它決定連哪裡：不寫、`127.0.0.1`、`0.0.0.0`、`::` → 連 `127.0.0.1`；`localhost`、`::1` → 照原值連。`HOST` 寫成其他值（某一個區網位址，或 `127.0.0.1` 以外的 `127.x`）時，app 視窗的網址 `http://localhost:<埠>/` 連不到後端，啟動器一開始就停下說明（第 5 節），不去開一個開不了畫面的後端。app 視窗的網址照舊是 `http://localhost:<埠>/`（`localhost` 只對應 `127.0.0.1` 與 `::1`）。

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
| `jobsWhileRecording` | `pause` | 偵測到本機重錄正在執行時，這次開的後端要不要跑背景工作：`pause`（預設：暫停；上傳的考卷先排隊，錄完後「關閉出題系統」再「出題系統」才開始）／`run`（照跑，佇列裡已有的工作會開跑，和錄製搶 CPU 與記憶體）。沒在錄製時兩者沒有差別。〔Owner 2026-09-27 DL-4 選 2〕預設從 `run` 改成 `pause`（第 8 節 DL-4） |

偵測到本機重錄正在執行時，就算設了 `stopDocker`／`stopOllama` 也不會關（錄製要用測試庫與 Ollama）。

〔2026-09-27，DL-4 審查〕`jobsWhileRecording` 的新預設 `pause` 只在 `config.json` **沒寫這一項**時生效。之前把舊範本（當時寫 `"run"`）整份複製成 `config.json` 的話，裡面的 `"jobsWhileRecording": "run"` 會繼續蓋過新預設：打開 `exam_pro\data\launcher\config.json`，把這一行刪掉（或改成 `"pause"`）。沒有這個檔案就什麼都不用做。

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

順序：（〔DA-11〕`.env` 的 `HOST` 只聽某個區網位址 → 開啟動畫面報 `host-unsupported`，後面都不做）→ 健康檢查（已在跑且資料庫正常 → 直接開 app 視窗）→ 啟動畫面 → `.env`／`node_modules`／`DATABASE_URL` → 錄製偵測 → 資料庫（連得上就不碰 Docker；錄製中又連不上 → 報錯、不動 Docker；否則 `docker info` →（需要時）開 Docker Desktop、輪詢就緒 → `docker compose up -d --wait` → 等資料庫）→ Ollama（`.env` 的模型有 `ollama:` 才做；失敗只警告）→ migration（只讀、只提示）→ 背景啟動 `node server.js` → 等健康檢查 → 啟動頁轉到系統首頁。

- **後端聽的位址**（〔DA-11＝1〕）：`server.js` 聽 `.env` 的 `HOST`，預設 `127.0.0.1`（`config/listenHost.js`）。`lib/probes.js` 的 `listenFromEnv` 用同一支判斷健康檢查與關閉通道要連哪個位址（`probes.base`）；只聽 `localhost` 連不到的位址（某個區網位址，或 `127.0.0.1` 以外的 `127.x`）時 `supported:false`，`launcher.initialFacts` 把它放進 `facts.listen`，`plan.nextAction` 一開始就報 `host-unsupported`；關閉捷徑同樣不送任何請求、只跳說明（`stopper.js`）。啟動器從不改後端的 `HOST`：後端與 `npm start` 同樣自己讀 `.env`。
- **後端怎麼開**：`spawn(node.exe, [server.js], {detached:true, windowsHide:true})`，stdout／stderr 附加到 `data\logs\server-日期.log`（以啟動那天命名，之後不換檔；實際路徑記在 `server.json` 的 `logFile`）。環境＝啟動器自己的環境（與在命令提示字元 `npm start` 相同，後端照舊自己讀 `.env`）**只多一個** `LAUNCHER_CONTROL_TOKEN`（64 個十六進位字元的一次性權杖），同一份寫進 `data\launcher\server.json`。
- **錄製偵測**：PowerShell `Get-CimInstance Win32_Process` 列出 node／cmd 的命令列，看有沒有 `record_local.bat`、`cassettes:rerecord`、`rerecord_all.js`、`eval:record`、`record_embeddings.js`、`record_cassettes.js`（`lib/windows.js` 的 `RECORDING_PATTERNS`）。重錄工具本身沒有鎖檔，所以不改它、只看程序。錄製中：資料庫本來就開著 → 照常起後端（它用 5442 的開發庫，錄製用 5433 的測試庫）；〔Owner 2026-09-27 DL-4 選 2〕**預設 `jobsWhileRecording:"pause"`：以 `JOB_RUNNER=off` 起後端**（背景工作暫停，`server.json` 記 `jobsPaused:true`，`server-日期.log` 的開頭那行也寫明），注意事項說明錄完後怎麼恢復；Owner 把它改成 `"run"` 時照常跑背景工作，注意事項改說**佇列裡已有的背景工作一起來就會開跑**、和錄製搶 CPU 與記憶體、怎麼改回 `pause`；資料庫沒開 → 報錯，不執行 `docker compose`（避免重建到 tmpfs 的測試庫）。讀不到程序清單 → 不當成錄製中，但加一條注意事項。
- **Ollama 需不需要**：`lib/models.js` 依 `.env` 算各角色實際的模型（與 `config/models.js` 同一條預設與退回鏈，單元測試逐一比對），有任何一個會用到的是 `ollama:` 才需要。`LOCAL_EXTRACT_MODE=ocr`（預設）不要求看圖模型。`OLLAMA_HOST` 指向別台電腦時不去開本機的 Ollama。
- **不自動升級**：只下 `SELECT version FROM schema_migrations`，與 `migrations/*.sql` 比對（`utils/migrationStatus.js`，與 `migrate.js` 同一條排序規則）。
- **同時點兩次**：`data\launcher\launch.lock` 記著第一個啟動器的 PID 與啟動頁網址；第二個只把那個啟動頁再開一次就結束。鎖超過 20 分鐘或 PID 不在就視為殘留。
- **結束碼**：預期中的失敗由啟動頁或訊息框說明，啟動器以 0 結束；未預期的例外寫進 `launcher-日期.log` 並以 1 結束，`run_hidden.vbs` 看到非 0 會跳訊息框指向 log 資料夾。
- **後端聽不了埠**（審查 dec/desktop-launcher 第 2 件）：`server.js` 聽不了埠時印出錯誤碼並以 1 結束（7.3）；啟動器從 log 認出 `EADDRINUSE`（被佔用 → 查是誰）或 `listen EACCES`（查不到誰在聽 → 「埠被 Windows 保留」，提示 `netsh interface ipv4 show excludedportrange protocol=tcp`；查得到 → 同被佔用）。另外防舊版 `server.js`（listen 錯誤被 Express 5 吞掉、不結束也不聽埠）：等後端逾時時，如果自己開的後端還活著、而 netstat 查到這個埠被**別的** PID 聽著，就先 `taskkill /PID … /T /F` 結束它、刪掉 `server.json`，再報埠被佔用；埠上沒人在聽（只是慢）或聽著的就是它自己時不結束，照舊報逾時。
- **健康檢查逾時**（審查第 5 件）：連續兩次逾時會被歸為「埠上有別的程式」。這時再用 netstat 比對：聽著這個埠的若正是 `server.json` 記的 PID（而且是 `node.exe`），啟動器報「出題系統的後端沒有回應」、關閉捷徑說「後端正忙，稍後再按」，不再說成別的程式。

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
- app 視窗：`msedge.exe --app=http://localhost:3000/ --user-data-dir=%LOCALAPPDATA%\TutorExamBank\browser-profile\edge --no-first-run --no-default-browser-check`；沒有 Edge 用 Chrome 的同一組參數；都沒有用預設瀏覽器（`rundll32 url.dll,FileProtocolHandler`）。網址一定用 `localhost`（`ALLOWED_ORIGINS` 預設只放 `http://localhost:3000`）。〔DA-11〕後端預設只聽 `127.0.0.1`：Edge／Chrome 把 `localhost` 解析成 `::1` 與 `127.0.0.1`，先試的那個被拒絕時會改試另一個，所以照樣開得起來〔推論：Chromium 對一個主機名稱的多個位址逐一嘗試；Windows 上要實際看一次，見 `docs/desktop-app-design.md` 10.5 節的 Owner 驗收〕。
- **視窗一定要看得到（`windowsHide`）**（審查 dec/desktop-launcher 第 1 件）：Node 的 `windowsHide:true` 在 libuv 是 `UV_PROCESS_WINDOWS_HIDE`，除了不開主控台，還會把 `STARTUPINFO.wShowWindow` 設成 `SW_HIDE`；GUI 程式第一次顯示視窗時照它決定（`start /min chrome` 開成最小化就是這個機制）。原本所有程式都這樣開，Edge 可能在背景載入啟動頁、啟動器以為畫面已送達，Owner 卻什麼都看不到。現在 `lib/system.js` 的 `exec`／`spawnDetached` 多一個 `hide`（預設 `true`）：**Edge、Chrome、rundll32、Docker Desktop.exe、`ollama app.exe`、顯示訊息框的 PowerShell 傳 `false`**；`node server.js`、`ollama serve`、netstat、tasklist、taskkill、docker CLI、不顯示視窗的 PowerShell 維持 `true`。GUI 程式本來就不開主控台；訊息框的 PowerShell 不是 detached，沿用啟動器自己那個（已被 `run_hidden.vbs` 隱藏的）主控台，所以都不會冒出黑色視窗。Linux 會忽略 `windowsHide`，雲端只能斷言傳下去的選項（`desktopLauncherRun`、`desktopLauncherSystem`），**實際效果要在 Windows 上驗收**。

### 7.3 健康檢查、關閉通道、聽不了埠（後端只改這三處）

**`GET /api/health`**（`controllers/healthController.js`，`app.js` 3a）：

```json
200 {"service":"tutor-exam-bank","status":"ok","version":"1.0.0","db":{"ok":true},
     "migrations":{"applied":"0020_output_truncated_review.sql","latest":"0020_output_truncated_review.sql","pending":[],"unknown":[]}}
503 {"service":"tutor-exam-bank","status":"degraded","version":"1.0.0","db":{"ok":false},"migrations":null}
```

- **刻意掛在 `apiKeyAuth` 之前**：啟動器與關閉捷徑要先認出「3000 埠上是不是這套系統」才決定開視窗、報埠衝突或送關閉；`.env` 的 `API_KEY` 可能在後端啟動後被改過，帶金鑰去問會被 401 擋住而分不出是誰在聽。
- 不洩漏資料：只有服務名稱、版本、資料庫連不連得上、migration 檔名；連線錯誤的原文（可能含帳號）一律不回。首頁本來就不經 `apiKeyAuth`（它把 `API_KEY` 注入頁面），這支不會讓「沒金鑰能拿到的東西」變多。只有 GET、不寫資料庫、資料庫查詢最多等 2 秒、`Cache-Control: no-store`。
- 限流：每次都查一次資料庫，所以**本機以外**的來源套既有的 `middleware/rateLimit.js`（每來源每分鐘 60 次，超過 429）。本機（socket 對端是 `127.0.0.0/8`／`::1`）不限：啟動器等後端時每秒問一次。判斷本機看 socket 的對端位址，不看 `req.ip`（設了 trust proxy 時可以用標頭偽造）。~~後端又綁在所有網路介面（DA-11）~~〔DA-11＝1，2026-09-27〕後端預設只聽 `127.0.0.1`，這時只有本機來源、限流不會觸發；Owner 設 `HOST=0.0.0.0` 開放區網時，區網來源才被限流。規則不變。
- 其他 `/api` 路由照舊要金鑰（單元與整合測試都有斷言）。

**`/api/launcher/status`、`POST /api/launcher/shutdown`**（`services/launcherControl.js`，`app.js` 3b、`server.js` 最後一行）：

- **只有環境裡有 `LAUNCHER_CONTROL_TOKEN` 的後端（由啟動器開的）才掛**；`npm start`、`npm run dev`、CI、測試都沒有這個變數，請求落到既有的 `/api` 路由（設了 `API_KEY` 又沒帶金鑰先回 401，否則 404），行為逐位元不變。`server.js` 只是把 `server` 與 `runner` 的參照交給它。
- 照慣例掛在 `apiKeyAuth` 之後（設了 `API_KEY` 就要 `x-api-key`），另外要 `x-launcher-token`（timing-safe 比對，錯了 403）。
- 為什麼要這條通道：Windows 沒有 SIGTERM，背景（沒有主控台）的 `node server.js` 收不到 Ctrl+C。
- 關閉順序：`runner.stop()`（不再認領新工作，不打斷在途的）→ `server.close()` → 等在途工作歸零（或到 `grace_ms`）→ 在途歸零才關連線池 → `exit(0)`。時限到了還有在途工作就**不關連線池、直接結束**（〔`dec/r8-b1-abandon`〕現在只在「放棄之後還有工作單位收不了尾」時才這樣，見下一段）：先關池的話在途工作接下來的查詢會失敗、被記成一次節點錯誤；直接結束則在途的工作單位停在原狀態，租約（`JOB_LEASE_MS`，預設 3 分）到期後下次開機重新認領——與當機、nodemon 重啟同一條既有保證（`workers/jobRunner.js` 檔頭）。
  〔2026-09-27，`dec/r8-b1-abandon`，行為變更〕時限到了還有在途工作時，先**放棄**它們：`runner.shutdown({ abandon: true })`（jobRunner 檔頭；桌面版的「現在放棄」也是這一條）中止在途節點，被放棄的不寫結果、不記成失敗或逾時、不動重試次數，只放掉**自己的**租約（值等於自己認領／續租時寫的那一個才清，所以同時開著的桌面版或另一個後端手上的租約不會被放掉），最多等 `ABANDON_WAIT_MS`（10 秒）；都收尾了就照常關連線池、`exit(0)`，**下次開機立刻重新認領**。放棄後還有工作單位沒收尾（例如卡在同步運算）才退回上面那條「不關連線池、直接結束、等租約到期」。重跑點不變（下一點）。關閉捷徑（`stop.js`）與 `/api/launcher/*` 的形狀都沒改。〔審查修正 `dec/r8-b1-abandon-fix`〕`runner.shutdown` 會先等正在認領的那一輪 tick 結束，剛認領到的那一列不開始、放掉租約，所以它回報「都收尾了」之後在途數不會再變多，接著關連線池是安全的（原本 tick 卡在認領的交易裡時，那一列會在連線池關掉之後才開始、失敗，要等租約到期）。Windows 上的驗收見 `docs/desktop-app-design.md` 6.2 節第 14 步〔要實測〕。
- **重新認領後從哪裡接著跑，看工作單位**（`dec/desktop-launcher-fix2` 更正；原本寫一律「從那一格重跑」）：
  - 單題（`job_questions`，`runJobQuestion`）：一次認領只跑一個節點，跑完就連同狀態寫回、放掉租約。中斷時那一列還停在原狀態，重新認領後重跑那一個節點（從節點開頭，不是從節點內部），前面的節點不重做。
  - 拆題（`jobs` 的 `kind='pdf'`，`runExtractJob`）：整份 job 是一個工作單位，`planChunks` 切出的塊依序跑。〔`dec/r7-checkpoints`，Owner 第六輪 DA-13＝2〕每一塊拆完時，「建這一塊的題目列」與「寫這一塊的 `extract` 事件（outcome `pass`／`skipped`，`detail` 有 `chunk`、`page_range`、`created`）」在同一個交易；這一列事件就是檢查點，不需要新欄位或 migration。重新認領時（`planResumeChunks`）跳過已有檢查點的塊，只從被中斷的那一塊接著拆；塊號不變，所以題號（塊號 × 1000 ＋ 塊內位置，`agents/extract.js`）、附圖配對、承上題的「前一塊」都和一次跑完相同。被中斷的那一塊一列題目都不會留下（交易沒提交），重拆時就算模型這次拆出不同的題數，也不會和上一輪的半套混成重複列。每塊頁數在兩輪之間變了（換了本機／Gemini 模式、改了 `JOB_PDF_CHUNK_PAGES`）時，已拆完的前幾頁照樣跳過，其餘頁用新的頁數切、塊號接在後面，不會撞到已建好的題號（這一點和設計稿第 36 項「只比頁碼範圍」不同，待 Owner 確認）。〔`dec/r7-checkpoints-fix`〕檢查點不是從第 1 頁起連續、塊號遞增的一串（中間有洞、同一個頁碼範圍兩個塊號等；塊依序跑、`page_count` 建立後不變，正常流程到不了，只有舊版程式留下的紀錄或人工改過才會）時，`planResumeChunks` 回 `inconsistent`、**不排任何塊**，job 直接 `failed`，`jobs.error` 寫「拆題檢查點對不上」，按重試也停在這裡（處理方式見 `docs/ops/runbook-job-stuck.md`）。原本這種情況退回「只跳過頁碼範圍相同的塊、其餘照這次的塊號跑」，會撞號（ON CONFLICT 悄悄丟掉新題）也會重拆已拆過的頁；「題號不撞、不重拆、塊號照頁碼順序」三者沒辦法同時做到，所以改成停下來。〔`dec/r7-checkpoints-fix`〕每一塊都已拆完、PDF 卻已經刪了（上一輪在刪檔之後、轉 `processing` 之前被殺）時直接轉 `processing`，不再報「PDF 原檔不存在」。「失敗後按重試」（`POST /api/jobs/:id/retry`）也一樣從失敗的那一塊接著拆（原本整份從第 1 塊重拆）。原本的行為（`dec/desktop-launcher-fix2` 寫的）：重新認領時不看哪幾塊已經做完，從第 1 塊整份重拆，每一塊都再呼叫一次 OCR 與模型。
  - 變式生成（`kind='variant'`，`runGenerateJob`）：〔`dec/r7-checkpoints`〕重新認領時跳過 `job_questions` 已經有那個 idx 的題，只生成缺的（原本從第 1 題重新生成、已存在的結果撞 UNIQUE 丟掉）。「缺的」是 `job_questions` 沒有的每一個 idx（設計稿第 36 項）：被中斷的那一題與之後的，**也包括中斷點之前沒過閘門的題**（會再呼叫一次模型，這次過了就多建一題）；預算用盡而略過的題會在呼叫前再檢查一次預算（預算沒變就照樣略過、不呼叫模型）。所以只有「中斷點之前每一題都建成了」時，結果才和一次跑完完全相同。兄弟題幹照舊逐題從資料庫讀（`readVariantSiblings`，依 idx 排序）（`variants.pg.test.js` 的 DA-13 案例）。已建好的題照樣算進「建了幾題」，全部建好才被中斷的 job 重新認領後不會被當成一題都沒建成而 `failed`。〔`dec/r7-checkpoints-fix`〕建好一題時「建列＋寫 `generate` 的 pass 事件」也在同一個交易（比照拆題）：原本兩句各自提交，在兩句之間被殺的話，這一題重新認領時被當成做完而跳過，它的 pass 事件（`text_gate`、`sim`、`jq_id`、`cost_usd`）永遠不會寫入，每日預算（`DAILY_COST_BUDGET_USD`，讀 `job_events`）會少算這一次。
  - 被打斷的那一次呼叫不會留下事件與用量紀錄（`writeEvent`／`chargeJob` 都在 `invokeNode` 回來之後）。模型已經回來、還沒寫完檢查點就被殺的那一塊，用量已經記了（供應商確實收了費），重拆時會再記一次。
  - 拆題與變式 job 在最後轉成 `processing` 之後一律檢查一次能不能收尾（`maybeFinishJob`）：接著拆的時候，前幾塊的題常在這一塊拆完之前就已經走到終態，這一塊又沒拆出題目的話，原本 job 會一直停在 `processing`。
  - `runner.stop()` 只停止認領、不會在塊與塊之間停下，所以「等在途工作收尾」對拆題而言是等整份卷拆完（本機 OCR 為主的 4 頁卷估計約 1～1.5 小時，`docs/local-mode.md` 10.12）。

**聽不了連接埠**（`server.js` 的 listen callback、`utils/listenFailure.js`；審查 dec/desktop-launcher 第 2 件，~~待 Owner 確認 DL-5~~〔Owner 2026-09-27 DL-5 選 1〕保留）：

- Express 5 的 `app.listen` 用 `server.once('error', callback)` 把 listen 的錯誤交給 callback，**不會丟出來**。原本的 callback 不看參數：埠被佔用時照印「已成功安全啟動」、不結束（連線池與 jobRunner 讓行程活著）、不聽任何埠，卻繼續認領、執行背景拆題；啟動器等不到健康檢查、關閉捷徑也找不到它（審查時在 Linux 重現過）。
- 現在 callback 收到錯誤就在 stderr 印出錯誤碼、Node 原本的訊息（例：`listen EADDRINUSE: address already in use 127.0.0.1:3000`；〔DA-11〕之前沒指定位址時是 `:::3000`）與處理方式（`EACCES` 時提示 `netsh … excludedportrange`），寫完再以結束碼 1 結束（Windows 主控台的 stderr 是非同步的，直接 `process.exit` 可能截掉訊息）。`npm start` 也一樣；正常啟動的行為不變。
- 由 `desktopServerListen.test.js` 真的執行 `server.js` 驗證：埠被佔用 → 結束碼 1、印 `EADDRINUSE`；埠空著 → 照印「成功安全啟動」。
- 〔DA-11＝1〕`HOST` 寫成這台電腦沒有的位址（`EADDRNOTAVAIL`）或查不到的名稱（`ENOTFOUND`）時，說明改成刪掉 `HOST`（只給本機）或 `HOST=0.0.0.0`（區網）。同一支測試真的執行 `server.js` 驗證：沒寫 `HOST` → 只聽 `127.0.0.1`（這台電腦的區網位址連不到）；`HOST=0.0.0.0` → 區網位址也連得到；`.env` 的 `HOST` 讀得到、系統環境變數優先。連真的資料庫的版本在 `test/integration/listenHost.pg.test.js`。
- 〔要實測；審查 `dec/r7-decisions-host`〕**同一個埠已經有別的程式在聽時，改綁 `127.0.0.1` 之後不一定報 `EADDRINUSE`**：
  - Windows 的 Winsock 相容例外：沒設 `SO_EXCLUSIVEADDRUSE` 時，別的程式已經聽 `0.0.0.0:3000`，新的程式照樣綁得上 `127.0.0.1:3000`（微軟〈Using SO_REUSEADDR and SO_EXCLUSIVEADDRUSE〉的表格：先以預設選項綁萬用位址、再以預設選項綁特定位址 → Success）。Node 用的 libuv 在 Windows 上兩個選項都不設（`src/win/tcp.c` 的註解）。Linux 上同樣的情況會報 `EADDRINUSE`，所以 `desktopServerListen` 測不出這個差異。
  - 別的程式只聽 IPv6（`[::1]:3000`，或只收 IPv6 的 `[::]:3000`）時，綁 `127.0.0.1:3000` 在任何作業系統都不衝突；瀏覽器開 `localhost` 先試 `::1`，就會連到那個程式。
  - 啟動器開後端之前先問 `127.0.0.1:3000`：對方聽 `0.0.0.0` 或雙堆疊的 `[::]` 時會回應，被認成「埠被佔用」，所以第一種擋得住；只聽 IPv6 的第二種擋不住。直接 `npm start` 兩種都擋不住。
  - 這次沒有加自動檢查（Linux 的測試重現不了 Winsock 的行為）。要補強時，在後端起來之後用 netstat（`probes.describePort` 同一套解析）找同一個埠上的其他 PID，有就當成埠衝突。Owner 端的症狀與查法在 `docs/desktop-app-design.md` 10.5 節第 4 點。

### 7.4 不影響既有行為

- `npm start`／`npm run dev`：多了 `/api/health`（新的 GET，不需金鑰；本機以外每分鐘 60 次）；沒有 `LAUNCHER_CONTROL_TOKEN`。**聽不了連接埠時改成印出原因並以結束碼 1 結束**（原本照印成功、變成不聽埠的背景程序；7.3，DL-5）。〔2026-09-27，DA-11＝1〕**後端改聽 `HOST`、預設 `127.0.0.1`**：同一個 Wi-Fi 的其他裝置預設連不到（原本綁所有網路介面）；要區網存取時設 `HOST=0.0.0.0`（`exam_pro/README.md`「區網存取」）。啟動訊息多一段括號說明實際聽的位址。其餘逐位元不變。
- CI：不裝、不跑任何 Windows 的東西；新增的單元測試都在雲端 Linux 上跑（Windows 指令經可注入的 `sys` 換成假的）。沒有新增相依套件。〔DA-11〕CI、整合測試與 e2e 都用 supertest 或自己在 `127.0.0.1` 開的伺服器，沒有依賴後端綁 `0.0.0.0`；`record_local.bat` 不啟動後端，不受影響。
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
| `exam_pro/controllers/healthController.js`、`utils/migrationStatus.js`、`services/launcherControl.js`、`utils/listenFailure.js`（`server.js` 用） | 第 7.3 節 |
| `exam_pro/config/listenHost.js`（`server.js` 與 `lib/probes.js` 共用） | 〔DA-11＝1〕後端聽的位址 `HOST`（預設 `127.0.0.1`）、啟動器要連哪個位址、啟動訊息 |
| `exam_pro/scripts/windows/wsl_memory_check.bat` → `scripts/desktop/wsl_memory_check.js` | 〔DA-14、DA-9〕WSL／Docker 記憶體與 Smart App Control 的檢查（只讀取與記錄；說明在 `docs/desktop-app-design.md` 第 10 節） |

單元測試（`npm test`）：`desktopLauncherPlan`（決策的各種狀態組合）、`desktopLauncherRun`（用假的 Windows 筆電把整個啟動流程跑一遍：冷開機、Docker 沒開／沒裝／逾時、錄製中、埠被佔、後端當掉、Ollama 各種狀況、啟動頁沒回應的退路、單一執行個體）、`desktopLauncherStop`、`desktopLauncherControl`（關閉通道與 `app.js` 的掛載順序）、`desktopHealth`、`desktopLauncherWindows`、`desktopLauncherConfig`、`desktopLauncherScripts`（`.bat`／`.vbs`／`.ico`／`status.html`／捷徑內容）、`desktopLauncherConfig`（設定與 `lib/models.js` 的模型退回鏈）、`desktopLauncherSystem`（真的 `lib/system.js`，含 `hide`→`windowsHide`）、`desktopServerListen`（真的執行 `server.js`：埠被佔用時結束；〔DA-11〕`HOST` 的四種情況）、`listenHost`（`config/listenHost.js` 與範本、文件）、`wslMemoryCheck`（只讀的檢查：指令白名單、log 內容）。整合測試：`test/integration/health.pg.test.js`、`test/integration/listenHost.pg.test.js`（真的資料庫）。

`test/unit/lib/desktopWorld.js` 的假後端照 **Express 5** 的真實行為模擬「聽不了埠」：修正後（印說明、結束碼 1，`exit-addrinuse`／`exit-eacces`）與修正前（照印成功、不結束、不聽埠，`listen-swallowed`）兩種都有；每次 exec／spawn 的選項都記下來，測試逐一斷言 `hide`。

### 7.6 長期風險：VBScript 淘汰

兩個捷徑都是 `wscript.exe run_hidden.vbs …`。微軟的時程：Windows 11 24H2 起 VBScript 是「選用功能（預設啟用）」，所以現在能用；預告約 2027 年改成預設停用，之後移除。到時如果 B（Electron 桌面殼）還沒上線，兩個捷徑都會失效（點了沒反應，或跳出 Windows Script Host 錯誤）。

- Owner 端的暫時解法寫在第 5 節常見狀況表（到「選用功能」把 VBScript 加回來）。
- 備案（**未在 Windows 實測**，給 B 的規劃參考）：捷徑改成 Windows 11 內建的 `conhost.exe --headless "<node.exe>" scripts\desktop\launch.js`，同樣不留黑色視窗、也不需要 VBScript。換之前要實測，而且啟動器結束碼非 0 時的訊息框（現在由 `.vbs` 跳）要改由 `launch.js` 自己跳。

## 8. 待 Owner 確認事項（〔2026-09-27〕第六輪已全部答覆）

> 〔Owner 2026-09-27 第六輪〕五題都答了，逐題就地加註「〔Owner 2026-09-27 選 N〕」，原文保留。DL-1、DL-2、DL-3、DL-5 選的都是原本的行為（程式與設定都不必改）；DL-4 選 2，`jobsWhileRecording` 的**程式預設**改成 `pause`（分支 `dec/r7-decisions-host`），Owner 不必寫 `config.json`。一覽表在 `docs/HANDOFF.md` §0.00d。

**DL-1　關閉時有背景工作在跑，怎麼處理**（目前：每次問）〔Owner 2026-09-27 選 1〕定案：每次問（`askBeforeStopWithJobs:true`、`stopGraceSec:120` 維持預設，程式不改）。與設計稿 DA-2 選 3 一致：有工作時問「等完／放棄」，對話框照實寫重跑範圍。〔2026-09-27，`dec/r8-b1-abandon`〕選項與預設都沒變；只是「否」的 2 分鐘到了之後，後端改成先中止在途工作、放掉租約再關（第 4 節、7.3），下次開啟不必等租約到期。

按「關閉出題系統」時，背景可能還有工作在跑。要等它們做完才關，還是時間到就直接關？直接關掉（或直接關機）的話，沒做完的工作下次開啟會自動接著做，但接得上的程度不一樣：

- **單題的檢查**（分類、lint、驗算等，每題分好幾步）：從中斷的那一步重做那一步，前面做完的不重做。最多白費一步（本機一步大多在 10 分鐘內）。
- **整份卷的拆題**：〔`dec/r7-checkpoints`，DA-13＝2〕從中斷的那一塊重拆，已經拆完的塊不重拆。最多白費一塊（本機 OCR 為主一塊 2 頁，約 30～45 分鐘）。原本是從第 1 塊整份重拆（4 頁卷約 1～1.5 小時白做）。
- **變式生成**：只補還沒建成的題，已經建好的題不重做；中斷的那一題與之前沒通過檢查（沒過閘門）的題會再生成一次（本機光生成每題約 3 分鐘）。

「等跑完」遇到拆題，也是等整份卷拆完（後端不會在塊與塊之間停下）。用 Gemini 時，被中斷的那一塊／那一題重做會再付一次費用；本機模式只花時間。

| 選項 | 代價 |
| :--- | :--- |
| 1. 每次問：是＝等跑完、否＝最多等 2 分鐘、取消（**目前**；〔Owner 2026-09-27 選定〕） | 有工作在跑時多一次點擊，而且要自己判斷：選「否」的後果同選項 3；選「是」時，正在拆題的話要等整份卷拆完（本機可能 1 小時以上）才真的關 |
| 2. 一律等跑完（`askBeforeStopWithJobs:false`＋`stopGraceSec:21600`） | 不會白做任何工作；但按了關閉，後端可能還要跑 1 小時以上（正在拆題時）才關；最多等 6 小時，超過照樣直接關，拆題從中斷的那一塊重拆 |
| 3. 一律只等 2 分鐘（`askBeforeStopWithJobs:false`） | 關得快；在途的是單題檢查時最多白費一步（本機大多在 10 分鐘內），是拆題時下次開啟從中斷的那一塊重拆（本機最多白做一塊，約 30～45 分鐘），是變式生成時只補還沒建成的題 |

**DL-2　只關掉系統視窗時，後端要不要跟著停**（目前：不停）〔Owner 2026-09-27 選 1〕定案：關視窗不停後端，要停用「關閉出題系統」。B（Electron 桌面殼）的關視窗行為另由設計稿 DA-2（選 3）處理。

| 選項 | 代價 |
| :--- | :--- |
| 1. 不停，要停用「關閉出題系統」（**目前**；〔Owner 2026-09-27 選定〕） | 忘了關時後端與資料庫一直佔記憶體（後端約 200～400 MB） |
| 2. 視窗關掉、而且沒有背景工作時自動停 | 要多一個在背景盯著視窗的小程式（約 0.5 人日）；Edge 的 app 視窗沒有「關閉」事件可接，只能輪詢，較不可靠 |
| 3. 等 B（Electron 桌面殼）再做：關視窗縮到系統匣、有工作時提示 | 現在沒有；B 的設計稿 DA-2 已列入 |

**DL-3　「關閉出題系統」要不要一併關 Docker Desktop／Ollama**（目前：都不關）〔Owner 2026-09-27 選 1〕定案：都不關（`stopDocker:"no"`、`stopOllama:false` 維持預設）。記憶體改由設計稿 DA-14 的 WSL 上限處理（先量再說，`docs/desktop-app-design.md` 第 10 節）。

| 選項 | 代價 |
| :--- | :--- |
| 1. 都不關（**目前**；〔Owner 2026-09-27 選定〕） | Docker Desktop 的 WSL 虛擬機約佔 1～2 GB 記憶體；Ollama 閒置 10 分鐘後會自己卸下模型，本體很小 |
| 2. 停資料庫容器（`stopDocker:"containers"`） | 省下資料庫的記憶體；Docker Desktop 本身還在 |
| 3. 連 Docker Desktop 一起結束（`stopDocker:"desktop"`）＋`stopOllama:true` | 記憶體省最多；下次開啟要多等 1～3 分鐘；舊版 Docker Desktop 不支援 `docker desktop stop`（會提示手動結束） |

表中的記憶體數字是一般情況的估計，**沒有在 Owner 的電腦上實測**；要決定 DL-2、DL-3 之前，可以在工作管理員看「VmmemWSL」（或「Vmmem」，Docker 的虛擬機）與「node.exe」實際佔多少。

**DL-4　錄製（重錄 cassette）進行中時開系統，背景工作要不要跑**（~~目前：照跑~~）〔Owner 2026-09-27 選 2〕定案：錄製中暫停背景工作。`jobsWhileRecording` 的**程式預設**從 `run` 改成 `pause`（`scripts/desktop/lib/config.js`、`config.example.json`、第 6 節的表、啟動畫面的注意事項一起改；分支 `dec/r7-decisions-host`），Owner 不必寫 `config.json`。要回到照跑，在 `config.json` 寫 `"jobsWhileRecording": "run"`。

只在「偵測到重錄正在跑、而資料庫本來就開著」時才有影響（資料庫沒開時啟動器本來就會停下來、不動 Docker）。後端一起來，inline 的 jobRunner 就會認領佇列裡已有的工作（之前上傳、還沒拆完的考卷），開始呼叫 Ollama，不必等你上傳。16 GB 的筆電上，這會和重錄搶記憶體，模型被換進換出，可能讓重錄逾時。

| 選項 | 代價 |
| :--- | :--- |
| 1. 照跑，只在啟動畫面警告（~~**目前**~~，第六輪之前的預設；`jobsWhileRecording:"run"`） | 佇列裡有工作時會和重錄搶 CPU／記憶體，重錄可能逾時、要重跑 |
| 2. 暫停背景工作（`jobsWhileRecording:"pause"`：後端以 `JOB_RUNNER=off` 啟動）〔Owner 2026-09-27 選定，現在的預設〕 | 錄製期間上傳的考卷只會排隊；錄完要點「關閉出題系統」再點「出題系統」，排隊的工作才開始（啟動畫面會提醒） |
| 3. 每次在啟動畫面問你要不要暫停 | 要另外實作（約 0.5 人日）；每次錄製中開系統都要多按一次 |

建議選 2：重錄一次要跑很久，被拖到逾時的損失，比「錄完要重開一次系統」大得多；而且只在錄製中開系統時才會用到。錄製偵測只看程式的命令列（`LLM_MODE=record` 這類環境變數開的錄製偵測不到，第 7.1 節），這三個選項都一樣。

**DL-5　後端聽不了連接埠時直接結束（`server.js` 的既有行為改了，請確認）**（目前：已改成結束）〔Owner 2026-09-27 選 1〕定案：保留修正。〔DA-11〕後端改聽 `HOST` 之後，`HOST` 寫錯（`EADDRNOTAVAIL`）也走同一條路：印原因與改法、結束碼 1。

原本 `server.js` 聽不了埠時照印「已成功安全啟動」、不結束、不聽任何埠，卻繼續跑背景拆題（Express 5 把錯誤交給 callback，callback 沒看）。這次改成印出錯誤碼與處理方式、以結束碼 1 結束；`npm start` 也一樣。

| 選項 | 代價 |
| :--- | :--- |
| 1. 保留修正：聽不了埠就印原因並結束（**目前**；〔Owner 2026-09-27 選定〕） | `npm start` 遇到埠被佔用時會直接結束，而不是看起來啟動成功（這正是修正的目的，沒有別的影響） |
| 2. 還原 `server.js`，只靠啟動器偵測（啟動器逾時時若查到埠被別的程式佔用，會結束自己開的後端） | `npm start` 照舊會變成沒有網頁、卻繼續跑背景拆題的程序；啟動器要等滿 120 秒才發現；`EACCES`（埠被保留）只能報「太久沒有回應」 |

建議選 1。

DL-1、DL-3、DL-4 都只改設定、不改程式：Owner 決定後照選項寫進 `exam_pro\data\launcher\config.json`（選目前的預設就什麼都不用寫）。DL-2 的選項 2、DL-4 的選項 3 要另外實作；DL-5 選 2 要改回 `server.js`。

〔Owner 2026-09-27 第六輪〕DL-1、DL-3 選的就是預設，`config.json` 什麼都不用寫；DL-4 選 2 已直接改成程式預設（不必寫 `config.json`）；DL-2、DL-5 選 1＝現況。沒有任何一題要另外實作。
