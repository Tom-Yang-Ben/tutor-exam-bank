# HANDOFF — 給下一個 Claude Code 對話的交接檔（2026-08-24）

> 目的：這份檔案讓新的對話在**不重讀歷史**的情況下接手「整合者／審查者」的角色。
> 讀完本檔後，第一件事通常是執行 §6 的「看進度」流程。
> 配套：`~/.claude/projects/.../memory/` 裡有 `roadmap-master-plan.md`、`stage1-status.md`、`stage2-status.md`、`stage3-status.md`（系統會自動載入索引）。
>
> 〔修訂 2026-09-24〕**最新狀態先看 §0（階段 5 交接）**；§1–§9 是 2026-08-24 階段 1–4 的交接快照，角色與流程仍適用，但其中的分支、數字與待辦已過時。

---

## 0. 階段 5 交接（2026-09-24）〔修訂 2026-09-24〕

### 0.1 範圍、分支與狀態

- **範圍**：缺口分析（claude.ai 專案文件 `claude/gap-analysis-2026-09-24.md`）的 P0 項目 G01–G10，需求 DEC-014～019（核准欄待 Owner 簽核）→ FR-021～035。契約：[`interfaces-stage5.md`](interfaces-stage5.md)（裁決 S5-1～S5-39 在第 9 條）。
- **分支**（本機 worktree 在 `/home/claude/wt/<名稱>`）：`stage5/base`（`caf906f`：契約、migrations 0010–0012、旗標與前端骨架）→ 五條程式 WS `stage5/ws-a`～`ws-e`、三組知識點內容 `stage5/kc-math`／`kc-phys`／`kc-chem` → **`stage5/integration`**（`6f8e671`，全部併入）→ 文件回填 `stage5/int-docs`（本檔所在）。
- **實際合併順序**：WS-A → WS-C → WS-D → WS-E → KC-M → KC-P → KC-C → 整合 chore（`bbea5e6`：WS-A 的 ADR 改號為 ADR-015、`.env.example` 去掉重複的 `MODEL_KC_TAG`）→ WS-B（審查修正由主控接手提交 `6fe425a` 後併入）。`#remedial`／`#coverage` 子錨點在 WS-E 的合併提交（`93ba65d`）解衝突時補上。
- **狀態**：整合分支 stage5/integration 當下：unit 2253、integration 471、e2e 11，另有整合補測進行中（主控合併後更新數字）；完整 `ci.sh`（unit、check:html、migrate、integration、e2e、五個 eval replay）全綠，五個 eval 量測值與 base 相同、沒有重錄任何 cassette。**尚未併入 main。** 化學的跨 WS 行為（化學題標知識點、化學補救卷、化學家教）依契約第 7 條由整合階段補測，本檔撰寫時仍在進行中。
- **功能文件**（權威）：[`grading-and-profile.md`](grading-and-profile.md)（WS-A）、[`chemistry.md`](chemistry.md)（WS-B）、[`knowledge-components.md`](knowledge-components.md)（WS-C）、[`remedial.md`](remedial.md)（WS-D）、[`tutor.md`](tutor.md)（WS-E）、`kc-review-數學.md`／`kc-review-物理.md`／`kc-review-化學.md`（知識點內容抽查）。共用文件（`engineering_docs/**`、兩份 README、本檔、`roadmap-plan.md` §7）已於 `stage5/int-docs` 回填。
- **上線步驟**：`engineering_docs/06_ops/deployment_and_operations.md` §3.4（備份 → migrate → `kc:load` 先 `--dry-run` → **`search:reindex` 必跑** → `solution:backfill` 先 `--dry-run` → 逐一開旗標）。

### 0.2 Ben 待辦

**簽核與裁決**

