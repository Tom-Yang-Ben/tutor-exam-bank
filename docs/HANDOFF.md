# HANDOFF — 給下一個 Claude Code 對話的交接檔（2026-08-24）

> 目的：這份檔案讓新的對話在**不重讀歷史**的情況下接手「整合者／審查者」的角色。
> 讀完本檔後，第一件事通常是執行 §6 的「看進度」流程。
> 配套：`~/.claude/projects/.../memory/` 裡有 `roadmap-master-plan.md`、`stage1-status.md`、`stage2-status.md`、`stage3-status.md`（系統會自動載入索引）。
>
> 〔修訂 2026-09-24〕**最新狀態先看 §0（階段 5 交接）**；〔修訂 2026-09-25〕章節重整的交接在 §0.0，本機模式（Ollama＋PaddleOCR、預設不連外）在 §0.0a。§1–§9 是 2026-08-24 階段 1–4 的交接快照，角色與流程仍適用，但其中的分支、數字與待辦已過時。
> 〔修訂 2026-09-26 決策單〕Owner 2026-09-25 在「出題系統決策單」的第一輪答案整理在 **§0.00**（含第二輪審定單待答項目）；§0.0、§0.0a、§0.2 被決定的項目已就地加註，原文保留。

---

## 0. 階段 5 交接（2026-09-24，最終審查後改寫）〔修訂 2026-09-24b〕

### 0.00 Owner 決策單第一輪（2026-09-25）〔修訂 2026-09-26 決策單〕

> 來源：Owner（Ben）2026-09-25 在「出題系統決策單」填的第一輪答案，2026-09-26 由 AI 登錄進文件（分支 `dec/docs-owner-decisions-round1`，只改文件、不改程式）。
> 「狀態」欄：**已定**＝照答案記錄，不必再動程式；**實作中**＝由括號內的分支實作，合併之前程式仍是舊行為；**第二輪待答**＝等第二輪審定單；**待決**＝Owner 選擇先觀察再定，AI 不代為決定。
> AI 不代填任何「核准」欄：B1 只記錄 Owner 選擇維持 enforce，`requirements_tracker.md` 的 DEC-013「核准」欄仍待 Owner 明示簽核。

