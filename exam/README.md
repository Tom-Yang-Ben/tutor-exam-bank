# ⚠️ ARCHIVED — 早期原型（請勿執行）

> 這是本專案**最初的可運作原型**，保留在 repo 中僅供呈現「重構前後對照」。
> **實際要安裝或執行，請一律使用 [`../exam_pro`](../exam_pro)。**

---

## 為什麼保留

它驗證了整套核心流程可行：**上傳考卷 PDF → AI 拆題 → 入庫 → 智慧組卷 → 匯出 Word**。
`exam_pro` 就是以這份程式碼為基礎重構而成，兩者並列可以看出架構演進的過程。

| | `exam`（本目錄） | `exam_pro` |
|---|---|---|
| 架構 | 全部邏輯集中在單一 `server.js`（375 行） | MVC 分層：`config` / `controllers` / `services` / `middleware` / `routes` / `utils` |
| 章節驗證 | 無 | 白名單嚴格驗證（`config/chapters.js`） |
| 存取控制 | 無 | 可選 `x-api-key`（timing-safe）+ CORS 白名單 |
| 速率限制 | 無 | AI 端點限流 |
| 靜態資產 | 直接吐出整個目錄 | 只公開 `public/`，避免原始碼與 `schema.sql` 外洩 |
| 公式轉換 | `temml` | 自製 LaTeX → OOXML 引擎（`utils/textFormatter.js`） |
| 種子資料 | 無 | `seed_questions.js`（30 題自製示範題） |

## 為什麼不要執行

- **缺少 `exam_pro` 已修補的安全防護**：無存取控制、無 CORS 限制、無章節白名單、無速率限制，靜態目錄也會外洩後端檔案。
- 與 `exam_pro` **共用同一個資料庫**（`tutor_exam_bank`）。在這裡執行寫入操作會影響正式資料。
- `clean-db.js` 是當時的一次性資料清理腳本，會**直接改寫題庫內容**，已不再維護。

## 目錄內容

```
exam/
├─ server.js        # 原型主體：7 條路由全部寫在同一支檔案
├─ index.html       # 前端單頁介面
├─ clean-db.js      # ⚠️ 一次性資料清理腳本（會改寫題庫，勿執行）
├─ schema.sql       # 資料表定義（與 exam_pro 的 schema 同源）
└─ .env.example     # 環境變數範本
```
