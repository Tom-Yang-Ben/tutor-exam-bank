# docs/questions2-wsD.md —— WS-D（評估與前端）對階段 2 凍結介面的提問

> 規則（`docs/interfaces-stage2.md` 檔頭）：任何 workstream **不得修改**凍結介面。
> 實作時發現介面有問題就寫在這裡，由開發者本人裁決後統一改 `interfaces-stage2.md`
> 並通知四條 WS「第 N 條已更新為 …，請 rebase 後對齊」。
>
> **狀態：Q1–Q5、Q7 已裁決並結案；Q6 至歸檔日（2026-08-25）仍未裁決。**
> Q6 的缺陷經 2026-08-25 實測仍在（多選 `B、D`／`B.D.` 仍判 `disagree` 誤報）；
> 懸案追蹤已移至 `docs/HANDOFF.md` §3「待使用者裁決」，本檔不再更新。
> Q1–Q5 為第一輪（2026-08-22，S2-* 見 `interfaces-stage2.md` §12）；
> Q6 為第二輪合併後新發現；Q7 為 S2-26 的結案紀錄（2026-08-23，§12.1）。
>
> 每一則都保留提問全文，是為了讓「為什麼介面長這樣」有跡可循——只看結論會看不出當初的岔路在哪裡。
> 每則末尾的「**裁決**」段落是開發者本人的決定與 WS-D 的落地情形。

---

## Q1（會影響 E-X12a 的基準線是否可信）第 10.1 條：`services/legacy/analyzePdf.js` 沒有主人

**背景。** 規劃 §5.3.5 與分工總表都要求 `--method legacy` 去跑「舊的
`aiService.analyzePdfContent`」，並在括號裡註明「保留 `aiService.js` 為
`services/legacy/analyzePdf.js`」。但：

- `interfaces-stage2.md` 第 10.1 條的所有權表裡**沒有 `services/legacy/`**，四條 WS 都不擁有它。
- WS-B 的 A-T8 明文要把 `aiService.analyzePdfContent` 改成新 extract agent 的**相容包裝**。

這兩件事合起來會產生一個很難發現的錯誤：A-T8 合入之後，`--method legacy` 這一欄
量到的其實是**新管線**，但報表上標的是 legacy。兩欄數字會神奇地一模一樣，
而且沒有任何東西會報錯——整份新舊對照實驗因此作廢。

**WS-D 目前的做法（不改介面）。** `eval/lib/legacyAdapter.js` 依序找
`services/legacy/analyzePdf.js` → `services/aiService.js`，並且：

1. 把實際用了哪一支記進報表的 `legacy.rel`；
2. 退回 `aiService.js` 時，檢查它裡面還在不在「手抄的章節白名單」這個 legacy 指紋
   （字串 `【數學科精細章節白名單】`，A-T8 會刪掉它），指紋不見了就在報表最上方印警告；
3. `prompt_hash` 只雜湊原始碼裡的長樣板字串（＝ prompt 本體），
   讓「改了 prompt」與「改了周邊程式」在報表上分得開。

**需要裁決的是。** 誰在什麼時候把舊版 `aiService.js` 快照成 `services/legacy/analyzePdf.js`？
三個選項：

| 選項 | 做法 | 代價 |
|---|---|---|
| A（建議） | 在 A-T8 的 PR 裡由 **WS-B** 一併建立（他本來就要動 `aiService.js`，最清楚該保留哪一版），並在第 10.1 條把 `services/legacy/` 列為 WS-B 的檔案 | WS-B 多一個檔案 |
| B | 由開發者本人在合併 A-T8 之前手動 `git mv` 一份快照 | 一個人工步驟，忘了就沒有基準線 |
| C | 不保留快照，接受 `--method legacy` 在 A-T8 之後失效，基準線只在 A-T8 合入**之前**跑一次 | 之後想重跑對照就沒得跑；換模型後也無法重驗 |


