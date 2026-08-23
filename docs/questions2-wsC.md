# docs/questions2-wsC.md — WS-C 對階段 2 凍結介面的疑問與暫行處置

> 規則：`docs/interfaces-stage2.md` 不得由 WS 修改。實作時發現介面有問題就寫在這裡，由開發者本人裁決後
> 統一改 `interfaces-stage2.md` 並通知四條 WS。
>
> **狀態：全部結案（2026-08-23）。** 第一輪裁決（S2-*）與第二輪補裁（S2-26）都已寫進 `docs/interfaces-stage2.md` §12（編號 S2-*）
> 與對應條文；每一條下方的「**裁決**」就是最終結論，程式碼與測試已對齊，
> 不需要再讀「我先怎麼做」那段來猜。
> 第 9～11 條是第二輪（S2-26）的；第 11 條的實作已照裁決落地，但**留了一筆待開發者決定的
> golden 衝突**（`ans-048`），細節見該條。

---

## 1.（第 4.2 條）「負號、± 一律去掉再比」照字面會讓 `-1` 與 `1` 判成 agree

**介面原本怎麼寫**：

> `number` 比正規化後的有理數（`\frac{a}{b}`、小數、`a/b`、負號、`±`、單位後綴一律去掉再比，容差 `1e-9`）

**問題**：這句有兩種讀法。照字面（把負號從字串裡拿掉）的話，`answerCompare` 會對「符號算錯」一律回
`agree`——而符號錯正是高中數理最典型的計算失誤，也是 verify 節點存在的主要理由之一。

**裁決（S2-11）**：**負號是數值的一部分**，`-1` 與 `1` → `disagree`；`±` 只與 `±` 比量值，
`±2` 對上單值 `2` → `uncertain`。第 4.2 條已改寫成這個說法。

**落地**：`utils/answerCompare.js` 的 `toNumber` 保留負號、`toNumberList` 單獨處理 `±`；
`test/unit/answerCompare.test.js` 有「負號是數值的一部分，-1 與 1 是 disagree」與
「± 只能跟 ± 比，對上單值一律 uncertain」兩項。
第二輪另修好一個實作缺陷：`-\frac{1}{2}` 原本解析成 `null`（外層負號在 `\frac` 展開後掉了），
使得「漏掉負號」這個 S2-11 最在意的案例反而回 `uncertain`；現已修正並補測試。

---

## 2.（第 4.3 條）`bare_script` 的埋點需要比 `:308-318` 多一處

**問題**：`eval/fixtures/questions.public.json` 把 `#38 $F^$` 與 `#59 $E^$` 標成
`broken_kind: "bare_script"`，但它們在 `$…$` **裡面**，走的是 `parseLatexToMath` → `parseScripted`，
不是 `renderMixedInto`。只埋 `:308-318` 的話，fixture 的 10 題壞公式只抓得到 8 題。

**裁決（S2-17）**：**凍結的是六個 kind，埋點位置由 WS-C 決定**。`bare_script` 補上 `parseScripted`
（`$…$` 內 `^`／`_` 後面什麼都沒有）。`formulaLint` 的兩條 rule 名一併凍結：
`$…$` 內 = `bare_script`（`error`）、純文字裡 = `bare_script_text`（`warn`）。

**落地**：`utils/textFormatter.js` 兩處埋點，檔頭註解寫明理由；`utils/formulaLint.js` 依事件位置
落在哪一段決定 rule 與 sev。fixture 10 題全中、其餘 50 題零誤報。

---

## 3.（第 3.1 條）`ctx` 沒有帶 `FEATURE_SIMILAR`，但 dedup1 的 `skipped` 條件要看它

**問題**：第 3.1 條的 `ctx.config` 只有 `models`／`limits`／`thresholds`，又明講「agent 不得自己讀
`process.env`」，但第 3.3 條要求 dedup1 在 `FEATURE_SIMILAR=false` 時 `skipped`——旗標拿不到。

**裁決（S2-8）**：`ctx.config.features = { similar, pipeline }` 由 runner 從 `config/features.js` 組出來，
**agent 要知道旗標只能從這裡讀**。

