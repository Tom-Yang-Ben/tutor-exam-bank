# docs/chemistry.md — 化學整條鏈路（卷別分流）

> 版本 v1.0 | 2026-09-24 | 分支 `stage5/ws-b` | 對應：`docs/interfaces-stage5.md` 第 3.2、3.3、4.2 條、ADR-010、DEC-019、缺口 G01
> 本檔是化學支援的功能文件：API、資料、排版子集、答案比對、eval 與給老師的操作說明。共用文件（api_spec、openapi、db_design、srs、各 tracker）由整合階段依本檔回填（第 1.7 條）。
> 章節表（`exam_pro/config/chemistryChapters.js`，44 章）是 ~~**AI 草擬、待 Owner 對照教科書定稿**~~ 〔修訂 2026-09-26 決策單 A11〕**Owner 2026-09-25 定稿**（決策單：照目前草案定稿，依龍騰；章名一字未改）；本檔所有例句、golden 與別名同樣是 AI 自撰，不取自任何出版社教材或考卷（這些仍是 AI 草擬，待 Owner 抽查）。
> 〔修訂 2026-09-26〕〔Owner 決策單 2026-09-25 B5〕NLQ 的 LLM 輔路徑與助教改為支援化學（原裁決 S5-13 維持不支援）：`nlq.v1` → `nlq.v2`、`assistant.v1` → `assistant.v2`，兩者的 cassette 需重錄。見第 7、9、10、11 節。

## 1. 一句話

上傳考卷時選「卷別」：**數學／物理**沿用凍結的 prompt、schema 與 cassette，一個字都不動；**化學**走另一組 agent 名、模板與 schema。化學題入庫之後，題庫、相似題、變式、NLQ、組卷、批改、弱點面板與 Word 匯出都能用。取捨見 [ADR-010](../engineering_docs/03_architecture/adr/ADR-010-subject-group-routing-for-chemistry.md)。

## 2. API 與資料

### 2.1 `POST /api/jobs`（multipart）

| 欄位 | 說明 |
| :--- | :--- |
| `pdf` | 不變 |
| `source_type`、`source_detail` | 不變 |
| `subject_group` | **新增**。`math_physics`（預設；沒帶或空字串也是它）或 `chemistry`。其他值回 `400 { "message": "subject_group 只能是 math_physics 或 chemistry。" }`，不建 job、不寫檔 |

- 冪等鍵由 `pdf_sha256` 改為 `(pdf_sha256, subject_group)`：同一份 PDF、同一卷別重傳仍回既有 job（`existing: true`）；**換卷別重傳會建新 job**——老師選錯卷別時不必動 `?force=1`。既有流程不帶這個欄位，兩次都是 `math_physics`，行為不變。
- 回應形狀不變：`202 { job_id, existing }`。

### 2.2 `GET /api/jobs/:id`

回應多一個鍵 `subject_group`（附加在最後，既有欄位與順序不變）。

### 2.3 資料表（`migrations/0011`，base 已建；WS-B 沒有新 migration）

| 表.欄 | 寫入 | 說明 |
| :--- | :--- | :--- |
| `questions.subject` | 管線 save、手動新增、複核 approve | CHECK 自 0011 起接受「化學」 |
| `jobs.subject_group` | `POST /api/jobs`（上傳）；`services/variantService.createVariantJob`（變式：化學藍本 → `chemistry`，其餘 → `math_physics`） | 預設 `math_physics` |

### 2.4 其他端點的變化（沒有新端點）

- `GET /api/chapter-whitelist`、`GET /api/chapter-volumes`：多出「化學」與六冊 44 章（資料來自 `config/chapters.js` 的 `VOLUMES`）。
- 所有以 `isValidSubject`／`SUBJECTS` 驗證科目的端點（題目 CRUD、批次入庫、複核 approve、弱點面板 `?subject=`、組卷、助教工具）現在接受「化學」。科目錯誤的訊息改由 `SUBJECTS` 產生：`學科僅能為「數學」、「物理」或「化學」！`（兩科時與原字串逐字相同）。

## 3. 化學排版（mhchem 子集）

網頁端：`public/index.html` 的 MathJax 設定明確載入 mhchem（`loader.load: ['[tex]/mhchem']`、`tex.packages: {'[+]': ['mhchem']}`）。
Word 端：`utils/chemFormula.js` 的 `ceToLatex` 先把 `\ce{…}` 轉成等價的一般 LaTeX（`\mathrm` 化學式、下標、上標電荷、箭頭），再交給 `utils/textFormatter.js` 既有的遞迴下降解析器轉成 OMML。Word 端因此沒有第二個解析器，`utils/formulaLint.js` 也不需要另開規則：解析器認得的寫法自然不發 `unknown_command`。

