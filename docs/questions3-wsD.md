# docs/questions3-wsD.md — WS-D（前端／eval／CI）對階段 3 凍結介面的疑問與備註

> 分支 `ws3-d/frontend`。對應 `docs/interfaces-stage3.md`（第 1、3、6、7、8 條）與
> `docs/stage3-parallel-prompts.md` §2 的 WS-D 提示詞。
>
> **本檔沒有任何一條是自行修改介面繞過**。所有實作都照凍結的簽名與字串做；
> 下面第 1–4 條是「介面沒有規定、我做了決定」的地方（做法與理由都寫清楚，供開發者本人裁決是否要寫回介面），
> 第 5–8 條是需要開發者本人拍板的疑問，第 9–11 條是給其他 workstream 的備註。

---

## A. 介面沒規定、WS-D 自行決定的部分（請確認要不要寫回介面）

### 1. 兩個 module 之間用 CustomEvent，不互相 import、不加 `window.ExamApp` 的鍵

第 7.1 條把 `window.ExamApp` 的鍵**逐一凍結**成十個（階段 2 五個 + 階段 3 五個）。
但 P-05 要求「最近錯題每列『找相似／出變式』按鈕（**呼叫 variants.js**）」，
而 `students.js` 與 `variants.js` 是兩個獨立的 module，彼此看不到對方。

三個選項與取捨：

| 做法 | 問題 |
|---|---|
| `students.js` 直接 `import { open } from './variants.js'` | 兩個檔就沒辦法各自用 `data:` URL 載入做單元測試（相對路徑解析不了，`test/unit/publicAssets.test.js` 既有那一招會失效）；而且 `FEATURE_VARIANTS` 關閉時 `variants.js` 仍會被載入 |
| `variants.js` 自己掛 `window.ExamApp.variants = {…}` | 等於在第 7.1 條的凍結清單上多加第十一個鍵 |
| **CustomEvent**（採用） | 零耦合、兩個檔都能單獨測、旗標關閉時另一邊也不受影響 |

實作（兩邊各自宣告同一個字串常數，`test/unit/stage3Ui.test.js` 有一項在釘「兩邊一致」）：

```js
// students.js 發、variants.js 收
export const VARIANT_EVENT = 'examapp:variant-request';
// detail 的形狀
{ action: 'similar' | 'variant',    // 找相似 / 出變式
  question_id: number,              // 藍本題號
  student_id: number | null,        // 目前選到的學生（排除他寫過的題）
  chapter: string | null,
  question_text: string }

// index.html 的「立即批改」發、students.js 收（detail 為空）
export const GRADE_EVENT = 'examapp:grade-paper';
```

`GRADE_EVENT` 刻意**不帶資料**：`paper_id` 與 `student_name` 一律由 `students.js` 從
`ExamApp.getPaperCache()` 讀——那正是裁決 S3-19 讓 `getPaperCache` 存在的理由。

另外，`students.js` 畫的兩顆按鈕帶 `data-variant-action` 屬性，`variants.js` 在輪詢期間
用它一次停用畫面上所有會送請求的按鈕（第 3.2 條「雙擊不該付兩次錢」的前端那一半）。

**要裁決的**：這兩個事件名與 detail 形狀要不要寫進 `interfaces-stage3.md` 第 7 條？
目前只有 WS-D 擁有的三個檔會用到，沒有跨 workstream 的影響。

### 2. `<section id="nlq">` 放在 `#library` 正上方

第 7.2 條第 3 列說三個空錨點放在「`<section id="review">` 附近」，
規劃 §4.3.5 的表格則說 NL 查題框在「`index.html:539-541` 搜尋框旁」——兩者位置不同。

採用：DOM 順序為 `#review` → `#students` → `#variants` → `#nlq` → `#library`。
`#nlq` 緊貼在題庫管理上方，視覺上就是「搜尋框旁」，同時仍然滿足第 7.2 條
「只插三個空錨點、內容全部由 module 建立」。若要嚴格照規劃把輸入框塞進
`#library` 的篩選列裡，就必須在 `index.html` 的篩選 grid 內多開一個插入點——
那會變成**第六個**插入點，而第 7.2 條寫的是「只有這五處」。