1. 簽核 `engineering_docs/01_requirements/requirements_tracker.md` 的 DEC-014～019 與 DEC-003 例外條款（核准欄，AI 不代填）；ADR-014、ADR-015 狀態為「提議」，請一併審閱。
2. 確認補救卷選題規則（`remedial.md` 第 3 節：Wilson 下界、k=min(3,⌈n/2⌉)、先備難度 ≤3、延伸難度 ≥ 平均＋1、跨科先備不納入、不足量不自動補）與兩條待確認裁決：S5-26（「加入補救卷」掛在 variants.js）、S5-28（confirm-paper 不重驗承上組）；既有待辦 `FOLLOW_UP_SHORTFALL_POLICY` 現在也作用於跨章配額（S5-29）。
3. 決定 S5-11：文字型答案單位衝突維持「無法判定」或改成「不一致」（改只動 `compareText` 一行＋`answer_chem.json` 的 unit-007）。
4. 決定是否另開裁決讓助教工具說明書與 NLQ 的 LLM 輔路徑支援化學（兩者都要重錄 cassette，S5-13）。

**內容審定（AI 草擬，第一次 `kc:load` 前後）**

5. **數學知識點的章節切法要在第一次 `kc:load` 之前決定**（`kc-review-數學.md` 第 2 節 11 點，尤其第 1、2、6 點；搬移知識點會改變 code）；並確認第 1 節最沒把握的 10 條（轉移矩陣行／列、百分位數、標準差分母、信賴區間 2 或 1.96 等）。
6. 物理：熱學要不要另立章（動到 `LEGACY_CHAPTERS` 需重錄全部 cassette）、必修與選修重疊概念拆或合（`kc-review-物理.md` 第 3 節 D，16 組）、「聲波與交互作用」章名原意、電容器與偏振要不要補；口語版風格與核可範例差距大（平均 129 字、多數未對學生說「你」），建議先定目標長度與句型再逐章改寫。
7. 化學：`kc-review-化學.md` 第 3 節 A–L 的章節切法、游離能例外的解釋版本、燃燒分析吸收劑依哪版課本、三個比喻是否合格、第 4 節建議的 5 條跨科先備（目前未寫入）。
8. 逐章審定口語版（三科 637 個，已審定 4 個；數學「向量內積」.01、.03 的重寫可當其餘草稿的寫法樣本），用知識點分頁的「朗讀」聽一遍再按「審定通過」；`curriculum_code` 全部是 null，有把握再補。
9. 化學章節表 `exam_pro/config/chemistryChapters.js`、44 句例句、化學別名；逐筆定案 `eval/golden/classify_chem.json`（24 筆）並抽查 `answer_chem.json`。
10. 錯因白名單（`config/errorTypes.js`，代碼有資料後只能新增、不能改名）與學生檔案選項（`config/studentProfile.js`）是否符合你的學生。

**實機與花錢的動作**

11. 照上線步驟升級正式庫；`solution:backfill` 先 `--dry-run` 再 `--limit 20`，讀幾題驗算摘要（模型寫的、未經審閱）再全補。
12. 瀏覽器實際走一遍（全部前端只以 miniDom 測過）：批改卡錯因與部分給分、錯因分布、學生檔案、題目詳解欄、Word 三種版本、化學卷上傳、知識點分頁（朗讀聲音）、補救卷與覆蓋率、AI 家教兩種模式、按住說話（**確認 Gemini 接受 Chrome 的 audio/webm**）。
13. 用 Microsoft Word 開一份含化學式與反應箭頭條件的卷，確認 `m:groupChr`、同位素前標與正體。
14. 錄製化學 classify cassette（約 24 次 `MODEL_EXTRACT`）：`LLM_MODE=record node --env-file=.env eval/classify_chem.js`，再決定是否設門檻或併入 CI（需另開裁決）。
15. 查證 `MODEL_VOICE` 的音訊輸入單價補進 `config/pricing.js`；確認 `TUTOR_DAILY_BUDGET_USD`（預設 1.0）與 `MODEL_TUTOR`（預設 Pro 級）；在錄第一批 tutor cassette 前審閱 `services/tutorService.js`、`services/voiceService.js` 的 SYSTEM（之後改一字鍵就變）。
16. `npm run kc:backfill -- --dry-run` 看題數與估價 → `--limit 20` 試跑 → 決定 `KC_TAG_MIN_CONFIDENCE` 與是否開 `FEATURE_KC_TAGGING`；要量標註準確率需先人工標一批 golden。
17. （選做）錄 20–30 題家教問答（數學、物理各半，含引導式）建立家教 eval。

### 0.3 已知限制（未修的審查發現與開放問題）

