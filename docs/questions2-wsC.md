# docs/questions2-wsC.md — WS-C 對階段 2 凍結介面的疑問與暫行處置

> 規則：`docs/interfaces-stage2.md` 不得由 WS 修改。實作時發現介面有問題就寫在這裡，由開發者本人裁決後
> 統一改 `interfaces-stage2.md` 並通知四條 WS。以下每一題都附「我先怎麼做」，程式碼**不繞過**介面，
> 只在介面沒寫到、或寫得有兩種讀法的地方做了可回退的選擇。
>
> **狀態：待裁決（2026-08-22，分支 `ws2-c/gates`）。**

---

## 1.（第 4.2 條）「負號、± 一律去掉再比」照字面會讓 `-1` 與 `1` 判成 agree

**介面怎麼寫**：

> `number` 比正規化後的有理數（`\frac{a}{b}`、小數、`a/b`、負號、`±`、單位後綴一律去掉再比，容差 `1e-9`）

**問題**：這句有兩種讀法。

- 讀法 A（字面）：把負號從字串裡拿掉再比 → `-1` 與 `1` 相等。
- 讀法 B：這幾種**寫法**都要先正規化成同一種表示再比，負號是數值的一部分。

照讀法 A 實作的話，`answerCompare` 會對「符號算錯」一律回 `agree`——而符號錯正是高中數理最典型的計算失誤，
也是 verify 節點存在的主要理由之一。等於這個閘門把它最該抓的那一類錯放掉。

`±` 又是另一回事：`±2` 對上 `2` 真的比不出來（不知道對方是漏寫還是真的只有一個解），
硬要判 agree 或 disagree 都是猜。

**我先怎麼做**：採讀法 B。

- 負號保留，`-1` 與 `1` → `disagree`（`test/unit/answerCompare.test.js` 有這一項）。
- `±` 只跟 `±` 比（比量值）；`±2` 對上單值 `2` → `uncertain`，符合第 4.2 條最後一句
  「任何比不出來的情況都回 uncertain」。
- `\frac{a}{b}`／`a/b`／小數／百分比／單位後綴照介面正規化，容差 `1e-9`。

**要裁決的**：確認採讀法 B，並把第 4.2 條那句改寫清楚（例如「`\frac{a}{b}`、小數、`a/b` 三種寫法先化成同一個
有理數；單位後綴去掉；負號視為數值的一部分；`±` 只與 `±` 比量值，對上單值回 uncertain，容差 1e-9」）。

---

## 2.（第 4.3 條）`bare_script` 的埋點需要比 `:308-318` 多一處

**介面怎麼寫**：埋點列在 `utils/textFormatter.js` 的 `bare_script :308-318`（都在 `renderMixedInto` 裡，
也就是**純文字**區段裡沒有底的 `^` / `_`）。

**問題**：`eval/fixtures/questions.public.json` 自己把 `#38 $F^$` 與 `#59 $E^$` 標成
`broken_kind: "bare_script"`，但這兩處都在 `$…$` **裡面**，走的是 `parseLatexToMath` → `parseScripted`，
不是 `renderMixedInto`。只埋 `:308-318` 的話，這兩題會被判成 ok，fixture 的 10 題就只抓得到 8 題。

**我先怎麼做**：在 `parseScripted` 多埋一處——`^` / `_` 後面什麼都沒有（字串結尾或群組立刻收尾）時
發 `bare_script`。事件種類仍是凍結的六個之一，沒有新增 kind。結果：fixture 10 題全中、其餘 50 題零誤報。

順帶一提，`formulaLint` 把這兩種 `bare_script` 分成兩條 rule：

| 位置 | rule | sev | 理由 |
|---|---|---|---|
| 落在 `$…$` 內 | `bare_script` | `error` | Word 會排出一個空的上下標方格，內容是錯的 |
| 落在純文字裡 | `bare_script_text` | `warn` | 填空題的 `答案：___` 就是這樣寫的，內容一字不差 |

**要裁決的**：確認第 4.3 條的埋點清單補上 `parseScripted`（或直接寫「凍結的是六個 kind，埋點位置由 WS-C 決定」）。

---

## 3.（第 3.1 條）`ctx` 沒有帶 `FEATURE_SIMILAR`，但 dedup1 的 `skipped` 條件要看它

**介面怎麼寫**：

- 第 3.1 條：`ctx.config = { models, limits, thresholds }`——只有三個鍵。
- 第 3.1 條又明講：「agent **不得自己讀 `process.env`**」。
- 第 3.3 條：dedup1「來源題無向量或 **`FEATURE_SIMILAR=false`** → `skipped`」。

**問題**：三句話湊起來，agent 拿不到 `FEATURE_SIMILAR`。

**我先怎麼做**：`agents/dedup.js` 先讀 `ctx.config.features.similar`（runner 之後補上就直接生效），
讀不到才退回 `services/retrievalService.isSimilarEnabled()`（那支會讀環境變數）。
單元測試一律用 `ctx.config.features.similar` 注入，所以測試本身仍然是純注入、不碰環境變數。

**要裁決的**：建議把 `ctx.config` 加上 `features: { similar: boolean, pipeline: boolean }`
（來源是 `config/features.js`，由 runner 組），並通知 WS-A。

---

## 4.（§10.1）`test/unit/` 的所有權與 WS-C 的任務清單衝突

**介面怎麼寫**：§10.1 把 `test/unit/`、`test/integration/`（controller 以外）整個歸給 **WS-D**。

