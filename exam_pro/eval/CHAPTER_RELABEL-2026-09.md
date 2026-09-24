# eval 素材改標清單（章節重整 CH-B，2026-09-25）

> 依據：`docs/chapter-restructure.md` 第 3.2 條第 1 點；章節清單以 `config/chapterPlan.js` 的 `PLAN_CHAPTERS` 為準（Owner 2026-09-25 定案）。
> 範圍：`eval/fixtures/questions.public.json` 與所有含數學／物理章名的 golden。
> 狀態：**AI 依題意逐題判斷，待 Owner 抽查**。最沒把握的幾題列在第 6 節。
> 2026-09-25 審查後修正：#25、#26（平方關係）改歸「直角三角形的邊角關係」，並新增自製干擾題 #61（第 2.1 節、第 6 節第 3 項）。
> 驗證：`test/unit/evalChapterRelabel.test.js` 用 `PLAN_CHAPTERS`＋化學章節跑一遍所有硬閘門，並逐列核對本檔第 2～4 節的表格與檔案內容。

## 0. 判斷原則

章名依龍騰 108 各冊目錄判斷，不照舊章機械對應。

- **指數與對數（第一冊）**：指數律、常用對數（以 10 為底）、科學記號與位數估計。
- **指數函數與對數函數（第三冊）**：一般底數的對數與對數律、換底公式、指數與對數方程式、兩種函數的圖形。
  108 課綱第一冊只教常用對數，一般底數的對數在第三冊。
- **直角三角形的邊角關係（第二冊）**：銳角三角比、特殊角、平方／商數／餘角關係。題目只用到銳角時歸這一章——即使答案寫「與角度無關」。
- **廣義角與極坐標（第二冊）**：廣義角與同界角、以坐標定義的三角比、參考角與象限正負號、極坐標。
- **三角函數的圖形（第三冊）**：弧度、圖形、週期與振幅。
- 物理 29 題（fixture #32–#60）的章名都屬 `MIGRATION` 的 `same`，題意也不屬於新增的四章，全部維持原章。

## 1. 總覽

| 檔案 | 改標 | 檢視後維持原章 | 備註 |
|---|---:|---:|---|
| `eval/fixtures/questions.public.json` | 12 | 3 | 61 題（新增 #61，第 2.1 節）；改標後涵蓋 10 章（原 8 章） |
| `eval/golden/classify.json` | 19 | 5 | fixture 段 12 筆與 fixture 一致；漂移段 7 筆；另新增 cls-fx-061（共 91 筆） |
| `eval/golden/variant.json` | 7 | 1 | 閘門要求藍本章名與 fixture 相同 |
| `eval/golden/pdf_sample/f1a15d77….json` | 2 | 1 | 樣卷 PDF 不印章名，sha256 不變，檔名不變 |
| `eval/golden/nlq.json` | 9 | — | 7 句改寫查詢、2 句改期望章節（nlq-032 的 relevant 也跟著變）；另有 2 句只調 relevant（第 4 節） |

**被刪的物理章**（流體的壓力與浮力、宇宙學簡介）：fixture 與 golden 都沒有題目標在這兩章，不需要移除任何題。

**不需要改的 golden**：
- `retrieval.json`：只有題號，沒有章名，不動。hard_negatives 與 `_suggestion.basis` 當初依舊章取「同章干擾題」，改標後有幾筆已不再同章：
  R001～R004（query #1～#4 改到指數函數與對數函數）的 #8 仍在指數與對數；R017、R018（query #25、#26 改到直角三角形的邊角關係）的 #29、#30 在廣義角與極坐標，
  新章唯一的干擾題 #61 沒有列入。這些負樣本與 query 不同 variant_group，仍然是負樣本，所以 relevant／hard_negatives 都不動。
  `_suggestion.basis` 的「hard_negatives = 同章干擾題」**刻意保留、已過期**：它記的是 2026-08-22 建稿時的依據，loader 會忽略 `_` 開頭的鍵。
  要不要把 #61 加進 R017、R018 的 hard_negatives，留給 Owner 決定（第 6 節第 6 項）。
- `answer.json`、`dedup.json`、`formula.json`：沒有章名欄位（題幹與 note 裡的「直線運動」「向量內積」等是內文）。
- `answer_chem.json`、`classify_chem.json`：化學不在本次範圍。

## 2. 改標清單

