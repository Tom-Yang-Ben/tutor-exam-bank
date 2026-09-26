// ─────────────────────────────────────────────────────────────
// test/unit/localPerfThinking.test.js — npm run perf:local 的「拆題以外的時間」（eval/tools/local_perf_report.js 第 1.2～1.5、4 段；
// 〔dec/local-thinking-speed〕docs/local-mode.md 第 10.12 條）
//
// 驗證（數字刻意取整，期望值可以心算）：
//   1. toEntry 的新欄位：parts 雜湊、不思考（request.ollamaOverrides）、sampleNo、回答字數、控制字元；
//   2. 推算速度：同一段 prompt 連送兩次 → 輸出速度與冷的讀 prompt 速度；隔太久、prompt 不同、讀得太少的不算；迴歸交叉檢查；
//   3. 思考比例：用不思考的回放檔擬合「字數 → token」，套到會思考的 agent；
//   4. 一份卷的估計（低／高）與選項 a／b／c 省下的時間；
//   5. token 分布與 num_ctx 8192；
//   6. 報告：新段落、--questions／--pages、「（不思考）」另列一組；既有的 parseArgs 形狀不變。
// 不呼叫模型、不連網（cassette 寫在暫存目錄）。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perf = require('../../eval/tools/local_perf_report');

const SEC = 1000;
const T0 = Date.parse('2026-09-26T01:00:00.000Z');
const M = 'qwen3:8b';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), '思考比例-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 直接造 entry（形狀同 toEntry 的輸出；只填這些函式會讀的欄位） */
function entry(o) {
    return {
        agent: 'classify', model: M, vendor: 'ollama', file: null, timeSource: 'meta', timing: null, pages: null, pagesFrom: null,
        chunkRef: null, partsHash: null, noThink: false, sampleNo: null, answer: null, ctrlEscapes: false, ...o
    };
}

/** 一支接一支的呼叫：start 秒開始、lat 秒 */
function at(startSec, latSec) { return { recordedAt: T0 + (startSec + latSec) * SEC, latencyMs: latSec * SEC }; }

describe('toEntry 的新欄位', () => {
    test('parts 雜湊、不思考、sampleNo、回答字數（中文／其他）、控制字元', () => {
        const e = perf.toEntry({
            meta: { agent: 'verify', model: M, recorded_at: '2026-09-26T01:00:00Z' },
            request: {
                parts: [{ kind: 'text', chars: 5, sha256: 'aa' }, { kind: 'text', chars: 5, sha256: 'bb' }],
                cacheKeyParts: { sampleNo: 2 }, ollamaOverrides: { think: false }
            },
            response: { data: { final_answer: '\u000crac{1}{2}', steps_summary: '先通分' }, usage: { tokenIn: 1, tokenOut: 2 }, latencyMs: 1000 }
        });
        assert.equal(e.partsHash, 'aa,bb');
        assert.equal(e.noThink, true);
        assert.equal(e.sampleNo, 2);
        const json = JSON.stringify({ final_answer: '\u000crac{1}{2}', steps_summary: '先通分' });
        assert.deepEqual(e.answer, { cjk: 3, other: json.length - 3 });
        assert.equal(e.ctrlEscapes, true);

        const plain = perf.toEntry({ meta: { agent: 'classify', model: M }, request: { parts: [] }, response: { text: '答案', latencyMs: 5 } });
        assert.deepEqual([plain.partsHash, plain.noThink, plain.sampleNo, plain.answer, plain.ctrlEscapes], [null, false, null, { cjk: 2, other: 0 }, false]);
        const noAnswer = perf.toEntry({ meta: { agent: 'ocr', model: 'paddleocr@3.7.0', kind: 'ocr' }, request: {}, response: { latencyMs: 5 } });
        assert.deepEqual([noAnswer.answer, noAnswer.ctrlEscapes], [null, false]);
    });

    test('hasCtrlEscapes：\\f\\t\\r\\b\\v 緊接英文字母才算；真的換行、tab 接數字或中文不算', () => {
        for (const s of ['\u000crac{1}{2}', '2 \times 3', '\rightarrow', '\beta', '\u000bec']) assert.equal(perf.hasCtrlEscapes({ a: [s] }), true, JSON.stringify(s));
        for (const s of ['第一行\n第二行', 'a\tb'.replace('b', '1'), '\t中文', '\\frac{1}{2}', '\nabla']) assert.equal(perf.hasCtrlEscapes(s), false, JSON.stringify(s));
        assert.equal(perf.hasCtrlEscapes(null), false);
        assert.equal(perf.hasCtrlEscapes(42), false);
    });

    test('charCounts：中日韓字元（含全形標點）與其他', () => {
        assert.deepEqual(perf.charCounts('設 $x$，求值。'), { cjk: 5, other: 4 });
        assert.deepEqual(perf.charCounts(''), { cjk: 0, other: 0 });
    });
});