**問題**：WS-C 的任務清單（`docs/stage2-parallel-prompts.md` §2 的 WS-C 段）第 1、6、7 點要求
「以 `node --test` 表格測試跑」「單元測試全部純函式或注入」「整合測試放 `test/integration/dedup.pg.test.js`」。
兩邊對不起來。

**我先怎麼做**：只**新增**檔案，一個字都不動 WS-D 既有的測試。新增的是：

```
test/unit/textFormatterStrict.test.js     A-T4 對照測試 + parseLatexStrict 事件
test/unit/formulaGate.test.js             formulaFix / formulaLint
test/unit/formulaGolden.test.js           eval/golden/formula.json 的表格測試
test/unit/normalizeStem.test.js           A-T5
test/unit/answerCompare.test.js           A-T5
test/unit/agentsGates.test.js             A-T10a/b/c（ctx 全注入）
test/integration/dedup.pg.test.js         A-T10c 對真 PG
test/fixtures/textFormatter.pre-a-t4.js   凍結副本（對照基準，不是測試）
test/fixtures/normalizeStem.s0.js         凍結副本（對照基準，不是測試）
```

**要裁決的**：合併時若 WS-D 也動了 `test/unit/`，這幾支是純新增檔，理論上不會衝突；
但所有權表建議補一句「各 WS 可在 `test/unit/` 新增自己的測試檔，不得修改別人的檔」。

---

## 5.（第 3.4 條）`buildSchema` 在 WS-B 的檔案裡，WS-C 的 agent 在它合入前無法載入

**介面怎麼寫**：`buildSchema(name)` 的位置是 `agents/schemas/index.js`，擁有者 **WS-B**（§10.1）。

**問題**：`agents/verify.js` 的 `answer_form` 是 `x-enum` 佔位符，一定要經過 `buildSchema` 才能送給模型；
但兩條 workstream 平行開發，WS-B 合入前那支檔案不存在，WS-C 的測試連跑都跑不起來。

**我先怎麼做**：新增 `agents/_schema.js`（底線開頭 = 暫時橋接）。
它**先試** `require('./schemas')`，WS-B 合入後就一律走官方版；還沒合入時才用本檔內的同一套規則就地組
（`x-enum` → `enum`，來源同樣是 `config/chapters.js`，白名單絕不手抄）。

**合併注意事項**：WS-B 的 `agents/schemas/index.js` 合入 main 之後，
`agents/_schema.js` 應該連同 `agents/lint.js`／`agents/verify.js` 的 require 一起改掉並刪除本檔。

---

## 6.（第 2.1 條 + §10.1）節點名是 `dedup0`／`dedup1`，但只有一支 `agents/dedup.js`

**介面怎麼寫**：`NODE_FOR_STATE` 的節點名是 `dedup0` 與 `dedup1`（第 2.1 條）；
§10.1 的所有權表只給 WS-C 一支 `agents/dedup.js`；WS-A 的 runner「節點實作從 `agents/<name>.js` 動態 require」。

**問題**：`require('../agents/dedup0')` 會找不到檔案。

**我先怎麼做**：`agents/dedup.js` 匯出 `{ run, runDedup0, runDedup1 }`（`run` 會依 `ctx.node`
或 input 有沒有 `embed_text` 自己分辨），另外加兩支三行的轉接檔 `agents/dedup0.js`／`agents/dedup1.js`，
內容只有 `module.exports = { run: runDedup0 }`。三條路都通，WS-A 用哪一種都行。

**要裁決的**：確認轉接檔的做法可以，或改成 runner 端做 `dedup0|dedup1 → agents/dedup` 的對應。

---

## 7.（第 5.2 條）cassette 鍵要 `sha256(模板原文)`，但 `generateJson` 的參數只帶得到模板「識別名」

**介面怎麼寫**：

- 第 5.1 條：`generateJson({ …, agent, cacheKeyParts, template })`，`template` 是「prompt 模板的**識別名**」。
- 第 5.2 條：`promptTemplateHash = sha256(模板原文)`；「模板＝把可變欄位挖空後的字串，**由 agent 提供**」。

**問題**：agent 提供的是識別名，`services/llm` 拿不到原文，算不出 `promptTemplateHash`。

**我先怎麼做**：`agents/lint.js` 與 `agents/verify.js` 各自 `module.exports` 一個 `PROMPT_TEMPLATE`
（把可變欄位挖成 `{{question_text}}` 這種佔位符的原文）與 `TEMPLATE`（識別名，`lint.v1`／`verify.v1`）。
WS-B 可以 `require('../agents/lint').PROMPT_TEMPLATE` 去算雜湊，不必改介面。

**要裁決的**：確認這個約定，或改成 `generateJson` 多收一個 `promptTemplate` 參數（原文）。
兩種都可以，但要挑一種寫進第 5 條，否則 WS-B 與 WS-C 會各做各的。

---

## 8.（第 4.4 條）`formulaLint` 的 `sev` 只有 error／warn，`audit_formulas` 原本有 info

**介面怎麼寫**：`issues: Array<{sev:'error'|'warn', rule, at, msg}>`。

**問題**：`audit_formulas.js:40` 的「有 LaTeX 但沒包 `$`」原本是 `info`，兩級制裡沒有它的位置。

**我先怎麼做**：降級的規則歸 `error`、寫法問題歸 `warn`，原本的 `info` 一律併進 `warn`
（`latex_without_dollar`）。因為 `ok === issues.every(i => i.sev !== 'error')`，併進 warn 不影響閘門。

**要裁決的**：只是知會，不需要改介面；但如果之後想在 `report:jobs` 分開統計 info，就要加第三級。
