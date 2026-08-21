# docs/questions-wsB.md — WS-B（遷移與維運）實作時發現、需要開發者本人裁決的問題

> `docs/interfaces.md` 是凍結介面，WS-B 一個字都沒有改。以下是實作 `migrate/*` 時撞到的介面／DDL 問題，
> 全部依規則停在這裡，**沒有自行改介面繞過**，也沒有動 `migrations/*.sql`。
> 每一條都寫了「現在暫時怎麼做」，所以在裁決之前遷移腳本仍然可以跑。

---

## Q1（需要新 migration）`origin` 的 CHECK 沒有留給「舊資料」的值

**問題**：`interfaces.md` §1.2 的 `origin` 是 `NOT NULL DEFAULT 'pdf' CHECK (origin IN ('pdf','manual','seed','variant'))`。
從 MySQL 搬過來的舊題目在來源上其實是混的——有些是 AI 拆 PDF 進來的、有些是老師在網頁上手動新增的，
舊 schema 沒有任何欄位分得出來。四個值裡沒有一個誠實的選擇。

**現在暫時怎麼做**：`import_pg.js` 一律寫 `origin='pdf'`（＝DDL 的預設值），
只有題幹與 `seed_questions.js` 完全相同的那 30 題改成 `origin='seed'`、`chapter_src='human'`。
也就是說**遷移進來的 `origin='pdf'` 有一部分是不準的**，不能拿來當「這題是 AI 拆出來的」的依據。

**要裁決的**：
- (a) 接受現況（`origin='pdf'` 對舊資料只是「未知」的同義詞），並在 README 寫明；或
- (b) 新開一支 `migrations/0004_origin_legacy.sql` 把 CHECK 加上 `'legacy'`，遷移的列一律寫 `'legacy'`。

(b) 比較誠實，代價是階段 3 所有讀 `origin` 的地方要多認一個值。我傾向 (b)，但這是新欄位值，依規則不自己動。

---

## Q2（需要確認驗收條件的措辭）`COUNT(attempts) = Σ history_json 鍵數` 有時**不可能**成立

**問題**：規劃 §1.4 的 M1 與 §5.3.6 步驟 4 都把「`COUNT(attempts)` = Σ `history_json` 鍵數」列為硬性驗收條件。
但只要下面任一情況存在，這個等式在數學上就不成立：

1. 同一題的 `history_json` 有兩個鍵在正規化後變成同一個人（例如 `王小明` 與 `王"小明`）
   → `UNIQUE (student_id, question_id)` 只容得下一列。
2. 某個鍵正規化後是空字串（只有空白／`"`／`\`）→ 建不出 `students` 的列，不會產生 `attempts`。

**現在暫時怎麼做**：`verify.js` **預設仍然把它當失敗**（非零退出），但會把差額拆開來印：
「正規化後為空 N 筆、同題撞鍵 M 組、合計少 K 筆 → 去重後應為 X」。
確認 `name_merge_report.md` 沒有誤判之後，用 `--allow-merged` 放行，且那行差額說明會被寫進備註。
`import_pg.js` 交易內的校驗用的是**去重後的期望值**（不然沒有任何一次匯入能 COMMIT）。

**要裁決的**：M1 的條文是否改成
「`COUNT(attempts)` = Σ `history_json` 鍵數 − 姓名合併與空姓名造成的差額，且差額逐筆列在合併報告裡並經人工確認」。

---

## Q3（流程決策）姓名正規化後為空的 `exam_papers` 要怎麼辦

**問題**：`exam_papers.student_id` 是 `NOT NULL`（`interfaces.md` §1.5 第 2 條）。
若某張舊試卷的 `student_name` 正規化後是空字串，就**沒有任何合法的 `student_id` 可以給它**，
硬要匯入只有兩條路：憑空造一個學生，或丟掉那張試卷——兩件事腳本都不該自己決定。

**現在暫時怎麼做**：`import_pg.js` 直接中止，並印出那幾張試卷的 id，提供兩個明確選項：
(a) 回舊 MySQL 把姓名補好再重跑 export；(b) `--unknown-student="未知學生"` 明確指定歸屬。
預設是中止，不會靜默丟資料。

**要裁決的**：真的遇到時走 (a) 還是 (b)。真資料 dry-run 跑完就知道有沒有這種列。

---

## Q4（協調，不是介面問題）`search_tsv` 由誰在遷移後補

**問題**：規劃 §2.3.6 的「寫入路徑清單」把 `migrate_mysql_to_pg.js` 列為 `search_tsv` 的寫入路徑之一
（「搬完後一條 `UPDATE … SET search_tsv = …`」），但 `interfaces.md` 第 2 條把分詞與 tsvector 的組裝
（含 setweight 的權重規則）整段劃給 WS-C，而 `utils/tokenize.js` 在 WS-B 寫這段時還不存在。

**現在暫時怎麼做**：`import_pg.js` **不寫** `search_tsv`（也不寫 `embedding`），留 NULL，
並在結尾與 `verify.js` 第 7 項印出「還有幾筆是 NULL、請執行『回填向量.bat』」。
理由：若 WS-B 自己實作一套權重規則，就會和 WS-C 的寫入路徑產生兩套 tsvector，
那比「暫時是 NULL」危險得多（hybrid 查詢會靜默地少召回一批題）。

**給 WS-C 的請求**：`scripts/backfill_embeddings.js` 請確認**同批也覆寫 `search_tsv`**
（規劃 §2.3.6 的寫入路徑表本來就是這樣寫的），否則遷移後的題永遠不會進全文索引。

---

## Q5（工具鏈）`package.json` 的 `scripts` 由 WS-D 統一，WS-B 沒有自己加

依 `interfaces.md` §10.1，`package.json` 的 `scripts` 由 WS-D 擁有。WS-B **沒有新增任何 script**，
也**沒有新增任何相依套件**（`mysql2` 與 `pg` 都已經在 `dependencies` 裡）。
建議 WS-D 加下面四行（前綴已避開既有名稱）：

```json
"migrate:export": "node migrate/export_mysql.js",
"migrate:import": "node migrate/import_pg.js",
"migrate:verify": "node migrate/verify.js",
"db:backup": "node scripts/backup.js"
```

---

## Q6（環境變數）`.env.example` 需要新增的四個備份變數

依規則 `.env.example` 不直接改，列在這裡與 PR 描述：

| 變數 | 預設 | 用途 |
|---|---|---|
| `BACKUP_DIR` | `exam_pro/backups` | `scripts/backup.js` 的輸出資料夾 |
| `BACKUP_KEEP` | `14` | 保留份數（對應 MySQL 保留 14 天的窗口） |
| `BACKUP_COPY_DIR` | （空） | 額外複製一份到這裡，例如雲端硬碟同步資料夾；留空不複製 |
| `BACKUP_PG_SERVICE` | `postgres` | `docker compose exec` 的服務名稱 |

四個都有預設值，不設也能跑。