**WS-A（審查六項 low 未進修正輪）**

- 老師用 PUT 改了題幹或答案但沒動詳解時，`verify` 來源的詳解仍保留並標「與答案比對一致」（回填腳本會略過這種題，PUT 路徑沒有）。
- 把「錯」改成「對」時部分給分不會自動清除：`result=1, score=0` 會被知識點弱點與補救卷（`COALESCE(score, result)`）當成全錯。
- 合併學生時，來源學生的檔案（年級、學校、備註…）被捨棄，只保留目標學生的；UI 未提示。
- `test/integration/students.pg.test.js` 有一個測試標題仍寫「五個頂層鍵」，斷言已是六個。
- `GET /api/questions/:id` 未限定數字路徑，之後新增 `GET /api/questions/<字面>` 須註冊在它之前（S5-8）。
- Word 詳解版不標示詳解來源，未經審閱的驗算摘要與老師寫的看起來一樣；複核核准入庫的題不寫詳解（靠回填）。

**WS-B（化學）**

- 化學路徑沒有任何 cassette：化學的拆題、分類、驗答、變式品質都沒量測；`eval:classify-chem` 待錄。
- NLQ 的 LLM 輔路徑與助教工具說明書仍只懂數學／物理（S5-13）；別名衝突：「碰撞學說」被物理「碰撞」吃掉、「原子結構」對到物理，要打完整章名。
- mhchem 子集限制（`\ce{Fe3+}` 讀成 Fe₃⁺，要寫 `Fe^{3+}`；不支援 `\pu`）；`embedText` 未改，`\ce{H2O}` 在 embedding 文本會出現「ce」字樣。
- 答案後方單位的讀取是啟發式；化學題的 `/similar` 沒有專門測試。

**WS-C（知識點）**

- `kc_tag` 從未對真 Gemini 執行；動態 enum schema 的線上相容性未驗證；沒有標註準確率 eval。
- 老師清空某題標註後不會被記住，`kc:backfill` 會再挑到；只有管線入庫會自動標（複核核准、手動新增的題要靠回填）；題目改章節或科目不會重標。
- `KC_TAG_MIN_CONFIDENCE` 以 `parseFloat` 解析，`0.8x` 會被讀成 0.8（文件寫「非法值退回 0.6」只對讀不出數字的值成立）。
- 草稿知識點在分頁上改了但沒審定，重新 `kc:load` 時會被種子檔覆寫，卡片上沒有提示。
- 標註費用不記入 `job_events`、不計入 `DAILY_COST_BUDGET_USD`（只在管線觸頂後擋下標註）；`eval/tools/check_html.js` 的頁面契約清單還沒有階段 5 的三個 module。

**WS-D（補救卷）**

- 直接呼叫 `confirm-paper` 仍可送出半組承上題（把關在草稿畫面，S5-28）；確認後卷名沿用「第一題的章節」，補救卷看起來像單章卷。
- 跨章配額（blueprint）只有 API，組卷分頁沒有畫面；選題參數是經驗法則，需實際使用後調整。

**WS-E（AI 家教與語音）**

- 從未呼叫真 Gemini：引導式是否洩答、是否真的用 code execution 驗算、thinking 預算是否足夠都未量測；家教沒有 eval。
- 每日預算只在程序內（重啟歸零）；語音的音訊輸入沒有分開計價，成本可能低估；題目附圖不送給家教。
- **MathJax 未載入 `ui/safe`**：受 LLM 影響的數學式理論上可產生 `javascript:` 連結（全站既有風險）。建議設定與驗證步驟見 `tutor.md` 第 8 節，需瀏覽器實測，尚未處理（S5-35）。
- `tutor.md` 操作說明寫「家教會記得最近 8 輪對話」，實際是最近 8 則訊息（約 4 次問答）。
- `utils/pseudonym.js` 對題幹同樣生效：學生若剛好叫「小明」，應用題裡的小明也會被換成代號再換回來。

**整合**

- `test/integration/followUp.pg.test.js` 在多條 CI 同時跑的負載下偶發失敗（base 上也會發生，非階段 5 引入），重跑會過。
- 契約第 1.7 條的共用文件已回填；測試數字待主控把整合補測併入後更新（本輪各文件都寫「整合分支 stage5/integration 當下」）。

