# 數學／物理章節重整：介面凍結與工作分配（2026-09-25）

> **狀態**：凍結（commit 於 `stage5/chapters-base`，基於 `stage5/integration`）。疑義以「裁決 CR-n」回覆，記於本檔第 8 條。
> **決策來源**：Owner 2026-09-25 於對話中定案。
> - 數學「照草案定案」：34 章 → 52 章，含 5 章改名。
> - 物理「照草案，但刪掉流體與宇宙學」：32 章 → 34 章。
> - 化學以龍騰版為準（章名不動，核對知識點歸屬）。
> - 錄製紀錄（cassette）重錄：Owner 同意由 AI 在他電腦上執行。但 2026-09-25 實測，他電腦上的 Cowork VM 連不到 `generativelanguage.googleapis.com`，因此改由 Owner 在 Windows 上執行一支準備好的指令（第 5 條）。
> **為什麼要重整**：舊白名單與 108 課綱單元不是一對一。例如「三次函數」裝了二次函數與複數、「正弦與餘弦定理」裝了和角公式，也完全沒有圓錐曲線與熱學。章名錯位會讓分類、知識點、弱點統計一起失準。

---

## 1. 範圍與原則

- 章節清單與舊→新對照的**唯一真相**是 `exam_pro/config/chapterPlan.js`（`PLAN_VOLUMES`、`PLAN_CHAPTERS`、`MIGRATION`）。本檔不重抄清單。
- **這次刻意讓數學／物理的 schema enum 改變**：既有 classify、extract、variant、nlq 的 cassette 會失效；檢索的 embeddings fixture 中，被改標章節的題目也會失效（embed_text 第一行含章名）。
- 因此在 Owner 重錄之前，本分支的 CI 預期：
  - **必須全綠**：unit、check:html、migrate、integration。
  - **允許失敗，但只能是 replay miss**（cassette 或 embeddings 找不到）：e2e 與五個 eval。任何其他原因的失敗都是缺陷。
  - 每個 WS 回報時要逐一列出失敗項目，並確認都是 replay miss。
- 化學的 schema、模板、cassette **一律不受影響**，化學路徑的測試必須全綠。
- 其他規則沿用 `docs/interfaces-stage5.md` 第 1 條：分支、commit 格式、測試不得放寬、學生姓名不出境、不新增依賴。

## 2. 定案清單摘要（細節以 `chapterPlan.js` 為準）

- **數學 52 章**：沿用舊名 25 章、改名 5 章、由拆分或新設而來 22 章。純新增、沒有舊題會搬入的章：複數的幾何意涵、拋物線、橢圓、雙曲線、線性規劃。
- **物理 34 章**：
  - 新增：電與磁的統一、測量與不確定度、質心與角動量、理想氣體與氣體動力論。
  - 刪除：流體的壓力與浮力、宇宙學簡介。
  - 簡諧運動、重力場與重力位能、動量兩章、電流與電路改到別冊，章名不變。
- `config/chapters.js` 匯出的 `LEGACY_SUBJECTS`／`LEGACY_CHAPTERS` 沿用名稱，值改成新的數學＋物理清單（順序：數學各冊 → 物理各冊）。註解要寫明「LEGACY 指『數學／物理這一組的 schema 值域』，2026-09-25 起為重整後版本」。

## 3. 工作分配

| WS | 主題 | 分支／worktree | 測試庫 |
|---|---|---|---|
| CH-A | 白名單與周邊（chapters、別名、例句、分詞詞典、prompt 片段、測試）＋舊題遷移腳本＋文件與 ADR | `stage5/ch-a` ／ `/home/claude/wt/ch-a` | `tutor_ch_a_test` |
| CH-B | eval 素材改標（fixtures、golden、pdf_sample）＋重錄腳本（給 Owner 在 Windows 執行）＋清除過期 cassette 的工具 | `stage5/ch-b` ／ `/home/claude/wt/ch-b` | `tutor_ch_b_test` |
| CH-C | 數學知識點種子檔依新章重排（代碼重編、新章撰寫） | `stage5/ch-c` ／ `/home/claude/wt/ch-c` | 不需要 |
| CH-D | 物理知識點種子檔（刪 2 章、新 4 章）＋化學種子檔的跨科先備改寫＋化學知識點歸屬依龍騰核對 | `stage5/ch-d` ／ `/home/claude/wt/ch-d` | 不需要 |