| 記法 | 例 | 轉成的 LaTeX | Word（OMML） |
| :--- | :--- | :--- | :--- |
| 下標 | `\ce{H2SO4}` | `\mathrm{H_{2}SO_{4}}` | `m:sSub`，正體 |
| 離子電荷 | `\ce{SO4^{2-}}`、`\ce{SO4^2-}`、`\ce{Na+}` | `\mathrm{SO_{4}^{2-}}` | `m:sSubSup`／`m:sSup` |
| 係數 | `\ce{2H2O}`、`\ce{1/2O2}`、`\ce{0.5O2}` | `2\mathrm{H_{2}O}`、`\frac{1}{2}\mathrm{O_{2}}` | 係數在 `\mathrm` 外 |
| 箭頭 | `->`、`<-`、`<=>`、`<->` | `\rightarrow`、`\leftarrow`、`\rightleftharpoons`、`\leftrightarrow` | `→ ← ⇌ ↔` |
| 箭頭條件 | `\ce{A ->[\Delta][加熱] B}` | `\xrightarrow[\text{加熱}]{\Delta}` | 上方 `m:groupChr`（箭頭在下、基線對齊），下方再包 `m:limLow` |
| 物態 | `(s)`、`(l)`、`(g)`、`(aq)` | `\mathrm{(aq)}` | 正體 |
| 氣體／沉澱 | `\ce{CO2 ^}`、`\ce{AgCl v}`（前後留空白） | `\uparrow`、`\downarrow` | `↑ ↓` |
| 水合物 | `\ce{CuSO4.5H2O}`、`\ce{CuSO4*5H2O}` | `\mathrm{CuSO_{4}}\cdot 5\mathrm{H_{2}O}` | `·` |
| 括號、錯離子 | `\ce{Ca(OH)2}`、`\ce{[Cu(NH3)4]^{2+}}` | 下標接在右括號 | |
| 同位素 | `\ce{^{14}_{6}C}` | `\prescript{14}{6}{\mathrm{C}}` | `m:sPre`（依 ECMA-376 順序 sub、sup、e；沒用 docx 的 `MathPreSubSuperScript`，它把 e 放在最前面） |

在 `\ce` 之外也支援：`\rightleftharpoons`、`\xrightarrow{上}`、`\xrightarrow[下]{上}`、`\xleftarrow`、`\uparrow`、`\downarrow`（以及 `\longrightarrow` 等幾個箭頭）。

`\mathrm{…}` 在 OMML 一律輸出正體（每個 `m:r` 補 `<m:rPr><m:sty m:val="p"/></m:rPr>`）。這是**所有科目**的行為改變：數學／物理題裡的 `\mathrm{m/s}` 單位從此也是正體（排版規範本來就該如此）。`\text{…}` 維持原樣。凍結的對照語料（`test/unit/textFormatterStrict.test.js`）沒有 `\mathrm`，逐位元對照仍全數通過。

**限制**（刻意不做，遇到時不丟例外，照字面包進 `\mathrm` 印出）：

- 電荷前面的數字：`\ce{Fe3+}` 依 mhchem 的讀法是 Fe₃⁺（下標 3、電荷 +），要寫 `\ce{Fe^{3+}}`。化學模板已要求模型一律用 `^{…}`。
- mhchem 的 `\pu{…}`（單位）、鍵結符號的精細排版（`-`、`=`、`#` 只照字面輸出）、`\bond{}`、上下並列的反應條件以外的版面。
- 新增的箭頭符號放在 `EXTRA_SYMBOLS`，**沒有**併進 `SYMBOLS`：`SYMBOLS` 同時給 `utils/embedText.js` 用，併進去會讓含 `\uparrow` 的既有題目 embed_text 改變、向量被判過期。

原卷比對（`agents/source_check.js`）：化學題先以 `ceToComparable` 把 `\ce{…}` 換成純文字（箭頭、`^`、`v` 拿掉，電荷的 `+ -` 保留），否則反應箭頭的 `-` 會被「負號比原卷多」規則當成抄錯。數學／物理題不經過這一步。

## 4. 管線：卷別分流

### 4.1 誰走哪一條

`agents/promptParts.js` 的 `resolveSubjectGroup(ctx, input)` 是唯一判準，依序：

1. `input.subject` 是合法科目 → 由科目決定（化學 → `chemistry`；數學、物理 → `math_physics`）。科目比卷別精準：化學題的變式不必另外標卷別。
2. `ctx.jq.payload.extract.subject`（lint、verify、source_check 的 input 沒有科目）。
3. `ctx.job.subject_group`（extract 只有這一個訊號；`workers/jobRunner.js` 把 `jobs.subject_group` 帶進 `ctx.job`）。
4. 都沒有 → `math_physics`（既有呼叫端，含 `services/aiService.js` 的舊流程）。

### 4.2 各節點

| 節點 | 數學／物理（逐字不變） | 化學（新） | 化學路徑的差別 |
| :--- | :--- | :--- | :--- |
| extract | `extract`／`extract.v2` | `extract_chem`／`extract_chem.v1` | SYSTEM、模板（化學式規範、結構式與實驗裝置寫進 figure_desc、週期表不是題目）、schema 值域（subject＝化學、chapter＝44 章） |
| classify | `classify`／`classify.v2`（〔CR-9〕2026-09-26 起，原 v1；化學不受影響） | `classify_chem`／`classify_chem.v1` | SYSTEM、模板、schema；閘門、kNN 投票、few-shot 取材與 cacheKeyParts 共用 |
| lint | `lint`／`lint.v2` | `lint_chem`／`lint_chem.v1` | 只有第三層（LLM 重寫）換模板——數學版會叫模型「改寫掉不支援的指令」，會把 `\ce` 拆掉 |
| source_check | —（零成本） | — | 題幹先過 `ceToComparable` |
| verify | `verify`／`verify.v1` | `verify_chem`／`verify_chem.v1` | SYSTEM 要求數值帶單位、化學式用 `$\ce{…}$`；比對時帶 `subject: '化學'` |
| generate（變式） | `variant`／`variant.v1` | `variant_chem`／`variant_chem.v1` | SYSTEM、模板（換物質與數據、反應式要平衡）、schema；兩道閘門共用 |
| dedup0／dedup1／save | 共用 | 共用 | 無（〔最終審查修正 S5-44〕dedup0 的庫內比對多一個例外，數理與化學共用：命中的題**已封存**、而且是**同一份 PDF（pdf_sha256 相同）、另一個卷別**的任務拆出來的，不算重複——那是選錯卷別後封存錯科題、換卷別重傳的更正，見第 10 節第 2 點） |

