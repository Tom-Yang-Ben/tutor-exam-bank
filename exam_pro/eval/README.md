# eval —— 評估體系（WS-D）

規格來源：`docs/roadmap-plan.md` §5.3.1–3.5、§5.6、§2.8、§3.8；
介面契約：`docs/interfaces-stage1.md`（階段 1）與 `docs/interfaces-stage2.md`（階段 2，優先）。

這個目錄回答一個問題：**改了東西之後，到底變好還是變壞，好多少。**
不是「有沒有回 200」，而是具體的數字：

| suite | 量什麼 | 進 CI |
|---|---|---|
| `--suite retrieval`（階段 1） | Recall@5／Recall@10／MRR，分 LIKE、純向量、hybrid 三欄對照 | ✅ |
| `--suite classify`（階段 2，A-T14） | 章節分類的 accuracy／macro-F1／Top-5 混淆對，cassette 回放 vs golden | ✅ |
| `--suite pipeline`（階段 2，A-T14） | 各節點通過率、needs_review 原因分佈、每份 PDF 的 token 與成本 | ✅ |
| `compare_pipeline.js`（E-X12a） | 舊流程 vs 新管線的逐欄對照 | ❌ 會連外，只在本機跑 |

公式 golden（`eval/golden/formula.json`）由 **WS-C** 產出，以 `node --test` 的表格測試跑，
不走 `eval/run.js`——它是純函式的 golden，不需要 cassette。

---

## 1. 兩層資料，一套 schema

| | 公開層 | 私有層 |
|---|---|---|
| 位置 | `eval/fixtures/`、`eval/golden/` | `eval/private/`（`.gitignore` 排除） |
| 內容 | **自行編寫**的 60 題教科書型例題、自製樣卷 `sample_exam.pdf`，以及四份 golden（檢索 40／分類 90／答案 50／重複 30） | 對真實題庫與真實考卷的人工標註 |
| 進版控 | ✅ | ❌ 永不 |
| 進 CI | ✅ 守「不退步」 | ❌ 只在本機跑 |
| 數字的意義 | 相對比較（這次 vs 上次） | 真實表現，手動抄進 README |

為什麼要分兩層：repo 政策是「不含任何題庫資料」（見根目錄 `NOTICE`），
所以進 CI 的題目必須是自製的；但自製 fixture 的分佈與真實題庫不同，
**CI 全綠不等於真實效果好**。公開層只守「不退步」，真實表現由私有層在本機量。

跑私有層：

```bash
npm run eval -- --suite retrieval --golden eval/private/golden/retrieval.json
node eval/compare_pipeline.js --method legacy --pdfs eval/private/pdf/ --golden eval/private/pdf_golden/
```

`run.js` 偵測到 `--golden` 落在 `eval/private/` 時會自動把 cassette 與報表目錄一起切進
`eval/private/`，並且**不把逐題明細寫進報表**——避免含逐字試題的內容以任何形式流進 repo。

---

## 2. 三欄是什麼

| 欄 | 怎麼算 | 為什麼要有它 |
|---|---|---|
| **LIKE（基準）** | 該題 `embed_text` 去掉第 1 行（學科｜章節｜題型｜難度）後 `tokenize()`，取前 3 個長度 ≥ 2 的詞，各自 `LIKE '%詞%'` 取 OR | 對應 `questionController.js` 現行的搜尋寫法。它是「什麼都不做」的對照組——hybrid 打不贏它，這整套檢索就沒有存在的理由 |
| **純向量** | `queries/hybrid.js` 傳 `sides:['vec']`（interfaces 第 5 條、裁決 18），與 `/similar` 的 `mode=vector` 同一條路 | 讓「向量」與「hybrid」共用同一段 SQL 與同一組候選條件，兩欄的差異只剩融合本身 |
| **hybrid** | `queries/hybrid.js` 傳 `sides:['vec','kw']`，RRF：`1/(60+vec_rank) + 1/(60+kw_rank)` | 實際上線的那條路徑 |

**關鍵字側的兩端都不自己分詞**（interfaces 第 2 條、裁決 21）：

- 文件端（`search_tsv`）＝ `services/embedService.js` 的 `buildTsvTokens()`，
  寫成 `章節 A ‖ keywords A ‖ 題幹 B`。`eval/lib/pgEngine.js` 灌 fixture 時呼叫同一支，
  `eval/lib/ranker.js` 的記憶體對照組也呼叫同一支（並套 `ts_rank` 的預設權重 `A=1.0`、`B=0.4`）。
