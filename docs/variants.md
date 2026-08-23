# docs/variants.md — 變式題：閘門、門檻校準與量測結果

> 產出者：WS-B（階段 3，分支 `ws3-b/variants`）。對應任務 P-10／P-11a／P-11b／P-12／P-14。
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
| 4 | **跑題** | `agents/generateVariant.js` | `cos(embed(變式), embed(藍本)) ≥ VARIANT_SIM_MIN` | `fail('off_topic')` |
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

---

## 3. `VARIANT_SIM_MIN` 的校準（P-11b）

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
| 0.80（`.env.example` 現值） | 1.0000 | 0.1226 | 0.9375 |
| 0.84 | 1.0000 | 0.0508 | 0.7102 |
| 0.88 | 1.0000 | 0.0146 | 0.3011 |
| 0.90 | 1.0000 | 0.0076 | 0.1023 |
| **0.92** | **1.0000** | **0.0064** | 0.0398 |
| 0.93 | 0.9500 | 0.0057 | 0.0114 |
| 0.94 | 0.9000 | 0.0032 | 0.0057 |

**結論：讓「同概念換數字」全過、又讓「跨章」幾乎全擋的值是 `0.92`。**
0.93 開始就會誤殺合格的數值變式（`#3`／`#4` 的 `exp-eq` 這一組餘弦 0.9298）。

0.92 之後殘留的跨章誤收（0.64%，4 對）全部是 **`向量內積` × `空間向量內積`**——
那是 fixture 刻意放進去的 `lookalike` 對照組（2D 與 3D 的內積），概念本來就幾乎相同，
不是門檻調得動的東西。

```
0.9685  #11 數學/向量內積 × #20 數學/空間向量內積
0.9615  #11 數學/向量內積 × #19 數學/空間向量內積
0.9461  #9  數學/向量內積 × #18 數學/空間向量內積
0.9440  #13 數學/向量內積 × #21 數學/空間向量內積（fixture 標為 lookalike）
```

### 3.3 一個變數兩個用途，最佳值不同（已寫進 `docs/questions3-wsB.md` 第 2 條）

`docs/interfaces-stage3.md` 第 9 條把 `VARIANT_SIM_MIN` 同時當成兩個東西：

1. **retrieved 分支的餘弦下限**——這是「相不相似到可以直接推薦」的門檻，**低一點比較好**
   （門檻越高，能直接推薦的題越少、越常要花錢生成）；
2. **生成後的跑題閾值**——這是「有沒有離題」的門檻，**高一點比較好**。

兩個方向相反。實測（下一節）：門檻從 0.80 拉到 0.92，`retrieved_coverage` 從
**0.8667 掉到 0.2000**——也就是說，把跑題閾值調到最佳值，會讓「純檢索就夠用」的比例
掉到五分之一，等於把七成本來免費的請求推去付費生成。

**本次實作照凍結介面走：兩處都讀同一個 `VARIANT_SIM_MIN`，預設 `0.80`。**
建議（待開發者裁決）拆成兩個變數：`VARIANT_RETRIEVE_SIM_MIN=0.80` 與
`VARIANT_OFFTOPIC_SIM_MIN=0.92`。在裁決之前，`0.80` 的實際效果是：
**檢索側很好用，跑題檢查形同虛設**（跨章的題有 12% 過得了 0.80）——
不過跑題不是唯一防線，離題的變式還會被 `classify` 的章節閘門與 `dedup1` 接著擋。

---

## 4. 量測結果（`--suite variant`）

環境：`LLM_MODE=replay`、`EMBED_MODE=fixture`、`VARIANT_SIM_MIN=0.80`、golden 30 藍本（尚未人工定案）。

| 指標 | 值 | 說明 |
|---|---:|---|
| `retrieved_coverage` | **0.8667** | 30 個藍本中有 26 個「純檢索就找得到 ≥ 2 題」 |
| `gate_pass_rate` | **n/a** | `eval/cassettes/variant/` 尚未錄製（見第 5 節）；**不用別的數字冒充** |
| 每題成本 | **n/a** | 同上 |

**每個藍本檢索到幾題**（門檻 0.80、鎖定同一難度、排除自己與整個家族）：

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

> ⚠️ 這個 0.8667 是**在 60 題的 fixture 上**量的，而 fixture 有 20 對刻意做出來的
> 「同概念換數字」。真實題庫的覆蓋率一定更低——這個數字的用途是「決定 3B 的優先度」
> 與「門檻換了會怎樣」的相對比較，不是對真實題庫的預測。

### 門檻對覆蓋率的影響（同一份 golden）

| `VARIANT_SIM_MIN` | 0.80 | 0.84 | 0.88 | 0.90 | 0.92 |
|---|---:|---:|---:|---:|---:|
| `retrieved_coverage` | 0.8667 | 0.5667 | 0.3000 | 0.2000 | 0.2000 |

---

## 5. 怎麼重跑、怎麼錄 cassette

### 5.1 重跑（不需要金鑰、不需要 DB）

```powershell
# 目前 eval/run.js 還沒接 --suite variant（那是 WS-D 的第 8.5 條），先直接呼叫 suite：
cd exam_pro
node --env-file=eval/.env.replay -e "require('./eval/lib/suiteVariant').runVariantSuite({}).then(r=>console.log(JSON.stringify(r.measured,null,2)))"

# 或跑單元測試（同一份數字，外加 golden 的硬閘門）
npm test -- test/unit/evalVariant.test.js
```

WS-D 接進 `eval/run.js` 之後就是 `npm run eval -- --suite variant`。

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

---

## 7. 已知缺口

1. **只改字閘門對「短題幹 + 換數字」有漏**：第 4.3 條的規則 2 要求「數字多重集合相同」，
   換成別的數字就不成立；規則 3 只看編輯距離比例，短題幹改四個數字就有 ~10% > `0.08`。
   實例：`設 $\vec{a}=(3,4)$、$\vec{b}=(1,2)$…` → `設 $\vec{a}=(6,8)$、$\vec{b}=(2,4)$…`
   會過。**不是沒有防線**（dedup1 的餘弦會極高 → `duplicate`），但文字閘門本身確實漏了它。
   建議見 `docs/questions3-wsB.md` 第 1 條。
2. **`gate_pass_rate` 尚未有數字**：需要一次真實錄製（第 5.2 節）。
3. **golden 尚未人工定案**：30 個藍本是機械挑的（fixture 的奇數 id，再換兩題讓「證明」與
   「多選」出現），`needs_human_confirm` 全部是 `true`，所以**現在不得 `--write-baseline`**。
4. **`--engine pg` 只是驗證用**：`retrieved_coverage` 的數字一律以 memory 引擎為準
   （兩邊算的是同一個餘弦）；那段 SQL 的正確性由 `test/integration/variants.pg.test.js`
   的 9 項條件斷言保證。