- 化學模板的註冊字串 = SYSTEM + `'\n---\n'` + 模板（第 1.2 條），SYSTEM 一改 cassette 鍵就變。既有模板的「SYSTEM 不在鍵內」缺口照契約只記錄、不修。
- `buildSchema(name)` 行為不變（同一個快取鍵、同一個凍結實例、同一個 schemaHash）；`buildSchema(name, { group: 'chemistry' })` 給化學值域，快取鍵 `name@chemistry`；未知 group 丟錯。
- 化學章節白名單在 prompt 裡每章加「」：「醇、酚、醚」本身含頓號，直接以頓號串接會被看成三章。數學與物理沒有這種章名，輸出不變。

### 4.3 設定檔（第 3.2 條）

- `config/chapters.js`：`VOLUMES['化學'] = CHEMISTRY_VOLUMES`（排在物理之後）。新增 `LEGACY_SUBJECTS`、`LEGACY_CHAPTERS`（66 章，順序逐字相同）、`SUBJECT_GROUPS`、`SUBJECT_GROUP_KEYS`、`isValidSubjectGroup`、`normalizeSubjectGroup`、`subjectGroupOf`、`subjectChoiceText`。
- 會進既有 LLM 呼叫的文字一律讀 `LEGACY_*`：`agents/schemas` 的 `ENUM_SOURCES`、`chapterWhitelistText()`（沒指定科目時）、`services/nlqService.chapterWhitelistText()`。
  〔Owner 決策單 2026-09-25 B5〕例外：`services/nlqService.chapterWhitelistText()` 改列三科（`SUBJECTS`），`ENUM_SOURCES` 多了兩個**新鍵** `subject_all`／`chapter_all`（三科的科目與章節，只有 `nlq.json` 用）；`subject`／`chapter` 兩個鍵的值域不變，所以 extract／classify／verify／lint／variant 的 schema 與 cassette 不受影響。
- `config/chapterExamples.js`：化學 44 章各一句自撰例句（10–80 字，化學式用 `$\ce{…}$`）。只進化學題的 classify prompt。
- `config/chapterAliases.js`：化學 44 章各 3–6 個別名（莫耳、平衡常數、Ksp、pH、勒沙特列、赫斯、氧化數、電解、酯化…），通過第 6.2 條三條硬規則。為了不改變數學／物理查詢的解析，**不收**會與數理別名互為子字串的詞（「標準還原電位」含「電位」、「電子排列」含「排列」、「碰撞學說」含「碰撞」），也不收「平衡」「反應」「電荷」這類泛詞。
- `utils/tokenize.js`：自訂詞典補化學名詞（`CHEMISTRY_TERMS`；原本的數理詞表改名 `MATH_PHYSICS_TERMS`、內容一字未動，合併後的詞典與先前相同）；化學章節名經既有的 `expandChapterWords` 自動進詞典。
- **併入後既有題目的 `search_tsv` 必須重建**（`npm run search:reindex`，見下方）。`search_tsv` 是寫入當下切好存進 DB 的，查詢端每次用當下的詞典切；新詞會改變部分既有數理題幹的切法，例如「質量數為 238」由「質量／數為」變成「質量數」，「理想氣體」「週期表」「反應速率」由兩個詞變成一個詞（後三個同時來自化學章節名，只刪詞典項目也擋不住）。不重建的話，新的查詢「質量數」對不上舊題，hybrid 的關鍵字側就查不到這些題。eval fixture 語料、golden 查詢與分詞測試字串（353 段）剛好沒有這些詞，重切逐字相同，所以 CI 看不出來——先前本節寫「不必重建」是只對 fixture 驗證的錯誤結論，已更正。
- `scripts/reindex_search_tsv.js`（`npm run search:reindex -- [--dry-run] [--limit N] [--test]`）：以目前的詞典重算**全部**題目（含已封存）的 `search_tsv`，只寫回有變的題、每批一個交易，印出會變／已寫回的題數與前 5 題的詞位差異。**不呼叫 LLM、不需金鑰、不動 embedding**（`backfill_embeddings.js` 只在 `embed_hash` 變了才重寫 `search_tsv`，分詞改了 `embed_hash` 不會變，而且它會打 embedding API）。token 由 `embedService.buildTsvTokens()` 產生；SQL 與題目 API 寫入端（POST 的 INSERT、PUT 的 `SEARCH_TSV_ASSIGN`）逐字等價，由 `test/integration/searchReindex.pg.test.js` 釘住。之後只要再改詞典或章節名，都要再跑一次。

### 4.4 驗證「數學／物理一個字都沒動」的方法

