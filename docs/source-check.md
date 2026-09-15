# docs/source-check.md — 拆題結果對照原卷文字層

> 版本 v1.0 | 2026-09-15 | 分支 `feat/source-check` | 對應：`docs/roadmap-plan.md` §6.5 待辦 12、ADR-009、FR-020、DEC-013、`docs/interfaces-stage2.md` 裁決 S2-31
> 本檔是演算法、規則、校準步驟與限制的權威文件；節點合約（input／outcome／payload 形狀）以 `docs/interfaces-stage2.md` 第 3 條為準，本檔不重複。
> 依 NOTICE，本檔與 repo 內所有 fixture 皆不含真實考卷內容；真實原卷的校準只記數字。

## 1. 為什麼要有這一道閘門

2026-09-15 以八份原卷逐題核對題庫，現行拆題管線入庫的題有 4 題把題幹或選項抄錯（常數多負號、向量分量多負號、解的分量正負號錯、選項分母漏字母），另在被判重複的重拆題中發現 2 筆（選項指數多一個負號、選項整排前移）。`verify` 節點只比答案、不比題幹，抄錯的題幹會讓正確答案看起來像錯。

抄錯的型態集中在**字元層級**：正負號、漏掉的字母。這不需要理解題意，用決定性比對即可攔下；取捨見 ADR-009。

## 2. 資料流

```text
extract（每塊 chunk）
  └ 附圖裁切（attachFigureImages）
  └ 原卷文字層（attachSourceText → services/sourceTextService.js）
        mupdf 讀該塊的頁 → utils/sourceCheck.js locateSegments
        → 每題 payload.extract.source_text = {v:1, status, pages, locate_score, segment?, shared?}
  └ insertJobQuestions（PDF 在全部 chunk 拆完後才刪）
dedup0 → classify → lint
source_check（agents/source_check.js，零成本、不重試）
  input：lint.question_text ?? extract.question_text、extract.source_text、是否附圖
  → match／skipped：前進到 source_checked → verify …
  → mismatch：enforce → needs_review('transcription_mismatch')；shadow → 照常前進但記錄
```

- 只存每題定位到的**片段**（≤ 1500 字），不存整頁。抽取失敗只記 warn，該塊每題 `status='error'`，入庫不受影響。
- extract 的模板、schema、`cacheKeyParts` 都未變動，cassette 不失效。
- 變式題沒有原卷，`source_text` 不存在，一律 `skipped('no_source_text')`。
- eval 的 `eval/lib/pipelineDriver.js` 在 extract 通過後以同一支服務附上片段，量測路徑與正式路徑一致。

## 3. 演算法（`exam_pro/utils/sourceCheck.js`，純函式）

### 3.1 文字層抽取

`services/sourceTextService.js` 的 `readPagesText` 以 mupdf `toStructuredText('preserve-whitespace').asText()` 逐頁取文字、依頁序串接。整塊去空白後少於 200 字（`minTextLayerChars`）視為掃描檔，全部 `no_text_layer`。

### 3.2 正規化

