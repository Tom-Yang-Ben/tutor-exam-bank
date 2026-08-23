# HANDOFF — 給下一個 Claude Code 對話的交接檔（2026-08-24）

> 目的：這份檔案讓新的對話在**不重讀歷史**的情況下接手「整合者／審查者」的角色。
> 讀完本檔後，第一件事通常是執行 §6 的「看進度」流程。
> 配套：`~/.claude/projects/.../memory/` 裡有 `roadmap-master-plan.md`、`stage1-status.md`、`stage2-status.md`、`stage3-status.md`（系統會自動載入索引）。

---

## 1. 專案與角色

- **專案**：家教數理題庫系統 `exam_pro/`（Node 24 / Express 5 / PostgreSQL 16 + pgvector（Docker）/ Gemini）。repo `C:\Users\Administrator\Desktop\期中專案`，GitHub `Tom-Yang-Ben/tutor-exam-bank`，CI = GitHub Actions（`unit` 22/24 + `integration`）。
- **使用者**：Ben（家教老師兼一人開發者），偏好「直接幫我做」；重大、不可逆、花錢的動作要先問。用繁體中文。
- **這個對話（我）的角色**：**整合者／審查者**，不是施工者。施工由四個平行的 Claude Code 對話在四個 git worktree 裡做；我負責：寫分工與提示詞、審 S0 的介面凍結、掃進度、在 scratchpad 做四合一試合併並跑全部測試、整理各 WS 的 `questions*-ws*.md` 成裁決、把裁決寫進 `interfaces*.md`、產出通知檔、合併進 main、push、看 CI、錄 cassette、維護 README／memory。**主目錄的 Claude 對話不做 WS 的工作。**
- **worktree**：`..\期中專案-wsA/B/C/D`（四個獨立資料夾，各自 branch）。每個階段開新分支、開**新的** Claude 對話貼提示詞。

## 2. 三階段的狀態（都已合入 main 並 push）

| 階段 | 狀態 | 關鍵文件 |
|---|---|---|
| 規劃 | `docs/roadmap-plan.md`（五章：排程、資料層、Agent 管線、產品面、橫切）；Artifact https://claude.ai/code/artifact/14b7e7a6-2a59-4991-8cee-022ecf19220f | — |
| 階段 1 資料層 | **完成並上線**（2026-08-21 MySQL→PG 切換、D-X1 收尾：mysql2／DB_*／schema.sql 已移除） | `docs/interfaces.md`（裁決 1–27）、`docs/stage1-parallel-prompts.md`、`docs/human-lane-stage1.md`、`docs/cutover-runbook.md` |
| 階段 2 Agent 管線 | **完成**（三輪合併、cassette 錄齊、CI 綠；`FEATURE_PIPELINE=true` 已在本機 `.env`）；A-T16 前後對照**使用者選擇先跳過** | `docs/interfaces-stage2.md`（S0-1～6、S2-1～30）、`docs/stage2-parallel-prompts.md`、`docs/ws-notices-round2/3-stage2.md` |
| 階段 3 產品面 | **第一輪合入 main（`b64f149`），裁決 S3-R1～R28 已發（`106a546`），nlq cassette 已錄（`fd5cf5b`），第二輪小修四條合入 main（`5facafe`，2026-08-24）**；WS 端已無待合併工作 | `docs/interfaces-stage3.md`（§15 = 裁決）、`docs/stage3-parallel-prompts.md`、`docs/ws-notices-round2-stage3.md` |

main 最新：`18db34d`（第二輪合併 `5facafe` → NUL 修正 `5e26224` → variant cassette `18db34d`）。單元 1403/1403、整合 253/253、五個 suite replay 通過。CI **全綠**（unit 22/24 + integration）。四個 worktree 已 ff 到同一點。

## 3. 階段 3 現在卡在哪、下一步

