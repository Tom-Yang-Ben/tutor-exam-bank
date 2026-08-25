# docs/archive/ — 已結案的歷史紀錄

> 2026-08-25 歸檔。這裡的檔案**全部已結案**，只作決策考古與流程紀錄，不再更新。
> 活的契約與參考文件（`interfaces*.md`、`retrieval.md`、`llm.md`、`variants.md`、`rag-and-agents.md`、`roadmap-plan.md`、`stage4-plan.md`、`HANDOFF.md`）仍在 `docs/` 上層。

## 內容

| 檔案 | 是什麼 | 結案時點 |
|---|---|---|
| `cutover-runbook.md` | MySQL→PG 切換之夜的逐步腳本與回滾界線 | 2026-08-21 依此執行完畢並上線；回滾窗口至 2026-09-04 |
| `human-lane-stage1.md` | 階段 1 開發者本人手動 lane 的五步操作 | 2026-08-21 全部完成 |
| `stage1/2/3-parallel-prompts.md` | 各階段四條 workstream 的 worktree 建立與分工提示詞 | 各階段合併結案（08-21／08-23／08-24） |
| `questions-ws{A-D}.md` | 階段 1 各 WS 對凍結介面的提問與裁決落地紀錄 | 2026-08-21 全部結案 |
| `questions2-ws{A-D}.md` | 階段 2 提問（裁決 S2-1～30 的原始討論） | 2026-08-23 結案；**例外：wsD 的 Q6 歸檔時仍未裁決**，追蹤在 `../HANDOFF.md` §3 |
| `questions3-ws{A-D}.md` | 階段 3 提問（裁決 S3-R1～R29 的原始討論） | 2026-08-24 全部結案 |

## 為什麼保留 questions 檔而刪掉 ws-notices

- **questions 檔記錄裁決的「為什麼」**——只看 `interfaces*.md` 的裁決結論會看不出當初的岔路，所以歸檔保留。
- **四份 `ws-notices-*.md`（round1、round2/3-stage2、round2-stage3）已刪除**：它們是貼給各 WS 的一次性通知稿，內容 100% 收錄於 `interfaces*.md` 的裁決節（§12／§12.1／§15），留著違反單一真相源。需要時查 git 歷史（刪除於本歸檔 commit）。

## 路徑對映

凍結契約 `interfaces*.md` 依制度不改動，其內文引用的 `docs/questions*-ws*.md`、
`docs/stage*-parallel-prompts.md`、`docs/cutover-runbook.md` 等舊路徑，一律對映到本資料夾
（`docs/archive/<同檔名>`）。若開新一輪平行作業，新的 questions／prompts 檔照舊體例開在 `docs/` 上層。
