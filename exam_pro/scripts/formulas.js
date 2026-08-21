// ─────────────────────────────────────────────────────────────
// scripts/formulas.js — 三支公式維運 .bat 的統一入口（E-X13b 的殼，規劃 §5.3.7）
//
// 用法：
//   node scripts/formulas.js audit     題庫公式健檢    → 公式健檢報告.html
//   node scripts/formulas.js preview   公式修正預覽    → 公式修正預覽.html（不寫入資料庫）
//   node scripts/formulas.js apply     套用公式修正    （先備份、再以交易寫入）
//
// **目前這支只是外殼**：實際工作仍然轉交給既有的 audit_formulas.js / fix_formulas.js，
// 行為與舊的三支 .bat 完全相同（含「先預覽再套用」與 --apply 前自動備份）。
//
// 為什麼先做殼：
//   規劃 §5.3.7 要把三支 .bat 換成 `node scripts/formulas.js`，內容則要改成
//   走 `pg` + WS-C 的 `parseLatexStrict` 事件計數。但那兩件事分別卡在
//   WS-A 的 D-D3（controller 與維運腳本改 pg）與 WS-C 的 `utils/textFormatter.js`
//   新增匯出上。先把入口與 .bat 換掉，等那兩邊就緒後只要改這一支的內容，
//   使用者雙擊的檔案與流程都不必再動一次。
//
// 遷移期間的注意事項：
//   audit_formulas.js 與 fix_formulas.js 目前仍連**舊的 MySQL**（各自 mysql.createConnection）。
//   切換之夜之後它們要由 WS-A 改成走 config/db.js（PostgreSQL）；在那之前，
//   這兩支讀到的是舊題庫，不是切換後的新資料。
// ─────────────────────────────────────────────────────────────

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const EXAM_PRO = path.resolve(__dirname, '..');

const MODES = {
    audit: { script: 'audit_formulas.js', args: [], desc: '題庫公式健檢（唯讀）' },
    preview: { script: 'fix_formulas.js', args: [], desc: '公式修正預覽（唯讀）' },
    apply: { script: 'fix_formulas.js', args: ['--apply'], desc: '套用公式修正（先備份再以交易寫入）' }
};

function main() {
    const mode = (process.argv[2] || '').toLowerCase();
    const target = MODES[mode];
    if (!target) {
        console.error('用法：node scripts/formulas.js <audit|preview|apply>');
        for (const [k, v] of Object.entries(MODES)) console.error(`   ${k.padEnd(8)} ${v.desc}`);
        process.exit(2);
    }

    const script = path.join(EXAM_PRO, target.script);
    if (!fs.existsSync(script)) {
        console.error(`❌ 找不到 ${target.script}（它屬於 WS-A，可能已改名或搬走）。`);
        process.exit(1);
    }

    console.log(`▶ ${target.desc}`);
    const extra = process.argv.slice(3).filter(a => a !== '--apply');   // apply 只能由 mode 決定
    const r = spawnSync(process.execPath, [script, ...target.args, ...extra], {
        cwd: EXAM_PRO,
        stdio: 'inherit',
        shell: false
    });
    if (r.error) { console.error('❌ 執行失敗：' + r.error.message); process.exit(1); }
    process.exit(r.status === null ? 1 : r.status);
}

main();