- 單元測試：`agentExtract.test.js` 釘住 66 章與 enum 內容；`chemistryAgents.test.js` 逐 agent 斷言數學／物理的請求（agent 名、模板、SYSTEM、schema 實例、prompt）與原本相同；`chemistryConfig.test.js` 斷言 `buildSchema(name)` 與 `buildSchema(name, {group:'math_physics'})` 是同一個實例。
- 開發期另以 base 版與修改版逐一比對 extract／classify／lint／verify／variant／nlq／assistant 的 SYSTEM、模板原文、實際 prompt、六支 schema 與模板雜湊，全部相同；NLQ 對 golden 與測試字串 388 句的規則解析逐字相同。
  〔Owner 決策單 2026-09-25 B5〕之後 nlq 與 assistant 依 Owner 決策改版（`nlq.v2`、`assistant.v2`，第 7 節），上面的「逐字相同」只對 extract／classify／lint／verify／variant 仍成立。
- CI 五個 eval 在不重錄任何 cassette 的情況下全綠，量到的數字與 base 相同。

## 5. 答案比對（`utils/answerCompare.js`、`utils/units.js`）

### 5.1 單位（修「5 cm 對 5 m 判 agree」）

- **只在兩邊都有「認得的」單位時介入**：因次不同 → `disagree`；因次相同 → 換算到 SI 再比（0.5 m 對 50 cm、0.25 M 對 0.25 mol/L、27 °C 對 300.15 K 都是 agree）。
- 溫度：℃ 對 K 時，高中慣用的 0 ℃ = 273 K 與精確值 273.15 **兩種都認**（`utils/units.js` 的 `conversionVariants`）：25 ℃ 對 298 K、27 ℃ 對 300 K 都是 agree，25 ℃ 對 299 K 仍是 disagree。兩邊同是 ℃ 或同是 K 時沒有位移，照原本的數值容差（25 ℃ 對 25.15 ℃ 是 disagree）。
- 度的符號寫在單位巨集前面（`27^{\circ}\mathrm{C}`、`27\,^\circ\text{C}`）讀成攝氏；先前只取 `\mathrm{C}`，會讀成庫侖、對上「27 °C」判 disagree。
- 答案後面單一個大寫字母、緊接中文（「$2$ A 點」「C 處」「N 極」）是點名，不讀成單位（安培、庫侖、牛頓）；後面是標點或結尾（「$2$ A。」）才當單位。讀不到單位時照原規則只比數值。
- 任何一邊沒有單位、或單位不在 `utils/units.js` 的表裡（「位數」「個」「度」）→ 照原規則只比數值。`eval/golden/answer.json` 的 250 個既有案例結果全部不變。
- claimed 的單位常寫在 `$…$` 外面（`…＝ 25$ m。`）：先看抽出來的答案本身，沒有再讀該段 `$…$` 後面緊接的文字（`locateFinalAnswer` 的 `end`；抽取規則 S2-12 一個字都沒改）。
- claimed 整段就是「數值＋單位」（`5 cm`，沒有 `$` 也沒有等號）時，只有模型答案也帶認得的單位才把整段當答案；其餘維持原本的 uncertain。
- 等價寫法：`\mathrm{cm}`、`\text{ cm}`、`cm`、`公分` 視為同一個；指數寫法 `m/s^2`、`m/s²`、`\mathrm{m/s^2}` 相同。
- **text 例外（待裁決）**：`answer_form = text` 時單位衝突只回 `uncertain`（裁決 S2-26「text 永遠不回 disagree」凍結）。契約第 4.2 條第 4 點的「不得判 agree」三種 answer_form 都做到；「應判 disagree」只有 number 與 expression 做到。兩條凍結規則在 text 上互相衝突，請整合階段記一條裁決（S5-n）決定是否維持，見第 12 節。

### 5.2 化學式與反應式

- 介入條件（最重要的取捨）：任何一邊寫了 `\ce{…}`；或 `subject === '化學'`（只有 `verify_chem` 會傳）且 answer_form 不是 number／option。**數學題絕不走這條**——「BC」（線段）剛好也是合法化學式（碳化硼）。
- 物種：正規化式與係數相同 → agree；元素組成相同但寫法不同（CH₃COOH 對 C₂H₄O₂）→ uncertain；否則 disagree。三種寫法（`\ce{H2SO4}`、`H_2SO_4`、`H₂SO₄`）正規化成同一個式子，電荷寫在前或後（`3+`／`+3`）都認。
- 反應式：兩側「物種→係數」都相同 → agree（順序與物態不影響）；左右對調或整條乘一個倍數 → uncertain；否則 disagree。一邊反應式、一邊單一物種 → uncertain。
- 任何一邊解析不出化學式 → 不介入，照原本的 answer_form 規則比。
- 新案例：`exam_pro/eval/golden/answer_chem.json`（18 筆 × 5 = 90 個案例，單位 9 筆、化學式 9 筆），`test/unit/answerCompareChem.test.js` 硬斷言。

## 6. 化學 eval（不在 CI 清單內）