### 3. `index.html` 的 inline script 自己有一份 `parseBool`

第 7.2 條要求三個 module 的 `parseBool` 與 `config/features.js` **逐字相同**。
但「立即批改」按鈕要不要出現，也得看 `FEATURE_STUDENTS`——那段判斷在 inline script 裡，
而 inline script 不是 module，拿不到 `public/js/*.js` 匯出的 `parseBool`。

採用：inline script 加一支四行的 `featureOn(name)`，規則字串與 `config/features.js` 逐字相同
（`v === '1' || v === 'true'`）。`eval/tools/check_html.js` 已加一條斷言在守這件事。
這樣「按了跳不到任何地方的按鈕」不會出現在畫面上。

**要裁決的**：這是全案第四份同樣的規則（後端一份、三個 module 各一份、inline 一份）。
可接受，或要改成別的做法？

### 4. `variants.js` 每一輪多打一支 `GET /api/jobs/:id/questions`

第 3.2 條只說「每 2 秒輪詢 `GET /api/jobs/:id`，最多 60 秒」，而 P-13 要求
「**每題**狀態 chip（生成中／檢查中／待核准／已入庫／失敗+原因）」。
`GET /api/jobs/:id` 只回四個 `counts`，回不出每一題的 `state` 與 `review_reason`。

採用：每一輪同時打 `GET /api/jobs/:id`（整體狀態與**實際** `cost_usd`）與
`GET /api/jobs/:id/questions?limit=20`（每題的 chip）。兩支都是階段 2 凍結的唯讀端點
（`interfaces-stage2.md` 第 6.2、6.3 條），形狀沒有任何改動。
第二支失敗時只是那一輪畫不出 chip，不影響輪詢本身。

---

## B. 需要開發者本人拍板的疑問

### 5. 「出變式」的 `count` 與 `difficulty_delta` 要不要讓老師選？

第 3 條的預設是 `count: 1`、`difficulty_delta: 0`，上限 `VARIANT_MAX_PER_REQUEST=3`。
目前前端**寫死送 `count: 2, difficulty_delta: 0`**，理由是第 8.3 條的 `gate_pass_rate`
定義就是「30 藍本 × 2 題 = 60 次生成」，前端與 eval 用同一個數字比較好對帳。

但這是產品決定不是技術決定：老師實際上想不想要「難度 +1 的變式」？
要的話 UI 要多兩個下拉（數量 1~3、難度 −1/0/+1）。**待裁決**。

### 6. 「找相似」的旗標：`FEATURE_SIMILAR` 沒有 `<meta>` 注入點

第 7.2 條只注入三個新旗標（`feature-students|nlq|variants`），
但「找相似」打的是階段 1 的 `GET /api/questions/:id/similar`，它由 `FEATURE_SIMILAR` 控制，
而那個旗標**沒有**被注入到前端。

目前的處理：兩顆按鈕（找相似／出變式）一起由 `feature-variants` 控制；
`/similar` 回 404 時顯示「找不到這一題，或 FEATURE_SIMILAR 未開啟（路由不掛載時同樣回 404）」。
這是誠實的，但不精確——`FEATURE_SIMILAR` 開著而 `FEATURE_VARIANTS` 關著時，
「找相似」明明可用卻不會出現。

**待裁決**：要不要加第四個 `<meta name="feature-similar">`（app.js 多一個 `replaceAll`，WS-A）？
若要，第 7.2、7.3 條要一起改。

### 7. 弱點面板的 `days` 下拉沒有凍結的選項清單

第 1.5 條凍結了 `days` 的合法範圍（1~365，預設 90）但沒說前端要給哪些選項。
目前給 `30 / 90 / 180 / 365` 四個。若老師實際上習慣看「這學期」「上個月」，
這四個值要換。**待回饋**（人工 lane 第 2 週試用時一併決定）。

