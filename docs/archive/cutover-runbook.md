# docs/archive/cutover-runbook.md — MySQL → PostgreSQL 切換手冊

> **📦 歷史紀錄（2026-08-25 歸檔）**：切換已於 **2026-08-21** 依本手冊執行完畢並上線（PG 開發庫埠 5442）；回滾窗口至 **2026-09-04**（MySQL 停而不刪，見 §「回滾界線」；窗口過後才可解除安裝 MySQL80 與刪資料目錄）。本檔保留作為切換之夜的完整紀錄，日常維運改看 `engineering_docs/06_ops/runbook-pg-down.md` 與 `deployment_and_operations.md`。

> 擁有者：WS-B（遷移與維運）。對應規劃 `docs/roadmap-plan.md` §2.3.5、§5.3.6；介面以 `docs/interfaces.md` 為準。
> 這份是**切換之夜照著念的稿子**：每一步都有可以複製貼上的指令、預期看到什麼、不對的話怎麼辦。

**核心決策（規劃 §5.3.6、§6.5）**：一次切換，不雙寫。凍結一晚 → `export` → `import` → `verify` → 切 `.env` → MySQL 停而不刪保留 14 天。
一人維運，雙寫的同步程式碼會比業務還多，而且沒人盯著的不一致比停機更危險。

---

## 0. 前置條件（切換之夜開始前必須全部成立）

| 條件 | 怎麼確認 |
|---|---|
| Docker Desktop 已啟動、兩個容器健康 | 雙擊 `啟動資料庫.bat`，最後印出「[OK] 資料庫已就緒」 |
| migrations 已套用 | `node migrate.js status` → `0001_init.sql`、`0002_vector.sql`、`0004_origin_legacy.sql` 都是「✅ 已套用」。**`0004` 是必要的**：`import_pg.js` 對舊題寫 `origin='legacy'`（裁決 13），沒套用會撞 `questions_origin_check`；`import_pg.js` 開場就會擋下來 |
| PG 是**空的** | `docker compose exec -T postgres psql -U exam -d tutor_exam_bank -c "SELECT count(*) FROM questions"` → `0` |
| `npm test` 全綠 | `npm test`（不連 DB、不呼叫 Gemini） |
| WS-A 的 controller 已改 `pg` 並合入 | `git log --oneline` 看得到 D-D3／D-D4 |
| 至少做過一次真資料 dry-run | 見下面第 1 節；`name_merge_report.md` 已人工看過 |
| 沒有其他人正在用系統 | 家教自用，確認自己不會在切換途中開網頁組卷 |

> **真資料 dry-run 由開發者本人執行**：這支腳本會連上裝著真實題庫的 MySQL，
> 產出的 `migrate/out/` 內含真實題目，已在 `.gitignore`，**任何情況下都不要 commit**（見 `NOTICE`）。

---

## 1. T-7 天：演練（不影響正式資料）

演練跑的是**真資料**，但寫進去的是測試庫，而且只到 `--dry-run` 為止。

```bat
cd /d "C:\Users\Administrator\Desktop\期中專案\exam_pro"

REM 1-1 倒出真 MySQL（唯讀，不動 MySQL 一個位元組）
node migrate/export_mysql.js

REM 1-2 打開報告，一列一列看過姓名合併有沒有誤判
notepad migrate\out\name_merge_report.md

REM 1-3 對測試庫（5433，tmpfs，容器停掉就沒了）做完整匯入演練
npm run migrate:test
node migrate/import_pg.js --test --apply
node migrate/verify.js --test
```

`verify.js` 全綠才算演練成功。有紅字就照第 5 節「常見狀況」處理，處理完重跑演練，**不要帶著紅字進切換之夜**。

演練完把測試庫清掉（下次演練才是乾淨的起點）：

```bat
docker compose exec -T postgres_test psql -U exam -d tutor_exam_bank_test -c "TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE"
```

### 1-b 不想動真資料時的離線演練

`migrate/fixtures/make_sample_export.js` 會造一份自製的小樣本（6 題、含「同一人兩種寫法」「全形空白」「空姓名」等髒資料），
格式與 `export_mysql.js` 的輸出完全相同，可以在完全不碰 MySQL 的情況下把 import／verify 跑通：