- 查詢端＝ `eval/lib/ranker.js` 的 `queryTokensFor()`，對齊 `services/retrievalService.js`
  的 `queryTokensForSource()`：取權重 `A` 的章節與 `keywords` 兩段，沒有才退回題幹。

只改其中一端，D-R2 的 Jaccard 就會轉紅，而**紅燈的原因會看起來像排序器寫錯**。

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

`test:integration` 帶 `--test-concurrency=1`：三支整合測試檔（`schema` / `hybrid` / `controllers`）
都對同一顆測試庫 `TRUNCATE`，並行跑的話彼此的交易與 `TRUNCATE` 會互相踩，
症狀是隨機一支轉紅、重跑又過——最難查的那種 flaky。

`npm test` 只跑 `test/unit/`，**永遠不連 DB、不呼叫 Gemini、不需要 secrets**。

---

## 3b. 階段 2 的兩個 suite（A-T14）

```bash
npm run eval:classify     # = npm run eval -- --suite classify
npm run eval:pipeline     # = npm run eval -- --suite pipeline
```

### `--suite classify`——量的是**第二層 LLM**，不是零成本閘門

`agents/classify.js` 有兩層（interfaces-stage2.md 第 3.3 條）：
第一層是零成本閘門（`isValidChapter` 且 `chapter_confidence ≥ CLASSIFY_MIN_CONF` 就直接放行、
不呼叫 LLM），第二層才是 few-shot + LLM。

**本 suite 固定餵 `{subject, chapter: decoy 或 '', chapter_confidence: 0, question_text}`
且 `ctx.db = null`**，強迫每一筆都走第二層。理由：如果把正解連同高信心一起餵進去，
閘門會 100% 命中、accuracy 恆為 1.0，而第二層一次都不會被呼叫——
那量到的是「我把答案抄給它然後它抄回來」。零成本閘門的通過率改在 `--suite pipeline` 量
（那裡的信心值來自真的 extract 輸出）。

`ctx.db = null` 不是「少了 DB 所以將就」，而是 cassette 鍵的可重現性要求：
`cacheKeyParts` 含 `fewShotIds`，只要 few-shot 來自資料庫，題庫多一題、近似索引微動、
同分排序變動都會讓鍵改變，replay 就會 miss（規劃 §5.3.3）。錄製時同樣 `ctx.db = null`。

這個約定已由**裁決 S2-13 寫進 `interfaces-stage2.md` 第 3.3 條**，不再是 WS-D 的單方決定。
suite 仍保留「`source='gate'` 應為 0」的斷言——那是這條約定有沒有真的生效的唯一訊號。

輸出：accuracy、macro-F1、Top-5 混淆對，另外分段報「fixture 60 題」與「漂移變體 30 筆」
（再細分同題幹改寫／章節名同義詞）——漂移那一段掉得特別多，就是 prompt 該補的地方。

### `--suite pipeline`——對自製樣卷跑完整條管線

輸入固定是 `eval/fixtures/sample_exam.pdf`（10 題，含 2 題刻意寫壞的 LaTeX），
以 `LLM_MODE=replay` 跑 extract → dedup0 → classify → lint → verify → dedup1 → save。

輸出三組數字：各節點通過率（**分母是 `pass + fail + error`，不含 `skipped`**——
證明題的 verify 與未就緒的 dedup1 本來就該跳過）、needs_review 原因分佈、
每份 PDF 的 token 與成本（`token_out` 一定含 thinking，第 0.4 條）。

### 兩個 suite 現在的狀態

第二輪合併後 `agents/*`、`pipeline/stateMachine.js`、`utils/*` 都已就位，
轉接層會自動改用真實作（`eval/lib/stage2Shims.js`、`stateMachineShim.js` 的既定行為）。
下表是「哪一格還不是真的」的判讀方式——實際狀態每次跑都會印在報表的 meta 與警告裡，
**以那一份為準**，不要以這張表為準：

