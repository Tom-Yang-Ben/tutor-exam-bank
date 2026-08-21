# 第一輪裁決通知（2026-08-21）— 貼給各 WS 的 Claude

> 裁決已寫進 `docs/interfaces.md` §1.6（第 13–25 條）與新增的 §12；`migrations/0004_origin_legacy.sql`、`.env.example`、`NOTICE` 已在 main 更新。
> 四條 WS 都先 `git merge main`，再依下面各自的段落動手。`interfaces.md` 仍然不得自行修改。

## 給 WS-A

```
docs/interfaces.md 已更新（裁決 13–25、新增 §12），請 git merge main 後讀 §1.6 與 §12，然後做：
1. §12.4：POST /api/questions 與 PUT /api/questions/:id 成功後呼叫 services/embedService.js 的 embedByIds([id])（EMBED_MODE=fixture 或無金鑰時允許失敗只記 log，不影響主要回應；或至少把 embed_hash 設 NULL 讓 backfill 撿到）。這是唯一的功能缺口：目前新題永遠沒有 search_tsv。
2. 確認 deleteQuestion 回應、config/features.js 匯出形狀、archived_at 邊界與 §12.1–12.3 一字不差（都是照你的 questions-wsA.md 接受的，應該不用改）。
3. config/db.js 的 DB_* 退路維持你現在的 PG 預設值；D-X1 時整段刪除（先不要做）。
4. questions-wsA.md 每條加一行「裁決：…（見 interfaces.md 第 N 條）」後結案。
整合測試 test/integration/controllers.pg.test.js 在四合一樹上全綠，不用動。
```

## 給 WS-B

```
docs/interfaces.md 已更新（裁決 13–16 是回你的），請 git merge main 後做：
1. migrations/0004_origin_legacy.sql 已由開發者加入（origin CHECK 多 'legacy'）。import_pg.js 對舊題一律寫 origin='legacy'；與 seed_questions.js 題幹完全相同的 30 題仍寫 'seed' + chapter_src='human'。
2. verify.js 的 attempts 守恆條文改為裁決 14 的寫法（差額逐筆進 name_merge_report.md、--allow-merged 放行）；你現在的實作已符合，只改文件與訊息措辭。
3. 姓名為空的舊試卷：預設中止 + 提示回 MySQL 補姓名（裁決 15）；--unknown-student 保留但在 runbook 標為「不建議」。
4. cutover-runbook.md 在 import→verify 之後加一步「回填向量.bat」（裁決 16：search_tsv/embedding 由 embedService 統一回填），並把 0004 納入 migrate 步驟。
5. questions-wsB.md 每條加「裁決：…」後結案。你要的四個 npm scripts 由 WS-D 加，.env.example 的 BACKUP_* 已由開發者加入。
```

## 給 WS-C

```
docs/interfaces.md 已更新（裁決 17–21 是回你的），請 git merge main 後確認：
1. 第 2 條：dict.txt.big 改為選用（JIEBA_DICT_BIG 預設不啟用）——你的實作已符合，不用改。
2. 第 5 條：sides 參數正式寫進介面——已符合。
3. 第 6 條：/similar 拿掉 scope=all；給 all 回 400。請刪掉逐學科合併的那段程式與對應測試。
4. 第 2 條新增「search_tsv 來源與權重」= 你 embedService 的章節 A／關鍵詞 A／題幹 B；請確認那支產生三段 token 的純函式有 module.exports 匯出（名稱寫進 docs/retrieval.md），WS-D 的 pgEngine 會改呼叫它。
5. questions-wsC.md 每條加「裁決：…」後結案。.env.example 的 EMBED_FIXTURE_DIR / JIEBA_DICT_BIG 已由開發者加入。
```

## 給 WS-D

```
docs/interfaces.md 已更新（裁決 18、21、24、25 是回你的），請 git merge main 後做：
1. test/unit/evalRanker.test.js 有 2 個測試（「命中越多關鍵字排越前」「關鍵字側比對的是整段 embed_text」）是對你的 bigram stub 寫的，合併後換成 WS-C 的 jieba 分詞就失敗；改成對 jieba 的期望值，或改寫成分詞器無關的斷言。
2. test/integration/schema.test.js「attempts 的 UNIQUE 擋得住重複指派」會撞 students_name_key（上一輪殘留的「整合測試學生」）；測試前清理或改 ON CONFLICT。
3. 純向量欄改傳 buildHybridQuery 的 sides:['vec']（第 5 條），不再靠 queryTokens=[]。
4. eval/lib/pgEngine.js 灌 fixture 時的 search_tsv 改呼叫 WS-C embedService 匯出的 tsv 純函式（第 2 條、裁決 21），eval/lib/tokenize.js 與 eval/lib/embedText.js 的轉接殼維持「有真的就用真的」。
5. package.json scripts 加：migrate:export / migrate:import / migrate:verify / db:backup（見 questions-wsB.md Q5）。
6. questions-wsD.md 每條加「裁決：…」後結案。
```
