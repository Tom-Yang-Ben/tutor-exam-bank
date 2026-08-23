# docs/questions3-wsB.md — WS-B（變式題與 kNN few-shot）的介面疑問

> 分支 `ws3-b/variants`。對應 `docs/interfaces-stage3.md` 第 3、4、5、8 條。
> 規矩（第 14 條第 7 點）：**發現介面有問題就停下來寫在這裡，不自行改介面繞過。**
> 下列每一條都**已照凍結介面實作**，這裡只記「照著做之後量到／看到什麼」，等開發者裁決。
>
> 分四類：
> **A. 需要裁決**（照做會有實際後果）｜**B. 落地時的選擇**（介面沒寫，我選了一個並說明理由）
> ｜**C. 知會其他 WS**（我動了共用檔）｜**D. 只是紀錄**。
>
> ## ✅ 全部結案（2026-08-24）
>
> 第一輪裁決 **S3-R8～R16** 已寫進 `docs/interfaces-stage3.md` §15，本檔每一條都已標上對應編號。
> A 類四條：**S3-R8／R9／R10 要改程式，已改完並重跑量測**；**S3-R11 接受現況**。
> B 類五條與 C 類全部**接受現況**（S3-R12～R16），程式不動。
> 本檔之後只當紀錄看，不再有待辦。

---

## A. 需要裁決

### 1. 只改字閘門（第 4.3 條）對「短題幹 + 換數字」有漏 —— **裁決：S3-R8（已改）**

**條文**：規則 2 是「數字多重集合相同**且**數字遮罩後文字相同 → `numbers_only`」，
規則 3 是「`edit_ratio < minEdit` → `too_close`」，並註明「『只換數字』的題會被規則 3 攔下
（正規化後的編輯距離極小）」。

**照做之後**：規則 3 攔得住的只有「題幹夠長、改的數字夠少」的情況。實測反例：

```
藍本：設 $\vec{a}=(3,4)$、$\vec{b}=(1,2)$，求兩向量的夾角餘弦值。
變式：設 $\vec{a}=(6,8)$、$\vec{b}=(2,4)$，求兩向量的夾角餘弦值。
→ 數字多重集合不同（規則 2 不成立），edit_ratio ≈ 0.10 > 0.08（規則 3 也不成立）→ **過關**
```

正規化後的題幹只有約 40 個字，換掉 4 個數字就是 10%。題幹越短、數字越多，漏得越明顯。

**如果規則 2 只要求「數字遮罩後文字相同」（拿掉「多重集合相同」這個 AND 條件）**，
上面這一題就會被判 `numbers_only`——而且不會誤傷任何合格變式（合格變式的敘述本來就改過，
遮罩後不會相同）。「數字對調」的情況仍然被同一條涵蓋。

**結果（S3-R8）**：規則 2 改成**只看「數字遮罩後文字相同」**，AND 條件拿掉，
`VARIANT_MIN_EDIT` 不動。已落地於 `utils/variantTextGate.js`；
`numberMultiset()` 與私有的 `arrayEqual()` 隨之刪除（沒有其他呼叫點）。

量到的效果（fixture 自己的 20 對「同概念換數字」，`docs/variants.md` 第 2.1 節）：
**攔截率 11/20 → 15/20**，補起來的四對編輯距離都過得了規則 3（0.0909～0.2439）；
仍放行的五對真的改了數字以外的東西（`2^{x+1}` → `3^{x-1}`、多一整段 `sin 45^circ` 說明），
**沒有合格變式被誤傷**。原本那項叫「已知缺口」的單測已改成正向斷言。

---

### 2. `VARIANT_SIM_MIN` 一個變數兩個用途，最佳值方向相反 —— **裁決：S3-R9（已改）**

**條文**（第 9 條）：`VARIANT_SIM_MIN = 0.80`，用途寫的是
「① `retrieved` 分支的餘弦下限；② 生成後的跑題閾值」。

**照做之後**（完整數據見 `docs/variants.md` 第 3 節）：

| 門檻 | 同概念換數字通過率 | 跨章誤收率 | `retrieved_coverage`（30 藍本） |
|---:|---:|---:|---:|
| **0.80（現值）** | 1.0000 | **0.1226** | **0.8667** |
| 0.92 | 1.0000 | 0.0064 | **0.2000** |