| 缺什麼 | 目前的行為 |
|---|---|
| `agents/extract.js` | 走 **oracle stub**：直接拿答案卷當拆題結果。`extract_recall` 與 `chapter_acc` 在定義上必為 1.0，因此**一律印 n/a** |
| `agents/classify.js` | classify 只跑第一層閘門。閘門通過率是真的，分類正確率不是 |
| `agents/verify.js` | verify 一律 `skipped`，`answer_agree_rate` 印 n/a（**不拿答案卷代打**，否則恆為 1） |
| `agents/dedup.js` | L0 用 eval 自己的確定性實作（**是真的**），L1 一律 `skipped` |
| `utils/answerCompare.js`、`parseLatexStrict`、`config/pricing.js` | 回 `null` → 報表印 n/a。這三支**沒有寫 stub**：一個「差不多」的暫用版會產生看起來合理、而且會被抄進 README 的假數字 |

`eval/thresholds.json` 的 `classify` 與 `pipeline` 兩節目前全是 `null`（只報告不擋），
而且 `--write-baseline` 在上表任一列還是 stub 時**拒絕執行**。

---

## 3c. 新舊對照 `compare_pipeline.js`（E-X12a）

```bash
# 公開樣卷（--method legacy 會呼叫 Gemini，需要 GEMINI_API_KEY）
npm run compare:legacy
npm run compare:pipeline          # replay，不連外

# 私有 PDF（報表與 cassette 自動切到 eval/private/，逐題明細不落地）
node eval/compare_pipeline.js --method legacy --pdfs eval/private/pdf/ --golden eval/private/pdf_golden/

# 只做載入與配對檢查，不呼叫任何模型
node eval/compare_pipeline.js --method legacy --dry-run
```

欄位（規劃 §5.3.5）：`q_expected | q_extracted | extract_recall | chapter_acc |
formula_strict_rate | token_in | token_out | cost_usd | latency_ms | model | prompt_hash`；
`--method pipeline` 另加 `answer_agree_rate | dedup_hits | saved | needs_review`。

**legacy 的 `saved` 恆為 0**，這不是 bug：舊流程只把陣列回給前端，一題都沒有入庫，
要老師按下「批量入庫」才會寫。這個不對稱正是規劃 §5.3.5 要呈現的結果。
**legacy 的 `token_in`／`token_out` 恆為 n/a** 也一樣：`aiService.analyzePdfContent`
根本沒有記帳，`usageMetadata` 在函式裡就被丟掉了。

### 答案卷

```
eval/golden/pdf_sample/<sha256>.json     公開樣卷，進版控
eval/private/pdf_golden/<sha256>.json    真實考卷的人工標註，永不進版控
```

**檔名必須是 PDF 的 sha256**，不是人取的名字。用檔名對應遲早會發生
「換了 PDF 沒換答案卷」，而症狀是 `extract_recall` 突然掉到 0，看起來像模型壞掉。
載入時會比對雜湊，不符就拒絕執行。

### ⚠️ legacy 一定要是 legacy

`eval/lib/legacyAdapter.js` 依序找 `services/legacy/analyzePdf.js` → `services/aiService.js`。
WS-B 的 A-T8 會把 `aiService.analyzePdfContent` 換成新 extract agent 的**相容包裝**——
那一刻起，`--method legacy` 量到的其實是新管線，兩欄數字會神奇地一模一樣而不會有任何錯誤。
腳本會檢查 `aiService.js` 裡還在不在「手抄的章節白名單」這個 legacy 指紋，不在就大聲警告。
`services/legacy/analyzePdf.js` 目前**沒有主人**（不在所有權表內），見 `docs/archive/questions2-wsD.md` Q1。

---

## 3d. 自製樣卷 `sample_exam.pdf`

```bash
npm run eval:sample-pdf                              # 重產
node eval/fixtures/make_sample_pdf.js --check        # 只驗現有檔案的 sha256 與本次產物一致
```

三個必須：內容只能取自 `questions.public.json`（NOTICE 第 2 條）、
輸出必須逐位元可重現（固定 `CreationDate` 與 file ID，否則 cassette 的
`cacheKeyParts.pdfSha256` 每次重產都失效）、字型必須是授權允許嵌入散布的
（Noto Sans TC，SIL OFL 1.1；標楷體與微軟正黑體**不可**）。

**重產一定會改變 sha256**（換字型、加題目都算），屆時：
① `eval/golden/pdf_sample/` 的答案卷檔名要跟著換（腳本會刪掉過期的那份）、
② extract 的 cassette 要重錄。

