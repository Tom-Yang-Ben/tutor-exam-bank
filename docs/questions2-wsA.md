# docs/questions2-wsA.md — WS-A（管線核心）對階段 2 凍結介面的提問

> 規則（`docs/interfaces-stage2.md` 開頭）：發現介面有問題就停下來寫在這裡，
> **不自行改介面繞過**。以下每一條都附「我暫時怎麼做」，讓開發者裁決時知道要改哪裡。
> 分支：`ws2-a/pipeline`。

---

## 1. `validateQuestionFields` 的回傳形狀：`error`（現況）vs `errors`（第 4.5 條）

**衝突**：`interfaces-stage2.md` 第 4.5 條把簽名凍結成

```js
function validateQuestionFields(q) {}   // → { ok, errors: string[], value? }
```

但同一條又寫「**從 `controllers/questionController.js:10-25` 原封不動抽出來，行為一字不改**」，
而現況那份回的是**單數字串**：

```js
return { ok: false, error: '學科僅能為「數學」或「物理」！' };   // 不是 errors: [...]
```

`controllers/questionController.js` 的 `updateQuestion` 就是讀 `v.error`
（`res.status(400).json({ message: v.error })`）。兩個要求無法同時滿足。

第 6.6 條的 approve 又寫「`errors` **原樣**來自 `validateQuestionFields`」，
而它的回應範例是陣列：`{ message: '欄位驗證失敗', errors: [ … ] }`。

**我暫時怎麼做**：`utils/questionValidation.js` **同時**回兩個鍵，驗證規則、判斷順序與
訊息文字一字未改：

| 情形 | 回傳 |
|---|---|
| 不通過 | `{ ok:false, error:'<原訊息>', errors:['<原訊息>'] }` |
| 通過 | `{ ok:true, errors:[], value:{…} }` |

- `error` 讓 `questionController` 的既有呼叫點與整合測試完全不受影響。
- `errors` 讓 approve 直接 `errors: v.errors`，符合第 6.6 條的陣列形狀。

**要裁決的**：是否接受「兩個鍵並存」當成第 4.5 條的最終形狀？
若要單一真相，建議改第 4.5 條為 `{ok, error, errors, value?}` 並在文件註明
「`errors` 恆為 `error` 的長度 1 陣列（本函式一次只回一則訊息）」；
若堅持只留 `errors`，則 `questionController.updateQuestion` 要一併改成讀 `v.errors[0]`，
那就不再是「行為一字不改」，需要開發者明示放行。

---

## 2. `test/unit/` 與 `test/integration/` 的所有權跨界

**衝突**：第 10.1 條的所有權表把 `test/unit/` 與 `test/integration/`（controller 以外）
劃給 **WS-D**；但 WS-A 的任務書明確要求 WS-A 自己寫

- `test/unit/stateMachine.test.js`（A-T2 的驗收條件：窮舉 + 性質測試 + 100% 分支覆蓋）
- `test/integration/jobs.pg.test.js`（A-T11／A-T12 的驗收條件）

**我暫時怎麼做**：兩支都由 WS-A 新增，**只新增檔案、不動 WS-D 既有的任何測試檔**。
`test/integration/jobs.pg.test.js` 覆蓋的是 controller 與 runner，落在
「`test/integration/`（controller 以外）歸 WS-D」的**例外**那一側，衝突較小；
`test/unit/stateMachine.test.js` 則確實是踩進 WS-D 的目錄。

**要裁決的**：合併時若 WS-D 也建了同名檔，以 WS-A 的版本為準（狀態機是 WS-A 的驗收條件），
或請在所有權表補一句「各 WS 可在 `test/unit/` 新增**自己擁有的模組**的測試檔」。

---

## 3. 終止性上界：規劃 §3.8 與介面第 2.4 條的數字不同

**差異**（不算衝突，但兩份文件的數字對不起來，怕日後有人照規劃寫測試）：

| 出處 | 上界 |
|---|---|
| `roadmap-plan.md` §3.8 驗收表 | 「任何序列在 **Σ maxRetries + 6** 步內達終態」＝ 5 + 6 = 11 |
| `interfaces-stage2.md` 第 2.4 條 | 「最多 **Σ maxRetries + Σ maxErrorRetries + 6**」＝ 5 + 18 + 6 = 29 |

規劃那份漏算了 `error` 的退避重試（每個節點各 `maxErrorRetries=3`，六個節點共 18 次），
實際最壞路徑是 29 步（測試已具體構造出來並斷言「剛好等於 29」）。

**我暫時怎麼做**：以**凍結介面第 2.4 條的 29** 為準，測試斷言 `worst === 29`。
規劃文件是舊的、且第 2.4 條較嚴謹，無須改動——只在這裡備查。

---

## 4. `POST /api/jobs` 的 413：multer 的預設錯誤不是凍結字串

**問題**：第 6.1 條要求檔案過大時回

```json
413 { "message": "PDF 檔案過大，單次最多 15 MB。" }
```

但 `routes/index.js` 現有的 multer（`limits.fileSize = 15MB`）超限時丟的是
`MulterError('LIMIT_FILE_SIZE')`，會被 `app.js` 的全域錯誤中樞接走，回的是
**500 `{ message: '後端伺服器內部發生未知錯誤' }`**。既有的 `/analyze-pdf` 一直是這個行為。

**我暫時怎麼做**：在 `[WS2-A: jobs]` 區塊內、只給 `POST /api/jobs` 這一條路由包一層
自己的 multer 錯誤處理中介軟體，把 `LIMIT_FILE_SIZE` 轉成第 6.1 條的 413 字串，
`app.js` 與 `/analyze-pdf` 完全不動（不是我擁有的檔案，且舊行為是既有測試的契約）。

**要裁決的**：`/analyze-pdf` 是否也該一併改成 413？（那是共用檔 `app.js` 或
`aiController` 的改動，不在 WS-A 的所有權內，所以我沒有動。）

---

## 5. `GET /api/jobs/:id` 的 `counts.pending` 與 `jobs.state='queued'` 的空窗期

**問題**（實作上的釐清，不需要改介面）：第 6.2 條寫
「四個 counts 相加 = 該 job 的 `job_questions` 總數」。job 剛建立、extract 還沒跑完時
**一列 `job_questions` 都還沒有**，四個 counts 全是 0，前端會看到「處理中 0 題」。

**我暫時怎麼做**：照字面實作（全 0），不自己補一個假的 pending；
`state` 欄位（`queued`／`extracting`）已經足夠讓前端顯示「拆題中」。
在此備查，免得 WS-D 接前端時以為是 bug。
