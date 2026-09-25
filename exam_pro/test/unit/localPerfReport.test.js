// ─────────────────────────────────────────────────────────────
// test/unit/localPerfReport.test.js — 本機效能實測工具（eval/tools/local_perf_report.js，npm run perf:local）
//
// 在暫存目錄（路徑含中文）造幾支假 cassette 與一段假 record log，驗證：
//   1. 參數；2. 讀 cassette、供應商判斷、--since、頁數（圖片張數；extract_ocr 對同一塊）；
//   3. 分組、百分位數（nearest-rank）與「樣本少」的門檻（n < 10 時 p90＝max）、輸出速度（Σtoken ÷ Σ秒）；
//   4. record log 的段落與耗時；
//   5. 建議的規則（逾時安全值、節點相加、RERECORD_TIME_SCALE、每塊頁數：外推到比錄製時少的頁數會低估、
//      1 頁也不夠時列出實際錄到的每塊最長）；6. 報告與 --out；
//   7. 本工具抄的預設值、步驟標籤與原始程式一致。
// 不呼叫模型、不連網、不讀 exam_pro/.env（env 一律注入）。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perf = require('../../eval/tools/local_perf_report');
const local = require('../../eval/lib/localMode');

const APP_DIR = path.resolve(__dirname, '..', '..');
const SEC = 1000;
const PDF = 'a'.repeat(64);
const T0 = Date.parse('2026-09-26T01:00:00.000Z');

let tmp;
let cassetteDir;
let logFile;

/** 寫一支 cassette（形狀同 services/llm/index.js、services/ocr/index.js 在 record 模式寫的） */
function writeCassette(root, agent, name, { model, kind, recordedAt, latencyMs, usage, parts, cacheKeyParts, pages, raw }) {
    const dir = path.join(root, agent);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    if (raw !== undefined) { fs.writeFileSync(file, raw); return file; }
    const meta = { agent, model, template: `${agent}.v1`, ...(kind ? { kind } : {}), fixtureHash: null };
    if (recordedAt !== undefined) meta.recorded_at = new Date(recordedAt).toISOString();
    const response = kind === 'ocr'
        ? { engine: 'paddleocr', engine_version: '3.7.0', dpi: 200, pages: pages.map(p => ({ page: p, markdown: '…' })), ...(latencyMs ? { latencyMs } : {}) }
        : { data: {}, usage, ...(latencyMs ? { latencyMs } : {}) };
    const request = kind === 'ocr'
        ? { pdf: { bytes: 1, sha256: PDF }, cacheKeyParts }
        : { parts: parts || [{ kind: 'text', chars: 10, sha256: 'x' }], cacheKeyParts: cacheKeyParts || {} };
    fs.writeFileSync(file, JSON.stringify({ meta, request, response }, null, 2));
    return file;
}

const img = { kind: 'image', mimeType: 'image/png', bytes: 100, sha256: 'i' };
const text = { kind: 'text', chars: 100, sha256: 't' };

/**
 * 造一組「本機重錄」的 cassette（數字刻意取整，下面的期望值可以心算）：
 *   ocr            2 支，每支 2 頁，100／140 秒
 *   extract_vision 2 支，每支 2 張圖（2 頁），600／900 秒，輸入 5000、輸出 1500 token
 *   extract_ocr    2 支（同一塊 → 2 頁），300／420 秒，輸入 4000、輸出 1500
 *   classify      10 支，10～100 秒，輸出 150 token；另有 Gemini 錄的 2 支（預設不算）
 *   verify         5 支，200～600 秒
 *   variant        1 支，250 秒，沒有 recorded_at（用檔案時間 2026-09-20）
 *   nlq            1 支，沒有 latencyMs；lint 1 支壞掉的 JSON
 */
function buildFixture(root) {
    let t = T0;
    const next = (latMs) => { t += latMs + 5 * SEC; return t; };   // 一支接一支，不重疊
    for (const [i, lat] of [100, 140].entries()) {
        writeCassette(root, 'ocr', `ocr${i}`, {
            model: 'paddleocr@3.7.0', kind: 'ocr', latencyMs: lat * SEC, recordedAt: next(lat * SEC),
            pages: [2 * i + 1, 2 * i + 2], cacheKeyParts: { pdfSha256: PDF, fromPage: 2 * i + 1, toPage: 2 * i + 2, dpi: 200 }
        });
    }
    for (const [i, lat] of [600, 900].entries()) {
        writeCassette(root, 'extract_vision', `v${i}`, {
            model: 'qwen3-vl:8b', latencyMs: lat * SEC, recordedAt: next(lat * SEC), parts: [text, img, img],
            usage: { tokenIn: 5000, tokenOut: 1500, tokenThinking: 0, tokenCached: 0 },
            cacheKeyParts: { template: 'extract_vision.v1', chunkNo: i + 1, pdfSha256: PDF }
        });
    }
    for (const [i, lat] of [300, 420].entries()) {
        writeCassette(root, 'extract_ocr', `o${i}`, {
            model: 'qwen3:8b', latencyMs: lat * SEC, recordedAt: next(lat * SEC),
            usage: { tokenIn: 4000, tokenOut: 1500, tokenThinking: 0, tokenCached: 0 },
            cacheKeyParts: { template: 'extract_ocr.v1', chunkNo: i + 1, pdfSha256: PDF, ocrSha256: 'b'.repeat(64) }
        });
    }
    for (let i = 1; i <= 10; i++) {
        writeCassette(root, 'classify', `c${String(i).padStart(2, '0')}`, {
            model: 'qwen3:8b', latencyMs: i * 10 * SEC, recordedAt: next(i * 10 * SEC),
            usage: { tokenIn: 2000, tokenOut: 150, tokenThinking: 0, tokenCached: 0 }
        });
    }
    for (let i = 0; i < 2; i++) {
        writeCassette(root, 'classify', `gemini${i}`, {
            model: 'gemini-3.5-flash', latencyMs: 3 * SEC, recordedAt: Date.parse('2026-08-23T12:00:00Z') + i * 60 * SEC,
            usage: { tokenIn: 1900, tokenOut: 58, tokenThinking: 500, tokenCached: 0 }
        });
    }
    for (let i = 2; i <= 6; i++) {
        writeCassette(root, 'verify', `r${i}`, {
            model: 'qwen3:8b', latencyMs: i * 100 * SEC, recordedAt: next(i * 100 * SEC),
            usage: { tokenIn: 300, tokenOut: 1000, tokenThinking: 0, tokenCached: 0 }
        });
    }
    const variant = writeCassette(root, 'variant', 'noTime', {
        model: 'qwen3:8b', latencyMs: 250 * SEC, usage: { tokenIn: 1200, tokenOut: 300, tokenThinking: 0, tokenCached: 0 }
    });
    const mtime = new Date('2026-09-20T10:00:00Z');
    fs.utimesSync(variant, mtime, mtime);
    writeCassette(root, 'nlq', 'noLatency', { model: 'qwen3:8b', recordedAt: next(0), usage: { tokenIn: 600, tokenOut: 50, tokenThinking: 0 } });
    writeCassette(root, 'lint', 'broken', { raw: '{ 這不是 JSON' });
    fs.writeFileSync(path.join(root, 'README.txt'), '不是目錄，略過');
}

