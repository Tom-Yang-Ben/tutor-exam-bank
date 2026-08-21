# 階段 1 人工 lane 操作手冊（開發者本人）

> 前提（已確認）：`origin/main` = `76919da`，CI 綠；Docker `exam_pg`(5442) / `exam_pg_test`(5433) 在跑；MySQL80 服務在跑、3306 開著；`.env` 有 `GEMINI_API_KEY`、`DATABASE_URL`、`TEST_DATABASE_URL`、`DB_*`（舊 MySQL）。
> 所有指令都在 `exam_pro/` 資料夾內執行。**順序有講究**：先改題目文字、再錄向量（題幹一改 `embed_text` 的 hash 就變，向量表會對不上）。

> **狀態（2026-08-21）**：步驟 1–5 全部完成（切換上線），並已同日執行 D-X1 收尾（見 `docs/cutover-runbook.md` §3-C 的執行紀錄）。本檔保留作為流程紀錄。

## 總覽

| 步驟 | 做什麼 | 預估 | 產出 |
|---|---|---|---|
| 1 | 核對 60 題 fixture 的答案與題幹 | 1.5–2 小時 | `eval/fixtures/questions.public.json` 定稿 |
| 2 | 錄向量 fixture（D-V0） | 10 分鐘 | `eval/fixtures/embeddings.gemini-embedding-001.768.json` |
| 3 | 定案檢索 golden 40 筆、寫門檻初值 | 1–1.5 小時 | `eval/golden/retrieval.json` 定稿、`eval/thresholds.json` |
| 4 | 真資料遷移彩排（對測試庫） | 30 分鐘 | `migrate/out/` 匯出檔 + 姓名合併報告 + verify 全過 |
| 5 | 切換之夜（D-X1） | 1 小時 | 應用程式跑在 PG 上 |

做完 1–3 就是 **M2**（檢索）的驗收物；做完 4–5 就是 **M1**（資料層切換）。

---

## 步驟 1：核對 60 題 fixture（1.5–2 小時）

開 `eval/fixtures/questions.public.json`。每題看三件事：

1. `answer_text` 的答案對不對（含選項代號與推導一句話）。
2. `question_text` 的 LaTeX 寫法合理（**`latex_broken: true` 的 10 題是故意寫壞的，不要修**；`broken_kind` 說明壞在哪）。
3. `chapter` 是否真的屬於 `config/chapters.js` 的那一章、`difficulty` 是否合理。

改完後把檔頭的 `_status` 改成不含 `needs_human_confirm` 的字樣，例如：
```json
"_status": "confirmed 2026-08-22 — 開發者本人逐題核對完成；60 題均為自行編寫。"
```
（`eval/lib/fixtures.js` 就是用這個字串判斷是否已核對。）

完成驗證：
```powershell
npm test                # 268 項仍全綠（載入時會過章節硬閘門）
```

## 步驟 2：錄向量 fixture（10 分鐘，花 60 次 embedding 呼叫）

```powershell
# 2-1 .env 把 EMBED_MODE 從 fixture 改成 record（record 模式才會呼叫 Gemini 並寫檔）
# 2-2 先看會送幾題、多少字，不呼叫 API
node eval/record_embeddings.js --dry-run
# 2-3 真的錄
npm run eval:record
# 2-4 .env 改回 EMBED_MODE=fixture（之後本機與 CI 一律只讀檔）
```

產出 `eval/fixtures/embeddings.gemini-embedding-001.768.json`（約 0.6 MB，**要進版控**，CI 靠它）。

驗證：
```powershell
node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite retrieval
```
三欄（LIKE／純向量／hybrid）都該有數字；再跑整合測試，D-R2 不再 SKIP：
```powershell
node --env-file=.env --env-file=eval/.env.replay --test "test/integration/**/*.test.js"
```

如果之後又改了任何一題的 `question_text`／`chapter`／`question_type`，要重跑 2-1～2-4。

## 步驟 3：定案 golden 40 筆 + 寫門檻初值（1–1.5 小時）