| 檔案 | 題號 | 舊章 | 新章 | 理由 |
|---|---|---|---|---|
| questions.public.json | 1 | 指數與對數 | 指數函數與對數函數 | log₂8＋log₂4：一般底數的對數律（第三冊） |
| questions.public.json | 2 | 指數與對數 | 指數函數與對數函數 | 同 #1，換成底數 3 |
| questions.public.json | 3 | 指數與對數 | 指數函數與對數函數 | 解指數方程式 2^(x+1)=32，化為同底比較指數，屬第三冊的指數函數（舊知識點 MATH.指數與對數.03） |
| questions.public.json | 4 | 指數與對數 | 指數函數與對數函數 | 同 #3，換數字 |
| questions.public.json | 7 | 指數與對數 | 指數函數與對數函數 | log₂3×log₃8：換底公式（第三冊） |
| questions.public.json | 25 | 三角函數的定義 | 直角三角形的邊角關係 | sin²40°＋cos²40°：40° 是銳角，平方關係是 108 第二冊 3-1 的典型例題（初版歸廣義角與極坐標，審查後依題意改標，見第 6 節第 3 項） |
| questions.public.json | 26 | 三角函數的定義 | 直角三角形的邊角關係 | 同 #25，換成 25° |
| questions.public.json | 27 | 三角函數的定義 | 廣義角與極坐標 | sin150°：第二象限，以參考角化簡 |
| questions.public.json | 28 | 三角函數的定義 | 廣義角與極坐標 | cos120°：同 #27 |
| questions.public.json | 29 | 三角函數的定義 | 廣義角與極坐標 | 與 400° 同界的最小正角：廣義角與同界角 |
| questions.public.json | 30 | 三角函數的定義 | 廣義角與極坐標 | 終邊通過 P(−3,4)，以 sinθ=y/r 定義 |
| questions.public.json | 31 | 三角函數的定義 | 廣義角與極坐標 | 第二象限 tanθ 的正負號 |
| classify.json | cls-fx-001 | 指數與對數 | 指數函數與對數函數 | 與 fixture #1 一致 |
| classify.json | cls-fx-002 | 指數與對數 | 指數函數與對數函數 | 與 fixture #2 一致 |
| classify.json | cls-fx-003 | 指數與對數 | 指數函數與對數函數 | 與 fixture #3 一致 |
| classify.json | cls-fx-004 | 指數與對數 | 指數函數與對數函數 | 與 fixture #4 一致 |
| classify.json | cls-fx-007 | 指數與對數 | 指數函數與對數函數 | 與 fixture #7 一致 |
| classify.json | cls-fx-025 | 三角函數的定義 | 直角三角形的邊角關係 | 與 fixture #25 一致 |
| classify.json | cls-fx-026 | 三角函數的定義 | 直角三角形的邊角關係 | 與 fixture #26 一致 |
| classify.json | cls-fx-027 | 三角函數的定義 | 廣義角與極坐標 | 與 fixture #27 一致 |
| classify.json | cls-fx-028 | 三角函數的定義 | 廣義角與極坐標 | 與 fixture #28 一致 |
| classify.json | cls-fx-029 | 三角函數的定義 | 廣義角與極坐標 | 與 fixture #29 一致 |
| classify.json | cls-fx-030 | 三角函數的定義 | 廣義角與極坐標 | 與 fixture #30 一致 |
| classify.json | cls-fx-031 | 三角函數的定義 | 廣義角與極坐標 | 與 fixture #31 一致 |
| classify.json | cls-dr-001 | 指數與對數 | 指數函數與對數函數 | 改寫自 #1，仍是一般底數的對數律 |
| classify.json | cls-dr-002 | 指數與對數 | 指數函數與對數函數 | 改寫自 #3，仍是指數方程式 |
| classify.json | cls-dr-008 | 三角函數的定義 | 直角三角形的邊角關係 | 改寫自 #25（不查表寫出 sin²40° 與 cos²40° 的和），理由同 #25 |
| classify.json | cls-dr-009 | 三角函數的定義 | 廣義角與極坐標 | 改寫自 #27，求 150° 的正弦 |
| classify.json | cls-dr-020 | 指數與對數 | 指數函數與對數函數 | 以對數律化簡 log₅25＋log₅5（一般底數）。decoy「對數函數」不變：仍不在白名單，也不等於正解 |
| classify.json | cls-dr-022 | 三角函數的定義 | 廣義角與極坐標 | 依單位圓定義求 cos240°。decoy「銳角三角函數」不變 |
| classify.json | cls-dr-023 | 三角函數的定義 | 廣義角與極坐標 | 依廣義角定義求 cosθ。decoy「廣義角」不變（不等於新章名） |
| variant.json | var-001 | 指數與對數 | 指數函數與對數函數 | 藍本 #1，與 fixture 一致 |
| variant.json | var-002 | 指數與對數 | 指數函數與對數函數 | 藍本 #3，與 fixture 一致 |
| variant.json | var-004 | 指數與對數 | 指數函數與對數函數 | 藍本 #7，與 fixture 一致 |
| variant.json | var-013 | 三角函數的定義 | 直角三角形的邊角關係 | 藍本 #25，與 fixture 一致 |
| variant.json | var-014 | 三角函數的定義 | 廣義角與極坐標 | 藍本 #27，與 fixture 一致 |
| variant.json | var-015 | 三角函數的定義 | 廣義角與極坐標 | 藍本 #29，與 fixture 一致 |
| variant.json | var-016 | 三角函數的定義 | 廣義角與極坐標 | 藍本 #31，與 fixture 一致 |
| pdf_sample | 1 | 指數與對數 | 指數函數與對數函數 | 樣卷第 1 題＝fixture #1 |
| pdf_sample | 4 | 三角函數的定義 | 直角三角形的邊角關係 | 樣卷第 4 題＝fixture #25 |
| nlq.json | nlq-032 | 三角函數的定義 | 廣義角與極坐標 | 別名「象限角」原本指向已不存在的「三角函數的定義」，應改指「廣義角與極坐標」（見第 6 節第 7 項）；relevant 由 25、26、29、31 改為 29、31（#25、#26 改標到直角三角形的邊角關係，本來就與象限角無關） |
| nlq.json | nlq-041 | 三角函數的定義 | 廣義角與極坐標 | 走 LLM 的句子：「終邊通過某一點求三角比」是以坐標定義的三角比；relevant 不變 |