已知限制：`NotoSansTC-VF.ttf` 是可變字型，fontkit 無法對它的具名實例做子集化，
所以嵌進去的是預設的 **Thin** 字重（字劃偏細但可讀）。

---

## 3e. 前端資產檢查 `npm run check:html`

```bash
npm run check:html
```

對 `public/*.html` 的每一段 inline `<script>` 與 `public/js/*.js` 做 `node --check`
（script 與 module 兩種模式分開判定），並檢查 interfaces-stage2.md 第 8 條的三個接點
（`<section id="review">`、`<script type="module" src="/js/review.js">`、`window.ExamApp` 的五個橋接函式）
與舊流程的兩個端點還在。

存在的理由：`public/index.html` 有一段一千多行的 inline script，**不在任何測試的路徑上**。
少一個右大括號，唯一的症狀是打開瀏覽器整頁沒有反應，而 CI 全綠。
同樣的檢查也寫成 `test/unit/publicAssets.test.js`，所以 `npm test` 一樣擋得住。

---

## 4. 門檻（ratchet）

`eval/thresholds.json` 的初值 = **第一次量測 − 0.03**，之後**只升不降**。
三個 suite 共用同一套規則（`retrieval` / `classify` / `pipeline`），`compareSuite()` 各自比對自己那一節。

- 門檻是 `null` = 還沒有基準線：只報告不擋。
- 門檻有數字卻量不到那一欄 = **失敗**。否則「向量檔被誤刪」會表現成 CI 全綠。
- `hybrid` 的 Recall@5 必須 **≥ LIKE**。差值只報，不設數字門檻——
  「要贏多少才算贏」很容易被 baseline 的定義操弄，只有「不得更差」這條不可爭辯。
- `--write-baseline` 在「暫用實作」狀態下**拒絕執行**（見下一節）。
- **只放「越高越好」的指標**。`needs_review` 的比率越低越好，放進 ratchet 會變成
  「只准更多題進複核」——那不是門檻，是反向的門檻。這類數字只在報表裡呈現分佈。
- 「整欄門檻都是 `null`」＝ 尚未建立基準線，等同於欄位不存在（只報告不擋）；
  只要**其中一個指標有數字**，那一欄就開始守門，量不到就算失敗。

### replay miss 的處置（介面第 5.2 條、裁決 S2-14）

`services/llm/fake.js` 在 cassette 找不到時一律丟錯，訊息逐字凍結，
`<suite>` **保持字面不代換**（它不知道自己在跑哪個 suite）。
「這是不是 replay miss」與「fork PR 要不要降級」則是 WS-D 的判斷——
介面的原話是「**這個判斷不在 `services/llm` 裡**」，落在 `eval/lib/replayMiss.js`。

**比對只到 `--suite ` 為止**（S2-14）。凍結的是前綴，不是整句；
拿整串去比會讓「多印一行有用的提示」變成破壞性改動。

| 情境 | 行為 |
|---|---|
| 本機 | miss = 紅燈。跑得出 miss 就是真的少錄了 cassette |
| main／同 repo 分支的 PR | miss = 紅燈 |
| fork PR（`EVAL_FORK_PR=true`，由 `ci.yml` 從 `github.event.pull_request.head.repo.fork` 傳入） | miss 降為 warning——外部貢獻者拿不到金鑰、無法自救（規劃 §5.3.3） |

---

## 5. 相依狀態

第一輪合併後，WS-A 與 WS-C 的零件都在了，只剩向量 fixture 要由開發者本人錄：

| 相依 | 誰的 | 狀態 | 沒有它的後果 |
|---|---|---|---|
| `utils/tokenize.js` | WS-C | ✅ 已合入 | — |
| `utils/embedText.js` | WS-C | ✅ 已合入 | — |
| `services/embedService.js` 的 `buildTsvTokens()` | WS-C | ✅ 已合入 | — |
| `queries/hybrid.js` | WS-C | ✅ 已合入 | — |
| `TEST_DATABASE_URL`（pg engine 自建 Pool，不經 `config/db.js`；裁決 26） | — | ✅ | 庫名必須以 `_test` 結尾 |
| `eval/fixtures/embeddings.<model>.768.json` | D-V0（需開發者本人的金鑰） | ⬜ 未錄製 | 向量／hybrid 欄印 `n/a`；D-R2 的整合測試 skip |

