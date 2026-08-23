# 階段 3 第一輪裁決通知（2026-08-23）— 貼給各 WS 的 Claude

> 四條已全部合進 main（`b64f149`，單元 1386/1388、整合 253/253）。裁決 S3-R1～R27 寫在 `docs/interfaces-stage3.md` §15（優先於對應條文）；`.env.example` 的 `VARIANT_SIM_MIN` 已拆成兩個。
> 每條先 `git merge main && cd exam_pro && npm ci`。`interfaces*.md` 仍不得自行修改。nlq／variant 的 cassette 由開發者在 main 統一錄（S3-R20），WS 不用錄。

## 給 WS-A

```
docs/interfaces-stage3.md 新增 §15（裁決 S3-R1～R27），請 git merge main 後做：
1. S3-R25：app.js 的 serveIndex 多一個 replaceAll：__FEATURE_SIMILAR__ → process.env.FEATURE_SIMILAR || 'false'（與另外三個同一行處理）；單測補一項。
2. S3-R1～R6 全部接受你的解讀，不用改程式；questions3-wsA.md 每條加「裁決：S3-Rn」後結案。
3. S3-R7：README 由 WS-D 標註，你不用動。
```

## 給 WS-B

```
docs/interfaces-stage3.md 新增 §15（裁決 S3-R8～R16 是回你的），請 git merge main 後做：
1. S3-R8：utils/variantTextGate.js 規則 2 改為「數字遮罩後文字相同 → numbers_only」（拿掉多重集合相同的 AND）；更新 18 項單測與「已知缺口」那一項（改成正向斷言）；重跑 --suite variant 看 gate_pass_rate 變化，寫進 docs/variants.md。
2. S3-R9：讀兩個新變數 VARIANT_RETRIEVE_SIM_MIN（services/variantService.js 的 retrieved 分支）與 VARIANT_OFFTOPIC_SIM_MIN（agents/generateVariant.js 的跑題閾值，經 ctx.config.thresholds.variantOfftopicSimMin；runner 的 loadStage3Config 組 variantRetrieveSimMin／variantOfftopicSimMin 兩個鍵），兩者都沒設時退回 VARIANT_SIM_MIN；docs/variants.md 第 3 節對應改。
3. S3-R10：controllers/reviewController.js 的 variantChapterSrc：章節未改且 payload.classify.source='knn' → 'knn'（其餘不變）；單測對應改。
4. S3-R11～R16 接受現況，不用改程式。
5. questions3-wsB.md 每條加「裁決：S3-Rn」後結案。
```

## 給 WS-C

```
docs/interfaces-stage3.md 新增 §15（裁決 S3-R17～R22 是回你的）：全部採納你現在的做法（semantic_text 以範例為準、question_types 走 excludeIds、句內學生名優先、6.4 先反推 subject、keywords 含題型、level 3 逐段 ILIKE + 先丟 ILIKE 再丟章節），請 git merge main 後只做：
1. utils/nlqHeuristics.js 檔頭把 S3-R17 的定義寫成依據（你在 Q1 說的那一句）。
2. questions3-wsC.md 每條加「裁決：S3-Rn」後結案。cassette 由開發者錄（S3-R20），你不用動。
```

## 給 WS-D

```
docs/interfaces-stage3.md 新增 §15（裁決 S3-R23～R27 是回你的），請 git merge main 後做：
1. S3-R27：test/unit 裡 eval/run.js 的兩個「替身回全部 n/a」「anyStub 擋 --write-baseline」測試，改成真 suite 已接上時的斷言（suiteNlq／suiteVariant 都在 main 了）；跑 npm test 全綠。
2. S3-R24：variants.js 的「出變式」加兩個下拉：數量 1~3（預設 1）、難度 −1／0／+1（預設 0）；送出的 body 用選到的值。
3. S3-R25：index.html 加 <meta name="feature-similar" content="__FEATURE_SIMILAR__">（WS-A 會在 app.js 補 replaceAll）；students.js 的「找相似」按鈕由 feature-similar 控制、「出變式」由 feature-variants 控制；check_html.js 的 STAGE3 檢查加這個 meta。
4. S3-R23／R26 接受現況；README「問題→決策→數字」表的 hybrid 列之外，補一句本機整合測試指令（S3-R7）。
5. questions3-wsD.md 每條加「裁決：S3-Rn」後結案。
```

## 合併後的錄製（開發者本人）

1. A／B／C／D 小修合入 → 2. 在 main 以 `LLM_MODE=record EMBED_MODE=record` 跑 `--suite nlq` 與 `--suite variant`（variant 30 藍本 × 2 生成 + 管線 verify，用 Pro，估約 2–3 美元）→ 3. replay 驗證、commit cassette 與新增的 embedding fixture → 4. CI 五個 suite 綠 → 5. 人工定案 nlq 50 句與 variant 30 藍本後 `--write-baseline`。