1. ~~第二輪小修~~ **已完成**（2026-08-24 合入 `5facafe`，A／B／C／D 的 questions3-ws*.md 全部結案）。目前沒有發給 WS 的新工作；若第三輪有需要，再開新分支貼新提示詞。
2. ~~nlqHeuristics.js 的字面 NUL~~ **已修**（`5e26224`，改成 `'\u0000'` 逸出）。WS-B 留下的私有測試庫 `tutor_exam_bank_wsb_test` 不用了可 DROP。
3. ~~variant cassette 尚未錄~~ **已錄（2026-08-24，`18db34d`）**：60 次生成、76 次 LLM、60 筆新向量；`gate_pass_rate` **0.15**（9/60）。**26/30 藍本停在 `off_topic`**（`VARIANT_OFFTOPIC_SIM_MIN=0.92`）、1 停 verify、3 全過；replay 掃描 0.85→5、0.88→14、0.90→19 個藍本停在 off_topic（數字在 `docs/variants.md` 第 4 節）。**待裁決：要不要把跑題閾值下修到 0.88～0.90**——改了要**重錄**（新放行的題會走到 classify／lint／verify；record 模式會重呼叫全部 ≈ 再一次費用）。順手修了 `suiteVariant.js` 的雞生蛋閘門（record 模式空目錄永遠不生成）。
4. 人工 lane（使用者）：定案 `eval/golden/nlq.json` 50 句、`eval/golden/variant.json` 30 藍本 → 我跑 `--write-baseline`；之後 `.env` 開 `FEATURE_STUDENTS／FEATURE_NLQ／FEATURE_VARIANTS／FEATURE_SIMILAR=true` 試用三個新分頁；P-15b 把數字填進 `exam_pro/README.md` 的「問題→決策→數字」表。
5. 階段 3 結案後沒有階段 4 規劃；可選的後續：A-T16 前後對照、`config/pricing.js` 填官方價格（目前全 0，`cost_usd` 恆 0）、私有 golden（真題庫）。

## 4. 本機環境（已確認）

- Docker：`exam_pg`（開發庫，**埠 5442**，5432 被原生 PG17 佔用）、`exam_pg_test`（測試庫 5433，tmpfs）。`npm run db:up` 起來。
- `exam_pro/.env`（不進版控）重點：`DATABASE_URL=...5442`、`TEST_DATABASE_URL=...5433/..._test`、`GEMINI_API_KEY`（**付費層**，2026-08-23 開通）、`EMBED_MODE=live`、`LLM_MODE=live`、`MODEL_EXTRACT=gemini:gemini-3.5-flash`、`MODEL_VERIFY=gemini:gemini-3.1-pro-preview`、`GEMINI_RPM=30`、`FEATURE_PIPELINE=true`；階段 3 的旗標尚未加（預設 false）。
- migrations 0001–0005 兩庫都套用；階段 3 不需新 migration。
- 每日 02:00 Windows 工作排程器「題庫每日備份」→ `exam_pro/backups/`；MySQL80 服務已停（Manual），資料庫保留不動；`Desktop/期中專案_資料庫備份/` 有 cutover dump。

## 5. 協作規則（凍結介面制度）

- 三份 `docs/interfaces*.md` 是凍結契約，**只有我（代使用者）可以改**；各 WS 發現問題寫 `docs/questions<N>-ws<X>.md`，我整理成裁決（編號 S2-*／S3-R*）寫進對應檔的裁決節，並產 `docs/ws-notices-*.md` 給使用者貼。
- 檔案所有權表在各 `interfaces*.md` 的 §10；`routes/index.js` 分區塊 append-only；`package.json` scripts 歸 WS-D；`.env.example` 只有 S0／我改。
- 測試金字塔：`npm test`（不連 DB／不連 Gemini）；`test/integration/` 只讀 `TEST_DATABASE_URL`（`_test` 後綴）；**整合測試必帶 `--test-concurrency=1`**（各檔共用測試庫會互相 TRUNCATE）；e2e `npm run test:e2e`。
- eval：`eval/run.js --suite retrieval|classify|pipeline|nlq|variant`，CI 恆 `LLM_MODE=replay`／`EMBED_MODE=fixture`；replay miss 在 main 是錯誤；門檻 `eval/thresholds.json` = 第一次量測 −0.03、只升不降（ratchet）；cassette 鍵含模型 ID（`config/models.js` 是單一真相，`ci.yml` 明寫）。
- 原則：prompt 不是保證、伺服器端驗證才是；協調層是程式碼；部分入庫；量測驅動。

