// agents/dedup1.js — L1 去重（向量餘弦），在 verify 之後、入庫之前
//
// 狀態機的 NODE_FOR_STATE 給的節點名是 dedup1，而 §10.1 的所有權表只給 WS-C
// 一支 agents/dedup.js；這支三行的轉接檔讓 runner 的 require('../agents/' + node) 直接可用。
// 邏輯全部在 agents/dedup.js，這裡不得有第二份實作。

const { runDedup1 } = require('./dedup');

module.exports = { run: runDedup1 };
