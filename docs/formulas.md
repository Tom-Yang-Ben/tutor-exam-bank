# docs/formulas.md — 題庫的公式與表格語法規範

> 目的：回答「題目文字裡的數學式與表格要怎麼寫，系統才會在網頁（MathJax）與 Word（OMML）兩邊都排得對」，
> 以及「入庫時的公式檢查到底在檢查什麼」。規則的程式碼真相：`exam_pro/utils/formulaLint.js`（檢查）、
> `exam_pro/utils/textFormatter.js`（Word 轉換）、`exam_pro/eval/golden/formula.json`（150 條 golden）。
> 2026-09-15 起：表格（`\begin{array}` 加 `\hline`）、跨行的 `$$…$$`、`\mathbb`、`\triangle`、`\ell`、`\hbar` 已支援。

## 1. 三個渲染端，同一份文字

| 端 | 引擎 | 讀到的是什麼 |
|---|---|---|
| 網頁（題庫列表、複核、組卷預覽） | MathJax 3（CDN，`tex-mml-chtml`） | `question_text`／`answer_text` 原文，`$…$` 行內、`$$…$$` 區塊 |
| Word 匯出 | `utils/textFormatter.js` → OMML（`m:oMath`） | 同一份原文，逐行掃描，`$…$` 與 `$$…$$` 轉成 Word 原生數學物件 |
| 入庫閘門 | `utils/formulaLint.js`（lint agent 與複核頁 approve 都用它） | 同一份原文；有 `error` 級問題就擋下，進 `needs_review('formula_unparsable')` |

三端共用一份文字，所以規範只有一套：**MathJax 看得懂、且 textFormatter 轉得出來的 LaTeX 子集**。MathJax 比 Word 端寬鬆得多，
凡是「網頁看起來正常但 Word 跑版」的案例，都是寫了 Word 端不認得的東西——以 lint 為準，不以網頁為準。

## 2. 表格怎麼寫

考卷裡的資料表（衛星質量與半徑、星球數據、統計次數表）一律用 LaTeX 的 `array` 環境包在區塊公式裡：

```latex
下表為甲、乙、丙、丁、戊五顆衛星的資料：
$$\begin{array}{|c|c|c|c|c|c|}
\hline
 & \text{甲} & \text{乙} & \text{丙} & \text{丁} & \text{戊} \\
\hline
\text{質量} & m & 4m & 6m & 9m & 30m \\
\hline
\text{軌道半徑} & R & 2R & 3R & 4R & 5R \\
\hline
\end{array}$$
試問何者受到的地球引力最大？
```

規則：

1. **整個表格放在一對 `$$ … $$` 裡**，可以跨行。2026-09-15 前 lint 與 Word 轉換都是逐行掃描，跨行的區塊在第一行就被判「環境沒關」，
   這正是 2026-08-29 台東卷兩題（下表衛星資料、火星重力）卡在複核的原因；現在兩端都先把區塊內的換行摺成空白再掃。
2. 欄位規格 `{|c|c|}` 與 `\hline` 可以寫（MathJax 會畫框線），Word 端會**略過框線**，只輸出無框的矩陣（OMML 的 `m:m` 沒有框線概念）。
   這是已知且接受的差異：Word 卷裡的表格看得到內容、看不到格線。
3. 中文儲存格用 `\text{…}` 包住；純數學儲存格直接寫（`4m`、`2R`）。
4. 列以 `\\` 分隔，欄以 `&` 分隔；不要在儲存格裡再放 `\begin{…}`（巢狀環境未支援，`textFormatter.js` 檔頭已註明）。
5. 不要用 `tabular`、`|` 直接畫線、或 Markdown 表格——三端都不認得。

矩陣類（`pmatrix`／`bmatrix`／`vmatrix`／`cases`／舊式 `\matrix{…}`）同一套機制，見 `textFormatter.js` 的 `MATRIX_ENVS`。

## 3. 指令白名單（Word 端認得的）