- 當**跑題閾值**用：0.80 太鬆——跨章的題有 12% 過得了，等於這一道幾乎不擋東西。
  讓「同概念換數字」全過、又擋得住跨章的值是 **0.92**（0.93 開始誤殺合格變式）。
- 當**檢索下限**用：0.80 好用——覆蓋率 0.8667；拉到 0.92 會掉到 0.2000，
  等於把七成本來免費的請求推去付費生成。

**結果（S3-R9）**：拆成兩個變數，各取自己那一側的最佳值：

- `VARIANT_RETRIEVE_SIM_MIN=0.80` → `services/variantService.js` 的 retrieved 分支；
- `VARIANT_OFFTOPIC_SIM_MIN=0.92` → `agents/generateVariant.js`，經
  `ctx.config.thresholds.variantOfftopicSimMin`（agent 不讀 `process.env`）；
- `workers/jobRunner.js` 的 `loadStage3Config()` 組出 `variantRetrieveSimMin`／`variantOfftopicSimMin`
  兩個鍵，**只有 offtopic 那個進 `ctx.config.thresholds`**——檢索下限是 service 層的事；
- 兩者都沒設時**退回舊名 `VARIANT_SIM_MIN`**，還沒更新 `.env` 的環境行為不變。

`retrieved_coverage` 維持 **0.8667**（檢索側門檻沒動），跑題那一道從「12% 跨章過得了」
收緊到 **0.64%**。

---

### 3. approve 的 `chapter_src` 與 saveNode 的對照表打架（第 4.7 vs 第 5.2 條）—— **裁決：S3-R10（已改）**

**條文**：

- 第 4.7 條的 `saveNode`：`chapter_src` 依 `payload.classify.source` —— `gate`/`llm` → `'ai'`、`knn` → `'knn'`。
- 第 4.7 條的**人工核准路徑**：變式題「送出的 `chapter` 與 `payload.classify.chapter` 相同時寫 `'ai'`，不同時寫 `'human'`」。
- 第 5.2 條卻寫「入庫時 `chapter_src` 依 `source`（**`saveNode` 與 approve 都照這張表**）」。

兩者在「章節沒被改過、而且 classify 是 kNN 短路決定的」這一格會給出不同答案：
第 4.7 條說寫 `'ai'`，第 5.2 條說寫 `'knn'`。

**結果（S3-R10）**：以**第 5.2 條**為準——approve 與 `saveNode` 查同一張表：

| 情況 | `chapter_src` |
|---|---|
| 章節**被改過** | `'human'`（唯一會產生投票權的路徑） |
| 章節沒改過，`source='gate'`／`'llm'` | `'ai'` |
| 章節沒改過，`source='knn'` | **`'knn'`** |

已落地於 `controllers/reviewController.js` 的 `variantChapterSrc()`；
`kind='pdf'` 的 approve 仍一律 `'human'`（第 6.6 條是契約，行為不變）。

---

### 4. kNN 短路的 `job_events.token_*` 做不到「一律 NULL」—— **裁決：S3-R11（維持現況）**

**條文**（第 5.2 條）：短路時的事件是
「`node='classify'`、`model=NULL`、`token_* = NULL`、`cost_usd = 0`、`outcome='pass'`、`detail.source='knn'`
——短路沒有花錢，報表要看得出來」。

**照做之後**：`model=NULL`、`cost_usd=0`、`outcome='pass'`、`detail.source='knn'` 都成立
（`detail.source` 是我在 `workers/jobRunner.js` 加的一個鍵，見 C-2）。
但 `token_in` **不會是 NULL**：A 層要先把題幹轉成向量才查得到最近鄰，那一次
`ctx.llm.embed()` 真的發生了，runner 的計量器（`meteredLlm.embed`）會把它的 `tokenIn` 記進來。

要讓它變成 NULL，只有兩條路，兩條我都沒走：

1. 改 `workers/jobRunner.js` 寫事件的條件（`meter.calls > 0` → `meter.model !== null`）。
   那會**同時改掉 PDF job 的 `dedup1` 事件**（它也是只呼叫 embed），違反「既有路徑逐位元不變」。
2. 讓 A 層在短路情境下不呼叫 embed——不可能，短路的判斷本身就需要那個向量。