### 2.1 新增的題

#25、#26 依題意改歸「直角三角形的邊角關係」後，這一章有換數字配對（trig-pyth）卻沒有同章干擾題，
fixture 的結構規則 D-E1（`test/unit/evalFixtures.test.js`「每個有配對的章節都至少有一題」）不成立，所以新增一題自製干擾題。

| 檔案 | 題號 | 新增到的章 | 理由 |
|---|---|---|---|
| questions.public.json | 61 | 直角三角形的邊角關係 | 自製干擾題（單選、難度 2、role=distractor）：直角三角形已知兩股求 sin A，考銳角三角比的定義；與 #25、#26（平方關係）同章不同概念。答案由 AI 撰寫，待 Owner 核對 |
| classify.json | cls-fx-061 | 直角三角形的邊角關係 | fixture 段逐字沿用 fixture #61 的題幹與標籤（規劃 §5.3.2「標籤沿用 fixture」） |

牽動的固定數字與檔案（測試照改並加註〔章節重整 CH-B〕，都仍是精確值）：

- fixture 60 → 61 題、classify 90 → 91 筆（fixture 段 60 → 61，漂移段仍是 30）、variant golden 涵蓋的章 9 → 10、nlq 檔頭註記的 fixture 章數 9 → 10。
  測試：`evalFixtures`、`evalGolden2`、`evalVariant`、`evalChapterRelabel`；`normalizeStem`、`formulaGate`、`textFormatterStrict` 只改測試名稱裡的題數
  （#61 的 LaTeX 零事件、formulaFix 零套用，已由這三支逐題驗過）。
- #61 刻意選單選、難度 2：不落入任何既有 nlq 句子的篩選條件，也不改變 `answerCompare` 的「填空／計算 45 題」統計。
  它不屬於任何 variant_group、不在樣卷上，retrieval、variant、樣卷的 golden 不需要新增項目。
- 檢索與 variant 的候選池多一題：variant 的 retrieved_coverage 只會持平或上升；retrieval 的 Recall 理論上可能因為多一個候選而被擠掉一名，
  但 #61 與其他章的題並不相近，重錄後若有變動，照第 5 條另開裁決，不自動放寬門檻。
