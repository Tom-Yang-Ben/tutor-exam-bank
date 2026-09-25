// services/ocr 的單元測試（〔本機模式 L2〕docs/local-mode.md 第 4 條第 2 點）
//
// 不需要 Python、不需要 PaddleOCR：OCR_PYTHON 換成目前這支 Node（process.execPath），
// 腳本換成 test/fixtures/fakeOcr/fake_ocr_pdf.js（命令列介面與 ocr_pdf.py 相同），
// 於是 child_process.spawn、逾時、中止、stderr、結束碼、暫存檔清理走的都是正式程式碼。
// 執行：npm test

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ocr = require('../../services/ocr');
const cassette = require('../../services/llm/cassette');
const { templateHash, sha256Hex } = require('../../services/llm/templates');
const { isReplayMiss, parseReplayMiss } = require('../../eval/lib/replayMiss');

const FAKE_SCRIPT = path.resolve(__dirname, '..', 'fixtures', 'fakeOcr', 'fake_ocr_pdf.js');
const PDF = Buffer.from('%PDF-1.4 假的 PDF，fake_ocr_pdf.js 只檢查檔案存在\n');
const PDF_SHA = crypto.createHash('sha256').update(PDF).digest('hex');

/** 用 Node 假扮 Python 的設定 */
function fakeConfig(extra = {}) {
    return { python: process.execPath, script: FAKE_SCRIPT, dpi: 200, timeoutMs: 20000, ...extra };
}

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    };
    return Promise.resolve().then(fn).finally(restore);
}

function ocrTempDirs() {
    return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('exam-ocr-')).sort();
}

