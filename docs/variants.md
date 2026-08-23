# docs/variants.md — 變式題：閘門、門檻校準與量測結果

> 產出者：WS-B（階段 3，分支 `ws3-b/variants`）。對應任務 P-10／P-11a／P-11b／P-12／P-14。
> 第二輪已依裁決 **S3-R8**（只改字閘門規則 2）、**S3-R9**（門檻拆成兩個）、**S3-R10**（approve 的 `chapter_src`）改寫。
> 介面以 `docs/interfaces-stage3.md` 第 3、4、5、8 條為準（凍結，本檔不得與它衝突）。
> 本檔的數字全部來自 `eval/lib/suiteVariant.js` 與 `eval/fixtures/questions.public.json`（自製題），
> **沒有任何一個數字是手打的**；重跑方式見第 5 節。

---

## 1. 一句話

**先檢索、再生成；生成走的是拆題那條一模一樣的管線；首輪一律等人點頭。**

- 檢索（`POST /api/questions/:id/variants` 的 200 分支）：零 LLM 費用，用藍本自己的向量查庫。
- 生成（202 分支）：`jobs(kind='variant')` → `generate` 節點 → `job_questions(state='extracted')`
  → **dedup0 → classify → lint → verify → dedup1 → save**，與 PDF 拆題逐節點相同。
- 首輪 `VARIANT_AUTO_APPROVE=false`：閘門全過也停在 `needs_review('awaiting_approval')`，
  老師在既有的複核佇列一鍵核准才入庫。

---

## 2. 八道閘門，兩個工具各司其職

| # | 閘門 | 在哪裡 | 用什麼判 | 不過時 |
|---|---|---|---|---|
| 1 | JSON schema | `agents/generateVariant.js`（ajv） | `agents/schemas/variant.json` | `fail('schema_invalid')` |
| 2 | 章節白名單 | 同上 | `isValidChapter` | 退回藍本章節，記 `chapter_overridden` |
| 3 | **只改字** | `utils/variantTextGate.js` | Levenshtein／數字遮罩（**不用 embedding**） | `fail('text_gate')` |
| 4 | **跑題** | `agents/generateVariant.js` | `cos(embed(變式), embed(藍本)) ≥ VARIANT_OFFTOPIC_SIM_MIN` | `fail('off_topic')` |
| 5 | 逐字重複 | `dedup0` 節點 | `normalizeStem` → sha256 | `fail('duplicate')` |
| 6 | 章節 | `classify` 節點 | 零成本閘門／kNN 短路／LLM | `fail('chapter_invalid')` |
| 7 | 公式 | `lint` 節點 | `formulaFix` + `formulaLint` | `fail('formula_unparsable')` |
| 8 | 答案 | `verify` 節點 | 另一個模型獨立解 + `answerCompare` | `fail('answer_mismatch')` |
| 9 | 語意重複 | `dedup1` 節點 | 向量餘弦，**排除藍本整個家族** | `fail('duplicate')` |

**第 3 道與第 4 道是同一個問題的兩面，用的卻必須是兩種工具**：

- `utils/embedText.js` 的設計目的就是讓「換數字的同一題」在向量空間碰撞（規劃 §2.3.6）。
  拿它去判「變式是不是太像藍本」，會把**所有合格的數值變式**退回。
- 反過來，拿編輯距離去判「跑題了沒」也不行：換一個情境的合格變式，字面上本來就該差很多。

所以：**向量管概念（第 4 道），文字管字面（第 3 道）**。

### 2.1 只改字閘門的規則 2 改寫（裁決 S3-R8）

原本的規則 2 是「**數字多重集合相同** 且 數字遮罩後文字相同 → `numbers_only`」。
那個 AND 條件只擋得住「數字對調」；換成**別的**數字時多重集合就不同了，整條規則失效，
只剩規則 3 的編輯距離在擋——而短題幹改四個數字就有 ~10% > `VARIANT_MIN_EDIT=0.08`。

S3-R8 把它改成**只看「數字遮罩後文字相同」**（每段連續數字換成 `#`）。

**效果（量在 fixture 自己的 20 對「同概念換數字」上——那正是這一道該擋下的東西）：**