- 向量：#61 是新題，向量檔裡沒有，與其他改標的題一起由 `npm run cassettes:rerecord` 的第 1 步補錄（第 7 節）。

## 3. nlq 查詢句改寫

舊句子點名了已不存在的章名，或依賴一個拆章後指向不確定的別名，所以改寫。改寫後的 `semantic_text` 取自 `utils/nlqHeuristics.js` 在新白名單下的輸出（golden 的回歸線，第 8.4 條）。

| 題號 | 舊查詢 | 新查詢 | 舊章 | 新章 | 理由 |
|---|---|---|---|---|---|
| nlq-003 | 三角函數的定義 | 廣義角與極坐標 | 三角函數的定義 | 廣義角與極坐標 | 舊章名已不存在；relevant 改為該章 5 題（#27～#31） |
| nlq-015 | 三角函數的定義難度 1 | 直角三角形的邊角關係難度 1 | 三角函數的定義 | 直角三角形的邊角關係 | 舊章名已不存在。原句篩出的 #25、#26 改標到直角三角形的邊角關係，改指該章以保留同一組 relevant（#25、#26；#61 難度 2 不在內）。若改成「廣義角與極坐標難度 1」會篩不出任何題（#27～#31 難度都 ≥ 2，relevant 不得為空） |
| nlq-021 | 指數與對數的填空題，小美沒做過 | 指數函數與對數函數的填空題，小美沒做過 | 指數與對數 | 指數函數與對數函數 | 該章唯一的填空題 #7 已改標，原句篩不出任何題（relevant 不得為空） |
| nlq-024 | 三角函數的定義的填空題，小美沒寫過 | 廣義角與極坐標的填空題，小美沒寫過 | 三角函數的定義 | 廣義角與極坐標 | 舊章名已不存在；relevant 不變（#27、#28） |
| nlq-028 | 對數的填空題 | 內積公式的填空題 | 指數與對數 | 向量內積 | 別名「對數」拆章後要指哪一章由 CH-A 的別名表決定；而且它是新章名與可能的新別名「對數函數」的子字串，第 6.2 條第 ③ 項可能迫使它改指或刪除，golden 無法預先確定。無論指哪一章，填空題都只剩 #7 或一題都沒有。改用章名沒受重整影響的別名「內積公式」，保留「口語別名＋題型」這一類；relevant #13、#14 |
| nlq-047 | 對數那邊小美一直卡住，來幾題填空 | 向量投影那邊小美一直卡住，來幾題填空 | 指數與對數 | 向量內積 | 理由同 nlq-028；保留「模糊句＋學生卡住＋題型」的句型；relevant #13、#14 |
| nlq-048 | 隨便給我幾題三角函數 | 隨便給我幾題廣義角與極坐標 | 三角函數的定義 | 廣義角與極坐標 | 別名「三角函數」原本指向已不存在的章；新章「三角函數的圖形」「三角函數的疊合」都含這四個字，CH-A 會怎麼改指無法預先確定；relevant 改為該章 5 題（#27～#31） |

## 4. 只調整 relevant 的 nlq 句子

查詢句與期望章節都不變，只因為 fixture 改標，篩出來的題變了。rules 路徑的 relevant 依定義是「expect 四欄對 fixture 篩出來的題」，單元測試逐句核對。

| 題號 | 查詢 | 舊 relevant | 新 relevant |
|---|---|---|---|
| nlq-002 | 指數與對數 | 1–8 | 5, 6, 8 |
| nlq-010 | 指數與對數難度 2 以下 | 1, 2, 3, 4, 8 | 8 |

## 5. 檢視後維持原章（拆分章的題）

| 檔案 | 題號 | 章 | 理由 |
|---|---|---|---|
| questions.public.json | 5 | 指數與對數 | 已知 log2≈0.3010 估計 2^50 的位數：常用對數（第一冊） |
| questions.public.json | 6 | 指數與對數 | 同 #5，換數字 |
| questions.public.json | 8 | 指數與對數 | 由 log2 推 log5：常用對數的運算 |
| classify.json | cls-fx-005、cls-fx-006、cls-fx-008 | 指數與對數 | 與 fixture 一致 |
| classify.json | cls-dr-003 | 指數與對數 | 改寫自 #5，位數估計 |
| classify.json | cls-dr-021 | 指數與對數 | log3≈0.4771 求 3^20 的首數與位數：常用對數。decoy「首數與尾數」不變 |
| variant.json | var-003 | 指數與對數 | 藍本 #5 |
| pdf_sample | 8 | 指數與對數 | 樣卷第 8 題＝fixture #8 |

