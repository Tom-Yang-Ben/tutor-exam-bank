# docs/questions-wsA.md — WS-A 對凍結介面的疑問與待裁決事項

> 依 `docs/stage1-parallel-prompts.md` 的硬規則第 2 條：實作 D-D3／D-D4／E-X9b 期間發現的
> 介面問題寫在這裡，**沒有自行改 `docs/interfaces.md` 繞過**。
> 下列每一條都標了「是否已阻擋實作」——目前**沒有任何一條阻擋**，全部照凍結介面實作完成。

---

## Q1（介面內部不一致，不阻擋）`config/db.js` 的 `DB_*` 退路與第 9 條的 `DB_*` 定義互相衝突

- 第 8 條：「連線來源：`DATABASE_URL`（存在時優先），否則以 `DB_HOST`／`DB_PORT`／`DB_USER`／`DB_PASSWORD`／`DB_NAME` 組出。」
- 第 9 條：`DB_HOST` 等五個變數的說明是「**舊 MySQL**，遷移期間保留」，`.env.example` 裡 `DB_PORT=3306`、`DB_USER=root`。

兩條合起來會得到一個危險的預設行為：只要有人忘了設 `DATABASE_URL`，`config/db.js` 就會**拿 MySQL 的埠與帳號去連 PostgreSQL**，
症狀是難以理解的連線錯誤（或更糟，連上另一個服務）。

**目前的處理**：照第 8 條實作退路，但把退路的**預設值**改成 PostgreSQL 的值（`5442` / `exam` / `exam`），
並在 `config/db.js` 加註解要求一律設定 `DATABASE_URL`。真正的行為差異只在「`DATABASE_URL` 沒設且 `DB_*` 也沒設」時才看得到。

**請裁決**：D-X1 之後 `DB_*` 會整組移除，屆時第 8 條的退路是否也一併刪掉、只留 `DATABASE_URL`？
若要保留退路，建議第 9 條另開一組不會撞名的變數（例如 `PG_HOST`／`PG_PORT`），或明講退路只在 `DB_PORT` 非 3306 時生效。

---

## Q2（介面未涵蓋，已自行決定，請確認）`deleteQuestion` 的完整回應形狀

第 6 條凍結的是 `/similar`，第 7 條凍結的是 `/generate-paper`；`DELETE /api/questions/:id` 的回應形狀
只在 §1.5 裁決 1 與規劃 §4.3.1 出現一句「回 `{archived:true}`」，沒有凍結其餘鍵。

**目前的實作**（沿用舊版的鍵名，只多一個 `archived`）：

| 情境 | 狀態 | 回應 |
|---|---|---|
| 有 `attempts` 紀錄 | 200 | `{ message: '該題已有學生作答紀錄，改為封存（不再出現在題庫與組卷候選中）。', id, archived: true }` |
| 沒有紀錄 | 200 | `{ message: '題目已刪除！', id }`（**不帶** `archived` 鍵） |
| 找不到或已封存 | 404 | `{ message: '找不到該題目' }` |

前端 `public/index.html` 目前只讀 `message`，因此相容。若之後要在 UI 上把「封存」與「刪除」分開顯示，
請把上表補進 `interfaces.md` 再改。

---

## Q3（介面未涵蓋，已自行決定，請 WS-C 對齊）`config/features.js` 的匯出形狀

第 9 條只說「所有 `FEATURE_*` 集中在 `config/features.js`，預設全關」與布林解讀規則，沒有凍結匯出形狀。
WS-C 的 `/similar` 要讀 `FEATURE_SIMILAR`，所以這裡先定一版：

```js
const features = require('../config/features');
features.FEATURE_SIMILAR         // boolean（getter，即時讀 process.env）
features.FEATURE_HYBRID_SEARCH   // boolean
features.isEnabled('FEATURE_XXX')// boolean，任意旗標
features.parseBool(value)        // 凍結的解讀規則：'1' 或 'true'（不分大小寫）為真
```