/** 一段 record log（record_local.bat → tee_run.js → rerecord_all.js 的輸出；CRLF，後面接著第二輪、中途被關掉） */
const LOG_TEXT = [
    '----------------------------------------------------------------',
    '本機重錄開始 2026/09/26 週六 09:00:00.00',
    '[1/3] 啟動資料庫容器（npm run db:up）',
    '',
    '[2026-09-26 09:00:00] > npm run db:up',
    ' Container exam-pg  Healthy',
    '[2026-09-26 09:00:05] 結束碼 0，5 秒',
    '[3/3] 重錄 cassette 與向量（npm run cassettes:rerecord ；自動輸入 yes）',
    '',
    '[2026-09-26 09:00:10] > npm run cassettes:rerecord',
    '',
    '══ 重錄前盤點（只回放、不連網） ══════════════════════════════════════════',
    '  · classify …',
    '✅ Ollama（http://127.0.0.1:11434）已就緒，需要的模型都在：qwen3-vl:8b、qwen3:8b',
    '確定要開始錄製嗎？請輸入 yes：',
    '══ 1/3 fixture 題缺的向量（只補缺的） ═════════════════════════════════════════',
    '[embed:record] 已寫入 3 筆向量 → eval/fixtures/embeddings.ollama-qwen3-embedding-0.6b.768.json',
    '  → 結束碼 0，12 秒',
    '',
    '══ 2/3 classify suite ═════════════════════════════════════════════',
    '[llm:record] 寫入 cassette → eval/cassettes/classify/x.json',
    'Error: Ollama 呼叫超過 OLLAMA_TIMEOUT_MS（1800000 ms）仍未完成：/api/chat(qwen3:8b)',
    '  → 結束碼 1，3456 秒（錄製模式下 eval 未達門檻也會回 1；以最後的回放驗證為準）',
    '',
    '══ 3/3 pipeline（extract 與後續節點；e2e 共用） ═══════════════════════════════',
    '{"node":"extract","msg":"節點 extract 超過 2700000 ms 未回應"}',
    '  → 結束碼 0，7200 秒',
    '',
    '══ 回放驗證（CI 的設定：replay／fixture） ═══════════════════════════',
    '| suite | 結束碼 | replay miss | 缺向量 | 門檻 |',
    '',
    '錄製步驟：embeddings=0（12 秒）、classify=1（3456 秒）、pipeline=0（7200 秒）',
    '[2026-09-26 12:15:00] 結束碼 1，11690 秒',
    '',
    '[2026-09-27 21:00:00] > npm run cassettes:rerecord -- --suites classify,nlq',
    '══ 1/2 classify suite ═════════════════════════════════════════════',
    '  → 結束碼 0，1800 秒',
    '══ 2/2 nlq suite（含查詢句向量） ══════════════════════════════════════',
    '[llm:record] 寫入 cassette → eval/cassettes/nlq/y.json',
    ''
].join('\r\n');

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '本機實測-'));
    cassetteDir = path.join(tmp, '錄好的 cassettes');
    buildFixture(cassetteDir);
    logFile = path.join(tmp, '記錄', 'record_20260926_090000.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `\uFEFF${LOG_TEXT}`, 'utf8');
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('parseArgs', () => {
    test('預設：eval/cassettes、只算本機、沒有 log／since／out', () => {
        const a = perf.parseArgs([]);
        assert.equal(a.cassettes, path.join(APP_DIR, 'eval', 'cassettes'));
        assert.deepEqual({ ...a, cassettes: null }, { cassettes: null, logs: [], since: null, vendor: 'ollama', out: null, help: false });
    });

    test('相對路徑以 cwd 為基準（可以含中文與空白）；--log 可以給好幾次', () => {
        const a = perf.parseArgs(['--cassettes', '錄好的 cassettes', '--log', 'a.log', '--log', '記錄/b.log', '--out', '報告/perf.md'], { cwd: tmp });
        assert.equal(a.cassettes, path.join(tmp, '錄好的 cassettes'));
        assert.deepEqual(a.logs, [path.join(tmp, 'a.log'), path.join(tmp, '記錄', 'b.log')]);
        assert.equal(a.out, path.join(tmp, '報告', 'perf.md'));
    });

    test('--since：只寫日期＝當天 0 點（本機時區）；帶時間照 Date；不合法就停', () => {
        assert.equal(perf.parseArgs(['--since', '2026-09-26']).since.getTime(), new Date(2026, 8, 26).getTime());
        assert.equal(perf.parseArgs(['--since', '2026-09-26T08:30']).since.getTime(), new Date(2026, 8, 26, 8, 30).getTime());
        assert.equal(perf.parseArgs(['--since', '2026-09-26T00:00:00Z']).since.getTime(), Date.parse('2026-09-26T00:00:00Z'));
        assert.throws(() => perf.parseArgs(['--since', '昨天']), /不是合法的時間/);
    });

    test('--vendor 只收 ollama／gemini／all（不分大小寫）；未知參數、少了值都停', () => {
        assert.equal(perf.parseArgs(['--vendor', 'ALL']).vendor, 'all');
        assert.equal(perf.parseArgs(['--vendor', 'gemini']).vendor, 'gemini');
        assert.throws(() => perf.parseArgs(['--vendor', 'openai']), /--vendor 只能是/);
        assert.throws(() => perf.parseArgs(['--fast']), /未知的參數/);
        assert.throws(() => perf.parseArgs(['--log']), /後面要接一個值/);
        assert.throws(() => perf.parseArgs(['--log', '--vendor', 'all']), /後面要接一個值/);
        assert.equal(perf.parseArgs(['-h']).help, true);
    });
});

describe('讀 cassette 與篩選', () => {
    test('供應商：OCR＝paddleocr；gemini-*／gemma-*＝gemini；其餘裸 ID＝ollama；沒有模型＝unknown', () => {
        assert.equal(perf.vendorOfCassette({ agent: 'ocr', model: 'paddleocr@3.7.0', kind: 'ocr' }), 'paddleocr');
        assert.equal(perf.vendorOfCassette({ agent: 'x', model: 'paddleocr@3.7.0' }), 'paddleocr');
        assert.equal(perf.vendorOfCassette({ agent: 'classify', model: 'gemini-3.5-flash' }), 'gemini');
        assert.equal(perf.vendorOfCassette({ agent: 'verify', model: 'gemini-3.1-pro-preview' }), 'gemini');
        assert.equal(perf.vendorOfCassette({ agent: 'classify', model: 'gemma-3-27b-it' }), 'gemini');
        assert.equal(perf.vendorOfCassette({ agent: 'classify', model: 'qwen3:8b' }), 'ollama');
        assert.equal(perf.vendorOfCassette({ agent: 'classify', model: 'gemma3:4b' }), 'ollama', 'Ollama 的 gemma 沒有連字號');
        assert.equal(perf.vendorOfCassette({ agent: 'classify', model: 'mistral' }), 'ollama');
        assert.equal(perf.vendorOfCassette({ agent: 'classify', model: '' }), 'unknown');
    });

    test('readCassettes：逐 agent 目錄讀；壞檔另列；頁數看圖片張數，extract_ocr 對同一塊補上', () => {
        const inv = perf.readCassettes(cassetteDir);
        assert.equal(inv.entries.length, 2 + 2 + 2 + 12 + 5 + 1 + 1);
        assert.equal(inv.broken.length, 1);
        assert.match(inv.broken[0].file, /lint[\\/]broken\.json$/);
        const byName = (agent) => inv.entries.filter(e => e.agent === agent);
        assert.deepEqual(byName('ocr').map(e => [e.pages, e.pagesFrom, e.vendor]), [[2, 'ocr', 'paddleocr'], [2, 'ocr', 'paddleocr']]);
        assert.deepEqual(byName('extract_vision').map(e => [e.pages, e.pagesFrom]), [[2, 'images'], [2, 'images']]);
        assert.deepEqual(byName('extract_ocr').map(e => [e.pages, e.pagesFrom]), [[2, 'chunk'], [2, 'chunk']]);
        assert.equal(byName('classify').filter(e => e.pages !== null).length, 0);
        const v = byName('variant')[0];
        assert.equal(v.timeSource, 'mtime');
        assert.equal(v.recordedAt, Date.parse('2026-09-20T10:00:00Z'));
        assert.equal(byName('nlq')[0].latencyMs, null);
        assert.throws(() => perf.readCassettes(path.join(tmp, '沒有這個目錄')), /找不到 cassette 目錄/);
    });

    test('selectEntries：預設只算本機（ollama＋paddleocr），沒有 latency 的不算；--since 看 recorded_at，沒有就看檔案時間', () => {
        const { entries } = perf.readCassettes(cassetteDir);
        const all = perf.selectEntries(entries);
        assert.equal(all.selected.length, 2 + 2 + 2 + 10 + 5 + 1);
        assert.deepEqual(all.skipped, { vendor: 2, byVendor: { gemini: 2 }, since: 0, noLatency: 1 });

        const since = perf.selectEntries(entries, { since: new Date('2026-09-25T00:00:00Z') });
        assert.equal(since.skipped.since, 1, '只有 variant 那支（檔案時間 9/20）在 --since 之前');
        assert.ok(!since.selected.some(e => e.agent === 'variant'));

        const gem = perf.selectEntries(entries, { vendor: 'gemini' });
        assert.deepEqual(gem.selected.map(e => e.model), ['gemini-3.5-flash', 'gemini-3.5-flash']);
        assert.equal(perf.selectEntries(entries, { vendor: 'all' }).selected.length, 22 + 2);
    });
});

describe('統計：百分位數、分組、速度', () => {
    test('percentile 用 nearest-rank：回傳的一定是量到的某一個值；順序不影響；空的回 null', () => {
        const xs = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
        assert.equal(perf.percentile(xs, 50), 5);
        assert.equal(perf.percentile(xs, 90), 9);
        assert.equal(perf.percentile(xs, 100), 10);
        assert.equal(perf.percentile(xs, 0), 1);
        assert.equal(perf.percentile([7], 90), 7);
        assert.equal(perf.percentile([1, 2], 50), 1);
        assert.equal(perf.percentile([1, 2], 90), 2);
        assert.equal(perf.percentile([], 50), null);
        assert.equal(perf.percentile([3, NaN, 1], 90), 3);
    });

    test('「樣本少」的門檻：nearest-rank 下 n < MIN_SAMPLES 時 p90 一定等於 max，n＝MIN_SAMPLES 起才不是', () => {
        assert.equal(perf.RULES.MIN_SAMPLES, 10);
        const upTo = (n) => Array.from({ length: n }, (_, i) => i + 1);
        for (let n = 1; n < perf.RULES.MIN_SAMPLES; n++) {
            assert.equal(perf.percentile(upTo(n), 90), n, `n=${n}：p90 應該就是最大值`);
        }
        assert.ok(perf.percentile(upTo(perf.RULES.MIN_SAMPLES), 90) < perf.RULES.MIN_SAMPLES, 'n=10：p90 是第 9 支，不是最大值');
        assert.equal(perf.LOW_SAMPLE_LABEL, '樣本少：p90 等於最大值');
    });

    test('statsOf 記下最慢那一次的頁數（maxCallPages）；不知道頁數時是 null', () => {
        const e = (latSec, pages) => ({ agent: 'extract_vision', model: 'm', vendor: 'ollama', latencyMs: latSec * SEC, usage: null, pages });
        const s = perf.statsOf({ agent: 'extract_vision', model: 'm', vendor: 'ollama', items: [e(100, 1), e(300, 3), e(200, 2)] });
        assert.deepEqual([s.maxMs, s.maxCallPages], [300 * SEC, 3]);
        const noPages = perf.statsOf({ agent: 'classify', model: 'm', vendor: 'ollama', items: [e(10, null), e(20, null)] });
        assert.deepEqual([noPages.maxMs, noPages.maxCallPages], [20 * SEC, null]);
    });

    test('依 agent＋模型分組；p50／p90／max；輸出速度＝Σ(tokenOut＋tokenThinking)÷Σ秒；每頁秒數', () => {
        const { entries } = perf.readCassettes(cassetteDir);
        const groups = perf.summarizeGroups(perf.selectEntries(entries).selected);
        assert.deepEqual(groups.map(g => g.agent), ['ocr', 'extract_vision', 'extract_ocr', 'classify', 'verify', 'variant'], '本機拆題鏈排在前面');

        const c = groups.find(g => g.agent === 'classify');
        assert.equal(c.n, 10);
        assert.equal(c.model, 'qwen3:8b');
        assert.equal(c.p50Ms, 50 * SEC);
        assert.equal(c.p90Ms, 90 * SEC);
        assert.equal(c.maxMs, 100 * SEC);
        assert.equal(c.meanMs, 55 * SEC);
        assert.ok(Math.abs(c.tokensPerSec - 1500 / 550) < 1e-9, `${c.tokensPerSec}`);
        assert.equal(c.avgTokenIn, 2000);
        assert.equal(c.pages, null);

        const v = groups.find(g => g.agent === 'extract_vision');
        assert.equal(v.pages.pages, 4);
        assert.equal(v.pages.secPerPage, 1500 / 4);
        assert.equal(v.pages.p90SecPerPage, 450);
        assert.equal(v.pages.tokensPerPage, 6500 * 2 / 4);
        assert.equal(v.tokensPerSec, 3000 / 1500);

        const o = groups.find(g => g.agent === 'ocr');
        assert.equal(o.tokensPerSec, null, 'OCR 沒有 token');
        assert.equal(o.pages.secPerPage, 240 / 4);

        // Gemini 與本機同一個 agent：byModel 分開列
        const both = perf.summarizeGroups(perf.selectEntries(entries, { vendor: 'all' }).selected);
        assert.deepEqual(both.filter(g => g.agent === 'classify').map(g => [g.model, g.n]), [['gemini-3.5-flash', 2], ['qwen3:8b', 10]]);
        const merged = perf.summarizeGroups(perf.selectEntries(entries, { vendor: 'all' }).selected, { byModel: false });
        assert.equal(merged.find(g => g.agent === 'classify').n, 12);
    });

    test('Gemini 的思考 token 另計：輸出速度把 tokenThinking 加進去', () => {
        const e = perf.toEntry({ meta: { agent: 'classify', model: 'gemini-3.5-flash', recorded_at: '2026-08-23T00:00:00Z' },
            request: { parts: [text] }, response: { usage: { tokenIn: 100, tokenOut: 50, tokenThinking: 150 }, latencyMs: 2000 } });
        const s = perf.statsOf({ agent: 'classify', model: e.model, vendor: e.vendor, items: [e] });
        assert.equal(s.tokensPerSec, 100);
        assert.equal(s.avgTokenOut, 200);
    });

    test('countOverlaps：一支接一支是 0；時間重疊（並行呼叫、latency 含排隊）才算', () => {
        const { entries } = perf.readCassettes(cassetteDir);
        assert.equal(perf.countOverlaps(perf.selectEntries(entries).selected), 0);
        const mk = (endSec, latSec) => ({ timeSource: 'meta', recordedAt: T0 + endSec * SEC, latencyMs: latSec * SEC });
        assert.equal(perf.countOverlaps([mk(100, 100), mk(200, 100)]), 0, '首尾相接不算');
        assert.equal(perf.countOverlaps([mk(100, 100), mk(150, 100), mk(160, 100)]), 2);
        assert.equal(perf.countOverlaps([mk(100, 100), { timeSource: 'mtime', recordedAt: T0 + 150 * SEC, latencyMs: 100 * SEC }]), 0, '檔案時間不準，不拿來判斷');
    });
});

describe('record log', () => {
    test('段落標頭與「→ 結束碼 x，N 秒」配對；認得步驟名；n 沒往前走就是新的一輪；沒有結束紀錄的標出來', () => {
        const log = perf.parseRecordLog(fs.readFileSync(logFile, 'utf8'));
        assert.equal(log.runs.length, 2);
        assert.deepEqual(log.runs[0].steps.map(s => [s.index, s.total, s.name, s.exitCode, s.sec]), [
            [1, 3, 'embeddings', 0, 12],
            [2, 3, 'classify', 1, 3456],
            [3, 3, 'pipeline', 0, 7200]
        ]);
        assert.equal(log.runs[0].steps[2].label, 'pipeline（extract 與後續節點；e2e 共用）');
        assert.deepEqual(log.runs[1].steps.map(s => [s.name, s.exitCode, s.sec]), [['classify', 0, 1800], ['nlq', null, null]]);
        assert.deepEqual(log.commands.map(c => [c.cmd, c.exitCode, c.sec]), [
            ['npm run db:up', 0, 5],
            ['npm run cassettes:rerecord', 1, 11690],
            ['npm run cassettes:rerecord -- --suites classify,nlq', null, null]
        ]);
        assert.equal(log.timeoutLines, 2, 'OLLAMA_TIMEOUT_MS 與節點逾時各一行');
    });

    test('認不得的標籤用最後的「錄製步驟：」補名字與秒數', () => {
        const log = perf.parseRecordLog([
            '══ 1/2 某個新步驟 ═════',
            '══ 2/2 classify suite ═════',
            '  → 結束碼 0，30 秒',
            '錄製步驟：brandnew=0（15 秒）、classify=0（30 秒）'
        ].join('\n'));
        assert.deepEqual(log.runs[0].steps.map(s => [s.name, s.exitCode, s.sec]), [['brandnew', 0, 15], ['classify', 0, 30]]);
    });

    test('不是重錄的 log：沒有段落', () => {
        const log = perf.parseRecordLog('hello\r\n[2026-09-26 09:00:00] > npm run ocr:selftest\r\n[2026-09-26 09:01:00] 結束碼 0，60 秒\r\n');
        assert.deepEqual(log.runs, []);
        assert.deepEqual(log.commands.map(c => c.sec), [60]);
    });

    test('stepNameOf 認得 rerecord_all.js 的每一個錄製步驟（標籤改了這裡要跟著改）', () => {
        const { recordSteps } = require('../../eval/tools/rerecord_all');
        const steps = recordSteps({ withSimilar: true });
        assert.ok(steps.length >= 6);
        for (const s of steps) assert.equal(perf.stepNameOf(s.label), s.name, s.label);
        assert.equal(perf.stepNameOf('回放驗證（CI 的設定：replay／fixture）'), null);
    });
});

describe('建議的規則', () => {
    const stats = () => {
        const { entries } = perf.readCassettes(cassetteDir);
        return perf.summarizeGroups(perf.selectEntries(entries).selected, { byModel: false });
    };

    test('safeMs＝max(3 × p90, 2 × max)，無條件進位到整分鐘', () => {
        assert.deepEqual([perf.RULES.P90_FACTOR, perf.RULES.MAX_FACTOR, perf.RULES.ROUND_MS], [3, 2, 60_000]);
        assert.equal(perf.safeMs(90 * SEC, 100 * SEC), 300 * SEC, '270 秒進位到 5 分');
        assert.equal(perf.safeMs(100 * SEC, 200 * SEC), 420 * SEC, 'max 的 2 倍較大時用它（400 秒 → 7 分）');
        assert.equal(perf.safeMs(600 * SEC, 600 * SEC), 1800 * SEC);
        assert.equal(perf.safeMs(0, 0), 0);
    });

    test('currentSettings：明寫的正整數優先，否則本機預設', () => {
        const s = perf.currentSettings({ OLLAMA_TIMEOUT_MS: '3600000', JOB_NODE_TIMEOUT_MS: 'abc', OCR_TIMEOUT_MS: '0' });
        assert.deepEqual(s.OLLAMA_TIMEOUT_MS, { value: 3_600_000, source: '.env' });
        assert.deepEqual(s.JOB_NODE_TIMEOUT_MS, { value: 2_700_000, source: '本機預設' });
        assert.deepEqual(s.OCR_TIMEOUT_MS, { value: 1_800_000, source: '本機預設' });
        assert.deepEqual(s.JOB_PDF_CHUNK_PAGES, { value: 2, source: '本機預設' });
    });

    test('逾時：OLLAMA 取最慢的本機 LLM；OCR 看 ocr；節點＝拆題一塊三步相加、驗算 ×2、單次呼叫，取最大', () => {
        const rec = perf.recommend(stats(), perf.currentSettings({}));
        // extract_vision：p90＝max＝900 秒 → max(2700, 1800) 秒
        assert.deepEqual([rec.ollamaTimeout.agent, rec.ollamaTimeout.needMs], ['extract_vision', 2700 * SEC]);
        assert.deepEqual([rec.ocrTimeout.needMs, rec.ocrTimeout.p90Ms], [420 * SEC, 140 * SEC]);
        const cand = Object.fromEntries(rec.nodeTimeout.candidates.map(c => [c.node, c.needMs]));
        assert.equal(cand['拆題一塊（ocr＋extract_vision＋extract_ocr）'], 3 * (140 + 900 + 420) * SEC);
        assert.equal(cand['驗算（最多採樣 2 次）'], 3 * 1200 * SEC);
        assert.equal(cand.classify, 300 * SEC);
        assert.equal(cand.variant, 780 * SEC, '250 秒：max(750, 500) 進位到 13 分');
        assert.equal(rec.nodeTimeout.node, '拆題一塊（ocr＋extract_vision＋extract_ocr）');
        assert.equal(rec.nodeTimeout.needMs, 4380 * SEC);
        assert.deepEqual(rec.lowSample.sort(), ['extract_ocr', 'extract_vision', 'ocr', 'variant', 'verify'],
            '少於 10 支的都算（verify 5 支也是）；classify 剛好 10 支不算');
    });

    test('RERECORD_TIME_SCALE＝實測秒數合計 ÷ SEC_PER_CALL 合計；倍率相差超過 2 倍時改建議個別的每次秒數', () => {
        const rec = perf.recommend(stats(), perf.currentSettings({}));
        const t = rec.timeScale;
        const est = 2 * local.SEC_PER_CALL.ocr + 2 * local.SEC_PER_CALL.extract_vision + 2 * local.SEC_PER_CALL.extract_ocr +
            10 * local.SEC_PER_CALL.classify + 5 * local.SEC_PER_CALL.verify + 1 * local.SEC_PER_CALL.variant;
        const measured = 240 + 1500 + 720 + 550 + 2000 + 250;
        assert.ok(Math.abs(t.measuredSec - measured) < 1e-6);
        assert.equal(t.estimatedSec, est);
        assert.equal(t.scale, Math.round((measured / est) * 100) / 100);
        assert.ok(t.spread > perf.RULES.SCALE_SPREAD);
        const env = Object.fromEntries(t.perAgent.map(p => [p.env, p.value]));
        assert.equal(env.RERECORD_SEC_PER_CALL_CLASSIFY, 55);
        assert.equal(env.RERECORD_SEC_PER_CALL_EXTRACT_VISION, 750);
        assert.equal(env.RERECORD_SEC_PER_CALL_VERIFY, 400);

        // 倍率一致時只建議一個倍率
        const even = perf.recommend([
            { agent: 'classify', vendor: 'ollama', n: 4, p50Ms: 1, p90Ms: 1, maxMs: 1, meanMs: local.SEC_PER_CALL.classify * 500, pages: null },
            { agent: 'verify', vendor: 'ollama', n: 4, p50Ms: 1, p90Ms: 1, maxMs: 1, meanMs: local.SEC_PER_CALL.verify * 500, pages: null },
            { agent: 'tutor', vendor: 'ollama', n: 4, p50Ms: 1, p90Ms: 1, maxMs: 1, meanMs: 1000, pages: null }
        ], perf.currentSettings({}));
        assert.equal(even.timeScale.scale, 0.5);
        assert.deepEqual(even.timeScale.perAgent, []);
        assert.deepEqual(even.timeScale.excluded, ['tutor'], '不在 SEC_PER_CALL 表上的不算倍率');
    });

    test('每塊頁數：每頁安全秒數線性外推，在目前的逾時與 num_ctx 下放得下的最大頁數', () => {
        // 每頁安全秒數：extract_vision max(3×450, 2×450)=1350、ocr 210、extract_ocr 630 → 一塊每頁 2190 秒
        const def = perf.recommend(stats(), perf.currentSettings({})).chunkPages;
        assert.equal(def.perPage.extract_vision.safeSec, 1350);
        assert.equal(def.perPage.ocr.safeSec, 210);
        assert.equal(def.perPage.extract_ocr.safeSec, 630);
        const lim = Object.fromEntries(def.limits.map(l => [`${l.name}:${l.why.split(' ')[0]}`, l.maxPages]));
        assert.equal(lim['JOB_NODE_TIMEOUT_MS:一塊（ocr＋extract_vision＋extract_ocr）每頁的安全秒數合計'], 1, '2700 ÷ 2190');
        assert.equal(lim['OLLAMA_TIMEOUT_MS:extract_vision'], 1, '1800 ÷ 1350');
        assert.equal(lim['OLLAMA_TIMEOUT_MS:extract_ocr'], 2);
        assert.equal(lim['OCR_TIMEOUT_MS:ocr'], 8);
        assert.equal(lim['OLLAMA_NUM_CTX:extract_vision'], 5, '16384 ÷ 3250 token');
        assert.equal(def.pages, 1);
        assert.equal(def.binding.name, 'JOB_NODE_TIMEOUT_MS');
        assert.equal(def.current, 2);
        assert.equal(def.recordedAvgPages, 2);
        // 實際錄到的每塊最長：各步最慢的那一次與它的頁數（extract_ocr 的頁數來自同一塊的 extract_vision）
        assert.deepEqual(def.recorded.steps, [
            { agent: 'ocr', maxMs: 140 * SEC, pages: 2 },
            { agent: 'extract_vision', maxMs: 900 * SEC, pages: 2 },
            { agent: 'extract_ocr', maxMs: 420 * SEC, pages: 2 }
        ]);
        assert.equal(def.recorded.sumMaxMs, 1460 * SEC);
        assert.deepEqual(def.belowRecorded, { pages: 1, recordedAvgPages: 2 }, '建議 1 頁＜錄製時的 2 頁：線性外推會低估');

        const roomy = perf.recommend(stats(), perf.currentSettings({ JOB_NODE_TIMEOUT_MS: '9000000', OLLAMA_TIMEOUT_MS: '5400000' })).chunkPages;
        assert.equal(roomy.pages, 4);
        assert.equal(roomy.belowRecorded, null, '維持 2 頁、最多 4 頁：都不少於錄製時的 2 頁，外推偏保守');

        const oneNow = perf.recommend(stats(), perf.currentSettings({
            JOB_NODE_TIMEOUT_MS: '9000000', OLLAMA_TIMEOUT_MS: '5400000', JOB_PDF_CHUNK_PAGES: '1'
        })).chunkPages;
        assert.deepEqual([oneNow.pages, oneNow.current], [4, 1]);
        assert.deepEqual(oneNow.belowRecorded, { pages: 1, recordedAvgPages: 2 }, '「目前 1 頁夠用」這個結論也是往少的方向外推');

        const tight = perf.recommend(stats(), perf.currentSettings({ JOB_NODE_TIMEOUT_MS: '1000000' })).chunkPages;
        assert.equal(tight.pages, 0);
        assert.equal(tight.binding.name, 'JOB_NODE_TIMEOUT_MS');
        assert.deepEqual(tight.belowRecorded, { pages: 1, recordedAvgPages: 2 }, '建議 0 頁時，結論講的是 1 頁');

        const ctx = perf.recommend(stats(), perf.currentSettings({
            JOB_NODE_TIMEOUT_MS: '900000000', OLLAMA_TIMEOUT_MS: '900000000', OCR_TIMEOUT_MS: '900000000', OLLAMA_NUM_CTX: '3000'
        })).chunkPages;
        assert.equal(ctx.pages, 0);
        assert.equal(ctx.binding.name, 'OLLAMA_NUM_CTX', '3000 ÷ 3250 token');

        const huge = perf.recommend(stats(), perf.currentSettings({
            JOB_NODE_TIMEOUT_MS: '900000000', OLLAMA_TIMEOUT_MS: '900000000', OCR_TIMEOUT_MS: '900000000', OLLAMA_NUM_CTX: '900000'
        })).chunkPages;
        assert.equal(huge.pages, perf.RULES.MAX_CHUNK_PAGES, '上限 10 頁');
    });

    test('沒有 extract_vision 就不建議頁數；沒有本機資料就什麼都不建議', () => {
        const onlyClassify = stats().filter(s => s.agent === 'classify');
        const rec = perf.recommend(onlyClassify, perf.currentSettings({}));
        assert.equal(rec.chunkPages, null);
        assert.equal(rec.ocrTimeout, null);
        assert.equal(rec.nodeTimeout.node, 'classify');
        const none = perf.recommend([], perf.currentSettings({}));
        assert.deepEqual([none.ollamaTimeout, none.ocrTimeout, none.nodeTimeout, none.timeScale, none.chunkPages], [null, null, null, null, null]);
    });
});

describe('報告與 main', () => {
    test('buildReport：三段都在；數字與建議寫進 Markdown', () => {
        const args = perf.parseArgs(['--cassettes', cassetteDir, '--log', logFile]);
        const { markdown, data } = perf.buildReport(args, { env: {}, now: new Date(2026, 8, 26, 12, 0, 0) });
        assert.match(markdown, /^# 本機效能實測\n/);
        assert.match(markdown, /產生時間：2026-09-26 12:00:00/);
        assert.match(markdown, /共 26 支；納入統計 22 支/, '26＝22＋供應商不符 2＋沒有 latency 1＋壞檔 1');
        assert.match(markdown, /供應商不符 2 支（gemini 2）/);
        assert.match(markdown, /沒有 latencyMs 的 1 支/);
        assert.match(markdown, /壞掉的 JSON 1 支/);
        assert.match(markdown, /其中 1 支沒有 recorded_at，用檔案修改時間/);
        assert.match(markdown, /\| `classify` \| `qwen3:8b` \| 10 \| 50 秒 \| 1 分 30 秒 \| 1 分 40 秒 \| 55 秒 \| 2\.7 \| 2,000 \| 150 \| — \|/);
        assert.match(markdown, /\| `extract_vision` \| `qwen3-vl:8b` \| 2（樣本少：p90 等於最大值） \| 10 分 \| 15 分 \| 15 分 \| 12 分 30 秒 \| 2\.0 \| 5,000 \| 1,500 \| 6 分 15 秒（4 頁） \|/);
        assert.match(markdown, /\| `verify` \| `qwen3:8b` \| 5（樣本少：p90 等於最大值） \|/, '5 支也是 p90＝max');
        assert.match(markdown, /「樣本少：p90 等於最大值」＝少於 10 支：百分位數用 nearest-rank，n ≤ 9 時/);
        assert.match(markdown, /\| 2\/3 classify suite \| classify \| 1 \| 57 分 36 秒 \|/);
        assert.match(markdown, /\| 2\/2 nlq suite（含查詢句向量） \| nlq \| （沒有結束紀錄：中斷或還在跑） \| — \|/);
        assert.match(markdown, /log 裡有 2 行逾時訊息/);
        assert.match(markdown, /`OLLAMA_TIMEOUT_MS`（單次 Ollama 呼叫） \| 1800000（30 分），本機預設 \| 2700000（45 分） \|.*\*\*不夠\*\*/);
        assert.match(markdown, /`OCR_TIMEOUT_MS`（單次 PaddleOCR） \| 1800000（30 分），本機預設 \| 420000（7 分） \|.*夠用/);
        assert.match(markdown, /`JOB_NODE_TIMEOUT_MS`（一個節點） \| 2700000（45 分），本機預設 \| 4380000（1 小時 13 分） \|/);
        assert.match(markdown, new RegExp(`RERECORD_TIME_SCALE=${data.recommendations.timeScale.scale}\``));
        assert.match(markdown, /RERECORD_SEC_PER_CALL_CLASSIFY=55/);
        assert.match(markdown, /建議：`JOB_PDF_CHUNK_PAGES=1`（目前 2 頁，受限於 `JOB_NODE_TIMEOUT_MS`）/);
        assert.match(markdown, /樣本少於 10 支的 agent（p90 等於最大值，逾時的安全值因此就是 3 × max）：`ocr`/);
        // 3.3：外推方向的說明、各步錄到的最長、建議少於錄製頁數時的提醒
        assert.match(markdown, /推到比 2 頁多時估得偏保守；\*\*推到比 2 頁少時會低估\*\*（固定開銷不會跟著頁數減半）/);
        assert.match(markdown, /\| 步驟 \| 每頁平均 \| 每頁 p90 \| 每頁安全秒數 \| 頁數來源 \| 錄到的每塊最長 \|/);
        assert.match(markdown, /\| `extract_vision` \| 6 分 15 秒 \| 7 分 30 秒 \| 22 分 30 秒 \| 實際頁數 \| 15 分（2 頁） \|/);
        assert.match(markdown, /\| `extract_ocr` \| 3 分 \| 3 分 30 秒 \| 10 分 30 秒 \| 實際頁數 \| 7 分（2 頁） \|/);
        assert.match(markdown, /注意：上面的結論推到每塊 1 頁，少於錄製時平均的 2 頁。線性外推在這個方向會\*\*低估\*\*/);
        assert.ok(!/與每塊頁數成正比/.test(markdown), '3.1 不再說一塊的時間與頁數成正比');
        assert.match(markdown, /頁數調小時不能直接按比例縮小/);
        assert.match(markdown, /重錄（`cassettes:rerecord`）時固定帶 2700000/, '節點建議超過重錄寫死的 45 分時要講明');
        assert.ok(!/\n{3,}/.test(markdown), '不要有連續空行');
        assert.ok(markdown.endsWith('\n'));
    });

    test('沒有本機 cassette（例如 repo 裡目前只有 Gemini 錄的）：照實說，不硬給建議', () => {
        const dir = path.join(tmp, '只有 Gemini');
        writeCassette(dir, 'classify', 'g', { model: 'gemini-3.5-flash', latencyMs: 3000, recordedAt: T0, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0 } });
        const { markdown } = perf.buildReport(perf.parseArgs(['--cassettes', dir]), { env: {} });
        assert.match(markdown, /沒有本機模型錄的 cassette/);
        assert.match(markdown, /無法建議逾時、倍率與頁數/);
        const all = perf.buildReport(perf.parseArgs(['--cassettes', dir, '--vendor', 'all']), { env: {} }).markdown;
        assert.match(all, /\| `classify` \| `gemini-3\.5-flash` \| 1（樣本少：p90 等於最大值） \|/);
        assert.match(all, /無法建議逾時、倍率與頁數/, 'Gemini 的速度不拿來建議本機的逾時');
    });

    test('.env 明寫的逾時夠大時：判「夠用」，頁數可以維持', () => {
        const args = perf.parseArgs(['--cassettes', cassetteDir]);
        const { markdown } = perf.buildReport(args, { env: { JOB_NODE_TIMEOUT_MS: '9000000', OLLAMA_TIMEOUT_MS: '5400000' } });
        assert.match(markdown, /`OLLAMA_TIMEOUT_MS`（單次 Ollama 呼叫） \| 5400000（1 小時 30 分），\.env \|.*夠用/);
        assert.match(markdown, /目前的 2 頁在安全範圍內；在目前的設定下最多可到 4 頁/);
        assert.ok(!/線性外推在這個方向會/.test(markdown), '結論都不少於錄製時的 2 頁：不必提醒低估');
    });

    test('每塊 1 頁也不夠時：講「達不到安全餘裕」（不是「會超過」），並列出實際錄到的每塊最長', () => {
        const args = perf.parseArgs(['--cassettes', cassetteDir]);
        const { markdown } = perf.buildReport(args, { env: { JOB_NODE_TIMEOUT_MS: '1000000' } });
        assert.ok(!/可能超過/.test(markdown), '舊的說法「即使每塊 1 頁也可能超過」已拿掉');
        assert.match(markdown, /建議：\*\*每塊 1 頁也達不到 max\(3 × p90, 2 × max\) 的安全餘裕\*\*。受限於 `JOB_NODE_TIMEOUT_MS`＝1000000（16 分 40 秒）：一塊（ocr＋extract_vision＋extract_ocr）每頁的安全秒數合計 2190 秒。請先照 3\.1 調高逾時/);
        assert.match(markdown, /實際錄到的每塊最長（成功留下回放檔的呼叫）：`ocr` 2 分 20 秒（2 頁）、`extract_vision` 15 分（2 頁）、`extract_ocr` 7 分（2 頁）；各步最長相加 24 分 20 秒（同一塊不一定每步都最慢，所以是上限）。/);
        assert.match(markdown, /注意：上面的結論推到每塊 1 頁，少於錄製時平均的 2 頁/);

        const ctx = perf.buildReport(args, { env: {
            JOB_NODE_TIMEOUT_MS: '900000000', OLLAMA_TIMEOUT_MS: '900000000', OCR_TIMEOUT_MS: '900000000', OLLAMA_NUM_CTX: '3000'
        } }).markdown;
        assert.match(ctx, /建議：\*\*每塊 1 頁，估計的 token 數也超過 `OLLAMA_NUM_CTX`＝3,000\*\*。extract_vision 每頁約 3,250 token（輸入＋輸出；固定的提示詞也按頁攤）。請先調高 `OLLAMA_NUM_CTX`/);
        assert.ok(!/安全餘裕\*\*/.test(ctx), 'token 放不下不是逾時的安全餘裕問題');
        assert.match(ctx, /實際錄到的每塊最長（成功留下回放檔的呼叫）：`ocr` 2 分 20 秒（2 頁）/);
    });

    test('main：印出報告；--out 另存（中文路徑、自動建目錄）；--help；log 不存在時照實寫', () => {
        let printed = '';
        const stdout = { write: (s) => { printed += s; } };
        const out = path.join(tmp, '報告', '本機 實測.md');
        const code = perf.main(['--cassettes', cassetteDir, '--log', path.join(tmp, '沒有.log'), '--since', '2026-09-22', '--out', out],
            { stdout, env: {}, cwd: tmp, now: new Date(2026, 8, 26) });
        assert.equal(code, 0);
        const saved = fs.readFileSync(out, 'utf8');
        assert.ok(printed.startsWith(saved), '畫面上印的就是存檔的內容');
        assert.match(printed, /已另存：/);
        assert.match(saved, /讀不到：找不到這個檔案/);
        assert.match(saved, /--since（2026-09-22 00:00:00）之前錄的 1 支/, 'variant 那支的檔案時間是 9/20');

        let help = '';
        assert.equal(perf.main(['--help'], { stdout: { write: (s) => { help += s; } } }), 0);
        assert.match(help, /npm run perf:local/);
    });
});

describe('與原始程式一致', () => {
    test('本機預設值＝各模組的預設（改了那邊，這裡的建議要跟著改）', () => {
        const ollama = require('../../services/llm/ollama');
        const ocr = require('../../services/ocr');
        const runner = require('../../workers/jobRunner');
        assert.equal(perf.SETTING_DEFAULTS.OLLAMA_TIMEOUT_MS, ollama.DEFAULT_TIMEOUT_MS);
        assert.equal(perf.SETTING_DEFAULTS.OLLAMA_NUM_CTX, ollama.DEFAULT_NUM_CTX);
        assert.equal(perf.SETTING_DEFAULTS.OCR_TIMEOUT_MS, ocr.DEFAULT_TIMEOUT_MS);
        assert.equal(perf.SETTING_DEFAULTS.JOB_NODE_TIMEOUT_MS, runner.LOCAL_NODE_TIMEOUT_MS);
        assert.equal(perf.SETTING_DEFAULTS.JOB_PDF_CHUNK_PAGES, runner.LOCAL_PDF_CHUNK_PAGES);
        const verifySrc = fs.readFileSync(path.join(APP_DIR, 'agents', 'verify.js'), 'utf8');
        assert.equal(Number(verifySrc.match(/const MAX_SAMPLES = (\d+);/)[1]), perf.RULES.VERIFY_MAX_SAMPLES);
        assert.deepEqual(local.LOCAL_EXTRACT_CHAIN, ['ocr', 'extract_vision', 'extract_ocr']);
    });

    test('package.json 的 perf:local', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['perf:local'], 'node eval/tools/local_perf_report.js');
    });
});