| 代號 | 決定 | 狀態 | 影響 |
|---|---|---|---|
| A1 | #61、#62 兩題 AI 自撰的干擾題照現稿用（題目與答案核可） | 已定 | fixture 不改；`eval/CHAPTER_RELABEL-2026-09.md` 第 2.1、6、8（狀態列）、8.6 節註記 |
| A2 | #52（甲乙兩車相對速度）維持「直線運動」 | 已定 | 不改標；直線運動不必補干擾題（CHAPTER_RELABEL 第 8.6 節第 3 項） |
| A3 | nlq-036 的計分：重錄完看分數再決定 | 待決（等重錄） | `filtersExact` 不改；重錄後由 Owner 決定要不要另開裁決 |
| A4 | retrieval R017／R018／R035／R036 的負樣本不動 | 已定 | `retrieval.json` 不改（R031～R034 同樣不動；#61、#62 不加進 hard_negatives） |
| A5 | 第一冊「指數與對數」只教常用對數（一般底數、換底、指數方程式在第三冊） | 已定（維持現況） | #1～#4、#7 等維持「指數函數與對數函數」；`kc-review-數學.md`「指數與對數依常用對數分冊」的前提成立 |
| A6 | 白名單外內容（數學邏輯、空間向量加減、物理熱學）放進既有章當知識點 | 方向已定；細節第二輪待答 | 不新增章名，白名單與 cassette 不動；放哪一章、寫哪幾條在知識點審定單 |
| A7 | 本機重錄後低於門檻：門檻數字不動，讓它紅燈，之後改善（不依本機模型重建基準） | 已定；PR 能否帶紅燈合併→第二輪 X1 待答 | `eval/thresholds.json` 不動；`local-mode.md` LM-14、第 6 條第 3 點、10.5、10.7 |
| A8 | 合併路徑：開一個 PR，`local/integration` → main（已含章節重整全部 commit） | 已定（PR 尚未開） | 取代 §0.0「先合 `stage5/integration`、再開 `stage5/chapters` 的 PR」；`stage5/integration` 已由 PR #38 合入 main（origin/main `d1834ac`） |
| A9 | 數學知識點歸屬「我要調整」。Owner 備註原文：「期望值放在古典機率，隨機變數是選修數甲的機率與統計，數學歸納法是數列與級數，推移矩陣是矩陣，複數是選修數甲，勘根定理是選修數甲的微積分，反方陣也是矩陣」 | 多數與草案一致；勘根定理與「期望值」的意思第二輪待確認 | **先不跑 `kc:load`**；`config/kc/數學.json` 等第二輪答完再改（`kc-review-數學.md` 第 2 節） |
| A10 | 物理會改知識點代碼的項目：先不載入知識點，改由第二輪審定單直接出題（把這些項目直接列成題目請 Owner 作答） | 第二輪待答 | 物理同樣先不跑 `kc:load` |
| A11 | 化學章節表照目前草案定稿（依龍騰） | 已定 | `config/chemistryChapters.js` 章名不動（只改註解）；`chemistry.md`、`interfaces-stage5.md` 第 3.3 條改為定稿；DEC-019 業務驗收「三科章節表經 Owner 定稿」的化學部分滿足 |
| B1 | 拆題後對照原卷檢查（DEC-013）維持 enforce（擋下） | 行為已定；DEC-013 核准欄仍待 Owner 明示簽核 | `SOURCE_CHECK_MODE` 維持 enforce；`requirements_tracker.md` 只在備註與決策沿革記錄 |
| B2 | ADR-014、ADR-015 接受；ADR-017 等本機實測後再定 | 已定 | ADR-014、ADR-015 狀態改為已接受；ADR-017 維持提議並註明原因 |
| B3 | 補救卷選題參數（S5-30）維持 | 已定 | 不改程式 |
| B4 | S5-11 文字型答案的單位衝突維持送複核（uncertain） | 已定 | 不改 `compareText` |
| B5 | S5-13 改為支援化學（助教工具說明書與 NLQ 的 LLM 輔路徑；需重錄） | 實作中（`dec/b5-chem-assistant-nlq`） | 兩者的 cassette 要重錄 |
| B6 | S5-26「加入補救卷」按鈕位置維持 | 已定 | — |
| B7 | S5-28 confirm-paper 伺服器端也檢查承上題整組 | 實作中（`dec/b7-followup-server-check`） | 直接呼叫 API 送半組承上題會被擋下（合併後生效） |
| B8 | S5-7 維持 | 已定 | — |
| B9 | S5-40 維持（error 退避期間該列已解鎖的既有設計不改） | 已定 | 管線行為不變 |
| B10 | 承上題湊不滿：改為直接報錯，請老師改題數（選項 B） | 實作中（`dec/b10-shortfall-error`） | `FOLLOW_UP_SHORTFALL_POLICY` 改 B；`roadmap-plan.md` §6.5 第 14 項、prd ACPT-019-7 |
| B11 | 錯因白名單與學生檔案欄位：用一陣子再說 | 已定（暫不改） | §0.2 第 11 項 |
| B12 | 知識點自動標註：先試 20 題看品質 | 已定；要等知識點載入之後 | §0.2 第 15 項（`kc:backfill -- --limit 20`） |
| B13 | 化學 eval 只當參考 | 已定 | 錄製後的分數只供參考，不設門檻、不當 CI 硬閘門（§0.2 第 16 項） |
| B14 | 化學教學取捨：Owner 要逐項看 | 第二輪待答 | `kc-review-化學.md` |
| B15 | 三科知識點逐章審定：找時間一次審完 | 第二輪待答 | 取代 §0.2 第 11 項「本週教哪章就審哪章」 |
| B16 | 未收錄的主題：之後需要再補 | 已定（暫不補） | — |
| B17 | 化學別名優先：維持 | 已定 | 「碰撞學說」「原子結構」仍要打完整章名（§0.3） |
| B18 | 本機拆題的限制：上傳幾份卷後再看 | 待決（實測後） | `local-mode.md` LM-12 |
| B19 | 本機家教：試幾題難題後再定 | 待決（試用後） | 本機家教沒有程式驗算（§0.0a 已知限制） |
| B20 | 舊題補附圖（roadmap 第 19 項）：做 | 工具實作中（`dec/b20-backfill-figures-tool`）；做哪幾份卷→第二輪 X2 待答 | 會寫正式庫、逐題人工確認對應 |
| B21 | `/analyze-pdf` 舊流程（roadmap 第 20 項）：保留並補裁圖（Owner 選 B，不採原建議 A） | 實作中（`dec/b21-legacy-analyze-pdf-figures`） | 兩條拆題路徑並存 |
| B22 | 下一輪開發順序照建議：錯題重練 → 間隔複習 → 診斷報告 → 入班診斷卷 → 學習路徑與提示 → 學生端 | 已定 | §0.2 第 20 項 |
| C | 本機模式暫不適用：補 Gemini 額度重錄、刪 Gemini cassette、語音與家教費用設定、標註費用未計入預算 | 本機模式下暫緩 | §0.0 的 Gemini 重錄、LM-14 的 `cassettes:prune -- --apply`、§0.2 第 13 項、§0.3 的標註費用 |

