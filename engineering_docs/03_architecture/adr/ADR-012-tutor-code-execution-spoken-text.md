# ADR-012: AI 家教獨立於助教、以 code execution 驗算、以口語版為講法依據 (Tutor with Code Execution and Spoken-Text Grounding) - 家教專用數理題庫系統

> **版本:** v1.0 | **更新:** 2026-09-24 | **狀態:** 活躍
> **Owner:** Ben（楊本顥） | **決策狀態:** 已接受（實作於 `stage5/ws-e`；需求側 DEC-018 待 Owner 簽核，計算驗證選項 a 由 Owner 2026-09-24 於對話中選定）
> **語域:** L3
> **實例:** 每決策一份（`ADR-NNN-<slug>.md`）
> **定位:** 本文件回答「AI 家教為何另立服務而不擴充助教、數值正確性為何交給 Gemini code execution、講法為何以知識點口語版為依據」；API、脈絡格式與操作說明歸 [`docs/tutor.md`](../../../docs/tutor.md)，介面合約歸 `docs/interfaces-stage5.md` 第 4.5、5.1 條；語音輸入的決策歸 [ADR-013](./ADR-013-push-to-talk-teacher-confirm.md)。

## 目錄

- [1. 背景與問題](#1-背景與問題)
- [2. 考量的選項](#2-考量的選項)
- [3. 決策](#3-決策)
- [4. 後果](#4-後果)
- [5. 追溯](#5-追溯)

## 1. 背景與問題

- **上下文**: DEC-018 要求「問高中數學、物理、化學的問題，AI 給出正確、能直接拿來教學的答覆；講法優先沿用知識點的口語說明；數值與代數結果經程式計算驗證，不只靠模型推理」。既有的對話式助教（[ADR-007](./ADR-007-assistant-no-native-function-calling.md)）是給老師查題庫的主控 agent，系統提示明令「唯一知識來源是工具回傳結果」，不能解題也不能講觀念（缺口 G06）；全案也沒有任何計算工具（缺口 G07，已實測 `answerCompare` 把 `5 cm` 與 `5 m` 判為一致）。
- **問題**: 三件事要一起決定——(1) 家教寫在哪裡；(2) 數值與代數結果怎麼驗算；(3) 怎麼讓 AI 的講法和老師上課的講法一致。
- **驅動因素/約束**:
  - 全案 LLM 呼叫只經 `services/llm`，record/replay、節流、成本估算只寫一份（[ADR-006](./ADR-006-cassette-record-replay.md)）；既有 cassette 一律不得失效（`interfaces-stage5.md` 第 1.1 條）。
  - 不新增 npm 依賴，除非沒有合理替代（第 1.8 條）；本系統是單機、單人、Node.js，沒有 Python 執行環境。
  - 學生姓名不出境（DEC-009）；會花錢的功能預設關、要有限流與成本上限。
  - 知識點的口語版（`knowledge_components.spoken_text`）由 Owner 逐條審定（`status = approved`），審定前是 AI 草稿。

## 2. 考量的選項

### 選項一: 擴充既有助教（在 `assistantService` 加「解題」工具）
- **描述**: 助教主控迴圈多一個 `solve_question` 工具，由另一次 LLM 呼叫產生講解。
- **優點**: 一個入口、一個分頁；沿用 ReAct 迴圈與工具軌跡 UI。
- **缺點**: 助教的核心底線「不得憑模型知識回答」與家教正好相反，兩份系統提示會互相妥協；受限 JSON 的決策迴圈不適合長篇 Markdown 講解；多一層主控呼叫，延遲與費用加倍；改動助教的 SYSTEM 會讓助教的 cassette 失效。
- **成本/複雜度**: 中

### 選項二: 獨立 `tutorService`＋`generateText`＋Gemini 內建 code execution（採用）
- **描述**: 新增自由文字生成 `services/llm.generateText`（可開 `tools: { codeExecution: true }`），家教服務組好脈絡後單次呼叫；模型在生成過程中自行撰寫並執行 Python（含 sympy），SDK 回傳的 `executableCode`／`codeExecutionResult` parts 由伺服器拆成 `codeRuns` 原樣回給前端。
- **優點**: 零新依賴、零自架服務；驗算程式與輸出是供應商實際執行的結果，不是模型「自稱驗算過」；沿用 cassette、節流、成本估算；助教完全不動。
- **缺點**: 綁定 Gemini（換供應商要找等價工具）；**要跑什麼程式由模型決定**——題意理解錯或列錯式子時，程式照樣算出錯的答案；code execution 的中間結果回灌以 input 計價，單次費用較高。
- **成本/複雜度**: 中

### 選項三: 伺服器端自建 SymPy 驗算服務
- **描述**: 另起 Python sidecar（SymPy／ChemPy），模型輸出結構化的「待驗算式子」，伺服器呼叫 sidecar 獨立驗算後再回填。
- **優點**: 驗算與模型解耦、可換供應商；可以做到「伺服器端獨立判定」。
- **缺點**: 單機部署多一個執行環境與程序管理；要設計「模型 → 可驗算式子」的中介格式並處理解析失敗；化學、物理單位的覆蓋要自己寫。對一人維護的系統，這是另一個專案的份量。
- **成本/複雜度**: 高

### 選項四: 不驗算，只靠較強的模型與答案比對
- **描述**: 用推理較強的模型直接解，再以 `utils/answerCompare.js` 與題庫答案比對。
- **優點**: 最簡單。
- **缺點**: 違反 DEC-018「不只靠模型推理」；沒有題目 ID 的自由提問沒有答案可比；`answerCompare` 已知有單位誤判。
- **成本/複雜度**: 低

## 3. 決策

**選擇**: 選項二，並附四項配套決策。

1. **家教是獨立服務**——`services/tutorService.js`、`POST /api/tutor`、「AI 家教」分頁，與助教分屬兩個旗標（`FEATURE_TUTOR`、`FEATURE_ASSISTANT`）。家教的輸出是 Markdown 自由文字，不是受限 JSON：講解本來就是長文，驗算結果則由 SDK 的 parts 結構化提供，不靠模型自己回報。
2. **驗算以「透明」補「不獨立」**——系統提示要求所有數值與代數結果都用 code execution 驗算，並在回覆最後寫「**驗算**：…」；伺服器把每一段程式與輸出原樣回傳（`verification.runs`），前端一律 `textContent` 呈現，沒有執行任何程式的回覆明講「沒有經過程式驗算」。模型選錯式子的風險不由系統消除，而是攤開給老師檢查，並在每則回覆標示「AI 產生，請自行判斷」。
3. **講法以口語版為依據、審定分權**——該題標註的知識點（沒有就同章）的 `spoken_text` 放進 prompt，要求優先沿用；`approved` 排在前面，`draft` 在 prompt 內標明「AI 草擬、老師尚未審定，僅供參考」。題目的標準答案與詳解（`solution_text`，可能為 NULL）一併放入，並要求「與標準答案不一致時明講，不得默默改成一致」。
4. **模板鍵含系統提示、成本有上限**——direct／socratic 各一份模板，註冊字串＝SYSTEM＋`'\n---\n'`＋PROMPT_TEMPLATE（第 1.2 條），系統提示改動即換 cassette 鍵；成本以 `config/pricing.js` 估算、程序內按日累計（`TUTOR_DAILY_BUDGET_USD`，與語音共用），查不到價目的模型以表上最貴單價估，不讓預算閘門失效。

選項一因為兩種服務的底線正好相反而放棄；選項三留待「驗算需要伺服器端獨立判定」（例如要自動批改或寫入題庫）時再評估；選項四不符合 DEC-018。

## 4. 後果

- **正面**: 老師可以直接問題目或觀念並拿到附驗算程式的講解；AI 的講法會往老師審定過的口語版靠攏；助教、拆題管線與全部既有 cassette 一個字都沒動；`generateText` 與音訊／圖片 parts 成為其他功能（例如之後的拍照提問）可以直接用的基礎能力。
- **負面**: 驗算不是獨立驗證——題意理解錯、列錯式子時程式照樣會「驗證」一個錯的答案；單次費用高於純文字生成（預設 MODEL_TUTOR 沿用 Pro 級的 MODEL_VERIFY，估計每次約 US$0.035，未實測）；綁定 Gemini 的 code execution；預算累計在程序內，重啟歸零；家教品質沒有 eval suite，需要真實呼叫才量得到。
- **影響範圍**: `exam_pro/services/tutorService.js`、`exam_pro/services/llm/{index,gemini,fake,cassette}.js`、`exam_pro/config/models.js`（MODEL_TUTOR、MODEL_VOICE、MODEL_KC_TAG）、`exam_pro/controllers/tutorController.js`、`exam_pro/routes/index.js`、`exam_pro/public/js/tutor.js`。
- **重新評估觸發**: 家教 eval（建議指標：驗算覆蓋率、驗算輸出與標準答案一致率、socratic 首輪洩漏最終答案的比例）顯示驗算覆蓋率偏低或錯誤率不可接受；需要換 LLM 供應商；家教要開放給學生端直接使用（屆時「老師把關」這一層不存在，驗算需改成伺服器端獨立判定，即選項三）；或每日預算經常觸頂。

## 5. 追溯

| 項目 | ID |
| :--- | :--- |
| 觸發來源 | DEC-018、DEC-009、DEC-015（口語版）；缺口 G06、G07；`docs/interfaces-stage5.md` 第 4.5、5.1、5.2 條 |
| 影響範圍 | [`docs/tutor.md`](../../../docs/tutor.md)、`docs/interfaces-stage5.md`、`../engineering_tracker.md`（整合階段回填） |
| 取代關係 | 無；與 [ADR-007](./ADR-007-assistant-no-native-function-calling.md) 並存（助教維持「只根據工具結果」，家教另立）；延伸 [ADR-006](./ADR-006-cassette-record-replay.md) 的 record/replay 到自由文字生成 |