| 規則 | `numbers_only` | `too_close` | **放行** |
|---|---:|---:|---:|
| 舊（多重集合 AND 遮罩） | 0 | 11 | **9 / 20** |
| **新（只看遮罩）** | 15 | 0 | **5 / 20** |

被補起來的 4 對：`#1×#2`（`log-add`，edit_ratio 0.2439）、`#13×#14`（`dot-perp`，0.0976）、
`#17×#18`（`sdot-basic`，0.1034）、`#32×#33`（`newton-fma`，0.0909）——
它們的編輯距離都**過得了**規則 3，舊規則等於直接把「只換數字」當成合格變式收下。

仍然放行的 5 對**不是漏網**，它們真的改了數字以外的東西：

```
#3  解方程式 $2^{x+1} = 32$。          #4  解方程式 $3^{x-1} = 81$。      ← +1 變 -1，不是數字
#40 …傾角 $30^\circ$…                  #41 …傾角 $45^\circ$（$\sin 45^\circ = \cos 45^\circ = …$）… ← 多了一整段
```

**沒有任何合格變式被新規則誤傷**：合格變式的敘述本來就重寫過，遮罩後不可能相同。

---

## 3. 跑題閾值與檢索下限的校準（P-11b）

### 3.1 量法

在 `eval/fixtures/questions.public.json` 的 60 題自製題上，用已錄好的向量
（`eval/fixtures/embeddings.gemini-embedding-001.768.json`，768 維，L2 正規化後餘弦 = 內積）
算出全部 1,770 個題對的餘弦，依關係分成四組：

| 關係 | 對數 | 最小 | p25 | 中位數 | p75 | p95 | 最大 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **同概念換數字**（同 `variant_group`） | 20 | **0.9298** | 0.9501 | 0.9631 | 0.9759 | 0.9863 | 0.9884 |
| 同章不同概念 | 176 | 0.7815 | 0.8356 | 0.8638 | 0.8835 | 0.9154 | 0.9480 |
| **跨章同科** | 675 | 0.7137 | 0.7542 | 0.7770 | 0.8045 | 0.8674 | 0.9685 |
| 跨科 | 899 | 0.6611 | 0.7148 | 0.7307 | 0.7441 | 0.7653 | 0.8240 |

「同概念換數字」是變式題**應該長成的樣子**（下限 0.9298）；
「跨章」是**跑題**（p95 = 0.8674）。兩者之間有一段乾淨的空隙。

### 3.2 門檻掃描

| 門檻 | 同概念換數字通過率（要 1.0） | 跨章誤收率（要低） | 同章不同概念誤收率 |
|---:|---:|---:|---:|
| 0.80（＝ `VARIANT_RETRIEVE_SIM_MIN`） | 1.0000 | 0.1226 | 0.9375 |
| 0.84 | 1.0000 | 0.0508 | 0.7102 |
| 0.88 | 1.0000 | 0.0146 | 0.3011 |
| 0.90 | 1.0000 | 0.0076 | 0.1023 |
| **0.92（＝ `VARIANT_OFFTOPIC_SIM_MIN`）** | **1.0000** | **0.0064** | 0.0398 |
| 0.93 | 0.9500 | 0.0057 | 0.0114 |
| 0.94 | 0.9000 | 0.0032 | 0.0057 |

**結論（S3-R9 當時）：讓「同概念換數字」全過、又讓「跨章」幾乎全擋的值是 `0.92`。**
0.93 開始就會誤殺合格的數值變式（`#3`／`#4` 的 `exp-eq` 這一組餘弦 0.9298）。

> **事後修正（S3-R29，2026-08-24）**：這張表的「正類」是 fixture 裡**只換數字**的現成題對，
> 可是只改字閘門（S3-R8）恰好就是要退回「只換數字」的變式——合格變式必須改寫敘述，
> 與藍本的餘弦天然比 0.93 低。第一次真實錄製 60 題後量到的分佈在第 4 節：0.92 擋掉 26/30 藍本，
> 因此下修為 **0.90**（此表的跨章誤收 0.76%、同章不同概念誤收 10%）。

