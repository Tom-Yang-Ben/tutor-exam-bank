// ─────────────────────────────────────────────────────────────
// test/unit/localBenchVision.test.js — 看圖拆題的本機量測（eval/tools/local_bench_vision.js，npm run local:bench-vision）
//
// 驗證：
//   1. 參數與預設（sample_exam.pdf 第 1 頁、200 DPI、先卸載、逾時 180 分、每 60 秒印進度）；
//   2. 送出的請求與 agents/extract.js 的 extract_vision 一模一樣（系統提示詞、提示詞、schema、輸出上限、每頁一張 PNG）；
//   3. 推估：線性外推與 --baseline（固定文字＋每頁圖片）、一塊 1 頁／N 頁、一份 4 頁卷、建議逾時、num_ctx 警告；
//   4. 不寫 cassette、不碰資料庫（LLM_MODE=record 也一樣）；
//   5. 對 127.0.0.1 上的假 Ollama 跑一次真的流程（卸載 → 串流呼叫 → 報告）。
// 不需要 Ollama；圖片用 sharp 當場造。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');

const bench = require('../../eval/tools/local_bench_vision');
const extract = require('../../agents/extract');
const { buildSchema } = require('../../agents/schemas');
const ollama = require('../../services/llm/ollama');

const APP_DIR = path.resolve(__dirname, '..', '..');
const MIN = 60_000;

let tmp;
let png;
const savedEnv = {};
const ENV_KEYS = ['LLM_MODE', 'EVAL_CASSETTE_DIR', 'OLLAMA_HOST', 'OLLAMA_PROGRESS_MS', 'VISION_MAX_EDGE_PX', 'MODEL_EXTRACT'];