describe('estimateSpeeds：推算輸出與讀 prompt 的速度', () => {
    const pair = (start, hash, tin, [lat1, out1], [lat2, out2], gapSec = 2) => [
        entry({ agent: 'variant', partsHash: hash, usage: { tokenIn: tin, tokenOut: out1, tokenThinking: 0 }, ...at(start, lat1) }),
        entry({ agent: 'variant', partsHash: hash, usage: { tokenIn: tin, tokenOut: out2, tokenThinking: 0 }, ...at(start + lat1 + gapSec, lat2) })
    ];

    test('同一段 prompt 連送兩次：第二次＝輸出速度；第一次多出來的＝冷的讀 prompt', () => {
        const entries = [
            ...pair(0, 'p1', 2000, [200, 200], [100, 200]),           // 輸出 2 token/秒；讀 2000 token 用 100 秒 → 20
            ...pair(1000, 'p2', 1500, [175, 150], [60, 150])          // 輸出 2.5；175 − 60 = 115 秒 → 13.04
        ];
        const s = perf.estimateSpeeds(entries);
        assert.equal(s.byModel.length, 1);
        const m = s.byModel[0];
        assert.equal(m.pairs, 2);
        assert.equal(m.outTps, (2 + 2.5) / 2, '中位數');
        assert.ok(Math.abs(m.coldPromptTps - (20 + 1500 / 115) / 2) < 1e-9, `${m.coldPromptTps}`);
        assert.deepEqual(m.timing, { outTps: null, promptTps: null });
    });

    test('不算的：中間隔超過 1 分鐘、prompt 不同、tokenIn 不同、不同 agent；讀太少的只算輸出速度', () => {
        const far = pair(0, 'p1', 2000, [200, 200], [100, 200], 61);
        const diffHash = [...pair(1000, 'p2', 2000, [200, 200], [100, 200])];
        diffHash[1] = { ...diffHash[1], partsHash: 'p3' };
        const diffIn = [...pair(2000, 'p4', 2000, [200, 200], [100, 200])];
        diffIn[1] = { ...diffIn[1], usage: { tokenIn: 1999, tokenOut: 200, tokenThinking: 0 } };
        const diffAgent = [...pair(3000, 'p5', 2000, [200, 200], [100, 200])];
        diffAgent[1] = { ...diffAgent[1], agent: 'classify' };
        assert.equal(perf.estimateSpeeds([...far, ...diffHash, ...diffIn, ...diffAgent]).byModel[0].pairs, 0);
        assert.equal(perf.SPEED_RULES.PAIR_MAX_GAP_MS, 60_000);

        const short = perf.estimateSpeeds(pair(0, 'q', 300, [200, 380], [190, 380])).byModel[0];
        assert.equal(short.pairs, 1);
        assert.equal(short.outTps, 2);
        assert.equal(short.coldPromptTps, null, `讀 ${perf.SPEED_RULES.PAIR_MIN_PROMPT_TOKENS} token 以下不推讀 prompt 速度`);
    });

    test('迴歸：讀的 token 數差不多的組，延遲＝截距＋斜率×輸出；r² 太低、讀的差很多、不到 5 支都不列', () => {
        const verify = [100, 200, 300, 400, 500, 600].map((out, i) => entry({ agent: 'verify', usage: { tokenIn: 300 + i, tokenOut: out, tokenThinking: 0 }, ...at(i * 1000, 10 + 0.5 * out) }));
        const s = perf.estimateSpeeds(verify);
        assert.equal(s.regressions.length, 1);
        const r = s.regressions[0];
        assert.equal(r.agent, 'verify');
        assert.ok(Math.abs(r.secPerOutToken - 0.5) < 1e-9 && Math.abs(r.outTps - 2) < 1e-9 && Math.abs(r.interceptSec - 10) < 1e-6 && r.r2 > 0.999);

        const spread = [100, 200, 300, 400, 500].map((out, i) => entry({ agent: 'variant', usage: { tokenIn: 500 * (i + 1), tokenOut: out, tokenThinking: 0 }, ...at(i * 1000, out) }));
        const noisy = [100, 200, 300, 400, 500, 600].map((out, i) => entry({ agent: 'nlq', usage: { tokenIn: 1400, tokenOut: out, tokenThinking: 0 }, ...at(i * 1000, [90, 10, 80, 20, 70, 30][i]) }));
        const few = verify.slice(0, 4).map(e => ({ ...e, agent: 'lint' }));
        assert.deepEqual(perf.estimateSpeeds([...spread, ...noisy, ...few]).regressions, []);
    });

    test('speedFor：有分段時間用 Ollama 量的；再來連送兩次；再來 r² 最高的迴歸', () => {
        const withTiming = [entry({ usage: { tokenIn: 1000, tokenOut: 100, tokenThinking: 0 }, timing: { promptEvalMs: 50 * SEC, evalMs: 40 * SEC }, ...at(0, 95) })];
        const s1 = perf.estimateSpeeds(withTiming);
        assert.deepEqual(perf.speedFor(s1, M), { outTps: 2.5, promptTps: 20, source: 'Ollama 的分段時間' });
        const s2 = perf.estimateSpeeds(pair(0, 'p', 2000, [200, 200], [100, 200]));
        assert.equal(perf.speedFor(s2, M).source, '同一段 prompt 連送兩次（1 對）');
        const s3 = perf.estimateSpeeds([100, 200, 300, 400, 500].map((out, i) => entry({ agent: 'verify', usage: { tokenIn: 300, tokenOut: out, tokenThinking: 0 }, ...at(i * 1000, 0.5 * out) })));
        assert.deepEqual([perf.speedFor(s3, M).outTps, perf.speedFor(s3, M).promptTps], [2, null]);
        assert.equal(perf.speedFor(perf.estimateSpeeds([]), M).source, '沒有資料');
    });
});

