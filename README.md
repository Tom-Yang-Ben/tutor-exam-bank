# 期中專案 · 家教專用數學物理題庫系統

> AIPE 課程期中專題。以 AI 協助家教老師「上傳考卷 → 自動拆題入庫 → 智慧組卷 → 匯出 Word 考卷」，減少人工出題與重複出題的負擔。

本 repo 收錄專題的**完整開發歷程**:從早期原型、企業級重構版，到開發紀實簡報。

> ⚖️ **本 repo 不含任何題庫資料或考卷內容。** 授權範圍僅限程式碼，
> 示範題為自行編寫。詳見 [`NOTICE`](./NOTICE)。

---

## 🗂 目錄總覽

| 目錄 / 檔案 | 內容 | 說明 |
|------------|------|------|
| **[`exam_pro/`](./exam_pro)** | 🌟 **主要成品**（企業級重構版） | MVC 分層架構的完整後端，詳見 [`exam_pro/README.md`](./exam_pro/README.md) |
| [`exam/`](./exam) | 早期原型 | 功能相同但邏輯集中於單一 `server.js`，保留以呈現重構前後對照 |
| `期中專題報告/` | 開發紀實簡報 | `tutor_presentation.html`（大型 pptx/pdf/mp4 素材已排除，不進版控）|
| `exam_pro 專案種子簡報.md` | 專案 baseline | 逆向回推的種子簡報（目標受眾 / 痛點 / 期望成果 / 約束 / 指標）|

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

## 🔐 安全與版控說明

- `.env`（含真實金鑰）、`node_modules/`、`uploads/` 上傳的考卷、題庫備份 JSON、維運報告產物、大型二進位素材（pptx/pdf/mp4）**皆已由 `.gitignore` 排除，不進版控**。
- 對外部署 `exam_pro` 時務必設定 `ALLOWED_ORIGINS` 並將 `NODE_ENV=production`。
  ⚠️ `API_KEY` 會被注入前端頁面，**不等同存取控制**，詳見 [`exam_pro/README.md`](./exam_pro/README.md#-安全注意事項)。
- 金鑰請妥善保管；若曾外流，請至 [Google AI Studio](https://aistudio.google.com/apikey) 重新產生。

---

## 📁 專案結構（精簡）

```
期中專案/
├─ exam_pro/          # 🌟 主要成品（見其 README）
│   ├─ app.js / server.js
│   ├─ config/ controllers/ services/ middleware/ routes/ utils/
│   ├─ public/index.html
│   └─ schema.sql
├─ exam/              # 早期原型（ARCHIVED，見其 README）
├─ 期中專題報告/       # 開發紀實簡報
├─ exam_pro 專案種子簡報.md   # 專案 baseline（逆向回推）
├─ LICENSE            # Apache License 2.0（程式碼）
└─ NOTICE             # 內容與著作權聲明
```

---

## 📄 授權與著作權

### 程式碼
本專案**程式碼**採 **[Apache License 2.0](./LICENSE)** 釋出。
你可自由使用、修改與散布（含商用），惟須保留版權與授權聲明。

### ⚖️ 題目內容（重要）

| | 說明 |
|---|---|
| **本 repo 不含題庫資料** | 沒有任何考卷、試題或其掃描檔。開發期間用於測試的實體考卷 PDF、題庫備份、維運報告與含逐字試題的一次性腳本，**均未收錄，且已自版本歷史完全移除**。 |
| **示範題為自製** | `exam_pro/seed_questions.js` 的 30 題係為展示流程自行編寫的常見教科書型例題，不取自任何特定考卷或出版品。 |
| **使用者自負責任** | 本系統用於管理**使用者自身合法擁有或有權使用**的題目。經 PDF 解析匯入的內容，著作權仍屬原著作權人，不因匯入而移轉。匯入前請自行確認已取得合法權源（自行創作、取得授權，或符合著作權法合理使用要件）。 |

完整聲明見 **[`NOTICE`](./NOTICE)**。

© 2026 Ben Yang (楊本顥)
