# ADR-002: 檢索採 hybrid 兩路融合（RRF）而非單路或加權融合 (Hybrid Retrieval with RRF) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **決策狀態:** 已採納（階段 1） | **決策者:** Ben
> **定位:** 本文件回答「為何以向量＋全文兩路檢索並以 RRF 融合」；向量儲存位置見 [ADR-001](./ADR-001-pgvector-over-dedicated-vector-db.md)，分詞器凍結見 ADR-008，系統全貌歸 sad。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 檢索層為單一 SQL 模組（`exam_pro/queries/hybrid.js`），由相似題（FR-010）、變式題檢索優先（FR-011）、kNN few-shot 分類（FR-002）、自然語言查題（FR-012）四個功能共用。改造前基準為純 `LIKE` 查詢。
- **問題**: 純 `LIKE` 的 Recall@5 僅 0.875；純向量檢索對專有名詞與符號的精確匹配易有遺漏。兩路並用時，餘弦相似度與全文檢索排名分數量綱不可直接比較。
- **驅動因素/約束**:
  - 使用情境為出卷前產生候選清單、由使用者挑選——recall 優先於 MRR。
  - PostgreSQL 缺乏成熟的內建中文分詞；`zhparser`／`pg_jieba` 為 C extension，於 Windows／Docker 環境維運成本高。
  - eval 與 API 必須走同一段 SQL，行為可被 CI 固定（NFR-003、NFR-004）。

## 2. 考量的選項

| 方案 | 優勢 | 限制 | 未採用的原因 |
|---|---|---|---|
| **純 `LIKE`**（改造前基準） | 實作最簡 | Recall@5 僅 0.875；無語意召回 | 「僅數值不同的同型題」無法召回 |
| **純向量檢索** | 架構較簡 | 專有名詞與符號的精確匹配易有遺漏 | 量測顯示 hybrid 的 recall 較佳（0.97 → 1.000），而增加一路 SQL 的成本極低 |
| **加權融合**（0.7 向量＋0.3 關鍵字） | 可調整兩側比重 | 須先各側 min-max 正規化再調權重，對分數分佈敏感 | RRF 僅依名次融合，無需分數校準；weighted 保留為 `hybrid.js` 的備用 mode |
| **DB 內建中文分詞**（zhparser／pg_jieba） | 分詞於 DB 端完成 | C extension，Windows／Docker 維運成本高 | 改以應用層 jieba 分詞（ADR-008），代價見 §4 |
| **Cross-encoder 重排** | 精度上限更高 | 每組 query-document 需一次模型呼叫，增加延遲與費用 | Recall@5 已達 1.000，重排無改善空間；檢索層為獨立 SQL 模組，規模擴大時可直接加入 |
| **hybrid（RRF k=60）**（採納） | 無需分數校準；兩側互補 | MRR 遭名次融合稀釋（見 §4） | — |

## 3. 決策

**選擇**: 向量側（pgvector 餘弦）與全文側（應用層 jieba 分詞建立 `search_tsv`，`to_tsquery('simple', ...)`）各自 `ORDER BY … LIMIT 50` 後 `FULL OUTER JOIN`，以 **RRF（Reciprocal Rank Fusion，k=60）** 融合：`score = 1/(60+vec_rank) + 1/(60+kw_rank)`，缺席側以 0 計。

**理由**:

1. 效益經量測驗證（golden 40 筆，人工定案）：Recall@5 由純 `LIKE` 的 0.875 提升至 **1.000**（純向量 0.97）；Recall@10 由 0.92 提升至 **1.000**。向量側召回「僅數值不同的同型題」，全文側精確匹配專有名詞與符號，兩者互補。
2. RRF 僅依名次融合，對分數分佈不敏感，無需正規化與權重調校。
3. 三種檢索模式（hybrid／vector／keyword）以 `sides` 參數共用同一段 SQL，避免三份實作漂移。

## 4. 後果

- **正面**: retrieval suite 指標寫入 `exam_pro/eval/thresholds.json` 並以 ratchet 把關（首測 −0.03、只升不降）；預設路徑（同章 hybrid）萬題實測 p95 38 ms。
- **負面（已知限制）**:
  - **RRF 對強信號的稀釋**：實測 MRR 純向量 0.9575，高於 hybrid 的 0.824——名次融合使正確結果偶爾自第 1 名移至第 2–3 名。本系統以 recall 為優先，此代價可接受；若情境改為僅取第一名，本決策應重新評估。
  - **中文分詞位於應用層**：更換分詞器時全文索引須整批重建，因此 `exam_pro/utils/tokenize.js` 被凍結為全案唯一分詞器（ADR-008）；`search_tsv` 三段 token 一律由 `buildTsvTokens` 產生（裁決 21）。
  - `scope=subject` 的關鍵字側於合成最壞情況下 p95 292 ms（`docs/retrieval.md` §7）；真題庫命中列數少一個數量級。
- **影響範圍**: `exam_pro/queries/hybrid.js`、`exam_pro/services/retrievalService.js`、`exam_pro/services/nlqService.js`、`exam_pro/utils/tokenize.js`、eval retrieval／nlq suite。
- **重新評估觸發**: 使用情境改為僅取 top-1（MRR 優先）；或 recall 指標跌破 ratchet 門檻。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-006、FR-010、FR-012、NFR-003、NFR-004 |
| 影響範圍 | FR-002、FR-011；api_spec、db_design（search_tsv 欄位） |
| 取代關係 | 無（Supersedes／Superseded-by 皆無） |
| 相關 ADR | [ADR-001](./ADR-001-pgvector-over-dedicated-vector-db.md)（向量儲存）、ADR-008（分詞器凍結） |
