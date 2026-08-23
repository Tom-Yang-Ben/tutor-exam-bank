// agents/generate.js — 變式生成節點的轉接檔（docs/interfaces-stage3.md 第 4.1／4.2 條）
//
// 第 4.1 條的節點名是 `generate`（job_events.node 的新增值），而第 10.1 條的所有權表
// 給 WS-B 的檔名是 `agents/generateVariant.js`。這支三行的轉接檔讓 runner 的
// loadAgent 走**第一順位**（`agents/<node>.js`）就找得到它，
// `AGENT_MODULE_FOR_NODE` 因此一個字都不必動——與 `agents/dedup0.js`／`dedup1.js` 同一個做法
// （裁決 S2-6）。邏輯全部在 agents/generateVariant.js，這裡不得有第二份實作。

const { run } = require('./generateVariant');

module.exports = { run };