### 0.4 下一步（主控）

1. 把整合補測與本文件回填併入 `stage5/integration`，重跑完整 `ci.sh`，更新各文件的測試數。
2. 併入 main、push、看 GitHub Actions；之後再請 Ben 照 §0.2 走上線與審定。
3. 後續缺口（錯題重練與間隔複習、訂正卷、學習路徑與報告、學生端）依 DEC-003 例外條款、DEC-016、DEC-017 另立契約，FR 自 FR-036 起分配。

---

## 1. 專案與角色

- **專案**：家教數理題庫系統 `exam_pro/`（Node 24 / Express 5 / PostgreSQL 16 + pgvector（Docker）/ Gemini）。repo `C:\Users\Administrator\Desktop\tutor-exam-bank`（2026-08-26 由「期中專案」改名），GitHub `Tom-Yang-Ben/tutor-exam-bank`，CI = GitHub Actions（`unit` 22/24 + `integration`）。
- **使用者**：Ben（家教老師兼一人開發者），偏好「直接幫我做」；重大、不可逆、花錢的動作要先問。用繁體中文。
- **這個對話（我）的角色**：**整合者／審查者**，不是施工者。施工由四個平行的 Claude Code 對話在四個 git worktree 裡做；我負責：寫分工與提示詞、審 S0 的介面凍結、掃進度、在 scratchpad 做四合一試合併並跑全部測試、整理各 WS 的 `questions*-ws*.md` 成裁決、把裁決寫進 `interfaces*.md`、產出通知檔、合併進 main、push、看 CI、錄 cassette、維護 README／memory。**主目錄的 Claude 對話不做 WS 的工作。**
- **worktree**：`..\tutor-exam-bank-wsA/B/C/D`（四個獨立資料夾，各自 branch）。每個階段開新分支、開**新的** Claude 對話貼提示詞。**（2026-08-26 已拆除**：階段 1–3 的 14 條 workstream 分支確認全數併入 main 後連同四個 worktree 一併清除；下一輪平行作業時照上述體例重建。）

## 2. 三階段的狀態（都已合入 main 並 push）

| 階段 | 狀態 | 關鍵文件 |
|---|---|---|
| 規劃 | `docs/roadmap-plan.md`（六章：排程、資料層、Agent 管線、產品面、橫切、階段 4 產品收斂）；Artifact https://claude.ai/code/artifact/14b7e7a6-2a59-4991-8cee-022ecf19220f | — |
| 階段 1 資料層 | **完成並上線**（2026-08-21 MySQL→PG 切換、D-X1 收尾：mysql2／DB_*／schema.sql 已移除） | `docs/interfaces-stage1.md`（裁決 1–27）、`docs/archive/stage1-parallel-prompts.md`、`docs/archive/human-lane-stage1.md`、`docs/archive/cutover-runbook.md` |
| 階段 2 Agent 管線 | **完成**（三輪合併、cassette 錄齊、CI 綠；`FEATURE_PIPELINE=true` 已在本機 `.env`）；A-T16 前後對照**使用者選擇先跳過** | `docs/interfaces-stage2.md`（S0-1～6、S2-1～30）、`docs/archive/stage2-parallel-prompts.md` |
| 階段 4 產品收斂 | **W1 四項完成（2026-08-24，`0c79865`＋`7d7764f`）**：學生改成選的（含管理面板：改名／合併／刪除）、出卷草稿→確認（dry_run／exclude_ids／confirm-paper／刪卷）、批改「未批全對」、時間窗預設 365。裁決 S4-1～S4-4。擱置：P-16、主控 agent 展示 | `docs/roadmap-plan.md` §6（2026-08-26 併自 stage4-plan.md） |
| 階段 3 產品面 | **結案（2026-08-24）**：兩輪合併、S3-R1～R29、cassette 錄齊、五個 suite 硬門檻、README 數字（P-15b）、四旗標開啟且**使用者試用通過**；pricing.js 已填官方價格 | `docs/interfaces-stage3.md`（§15 = 裁決）、`docs/archive/stage3-parallel-prompts.md` |

