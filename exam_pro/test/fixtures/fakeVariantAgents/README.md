# test/fixtures/fakeVariantAgents（擁有者：WS-B）

test/integration/variants.pg.test.js 專用的 agentsDir。

- generate.js：變式生成節點的假 agent（唯一一支真的實作）。
- 其餘四支只是 require 過去 ../fakeAgents/ 的同名檔——變式 job 與 PDF job 走同一條管線，
  假 agent 也不該有第二份。WS-A 的 test/fixtures/fakeAgents/ 一個字都沒改。
