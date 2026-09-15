# test/fixtures/fakeVariantAgents（擁有者：WS-B）

test/integration/variants.pg.test.js 專用的 agentsDir。

- generate.js：變式生成節點的假 agent（唯一一支真的實作）。
- 其餘四支只是 require 過去 ../fakeAgents/ 的同名檔——變式 job 與 PDF job 走同一條管線，
  假 agent 也不該有第二份。WS-A 的 test/fixtures/fakeAgents/ 一個字都沒改。
- source_check.js（2026-09-15 加）：直接 require 真的 `agents/source_check.js`。變式題沒有原卷片段，
  真 agent 一律回 skipped，與正式環境行為一致（docs/source-check.md）。