## 6. 最沒把握、請 Owner 抽查

1. **一般底數的對數（#1、#2、#7，cls-dr-001、cls-dr-020）**：如果 Ben 的龍騰第一冊已經教一般底數的對數律與換底公式，這幾題應該改回「指數與對數」。
2. **指數方程式（#3、#4，cls-dr-002）**：高一用指數律就解得出來。如果龍騰第一冊有這類題，改回「指數與對數」。
3. **平方關係（#25、#26，cls-dr-008、var-013、樣卷第 4 題）——已依題意改歸「直角三角形的邊角關係」**：
   初版歸「廣義角與極坐標」，理由之一是 fixture 的結構規則 D-E1（有換數字配對的章至少要有一題同章干擾題），不是純粹依題意。
   審查指出這違反第 3.2 條第 1 點「每一題照題意改標」：40°、25° 都是銳角，這是 108 第二冊 3-1 平方關係的典型例題。
   現已改標，並新增自製干擾題 #61 讓 D-E1 成立（第 2.1 節）。**請 Owner 核對 #61 的題目與答案。**
4. **nlq-032（別名「象限角」）**：golden 期望它指向「廣義角與極坐標」，relevant 是 #29、#31。別名表由 CH-A 改，整合時要核對兩邊一致（第 7 項）。
5. **nlq-041（走 LLM 的句子）**：假設 CH-A 沒有把「三角比」「終邊」加成別名。如果加了，這一句會改走規則路徑，expect_path 要改成 rules。
6. **retrieval 的 R017、R018**：hard_negatives 仍是 #29、#30（改標後已不同章，但仍是負樣本）。要不要改列或加列新章的干擾題 #61，請 Owner 決定；本分支不動已定案的檢索 golden（第 1 節）。
7. **CH-A 別名表核對清單（整合時）**：兩個被拆分舊章的別名，要與本檔的標註一致。

   | 別名 | 目前指向 | eval 標註期望 | 說明 |
   |---|---|---|---|
   | 象限角 | 三角函數的定義 | 廣義角與極坐標 | nlq-032 直接用到 |
   | 同界角 | 三角函數的定義 | 廣義角與極坐標 | #29 的內容；nlq golden 沒用到 |
   | 弧度量 | 三角函數的定義 | 三角函數的圖形 | 第 0 節：弧度在第三冊；golden 沒用到 |
   | 三角函數 | 三角函數的定義 | （CH-A 決定） | 是兩個新章名的子字串；nlq-048 已改寫避開 |
   | 指數方程式 | 指數與對數 | 指數函數與對數函數 | #3、#4、cls-dr-002 都標在指數函數與對數函數；CH-A 不改指的話，規則路徑與 eval 標註會不一致 |
   | 對數運算、log | 指數與對數 | （CH-A 決定） | 兩章都有：常用對數在指數與對數，一般底數在指數函數與對數函數；nlq golden 刻意不用 |
   | 對數 | 指數與對數 | （CH-A 決定） | 是新章名與可能新別名的子字串；nlq-028、nlq-047 已改寫避開 |
   | 指數律 | 指數與對數 | 指數與對數 | 第一冊；不受拆分影響 |

## 7. 對 eval 與 CI 的影響（Owner 重錄前）

- **向量**：embed_text 第一行含章名。改標的 12 題（#1–4、#7、#25–31）與新增的 #61，共 13 題在 `eval/fixtures/embeddings.gemini-embedding-001.768.json` 裡查不到；
  nlq 改寫後的查詢句有 6 段 semantic_text 查不到（廣義角與極坐標、隨便 廣義角與極坐標、直角三角形的邊角關係、指數函數與對數函數、內積公式、向量投影 邊小美一直卡住）。
  `npm run cassettes:rerecord` 的第 1 步（`eval/record_embeddings.js --only-missing`）與第 3 步（nlq）會補錄。
- **cassette**：`config/chapters.js` 換成新清單後（CH-A），classify、extract、nlq、variant 的 schemaHash 會變，這些 cassette 全部讀不到。lint 與 verify 的鍵不含章名，仍然有效。
  `eval/lib/cassetteAudit.js` 的靜態稽核會算出失效的數量。
