// services/ocr/cli.js — 給安裝腳本與 npm script 用的跨平台入口（〔本機模式 L2〕docs/local-mode.md 第 4、6 條）
//
//   node services/ocr/cli.js selftest   不連網確認 PaddleOCR 與模型都已就緒（結束碼 0＝可用）
//   node services/ocr/cli.js warmup     下載模型並試跑一次（安裝時用，需要網路；下載進度直接印出來）
//
// Python 的路徑依 .env 的 OCR_PYTHON（沒設＝Windows：ocr_service\.venv\Scripts\python.exe、其他：ocr_service/.venv/bin/python），
// 所以 .bat 與 package.json 不必各自拼 Windows／POSIX 兩種路徑。L4 可以加：
//   "ocr:selftest": "node services/ocr/cli.js selftest"、"ocr:warmup": "node services/ocr/cli.js warmup"

const path = require('path');

const ocr = require('./index');

async function main(argv) {
    const cmd = String(argv[0] || '').trim();
    if (cmd !== 'selftest' && cmd !== 'warmup') {
        console.error('用法：node services/ocr/cli.js selftest｜warmup');
        return 2;
    }
    const cfg = ocr.resolveOcrConfig();
    console.log(`[ocr] Python：${cfg.python}`);
    console.log(`[ocr] 腳本：${cfg.script}`);
    const r = cmd === 'selftest'
        ? await ocr.selftest()
        : await ocr.warmup({ onStderr: (t) => process.stderr.write(t) });
    if (r.ok) {
        console.log(`[ocr] ${cmd} 通過（PaddleOCR ${r.engineVersion}）。`);
        return 0;
    }
    console.error(`[ocr] ${cmd} 失敗：${r.message}`);
    return 1;
}

if (require.main === module) {
    // 只有直接執行時才讀 .env（被 require 時——例如單元測試——不碰使用者的設定）
    try {
        require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
    } catch (_) { /* 沒有 dotenv 或沒有 .env：照環境變數跑 */ }
    main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { main };