```bat
node migrate/fixtures/make_sample_export.js --out migrate/out/sample
node migrate/import_pg.js --test --in migrate/out/sample --apply
node migrate/verify.js --test --in migrate/out/sample --allow-merged
```

---

## 2. 切換之夜：逐條指令

> 全程在 `exam_pro` 資料夾內，用 cmd（每支 `.bat` 都會先 `chcp 65001`）。
> 建議把整個視窗的輸出留著，事後貼進 `migrate/out/import_report.md` 旁邊。

### 2-1 凍結寫入

```bat
REM 關掉正在跑的服務，這段時間不新增題目、不組卷
REM （用 Ctrl+C 停掉 npm start 的視窗；確認 http://localhost:3000 打不開）
```

**凍結是回滾成本為零的前提**：只要這段時間沒有人寫入，當晚回滾就是「零遺失」。

### 2-2 備份兩邊

```bat
REM 舊 MySQL：整庫備份（這是最後的保命符，先做）
mysqldump -u root -p --default-character-set=utf8mb4 --single-transaction tutor_exam_bank > D:\備份\tutor_exam_bank_cutover.sql

REM 新 PG：切換前的空庫快照（回滾時可以直接還原成乾淨狀態）
備份資料庫.bat
```

`備份資料庫.bat` 失敗時會寫 `backups\LAST_FAILED.txt` 並停在畫面上不關視窗——**看到紅字就停在這裡，不要往下走**。

### 2-3 匯出 MySQL

```bat
node migrate/export_mysql.js
```