- golden：`exam_pro/eval/golden/classify_chem.json`，24 筆自撰題（六冊各 3–5 筆），`needs_human_confirm` 全部為 true，待 Owner 逐筆定案。
- 指令：`npm run eval:classify-chem`（`exam_pro/eval/classify_chem.js`）。量第二層 LLM 分類（輸入的 chapter_confidence 一律 0、chapter 給 decoy，強迫走 LLM），輸出 accuracy、macro-F1、各冊正確率、混淆對，報表寫到 `eval/reports/classify-chem-<日期>-<sha>.json`。
- 沒有 cassette（`eval/cassettes/classify_chem/` 不存在或是空的）→ 印出「尚未錄製，略過」並 exit 0；cassette 不完整 → 報 replay miss、分數 n/a、exit 0；`--min-accuracy 0.8` 有給才當門檻。
- **錄製**（要真的 Gemini 金鑰、會花錢；約 24 次 `MODEL_EXTRACT` 呼叫）：

```bash
cd exam_pro
# .env 裡要有 GEMINI_API_KEY；MODEL_EXTRACT 與 CI 相同（gemini:gemini-3.5-flash）
LLM_MODE=record node --env-file=.env eval/classify_chem.js
# 之後就是純回放（不花錢）：
npm run eval:classify-chem
# 覺得分數站得住腳，再決定要不要加 --min-accuracy 或併入 CI（需另開裁決）
```

- 錄好的 cassette 在 `eval/cassettes/classify_chem/`，只存請求摘要（字數＋sha256），不存題目全文（NOTICE 第 4 條）。`test/unit/evalClassifyChem.test.js` 以同一支 `cassetteKey` 寫假 cassette 驗證「錄完就能回放」，避免錄完才發現鍵對不上。
- 化學卷的 extract／verify／lint／變式目前**沒有** cassette，也沒有 eval；要量時比照上面的方式另錄（建議先用自製的化學樣卷，勿用有版權的考卷）。

## 7. NLQ（自然語言查題）與助教

- 規則路徑辨識化學章節本名與別名：「緩衝溶液的計算題，難度 3 以上」「Ksp 跟勒沙特列的題目」都在規則層抓到章節，`subject` 由章節反推為化學，**不呼叫 LLM**。
- **LLM 輔路徑支援化學**〔Owner 決策單 2026-09-25 B5〕（原裁決 S5-13：`nlq.v1` 的 prompt 與 schema 凍結為數學／物理兩科、本階段不支援；Owner 改判支援，接受改模板並重錄）。模板 `nlq.v1` → `nlq.v2`：
  - 白名單（`chapterWhitelistText()`）列三科，一科一行。化學那一行每章加「」（沿用 `agents/promptParts.js` 的 `joinChapters`：「醇、酚、醚」本身含頓號）；數學、物理兩行與 `nlq.v1` 逐字相同。
  - schema（`agents/schemas/nlq.json`）的 `subject`、`chapters` 改讀新的 enum 來源 `subject_all`／`chapter_all`：三科、數學→物理→化學依序攤平的全部章節（2026-09-26 為 52＋34＋44＝130 章）。說明文字補「化學章名輸出時不要帶「」」。
  - SYSTEM 改為「數學、物理與化學」；模板規則 1 補「化學章名輸出時不要帶「」」、規則 2 補「同一個詞（濃度、速率、平衡、能量）可能出現在不同學科，要看整句在問哪一科」。
  - 註冊字串改為 SYSTEM + `'\n---\n'` + 模板（階段 5 第 1.2 條的慣例）：之後 SYSTEM 一改，cassette 鍵就變。識別名、模板雜湊、schemaHash、`cacheKeyParts.template` 都變了，`nlq.v1` 的 cassette 一支都不會再被讀到。
  - 本機（Ollama）與 Gemini 走同一段程式；Ollama 看不到 schema 的說明文字，`services/llm/ollama.js` 會把欄位說明附在 system 後面，科目 enum（三個）會逐一列出。
- 規則沒抓到章節時（第 6.3 條），化學句子**不再跳過 LLM**，與數理句子一樣交給 LLM 挑章節。規則層原本的「只查化學」判斷改當**退路**（`utils/nlqHeuristics.js` 的 `chemistrySubjectPrior`）：
  - 推定成立：`isChemistryOnlyQuery`（有化學線索 `CHEMISTRY_HINTS`、沒有任何數理線索），或 `namesChemistry`（句子點名「化學」——「化學能」不算——而且沒點名數學／物理）。後者是新的：「化學 溶液的密度怎麼算」有數理名詞「密度」，原本推定不成立，點名化學之後成立。
  - 用途：LLM 失敗（逾時、replay miss、schema 不合），或 LLM 科目與合法章節都沒給 → 再驗之後的 `subject` 補成化學。LLM 給了科目或合法章節就以 LLM 為準。化學句子因此至少維持改判前的檢索範圍（只查化學），不會退成三科全查。
  - 數理句子（點名數學／物理、數理複合詞「化學能」「核反應」「衰減」、數理名詞且沒點名化學）推定不成立，行為與改判前相同：「物理 濃度梯度造成的擴散」「數學的溶液混合濃度應用題」走 LLM，LLM 空手或失敗時 `subject` 為 null。
  - LLM 給的章節一律再驗（第 6.4 條）：打錯的章名（「化學平衡」）、跨科的章名（化學配「向量內積」）丟掉那一個並附警告。
  - **本機模式的代價**：`NLQ_TIMEOUT_MS` 預設 4000，本機模型通常在逾時內回不來。規則沒抓到章節的化學句子因此也會等 4 秒、附「LLM 解析逾時」警告（`fallback_level` 1），`subject` 由推定補成化學；改判前這類句子零延遲、沒有警告。要真的用上 LLM 輔路徑，照 `docs/local-mode.md` 第 10.3 節把 `NLQ_TIMEOUT_MS` 調大。
