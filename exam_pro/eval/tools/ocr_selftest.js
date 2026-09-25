// ─────────────────────────────────────────────────────────────
// eval/tools/ocr_selftest.js — npm run ocr:selftest（本機模式，docs/local-mode.md 第 4 條第 1 點、第 6 條）
//
// 跑一次 `<OCR_PYTHON> ocr_service/ocr_pdf.py --selftest`，確認 PaddleOCR 的套件與模型都已就緒
// （執行期不下載任何東西；模型在安裝時由 setup_local_ai.bat 呼叫 --warmup 下載）。
// Python 的路徑讀 .env 的 OCR_PYTHON；沒設時是 ocr_service/.venv 裡的那一支
// （Windows：ocr_service\.venv\Scripts\python.exe；其他：ocr_service/.venv/bin/python）。
//
// 與 npm run cassettes:rerecord 的錄前檢查是同一支函式（eval/lib/localMode.js 的 checkOcr）。
// 結束碼：0＝通過；1＝沒過（原因與處置印在 stderr）。
// ─────────────────────────────────────────────────────────────

const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(APP_DIR, '.env'), quiet: true });

const local = require('../lib/localMode');

/**
 * @param {{checkOcr?:Function, env?:object}} [io] 測試注入點
 * @returns {Promise<number>} 結束碼
 */
async function main(io = {}) {
    const checkOcr = io.checkOcr || local.checkOcr;
    const env = io.env || process.env;
    const python = local.ocrPython(env);
    console.log(`OCR 自我檢查：${python} ocr_service/ocr_pdf.py --selftest`);
    const r = await checkOcr({ python });
    if (!r.ok) {
        console.error(`❌ ${r.error}`);
        for (const line of r.detail || []) console.error(`   │ ${line}`);
        for (const line of local.ocrAdvice(python)) console.error(`   ${line}`);
        return 1;
    }
    console.log(`✅ PaddleOCR 已就緒（${r.engineVersion || '版本不明'}）`);
    return 0;
}

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    });
}

module.exports = { main };