**第二輪待答（知識點審定單與 X 項）**：

- **知識點審定單**：A6 白名單外內容要放哪一章、寫成哪幾條；A9 勘根定理的歸屬（Owner 寫「選修數甲的微積分」，草案在 `多項式函數的圖形.06`）與「期望值放在古典機率」的意思；A10 物理會改代碼的項目（審定單直接列成題目）；B14 化學教學取捨逐項看；B15 三科知識點逐章審定。這些答完之前不跑 `kc:load`，B12 的 20 題試標也等載入之後。
- **X1**：本機重錄後 eval 紅燈時，A8 的 PR 能不能帶著紅燈合併。
- **X2**：舊題補附圖（B20）要做哪幾份卷。
- 另外等實測或重錄才定的（不在審定單上）：A3 nlq-036 計分、B18 本機拆題限制、B19 本機家教、ADR-017。

### 0.0 章節重整（2026-09-25）〔修訂 2026-09-25 章節重整〕

- **範圍**：數學 34→52 章、物理 32→34 章（刪「流體的壓力與浮力」「宇宙學簡介」，新增 4 章），對齊 108 課綱龍騰版目錄；化學章名不動（依龍騰版核對，知識點不需搬移）。契約 [`chapter-restructure.md`](chapter-restructure.md)（裁決 CR-1～CR-6 在第 8 條）、ADR-016。
- **分支：`stage5/chapters`**，基底 `stage5/integration`（含 `7184f53`：DEC-014～019 與 DEC-003 例外條款依 Owner 對話指示登錄為已核准）。組成：`stage5/chapters-base`（介面凍結、`config/chapterPlan.js`）→ CH-A（白名單換新、`npm run chapters:migrate`、migration 0014）、CH-B（eval 素材改標、`npm run cassettes:rerecord`／`cassettes:prune`）、CH-C（數學 254 個知識點）、CH-D（物理 196 個、化學恆等對照）→ 整合（CR-1～CR-6）。
- **狀態**：unit、check:html、migrate、integration 全綠；e2e 與五個 eval 的失敗**全部**是 replay miss 或缺 embedding fixture（白名單在 schema enum 裡，數學／物理 cassette 刻意失效）。依賴 cassette 的單元測試缺檔即略過（CR-4），重錄後恢復。
- **合併順序**：先合 `stage5/integration`（階段 5 PR）→ Owner 在 `stage5/chapters` 上重錄（`chapter-restructure.md` 第 5 條，Owner 的 Windows 本機執行，金鑰不離開本機）→ 主控核對門檻（低於門檻另開裁決，不自動放寬）→ 開 `stage5/chapters` 的 PR。〔修訂 2026-09-26 決策單〕`stage5/integration` 已由 PR #38 合入 main（origin/main `d1834ac`）；Owner 決定（A8）其後只開**一個** PR：`local/integration` → main（已含章節重整全部 commit），不再單獨開 `stage5/chapters` 的 PR。重錄後低於門檻：門檻不動、讓它紅燈（A7）；PR 能否帶紅燈合併在第二輪 X1 待答。
- 〔修訂 2026-09-25 CR-7／CR-8〕第一次重錄因 Gemini 預付額度用完而中斷，量到 classify 低於門檻；根因（例句與分冊矛盾）已修（CR-7），並在不呼叫 Gemini 的前提下完成全面審查與 Owner 裁決的 golden 改標、白名單分冊（CR-8）。**Owner 決定延後重錄**：`stage5/chapters` 暫不合併，等補額度後一次重錄（`npm run db:up` → `npm run migrate:test` → `npm run cassettes:rerecord`，約 US$0.75～2.82），主控再核對門檻。〔修訂 2026-09-26 決策單 C〕補 Gemini 額度重錄在本機模式下暫緩：重錄改用本機模型（§0.0a 第 4 步）。
- **上線**多兩步（已寫進下方 0.2 第 7 項）：`migrate` 之後 `chapters:migrate`（提議檔 → 老師確認 → `--apply`）、`embed:backfill`。