| 對象 | 處理 |
| :--- | :--- |
| 原卷文字層 | NFKC（全形數字、字母、負號轉半形）；**Private Use Area 對映**（`puaMap`）：U+F02D→`-`、U+F02B→`+`、U+F03D→`=`、U+F030–F039→`0`–`9`。U+F061–F07A 不對映（Symbol 字型該段是希臘字母，例如 U+F070＝π） |
| 拆題 LaTeX | NFKC；去掉 `[附圖描述：…]`；`\begin{env}{欄位格式}` 與 `\end{env}` 整段去掉（array 的 `{|c|c|}` 不留字母）；`\left`／`\right` 去掉；`\text{…}`、`\mathrm{…}` 等保留內容；其餘指令名去掉，但 `sin cos tan cot sec csc log ln lim exp det max min` 保留（原卷文字層也印得出來）；`{}$^_&\` 換空白。`\pm`／`\mp` 因此不算負號 |
| 兩邊共同 | 去掉開頭題號（`12.`、`(3)`）與配分註記（`（5分）`、`每題 4 分`） |

計數：負號（`-` 與 U+2212）、數字與小寫字母的多重集合。

### 3.3 定位（`locateSegments`，extract 階段）

1. 題目的中文字序列少於 12 字（`minCjk`）→ `low_anchor`。
2. 以題目前 12 個中文字 5-gram 在原卷中文字序列中找候選起點；每個起點計算「題目所有 5-gram 落在 `起點…起點+題長+10` 範圍內的比例」（覆蓋率）。
3. 取覆蓋率最高者；**同分時**先比「開頭 12 個 gram 有幾個剛好對齊」，再比「不早於上一題起點」（依卷面順序定位）。前者避免上一題結尾與本題共用詞組（例如「之最小值為」）時，段落從上一題尾巴起算、帶進別題的字母。
4. 覆蓋率 < 0.8（`minCoverage`）→ `not_found`（附 `locate_score`）。
5. 段落從起點往前吞掉題號，往後延伸到最後一個中文字之後最多 600 字（`tailMax`），遇到「換行＋題號」「題組」「答案卷／答案欄」即截斷；截斷上限 1500 字（`segmentMax`）。
6. 與上一題的段落重疊（題組前導語被放進每個小題、承上題）→ 標 `shared: true`。

### 3.4 比對（`compareSegment`，source_check 節點）

先以題幹重算中文字 5-gram 在片段中的覆蓋率，低於 0.8 → `skipped('locate_mismatch')`（lint 或人大改題幹時不硬比）。之後計算四個訊號：

| 訊號 | 定義 |
| :--- | :--- |
| `extraMinus` | 拆題負號數 − 原卷負號數；**原卷片段完全沒有負號字形時固定為 0**（有些 PDF 的算式負號不在文字層） |
| `missLower` | 原卷有、拆題缺少的小寫字母個數；**附圖題固定為 0**（圖上標籤會混進文字層） |
| `missDigits` | 原卷有、拆題缺少的數字個數 |
| `extraDigits` | 拆題有、原卷缺少的數字個數 |

判定為 `mismatch` 的規則（任一成立）：

- `extra_minus`：`extraMinus ≥ 1`
- `missing_lower`：`missLower ≥ 1` 且 `missDigits ≤ 1`
- `extra_digits`（**預設關閉**，`extraDigitsRule`）：`extraDigits ≥ 2`

`describeMismatch` 產生繁體中文的具體一句，例：「拆題題幹與原卷文字層不一致：負號比原卷多 1 個（拆題 3、原卷 2）；原卷有、拆題漏掉的字母：m。請對照原卷確認題幹與選項。」

### 3.5 模式與人工核准

- `SOURCE_CHECK_MODE`：`enforce`（預設；未設定、空字串、非法值都退回 `enforce`）→ `fail('transcription_mismatch')`；`shadow` → `pass` 但 `payload.source_check.verdict='mismatch'`、`shadow:true`；`off` → `skipped('disabled')`。runner 建立時讀取，改動需重啟。
- 不重試（決定性比對，重跑結果相同），也不在 `POST /api/jobs/:id/retry` 的可重跑清單內。
- 人工 approve **不重跑**閘門，只在 `node='approve'` 事件的 `detail` 記 `source_recheck`（修正後題幹重跑的 `match`／`mismatch`／`skipped`，無片段時 `null`）與 `stem_edited`。
- 複核卡片的原因列優先顯示 `payload.source_check.message`；展開後可看原卷片段（`escapeHtml` 後放進 `<pre>`，原因為 `transcription_mismatch` 時預設展開）。

## 4. 校準

### 4.1 步驟

```bash
cd exam_pro
# DATABASE_URL 指向正式庫；工具連線後第一句 SET default_transaction_read_only = on，只做 SELECT
node eval/tools/calibrate_source_check.js --pdf-dir "<原卷資料夾>" --out eval/local/source_check.json
node eval/tools/calibrate_source_check.js --pdf-dir "<原卷資料夾>" --sweep --out eval/local/source_check_sweep.json
node eval/tools/calibrate_source_check.js --pdf-dir "<原卷資料夾>" --show-text          # 逐題看判定（只印終端機）
node eval/tools/calibrate_source_check.js --pdf-dir "<原卷資料夾>" --include-dups       # 一併量被判重複／不採用的列
```

- 原卷以檔案 sha256 對應 `jobs.pdf_sha256`；同一份 PDF 被拆過多次時逐 job 分開算。
- 已知正例以 `questions.id` 給定（預設 130、154、161、222、227，`--positives` 可覆寫）；預設排除 `rejected` 與 `duplicate` 的列。
- `--out` 只允許寫到 `eval/local/`（已 gitignore），檔案只含數字；`--show-text` 的題目文字只印到終端機。
- 每個設定都會一併跑公開樣卷（`eval/fixtures/sample_exam.pdf`＋`meta.template='extract.v2'` 的 cassette）。
- 採用門檻：樣卷 0 誤報，且真實原卷誤報 ≤ 已比對題數 2%。

### 4.2 結果（2026-09-15）

**公開樣卷**：10 題中可比對 5、跳過 5（皆 `low_anchor`）、誤報 0。同一斷言在 `test/unit/sourceCheckSample.test.js` 由 CI 單元層執行。

**真實原卷**（8 份，現行入庫題 117 列）：

| 項目 | 數字 |
| :--- | :--- |
| 可比對 | 63（53.8%） |
| 判不一致 | 3：TP 3（題 130、161、222）、FP 0 |
| FN | 2：題 154（題目中文字太少，`low_anchor`）、題 227（掃描檔，`no_text_layer`）；兩者皆為跳過，**可比對卻判一致者 0** |
| 跳過 | `no_text_layer` 24（20.5%，其中一份整份為掃描檔）、`low_anchor` 17（14.5%）、`not_found` 11（9.4%）、`locate_mismatch` 2（1.7%）；合計 54（46.2%）；排除掃描檔後跳過比例約 32% |

含被判重複／不採用的列（168 列）：可比對 111（66.1%），判不一致 4＝上述 TP 3＋重拆題中已知的「選項指數多一個負號」1 筆，無誤報；另一筆已知錯誤「選項整排前移」未被抓到（見第 5 節）。

**PUA 對映前後的負號字形數**（依檔案）：16→16、0→93、45→45、11→59、4→5、2→2、6→6、1→1。兩份 Symbol 字型原卷的負號全在 U+F02D。

**參數掃描**（117 列；樣卷在所有設定下皆 0 誤報）：

| 設定 | 可比對 | TP | FP |
| :--- | ---: | ---: | ---: |
| 主線原型：tailMax 160、無 PUA 對映、同分取最早起點 | 63 | 3 | 2 |
| ＋同分對齊決勝（tailMax 160、無 PUA） | 63 | 3 | 1 |
| ＋同分對齊決勝＋PUA（tailMax 160） | 63 | 3 | 1 |
| ＋同分對齊決勝＋tailMax 600（無 PUA） | 63 | 3 | 1 |
| **採用：同分對齊決勝＋PUA＋tailMax 600、minCoverage 0.8** | **63** | **3** | **0** |
| 採用設定，minCoverage 改 0.7 | 71 | 3 | 2 |
| 採用設定，打開 extraDigitsRule | 63 | 3 | 4 |

三項調整各自消除一種誤報：對齊決勝消除「段落從上一題尾巴起算」；tailMax 600 消除「矩陣題的文字層一格一行，160 字截掉選項後負號變少」；PUA 對映消除「Symbol 字型原卷的片段只剩部分負號」。召回未增加（已知正例中可比對者皆已抓到），採用理由是誤報由 2（3.2%，超過 2% 門檻）降為 0。主線原型在含重拆題的母體上量得可比對 107、TP 3、FP 1，與上表母體不同。

## 5. 限制

- **約三分之一到一半的題目不可比對**：純算式題（中文字 < 12）、掃描檔（整份跳過）、文字層排版打散到定位不到的題。跳過不等於通過檢查，只是這道閘門不表態。
- 只抓字元層級的差異：負號數量、漏掉的小寫字母（數字缺漏 ≤ 1 時）。**抓不到**選項整排前移、數字互換位置、分數上下顛倒、單位換算錯誤等結構性錯誤。
- 原卷片段本身沒有負號字形時，負號規則不觸發；附圖題不跑字母規則。
- 規則是針對 2026-09-15 發現的錯誤型態校準的；新型態的考卷（不同字型、雙欄排版）上線初期建議先以 `shadow` 觀察，再依第 4.1 節重新校準。
- 題組前導語被放進每個小題時，片段會重疊（`shared`）；目前照常比對，`extraDigitsRule` 因此預設關閉。

## 6. 相關檔案與測試

| 類別 | 路徑 |
| :--- | :--- |
| 純函式 | `exam_pro/utils/sourceCheck.js` |
| 文字層服務 | `exam_pro/services/sourceTextService.js`、`exam_pro/services/mupdf.js`（與附圖裁切共用的 mupdf 載入器） |
| 節點 | `exam_pro/agents/source_check.js`；`exam_pro/workers/jobRunner.js`（`attachSourceText`、`loadSourceCheckConfig`、`buildInput('source_check')`）；`exam_pro/pipeline/stateMachine.js` |
| 資料庫 | `exam_pro/migrations/0009_source_check.sql` |
| 複核 | `exam_pro/controllers/reviewController.js`（`sourceRecheck`）、`exam_pro/public/js/review.js`（`reasonSentence`、`sourceSegmentOf`） |
| eval／校準 | `exam_pro/eval/lib/pipelineDriver.js`、`exam_pro/eval/tools/calibrate_source_check.js` |
| 測試 | `test/unit/sourceCheck.test.js`、`test/unit/sourceCheckSample.test.js`、`test/integration/jobs.pg.test.js`（「runner — source_check 節點與 0009」）、`test/e2e/pipeline.e2e.test.js`、`test/fixtures/fakeAgents/source_check.js`、`test/fixtures/fakeVariantAgents/source_check.js` |