> **裁決（S2-19，落地於第 10.1 條）：選項 A。**
> `services/legacy/analyzePdf.js` 由 **WS-B** 從 A-T8 之前的 `aiService.js` 快照建立
> （`git show e1740ca:exam_pro/services/aiService.js`），並歸 WS-B 所有。
>
> **WS-D 已照辦**：`eval/lib/legacyAdapter.js` 的解析順序不變（快照優先），
> **指紋檢查照樣保留**——快照萬一取錯版本、或日後有人「順手」把它改成呼叫新 agent，
> 那個警告是唯一會出聲的地方，成本只是一次 `String.includes`。
> 檔頭註解已改寫成引用 S2-19。目前快照尚未建立，`--method legacy` 仍會退回 `aiService.js`
> 並印出「尚未建立」的警告，這是預期行為。

---

## Q2（會影響 A-T13 是否真的能開啟）第 8 條：`FEATURE_PIPELINE` 的注入點需要 `app.js` 配合一行

**背景。** 第 8 條說「旗標讀法：後端在 `GET /api/chapter-whitelist` 之外不另開端點；
前端從 `index.html` 既有的注入點讀（WS-D 決定，但**不得**把 `FEATURE_PIPELINE` 寫死在 JS）」。

`index.html` 既有的注入點只有一個：`<meta name="api-key" content="__API_KEY__">`，
由 `app.js:51-57` 的 `serveIndex()` 做字串替換。

**WS-D 目前的做法（不改介面、不改別人的檔）。** 在 `index.html`（WS-D 的檔案）加一行
語意完全對齊的 `<meta name="feature-pipeline" content="__FEATURE_PIPELINE__">`，
`public/js/review.js` 用與 `config/features.js` 逐字相同的 `parseBool` 讀它。
佔位字串沒被替換掉時 `parseBool('__FEATURE_PIPELINE__') === false`，
也就是「旗標關閉、走舊流程」——安全的預設，且已有單元測試守著。

**需要裁決的是。** `app.js` 不在第 10.1 條的任何一格裡（WS-A 擁有 `server.js`，不是 `app.js`）。
`serveIndex()` 需要多一行：

```js
const key = process.env.API_KEY || '';
const pipeline = process.env.FEATURE_PIPELINE || 'false';     // ← 這一行
res.type('html').send(
    html.replace('__API_KEY__', key).replace('__FEATURE_PIPELINE__', pipeline)   // ← 與這一段
);
```

由誰加？建議 **WS-A**（他在 A-T12 本來就要動 `routes/index.js` 與 `server.js`，
`app.js` 與這兩支是同一層）。在那之前，本機驗收可用 `?pipeline=1` 手動開啟。


> **裁決（S2-20，落地於第 10.1 條）：`app.js` 歸 WS-A，由 WS-A 在 `serveIndex()` 補
> `__FEATURE_PIPELINE__` 的注入。**
>
> **WS-D 不動**：`index.html` 的 `<meta name="feature-pipeline">` 與 `review.js` 的
> `parseBool` 讀法維持原樣。注入合入之前佔位字串會被判成 `false`（＝旗標關閉、走舊流程），
> 這是安全的預設，已有單元測試守著；本機驗收仍可用 `?pipeline=1`。
> 檔頭註解已從「需要有人補」改寫成引用 S2-20。

---

## Q3（會影響 answer golden 的定案）第 4.2 條：`claimed` 抽取規則的「第一個 `$…$`」在真實答案上常常抽到算式

**背景。** 第 4.2 條規定：「`填空`／`計算`：先從 `claimed` 抽 `final_answer`——**第一個 `$…$`**，
沒有就取**最後一個 `=` 之後**的片段」。

**這不是邊緣案例，是常態。** 對 `eval/fixtures/questions.public.json` 的 60 題實測
（45 題走這條規則，單選／多選／證明的 15 題不走），結果是：

| 抽出來的東西 | 題數 |
|---|---:|
| **算式，不是答案** | **39 / 45** |
| 看起來乾淨的值 | 6 / 45 |

而且那 6 題「乾淨」的裡面有 3 題其實抽錯了，錯得比抽到算式更嚴重。兩種失敗長這樣：

**(a) 抽到算式 —— 結果是 `uncertain`，驗不到但不誤報。** 例如 #9：

```
answer_text: "$\vec{a} \cdot \vec{b} = 3 \times 1 + 4 \times 2 = 3 + 8 = 11$。"
抽出：「\vec{a} \cdot \vec{b} = 3 \times 1 + 4 \times 2 = 3 + 8 = 11」
```