### 8. `PATCH /api/papers/:id/results` 的 100 筆上限在 UI 上碰不到

第 1.4 條的 `results 最多 100 筆。`；而 `generatePaper` 的 `MAX_QUESTIONS` 是 50
（`controllers/examController.js:4`），所以一張卷最多 50 題，改滿也只有 50 筆。
前端仍然擋了（超過就顯示「一次最多儲存 100 筆批改」而不是偷偷分批送，
分批會破壞「全有全無」）。**只是備註，不需要裁決。**

---

## C. 給其他 workstream 的備註

### 9. 給 WS-C（nlq）與 WS-B（variant）：suite 的匯出名稱與 `run.js` 的替身

`eval/run.js` 已經接好 `--suite nlq` 與 `--suite variant`，用**惰性 require**：

```js
eval/lib/suiteNlq.js      →  module.exports = { runNlqSuite };      // 簽名 (args) => Promise<res>
eval/lib/suiteVariant.js  →  module.exports = { runVariantSuite };
```

- 檔案還沒合入時，`run.js` 回一個「全部 n/a」的替身，並印
  `nlq suite 的分數全部 n/a：./lib/suiteNlq.js 尚未合入（擁有者：WS-C）。`
  CI 的兩步因此現在就是綠的，你們合入之後同一行指令會自動改跑真的。
- 替身的 `meta.sources.anyStub = true`，所以 `--write-baseline` 會被 `runStage2Suite` 擋下來。
  你們的 suite 合入後**記得把 `meta.sources.anyStub` 設成 `false`**，否則永遠寫不了門檻初值。
- 回傳物件除了第 8.1 條的必要鍵之外，可以多一個 `extra`（自由格式的物件）：
  報表會把它印在「只報告、不設門檻的數字」那一段。第 8.3 條的每題 `cost_usd` 與
  各閘門通過數放這裡（放進 `measured` 會被 ratchet 當成門檻＝反向門檻）。
- `eval/thresholds.json` 的 `nlq`／`variant` 兩節已建好、值全是 `null`（只報告不擋）。
  `SUITE_METRICS` 的欄與指標名逐字照第 8.2、8.3 條，`test/unit/evalStage3.test.js` 在釘。

### 10. 給 WS-A：`app.js` 的三個 `replaceAll` 還沒合入

`public/index.html` 的三個 `<meta>` 目前是佔位字串 `__FEATURE_STUDENTS__` 等。
在第 7.3 條的三行 `replaceAll` 合入之前，`parseBool` 會判成 `false`＝三個分頁都不渲染
（這是安全預設，不是壞掉）。本機驗收可用 `?students=1&nlq=1&variants=1&mock=1`。

另外，`GET /api/students` 的下拉會顯示「姓名（N 卷，已批 X%）」，
姓名另外存在 `option.dataset.name`——**請確認 `graded_ratio` 在沒有 attempts 時回 `0` 而不是 `null`**
（第 1.1 條寫的是 `0`），否則會顯示成「已批 —」。

### 11. 給全部：`test/e2e/` 是新的一層，不在 `npm test` 裡

```bash
npm run test:e2e     # 需要 TEST_DATABASE_URL；本機沒設會整層 skip
```

- 兩條端到端在 `test/e2e/`，CI 的 `integration` job 排在整合測試之後跑。
- **它們會 `TRUNCATE job_events, job_questions, jobs`**，跑之前確認沒有別的 runner 指著測試庫。
- 它們**不會**動 `questions` 全表：只刪自己插進去的題（`[E2E-WORD]` 記號）與
  `origin='pdf'` 且沒有任何 `attempts` 指著的殘留題。
- `LLM_MODE` 不是 `replay` 時 `pipeline.e2e.test.js` 會直接丟錯，不會靜默改打 Gemini。
