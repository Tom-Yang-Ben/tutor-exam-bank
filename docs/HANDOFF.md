# HANDOFF — 給下一個 Claude Code 對話的交接檔（2026-08-24）

> 目的：這份檔案讓新的對話在**不重讀歷史**的情況下接手「整合者／審查者」的角色。
> 讀完本檔後，第一件事通常是執行 §6 的「看進度」流程。
> 配套：`~/.claude/projects/.../memory/` 裡有 `roadmap-master-plan.md`、`stage1-status.md`、`stage2-status.md`、`stage3-status.md`（系統會自動載入索引）。
>
> 〔修訂 2026-09-24〕**最新狀態先看 §0（階段 5 交接）**；〔修訂 2026-09-25〕章節重整的交接在 §0.0，本機模式（Ollama＋PaddleOCR、預設不連外）在 §0.0a。§1–§9 是 2026-08-24 階段 1–4 的交接快照，角色與流程仍適用，但其中的分支、數字與待辦已過時。
> 〔修訂 2026-09-26 決策單〕Owner 2026-09-25 在「出題系統決策單」的第一輪答案整理在 **§0.00**（含第二輪審定單待答項目）；§0.0、§0.0a、§0.2 被決定的項目已就地加註，原文保留。
> 〔修訂 2026-09-26 合併回填〕第一輪的 B5、B7、B10、B21 已合入 `local/integration`（`7dc14a0`，尚未推上 GitHub）；§0.00、§0.2、§0.3、§0.4 就地更新。〔修訂 2026-09-26 決策單第二、三輪〕Owner 2026-09-26 在第二輪「知識點審定單」與第三輪「重練與收尾決策單」的答覆登錄在 **§0.00a**（重點與實作分支；實作分支都還沒合入）。〔整合 2026-09-26〕§0.00a 的實作分支（錯題重練除外）、B20 修正分支與 `dec/x-nlq-improve-fix`、`dec/x-local-perf-tool-fix`、`dec/x-readme-architecture-fix` 已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）；各處狀態見 §0.00a 最後的表與 §0.4 第 4 項。
> 〔整合 2026-09-26〕`dec/integration-r23` 之後又整合了一次：`dec/integration-final`（r23＋審查修正 `dec/integration-r23-fix`＋variant 向量修正 `dec/fix-variant-embed-record`）再依序併入錯題重練全部（`dec/retrain-phase2-fix`）與本機看圖逾時（`dec/local-vision-timeout`），成為 **`dec/integration-all`**（待併 `local/integration`）。本檔原寫「已合入 `dec/integration-r23`」的地方一律改為「已合入 ~~`dec/integration-r23`~~ `dec/integration-all`」（r23 的內容都在裡面），錯題重練原本的「另一條工作進行中」也改為已合入。完整 `ci.sh` 結果在 §0.4 第 5 項；Owner 接下來要做的事與待裁決清單在 §0.4 第 6、7 項。
> 〔修訂 2026-09-26 決策單第四輪〕Owner 2026-09-26 在第四輪「上線與本機速度決策單」（U1～U3、V1～V5、T1～T3、Q1～Q4）的答覆登錄在 **§0.00b**（每題的答覆與落實位置）；程式改動在分支 `dec/r4-decisions`（V3、V4、Q1、Q3）。§0.00 的 B18、§0.00a 的 M4、§0.4 第 6、7 項已就地加註，原文保留。
> 〔OCR 為主 2026-09-26〕Owner 選「這台電腦的拆題改成 OCR 為主」：§0.00b 最後一段（分支 `dec/local-ocr-first`、`local-mode.md` 10.12）。
> 〔整合 r5 2026-09-26〕`dec/integration-r5`＝`local/integration`（889d18f）依序併入 `dec/local-ocr-first-fix`、`dec/local-embed-thresholds-fix`、`dec/local-thinking-speed-fix`：狀態在 §0.4 第 8 項；三條分支帶來的待 Owner 決定事項整理成一份總表 [`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md)（§0.4 第 7 項最後一條）。`local-mode.md` 的三個「10.12」依併入順序改號為 10.12（OCR 為主）、10.13（向量門檻）、10.14（拆題以外的時間）。
> 〔整合 final5 2026-09-27〕`dec/integration-final5`＝`dec/integration-r5-fix`（ed93665）依序併入 `dec/local-classify-nlq-prep-fix`、`dec/latex-escape-repair-fix`、`dec/phys-spoken-reviewed`、`dec/cleanup-exam-legacy`：狀態在 §0.4 第 9 項。`local-mode.md` 第四個「10.12」（classify／nlq 重錄前修正）改號為 **10.15**。
> 〔第五輪決策 2026-09-27〕Owner 2026-09-27 在第五輪決策單（30 題：D、V5、C、O、LC、L、K-P）的答覆登錄在 **§0.00c**（每題的選項與落實分支）；§0.00 的 A10、B15 與 §0.2 第 7 項「物理先不跑 `kc:load`」已就地加註解除（K-P）。
> 〔整合 r6 2026-09-27〕`dec/integration-r6`＝`local/integration-r5`（a670783）依序併入第五輪五組 `dec/r6-templates-fix`、`dec/r6-local-tuning-fix`、`dec/r6-gates-fix`、`dec/r6-defaults-fix`、`dec/r6-docs-kc-fix`：狀態在 §0.4 第 10 項。`local-mode.md` 五個暫編的「10.16」改號為 10.16～10.20，新增 **10.21 重錄計畫**（交付 Owner 電腦重錄的步驟）。
> 〔第六輪決策 2026-09-27，桌面版〕Owner 2026-09-27 在第六輪決策單（19 題：啟動器 DL-1～DL-5、桌面版設計稿 DA-1～DA-14）的答覆登錄在 **§0.00d**；程式只改兩處（DL-4 啟動器預設、DA-11 網頁版 `HOST`），分支 `dec/r7-decisions-host`（從 `dec/integration-r7` `6757e25` 開）；審查小修在 `dec/r7-decisions-host-fix`（`desktop-app-design.md` 文末「審查修正紀錄（`dec/r7-decisions-host-fix`）」）。

---

## 0. 階段 5 交接（2026-09-24，最終審查後改寫）〔修訂 2026-09-24b〕

### 0.00 Owner 決策單第一輪（2026-09-25）〔修訂 2026-09-26 決策單〕

> 來源：Owner（Ben）2026-09-25 在「出題系統決策單」填的第一輪答案，2026-09-26 由 AI 登錄進文件（分支 `dec/docs-owner-decisions-round1`，只改文件、不改程式）。
> 「狀態」欄：**已定**＝照答案記錄，不必再動程式；**實作中**＝由括號內的分支實作，合併之前程式仍是舊行為；**第二輪待答**＝等第二輪審定單；**待決**＝Owner 選擇先觀察再定，AI 不代為決定。〔修訂 2026-09-26 合併回填〕**已合入**＝實作分支已合入 `local/integration`（`7dc14a0`），尚未推上 GitHub、尚未合入 main；**第二輪已答**＝結果見 §0.00a。〔整合 2026-09-26〕「已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）」＝已在整合分支合併並跑過完整 `ci.sh`，還沒併進 `local/integration`。
> AI 不代填任何「核准」欄：B1 只記錄 Owner 選擇維持 enforce，`requirements_tracker.md` 的 DEC-013「核准」欄仍待 Owner 明示簽核。

| 代號 | 決定 | 狀態 | 影響 |
|---|---|---|---|
| A1 | #61、#62 兩題 AI 自撰的干擾題照現稿用（題目與答案核可） | 已定 | fixture 不改；`eval/CHAPTER_RELABEL-2026-09.md` 第 2.1、6、8（狀態列）、8.6 節註記 |
| A2 | #52（甲乙兩車相對速度）維持「直線運動」 | 已定 | 不改標；直線運動不必補干擾題（CHAPTER_RELABEL 第 8.6 節第 3 項） |
| A3 | nlq-036 的計分：重錄完看分數再決定 | 待決（等重錄） | `filtersExact` 不改；重錄後由 Owner 決定要不要另開裁決 |
| A4 | retrieval R017／R018／R035／R036 的負樣本不動 | 已定 | `retrieval.json` 不改（R031～R034 同樣不動；#61、#62 不加進 hard_negatives） |
| A5 | 第一冊「指數與對數」只教常用對數（一般底數、換底、指數方程式在第三冊） | 已定（維持現況） | #1～#4、#7 等維持「指數函數與對數函數」；`kc-review-數學.md`「指數與對數依常用對數分冊」的前提成立 |
| A6 | 白名單外內容（數學邏輯、空間向量加減、物理熱學）放進既有章當知識點 | 方向已定；細節第二輪待答。〔修訂 2026-09-26 決策單第二、三輪〕第二輪已答（§0.00a：M4 邏輯兩條進「集合與計數原理」、M5 空間向量坐標運算進「空間概念與座標系」、P1 熱學兩條進「理想氣體與氣體動力論」），實作分支未合入。〔整合 2026-09-26〕實作分支（`dec/r2-math-kc*`、`dec/r2-phys-*`）已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`） | 不新增章名，白名單與 cassette 不動；放哪一章、寫哪幾條在知識點審定單 |
| A7 | 本機重錄後低於門檻：門檻數字不動，讓它紅燈，之後改善（不依本機模型重建基準） | 已定；PR 能否帶紅燈合併→第二輪 X1 待答。〔修訂 2026-09-26 決策單第二、三輪〕X1 已答：只限 eval 分數可以紅燈合併，unit、integration、e2e 必須綠，PR 說明列出未達項（§0.00a） | `eval/thresholds.json` 不動；`local-mode.md` LM-14、第 6 條第 3 點、10.5、10.7 |
| A8 | 合併路徑：開一個 PR，`local/integration` → main（已含章節重整全部 commit） | 已定（PR 尚未開） | 取代 §0.0「先合 `stage5/integration`、再開 `stage5/chapters` 的 PR」；`stage5/integration` 已由 PR #38 合入 main（origin/main `d1834ac`） |
| A9 | 數學知識點歸屬「我要調整」。Owner 備註原文：「期望值放在古典機率，隨機變數是選修數甲的機率與統計，數學歸納法是數列與級數，推移矩陣是矩陣，複數是選修數甲，勘根定理是選修數甲的微積分，反方陣也是矩陣」 | 多數與草案一致；勘根定理與「期望值」的意思第二輪待確認。〔修訂 2026-09-26 決策單第二、三輪〕第二輪已答：M1「古典機率」「期望值」兩章維持分開；M3 勘根定理搬到選修「函數的極限」（§0.00a） | **先不跑 `kc:load`**；`config/kc/數學.json` 等第二輪答完再改（`kc-review-數學.md` 第 2 節）。〔現況 2026-09-27〕第二輪已答、數學種子檔（`dec/r2-math-kc*`）已隨 `dec/integration-all` 併入 `local/integration`（`889d18f`），§0.2 第 7 項「併入之前不跑」的條件已成立；Owner 第五輪 K-P 只就物理決定，數學沒有新決定 |
| A10 | 物理會改知識點代碼的項目：先不載入知識點，改由第二輪審定單直接出題（把這些項目直接列成題目請 Owner 作答） | 第二輪待答。〔修訂 2026-09-26 決策單第二、三輪〕第二輪已答（P1～P20，§0.00a），實作分支未合入。〔整合 2026-09-26〕實作分支（`dec/r2-phys-*`）已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`） | ~~物理同樣先不跑 `kc:load`~~〔Owner 2026-09-27 第五輪 K-P 選 3〕解除：物理知識點維持草稿，但允許 `kc:load` 載入（§0.00c，`dec/r6-docs-kc`） |
| A11 | 化學章節表照目前草案定稿（依龍騰） | 已定 | `config/chemistryChapters.js` 章名不動（只改註解）；`chemistry.md`、`interfaces-stage5.md` 第 3.3 條改為定稿；DEC-019 業務驗收「三科章節表經 Owner 定稿」的化學部分滿足 |
| B1 | 拆題後對照原卷檢查（DEC-013）維持 enforce（擋下） | 行為已定；DEC-013 核准欄仍待 Owner 明示簽核 | `SOURCE_CHECK_MODE` 維持 enforce；`requirements_tracker.md` 只在備註與決策沿革記錄 |
| B2 | ADR-014、ADR-015 接受；ADR-017 等本機實測後再定 | 已定 | ADR-014、ADR-015 狀態改為已接受；ADR-017 維持提議並註明原因 |
| B3 | 補救卷選題參數（S5-30）維持 | 已定 | 不改程式 |
| B4 | S5-11 文字型答案的單位衝突維持送複核（uncertain） | 已定 | 不改 `compareText` |
| B5 | S5-13 改為支援化學（助教工具說明書與 NLQ 的 LLM 輔路徑；需重錄） | ~~實作中（`dec/b5-chem-assistant-nlq`）~~ 〔修訂 2026-09-26 合併回填〕**已合入 `local/integration`（`7dc14a0`）** | 兩者的 cassette 要重錄（`nlq.v2`~~、`assistant.v2`~~；本機模型重錄前 nlq eval 的 LLM 路徑 8 句會 replay miss）〔整合 2026-09-26 更正〕助教沒有入庫的 cassette（`eval/cassettes/` 底下沒有 `assistant`，CI 也不回放助教），`assistant.v2` 不必重錄；B5 要重錄的只有 `nlq.v2`（nlq eval 的 LLM 路徑 8 句）。整合後另有 CR-9 的 `classify.v2`（數學＋物理 classify 全部）要重錄，合起來是 `nlq.v2` 與 `classify.v2` 兩個 |
| B6 | S5-26「加入補救卷」按鈕位置維持 | 已定 | — |
| B7 | S5-28 confirm-paper 伺服器端也檢查承上題整組 | ~~實作中（`dec/b7-followup-server-check`）~~ 〔修訂 2026-09-26 合併回填〕**已合入 `local/integration`（`7dc14a0`）** | 直接呼叫 API 送半組承上題會被擋下（400＋`incomplete_groups`；`interfaces-stage1.md` 第 7.1 條、`remedial.md` 第 2.2 節） |
| B8 | S5-7 維持 | 已定 | — |
| B9 | S5-40 維持（error 退避期間該列已解鎖的既有設計不改） | 已定 | 管線行為不變 |
| B10 | 承上題湊不滿：改為直接報錯，請老師改題數（選項 B） | ~~實作中（`dec/b10-shortfall-error`）~~ 〔修訂 2026-09-26 合併回填〕**已合入 `local/integration`（`7dc14a0`）** | `FOLLOW_UP_SHORTFALL_POLICY` 改 B；`roadmap-plan.md` §6.5 第 14 項、prd ACPT-019-7。〔修訂 2026-09-26 合併回填〕改成環境變數、預設 `error`（400，訊息建議改成幾題；單章、blueprint、助教試算同一個開關），`.env` 設 `note` 可切回；補救卷草稿不受影響 |
| B11 | 錯因白名單與學生檔案欄位：用一陣子再說 | 已定（暫不改） | §0.2 第 11 項 |
| B12 | 知識點自動標註：先試 20 題看品質 | 已定；要等知識點載入之後 | §0.2 第 15 項（`kc:backfill -- --limit 20`） |
| B13 | 化學 eval 只當參考 | 已定 | 錄製後的分數只供參考，不設門檻、不當 CI 硬閘門（§0.2 第 16 項） |
| B14 | 化學教學取捨：Owner 要逐項看 | 第二輪待答。〔修訂 2026-09-26 決策單第二、三輪〕第二輪已答（C1～C16，§0.00a），實作分支未合入。〔整合 2026-09-26〕實作分支（`dec/r2-chem-kc*`）已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`） | `kc-review-化學.md` |
| B15 | 三科知識點逐章審定：找時間一次審完 | 第二輪待答。〔修訂 2026-09-26 決策單第二、三輪〕知識點審定單已答（§0.00a）；逐條 `approved` 仍只有數學 4 條，物理口語版依 P20 全面重寫後待 Ben 逐章核對。〔整合 2026-09-26〕三科種子檔的實作分支已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）；逐條審定數不變。〔口語版核對 2026-09-26〕物理 198 條口語版 Owner 已大略看過、全部 OK，日後需要再改（`kc-review-物理.md` 第 9 節）；要不要標 `approved` 列入第五輪決策單。〔Owner 2026-09-27 第五輪 K-P 選 3〕198 條維持 `draft`（不標 `approved`），但允許 `kc:load` 載入；「物理先不跑 `kc:load`」解除（§0.00c，`dec/r6-docs-kc`） | 取代 §0.2 第 11 項「本週教哪章就審哪章」 |
| B16 | 未收錄的主題：之後需要再補 | 已定（暫不補） | — |
| B17 | 化學別名優先：維持 | 已定 | 「碰撞學說」「原子結構」仍要打完整章名（§0.3） |
| B18 | 本機拆題的限制：上傳幾份卷後再看 | 待決（實測後）。〔整合 2026-09-26〕Owner 重錄 pipeline 時看圖拆題在 30 分逾時；逾時清單、量測指令與四個加速選項已由 `dec/local-vision-timeout` 補上（已合入 `dec/integration-all`），選哪一個待 Owner 決定（§0.4 第 7 項）。〔修訂 2026-09-26 決策單第四輪 V1～V4〕逾時的處理已定：Owner 的 `.env` 直接放寬（V1）、沒有獨立顯示卡（V2）、本機拆題逾時只重試 1 次（V3）、`/analyze-pdf` 本機預設每塊 2 頁（V4），見 §0.00b；「上傳幾份卷後再看」的其餘限制仍待決 | `local-mode.md` LM-12 |
| B19 | 本機家教：試幾題難題後再定 | 待決（試用後） | 本機家教沒有程式驗算（§0.0a 已知限制） |
| B20 | 舊題補附圖（roadmap 第 19 項）：做 | 工具實作中（`dec/b20-backfill-figures-tool`）；做哪幾份卷→第二輪 X2 待答。〔修訂 2026-09-26 決策單第二、三輪〕X2 已答：各校考卷整個資料夾先跑「只列出」、再逐題確認；工具修正中（`dec/b20-backfill-figures-tool-fix`），尚未合入。〔整合 2026-09-26〕含第二輪修正的 `dec/b20-backfill-figures-tool-fix2` 已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`） | 會寫正式庫、逐題人工確認對應 |
| B21 | `/analyze-pdf` 舊流程（roadmap 第 20 項）：保留並補裁圖（Owner 選 B，不採原建議 A） | ~~實作中（`dec/b21-legacy-analyze-pdf-figures`）~~ 〔修訂 2026-09-26 合併回填〕**已合入 `local/integration`（`7dc14a0`）** | 兩條拆題路徑並存（舊流程重用管線的 `figureService` 裁圖，見 `docs/figures.md`；化學仍只走新管線） |
| B22 | 下一輪開發順序照建議：錯題重練 → 間隔複習 → 診斷報告 → 入班診斷卷 → 學習路徑與提示 → 學生端 | 已定 | §0.2 第 20 項 |
| C | 本機模式暫不適用：補 Gemini 額度重錄、刪 Gemini cassette、語音與家教費用設定、標註費用未計入預算 | 本機模式下暫緩 | §0.0 的 Gemini 重錄、LM-14 的 `cassettes:prune -- --apply`、§0.2 第 13 項、§0.3 的標註費用 |

**第二輪待答（知識點審定單與 X 項）**：

> 〔修訂 2026-09-26 決策單第二、三輪〕以下「知識點審定單」與 X1、X2 已由 Owner 2026-09-26 答覆，結果見 §0.00a；最後一點（A3、B18、B19、ADR-017）仍待實測或重錄。

- **知識點審定單**：A6 白名單外內容要放哪一章、寫成哪幾條；A9 勘根定理的歸屬（Owner 寫「選修數甲的微積分」，草案在 `多項式函數的圖形.06`）與「期望值放在古典機率」的意思；A10 物理會改代碼的項目（審定單直接列成題目）；B14 化學教學取捨逐項看；B15 三科知識點逐章審定。這些答完之前不跑 `kc:load`，B12 的 20 題試標也等載入之後。〔Owner 2026-09-27 第五輪 K-P 選 3〕三科審定單都已答；物理知識點維持草稿、允許載入，`kc:load` 不再因物理而擋（§0.00c）；數學、化學照 §0.2 第 7 項原有條件（已併入 `local/integration`，條件已成立）。
- **X1**：本機重錄後 eval 紅燈時，A8 的 PR 能不能帶著紅燈合併。
- **X2**：舊題補附圖（B20）要做哪幾份卷。
- 另外等實測或重錄才定的（不在審定單上）：A3 nlq-036 計分、B18 本機拆題限制、B19 本機家教、ADR-017。

### 0.00a Owner 決策單第二、三輪（2026-09-26）〔修訂 2026-09-26 決策單第二、三輪〕

> 來源：Owner（Ben）2026-09-26 在第二輪「知識點審定單」（59 題：數學 M1～M21、物理 P1～P20、化學 C1～C16、X1、X2）與第三輪「重練與收尾決策單」（23 題：R1～R12、K1～K11）填的答案，由 AI 登錄（分支 `dec/docs-backfill-round1-merged`，只改文件）。
> 本節只寫重點與交叉引用。完整結果在 claude.ai 專案文件 `claude/owner-decisions-2026-09-26.md`（在專案裡，不在 repo）；知識點每一項的做法在各實作分支的 `docs/kc-review-{數學,物理,化學}.md`；R1～R12 的背景與選項原文在 `docs/retrain-and-review.md` 第 8 節。
> **實作分支都還沒合入 `local/integration`**（截至 `7dc14a0`）：合入之前，種子檔、分類模板與程式仍是第一輪之後的狀態，`kc:load` 也還不能載入新版。
> 〔整合 2026-09-26〕錯題重練以外的實作分支已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）；狀態見本節最後的表。〔整合 2026-09-26〕錯題重練（`dec/retrain-phase2-fix`，FR-036～040）也已合入 `dec/integration-all`。
> AI 不代填任何「核准」欄：DEC-013 仍待 Owner 明示簽核；知識點的逐條 `approved` 仍只有數學 4 條（第二輪改的是內容與歸屬，不是逐條審定）。

**X 項（第二輪）**

- **X1** 選 1：PR 可以帶著紅燈合併，但只限 eval 分數；unit、integration、e2e 必須綠；PR 說明要列出未達項。適用 A8 的 PR（`local/integration` → main），與 A7（門檻數字不動）一起看；不改程式。
- **X2** 選 1：各校考卷整個資料夾先跑「只列出」，再逐題確認。對應 B20 的 `figures:backfill`：預設 dry-run 只產提議檔與預覽頁，老師逐題確認後才 `--apply` 寫正式庫（寫之前先備份）。

**數學（M1～M21）**：要改的 9 項，其餘 M1、M2、M6、M7、M9、M11～M14、M16、M18、M20 維持現狀。

- M3：勘根定理搬到選修「函數的極限」（`.07`），改寫成連續函數版本，和中間值定理分工。
- M4：「集合與計數原理」加邏輯兩條（命題與且、或、非；充分條件與必要條件）。〔整合 2026-09-26 審查〕實作時加的查題別名「命題」會把「段考命題」（出題）判成本章，已換成「且或非」；「邏輯」有同樣的問題，是否保留待 Owner 決定（`kc-review-數學.md` 第 10.3 節第 7 點）。〔修訂 2026-09-26 決策單第四輪 Q1／Q2〕Owner：拿掉「邏輯」（改由 LLM 判斷）、「且或非」保留；`dec/r4-decisions` 已改（§0.00b）。
- M5：空間向量坐標運算搬到「空間概念與座標系」（`空間向量內積.01` → `空間概念與座標系.06`）。
- M8：標準差只寫除以 n，不提 n−1。
- M10：刪「二項分布中機率最大的次數」那一條，幾何分布刪 E(X)=1/p（K9：口語版一起改）。
- M15：「複數的幾何意涵」改成 3 條（複數平面與絕對值、加減的幾何意義、乘除的幾何意義），刪極式、棣美弗定理、n 次方根。
- M17：橢圓焦點三角形面積公式與退化情形都刪。
- M19：三角方程式補一般解。
- M21：`平面方程式.06` 的先備改指向量係數積（全檔不再有指向後面章節的先備）。

**物理（P1～P20）**：要改的 9 項，其餘 P2、P3、P5、P6、P8、P11、P14、P16～P19 維持現狀。

- P1：熱學新增兩條（比熱與熱平衡、潛熱與熱膨脹），放在「理想氣體與氣體動力論」。
- P4：轉動慣量只講定性。
- P7：康普頓效應加入 Δλ 的計算。
- P9：B 類不確定度取最小刻度的一半。
- P10：不確定度的兩種組合方法都寫。
- P12：氣體動力論的壓力公式只用結果，不推導。
- P13：保留方均根速率 v_rms，用「平均動能」並註明單原子分子。
- P15：刪 X 射線最短波長 λmin 的公式。
- P20：口語版改成 90～130 字、對學生說「你」；198 條已全部重寫（AI 草稿），待 Ben 逐章核對。〔口語版核對 2026-09-26〕Ben 已大略看過，198 條全部 OK、接受現狀，日後需要再改（`kc-review-物理.md` 第 9 節）。

**化學（C1～C16）**：要改的 7 項，其餘 C1～C3、C6～C9、C12、C15 維持現狀。

- C4：原子說排在倍比定律之前，只改排序，代碼不重用。
- C5：游離能的例外以說法甲（軌域能量）為主，再接一句說法乙（全滿、半滿）。
- C10：氣體動力論只講定性。
- C11：依數性質只講強電解質。
- C13：補上強鹼性中的錳酸根 MnO₄²⁻。
- C14：錯離子拆成兩條（過渡金屬的氧化數與顏色；錯離子的配位數與形狀）。
- C16：溶解度只分可溶與難溶（微溶算難溶）。

**第三輪：錯題重練與間隔複習（R1～R12）**——需求是 DEC-003 例外條款與 DEC-016（2026-09-25 已核准）。依 `docs/retrain-and-review.md` 第 8 節「選完之後本檔凍結」，R1～R12 答完、設計凍結；參數之後寫進 `config/retrain.js` 並標〔Owner 決策單 2026-09-26 R*〕。R1、R11、R12 Owner 沒有採設計稿的建議，實作時以 Owner 的選擇為準。

- R1 選 2：只有老師在批改卡上勾「要重練」的題才進清單；清單上也可以手動加入或移出（建議是 1：答錯自動進）。
- R2 選 1：只有全對才算對（沒給部分分，或給 100%）。
- R3 選 2：對 3 次才算會——下一份卷重做一次、隔 1 週、再隔 2 週。
- R4 選 1：錯了回到第一關、錯的次數加一；錯滿 3 次標「卡關」提醒，仍留在清單。
- R5 選 1：固定關卡（Leitner 式），間隔與次數依 R3。
- R6 選 1：兩種出法都要——出新卷時可勾「附上到期的重練題」（上限預設新題數的三成，出卷時可改），也能單獨出一份重練卷。
- R7 選 1：學生卷面不標；老師的版本（標準版答案區、詳解版）與批改卡標「重練」。
- R8 選 1：重練題不佔變式家族名額，同家族的一題新變式可以同卷出。
- R9 選 1：這一輪一律用原題；想換題用現有的「找相似／出變式」手動加。
- R10 選 1：弱點面板與補救卷只算每題第一次作答；另做一張「重練成效」表。
- R11 選 3：不補建以前的錯題，從開啟那天起才開始記（建議是 1：補最近 30 天）。
- R12 選 2：重練題的承上題組放不進卷時直接報錯，請老師調整題數，和新題的 B10 一致（建議是 1：跳過並附註）。

**第三輪：收尾（K1～K11）**

- K1 選 1：化學「溶解度」補一句「難溶不等於完全不溶」。
- K2 選 1：分類界線——一維運動（含一維相對速度）歸「直線運動」，需要向量分解或二維的歸「平面運動」。
- K3 選 1：分類界線——只用到銳角與平方、商數、餘角關係的歸「直角三角形的邊角關係」，化成 r sin(x+φ) 的才歸「三角函數的疊合」。
- K4 選 2：比熱、潛熱、熱膨脹、熱平衡四個查題別名都指向物理「理想氣體與氣體動力論」；Owner 接受「化學 比熱」會被判成物理。
- K5 選 2：物理熱學新增的兩條維持排在該章最後。
- K6 選 3：不確定度的兩種組合方法都有教，維持現寫法（以課本或題目指定的方法為準）。
- K7 選 1：清掉物理三條用不到的先備（X 射線那一條的兩個先備、氣體動力論壓力公式那一條的一個先備）。
- K8 選 1：數學邏輯兩條的排序維持（集合運算之後、計數原理之前）。
- K9 選 1：同意 M10 連口語版一起改（維持現稿）。
- K10 選 1：數學「複數乘除的幾何意義」拿掉和角公式這個先備。
- K11 選 1：化學「醛與酮」不加錯離子先備。

**由哪些分支實作（都尚未合入 `local/integration`）**〔整合 2026-09-26〕錯題重練以外的分支已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`），逐列標在「狀態」欄。〔整合 2026-09-26〕錯題重練與本機看圖逾時也已合入，各加一列（R1～R12 那一列之後）。

| 範圍 | 分支 | 狀態（2026-09-26） |
|---|---|---|
| 數學 M1～M21、K8～K10 | `dec/r2-math-kc` → `dec/r2-math-kc2`（M15、M17 補答、勘根定理改寫）→ `dec/r2-math-kc3`（K8～K10） | ~~已 commit，待合併~~ 〔整合 2026-09-26〕**已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）**；三條一起合入，種子檔 `version` 維持 3 |
| 物理 P1～P20、K4～K7 | `dec/r2-phys-content`（P1～P15）→ `dec/r2-phys-spoken`（P20 口語版全面重寫）→ `dec/r2-phys-kc3`（K4～K7） | ~~已 commit，待合併~~ 〔整合 2026-09-26〕**已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）** |
| 化學 C1～C16、K1、K11 | `dec/r2-chem-kc` → `dec/r2-chem-kc2`（C4 改回原代碼、只改排序）→ `dec/r2-chem-kc3`（K1、K11） | ~~kc3 進行中~~ 〔整合 2026-09-26〕**已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）** |
| 分類界線 K2、K3（連同 CR-9 指數與對數分冊界線，分類模板升 `classify.v2`） | `dec/r2-classify-explog2` → `dec/r2-classify-explog3` | ~~explog3 進行中~~ 〔整合 2026-09-26〕**已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）**；`classify.v2` 需以本機模型補錄 |
| X2（B20 舊題補附圖） | `dec/b20-backfill-figures-tool`（修正分支 `dec/b20-backfill-figures-tool-fix`；〔整合 2026-09-26〕第二輪修正 `dec/b20-backfill-figures-tool-fix2`） | ~~修正中；合入前不對正式庫執行~~ 〔整合 2026-09-26〕**已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）**（兩輪修正都在內）；併入 `local/integration` 之前仍不對正式庫執行 |
| R1～R12 錯題重練 | `dec/design-retrain-spaced-fix`（設計稿 `docs/retrain-and-review.md`）、`dec/retrain-p1-data-layer`（第一階段：派題與作答拆表，migration 0016，相容檢視）、`dec/retrain-schedule`（排程純函式與 ADR-018／019） | ~~設計稿與第一階段已 commit；排程進行中；重練規則、API、畫面在之後。〔整合 2026-09-26〕**另一條工作進行中**（`dec/retrain-*` 與設計稿分支都不在 `dec/integration-r23`）~~ 〔整合 2026-09-26〕**已合入 `dec/integration-all`（待併 `local/integration`）**：設計稿、第一階段、排程與第二階段全部在 `dec/retrain-phase2-fix` 裡，見下一列 |
| 〔整合 2026-09-26〕錯題重練全部（R1～R12 → FR-036～040） | `dec/retrain-phase2-fix`（`43cf5fc`；其下是 `dec/retrain-base`＝第一階段資料層＋排程純函式＋排程修正 `dec/retrain-schedule-fix`，第二階段 `dec/retrain-p2-core`、`dec/retrain-p3-paper`、`dec/retrain-p4-ui` → `dec/retrain-phase2` → 審查修正） | **已合入 `dec/integration-all`（待併 `local/integration`）**：migrations 0016（派題與作答拆表）、0017（重練排程項目）、0018（移出的來源），排程純函式，API-1～13，批改卡「要重練」勾選，出卷整合（附帶重練題、重練卷、補救卷重練組），Word 答案區標「（重練）」，錯題重練卡與重練成效表；旗標 `FEATURE_RETRAIN` 預設關。**新程式即使旗標關閉也必須 migrate 到 0018**（§0.2 第 7 項）。實作狀態 `retrain-and-review.md` 第 5.6.1～5.6.6 節；待裁決見 §0.4 第 7 項 |
| 〔整合 2026-09-26〕本機看圖拆題逾時（Owner 重錄 pipeline 時 `extract_vision` 30 分逾時） | `dec/local-vision-timeout`（`e7a4bad`） | **已合入 `dec/integration-all`（待併 `local/integration`）**：重錄 pipeline／e2e 時單次呼叫與節點逾時放寬到 3 小時、Ollama 長呼叫可印進度（`OLLAMA_PROGRESS_MS`）、`usage.timing` 進回放檔、`npm run local:bench-vision`、`VISION_MAX_EDGE_PX`（預設不縮）；預設值一個都沒改。加速選項待 Owner 決定（`local-mode.md` 10.11；§0.4 第 7 項） |
| X1 | 不改程式 | 開 A8 的 PR 時適用 |
| 〔整合 2026-09-26〕不在決策單上、同批合入的分支 | `dec/x-nlq-improve-fix`（查題證據檢查與平面／空間對齊、`nlq.v2` 模板，`docs/retrieval.md` §9）、`dec/x-local-perf-tool-fix`（`npm run perf:local`，B18 實測用）、`dec/x-readme-architecture-fix`（README、sad.md §7.1）、`dec/docs-backfill-round1-merged`（本節的登錄） | **已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）** |

### 0.00b Owner 決策單第四輪（2026-09-26）〔修訂 2026-09-26 決策單第四輪〕

> 來源：Owner（Ben）2026-09-26 在第四輪「上線與本機速度決策單」（15 題：U1～U3 上線與重錄、V1～V5 本機速度、T1～T3 錯題重練、Q1～Q4 知識點與查題）填的答案，備註欄全空；由 AI 登錄並落實（分支 `dec/r4-decisions`，起點 `local/integration` 的 `4bdaf87`）。
> 程式與內容只改四項（V3、V4、Q1、Q3），其餘只登錄。V1 的逾時放寬只改 Owner 電腦上的 `.env`，程式預設不變。AI 不代填任何「核准」欄：DEC-013 仍待 Owner 明示簽核。

| 題號 | 答覆 | 落實在哪 |
|---|---|---|
| U1 | 選 1：現在就做——先存錄好的檔 → 合併新版 → 備份資料庫 → 升級到 0018 並核對 → 推到 GitHub | 不改程式。由 AI 在 Owner 電腦上執行；升級照 §0.4 第 6 項①（`deployment_and_operations.md` §3.6）；本分支併入 `local/integration` 後一起送過去 |
| U2 | 選 1：9/24 用 Gemini 錄的 131 個檔一起存（與本機錄的分開兩個 commit） | 不改程式；在 Owner 電腦上 commit。之後要清再用 `cassettes:prune` |
| U3 | 選 2：更新後先只跑 1 頁看圖量測，其餘重錄等看完數字再說 | 不改程式；§0.4 第 6 項②③ 加註；`local-mode.md` 10.11 第 3 點「Owner 的選擇」 |
| V1 | 選 2：直接放寬——`OLLAMA_TIMEOUT_MS=5400000`（90 分）、`JOB_NODE_TIMEOUT_MS=7200000`（2 小時） | 只改 Owner 的 `.env`；程式預設（30 分、45 分）與 `.env.example` 不變；(a) 一塊 1 頁、(b) 縮圖這次不採用。`local-mode.md` 10.11 第 3 點 |
| V2 | 選 3：沒有獨立顯示卡，只有內顯 | 不改程式；選項 (d) 不適用（`local-mode.md` 10.11 第 3 點） |
| V3 | 選 2：本機模式逾時只重試 1 次 | **程式**：`workers/jobRunner.js` 的 `runExtractChunk`＋常數 `LOCAL_EXTRACT_TIMEOUT_MAX_RETRIES = 1`（檔頭註明出處）。拆題模型是 ollama 時，拆題一塊 `timeout` 只重試 1 次（共跑 2 次），`jobs.error` 註明「（本機模式逾時只重試 1 次）」；其他錯誤類別與 Gemini 模式仍重試 3 次（逾時也算進這 3 次）；逐題的節點照狀態機原規則。測試：`test/unit/localRound4Decisions.test.js`、`test/integration/localExtract.pg.test.js`。`local-mode.md` 10.11 表 #4 |
| V4 | 選 1：舊流程 `/analyze-pdf` 本機模式預設跟新流程一樣每塊 2 頁 | **程式**：`services/aiService.js` 的 `buildCtx`——拆題模型是 ollama 且 `.env` 沒明寫（或不是正整數）`JOB_PDF_CHUNK_PAGES` 時，用 `workers/jobRunner.js` 的 `LOCAL_PDF_CHUNK_PAGES`（同一個常數）；Gemini 模式仍 20 頁。測試：`test/unit/localRound4Decisions.test.js`。`local-mode.md` 10.11 表 #6 |
| V5 | 選 1：重錄後依本機向量分布提出三個餘弦門檻的新值與依據，Owner 核准後才改 | 這次不改任何門檻（程式預設、`eval/thresholds.json` 都不動）；`local-mode.md` 10.7 第 9 點；§0.4 第 7 項 |
| T1 | 選 1：「判定已會」的題被承上組帶出又答錯，維持已會、只提示 | 不改程式（凍結的純函式照舊）；`retrain-and-review.md` 第 5.6.6 節 |
| T2 | 選 1：錯題重練實作細節 ①～⑧ 全部照現狀 | 不改程式；`retrain-and-review.md` 第 5.6.5 節彙總表之前（①～⑧ 逐條列出） |
| T3 | 選 1：Word 詳解版只在答案與詳解段標「（重練）」，題目段不標 | 不改程式；同上 |
| Q1 | 選 1：拿掉查題別名「邏輯」（改由 LLM 輔路徑判斷） | **程式**：`config/chapterAliases.js`；`test/unit/kcReviewRound2Math.test.js`（M4 改釘其餘四個別名，另加一案：「邏輯推理的機率題」規則抓不到章、`confident` 為假）。`kc-review-數學.md` 第 10.3 節第 7 點 |
| Q2 | 選 1：別名「且或非」保留（「命題」不加回） | 不改程式；同上 |
| Q3 | 選 1：`CHEM.溶解度.05` 的 description 改成「氫氧化物多難溶（含 Ca(OH)₂），鹼金屬與 Ba 的除外」，其餘照現在 | **內容**：`config/kc/化學.json` 只改這一處（199 → 198 字），口語版不動；`npm run kc:validate` 通過；`test/unit/kcReviewChem.test.js` 新增一案。`kc-review-化學.md` 第 10 節 |
| Q4 | 選 1：舊題補附圖的候選排序維持「數字一致」在「出處註記」之前 | 不改程式；`figures.md`「候選題」一段加註 |

**本分支的完整 `ci.sh`**（測試庫 `tutor_r4dec_test`）：unit 3,261（3,259 過、2 略過；比 `local/integration` 多 17 案）、`check:html`、migrate（到 0018）、integration 597（多 4 案）全綠。e2e 12 項中 3 項紅、五個 eval 紅——與 `local/integration`（`4bdaf87`）在同一環境逐項比對，失敗的測試與 eval 輸出相同（缺本機 ocr cassette；classify 92、pipeline 1、nlq 8 筆 replay miss；retrieval 未達門檻；variant 缺向量 fixture），全是本機回放檔／向量檔還沒重錄。沒有改 `eval/thresholds.json`、golden、cassette，也沒有弱化任何既有測試。

**〔OCR 為主 2026-09-26〕2026-09-26 Owner 選 OCR 為主**（第四輪之後、Owner 實測 `qwen3-vl:8b` 看 1 頁樣卷 54 分鐘、JSON 還不合法）：這台電腦的拆題不看圖，只用 PaddleOCR＋`qwen3:8b` 整理；每題都停在人工複核、附圖抓不到的用 `figures:backfill` 補。落實在分支 `dec/local-ocr-first`（起點 `local/integration`）：新設定 `LOCAL_EXTRACT_MODE`（`cross` 預設不變／`ocr`；`config/localExtractMode.js`，與 `OCR_ENGINE=none` 同時設啟動就報錯）、`agents/extract.js` 的 `runLocalOcrOnly`、複核原因 `ocr_only`（`migrations/0019_ocr_only_review.sql`、`reviewController`、複核頁「只用 OCR 拆題，請核對題目與公式」）、依 PaddleOCR 版面配附圖（`ocr_pdf.py` 回報 `figures`、`agents/extractOcrFigures.js`）、`ci.yml` 與 `eval/.env.replay` 改 `LOCAL_EXTRACT_MODE: ocr`（重錄 pipeline／e2e 不再跑看圖）、`npm run perf:local` 3.4 段。Owner 要做的：更新程式後先 `npm run migrate`（到 0019），`.env` 加 `LOCAL_EXTRACT_MODE=ocr`，重啟。說明與預估時間在 [`local-mode.md`](local-mode.md) 10.12。〔審查 2026-09-26，分支 `dec/local-ocr-first-fix`〕e2e 的「部分入庫」兩項在 `ocr` 模式下設計上不會綠，照 10.12 第 7 點選項 ① 改成「全部停在複核 → 經複核 API 核准一題入庫」（`cross` 模式的原本兩項一字不改；**測試契約變更，待 Owner 裁決**）；`eval:pipeline` 的 `saved_rate` 在 `ocr` 模式固定是 0，怎麼解讀待 Owner 決定；附圖配對補了反例（上一題定位不到或被漏拆時圖不再配給下一題、截斷時整塊不配、「第 n 題」）；沒套 0019 就開 `ocr` 模式時佇列暫停、只報一次錯；`report:jobs` 多「OCR 版面配圖」一節。

### 0.00c 第五輪決策（2026-09-27）〔第五輪決策 2026-09-27〕

> 來源：Owner（Ben）2026-09-27 在第五輪決策單（題目與選項見 [`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md) 的 D、V5、C、O 系列，與 [`local-mode.md`](local-mode.md) 10.15 第 6 點的 LC 系列；L-1～L-3、K-P 只在決策單上）的答覆。
> 落實分成五條分支，都從 `local/integration-r5`（`a670783`）開、各自獨立、**都還沒合入**：A＝`dec/r6-templates`、B＝`dec/r6-local-tuning`、C＝`dec/r6-gates`、D＝`dec/r6-defaults`、E＝`dec/r6-docs-kc`（本表與 K-P、O-3）。「只記錄」的題不改程式，只登錄在本表與總表的就地註記。AI 不代填任何「核准」欄；產品門檻預設與計分規則的改動只限 Owner 在本輪明確選的那幾題（V5-1～V5-3、LC-4、D-2），`eval/thresholds.json` 的門檻數字不動。

| 題號 | Owner 選項 | 落實 |
|---|---|---|
| C-a | 1：公式重寫（lint）維持思考 | 只記錄（程式不變） |
| C-b | 2：知識點標註關掉思考 | B＝`dec/r6-local-tuning` |
| C-c | 2：驗算只降輸出上限到 3072（思考不動） | B＝`dec/r6-local-tuning` |
| C-d | 1：`num_ctx` 維持 16384 | 只記錄 |
| C-e | 2：Ollama 與其他程式的記憶體先量再決定 | 只記錄（先量） |
| C-f | 2：本機被截斷的回應不重試，直接進複核 | B＝`dec/r6-local-tuning` |
| C-g | 1：驗算不一致時維持原地重跑一次 | 只記錄 |
| C-h | 1：思考模式維持溫度 0 | 只記錄 |
| C-i | 1：分類維持一題接一題 | 只記錄 |
| D-1 | 1：同意現況（e2e 在 OCR 模式驗「全部停在複核 → 人工核准一題入庫」） | 只記錄（現況即 `local-mode.md` 10.12 第 7 點的 ①a／①b） |
| D-2 | 3：OCR 模式下 pipeline eval 的 `saved_rate` 印 n/a＋替代指標 | C＝`dec/r6-gates` |
| D-3 | 2：`LOCAL_EXTRACT_MODE` 程式預設也改 `ocr` | D＝`dec/r6-defaults` |
| D-4 | 1：OCR 整理放不下 `num_ctx` 時先不調 | 只記錄 |
| K-P | 3：物理 198 個知識點維持草稿（`draft`），但允許 `kc:load` 載入 | E＝`dec/r6-docs-kc`：`scripts/load_kc.js`、`services/kcService.loadSeeds`、`utils/kcSeed.js` 本來就沒有擋草稿或擋物理，程式不改；加測試釘住（`test/unit/kcPhysicsDraftLoad.test.js`、`test/integration/kcLoadPhysicsDraft.pg.test.js`）；§0.00 A10、B15 與 §0.2 第 7 項的「物理先不跑 `kc:load`」加註解除 |
| L-1 | 1：加 | C＝`dec/r6-gates` |
| L-2 | 1：改，並一起重錄 | A＝`dec/r6-templates` |
| L-3 | 1：支援 | C＝`dec/r6-gates` |
| LC-1 | 2：分類輸出改成「理由先」（理由 → 章節 → 信心） | A＝`dec/r6-templates` |
| LC-2 | 1：圓周運動、三角平方關係不加程式規則（交給模板與模型）〔Owner 2026-09-27 改答：加四條規則〕classify.v2 本機重錄（86/92、macro-F1 0.8477 未達門檻）後改答：在 `utils/chapterPostRules.js` 加平方關係、廣義角、摩擦係數、等速圓周運動的運動學四條界線規則（程式後處理，不改模板與 schema、不必重錄） | ~~只記錄~~ `dec/r6-classify-rules`（從 `dec/r6-recorded-step1` `7536493` 開，不在上面五條分支內；[`local-mode.md`](local-mode.md) 10.22：replay 91/92、macro-F1 0.9744，仍錯 cls-fx-051）〔審查修正 `dec/r6-classify-rules-fix`〕規則 1、3、4 往「不換」的方向收窄、誤觸檢查補掃拆題回放檔與 pdf_sample golden（10.22 第 7 點），分數不變 |
| LC-3 | 2：程式界線規則也套在零成本閘門 | C＝`dec/r6-gates` |
| LC-4 | 3：`llm` 路徑、期望多章的句子放寬計分（回的章都在期望內、至少一章） | C＝`dec/r6-gates`（**放寬計分**，門檻數字不動） |
| O-2 | 1：kNN 投票門檻 `KNN_VOTE_SIM` 維持 0.90 | D＝`dec/r6-defaults` |
| O-3 | 2：ADR-017 現在改寫成 OCR 為主，等重錄與上傳真卷有數字後再定案 | E＝`dec/r6-docs-kc`：ADR-017 改寫（v1.1、狀態維持「提議中／待數據定案」、新增 §3.1 定案條件），原文以〔修訂 2026-09-27〕保留；`engineering_tracker.md` ADR 索引加註 |
| O-4 | 2：variant 重錄、重標初判之後再抽查 10～15 支 | 只記錄（重錄後做） |
| O-5 | 2：公式重寫（lint）第三層也加 L-2「JSON 字串裡的反斜線寫兩個」（與 `promptParts.jsonBackslashRule()` 同一段），`lint.v2` → `lint.v3`、`lint_chem.v1` → `lint_chem.v2` | `dec/r6-lint-v3`（2026-09-27 另答，從 `local/integration-r6` `6222475` 開，不在上面五條分支內）；lint 的 cassette 隨 variant、pipeline 重錄一起錄（`local-mode.md` 10.16 第 2 點加註、10.21 第 1a 步） |
| V5-1 | 2：`VARIANT_RETRIEVE_SIM_MIN` 改 0.72 | D＝`dec/r6-defaults` |
| V5-2 | 2：`VARIANT_OFFTOPIC_SIM_MIN` 改 0.87（暫定） | D＝`dec/r6-defaults` |
| V5-3 | 3：`DEDUP_DUP_THRESHOLD` 改 0.99 | D＝`dec/r6-defaults` |
| V5-4 | 1：`DEDUP_VARIANT_THRESHOLD` 維持 0.90 | D＝`dec/r6-defaults` |
| V5-5 | 1：新門檻只改本機模式的預設 | D＝`dec/r6-defaults` |
| V5-6 | 2：從生成端讓同一藍本的兄弟變式彼此不同 | A＝`dec/r6-templates` |

- 各分支實際改了什麼、要不要重錄，以各分支在 `local-mode.md` 末尾新增的「第五輪 <組名>（2026-09-27）」一節為準（整合時重編節號）；本表只登錄答案與分支。
- 同批另做的文件清理（cleanup 審查留下的，不是決策單題目）：README 連到 tag `v1-mysql` 的原型說明後補一句授權指路（〔審查修正 2026-09-27，`dec/r6-docs-kc-fix`〕原句「tag 內的授權宣告以主線 LICENSE 為準」和 README「授權與著作權」一節「2026-08-24 之前的歷史版本曾以 Apache-2.0 釋出」字面衝突，改為「主線現行版本以主線 `LICENSE` 為準；tag 內的歷史版本見授權與著作權一節」；只是指路、不改授權，措辭仍請 Owner 看過）；`requirements_tracker.md`、`ux_research_and_journey.md` 提到 `exam/` 的三處加〔修訂 2026-09-27〕「已自主線移除，見 tag `v1-mysql`」。都在 `dec/r6-docs-kc`。

### 0.00d 第六輪決策（2026-09-27，桌面版）〔第六輪決策 2026-09-27，桌面版〕

> 來源：Owner（Ben）2026-09-27 在第六輪決策單的答覆：桌面啟動器 A 的待確認事項（[`desktop-launcher.md`](desktop-launcher.md) 第 8 節 DL-1～DL-5）與桌面版 B＋D2 設計稿的決策草稿（[`desktop-app-design.md`](desktop-app-design.md) 第 8 條 DA-1～DA-14）。兩份文件都已逐題就地加註〔Owner 2026-09-27 選 N〕，設計稿依答案確定的段落改成「定案」語氣、原文保留。
> 落實在分支 **`dec/r7-decisions-host`**（從 `dec/integration-r7` `6757e25` 開；審查修正 `dec/r7-decisions-host-fix`〔2026-09-27 已和 `dec/r7-checkpoints-fix`（DA-13）、`dec/r7-test-hygiene-fix`、`dec/r7-electron-b1-fix`（B1）一起併入 **`dec/integration-r8`**〕）。程式只改兩處：DL-4（啟動器預設）與 DA-11 的網頁版那一半（後端 `HOST`）；另加 DA-14／DA-9 給 Owner 用的唯讀檢查工具。其餘題目是「維持現狀」或要等 B、D2 實作時照答案做。沒有改任何 cassette 鍵（模板、schema、prompt、`cacheKeyParts`）、golden 或 `eval/thresholds.json`。AI 不代填任何「核准」欄。

| 題號 | Owner 選項 | 落實 |
|---|---|---|
| DL-1 | 1：關閉時有背景工作 → 每次問（是＝等跑完、否＝最多等 2 分鐘、取消） | 只記錄（就是現行預設 `askBeforeStopWithJobs:true`、`stopGraceSec:120`） |
| DL-2 | 1：只關系統視窗時後端不停，要停用「關閉出題系統」 | 只記錄（現況） |
| DL-3 | 1：「關閉出題系統」不關 Docker Desktop 與 Ollama | 只記錄（現行預設 `stopDocker:"no"`、`stopOllama:false`） |
| DL-4 | 2：錄製（重錄 cassette）進行中開系統時暫停背景工作 | **程式**：`scripts/desktop/lib/config.js` 的 `jobsWhileRecording` 預設 `run` → `pause`；`config.example.json`、`desktop-launcher.md` 第 6 節的表與 7.1、啟動畫面的注意事項（`lib/plan.js`：pause 寫明「預設」，run 寫明「設定是 run、怎麼改回 pause」）一起改；測試改為新預設（`desktopLauncherConfig`、`desktopLauncherRun`、`desktopLauncherPlan`）。Owner 不必寫 `config.json` |
| DL-5 | 1：保留「後端聽不了連接埠就印原因並結束」 | 只記錄（現況；`deployment_and_operations.md` 的「待 Owner 確認」改成已答） |
| DA-1 | 2：設定放 `%APPDATA%`，資料庫、附圖、日誌放 `%LOCALAPPDATA%`，備份放「文件\TutorExamBank\backups」 | 只記錄；B2 照做 |
| DA-2 | 3：看狀況——有工作縮到系統匣並通知、沒工作直接結束；從系統匣結束時問等完或放棄，寫明重跑範圍 | 只記錄；B1 照做 |
| DA-3 | 2：後端用 `utilityProcess.fork` | 只記錄；B1 照做 |
| DA-4 | 1：原生庫由 app 管理；每天第一次開啟、結束前有寫入、migrate 前備份；停用 02:00 排程 | 只記錄；D2 照做 |
| DA-5 | 2：手動觸發的 GitHub Actions 在 Windows runner 對 EDB PG16 編 pgvector，產出 zip 與 SHA-256 | 只記錄；D2 照做（`ci.yml` 不改） |
| DA-6 | 1：維持 git＋bundle，從 repo 啟動 Electron（U1） | 只記錄。建議原本是「B3 起改 U2」，這次只選了 1：**B3 開工前再問一次** |
| DA-7 | 2：Docker 保留安裝但不自動啟動（D1 備援），舊 volume 至少留 30 天 | 只記錄；D2 照做（前提：DA-14 量完仍決定做 D2） |
| DA-8 | 1：金鑰照舊明文寫在 `.env`，搬到 `%APPDATA%\TutorExamBank\.env` | 只記錄；B2 照做 |
| DA-9 | 1：不簽章，只在 Owner 電腦 build | 只記錄。**前提 Smart App Control 關閉，待 Owner 確認**：`wsl_memory_check.bat` 讀得出狀態（`desktop-app-design.md` 10.4） |
| DA-10 | 2：B2 完成且演練通過後挑空檔搬家 | 只記錄 |
| DA-11 | 1：桌面版只綁 127.0.0.1；網頁版改用 `HOST`、預設 127.0.0.1 | **程式（網頁版）**：新增 `config/listenHost.js`；`server.js` 改 `app.listen(PORT, HOST)`，啟動訊息寫明實際聽的位址；`utils/listenFailure.js` 對 `EADDRNOTAVAIL`／`ENOTFOUND` 說明怎麼改 `HOST`；桌面啟動器與關閉捷徑照 `HOST` 決定連哪個位址（`lib/probes.js` 的 `listenFromEnv`），`HOST` 只聽某個區網位址（或 `127.0.0.1` 以外的 `127.x`，`dec/r7-decisions-host-fix`）時停下說明（`host-unsupported`）；`/api/health` 的本機判斷擴大到 127.0.0.0/8（限流規則不變）。文件：`.env.example`（`# HOST=0.0.0.0` 註解＋三件事）、`exam_pro/README.md`「區網存取」、根目錄 README、`deployment_and_operations.md` §3.2、§4.1、`api_spec.md` 限流列。測試：`listenHost`（單元）、`desktopServerListen`（真的執行 `server.js`：沒寫 `HOST` 時區網連不到、`0.0.0.0` 連得到、寫錯位址結束碼 1、`.env` 讀得到）、`test/integration/listenHost.pg.test.js`（真的資料庫）。e2e、整合測試、CI、`record_local.bat` 都沒有依賴 `0.0.0.0` |
| DA-12 | 2：原生庫用 ICU（`--locale-provider=icu`） | 只記錄；`--icu-locale` 的值在 D2 演練時比對後記錄 |
| DA-13 | 2：拆題逐塊、變式逐題的檢查點都做 | 只記錄；B1（或更早）實作 |
| DA-14 | 1：Owner 先設 `.wslconfig` 的 `memory=3GB`、`autoMemoryReclaim=dropCache` 並量測（Owner 自己做） | **工具（只讀取）**：`exam_pro/scripts/windows/wsl_memory_check.bat` → `scripts/desktop/wsl_memory_check.js`，讀 `.wslconfig`、vmmem／VmmemWSL、總記憶體與使用中、Docker Desktop（〔`dec/r7-decisions-host-fix`〕含 `docker info` 的 `MemTotal`，和 `.wslconfig` 的 `memory` 比對，是上限生效了沒的直接證據）與 Ollama、Smart App Control，寫到 `exam_pro/data/logs/wsl_check-日期.log`；Owner 的步驟（含 `wsl --shutdown` 在重錄或上傳進行中**不可以**做）在 `desktop-app-design.md` 第 10 節。測試：`wslMemoryCheck`（指令白名單、log 內容） |

**Owner 接下來要做的（都不急，照自己的時間）**：

1. 等這一輪重錄跑完、合併之後才更新（**重錄進行中不要更新 repo**）；更新後點「出題系統」確認 app 視窗照常開（後端改成只聽 127.0.0.1，`desktop-app-design.md` 10.5）。有 `exam_pro\data\launcher\config.json` 的話，確認裡面沒有 `"jobsWhileRecording": "run"`（有就刪掉那一行，`desktop-launcher.md` 第 6 節）。
2. 跑 `wsl_memory_check.bat` 看 Smart App Control 是不是關閉（DA-9 的前提，10.4）；開啟或評估模式就先回報，不要自己改。
3. 沒有重錄、沒有上傳時照 10.2 設 `.wslconfig` 上限（生效與否看 log 的「[.wslconfig 是否生效]」），並在閒置／上傳／重錄三種情況各跑一次檢查（10.3；「設上限前的重錄」要在下一輪重錄時量），把 log 交給維護的人，再決定 D2 做不做（DA-14）。
4. 之後才會問的：B3 開工前 DA-6「B3 之後改不改 U2」；要改走退路時 DA-5；重新啟用 Gemini 時 DA-8 的 `safeStorage`。
5. 〔待 Owner 決定，2026-09-27〕**desktop 納入 CI 與 dependabot**（`desktop-app-design.md` R-7）：提案分支 `dec/r8-desktop-ci-fix`（`dec/r8-desktop-ci` 加審查修正；基底 `dec/integration-r8` `9d27210`）已備妥，**Owner 同意之前不併入任何整合分支**（只有這一行可以先進整合分支）。要決定的是：① CI 加 `desktop` job（每次 push 與 PR 跑桌面版的 `npm test`，不下載 Electron）；② Dependabot 加 `/desktop`（Electron 有新版就開 PR；PR 會被版本鎖弄成紅燈，要照步驟升級才合併；紅燈能不能真的擋住合併要看分支保護〔要實測〕）；③ `/desktop` 要不要照 `/exam_pro` 分組（照慣例分組可能壓掉大版本的 PR〔推論〕）。建議：選 1（兩個都做），分組選 B（不分組）。代價、不做的風險、選項與要實測的事，寫在提案分支的 `docs/desktop-app-design.md` 6.2 節「決策說明：desktop 納入 CI 與 dependabot」（`git show dec/r8-desktop-ci-fix:docs/desktop-app-design.md`）。Owner 回覆的格式：「同意，選 1，分組選 B」。

### 0.0 章節重整（2026-09-25）〔修訂 2026-09-25 章節重整〕

- **範圍**：數學 34→52 章、物理 32→34 章（刪「流體的壓力與浮力」「宇宙學簡介」，新增 4 章），對齊 108 課綱龍騰版目錄；化學章名不動（依龍騰版核對，知識點不需搬移）。契約 [`chapter-restructure.md`](chapter-restructure.md)（裁決 CR-1～CR-6 在第 8 條）、ADR-016。
- **分支：`stage5/chapters`**，基底 `stage5/integration`（含 `7184f53`：DEC-014～019 與 DEC-003 例外條款依 Owner 對話指示登錄為已核准）。組成：`stage5/chapters-base`（介面凍結、`config/chapterPlan.js`）→ CH-A（白名單換新、`npm run chapters:migrate`、migration 0014）、CH-B（eval 素材改標、`npm run cassettes:rerecord`／`cassettes:prune`）、CH-C（數學 254 個知識點）、CH-D（物理 196 個、化學恆等對照）→ 整合（CR-1～CR-6）。
- **狀態**：unit、check:html、migrate、integration 全綠；e2e 與五個 eval 的失敗**全部**是 replay miss 或缺 embedding fixture（白名單在 schema enum 裡，數學／物理 cassette 刻意失效）。依賴 cassette 的單元測試缺檔即略過（CR-4），重錄後恢復。
- **合併順序**：先合 `stage5/integration`（階段 5 PR）→ Owner 在 `stage5/chapters` 上重錄（`chapter-restructure.md` 第 5 條，Owner 的 Windows 本機執行，金鑰不離開本機）→ 主控核對門檻（低於門檻另開裁決，不自動放寬）→ 開 `stage5/chapters` 的 PR。〔修訂 2026-09-26 決策單〕`stage5/integration` 已由 PR #38 合入 main（origin/main `d1834ac`）；Owner 決定（A8）其後只開**一個** PR：`local/integration` → main（已含章節重整全部 commit），不再單獨開 `stage5/chapters` 的 PR。重錄後低於門檻：門檻不動、讓它紅燈（A7）；PR 能否帶紅燈合併在第二輪 X1 待答。〔修訂 2026-09-26 決策單第二、三輪 X1〕Owner 選 1：只限 eval 分數可以紅燈合併，unit、integration、e2e 必須綠，PR 說明列出未達項（§0.00a）。
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
  5. 回放驗證若有 eval 低於門檻：`eval/thresholds.json` 的數字不動，由 Owner 另行裁決（契約第 6 條第 3 點）。〔修訂 2026-09-26 決策單 A7〕Owner 已裁決：門檻數字不動，讓它紅燈、之後改善，不依本機模型重建基準；PR 能否帶紅燈合併在第二輪 X1 待答。〔修訂 2026-09-26 決策單第二、三輪 X1〕已答：只限 eval 分數可紅燈合併（§0.00a）。
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
2a. 〔修訂 2026-09-25 章節重整〕切到 `stage5/chapters` 重錄 cassette（§0.0；步驟見 `chapter-restructure.md` 第 5 條），commit、push 後開 PR。〔修訂 2026-09-26 決策單 A8／A7／C〕改為：在 `local/integration` 以本機模型重錄（§0.0a 第 4 步，不補 Gemini 額度），之後開**一個** PR `local/integration` → main；低於門檻時門檻不動、讓它紅燈；能否帶紅燈合併在第二輪 X1 待答。〔修訂 2026-09-26 決策單第二、三輪 X1〕已答：只限 eval 分數可紅燈合併，unit、integration、e2e 必須綠，PR 說明列出未達項。〔修訂 2026-09-26 合併回填〕B5（已合入）把 NLQ 模板升到 `nlq.v2`，`dec/r2-classify-explog*`（未合入）把分類模板升到 `classify.v2`：這兩個 suite 的 cassette 要用本機模型補錄；重錄當下若還沒合入，合入後再補錄這兩個。〔整合 2026-09-26〕`dec/r2-classify-explog3`（含 explog、explog2）已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`），`classify.v2` 在該分支已生效；上一句的「合入」指併進 `local/integration`，補錄方式不變。

**B. 上線前只做「會改代碼或章名」的決定（約半天）**

3. ~~簽核 DEC-014～019 與 DEC-003 例外條款~~ 〔修訂 2026-09-25〕Owner 於對話中核准、由 AI 依指示登錄（`7184f53`）；DEC-013 仍待定。ADR-014、ADR-015、ADR-016 狀態為「提議」，請審閱。〔修訂 2026-09-26 決策單 B1／B2〕DEC-013：Owner 選擇維持 enforce（擋下），但決策單的措辭是「維持：擋下」而不是簽核，核准欄仍待 Owner 明示簽核。ADR-014、ADR-015 Owner 接受（狀態已改）；ADR-016 早已是「已接受」（2026-09-25 定案），原文寫「提議」有誤；ADR-017 等本機實測後再定。
4. 數學知識點章節切法——〔修訂 2026-09-25〕章節已照草案重整（§0.0）；`kc-review-數學.md` 第 2 節仍待 Owner 決定的：邏輯（新章表無對應章）、空間向量、期望值與隨機變數重疊、`平面方程式.06` 指向後章的先備；另有數學歸納法、推移矩陣、複數所在冊別與「指數與對數依常用對數分冊」的前提。**第一次 `kc:load` 之前**決定。〔修訂 2026-09-26 決策單 A5／A6／A9〕部分已答：「指數與對數依常用對數分冊」的前提成立（A5，維持現況）；邏輯、空間向量加減放進既有章當知識點（A6，細節第二輪待答）；歸屬 Owner 要調整（A9，原文見 §0.00），期望值的意思與勘根定理第二輪待確認；`平面方程式.06` 的先備未在第一輪答到，仍待決。**第二輪答完之前不跑 `kc:load`。**〔修訂 2026-09-26 決策單第二、三輪〕第二輪已答（M1～M21、K8～K10，§0.00a）：邏輯兩條進「集合與計數原理」（M4）、空間向量坐標運算進「空間概念與座標系」（M5）、期望值兩章維持分開（M1）、勘根定理搬到選修「函數的極限」（M3）、`平面方程式.06` 的先備改指向量係數積（M21）。種子檔改在 `dec/r2-math-kc*`，尚未合入；合入之後才有新版可載入。〔整合 2026-09-26〕`dec/r2-math-kc`、`kc2`、`kc3` 已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`；數學 253 個知識點，`kc:validate` 通過）；併入 `local/integration` 之前仍不跑 `kc:load`（第 7 項）。
5. 化學章節表 `exam_pro/config/chemistryChapters.js`——**第一次上傳化學卷之前**定稿，入庫的題會記章名。〔修訂 2026-09-25〕教科書版本定為龍騰；知識點歸屬已依龍騰目錄核對（`kc-review-化學.md` 第 3 節），請 Owner 抽看。〔修訂 2026-09-26 決策單 A11〕Owner 2026-09-25 定稿：照目前草案（依龍騰），章名不動。化學知識點的教學取捨（B14）與逐章審定（B15）在第二輪待答。〔修訂 2026-09-26 決策單第二、三輪〕第二輪已答（C1～C16、K1、K11，§0.00a），由 `dec/r2-chem-kc*` 落實、尚未合入。〔整合 2026-09-26〕`dec/r2-chem-kc`、`kc2`、`kc3` 已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`；化學 237 個知識點）。
6. 物理「熱學另立章」**明確延後**：會改到數學／物理的章節清單（`LEGACY_CHAPTERS`），全部既有 cassette 都要重錄，另開裁決再議。〔修訂 2026-09-25 章節重整〕已由 2026-09-25 的章節重整一併處理（新章「理想氣體與氣體動力論」，見 [`chapter-restructure.md`](chapter-restructure.md)）；cassette 依該檔第 5 條由 Owner 重錄。〔修訂 2026-09-26 決策單 A6〕新章之外仍在白名單外的物理熱學內容，Owner 決定放進既有章當知識點（不再新增章），放哪一章在第二輪知識點審定單待答。〔修訂 2026-09-26 決策單第二、三輪〕P1 已答：比熱與熱平衡、潛熱與熱膨脹兩條放「理想氣體與氣體動力論」並排在最後（K5）；四個查題別名指向物理（K4）。由 `dec/r2-phys-*` 落實、尚未合入。〔整合 2026-09-26〕`dec/r2-phys-content`、`dec/r2-phys-spoken`、`dec/r2-phys-kc3` 已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`；物理 198 個知識點）。

**C. 上線（不呼叫 LLM、不花錢；§3.4）**

7. 備份 → `npm run migrate`（到 0013；〔修訂 2026-09-25 章節重整〕併入章節重整後到 0014）→ 〔修訂 2026-09-25 章節重整〕`npm run chapters:migrate`（產生提議檔 → 老師確認 → `--apply`，步驟見 [`chapter-restructure.md`](chapter-restructure.md) 第 6.1 節）→ `npm run embed:backfill`（搬過章的題重算向量，費用很小）→ **`npm run search:reindex`（必跑，緊接 migrate）** → `npm run kc:load`（先 `--dry-run`；可跳過）→ `npm run solution:backfill`（先 `--dry-run`、再 `--limit 20`、抽讀）→ 啟動。〔修訂 2026-09-26 決策單 A9／A10〕這一輪**跳過 `kc:load`**：數學歸屬要調整、物理會改代碼的項目改由第二輪審定單處理，答完、種子檔改好之後再載入。〔修訂 2026-09-26 決策單第二、三輪〕第二輪已答；三科種子檔改在 §0.00a 列的分支，合入 `local/integration` 之前仍不跑 `kc:load`。〔整合 2026-09-26〕這些分支已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）；規則不變，併入 `local/integration` 之前仍不跑。〔修訂 2026-09-26 錯題重練第二階段〕併入錯題重練（`migrations/0016`～`0018`）之後，這一步的「備份 → `npm run migrate`」改成：**先停服務** → 更新程式 → `npm run db:backup` → `node scripts/snapshot_attempt_views.js --out=before.json` → `npm run migrate`（到 0018）→ `node scripts/snapshot_attempt_views.js --out=after.json` → `node scripts/snapshot_attempt_views.js --compare before.json after.json`，回 0（完全相同）才往下做；有差異就先別用，把輸出與兩個檔案留給開發者。**`FEATURE_RETRAIN` 關閉也一定要套**：新程式的批改、刪卷、刪學生、合併學生都會讀寫 `retrain_items`，沒套會 500。細節見 [`retrain-and-review.md`](retrain-and-review.md) 第 5.6.6 節。〔整合 2026-09-26〕錯題重練已合入 `dec/integration-all`；同一套升級步驟也寫進 `engineering_docs/06_ops/deployment_and_operations.md` §3.6。〔整合 2026-09-26〕Owner 的正式庫 2026-09-25 已走到 0015（章名遷移、換向量、`search:reindex` 都做完了），接下來只要照 §3.6 做 0016～0018（§0.4 第 6 項①），已做過的不要重做；本項的完整鏈留給還沒升到 0015 的庫，還沒做的 `kc:load`、`solution:backfill` 照本項的規則。〔Owner 2026-09-27 第五輪 K-P 選 3〕只解除「物理先不跑 `kc:load`」：物理 198 條維持 `draft`、允許載入，仍先 `--dry-run`（§0.00c）。數學與化學不在 K-P 範圍內，照本項原有的條件「併入 `local/integration` 之前不跑」；〔現況 2026-09-27〕這個條件已成立（`dec/integration-all` 含 `dec/r2-math-kc*`、`dec/r2-chem-kc*`，已併入 `local/integration` `889d18f`），不是本輪的新決定。
8. 瀏覽器實際走一遍核心延伸：批改卡（錯因、部分給分、對錯切換清分數）、錯因分布、學生檔案、題目詳解欄、Word 三種版本（詳解版的「AI 驗算摘要」加註）、小量化學卷上傳；貼一次 `$\href{javascript:alert(1)}{x}$` 確認不產生連結、`$\ce{2H2 + O2 -> 2H2O}$` 照常排版。
9. 用 Microsoft Word 開一份含化學式與反應箭頭條件的卷，確認排版。

**D. 開始累積資料（日常使用 1–2 週）**

10. 每次批改都標錯因（部分給分視需要）——這是弱點診斷與補救卷的原料。
11. 開 `FEATURE_KC`：**本週教哪章就審哪章**的口語版（朗讀聽一遍→修改→審定通過）；錯因白名單與學生檔案選項若不合用，在累積太多資料前提出。〔修訂 2026-09-26 決策單 B15／B11〕審定方式改為：三科知識點找時間一次審完（第二輪待答），不採「本週教哪章就審哪章」；錯因白名單與學生檔案欄位先用一陣子再說。〔修訂 2026-09-26 決策單第二、三輪〕知識點審定單已答（§0.00a）；物理口語版依 P20 全面重寫（198 條 AI 草稿）待 Ben 逐章核對，逐條 `approved` 仍只有數學 4 條。
12. 開 `FEATURE_REMEDIAL`：先以章節為單位出補救卷（還沒標知識點時自動退回章節基底）。

**E. 小額花錢的功能（一次開一個，每開一個實際用一次）**

13. 查證 `MODEL_VOICE` 的音訊輸入單價補進 `config/pricing.js`、確認 `TUTOR_DAILY_BUDGET_USD` 與 `MODEL_TUTOR`；錄第一批 tutor cassette 前審閱 `tutorService.js`、`voiceService.js` 的 SYSTEM。〔修訂 2026-09-26 決策單 C〕語音與家教的費用設定在本機模式下暫緩（本機不花錢、語音關閉）。
14. `FEATURE_TUTOR`（文字，兩種模式）→ `FEATURE_VOICE`（桌機 Chrome、`http://localhost:3000`，確認 Gemini 接受 audio/webm）。〔修訂 2026-09-26 決策單 B19／C〕本機家教先試幾題難題再定（待決）；語音在本機模式下關閉，`FEATURE_VOICE` 暫緩。
15. **切法確定後**才補標舊題：`npm run kc:backfill -- --dry-run` → `--limit 20` → 全跑；看過品質再決定 `KC_TAG_MIN_CONFIDENCE` 與是否開 `FEATURE_KC_TAGGING`。〔修訂 2026-09-26 決策單 B12〕Owner：先試 20 題看品質；要等知識點載入（第二輪答完、`kc:load`）之後。
16. 化學：定案 `eval/golden/classify_chem.json`（24 筆）後錄 cassette（`LLM_MODE=record node --env-file=.env eval/classify_chem.js`），再決定是否設門檻、併入 CI。〔修訂 2026-09-26 決策單 B13〕Owner：化學 eval 只當參考——錄製後的分數不設門檻、不當 CI 硬閘門。

**F. 用過 2–4 週再決定**

17. 補救卷選題參數（`remedial.md` 第 3 節）與裁決 S5-11（文字型答案單位衝突）、S5-13（助教與 NLQ 的 LLM 路徑支援化學，需重錄）、S5-26、S5-28、S5-7（API 只送 `result` 時保留部分給分）。〔修訂 2026-09-26 決策單 B3～B8〕Owner 已答（不等 2–4 週）：補救卷參數 S5-30 維持；S5-11 維持送複核；**S5-13 改為支援化學**（`dec/b5-chem-assistant-nlq` 實作中，需重錄）；S5-26 維持；**S5-28 改為伺服器也檢查承上題整組**（`dec/b7-followup-server-check` 實作中）；S5-7 維持。〔修訂 2026-09-26 合併回填〕B5、B7 已合入 `local/integration`（`7dc14a0`）；B5 的 `nlq.v2`~~、`assistant.v2`~~ 仍待本機模型重錄。〔整合 2026-09-26 更正〕助教沒有入庫的 cassette（`eval/cassettes/` 底下沒有 `assistant`），`assistant.v2` 不必重錄；要以本機模型重錄的是 `nlq.v2`（LLM 路徑 8 句）與 CR-9 的 `classify.v2`（`docs/chapter-restructure.md` 第 8 條）。
18. 管線既有設計「error 退避期間該列已解鎖、可被別的槽立刻重跑」要不要修（會改變管線行為，S5-40）。〔修訂 2026-09-26 決策單 B9〕Owner：維持，不修。
19. （選做）錄 20–30 題家教問答建立家教 eval；人工標一批題目→知識點 golden 以量測標註準確率。

**G. 下一輪開發（依相依順序；FR 自 FR-036 起）**

20. 錯題重練（DEC-003 例外，拆「派題」與「作答」）→ 間隔複習 → 診斷報告（老師／家長版）→ 入班診斷卷 → 學習路徑與提示階梯 → 學生端（最大，放最後）。〔修訂 2026-09-26 決策單 B22〕Owner：照這個順序。〔修訂 2026-09-26 決策單第二、三輪〕錯題重練與間隔複習的 R1～R12 已答（§0.00a），設計見 `docs/retrain-and-review.md`（已凍結；在錯題重練分支上，尚未合入）。~~〔整合 2026-09-26〕錯題重練的分支（設計稿與 `dec/retrain-*`）不在 `dec/integration-r23`，這一句仍成立（§0.00a 最後的表）。~~ 〔整合 2026-09-26〕錯題重練與間隔複習（設計稿與 `dec/retrain-*` 全部，最後一條是 `dec/retrain-phase2-fix`）已合入 `dec/integration-all`（待併 `local/integration`），分配為 FR-036～040；照 B22 的順序這兩步已完成，下一步是診斷報告（FR 自 FR-041 起）。

### 0.3 已知限制（最終審查後仍未處理者）

- **品質未量測**：家教、語音、知識點標註、化學拆題／分類都沒有真 Gemini 執行與 eval；化學路徑沒有任何 cassette。
- **內容待審**：三科 637 個知識點只有 4 條已審定，`curriculum_code` 全為 null；化學章節表、例句、別名、`classify_chem.json`、`answer_chem.json` 都是 AI 草擬。〔修訂 2026-09-26 決策單 A11〕化學章節表已由 Owner 2026-09-25 定稿（照草案、依龍騰）；例句、別名、兩份化學 golden 仍是 AI 草擬。〔修訂 2026-09-26 決策單第二、三輪〕知識點審定單第二輪已答、實作分支未合入（§0.00a）；逐條 `approved` 仍只有數學 4 條，物理 198 條口語版依 P20 重寫後是新的 AI 草稿、待 Ben 逐章核對。〔整合 2026-09-26〕實作分支已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）；合併後三科共 688 個知識點（數學 253、物理 198、化學 237，`kc:validate` 通過），開頭的「637 個」是 2026-09-24 的數字；已審定仍只有數學 4 條。
- **批改**：直接打 API 只送 `{result:1}` 時舊的部分給分保留（前端已處理，S5-7）；合併學生會丟掉來源學生的檔案欄位；複核核准入庫的題不寫詳解（靠回填）。〔修訂 2026-09-26 決策單 B8〕S5-7 Owner 選擇維持。
- **化學**：~~NLQ 的 LLM 輔路徑與助教工具說明書只懂數學／物理~~（S5-13；〔修訂 2026-09-26 決策單 B5〕Owner 改為要支援化學，`dec/b5-chem-assistant-nlq` 實作中、需重錄；〔修訂 2026-09-26 合併回填〕已合入 `local/integration` `7dc14a0`：兩者都支援化學，剩下的限制是 `nlq.v2` 還沒有本機 cassette，而且本機模式 `NLQ_TIMEOUT_MS` 預設 4 秒時，規則抓不到章節的化學句子會多等 4 秒、附逾時警告，`subject` 由推定補成化學）；別名衝突（「碰撞學說」「原子結構」要打完整章名；〔修訂 2026-09-26 決策單 B17〕Owner：別名優先維持）；mhchem 子集限制（`\ce{Fe3+}` 要寫 `Fe^{3+}`、不支援 `\pu`）；`embedText` 內 `\ce` 會留下「ce」字樣；上傳頁沒有「目前卷別」的醒目標示（選錯的後果已由 S5-44 處理）。
- **知識點**：老師清空某題標註後不會被記住，`kc:backfill` 會再挑到；只有管線入庫會自動標；標註費用不記入 `job_events`、不計入 `DAILY_COST_BUDGET_USD`（〔修訂 2026-09-26 決策單 C〕本機模式下暫緩）。
- **補救卷**：手動加題（題目 ID、找相似）不檢查變式家族互斥；~~直接呼叫 `confirm-paper` 仍可送出半組承上題~~（S5-28；〔修訂 2026-09-26 決策單 B7〕Owner 改為伺服器也檢查，`dec/b7-followup-server-check` 實作中；〔修訂 2026-09-26 合併回填〕已合入 `local/integration` `7dc14a0`，半組回 400＋`incomplete_groups`，這一條限制解除）；確認後卷名沿用第一題章節；跨章配額只有 API 沒有畫面；新增學生後，補救卷／家教／覆蓋率的學生下拉要重整頁面才更新。
- **家教與語音**：每日預算只在程序內（重啟歸零）、同時送多個請求可略超上限；語音音訊輸入沒有分開計價；題目附圖不送給家教；姓名遮罩已補強（S5-46）但仍是字串比對，綽號不在名單內時擋不住。
- **路由**：`GET /api/questions/:id` 未限定數字路徑，之後新增 `GET /api/questions/<字面>` 須註冊在它之前（S5-8）。

### 0.4 下一步（主控）

1. 交付 `stage5/integration`：推上 GitHub（需把 repo 加入工作階段的授權來源），或放進 Owner 本機 repo 由 Owner 推送。〔修訂 2026-09-25〕Owner 已推送；`7184f53` 待推。
2. 〔修訂 2026-09-25〕`stage5/chapters` 以 git bundle 放進 Owner 本機 repo；Owner 重錄後，主控核對五個 eval 的量測值與門檻（`eval/thresholds.json`），確認 unit 的略過數歸零（CR-4），再開 PR。〔修訂 2026-09-26 決策單 A8／A7〕改為 `local/integration` 以本機模型重錄後開一個 PR 到 main；低於門檻的 eval 門檻不動、照實紅燈，是否可帶紅燈合併等第二輪 X1。〔修訂 2026-09-26 決策單第二、三輪 X1〕已答：只限 eval 分數可紅燈合併；unit、integration、e2e 必須綠；PR 說明列出未達的 eval 項目與數字。
3. 合併後依 Owner 回饋處理第 0.2 節 F、G。〔修訂 2026-09-26 決策單〕F 項已在決策單第一輪答完（§0.00 的 B3～B9）；G 項照 B22 的順序。實作中的分支：`dec/b5-chem-assistant-nlq`、`dec/b7-followup-server-check`、`dec/b10-shortfall-error`、`dec/b20-backfill-figures-tool`、`dec/b21-legacy-analyze-pdf-figures`。〔修訂 2026-09-26 合併回填〕B5、B7、B10、B21 已合入 `local/integration`（`7dc14a0`；合併時主控實跑 unit、integration 全綠，文件回填在 `dec/docs-backfill-round1-merged`）；B20 仍在修正（`dec/b20-backfill-figures-tool-fix`）。〔整合 2026-09-26〕B20（含兩輪修正，`dec/b20-backfill-figures-tool-fix2`）已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`）。第二、三輪的實作分支見 §0.00a 最後的表。
4. 〔修訂 2026-09-26 合併回填〕待辦：①把 §0.00a 的實作分支與 B20 修正分支（〔整合 2026-09-26〕補列：以及 `dec/x-nlq-improve-fix`、`dec/x-local-perf-tool-fix`、`dec/x-readme-architecture-fix`）合入 `local/integration`，跑完整 `ci.sh`〔整合 2026-09-26〕錯題重練以外的上述分支與 `dec/docs-backfill-round1-merged` 已合入 ~~`dec/integration-r23`~~ `dec/integration-all`（待併 `local/integration`），完整 `ci.sh` 的結果見該分支最後一個 commit 的說明；~~錯題重練（`dec/retrain-*`）另一條工作進行中；~~ 〔整合 2026-09-26〕錯題重練（`dec/retrain-phase2-fix`）與本機看圖逾時（`dec/local-vision-timeout`）也已合入 `dec/integration-all`（第 5 項）；②`local/integration` 還沒推上 GitHub（雲端推送不通時由 Owner 的電腦推），推送時機由 Owner 決定；③Owner 以本機模型重錄後，照 A8 開一個 PR 到 main，依 X1 只有 eval 分數可以紅燈；~~④錯題重練的其餘部分（重練規則、API、畫面）依 `docs/retrain-and-review.md` 與 R1～R12 施工。~~ 〔整合 2026-09-26〕④已完成（FR-036～040；實作狀態見 `docs/retrain-and-review.md` 第 5.6.1～5.6.6 節）。
5. 〔整合 2026-09-26〕**`dec/integration-all` 的狀態**：`dec/integration-final`（`fab8eb8`）依序以 `--no-ff` 併入 `dec/retrain-phase2-fix`（`43cf5fc`）與 `dec/local-vision-timeout`（`e7a4bad`）。完整 `ci.sh`：unit 3,244（3,242 過、2 略過）、`check:html`、migrate（到 0018）、integration 593 全綠；e2e 12 項中 3 項紅（缺本機 ocr cassette）、五個 eval 紅（classify 92、pipeline 1、nlq 8 筆 replay miss，retrieval 未達門檻，variant 缺向量 fixture）——種類與筆數和兩條來源分支相同，全是本機回放檔／向量檔還沒重錄。整合時只改了一處測試夾具：`figureBackfill.pg.test.js`（B20，寫在拆表之前）的 `TRUNCATE attempts, …` 改成 `TRUNCATE attempt_records, assignments, …`（對檢視 TRUNCATE 會報錯；斷言不動）。任何「核准」欄都沒有動，DEC-013 仍待 Owner 簽核。
6. 〔整合 2026-09-26〕**Owner 需要做的事**（依序）：
   - ① 更新程式後 migrate 到 0018〔修訂 2026-09-27 已完成〕：**Owner 的正式庫 2026-09-26 已升到 0018**——升級前先 `npm run db:backup`，`snapshot_attempt_views.js` 升級前後的 attempts 快照逐欄相同（6 筆作答、1 位學生），這一步不要重做。以下是當時的步驟，留作紀錄。照 `engineering_docs/06_ops/deployment_and_operations.md` §3.6（~~正式庫已在 0015：~~ 升級前正式庫在 0015：2026-09-25 本機模式上線時已從 0009 套到 0015，章名遷移、換向量、`search:reindex` 也做完了，這些不要重做）先停服務 → 更新程式 → `npm run db:backup` → `node scripts/snapshot_attempt_views.js --out=before.json` → `npm run migrate` → `--out=after.json` → `--compare before.json after.json` 回 0 才啟動。`FEATURE_RETRAIN` 關閉也一定要套。§0.2 第 7 項是從 0015 之前一路升上來的完整路徑（還沒升到 0015 的庫才照它從頭走）；它列的步驟裡 Owner 還沒做的只有 `kc:load`（併入 `local/integration` 之後才跑）與 `solution:backfill`，照第 7 項的規則做。
   - 〔修訂 2026-09-26 決策單第四輪 U1～U3〕Owner 選：①（連同存錄製檔、推送）現在就做、由 AI 在 Owner 電腦上執行（U1），9/24 Gemini 錄的 131 個檔一起存、與本機錄的分開 commit（U2）；更新後**先只做 ③ 的 1 頁量測**，② 的重錄等看完數字再決定（U3）。`.env` 另照 V1 放寬 `OLLAMA_TIMEOUT_MS=5400000`、`JOB_NODE_TIMEOUT_MS=7200000`（§0.00b）。
   - ② 以本機模型重錄（[`local-mode.md`](local-mode.md) 10.7）：`classify.v2`（CR-9 與 K2、K3，classify 全部 92 筆；`record_local.bat classify`）、`nlq.v2`（LLM 路徑 8 句；`record_local.bat nlq`）、variant 補向量（10.7 第 8 點：LLM 全部回放、只呼叫 embedding 模型）、pipeline＋e2e（`record_local.bat pipeline,e2e`；本版起這兩步的單次呼叫與節點逾時放寬到 3 小時、每 5 分鐘印進度，10.11 第 2 點）。錄完先 `npm run cassettes:rerecord -- --dry-run` 看盤點（缺 cassette、缺向量應為 0），再 commit、push。
   - ③ `npm run local:bench-vision`（10.8、10.11：先卸載模型、只看 1 頁，印載入／讀圖／輸出各花多久與逾時建議；可再加 `-- --max-edge 1600` 比一次），結果貼回來，當作第 7 項加速選項的依據。
   - ④ 重錄之後 `npm run perf:local`（10.10：每一步實際秒數、每頁讀圖秒數與逾時建議）。
   - ⑤（要用錯題重練時）`.env` 設 `FEATURE_RETRAIN=true` 重啟，在瀏覽器實際走一遍：批改卡勾「要重練」→ 錯題重練卡 → 出一份重練卷 → 下載 Word（這些畫面只以 miniDom 與一次性 Playwright 冒煙測過）。
7. 〔整合 2026-09-26〕**待 Owner 裁決**（AI 不代為決定；背景、選項與代價在各條的出處）：
   - ~~「判定已會」的題被承上組帶著出又答錯：維持練到會（目前的行為，批改卡會另外提示），還是回第 1 關（要改凍結的純函式）——[`retrain-and-review.md`](retrain-and-review.md) 第 5.6.6 節「待 Owner 裁決」。~~ 〔修訂 2026-09-26 決策單第四輪 T1〕已決定：維持練到會、只提示，不改程式（§0.00b）。
   - ~~查題別名「邏輯」保留或拿掉（「邏輯推理的機率題」目前被規則判成「集合與計數原理」、不走 LLM）——[`kc-review-數學.md`](kc-review-數學.md) 第 10.3 節第 7 點。~~ 〔修訂 2026-09-26 決策單第四輪 Q1〕已決定：拿掉，`dec/r4-decisions` 已改（「且或非」依 Q2 保留）。
   - ~~本機向量的三個餘弦門檻要不要依 `qwen3-embedding:0.6b` 重新校準：`VARIANT_RETRIEVE_SIM_MIN` 0.80、`VARIANT_OFFTOPIC_SIM_MIN` 0.90、`DEDUP_DUP_THRESHOLD` 0.97（都照 Gemini 向量定的；variant 的 `retrieved_coverage` 本機重錄實測 0.2333）——[`local-mode.md`](local-mode.md) 10.7 第 9 點。~~ 〔修訂 2026-09-26 決策單第四輪 V5〕已決定要重新校準（選 1）：重錄後依本機向量分布提出三個門檻的新值與依據，**新值仍待 Owner 核准**；這次不改任何門檻。
   - ~~看圖拆題加速選項：(a) 一塊 1 頁、(b) 送出前縮圖 `VISION_MAX_EDGE_PX`、(c) 同時放寬 `OLLAMA_TIMEOUT_MS` 與 `JOB_NODE_TIMEOUT_MS`、(d) 獨立顯示卡；建議先做第 6 項③的量測——[`local-mode.md`](local-mode.md) 10.11 第 3 點。~~ 〔修訂 2026-09-26 決策單第四輪 V1、V2〕已決定：(c) 直接放寬 Owner 的 `.env`（90 分／2 小時，程式預設不變）；沒有獨立顯示卡，(d) 不適用；(a)(b) 這次不採用；先量 1 頁（U3）。
   - ~~本機拆題逾時要不要改成不重試（現在逾時算錯誤、退避後重試 3 次，一塊真的做不完時最壞要 4 × 節點逾時才讓整份卷失敗），以及舊流程 `/analyze-pdf` 在 `.env` 沒寫 `JOB_PDF_CHUNK_PAGES` 時一次送 20 頁（比管線的 2 頁更容易逾時，LM-12 ⑤）——[`local-mode.md`](local-mode.md) 10.11 第 1 點的表（#4、#6）與選項 (c) 的代價一。~~ 〔修訂 2026-09-26 決策單第四輪 V3、V4〕已決定並已改（`dec/r4-decisions`）：本機拆題逾時只重試 1 次（V3 選 2）；`/analyze-pdf` 本機模式預設每塊 2 頁（V4 選 1）。
   - ~~錯題重練實作時自行決定、列給 Owner 確認的各條：第 5.6.2 節 ①～⑬（排程核心：重新加入的同日邊界、API 回應多的鍵、勾選與取消的承上組規則等）、第 5.6.3 節 ①～⑪（出卷：R12 建議題數、附帶只挑同科、Word 只標答案區等）、第 5.6.4 節 ①～⑪（畫面與成效）、第 5.6.6 節 ①～⑥（審查修正：移出的來源、刪卷時的承上組、仍然不同的邊界等），彙總在第 5.6.5 節——[`retrain-and-review.md`](retrain-and-review.md)。~~ 〔修訂 2026-09-26 決策單第四輪 T2、T3〕已決定：Owner 確認決策單列的 ①～⑧（T2）與 Word 詳解版只在答案與詳解段標「（重練）」（T3）都照現狀，不改程式；其餘各條照現狀運作（§0.00b、`retrain-and-review.md` 第 5.6.5 節）。
   - 既有仍待決：DEC-013 核准欄待 Owner 明示簽核；A3（nlq-036 計分，等重錄）、B18（本機拆題限制，見上面加速選項）、B19（本機家教）、ADR-017（等本機實測）——§0.00。〔修訂 2026-09-26 決策單第四輪〕B18 裡逾時的處理已由 V1～V4 決定（§0.00b），其餘限制仍等上傳幾份卷後再看；新增待核准：V5 的三個門檻新值（重錄之後才提出）。
   - 〔整合 r5 2026-09-26〕**`dec/integration-r5` 帶來的待決事項總表**：[`owner-pending-decisions-r5.md`](owner-pending-decisions-r5.md)——D-1～D-4（OCR 為主：e2e 合約 ①a／①b、ocr 模式的 `saved_rate`、`.env.example` 與程式預設不同、OCR 整理的 `num_ctx`）、V5-1～V5-6（向量門檻；上一條的「三個門檻新值」已用 889d18f 錄的資料先提出，V5-2 仍要等重錄）、C-a～C-i（拆題以外的加速選項）、O-1～O-4（LaTeX 反斜線修補分支的併入時機、`KNN_VOTE_SIM`、ADR-017、抽查 Claude 對 55 支變式的跑題初判），共 23 項。每一項都還沒改。〔整合審查 2026-09-27〕O-4 是審查時補的；merge commit `77610fd` 標題寫的「C-a～C-h」應為「C-a～C-i」（歷史不改寫）。
8. 〔整合 r5 2026-09-26〕**`dec/integration-r5` 的狀態**：`local/integration`（`889d18f`）依序以 `--no-ff` 併入 `dec/local-ocr-first-fix`（`6035def`）、`dec/local-embed-thresholds-fix`（`72eb69a`）、`dec/local-thinking-speed-fix`（`1c62357`；其中 `3b0bc33` 是 `15b3a47` 的 cherry-pick，兩邊 diff 相同、沒有衝突）。衝突只在文件與四個檔的相鄰新增（`local-mode.md` 的三個 10.12 改號、`package.json` 兩個 script、`report_jobs.js` 的回傳、`local_perf_report.js` 的欄位與匯出），兩邊都保留；另加 `test/unit/localModeSections.test.js` 釘住改號與交互參照、`reportJobs.pg.test.js` 一案證明同一次 `collect` 兩邊的欄位都對。測試（PostgreSQL 16＋pgvector、埠 5433，env 照 `ci.yml`）：unit 3,495（3,493 過、2 略過）、`check:html`、migrate（到 0019）、integration 615 全綠；e2e 12 項中 3 項紅、classify／pipeline／nlq／variant 四個 eval 紅、retrieval 全過。與 `889d18f` 同機逐項比對：integration 原本紅的 4 項（`cassetteTools.pg` JSON 截斷）修好；e2e 與 pipeline 缺的回放檔從 `extract_vision/85ab9965…` 換成 `extract_ocr/a47b37a0…`、e2e 紅的兩項從「部分入庫」「部分是真的」換成 ocr 模式的 ①a、①b（`LOCAL_EXTRACT_MODE=cross` 時與 889d18f 逐項相同）；其餘 eval 報表逐欄相同。**交付到 Owner 電腦時**：更新程式後 `npm run migrate`（到 0019）；Owner 現有的 `.env` 沒有 `LOCAL_EXTRACT_MODE`，程式預設是 `cross`（看圖），要走 OCR 為主必須在 `.env` 加 `LOCAL_EXTRACT_MODE=ocr`（10.12 第 2 點；要不要改預設是 D-3）。〔Owner 第五輪 D-3 選 2，`dec/r6-defaults` 2026-09-27〕程式預設已改成 `ocr`，不加這一行也走 OCR 為主；另外 V5-1～V5-5、O-2 的門檻依向量模型取預設，Owner 的 `.env` 若明寫了舊的 `VARIANT_RETRIEVE_SIM_MIN`／`VARIANT_OFFTOPIC_SIM_MIN`／`DEDUP_DUP_THRESHOLD`／`VARIANT_SIM_MIN`，升級時要刪掉（`local-mode.md` 10.19）。
   - 〔整合審查 2026-09-27 `dec/integration-r5-fix`〕審查找到一個兩條分支合在一起才出現的問題並已修正：OCR 整理的 num_ctx 預算與截斷判斷（`agents/extract.js`）原本只看全域 `OLLAMA_NUM_CTX` 與固定的 8192，不認加速分支的 `OLLAMA_NUM_CTX_EXTRACT_OCR`／`OLLAMA_MAX_OUTPUT_EXTRACT_OCR`；現在與 `services/llm/index.js` 用同一條規則算實際送出的值，`npm run perf:local` 3.4 段與每塊頁數的 num_ctx 限制也一樣（10.12 第 6 點最後一條；單元測試釘住三種設定）。什麼都沒寫時行為與摘要逐鍵不變。
   - **下次整合要注意**：① `dec/local-classify-nlq-prep-fix`（起點也是 `889d18f`）同樣新增「### 10.12 classify／nlq 重錄前修正」，是第四個 10.12——併入時那一節改號為 **10.15**，它的程式註解、文件與測試裡指到 10.12 的地方一起改，`test/unit/localModeSections.test.js` 的 `heads`（目前寫死 `['10.12','10.13','10.14']`）與對照表也要更新，否則會紅燈。② `dec/latex-escape-repair-fix` 在 `prune_cassettes.js`、`rerecord_all.js` 用了另一種「stdout 寫完再結束」的寫法，也改了 `services/llm/index.js`，併入時要與 `eval/lib/exitAfterFlush.js`、`adapterOpts` 合成一版並補測試（O-1）。
     〔整合 final5 2026-09-27〕①② 都已在 `dec/integration-final5` 處理，見第 9 項。
9. 〔整合 final5 2026-09-27〕**`dec/integration-final5` 的狀態**：`dec/integration-r5-fix`（`ed93665`）依序以 `--no-ff` 併入 `dec/local-classify-nlq-prep-fix`（`5513f4d`）、`dec/latex-escape-repair-fix`（`904dd7e`）、`dec/phys-spoken-reviewed`（`c859a33`）、`dec/cleanup-exam-legacy`（`e0213c0`）。
   - 衝突與處理：① `local-mode.md` 末尾兩邊都新增一節：`dec/local-classify-nlq-prep-fix` 的「10.12 classify／nlq 重錄前修正」改號為 **10.15**，它的程式註解（`agents/classify.js`、`utils/chapterPostRules.js`）、eval 訊息（`eval/lib/suiteClassify.js`）、工具與 fixture 說明、測試（`localV1Regression`）一併改號；`localModeSections.test.js` 的 `heads` 與對照表加 10.15。② `prune_cassettes.js`、`rerecord_all.js`：`3c35ee1` 的 stdout 截斷修正與主線 `15b3a47`（共用 `eval/lib/exitAfterFlush.js`，連 stderr 一起等）等效，保留主線那一份。③ `services/llm/index.js` 檔頭兩段說明都保留，程式自動合併：本機調整（`adapterOpts`）照送、record 仍存原始回應並記 `ollamaOverrides`、回傳都經 LaTeX 修復；`latexEscapeRepair.test.js` 補一案釘住兩者同時生效。`dec/phys-spoken-reviewed`、`dec/cleanup-exam-legacy` 無衝突。本檔兩邊的加註都保留。
   - O-1（LaTeX 修補什麼時候併）：本次依主控指示併入，**不是 Owner 的裁決**，總表 O-1 已加註。代價照預估：variant 回放缺向量從 1 次變 29 次，要整步重錄 variant 才恢復。
   - 測試（全新 UTF8 測試庫、埠 5433，env 照 `ci.yml`）：unit 3,609（3,607 過、2 略過）、`check:html`、migrate（到 0019）、integration 615 全綠；e2e 12 項中 3 項紅、classify／pipeline／nlq／variant 四個 eval 紅、retrieval 全過。與 `ed93665` 同機逐項比對：unit 3,502 → 3,609（新增 `chapterPostRules`、`localV1Regression`、`latexEscapeRepair` 三支與 `localModeSections` 的 10.15 檢查），integration 615 不變；e2e 紅的是同樣三項（缺 `extract_ocr/a47b37a0…`）；classify（92 筆）、pipeline（1 筆）、nlq（8 筆）的報表除 commit 外逐字相同；variant 2 筆 replay miss 不變，缺向量 1 → 29（上一點），分數欄本來就是 n/a。
   - README 兩處過時敘述（錯題重練「待併 `local/integration`」、migration「`local/integration` 到 0015」）以〔修訂 2026-09-27〕就地更正；README、`exam_pro/README.md`、`qa_tracker`、`sad`、`deployment_and_operations` 的測試數回填 final5 的數字。
10. 〔整合 r6 2026-09-27〕**`dec/integration-r6` 的狀態**：`local/integration-r5`（`a670783`）依序以 `--no-ff` 併入 `dec/r6-templates-fix`（`824ba71`，A 模板與 schema）、`dec/r6-local-tuning-fix`（`990a66f`，B 本機呼叫調整＋migration 0020）、`dec/r6-gates-fix`（`61903e9`，C 閘門與計分）、`dec/r6-defaults-fix`（`4617ed7`，D 預設值與門檻）、`dec/r6-docs-kc-fix`（`c211525`，E 文件與知識點）。
   - 衝突與處理：① `local-mode.md` 五組各自在末尾新增的「10.16 第五輪 X」依併入順序改號為 10.16～10.20；各組新增的交互參照只改自己那幾行（`ci.yml`、`formulas.md`、`llm.md`、`variants.md`、本檔、`owner-pending-decisions-r5.md`、`.env.example`、migration 0020、`config/*`、複核頁、`jobRunner`、測試註解）；C 組加在 10.15 末尾的落實註記移回 10.15。② `localModeSections.test.js` 各組放寬成「10.15 之後允許暫編 10.16」，整合後改回**逐字**列出 10.12～10.21 每一節的節號與標題，並釘住第五輪各組的檔指到自己那一節。③ `owner-pending-decisions-r5.md`：總表 V5-1～V5-5 採 D 組註記、V5-6 保留 A 組註記、O-5（A）與 C 組表末的小節都保留；C-a／C-d／C-e／C-g／C-h／C-i 的 B、E 兩組加註都保留。④ `workers/jobRunner.js` 同時引入 B 的 `REVIEW_REASON_FOR_ERROR` 與 C 的 `findControlChars`。⑤ C 的 D-2 × D 的 D-3：`isOcrOnlyRun` 在「ollama、沒寫 `LOCAL_EXTRACT_MODE`」時改為 OCR 模式（`evalPipelineOcrMode.test.js` 改期望值並補「寫錯字」一案）。
   - 交互測試：新增 `test/unit/r6Interactions.test.js`（A 的 `variant.v2` × C 的 control_char／`\bullet`／`\textbf` × LaTeX 修復；A 的 classify schema 順序 × C 的 LC-3 閘門；D 的預設 ocr × C 的 D-2；B 的 0020 × 0019 完整值域與複核白名單）與 `test/unit/rerecordPlanR6.test.js`（10.21 的步驟、順序、`LLM_MODE`／`EMBED_MODE` 與 `record_local.bat`／`rerecord_all.js` 一致；`.env` 舊門檻不會帶進錄製）。`record_local.bat` 與 `rerecord_all.js` 已支援 10.21 的全部步驟，沒有改。
   - 測試（全新 UTF8 測試庫、埠 5433，env 照 `ci.yml`；與 `a670783` 同機逐項比對）：unit 3,611 → 3,770（3,768 過、2 略過）、`check:html` 過、migrate（到 0020）、integration 615 → 624 全綠；e2e 12 項中同樣 3 項紅（缺 `extract_ocr`，鍵 `a47b37a0…` → `a5918283…`，A 的 `extract_ocr.v2`）；retrieval 全過（數字相同）；classify 92 筆、nlq 8 筆 replay miss 不變（nlq 報表多一行 C 的 LC-4 放寬計分說明）；pipeline 1 筆（同上 `extract_ocr` 換鍵），`saved_rate` 由 n/a 改印「OCR 模式不比門檻」並多一行人工核准前的通過率（C 的 D-2）；variant replay miss 2 → **60**、缺向量 29 → 0（A 的 `variant.v2` 讓 60 次生成全部對不上，走不到向量），`retrieved_coverage` 0.2333 → 0.5000（D 的 V5-1，門檻 0.8367 不動）。新增的 miss 只有 variant 一項，照 `local-mode.md` 10.21 第 2 步整步重錄。
   - 〔整合審查 2026-09-27 `dec/integration-r6-fix`〕① 10.21 原本拿「視窗印 [OK]」當成功判準，但 eval 未達門檻時 `run.js` 結束碼是 1 → `verifyReport.ok=false` → `record_local.bat` 印 [!]（variant 的 `retrieved_coverage` 0.5 必定如此）。改成以回放驗證表的 replay miss 與缺向量為準、寫明「只有門檻欄 ❌ 不要重跑」（10.21 第 0 步第 6 點與第 1～3 步）；`record_local.bat` 的失敗提示、`rerecord_all.js` 錄完的提示同步。② 重錄工具的回放驗證表（`cassettePlan.thresholdRows`）不認 D-2：報表 JSON 新增 `not_applicable`（`report2.emit`），`thresholdRows` 傳給 `compareSuite`，OCR 模式的 `saved_rate` 列成「n/a（不比門檻）」、不列進「門檻未達」；沒有這個欄位的報表照舊比（白名單以外照舊丟錯）。③ `rerecord_all.js` 錄完的「下一步」改成 `cassettes:prune` 先不要 `--apply`（與 10.21、`record_local.bat` 一致）。④ A 組的合併 commit 補上 Co-Authored-By／Claude-Session：以相同的 tree 重建五個合併與整合 commit（`git diff 744f143` 為空）。`thresholds.json`、golden、cassette 都沒動；新增單元測試在 `rerecordPlanR6.test.js`。

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