`eval/lib/tokenize.js` 與 `eval/lib/embedText.js` 是**轉接殼**，規則是「有真的就用真的」：
`utils/` 底下有就直接用，沒有才退回殼內標示清楚的暫用實作。合入後不必改 eval——
但殼保留著，是為了讓「哪一支不見了」變成一句明確的警告，而不是一個 `MODULE_NOT_FOUND` 堆疊。

三個硬性 guard，都是為了不留下「看起來有數字、其實是假的」的痕跡：

1. **不拿假向量湊數字**。查不到向量就印 `n/a` 並說明原因（`docs/interfaces-stage1.md` 第 4 條）。
2. **暫用實作狀態下不得寫 `thresholds.json` 初值**。基準線一定會被之後的真實作推翻，
   CI 會紅得莫名其妙，而紅燈的原因跟那次改動無關。
3. **暫用實作狀態下不得錄向量**。鍵是 `sha256(buildEmbedText(q))`，規則差一個字元，整份表作廢。

報表的 `meta` 會記下 `tokenizer` / `embedText` 的實際來源。
**比較兩份 `meta` 不同的報表是沒有意義的**，`eval/trend.js` 會先把環境差異列出來再印數字。

---

## 6. 待人工確認

| 項目 | 狀態 | 誰做 |
|---|---|---|
| `eval/fixtures/questions.public.json` 的 60 題答案 | ✅ 2026-08-22 已逐題核對 | — |
| `eval/golden/retrieval.json` 的 40 筆相關性判定 | ✅ 已逐筆定案 | — |
| `eval/golden/classify.json` 的 90 筆章節標籤 | 90/90 `needs_human_confirm` | 開發者本人 |
| `eval/golden/answer.json` 的 50 題 | 50/50 `needs_human_confirm` | 開發者本人 |
| `eval/golden/dedup.json` 的 30 組 | 30/30 `needs_human_confirm` | 開發者本人 |
| `eval/golden/pdf_sample/<sha256>.json` 的 `answer_form`／`final_answer` | `needs_human_confirm` | 開發者本人 |

### 階段 2 三份 golden 具體要看哪些欄位

**`classify.json`（90 筆）——只有 30 筆需要真的花時間。**
前 60 筆（`cls-fx-*`）的標籤直接沿用已定案的 fixture，有測試守著兩邊一致，**掃過即可**。
後 30 筆（`cls-dr-*`）是手寫改寫，要看的是：

| 欄位 | 要判斷什麼 |
|---|---|
| `chapter` | 改寫後的題幹是否還屬於這一章。其中 3 筆已在 `note` 標出爭議：<br>`cls-dr-018`（三維向量的點積 → 空間向量內積 or 外積）<br>`cls-dr-028`（自由落體 → 直線運動 or 平面運動）<br>`cls-dr-030`（等位面與電場線 → 電場與電位 or 靜電學） |
| `decoy_chapter` | 「模型最可能漂到的值」猜得準不準。18 筆有 decoy，其中 4 筆的 decoy 本身也在白名單內——那 4 筆 `isValidChapter` 擋不住，只有第二層 LLM 判得出來，是最有價值的案例 |

**`answer.json`（50 題）——要看的是 `expect` 兩欄，不是答案本身。**
答案多半改寫自已定案的 fixture；真正需要裁決的是「這種寫法應該判 agree 還是 uncertain」。
已在 `note` 標出的幾筆：

- `ans-004`：小寫 `(a)` 是否等同 `(A)`（第 4.2 條沒明講）
- `ans-013`／`ans-016`：`AC`、`AE` 這類無括號連寫抽不抽得出兩個代號（`ans-016` 的代號到 `(E)`）
- `ans-027`：`6.0 \times 10^{2}` 是否算 `600` 的等價形（科學記號）
- `ans-040`：容差邊界。`0.333333333333` 與 `1/3` 差約 3.3e-13 < 1e-9 → agree；要到 `0.333333333`（差 3.3e-10）才會 disagree。1e-9 這個值要不要調，請確認
- `ans-043`：`2.4e-4` 這種 e 記法支不支援
- `ans-045`／`ans-046`：`expression` 只比「去空白、去 `$`、去 `\left\right` 後的字串」，
  所以 `^{\circ}` 與 `^\circ`、`\theta = 45^\circ` 與 `45^\circ` 都算不同字串——
  要不要把 LaTeX 的等價寫法納入正規化
