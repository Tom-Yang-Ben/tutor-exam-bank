# ADR-016: 數學／物理章節白名單重整 (Chapter Whitelist Restructure) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受（Owner 2026-09-25 於對話中定案；實作於 `stage5/ch-a`～`ch-d`）
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「數學／物理的章節白名單為何要整份換成對齊 108 龍騰目錄的新清單、為何刻意讓既有 cassette 失效並一次重錄、舊題為何以『規則提議＋老師確認』遷移而不是自動搬」；定案清單與舊→新對照歸 `exam_pro/config/chapterPlan.js`，工作分配、驗收與操作步驟歸 [`docs/chapter-restructure.md`](../../../docs/chapter-restructure.md)。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 數學 34 章、物理 32 章的精細章節白名單（`config/chapters.js`）是系統早期手訂的，與 108 課綱各冊單元不是一對一。例如「三次函數」裝了二次函數與複數、「正弦與餘弦定理」裝了和角公式、「組合」裝了二項式定理，也完全沒有圓錐曲線與熱學。白名單是整個系統的分類軸：拆題與分類的 schema enum、NLQ 的規則與 prompt、分詞詞典、知識點（每章 3–8 個）、弱點統計、題庫覆蓋率、補救卷的跨章配額都以章為單位。
- **問題**: 章名錯位會讓分類、知識點與弱點統計一起失準（「學生三次函數弱」其實可能是複數弱）；缺的章（拋物線、橢圓、雙曲線、線性規劃、理想氣體）則根本無處可放。要不要、以及怎麼把白名單換成對齊教科書的版本？
- **驅動因素/約束**:
  - schema 的 `chapter` enum 與 prompt 裡的白名單文字都進了 cassette 的鍵（[ADR-006](./ADR-006-cassette-record-replay.md)）；檢索 eval 的 embeddings fixture 以 embed_text 為鍵，而 embed_text 第一行含章名。白名單一動，數學／物理的 classify、extract、variant、nlq cassette 全部失效，被改標章節的題的 embeddings 也失效。
  - 階段 5 的共通規則（`docs/interfaces-stage5.md` 第 1.1 條）原本是「既有 cassette 一律不得失效」；化學當時是以卷別分流（[ADR-010](./ADR-010-subject-group-routing-for-chemistry.md)）繞開的。這一次要改的正是數學／物理自己的值域，繞不開。
  - 題庫裡已經有真實的舊題（老師多年累積的考卷），它們掛著舊章名；新白名單一生效，這些題在編輯時存不回去、弱點與覆蓋率對不上新章。
  - 舊→新不是一對一：1 章改名、多章一拆多、物理 2 章被刪。拆分的去處要看題目內容才能決定。
  - Owner 是唯一使用者也是維護者；重錄 cassette 需要他在自己的 Windows 電腦上用自己的金鑰執行（AI 環境沒有網路 LLM）。

## 2. 考量的選項

### 選項一: 不動白名單，只在知識點層補齊
- **描述**: 章名維持 66 章，把教科書的細分放到知識點（例：「三次函數」底下掛複數的知識點）。
- **優點**: 零重錄、零遷移。
- **缺點**: 分類、弱點統計、覆蓋率、補救卷配額都以章為單位，錯位的章名照樣誤導；沒有章可放的內容（圓錐曲線、熱學）仍然沒有位置；知識點的「每章 3–8 個」會被塞爆。治標不治本。
- **成本/複雜度**: 低

### 選項二: 新舊並存（新章作為別名層或第二組 enum，舊 cassette 保留）
- **描述**: schema 與 prompt 維持舊 66 章，另外在伺服器端把舊章「翻譯」成新章；或新增一組新 enum 的模板，舊模板繼續用舊 enum。
- **優點**: 既有 cassette 不失效。
- **缺點**: 一拆多的章無法單靠翻譯決定去處（「三次函數」要翻成哪一章？）；兩套值域並存，每個讀 `CHAPTERS` 的地方都要知道現在用哪一套，化學已經用掉一次這種分流，再疊一層會讓每個 agent 都有三條路徑；模型仍在舊的錯位章名裡分類，品質問題沒解決。
- **成本/複雜度**: 高

### 選項三: 整份換成對齊 108 龍騰目錄的新清單，刻意讓 cassette 失效並一次重錄；舊題以規則提議＋老師確認遷移（採用）
- **描述**: `config/chapterPlan.js` 是定案清單（數學 52 章、物理 34 章）與舊→新對照（`MIGRATION`：same／rename／split／removed）的唯一真相；`config/chapters.js` 的數學／物理 `VOLUMES` 直接讀它，`LEGACY_*` 名稱沿用、值換成新清單。別名、few-shot 例句、分詞詞典、知識點種子檔、eval 素材全部依新清單改寫。受影響的 cassette 與 embeddings 由 Owner 用一支準備好的指令（`npm run cassettes:rerecord`）一次重錄。舊題由 `npm run chapters:migrate` 依對照表與關鍵字規則產生提議檔（CSV），老師確認後 `--apply`。
- **優點**: 分類軸與教科書一致，下游的分類、知識點、弱點、覆蓋率、補救卷一起變準；只有一套值域，程式結構不變；遷移的每一個決定都有人看過，可稽核（`chapter_migration_log`）。
- **缺點**: 一次重錄要錢、要 Owner 動手，重錄前 CI 的 e2e 與五個 eval 只能是紅燈（replay miss）；重錄後 eval 的量測值會跳，不能直接跟舊數字比；老師要花時間確認提議檔。
- **成本/複雜度**: 中（程式）／中（重錄與確認）

## 3. 決策

**選擇**: 選項三——整份換成新清單、刻意讓數學／物理的 cassette 失效並一次重錄、舊題以規則提議＋人工確認遷移。