3-1 **先用有向量的候選池重產一次建議稿**（只做這一次，之後不要再跑，它會覆寫整個檔）：
```powershell
npm run eval:golden        # = node eval/tools/suggest_golden.js
```
3-2 開 `eval/golden/retrieval.json`，每一筆：
- `query.value` 是 fixture 題號；看 `_suggestion.pool` 列出的候選題，決定哪些**真的是「同概念、換數字」的相關題**→ 放進 `relevant`；明顯同章但不同概念的→ `hard_negatives`（可留空）。
- 判好就把 `needs_human_confirm` 改成 `false`（`_suggestion` 可刪可留，loader 不看它）。
- 40 筆都改完，檔頭 `_status` 同樣改成 `confirmed …`。

3-3 寫門檻初值（第一次量測 − 0.03，之後只升不降）：
```powershell
npm run eval:baseline      # = eval --suite retrieval --write-baseline
```
3-4 commit 這三個檔（fixture、embeddings、golden、thresholds），push，看 CI integration job 的 step summary 有三欄表。

把三欄數字（含日期、模型 ID、commit）貼進 `exam_pro/README.md`——這就是規劃 §2.8 說的「對照表是驗收物」。

## 步驟 4：真資料遷移彩排（30 分鐘；全程對**測試庫**，不碰開發庫）

```powershell
# 4-1 測試庫清空（eval 會在裡面留 60 題 fixture；import 預設拒絕疊在既有資料上）
docker exec exam_pg_test psql -U exam -d tutor_exam_bank_test -c "TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE"

# 4-2 從 MySQL 倒出（只讀 MySQL；輸出到 migrate/out/，已在 .gitignore，內含真題不得進版控）
npm run migrate:export

# 4-3 彩排匯入：打測試庫、真的 COMMIT（預設是 dry-run 會 ROLLBACK，這裡要 --apply 才能跑 verify）
node migrate/import_pg.js --test --apply

# 4-4 獨立校驗
node migrate/verify.js --test
```

看兩樣東西：
- `migrate/out/name_merge_report.md`：哪些姓名被正規化合併（`王"小明` → `王小明`）、有沒有**正規化後為空**的試卷。若有空姓名 → 裁決 15：回 MySQL 把那幾張試卷的 `student_name` 補好，再從 4-2 重跑。
- `verify.js` 若只因「姓名合併造成 attempts 少 K 筆」而紅，且報告裡每一筆你都認得 → `node migrate/verify.js --test --allow-merged`（裁決 14）。其他任何不等都不要放行。

彩排全過 = M1 的資料正確性條件成立。彩排完可再清一次測試庫（4-1），eval 下次跑也會自己清。

## 步驟 5：切換之夜（D-X1；照 `docs/cutover-runbook.md`）

只列骨架，細節與回滾界線以 runbook 為準：
1. 停止在 MySQL 上出卷（凍結寫入）；`npm run db:backup` 先備一份 PG。
2. `npm run migrate:export`（重倒一次最新的）→ `node migrate/import_pg.js --apply`（打 `DATABASE_URL` 開發庫）→ `node migrate/verify.js`（必要時 `--allow-merged`）。
3. 雙擊 `回填向量.bat`（或 `npm run embed:backfill`）：補 `embedding` 與 `search_tsv`，結尾 `embedding IS NULL` 必須為 0。
4. `.env` 的 `EMBED_MODE` 改 `live`（正式環境要真的算向量）、`FEATURE_SIMILAR=true`；`npm start`，用前端出一張卷、匯一次 Word、打一次 `/api/questions/:id/similar`。
5. `git tag v1-mysql`；MySQL 停而不刪、保留 14 天；14 天內若回滾用 `migrate/export_pg_delta.js`。
6. 驗收清單對照規劃 §1.4 的 M1：`verify` 0 差異、`npm test` 綠、integration 綠、組卷兩次不重疊、姓名合併報告已確認。

---

## 常見狀況

| 狀況 | 處理 |
|---|---|
| `eval:record` 說 `EMBED_MODE=fixture` 拒絕 | 步驟 2-1 沒改 `.env` |
| `eval:record` 429 | `.env` 的 `EMBED_RPM` 調低（預設 60），它會退避重試 |
| 錄完向量後 eval 說找不到某些 hash | 錄完又改過題目文字；重跑步驟 2 |
| `import_pg.js` 說目標表已有資料 | 4-1 沒清測試庫；或你打到的是開發庫（確認有 `--test`） |
| `verify.js` Word 產物逐位元比對不等 | 那是 `textFormatter` 輸出不一致，不是遷移問題；記下題號回報 |
