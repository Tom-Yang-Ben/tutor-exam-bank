# eval —— 檢索評估體系（WS-D）

規格來源：`docs/roadmap-plan.md` §5.3.1–3.4、§5.6、§2.8；介面契約：`docs/interfaces.md`。

這個目錄回答一個問題：**改了檢索之後，到底變好還是變壞，好多少。**
不是「有沒有回 200」，而是 Recall@5 / Recall@10 / MRR 三個數字，分 LIKE、純向量、hybrid 三欄對照。

---

## 1. 兩層資料，一套 schema

| | 公開層 | 私有層 |
|---|---|---|
| 位置 | `eval/fixtures/`、`eval/golden/` | `eval/private/`（`.gitignore` 排除） |
| 內容 | **自行編寫**的 60 題教科書型例題 + 40 筆檢索 golden | 對真實題庫的人工標註 |
| 進版控 | ✅ | ❌ 永不 |
| 進 CI | ✅ 守「不退步」 | ❌ 只在本機跑 |
| 數字的意義 | 相對比較（這次 vs 上次） | 真實表現，手動抄進 README |

為什麼要分兩層：repo 政策是「不含任何題庫資料」（見根目錄 `NOTICE`），
所以進 CI 的題目必須是自製的；但自製 fixture 的分佈與真實題庫不同，
**CI 全綠不等於真實效果好**。公開層只守「不退步」，真實表現由私有層在本機量。

跑私有層：

```bash
npm run eval -- --suite retrieval --golden eval/private/golden/retrieval.json
```

`run.js` 偵測到 `--golden` 落在 `eval/private/` 時會自動把 cassette 與報表目錄一起切進
`eval/private/`，並且**不把逐題明細寫進報表**——避免含逐字試題的內容以任何形式流進 repo。

---

## 2. 三欄是什麼

| 欄 | 怎麼算 | 為什麼要有它 |
|---|---|---|
| **LIKE（基準）** | 該題 `embed_text` 去掉第 1 行（學科｜章節｜題型｜難度）後 `tokenize()`，取前 3 個長度 ≥ 2 的詞，各自 `LIKE '%詞%'` 取 OR | 對應 `questionController.js` 現行的搜尋寫法。它是「什麼都不做」的對照組——hybrid 打不贏它，這整套檢索就沒有存在的理由 |
| **純向量** | `queries/hybrid.js` 但 `queryTokens` 傳空陣列（關鍵字側回空集合，RRF 分數退化成 `1/(60+vec_rank)`，排序即純向量順序） | 讓「向量」與「hybrid」共用同一段 SQL 與同一組候選條件，兩欄的差異只剩融合本身 |
| **hybrid** | `queries/hybrid.js`，RRF：`1/(60+vec_rank) + 1/(60+kw_rank)` | 實際上線的那條路徑 |

**LIKE 欄的關鍵字規則寫死在 `eval/lib/pooling.js`，不可以在 PR 裡順手調。**
理由很直接：只要有人把關鍵字從 3 個調成 5 個、或不去掉章節那一行，
hybrid 的相對優勢就可以被憑空製造出來，而報表上完全看不出來。

---

## 3. 怎麼跑

```bash
# 只跑 LIKE 欄——不需要向量、不需要 DB，最快確認骨架沒壞
npm run eval -- --suite retrieval --mode like

# 三欄對照（有向量 fixture 與 queries/hybrid.js 時自動走 pg engine）
npm run eval:retrieval

# 強制用記憶體排序器（不碰 DB）／強制走真 PG
npm run eval -- --suite retrieval --engine memory
npm run eval -- --suite retrieval --engine pg

# 印出與上一份報表的差值
npm run eval:trend

# 重建 golden 建議稿（會覆寫 eval/golden/retrieval.json，人工判定過的內容會被蓋掉，小心）
npm run eval:golden

# 錄製 fixture 向量（只在本機、由開發者本人執行，需要 GEMINI_API_KEY）
npm run eval:record
npm run eval:record -- --dry-run     # 先看會送幾批、多少字元

# 第一次量測後寫 thresholds.json 初值（= 量測值 − 0.03）
npm run eval:baseline
```

常用旗標：`--golden <path>`、`--mode like|vector|hybrid|all`、`--engine memory|pg|auto`、
`--scope chapter|subject|all`（預設 `subject`）、`--fuse rrf|weighted`、`--limit`、`--no-exclude-self`。

整合測試（需要 PG）：

```bash
docker compose up -d postgres_test
$env:TEST_DATABASE_URL = "postgres://exam:exam@localhost:5433/tutor_exam_bank_test"   # PowerShell
npm run migrate:test
npm run test:integration
```

`npm test` 只跑 `test/unit/`，**永遠不連 DB、不呼叫 Gemini、不需要 secrets**。

---

## 4. 門檻（ratchet）

`eval/thresholds.json` 的初值 = **第一次量測 − 0.03**，之後**只升不降**。

