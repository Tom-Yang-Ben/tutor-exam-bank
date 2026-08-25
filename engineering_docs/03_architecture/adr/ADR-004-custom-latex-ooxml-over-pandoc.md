# ADR-004: 自製 LaTeX→OOXML 轉換而非採用 pandoc (Custom LaTeX to OOXML over Pandoc) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **決策狀態:** 已採納（重構期 `exam_pro` v1） | **決策者:** Ben
> **定位:** 本文件回答「Word 匯出的公式引擎為何自製解析器而非 pandoc」；AI 輸出的 LaTeX 白名單約束見 ADR-005，系統全貌歸 sad。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 交付物必須是 Word 原生方程式的 `.docx`（DEC-002）——學生端用紙本，公式須為直式分數而非斜線，且可用 Word 方程式編輯器開啟編輯。
- **問題**: 資料來源不是一份 LaTeX 文件，而是 DB 裡一列列的題目，內容為「中文敘述混雜行內 `$...$` 片段」；匯出需程式化組裝版面（標題階層、藍色題號、`★` 難度、換頁、答案區紅字、遠端圖片插入）。
- **驅動因素/約束**:
  - 部署零外部相依：單人維運的 Node.js 伺服器，不希望依賴外部二進位。
  - 輸入域受控：AI prompt 已將可用語法限縮為高中數理子集，並強制 `\frac{}{}`（ADR-005 的白名單約束與本解析器刻意互相對齊）。
  - 單一公式失敗不得導致整份考卷打包失敗。

## 2. 考量的選項

| 方案 | 優勢 | 限制 | 未採用的原因 |
|---|---|---|---|
| **pandoc** | 文件轉換業界標準，LaTeX 覆蓋率遠勝自製解析器 | 單位是整份文件；外部二進位相依，每次請求需 `spawn`，部署環境須另裝執行檔；產檔後無法再回頭程式化插入版面元素 | 輸入是 DB 題目列而非 LaTeX 文件；交付物需以 `docx` 物件模型逐段建構 |
| **temml：LaTeX→MathML→字串包裝 OMML**（原型 `exam/server.js` 實際採用後淘汰） | 實作快 | 本質是「MathML 標籤穿 OOXML 外衣」，Word 不保證接受 | 中介方案已試過並淘汰；無法保證產出可編輯的原生方程式 |
| **公式貼圖** | 迴避 OOXML 複雜度 | 紙本列印品質差；學生端無法得到直式分數的可編輯公式 | 違反 DEC-002 核心約束 |
| **自製 tokenizer＋遞迴下降解析器 → `docx` 原生 Math 物件**（採納） | 零外部相依；版面完全可控；失敗可局部降級 | 僅支援 LaTeX 語法子集 | — |

## 3. 決策

**選擇**: 於 `exam_pro/utils/textFormatter.js` 自製 tokenizer＋遞迴下降解析器，直接建構 `docx` 套件的原生數學物件（`MathFraction`、`MathRadical`、`MathSum`、`MathSubSuperScript` 等）；`buildParagraphComponents`／`renderMixedInto` 處理中英數混排；`exam_pro/services/wordService.js` 以 `docx` 物件模型逐段組裝整份考卷（含防 SSRF 的遠端圖片插入）。

**理由**:

1. 輸入不是一份 LaTeX 文件：pandoc 的單位是整份文件，而本系統處理的是 DB 中混排的題目片段。
2. 交付物需要程式化組裝：標題階層、題號、難度、換頁、答案區等由物件模型逐段建構，交給 pandoc 產檔後即無法回頭插入。
3. 零外部二進位相依：現行方案不需每請求 `spawn`，部署不需額外安裝執行檔。
4. 中介方案（temml→MathML 包裝）已於原型實測並淘汰；重構版產出可用 Word 方程式編輯器開啟編輯的真直式分數，正對應核心約束。
5. 輸入域受控，無須覆蓋完整 LaTeX：未知指令退化為純文字（`parseCommand` 末段），單一公式失敗不會導致整份考卷匯出失敗。

## 4. 後果

- **正面**: 部署零相依；版面完全可控；失敗可局部降級；希臘字母／符號對照表由 `exam_pro/utils/embedText.js` 直接重用（避免「Word 匯出看到 θ、embedding 看到 theta」的不一致）。
- **負面（已知限制）**:
  - 僅支援高中數理 LaTeX 子集，覆蓋率遠低於 pandoc；語法域擴張時解析器須同步擴充。
  - 解析器正確性依賴白名單前置約束（ADR-005）：AI 輸出若繞過白名單（如以斜線寫分數），產出即非直式分數。
  - 解析器與 lint（FR-003）、embed 文本（`embedText.js`）三處對 LaTeX 的認知須維持對齊。
- **影響範圍**: `exam_pro/utils/textFormatter.js`、`exam_pro/services/wordService.js`、`exam_pro/agents/lint.js`、下載端點 download-word（FR-009）。
- **重新評估觸發**: 題目所需 LaTeX 語法超出高中數理子集且擴充成本過高；或 `docx` 套件的 Math 物件 API 發生不相容變更。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-001、DEC-002、FR-009 |
| 影響範圍 | FR-003（公式 lint 與解析器對齊）、NFR-001（圖片插入防 SSRF）；api_spec（download-word） |
| 取代關係 | Supersedes：原型 temml→MathML 方案（`exam/server.js`，ARCHIVED）；Superseded-by 無 |
| 相關 ADR | ADR-005（LaTeX 白名單為本解析器的前置防線） |