預期輸出：`questions`／`exam_papers` 筆數、章節數、`history_json` 鍵數、`→ attempts 應有`、`→ students 應有`。
產出在 `migrate\out\`：`questions.jsonl`、`exam_papers.jsonl`、`checksums.json`、`name_merge_report.md`。

### 2-4 人工確認姓名合併

```bat
notepad migrate\out\name_merge_report.md
```

四個段落一定要看。前兩節同時也是 2-7 那個 attempts 差額的來源，逐條看過才有資格加 `--allow-merged`：

| 段落 | 意思 | 要做的判斷 |
|---|---|---|
| 正規化後合併的姓名 | `王"小明`（試卷）與 `王小明`（history 鍵）會併成同一位學生 | 這確實是同一個人嗎？ |
| 同一題出現多個鍵指向同一位學生 | `UNIQUE (student_id, question_id)` 只容得下一列，取最早的日期 | 少掉的那幾列就是 attempts 差額的一部分 |
| 疑似同一人（**不會**自動合併） | 只差全形／半形空白，程式**不敢**替你決定 | 若是同一人，**回舊 MySQL 把姓名改一致，重跑 2-3** |
| 正規化後為空的姓名 | 姓名只有空白或只有 `"` `\` | history 的鍵會被丟掉（也算進差額）；**試卷則會擋下整支匯入**，依裁決 15 回 MySQL 補姓名後重跑 2-3 |

### 2-5 匯入 PG（先 dry-run）

```bat
node migrate/import_pg.js
```

`--dry-run` 是預設：整套流程跑完（含交易內的筆數、各章筆數、逐列雜湊校驗），然後 `ROLLBACK`。
看到「✅ dry-run 全部通過」才往下走；報告在 `migrate\out\import_report.md`。

### 2-6 匯入 PG（真的寫入）

```bat
node migrate/import_pg.js --apply
```

這一步做完的事（規劃 §2.3.5、§5.3.6 步驟 3）：

- `questions`／`exam_papers` **保留原 id**（`OVERRIDING SYSTEM VALUE`）
- `history_json` 在 **PG 端**以 `jsonb_each_text` 展開成 `students` + `attempts(assigned_at)`
- `question_ids` 由 JSON 陣列轉成 `INT[]`
- 舊題一律 `origin='legacy'`（裁決 13 = 來源未知；舊 schema 分不出是 AI 拆 PDF 還是手動新增，
  不拿 `'pdf'` 假裝知道）。唯一的例外是題幹與 `seed_questions.js` 完全相同的那 30 題，
  改標 `origin='seed'`、`chapter_src='human'`
- `attempts.paper_id` 以「同學生 + 同一天 + 該卷含這題」回填，對不上留 `NULL`
- 對 `questions`／`exam_papers`／`students` 各跑一次 `setval`
- 寫出 `migrate\out\cutover.json`（**14 天內回滾要用，不要刪**）
- **不寫** `search_tsv` 與 `embedding` —— 裁決 16 把這兩欄統一交給 `services/embedService.js`，
  在 2-8 由「回填向量.bat」補

### 2-7 校驗

```bat
node migrate/verify.js
```

六項檢查任一不等就以非零碼退出：筆數、各章筆數、逐列 `sha256(question_text+answer_text)`、
**attempts 守恆**、隨機 20 題 `buildParagraphComponents` 產物逐位元比對、參照完整性與序列。

> **第 4 項 attempts 守恆的條文**（`docs/interfaces.md` 裁決 14）：
>
> > `COUNT(attempts)` = Σ `history_json` 鍵數 − 姓名合併與空姓名造成的差額；
> > 差額**逐筆列在 `name_merge_report.md`**，經人工確認後以 `--allow-merged` 放行。
>
> 差額不是 bug：`UNIQUE (student_id, question_id)` 只容得下一列，同一題有兩個鍵指向同一人時
> 必然少一列；正規化後為空的鍵則建不出 `students`。verify 會印成
> 「attempts N = 鍵總數 M − 差額 K（正規化後為空 x 筆、同題撞鍵 y 組）」。
>
> 做法：回頭把 `name_merge_report.md` 的「正規化後合併的姓名」與「同一題出現多個鍵指向同一位學生」
> 兩節逐條看過，數字對得起來、也確定不是誤判，才執行
> `node migrate/verify.js --allow-merged`，並把那行差額說明抄進 `import_report.md`。
> **verify 預設仍然把差額當失敗**，不要因為看到紅字就直接加旗標。

### 2-8 回填向量與全文檢索欄位（**這一步不能省**）

```bat
回填向量.bat
```

**裁決 16**：遷移後的 `search_tsv` 與 `embedding` 由 `services/embedService.js` 統一回填。
`import_pg.js` 刻意不碰這兩欄——若遷移腳本自己實作一套 tsvector 權重，就會與寫入路徑
（`createQuestion`／`batchSaveQuestions`／`backfill_embeddings.js`）產生兩套規則，
hybrid 查詢會**靜默地**少召回一批題，比「暫時是 NULL」危險得多。

`回填向量.bat` 是 `scripts/backfill_embeddings.js` 的殼，可以中斷再重跑（每批一個交易，天然斷點續跑）。
跑完再執行一次 `node migrate/verify.js`，第 7 項應該顯示 `embedding IS NULL：0 筆、search_tsv IS NULL：0 筆`。

> **時間安排**：這一步要呼叫 Gemini，題數多時可能要跑很久，可以隔天再跑完——但**別忘了跑**。
> 在它跑完之前：組卷、題庫瀏覽、Word 下載都正常（那些不需要向量），
> 但 `GET /api/questions/:id/similar` 會回 409、hybrid 檢索找不到遷移進來的題。
> 那兩個功能的旗標（`FEATURE_SIMILAR`／`FEATURE_HYBRID_SEARCH`）預設是關的，
> **回填沒跑完就不要開**。

### 2-9 切 `.env`

```ini
# exam_pro/.env
DATABASE_URL=postgres://exam:exam@localhost:5442/tutor_exam_bank
```

`config/db.js` 以 `DATABASE_URL` 優先（`docs/interfaces.md` 第 8 條）。
**舊的 `DB_HOST`／`DB_PORT`／`DB_USER`／`DB_PASSWORD`／`DB_NAME` 先留著不要刪**——
14 天內回滾、以及 `migrate/export_mysql.js` 都還要用（`docs/interfaces.md` 第 9 條）。

### 2-10 冒煙測試

```bat
npm start
```

在瀏覽器上依序做完這四件事，任一項不對就進第 3 節回滾：

1. 題庫列表載入得出來，右上角的總筆數是**數字**不是字串（`total` 的型別由 `setTypeParser(20)` 保證）
2. 智慧組卷：挑一位真的存在的學生，抽 5 題 → 200，回應含 `paper_id`
3. **同一位學生、同一章再組一次** → 抽到的題目與上一次**完全不重疊**（`attempts` 的 `NOT EXISTS` 生效）
4. 下載 Word → 打開來公式顯示正常（`<m:oMath>` 有渲染出來）

### 2-11 打 tag 並讓 MySQL 唯讀

```bat
git tag v1-mysql
git push origin v1-mysql
```

`v1-mysql` 指向**切換前最後一個能連 MySQL 跑起來的 commit**。回滾時 `git checkout v1-mysql` 就回到那個世界。

MySQL 停而不刪、保留 14 天。建議直接把服務停掉（最徹底的唯讀）：

```bat
REM 系統管理員身分執行
net stop MySQL80
```

若因為別的專案要留著 MySQL 服務，改成把帳號降成唯讀：

```sql
REVOKE INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON tutor_exam_bank.* FROM 'root'@'localhost';
FLUSH PRIVILEGES;
```

**14 天內不要 `DROP DATABASE`**，也不要把 `D:\備份\tutor_exam_bank_cutover.sql` 刪掉。

### 2-12 設定每日備份

Windows 工作排程器 → 建立基本工作：

| 欄位 | 值 |
|---|---|
| 名稱 | 題庫每日備份 |
| 觸發程序 | 每天 02:00 |
| 動作 | 啟動程式 |
| 程式或指令碼 | `C:\Windows\System32\cmd.exe` |
| 引數 | `/c "C:\Users\Administrator\Desktop\期中專案\exam_pro\備份資料庫.bat"` |
| 起始位置 | `C:\Users\Administrator\Desktop\期中專案\exam_pro` |

**勾「只有使用者登入時才執行」**：Docker Desktop 只有在登入後才會起來，
選「不論使用者登入與否」會每天靜默失敗。失敗時 `scripts/backup.js` 會寫 `backups\LAST_FAILED.txt`，
養成每週看一眼的習慣（或把 `BACKUP_COPY_DIR` 指到雲端硬碟同步資料夾，看檔案有沒有長出來）。

---

## 3. 回滾界線

**回滾的成本完全取決於「凍結之後有沒有人寫入 PG」，所以界線要先講清楚。**

### 3-A 當晚回滾（凍結還沒解除）＝ 零遺失

適用時機：2-7 的 `verify.js` 有紅字、或 2-10 的冒煙測試不過，而且**還沒有人用新系統寫進任何東西**。

```bat
REM A-1 停掉服務
REM （Ctrl+C 結束 npm start）