比不出有理數，`answerCompare` 回 `uncertain`。verify 節點會為此再採樣一次（多付一次錢），
仍 `uncertain` 就 `fail('answer_mismatch')` 進複核。**39 題全部走這條路，等於解題驗證整段失效。**

**(b) 抽到中間值 —— 結果是 `disagree`，也就是系統性的假警報。** 例如 #13：

```
answer_text: "垂直即內積為 $0$：$2 \times 3 + k \times 6 = 0$，得 $6k = -6$，$k = -1$。"
抽出：「0」          ← 第一個 $…$，是題目條件裡的 0，不是答案
真正的答案：-1
```

驗證模型算出 `-1`，比對器拿到 `0`，兩邊都抽得出來且不相等 → **`disagree`**。
#13、#14、#21 三題都是這個形狀（「垂直即內積為 $0$」這種寫法在向量章非常常見）。
第 4.2 條最後一句寫「任何比不出來的情況都回 `uncertain`，不回 `disagree`」——
這裡的問題是它**比得出來，只是比錯了對象**，那條防線擋不住。

**WS-D 目前的做法（不改介面）。** `eval/golden/answer.json` 的 50 筆裡，
把這種情形標成 `extraction_hazard: true` 並把 `expect.equivalent` 寫成 `uncertain`
（也就是**照介面現在的規則**寫期望值），另外在 `note` 說明。目前有 2 筆。
其餘 48 筆的 `claimed` 都刻意寫成「答案在最前面」的形式，避開這個問題。

**需要裁決的是。** 對 fixture 的 45 題填空／計算實測三條規則
（判準：抽出來的字串本身就是答案；不對抽出來的東西再補一次後處理）：

| 規則 | 定義 | 抽對 |
|---|---|---:|
| **A（現行）** | 第一個 `$…$`，沒有就取最後一個 `=` 之後 | **4 / 45** |
| B | 最後一個 `$…$`（整段） | 8 / 45 |
| **C** | 最後一個 `$…$`；該段含 `=` 就再取 `=` 之後 | **39 / 45** |

**WS-D 的建議是 C。** 中文數學答案的寫法幾乎一定是「過程 = 結論」，
最後一個等號右邊就是答案；把規則從「第一個」改成「最後一個」是這裡唯一的關鍵改動。

C 剩下的 6 題失敗全部可診斷，而且都指向同一件事——**單位不該被寫在 `$…$` 裡**：

```
#32  「$a = \frac{10}{2} = 5$ m/s$^2$」   → 最後一個 $…$ 是「^2」（單位的上標）
#33、#40、#41 同上
#22  「…也就是 $A$ 點的 $x$ 座標。」      → 答案是文字敘述，最後一個 $…$ 是「x」
#45  「$v_{max} = \sqrt{200} \approx 14.1$」→ 用 \approx 而非 =，切不到
```

前四題可由 `answerCompare` 的「單位後綴一律去掉再比」順手解決（把 `$^2$` 這種
只含上下標的片段視為單位的一部分而跳過）；#45 建議把切割符從 `=` 放寬成 `=|\approx`；
#22 是 `answer_form: 'text'`，本來就不該走數值路徑。

裁決之後要一起改的東西：
1. `utils/answerCompare.js`（**WS-C**）的抽取規則；
2. `eval/golden/answer.json` 裡 `extraction_hazard: true` 的那幾筆，`expect` 從 `uncertain` 改回 `agree`；
3. 其餘 48 筆的 `claimed`——它們現在為了不與介面牴觸，全被寫成「答案在最前面」的形式，
   那**不是 fixture 的真實分佈**（45 題裡只有 6 題長那樣）。改規則之後應該改寫成真實寫法，
   golden 才量得到真正的行為。


