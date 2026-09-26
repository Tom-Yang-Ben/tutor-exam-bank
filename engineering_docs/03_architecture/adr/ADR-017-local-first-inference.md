# ADR-017: 本機優先推論 (Local-first Inference) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-25 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 提議（Owner 2026-09-25 於對話中提出目標與選項；實作於 `local/base` 的 L1～L4，待 Owner 以本機模型實測後定案）
> 〔修訂 2026-09-26 決策單 B2〕Owner 2026-09-25 決策單：ADR-014、ADR-015 接受，**本 ADR 維持「提議」，等本機實測後再定**——CPU 上的速度、交叉驗證造成的複核比例、本機模型重錄後的 eval 分數都還沒有實測數字（`docs/local-mode.md` 第 10.5 條、LM-12）。同一張決策單另定：重錄後低於門檻時門檻數字不動、讓它紅燈（A7，LM-14）；本機拆題限制（B18）與本機家教（B19）都等實測後再看。
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「為何把預設的 LLM 與 embedding 從 Gemini 改成 Owner 電腦上的 Ollama＋PaddleOCR、為何拆題改成兩條路徑交叉驗證、為何 Gemini 保留為可切回的選項、CI 如何在不裝任何模型的前提下繼續運作」；凍結介面、工作分配與使用說明歸 [`docs/local-mode.md`](../../../docs/local-mode.md)。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: 系統的拆題、分類、公式 lint、驗算、出變式、找相似題向量、自然語言查題、AI 家教與語音全部呼叫 Gemini（`services/llm` 是唯一轉接點，[ADR-003](./ADR-003-code-orchestrated-agent-pipeline.md)）。章節重整後的第一次重錄因預付額度用完而中斷（`docs/HANDOFF.md` §0.0，CR-7），Owner 因此提出：「最好是能讓這專案所有步驟、功能都純地端而不用連出去以及不產生額外費用」。
- **問題**: 在 Owner 唯一的一台電腦（Intel Core i5-8265U、無獨立顯卡、16 GB RAM、Windows）上，要怎麼讓每一個功能都能在不連外、零費用的前提下運作，同時不把既有的 Gemini 路徑、CI 的確定性與品質閘門弄壞？
- **驅動因素/約束**:
  - 硬體：只能用 CPU 推論，一次只放得下一個 8B 級的模型；速度是每秒幾個 token。
  - 資料：題目與學生資料留在本機本來就是 DEC-009 的前提；本機推論把「僅 LLM 呼叫對外」這個例外也收掉。
  - CI 必須維持零金鑰、零網路、確定性回放（[ADR-006](./ADR-006-cassette-record-replay.md)）；GitHub 的 runner 不可能跑 8B 模型。
  - Owner 的選擇（對話中）：記憶體 16 GB；PDF 拆題用 PaddleOCR 與視覺模型交叉驗證；語音先關掉；Gemini 保留、預設本機。
  - 既有的 Gemini 路徑必須逐位元不變（送出的 prompt、schema、cassette 鍵），既有測試不得放寬。

## 2. 考量的選項

### 選項一: 維持 Gemini，只控制花費（降級模型、限額、快取）
- **描述**: 繼續用雲端，改用更便宜的模型並收緊每日預算。
- **優點**: 零改動；品質與速度最好。
- **缺點**: 不符合 Owner 的目標（仍連外、仍花錢）；額度用完就整條管線停擺（CR-7 實際發生過）。
- **成本/複雜度**: 低

### 選項二: 其他免費雲端額度或自架遠端 GPU
- **描述**: 換到有免費額度的其他雲端 API，或租用／借用遠端 GPU 跑開源模型。
- **優點**: 速度接近雲端。
- **缺點**: 仍然連外；免費額度會變、會用完；遠端主機另有成本與維運。不符合「純地端」。
- **成本/複雜度**: 中

### 選項三: 本機 Ollama＋PaddleOCR 為預設，Gemini 保留為可切回的供應商（採用）
- **描述**: `services/llm` 新增 `ollama` 供應商（`MODEL_*`、`EMBED_MODEL` 以 `vendor:` 前綴選擇），預設 `ollama:qwen3-vl:8b`（拆題、分類、lint）、`ollama:qwen3:8b`（驗算、出變式、OCR 結果整理）、`ollama:qwen3-embedding:0.6b`（768 維）。PDF 拆題改成兩條本機路徑：PaddleOCR（版面＋文字＋公式轉 LaTeX）與視覺模型各拆一次、逐題對齊比對，不一致的題停在人工複核。語音在非 Gemini 模式下不掛載；家教忽略 code execution。前端的 MathJax、gsap、字型改由本機提供。CI 照舊只讀 cassette 與向量檔，模型名改成本機的，由 Owner 在自己的電腦上以本機模型重錄。
- **優點**: 執行期零外連、零費用；額度不再是單點故障；Gemini 路徑的程式與 cassette 鍵不變，改 `.env` 幾行即可切回；CI 的機制（record／replay、fixture、門檻 ratchet）一個字都不用改。
- **缺點**: CPU 上非常慢（一份考卷數小時）；8B 模型品質低於 Gemini，eval 的量測值預期下降；多一套 Python 環境（PaddleOCR）要安裝與維護；語音與家教的程式驗算暫時沒有。
- **成本/複雜度**: 高（四條平行工作）