describe('estimateThinking：思考占輸出多少', () => {
    /** 不思考的：輸出 token 剛好＝1 × 中文＋0.5 × 其他 */
    const calib = Array.from({ length: 12 }, (_, i) => entry({
        agent: i % 2 ? 'classify' : 'variant', answer: { cjk: 10 + 7 * i, other: 40 + 13 * i },
        usage: { tokenIn: 1000, tokenOut: (10 + 7 * i) + 0.5 * (40 + 13 * i), tokenThinking: 0 }
    }));
    const lint = [600, 900].map(out => entry({ agent: 'lint', answer: { cjk: 100, other: 100 }, usage: { tokenIn: 900, tokenOut: out, tokenThinking: 0 } }));

    test('擬合出 a＝1、b＝0.5；lint 的回答 150 token，其餘是思考', () => {
        const [t] = perf.estimateThinking([...calib, ...lint]);
        assert.equal(t.model, M);
        assert.ok(Math.abs(t.coef.a - 1) < 1e-9 && Math.abs(t.coef.b - 0.5) < 1e-9, JSON.stringify(t.coef));
        assert.equal(t.calibN, 12);
        assert.deepEqual(t.calibAgents, ['classify', 'variant']);
        assert.ok(t.calibErr < 1e-9);
        assert.equal(t.agents.length, 1);
        const a = t.agents[0];
        assert.equal(a.agent, 'lint');
        assert.ok(Math.abs(a.meanAnswer - 150) < 1e-6 && Math.abs(a.meanThinking - 600) < 1e-6 && Math.abs(a.share - 1200 / 1500) < 1e-9, JSON.stringify(a));
    });

    test('OLLAMA_NO_THINK 錄的 lint 算進換算、不算進思考；不思考的少於 10 支就不估', () => {
        const noThinkLint = entry({ agent: 'lint', noThink: true, answer: { cjk: 100, other: 100 }, usage: { tokenIn: 900, tokenOut: 150, tokenThinking: 0 } });
        const [t] = perf.estimateThinking([...calib, ...lint, noThinkLint]);
        assert.equal(t.calibN, 13);
        assert.equal(t.agents[0].n, 2);
        assert.deepEqual(perf.estimateThinking([...calib.slice(0, 9), ...lint]), []);
        assert.equal(perf.SPEED_RULES.CALIB_MIN_N, 10);
    });

    test('verifyUncertainRate：第 2 次採樣 ÷ 第 1 次；不思考錄的不算', () => {
        const v = (sampleNo, noThink = false) => entry({ agent: 'verify', sampleNo, noThink });
        assert.deepEqual(perf.verifyUncertainRate([...Array(10).fill(0).map(() => v(1)), v(2), v(2), v(2, true), entry({ agent: 'verify_chem', sampleNo: 1 })]),
            { rate: 2 / 11, first: 11, second: 2 });
        assert.equal(perf.verifyUncertainRate([v(null)]), null);
    });
});

