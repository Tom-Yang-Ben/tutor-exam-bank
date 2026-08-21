# docs/questions-wsC.md — WS-C 對凍結介面的疑問與暫行處置

> 規則：`docs/interfaces.md` 不得由 WS 修改。實作時發現介面有問題就寫在這裡，由開發者本人裁決後
> 統一改 `interfaces.md` 並通知四條 WS。以下每一題都附「我先怎麼做」，程式碼**不繞過**介面，
> 只在介面沒寫到的地方做了可回退的選擇。
>
> **狀態：全部結案（2026-08-21）。** 第一輪裁決已寫進 `docs/interfaces.md`（裁決 17–21、24），
> 每一條下方的「**裁決**」就是最終結論；程式碼與測試已對齊，不需要再讀「我先怎麼做」那段來猜。

---

## 1.（第 2 條）`dict.txt.big` 並不隨附在 `@node-rs/jieba` 裡

**介面怎麼寫**：「實作：`@node-rs/jieba`（win32 有預編譯 napi）+ **`dict.txt.big` 繁體詞典**」。

**實際狀況**：`@node-rs/jieba@2.0.2` 只隨附簡體的 `dict.txt`（349,045 行，含「學」的詞條只有 1 條）。
`dict.txt.big` 是 jieba 上游倉庫裡的另一個檔（約 8.5 MB），npm 套件沒有帶，也沒有現成的 npm 套件提供它。
要用它只有三條路，各有代價：

| 做法 | 代價 |
|---|---|
| 把 8.5 MB 詞典 commit 進 repo | repo 體積、`NOTICE` 要加一段第三方資料來源（jieba, MIT） |
| `postinstall` 下載 | `npm ci` 要連外網；CI 與離線環境會壞 |
| 不用大詞典，改以自訂詞補足 | 繁體長詞的切分靠 HMM，少數詞會切錯 |

**我先怎麼做**：走第三條，並把差距補起來——
內建 `dict.txt` + `config/chapters.js` 全部章節名（含拆出的子詞）+ `utils/tokenize.js` 內手寫的
約 240 個高中數理繁體名詞。實測「作圓/周運動」「求外/接圓半徑」「克拉/瑪/公式」這幾個原本會切錯的
都已正確。另留 `JIEBA_DICT_BIG` 環境變數：指到本機的 `dict.txt.big` 就會額外載入，**預設不啟用**
（本機有、CI 沒有的話，同一題兩邊會切出不同 token，寫入與查詢就不一致，這比切錯詞更糟）。

**裁決（17，已結案）**：接受現況——`interfaces.md` 第 2 條改為「`dict.txt.big` 為選用：不進版控、
不 postinstall 下載，`JIEBA_DICT_BIG` 指到本機檔案時才載入，預設不啟用」。**程式碼不需要改**。

---

## 2.（第 5、6 條）`buildHybridQuery` 沒有「只跑單側」的參數，但 `/similar` 要 `mode=vector|keyword`

**介面怎麼寫**：第 5 條的 `mode` 是 `'rrf'|'weighted'`（融合方式）；第 6 條的 `/similar` 另有
`mode = hybrid|vector|keyword`（要不要跑某一側）。兩個 `mode` 是不同維度的東西，
而第 5 條的參數表裡沒有可以關掉單側的欄位。

`mode=vector` 還可以用「傳空的 `queryTokens`」達成（關鍵字側自然空集合），
但 `mode=keyword` **沒有辦法**——`queryVector` 是必填且長度必須等於 768。

**我先怎麼做**：`buildHybridQuery` 多收一個**選用**參數 `sides`（預設 `['vec','kw']`），
沒傳就跟原本完全一樣；`/similar` 的 `mode=vector` 傳 `['vec']`、`mode=keyword` 傳 `['kw']`。
既有參數的名稱、型別、預設值與結果集欄位都沒動。

**裁決（18，已結案）**：`sides` 正式寫進 `interfaces.md` 第 5 條（選用、預設 `['vec','kw']`）。
**程式碼不需要改**；WS-D 的 `eval/lib/pgEngine.js` 可直接用它跑純向量欄。

---

## 3.（第 6 條）`scope=all` 無法用同一段 SQL 表達

**介面怎麼寫**：第 5 條 `subject` 是「必填」，第 6 條的 `scope` 卻有 `all`（跨學科）。

**我先怎麼做**：`scope=all` 時逐學科（`config/chapters.js` 的 `SUBJECTS`）各跑一次同一段 SQL，
再依 `score DESC, id ASC` 合併取前 k。缺點誠實說明：RRF 的分數是「該次查詢候選池內的名次」，
兩次查詢的分數嚴格說不可直接比較，因此跨學科的排序只是近似（同分時以 id 決定，結果仍是確定性的）。