- **`extraction_hazard: true` 的 1 筆（`ans-047`）**：見 `docs/archive/questions2-wsD.md` Q3 與裁決 S2-12。
  抽取規則已改為「最後一個 `$…$`，含 `=`／`\approx` 取其後，純上下標片段跳過」，
  其餘各筆的 `expect` 都已改回 `agree`。

**`dedup.json`（30 組）——`expect_l0` 不必看，`expect_l1` 才要。**
16 組 `expect_l0: 'hit'` 已經對參考實作實測通過，且有單元測試守著（純函式，不需要模型）。
需要人看的是 14 組 `expect_l1`：7 組換數字標成 `variant`、7 組不同題標成 `unique`，
**實際餘弦要等向量 fixture 才量得到**；`DEDUP_DUP_THRESHOLD=0.97` 與
`DEDUP_VARIANT_THRESHOLD=0.90` 這兩個門檻是否合適，請看過數字再定案。
其中 3 組（`dd-df-01`～`03`）是「平面 vs 空間」的跨章字面相近題，
題幹幾乎同構只差一個維度——若被判 `duplicate`，就是閾值太鬆。

**`pdf_sample/<sha256>.json`——只有兩欄是 WS-D 判斷的。**
`subject`／`chapter`／`question_type`／`difficulty`／`question_text`／`answer_text`
全部直接沿用已定案的 fixture；`answer_form` 與 `final_answer` 是 WS-D 從 `answer_text`
挑出來的，只要看這 10 題的這兩欄。

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
  compare_pipeline.js       E-X12a：新舊對照（--method legacy|pipeline），不進 CI
  fixtures/
    questions.public.json   60 題自製 fixture
    embeddings.<model>.768.json   由 record_embeddings.js 產生
    sample_exam.pdf         自製樣卷（10 題），--suite pipeline 與 E-X12a 的輸入
    make_sample_pdf.js      樣卷產生器（只在本機跑）
  golden/
    retrieval.json          40 筆檢索 golden
    classify.json           90 筆分類 golden（60 fixture + 30 漂移變體）
    answer.json             50 題答案 golden（各 3 等價 + 2 錯答 = 250 案例）
    dedup.json              30 組重複判定 golden
    formula.json            公式 golden（**WS-C 產出**，走 node --test 不走本入口）
    pdf_sample/<sha256>.json  公開樣卷的答案卷
  lib/
    fixtures.js  golden.js       載入 + 硬閘門
    tokenize.js  embedText.js    轉接 WS-C 的凍結介面（未合入時 stub）
    embeddings.js                讀向量 fixture
    pooling.js                   LIKE 關鍵字規則（凍結）+ 候選池
    ranker.js                    記憶體排序器（LIKE 欄 + SQL 的對照組）
    pgEngine.js                  對真 PG 下 queries/hybrid.js
    metrics.js                   Recall@K / MRR / Jaccard / accuracy / macro-F1 / 混淆對 / percentile（純函式）
    report.js  thresholds.js     報表與門檻（thresholds 對三個 suite 通用）
    report2.js                   階段 2 兩個 suite 的報表
    golden2.js                   classify / answer / dedup 三份 golden 的載入與硬閘門
    pdfGolden.js  pdfMatch.js    答案卷載入、拆題結果與答案卷的配對
    suiteClassify.js  suitePipeline.js   兩個 suite 的主體
    pipelineDriver.js            eval 專用的管線推進器（不碰 DB、不寫檔）
    stateMachineShim.js          轉接 pipeline/stateMachine.js（WS-A）
    stage2Shims.js               轉接 normalizeStem / answerCompare / parseLatexStrict / pricing
    legacyAdapter.js             解析 --method legacy 的進入點與 prompt_hash
  tools/suggest_golden.js   產生 golden 建議稿
  tools/check_html.js       npm run check:html
  reports/                  報表輸出（.gitignore）
  private/                  私有層（.gitignore）
```

對應的測試在 `test/unit/metrics.test.js`、`evalPooling.test.js`、`evalFixtures.test.js`、
`evalRanker.test.js`，以及 `test/integration/schema.test.js`、`retrievalEval.test.js`。