**刻意用 getter 而不是在 require 當下取值**：`routes/index.js` 的 require 時機早於某些測試設定環境變數，
先讀先錯。若 WS-C 需要別的形狀，請在合入前提出。

---

## Q4（實作解讀，請確認）「所有候選池加 `archived_at IS NULL`」的邊界

裁決文字是「所有候選池（`generatePaper`、`similar`、hybrid、few-shot）一律加 `archived_at IS NULL`」。
WS-A 這一側把它套用到下列位置，其中前三項不在原文的列舉裡：

| 位置 | 是否排除已封存 | 理由 |
|---|---|---|
| `generatePaper` 候選池 | ✅ 排除 | 原文明列 |
| `listQuestions` | ✅ 排除 | 封存＝對使用者而言已刪除；不排除的話「刪除」在 UI 上看起來沒生效，也與兩個 VIEW 的定義不一致 |
| `getChapters` | ✅ 排除 | 它是前端章節下拉的來源，整章都被封存時不該還出現在選單裡 |
| `updateQuestion` | ✅ 排除（改不到就 404） | 使用者看不到的題目不該還能被編輯 |
| `audit_formulas.js` / `fix_formulas.js` | ✅ 排除 | 健檢／修正已封存的題沒有意義 |
| **`wordController.downloadWord`** | ❌ **不排除** | 這是「重印一張已經出過的試卷」，題目事後被封存時仍要印得出來，否則舊卷會突然少幾題 |

最後一列是唯一的例外，也是最需要確認的一項。

---

## Q5（不是介面問題，但會影響 WS-D 的 D-C1）Node 24 在 Windows 上 `node --test <目錄>` 會失敗

`docs/stage1-parallel-prompts.md` 給 WS-D 的第 1 項是「`npm test` 改為 `node --test test/unit/`」。
在本機（Node v24.15.0 / Windows 11）實測，**傳目錄會失敗**——node 會把目錄本身當成模組去 `require`：

```
Error: Cannot find module 'C:\...\exam_pro\test\integration'
✖ test\integration  'test failed'
```

`test/integration`、`test\integration`、`test/integration/` 三種寫法都一樣失敗；改成 glob 就正常：

```bash
node --test "test/unit/**/*.test.js"
```

WS-A 的整合測試因此在 README 與檔頭註解都寫 glob 形式。**請 WS-D 在寫 `npm test` 與 CI 指令時直接用 glob**，
否則 CI 在 windows runner 上會紅、在 ubuntu 上卻是綠的。

---

## Q6（防呆的邊界，提醒）`npm test` 不連 DB 的保證條件

整合測試的唯一開關是 `process.env.TEST_DATABASE_URL`（本檔**刻意不 `require('dotenv')`**），
所以 `npm test` 預設一定 skip。但如果有人把 `TEST_DATABASE_URL` **export 到 shell 環境變數**裡，
`npm test` 就會連上那個資料庫（庫名仍受 `_test` 後綴防呆保護，打不到真題庫）。

**請 WS-D 在 CI 的 unit job 明確不要設定 `TEST_DATABASE_URL`**，integration job 才設。
若要更嚴格，可以再加一個 `RUN_INTEGRATION=1` 的第二道開關——但那會偏離
`stage1-parallel-prompts.md`「只讀 `TEST_DATABASE_URL`」的字面規定，所以先不做，等裁決。

---

## Q7（版控衛生，提醒開發者本人）`NOTICE` 的第三方套件清單尚未跟上

`NOTICE` 底部的「第三方相依套件」列了 `mysql2 (MIT)`，但沒有列 S0 加入的 `pg (MIT)`，
也沒有 WS-A 這次加入的 `supertest (MIT, devDependency)`。`NOTICE` 不在 `docs/interfaces.md` 第 10.1 的
所有權表裡，WS-A 沒有動它——請開發者本人在合併時補上這三筆（`mysql2` 要到 D-X1 才刪）。