**現況**：`token_in` 記的是那一次 embedding 的實際 token 數（通常是幾百），
`token_out`／`token_thinking`／`token_cached` 是 `null`，`cost_usd` 是 0。

我認為這比 NULL **更誠實**（那次呼叫確實發生了，只是幾乎不要錢），但它與條文字面不符，
所以寫在這裡。

**結果（S3-R11）**：維持現況，第 5.2 條的「`token_* = NULL`」改寫成「照實記」。
程式不動。

---

## B. 落地時的選擇（介面沒寫死，我選了一個）

### 5. `outcome.gate`：`text_gate` 與 `sim` 怎麼從 agent 交棒給 runner —— **裁決：S3-R12（接受）**

**條文**：第 4.2 條說 `outcome.data`「與 `payload.extract` 同形**再加兩個鍵**
（`variant_of_root`、`anchor_ids`）」；第 4.5 條說 `payload.variant` 裡要有
`text_gate` 與 `sim`，而且「只由 `generate` 節點寫」。

問題：`text_gate` 與 `sim` 只有 agent 算得出來，但依第 4.2 條它們**不能**放進 `data`
（那會變成第三、四個新鍵）。

**我的選擇**：`agents/generateVariant.js` 回 `{ kind:'pass', data:{…}, gate:{ text_gate, sim } }`，
runner 從 `outcome.gate` 取值組出 `payload.variant`。理由：`data` 的形狀是條文逐鍵列出來的，
動它風險比較大；`Outcome` 多一個 runner 才讀的鍵不影響 `transition()`
（`generate` 是 job 層節點，本來就不經狀態機）。

其餘四個欄位（`source_question_id`／`difficulty_delta`／`anchor_ids`／`attempt`）由 runner 自己填。

### 6. `ctx.config.models` 加第三個鍵 `variant` —— **裁決：S3-R13（接受）**

**條文**：第 9 條說「`MODEL_VARIANT` 未設時退回 `MODEL_VERIFY` 的解析在 `config/models.js`
**之外**做（WS-B 自己在 `variantService`／`generateVariant` 解析）」，但第 3.1 條又說
**agent 不得自己讀 `process.env`**。兩條合起來，退回這一步只能由 runner 做。

**我的選擇**：`config/models.js` 加一個 `MODEL_VARIANT` getter（沒設時回 `null`，
既有兩個 getter 與 `warnIfSameModel()` 一個字都沒動）；`workers/jobRunner.js` 的
`loadModels()` 組出 `{ extract, verify, variant: MODEL_VARIANT || MODEL_VERIFY }`；
`agents/generateVariant.js` 讀 `ctx.config.models.variant`，沒有就退 `.verify`。

### 7. `agents/generate.js` 這支三行轉接檔 —— **裁決：S3-R14（接受）**

節點名是 `generate`（第 4.1 條），檔名是 `agents/generateVariant.js`（第 10.1 條）。
runner 的 `loadAgent` 解析順序是 ①`agents/<node>.js` → ②`AGENT_MODULE_FOR_NODE`。

**我的選擇**：走第一順位，加一支三行的 `agents/generate.js`（與 `agents/dedup0.js`
／`dedup1.js` 完全同一個做法，裁決 S2-6）。這樣 `AGENT_MODULE_FOR_NODE` 一個鍵都不必動——
它的內容被 `test/unit/jobRunner.test.js`（WS-A 的檔，我不得修改）用 `deepEqual` 釘死了。

同理，階段 3 的五個新設定不放進 `loadConfig()`（它的回傳形狀也被 `deepEqual` 釘死），
改成另一支 `loadStage3Config()`，由 `createRunner()` 合併。行為完全相同。

### 8. `eval/lib/suiteVariant.js` 的 golden 載入器寫在同一支檔裡 —— **裁決：S3-R15（接受）**

第 10.1 條給 WS-B 的 eval 檔只有 `eval/lib/suiteVariant.js`、`eval/golden/variant.json`、
`eval/cassettes/variant/**`，`eval/**` 其餘歸 WS-D。所以我**沒有**另開
`eval/lib/goldenVariant.js`，把 golden 的硬閘門寫在 suite 檔內
（`loadVariantGolden` / `validateGoldenEntries`，兩支都有匯出）。
WS-D 若想把它搬去 `golden2.js` 旁邊，直接搬即可，我沒有其他呼叫點。