| 類別 | 指令 |
|---|---|
| 希臘字母 | `\alpha`…`\omega`、`\Gamma`…`\Omega`（含 `\varepsilon`、`\vartheta`、`\varphi`） |
| 運算與關係 | `\times \div \cdot \pm \mp \leq \geq \neq \approx \equiv \sim \propto \infty \partial \nabla \in \notin \subset \cup \cap \to \Rightarrow \Leftrightarrow \cdots \ldots \angle \perp \parallel \circ \because \therefore \degree` |
| 結構 | `\frac \dfrac \sqrt[n]{} \sum \int \lim \left( \right) \left\{ \right.` |
| 函數 | `\sin \cos \tan \log \ln \exp \det \max \min …`（`FUNCTIONS` 集合） |
| 字型 | `\text \mathrm \mathbf \mathit \mbox \operatorname`；**`\mathbb{R}` → ℝ**（單一拉丁字母映射，其餘照字面） |
| 重音 | `\vec \hat \bar \overline \dot \ddot \tilde` |
| 2026-09-15 新增 | `\ell`（ℓ）、`\hbar`（ℏ）、`\triangle`（△）、`\square`（□）、`\hline`（表格橫線，Word 端略過） |

不在表上的指令：Word 端會**去掉反斜線印出指令名**（`unknown_command` 事件，lint 判 `error`）。新指令請加進 `SYMBOLS`／`parseCommand`
並補一條 `test/unit/formulaTables.test.js` 的案例；若 golden 裡原本標 `degrade` 的案例因此變成可轉換，要一併把 `expect` 改為 `ok`（F134 `\mathbb` 就是先例）。

## 4. lint 檢查什麼

`formulaLint(text)` 回 `{ ok, issues:[{sev:'error'|'warn', rule, at, msg}] }`，`error` 才擋入庫：

| 規則 | 級別 | 意思 |
|---|---|---|
| `dollar_unbalanced` | error | `$` 奇數個 |
| `brace_unbalanced` | error | `{`／`}` 數量不等。**`\{`、`\}` 是字面括號不計**（2026-09-15 修正：`\left\{` 方程組原本被誤判） |
| `legacy_marker` | error | 舊轉換器殘留 `[FRAC:…]`、`[SUB:…]` |
| `bare_frac_sqrt`、`bare_ell` | error | `frac`、`sqrt`、`ell` 少了反斜線 |
| `dollar_before_script`、`dollar_before_rbrace` | error | `$X$^{n}`、`…$}` 這類錯位 |
| `unknown_command`、`missing_rbrace`、`parser_error`、`tokenize_error`、`empty_fallback`、`bare_script` | error | 真的跑一次 Word 轉換器得到的事件（`parseLatexStrict`；六種事件凍結於 `docs/interfaces-stage2.md` §4.3） |
| `slash_fraction`、`unicode_math`、`latex_without_dollar`、`bare_script_text` | warn | 建議改寫，不擋入庫 |

## 5. 2026-09-15 全庫健檢結果

219 題全部跑過 lint 與 Word 轉換（`bank_syntax_audit`）：

- 修正前 8 題有 error：`\triangle`（3 題）、`\mathbb{R}`（2 題）、`\left\{` 誤判（2 題）、舊題 47 的殘留標記與裸 `ell`。
- 修正後只剩題 47：它是 2026-05 從舊系統匯入的殘缺版本，同一題已於 2026-08-29 以乾淨 LaTeX 重新入庫（題 195），處置見 roadmap。
- warn 級 118 處 `bare_script_text`、79 處 `slash_fraction` 幾乎全在舊題的純文字（`1/4`、`m/s^2`），網頁與 Word 都照字面印，不跑版。

## 6. 拆題 prompt 與表格

`agents/extract.js` 的 prompt 目前**沒有**明說表格要怎麼寫；模型自己就會輸出 `\begin{array}` 加 `\hline`（台東卷兩題即是）。
要在 prompt 加規範時注意：prompt 模板進 cassette 鍵，改了模板版本（`extract.v1` → `v2`）就要重錄 pipeline cassette（需金鑰、約半小時），
CI 才會綠。這一步列在 roadmap 擱置區，等下一次需要重錄時一併做。