- `subject` 全空時的檢索改成三科各跑一次（原本兩科）。
- 已知限制：「碰撞學說」會被物理別名「碰撞」吃掉、「原子結構」會對到物理的「原子結構與光譜」——要查化學的這兩章請打完整章名（「碰撞學說與催化」「原子結構與週期表」）或用其他別名（催化劑、活化能、週期表、原子序）。這是規則層的別名衝突，LLM 輔路徑不會介入（規則抓到章節就不呼叫 LLM）。

### 7.1 助教（`services/assistantService.js`）〔Owner 決策單 2026-09-25 B5〕

- 工具說明書（SYSTEM 的一部分）的科目選項改由 `SUBJECTS` 產生：`get_student_weakness`、`preview_paper` 的 `subject` 寫成「數學|物理|化學」（原本寫死「數學|物理」，主控模型不知道可以查化學）。SYSTEM 多一句「題庫涵蓋數學、物理、化學共 3 科；subject 只能填這幾個科目名，chapter 要與該科章節白名單完全相同」；`search_questions` 的說明寫明三科都查得到，並多一個化學例句（「緩衝溶液的計算題」）。
- `preview_paper` 的章節改在執行前驗白名單（`isValidChapter(subject, chapter)`）。原本只檢查非空：錯的章名一路送進選題，撈不到題，回「新題目庫存不足…僅剩 0 題」，主控會以為真的沒題。現在錯誤訊息給候選，主控下一步自己修正：
  - 別名對到本科章節：「勒沙特列」→「可能是：「勒沙特列原理」」；
  - 本科章名與輸入互為子字串：「pH」→「酸鹼解離與pH值」、化學科的「碰撞」→「碰撞學說與催化」；
  - 章名屬於別科：化學科配「向量內積」→「是數學的章節，subject 要填「數學」」。
  - 三科一視同仁：數學／物理的錯章名從此也在驗證階段擋下（回應形狀相同：`{ ok:false, result:{ error:'參數不合法：…' } }`）。
- 模板 `assistant.v1` → `assistant.v2`。`assistant.v1` 從來沒有註冊原文，cassette 鍵裡的模板雜湊只是識別名的雜湊，SYSTEM（說明書）改了鍵也不變——不升版的話，舊 cassette 會被當成新說明書的回應讀出來。`assistant.v2` 註冊 SYSTEM + `'\n---\n'` + `PROMPT_TEMPLATE`（`buildPrompt` 的骨架，字樣抽成 `PROMPT_PARTS`，送出的 prompt 與改版前逐字相同）。`DECISION_SCHEMA` 不變。
- 助教的 `search_questions` 工具呼叫的就是 NLQ（上一節），化學查詢的行為與 NLQ 端點相同。

## 8. 前端

- 上傳區多一個「卷別」下拉（`#pdf_subject_group`：數學／物理｜化學）。新版管線（`FEATURE_PIPELINE`，`public/js/review.js`）把它當 `subject_group` 送出；**舊版單次拆題（`/api/analyze-pdf`）選化學會直接提示**「化學卷需要新版拆題管線」，不送出。
- 科目下拉不再寫死：`index.html` 的三個科目選單（手動新增、組卷、題庫管理）、題目編輯器與題庫管理的章節分組依 `/api/chapter-volumes` 重建；學生分頁（`public/js/students.js`）依 `/api/chapter-whitelist`；NLQ 回寫下拉在不分科時列全部科目（`public/js/nlq.js`）。
- 所有改動都是最小掛鉤並註記〔stage5 WS-B〕。

## 9. 刻意不支援／已知缺口

| 項目 | 狀態 | 理由 |
| :--- | :--- | :--- |
| 舊版單呼叫拆題 `services/aiService.js`（`/api/analyze-pdf`） | ~~維持原狀，只拆數學／物理~~ 〔修訂 2026-09-26 合併回填 B21〕仍只拆數學／物理；Owner 決策單 2026-09-25 B21 保留這條舊流程並補上附圖裁切（已合入 `local/integration` `7dc14a0`，重用管線的 `figureService`，見 `docs/figures.md`），化學範圍不變 | 契約要求不動；前端選化學時直接擋下並提示改用新版管線（B21 沒有改這一點） |
| NLQ 的 LLM 輔路徑 | 〔Owner 決策單 2026-09-25 B5〕已支援化學（`nlq.v2`） | 見第 7 節；原本（裁決 S5-13）不支援。`nlq.v2` 的 cassette 需重錄 |
| 助教（`services/assistantService.js`） | 〔Owner 決策單 2026-09-25 B5〕工具說明書與驗證都接受化學（`assistant.v2`） | 見第 7.1 節；原本說明書仍寫「數學\|物理」（裁決 S5-13）。`preview_paper` 的章節改驗白名單 |
| embedding 文本（`utils/embedText.js`） | 未改 | `\ce{H2O}` 會轉成「ce H2O」這類字樣；改規則會讓全部向量作廢（該檔檔頭警告） |
| 化學的 extract／verify／變式 cassette 與 eval | 尚未錄製 | 需要真 LLM；見第 6 節 |
| 章節表、例句、別名、golden | AI 草擬（〔修訂 2026-09-26 決策單 A11〕章節表已由 Owner 2026-09-25 定稿） | 待 Owner 對照教科書定稿；章名一改，知識點代碼與已標註資料要跟著遷移。〔修訂 2026-09-26 決策單〕章節表照草案定稿、依龍騰（A11）；例句、別名、golden 仍待 Owner 抽查；別名優先維持（B17）；`classify_chem.json` 的 eval 只當參考（B13） |