各 WS 以 `chapterPlan.js` 為準各自施工，不依賴彼此分支。CH-C／CH-D 驗證種子檔時，把 `PLAN_CHAPTERS` 加上化學章節傳進 `validateSeeds(seeds, { chapters })`。

### 3.1 CH-A

1. `config/chapters.js` 的數學與物理 `VOLUMES` 改讀 `chapterPlan.PLAN_VOLUMES`，化學不動。
2. **`config/chapterAliases.js`**：
   - 指向「被拆分」舊章的別名，要改指到正確的新章。例如「和角公式」→ 和角與差角公式、「條件機率」→ 條件機率與貝氏定理、「複數」→ 複數與多項式方程式、「二項式定理」→ 二項式定理。
   - 新章補上常用別名。
   - 被刪的物理章，別名一併移除。
   - 別名衝突規則沿用第 6.2 條。
3. `config/chapterExamples.js`：每個新章寫一句**自撰**的典型題幹，不可抄考卷或出版社原文；改名的章把例句一起搬過去。
4. `utils/tokenize.js`：新章名與新名詞進詞典。會因此改變切法的既有語料要列出來，併入後的 `search:reindex` 會處理。
5. **`agents/promptParts.js`、`services/nlqService.js`**：凡是列出數學／物理白名單的地方，改成新清單。它們進的是既有 cassette 的呼叫，這些 cassette 本來就要重錄。
6. **既有測試**：
   - 釘住 66 章、34／32 章的斷言，照新數字（52＋34＝86）更新，並加註〔章節重整 CH-A〕。
   - 斷言特定舊章名的測試，改用新章名。
   - 其餘測試不得放寬。
7. **舊題遷移**：新增 `scripts/migrate_chapters.js`（`npm run chapters:migrate`），**不呼叫 LLM**。
   - `--dry-run`（預設）：依 `MIGRATION` 產生一份提議檔 `data/chapter-migration-<日期>.csv`。欄位：id、subject、舊章、提議新章、依據（rename／keyword:<命中詞>／default／removed）、題幹前 60 字。同時印出統計。
     - `rename` 的題直接提議新章。
     - `split` 的題用關鍵字規則提議，規則放 `config/chapterMigrationRules.js`（例：和角｜倍角｜半角 → 和角與差角公式；疊合 → 三角函數的疊合；條件機率｜貝氏｜獨立事件 → 條件機率與貝氏定理；二項式｜二項展開 → 二項式定理；Σ｜級數 → 級數；遞迴｜數學歸納 → 數列與遞迴關係；複數｜虛數 → 複數與多項式方程式；不等式 → 多項式不等式；集合｜排容｜文氏圖 → 集合與計數原理；轉移矩陣｜線性變換｜旋轉｜鏡射 → 矩陣的應用；聯立｜高斯消去｜三元 → 一次方程組；二元一次｜克拉瑪 → 面積與行列式；廣義角｜標準位置｜極坐標 → 廣義角與極坐標；圖形｜週期｜振幅｜弧度 → 三角函數的圖形；二項分布｜幾何分布 → 二項分布與幾何分布；指數函數｜對數函數 → 指數函數與對數函數；質心｜角動量 → 質心與角動量）。沒命中就提議 `to[0]`。
     - `removed` 的題提議 `to[0]`（沒有 `to` 就留空），**一律要老師確認**。
   - `--apply <csv>`：套用老師改過的 CSV。
     - 單一交易，逐列驗證新章在白名單內，被改到的題 `chapter_src` 設為 `human`。
     - 同時刪除這些題 `src='ai'` 的知識點標註。
     - 印出之後必跑的指令：`embed:backfill`（embed_text 含章名）與 `search:reindex`。
   - 整合測試：rename 自動、split 的關鍵字命中與預設、removed 空白、apply 的驗證與交易、`chapter_src`、知識點標註清除、重跑冪等。