> **裁決（S2-12，落地於第 4.2 條）：採 C，並加兩項補強。**
> 抽取規則改為「**取最後一個 `$…$`**；該段含 `=` 或 `\approx` 就再取最後一個 `=`／`\approx`
> 之後的片段；**只含上下標的片段（例如單位的 `$^2$`）視為單位的一部分跳過**，往前找上一段；
> 沒有任何 `$…$` 就取整段文字最後一個 `=`／`\approx` 之後」。
> 同時 S2-11 定案：**負號是數值的一部分**（`-1` 與 `1` 判 `disagree`），`±` 只與 `±` 比。
>
> **WS-D 已照辦**（`eval/golden/answer.json` v2）：
> 1. 40 筆的 `claimed` 改回**真實寫法**（過程 = 結論），直接沿用 fixture 的 `answer_text` 原文——
>    舊版為了不與舊規則牴觸而寫成「答案在最前面」，那不是 fixture 的真實分佈。
> 2. `extraction_hazard` 從 2 筆減為 1 筆（`ans-047`），`expect.equivalent` 改回 `agree`
>    的有 47/50 筆。
> 3. 產生腳本內建一份 S2-12 的參考抽取器，**逐筆檢查 `claimed` 抽得到預期的答案，抽不到就拒絕產出**——
>    產生過程中因此抓到兩筆標錯（`ans-045`／`ans-046` 的題目問的是夾角，不是餘弦值）。
> 4. 新增 `test/unit/answerGolden.test.js`：250 個案例對 `utils/answerCompare.js` 全跑一遍。
>    它用一個確定性探針判斷實作在哪一版——已是 S2-12 就硬斷言 250 筆，還是舊規則就印出
>    目前的相符數並 skip，WS-C 更新 `extractFinalAnswer` 之後自動轉成硬斷言。
>
> **仍待 WS-C**：`utils/answerCompare.js` 目前是 S2-12 之前的實作（探針顯示
> `claimed` 的最後一段 `$x = 4$` 抽不到 `4`），250 個案例目前 163 筆相符。

---

## Q4（會影響 `--suite classify` 量到的是不是第二層）第 3.3 條：classify 的 eval 輸入沒有定義

**背景。** 規劃 §3.8 把章節分類拆成兩個數字：「classify 零成本閘門通過率」與
「二層 LLM 用 fixtures 回放 vs golden 100 題」。但第 3.3 條只定義了 classify 的
`input = { subject, chapter, chapter_confidence, question_text }`——那是 **runner 從 extract 的
輸出組出來的**。eval 沒有 extract 的輸出，只有 golden 的正解標籤。

若 eval 把 golden 的正解章節連同高信心一起餵進去，第一層閘門會 100% 命中，
accuracy 恆為 1.0，而第二層 LLM **一次都不會被呼叫**——量到的是「我把答案抄給它然後它抄回來」。

**WS-D 目前的做法（不改介面）。** `--suite classify` 的輸入固定為：

```js
{ subject: <golden 的 subject>,
  chapter: <golden 的 decoy_chapter ?? ''>,   // 刻意不放正解
  chapter_confidence: 0,                      // 刻意讓閘門過不了
  question_text: <golden 的題幹> }
```

`chapter_confidence: 0` 保證第一層必定失敗、第二層必定被觸發。
零成本閘門通過率則改在 `--suite pipeline` 量（那裡的信心值來自真的 extract 輸出）。
suite 另外會斷言「`source='gate'` 的筆數應為 0」，不為 0 就在報表印警告。

**需要裁決的是。** 這個約定要不要寫進第 3.3 條（或第 9 條的 eval 章節）？
如果不寫進去，`agents/classify.js` 的作者完全有理由把「`chapter_confidence` 缺值時視為 1.0」
當成合理的預設，那一改就會讓 classify suite 的數字整個失真，而報表上只會看到 accuracy 變好。


> **裁決（S2-13，落地於第 3.3 條）：維持 WS-D 的做法，並把約定寫進介面。**
> 第 3.3 條的 classify 那一列現在明文寫著：
> 「`chapter_confidence` 缺值或 `0` 一律視為閘門不過，不得當成 1.0」，以及
> 「**eval 的 `--suite classify` 固定餵 `{subject, chapter: decoy 或 '', chapter_confidence: 0, question_text}`
> 且 `ctx.db = null`**，保證量到的是第二層；錄製 cassette 時同樣 `ctx.db = null`（`fewShotIds` 才可重現）」。
>
> **WS-D 已照辦**：輸入不變；`ctx.db` 從「會丟錯的假 db」改成 `null`（S2-8／S2-13），
> 並補上 `ctx.config.features = { similar: false, pipeline: true }`——
> 否則 agent 會先試向量最近鄰再失敗降級，白跑一次。
> 「`source='gate'` 應為 0」的斷言**保留**：那是這條約定有沒有真的生效的唯一訊號。