describe('estimatePaper：一份卷的估計與選項 a／b／c', () => {
    const settings = perf.currentSettings({});
    const speeds = { byModel: [{ model: M, pairs: 3, outTps: 2, coldPromptTps: 20, examples: [], timing: { outTps: null, promptTps: null } }], regressions: [] };
    const stat = (o) => ({ n: 20, ...o });
    const stats = new Map([
        ['ocr', stat({ agent: 'ocr', n: 1, pages: { secPerPage: 60, p90SecPerPage: 70 } })],
        ['classify', stat({ agent: 'classify', p50Ms: 50 * SEC, p90Ms: 90 * SEC, avgTokenIn: 2000, avgTokenOut: 100 })],
        ['lint', stat({ agent: 'lint', n: 4, p50Ms: 500 * SEC, p90Ms: 600 * SEC, avgTokenIn: 1000 })],
        ['verify', stat({ agent: 'verify', p50Ms: 200 * SEC, p90Ms: 400 * SEC, avgTokenIn: 300 })]
    ]);
    const thinking = [{ model: M, agents: [
        { agent: 'lint', n: 4, meanThinking: 600, share: 0.8 },
        { agent: 'verify', n: 20, meanThinking: 400, share: 400 / 450 }
    ] }];
    const verifyEntries = [...Array(10).fill(0).map(() => entry({ agent: 'verify', sampleNo: 1 })), entry({ agent: 'verify', sampleNo: 2 }), entry({ agent: 'verify', sampleNo: 2 })];

    test('各步驟：OCR 按頁、OCR 整理用 token 估、分類 0～全部（高＝冷的 prompt）、lint 10%～20%、驗算含 uncertain 與重跑', () => {
        const p = perf.estimatePaper({ stats, speeds, thinking, entries: verifyEntries, settings, paper: { questions: 10, pages: 4 } });
        assert.deepEqual([p.chunkPages, p.chunks], [2, 2]);
        const by = Object.fromEntries(p.rows.map(r => [r.key, r]));
        assert.deepEqual([by.ocr.calls, by.ocr.perCallMs, by.ocr.total], [{ low: 2, high: 2 }, { low: 120 * SEC, high: 140 * SEC }, { low: 240 * SEC, high: 280 * SEC }]);
        // (2450 + 550 × 2) ÷ 20 ＋ (150 × 10 ÷ 2) ÷ 2 ＝ 177.5 ＋ 375 秒
        assert.deepEqual(by.extract_ocr.perCallMs, { low: 552.5 * SEC, high: 552.5 * SEC });
        assert.match(by.extract_ocr.basis, /\*\*估計\*\*.*3,550 token.*750 token/);
        // 冷的分類：2000 ÷ 20 ＋ 100 ÷ 2 ＝ 150 秒（比 p90 90 秒大）
        assert.deepEqual([by.classify.calls, by.classify.perCallMs, by.classify.total], [{ low: 0, high: 10 }, { low: 50 * SEC, high: 150 * SEC }, { low: 0, high: 1500 * SEC }]);
        assert.deepEqual([by.lint.calls, by.lint.total], [{ low: 1, high: 2 }, { low: 500 * SEC, high: 1200 * SEC }]);
        assert.equal(p.uncRate, 0.2);
        assert.ok(Math.abs(by.verify.calls.high - 10 * 1.2 * 1.3) < 1e-9);
        assert.deepEqual(by.verify.total.low, 2000 * SEC);
        assert.ok(Math.abs(by.verify.total.high - 15.6 * 400 * SEC) < 1e-6);
        assert.equal(by.kc_tag.inTotal, false, '知識點標註預設關，不算進合計');
        assert.deepEqual(p.total.missing, []);
        assert.ok(Math.abs(p.total.low - (240 + 1105 + 0 + 500 + 2000) * SEC) < 1e-6, `${p.total.low}`);
        assert.ok(Math.abs(p.total.high - (280 + 1105 + 1500 + 1200 + 6240) * SEC) < 1e-6, `${p.total.high}`);
    });

    test('選項 a／c：思考比例 ×（p50／p90 的延遲 − 讀 prompt）× 呼叫次數；b（沒有 kc_tag 回放檔）照 lint／verify 的平均思考比例推', () => {
        const p = perf.estimatePaper({ stats, speeds, thinking, entries: verifyEntries, settings, paper: { questions: 10, pages: 4 } });
        const s = Object.fromEntries(p.savings.map(x => [x.option, x]));
        // lint：讀 1000 token ÷ 20＝50 秒；0.8 ×（500 − 50）＝360 秒、0.8 ×（600 − 50）＝440 秒；1～2 次
        assert.deepEqual([s.a.perCallMs, s.a.total], [{ low: 360 * SEC, high: 440 * SEC }, { low: 360 * SEC, high: 880 * SEC }]);
        assert.match(s.a.note, /思考約占輸出 80%/);
        // verify：讀 300 ÷ 20＝15 秒
        const share = 400 / 450;
        assert.ok(Math.abs(s.c.perCallMs.low - share * 185 * SEC) < 1e-6 && Math.abs(s.c.perCallMs.high - share * 385 * SEC) < 1e-6);
        assert.ok(Math.abs(s.c.total.high - 15.6 * share * 385 * SEC) < 1e-6);
        assert.ok(s.c.total.low <= p.rows.find(r => r.key === 'verify').total.low, '省下的不會比那一步本身還多');
        const meanShare = (0.8 + share) / 2;
        const kcThink = 130 * meanShare / (1 - meanShare);
        assert.ok(Math.abs(s.b.thinkingTokens - kcThink) < 1e-6);
        assert.deepEqual(s.b.perCallMs, { low: kcThink / 2 * SEC, high: kcThink / 2 * SEC });
        assert.equal(s.b.inTotal, false);
        assert.match(s.b.note, /估計/);
        const kc = p.rows.find(r => r.key === 'kc_tag');
        assert.ok(Math.abs(kc.perCallMs.low - (1600 / 20 + (130 + kcThink) / 2) * SEC) < 1e-6);
        assert.ok(kc.basis.includes('思考照 lint／verify 的平均比例'));
    });

    test('--questions／--pages 與每塊頁數：20 題、5 頁、一塊 1 頁 → 5 塊', () => {
        const p = perf.estimatePaper({ stats, speeds, thinking, entries: verifyEntries, settings: perf.currentSettings({ JOB_PDF_CHUNK_PAGES: '1' }), paper: { questions: 20, pages: 5 } });
        assert.deepEqual([p.chunks, p.rows.find(r => r.key === 'lint').calls], [5, { low: 2, high: 4 }]);
    });

    test('速度不明：OCR 整理與知識點標註算不出來，合計列出缺哪幾步', () => {
        const none = { byModel: [], regressions: [] };
        const p = perf.estimatePaper({ stats, speeds: none, thinking: [], entries: [], settings, paper: { questions: 10, pages: 4 } });
        assert.deepEqual(p.total.missing, ['extract_ocr']);
        assert.equal(p.uncRate, perf.PAPER_ASSUMPTIONS.VERIFY_UNCERTAIN_RATE_FALLBACK);
        assert.ok(p.savings.every(s => s.total === null));
    });

    test('假設的數字（改了要一併改文件 docs/local-mode.md 第 10.12 條）', () => {
        const A = perf.PAPER_ASSUMPTIONS;
        assert.deepEqual([A.QUESTIONS, A.PAGES], [10, 4]);
        assert.deepEqual({ ...A.LINT_LLM_RATE }, { low: 0.1, high: 0.2 });
        assert.deepEqual({ ...A.CLASSIFY_LLM_RATE }, { low: 0, high: 1 });
        assert.deepEqual({ ...A.VERIFY_FAIL_RATE }, { low: 0, high: 0.3 });
        assert.equal(perf.KV_BYTES_PER_TOKEN_8B, 147_456);
    });
});