> **docs/ 歸檔（2026-08-25）**：已結案的一次性協調文件（`questions*-ws*.md`、`stage*-parallel-prompts.md`、`human-lane-stage1.md`、`cutover-runbook.md`）已移入 `docs/archive/`（索引見該資料夾 README）；四份 `ws-notices-*.md` 已刪除——內容 100% 收錄於 `interfaces*.md` 的裁決節（§12／§12.1／§15），git 歷史可查。

main 最新：`0ff47b4`（階段 4 第一批：A1 對話式助教 + 清理）。第一批內容：A1 助教（主控 agent＋五個只讀工具，FEATURE_ASSISTANT，本機 .env 已開）；C1 wsb_test 已 DROP；C2 測試學生已由使用者清空（備份在 exam_pro/backups/manual-20260824-1356-*.dump）；C3 MySQL 歸檔已驗證（Desktop/期中專案_資料庫備份/ 的 cutover dump 即歸檔，服務停用後資料未變），**9/4 回滾窗口過後**才可解除安裝 MySQL80 與刪資料目錄。擱置：P-16、B 批（私有 golden、閾值 0.88、fixture 120、A-T16）。
單元 1404、整合 259、e2e 11、check:html、五個 suite 硬門檻全過；CI 全綠。四個 worktree 已 ff 到同一點。

## 3. 階段 3 現在卡在哪、下一步

> **2026-08-24 結案**。四個旗標已在本機 .env 開啟（FEATURE_STUDENTS／NLQ／VARIANTS／SIMILAR=true），使用者實測：學生分頁、NLQ、找相似、出變式都正常——注意時間窗預設 90 天，示範資料在 5/17～5/21，要選 180 天才看得到。pricing.js 已填官方價（`7861a25`），live 路徑的 cost_usd 從此有真數字。
> **待使用者裁決的資料問題**：students 表有「小」「名」「華」三個單字名學生（舊 MySQL 5/21 的考卷本來就這樣建，非遷移 bug）；「名」→小明、「華」→小華好猜，「小」是誰只有老師知道。答案定了再併（attempts 有 (student_id, question_id) 唯一鍵，併時要處理衝突）。
> ~~待裁決的介面缺陷（階段 2 遺留 Q6）~~ → **已修（2026-08-27）**：依 `docs/archive/questions2-wsD.md` Q6 的選項 A 落地（含超集一般化：整串去標點後全是 A–H 字母、且裸字母層是標號層的超集時改用裸字母層），`B、D`／`B.D.`／`A、B、C` 都抽得到完整集合；「A. 互相垂直」這類帶敘述的標號不受影響。案例見 `test/unit/answerCompare.test.js`。
> 下一階段沒有現成規劃——候選見 §3.5 與結案回報。

1. ~~第二輪小修~~ **已完成**（2026-08-24 合入 `5facafe`，A／B／C／D 的 questions3-ws*.md 全部結案）。目前沒有發給 WS 的新工作；若第三輪有需要，再開新分支貼新提示詞。
2. ~~nlqHeuristics.js 的字面 NUL~~ **已修**（`5e26224`，改成 `'\u0000'` 逸出）。WS-B 留下的私有測試庫 `tutor_exam_bank_wsb_test` 不用了可 DROP。
3. ~~variant cassette~~ **已錄並依 S3-R29 重錄**（`VARIANT_OFFTOPIC_SIM_MIN` 0.92 → 0.90；`.env`／`.env.example`／三處程式預設同步）：`gate_pass_rate` 0.15 → **0.25**（21/30 藍本仍停 off_topic、4 停 verify、5 全過），`retrieved_coverage` 0.8667。0.92 的由來與為何錯：S3-R9 用 fixture「同概念換數字」的現成題對校準（餘弦 ≥ 0.93），但那正是只改字閘門 S3-R8 要退回的東西；實錄合格變式餘弦多在 0.85～0.92（`docs/variants.md` 第 3／4 節）。若還想再降（0.88），同樣要重錄（record 模式會重呼叫全部 ≈ 90 次 LLM、~25 分鐘）。
4. ~~golden 定案 → `--write-baseline`~~ **已完成（2026-08-24）**：nlq 門檻 rules 0.81／0.97／0.97、llm 0.72／0.845；variant 0.8367／0.22（皆量測 −0.03，只升不降）。接下來（使用者）： `.env` 開 `FEATURE_STUDENTS／FEATURE_NLQ／FEATURE_VARIANTS／FEATURE_SIMILAR=true` 試用三個新分頁；~~P-15b~~ 已完成（2026-08-24，`f6d477e`：README 八格數字補完，附日期／模型 ID／commit）。
5. 階段 3 結案後沒有階段 4 規劃；可選的後續：A-T16 前後對照、`config/pricing.js` 填官方價格（目前全 0，`cost_usd` 恆 0）、私有 golden（真題庫）。