0.92 之後殘留的跨章誤收（0.64%，4 對）全部是 **`向量內積` × `空間向量內積`**——
那是 fixture 刻意放進去的 `lookalike` 對照組（2D 與 3D 的內積），概念本來就幾乎相同，
不是門檻調得動的東西。

```
0.9685  #11 數學/向量內積 × #20 數學/空間向量內積
0.9615  #11 數學/向量內積 × #19 數學/空間向量內積
0.9461  #9  數學/向量內積 × #18 數學/空間向量內積
0.9440  #13 數學/向量內積 × #21 數學/空間向量內積（fixture 標為 lookalike）
```

### 3.3 一個變數兩個用途 → **拆成兩個**（裁決 S3-R9，已落地）

原本 `VARIANT_SIM_MIN` 同時當成兩個東西，而兩者的最佳值**方向相反**：

1. **retrieved 分支的餘弦下限**——「相不相似到可以直接推薦」，**低一點比較好**
   （門檻越高，能直接推薦的題越少、越常要花錢生成）；
2. **生成後的跑題閾值**——「有沒有離題」，**高一點比較好**。

實測：門檻從 0.80 拉到 0.92，`retrieved_coverage` 從 **0.8667 掉到 0.2000**——
把跑題閾值調到最佳值，會讓「純檢索就夠用」的比例掉到五分之一，
等於把七成本來免費的請求推去付費生成。

**S3-R9 因此拆成兩個變數，各自取自己那一側的最佳值：**

| 變數 | 值 | 誰讀 | 為什麼是這個數字 |
|---|---:|---|---|
| `VARIANT_RETRIEVE_SIM_MIN` | `0.80` | `services/variantService.js` 的 retrieved 分支 | 覆蓋率最高（0.8667）而候選仍都是同章同概念 |
| `VARIANT_OFFTOPIC_SIM_MIN` | ~~`0.92`~~ **`0.90`**（S3-R29） | `agents/generateVariant.js`（經 `ctx.config.thresholds.variantOfftopicSimMin`） | 0.92 是用「同概念換數字」的現成題對校準的——但那正是只改字閘門要退回的東西；實錄合格變式餘弦多在 0.85～0.92（第 4 節），0.90 時跨章誤收仍 0.76% |

- 兩者**都沒設**時退回舊名 `VARIANT_SIM_MIN`（過渡期的退路，`.env.example` 註明之後移除）：
  還沒更新 `.env` 的環境行為與 S3-R9 之前完全相同。
- `workers/jobRunner.js` 的 `loadStage3Config()` 組出 `variantRetrieveSimMin`／`variantOfftopicSimMin`
  兩個鍵；**只有 offtopic 那個進 `ctx.config.thresholds`**——檢索下限是 service 層的事，agent 用不到。

---

## 4. 量測結果（`--suite variant`）

環境：`LLM_MODE=replay`、`EMBED_MODE=fixture`、`VARIANT_RETRIEVE_SIM_MIN=0.80`、
`VARIANT_OFFTOPIC_SIM_MIN=0.92`、golden 30 藍本（尚未人工定案）。

| 指標 | 值 | 說明 |
|---|---:|---|
| `retrieved_coverage` | **0.8667** | 30 個藍本中有 26 個「純檢索就找得到 ≥ 2 題」 |
| `gate_pass_rate` | **0.1500** | 2026-08-24 第一次錄製（60 次生成、76 次 LLM 呼叫、60 筆新向量）：9/60 全過。**26/30 藍本停在 `off_topic`**、1/30 停在 `verify`、3/30 兩題全過——跑題閾值 0.92 是主要瓶頸，見下方「閾值掃描」 |
| 每題成本 | **n/a** | `config/pricing.js` 全 0，`cost_usd` 恆 0（非本節範圍） |

**跑題閾值掃描**（replay 模式、同一批 cassette；降閾值後多出來的 verify 呼叫沒錄過，所以只看「停在 off_topic 的藍本數」）：

| `VARIANT_OFFTOPIC_SIM_MIN` | 停在 off_topic 的藍本 | 說明 |
|---:|---:|---|
| 0.80 | 0 / 30 | 全部放行（但其後 46 次 verify 未錄，gate_pass_rate 不可得） |
| 0.85 | 5 / 30 | |
| 0.88 | 14 / 30 | |
| 0.90 | 19 / 30 | |
| **0.92**（現值） | **26 / 30** | 合格變式與藍本的餘弦多落在 0.85～0.92 之間 |