REM A-2 .env 切回 MySQL：把 DATABASE_URL 那行註解掉
REM     #DATABASE_URL=postgres://exam:exam@localhost:5442/tutor_exam_bank
REM     DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME 這幾行本來就沒刪

REM A-3 程式碼回到切換前
git checkout v1-mysql

REM A-4 MySQL 起回來、權限收回來
net start MySQL80
REM （若之前是用 REVOKE：GRANT ALL ON tutor_exam_bank.* TO 'root'@'localhost'; FLUSH PRIVILEGES;）

REM A-5 npm start，重跑 2-10 的四項冒煙測試
```

PG 那邊**不用清**（下次重來時 `import_pg.js` 會擋下非空的資料庫，屆時再 `TRUNCATE`）。
因為寫入是凍結的，MySQL 的內容與凌晨備份的時點完全一致，**沒有任何資料遺失**。

### 3-B 上線後 1～14 天內回滾 ＝ 需要反向匯出

適用時機：已經解除凍結、用新系統組過卷或新增過題，之後才決定退回 MySQL。

**這段期間在 PG 新增的題目／試卷／作答紀錄不會自己回到 MySQL**，必須先倒出來：

```bat
REM B-1 先停服務、再備份 PG（倒的東西等一下要對照）
備份資料庫.bat

