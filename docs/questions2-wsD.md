# docs/questions2-wsD.md —— WS-D（評估與前端）對階段 2 凍結介面的提問

> 規則（`docs/interfaces-stage2.md` 檔頭）：任何 workstream **不得修改**凍結介面。
> 實作時發現介面有問題就寫在這裡，由開發者本人裁決後統一改 `interfaces-stage2.md`
> 並通知四條 WS「第 N 條已更新為 …，請 rebase 後對齊」。
>
> **狀態：五則全部待裁決（2026-08-22 提出，第一輪 WS-D 交付時）。**
> 每一則都寫了「WS-D 目前的做法」——都是不改介面就能繼續往下做的暫行方案，
> 沒有任何一則卡住交付。裁決之後若與暫行方案不同，改的是 WS-D 的檔案。

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

---

## 附：不是提問，但要通知其他 workstream 的事

1. **`package.json` 的 `scripts` 已由 WS-D 加了七支**：`check:html`、`eval:classify`、
   `eval:pipeline`、`eval:sample-pdf`、`compare:legacy`、`compare:pipeline`、`report:jobs`。
   其中 `report:jobs` 指向 `scripts/report_jobs.js`（**WS-A 的 A-T15**，檔案尚未存在）。
2. **新的 devDependency：`pdfkit`**，只給 `eval/fixtures/make_sample_pdf.js` 用，不在 CI 路徑上。
3. **WS-A**：`pipeline/stateMachine.js` 合入後，`eval/lib/stateMachineShim.js` 會自動改用真實作，
   `test/unit/evalPipeline.test.js` 的 15 項狀態機測試也會跟著改測真的。兩者行為若有出入，
   那 15 項會第一個轉紅——請不要把它當成 eval 壞掉。
4. **WS-C**：`utils/normalizeStem.js` 合入後，`test/unit/evalGolden2.test.js` 會比對
   它與 `scripts/backfill_text_hash.js` 參考實作對 180 段文字的雜湊是否逐位元相同。
   `eval/golden/dedup.json` 的 16 組 `expect_l0: 'hit'` 也全部靠這個實作，
   規則一改那 16 組就會轉紅——那是刻意的（規則一改，全庫 `text_hash` 作廢）。
5. **WS-B**：`eval/cassettes/` 是你的目錄。`--suite classify` 會用 `LLM_MODE=replay` 讀它；
   在 cassette 錄好之前 suite 印 n/a、不擋 CI。錄好之後 replay miss 會直接讓 CI 那一步失敗
   （第 5.2 條的訊息是凍結的，WS-D 不會攔截或改寫它）。