## 3. 決策

**選擇**: 選項三——本機優先、Gemini 保留。

**理由**:
- 只有選項三同時滿足「不連外」與「不花錢」；速度與品質的代價在 Owner 提出目標時已經知道，而且可以用「晚上處理、隔天複核」的使用方式吸收。
- **仍然只有一個轉接點**：所有呼叫照舊經過 `services/llm` 的 `generateJson`／`generateText`／`embed`，新增供應商而不是在 agent 裡直接打 HTTP；Gemini 分支逐位元不變，所以切回 Gemini 只是改 `.env`，不是回滾程式。
- **交叉驗證是對模型變弱的補償**：本機視覺模型單獨拆題的抄錯率預期明顯高於 Gemini。兩條獨立的路徑（OCR 看字元、視覺模型看版面）同時抄錯同一個地方的機率低；不一致就交給人，保住「錯的題不自動入庫」這條品質底線（[ADR-005](./ADR-005-server-side-whitelist-validation.md)、[ADR-009](./ADR-009-deterministic-source-text-check.md) 的延伸）。
- **CI 不跟著本機化**：CI 的價值是確定性，而 cassette 本來就把「模型的回答」凍結成檔案；把模型名換成本機的、由 Owner 重錄，CI 就繼續是零金鑰、零網路，不必在 runner 上裝 Ollama 或 Python。新增的本機 OCR 也走同一套 record／replay（agent＝`ocr`），CI 不需要 Python。
- **慢是預期的**：逾時、租約與併發的預設值依供應商調整（拆題模型是 `ollama` 時一塊 2 頁、節點逾時 45 分、`OLLAMA_CONCURRENCY=1`），長節點靠租約續租而不是把租約拉長；錄製工具在錄之前印出「預估時間」取代「預估費用」，並先檢查 Ollama、模型與 OCR 都就緒，免得跑了幾個小時才失敗。

## 4. 後果

- **正面**: 執行期零外連、零費用；額度用完不再讓管線停擺；題目與學生資料完全不離開本機；Gemini 仍可在 `.env` 改五行切回，也可以只把單一節點切回；Windows 上有雙擊即可的安裝與重錄腳本（`exam_pro\scripts\windows\setup_local_ai.bat`、`record_local.bat`），輸出寫 log。
- **負面**: 一份考卷從上傳到處理完要數小時；複核佇列變長（交叉驗證不一致的題一律停下）；五個 eval 以本機模型重錄後很可能低於用 Gemini 建立的門檻，門檻不自動放寬、由 Owner 另行裁決（多半是依本機模型重建基準）；在 Owner 重錄之前，CI 的 e2e 與五個 eval 會因缺 cassette／缺向量而紅燈（契約第 8 條的預期）；換 embedding 模型後正式庫要跑一次 `embed:backfill` 全部題目與 `search:reindex`；語音關閉、家教不做程式驗算；自然語言查題的 LLM 輔路徑在預設 4 秒逾時下實際上用不到；要另外維護一個 Python 虛擬環境（PaddleOCR 版本固定在 `ocr_service/requirements.txt`）。
- **影響範圍**: `exam_pro/services/llm/**`（新 `ollama.js`）、`config/models.js`、`config/pricing.js`、`services/ocr/**`、`ocr_service/**`、`agents/extract.js`、`agents/extractCrossCheck.js`、`workers/jobRunner.js`、`public/**`（離線化）、`eval/**`（重錄檢查、時間粗估、新 cassette 目錄）、`.github/workflows/ci.yml`、`.env.example`、`scripts/windows/*.bat`；分工見 `docs/local-mode.md` 第 3～6 條。
- **重新評估觸發**: Owner 實測後速度或品質無法接受（例如一份考卷超過一夜、複核比例高到失去自動化的意義）；Owner 換了有 GPU 的電腦（可改用更大的模型，CI 的模型名跟著換、重錄）；Ollama 或 PaddleOCR 的授權、維護狀態改變；有更小而品質相當的本機模型可用。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | Owner 2026-09-25 對話（目標：全部步驟與功能純地端、不連外、零費用；選項：16 GB、PaddleOCR＋視覺模型交叉驗證、語音先關、Gemini 保留且預設本機）；`docs/local-mode.md` 第 0 條 |
| 影響範圍 | `docs/local-mode.md`（凍結契約與使用說明）、`.github/workflows/ci.yml`（CI 的模型名）、`eval/thresholds.json`（門檻數字不動，本機重錄後由 Owner 裁決） |
| 取代關係 | 無；延續 [ADR-003](./ADR-003-code-orchestrated-agent-pipeline.md)（單一轉接點、程式碼編排）、[ADR-006](./ADR-006-cassette-record-replay.md)（record／replay 機制與鍵公式不變，只換模型名並重錄）、[ADR-005](./ADR-005-server-side-whitelist-validation.md)（伺服器端閘門仍是最終把關）、[ADR-013](./ADR-013-push-to-talk-teacher-confirm.md)（語音在本機模式下關閉）、[ADR-012](./ADR-012-tutor-code-execution-spoken-text.md)（本機模式下家教不做程式驗算） |