- **單元與整合測試**：用到這兩類錄好的資料的測試，在資料不齊時會 skip，並指名缺什麼（`test/unit/lib/recordedData.js`）。
  另外有一則測試專門確認 suite 是以「查不到」停下，沒有用假資料湊數字。重錄後這些測試會自動恢復執行。
  缺資料本身由 e2e 與五個 eval 以 replay miss 擋住，不會因為單元測試 skip 而被放過。
- 重錄步驟見 `docs/chapter-restructure.md` 第 5 條與 `eval/README.md` 第 3f 節。

### 7.1 CH-A 合入後、Owner 重錄前的預期紅燈（全部是 replay miss）

2026-09-25 在 CH-B 分支以 `test/fixtures/planChapters.preload.js` 模擬 CH-A 合入後的 `config/chapters.js`，
跑一遍完整 CI（unit、check:html、migrate、integration、e2e、五個 eval），結果如下（審查修正、新增 #61 之後重跑）。這份清單就是 Owner 重錄後應該恢復綠燈的範圍。

| CI 步驟 | 失敗 | 原因 |
|---|---|---|
| e2e | `pipeline.e2e.test.js` 的 3 則（runner 把 job 跑完、部分入庫、needs_review） | extract 的 cassette 查不到（schemaHash 變了），job 以「拆題連續失敗：LLM_MODE=replay 找不到 cassette（agent=extract …）」結束。`paperWord.e2e.test.js` 不受影響 |
| eval:retrieval | 13 題查不到向量 | fixture #1–4、#7、#25–31 改標後 embed_text 變了；#61 是新題 |
| eval:classify | 91 筆 replay miss | classify 的 schemaHash 變了（含新增的 cls-fx-061） |
| eval:pipeline | 1 筆 replay miss | extract 查不到，下游節點被擋 |
| eval:nlq | 8 筆 replay miss | nlq 的 schemaHash 變了（expect_path=llm 的 8 句）；recall10 另因向量不齊印 n/a（警告，不算失敗） |
| eval:variant | 13 題查不到向量 | 同 retrieval，在生成前就停下 |

`npm run cassettes:rerecord -- --dry-run` 在同一個模擬狀態下的估計：錄製時 LLM 呼叫 100～214 次、費用約 $0.74～$2.80（未含向量）；
向量缺 19 段（fixture 13 題、nlq 查詢句 6 段）。範圍內 213 支 cassette 中，鍵失效的有 159 支（classify 90、extract 1、nlq 8、variant 60），
lint 1 支與 verify 53 支的鍵仍然有效。cls-fx-061 是新題，repo 裡本來就沒有它的 cassette，所以 classify 的 miss 是 91、失效的舊檔仍是 90。

同一個模擬狀態下，unit 另有 17 則、integration 另有 6 則紅燈，**不是 replay miss**，也與本分支的素材無關：
preload 只換了 `config/chapters.js`，沒有換 CH-A 要改的別名表、例句、schema／prompt 相關的既有斷言（unit 那 17 則），
也沒有換 CH-C 的數學種子檔（integration 那 6 則都在「階段 5 跨 WS」一支，第一則載入三份種子檔就因舊章名失敗）。
改標前（本分支前一個 commit）在同一個模擬狀態下是同樣這 17＋6 則，逐則比對過。

### 7.2 資料不齊時改成 skip 或改驗「以 miss 停下」的測試（〔章節重整 CH-B〕）

重錄後會自動恢復執行，不必再改測試：

- `test/unit/cassetteReplay.test.js`：classify 組改成「現行 schema 下 fixture #9 的 cassette 不在就 skip」，與 extract 組的既有做法相同。extract 組照舊。
- `test/unit/evalVariant.test.js`：`runVariantSuite` 那一組在向量不齊時 skip，並指名缺哪幾題。
  另外新增一則，確認 suite 是以「查不到向量」拒絕執行。`retrieveInMemory` 四則只餵有向量的題，向量齊全時與原本逐字相同。
- `test/unit/evalStage3.test.js`：variant 缺向量時，確認它以「查不到向量」停下。nlq 的 llm 欄是 null 時，只接受「全部都是 replay miss」這一種理由。
- `test/integration/retrievalEval.test.js`：向量檔在、但有題查不到時，與「未錄製」同樣 skip 並指名缺哪幾題。
