# Runbook - PostgreSQL 不可用 (PG Down) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-08-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥）
> **語域:** L3（工程）
> **實例:** 每故障症狀一份（`runbook-<symptom>.md`）。本文件僅處理「PG 容器起不來、連線失敗、備份還原」；MySQL→PG 切換之夜的完整流程與回滾界線歸 `docs/cutover-runbook.md`（切換已於 2026-08-21 完成並跳過回滾窗口，該文件保留為歷史紀錄）。

## 目錄

- [1. Symptoms（症狀）](#1-symptoms症狀)
- [2. Impact（影響）](#2-impact影響)
- [3. Possible Causes（可能原因）](#3-possible-causes可能原因)
- [4. Diagnosis（診斷步驟）](#4-diagnosis診斷步驟)
- [5. Mitigation（短期緩解）](#5-mitigation短期緩解)
- [6. Recovery（恢復確認）](#6-recovery恢復確認)
- [7. Escalation（升級條件）](#7-escalation升級條件)
- [8. 追溯](#8-追溯)

## 1. Symptoms（症狀）

- `npm start` 失敗或 API 回 500，錯誤含 `ECONNREFUSED`／連線逾時。
- `啟動資料庫.bat` 印出「偵測不到 Docker 引擎」或容器未達 healthy。
- 「密碼驗證失敗」但密碼正確——典型為連到 5432 被本機原生 PostgreSQL 17 服務接走（開發庫埠是 **5442**）。
- `backups\LAST_FAILED.txt` 出現（每日 02:00 排程備份失敗的旗標檔）。

## 2. Impact（影響）

| 項目 | 內容 |
| :--- | :--- |
| **受影響功能** | 全站（題庫、組卷、匯出、拆題、RAG 均依賴同一 PG 16 + pgvector） |
| **嚴重程度判定** | 容器重啟可復原＝例行處置；volume 損毀需還原備份＝重大，還原前先停止一切寫入 |

## 3. Possible Causes（可能原因）

1. Docker Desktop 未啟動（開機後未登入、或排程在鎖定畫面下跑）。
2. `DATABASE_URL` 指錯埠：開發庫 5442（volume）、測試庫 5433（tmpfs）；5432 是本機原生 PG17。
3. 容器異常退出或 volume 損毀（`docker compose logs` 可辨識）。
4. migrations 未套用（0001–0005），啟動後查詢到不存在的資料表。

## 4. Diagnosis（診斷步驟）

```bat
cd /d "C:\Users\Administrator\Desktop\期中專案\exam_pro"

REM 1. 容器狀態（服務名：postgres＝開發 5442、postgres_test＝測試 5433）
docker compose ps

REM 2. 一鍵健檢：結尾應印「[OK] 資料庫已就緒」
啟動資料庫.bat

REM 3. 直接對資料庫執行查詢（確認埠與帳密，並確認資料量）
docker compose exec -T postgres psql -U exam -d tutor_exam_bank -c "SELECT count(*) FROM questions"

REM 4. 容器日誌與 migrations 狀態
docker compose logs --tail 50 postgres
node migrate.js status
```

`.env` 核對：`DATABASE_URL=postgres://exam:exam@localhost:5442/tutor_exam_bank`（`config/db.js` 只認 `DATABASE_URL`）。

## 5. Mitigation（短期緩解）

1. Docker 未起：啟動 Docker Desktop 後 `npm run db:up`（`docker compose up -d --wait`）。
2. 埠指錯：改回 5442 後重啟 `npm start`；不要動本機 5432 的原生服務。
3. 容器起得來但表缺：`npm run migrate` 補套用 0001–0005。
4. volume 損毀＝需還原備份（先停 `npm start`，確認不再寫入）：

```bat
REM 備份檔在 backups\<日期>.dump（pg_dump -Fc 自訂格式，由 備份資料庫.bat / scripts/backup.js 產生）
REM 重建空庫後以容器內的 pg_restore 還原：
docker compose exec -T postgres psql -U exam -d postgres -c "DROP DATABASE IF EXISTS tutor_exam_bank; CREATE DATABASE tutor_exam_bank"
type backups\<日期>.dump | docker compose exec -T postgres pg_restore -U exam -d tutor_exam_bank --no-owner --no-acl
```

還原後資料回到備份時點——當日新增的題目／作答紀錄會遺失，還原前先向使用者（即 Owner 本人）確認可接受。

## 6. Recovery（恢復確認）

- `啟動資料庫.bat` 印「[OK] 資料庫已就緒」；`node migrate.js status` 五支 migrations 均已套用。
- 冒煙四項（沿用 `docs/cutover-runbook.md` §2-10）：題庫列表載入、組卷 200、同學生同章再組不重疊、Word 下載公式正常。
- 手動跑一次 `npm run db:backup` 成功且無 `LAST_FAILED.txt`，確認備份鏈恢復。

## 7. Escalation（升級條件）

| 情況 | 處置 |
| :--- | :--- |
| 還原備份仍起不來 | 換前一份 `backups\*.dump` 逐份回退；備份檔開頭應為 `PGDMP` 魔數（`scripts/backup.js` 產出時已驗證） |
| 排程備份連續失敗 | 檢查排程是否勾「只有使用者登入時才執行」（Docker 僅登入後可用）；`BACKUP_COPY_DIR` 異地副本是否同步 |

## 8. 追溯

| 項目 | ID／來源 |
| :--- | :--- |
| 上游需求 | DEC-004、NFR-005、NFR-006（同交易一致性、migrations 只增不改） |
| 對應模組 | `exam_pro/docker-compose.yml`、`exam_pro/scripts/backup.js`、`exam_pro/備份資料庫.bat`、`exam_pro/啟動資料庫.bat`、`exam_pro/config/db.js` |
| 下游文件 | `docs/cutover-runbook.md`（歷史切換紀錄）；事故覆盤紀錄（待補） |