---

## Q5（會影響公開樣卷能不能進版控）第 10.1 條與根 `.gitignore`：`*.pdf` 擋住 `sample_exam.pdf`

**背景。** 規劃 §5.3.1 明寫「`eval/fixtures/sample_exam.pdf` 一次產好、commit 進 repo
（`.gitignore` 加 `!exam_pro/eval/fixtures/sample_exam.pdf`）」。
但根目錄 `.gitignore` 有一條 `*.pdf`（「大型報告素材」那一段），而 `.gitignore` 是 **S0 的檔案**，
WS-D 不得改。

**WS-D 目前的做法。** 用 `git add -f exam_pro/eval/fixtures/sample_exam.pdf` 加入版控。
檔案一旦被追蹤，`.gitignore` 就不再對它作用，所以功能上沒有問題。

**順帶回報一個已經修掉的問題（不需要裁決，只需要知道）。**
`.gitattributes`（第 10.1 條列為 **WS-D 擁有**）原本有一條 `exam_pro/eval/** text eol=lf`。
它把二進位的 PDF 當成文字，commit 時收掉一個 CRLF，存進去的 blob 比磁碟上少一個位元組——
PDF 的 xref 位移全部作廢，而 `git status` 仍然是乾淨的，只有在別台機器 checkout
之後打開檔案才會發現。已加 `exam_pro/eval/fixtures/*.pdf binary` 修正並重新 add，
blob 的 sha256 現在與 `make_sample_pdf.js` 產出的完全相同。

**需要裁決的是。** 要不要請 S0 在根 `.gitignore` 補一行
`!exam_pro/eval/fixtures/sample_exam.pdf`？
建議補：`git add -f` 是一次性的，下次有人重產樣卷（換字型、加題目）再 `git add`
就會被 `*.pdf` 默默擋掉，而 `git status` 不會顯示它——症狀是 CI 上
`--suite pipeline` 突然找不到檔案。


> **裁決（S2-15）：根 `.gitignore` 加 `!exam_pro/eval/fixtures/*.pdf`（已由 S0 補上）。**
> 樣卷以 **WS-D 的 `eval/fixtures/make_sample_pdf.js` 產出為準**，
> WS-B 的 `scripts/make_sample_exam_pdf.js` 退場；cassette 要對 D 的樣卷重錄。
>
> **WS-D 不用再做什麼**：`git add -f` 的一次性做法從此不需要。
> `.gitattributes` 的 `exam_pro/eval/fixtures/*.pdf binary` 保留——那條修的是
> `text eol=lf` 把 PDF 當文字而少存一個位元組的問題，與 `.gitignore` 無關。

---

## Q6（第二輪新發現，**歸檔時仍待裁決**——追蹤見 `docs/HANDOFF.md` §3）第 4.2 條：選項代號抽取對「B、D」「B.D.」只抽得到第一個

**背景。** 改寫 answer golden 時對已合入的 `utils/answerCompare.js` 實測，發現多選題的
代號抽取在兩種很自然的寫法上只抽得到第一個代號，結果從 `agree` 變成 `disagree`：

| model.final_answer | claimed | 抽出 | 結果 |
|---|---|---|---|
| `(B)(D)` | `(B)(D)。…` | {B,D} | agree ✅ |
| `BD` | `(B)(D)。…` | {B,D} | agree ✅ |
| `B, D` | `(B)(D)。…` | {B,D} | agree ✅ |
| **`B、D`** | `(B)(D)。…` | **{B}** | **disagree ❌** |
| **`B.D.`** | `(B)(D)。…` | **{B}** | **disagree ❌** |

**原因。** `extractOptionCodes()` 是三層由強到弱、**抽到就停**：
括號型 → 標號型（`A.`／`A、`）→ 裸字母。
`B、D` 會被第二層的 `LABELLED_OPTION_RE` 匹配到「`B、`」而回傳 `{B}` 並提早 return，
第三層「整串只剩字母」的完整解讀因此永遠沒有機會執行。`B.D.` 同理。