## 6. 我的標準流程（照做即可）

**看進度**：
```bash
cd "C:/Users/Administrator/Desktop/期中專案" && for d in wsA wsB wsC wsD; do p="../期中專案-$d"; echo "=== $d ($(git -C $p branch --show-current)) ahead $(git -C $p rev-list --count main..HEAD) behind $(git -C $p rev-list --count HEAD..main)"; git -C $p log --oneline main..HEAD | head; git -C $p -c core.quotepath=false status --short | head -5; ls $p/docs/questions3-*.md 2>/dev/null; done
```
**試合併**（在 scratchpad 開臨時 worktree，不碰 main）：
```bash
SCR="<scratchpad>/integN"; git worktree add "$SCR" -b integ/xxx main; cd "$SCR"; for b in <四個分支>; do git merge --no-edit "$b" || { git merge --abort; echo CONFLICT; }; done
cd exam_pro && cp ../../期中專案/exam_pro/.env .env && npm ci
npm test
node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/integration/**/*.test.js"
for s in retrieval classify pipeline nlq variant; do node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite $s | tail -2; done
```
全綠（或紅都可解釋）→ `git merge --ff-only integ/xxx` 進 main → `git push origin main` → 四個 worktree `git merge --ff-only main` + `npm ci` → `gh run watch <id>` 看 CI → 刪臨時 worktree 與分支。
**裁決**：讀四份 questions → 寫裁決表進 `interfaces-stageN.md`（新增一節，優先於條文）→ 必要時改 `.env.example`／`.gitignore` → 寫 `docs/ws-notices-roundK-stageN.md`（四段，可直接貼）→ commit、push、ff worktrees → 回報使用者。
**commit 訊息**：繁中、`feat|fix|docs|eval|test(範圍): 說明`，結尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 7. 錄 cassette（需要金鑰，只在主目錄 main 上做）
```bash
cd exam_pro
LLM_MODE=record EMBED_MODE=record node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite nlq       # 已錄
LLM_MODE=record EMBED_MODE=record node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite variant   # 已錄（約 25 分鐘；背景 Bash 10 分鐘會逾時，用 PowerShell Start-Process 分離跑）
node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite <s>   # replay 驗證
git add eval/cassettes eval/fixtures/embeddings.*.json
```
（shell 環境變數優先於 `--env-file`；付費層 `GEMINI_RPM=30` 可行。）

## 8. 踩過的坑（避免重踩）
- Git Bash heredoc 會吃掉 `\\`：寫含反斜線的 JS／測試一律用 Write／Edit 工具，不用 `cat <<EOF`。
- repo 檔案多為 CRLF：用 node 做字串替換時 `includes('...\n...')` 會對不上，用 regex 或 Edit 工具。
- 自動模式的 classifier 會擋某些寫正式庫／系統的指令（`import_pg.js --apply`、`schtasks`、`Register-ScheduledTask`）：請使用者在對話框用 `! <指令>` 自己跑（注意 Git Bash 的 `/Create` 要加 `MSYS_NO_PATHCONV=1`）。
- `config/db.js` 只認 `DATABASE_URL`；**eval／測試凡會寫表者只准連 `TEST_DATABASE_URL`**（裁決 26）。
- Node 22 vs 24 差異：`Math.pow` 浮點（科學記號改字串 e-notation）、`--check` 模組偵測（暫存目錄放 `package.json` 釘 commonjs）。
- 免費層 Gemini 每模型每日 20 次；現已付費。
- 主目錄 `exam_pro/node_modules` 偶爾壞掉 → `npm ci`。
- 四個 worktree 的 `.env` 是從主目錄複製的；`npm ci` 要各自跑。

## 9. 給新對話的起手式
1. 讀本檔 + memory（自動）。
2. 跑 §6「看進度」。
3. 依狀態接續：四條第二輪未完 → 等；完了 → 試合併 → 合併 → CI；之後處理 variant 錄製（先問費用）、golden 定案、門檻、試用、README 數字。
4. 回報時用表格、講清楚「做了什麼／數字／接下來要使用者做什麼」。