## 4. 本機環境（已確認）

- Docker：`exam_pg`（開發庫，**埠 5442**，5432 被原生 PG17 佔用）、`exam_pg_test`（測試庫 5433，tmpfs）。`npm run db:up` 起來。
- `exam_pro/.env`（不進版控）重點：`DATABASE_URL=...5442`、`TEST_DATABASE_URL=...5433/..._test`、`GEMINI_API_KEY`（**付費層**，2026-08-23 開通）、`EMBED_MODE=live`、`LLM_MODE=live`、`MODEL_EXTRACT=gemini:gemini-3.5-flash`、`MODEL_VERIFY=gemini:gemini-3.1-pro-preview`、`GEMINI_RPM=30`、`FEATURE_PIPELINE=true`；階段 3 的旗標尚未加（預設 false）。
- migrations 0001–0005 兩庫都套用；階段 3 不需新 migration。
- 每日 02:00 Windows 工作排程器「題庫每日備份」→ `exam_pro/backups/`；MySQL80 服務已停（Manual），資料庫保留不動；`Desktop/期中專案_資料庫備份/` 有 cutover dump。

## 5. 協作規則（凍結介面制度）

- 三份 `docs/interfaces*.md` 是凍結契約，**只有我（代使用者）可以改**；各 WS 發現問題寫 `docs/questions<N>-ws<X>.md`，我整理成裁決（編號 S2-*／S3-R*）寫進對應檔的裁決節，並產 `docs/ws-notices-*.md` 給使用者貼。（歷次 questions 檔已結案歸檔於 `docs/archive/`；ws-notices 為拋棄式通知稿，用完即刪。若開新一輪平行作業，照此體例在 `docs/` 開新檔即可。）
- 檔案所有權表在各 `interfaces*.md` 的 §10；`routes/index.js` 分區塊 append-only；`package.json` scripts 歸 WS-D；`.env.example` 只有 S0／我改。
- 測試金字塔：`npm test`（不連 DB／不連 Gemini）；`test/integration/` 只讀 `TEST_DATABASE_URL`（`_test` 後綴）；**整合測試必帶 `--test-concurrency=1`**（各檔共用測試庫會互相 TRUNCATE）；e2e `npm run test:e2e`。
- eval：`eval/run.js --suite retrieval|classify|pipeline|nlq|variant`，CI 恆 `LLM_MODE=replay`／`EMBED_MODE=fixture`；replay miss 在 main 是錯誤；門檻 `eval/thresholds.json` = 第一次量測 −0.03、只升不降（ratchet）；cassette 鍵含模型 ID（`config/models.js` 是單一真相，`ci.yml` 明寫）。
- 原則：prompt 不是保證、伺服器端驗證才是；協調層是程式碼；部分入庫；量測驅動。

## 6. 我的標準流程（照做即可）