**落地**：`agents/dedup.js` 的 `similarEnabled(ctx)` 只讀 `ctx.config.features.similar`，
已移除原本退回 `services/retrievalService.isSimilarEnabled()` 的那條路（它會讀環境變數）。
runner 沒給就當關閉——dedup1 一律 `skipped`，是安全的那一邊（L0 的雜湊仍然擋得住逐字重複）。

---

## 4.（§10.1）`test/unit/` 的所有權與 WS-C 的任務清單衝突

**問題**：§10.1 把 `test/unit/`、`test/integration/`（controller 以外）整個歸給 WS-D，
但 WS-C 的任務清單要求把公式表格測試、純函式測試與 `dedup.pg.test.js` 放進去。

**裁決（S2-2）**：各 WS 可在 `test/unit`／`test/integration` **新增自己的測試檔，不得改別人的**。

**落地**：WS-C 新增的九個檔（六支測試 + 兩支凍結副本 + 一支整合測試）都是純新增，
一個字都沒有動到 WS-D 既有的測試。

---

## 5.（第 3.4 條）`buildSchema` 在 WS-B 的檔案裡，WS-C 的 agent 在它合入前無法載入

**問題**：`agents/verify.js` 的 `answer_form` 是 `x-enum` 佔位符，一定要經過 `buildSchema` 才送得出去；
但兩條 workstream 平行開發，WS-B 合入前 `agents/schemas/index.js` 不存在。

**裁決（S2-24）**：WS-C 的 `agents/_schema.js` 橋接在 WS-B 合入後改用
`agents/schemas/index.js` 的 `buildSchema` 並**刪除**。

**落地**：`agents/lint.js`／`agents/verify.js` 改成 `require('./schemas')`，
`agents/_schema.js` 已刪除。`agents/schemas/lint.json`／`verify.json` 仍由 WS-C 維護，
WS-B 的 `buildSchema` 讀得到，`answer_form` 的 enum 注入實測正常。

---

## 6.（第 2.1 條 + §10.1）節點名是 `dedup0`／`dedup1`，但只有一支 `agents/dedup.js`

**問題**：`require('../agents/dedup0')` 會找不到檔案。

**裁決（S2-6）**：`dedup0`／`dedup1` 由 `agents/dedup.js` 一支服務（匯出
`{ run, runDedup0, runDedup1 }`）+ 兩支三行的轉接檔；runner 的解析順序是
①`agents/<node>.js` → ②`AGENT_MODULE_FOR_NODE[node]`。層級**只能靠凍結的 input 鍵**判斷
（`dedup0` 拿 `{question_text}`、`dedup1` 拿 `{question_id, embed_text, subject, chapter}`），
不得看 `ctx.jq.state` 或 payload。

**落地**：三條路都通，且 `run()` 的分派只看 `ctx.node` 與 input 有沒有 `embed_text`，
沒有碰 `ctx.jq.state`。

---

## 7.（第 5.2 條）cassette 鍵要 `sha256(模板原文)`，但 `generateJson` 只帶得到模板「識別名」

**問題**：agent 提供的是識別名，`services/llm` 拿不到原文，算不出 `promptTemplateHash`。

**裁決（S2-5）**：模板原文走 `services/llm/templates.js` 註冊表——
`registerTemplate(name, text)`／`getTemplate(name)`，每個 agent 在**模組載入時**註冊，
`services/llm` 依 `template` 識別名回查原文算雜湊。**四個 LLM 節點（extract／classify／lint／verify）
都必須註冊**；沒註冊的識別名退回 `sha256(識別名)` 並印一次警告。

**落地**：`agents/lint.js`／`agents/verify.js` 在模組載入時
`registerTemplate('lint.v1'|'verify.v1', PROMPT_TEMPLATE)`，`generateJson` 只傳識別名。
實測 `templateHash('lint.v1')`／`('verify.v1')` 已取得原文雜湊（不再落到警告那條路）。
兩支 agent 仍然 `module.exports` 出 `PROMPT_TEMPLATE` 與 `TEMPLATE`，方便 eval 直接取用。

---

## 8.（第 4.4 條）`formulaLint` 的 `sev` 只有 error／warn，`audit_formulas` 原本有 info