8. `docs/chapter-restructure.md` 補「給老師的遷移操作步驟」一節（在第 7 條之前），並新增 **ADR-016**（章節白名單重整：對齊 108 龍騰目錄、刻意讓 cassette 失效並一次重錄、舊題以規則提議＋人工確認遷移）。

### 3.2 CH-B

1. **`eval/fixtures/questions.public.json` 與所有 golden**（classify、nlq、retrieval、variant、pdf_sample、dedup、formula、answer 等，凡含數學／物理章名者）：
   - 每一題照題意改標到新章。不能只照舊章機械對應，要讀題幹判斷。
   - 被刪物理章的題改到最合適的章，或移除該題並記錄理由。
   - 改標清單寫進 `eval/CHAPTER_RELABEL-2026-09.md`：題號、舊章、新章、理由。
2. **重錄腳本 `eval/tools/rerecord_all.js`**（`npm run cassettes:rerecord`），給 Owner 在 Windows 的 `exam_pro/` 下執行。
   - 讀 `.env` 的金鑰，依序錄：
     - retrieval 需要的 embeddings（只補缺的）
     - classify、nlq、variant 三個 suite
     - pipeline／e2e 需要的 extract 與後續節點
   - `--dry-run` 只做回放，列出每個 suite 缺多少 cassette、預估呼叫次數與費用（用 `config/pricing.js`），不打網路。
   - 正式執行前要求輸入 `yes` 確認。
   - 跑完用 replay 模式把五個 eval 與 e2e 各跑一次，印出結果與門檻比較。
   - 要照 repo 既有的 record 機制（`LLM_MODE=record`、`EMBED_MODE`、`eval/README.md`、`eval/record_embeddings.js`）實作，**不要另造一套**。寫單元測試覆蓋 dry-run 的計數邏輯。
3. **過期 cassette 清除工具 `eval/tools/prune_cassettes.js`**（`npm run cassettes:prune`）：
   - 在 replay 模式跑完全部 suite 並記下命中的鍵，列出沒被命中的 cassette 檔。
   - `--apply` 才刪除。
   - 化學 cassette 目錄（`*_chem`）與 tutor／voice 不在範圍內。
4. **回報**：逐一列出本分支 CI 中「預期會 replay miss」的項目與數量。這份清單就是 Owner 重錄後應該恢復綠燈的範圍。

### 3.3 CH-C（數學知識點）

1. 依新 52 章重寫 `config/kc/數學.json`。規則同 `docs/interfaces-stage5.md` 第 3.4、3.5 條：每章 3–8 個，口語版準則不變。
2. **搬移**：
   - 舊知識點依內容搬到新章，例如和角、倍角、疊合移到新設的兩章，條件機率移到新章。
   - 代碼依新章名與新序號重編；**「向量內積」章 4 條 approved 的代碼、內容、status 一律不變**。
3. **撰寫新章**：沒有舊知識點可搬的章要新寫，包括複數的幾何意涵、拋物線、橢圓、雙曲線、線性規劃、二項分布與幾何分布，以及集合與計數原理中舊檔沒有的部分。
4. **對照檔** `config/kc/code-map-數學-2026-09.json`：舊 code → 新 code（或 `null`＝刪除）。先備引用照這份對照改寫。
5. 抽查紀錄 `docs/kc-review-數學.md` 更新：第 2 節的 11 點改寫成「已依重整處理」或「仍待 Owner 決定」；新章列入最沒把握清單。

### 3.4 CH-D（物理知識點＋化學核對）