REM B-2 反向匯出：只倒切換之後新增的列，attempts 摺回 history_json
node migrate/export_pg_delta.js
REM 產出在 migrate\out\：
REM   delta_questions.jsonl      新增的題目（history_json 已摺回）
REM   delta_papers.jsonl         新增的試卷（student_id 已還原成 student_name）
REM   delta_history_patch.jsonl  舊題目新增的作答紀錄
REM   rollback_mysql.sql         可直接餵給 MySQL 的還原語句

REM B-3 **先看過** rollback_mysql.sql 再執行，特別確認 id 不會撞到 MySQL 既有資料
notepad migrate\out\rollback_mysql.sql

REM B-4 MySQL 起回來、權限開回來，然後灌入
net start MySQL80
mysql -u root -p --default-character-set=utf8mb4 tutor_exam_bank < migrate\out\rollback_mysql.sql

REM B-5 接著照 3-A 的 A-2、A-3、A-5 做完
```

**界線的誠實說明**：`export_pg_delta.js` 靠 `migrate\out\cutover.json` 的 `max_ids` 判斷「哪些是切換後新增的」。
`cutover.json` 弄丟就沒有界線可用（只能人工用 `created_at` 推），所以那個檔要跟備份放在一起。
另外，**切換後在 PG 上「修改」既有題目的內容不會被倒回去**（delta 只看新增的 id）——
14 天窗口內如果大量編輯過舊題，退回 MySQL 就等於放棄那些編輯。這一點在決定要不要回滾時要先講明。

> **執行紀錄**：切換之夜於 2026-08-21 完成（70 題／126 卷／143 attempts／5 學生，verify 七項全過，冒煙全過，tag `v1-mysql`）。
> 開發者決定**跳過 14 天窗口**，同日執行 3-C 收尾（切換後無任何新寫入，零遺失）：`mysql2`／`DB_*`／`schema.sql`／`export_mysql.js` 已移除，`config/db.js` 只認 `DATABASE_URL`。
> 之後若仍要退回 MySQL：用 `Desktop\期中專案_資料庫備份\tutor_exam_bank_cutover_2026-08-21.sql` 還原 + `git checkout v1-mysql`。

### 3-C 第 15 天起 ＝ 不回滾

14 天窗口過了就不再保證能退回 MySQL。此時做 D-X1 收尾：

```bat
REM 確認 PG 一切正常、備份機制連跑兩週沒有 LAST_FAILED.txt 之後
REM 1. MySQL 整庫最後一次備份，收進長期保存的資料夾（不要放 repo）
REM 2. DROP DATABASE tutor_exam_bank;（或直接移除 MySQL）
REM 3. .env 與 .env.example 移除 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME 五行
REM 4. package.json 移除 mysql2 相依（migrate/export_mysql.js 一併退役）
REM 5. 刪除 exam_pro/schema.sql（MySQL 版）與 setup_index_views.js
REM    （建立索引與檢視表.bat 已於第一輪合併時隨 WS-A 一起退役）
REM 6. 更新 exam_pro/README.md 與根 README 的資料庫段落
```

---

## 4. 一頁速查

| 步驟 | 指令 | 過關條件 |
|---|---|---|
| 凍結 | 停掉 `npm start` | 網頁打不開 |
| 備份 | `mysqldump …` + `備份資料庫.bat` | 兩個檔案都長出來，沒有 `LAST_FAILED.txt` |
| 匯出 | `node migrate/export_mysql.js` | 印出筆數摘要 |
| 看報告 | `notepad migrate\out\name_merge_report.md` | 合併與疑似同一人都確認過 |
| 演練匯入 | `node migrate/import_pg.js` | 「✅ dry-run 全部通過」 |
| 正式匯入 | `node migrate/import_pg.js --apply` | 「✅ 已 COMMIT」＋ `cutover.json` 產生 |
| 校驗 | `node migrate/verify.js` | 「✅ 校驗全部通過」（attempts 差額逐條對過 `name_merge_report.md` 才加 `--allow-merged`） |
| 回填 | `回填向量.bat`（**不能省**） | 再跑一次 verify，`embedding IS NULL` 與 `search_tsv IS NULL` 都是 0 |
| 切換 | 改 `.env` 的 `DATABASE_URL` | `npm start` 起得來 |
| 冒煙 | 列表／組卷兩次／Word | 兩次組卷不重疊 |
| 收尾 | `git tag v1-mysql`、停 MySQL、設排程 | tag 推上去、排程建好 |

---

## 5. 常見狀況與處置

| 訊息／症狀 | 意思 | 怎麼辦 |
|---|---|---|
| `目標資料庫不是空的（questions=…）` | PG 已經有資料了 | 若是演練殘留就照訊息裡的 `TRUNCATE` 清掉；確定要疊加才用 `--force` |
| `有 N 張試卷的 student_name 正規化後是空字串` | 試卷姓名只有空白／`"`／`\` | **依裁決 15：回舊 MySQL 把那幾張卷的姓名補好，重跑 2-3**。`--unknown-student="未知學生"` **不建議使用**，只留給「真的查不出是誰」的例外；用了要在 `import_report.md` 註明是誰決定的 |
| `history_json 有 N 筆日期不是 YYYY-MM-DD` | 舊資料裡有髒日期 | 先修來源；確定要放棄那些紀錄才加 `--skip-bad-dates`（會列進報告） |
| `姓名正規化的 JS 與 SQL 兩份實作結果不一致` | `normalizeName` 與 `pgNormalizeSql` 走鐘了 | **不要繞過**。修 `migrate/lib/normalize.js`，跑 `npm test` 確認 22 項全綠再重來 |
| `questions.id=N 的逐列雜湊不符` | 匯出之後 MySQL 又被改過，或匯入途中資料被動到 | 確認凍結是否真的生效，`TRUNCATE` PG 後從 2-3 重跑 |
| `attempts N ≠ history_json 鍵總數 M` | 姓名合併／同題撞鍵的必然結果 | 看差額拆解是否與 `name_merge_report.md` 對得上，對得上才 `--allow-merged` |
| `<table> 的序列 last_value < max(id)` | 漏了 `setval` | 上線後第一筆新增就會主鍵衝突。重跑匯入，或手動 `SELECT setval(pg_get_serial_sequence('questions','id'), (SELECT max(id) FROM questions))` |
| `偵測不到 Docker 引擎` | Docker Desktop 沒起來，或排程器在鎖定畫面下跑 | 啟動 Docker Desktop；排程器要勾「只有使用者登入時才執行」 |
| cmd 視窗中文變亂碼 | 沒有 `chcp 65001` | 所有 `.bat` 都已經先 `chcp 65001`；手打指令時自己先下一次 |
| `密碼驗證失敗` 但密碼是對的 | 5432 被本機原生的 PostgreSQL 17 服務接走 | 開發庫的埠是 **5442**（`docs/interfaces.md` 第 9 條），確認 `DATABASE_URL` 沒被改回 5432 |

---

## 6. 這份手冊涵蓋範圍以外的事

- **`search_tsv`／`embedding` 的來源文字與權重規則**屬 `services/embedService.js`（裁決 16、21），`import_pg.js` 刻意不碰，避免兩套寫法；本手冊只負責在 2-8 提醒你去跑回填。
- **`deleteQuestion` 改成軟刪除**（有 `attempts` 就回 `{archived:true}`）見 `docs/interfaces.md` §12.1；`attempts.question_id` 是 `ON DELETE RESTRICT`，硬刪一定失敗，這是刻意的。
- **`audit_formulas.js` / `fix_formulas.js` 連的是哪個資料庫**：切換之後由 WS-A 改走 `config/db.js`；在那之前三支公式 `.bat`（已改包 `node scripts/formulas.js`）讀到的是舊題庫。改完之後 `scripts/formulas.js` 的內容要換掉，但入口與 `.bat` 不必再動。
- **`origin='legacy'` 對階段 3 的意義**：它代表「來源未知」，不是「AI 拆出來的」。任何按 `origin` 做統計或分流的地方都要認得這個值（裁決 13）。