**裁決（S2-18）**：`audit_formulas.js` 原本的 `info`（如 `latex_without_dollar`）一律併進 `warn`，
**不加第三級**。

**落地**：`utils/formulaLint.js` 的檔頭註解寫明這條裁決；因為
`ok === issues.every(i => i.sev !== 'error')`，併進 warn 不影響閘門。

---

# 第二輪：已結案

## 9.（第 4.2 條）科學記號 `1.8 \times 10^5` 目前解析不出數值

**現況**：裁決 S2-12 的新抽取規則上線後，對 `eval/fixtures/questions.public.json` 的 45 題填空／計算，
抽出來的片段有 40 題可以解析成數值（舊規則是 35 題，且抽出來的多半是算式而非答案）。
剩下 5 題：

| 題 | 抽出來的字串 | 狀況 |
|---|---|---|
| #22 | `x` | 答案是文字敘述（`answer_form: 'text'`），本來就不該走數值路徑；比對器回 `uncertain`，行為正確 |
| #56、#57、#58、#60 | `1.8 \times 10^5`、`2 \times 10^5`、`2.4 \times 10^{-4}`、`2 \times 10^{-4}` | **科學記號**，`toNumber` 認不出來 → `uncertain` |

**為什麼沒有自己決定**：第 4.2 條列的等價形是「`\frac{a}{b}`、小數、`a/b`、百分比」，沒有科學記號；
而 WS-D 在 `docs/questions2-wsD.md` 的 `eval/golden/answer.json` 裡（`ans-027`、`ans-043`）
已經把「科學記號算不算 `number` 的等價形」「`e` 記法要不要支援」列為**待開發者定案**。
這是同一個問題的兩面，不該由 WS-C 單方面決定。

**影響**：這 4 題每次都會走「uncertain → 再採樣一次 → 仍 uncertain → `answer_mismatch` 進複核」，
也就是多付一次模型錢再讓老師白看一題。物理科的答案很常寫成科學記號，實際佔比會比 fixture 高。

**建議**：`toNumber` 支援 `a \times 10^{b}`（含負指數與 `10^{-4}` 的大括號形式），
與既有的 `1.8e5` 科學記號一併收斂。若同意，第 4.2 條的等價形清單加一項即可，簽名不動。

順帶一提，第二輪已經自行修掉的兩個實作缺陷（都在 S2-11／第 4.2 條的既有文字範圍內，不需要改介面）：

- `-\frac{1}{2}` 解析成 `null`（外層負號在 `\frac` 展開後掉了）→ 已修，`-0.5`。
- `45^\circ`／`45^{\circ}` 解析成 `null`（`^\circ` 是角度單位，屬於第 4.2 條「單位後綴一律去掉再比」）→ 已修，`45`。

**裁決（S2-26）**：第 4.2 條的 `number` 補上三種寫法——科學記號（`a \times 10^{n}`／`a×10^n`／`2.4e-4`）、
`\mathrm{…}`／`\text{…}`／`\,`／`\ ` 與其後的單位整段去掉、`\sqrt{n}`／`\frac{\sqrt{a}}{b}`／`\pi`
這類可數值化的式子算出數值再比（容差 `1e-9`，兩邊都算得出且不等 → `disagree`）。

**落地**：`utils/answerCompare.js` 換掉原本「一條正則配一種寫法」的作法，改成
「LaTeX → 算式字串 → 遞迴下降求值器」兩段。求值器**不用 `eval`／`Function`**——輸入來自模型，
任何看不懂的字元一律讓整式失敗回 `null`（猜錯數值會變成假的 agree／disagree，比 uncertain 糟得多）。
對 fixture 的 45 題填空／計算，抽出後可解析成數值的由 40 題升到 44 題，只剩 #22（它的答案是一句文字敘述）。
`expression` 一併照 S2-26 改：字串不同時兩邊都能數值化才照 `number` 比，否則 `uncertain`
（原本落到 `disagree`，等於拿「看不懂」當「不一樣」）。

---

## 10.（S2-12 的連帶）`eval/golden/answer.json` 的 48 筆 `claimed` 還是舊寫法

