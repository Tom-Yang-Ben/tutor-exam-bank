# 家教專用數學物理題庫系統（企業級重構版）

以 **Node.js + Express + MySQL + Google Gemini** 打造的家教題庫與智慧組卷後端。
支援上傳考卷 PDF 由 AI 自動拆題入庫、依學生作答歷史智慧組卷、並匯出含數學公式排版的 Word 考卷。

---

## ✨ 功能特色

| 功能 | 說明 |
|------|------|
| 📄 **PDF 智慧解題** | 上傳考卷 PDF，Gemini 2.5 Flash 自動拆解題目、判斷學科／章節／難度，並將公式轉為 LaTeX |
| ✍️ **題庫管理** | 題目新增／編輯／刪除／搜尋／分頁，後端以「章節白名單」嚴格驗證 |
| 🧠 **智慧組卷** | 依「學生 × 章節」抽題，自動記錄作答歷史，避免重複出題（交易確保一致性）|
| 📥 **匯出 Word** | 依題型與難度排序，產生 `.docx` 考卷，內建 LaTeX → Word 數學公式轉換 |
| 🔒 **安全設計** | 參數化 SQL、可選 API Key 認證（timing-safe）、CORS 白名單、圖片下載防 SSRF |

---

## 🗂 專案結構

```
exam_pro/
├─ server.js              # 進入點：啟動 HTTP server
├─ app.js                 # Express 設定：CORS、靜態檔、金鑰注入、全域錯誤中樞
├─ config/
│   ├─ db.js              # MySQL 連線池
│   └─ chapters.js        # 數學/物理精細章節白名單 + 驗證函式
├─ middleware/
│   └─ auth.js            # 可選的 x-api-key 認證（timingSafeEqual）
├─ routes/index.js        # API 路由表
├─ controllers/           # 請求處理：question / exam / ai / word
├─ services/
│   ├─ aiService.js       # 呼叫 Gemini 解析 PDF
│   └─ wordService.js     # 產生 Word 考卷（含防 SSRF 圖片下載）
├─ utils/textFormatter.js # LaTeX → OOXML 數學公式解析器
├─ schema.sql             # 資料表定義（questions / exam_papers）
├─ index.html             # 前端單頁介面
└─ *.bat / fix_*.js       # 題庫維運工具（見下方）
```

---

## 🚀 安裝與啟動

### 1. 前置需求
- Node.js 18+
- MySQL 8.0.16+（`CHECK` 約束與 JSON 函式需要）
- 一組 [Google Gemini API 金鑰](https://aistudio.google.com/apikey)

### 2. 安裝相依套件
```bash
cd exam_pro
npm install
```

### 3. 設定環境變數
複製範本並填入實際值：
```bash
cp .env.example .env
```
| 變數 | 說明 | 預設 |
|------|------|------|
| `PORT` | 服務埠 | `3000` |
| `GEMINI_API_KEY` | Google Gemini 金鑰（**必填**）| — |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | MySQL 連線 | localhost / root / — / tutor_exam_bank |
| `API_KEY` | 後端存取金鑰；留空則**停用**認證（純本機自用）| 空 |
| `ALLOWED_ORIGINS` | 允許的前端來源（逗號分隔）| `http://localhost:3000` |
| `IMAGE_HOST_ALLOWLIST` | Word 匯圖時允許的圖片網域（逗號分隔，選填）| 空 |
| `NODE_ENV` | `production` 時錯誤不外洩細節 | `development` |

### 4. 建立資料庫
```bash
mysql -u root -p < schema.sql
```

### 5. 啟動
```bash
npm start      # 正式
npm run dev    # 開發（nodemon 熱重載）
```
啟動後開啟 <http://localhost:3000>。

---

## 🔌 API 一覽

所有路由掛在 `/api` 之下；若設定了 `API_KEY`，需帶 `x-api-key` 標頭。

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/questions` | 題庫列表（支援 `subject/chapter/question_type/q/page/limit` 篩選分頁）|
| POST | `/api/questions` | 新增單題 |
| PUT | `/api/questions/:id` | 更新題目 |
| DELETE | `/api/questions/:id` | 刪除題目 |
| POST | `/api/batch-save-questions` | 批次入庫（AI 解析結果）|
| GET | `/api/chapters` | 題庫中實際存在的章節 |
| GET | `/api/chapter-whitelist` | 完整章節白名單（前端下拉選單）|
| POST | `/api/generate-paper` | 智慧組卷（`student_name/subject/chapter/count`）|
| POST | `/api/analyze-pdf` | 上傳 PDF（`multipart/form-data`, 欄位 `pdf`）解析題目 |
| POST | `/api/download-word` | 依 `question_ids` 產生 Word 考卷 |

---

## 🛠 題庫維運工具（Windows `.bat`）

雙擊即可執行，`fix_*` 類含「先預覽、再套用」雙段流程並自動備份：

| 批次檔 | 作用 |
|--------|------|
| `執行公式健檢.bat` | 掃描題庫公式問題 → 產生 `公式健檢報告.html` |
| `預覽公式修正.bat` / `套用公式修正.bat` | 公式自動修正（套用前備份為 `formulas_backup_*.json`）|
| `預覽逐字校正.bat` / `套用逐字校正.bat` | 逐字校正 |
| `預覽人工修正.bat` / `套用人工修正.bat` | 人工修正清單 |
| `建立索引與檢視表.bat` | 建立資料庫索引與檢視表 |

> ⚠️ `*_backup_*.json` 內含題庫資料，已在 `.gitignore` 排除，請勿外流。

---

## 🔐 安全注意事項

- **`.env` 內含真實金鑰，切勿進版控或分享**（已由 `.gitignore` 排除）。若金鑰曾外流，請至 Google AI Studio **重新產生**。
- 對外部署時務必設定 `API_KEY`、`ALLOWED_ORIGINS`，並將 `NODE_ENV=production`。
- 資料庫帳號建議改用最小權限帳號，勿用 root。
