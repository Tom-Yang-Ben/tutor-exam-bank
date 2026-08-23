# docs/questions3-wsA.md — WS-A（學生／試卷／批改／弱點面板）對階段 3 介面的疑問

> 分支 `ws3-a/students`，對應 `docs/interfaces-stage3.md` 第 1、2、7.3 條。
> 規則：介面不得自行修改。以下每一條都**照現行介面的字面實作了**，並在此列出所採用的解讀，
> 請開發者本人裁決；若裁決與我的解讀不同，改動只會落在我擁有的檔案裡。
> 沒有任何一條讓我卡住，全部任務已完成。
>
> **本檔已結案（2026-08-24）。** 第 1～7 條全部由第一輪裁決 **S3-R1～S3-R7** 回覆
> （`docs/interfaces-stage3.md` §15），第 1～6 條**全部接受本檔採用的解讀，程式不需修改**；
> 第 7 條由 WS-D 在 README 標註。第 8 條是公告，不需裁決。
> 另有裁決 **S3-R25** 給 WS-A 一項新工作（`app.js` 第四個 `replaceAll`），已落地，見文末。

---

## 1. `PATCH /api/papers/:id/results` 的 400 檢查**優先序**未定義（第 1.4 條）

> **裁決：S3-R1（接受，程式不動）** — 400 檢查優先序＝第 1.4 條表格的列順序：重複檢查在型別檢查之前、body 驗證在試卷存在性之前。已實作，整合測試「六個 400 訊息逐字凍結」照此釘住。

第 1.4 條的表格列了七個訊息，但沒說「同一份 body 同時違反兩條時該回哪一個」。
表格的列順序是唯一的訊號，我就照它實作：

```
results 必須是非空陣列。
→ results 最多 100 筆。
→ results 內有重複的 question_id。
→ question_id 必須是正整數。
→ result 只接受 0、1 或 null。
→ 404 找不到該試卷
→ 題目 ${question_id} 不在這張試卷內。
```

具體的取捨有兩處：

- **重複檢查排在型別檢查之前。** 送 `[{question_id:'x'},{question_id:'x'}]` 會得到
  「重複」而不是「必須是正整數」。理由是重複檢查比對的是使用者送來的**原始值**，
  不需要先確定那些值合法。若裁決認為型別優先，我把兩個迴圈對調即可。
- **body 驗證排在「試卷存不存在」之前。** 對一張不存在的卷送壞 body 會拿到 400 而不是 404。

**影響：** 只影響「一次違反多條」的邊界請求；前端正常操作不會踩到。
`test/integration/students.pg.test.js` 的「六個 400 訊息逐字凍結」是照上面的順序釘的。

---

## 2. `PATCH /api/papers/:id/results` 的 `:id` 不是整數時回什麼（第 1.4 條）

> **裁決：S3-R2（接受，程式不動）** — `/api/papers/:id`、`PATCH …/results`、`/api/students/:id/*` 的 `:id` 非整數一律 404（與第 1.2 條同）。已實作。

第 1.2 條明說「`:id` 不是整數也回 404，不回 400」，但第 1.3、1.4 條沒有重述。
我把同一條規則套到 `GET /api/papers/:id` 與 `PATCH /api/papers/:id/results`：
`/api/papers/abc` 一律回 `404 { message: '找不到該試卷' }`。

**理由：** 三支的 `:id` 語意相同，兩種行為並存只會讓前端要為不同端點寫不同的錯誤處理。

---

## 3. `GET /api/students` 的 `graded_ratio` 分母（第 1.1 條）

> **裁決：S3-R3（接受，程式不動）** — `graded_ratio` 分母＝該生**全部** `attempts`。已實作。

條文寫「該生 `attempts` 中 `result IS NOT NULL` 的比例」。我照字面用**該生全部 `attempts`**
當分母，**不**限縮成「有 `paper_id` 的 attempts」。

**為什麼要問：** 階段 1 的 `generatePaper` 一定會寫 `paper_id`，所以目前兩種算法結果相同；
但若之後有「不經試卷直接指派題目」的路徑，兩者就會分岔。若那時要改成後者，
改的是 `controllers/studentController.js` 的一個子查詢。

---

## 4. `GET /api/papers/:id` 遇到 `question_ids` 裡的題目在 `questions` 中不存在（第 1.3 條）

> **裁決：S3-R4（接受，程式不動）** — `GET /api/papers/:id` 用 INNER JOIN；`question_ids` 裡不存在的題直接不出現（現行 DDL 下不可能發生）。已實作。

我用 `unnest(...) WITH ORDINALITY JOIN questions`（INNER JOIN），
所以真的發生時那一題會**從清單消失**，而不是回一列 `question_text: null`。

**理由：** `attempts.question_id` 是 `ON DELETE RESTRICT`（`0001_init.sql`），
而這張卷上的每一題都有 `attempts` 列，所以題目刪不掉——這個情境在現行 DDL 下不可能發生。
若要對「資料已經壞掉」也保持可讀，應改成 `LEFT JOIN` 並允許欄位為 null；
那會讓回應形狀多出一種可能，所以我沒有自作主張。

---

## 5. `GET /api/students/:id/weakness` 的 404 與 400 誰先（第 1.5 條）

