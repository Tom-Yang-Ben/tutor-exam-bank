# 階段 4：產品收斂（2026-08-24 凍結）

> 背景：階段 1–3 把「多 agent + RAG」的作品集蓋好了，但日常主流程（選學生 → 出不重複
> 的卷 → 匯出）被三個設計反噬：學生是打字打出來的（打錯字＝靜默分裂不重複紀錄）、
> 出卷一按就定案（重抽會燒題）、弱點面板要的批改資料日常流程不生產。
> 本階段**單線施工**（不開四個 worktree），四項全部由使用者 2026-08-24 核准。
> 擱置區（全部處理完再議）：P-16 參數化模板；「主控 agent + 工具調用」展示（見 §5）。

## 1. 範圍（四項）

| # | 項目 | 一句話 |
|---|---|---|
| W1-1 | 學生改成選的 | 組卷表單下拉選學生＋明確「新增」；學生管理（改名／合併／刪除）；`generate-paper` **不再自動建學生** |
| W1-2 | 出卷改成草稿→確認 | 預覽不寫庫、可換一題／重抽；「確認出卷」才寫卷與 attempts；補「刪除考卷」還原題目池 |
| W1-3 | 批改輕量化 | 批改表單加「未批的全部標為對」——只點錯的，十秒批完一張卷 |
| W1-4 | 小修 | 弱點面板時間窗預設 90 → 365；空狀態文案講人話 |

## 2. API 契約（本階段凍結；裁決 S4-*）

### 2.1 學生管理（掛在核心區，**不在** FEATURE_STUDENTS 旗標內）

- `GET /api/students` —— 由 [WS3-A] 旗標區**搬到核心區**（組卷下拉需要它恆常在）。
  回應形狀不變：`{items:[{id,name,papers,graded_ratio}]}`。（裁決 S4-2）
- `POST /api/students {name}` → 201 `{id,name}`；trim 後空 → 400；重名 → 409。
- `PATCH /api/students/:id {name}` → 200 `{id,name}`；重名 → 409；查無 → 404。
- `DELETE /api/students/:id` → 200 `{deleted:{attempts,papers}}`——同一交易刪
  attempts → exam_papers → student。**不可逆**，前端二次確認。
- `POST /api/students/:id/merge {into_id}` → 200
  `{moved_attempts, dropped_conflicts, moved_papers}`——同一交易：
  ① 刪來源中與目標衝突的 attempts（同 question_id，**保留目標側**的批改）；
  ② 其餘 attempts `UPDATE student_id`；③ exam_papers `UPDATE student_id`；④ 刪來源學生。
  自併（id === into_id）→ 400。

### 2.2 組卷（`POST /api/generate-paper` 改契約）

- 收 `student_id`（優先）**或** `student_name`（相容）。
- **裁決 S4-1：不再自動建學生**——`student_name` 查無此人 → 404
  `「查無學生「<name>」，請先新增學生。」`。自動建立正是垃圾人名（小／名／華）的根因。
- 新參數 `dry_run: true` → 走完全相同的選題邏輯但**整段不寫庫**（不建卷、不寫 attempts），
  回 `{dry_run:true, student_id, paper_title_preview, question_ids, questions}`。
- 新參數 `exclude_ids: int[]`（僅 dry_run 需要；confirm 不收）——候選池額外排除這些題，
  「換一題」＝把那題加進 exclude_ids 再 dry_run 一次；「整卷重抽」＝exclude_ids 不變重叫
  （洗牌自然給出不同組合）。上限 200 個。
- 不帶 `dry_run` 的舊行為（直接成卷）保留——但前端一律走 dry_run → confirm。

### 2.3 確認與刪卷

- `POST /api/confirm-paper {student_id, question_ids}` → 交易內重驗（未封存、該生未寫過、
  家族互斥不重驗——題目就是預覽選出的那批）→ 建卷＋attempts（`ON CONFLICT DO NOTHING`
  ＋rowCount 檢查，409 語意與 generate-paper 相同）→ 200
  `{paper_id, paper_title, question_ids, questions}`（形狀與 generate-paper 成功回應一致，
  前端共用同一段渲染與 Word 匯出）。題數 1..50。
- `DELETE /api/papers/:id` → 200 `{deleted_attempts}`——同一交易刪該卷 attempts 與卷。
  **已批改的紀錄會一併消失**（前端警告文案明說）。掛核心區。（裁決 S4-3）

### 2.4 前端

- 組卷表單：`<input student_name>` → `<select id="student_select">`（載入 `GET /api/students`）
  ＋「＋ 新增學生」（inline 輸入 → POST → 重載下拉並選中）。
- 組卷流程：生成 → **預覽卡**（每題「換這題」、整卷「重抽」「確認出卷」）→ 確認後
  才出現「下載 Word」「立即批改」。預覽狀態明標「尚未寫入，重抽不會燒題」。
- 學生管理 UI 放**學生分頁**（FEATURE_STUDENTS 內）：每列加「改名／合併到…／刪除」。
  組卷下拉不依賴該分頁。
- 批改表單：儲存鍵旁加「未批的全部標為對」（只改前端狀態，仍走原本的 diff → PATCH）。
- `public/js/students.js` `DEFAULT_DAYS` 90 → 365（裁決 S4-4：家教場景「不重複」與弱點
  都是長期視角；伺服器端第 1.5 條 days 預設 90 不動，前端恆帶參數）。

## 3. 不動的東西

agent 管線、RAG 檢索、NLQ、變式、複核佇列、eval 與門檻——全部不碰。
`index.html` 舊 inline script 這次**在範圍內**（組卷區就住在那裡）；改動仍過
`npm run check:html` 的語法與接點檢查。

## 4. 測試計畫

- 整合測試更新：`controllers.pg.test.js` 的 generate-paper 案例先建學生（新契約 S4-1）；
  新增學生管理 CRUD＋merge、dry_run 不落痕跡、confirm 原子性、刪卷還原題目池等案例。
- e2e 兩條照跑（組卷那條改走 dry_run → confirm）。
- 單元：`diffResults` 不變；「未批全對」的純函式行為。
- 驗收：單元＋整合＋e2e＋`check:html` 全綠，CI 綠。

## 5. 擱置區（本階段完成後再議）

1. **P-16 參數化模板**（使用者指示擱置）。
2. ~~「主控 agent + 工具調用」展示~~ → **已執行（2026-08-24，`0ff47b4`）**：
   對話式助教（FEATURE_ASSISTANT／POST /api/assistant／前端「助教」分頁）。
   主控 LLM 以受限 JSON 調度五個**只讀**工具；工具調用軌跡直接攤在 UI 上。
   設計細節與兩種編排哲學的對照見 `services/assistantService.js` 檔頭與
   `docs/rag-and-agents.md` §2.10。出卷／出變式仍由人按確認——助教沒有寫入權。