### 0.0a 本機模式（2026-09-25）〔修訂 2026-09-25 本機模式〕

- **範圍**：Owner 要求「所有步驟、功能都純地端、不連出去、不產生額外費用」。預設改成本機 Ollama（`qwen3-vl:8b` 只負責看頁面拆題；`qwen3:8b` 驗算／變式／OCR 結果整理，以及分類／lint／知識點標註／主控助教（`MODEL_TEXT`，LM-15：16 GB 的電腦不必在兩個模型之間換載）；`qwen3-embedding:0.6b` 向量）＋ PaddleOCR；PDF 拆題由 OCR 與視覺模型交叉驗證，不一致的題一律停在人工複核；語音關閉；Gemini 保留，改 `.env` 五行即可切回。契約與使用說明 [`local-mode.md`](local-mode.md)（使用說明在第 10 條）、ADR-017（狀態：提議；〔修訂 2026-09-26 決策單 B2〕Owner 決定等本機實測後再定）。
- **分支：`local/base`**（基底 `stage5/chapters` 的 522f81c）→ L1（Ollama 轉接層）、L2（本機 OCR 與交叉驗證）、L3（前端離線化）、L4（eval、CI、Windows 腳本、文件）→ 主控整合。
- **CI**：`.github/workflows/ci.yml` 的 `MODEL_EXTRACT`／`MODEL_VERIFY`／`EMBED_MODEL`／`MODEL_NLQ` 改成本機模型；CI 仍是 replay＋fixture，不裝 Ollama、不裝 Python。Owner 以本機模型重錄之前，e2e 與五個 eval 只會因缺 cassette／缺向量紅燈（契約第 8 條）。**若本機模式先合入，§0.0 的章節重整重錄就改用本機模型做，不必補 Gemini 額度**（仍照 `cassettes:rerecord`，只是不花錢、慢很多）。
- **Owner 待辦（依序；步驟細節見 `local-mode.md` 第 10 條）**：
  1. 安裝 Ollama 與 Python 3.11／3.12（64 位元）→ 雙擊 `exam_pro\scripts\windows\setup_local_ai.bat`（拉三個模型約 12 GB、建 `ocr_service\.venv`、下載 OCR 模型、自我檢查；log 在 `exam_pro\data\local_ai\`）。
  2. 改 `.env`（第 10.3 條）：舊 `.env` 明寫了 Gemini 的模型，要改；**刪掉 `JOB_PDF_CHUNK_PAGES=20`、`JOB_NODE_TIMEOUT_MS=120000`**（舊範本寫死的 Gemini 值會蓋掉本機預設，本機拆題一定逾時）。
  3. 正式庫換向量（第 10.6 條，免費但慢）：`npm run embed:backfill`（全部題目；模型不同的都會重算）→ `npm run search:reindex`。
  4. 雙擊 `exam_pro\scripts\windows\record_local.bat` 以本機模型重錄 CI 的回放檔（db:up → migrate:test → `cassettes:rerecord` 自動輸入 yes；錄前檢查 Ollama、模型、OCR、測試庫；印粗估時間，可能要一整天，可分次）；commit、push。舊的 Gemini cassette 先不要 `cassettes:prune -- --apply`，除非確定不讓 CI 切回 Gemini。〔修訂 2026-09-26 決策單 C〕刪 Gemini cassette 在本機模式下暫緩。
  5. 回放驗證若有 eval 低於門檻：`eval/thresholds.json` 的數字不動，由 Owner 另行裁決（契約第 6 條第 3 點）。〔修訂 2026-09-26 決策單 A7〕Owner 已裁決：門檻數字不動，讓它紅燈、之後改善，不依本機模型重建基準；PR 能否帶紅燈合併在第二輪 X1 待答。
- **已知限制**：CPU 上很慢（一份 4 頁考卷粗估數小時，**未實測**）；品質低於 Gemini、複核佇列會變長；自然語言查題的 LLM 輔路徑在預設 4 秒逾時下實際上用不到；家教沒有程式驗算；語音關閉。

> 本節取代同日稍早版本（`129d941`）。那一版寫於「整合補測」與「最終審查」併入之前，§0.3 有多項已修好，§0.2 以「類型」分組、順序有依賴問題。本版依最終 HEAD `936a6b5` 的實況重寫。

### 0.1 範圍、分支與狀態

- **範圍**：缺口分析 P0 項目 G01–G10；需求 DEC-014～019 與 DEC-003 例外條款（核准欄待 Owner 簽核）→ FR-021～035、NFR-007～009。契約與裁決：[`interfaces-stage5.md`](interfaces-stage5.md)（裁決 S5-1～S5-47 在第 9 條）。
- **交付分支：`stage5/integration`**（HEAD `936a6b5`）。基底是 `cb47dbe`（`docs/sync-after-prs-30-33`，該分支尚未併入 main，因此對 main 開 PR 時會連帶這一個文件同步 commit）。
- **組成**：`stage5/base`（契約、migrations 0010–0012、旗標與前端骨架）→ 五條程式 WS（`stage5/ws-a`～`ws-e`）＋三組知識點內容（`stage5/kc-math`／`kc-phys`／`kc-chem`）→ 整合補測（`stage5/int-code`）＋共用文件回填（`stage5/int-docs`）→ 最終審查修正（`stage5/int-fix`，含 migration 0013）。
- **狀態**：完整 `ci.sh` 全綠——unit 2287、integration 485、e2e 11、五個 eval（replay）量測值與階段 5 之前相同，**沒有重錄任何 cassette**。從未呼叫真 Gemini；前端只以 miniDom 測過，未在真瀏覽器操作。
- **migrations**：0010（批改細節、學生檔案）、0011（化學 CHECK、文字詳解、上傳卷別）、0012（知識點三表）、0013（老師修改標記：`questions.solution_cleared_at`、`knowledge_components.edited_at`）。全部只增不改，已在「只套到 0009、含舊資料」的庫上逐支驗證過。〔修訂 2026-09-25 章節重整〕數學／物理章節重整（[`chapter-restructure.md`](chapter-restructure.md)、ADR-016）另加 0014（`chapter_migration_log`：舊題搬章的處理紀錄；契約未預列，主控已核准，見 chapter-restructure.md CR-3）。
- **功能文件**（權威）：[`grading-and-profile.md`](grading-and-profile.md)、[`chemistry.md`](chemistry.md)、[`knowledge-components.md`](knowledge-components.md)、[`remedial.md`](remedial.md)、[`tutor.md`](tutor.md)、`kc-review-{數學,物理,化學}.md`。上線步驟：`engineering_docs/06_ops/deployment_and_operations.md` §3.4。

### 0.2 Ben 待辦（建議順序，待 Owner 確認）

排序原則：①會改變知識點代碼或章名的決定先做，只改文字的邊用邊做；②免費、可回滾的先做，花錢的後做、一次開一個；③越早讓新批改資料開始累積越好（診斷與補救卷的品質取決於資料量）。

**A. 交付與合併**

1. ~~取得 `stage5/integration`（GitHub 上的分支，或主控放進本機 repo 的分支），對 main 開 PR，看過再合併；GitHub Actions 綠燈才算完成。〔修訂 2026-09-25〕推送前確認含 `7184f53`（DEC 核准登錄）。~~ 〔修訂 2026-09-26 決策單〕已完成：PR #38 合入 main（origin/main `d1834ac`，含 `7184f53`）。
2. ~~本機切分支前先 `git checkout -- engineering_docs/01_requirements/requirements_tracker.md`~~ 〔修訂 2026-09-25〕Owner 已完成。
2a. 〔修訂 2026-09-25 章節重整〕切到 `stage5/chapters` 重錄 cassette（§0.0；步驟見 `chapter-restructure.md` 第 5 條），commit、push 後開 PR。〔修訂 2026-09-26 決策單 A8／A7／C〕改為：在 `local/integration` 以本機模型重錄（§0.0a 第 4 步，不補 Gemini 額度），之後開**一個** PR `local/integration` → main；低於門檻時門檻不動、讓它紅燈；能否帶紅燈合併在第二輪 X1 待答。

**B. 上線前只做「會改代碼或章名」的決定（約半天）**

3. ~~簽核 DEC-014～019 與 DEC-003 例外條款~~ 〔修訂 2026-09-25〕Owner 於對話中核准、由 AI 依指示登錄（`7184f53`）；DEC-013 仍待定。ADR-014、ADR-015、ADR-016 狀態為「提議」，請審閱。〔修訂 2026-09-26 決策單 B1／B2〕DEC-013：Owner 選擇維持 enforce（擋下），但決策單的措辭是「維持：擋下」而不是簽核，核准欄仍待 Owner 明示簽核。ADR-014、ADR-015 Owner 接受（狀態已改）；ADR-016 早已是「已接受」（2026-09-25 定案），原文寫「提議」有誤；ADR-017 等本機實測後再定。
4. 數學知識點章節切法——〔修訂 2026-09-25〕章節已照草案重整（§0.0）；`kc-review-數學.md` 第 2 節仍待 Owner 決定的：邏輯（新章表無對應章）、空間向量、期望值與隨機變數重疊、`平面方程式.06` 指向後章的先備；另有數學歸納法、推移矩陣、複數所在冊別與「指數與對數依常用對數分冊」的前提。**第一次 `kc:load` 之前**決定。〔修訂 2026-09-26 決策單 A5／A6／A9〕部分已答：「指數與對數依常用對數分冊」的前提成立（A5，維持現況）；邏輯、空間向量加減放進既有章當知識點（A6，細節第二輪待答）；歸屬 Owner 要調整（A9，原文見 §0.00），期望值的意思與勘根定理第二輪待確認；`平面方程式.06` 的先備未在第一輪答到，仍待決。**第二輪答完之前不跑 `kc:load`。**
5. 化學章節表 `exam_pro/config/chemistryChapters.js`——**第一次上傳化學卷之前**定稿，入庫的題會記章名。〔修訂 2026-09-25〕教科書版本定為龍騰；知識點歸屬已依龍騰目錄核對（`kc-review-化學.md` 第 3 節），請 Owner 抽看。〔修訂 2026-09-26 決策單 A11〕Owner 2026-09-25 定稿：照目前草案（依龍騰），章名不動。化學知識點的教學取捨（B14）與逐章審定（B15）在第二輪待答。
6. 物理「熱學另立章」**明確延後**：會改到數學／物理的章節清單（`LEGACY_CHAPTERS`），全部既有 cassette 都要重錄，另開裁決再議。〔修訂 2026-09-25 章節重整〕已由 2026-09-25 的章節重整一併處理（新章「理想氣體與氣體動力論」，見 [`chapter-restructure.md`](chapter-restructure.md)）；cassette 依該檔第 5 條由 Owner 重錄。〔修訂 2026-09-26 決策單 A6〕新章之外仍在白名單外的物理熱學內容，Owner 決定放進既有章當知識點（不再新增章），放哪一章在第二輪知識點審定單待答。

**C. 上線（不呼叫 LLM、不花錢；§3.4）**

7. 備份 → `npm run migrate`（到 0013；〔修訂 2026-09-25 章節重整〕併入章節重整後到 0014）→ 〔修訂 2026-09-25 章節重整〕`npm run chapters:migrate`（產生提議檔 → 老師確認 → `--apply`，步驟見 [`chapter-restructure.md`](chapter-restructure.md) 第 6.1 節）→ `npm run embed:backfill`（搬過章的題重算向量，費用很小）→ **`npm run search:reindex`（必跑，緊接 migrate）** → `npm run kc:load`（先 `--dry-run`；可跳過）→ `npm run solution:backfill`（先 `--dry-run`、再 `--limit 20`、抽讀）→ 啟動。〔修訂 2026-09-26 決策單 A9／A10〕這一輪**跳過 `kc:load`**：數學歸屬要調整、物理會改代碼的項目改由第二輪審定單處理，答完、種子檔改好之後再載入。
8. 瀏覽器實際走一遍核心延伸：批改卡（錯因、部分給分、對錯切換清分數）、錯因分布、學生檔案、題目詳解欄、Word 三種版本（詳解版的「AI 驗算摘要」加註）、小量化學卷上傳；貼一次 `$\href{javascript:alert(1)}{x}$` 確認不產生連結、`$\ce{2H2 + O2 -> 2H2O}$` 照常排版。
9. 用 Microsoft Word 開一份含化學式與反應箭頭條件的卷，確認排版。

**D. 開始累積資料（日常使用 1–2 週）**

10. 每次批改都標錯因（部分給分視需要）——這是弱點診斷與補救卷的原料。
11. 開 `FEATURE_KC`：**本週教哪章就審哪章**的口語版（朗讀聽一遍→修改→審定通過）；錯因白名單與學生檔案選項若不合用，在累積太多資料前提出。〔修訂 2026-09-26 決策單 B15／B11〕審定方式改為：三科知識點找時間一次審完（第二輪待答），不採「本週教哪章就審哪章」；錯因白名單與學生檔案欄位先用一陣子再說。
12. 開 `FEATURE_REMEDIAL`：先以章節為單位出補救卷（還沒標知識點時自動退回章節基底）。

**E. 小額花錢的功能（一次開一個，每開一個實際用一次）**

13. 查證 `MODEL_VOICE` 的音訊輸入單價補進 `config/pricing.js`、確認 `TUTOR_DAILY_BUDGET_USD` 與 `MODEL_TUTOR`；錄第一批 tutor cassette 前審閱 `tutorService.js`、`voiceService.js` 的 SYSTEM。〔修訂 2026-09-26 決策單 C〕語音與家教的費用設定在本機模式下暫緩（本機不花錢、語音關閉）。
14. `FEATURE_TUTOR`（文字，兩種模式）→ `FEATURE_VOICE`（桌機 Chrome、`http://localhost:3000`，確認 Gemini 接受 audio/webm）。〔修訂 2026-09-26 決策單 B19／C〕本機家教先試幾題難題再定（待決）；語音在本機模式下關閉，`FEATURE_VOICE` 暫緩。
15. **切法確定後**才補標舊題：`npm run kc:backfill -- --dry-run` → `--limit 20` → 全跑；看過品質再決定 `KC_TAG_MIN_CONFIDENCE` 與是否開 `FEATURE_KC_TAGGING`。〔修訂 2026-09-26 決策單 B12〕Owner：先試 20 題看品質；要等知識點載入（第二輪答完、`kc:load`）之後。
16. 化學：定案 `eval/golden/classify_chem.json`（24 筆）後錄 cassette（`LLM_MODE=record node --env-file=.env eval/classify_chem.js`），再決定是否設門檻、併入 CI。〔修訂 2026-09-26 決策單 B13〕Owner：化學 eval 只當參考——錄製後的分數不設門檻、不當 CI 硬閘門。

