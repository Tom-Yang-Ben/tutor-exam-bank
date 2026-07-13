# 期中專案 · 家教專用數學物理題庫系統

> AIPE 課程期中專題。以 AI 協助家教老師「上傳考卷 → 自動拆題入庫 → 智慧組卷 → 匯出 Word 考卷」，減少人工出題與重複出題的負擔。

本 repo 收錄專題的**完整開發歷程**:從早期原型、企業級重構版，到最終簡報與相關練習。

---

## 🗂 目錄總覽

| 目錄 / 檔案 | 內容 | 說明 |
|------------|------|------|
| **[`exam_pro/`](./exam_pro)** | 🌟 **主要成品**（企業級重構版） | MVC 分層架構的完整後端，詳見 [`exam_pro/README.md`](./exam_pro/README.md) |
| [`exam/`](./exam) | 早期原型 | 功能相同但邏輯集中於單一 `server.js`，保留以呈現重構前後對照 |
| [`depository/`](./depository) | 課堂練習 | Python / Jupyter 練習檔（`firework.py` ASCII 煙火、`donut.ipynb` 旋轉甜甜圈、matlab/experiment 等），與題庫系統無關 |
| `期中專題報告/` | 簡報與 Demo | 報告簡報、螢幕錄影、擷圖等（大型 pptx/pdf/mp4 已排除，不進版控）|
| `行事曆修改方案.md` | 另一構想草稿 | 「班表一鍵匯入 Apple 行事曆」的獨立發想，與題庫系統無關 |

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

- `.env`（含真實金鑰）、`node_modules/`、`uploads/` 暫存檔、題庫備份 JSON、大型報告二進位檔（pptx/pdf/mp4）**皆已由 `.gitignore` 排除，不進版控**。
- 對外部署 `exam_pro` 時務必設定 `API_KEY`、`ALLOWED_ORIGINS`，並將 `NODE_ENV=production`。
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
├─ exam/              # 早期原型
├─ depository/        # 課堂練習（Python / Jupyter）
├─ 期中專題報告/       # 簡報與 Demo（大型檔已排除）
└─ 行事曆修改方案.md   # 另一構想草稿
```

---

## 📄 授權

本專案採 **[Apache License 2.0](./LICENSE)** 釋出。
你可自由使用、修改與散布（含商用），惟須保留版權與授權聲明。詳見 [`LICENSE`](./LICENSE)。

© 2026 Ben Yang (楊本顥)
