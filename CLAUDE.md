# 給 AI 協作者（Claude、Codex 等）的工作規則

## README 寫作規則

1. **README 只寫「現在」**：系統是什麼、為什麼做、怎麼開始、架構、現行的評測數字、文件索引、授權。
2. **不寫歷史**：開發階段的演進、每一輪的 Owner 決策、修訂紀錄、〔修訂 YYYY-MM-DD〕這類註記，一律寫到 `docs/HANDOFF.md` 或 commit 訊息，不進 README。
3. **細節放專門文件**：完整 API、環境變數總表、驗收清單、設計理由放 `docs/`、`engineering_docs/`，README 只放連結。
4. **長度上限**：根目錄 `README.md` 與 `exam_pro/README.md` 各不超過 200 行。
5. **數字要能重現**：README 裡的評測數字必須是目前 main 上照 CI 設定實跑的結果，改了程式或回放檔就重跑、更新。

第 2、4 條由 `exam_pro/test/unit/readmeRules.test.js` 自動檢查，CI 會擋。

## 其他文件

- 現況、待辦與 Owner 決策紀錄：`docs/HANDOFF.md`
- 本機模式：`docs/local-mode.md`
