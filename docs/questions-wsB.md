# docs/questions-wsB.md — WS-B（遷移與維運）提出的問題與裁決結果

> **狀態：六條全部結案**（2026-08-21 第一輪裁決，`docs/interfaces.md` §1.6 裁決 13–16）。
> `docs/interfaces.md` 是凍結介面，WS-B 一個字都沒有改，也沒有動 `migrations/0001`／`0002`。
> 以下保留原本的問題陳述，並在每條末尾附上裁決與落地狀況，供之後回頭查「當初為什麼這樣決定」。

---

## Q1（已結案）`origin` 的 CHECK 沒有留給「舊資料」的值

**問題**：`interfaces.md` §1.2 的 `origin` 是 `NOT NULL DEFAULT 'pdf' CHECK (origin IN ('pdf','manual','seed','variant'))`。
從 MySQL 搬過來的舊題目在來源上其實是混的——有些是 AI 拆 PDF 進來的、有些是老師在網頁上手動新增的，
舊 schema 沒有任何欄位分得出來。四個值裡沒有一個誠實的選擇。

**當時的暫行做法**：一律寫 `origin='pdf'`（DDL 預設值），只有種子題寫 `'seed'`。

> **裁決（interfaces.md 裁決 13）**：採 (b)。新開 `migrations/0004_origin_legacy.sql`
> 把 CHECK 改為 `('pdf','manual','seed','variant','legacy')`；從 MySQL 遷移的舊題一律
> `origin='legacy'`（＝來源未知），只有題幹與 `seed_questions.js` 完全相同的 30 題寫
> `'seed'` + `chapter_src='human'`。階段 3 讀 `origin` 時必須認得 `'legacy'`。
>
> **落地**：`import_pg.js` 的 questions INSERT 改寫 `'legacy'`；`assertMigrated()` 把
> `0004_origin_legacy.sql` 列為必要前提（沒套用會撞 `questions_origin_check`，開場就擋下來）；
> 匯入報告的「來源標記」一列與 runbook 2-6 同步更新。

---

## Q2（已結案）`COUNT(attempts) = Σ history_json 鍵數` 有時**不可能**成立

**問題**：規劃 §1.4 的 M1 與 §5.3.6 步驟 4 都把這個等式列為硬性驗收條件，但只要下面任一情況存在，
它在數學上就不成立：

1. 同一題的 `history_json` 有兩個鍵在正規化後變成同一個人（例如 `王小明` 與 `王"小明`）
   → `UNIQUE (student_id, question_id)` 只容得下一列。