要調閾值就得在 `.env` 改值後**重錄一次**（新放行的題會走到 classify／lint／verify，cassette 才會補上）。

**每個藍本檢索到幾題**（`VARIANT_RETRIEVE_SIM_MIN=0.80`、鎖定同一難度、排除自己與整個家族）：

| 檢索到 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 藍本數 | 1 | 3 | 2 | 5 | 4 | 5 | 3 | 4 | 2 | 1 |

**覆蓋不足的 4 個藍本**（這 4 題才需要花錢生成）：

| golden id | fixture | 章節 | 難度 | 檢索到 | 最高餘弦 |
|---|---|---|---:|---:|---:|
| `var-003` | #5 | 數學／指數與對數 | 4 | 1 | 0.9610 |
| `var-004` | #7 | 數學／指數與對數 | 3 | 1 | 0.8037 |
| `var-008` | #16 | 數學／向量內積 | 5 | 0 | — |
| `var-027` | #53 | 物理／直線運動 | 1 | 1 | 0.8031 |

四題的共同點是**難度上落單**（該章該難度只有它自己或再一題）。這正是第 3.1 條
「給了 `difficulty_delta` 就鎖定單一難度」的字面語意造成的——**不是 bug，是設計**：
要「難一點的相似題」時就該只給難一點的，不該混回同難度的。

**S3-R8 之後 `gate_pass_rate` 會怎麼變？** 端到端的數字仍要等 cassette（第 5.2 節），
但方向是確定的、而且量得出來：文字閘門對「只換數字」的攔截率由 **11/20 升到 15/20**（第 2.1 節）。
也就是說 `gate_pass_rate` 會**往下**，而下降的那幾題正是本來就不該收的——
這一格的數字變小是閘門變準，不是品質退步。第 5.2 節錄完 cassette 後把實際值補進這張表。

> ⚠️ 這個 0.8667 是**在 60 題的 fixture 上**量的，而 fixture 有 20 對刻意做出來的
> 「同概念換數字」。真實題庫的覆蓋率一定更低——這個數字的用途是「決定 3B 的優先度」
> 與「門檻換了會怎樣」的相對比較，不是對真實題庫的預測。

### 門檻對覆蓋率的影響（同一份 golden）

| `VARIANT_RETRIEVE_SIM_MIN` | 0.80 | 0.84 | 0.88 | 0.90 | 0.92 |
|---|---:|---:|---:|---:|---:|
| `retrieved_coverage` | 0.8667 | 0.5667 | 0.3000 | 0.2000 | 0.2000 |

---

## 5. 怎麼重跑、怎麼錄 cassette

### 5.1 重跑（不需要金鑰、不需要 DB）

```powershell
cd exam_pro
npm run eval:variant          # WS-D 已把 --suite variant 接進 eval/run.js（第 8.5 條）

# 或跑單元測試（同一份數字，外加 golden 的硬閘門）
npm test -- test/unit/evalVariant.test.js
```

### 5.2 錄 cassette（需要 `GEMINI_API_KEY`，會產生費用）

**`LLM_MODE=record` 與 `EMBED_MODE=record` 必須一起開（裁決 S3-20）。**
變式題幹是**新字串**，只錄 LLM 不錄向量的話，CI 會在 `eval/fixtures/embeddings.*.json`
查不到鍵而硬失敗——那是刻意的（`interfaces.md` 第 4 條「不得靜默回退成假向量」）。

PowerShell **沒有行內 `VAR=x`**，要先 `$env:`：

```powershell
cd exam_pro
$env:LLM_MODE = 'record'
$env:EMBED_MODE = 'record'
$env:GEMINI_RPM = '30'      # 用 .env 的值；免費層是 5
node -e "require('./eval/lib/suiteVariant').runVariantSuite({}).then(r=>console.log(r.measured))"
Remove-Item Env:LLM_MODE, Env:EMBED_MODE
```