describe('tokenDistribution：num_ctx 8192 放不放得下', () => {
    test('實測放得下／寫到輸出上限會超過／不設上限／放不下', () => {
        const entries = [
            ...[800, 1000].map(out => entry({ agent: 'lint', usage: { tokenIn: 900, tokenOut: out, tokenThinking: 0 } })),
            entry({ agent: 'classify', usage: { tokenIn: 3600, tokenOut: 60, tokenThinking: 0 } }),
            entry({ agent: 'extract_ocr', usage: { tokenIn: 6000, tokenOut: 3000, tokenThinking: 0 } }),
            entry({ agent: 'kc_tag', usage: { tokenIn: 1600, tokenOut: 500, tokenThinking: 0 } })
        ];
        const groups = perf.summarizeGroups(entries);
        const rows = Object.fromEntries(perf.tokenDistribution(groups, entries).map(r => [r.agent, r]));
        assert.deepEqual([rows.lint.totalMax, rows.lint.worst, rows.lint.fitsObserved, rows.lint.fitsWorst], [1900, 900 + 8192, true, false]);
        assert.deepEqual([rows.classify.worst, rows.classify.fitsWorst], [null, null]);
        assert.deepEqual([rows.extract_ocr.fitsObserved, rows.extract_ocr.maxOutputTokens], [false, 8192]);
        assert.deepEqual([rows.kc_tag.worst, rows.kc_tag.fitsWorst], [1600 + 4096, true]);
        assert.deepEqual(rows.lint.in, { min: 900, p50: 900, p90: 900, max: 900 });
        assert.deepEqual(rows.lint.out, { min: 800, p50: 800, p90: 1000, max: 1000 });
    });

    test('maxOutputOf／thinksByDefault 跟 localTuning、agents/extract 一致', () => {
        assert.equal(perf.maxOutputOf('verify'), 8192);
        assert.equal(perf.maxOutputOf('kc_tag'), 4096);
        assert.equal(perf.maxOutputOf('extract_ocr_chem'), require('../../agents/extract').LOCAL_MAX_OUTPUT_TOKENS);
        assert.equal(perf.maxOutputOf('classify'), null);
        assert.deepEqual(['verify', 'lint_chem', 'kc_tag', 'tutor', 'classify', 'variant'].map(perf.thinksByDefault), [true, true, true, true, false, false]);
    });
});

