# ADR-008: 應用層中文分詞 (App-Layer Chinese Tokenizer) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「中文分詞為何放在應用層、凍結分詞器的代價」；hybrid 檢索與 RRF 融合的整體決策歸 [ADR-002](./ADR-002-hybrid-retrieval-rrf.md)。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: hybrid 檢索（[ADR-002](./ADR-002-hybrid-retrieval-rrf.md)）的全文側需要中文分詞——題幹為中文敘述混雜數學符號與專有名詞，未分詞的全文索引無法有效匹配。
- **問題**: PostgreSQL 缺乏成熟的內建中文分詞；分詞放在資料庫層或應用層須做選擇，且分詞結果決定全文索引內容，事後更換的成本高。
- **驅動因素/約束**:
  - 單人維護、Windows／Docker 環境（開發 PG 5442、測試 5433）——資料庫端 C extension 的建置與升級成本不成比例。
  - 章節名、數理專有名詞需自訂詞條才能正確切分。
  - 索引內容與查詢分詞必須出自同一分詞器，否則兩側 token 不一致、全文側失效。

## 2. 考量的選項

### 選項一: 資料庫端分詞 extension（zhparser／pg_jieba）
- **描述**: 於 PostgreSQL 安裝中文分詞 C extension，以 `to_tsvector` 原生流程建索引。
- **優點**: 分詞與索引同層，SQL 端一致性由資料庫保證。
- **缺點**: 兩者均為 C extension，於 Windows／Docker 環境需自行編譯或維護客製映像；PG 大版本升級連動 extension 重建。
- **成本/複雜度**: 高

### 選項二: 不分詞（bigram 或 LIKE）
- **描述**: 以固定 n-gram 切分或維持 `LIKE` 比對。
- **優點**: 零分詞相依。
- **缺點**: 量測基準顯示 `LIKE` 的 Recall@5 僅 0.875；n-gram 對專有名詞與符號的精確度不足且索引膨脹。
- **成本/複雜度**: 低

### 選項三: 應用層 jieba 分詞（採用）
- **描述**: `exam_pro/utils/tokenize.js` 以 jieba＋章節自訂詞分詞，於應用層產出 token 後寫入全文索引；查詢端經同一模組分詞。
- **優點**: npm 相依即可用，無資料庫端建置；自訂詞條（章節名）由程式碼版本控制；分詞行為可被單元測試固定。
- **缺點**: 索引內容綁定分詞器版本與詞庫——更換分詞器時全文索引須整批重建。
- **成本/複雜度**: 中

## 3. 決策

**選擇**: 選項三——jieba 於應用層分詞，且 `utils/tokenize.js` 凍結為全案唯一分詞器。

**理由**: 資料庫端 extension 的維運成本與單人 Windows／Docker 環境不成比例；應用層方案以極低建置成本使 hybrid 檢索 Recall@5 由 0.875（LIKE 基準）達 1.000。凍結為唯一分詞器是對「索引端與查詢端 token 必須一致」約束的結構性回應：任何模組（檢索、NLQ、eval）都經同一入口分詞，杜絕兩套分詞並存導致的靜默 recall 劣化。

## 4. 後果

- **正面**: 全文側可精確匹配專有名詞與符號，與向量側互補；零資料庫端客製，`npm run db:up` 用官方 pgvector 映像即可。
- **負面**: 更換分詞器或改動詞庫即改變索引內容，全文索引須整批重建——此為凍結的明訂代價；jieba 詞庫對新專有名詞的切分需以自訂詞條補充。
- **影響範圍**: `exam_pro/utils/tokenize.js`、`exam_pro/queries/hybrid.js`（全文側）、`exam_pro/services/nlqService.js`、`exam_pro/eval/`（retrieval suite）。
- **重新評估觸發**: 題庫規模或多語需求使應用層分詞成為瓶頸、或部署環境改為可穩定維護 pg_jieba 的 Linux 主機時。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-006、FR-010、FR-012、NFR-004 |
| 影響範圍 | `exam_pro/utils/tokenize.js`、`exam_pro/queries/hybrid.js`、`../engineering_tracker.md` |
| 取代關係 | 無；為 ADR-002 hybrid 檢索的組成決策 |
