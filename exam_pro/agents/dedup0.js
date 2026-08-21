// agents/dedup0.js — L0 去重（題幹雜湊），在任何 LLM 呼叫之前
//
// 狀態機的 NODE_FOR_STATE 給的節點名是 dedup0，而 §10.1 的所有權表只給 WS-C
// 一支 agents/dedup.js；這支三行的轉接檔讓 runner 的 require('../agents/' + node) 直接可用。
// 邏輯全部在 agents/dedup.js，這裡不得有第二份實作。

const { runDedup0 } = require('./dedup');

module.exports = { run: runDedup0 };