### 9. `--suite variant` 的檢索引擎預設是 memory —— **裁決：S3-R15（接受）**

`retrieved_coverage` 用 `eval/fixtures` 的向量在記憶體裡算餘弦（與 SQL 算的是同一件事），
不需要 PG。理由與 `eval/lib/ranker.js` 的 LIKE 欄一字不差：這一欄不該因為
「今天有沒有 PG」而變成兩個數字。那段真的 SQL 由
`test/integration/variants.pg.test.js` 的 9 項條件斷言逐條驗。

---

## C. 知會其他 WS（我動了共用檔）

### C-1. `controllers/reviewController.js`（WS-A 階段 2 的檔）—— 只加 variant 分支

第 4.7 條指定的改動，三處：

1. `approve` 的第一句 SQL 多 join 一次 `jobs` 取 `kind`（`FOR UPDATE OF q`，仍然只鎖 `job_questions`）；
2. `INSERT questions` 的 `origin`／`chapter_src` 從寫死字面值改成參數，並多寫一欄 `variant_of`；
3. 多一支純函式 `variantChapterSrc(payload, submitted)` 並匯出（給單元測試釘住裁決 S3-12）。

**`kind='pdf'` 的行為逐位元不變**（`origin='pdf'`、`chapter_src='human'`、`variant_of=NULL`），
`test/integration/variants.pg.test.js` 有一項就是釘這個的。既有的
`test/integration/jobs.pg.test.js` 全數仍綠。

### C-2. `workers/jobRunner.js`（WS-A 的檔）—— 只加分支

1. `tick()` 加**第二條**認領分支（`kind='variant'`），既有那條一個字沒動；
2. 新增 `runGenerateJob`／`runGenerateOne`／`insertVariantQuestion`（新函式，不碰既有的）；
3. `loadStage3Config()`（新函式）＋ `createRunner` 的設定合併多一個展開；
4. `invokeNode` 的 `ctx.config.thresholds` 多三個鍵、`ctx.job` 多兩個鍵（第 4.5 條明列的附加）；
5. `runJobQuestion` 的 SELECT 多撈 `j.kind, j.pdf_sha256`；`limits` 對變式 job 覆寫 `maxRetries.lint`；
   `node==='save' && kind==='variant' && !autoApprove` 時走第 4.7 條的政策停等；
6. `saveNode` 的三個欄位改由 `job.kind` 與 `payload.classify.source` 決定（見 C-3）；
7. `job_events.detail` 對 `node='classify'` 多一個 `source` 鍵（第 5.2 條要求「報表看得出來」）；
8. `failJob` 多一個選用參數 `node`（預設 `'extract'`，既有兩個呼叫點的行為不變）。

`pipeline/stateMachine.js` **一個字都沒改**。政策停等是整條管線唯一一處不經 `transition()`
的狀態變更（裁決 S3-11），`test/unit/variantPipeline.test.js` 有三項釘住
「這條路徑之後 `state` 仍是合法終態、`error_class` 是 NULL」。

### C-3. `saveNode` 的 `chapter_src` 對 **PDF job 也會變**（第 5.2 條要求的）—— **裁決：S3-R16（接受）**

第 5.2 條：「入庫時 `chapter_src` 依 `source`：`gate`→`'ai'`、`llm`→`'ai'`、`knn`→`'knn'`」，
沒有限定只有變式 job。所以 PDF job 的題**如果**被 kNN 短路分類，也會寫 `chapter_src='knn'`
而不是 `'ai'`。這是新行為（階段 2 一律寫 `'ai'`），但它正是第 5 條要的：
`'knn'` 這個值必須在庫裡看得出來，否則「kNN 標的」與「LLM 標的」就混在一起，
下一輪投票也分不清誰有投票權。短路不成立時（題庫初期一定不成立）行為與階段 2 完全相同。

### C-4. `agents/dedup.js`（WS-C 階段 2 的檔）—— 只加選用鍵 —— **裁決：S3-R16（接受）**