**為什麼要緊。** `disagree` 會直接變成 `answer_mismatch` 進複核佇列。
這不是漏報而是**誤報**，而且集中在多選題——老師會反覆看到「答案對不上」，
但兩邊其實一模一樣。第 4.2 條的原則是「比不出來回 `uncertain`，不回 `disagree`」，
這裡卻是「比出一半就下結論」。

**WS-D 目前的做法。** `eval/golden/answer.json` 的 `ans-014` 改用已驗證可用的 `B, D`
（半形逗號），並在 `note` 指向本條。**沒有**把 `B、D` 寫成期望 `disagree`——
那等於把一個缺陷寫進 golden 當成正確行為。

**需要裁決的是。** 三個選項：

| 選項 | 改法 | 代價 |
|---|---|---|
| A（建議） | 第二層改成「掃完整串再判斷」：若標號型只抽到 1 個、而整串去掉標點後**全是 A–H 字母**，就改用第三層的結果 | `utils/answerCompare.js` 十行內；WS-C 要加兩個案例 |
| B | 在第二層的分隔字元集合裡把 `、` 與 `.` 也當成「代號之間的分隔」而非「代號的後綴」 | 會讓「`A.` 這種標號」與「`A、B` 這種列舉」的界線變模糊 |
| C | 不改，並在第 4.2 條明文限定合法寫法只有 `(A)`／`A`／`A.`／連寫 | 最省事，但線上遇到 `B、D` 時仍會誤報，只是變成「已知且允許」 |

---

## Q7（已結案）第 4.2 條：250 案例 golden 與實作的 20 筆落差怎麼分責

**背景。** 第二輪合併後 `test/unit/answerGolden.test.js` 的 250 個案例對
已合入的 `utils/answerCompare.js` 有 20 筆不符。問題不是「誰對」，而是
**這 20 筆該由誰改**——golden 往實作靠，還是實作往 golden 靠。

> **裁決（S2-26，落地於第 4.2 條與 §12.1）：golden 是裁判，C 改實作、D 改少數期望。**
>
> 第 4.2 條補齊三段細則：
> - `number` 再加科學記號（`a \times 10^{n}`／`a×10^n`／`2.4e-4`）、
>   `\mathrm{…}`／`\text{…}`／`\,`／`\ ` 與其後的單位整段去掉、
>   `\sqrt{n}`／`\frac{\sqrt{a}}{b}`／`\pi` 這類可數值化的式子算出數值再比（容差 `1e-9`）。
> - `text`：`normalizeStem` 後相等 → `agree`；**不相等一律 `uncertain`，永遠不回 `disagree`**。
> - `expression`：字串相等 → `agree`；否則兩邊都能數值化就照 `number` 比；否則 `uncertain`。
> - **D 只改 `ans-047` 的三個 `eq*` 期望（`uncertain` → `agree`）；其餘由 C 的實作對齊。**
>
> **WS-D 已照辦**（`eval/golden/answer.json` v3）：
> 1. `ans-047` 的 `expect.equivalent` 改成 `agree`，`note` 改寫成引用 S2-26 的三段比法。
>    `extraction_hazard` 因此**全檔歸零**（S2-12 管抽取、S2-26 管比法，兩條合起來沒有剩下的爭議）。
>    欄位保留是為了下一次規則改動時還有地方標。
> 2. `test/unit/answerGolden.test.js` 的探針從「只認 S2-12」擴成「S2-12 + S2-26」。
>    S2-12 已經合入，光認它會讓測試立刻硬斷言而卡在 S2-26 的 18 筆上——
>    那是一片與本次改動無關的紅燈。現在兩條都到位才硬斷言，否則印出相符數與前五筆差異並 skip。
> 3. 「等價寫法互比」那一條同樣要等 S2-26（`ans-047` 的 `\left\right` 版本靠數值比才 agree），
>    也一起 gate 住；另外三條不依賴裁決進度，照舊硬斷言。

**目前的數字（2026-08-23 實測）：232/250 相符，18 筆待 C 對齊。**