**現況**：S2-12 已裁決「D 的 answer golden 改回真實寫法」，但目前 `eval/golden/answer.json`
還是為了配合舊規則而寫成「答案在最前面、說明在後面」。新規則取**最後一個** `$…$`，
這種寫法會抽到說明裡的最後一個公式。例如 `ans-036`（S2-11 的重點案例）：

```
claimed: "$-\frac{1}{2}$。$120^\circ$ 的參考角為 $60^\circ$，第二象限的餘弦為負。"
新規則抽出：60^\circ      ← 說明裡的參考角，不是答案
```

`answerCompare` 因此對 `equivalents` 的四種寫法全部回 `disagree`（而 golden 期望 `agree`）。

**這不是新規則的缺陷**：fixture 的 45 題真實答案裡有 39 題是「過程 = 結論」的寫法，
新規則正是為它們設計的；`ans-036` 這種「結論在最前面」的形狀是 WS-D 當初為了閃避舊規則才寫的，
不是真實分佈。

**結案**：WS-D 已依 S2-12 把 `answer.json` 的 `claimed` 全部改寫成真實寫法
（`_status` 標記為「2026-08-22 依裁決 S2-12 改寫」），並新增 `test/unit/answerGolden.test.js`
把 250 個案例接上 `answerCompare`。本輪（S2-26 落地後）250 案例相符 242 筆；
`ans-017` 的 hazard 已消失，只剩 `ans-047`（golden 要改成 `agree`，見下）與 `ans-048`（第 11 條）。

---

## 11.（第 4.2 條）S2-26 的 `text` 規則與 golden `ans-048` 的期望互相矛盾

**裁決（S2-26）**：`text` —— `normalizeStem` 後相等 → `agree`；**不相等一律 `uncertain`，永遠不回 `disagree`**。

**落地**：`compareText` 照做，並且改成比**整段 `claimed`**（不走 `$…$` 抽取）——
文字型答案沒有「最後一個等號右邊」，抽出來的多半是敘述裡的某個符號。
`answer.json` 的三筆 `text` 中，`ans-049`（5 個案例）與 `ans-050`（證明題）都因此變成相符。

**但 `ans-048` 的 5 個案例在 S2-26 下不可能相符**，而且不是實作差一點，是期望本身還停在舊語意：

```
normalizeStem(claimed) = "兩向量的內積為零且皆非零向量,故夾角為90^\circ,兩者互相垂直。"
  eq    "互相垂直"   → "互相垂直"   不相等   expect agree     → S2-26 只能回 uncertain
  eq    "互相垂直。" → "互相垂直。" 不相等   expect agree     → 同上
  eq    "互 相 垂 直" → "互相垂直"  不相等   expect agree     → 同上
  wrong "互相平行"   → "互相平行"   不相等   expect disagree  → S2-26 明令 text 不回 disagree
  wrong "長度相等"   → "長度相等"   不相等   expect disagree  → 同上
```

- 三筆 `eq` 要 `agree`，就必須有「claimed 以 model 結尾也算相等」這類**包含式**比對，
  而 S2-26 寫的是「相等」。
- 兩筆 `wrong` 要 `disagree`，直接牴觸「永遠不回 `disagree`」。

`ans-049` 的結構與 `ans-048` 完全相同（claimed 是一整句說明、model 只回結論短語），
WS-D 已經把它改成 `{equivalent:'uncertain', wrong:'uncertain'}` 並因此相符——
**`ans-048` 看起來只是漏改的那一筆**。

**要做的事（WS-D，或開發者裁決）**：兩條路擇一——
1. 把 `ans-048` 的 `expect` 改成 `{equivalent:'uncertain', wrong:'uncertain'}`（與 `ans-049` 一致）；
   這樣 250 案例會只剩 `ans-047` 的三筆 `eq*`（那三筆是 golden 要改成 `agree`）。
2. 若希望「說明句結尾就是答案」能判 `agree`，那要改的是 S2-26 的 `text` 規則本身
   （加一條「claimed 正規化後以 model 結尾 → `agree`」），並同時決定 `wrong` 要回 `uncertain` 還是 `disagree`。
   WS-C 不自行加這條——它會讓實作與凍結條文不一致。