**理由**:
- 白名單是分類軸，錯位的軸讓所有下游統計一起錯；只有把軸本身換掉才解決問題。新清單逐冊對照 108 龍騰目錄（`docs/chapter-restructure.md` 附錄 A），章名由 Owner 定案（數學「照草案定案」；物理「照草案，但刪掉流體與宇宙學」）。
- 「既有 cassette 不得失效」是為了讓 CI 的數字可以跨版本比較；這一次值域本身改變，舊數字已經不是同一件事，保留舊 cassette 只會讓測的東西與線上行為脫節。與其長期維持兩套值域，不如一次重錄、之後照舊凍結。重錄前 CI 的預期寫死在契約：unit、check:html、migrate、integration 全綠，e2e 與 eval 只允許 replay miss，任何其他失敗都是缺陷——紅燈的範圍是可列舉、可驗證的。
- 舊題不自動搬：一拆多的去處要看題意。關鍵字規則（`config/chapterMigrationRules.js`）只負責提議並寫明依據（`rename`／`keyword:<命中詞>`／`default`／`removed`），老師在 Excel 裡改完再套用；套用是單一交易、逐列驗證，換章的題標成 `chapter_src='human'`、清掉 AI 知識點標註（AI 是從舊章的知識點裡挑的），並記進 `chapter_migration_log`。不呼叫 LLM：一次性的遷移不值得為它錄 cassette，而且老師本來就要看每一題。
- 新章沿用舊名的拆分（排列、組合…共 9 章）讓「還沒處理」與「老師確認留在原章」在 `questions.chapter` 上無法區分，所以新增 `chapter_migration_log`（migration 0014）當作已處理的紀錄與稽核軌跡，重跑 `--dry-run` 才不會把確認過的題再提議一次。
- 化學不動：化學的章名已依龍騰版訂定（ADR-010），它的 schema、模板與 cassette 都在另一條路徑，這次的改動不碰它們。

## 4. 後果

- **正面**: 分類、知識點、弱點統計、覆蓋率與補救卷都以對齊教科書的章為單位；新增的圓錐曲線、線性規劃、熱學等內容有章可放；舊的章名收成別名（多項式除法、三次函數、矩陣的加減與乘法、克拉瑪公式），老師照舊習慣打字仍查得到；遷移每一題的去處與依據都留紀錄。
- **負面**: Owner 重錄之前，CI 的 e2e 與五個 eval 是紅燈（只能是 replay miss）；單元測試裡的 classify 回放測試改為「對應的 cassette 不在就略過」（與 extract 回放測試原本的做法一致），重錄後自動恢復；重錄後 eval 數字與舊基準不可直接比較，若低於門檻另開裁決、不自動放寬；上線多兩步（`chapters:migrate`、`embed:backfill`）；分詞詞典改變，全部題目要跑一次 `search:reindex`（repo 內語料切法改變的只有 6 段，全在 eval 素材：NLQ 查詢「象限角的單選題」的「象限／角」變成「象限角」、「求它的三角比」的「三角／比」變成「三角比」、三句寫到舊章名「三角函數的定義」的查詢不再切成一個詞，以及一題答案的「同界角」；老師的真實題庫一定還有更多，所以 reindex 必跑）；別名受第 6.2 條「沒有跨章子字串」規則限制，「角動量守恆」「對數函數」「等比級數」這類詞無法收成別名，查詢時會被較短的別名吃到相鄰章（例：「角動量守恆」→ 動量守恆與碰撞，與重整前相同），需要時由 LLM 輔路徑補。
- **影響範圍**: `exam_pro/config/chapterPlan.js`（定案清單）、`config/chapters.js`、`config/chapterAliases.js`、`config/chapterExamples.js`、`config/chapterMigrationRules.js`（新）、`utils/tokenize.js`、`agents/promptParts.js`、`agents/schemas/index.js`、`services/nlqService.js`、`scripts/migrate_chapters.js`（新）、`migrations/0014_chapter_migration_log.sql`（新）、`seed_questions.js`、`config/kc/*.json`、`eval/fixtures/**`、`eval/golden/**`、`eval/cassettes/**`（重錄）、`eval/tools/rerecord_all.js`、`eval/tools/prune_cassettes.js`。
- **重新評估觸發**: 教科書版本改變（Owner 改用其他出版社版本、或新課綱）；Owner 重錄後某個 eval 的量測值持續低於門檻，且原因是章的切法（例如兩章在題目上分不開）；遷移後老師回報大量題目「放哪一章都不對」；再有需要整份重排的情況時，沿用本 ADR 的流程（新 `PLAN_ID`、一次重錄、規則提議＋確認），不要改成兩套值域並存。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | Owner 2026-09-25 對話定案（數學「照草案定案」、物理「照草案，但刪掉流體與宇宙學」、化學以龍騰版為準）；`docs/chapter-restructure.md` 第 1、2、3.1 條 |
| 影響範圍 | `docs/chapter-restructure.md`、`exam_pro/config/chapterPlan.js`、`migrations/0014_chapter_migration_log.sql`、`docs/interfaces-stage5.md` 第 1.1 條（本次刻意例外） |
| 取代關係 | 無；對 [ADR-006](./ADR-006-cassette-record-replay.md)「cassette 凍結」做一次性的刻意例外（重錄後照舊凍結）；延續 [ADR-005](./ADR-005-server-side-whitelist-validation.md)（伺服器端白名單仍是最終閘門）、[ADR-008](./ADR-008-app-layer-chinese-tokenizer.md)（詞典改了要重切 search_tsv）、[ADR-010](./ADR-010-subject-group-routing-for-chemistry.md)（化學路徑不受影響）、[ADR-011](./ADR-011-knowledge-component-model.md)（知識點代碼依新章重編） |