1. **`config/kc/物理.json`**：
   - 刪除「流體的壓力與浮力」「宇宙學簡介」兩章的知識點（列入對照檔，值為 `null`）。
   - 新 4 章各寫 3–8 個知識點，對照龍騰 108：
     - 電與磁的統一：電流磁效應、電磁感應、電與磁的整合、波的性質、光與電磁波（必修層次）
     - 測量與不確定度：不確定度與有效數字、不確定度的組合、因次分析
     - 質心與角動量：重心與質心、質心運動、角動量守恆
     - 理想氣體與氣體動力論：理想氣體方程式、氣體動力論
   - 既有知識點若更適合新章（例如質心、角動量）就搬過去並重編代碼。
   - 對照檔：`config/kc/code-map-物理-2026-09.json`。
2. **`config/kc/化學.json`**：
   - 跨科先備若指向數學／物理的舊 code，依兩份對照檔改寫。數學對照檔由 CH-C 產出、不在本分支，所以先依規則推定並列入抽查紀錄，整合時由主控核對。
   - 依龍騰版核對 `docs/kc-review-化學.md` 第 3 節 A–L 的知識點歸屬。龍騰目錄見本檔附錄 A；化學章名不動。需要搬移的就搬、重編代碼，並產出 `config/kc/code-map-化學-2026-09.json`。
3. 抽查紀錄 `docs/kc-review-物理.md`、`docs/kc-review-化學.md` 更新。

## 4. 驗收

- **CH-A、CH-B**：`/home/claude/ci.sh <worktree>/exam_pro <db>` 中，unit、check:html、migrate、integration 全綠；e2e 與 eval 的失敗逐項確認為 replay miss。
- **CH-C、CH-D**：`validateSeeds` 對 `PLAN_CHAPTERS`＋化學章節零 error；對照檔涵蓋每一個舊 code。
- **整合**：主控合併後，用新的 `CHAPTERS` 跑一次三科種子檔全域驗證（跨科先備解析、無環）。

## 5. Owner 重錄（整合後）

1. 把整合分支取到 Windows 本機。
2. `cd exam_pro` → `npm run cassettes:rerecord -- --dry-run`，看缺多少、預估費用。
3. `npm run cassettes:rerecord`，輸入 `yes`。
4. 跑完把新的 cassette 與 embeddings fixture commit、push。主控接手看門檻；若 eval 的量測值低於門檻，另開裁決，不自動放寬門檻。
5. `npm run cassettes:prune -- --apply` 清掉過期檔，再 commit。

## 6. 上線（Owner，重錄且 CI 綠燈後）

在 `docs/HANDOFF.md` 第 0.2 節的上線步驟中，`migrate` 之後、`search:reindex` 之前插入兩步：

1. `npm run chapters:migrate`：產生提議檔 → 老師確認 → `--apply`。
2. `npm run embed:backfill`：embed_text 含章名，搬章的題要重算向量；會呼叫 embedding API，費用很小。

之後照原順序：`search:reindex` → `kc:load` → ……

## 7. 附錄 A：龍騰 108 目錄摘要（2026-09-25 擷取自升學王版本對照表）

- **化學**：必修（物質的組成／物質的構造與反應／溶液與反應／生活中的化學）；選修一（化學反應與能量：限量試劑與產率、能量形式轉換、反應熱與赫斯定律、莫耳燃燒熱與生成熱；氣體；溶液的性質）；選修二（原子構造、化學鍵結、反應速率）；選修三（化學平衡、酸鹼）；選修四（氧化還原與電化學、無機化合物與先進材料）；選修五（有機化合物、聚合物、化學與社會）。
- **物理**：必修（科學的態度與方法、物質的組成與交互作用、物體的運動、電與磁的統一、能量、量子現象）；選修一（測量與不確定度、直線運動、平面運動、牛頓運動定律、週期運動、萬有引力）；選修二（靜力平衡、動量與角動量、功與能量、碰撞、熱學）；選修三（波動、聲波、幾何光學、物理光學）；選修四（靜電學、電流的磁效應、電磁感應）；選修五（電路學、量子現象、原子結構）。

## 8. 裁決紀錄

（CR-n 記於此。）
