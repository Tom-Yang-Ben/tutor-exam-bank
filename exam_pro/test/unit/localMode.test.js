// ─────────────────────────────────────────────────────────────
// test/unit/localMode.test.js — 本機模式在 eval 這一側的判斷、錄前檢查與時間粗估（eval/lib/localMode.js）
// docs/local-mode.md 第 6 條第 2 點（L4）。
//
// 不連網、不跑 Python：Ollama 的 /api/tags 與 ocr_pdf.py --selftest 一律注入替身。
// ─────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const local = require('../../eval/lib/localMode');
const audit = require('../../eval/lib/cassetteAudit');
const { formatSummary } = require('../../eval/lib/cassettePlan');

const APP_DIR = path.resolve(__dirname, '..', '..');

describe('模型字串：供應商與裸 ID（只切第一個冒號，與 config/models.js 的 parseModel 同一條規則）', () => {
    test('vendorOf／modelIdOf', () => {
        assert.equal(local.vendorOf('ollama:qwen3:8b'), 'ollama');
        assert.equal(local.modelIdOf('ollama:qwen3:8b'), 'qwen3:8b');
        assert.equal(local.vendorOf('ollama:qwen3-embedding:0.6b'), 'ollama');
        assert.equal(local.modelIdOf('ollama:qwen3-embedding:0.6b'), 'qwen3-embedding:0.6b');
        assert.equal(local.vendorOf('gemini:gemini-3.5-flash'), 'gemini');
        assert.equal(local.vendorOf('gemini-embedding-001'), 'gemini', '沒有前綴的舊值一律視為 Gemini（第 2 條）');
        assert.equal(local.modelIdOf('gemini-embedding-001'), 'gemini-embedding-001');
        assert.equal(local.vendorOf(' OLLAMA:x '), 'ollama');
        assert.equal(local.vendorOf(''), null);
        assert.equal(local.vendorOf(undefined), null);
    });

    test('embedModelFromEnv：有設就用，沒設或空白是本機預設', () => {
        assert.equal(local.embedModelFromEnv({}), 'ollama:qwen3-embedding:0.6b');
        assert.equal(local.embedModelFromEnv({ EMBED_MODEL: '  ' }), 'ollama:qwen3-embedding:0.6b');
        assert.equal(local.embedModelFromEnv({ EMBED_MODEL: 'gemini-embedding-001' }), 'gemini-embedding-001');
    });
});

describe('本機預設與 repo 的設定一致', () => {
    test('LOCAL_DEFAULTS 就是 docs/local-mode.md 第 2 條那幾個值', () => {
        const doc = fs.readFileSync(path.resolve(APP_DIR, '..', 'docs', 'local-mode.md'), 'utf8');
        for (const [k, v] of Object.entries({ MODEL_EXTRACT: local.LOCAL_DEFAULTS.MODEL_EXTRACT, MODEL_VERIFY: local.LOCAL_DEFAULTS.MODEL_VERIFY, EMBED_MODEL: local.LOCAL_DEFAULTS.EMBED_MODEL, OLLAMA_HOST: local.LOCAL_DEFAULTS.OLLAMA_HOST })) {
            assert.ok(doc.includes(`| \`${k}\` | \`${v}\``), `docs/local-mode.md 第 2 條的 ${k} 不是 ${v}`);
        }
        assert.ok(doc.includes('| `OCR_ENGINE` | `paddle`'));
        assert.ok(doc.includes('| `OCR_DPI` | `200`'));
        assert.equal(local.LOCAL_NODE_TIMEOUT_MS, 2_700_000, '第 2 條：JOB_NODE_TIMEOUT_MS 拆題模型是 ollama 時預設 2700000');
    });

    test('NLQ_CODE_DEFAULT 與 services/nlqService.js 的 DEFAULT_MODEL_NLQ 相同（那支沒有匯出，掃原始碼）', () => {
        const src = fs.readFileSync(path.join(APP_DIR, 'services', 'nlqService.js'), 'utf8');
        const m = src.match(/const DEFAULT_MODEL_NLQ = '([^']+)'/);
        assert.ok(m, 'services/nlqService.js 找不到 DEFAULT_MODEL_NLQ');
        assert.equal(local.NLQ_CODE_DEFAULT, m[1], 'nlqService 的預設改了：同步改 eval/lib/localMode.js 的 NLQ_CODE_DEFAULT');
    });
});

