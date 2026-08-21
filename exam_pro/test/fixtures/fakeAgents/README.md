# test/fixtures/fakeAgents — 給 jobRunner 用的假 agent（擁有者：WS-A）

WS-B 的 `agents/extract.js`／`classify.js` 與 WS-C 的 `lint.js`／`verify.js`／`dedup.js`
合入之前，runner 的行為（認領、租約、預算、退避、事件、部分入庫）就要能被測。
這裡的每一支都符合 `docs/interfaces-stage2.md` 第 3.1 條的 agent 合約
（`module.exports = { run }`、`run(ctx, input) → Promise<outcome>`、不 throw），
但**完全不呼叫 LLM**：回什麼由 `ctx.jq.payload.extract.__fake` 這個測試專用的指令欄位決定。

指令格式（由整合測試在建 `job_questions` 時塞進 payload）：

```jsonc
"__fake": {
  "dedup0":   { "kind": "pass" },
  "classify": { "kind": "fail", "reason": "chapter_invalid", "times": 3 },
  "verify":   { "kind": "error", "errorClass": "rate_limited" },
  "lint":     { "kind": "spendThenPass", "tokenIn": 100000 }
}
```

- 沒有指令的節點一律 `pass`，並寫進該節點在第 3.2 條裡的必要欄位。
- `times`：前 N 次照指令回，之後改回 `pass`（測「重試幾次後成功」）。
- `spendThenPass`：先呼叫 `ctx.llm.generateJson()`（走 fake adapter）製造用量與成本，
  再回 `pass`——這是預算超線那組案例的來源。

`agents/` 的真檔案合入後，整合測試只要把 `agentsDir` 指回 `agents/` 就能跑同一組案例；
這個資料夾**不會**被 `npm test` 當成測試檔（檔名不含 `.test.js`）。
