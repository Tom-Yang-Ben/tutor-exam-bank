// 轉接到 WS-A 的假 agent（test/fixtures/fakeAgents/），本目錄只多一支 generate.js。
// 不複製一份實作：變式 job 走的就是**完全相同**的六個節點，假 agent 也該是同一份。

module.exports = require('../fakeAgents/verify');