| 筆數 | 案例 | 依 S2-26 該怎麼判 | 誰改 |
|---:|---|---|---|
| 1 | `ans-026#eq3` `$5\ \mathrm{m/s^2}$` | 單位整段去掉 → `agree` | C |
| 1 | `ans-027#eq3` `6.0 \times 10^{2}` | 科學記號 → `agree` | C |
| 2 | `ans-035#wrong2`／`ans-036#wrong2` `\frac{\sqrt{3}}{2}` | 根式數值化，兩邊都算得出且不等 → `disagree` | C |
| 5 | `ans-043` 全部 | 科學記號三種寫法 → `agree`／`disagree` | C |
| 1 | `ans-047#eq3` `$\left(\frac{3}{1}\right)$` | expression 去 `\left\right` 後退回數值比 → `agree` | C |
| 5 | `ans-049` 全部 | text 不相等一律 `uncertain`（現在回 `disagree`） | C |
| **3** | **`ans-048` 的三個 `eq*`** | **見下** | **~~待裁決~~ → 已由 S2-27 裁決（2026-08-23，`text` 改「包含」判定，見 `interfaces-stage2.md` §12.1）** |

---

### ⚠️ 附帶發現：照 S2-26 實作之後會是 247/250，不是 250/250

`ans-048` 的三筆在 S2-26 底下**到不了 `agree`**：

```
claimed  「兩向量的內積為零且皆非零向量，故夾角為 $90^\circ$，兩者互相垂直。」
         → normalizeStem → 兩向量的內積為零且皆非零向量,故夾角為90^\circ,兩者互相垂直。
model    「互相垂直」→ normalizeStem → 互相垂直
                                        ↑ 兩者不相等
```

`text` 比的是**整段 `claimed`** 的 `normalizeStem`，而 `claimed` 是一整句說明、
model 只回結論短語，兩者永遠不會相等。依 S2-26「不相等一律 `uncertain`」，
這三筆的正解是 `uncertain`，但 golden 目前寫 `agree`。

**WS-D 沒有自行改它**，因為裁決明講「其餘 17 筆維持 golden 的期望、由 C 的實作對齊」，
而這一筆不屬於「C 對齊得了」的範圍——它是 golden 自己與 S2-26 相牴觸。
`ans-049` 是同一個形狀，那一筆 golden 早就寫 `uncertain`（第一輪就標了 note），
兩筆的期望不一致，本身就是一個訊號。

**三個選項**（改一行就好）：

| 選項 | 做法 | 影響 |
|---|---|---|
| A（建議） | `ans-048` 的 `expect.equivalent` 改成 `uncertain`，與 `ans-049` 一致 | 250/250 可達成。代價是 golden 裡不再有任何一筆 `text` 型的 `agree` 案例——那條路徑等於沒被測到 |
| B | 保留 `agree`，並把 `claimed` 改寫成只有結論的「互相垂直。」 | 250/250 可達成，且 `text` 的 `agree` 路徑有被測到。代價是 `claimed` 不再是真實的答案寫法（真實答案就是一整句） |
| C | 維持現狀，接受 247/250，把這三筆當成「已知且允許的落差」 | 測試永遠不會全綠，硬斷言那條路就一直走不到 |

順帶一提，這三筆也指向一個更大的問題（第一輪 `ans-049` 的 note 已提過）：
**`text` 型答案到底該不該進 verify**。真實答案是整句、model 回的是短語，
兩者在任何字串比法下都不會相等，結果永遠是 `uncertain`——
那 verify 對 `text` 型就只是白花一次呼叫。選項可能是「`answer_form='text'` 一律 `skipped`」。

---

## 附：不是提問，但要通知其他 workstream 的事

> 更新於第二輪合併後（2026-08-22）。前五條是第一輪就有的，第 6–8 條是這一輪跑出來的。

1. **`package.json` 的 `scripts` 由 WS-D 統一維護**，目前多了七支：`check:html`、
   `eval:classify`、`eval:pipeline`、`eval:sample-pdf`、`compare:legacy`、
   `compare:pipeline`、`report:jobs`。
2. **devDependency `pdfkit`** 只給 `eval/fixtures/make_sample_pdf.js` 用，不在 CI 路徑上。
3. **WS-A**：`pipeline/stateMachine.js` 已合入，`eval/lib/stateMachineShim.js` 已自動改用真實作，
   `test/unit/evalPipeline.test.js` 的 15 項狀態機測試現在測的是真的，**全過**。
