# ADR-001: 向量檢索採 PostgreSQL + pgvector 而非專用向量庫 (pgvector over Dedicated Vector DB) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **決策狀態:** 已採納（階段 1；資料層於 2026-08-21 切換上線） | **決策者:** Ben
> **定位:** 本文件回答「向量儲存為何與關聯資料同置於 PostgreSQL」；兩路融合演算法見 [ADR-002](./ADR-002-hybrid-retrieval-rrf.md)，分詞器凍結見 ADR-008，系統全貌歸 sad。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 階段 1 將資料層自 MySQL 遷移至 PostgreSQL 16（DEC-004），同時為相似題檢索（FR-010）、變式題檢索優先（FR-011）、kNN few-shot 分類（FR-002）、自然語言查題（FR-012）建立向量檢索能力。embedding 採 `gemini-embedding-001`（768 維，L2 正規化後餘弦相似度等值於內積）。
- **問題**: 向量索引置於何處。題庫規模為數百至數千題；系統由單人維運（DEC-009 要求資料留本地）。
- **驅動因素/約束**:
  - 「排除該學生已作答題目（`NOT EXISTS attempts`）」「排除同一變式家族」「限定難度」「排除已封存」皆為關聯式條件，且必須與向量檢索位於**同一查詢**——此為決定性因素。
  - 組卷與作答歷史同交易寫入（NFR-006），檢索層需自然取得交易一致性。
  - 單人維護，不引入額外常駐服務。

## 2. 考量的選項

| 方案 | 優勢 | 限制 | 未採用的原因 |
|---|---|---|---|
| **專用向量庫**（Pinecone／Milvus／Qdrant／Weaviate） | 支撐億級向量、ANN 成熟、可託管 | 增加一項服務或訂閱成本；關聯過濾依賴 metadata filter 或超額撈取；與 PostgreSQL 形成兩份需同步的資料 | 資料規模相差三個數量級；join 條件為核心需求，分離儲存顯著增加複雜度 |
| **FAISS／記憶體內索引** | 速度最快、無外部服務 | 無持久化、無過濾語意、行程重啟需重建、與資料庫脫節 | 單人專案要求開機即用；過濾需求同上 |
| **Elasticsearch／OpenSearch** | 全文檢索能力最強、亦支援 kNN | JVM 資源需求高、維運負擔重、中文仍需另裝分詞插件 | 引入成本與本專案的全文檢索需求不成比例 |
| **PostgreSQL 16 + pgvector**（採納） | 向量與關聯條件同庫同查詢；交易一致性原生；僅需啟用 extension | 億級規模不適用；ANN 需另行調參 | — |

## 3. 決策

**選擇**: PostgreSQL 16 + pgvector，向量欄位與 `questions` 同表同庫（migration `0002_vector`），檢索 SQL 集中於 `exam_pro/queries/hybrid.js`，由 API 與 eval 共用。

**理由**:

1. 題庫為數百至數千題，pgvector 精確搜尋已足夠快，尚無建立 ANN 索引的必要——實測萬題規模下預設路徑（同章、hybrid、k=10）p95 為 38 ms，達成規劃「萬題 p95 < 100 ms」目標（`docs/retrieval.md` §7）。
2. 關聯條件與向量檢索位於同一查詢：向量庫若為獨立服務，須先超額撈取再於應用層過濾，並維護兩份需同步的資料；同庫則單一查詢完成，且自然取得交易一致性。
3. PostgreSQL 為既有相依，向量能力僅需啟用 extension，符合單人維運前提。

## 4. 後果

- **正面**: 檢索 SQL 單點維護（`exam_pro/queries/hybrid.js`）；`NOT EXISTS attempts` 等排除條件直接內嵌於候選 CTE；eval 與 API 走同一段 SQL，指標可被 CI 固定（NFR-004）。
- **負面（已知限制）**:
  - 規模上限：向量數達千萬級時需建立 HNSW／IVFFlat 索引並調參；更大規模應重新評估專用向量庫。
  - 實測萬題規模下 HNSW 不被規劃器選用（候選 CTE join 後走 Bitmap Heap Scan + top-N 排序），內聯條件與 `hnsw.iterative_scan = relaxed_order` 均無改善，故維持現行 SQL 形狀（`docs/retrieval.md` §7）。
  - embedding 模型升級需重灌全部向量欄位並重錄 cassette（`exam_pro/scripts/backfill_embeddings.js` 即為此準備）。
- **影響範圍**: `exam_pro/queries/hybrid.js`、`exam_pro/services/embedService.js`、`exam_pro/migrations/0002_vector`、eval retrieval suite。
- **重新評估觸發**: 向量數逼近千萬級；或檢索 p95 超出門檻且索引調參無效。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-004、DEC-009、FR-010、FR-011、FR-012、NFR-006 |
| 影響範圍 | FR-002（kNN 分類）、FR-008（組卷排除條件）；db_design、api_spec |
| 取代關係 | 無（Supersedes／Superseded-by 皆無） |
| 相關 ADR | [ADR-002](./ADR-002-hybrid-retrieval-rrf.md)（融合演算法）、ADR-008（應用層分詞） |
