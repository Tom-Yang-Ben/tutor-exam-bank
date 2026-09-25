// test/fixtures/fakeOcr/fake_ocr_pdf.js — 假的 ocr_service/ocr_pdf.py（〔本機模式 L2〕單元測試用）
//
// 由 Node 執行（測試把 OCR_PYTHON 換成 process.execPath），命令列介面與 ocr_pdf.py 相同：
//   --pdf <檔> --from N --to M --dpi D --out <目錄> ｜ --selftest ｜ --warmup
// 行為由環境變數 FAKE_OCR_MODE 決定，讓 services/ocr 的 spawn、逾時、中止、錯誤處理都能在沒有 Python 的 CI 上測：
//   ok（預設）   每頁寫一張假 PNG、stdout 印一個 JSON
//   noise        JSON 之前先在 stdout 印一行雜訊（測「取最後一行」的退路）
//   exit3        stderr 印訊息、以 3 結束（模型不在）
//   exit5        stderr 印訊息、以 5 結束（辨識失敗）
//   hang         永遠不結束（測逾時與中止）
//   badjson      stdout 印非 JSON
//   missing_page 少回最後一頁
//   version      engine_version 回 9.9.9（與 requirements.txt 不符）
//   outside      image 路徑指到輸出目錄外
// FAKE_OCR_ARGS_FILE 有設時，把收到的 argv 寫進那個檔（測「有沒有照介面傳參數」）。

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (process.env.FAKE_OCR_ARGS_FILE) fs.writeFileSync(process.env.FAKE_OCR_ARGS_FILE, JSON.stringify(argv));

function arg(name) {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
}

const mode = process.env.FAKE_OCR_MODE || 'ok';
// 1x1 的透明 PNG（內容不重要，只要是檔案）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

if (argv.includes('--selftest') || argv.includes('--warmup')) {
    if (argv.includes('--warmup')) process.stderr.write('Downloading PP-DocLayout_plus-L ... 100%\n');
    if (mode === 'exit3') {
        process.stderr.write('[ocr_pdf] 模型不在本機（PP-DocBlockLayout）。\n');
        process.exit(3);
    }
    process.stdout.write(JSON.stringify({ ok: true, engine: 'paddleocr', engine_version: '3.7.0' }) + '\n');
    process.exit(0);
}

if (mode === 'hang') {
    process.stderr.write('假 OCR：卡住\n');
    setInterval(() => { }, 1000);
    return;
}
if (mode === 'exit3') {
    process.stderr.write('[ocr_pdf] 模型不在本機（PP-DocBlockLayout）。請先執行一次 python ocr_pdf.py --warmup。\n');
    process.exit(3);
}
if (mode === 'exit5') {
    process.stderr.write('Traceback: 假的辨識失敗\n[ocr_pdf] 第 1 頁辨識失敗：RuntimeError: boom\n');
    process.exit(5);
}
if (mode === 'badjson') {
    process.stdout.write('這不是 JSON\n');
    process.exit(0);
}

const from = Number(arg('--from'));
const to = Number(arg('--to'));
const out = arg('--out');
const dpi = Number(arg('--dpi'));
if (!fs.existsSync(arg('--pdf'))) {
    process.stderr.write(`[ocr_pdf] 找不到 PDF：${arg('--pdf')}\n`);
    process.exit(4);
}
fs.mkdirSync(out, { recursive: true });

const pages = [];
const last = mode === 'missing_page' ? to - 1 : to;
for (let p = from; p <= last; p++) {
    const image = mode === 'outside'
        ? path.resolve(out, '..', `escape-${p}.png`)
        : path.resolve(out, `page-${String(p).padStart(4, '0')}.png`);
    fs.writeFileSync(image, PNG);
    pages.push({ page: p, image, markdown: `第 ${p} 頁\n\n1. 設 $x+${p}=5$，求 $x$。\n\n[圖]` });
}

process.stderr.write('假 OCR：這是 log，應該只出現在 stderr\n');
if (mode === 'noise') process.stdout.write('some library printed to stdout\n');
process.stdout.write(JSON.stringify({
    engine: 'paddleocr',
    engine_version: mode === 'version' ? '9.9.9' : '3.7.0',
    pipeline: 'PP-StructureV3',
    dpi,
    pages
}) + '\n');