describe('報告', () => {
    let dir;
    before(() => {
        dir = path.join(tmp, '錄好的');
        const w = (agent, name, doc) => {
            fs.mkdirSync(path.join(dir, agent), { recursive: true });
            fs.writeFileSync(path.join(dir, agent, `${name}.json`), JSON.stringify(doc));
        };
        let t = T0;
        const cas = (agent, name, { latSec, tin, tout, data, sha = name, ckp = {}, overrides, gap = 5 }) => {
            t += (gap + latSec) * SEC;
            w(agent, name, {
                meta: { agent, model: M, template: `${agent}.v1`, recorded_at: new Date(t).toISOString() },
                request: { parts: [{ kind: 'text', chars: 10, sha256: sha }], cacheKeyParts: ckp, ...(overrides ? { ollamaOverrides: overrides } : {}) },
                response: { data, usage: { tokenIn: tin, tokenOut: tout, tokenThinking: 0, tokenCached: 0 }, latencyMs: latSec * SEC }
            });
        };
        for (let i = 0; i < 6; i++) {
            const data = { question_text: i === 0 ? '求 $\u000crac{1}{2}$ 的值' : `第 ${i} 題：求值`, answer_text: '1' };
            const tout = Math.round(perf.charCounts(JSON.stringify(data)).cjk + 0.5 * perf.charCounts(JSON.stringify(data)).other);
            cas('variant', `v${i}a`, { latSec: 200, tin: 2000, tout, data, sha: `s${i}` });
            cas('variant', `v${i}b`, { latSec: tout / 2, tin: 2000, tout, data, sha: `s${i}`, gap: 1 });
        }
        for (let i = 0; i < 12; i++) cas('verify', `r${i}`, { latSec: 10 + 0.5 * (300 + 20 * i), tin: 310, tout: 300 + 20 * i, data: { final_answer: '1', answer_form: 'number', steps_summary: '算' }, ckp: { sampleNo: i < 2 ? 2 : 1 } });
        for (let i = 0; i < 3; i++) cas('lint', `l${i}`, { latSec: 500, tin: 900, tout: 1000, data: { question_text: '題', answer_text: '答' } });
        cas('lint', 'lnt', { latSec: 100, tin: 900, tout: 60, data: { question_text: '題', answer_text: '答' }, overrides: { think: false } });
        for (let i = 0; i < 3; i++) cas('classify', `c${i}`, { latSec: 50, tin: 3000, tout: 60, data: { chapter: '數列', confidence: 0.9, rationale: '因為' } });
    });

    test('新段落都在；「（不思考）」另列一組；第 4 段的一份卷大小可以改', () => {
        const { markdown, data } = perf.buildReport(perf.parseArgs(['--cassettes', dir]), { env: {}, now: new Date(2026, 8, 26, 12) });
        for (const h of ['### 1.2 ', '### 1.3 ', '### 1.4 ', '### 1.5 ', '## 4. ', '### 4.1 ']) assert.ok(markdown.includes(h), h);
        assert.match(markdown, /\| `lint`（不思考） \| `qwen3:8b` \| 1（樣本少：p90 等於最大值） \|/);
        assert.match(markdown, /\| `lint` \| `qwen3:8b` \| 3（樣本少：p90 等於最大值） \|/);
        assert.match(markdown, /一份 10 題、4 頁的卷，每塊 2 頁/);
        // 第 1 題的 \frac 被 JSON 吃掉（連送兩次，兩支都算）
        assert.match(markdown, /\| `variant` \| `qwen3:8b` \| 2／12 \| 17% \|/);
        assert.equal(data.speeds.byModel[0].pairs, 6);
        assert.ok(Math.abs(data.speeds.byModel[0].outTps - 2) < 0.05, `${data.speeds.byModel[0].outTps}`);
        assert.ok(data.paper && data.paper.rows.some(r => r.key === 'verify'));
        assert.equal(data.paper.uncRate, 2 / 10);
        assert.ok(!/\n{3,}/.test(markdown), '不要有連續空行');

        const big = perf.buildReport(perf.parseArgs(['--cassettes', dir, '--questions', '20', '--pages', '6']), { env: { JOB_PDF_CHUNK_PAGES: '3' } }).markdown;
        assert.match(big, /一份 20 題、6 頁的卷，每塊 3 頁（`JOB_PDF_CHUNK_PAGES`＝3，\.env）＝2 塊/);
    });

    test('parseArgs：--questions／--pages 有給才出現 paper；範圍 1～200', () => {
        assert.equal('paper' in perf.parseArgs([]), false, '沒給時 args 的形狀與之前相同');
        assert.deepEqual(perf.parseArgs(['--pages', '6']).paper, { pages: 6 });
        assert.deepEqual(perf.parseArgs(['--questions', '12', '--pages', '3']).paper, { questions: 12, pages: 3 });
        assert.throws(() => perf.parseArgs(['--questions', '0']), /1～200/);
        assert.throws(() => perf.parseArgs(['--pages', 'abc']), /1～200/);
        assert.throws(() => perf.parseArgs(['--pages']), /後面要接一個值/);
        assert.match(perf.USAGE, /--questions <N>/);
    });

    test('沒有本機資料：第 4 段說明估不出來', () => {
        const empty = path.join(tmp, '空的');
        fs.mkdirSync(empty, { recursive: true });
        const { markdown } = perf.buildReport(perf.parseArgs(['--cassettes', empty]), { env: {} });
        assert.match(markdown, /## 4\. [^\n]*\n\n沒有本機模型（Ollama／PaddleOCR）的資料，估不出來。/);
    });
});