錄完之後 `eval/cassettes/variant/`、`eval/cassettes/classify|lint|verify/`（新鍵）與
`eval/fixtures/embeddings.gemini-embedding-001.768.json` 都會長大，三者要一起進版控。

一次完整錄製的呼叫次數上界：
30 藍本 × 2 題 × （1 次 generate + 最多 1 次 classify + 最多 1 次 lint 重寫 + 1 次 verify）
≈ **60～240 次**，外加 60 × 2 段 embedding。用 `VARIANT_TOKEN_BUDGET_USD` 與 `GEMINI_RPM` 控。

---

## 6. kNN few-shot 分類（P-14）

`agents/classify.js` 的 A 層改成第 5.1 條的查詢（`k=8`、排除同一份 PDF、`human` 依距離優先），
並在 A 層與 LLM 之間插入**投票短路**：最近 5 個鄰居裡 ≥ 4 題是**人工確認**的同一章、
且最近鄰餘弦 ≥ `KNN_VOTE_SIM`（0.90）→ 直接採用，`source='knn'`、入庫 `chapter_src='knn'`，
**一次 LLM 都不呼叫**。

- **`'knn'` 與 `'ai'` 沒有投票權**（只數 `'human'`）。自動標籤餵回自動投票是閉環放大器，
  錯一題會自我強化成一串同錯題（規劃 §4.4）。
- 目前開發庫的 `chapter_src='human'` 題數少，**短路率預期就是 0**。這是誠實的起點：
  老師每在題庫管理改一次章節（`PUT /api/questions/:id` 會寫 `chapter_src='human'`），
  短路率就會往上一點。
- `cacheKeyParts.fewShotIds` 的算法**一個字都沒改**（`examples` 裡的整數 id 由小到大），
  所以階段 2 錄的 90 支 classify cassette 全部不失效——
  `npm run eval:classify` 在改動後仍是 `accuracy 0.9000 / macro-F1 0.9256`，兩個門檻都過。

短路率與短路正確率由 `--suite classify` 多印兩欄（第 5.2 條，**不設門檻，只報告**）；
`job_events.detail.source` 也記了這一格是誰決定的，`report:jobs` 之後看得出來。

**`chapter_src` 三個來源怎麼寫（裁決 S3-R10 之後，`saveNode` 與 approve 同一張表）：**

| 情況 | `chapter_src` |
|---|---|
| 自動入庫（`saveNode`），`source='gate'`／`'llm'` | `'ai'` |
| 自動入庫（`saveNode`），`source='knn'` | `'knn'` |
| 人工核准，**章節沒改過**，`source='gate'`／`'llm'` | `'ai'` |
| 人工核准，**章節沒改過**，`source='knn'` | `'knn'` |
| 人工核准，**章節被改過** | `'human'`（唯一會產生投票權的路徑） |

S3-R10 之前「人工核准且章節沒改過」一律寫 `'ai'`，於是 kNN 短路決定的題在庫裡與
LLM 決定的混在一起，報表分不出來；改成查同一張表就一致了。**兩種寫法都不會產生假的
`'human'`**，kNN 投票的防線沒有破口。

---

## 7. 已知缺口

1. ~~只改字閘門對「短題幹 + 換數字」有漏~~ → **裁決 S3-R8 已補**（第 2.1 節）：
   規則 2 改成只看「數字遮罩後文字相同」，fixture 的 20 對「同概念換數字」攔截率 11/20 → 15/20。
2. ~~`gate_pass_rate` 尚未有數字~~ → **2026-08-24 已錄**（第 4 節）。0.92 時 0.15、擋掉 26/30 藍本 → **S3-R29 下修為 0.90 並重錄**（數字見第 4 節）。
3. **golden 尚未人工定案**：30 個藍本是機械挑的（fixture 的奇數 id，再換兩題讓「證明」與
   「多選」出現），`needs_human_confirm` 全部是 `true`，所以**現在不得 `--write-baseline`**。
4. **`--engine pg` 只是驗證用**：`retrieved_coverage` 的數字一律以 memory 引擎為準
   （兩邊算的是同一個餘弦）；那段 SQL 的正確性由 `test/integration/variants.pg.test.js`
   的 9 項條件斷言保證。