before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '看圖量測-'));
    png = await sharp({ create: { width: 1654, height: 2339, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    ollama._resetForTest();
});

/** Owner 實機的 .env（OLLAMA_TIMEOUT_MS 30 分；其餘沒寫＝本機預設） */
const OWNER_ENV = Object.freeze({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b', OLLAMA_TIMEOUT_MS: '1800000', OLLAMA_NUM_CTX: '16384', OCR_DPI: '200' });

/** 量到的一頁：載入 12 秒、讀 prompt 10 分（3,000 token）、輸出 17 分（1,500 token） */
const TIMING = Object.freeze({ totalMs: 1_632_000, loadMs: 12_000, promptEvalMs: 600_000, evalMs: 1_020_000 });
const USAGE = Object.freeze({ tokenIn: 3000, tokenOut: 1500, tokenThinking: 0, tokenCached: 0, timing: TIMING });

function fakes({ generate, unload } = {}) {
    const seen = { order: [], generate: [], unload: [], render: [] };
    let t = 0;
    return {
        seen,
        io: {
            env: OWNER_ENV,
            cwd: APP_DIR,
            now: () => { t += 1_700_000; return t; },
            stdout: { write: (s) => { seen.out = (seen.out || '') + s; } },
            renderPages: async (opts) => { seen.order.push('render'); seen.render.push(opts); return [png]; },
            unloadModel: async (o) => { seen.order.push('unload'); seen.unload.push(o); if (unload) return unload(o); return { done_reason: 'unload' }; },
            generateJson: async (o) => {
                seen.order.push('generate');
                seen.generate.push(o);
                if (generate) return generate(o, seen.generate.length);
                return { data: { questions: [{}, {}, {}] }, usage: USAGE, latencyMs: 1, raw: null, schemaFallback: false };
            }
        }
    };
}

describe('parseArgs', () => {
    test('預設：sample_exam.pdf 第 1 頁、DPI 與縮圖照 .env、先卸載、不做 baseline、逾時 180 分、60 秒印一次進度', () => {
        assert.deepEqual(bench.parseArgs([]), {
            pdf: bench.DEFAULT_PDF, from: 1, pages: 1, dpi: null, maxEdge: null, model: null,
            baseline: false, warm: false, timeoutMin: 180, progressSec: 60, help: false
        });
        assert.equal(bench.DEFAULT_PDF, path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf'));
    });

    test('--pdf 相對路徑以 cwd 為準（中文路徑）；--pages 上限 4；--max-edge 0 或 ≥512；錯的值擋下', () => {
        const a = bench.parseArgs(['--pdf', '考卷/第一次段考.pdf', '--pages', '2', '--from', '3', '--dpi', '150', '--max-edge', '1600', '--baseline', '--warm', '--timeout-min', '240', '--progress-sec', '0'], { cwd: tmp });
        assert.equal(a.pdf, path.join(tmp, '考卷', '第一次段考.pdf'));
        assert.deepEqual([a.pages, a.from, a.dpi, a.maxEdge, a.baseline, a.warm, a.timeoutMin, a.progressSec], [2, 3, 150, 1600, true, true, 240, 0]);
        assert.equal(bench.parseArgs(['--max-edge', '0']).maxEdge, 0);
        assert.throws(() => bench.parseArgs(['--pages', '5']), /1～4/);
        assert.throws(() => bench.parseArgs(['--pages', '0']), /1～4/);
        assert.throws(() => bench.parseArgs(['--max-edge', '300']), /看不清題目/);
        assert.throws(() => bench.parseArgs(['--dpi', 'abc']), /整數/);
        assert.throws(() => bench.parseArgs(['--pdf']), /後面要接一個值/);
        assert.throws(() => bench.parseArgs(['--cassette']), /未知的參數/);
    });

    test('package.json 的 local:bench-vision', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['local:bench-vision'], 'node eval/tools/local_bench_vision.js');
    });
});

describe('estimate：推估一塊與一份卷', () => {
    const settings = (over = {}) => bench.currentSettings({ ...OWNER_ENV, ...over });
    const M = { pages: 1, loadMs: 12_000, promptEvalMs: 600_000, evalMs: 1_020_000, tokenIn: 3000, tokenOut: 1500 };

    test('線性外推：一塊 n 頁＝載入＋n ×（每頁讀 prompt＋每頁輸出）；一份 4 頁卷＝每塊各含一次載入', () => {
        const e = bench.estimate(M, settings());
        assert.equal(e.method, 'linear');
        assert.equal(e.onePage.ms, 12_000 + 1_620_000);
        assert.equal(e.current.pages, 2, 'JOB_PDF_CHUNK_PAGES 沒寫＝本機預設 2');
        assert.equal(e.current.ms, 12_000 + 2 * 1_620_000);
        assert.deepEqual([e.paper.pages, e.paper.chunks, e.paper.ms], [4, 2, 2 * (12_000 + 2 * 1_620_000)]);
        assert.equal(e.current.needTimeoutMs, 109 * MIN, '2 × 54 分 12 秒 = 108 分 24 秒 → 進位到 109 分');
        assert.deepEqual([e.current.tokensIn, e.current.tokensOut], [6000, 3000]);
        assert.equal(e.ctx.over, false);
        assert.equal(e.ctx.overWithMax, false, '6000 + 8192 < 16384');
        const one = bench.estimate(M, settings({ JOB_PDF_CHUNK_PAGES: '1' }));
        assert.equal(one.current.pages, 1);
        assert.deepEqual([one.paper.chunks, one.paper.ms], [4, 4 * (12_000 + 1_620_000)]);
        const three = bench.estimate(M, settings({ JOB_PDF_CHUNK_PAGES: '3' }));
        assert.equal(three.paper.ms, (12_000 + 3 * 1_620_000) + (12_000 + 1_620_000), '4 頁切成 3＋1');
    });

    test('--baseline：固定文字只算一次，每頁只乘圖片；baseline 不合理（比整次還久）就退回線性', () => {
        const e = bench.estimate(M, settings(), { baseline: { promptEvalMs: 200_000, tokenIn: 2000 } });
        assert.equal(e.method, 'baseline');
        assert.deepEqual(e.fixed, { promptEvalMs: 200_000, tokenIn: 2000 });
        assert.equal(e.perPage.promptEvalMs, 400_000);
        assert.equal(e.perPage.tokenIn, 1000);
        assert.equal(e.current.ms, 12_000 + 200_000 + 2 * (400_000 + 1_020_000));
        assert.equal(e.current.tokensIn, 2000 + 2 * 1000);
        for (const bad of [{ promptEvalMs: 700_000, tokenIn: 2000 }, { promptEvalMs: 100, tokenIn: 5000 }, { promptEvalMs: null, tokenIn: 1 }, null]) {
            assert.equal(bench.estimate(M, settings(), { baseline: bad }).method, 'linear', JSON.stringify(bad));
        }
    });

    test('num_ctx：一塊的讀＋寫超過就 over；讀＋輸出上限（8192）超過就 overWithMax', () => {
        const over = bench.estimate({ ...M, tokenIn: 7000, tokenOut: 1500 }, settings());
        assert.deepEqual([over.current.tokensIn, over.current.tokensOut], [14000, 3000]);
        assert.equal(over.ctx.over, true, '讀 14000＋寫 3000＝17000 > 16384');
        const tight = bench.estimate({ ...M, tokenIn: 5000, tokenOut: 500 }, settings());
        assert.equal(tight.ctx.over, false, '10000＋1000 放得下');
        assert.equal(tight.ctx.overWithMax, true, '10000＋8192＝18192 > 16384');
        assert.equal(bench.estimate({ ...M, tokenIn: 5000, tokenOut: 500 }, settings({ OLLAMA_NUM_CTX: '32768' })).ctx.overWithMax, false);
    });

    test('報告：num_ctx 放不下時講明怎麼辦', async () => {
        const over = fakes({ generate: () => ({ data: { questions: [] }, usage: { ...USAGE, tokenIn: 7000 } }) });
        await bench.main([], over.io);
        assert.match(over.seen.out, /⚠️ 一塊 2 頁估計要讀 14,000、寫 3,000 token，超過 `OLLAMA_NUM_CTX`=16384/);
        const tight = fakes({ generate: () => ({ data: { questions: [] }, usage: { ...USAGE, tokenIn: 5000, tokenOut: 500 } }) });
        await bench.main([], tight.io);
        assert.match(tight.seen.out, /注意：一塊 2 頁估計讀 10,000 token，加上輸出上限 8192 會超過 `OLLAMA_NUM_CTX`=16384/);
    });
});

describe('main（注入假的 Ollama）', () => {
    test('先卸載再呼叫一次；請求與 extract_vision 一模一樣；印出分段時間、推估與建議；結束碼 0', async () => {
        const { io, seen } = fakes();
        const code = await bench.main([], io);
        assert.equal(code, 0, seen.out);
        assert.deepEqual(seen.order, ['render', 'unload', 'generate'], '卸載在呼叫之前；只呼叫一次');
        assert.deepEqual(seen.unload, [{ model: 'qwen3-vl:8b' }]);
        assert.deepEqual(seen.render[0].fromPage, 1);
        assert.equal(seen.render[0].toPage, 1);
        assert.equal(seen.render[0].dpi, 200);

        const g = seen.generate[0];
        assert.equal(g.model, 'qwen3-vl:8b', '裸 ID');
        assert.equal(g.system, extract.SYSTEM);
        assert.equal(g.parts[0].text, extract.buildLocalPrompt('math_physics', 'vision', { fromPage: 1, toPage: 1 }));
        assert.deepEqual(g.parts.slice(1), [{ imageBase64: png.toString('base64'), mimeType: 'image/png' }]);
        assert.equal(g.schema, buildSchema('extract'));
        assert.equal(g.maxOutputTokens, extract.LOCAL_MAX_OUTPUT_TOKENS);
        assert.equal(g.timeoutMs, 180 * MIN, '量測自己的逾時，不受 .env 的 30 分限制');
        assert.equal(g.progressMs, 60_000);
        assert.equal(typeof g.onProgress, 'function');

        const out = seen.out;
        assert.match(out, /模型：qwen3-vl:8b（Ollama http:\/\/127\.0\.0\.1:11434）/);
        assert.match(out, /PDF：eval\/fixtures\/sample_exam\.pdf 第 1 頁（1 頁、一次送出），200 DPI/);
        assert.match(out, /圖片：1654×2339 px、\d+ KB（沒有縮圖）/);
        assert.match(out, /設定：OLLAMA_NUM_CTX=16384（\.env）、JOB_PDF_CHUNK_PAGES=2（本機預設）、OLLAMA_TIMEOUT_MS=1800000（30 分，\.env）、JOB_NODE_TIMEOUT_MS=2700000（45 分，本機預設）/);
        assert.match(out, /結果：拆出 3 題（JSON 合法）/);
        assert.match(out, /\| 載入模型 \| 12 秒 \| — \| — \|/);
        assert.match(out, /\| 讀 prompt（系統提示詞＋章節白名單＋1 頁圖片） \| 10 分 \| 3,000 \| 5\.0 token\/秒 \|/);
        assert.match(out, /\| 輸出（含思考） \| 17 分 \| 1,500 \| 1\.5 token\/秒 \|/);
        assert.match(out, /\| 一塊 1 頁（JOB_PDF_CHUNK_PAGES=1） \| 27 分 12 秒 \| 3,000／1,500 \| 在逾時之內 \|/);
        assert.match(out, /\| 一塊 2 頁（目前的 JOB_PDF_CHUNK_PAGES） \| 54 分 12 秒 \| 6,000／3,000 \| \*\*超過\*\*（估 54 分 12 秒 > 30 分） \|/);
        assert.match(out, /\| 一份 4 頁卷（2 塊，只算看圖） \| 1 小時 48 分 \| — \| 每一塊各自計時 \|/);
        assert.match(out, /`OLLAMA_TIMEOUT_MS` 至少 6540000（1 小時 49 分＝2 × 一塊 2 頁的估計，進位到分）；目前 1800000（30 分）→ \*\*不夠\*\*/);
        assert.match(out, /`JOB_NODE_TIMEOUT_MS` 要比 `OLLAMA_TIMEOUT_MS` 再多出 OCR 與 OCR 整理的時間.*目前 2700000（45 分），\*\*光是看圖這一步的估計就超過它\*\*/);
        assert.match(out, /輸出比讀 prompt 久：一塊少放幾頁（選項 a）/);
    });

    test('--max-edge：送出前縮圖（報告列出原圖與縮後的大小）；--warm 不卸載；--baseline 多一次只有文字、輸出 1 token 的呼叫（前面再卸載一次）', async () => {
        const { io, seen } = fakes({
            generate: (o, n) => {
                if (n === 1) return { data: { questions: [] }, usage: USAGE };
                assert.deepEqual(o.parts, [{ text: extract.buildLocalPrompt('math_physics', 'vision', { fromPage: 1, toPage: 1 }) }], 'baseline 只有文字');
                assert.equal(o.maxOutputTokens, 1);
                assert.equal(o.progressMs, 0);
                throw Object.assign(new Error('Ollama 回了空字串'), {
                    errorClass: 'schema_invalid',
                    usage: { tokenIn: 2000, tokenOut: 1, tokenThinking: 0, tokenCached: 0, timing: { totalMs: 210_000, loadMs: 10_000, promptEvalMs: 200_000, evalMs: 0 } }
                });
            }
        });
        const code = await bench.main(['--max-edge', '1600', '--warm', '--baseline'], io);
        assert.equal(code, 0, seen.out);
        assert.deepEqual(seen.order, ['render', 'generate', 'unload', 'generate'], '--warm：第一次不卸載；--baseline 前卸載一次');
        const sent = await sharp(Buffer.from(seen.generate[0].parts[1].imageBase64, 'base64')).metadata();
        assert.equal(Math.max(sent.width, sent.height), 1600);
        assert.match(seen.out, /（送出前長邊縮到 1600 px；原圖 1654×2339）/);
        assert.match(seen.out, /沒有先卸載（--warm）/);
        assert.match(seen.out, /\| 　其中固定的文字（--baseline 量的） \| 3 分 20 秒 \| 2,000 \|/);
        assert.match(seen.out, /\| 　其中圖片（每頁） \| 6 分 40 秒 \| 1,000 \|/);
        assert.match(seen.out, /推估（只算看圖拆題 extract_vision 一步；固定文字＋每頁圖片/);
    });

    test('JSON 不合法（被輸出上限截斷）：時間照樣算、結束碼 0；逾時：講明、建議、結束碼 1', async () => {
        const bad = fakes({ generate: () => { throw Object.assign(new Error('Unexpected end of JSON input'), { errorClass: 'schema_invalid', usage: USAGE, finishReason: 'MAX_TOKENS' }); } });
        assert.equal(await bench.main([], bad.io), 0);
        assert.match(bad.seen.out, /JSON 不合法（finishReason MAX_TOKENS：寫到輸出上限被截斷）——下面的時間照樣有效/);
        assert.match(bad.seen.out, /\| 一塊 2 頁（目前的 JOB_PDF_CHUNK_PAGES） \| 54 分 12 秒/);

        const slow = fakes({ generate: () => { throw Object.assign(new Error('Ollama 呼叫超過這次指定的逾時（10800000 ms）仍未完成：/api/chat(qwen3-vl:8b)'), { errorClass: 'timeout' }); } });
        assert.equal(await bench.main(['--timeout-min', '180'], slow.io), 1);
        assert.match(slow.seen.out, /❌ 沒有量到：Ollama 呼叫超過這次指定的逾時/);
        assert.match(slow.seen.out, /一頁在 3 小時 內都沒有做完。可以：加大 --timeout-min 再量一次；或先試選項 b（--max-edge 1600）/);
    });

    test('模型不是 ollama：直接拒絕，不轉圖、不呼叫；PDF 頁數不夠：講明', async () => {
        const { io, seen } = fakes();
        await assert.rejects(() => bench.main([], { ...io, env: { MODEL_EXTRACT: 'gemini:gemini-3.5-flash' } }), /只量本機模型/);
        assert.deepEqual(seen.order, []);
        await assert.rejects(() => bench.main(['--pages', '2'], io), /這份 PDF 只有 1 頁/);
        await assert.rejects(() => bench.main(['--pdf', path.join(tmp, '沒有.pdf')], io), /找不到 PDF/);
    });

    test('不寫 cassette、不碰資料庫：LLM_MODE=record 也一樣（直接呼叫 ollama adapter，不經 services/llm）', async () => {
        process.env.LLM_MODE = 'record';
        process.env.EVAL_CASSETTE_DIR = path.join(tmp, 'cassettes-不該出現');
        try {
            const { io } = fakes();
            assert.equal(await bench.main([], io), 0);
        } finally {
            delete process.env.LLM_MODE;
            delete process.env.EVAL_CASSETTE_DIR;
        }
        assert.equal(fs.existsSync(path.join(tmp, 'cassettes-不該出現')), false);
        const loaded = Object.keys(require.cache).map(f => path.relative(APP_DIR, f).split(path.sep).join('/'));
        assert.ok(!loaded.includes('config/db.js'), '沒有載入資料庫模組');
        assert.ok(!loaded.includes('services/llm/index.js'), '沒有經過 services/llm 的 record／replay');
        const src = fs.readFileSync(path.join(APP_DIR, 'eval', 'tools', 'local_bench_vision.js'), 'utf8');
        assert.ok(!/require\(['"][./]*services\/llm['"]\)/.test(src), '原始碼也不 require services/llm（index）');
        assert.ok(!/writeCassette|config\/db/.test(src));
    });
});

describe('對 127.0.0.1 上的假 Ollama 跑一次（卸載 → 串流 → 報告）', () => {
    let server;
    let port;
    const hits = [];

    before(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', async () => {
                const body = JSON.parse(raw);
                hits.push({ url: req.url, body: { ...body, messages: undefined }, images: body.messages ? body.messages[1].images.length : 0 });
                res.writeHead(200, { 'content-type': 'application/json' });
                if (req.url === '/api/generate') return res.end(JSON.stringify({ model: body.model, done: true, done_reason: 'unload' }));
                const done = {
                    model: body.model, created_at: '2026-09-26T00:00:00Z', done: true, done_reason: 'stop',
                    total_duration: 1_632e9, load_duration: 12e9, prompt_eval_count: 3000, prompt_eval_duration: 600e9, eval_count: 1500, eval_duration: 1_020e9
                };
                const content = '{"questions":[]}';
                if (!body.stream) return res.end(JSON.stringify({ ...done, message: { role: 'assistant', content } }));
                for (const ch of content) {
                    res.write(`${JSON.stringify({ model: body.model, done: false, message: { role: 'assistant', content: ch } })}\n`);
                    await new Promise(r => setImmediate(r));
                }
                res.end(`${JSON.stringify({ ...done, message: { role: 'assistant', content: '' } })}\n`);
            });
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
    });

    test('真的 ollama adapter：先 /api/generate 卸載（keep_alive:0），再 /api/chat stream:true；報告照 Ollama 的分段時間', async () => {
        process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
        ollama._resetForTest();
        let out = '';
        const code = await bench.main(['--progress-sec', '1'], {
            env: { ...OWNER_ENV, OLLAMA_HOST: `http://127.0.0.1:${port}` },
            cwd: APP_DIR,
            stdout: { write: (s) => { out += s; } }
        });
        assert.equal(code, 0, out);
        assert.deepEqual(hits.map(h => h.url), ['/api/generate', '/api/chat']);
        assert.deepEqual(hits[0].body, { model: 'qwen3-vl:8b', keep_alive: 0, messages: undefined });
        assert.equal(hits[1].body.stream, true, '串流，印得出進度');
        assert.equal(hits[1].body.options.num_predict, extract.LOCAL_MAX_OUTPUT_TOKENS);
        assert.equal(hits[1].images, 1, 'sample_exam.pdf 第 1 頁一張圖');
        assert.match(out, /\[ollama\] \/api\/chat\(qwen3-vl:8b\) 完成：載入模型 12 秒；讀 prompt 3000 token 用 10 分/);
        assert.match(out, /結果：拆出 0 題（JSON 合法）/);
        assert.match(out, /\| 一塊 2 頁（目前的 JOB_PDF_CHUNK_PAGES） \| 54 分 12 秒/);
    });
});
