// npm run perf:local 在 LOCAL_EXTRACT_MODE=ocr 時的算法（〔OCR 為主 2026-09-26〕docs/local-mode.md 10.12）
//
//   - 拆題一塊只有 ocr → extract_ocr：節點逾時不再說「沒有 extract_vision 的資料」、每塊頁數改以 extract_ocr 為基準
//     （頁數由同一份 PDF 的 OCR 頁碼範圍推）
//   - 3.4 段：extract_ocr 讀得最多的一次＋輸出上限（8192）放不放得進 OLLAMA_NUM_CTX，放不下就提醒
// 交叉驗證模式（沒寫或 cross）的算法與之前逐字相同（test/unit/localPerfReport.test.js 不動）。
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perf = require('../../eval/tools/local_perf_report');

const SEC = 1000;
const PDF = 'f'.repeat(64);

function writeCassette(root, agent, key, doc) {
    const dir = path.join(root, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(doc), 'utf8');
}

describe('perf:local — 只用 OCR 拆題', () => {
    let root;
    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ocr-'));
        // 一份 4 頁卷、每塊 2 頁：OCR 兩支（1–2、3–4 頁）、extract_ocr 兩支（第 1、2 塊）；沒有看圖的 cassette
        for (const [i, [from, to, lat]] of [[1, 2, 200], [3, 4, 260]].entries()) {
            writeCassette(root, 'ocr', `o${i}`, {
                meta: { agent: 'ocr', model: 'paddleocr@3.7.0', kind: 'ocr', recorded_at: `2026-09-27T0${i}:00:00Z` },
                request: { cacheKeyParts: { pdfSha256: PDF, fromPage: from, toPage: to, dpi: 200 } },
                response: { latencyMs: lat * SEC }
            });
        }
        for (const [i, [lat, tokenIn]] of [[1500, 6000], [1800, 9000]].entries()) {
            writeCassette(root, 'extract_ocr', `e${i}`, {
                meta: { agent: 'extract_ocr', model: 'qwen3:8b', recorded_at: `2026-09-27T0${i + 2}:00:00Z` },
                request: { parts: [{ kind: 'text', chars: 100 }], cacheKeyParts: { template: 'extract_ocr.v1', chunkNo: i + 1, pdfSha256: PDF, ocrSha256: 'x' } },
                response: { latencyMs: lat * SEC, usage: { tokenIn, tokenOut: 3000, tokenThinking: 0, tokenCached: 0 } }
            });
        }
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    const stats = () => {
        const { entries } = perf.readCassettes(root);
        return perf.summarizeGroups(perf.selectEntries(entries).selected, { byModel: false });
    };

    test('輸出上限與 agents/extract.js 一致', () => {
        assert.equal(perf.EXTRACT_MAX_OUTPUT_TOKENS, require('../../agents/extract').LOCAL_MAX_OUTPUT_TOKENS);
    });

    test('沒有看圖的 cassette：extract_ocr 的頁數由同一份 PDF 的 OCR 頁碼範圍推（第 n 塊）', () => {
        const { entries } = perf.readCassettes(root);
        const eo = entries.filter(e => e.agent === 'extract_ocr').sort((a, b) => a.chunkRef.localeCompare(b.chunkRef));
        assert.deepEqual(eo.map(e => [e.pages, e.pagesFrom]), [[2, 'ocr-chunk'], [2, 'ocr-chunk']]);
    });

    test('ocr 模式：節點＝ocr＋extract_ocr（不說缺看圖）；每塊頁數以 extract_ocr 為基準', () => {
        const rec = perf.recommend(stats(), perf.currentSettings({}), { mode: 'ocr' });
        assert.equal(rec.mode, 'ocr');
        const node = rec.nodeTimeout.candidates.find(c => /^拆題一塊/.test(c.node));
        assert.equal(node.node, '拆題一塊（ocr＋extract_ocr）');
        assert.equal(node.note, '各步的 p90、max 分別相加（保守）');
        assert.ok(rec.chunkPages, '有 extract_ocr 就建議頁數');
        assert.deepEqual(Object.keys(rec.chunkPages.perPage), ['ocr', 'extract_ocr']);
        assert.equal(rec.chunkPages.recordedAvgPages, 2);
    });

    test('cross 模式（沒寫）同一批資料：照舊要看圖的 cassette 才建議頁數、節點標出缺 extract_vision', () => {
        const rec = perf.recommend(stats(), perf.currentSettings({}));
        assert.equal(rec.mode, 'cross');
        assert.equal(rec.chunkPages, null);
        const node = rec.nodeTimeout.candidates.find(c => /^拆題一塊/.test(c.node));
        assert.match(node.note, /沒有 extract_vision 的資料/);
    });

    test('ocrCtx：讀得最多的 9000＋8192 > 16384 → 放不下；調高 num_ctx 就放得下', () => {
        const over = perf.recommend(stats(), perf.currentSettings({}), { mode: 'ocr' }).ocrCtx;
        assert.deepEqual(over, { agent: 'extract_ocr', maxTokenIn: 9000, maxOutputTokens: 8192, numCtx: 16384, over: true, n: 2 });
        const ok = perf.recommend(stats(), perf.currentSettings({ OLLAMA_NUM_CTX: '20480' }), { mode: 'ocr' }).ocrCtx;
        assert.equal(ok.over, false);
        assert.equal(perf.recommend([], perf.currentSettings({})).ocrCtx, null);
    });

    test('報告 3.4 段：寫出拆題方式與「放不下」的處置（JOB_PDF_CHUNK_PAGES=1 或調高 OLLAMA_NUM_CTX）', () => {
        const args = perf.parseArgs(['--cassettes', root], { cwd: process.cwd() });
        const { markdown } = perf.buildReport(args, { env: { LOCAL_EXTRACT_MODE: 'ocr' }, now: new Date('2026-09-27T12:00:00Z') });
        assert.match(markdown, /### 3\.4 OCR 整理一次讀多少（`OLLAMA_NUM_CTX`）/);
        assert.match(markdown, /`LOCAL_EXTRACT_MODE=ocr`（只用 OCR/);
        assert.match(markdown, /⚠️ \*\*放不下\*\*/);
        assert.match(markdown, /JOB_PDF_CHUNK_PAGES` 設成 1/);
        assert.ok(!/\n{3,}/.test(markdown));
        const roomy = perf.buildReport(args, { env: { LOCAL_EXTRACT_MODE: 'ocr', OLLAMA_NUM_CTX: '32768' } }).markdown;
        assert.match(roomy, /放得下（還有/);
    });
});
