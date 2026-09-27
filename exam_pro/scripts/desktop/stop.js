// ─────────────────────────────────────────────────────────────
// scripts/desktop/stop.js — 桌面「關閉出題系統」圖示執行的程式（docs/desktop-launcher.md 第 4 節）
//
// 捷徑：wscript.exe scripts\desktop\run_hidden.vbs stop <node.exe>。
// 優雅關閉由啟動器開的後端：停止認領新工作 → 等在途的背景工作收尾（有工作時先問 Owner 要不要等）→ 結束。
// Docker 與 Ollama 預設不關（data\launcher\config.json 的 stopDocker／stopOllama 可改）。流程在 lib/stopper.js。
// ─────────────────────────────────────────────────────────────
'use strict';

const { bootstrap, crash } = require('./lib/bootstrap');

async function main() {
    const b = bootstrap('stop');
    const { sys, paths, log, config, configWarnings, env, port } = b;
    const { createUi } = require('./lib/ui');
    const { createProbes } = require('./lib/probes');
    const { runStop } = require('./lib/stopper');

    log(`==== 關閉出題系統（埠 ${port}）====`);
    for (const x of configWarnings) log(`⚠ 設定檔：${x}（改用預設值）`);
    const ui = createUi({ sys, config, statusHtml: '', log });
    const probes = createProbes({ sys, config, env, paths, port });
    const { result } = await runStop({ sys, config, env, paths, probes, ui, log });
    log(`==== 關閉結果：${result} ====`);
    return 0;
}

main().then(code => process.exit(code), err => crash('stop', err));
