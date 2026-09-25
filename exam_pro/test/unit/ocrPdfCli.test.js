// ocr_service/ocr_pdf.py 的 CLI 合約（〔本機模式 L2〕docs/local-mode.md 第 4 條第 1 點）
//
// CI 不裝 PaddleOCR：這裡只驗「不需要載入 PaddleOCR 就走得到」的部分——
//   參數檢查（結束碼 2）、輸入檔不存在（結束碼 4）、錯誤只進 stderr、stdout 保持空白。
// 機器上沒有 Python 時整組略過（npm test 不要求 Python）。其餘部分用原始碼靜態檢查釘住：
// --selftest／--warmup、只用 CPU、執行期不下載（關掉模型平台檢查＋下載護欄）、stdout 只放 JSON。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'ocr_service', 'ocr_pdf.py');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');

function findPython() {
    for (const cmd of ['python3', 'python']) {
        try {
            const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 10000 });
            if (r.status === 0 && r.stdout.trim() === '3') return cmd;
        } catch (_) { /* 沒有這個指令 */ }
    }
    return null;
}
const PYTHON = findPython();

function run(args) {
    return spawnSync(PYTHON, [SCRIPT, ...args], {
        encoding: 'utf8', timeout: 60000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
}

describe('ocr_pdf.py — 原始碼合約（靜態）', () => {
    test('三種模式：辨識（--pdf --from --to --dpi --out）、--selftest、--warmup', () => {
        for (const flag of ['"--pdf"', '"--from"', '"--to"', '"--dpi"', '"--out"', '"--selftest"', '"--warmup"']) {
            assert.ok(SOURCE.includes(flag), `少了 ${flag}`);
        }
        assert.match(SOURCE, /add_mutually_exclusive_group/);
    });

    test('用 PaddleOCR 3.x 的 PP-StructureV3：繁體中文、只用 CPU、公式辨識與表格辨識都開', () => {
        assert.match(SOURCE, /from paddleocr import PPStructureV3/);
        assert.match(SOURCE, /"lang": "chinese_cht"/);
        assert.match(SOURCE, /"device": "cpu"/);
        assert.match(SOURCE, /"use_formula_recognition": True/);
        assert.match(SOURCE, /"use_table_recognition": True/);
    });

    test('執行期不下載：關掉模型平台連線檢查、HF 離線、下載步驟換成丟錯；只有 --warmup 允許下載', () => {
        assert.match(SOURCE, /PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK/);
        assert.match(SOURCE, /HF_HUB_OFFLINE/);
        assert.match(SOURCE, /_download_from_hoster = _refuse/);
        assert.match(SOURCE, /allow_download = bool\(args\.warmup\)/);
    });

    test('stdout 只放最後的 JSON：fd 1 接到 fd 2、JSON 以 UTF-8 寫到另存的 fd', () => {
        assert.match(SOURCE, /os\.dup2\(2, 1\)/);
        assert.match(SOURCE, /ensure_ascii=False/);
        assert.match(SOURCE, /\.encode\("utf-8"\)/);
    });

    test('輸出欄位：engine、engine_version、dpi、pages[{page, image, markdown}]', () => {
        for (const key of ['"engine"', '"engine_version"', '"dpi"', '"pages"', '"page"', '"image"', '"markdown"']) {
            assert.ok(SOURCE.includes(key), `少了 ${key}`);
        }
    });

    test('結束碼與 services/ocr 的對照一致（3＝沒準備好、4＝輸入有問題）', () => {
        assert.match(SOURCE, /EXIT_NOT_READY = 3/);
        assert.match(SOURCE, /EXIT_INPUT = 4/);
    });
});

describe('ocr_pdf.py — 實際執行（不需要 PaddleOCR 的部分）', { skip: PYTHON ? false : '這台機器沒有 Python 3' }, () => {
    test('語法正確（py_compile）', () => {
        const r = spawnSync(PYTHON, ['-c', `import py_compile, sys; py_compile.compile(sys.argv[1], doraise=True, cfile=${JSON.stringify(path.join(os.tmpdir(), `ocr_pdf_${process.pid}.pyc`))})`, SCRIPT], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    });

    test('辨識模式缺參數 → 結束碼 2，stdout 空白', () => {
        const r = run(['--from', '1']);
        assert.equal(r.status, 2);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, /--pdf/);
    });

    test('頁碼範圍不合法、DPI 超出範圍 → 結束碼 2', () => {
        assert.equal(run(['--pdf', 'x.pdf', '--from', '3', '--to', '2', '--out', os.tmpdir()]).status, 2);
        assert.equal(run(['--pdf', 'x.pdf', '--from', '1', '--to', '1', '--dpi', '5', '--out', os.tmpdir()]).status, 2);
    });

    test('--selftest 與 --warmup 不能同時用', () => {
        assert.equal(run(['--selftest', '--warmup']).status, 2);
    });

    test('PDF 不存在 → 結束碼 4、錯誤只在 stderr、stdout 空白（在載入 PaddleOCR 之前就擋下）', () => {
        const missing = path.join(os.tmpdir(), `沒有這個檔-${process.pid}.pdf`);
        const r = run(['--pdf', missing, '--from', '1', '--to', '1', '--out', os.tmpdir()]);
        assert.equal(r.status, 4, r.stderr);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, /找不到 PDF/);
    });
});