**F. 用過 2–4 週再決定**

17. 補救卷選題參數（`remedial.md` 第 3 節）與裁決 S5-11（文字型答案單位衝突）、S5-13（助教與 NLQ 的 LLM 路徑支援化學，需重錄）、S5-26、S5-28、S5-7（API 只送 `result` 時保留部分給分）。〔修訂 2026-09-26 決策單 B3～B8〕Owner 已答（不等 2–4 週）：補救卷參數 S5-30 維持；S5-11 維持送複核；**S5-13 改為支援化學**（`dec/b5-chem-assistant-nlq` 實作中，需重錄）；S5-26 維持；**S5-28 改為伺服器也檢查承上題整組**（`dec/b7-followup-server-check` 實作中）；S5-7 維持。
18. 管線既有設計「error 退避期間該列已解鎖、可被別的槽立刻重跑」要不要修（會改變管線行為，S5-40）。〔修訂 2026-09-26 決策單 B9〕Owner：維持，不修。
19. （選做）錄 20–30 題家教問答建立家教 eval；人工標一批題目→知識點 golden 以量測標註準確率。

**G. 下一輪開發（依相依順序；FR 自 FR-036 起）**

20. 錯題重練（DEC-003 例外，拆「派題」與「作答」）→ 間隔複習 → 診斷報告（老師／家長版）→ 入班診斷卷 → 學習路徑與提示階梯 → 學生端（最大，放最後）。〔修訂 2026-09-26 決策單 B22〕Owner：照這個順序。