## 10. 給老師的操作說明

1. **上傳化學卷**：題庫頁「AI 批量解析考卷」→ 選 PDF →「卷別」選「化學」→ 啟動。需要新版管線（`.env` 的 `FEATURE_PIPELINE=true`）；舊版會跳出提示。
2. **選錯卷別**（卷別下拉預設是「數學／物理」，上傳化學卷前記得切換）：〔最終審查修正 S5-44〕
   1. 先處理舊任務：還在複核頁的題按「不採用」；**已經自動入庫、被歸到錯誤科目的題**到題庫管理逐題「刪除」——這些題被匯入任務引用、刪不掉，系統會問要不要改成封存，選封存。
   2. 換對卷別，再上傳同一份 PDF，系統會建新任務（同卷別重傳會接回原任務，不重複付費）。
   3. 新任務裡與舊任務**已封存**的題題幹相同的題，不會被當成重複，照常入庫。
   - 如果先重傳、後封存：新任務裡這些題會停在複核頁、標「重複」。把舊的錯科題封存之後，到複核頁逐題「核准」就能入庫（核准只擋與**在庫**題重複的題幹）。
   - 舊的錯科題沒封存之前，新任務的同一題一定判重複——題庫同一時間只允許一題在庫（text_hash 唯一索引）。
3. **化學式怎麼寫**（手動新增或在複核頁修改時）：一律寫成 `$\ce{…}$`。
   - 下標直接寫數字：`$\ce{H2SO4}$`；離子電荷用 `^{}`：`$\ce{Fe^{3+}}$`、`$\ce{SO4^{2-}}$`（**不要**寫 `Fe3+`，會變成 Fe₃⁺）。
   - 反應式：`$\ce{2H2 + O2 -> 2H2O}$`，可逆用 `<=>`，條件寫 `->[催化劑][加熱]`；氣體 ` ^`、沉澱 ` v`（前後空一格）；結晶水 `$\ce{CuSO4.5H2O}$`。
   - 單位用 `\mathrm`：`$0.10\ \mathrm{M}$`。網頁預覽與 Word 匯出都會排成正體。
4. **查化學題**：題庫管理、組卷、弱點面板的科目下拉都有「化學」。自然語言查題用章名或常用簡稱（莫耳、Ksp、pH、勒沙特列、赫斯定律、氧化數、電解、酯化…）最快、最準，不必等 AI。句子裡沒有章名時，系統會請 AI 判斷是哪一章（三科都懂）；AI 判斷不出來或逾時，句子裡寫了「化學」（或只有化學的字眼，例如溶液、酸鹼、沉澱）就只查化學。句子裡寫了「物理」「數學」時，系統會照數理的方式解析。本機模式下 AI 通常來不及回應（預設只等 4 秒），畫面會出現「LLM 解析逾時」的提示，這是正常的。
   - 助教也能查化學：例如「某某化學哪一章最弱」「用自然語言找緩衝溶液的計算題」「幫某某預覽勒沙特列原理 5 題」（把「某某」換成學生姓名）。章名打得不完整時，系統會把可能的正確章名告訴助教，助教通常會自己改正後再查。
5. **驗答結果**：驗證模型的答案與拆題答案的單位不同（5 cm 對 5 m）或化學式不同，會停在複核頁標「答案不一致」；只是寫法不同（CH₃COOH 對 C₂H₄O₂）會標「比不出來」，請人工確認。攝氏換克耳文用 273 或 273.15 都算一致（25 ℃ 對 298 K 不會被標不一致）。
6. **升級後跑一次關鍵字索引重建**（只要一次，之後改章節表或詞典時再跑）：在 `exam_pro` 資料夾執行 `npm run search:reindex -- --dry-run` 看會變幾題，確認後再執行 `npm run search:reindex`。不花錢、不呼叫 AI、可以中斷重跑。沒跑的話，部分舊的數理題（例如題幹有「質量數」「理想氣體」的）用關鍵字查會查不到。

## 11. 測試