2. 某個鍵正規化後是空字串（只有空白／`"`／`\`）→ 建不出 `students` 的列，不會產生 `attempts`。

> **裁決（interfaces.md 裁決 14）**：M1 條文改寫為
> 「`COUNT(attempts)` = Σ `history_json` 鍵數 − 姓名合併與空姓名造成的差額；
> 差額逐筆列在 `name_merge_report.md`，經人工確認後以 `--allow-merged` 放行」。
> `verify.js` 預設仍把差額當失敗。
>
> **落地**：實作本來就符合，這一輪只改措辭。`verify.js` 第 4 項標題改為「attempts 守恆」，
> 訊息改成 `attempts N = history_json 鍵總數 M − 差額 K（姓名正規化後為空 x 筆、同題撞鍵 y 組）`，
> 並在紅字裡明指要去看 `name_merge_report.md` 的哪兩節。
> 「實際筆數連差額推得的期望值都對不上」是另一條訊息——那個才是真的有問題。
> runbook 2-4 的表格加上「同一題出現多個鍵指向同一位學生」那一節，2-7 直接引用裁決條文。

---

## Q3（已結案）姓名正規化後為空的 `exam_papers` 要怎麼辦

**問題**：`exam_papers.student_id` 是 `NOT NULL`（`interfaces.md` §1.5 第 2 條）。
若某張舊試卷的 `student_name` 正規化後是空字串，就沒有任何合法的 `student_id` 可以給它，
硬要匯入只有兩條路：憑空造一個學生，或丟掉那張試卷——兩件事腳本都不該自己決定。

> **裁決（interfaces.md 裁決 15）**：走 (a)——回舊 MySQL 補姓名再重跑 export。
> `import_pg.js` 預設中止，不得靜默丟資料。
>
> **落地**：錯誤訊息改成單一建議路徑（回 MySQL 補姓名 → 重跑 `export_mysql.js`）。
> `--unknown-student` 旗標**保留但標為不建議**，只留給「真的查不出是誰」的例外，
> 訊息與 runbook 都要求用了要在 `import_report.md` 註明是誰決定的。
> runbook 第 5 節「常見狀況」那一列與 2-4 的表格同步改寫。

---

## Q4（已結案）`search_tsv` 由誰在遷移後補

**問題**：規劃 §2.3.6 的「寫入路徑清單」把遷移腳本列為 `search_tsv` 的寫入路徑之一，
但 `interfaces.md` 第 2 條把分詞與 tsvector 的組裝（含 setweight 權重）整段劃給 WS-C。
若 WS-B 自己實作一套權重規則，就會出現兩套 tsvector，hybrid 查詢會靜默地少召回一批題。

> **裁決（interfaces.md 裁決 16）**：遷移後的 `search_tsv`／`embedding` 由
> `services/embedService.js` 統一回填；`import_pg.js` 不寫這兩欄，runbook 在
> import → verify 之後接「回填向量.bat」。
>
> **落地**：`import_pg.js` 維持不寫（檔頭已註明理由），結尾與 `verify.js` 第 7 項會印出
> 還有幾筆是 NULL。runbook 2-8 升級為「**這一步不能省**」，寫明回填沒跑完之前
> `/similar` 會回 409、hybrid 找不到遷移進來的題，因此 `FEATURE_SIMILAR` 與
> `FEATURE_HYBRID_SEARCH` 不要提早打開；一頁速查的過關條件改成「再跑一次 verify，
> `embedding IS NULL` 與 `search_tsv IS NULL` 都是 0」。

---

## Q5（已結案）`package.json` 的 `scripts`

依 `interfaces.md` §10.1，`package.json` 的 `scripts` 由 WS-D 擁有。WS-B **沒有新增任何 script**，
也**沒有新增任何相依套件**（`mysql2` 與 `pg` 本來就在 `dependencies` 裡）。

> **裁決（interfaces.md §12.5 的 WS-D 必修清單）**：由 WS-D 加下面四行。
>
> ```json
> "migrate:export": "node migrate/export_mysql.js",
> "migrate:import": "node migrate/import_pg.js",
> "migrate:verify": "node migrate/verify.js",
> "db:backup": "node scripts/backup.js"
> ```
>
> **落地**：等 WS-D 加入前，runbook 一律寫完整的 `node migrate/…` 指令，兩種寫法都會通。
> 另外因為裁決 24 把 `npm test` 改成 `node --test "test/unit/**/*.test.js"`，
> 原本放在 `migrate/lib/normalize.test.js` 的 22 項測試已搬到 `test/unit/normalize.test.js`
> （留在 `migrate/lib/` 的話不會被收進去）。

---

## Q6（已結案）`.env.example` 需要新增的四個備份變數

| 變數 | 預設 | 用途 |
|---|---|---|
| `BACKUP_DIR` | `exam_pro/backups` | `scripts/backup.js` 的輸出資料夾 |
| `BACKUP_KEEP` | `14` | 保留份數（對應 MySQL 保留 14 天的窗口） |
| `BACKUP_COPY_DIR` | （空） | 額外複製一份到這裡，例如雲端硬碟同步資料夾；留空不複製 |
| `BACKUP_PG_SERVICE` | `postgres` | `docker compose exec` 的服務名稱 |

> **裁決**：四個都已由開發者本人加進 `.env.example`（第 42–45 行，以註解形式列出預設值）。
> 四個都有程式內建預設值，不設也能跑。**結案**。