> **裁決：S3-R5（接受，程式不動）** — 錯誤順序＝路徑參數 → 查詢參數 → 資料存在性。已實作。

我的順序是：`:id` 不是整數 → **404** ／ `subject`、`days` 不合法 → **400** ／ 學生不存在 → **404**。
也就是「路徑參數 → 查詢參數 → 資料存在性」。
對一位不存在的學生送 `?days=999` 會拿到 400 而不是 404。

---

## 6. EXPLAIN 斷言在 1,000 列的小表上需要 `SET LOCAL enable_seqscan = off`（第 1.6 條）

> **裁決：S3-R6（接受，程式不動）** — `EXPLAIN` 斷言在交易內 `SET LOCAL enable_seqscan = off` 後做；驗的是「謂詞走得到索引」，不是「小表會不會用索引」。已實作於 `test/integration/students.pg.test.js` 的「查詢計畫」那一組。

第 1.6 條要求整合測試斷言「`EXPLAIN (FORMAT JSON)` 的計畫含 `idx_attempts_student_date`」。
實作時的事實是：**1,000 列的 `attempts` 只有幾頁，`ANALYZE` 之後 planner 幾乎一定選 Seq Scan**——
而那是**正確**的選擇，不是缺陷。直接斷言會得到一個「只有在資料剛好夠大時才會綠」的測試。

我的做法（`test/integration/students.pg.test.js` 的「查詢計畫」那一組）：
在交易內 `SET LOCAL enable_seqscan = off` 再 `EXPLAIN`，斷言計畫走的是 `idx_attempts_student_date`。

**這樣驗到的是什麼：** 不是「小表上會不會用索引」，而是「**這組謂詞走得到那支索引**」。
有人把 `WHERE` 改成 `date(a.assigned_at) >= …`、或改用別的欄位篩學生時，索引就再也搭不上，
正式庫（十萬列以上）會從索引掃退化成全表掃，而所有功能測試依然全綠。這正是要擋的回歸。

**裁決結果：** 接受，維持現行做法；沒有改成「把 fixture 灌到十萬列讓 planner 自然選索引」——
那會讓整合測試慢很多，換到的也只是「這台機器上剛好夠大」而已。

---

## 7. 給 WS-D 的一則事實：`npm run test:integration` 目前不會真的連上測試庫

> **裁決：S3-R7（結案，WS-A 不動）** — `npm run test:integration` 維持 CI 語意（由 workflow 提供 `TEST_DATABASE_URL`）；本機用 README 那行 `--env-file=.env`。README 由 **WS-D** 再標一次，`package.json` 的 `scripts` 不改。

`package.json` 的 `test:integration` 是
`node --env-file=eval/.env.replay --test --test-concurrency=1 "test/integration/**/*.test.js"`，
而 `eval/.env.replay` 只有 `LLM_MODE=replay` 與 `EMBED_MODE=fixture`，**沒有 `TEST_DATABASE_URL`**。
所以除非 shell 環境裡已經有那個變數，這道指令會讓所有 `*.pg.test.js` 整批 skip（而且是綠的）。

我本地是用既有 README／測試檔註解裡的那道指令跑的：

```
node -r dotenv/config --test --test-concurrency=1 "test/integration/**/*.test.js"
```

`scripts` 歸 WS-D 統一，所以我沒有改 `package.json`。列在這裡是因為
「skip 也是綠的」是最容易讓人以為整合測試有跑到的失效模式。

---

## 8. 一則語意變更的公告（不是疑問，但要讓其他 WS 知道）

P-06 之後，`POST /api/generate-paper` 的抽題從「**每題**等機率」變成「**每家族**等機率」
（一個有 5 題變式的家族，與一個孤題被抽中的機率相同）。
回應形狀完全不變，既有整合測試全綠。WS-B 大量產出變式之後，
這一點會直接影響「同章節的題目多久會被抽到一次」的觀感——是刻意的設計（規劃 §4.1）。

---

## 9. 裁決 S3-R25 交辦的新工作（已完成）

第一輪裁決另外給了 WS-A 一項不在原本八條裡的工作：

> **S3-R25**：加第四個注入點 `<meta name="feature-similar">`（`app.js` 多一個 `replaceAll`，WS-A；`index.html` 加 meta，WS-D）；「找相似」由 `feature-similar` 控制、「出變式」由 `feature-variants` 控制。

已落地：`app.js` 的 `serveIndex` 與另外三個同一串處理，
`.replaceAll('__FEATURE_SIMILAR__', process.env.FEATURE_SIMILAR || 'false')`。

注入的是**階段 1 就有**的 `FEATURE_SIMILAR`，不是新造的旗標——
「找相似」打的是 `GET /api/questions/:id/similar`，那條路由由 `routes/index.js`
`[WS-C: retrieval]` 區塊的 `isSimilarEnabled()` 決定掛不掛載。兩邊必須是同一個變數，
否則會出現「按鈕在、路由不在」而老師只拿得到 404。
`test/unit/serveIndexFlags.test.js` 補了一項專門擋「另造 `FEATURE_SIMILAR_*`」。

**`index.html` 的第四個 `<meta name="feature-similar" content="__FEATURE_SIMILAR__">` 歸 WS-D**；
在它加上去之前，這個 `replaceAll` 是 no-op（找不到佔位字串），不影響現行頁面。
