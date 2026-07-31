# 期中專案 · 家教專用數學物理題庫系統

> AIPE 課程期中專題。以 AI 協助家教老師「上傳考卷 → 自動拆題入庫 → 智慧組卷 → 匯出 Word 考卷」，減少人工出題與重複出題的負擔。

本 repo 收錄專題的**完整開發歷程**:從早期原型、企業級重構版，到開發紀實簡報。

> ⚖️ 本 repo 不含任何題庫或考卷內容；程式碼採 Apache-2.0，示範題為自行編寫。詳見 [`NOTICE`](./NOTICE)。

---

## 🎯 問題背景與設計目標

**使用者**：一對一數理家教老師（高中數學／物理），手上有大量歷屆考卷 PDF，需要為每位學生客製特訓卷。

**痛點**：出卷的行政損耗遠大於教學本身。複雜公式（直式分數、根式、幾何圖）在 Word 手動排版容易跑位；題目散在各份考卷裡，哪個學生寫過哪題無從追蹤，重複出題傷害練習效果。一份特訓卷常花 **2 小時以上**。

**目標**：出一份卷從 2 小時縮短到幾分鐘，把心力留給一對一指導本身。

**關鍵約束**：

- 交付物必須是 **Word 原生方程式**的 `.docx`——學生端用紙本，公式得是直式分數而非斜線，因此自製 LaTeX → OOXML 轉換而非貼圖。
- AI 拆題的輸出格式必須可控（章節名、LaTeX 語法不能自由發揮），以白名單驗證收斂。
- AI 呼叫需限流以控制成本。

**成功標準**：上傳 PDF → 自動拆題入庫 → 選學生一鍵組卷 → 匯出可直接列印的 Word，全程零手動排版；同一學生保證不會拿到寫過的題目。

---

## 🗂 目錄總覽

| 目錄 / 檔案 | 內容 | 說明 |
|------------|------|------|
| **[`exam_pro/`](./exam_pro)** | 🌟 **主要成品**（企業級重構版） | `app.js` / `server.js` + `config` `controllers` `services` `middleware` `routes` `utils` 分層，前端為 `public/index.html`，資料表定義於 `schema.sql`。詳見 [`exam_pro/README.md`](./exam_pro/README.md) |
| [`exam/`](./exam) | 早期原型（ARCHIVED） | 功能相同但邏輯集中於單一 `server.js`，保留以呈現重構前後對照 |
| [`期中專題報告/`](./期中專題報告) | 開發紀實簡報 | [`tutor_presentation.html`](./期中專題報告/tutor_presentation.html)：GitHub 只會顯示原始碼，請下載後用瀏覽器開啟（大型 pptx/pdf/mp4 素材未進版控）|
| [`LICENSE`](./LICENSE) | Apache License 2.0 | 程式碼授權 |
| [`NOTICE`](./NOTICE) | 內容與著作權聲明 | 題目內容的權利範圍與使用者責任 |

---

## 🔄 兩個子專案的關係

```
exam/  ──（重構）──▶  exam_pro/
原型：邏輯全在              企業級版：MVC 分層、
單一 server.js            白名單驗證、API 認證、
                         防 SSRF、LaTeX→Word 公式引擎
```

- **`exam`**：最初的可運作原型，驗證「AI 拆題 + 組卷 + 匯出」的核心流程。
- **`exam_pro`**：以 `exam` 為基礎重構，拆分為 `config / controllers / services / middleware / routes / utils`，並補強安全性與正確性。**若要實際執行，請使用 `exam_pro`。**

---

## 🚀 快速開始（exam_pro）

```bash
cd exam_pro
npm install
cp .env.example .env      # 填入 GEMINI_API_KEY 與資料庫設定
mysql -u root -p < schema.sql
npm start                 # http://localhost:3000
```

完整安裝步驟、環境變數表、API 一覽與維運工具說明，請見 **[`exam_pro/README.md`](./exam_pro/README.md)**。

---

## 🧰 技術棧

- **後端**：Node.js · Express · MySQL（mysql2）
- **AI**：Google Gemini 2.5 Flash（`@google/genai`）— PDF 考卷解析
- **文件**：`docx`（自製 LaTeX → OOXML 數學公式轉換）
- **前端**：單頁 HTML + Tailwind（CDN）+ MathJax

---

## 🔐 安全注意事項

- 對外部署 `exam_pro` 時務必設定 `ALLOWED_ORIGINS` 並將 `NODE_ENV=production`。
  ⚠️ `API_KEY` 會被注入前端頁面，**不等同存取控制**，詳見 [`exam_pro/README.md`](./exam_pro/README.md#-安全注意事項)。
- 金鑰請妥善保管；若曾外流，請至 [Google AI Studio](https://aistudio.google.com/apikey) 重新產生。

---

## 📄 授權與著作權

### 程式碼
本專案**程式碼**採 **[Apache License 2.0](./LICENSE)** 釋出。
你可自由使用、修改與散布（含商用），惟須保留版權與授權聲明。

### ⚖️ 題目內容（重要）

| | 說明 |
|---|---|
| **本 repo 不含題庫資料** | 沒有任何考卷、試題或其掃描檔。開發期間用於測試的實體考卷 PDF、題庫備份 JSON、維運報告產物與含逐字試題的一次性腳本，**均未收錄、已自版本歷史完全移除，並由 `.gitignore` 持續排除**（同時排除 `.env`、`node_modules/`、`uploads/` 與大型二進位素材）。 |
| **示範題為自製** | `exam_pro/seed_questions.js` 的 30 題係為展示流程自行編寫的常見教科書型例題，不取自任何特定考卷或出版品。 |
| **使用者自負責任** | 本系統用於管理**使用者自身合法擁有或有權使用**的題目。經 PDF 解析匯入的內容，著作權仍屬原著作權人，不因匯入而移轉。匯入前請自行確認已取得合法權源（自行創作、取得授權，或符合著作權法合理使用要件）。 |

完整聲明見 **[`NOTICE`](./NOTICE)**。

© 2026 Ben Yang (楊本顥)