### 0.3 已知限制（最終審查後仍未處理者）

- **品質未量測**：家教、語音、知識點標註、化學拆題／分類都沒有真 Gemini 執行與 eval；化學路徑沒有任何 cassette。
- **內容待審**：三科 637 個知識點只有 4 條已審定，`curriculum_code` 全為 null；化學章節表、例句、別名、`classify_chem.json`、`answer_chem.json` 都是 AI 草擬。〔修訂 2026-09-26 決策單 A11〕化學章節表已由 Owner 2026-09-25 定稿（照草案、依龍騰）；例句、別名、兩份化學 golden 仍是 AI 草擬。
- **批改**：直接打 API 只送 `{result:1}` 時舊的部分給分保留（前端已處理，S5-7）；合併學生會丟掉來源學生的檔案欄位；複核核准入庫的題不寫詳解（靠回填）。〔修訂 2026-09-26 決策單 B8〕S5-7 Owner 選擇維持。
- **化學**：NLQ 的 LLM 輔路徑與助教工具說明書只懂數學／物理（S5-13；〔修訂 2026-09-26 決策單 B5〕Owner 改為要支援化學，`dec/b5-chem-assistant-nlq` 實作中、需重錄）；別名衝突（「碰撞學說」「原子結構」要打完整章名；〔修訂 2026-09-26 決策單 B17〕Owner：別名優先維持）；mhchem 子集限制（`\ce{Fe3+}` 要寫 `Fe^{3+}`、不支援 `\pu`）；`embedText` 內 `\ce` 會留下「ce」字樣；上傳頁沒有「目前卷別」的醒目標示（選錯的後果已由 S5-44 處理）。
- **知識點**：老師清空某題標註後不會被記住，`kc:backfill` 會再挑到；只有管線入庫會自動標；標註費用不記入 `job_events`、不計入 `DAILY_COST_BUDGET_USD`（〔修訂 2026-09-26 決策單 C〕本機模式下暫緩）。
- **補救卷**：手動加題（題目 ID、找相似）不檢查變式家族互斥；直接呼叫 `confirm-paper` 仍可送出半組承上題（S5-28；〔修訂 2026-09-26 決策單 B7〕Owner 改為伺服器也檢查，`dec/b7-followup-server-check` 實作中）；確認後卷名沿用第一題章節；跨章配額只有 API 沒有畫面；新增學生後，補救卷／家教／覆蓋率的學生下拉要重整頁面才更新。
- **家教與語音**：每日預算只在程序內（重啟歸零）、同時送多個請求可略超上限；語音音訊輸入沒有分開計價；題目附圖不送給家教；姓名遮罩已補強（S5-46）但仍是字串比對，綽號不在名單內時擋不住。
- **路由**：`GET /api/questions/:id` 未限定數字路徑，之後新增 `GET /api/questions/<字面>` 須註冊在它之前（S5-8）。

### 0.4 下一步（主控）

1. 交付 `stage5/integration`：推上 GitHub（需把 repo 加入工作階段的授權來源），或放進 Owner 本機 repo 由 Owner 推送。〔修訂 2026-09-25〕Owner 已推送；`7184f53` 待推。
2. 〔修訂 2026-09-25〕`stage5/chapters` 以 git bundle 放進 Owner 本機 repo；Owner 重錄後，主控核對五個 eval 的量測值與門檻（`eval/thresholds.json`），確認 unit 的略過數歸零（CR-4），再開 PR。〔修訂 2026-09-26 決策單 A8／A7〕改為 `local/integration` 以本機模型重錄後開一個 PR 到 main；低於門檻的 eval 門檻不動、照實紅燈，是否可帶紅燈合併等第二輪 X1。
3. 合併後依 Owner 回饋處理第 0.2 節 F、G。〔修訂 2026-09-26 決策單〕F 項已在決策單第一輪答完（§0.00 的 B3～B9）；G 項照 B22 的順序。實作中的分支：`dec/b5-chem-assistant-nlq`、`dec/b7-followup-server-check`、`dec/b10-shortfall-error`、`dec/b20-backfill-figures-tool`、`dec/b21-legacy-analyze-pdf-figures`。

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
