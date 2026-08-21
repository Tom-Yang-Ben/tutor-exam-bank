# 階段 2 第一輪裁決通知（2026-08-22）— 貼給各 WS 的 Claude

> 四條已全部合進 main（含試合併時補回的相依）。裁決 S2-1～S2-25 已寫進 `docs/interfaces-stage2.md` §12 與對應條文；`.gitignore`（放行 fixture PDF）、`.env.example`（`GEMINI_RPM=5`）已在 main。
> 每條 WS 先 `git merge main && cd exam_pro && npm ci`，再做自己的段落。`interfaces*.md` 仍不得自行修改。
> 合併後 main 目前已知的紅（都在下面的小修範圍內）：B 的 extract cassette 測試與 D 的 `pipelineDriver` 測試（樣卷改以 D 的為準）、`--suite pipeline`（同上）、A 的 approve 整合測試（`text_hash` 重算）。

## 給 WS-A

```
docs/interfaces-stage2.md 已更新（§12 裁決 S2-1～25），請 git merge main && cd exam_pro && npm ci 後做：
1. S2-8：runner 組 ctx 時加 ctx.config.features = { similar, pipeline }（來源 config/features.js）。
2. S2-4：generateJson 回傳的 schemaFallback（agent 會放進 outcome.data.schema_fallback）寫進 job_events.detail.schema_fallback。
3. S2-20：app.js 歸你；serveIndex() 的字串替換加 __FEATURE_PIPELINE__ → process.env.FEATURE_PIPELINE || 'false'（與 __API_KEY__ 同一行處理）。
4. S2-23：approve 入庫的 text_hash 對修正後 question_text 以 utils/normalizeStem.textHash 重算（reviewController 現在就是這樣），把 test/integration/jobs.pg.test.js 那一項「text_hash 等於 payload 的 cccc…」改成斷言等於 textHash(修正後文字)。
5. S2-7／S2-6：save 在 runner、dedup0/dedup1 的對應表——你現在的實作已符合，只要確認註解引用到 §12。
6. questions2-wsA.md 每條加「裁決：…（S2-n）」後結案。
跑 npm test 與 npm run test:integration（需 TEST_DATABASE_URL）全綠再回報。
```

## 給 WS-B

```
docs/interfaces-stage2.md 已更新（§12 裁決 S2-1～25），請 git merge main && cd exam_pro && npm ci 後做：
1. S2-15：樣卷以 WS-D 的 eval/fixtures/sample_exam.pdf（由 eval/fixtures/make_sample_pdf.js 產生，sha256 f1a15d77…）為準；刪除 scripts/make_sample_exam_pdf.js；scripts/record_cassettes.js 改讀 D 的樣卷。
2. S2-19：從 A-T8 之前的版本快照 services/legacy/analyzePdf.js（git show e1740ca:exam_pro/services/aiService.js），只改 module path／require，行為不變；eval/lib/legacyAdapter.js 會自動偵測它。
3. S2-5：確認 templates.js 的 registerTemplate/getTemplate 已匯出；extract/classify 已註冊；等 WS-C 註冊 lint/verify 後四個都走原文雜湊。
4. S2-13／S2-8：classify 對 chapter_confidence 缺值或 0 一律視為閘門不過；ctx.config.features.similar 為真時才走 A 層。
5. **先不要重錄 cassette**——等 WS-C 的 registerTemplate 與 buildSchema 切換合入（模板／schema 一改鍵就變），由開發者統一通知「可以錄了」再跑：
   node scripts/record_cassettes.js --agent all（extract 1 次 + classify 8 題）
   LLM_MODE=record GEMINI_RPM=5 node eval/run.js --suite classify（90 筆 golden，約 18 分鐘）
   LLM_MODE=record GEMINI_RPM=5 node eval/run.js --suite pipeline（6 題的 extract/classify/lint/verify）
   錄完 git add eval/cassettes 並確認 LLM_MODE=replay 下三個 suite 全綠。
6. questions2-wsB.md 每條加「裁決：…」後結案；附帶的 #47／#54 交給開發者決定。
```

## 給 WS-C

```
docs/interfaces-stage2.md 已更新（§12 裁決 S2-1～25），請 git merge main && cd exam_pro && npm ci 後做：
1. S2-24：WS-B 的 agents/schemas/index.js 已在 main，agents/lint.js／verify.js 改 require('./schemas').buildSchema，刪除 agents/_schema.js。
2. S2-5：agents/lint.js／verify.js 在模組載入時呼叫 services/llm/templates.js 的 registerTemplate('lint.v1'|'verify.v1', PROMPT_TEMPLATE)，generateJson 傳 template 識別名。
3. S2-12：utils/answerCompare.js 的 final_answer 抽取改為第 4.2 條新規則（最後一個 $…$，含 = 或 \approx 取其後，純上下標片段視為單位跳過，沒有 $…$ 就取整段最後一個 =／\approx 之後）；單元測試用 WS-D 在 questions2-wsD.md Q3 列的案例（#9、#13、#32、#45、#22）。
4. S2-11：負號保留、± 只與 ± 比——你已這樣做，確認測試有。
5. S2-17／S2-18：bare_script 雙埋點與 bare_script_text、info 併 warn——已符合，確認 rule 名寫進 docs 註解。
6. scripts/backfill_text_hash.js 改 require utils/normalizeStem（檔頭 TODO），並驗證對開發庫 70 題的雜湊逐位元相同（node scripts/backfill_text_hash.js --dry-run 比對）。
7. questions2-wsC.md 每條加「裁決：…」後結案。
```

## 給 WS-D

```
docs/interfaces-stage2.md 已更新（§12 裁決 S2-1～25），請 git merge main && cd exam_pro && npm ci 後做：
1. S2-12：eval/golden/answer.json 依新抽取規則改回真實寫法（過程 = 結論），extraction_hazard 的那幾筆 expect 改回 agree；等 WS-C 的 answerCompare 合入後 test/unit 的 answer golden 測試應全綠。
2. S2-13：classify suite 的輸入約定已寫進第 3.3 條；維持現做法，並把「source='gate' 應為 0」的斷言保留。
3. S2-14：CI 比對 replay miss 訊息只比到 `--suite ` 為止。
4. S2-22：review.js 在 jobs.state 為 queued／extracting 時顯示「拆題中」，不要把 counts 全 0 當成錯。
5. S2-20：FEATURE_PIPELINE 的 meta 注入由 WS-A 在 app.js 補；你這邊 parseBool 讀法不變。
6. compare_pipeline：WS-B 會建 services/legacy/analyzePdf.js（S2-19），legacyAdapter 的指紋檢查保留。
7. questions2-wsD.md 每條加「裁決：…」後結案。
```

## 合併後的錄製順序（開發者本人協調）

1. A、C、D 的小修合入 → 2. 通知 WS-B 重錄 cassette（上面第 5 點，約 25 分鐘、免費層） → 3. CI 三個 suite 綠 → 4. 跑 A-T16 前後對照（私有 PDF，連外，手動）。