| 檔案 | 內容 |
| :--- | :--- |
| `test/unit/chemistryConfig.test.js` | 白名單三科、LEGACY_*、SUBJECT_GROUPS、buildSchema 卷別、promptParts、別名／例句／分詞、NLQ 規則路徑、點名數理或帶數理名詞的句子照舊走 LLM、subject_group 解析、助教工具與題目驗證訊息。〔Owner 決策單 2026-09-25 B5〕「化學句子不走 LLM」與「送 LLM 的白名單只列兩科」三個測試依改判更新（化學句子走 LLM、LLM 空手或失敗時 subject 仍是化學；白名單與 schema 三科），修改處有註記 |
| `test/unit/chemAssistantNlq.test.js` | 〔Owner 決策單 2026-09-25 B5〕NLQ 化學的規則解析（別名＋題型＋難度＋沒寫過）、`namesChemistry`／`chemistrySubjectPrior`、`nlq.v2` 的註冊字串與請求（agent、template、schema、prompt、cacheKeyParts）、schema 三科值域且其他 schema 不變、LLM 給的化學章節被採用、非法章名（打錯、跨科）仍被擋、化學推定只當退路、數理句子不受影響、cassetteAudit 的 `chapter_all` 注入；助教說明書的科目、`preview_paper` 的章節驗證與候選、主控迴圈把錯誤餵回、`assistant.v2` 的註冊字串與 `buildPrompt` 骨架 |
| `test/unit/chemistryAgents.test.js` | 五個 agent 的化學路徑（agent 名、模板、SYSTEM、schema）、化學模板註冊字串、數學／物理請求不變、source_check 的箭頭 |
| `test/unit/chemFormula.test.js` | mhchem 子集每一種記法、ceToComparable、化學答案解析 |
| `test/unit/textFormatterChem.test.js` | 每一種記法打包成 .docx 後的 OMML、`\mathrm` 正體、parseLatexStrict 無事件、formulaLint 放行 |
| `test/unit/answerCompareChem.test.js` | `answer_chem.json` 90 個案例、單位與化學式的介入邊界（含 ℃／K 的 273 慣例、`^{\circ}\mathrm{C}`、「A 點」不是安培）、`utils/units.js` |
| `test/unit/reindexSearchTsv.test.js`、`test/integration/searchReindex.pg.test.js` | `search:reindex` 的參數；舊詞典切的 `search_tsv` 查不到新 token、dry-run 不寫、重算後查得到、重跑 0 題、已封存與 NULL 也補、`--limit`；與 POST／PUT `/api/questions` 寫入的值逐字相同 |
| `test/unit/evalClassifyChem.test.js` | classify_chem golden 硬閘門、沒有 cassette 略過、假 cassette 完整回放 accuracy 1、不完整回放 n/a |
| `test/integration/chemistry.pg.test.js` | `POST /api/jobs` 的 subject_group（400、預設、冪等鍵）、化學卷走完真的 agents 入庫、verify 的單位與化學式比對、題庫列表與手動新增、NLQ、組卷→批改→弱點、Word 匯出、化學變式。〔Owner 決策單 2026-09-25 B5〕NLQ 的 LLM 輔路徑挑化學章節後檢索落在化學題、助教 `preview_paper` 預覽化學章節（不寫庫）與非法章名 |
| 既有測試的修改（〔stage5 WS-B〕註記） | 「化學被拒」改用「生物」（agentClassify、agentGenerateVariant、students.pg）並補正向斷言；agentExtract 的 subject enum 改對 LEGACY_SUBJECTS 並逐字釘死 `['數學','物理']`；nlqAliases 的 66 章改為「66＋44」且 66 章逐章釘住；nlqService 的「兩科各跑一次」改為「每科各跑一次」；tokenize 的「每章切得出長詞」對「醇、酚、醚」改為「三個單字各自成 token」 |

## 12. 給整合階段

- API：`POST /api/jobs` 的 `subject_group`、`GET /api/jobs/:id` 的 `subject_group`（api_spec、openapi 回填）。
- 資料：`jobs.subject_group` 的寫入者包含 `variantService.createVariantJob`；冪等鍵改為 `(pdf_sha256, subject_group)`（db_design 的說明回填）。
- 需求：FR 編號由整合階段分配；DEC-019 的業務驗收項目＝章節表定稿、`eval:classify-chem` 錄製與分數。
- 預期衝突：`workers/jobRunner.js`（WS-A 在 save 寫詳解、WS-C 在 save 後掛鉤；WS-B 只動三個 `ctx.job` 與兩句 SELECT）、`public/js/students.js`（WS-B 只換了科目下拉那四行）、`index.html` inline script、`package.json` scripts（WS-B 新增 `eval:classify-chem`、`search:reindex`）、`controllers/questionController.js` 與 `utils/questionValidation.js`（不在 WS-B 的可擴充清單內；WS-B 各只改一行錯誤訊息，改成由 `subjectChoiceText()` 產生科目清單，無功能改動——請在 WS-A 之後合併、保留 WS-A 的版本再套這一行）。
- **合併後的 Owner 動作**：在正式題庫跑一次 `npm run search:reindex`（先 `--dry-run`），理由見第 4.3 節。沒跑不會壞資料，但部分舊的數理題關鍵字檢索會查不到；共用文件（HANDOFF、README 的升級步驟）回填時請一併寫入。
- **待裁決（建議記為 S5-n）**：`answer_form = text` 的單位衝突回 `uncertain`（依 S2-26），與契約第 4.2 條第 4 點「應判 disagree」不一致（見第 5.1 節）。WS-B 維持 S2-26，因為改成 disagree 會打破「text 永遠不回 disagree」的凍結取捨；若裁決要改，只動 `compareText` 的一行，`answer_chem.json` 的 unit-007 期望要一起改。〔修訂 2026-09-26 決策單 B4〕已記為 S5-11；Owner 2026-09-25 決策單選「維持送複核」，`compareText` 與 unit-007 不改。
- 化學跨 WS 行為（化學題標知識點、補救卷、AI 家教）由整合階段補測（第 7 條）。