`runDedup1` 多吃一個選用鍵 `exclude_family_root`（裁決 S3-14）。給了才多接一段
`AND COALESCE(variant_of, id) <> $4`；**沒給時 SQL 字串與參數陣列與階段 2 逐位元相同**
（不是「加一個恆真的條件」——那會改變 SQL 文字）。`runDedup0` 一個字沒動。
`test/unit/variantPipeline.test.js` 有四項釘這個。

### C-5. `agents/classify.js` 的 A 層改了，但 cassette 全部有效

`FEW_SHOT_K` 由 5 改成 8、`chapter_src` 的 `IN` 多了 `'knn'`、多了兩個 `LEFT JOIN`。
`cacheKeyParts.fewShotIds` 的算法**沒改**，而且 eval 與錄製一律 `ctx.db = null`
（裁決 S2-8）→ `fewShotIds` 恆為 `[]`。改動後 `npm run eval:classify` 仍是
`accuracy 0.9000 / macro-F1 0.9256`，兩個門檻都過。

### C-6. 給 WS-D 的三件事

1. **`eval/run.js` 還沒有 `--suite variant`**（第 8.5 條是 WS-D 的工作）：
   `runVariantSuite(args)` 已按第 8.1 條的形狀匯出，`args` 只用到 `--golden` 與 `--engine`。
   另外 `eval/lib/thresholds.js` 的 `SUITE_METRICS` 要加
   `variant: { columns:['variant'], metrics:['retrieved_coverage','gate_pass_rate'] }`，
   否則 `compareSuite`／`writeBaselineSuite` 會丟「未知的 suite」。
2. **`--write-baseline` 目前必須擋下來**：golden 30 筆全部還是 `needs_human_confirm`。
   `run.js` 現有的 stub guard 只認得 classify／pipeline，麻煩比照加一條
   （`res.meta.goldenPending > 0` 就拒絕），我在 suite 的 `warnings` 有留同樣的字串。
3. **`package.json` 的 `scripts`**：需要 `"eval:variant": "npm run eval -- --suite variant"`。
   我沒有動 `scripts`（第 10.1 條：由 WS-D 統一）。

### C-7. 新環境變數

**沒有新增**。第 9 條列的九個變數（`MODEL_VARIANT`、`VARIANT_MAX_PER_REQUEST`、
`VARIANT_SIM_MIN`、`VARIANT_MIN_EDIT`、`VARIANT_LINT_RETRIES`、`VARIANT_TOKEN_BUDGET_USD`、
`VARIANT_AUTO_APPROVE`、`KNN_VOTE_SIM`、`FEATURE_VARIANTS`）S0 已寫進 `.env.example`，
全部照原名原預設讀。

⚠️ 但 `exam_pro/.env`（開發者本機那一份，不在版控內）**沒有這九個變數**，
所以本機跑起來時全部吃程式裡的預設值。`FEATURE_VARIANTS` 預設 `false`
→ **`POST /api/questions/:id/variants` 這條路由現在不會掛載**。要試用請自行加：

```
FEATURE_VARIANTS=true
VARIANT_AUTO_APPROVE=false
```

---

## D. 只是紀錄

### D-1. 變式 job 的 `jobs.state` 沿用 `'extracting'`

第 4.1 條的認領分支寫的是 `kind='variant' AND state IN ('queued','extracting')`，
所以「generate 節點正在跑」這個階段用的是既有的 `'extracting'`。
DDL 的 `jobs.state` CHECK 因此不必動——只是 `'extracting'` 這個名字對變式 job 有點名不符實。

### D-2. `retrieved` 分支的 `SET LOCAL hnsw.ef_search = 100`

第 3.1 條沒寫要不要調召回深度。我照 `/similar` 加了（同一個值、同樣在交易內）。
理由：本端點的候選條件收得比 `/similar` 更緊（鎖定單一難度、排除整個家族、排除該生寫過的），
HNSW 預設的召回深度更容易漏掉合格的題。

### D-3. `test/fixtures/fakeVariantAgents/`

`test/integration/variants.pg.test.js` 專用的 `agentsDir`。只有 `generate.js` 是實作，
其餘四支 `require` 過去 `../fakeAgents/` 的同名檔——變式 job 與 PDF job 走同一條管線，
假 agent 也不該有第二份。**WS-A 的 `test/fixtures/fakeAgents/` 一個字都沒改。**