**看進度**：
```bash
cd "C:/Users/Administrator/Desktop/tutor-exam-bank" && for d in wsA wsB wsC wsD; do p="../tutor-exam-bank-$d"; echo "=== $d ($(git -C $p branch --show-current)) ahead $(git -C $p rev-list --count main..HEAD) behind $(git -C $p rev-list --count HEAD..main)"; git -C $p log --oneline main..HEAD | head; git -C $p -c core.quotepath=false status --short | head -5; ls $p/docs/questions3-*.md 2>/dev/null; done
```
**試合併**（在 scratchpad 開臨時 worktree，不碰 main）：
```bash
SCR="<scratchpad>/integN"; git worktree add "$SCR" -b integ/xxx main; cd "$SCR"; for b in <四個分支>; do git merge --no-edit "$b" || { git merge --abort; echo CONFLICT; }; done
cd exam_pro && cp ../../tutor-exam-bank/exam_pro/.env .env && npm ci
npm test
node --env-file=.env --env-file=eval/.env.replay --test --test-concurrency=1 "test/integration/**/*.test.js"
for s in retrieval classify pipeline nlq variant; do node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite $s | tail -2; done
```
全綠（或紅都可解釋）→ `git merge --ff-only integ/xxx` 進 main → `git push origin main` → 四個 worktree `git merge --ff-only main` + `npm ci` → `gh run watch <id>` 看 CI → 刪臨時 worktree 與分支。
**裁決**：讀四份 questions → 寫裁決表進 `interfaces-stageN.md`（新增一節，優先於條文）→ 必要時改 `.env.example`／`.gitignore` → 寫 `docs/ws-notices-roundK-stageN.md`（四段，可直接貼）→ commit、push、ff worktrees → 回報使用者。
**commit 訊息**：繁中、`feat|fix|docs|eval|test(範圍): 說明`，結尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 7. 錄 cassette（需要金鑰，只在主目錄 main 上做）
```bash
cd exam_pro
LLM_MODE=record EMBED_MODE=record node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite nlq       # 已錄
LLM_MODE=record EMBED_MODE=record node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite variant   # 已錄（約 25 分鐘；背景 Bash 10 分鐘會逾時，用 PowerShell Start-Process 分離跑）
node --env-file=.env --env-file=eval/.env.replay eval/run.js --suite <s>   # replay 驗證
git add eval/cassettes eval/fixtures/embeddings.*.json
```
（shell 環境變數優先於 `--env-file`；付費層 `GEMINI_RPM=30` 可行。）

## 8. 踩過的坑（避免重踩）
- Git Bash heredoc 會吃掉 `\\`：寫含反斜線的 JS／測試一律用 Write／Edit 工具，不用 `cat <<EOF`。
- repo 檔案多為 CRLF：用 node 做字串替換時 `includes('...\n...')` 會對不上，用 regex 或 Edit 工具。
- 自動模式的 classifier 會擋某些寫正式庫／系統的指令（`import_pg.js --apply`、`schtasks`、`Register-ScheduledTask`）：請使用者在對話框用 `! <指令>` 自己跑（注意 Git Bash 的 `/Create` 要加 `MSYS_NO_PATHCONV=1`）。
- `config/db.js` 只認 `DATABASE_URL`；**eval／測試凡會寫表者只准連 `TEST_DATABASE_URL`**（裁決 26）。
- Node 22 vs 24 差異：`Math.pow` 浮點（科學記號改字串 e-notation）、`--check` 模組偵測（暫存目錄放 `package.json` 釘 commonjs）。
- 免費層 Gemini 每模型每日 20 次；現已付費。
- 主目錄 `exam_pro/node_modules` 偶爾壞掉 → `npm ci`。
- 四個 worktree 的 `.env` 是從主目錄複製的；`npm ci` 要各自跑。
- **FEATURE_SIMILAR=true 時 e2e 的 dedup1 需要 sample PDF 題的向量**：CI 沒設這個旗標，dedup1 一路 skipped 所以恆綠；本機 .env 開著就會 embed fixture miss → 0 題入庫。已於 0c79865 補錄 16 筆向量進 fixture；之後 fixture 若重建，記得用 LLM_MODE=replay EMBED_MODE=record FEATURE_SIMILAR=true 跑一次管線補齊。
- bash 裡 node -e 的字串**絕不能含反引號**（會被當指令替換執行——踩過兩次，一次把 nlqHeuristics.js 當 shell 跑出五個空檔案）：多行編輯一律先 Write 腳本檔再 node 執行。

## 9. 給新對話的起手式
1. 讀本檔 + memory（自動）。
2. 跑 §6「看進度」。
3. 依狀態接續：四條第二輪未完 → 等；完了 → 試合併 → 合併 → CI；之後處理 variant 錄製（先問費用）、golden 定案、門檻、試用、README 數字。
4. 回報時用表格、講清楚「做了什麼／數字／接下來要使用者做什麼」。