4. **WS-C**：`utils/normalizeStem.js` 已合入，`test/unit/evalGolden2.test.js` 比對它與
   `scripts/backfill_text_hash.js` 參考實作對 180 段文字的雜湊——**逐位元相同，全過**。
   `eval/golden/dedup.json` 的 16 組 `expect_l0: 'hit'` 也全過。
5. **WS-B**：`eval/cassettes/` 是你的目錄，WS-D 不碰。

---

### 6. ⚠️ WS-B：cassette 要對 **WS-D 的樣卷** 重錄（裁決 S2-15），目前是紅燈

第二輪合併後，`eval/fixtures/sample_exam.pdf` 是 WS-D 產的 **10 題**版本
（S2-15：WS-B 的 `scripts/make_sample_exam_pdf.js` 退場）。但 `eval/cassettes/extract/`
裡的 cassette 還是對舊的 6 題樣卷錄的，鍵對不上。**同一個 key 在三個地方一起紅**：

| 位置 | 症狀 |
|---|---|
| `test/unit/cassetteReplay.test.js`（**WS-B 的檔**） | 「extract：對自製的 sample_exam.pdf 回放出 6 題」→ replay miss，`npm test` 紅燈 |
| `npm run eval:pipeline` | extract 節點 miss，整條管線跑不起來 → 紅燈 |
| `npm run eval:classify` | 90 筆裡 82 筆 miss → 紅燈 |

miss 的 key 都是 `83edf715c659…`（extract）。

**WS-D 已做的事**：把 replay miss 從一般錯誤裡分出來，不再讓它偽裝成模型表現——
`--suite classify` 原本會把 82 筆 miss 算成答錯而印出「accuracy 0.0667」，
現在一律 n/a 並明說是 miss；`--suite pipeline` 的 `reason` 會指名是哪一支 cassette
與「必須對這一份樣卷錄製（S2-15）」。

**WS-B 要做的事**：`npm run eval:record`（需要金鑰）對現在這份 `sample_exam.pdf` 重錄，
並把 `cassetteReplay.test.js` 裡「回放出 6 題」的期望改成 10 題。
classify 的 cassette 也要補到涵蓋 `eval/golden/classify.json` 的 90 筆
（目前只涵蓋 8 筆），否則 `--suite classify` 永遠沒有數字。

### 7. ⚠️ WS-A：`test/integration/jobs.pg.test.js` 有一項還在斷言舊的 `text_hash`（裁決 S2-23）

`approve 入庫：origin=pdf、chapter_src=human、text_hash 與 search_tsv 都有` 目前紅燈：

```
actual   'cad606ec7861adf0954db88bc1729d34a2c342e8d71c97f05a379a30eba1752e'   ← 對修正後的文字重算
expected 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'   ← 沿用 payload 的假值
```

S2-23 已定案「approve 入庫時 `text_hash` **對修正後的 `question_text` 重算**，不沿用 payload 的值——
人改過文字，雜湊就該變；**A 的整合測試據此修正**」。實作已經照做了，測試還沒跟上。
這一項不在 WS-D 的所有權內（S2-2：不得改別人的測試檔），所以留給 WS-A。

### 8. WS-A：`app.js` 的 `__FEATURE_PIPELINE__` 注入尚未合入（裁決 S2-20）

目前 `serveIndex()` 只替換 `__API_KEY__`。在補上之前，前端讀到的是佔位字串、
`parseBool` 判成 `false`＝旗標關閉、走舊流程——這是安全的預設，不是壞掉，
且有單元測試守著。補上之後 WS-D 這邊不需要任何改動。

### 9. 給所有人：`EVAL_FORK_PR` 這個新的 CI 環境變數

`ci.yml` 的 integration job 多了 `EVAL_FORK_PR: ${{ github.event.pull_request.head.repo.fork }}`。
它只影響一件事：fork PR 的 replay miss 降為 warning 而不是紅燈（規劃 §5.3.3、介面第 5.2 條，
「這個判斷不在 `services/llm` 裡」）。判斷本身在 `eval/lib/replayMiss.js`，
比對只到 `--suite ` 為止（裁決 S2-14）。本機與 main 上不設這個變數，miss 一律紅燈。