describe('recordingPlan：這一輪錄製用到哪些模型、要不要金鑰與 OCR', () => {
    const LOCAL_CI = { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b', EMBED_MODEL: 'ollama:qwen3-embedding:0.6b', MODEL_NLQ: 'ollama:qwen3:8b' };
    const ALL = ['retrieval', 'classify', 'pipeline', 'nlq', 'variant', 'e2e'];

    test('全部本機：不需要金鑰；三個模型各列一次；錄 pipeline 就要 OCR', () => {
        const p = local.recordingPlan({ models: LOCAL_CI, suites: ALL });
        assert.equal(p.needGeminiKey, false);
        assert.equal(p.local, true);
        assert.deepEqual(p.ollama, ['qwen3-vl:8b', 'qwen3:8b', 'qwen3-embedding:0.6b']);
        assert.equal(p.needOcr, true);
    });

    test('只錄 retrieval：只需要 embedding 模型；不錄 pipeline／e2e 不需要 OCR', () => {
        const p = local.recordingPlan({ models: LOCAL_CI, suites: ['retrieval'] });
        assert.deepEqual(p.ollama, ['qwen3-embedding:0.6b']);
        assert.equal(p.needOcr, false);
        assert.equal(local.recordingPlan({ models: LOCAL_CI, suites: ['classify'] }).needOcr, false);
        assert.equal(local.recordingPlan({ models: LOCAL_CI, suites: ['e2e'] }).needOcr, true, 'e2e 由 pipeline 那一步順帶錄');
    });

    test('--no-similar：只選 e2e 時不錄 dedup1 的向量，也就不需要 embedding 模型', () => {
        assert.deepEqual(local.recordingPlan({ models: LOCAL_CI, suites: ['e2e'], withSimilar: false }).ollama, ['qwen3-vl:8b', 'qwen3:8b']);
        assert.ok(local.recordingPlan({ models: LOCAL_CI, suites: ['e2e'] }).ollama.includes('qwen3-embedding:0.6b'));
    });

    test('OCR_ENGINE=none（ci.yml）或拆題走 Gemini：不需要 OCR', () => {
        assert.equal(local.recordingPlan({ models: { ...LOCAL_CI, OCR_ENGINE: 'none' }, suites: ALL }).needOcr, false);
        assert.equal(local.recordingPlan({ models: { ...LOCAL_CI, MODEL_EXTRACT: 'gemini:gemini-3.5-flash' }, suites: ALL }).needOcr, false);
    });

    test('ci.yml 沒寫 MODEL_NLQ：nlq 用 services/nlqService.js 的預設（Gemini），錄 nlq 就要金鑰', () => {
        const p = local.recordingPlan({ models: { MODEL_EXTRACT: LOCAL_CI.MODEL_EXTRACT, MODEL_VERIFY: LOCAL_CI.MODEL_VERIFY }, suites: ['nlq'] });
        assert.equal(p.needGeminiKey, true);
        assert.deepEqual(p.gemini.map(u => u.key), ['MODEL_NLQ']);
        assert.equal(local.recordingPlan({ models: { MODEL_EXTRACT: LOCAL_CI.MODEL_EXTRACT, MODEL_VERIFY: LOCAL_CI.MODEL_VERIFY }, suites: ['classify'] }).needGeminiKey, false);
    });

    test('全部 Gemini：要金鑰、不是本機、不需要 OCR；ci.yml 沒寫 EMBED_MODEL 時是本機預設', () => {
        const p = local.recordingPlan({ models: { MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b', EMBED_MODEL: 'gemini-embedding-001', MODEL_NLQ: 'gemini:c' }, suites: ALL });
        assert.equal(p.needGeminiKey, true);
        assert.equal(p.local, false);
        assert.equal(p.needOcr, false);
        assert.equal(local.isLocalRun({ MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b' }), false);
        assert.equal(local.isLocalRun({}), true, '沒寫就是程式預設＝本機');
        assert.deepEqual(local.recordingPlan({ models: { MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b' }, suites: ['retrieval'] }).ollama, ['qwen3-embedding:0.6b']);
    });

    test('localRecordEnv：本機才帶長逾時；NLQ 走本機才帶 NLQ 的長逾時', () => {
        assert.deepEqual(local.localRecordEnv(local.recordingPlan({ models: LOCAL_CI, suites: ALL })),
            { JOB_NODE_TIMEOUT_MS: '2700000', NLQ_TIMEOUT_MS: '1800000' });
        assert.deepEqual(local.localRecordEnv(local.recordingPlan({ models: { ...LOCAL_CI, MODEL_NLQ: 'gemini:x' }, suites: ALL })),
            { JOB_NODE_TIMEOUT_MS: '2700000' });
        assert.deepEqual(local.localRecordEnv(local.recordingPlan({ models: { MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b', EMBED_MODEL: 'gemini-embedding-001', MODEL_NLQ: 'gemini:c' }, suites: ALL })), {});
    });
});

describe('Ollama：位址與 /api/tags 檢查', () => {
    test('ollamaHost：預設 127.0.0.1:11434；補 scheme 與埠；0.0.0.0 改連本機；非本機標出來', () => {
        assert.deepEqual(local.ollamaHost({}), { url: 'http://127.0.0.1:11434', local: true });
        assert.deepEqual(local.ollamaHost({ OLLAMA_HOST: 'localhost' }), { url: 'http://localhost:11434', local: true });
        assert.deepEqual(local.ollamaHost({ OLLAMA_HOST: '0.0.0.0:11500' }), { url: 'http://127.0.0.1:11500', local: true });
        assert.deepEqual(local.ollamaHost({ OLLAMA_HOST: 'http://[::1]:11434/' }), { url: 'http://[::1]:11434', local: true });
        assert.equal(local.ollamaHost({ OLLAMA_HOST: 'http://192.168.1.5:11434' }).local, false);
        assert.ok(local.ollamaHost({ OLLAMA_HOST: 'http://' }).error);
    });

    test('hasModel：完全相同，或沒寫 tag 時對 :latest；不分大小寫', () => {
        assert.equal(local.hasModel(['qwen3:8b'], 'qwen3:8b'), true);
        assert.equal(local.hasModel(['qwen3:latest'], 'qwen3'), true);
        assert.equal(local.hasModel(['qwen3:14b'], 'qwen3:8b'), false);
        assert.equal(local.hasModel(['Qwen3-VL:8B'], 'qwen3-vl:8b'), true);
    });

    test('checkOllama：打 {host}/api/tags；列出缺的模型', async () => {
        const urls = [];
        const fetchImpl = async (url) => {
            urls.push(url);
            return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }, { model: 'qwen3-embedding:0.6b' }] }) };
        };
        const r = await local.checkOllama({ host: 'http://127.0.0.1:11434', models: ['qwen3-vl:8b', 'qwen3:8b', 'qwen3-embedding:0.6b'], fetchImpl });
        assert.deepEqual(urls, ['http://127.0.0.1:11434/api/tags']);
        assert.equal(r.ok, false);
        assert.equal(r.reachable, true);
        assert.deepEqual(r.missing, ['qwen3-vl:8b']);
        assert.match(r.error, /qwen3-vl:8b/);
        assert.ok(local.ollamaAdvice(r, 'http://127.0.0.1:11434').some(l => l.includes('ollama pull qwen3-vl:8b')));

        const all = await local.checkOllama({ host: 'http://h', models: ['qwen3:8b'], fetchImpl });
        assert.deepEqual({ ok: all.ok, missing: all.missing, error: all.error }, { ok: true, missing: [], error: null });
    });

    test('checkOllama：連不上、HTTP 錯誤、不是 JSON，都回 ok=false 並說明', async () => {
        const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        const down = await local.checkOllama({ host: 'http://127.0.0.1:11434', models: ['qwen3:8b'], fetchImpl: async () => { throw refused; } });
        assert.equal(down.ok, false);
        assert.equal(down.reachable, false);
        assert.match(down.error, /連不上 Ollama.*ECONNREFUSED/);
        assert.ok(local.ollamaAdvice(down, 'http://127.0.0.1:11434').some(l => l.includes('開啟 Ollama')));

        const http500 = await local.checkOllama({ host: 'http://h', models: [], fetchImpl: async () => ({ ok: false, status: 500 }) });
        assert.match(http500.error, /HTTP 500/);
        const notJson = await local.checkOllama({ host: 'http://h', models: [], fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } }) });
        assert.match(notJson.error, /不是 JSON/);
    });
});

describe('PaddleOCR：Python 路徑與 --selftest', () => {
    test('ocrPython：沒設時是 ocr_service/.venv 裡的那一支（Windows 與其他）；相對路徑以 exam_pro/ 為基準；只寫指令名原樣', () => {
        assert.ok(local.ocrPython({}, 'win32').endsWith(path.join('ocr_service', '.venv', 'Scripts', 'python.exe')));
        assert.ok(local.ocrPython({}, 'linux').endsWith(path.join('ocr_service', '.venv', 'bin', 'python')));
        assert.equal(local.ocrPython({ OCR_PYTHON: 'ocr_service/.venv/bin/python' }, 'linux'), path.join(APP_DIR, 'ocr_service', '.venv', 'bin', 'python'));
        assert.equal(local.ocrPython({ OCR_PYTHON: '/usr/bin/python3' }), '/usr/bin/python3');
        assert.equal(local.ocrPython({ OCR_PYTHON: 'python' }), 'python');
    });

    test('parseSelftest：取最後一行 JSON；整段多行 JSON 也接受；不是 JSON 回 null', () => {
        assert.deepEqual(local.parseSelftest('loading...\n{"ok": true, "engine_version": "3.0.0"}\n'), { ok: true, engine_version: '3.0.0' });
        assert.deepEqual(local.parseSelftest('{\n  "ok": true\n}\n'), { ok: true });
        assert.equal(local.parseSelftest('Traceback ...'), null);
    });

    /** 假的 execFile：記下參數，回指定的結果 */
    function fakeExec(result) {
        const calls = [];
        const impl = (file, args, opts, cb) => { calls.push({ file, args, opts }); setImmediate(() => cb(result.err || null, result.stdout || '', result.stderr || '')); };
        return { impl, calls };
    }

    test('checkOcr：<python> ocr_pdf.py --selftest，stdout 是 {ok:true} 才算過；Python 以 UTF-8 輸出', async () => {
        const { impl, calls } = fakeExec({ stdout: '{"ok": true, "engine_version": "paddleocr 3.0.3"}\n' });
        const r = await local.checkOcr({ python: '/venv/bin/python', script: '/x/ocr_pdf.py', execFileImpl: impl, existsImpl: () => true });
        assert.deepEqual(r, { ok: true, engineVersion: 'paddleocr 3.0.3' });
        assert.equal(calls[0].file, '/venv/bin/python');
        assert.deepEqual(calls[0].args, ['/x/ocr_pdf.py', '--selftest']);
        assert.equal(calls[0].opts.env.PYTHONUTF8, '1');
        assert.ok(calls[0].opts.timeout > 0);
    });

    test('checkOcr：結束碼非 0、印出 ok:false、找不到 Python 或腳本，都回 ok=false 並附原因', async () => {
        const fail = fakeExec({ err: Object.assign(new Error('exit'), { code: 1 }), stderr: 'x\nModuleNotFoundError: No module named paddleocr\n' });
        const r1 = await local.checkOcr({ python: '/p', script: '/s', execFileImpl: fail.impl, existsImpl: () => true });
        assert.equal(r1.ok, false);
        assert.match(r1.error, /結束碼 1/);
        assert.ok(r1.detail.some(l => l.includes('ModuleNotFoundError')));

        const notOk = fakeExec({ stdout: '{"ok": false, "error": "模型不在"}' });
        const r2 = await local.checkOcr({ python: '/p', script: '/s', execFileImpl: notOk.impl, existsImpl: () => true });
        assert.equal(r2.ok, false);

        const enoent = fakeExec({ err: Object.assign(new Error('spawn'), { code: 'ENOENT' }) });
        const r3 = await local.checkOcr({ python: 'python', script: '/s', execFileImpl: enoent.impl, existsImpl: () => true });
        assert.match(r3.error, /找不到 Python/);

        const noScript = await local.checkOcr({ python: '/p', script: path.join(APP_DIR, 'ocr_service', 'ocr_pdf.py'), execFileImpl: () => { throw new Error('不該跑'); }, existsImpl: () => false });
        assert.match(noScript.error, /找不到 ocr_service\/ocr_pdf\.py/);
        const noPython = await local.checkOcr({ python: '/nope/python', script: '/s', execFileImpl: () => { throw new Error('不該跑'); }, existsImpl: (p) => p === '/s' });
        assert.match(noPython.error, /找不到 OCR 用的 Python/);
        assert.ok(local.ocrAdvice('/nope/python').some(l => l.includes('setup_local_ai.bat')));
    });
});

describe('預估時間（粗估）', () => {
    test('secPerCall：預設表 × RERECORD_TIME_SCALE；單一 agent 覆寫優先且不乘倍率；沒列的 agent 用預設', () => {
        assert.equal(local.secPerCall('verify', {}), local.SEC_PER_CALL.verify);
        assert.equal(local.secPerCall('verify', { RERECORD_TIME_SCALE: '0.5' }), local.SEC_PER_CALL.verify / 2);
        assert.equal(local.secPerCall('extract_vision', { RERECORD_SEC_PER_CALL_EXTRACT_VISION: '900', RERECORD_TIME_SCALE: '2' }), 900);
        assert.equal(local.secPerCall('kc_tag', {}), local.DEFAULT_SEC_PER_CALL);
        assert.equal(local.secPerCall('verify', { RERECORD_TIME_SCALE: 'abc' }), local.SEC_PER_CALL.verify, '非法值不理會');
        assert.equal(local.secPerEmbed({ RERECORD_SEC_PER_EMBED: '0.25' }), 0.25);
    });

    test('estimateLocalTime：下限＝看得到的呼叫＋向量；上限再加下游與本機拆題鏈上看不到的步驟；e2e 的 LLM 不算', () => {
        const ev = (suite, extra) => ({ suite, ...extra });
        const events = [
            ev('classify', { kind: 'start' }),
            ev('classify', { kind: 'llm', agent: 'classify', model: 'qwen3-vl:8b', key: 'a'.repeat(64), hit: false, cacheKeyParts: { q: 1 } }),
            ev('classify', { kind: 'llm', agent: 'classify', model: 'qwen3-vl:8b', key: 'b'.repeat(64), hit: false, cacheKeyParts: { q: 2 } }),
            ev('pipeline', { kind: 'start' }),
            ev('pipeline', { kind: 'llm', agent: 'ocr', model: null, key: 'c'.repeat(64), hit: false, cacheKeyParts: { pdfSha256: 'x' } }),
            ev('nlq', { kind: 'start' }),
            ev('nlq', { kind: 'embed', hash: 'h1', hit: false, chars: 10 }),
            ev('e2e', { kind: 'start' }),
            ev('e2e', { kind: 'llm', agent: 'ocr', model: null, key: 'c'.repeat(64), hit: false, cacheKeyParts: { pdfSha256: 'x' } })
        ];
        // 一支舊的 Gemini verify cassette（下游被擋，這一輪看不到）
        const entries = [{ agent: 'verify', key: 'd'.repeat(64), model: 'gemini-3.1-pro-preview', cacheKeyParts: { old: 1 }, usage: null, keyValid: true }];
        const summary = audit.summarize({ events, entries, suites: ['classify', 'pipeline', 'nlq', 'e2e'], runs: {}, extraEmbedGaps: [{ id: 1, hash: 'h2', chars: 5 }] });
        const env = {};
        const t = local.estimateLocalTime(summary, { env });
        const S = local.SEC_PER_CALL;
        // 向量：第 1 步補 2 段（h1 探針看到、h2 靜態缺口）＋ nlq 錄製時逐段重算 1 段
        const embed = 3 * local.DEFAULT_SEC_PER_EMBED;
        assert.equal(t.embedSec, embed);
        assert.equal(t.lowerSec, 2 * S.classify + S.ocr + embed);
        assert.equal(t.upperSec, t.lowerSec + S.verify + S.extract_vision + S.extract_ocr, 'ocr miss 之後，同一塊的視覺版與 OCR 版這一輪看不到');
        assert.equal(t.bySuite.e2e, 0, 'e2e 的呼叫由 pipeline 那一步錄');
        assert.equal(t.calls.classify, 2);

        const text = formatSummary({ summary, inventory: { dir: '/tmp/c', skipped: [] }, models: { MODEL_EXTRACT: 'ollama:qwen3-vl:8b', MODEL_VERIFY: 'ollama:qwen3:8b', source: 'test' } }, { env });
        assert.match(text, /預估時間（本機，粗估）/);
        assert.match(text, /本機模型費用 \$0/);
        assert.match(text, /RERECORD_TIME_SCALE/);
        assert.doesNotMatch(text, /估計費用/);
        const gem = formatSummary({ summary, inventory: { dir: '/tmp/c', skipped: [] }, models: { MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b', source: 'test' } }, { env });
        assert.match(gem, /估計費用/, 'Gemini 路徑的盤點表照舊印費用');
    });

    test('formatDuration', () => {
        assert.equal(local.formatDuration(42), '42 秒');
        assert.equal(local.formatDuration(125), '2 分');
        assert.equal(local.formatDuration(3600), '1 小時');
        assert.equal(local.formatDuration(3 * 3600 + 20 * 60), '3 小時 20 分');
        assert.equal(local.formatDuration(-5), '0 秒');
    });
});