describe('services/ocr — 設定解析', () => {
    test('OCR_ENGINE：預設 paddle；none 原樣；大小寫與空白不影響', () => {
        assert.equal(ocr.resolveEngine({}), 'paddle');
        assert.equal(ocr.resolveEngine({ OCR_ENGINE: '' }), 'paddle');
        assert.equal(ocr.resolveEngine({ OCR_ENGINE: ' None ' }), 'none');
        assert.equal(ocr.resolveEngine({ OCR_ENGINE: 'PADDLE' }), 'paddle');
    });

    test('OCR_ENGINE 打錯字 → 退回 paddle（不讓交叉驗證悄悄關掉）', () => {
        const warn = console.warn;
        const seen = [];
        console.warn = (m) => seen.push(m);
        try {
            assert.equal(ocr.resolveEngine({ OCR_ENGINE: 'paddleocr' }), 'paddle');
            assert.equal(ocr.resolveEngine({ OCR_ENGINE: 'off' }), 'paddle');
        } finally {
            console.warn = warn;
        }
        assert.ok(seen.some(m => /OCR_ENGINE/.test(m)));
    });

    test('OCR_PYTHON 預設：Windows 用 .venv\\Scripts\\python.exe，其他用 .venv/bin/python（都在 exam_pro/ocr_service 底下）', () => {
        const win = ocr.defaultPython('win32');
        assert.ok(win.endsWith(path.win32.join('ocr_service', '.venv', 'Scripts', 'python.exe')), win);
        const posix = ocr.defaultPython('linux');
        assert.equal(posix, path.resolve(__dirname, '..', '..', 'ocr_service', '.venv', 'bin', 'python'));
        assert.equal(ocr.resolveOcrConfig({}, 'linux').python, posix);
        assert.equal(ocr.resolveOcrConfig({ OCR_PYTHON: '   ' }, 'linux').python, posix);
    });

    test('OCR_PYTHON：絕對路徑原樣、裸指令交給 PATH、相對路徑以 exam_pro/ 為基準', () => {
        assert.equal(ocr.resolvePython('/opt/py/bin/python3', 'linux'), '/opt/py/bin/python3');
        assert.equal(ocr.resolvePython('python3', 'linux'), 'python3');
        assert.equal(ocr.resolvePython('py', 'win32'), 'py');
        assert.equal(ocr.resolvePython('ocr_service/.venv/bin/python', 'linux'),
            path.resolve(__dirname, '..', '..', 'ocr_service', '.venv', 'bin', 'python'));
        assert.equal(ocr.resolvePython('C:\\Py312\\python.exe', 'win32'), 'C:\\Py312\\python.exe');
    });

    test('OCR_DPI／OCR_TIMEOUT_MS：預設 200／1800000，亂填或超出範圍退回預設', () => {
        const d = ocr.resolveOcrConfig({});
        assert.equal(d.dpi, 200);
        assert.equal(d.timeoutMs, 1800000);
        assert.equal(d.script, path.resolve(__dirname, '..', '..', 'ocr_service', 'ocr_pdf.py'));
        assert.equal(ocr.resolveOcrConfig({ OCR_DPI: '300', OCR_TIMEOUT_MS: '5000' }).dpi, 300);
        assert.equal(ocr.resolveOcrConfig({ OCR_DPI: '300', OCR_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
        for (const bad of ['abc', '10', '9999', '']) assert.equal(ocr.resolveOcrConfig({ OCR_DPI: bad }).dpi, 200, bad);
        for (const bad of ['0', '-5', 'x']) assert.equal(ocr.resolveOcrConfig({ OCR_TIMEOUT_MS: bad }).timeoutMs, 1800000, bad);
    });

    test('engine 版本取 requirements.txt 釘死的 paddleocr（replay 時沒有 Python 可問）', () => {
        assert.equal(ocr.pinnedEngineVersion(), '3.7.0');
        const tmp = path.join(os.tmpdir(), `req-${process.pid}.txt`);
        fs.writeFileSync(tmp, 'paddlepaddle==3.3.1\npaddleocr[doc-parser] == 3.9.1  # 註解\n');
        try {
            assert.equal(ocr.pinnedEngineVersion(tmp), '3.9.1');
            fs.writeFileSync(tmp, 'paddleocr>=3.0\n');
            assert.throws(() => ocr.pinnedEngineVersion(tmp), /沒有以 == 釘死/);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test('requirements.txt 釘死 CPU 版的三個套件（沒有 paddlepaddle-gpu、全部 ==）', () => {
        const text = fs.readFileSync(ocr.REQUIREMENTS_PATH, 'utf8');
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        assert.ok(lines.length >= 3);
        for (const l of lines) assert.match(l, /^[A-Za-z0-9_.-]+(\[[^\]]+\])?==[0-9][0-9A-Za-z.]*$/, l);
        assert.ok(lines.some(l => l.startsWith('paddlepaddle==')));
        assert.ok(lines.some(l => l.startsWith('paddleocr')));
        assert.ok(lines.some(l => l.startsWith('pymupdf==')));
        assert.ok(!lines.some(l => /gpu/i.test(l)));
    });
});

describe('services/ocr — cassette 鍵', () => {
    test('公式＝cassetteKey(agent ocr, modelId paddleocr@<版本>, template ocr.v1, cacheKeyParts{pdfSha256,fromPage,toPage,dpi})', () => {
        const parts = { engineVersion: '3.7.0', pdfSha256: 'a'.repeat(64), fromPage: 3, toPage: 4, dpi: 200 };
        const key = ocr.ocrCassetteKey(parts);
        const manual = sha256Hex([
            'ocr', 'paddleocr@3.7.0', templateHash('ocr.v1'), sha256Hex(''),
            JSON.stringify({ pdfSha256: 'a'.repeat(64), fromPage: 3, toPage: 4, dpi: 200 })
        ].join('\n'));
        assert.equal(key, manual);
    });

    test('版本、頁碼、DPI、PDF 任何一個不同，鍵就不同', () => {
        const base = { engineVersion: '3.7.0', pdfSha256: 'a'.repeat(64), fromPage: 1, toPage: 2, dpi: 200 };
        const k0 = ocr.ocrCassetteKey(base);
        for (const change of [{ engineVersion: '3.7.1' }, { fromPage: 2 }, { toPage: 3 }, { dpi: 300 }, { pdfSha256: 'b'.repeat(64) }]) {
            assert.notEqual(ocr.ocrCassetteKey({ ...base, ...change }), k0, JSON.stringify(change));
        }
    });

    test('ocr.v1 已註冊成辨識設定的描述（改 ocr_pdf.py 的設定要跟著改版，cassette 才會失效）', () => {
        assert.equal(templateHash('ocr.v1'), sha256Hex(ocr.PIPELINE_DESCRIPTION));
        assert.match(ocr.PIPELINE_DESCRIPTION, /PP-StructureV3/);
        assert.match(ocr.PIPELINE_DESCRIPTION, /chinese_cht/);
        assert.match(ocr.PIPELINE_DESCRIPTION, /device=cpu/);
        // 與 ocr_pdf.py 的 PIPELINE_OPTIONS 對得上（兩邊各寫一份，這裡釘住不要漂）
        const py = fs.readFileSync(ocr.SCRIPT_PATH, 'utf8');
        assert.match(py, /"lang": "chinese_cht"/);
        assert.match(py, /"device": "cpu"/);
        assert.match(py, /"formula_recognition_model_name": "PP-FormulaNet_plus-M"/);
        assert.match(ocr.PIPELINE_DESCRIPTION, /PP-FormulaNet_plus-M/);
    });
});

describe('services/ocr — 輸出解析', () => {
    const ok = (pages) => JSON.stringify({ engine: 'paddleocr', engine_version: '3.7.0', dpi: 200, pages });

    test('依頁序回傳；圖檔不存在或在輸出目錄外一律 imagePath=null', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrparse-'));
        try {
            const img = path.join(dir, 'page-0002.png');
            fs.writeFileSync(img, 'x');
            const r = ocr.parseOcrOutput(ok([
                { page: 2, image: img, markdown: 'B' },
                { page: 1, image: path.join(dir, 'nope.png'), markdown: 'A' }
            ]), { fromPage: 1, toPage: 2, outDir: dir });
            assert.deepEqual(r.pages.map(p => p.page), [1, 2]);
            assert.equal(r.pages[0].imagePath, null);
            assert.equal(r.pages[1].imagePath, img);
            assert.equal(r.engineVersion, '3.7.0');
            const outside = ocr.parseOcrOutput(ok([{ page: 1, image: img, markdown: 'A' }]),
                { fromPage: 1, toPage: 1, outDir: path.join(dir, 'sub') });
            assert.equal(outside.pages[0].imagePath, null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('前面混了雜訊 → 取最後一行的 JSON', () => {
        const r = ocr.parseOcrOutput(`log line\n${ok([{ page: 1, image: null, markdown: 'A' }])}\n`, { fromPage: 1, toPage: 1 });
        assert.equal(r.pages[0].markdown, 'A');
    });

    test('格式不對一律丟 provider_error：非 JSON、engine 不對、缺版本、缺頁、多頁、重複頁', () => {
        const cases = [
            ['不是 JSON', /不是 JSON/],
            [JSON.stringify({ engine: 'tesseract', engine_version: '5', pages: [] }), /engine/],
            [JSON.stringify({ engine: 'paddleocr', pages: [] }), /engine_version/],
            [JSON.stringify({ engine: 'paddleocr', engine_version: '3.7.0' }), /pages/],
            [ok([{ page: 1, markdown: 'A' }]), /少回了第 2 頁/],
            [ok([{ page: 1, markdown: 'A' }, { page: 2, markdown: 'B' }, { page: 3, markdown: 'C' }]), /範圍外/],
            [ok([{ page: 1, markdown: 'A' }, { page: 1, markdown: 'A' }]), /重複/],
            [ok([{ page: '1', markdown: 'A' }]), /格式不對/]
        ];
        for (const [stdout, re] of cases) {
            assert.throws(() => ocr.parseOcrOutput(stdout, { fromPage: 1, toPage: 2 }), (err) => {
                assert.match(err.message, re);
                assert.equal(err.errorClass, 'provider_error');
                return true;
            }, stdout.slice(0, 40));
        }
    });

    test('pagesToText：每頁前面加分頁標記，頁間空一行', () => {
        const t = ocr.pagesToText([{ page: 3, markdown: ' A \n' }, { page: 4, markdown: 'B' }]);
        assert.equal(t, '<!-- 第 3 頁 -->\nA\n\n<!-- 第 4 頁 -->\nB');
    });
});

describe('services/ocr — 子行程（spawn，不經 shell）', () => {
    let cassetteDir;
    before(() => {
        cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cassettes-'));
    });
    after(() => {
        fs.rmSync(cassetteDir, { recursive: true, force: true });
    });
    beforeEach(() => ocr._resetForTest());
    afterEach(() => ocr._resetForTest());

    test('live：依契約傳參數、回每頁 markdown 與 PNG 路徑；dispose() 刪掉暫存目錄', async () => {
        const argsFile = path.join(cassetteDir, 'args.json');
        await withEnv({ FAKE_OCR_MODE: 'ok', FAKE_OCR_ARGS_FILE: argsFile }, async () => {
            const before = ocrTempDirs();
            const r = await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 3, toPage: 4, mode: 'live', config: fakeConfig() });
            assert.equal(r.engine, 'paddleocr');
            assert.equal(r.engineVersion, '3.7.0');
            assert.equal(r.replayed, false);
            assert.deepEqual(r.pages.map(p => p.page), [3, 4]);
            assert.match(r.pages[0].markdown, /x\+3=5/);
            for (const p of r.pages) assert.ok(fs.existsSync(p.imagePath), p.imagePath);

            const argv = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
            // 子行程收到的 argv（腳本路徑之後）：--pdf <暫存檔> --from --to --dpi --out
            assert.deepEqual(argv.filter(a => a.startsWith('--')), ['--pdf', '--from', '--to', '--dpi', '--out']);
            const flag = (n) => argv[argv.indexOf(n) + 1];
            assert.equal(flag('--from'), '3');
            assert.equal(flag('--to'), '4');
            assert.equal(flag('--dpi'), '200');
            assert.ok(fs.existsSync(path.dirname(flag('--out'))), '輸出目錄在暫存資料夾裡');
            assert.ok(path.basename(path.dirname(flag('--pdf'))).startsWith('exam-ocr-'));

            assert.equal(ocrTempDirs().length, before.length + 1);
            r.dispose();
            r.dispose();   // 重複呼叫無害
            assert.deepEqual(ocrTempDirs(), before, '用完要刪暫存目錄');
            for (const p of r.pages) assert.ok(!fs.existsSync(p.imagePath));
        });
    });

    test('stdout 前面有雜訊也解析得出來', async () => {
        await withEnv({ FAKE_OCR_MODE: 'noise' }, async () => {
            const r = await ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', config: fakeConfig() });
            assert.equal(r.pages.length, 1);
            r.dispose();
        });
    });

    test('結束碼 3（模型不在）→ provider_error，訊息提示 --warmup 並附 stderr；暫存目錄已刪', async () => {
        await withEnv({ FAKE_OCR_MODE: 'exit3' }, async () => {
            const before = ocrTempDirs();
            await assert.rejects(
                ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', config: fakeConfig() }),
                (err) => {
                    assert.equal(err.errorClass, 'provider_error');
                    assert.equal(err.exitCode, 3);
                    assert.match(err.message, /--warmup/);
                    assert.match(err.message, /PP-DocBlockLayout/, 'stderr 要收進錯誤訊息');
                    return true;
                });
            assert.deepEqual(ocrTempDirs(), before);
        });
    });

    test('其他非 0 結束碼 → provider_error，訊息帶結束碼與 stderr 尾段', async () => {
        await withEnv({ FAKE_OCR_MODE: 'exit5' }, async () => {
            await assert.rejects(
                ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', config: fakeConfig() }),
                (err) => {
                    assert.equal(err.errorClass, 'provider_error');
                    assert.match(err.message, /結束碼 5/);
                    assert.match(err.message, /RuntimeError: boom/);
                    return true;
                });
        });
    });

    test('stdout 不是 JSON、少頁 → provider_error', async () => {
        for (const mode of ['badjson', 'missing_page']) {
            await withEnv({ FAKE_OCR_MODE: mode }, async () => {
                await assert.rejects(
                    ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 2, mode: 'live', config: fakeConfig() }),
                    (err) => err.errorClass === 'provider_error');
            });
        }
    });

    test('圖檔路徑在輸出目錄外 → imagePath=null（不信任子行程給的任意路徑）', async () => {
        await withEnv({ FAKE_OCR_MODE: 'outside' }, async () => {
            const r = await ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', config: fakeConfig() });
            assert.equal(r.pages[0].imagePath, null);
            r.dispose();
        });
    });

    test('逾時（OCR_TIMEOUT_MS）→ errorClass timeout，子行程被結束', async () => {
        await withEnv({ FAKE_OCR_MODE: 'hang' }, async () => {
            const t0 = Date.now();
            await assert.rejects(
                ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', config: fakeConfig({ timeoutMs: 300 }) }),
                (err) => {
                    assert.equal(err.errorClass, 'timeout');
                    assert.match(err.message, /OCR_TIMEOUT_MS/);
                    return true;
                });
            assert.ok(Date.now() - t0 < 10000, '逾時後要馬上結束，不能等子行程自己停');
        });
    });

    test('signal 中止（節點逾時）→ errorClass timeout；已中止的 signal 連子行程都不開', async () => {
        await withEnv({ FAKE_OCR_MODE: 'hang' }, async () => {
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 200);
            await assert.rejects(
                ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', signal: ac.signal, config: fakeConfig() }),
                (err) => err.errorClass === 'timeout' && /中止/.test(err.message));

            let spawned = false;
            await assert.rejects(
                ocr.ocrPdf({
                    pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', signal: AbortSignal.abort(), config: fakeConfig(),
                    spawnImpl: () => { spawned = true; throw new Error('不該被呼叫'); }
                }),
                (err) => err.errorClass === 'timeout');
            assert.equal(spawned, false);
        });
    });

    test('找不到 Python → provider_error，訊息指向 OCR_PYTHON 與 OCR_ENGINE=none', async () => {
        await assert.rejects(
            ocr.ocrPdf({
                pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live',
                config: fakeConfig({ python: path.join(os.tmpdir(), 'no-such-python-here', 'python') })
            }),
            (err) => {
                assert.equal(err.errorClass, 'provider_error');
                assert.match(err.message, /OCR_PYTHON/);
                assert.match(err.message, /OCR_ENGINE=none/);
                return true;
            });
    });

    test('spawn 用參數陣列、不經 shell、stdin 關閉、子行程的 Python 輸出強制 UTF-8', async () => {
        let seen = null;
        const { EventEmitter } = require('node:events');
        const spawnImpl = (cmd, args, options) => {
            seen = { cmd, args, options };
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => { };
            setImmediate(() => {
                child.stdout.emit('data', Buffer.from(JSON.stringify({
                    engine: 'paddleocr', engine_version: '3.7.0', dpi: 200, pages: [{ page: 1, image: null, markdown: 'A' }]
                })));
                child.emit('close', 0, null);
            });
            return child;
        };
        const r = await ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', config: fakeConfig({ python: 'python-x' }), spawnImpl });
        r.dispose();
        assert.equal(seen.cmd, 'python-x');
        assert.ok(Array.isArray(seen.args));
        assert.equal(seen.args[0], FAKE_SCRIPT, '第一個參數是 ocr_pdf.py 的路徑');
        assert.equal(seen.options.shell, false);
        assert.deepEqual(seen.options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(seen.options.windowsHide, true);
        assert.equal(seen.options.env.PYTHONIOENCODING, 'utf-8');
        assert.equal(seen.options.env.PYTHONUTF8, '1');
    });

    test('record 寫 cassette（只存 markdown，不存圖片與 PDF），replay 讀回來、imagePath 一律 null', async () => {
        await withEnv({ FAKE_OCR_MODE: 'ok', EVAL_CASSETTE_DIR: cassetteDir }, async () => {
            const log = console.log;
            console.log = () => { };
            let rec;
            try {
                rec = await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, mode: 'record', config: fakeConfig() });
            } finally {
                console.log = log;
            }
            rec.dispose();

            const key = ocr.ocrCassetteKey({ engineVersion: '3.7.0', pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, dpi: 200 });
            assert.equal(rec.cassetteKey, key);
            const file = path.join(cassetteDir, 'ocr', `${key}.json`);
            assert.equal(cassette.cassettePath('ocr', key), file);
            const tape = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.equal(tape.meta.agent, 'ocr');
            assert.equal(tape.meta.model, 'paddleocr@3.7.0');
            assert.equal(tape.meta.template, 'ocr.v1');
            assert.deepEqual(tape.request.cacheKeyParts, { pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, dpi: 200 });
            assert.deepEqual(tape.response.pages.map(p => Object.keys(p).sort()), [['markdown', 'page'], ['markdown', 'page']]);
            const raw = fs.readFileSync(file, 'utf8');
            assert.ok(!raw.includes('page-0001.png'), '不存圖片路徑');
            assert.ok(!raw.includes(PDF.toString('base64')), '不存 PDF');

            const rep = await ocr.ocrPdf({ pdfBytes: PDF, pdfSha256: PDF_SHA, fromPage: 1, toPage: 2, mode: 'replay', config: fakeConfig({ python: '/不會被呼叫' }) });
            assert.equal(rep.replayed, true);
            assert.deepEqual(rep.pages.map(p => p.markdown), rec.pages.map(p => p.markdown));
            assert.deepEqual(rep.pages.map(p => p.imagePath), [null, null]);
            rep.dispose();
        });
    });

    test('replay miss：訊息與 LLM 的 replay miss 同格式（eval/lib/replayMiss.js 認得），不開子行程', async () => {
        await withEnv({ EVAL_CASSETTE_DIR: cassetteDir }, async () => {
            let spawned = false;
            await assert.rejects(
                ocr.ocrPdf({
                    pdfBytes: PDF, fromPage: 5, toPage: 6, mode: 'replay', config: fakeConfig(),
                    spawnImpl: () => { spawned = true; }
                }),
                (err) => {
                    assert.ok(isReplayMiss(err), err.message);
                    assert.equal(parseReplayMiss(err).agent, 'ocr');
                    assert.match(err.message, /^LLM_MODE=replay 找不到 cassette（agent=ocr key=[0-9a-f]{64}）。請在本機執行 npm run eval:record -- --suite <suite>/);
                    return true;
                });
            assert.equal(spawned, false);
        });
    });

    test('record 時 ocr_pdf.py 回報的版本與 requirements.txt 不同 → 拒錄；live 只警告', async () => {
        await withEnv({ FAKE_OCR_MODE: 'version', EVAL_CASSETTE_DIR: cassetteDir }, async () => {
            await assert.rejects(
                ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'record', config: fakeConfig() }),
                (err) => err.errorClass === 'provider_error' && /9\.9\.9/.test(err.message) && /3\.7\.0/.test(err.message));
            const warn = console.warn;
            const seen = [];
            console.warn = (m) => seen.push(m);
            try {
                const r = await ocr.ocrPdf({ pdfBytes: PDF, fromPage: 1, toPage: 1, mode: 'live', config: fakeConfig() });
                assert.equal(r.engineVersion, '9.9.9');
                r.dispose();
            } finally {
                console.warn = warn;
            }
            assert.ok(seen.some(m => /9\.9\.9/.test(m)));
        });
    });

    test('模式預設跟 LLM_MODE（未設＝replay）', async () => {
        await withEnv({ LLM_MODE: undefined, EVAL_CASSETTE_DIR: cassetteDir }, async () => {
            await assert.rejects(
                ocr.ocrPdf({ pdfBytes: PDF, fromPage: 7, toPage: 7, config: fakeConfig() }),
                (err) => isReplayMiss(err));
        });
    });

    test('參數檢查：pdfBytes 不是 Buffer、頁碼範圍不合法 → 丟錯', async () => {
        await assert.rejects(ocr.ocrPdf({ pdfBytes: 'x', fromPage: 1, toPage: 1, mode: 'live' }), /Buffer/);
        await assert.rejects(ocr.ocrPdf({ pdfBytes: PDF, fromPage: 2, toPage: 1, mode: 'live' }), /頁碼/);
        await assert.rejects(ocr.ocrPdf({ pdfBytes: PDF, fromPage: 0, toPage: 1, mode: 'live' }), /頁碼/);
    });

    test('warmup：跑 --warmup、把 stderr（下載進度）即時交給 onStderr；失敗回 {ok:false}', async () => {
        await withEnv({ FAKE_OCR_MODE: 'ok' }, async () => {
            const seen = [];
            const r = await ocr.warmup({ config: fakeConfig(), onStderr: (t) => seen.push(t) });
            assert.deepEqual(r, { ok: true, engineVersion: '3.7.0' });
            assert.ok(seen.join('').includes('Downloading'), '進度要即時轉出來');
        });
        await withEnv({ FAKE_OCR_MODE: 'exit3' }, async () => {
            const r = await ocr.warmup({ config: fakeConfig() });
            assert.equal(r.ok, false);
        });
    });

    test('cli：不認得的子指令 → 結束碼 2', async () => {
        const { main } = require('../../services/ocr/cli');
        const err = console.error;
        console.error = () => { };
        try {
            assert.equal(await main(['nope']), 2);
            assert.equal(await main([]), 2);
        } finally {
            console.error = err;
        }
    });

    test('selftest：成功回 {ok, engineVersion}；模型不在回 {ok:false} 與訊息，不丟錯', async () => {
        await withEnv({ FAKE_OCR_MODE: 'ok' }, async () => {
            assert.deepEqual(await ocr.selftest({ config: fakeConfig() }), { ok: true, engineVersion: '3.7.0' });
        });
        await withEnv({ FAKE_OCR_MODE: 'exit3' }, async () => {
            const r = await ocr.selftest({ config: fakeConfig() });
            assert.equal(r.ok, false);
            assert.match(r.message, /--warmup/);
        });
    });
});