**裁決（19，已結案）**：從 `/similar` **拿掉 `scope=all`**，給 `all` 回 400。
已刪掉逐學科合併的那段程式（`findSimilar` 現在永遠只跑一次 SQL，SQL 的順序就是最終順序）、
刪掉對應的整合測試，並補上「`scope=all` → 400」的單元與 HTTP 測試。
`parseSimilarQuery` 與 `findSimilar` 兩個入口都擋，直接呼叫 `findSimilar` 的程式也不會悄悄降級成 `subject`。

---

## 4.（第 6 條）`difficulty_delta` 是「鎖定一個難度」還是「以它為中心 ±1」？

**介面怎麼寫**：「給了則目標難度 = 來源難度 + delta（夾在 1~5）；未給則 ±1」。

**我先怎麼做**：照字面實作成**鎖定單一難度**（`difficultyMin = difficultyMax = clamp(來源+delta)`），
因為「未給則 ±1」這句反過來說明了「給了就不是 ±1」。

**裁決（20，已結案）**：維持字面語意（鎖定單一難度），階段 3 依實際使用再調。**程式碼不需要改**。

---

## 5.（第 9 條）新增了兩個環境變數，都有安全的預設值

`.env.example` 我沒有改（依規則）。這兩個變數不加也能正常運作：

| 變數 | 預設 | 用途 |
|---|---|---|
| `EMBED_FIXTURE_DIR` | `exam_pro/eval/fixtures` | fixture 向量檔的目錄。單元測試靠它把 fixture 寫到系統暫存目錄，不碰 repo 的 `eval/` |
| `JIEBA_DICT_BIG` | 未設定（不啟用） | 見第 1 題。指到本機 `dict.txt.big` 的路徑時額外載入 |

**裁決（已結案）**：兩個變數都已由開發者本人加進 `.env.example`。**程式碼不需要改**。

---

## 6.（第 8 條）`config/db.js` 目前仍是 mysql2，而它與 pg 版長得很像

`mysql2` 的 pool 同樣有 `.query()` 與 `.pool`，所以「有沒有切到 pg」不能只看這兩個屬性——
`embedService` 與 `retrievalService` 改成認 pg 專有的 `pool.connect()`，否則在 D-D3 合入前
會一路跑到「連不上 MySQL」那種完全看不懂的錯誤。

**裁決（已結案）**：D-D3 已合入 main，`config/db.js` 現在就是 `{ pool, query }`，這段保護自動生效
（多留著也沒有壞處：它同時擋掉「有人把別的 pool 注進來」）。`{ db }` 注入維持可用，
整合測試就是靠它打 `postgres_test`。

---

## 7.（第 10.1 條）我碰到的共用檔與新目錄，請確認可接受

- `routes/index.js`：只在 `// ===== [WS-C: retrieval] =====` 區塊內 append 了 7 行。
- `package.json`：只加 `dependencies` 的 `@node-rs/jieba`、`pgvector`（沒有動 `scripts`）。
- 新目錄 `test/unit/`（WS-D 的搬遷目的地）與 `test/integration/`（WS-D 擁有，controller 以外）：
  我各放了自己的新檔（`test/unit/{tokenize,embedText,llmEmbed,embedService,hybridQuery}.test.js`、
  `test/integration/hybrid.pg.test.js`），沒有動任何既有檔。若你希望 WS-C 的測試改放別處，我照做。
- `NOTICE` 的第三方套件清單建議補上 `@node-rs/jieba (MIT)` 與 `pgvector (MIT)`——那個檔不在
  所有權表裡，我沒有動它。

**裁決（已結案）**：全部接受；`NOTICE` 已由開發者本人補齊。測試檔維持放在
`test/unit/` 與 `test/integration/`。

---

## 8.（給 WS-D 的提醒，不是介面問題）Node 24 上 `node --test test/unit/` 不能用

規劃 §5.3.1 把 `npm test` 定為 `node --test test/unit/`。這台開發機的 Node 是 v24.15.0，
實測把「目錄」傳給 `--test` 會被當成模組去解析：

```
node --test test/unit                → Error: Cannot find module …\test\unit
node --test ./test/unit              → 同上
node --test "test/unit/*.test.js"    → 正常
node --test                          → 正常（自動遞迴搜尋，目前 138 項）
```

（在 ASCII 路徑下也重現得到，與專案路徑含中文無關。）`scripts` 由 WS-D 統一，所以我沒有動
`package.json` 的 `scripts`；請把 `test` 改成 glob 形式，或維持現在無參數的 `node --test`。
CI 矩陣若含 Node 22，請一併確認該版本的行為。

順帶一提：無參數的 `node --test` 會連 `test/integration/` 一起搜到，我的整合測試因此設計成
「沒有 `TEST_DATABASE_URL` 就整組 skip」，且**不呼叫 `dotenv.config()`**——這樣 `npm test` 才會
維持不連 DB。WS-D 若把整合測試改成會自己讀 `.env`，這條保證就會破掉。

**裁決（24，已結案）**：`npm test` 改為 `node --test "test/unit/**/*.test.js"`，規劃裡
`node --test test/unit/` 的寫法作廢。
