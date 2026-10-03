# 給 AI 協作者（Claude、Codex 等）的工作規則

## README 寫作規則

1. **README 只寫「現在」**：系統是什麼、為什麼做、怎麼開始、架構、現行的評測數字、文件索引、授權。
2. **不寫歷史**：開發階段的演進、每一輪的 Owner 決策、修訂紀錄、〔修訂 YYYY-MM-DD〕這類註記，一律寫到 `docs/HANDOFF.md` 或 commit 訊息，不進 README。
3. **細節放專門文件**：完整 API、環境變數總表、驗收清單、設計理由放 `docs/`、`engineering_docs/`，README 只放連結。
4. **長度上限**：根目錄 `README.md` 與 `exam_pro/README.md` 各不超過 200 行。
5. **數字要能重現**：README 裡的評測數字必須是目前 main 上照 CI 設定實跑的結果，改了程式或回放檔就重跑、更新。

第 2、4 條由 `exam_pro/test/unit/readmeRules.test.js` 自動檢查，CI 會擋。

## 其他文件

- 現況、待辦與 Owner 決策紀錄：`docs/HANDOFF.md`
- 本機模式：`docs/local-mode.md`

## 本機開發環境（這台 Windows 電腦）

這一節是這台開發機的操作限制，對 AI 協作者是硬規則。

1. **Git**：所有 `git` 指令一律加 `--no-optional-locks`，避免與開著的編輯器或其他 session 搶 `index.lock`。
2. **不自行刪除**：刪除任何檔案或分支前先問 Owner。
3. **不要動 WSL**：不得執行 `wsl --shutdown`，不得修改 `.wslconfig`。Docker 的 PostgreSQL、Ollama、PaddleOCR 都在上面，關掉會中斷正在跑的 job。
4. **正式資料庫**：執行 migrate、匯入或刪資料之前，先說明要做什麼，再跑 `npm run db:backup`，備份完成才動資料。
5. **長時間工作**：預估會跑很久的工作（例如補錄回放檔可能要好幾小時）先回報預估時間，由 Owner 確認電腦不會進入睡眠後才開始。
6. **本機資源**：只有 CPU 內顯，模型是 Ollama 的 `qwen3:8b` 與 `qwen3-embedding:0.6b`。單題變式生成與助教回答以分鐘計，設計與測試都要假設這個速度。

### Commit、推送與合併

- Commit 走 **Conventional Commits**、訊息用繁體中文，結尾加一行：

  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```

- 推送前先告訴 Owner 要推什麼；**合併到 `main` 一定要 Owner 明確同意**。
- 操作細節（分支鐵律、多 session 協調、destructive 操作前的 backup tag、PR 結構）見 [`.claude/rules/git-workflow.md`](./.claude/rules/git-workflow.md)。

### 不可放寬的界線

- 不削弱測試、不放寬 `exam_pro/eval/thresholds.json`、不改 golden 與既有 cassette（Owner 同意的例外除外）。
- API 金鑰只留在 `.env`，不得寫進程式、測試、commit 或 log。
- 學生姓名不送進模型，一律經 `exam_pro/utils/pseudonym.js`。