- 門檻是 `null` = 還沒有基準線：只報告不擋。
- 門檻有數字卻量不到那一欄 = **失敗**。否則「向量檔被誤刪」會表現成 CI 全綠。
- `hybrid` 的 Recall@5 必須 **≥ LIKE**。差值只報，不設數字門檻——
  「要贏多少才算贏」很容易被 baseline 的定義操弄，只有「不得更差」這條不可爭辯。
- `--write-baseline` 在 stub 狀態下**拒絕執行**（見下一節）。

---

## 5. 目前的暫用狀態（stub）

WS-C 的三個檔還沒合入時，eval 用 `eval/lib/` 內的轉接層退回暫用實作：

| 缺的東西 | 誰的 | 沒有它的後果 |
|---|---|---|
| `utils/tokenize.js` | WS-C（D-T1） | LIKE 欄與 hybrid 關鍵字側改用 CJK bigram 的 stub 分詞器，數字不是最終規則 |
| `utils/embedText.js` | WS-C（D-E3） | `embed_hash` 與最終規則不同 → 錄出來的向量檔會全部查不到 |
| `queries/hybrid.js` | WS-C（D-R1） | 只能跑 `--engine memory`；D-R2 的 Jaccard 斷言會 skip |
| `config/db.js` 的 `{ pool, query }` | WS-A（D-D3） | 同上 |
| `eval/fixtures/embeddings.*.json` | D-V0（需開發者本人的金鑰） | 向量／hybrid 欄印 `n/a` |

三個硬性 guard，都是為了不留下「看起來有數字、其實是假的」的痕跡：

1. **不拿假向量湊數字**。查不到向量就印 `n/a` 並說明原因（`docs/interfaces.md` 第 4 條）。
2. **stub 狀態下不得寫 `thresholds.json` 初值**。否則 WS-C 合入真 jieba 之後數字必然變動，
   CI 會紅得莫名其妙，而紅燈的原因跟這次改動無關。
3. **stub 狀態下不得錄向量**。鍵是 `sha256(buildEmbedText(q))`，規則差一個字元，整份表作廢。

轉接層會在 stderr 警告，並把 `tokenizer` / `embedText` 的實際來源寫進每一份報表的 `meta`。
**比較兩份 `meta` 不同的報表是沒有意義的**，`eval/trend.js` 會先把環境差異列出來再印數字。

---

## 6. 待人工確認的兩件事

| 項目 | 狀態 | 誰做 |
|---|---|---|
| `eval/fixtures/questions.public.json` 的 60 題答案 | `needs_human_confirm` | 開發者本人逐題核對 |
| `eval/golden/retrieval.json` 的 40 筆相關性判定 | 40/40 `needs_human_confirm` | 開發者本人逐筆判定 |

golden 的建議是從 **fixture 的結構標註**推出來的（同 `variant_group` = 正樣本、
`lookalike_of` 與同章 `distractor` = 硬負樣本），**不是**從任何檢索系統的輸出推出來的。
用被測系統的輸出當答案，就是規劃 §5.6.1 說的自證；向量近鄰只用來擴大候選池
（`_suggestion.pool`），讓人工判定時看得到可能漏掉的正樣本。

確認完成後把每筆的 `needs_human_confirm` 改成 `false`，
`test/unit/evalFixtures.test.js` 的對應斷言也要跟著從「全部待確認」改成「全部已確認」。

---

## 7. 檔案地圖

```
eval/
  run.js                    唯一入口
  trend.js                  與上一份報表的差值
  record_embeddings.js      D-V0：錄 fixture 向量（本機、需金鑰）
  thresholds.json           CI 門檻（ratchet）
  .env.replay               LLM_MODE=replay / EMBED_MODE=fixture（無金鑰，進版控）
  fixtures/
    questions.public.json   60 題自製 fixture
    embeddings.<model>.768.json   由 record_embeddings.js 產生
  golden/retrieval.json     40 筆檢索 golden
  lib/
    fixtures.js  golden.js       載入 + 硬閘門
    tokenize.js  embedText.js    轉接 WS-C 的凍結介面（未合入時 stub）
    embeddings.js                讀向量 fixture
    pooling.js                   LIKE 關鍵字規則（凍結）+ 候選池
    ranker.js                    記憶體排序器（LIKE 欄 + SQL 的對照組）
    pgEngine.js                  對真 PG 下 queries/hybrid.js
    metrics.js                   Recall@K / MRR / Jaccard（純函式）
    report.js  thresholds.js     報表與門檻
  tools/suggest_golden.js   產生 golden 建議稿
  reports/                  報表輸出（.gitignore）
  private/                  私有層（.gitignore）
```

對應的測試在 `test/unit/metrics.test.js`、`evalPooling.test.js`、`evalFixtures.test.js`、
`evalRanker.test.js`，以及 `test/integration/schema.test.js`、`retrievalEval.test.js`。
