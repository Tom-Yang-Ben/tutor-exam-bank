// ─────────────────────────────────────────────────────────────
// test/unit/localPerfThinking.test.js — npm run perf:local 的「拆題以外的時間」（eval/tools/local_perf_report.js 第 1.2～1.5、4 段；
// 〔dec/local-thinking-speed〕docs/local-mode.md 第 10.14 條）
//
// 驗證（數字刻意取整，期望值可以心算）：
//   1. toEntry 的新欄位：parts 雜湊、不思考（request.ollamaOverrides）、sampleNo、回答字數、控制字元；
//   2. 推算速度：同一段 prompt 連送兩次 → 輸出速度與冷的讀 prompt 速度；隔太久、prompt 不同、讀得太少的不算；迴歸交叉檢查；
//   3. 思考比例：用不思考的回放檔擬合「字數 → token」，套到會思考的 agent；
//   4. 一份卷的估計（低／高）與選項 a／b／c 省下的時間；
//   5. token 分布與 num_ctx 8192；
//   6. 報告：新段落、--questions／--pages、「（不思考）」另列一組；既有的 parseArgs 形狀不變。
//   〔審查修正 dec/local-thinking-speed-fix〕冷的讀 prompt 只用「這個 agent 第一次出現」的呼叫、連送兩次的第一次是部分快取；
//   中間夾了別的呼叫再送一次 → 快取份數；溫度 0 的重現性；\n 開頭的 LaTeX 指令與修回；公式閘門的分批統計；
//   OCR 整理的 token 每次重算；分類 prompt 每題不同的比例用目前的模板重算；不思考版的回放檔、沒有回放檔的步驟、--backfill。
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
        // 〔審查修正〕\nabla（換行＋abla）改算：\n 開頭的 LaTeX 指令也是被 JSON 吃掉的反斜線（下一個測試）
        for (const s of ['\u000crac{1}{2}', '2 \times 3', '\rightarrow', '\beta', '\u000bec', '\nabla']) assert.equal(perf.hasCtrlEscapes({ a: [s] }), true, JSON.stringify(s));
        for (const s of ['第一行\n第二行', 'a\tb'.replace('b', '1'), '\t中文', '\\frac{1}{2}']) assert.equal(perf.hasCtrlEscapes(s), false, JSON.stringify(s));
        assert.equal(perf.hasCtrlEscapes(null), false);
        assert.equal(perf.hasCtrlEscapes(42), false);
    });

    test('charCounts：中日韓字元（含全形標點）與其他', () => {
        assert.deepEqual(perf.charCounts('設 $x$，求值。'), { cjk: 5, other: 4 });
        assert.deepEqual(perf.charCounts(''), { cjk: 0, other: 0 });
    });

    test('〔審查修正〕\\n 開頭的 LaTeX 指令（\\neq、\\nu、\\nabla、\\not…）也算；避開真的換行；\\ne／\\nu／\\ni 只在 $…$ 裡才算', () => {
        // 模型寫單一反斜線 → JSON.parse 之後是「換行＋指令名的其餘字母」
        const parsed = (latex) => JSON.parse(`"${latex}"`);
        for (const latex of ['$a \\neq b$', '$\\nabla f$', '$\\not= 0$', '$x \\notin A$', '$\\nu = 3$', '$a \\ne b$', '$x \\ni y$', '$\\nleq$', '甲 \\nRightarrow 乙']) {
            assert.equal(perf.hasCtrlEscapes(parsed(latex)), true, latex);
        }
        // 真的換行：換行後接中文、選項、英文單字、數字；短的指令名在 $…$ 外面；$$…$$ 裡的短指令寧可少算
        for (const s of ['第一行\n第二行', '(A) 甲\n(B) 乙', 'first line\nnext line', 'x = 1\nu = 3', '答：\ne 為自然對數的底', '\n\n段落', '$$a \ne b$$', 'note\nothing']) {
            assert.equal(perf.hasCtrlEscapes(s), false, JSON.stringify(s));
        }
        assert.ok(perf.N_COMMAND_TAILS.includes('eq') && perf.N_COMMAND_TAILS.includes('abla') && perf.N_COMMAND_TAILS.includes('ot'));
        assert.deepEqual([...perf.N_COMMAND_SHORT], ['e', 'u', 'i']);
    });

    test('〔審查修正〕restoreCtrlEscapes：hasCtrlEscapes 認得的都修回反斜線，其餘一個字都不動', () => {
        assert.equal(perf.restoreCtrlEscapes('$\u000crac{1}{2} \times 3$'), '$\\frac{1}{2} \\times 3$');
        assert.equal(perf.restoreCtrlEscapes('$a \neq b$ 且 $\nu = 2$'), '$a \\neq b$ 且 $\\nu = 2$');
        assert.equal(perf.restoreCtrlEscapes('$\rightarrow \beta$'), '$\\rightarrow \\beta$');
        for (const s of ['第一行\n第二行', 'x = 1\nu = 3', '\t中文', '$\\frac{1}{2}$', '']) assert.equal(perf.restoreCtrlEscapes(s), s, JSON.stringify(s));
        assert.equal(perf.restoreCtrlEscapes(null), '');
        for (const s of ['$\u000crac{1}{2}$', '$a \neq b$', '$\nu$']) assert.equal(perf.hasCtrlEscapes(perf.restoreCtrlEscapes(s)), false, JSON.stringify(s));
    });
});

describe('estimateSpeeds：推算輸出與讀 prompt 的速度', () => {
    const pair = (start, hash, tin, [lat1, out1], [lat2, out2], gapSec = 2) => [
        entry({ agent: 'variant', partsHash: hash, usage: { tokenIn: tin, tokenOut: out1, tokenThinking: 0 }, ...at(start, lat1) }),
        entry({ agent: 'variant', partsHash: hash, usage: { tokenIn: tin, tokenOut: out2, tokenThinking: 0 }, ...at(start + lat1 + gapSec, lat2) })
    ];

    test('同一段 prompt 連送兩次：第二次＝輸出速度；第一次多出來的＝部分快取的讀 prompt（〔審查修正〕不當冷的用）', () => {
        const entries = [
            ...pair(0, 'p1', 2000, [200, 200], [100, 200]),           // 輸出 2 token/秒；讀 2000 token 用 100 秒 → 20
            ...pair(1000, 'p2', 1500, [175, 150], [60, 150])          // 輸出 2.5；175 − 60 = 115 秒 → 13.04
        ];
        const s = perf.estimateSpeeds(entries);
        assert.equal(s.byModel.length, 1);
        const m = s.byModel[0];
        assert.equal(m.pairs, 2);
        assert.equal(m.outTps, (2 + 2.5) / 2, '中位數');
        assert.ok(Math.abs(m.partialPromptTps - (20 + 1500 / 115) / 2) < 1e-9, `${m.partialPromptTps}`);
        assert.deepEqual([m.promptPairs, m.partialPairs], [2, 2], '看不出科目的變式（前綴不明）算部分快取');
        assert.equal(m.coldPromptTps, null, '第一支是這一批的第一支（含載入）、第二對的第一次前綴不明：沒有冷的樣本');
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
        assert.equal(short.partialPromptTps, null, `讀 ${perf.SPEED_RULES.PAIR_MIN_PROMPT_TOKENS} token 以下不推讀 prompt 速度`);
        assert.equal(short.coldPromptTps, null);
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

    test('speedFor：有分段時間用 Ollama 量的；再來連送兩次；再來 r² 最高的迴歸；〔審查修正〕沒有冷的樣本時退回部分快取並標 promptPartial', () => {
        const withTiming = [entry({ usage: { tokenIn: 1000, tokenOut: 100, tokenThinking: 0 }, timing: { promptEvalMs: 50 * SEC, evalMs: 40 * SEC }, ...at(0, 95) })];
        const s1 = perf.estimateSpeeds(withTiming);
        assert.deepEqual(perf.speedFor(s1, M), { outTps: 2.5, promptTps: 20, source: 'Ollama 的分段時間', promptPartial: false, slotsAtLeast: null });
        const s2 = perf.estimateSpeeds(pair(0, 'p', 2000, [200, 200], [100, 200]));
        const sp2 = perf.speedFor(s2, M);
        assert.deepEqual([sp2.outTps, sp2.promptTps, sp2.promptPartial], [2, 20, true]);
        assert.match(sp2.source, /^輸出：同一段 prompt 連送兩次（1 對）；讀 prompt：\*\*沒有冷的樣本，暫用連送兩次的第一次（部分快取，偏快/);
        const s3 = perf.estimateSpeeds([100, 200, 300, 400, 500].map((out, i) => entry({ agent: 'verify', usage: { tokenIn: 300, tokenOut: out, tokenThinking: 0 }, ...at(i * 1000, 0.5 * out) })));
        assert.deepEqual([perf.speedFor(s3, M).outTps, perf.speedFor(s3, M).promptTps], [2, null]);
        assert.equal(perf.speedFor(perf.estimateSpeeds([]), M).source, '沒有資料');
    });

    // 〔審查修正〕冷的讀 prompt 只用「這個 agent 第一次出現」的呼叫
    const call = (o) => entry({ template: `${o.agent}.v1`, ...o });
    const seq = (items) => {
        let t = 0;
        return items.map(({ gap = 2, lat, ...o }) => {
            const e = call({ ...o, ...at(t + gap, lat) });
            t += gap + lat;
            return e;
        });
    };
    const u = (tokenIn, tokenOut) => ({ usage: { tokenIn, tokenOut, tokenThinking: 0 } });

    test('冷的讀 prompt：只用 agent 第一次出現的；同一個 agent 換科的只列出；第一支、隔太久、讀太少、輸出占一半以上的不採用', () => {
        const entries = seq([
            { agent: 'nlq', ...u(1400, 50), lat: 300 },                                                   // 這一批的第一支（含載入）
            { agent: 'variant', subject: '數學', partsHash: 'v1', ...u(2000, 200), lat: 350 },           // 冷：350 − 200/2 ＝ 250 秒 → 8
            { agent: 'variant', subject: '數學', partsHash: 'v1', ...u(2000, 200), lat: 100, gap: 1 },   // 連送兩次 → 輸出 2 token/秒
            { agent: 'variant', subject: '數學', partsHash: 'v2', ...u(2000, 200), lat: 150 },           // 同一科的下一題：部分快取
            { agent: 'variant', subject: '數學', partsHash: 'v2', ...u(2000, 200), lat: 100, gap: 1 },
            { agent: 'variant', subject: '物理', partsHash: 'v3', ...u(1800, 100), lat: 200 },           // 換科：200 − 50 ＝ 150 秒 → 12（只列出）
            { agent: 'lint', ...u(900, 1000), lat: 520 },                                                 // 讀不到 1000
            { agent: 'classify', subject: '數學', ...u(3600, 60), lat: 480, gap: 6 * 60 },               // 離上一支 6 分
            { agent: 'verify', ...u(1200, 900), lat: 480 }                                                // 輸出 450 秒，占一半以上
        ]);
        const m = perf.estimateSpeeds(entries).byModel[0];
        assert.equal(m.outTps, 2);
        assert.deepEqual(m.cold.map(c => [c.agent, c.strict, Math.round(c.tps * 1000) / 1000]), [['variant', true, 8], ['variant', false, 12]]);
        assert.equal(m.coldPromptTps, 8, '只用 strict 的');
        assert.equal(m.coldIncludesSubject, false);
        assert.equal(m.cold[0].prevLabel, '`nlq`');
        assert.equal(m.cold[1].label, '`variant`（物理）');
        assert.deepEqual(m.coldSkipped.map(c => c.agent), ['nlq', 'lint', 'classify', 'verify']);
        assert.match(m.coldSkipped[0].why, /第一支/);
        assert.match(m.coldSkipped[1].why, /只讀 900 token/);
        assert.match(m.coldSkipped[2].why, /離上一支 6 分/);
        assert.match(m.coldSkipped[3].why, /一半以上/);
        // 連送兩次的第一次：v1 是冷的（不算部分快取）、v2 是部分快取
        assert.deepEqual(m.examples.map(p => p.firstPrefix), ['new', 'seen']);
        assert.deepEqual([m.promptPairs, m.partialPairs], [2, 1]);
        assert.equal(m.partialPromptTps, 2000 / 50);
        const sp = perf.speedFor({ byModel: [m], regressions: [] }, M);
        assert.deepEqual([sp.outTps, sp.promptTps, sp.promptPartial], [2, 8, false]);
        assert.match(sp.source, /冷的讀 prompt：這個 agent 第一次出現的 1 支/);

        // 只有「換科」的樣本時才用它，並標 coldIncludesSubject
        const onlySubject = perf.estimateSpeeds(entries.filter(e => !(e.agent === 'variant' && e.subject === '數學' && e.partsHash === 'v1'))).byModel[0];
        assert.equal(onlySubject.coldIncludesSubject, true);
    });

    test('prefixFamily：分類、出變式要連科目；看不出科目回 null；其他 agent 看 agent＋模板', () => {
        assert.deepEqual([...perf.SUBJECT_PREFIX_AGENTS], ['classify', 'variant']);
        assert.notEqual(perf.prefixFamily({ agent: 'classify', template: 'c', subject: '數學' }), perf.prefixFamily({ agent: 'classify', template: 'c', subject: '物理' }));
        assert.equal(perf.prefixFamily({ agent: 'classify', template: 'c', subject: null }), null);
        assert.equal(perf.prefixFamily({ agent: 'verify', template: 'v' }), perf.prefixFamily({ agent: 'verify', template: 'v', subject: '物理' }));
        assert.notEqual(perf.prefixFamily({ agent: 'verify', template: 'v' }), perf.prefixFamily({ agent: 'lint', template: 'v' }));
        assert.equal(perf.subjectOfChapter('直線運動'), '物理');
        assert.equal(perf.subjectOfChapter('不存在的章'), null);
    });

    test('SUBJECT_PREFIX_AGENTS 的前提：分類與出變式的模板，第一行之後就是該科的章節白名單', () => {
        for (const mod of ['../../agents/classify', '../../agents/generateVariant']) {
            const t = require(mod).PROMPT_TEMPLATE;
            const lines = t.split('\n');
            assert.ok(!lines[0].includes('{{'), `${mod} 第一行沒有挖空欄位`);
            assert.ok(lines.slice(1, 3).some(l => l.includes('{{CHAPTER_WHITELIST}}')), `${mod} 第一行之後就是白名單`);
        }
    });

    test('同一段 prompt 中間夾了別的呼叫再送一次：熱的 → 至少幾份快取；冷的不算', () => {
        const entries = seq([
            { agent: 'nlq', ...u(1400, 50), lat: 300 },
            { agent: 'variant', subject: '數學', partsHash: 'a', ...u(2000, 200), lat: 350 },   // 冷：讀速 8（輸出速度由下面的連送兩次推）
            { agent: 'verify', partsHash: 'x', ...u(300, 400), lat: 210 },
            { agent: 'lint', partsHash: 'y', ...u(900, 800), lat: 420 },
            { agent: 'variant', subject: '數學', partsHash: 'a', ...u(2000, 200), lat: 105 },   // 扣掉輸出 5 秒 × 8 ＝ 40 token < 1000 → 熱
            { agent: 'variant', subject: '數學', partsHash: 'b', ...u(2000, 200), lat: 300 },
            { agent: 'variant', subject: '數學', partsHash: 'b', ...u(2000, 200), lat: 100, gap: 1 },  // 連送兩次 → 輸出 2
            { agent: 'classify', subject: '物理', partsHash: 'c', ...u(2500, 60), lat: 330 },
            { agent: 'verify', partsHash: 'z', ...u(300, 400), lat: 210 },
            { agent: 'classify', subject: '物理', partsHash: 'c', ...u(2500, 60), lat: 330 }    // 扣掉輸出 300 秒 × 8 ＝ 2400 → 冷
        ]);
        const m = perf.estimateSpeeds(entries).byModel[0];
        assert.equal(m.outTps, 2);
        assert.equal(m.resends.length, 2);
        const [hot, cold] = m.resends;
        assert.deepEqual([hot.agent, hot.between, hot.otherFamilies, hot.hot], ['variant', ['verify', 'lint'], 2, true]);
        assert.equal(Math.round(hot.secondNonOutSec), 5);
        assert.deepEqual([cold.agent, cold.between, cold.hot], ['classify', ['verify'], false]);
        assert.equal(m.slotsAtLeast, 3, '夾了 2 種別的前綴仍是熱的 → 至少 3 份');
        assert.equal(perf.speedFor({ byModel: [m], regressions: [] }, M).slotsAtLeast, 3);
        // 夾太多支的不看
        const far = seq([
            { agent: 'variant', subject: '數學', partsHash: 'a', ...u(2000, 200), lat: 350 },
            ...Array.from({ length: perf.SPEED_RULES.RESEND_MAX_BETWEEN + 1 }, (_, i) => ({ agent: 'verify', partsHash: `v${i}`, ...u(300, 400), lat: 210 })),
            { agent: 'variant', subject: '數學', partsHash: 'a', ...u(2000, 200), lat: 105 }
        ]);
        assert.equal(perf.estimateSpeeds(far).byModel[0].resends.length, 0);
    });

    test('repeatsOf：同一段 prompt 相鄰兩次的回答逐字相同嗎；驗算另看最終答案', () => {
        const r = (agent, hash, answerHash, finalAnswer = null, tokenOut = 100) => entry({ agent, partsHash: hash, answerHash, finalAnswer, ...u(1000, tokenOut) });
        const out = perf.repeatsOf([
            r('variant', 'a', 'x'), r('variant', 'a', 'x'), r('variant', 'a', 'y', null, 150),
            r('variant', 'b', 'z'), r('variant', 'c', 'z'),
            r('verify', 'v', 'p', '3', 400), r('verify', 'v', 'q', '3', 420)
        ]);
        assert.deepEqual([out.pairs, out.identical], [3, 1]);
        const by = Object.fromEntries(out.byAgent.map(x => [x.agent, x]));
        assert.deepEqual({ ...by.variant }, { agent: 'variant', pairs: 2, identical: 1, closeOut: 1, finalPairs: 0, sameFinal: 0 });
        assert.deepEqual({ ...by.verify }, { agent: 'verify', pairs: 1, identical: 0, closeOut: 1, finalPairs: 1, sameFinal: 1 });
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

    test('假設的數字（改了要一併改文件 docs/local-mode.md 第 10.14 條）', () => {
        const A = perf.PAPER_ASSUMPTIONS;
        assert.deepEqual([A.QUESTIONS, A.PAGES], [10, 4]);
        assert.deepEqual({ ...A.LINT_LLM_RATE }, { low: 0.1, high: 0.2 });
        assert.deepEqual({ ...A.CLASSIFY_LLM_RATE }, { low: 0, high: 1 });
        assert.deepEqual({ ...A.VERIFY_FAIL_RATE }, { low: 0, high: 0.3 });
        assert.equal(perf.KV_BYTES_PER_TOKEN_8B, 147_456);
        assert.deepEqual({ ...A.CLASSIFY_PER_QUESTION_SHARE }, { low: 0.58, high: 0.68 });
        assert.equal(A.KC_BACKFILL_QUESTIONS, 200);
    });

    test('〔審查修正〕CLASSIFY_PER_QUESTION_SHARE 用目前的模板重算：few-shot 起到結尾占整段 prompt 的比例（數學／物理各第一題）', async () => {
        const bench = require('../../eval/tools/local_bench_text');
        const ollama = require('../../services/llm/ollama');
        const classify = require('../../agents/classify');
        const header = classify.fewShotText([{ question_text: 'x', chapter: 'y' }]).split('\n')[0];
        const qs = bench.loadFixtureQuestions();
        const shares = {};
        for (const subject of ['數學', '物理']) {
            const q = qs.find(x => x.subject === subject);
            const req = await bench.captureRequest('classify', bench.inputFor('classify', q), 'ollama:qwen3:8b');
            const system = `${req.system}\n\n${ollama.schemaGuide(ollama.toOllamaSchema(req.schema))}`;
            const user = ollama.toUserMessage(req.parts).content;
            const at = user.indexOf(header);
            assert.ok(at > 0, '找得到 few-shot 的標頭');
            const perQuestion = bench.estimateTokens(user.slice(at));
            shares[subject] = perQuestion / (bench.estimateTokens(system) + bench.estimateTokens(user));
        }
        const A = perf.PAPER_ASSUMPTIONS.CLASSIFY_PER_QUESTION_SHARE;
        assert.ok(Math.abs(shares['物理'] - A.low) <= 0.03, `物理 ${shares['物理']}`);
        assert.ok(Math.abs(shares['數學'] - A.high) <= 0.03, `數學 ${shares['數學']}`);
    });

    test('〔審查修正〕合計要用的步驟沒有回放檔：照樣列一列、每次「—」，列進 total.missing（不再悄悄少算）', () => {
        const noVerify = new Map([...stats].filter(([k]) => k !== 'verify' && k !== 'ocr'));
        const p = perf.estimatePaper({ stats: noVerify, speeds, thinking, entries: [], settings, paper: { questions: 10, pages: 4 } });
        const by = Object.fromEntries(p.rows.map(r => [r.key, r]));
        assert.deepEqual([by.verify.perCallMs, by.verify.total], [{ low: null, high: null }, { low: null, high: null }]);
        assert.match(by.verify.basis, /沒有 verify 的回放檔/);
        assert.match(by.ocr.basis, /沒有 ocr/);
        assert.deepEqual(p.total.missing, ['ocr', 'verify']);
        const s = Object.fromEntries(p.savings.map(x => [x.option, x]));
        assert.equal(s.c.total, null);
    });

    test('〔審查修正〕statsInfo：那一步用的是不思考版 → 選項寫「已經是不思考」；uncertain 比例也看不思考版', () => {
        const noThinkVerify = [...Array(4).fill(0).map(() => entry({ agent: 'verify', sampleNo: 1, noThink: true })), entry({ agent: 'verify', sampleNo: 2, noThink: true })];
        const info = new Map([['verify', { noThink: true, note: '（只有不思考版的回放檔）' }]]);
        const p = perf.estimatePaper({ stats, statsInfo: info, speeds, thinking, entries: noThinkVerify, settings, paper: { questions: 10, pages: 4 } });
        const s = Object.fromEntries(p.savings.map(x => [x.option, x]));
        assert.deepEqual([s.c.perCallMs, s.c.total], [null, null]);
        assert.match(s.c.note, /已經是不思考版/);
        assert.equal(p.uncRate, 1 / 4);
        assert.match(p.rows.find(r => r.key === 'verify').basis, /只有不思考版的回放檔/);
        assert.deepEqual(perf.verifyUncertainRate(noThinkVerify), null, '預設只看思考版');
        assert.deepEqual(perf.verifyUncertainRate(noThinkVerify, { noThink: true }), { rate: 0.25, first: 4, second: 1 });
    });

    test('〔審查修正〕currentStats：照 .env 的 OLLAMA_NO_THINK 挑思考版或不思考版；挑的沒有就用另一版並加註', () => {
        const think = new Map([['verify', { agent: 'verify', tag: 'T' }], ['lint', { agent: 'lint', tag: 'T' }], ['classify', { agent: 'classify', tag: 'T' }]]);
        const noThink = new Map([['verify', { agent: 'verify', tag: 'N' }], ['kc_tag', { agent: 'kc_tag', tag: 'N' }]]);
        // 〔Owner 第五輪 C-b〕OLLAMA_NO_THINK=none：取消本機預設（kc_tag 照舊思考），與加預設之前的「沒寫」相同
        const a = perf.currentStats(think, noThink, { OLLAMA_NO_THINK: 'none' });
        assert.deepEqual([a.stats.get('verify').tag, a.stats.get('lint').tag, a.stats.get('kc_tag').tag], ['T', 'T', 'N']);
        assert.deepEqual([a.info.get('verify').noThink, a.info.get('kc_tag').noThink], [false, true]);
        assert.match(a.info.get('kc_tag').note, /只有不思考版/);
        // 〔Owner 第五輪 C-b〕什麼都沒寫：kc_tag 本機預設不思考 → 挑不思考版、註明是本機預設
        const d = perf.currentStats(think, noThink, {});
        assert.deepEqual([d.stats.get('kc_tag').tag, d.info.get('kc_tag').noThink, d.stats.get('verify').tag], ['N', true, 'T']);
        assert.match(d.info.get('kc_tag').note, /本機預設不思考（Owner 第五輪 C-b）：用不思考版的回放檔/);
        const b = perf.currentStats(think, noThink, { OLLAMA_NO_THINK: 'verify,lint,classify' });
        assert.deepEqual([b.stats.get('verify').tag, b.stats.get('lint').tag, b.stats.get('classify').tag], ['N', 'T', 'T']);
        assert.deepEqual([b.info.get('verify').noThink, b.info.get('lint').noThink, b.info.get('classify').noThink], [true, false, false]);
        assert.match(b.info.get('lint').note, /設了 `OLLAMA_NO_THINK`，但只有思考版/);
        assert.equal(b.info.get('classify').note, null, '本來就不思考的不受 OLLAMA_NO_THINK 影響');
    });

    test('〔審查修正〕既有題庫補標（paper.backfill）：知識點標註那一列與選項 b 都乘上題數', () => {
        const p = perf.estimatePaper({ stats, speeds, thinking, entries: verifyEntries, settings, paper: { questions: 10, pages: 4, backfill: 50 } });
        const kc = p.rows.find(r => r.key === 'kc_tag');
        assert.equal(kc.backfill.questions, 50);
        assert.ok(Math.abs(kc.backfill.low - 5 * kc.total.low) < 1e-6);
        const b = p.savings.find(x => x.option === 'b');
        assert.ok(Math.abs(b.backfill.low - 5 * b.total.low) < 1e-6);
        assert.equal(perf.estimatePaper({ stats, speeds, thinking, entries: verifyEntries, settings, paper: { questions: 10, pages: 4 } }).backfill, 200);
    });

    test('〔審查修正〕extractOcrTokens：給了就照它估 OCR 整理；extractOcrTokenEstimate 從模板與回放檔重算', () => {
        const p = perf.estimatePaper({
            stats, speeds, thinking, entries: verifyEntries, settings, paper: { questions: 10, pages: 4 },
            extractOcrTokens: { fixedTokens: 2000, tokensPerPage: 500, outPerQuestion: 100, basis: '依據' }
        });
        // (2000 + 500 × 2) ÷ 20 ＋ (100 × 10 ÷ 2) ÷ 2 ＝ 150 ＋ 250 秒
        const exo = p.rows.find(r => r.key === 'extract_ocr');
        assert.deepEqual(exo.perCallMs, { low: 400 * SEC, high: 400 * SEC });
        assert.match(exo.basis, /讀約 3,000 token、寫約 500 token（讀＋寫約 3,500）.*依據/);

        const none = perf.extractOcrTokenEstimate([]);
        assert.ok(none.fixedTokens > 1500 && none.fixedTokens < 4000, `${none.fixedTokens}`);
        assert.deepEqual([none.tokensPerPage, none.outPerQuestion], [perf.PAPER_ASSUMPTIONS.OCR_TOKENS_PER_PAGE, perf.PAPER_ASSUMPTIONS.EXTRACT_OUT_TOKENS_PER_QUESTION]);
        assert.match(none.basis, /沒有 ocr 回放檔.*沒有 extract 回放檔/);
        const ocr = entry({ agent: 'ocr', ocrText: { cjk: 100, other: 200 }, pages: 2 });
        const ex = entry({ agent: 'extract', answer: { cjk: 1000, other: 1000 }, gateItems: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }] });
        const got = perf.extractOcrTokenEstimate([ocr, ex]);
        const T = require('../../eval/tools/local_bench_text').TOKENS_PER_CHAR;
        assert.ok(Math.abs(got.tokensPerPage - (T.cjk * 100 + T.other * 200) / 2) < 1e-9);
        assert.ok(Math.abs(got.outPerQuestion - (T.cjk * 1000 + T.other * 1000) / 2) < 1e-9);
        assert.equal(got.fixedTokens, none.fixedTokens);
    });

    test('〔審查修正〕formulaGateStats／gateBatches：閘門不過、帶控制字元通過、修回後仍不過；回放檔依供應商分批', () => {
        // 假的閘門：有 BAD 或換頁字元就不過
        const gate = (q) => ({ ok: !q.includes('BAD') && !q.includes('\u000c') });
        const [g] = perf.formulaGateStats([{ key: 'k', label: 'L', items: [{ q: 'ok' }, { q: '\u000crac' }, { q: 'BAD' }, { q: '2 \times 3' }] }], { gate });
        assert.deepEqual(g, { key: 'k', label: 'L', short: 'k', n: 4, ctrl: 2, fail: 2, ctrlPass: 1, failAfterRestore: 1 });
        assert.deepEqual(perf.formulaGateStats([{ key: 'empty', label: 'E', items: [] }], { gate }), []);

        const e = (agent, vendor, model, items) => entry({ agent, vendor, model, gateItems: items });
        const batches = perf.gateBatches([
            e('variant', 'ollama', 'qwen3:8b', [{ q: 'a', a: '1' }]), e('variant', 'gemini', 'gemini-x', [{ q: 'b', a: '2' }]),
            e('variant', 'ollama', 'qwen3:8b', [{ q: 'c', a: '3' }]), e('extract', 'gemini', 'gemini-x', [{ q: 'd', a: '4' }, { q: 'e', a: '5' }]),
            e('lint', 'ollama', 'qwen3:8b', [{ q: 'f', a: '6' }]), e('classify', 'ollama', 'qwen3:8b', null)
        ], [{ question_text: 'q', answer_text: 'a' }]);
        assert.deepEqual(batches.map(b => [b.key, b.items.length]), [['fixture', 1], ['extract/gemini', 2], ['variant/gemini', 1], ['variant/ollama', 2], ['lint/ollama', 1]]);
        assert.equal(batches.find(b => b.key === 'variant/ollama').short, '本機 變式');
        assert.match(batches.find(b => b.key === 'variant/ollama').label, /`qwen3:8b` 出的變式（2 支回放檔）/);
        assert.deepEqual(perf.gateBatches([], null), []);
    });

    test('〔審查修正〕gateItemsOf：變式、拆題（每一題）、lint 的輸入；其他 agent 沒有', () => {
        assert.deepEqual(perf.gateItemsOf('variant', { response: { data: { question_text: 'Q', answer_text: 'A' } } }), [{ q: 'Q', a: 'A' }]);
        assert.deepEqual(perf.gateItemsOf('extract_ocr_chem', { response: { data: { questions: [{ question_text: 'Q1' }, null, { question_text: 'Q2', answer_text: 'A2' }] } } }),
            [{ q: 'Q1', a: '' }, { q: 'Q2', a: 'A2' }]);
        assert.deepEqual(perf.gateItemsOf('lint', { request: { cacheKeyParts: { questionText: 'Q', answerText: 'A' } }, response: {} }), [{ q: 'Q', a: 'A' }]);
        assert.equal(perf.gateItemsOf('classify', { response: { data: { chapter: '數列' } } }), null);
        assert.equal(perf.gateItemsOf('variant', { response: {} }), null);
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
        // 〔Owner 第五輪 L-3〕\textbf 之後解析器支援，「公式寫錯」的那一題改用不支援的 \vecc（斷言不變）
        const fixtureQuestions = [{ question_text: '求 $\\frac{1}{2}$ 的值', answer_text: '$\\frac{1}{2}$' }, { question_text: '求 $\\vecc{v}$', answer_text: '1' }];
        const { markdown, data } = perf.buildReport(perf.parseArgs(['--cassettes', dir]), { env: {}, now: new Date(2026, 8, 26, 12), fixtureQuestions });
        for (const h of ['### 1.2 ', '### 1.3 ', '### 1.4 ', '### 1.5 ', '### 1.6 ', '## 4. ', '### 4.1 ']) assert.ok(markdown.includes(h), h);
        assert.match(markdown, /\| `lint`（不思考） \| `qwen3:8b` \| 1（樣本少：p90 等於最大值） \|/);
        assert.match(markdown, /\| `lint` \| `qwen3:8b` \| 3（樣本少：p90 等於最大值） \|/);
        assert.match(markdown, /一份 10 題、4 頁的卷，每塊 2 頁/);
        // 第 1 題的 \frac 被 JSON 吃掉（連送兩次，兩支都算）；〔審查修正〕是下限，寫「至少」
        assert.match(markdown, /\| `variant` \| `qwen3:8b` \| 至少 2／12 \| 至少 17% \|/);
        // 〔審查修正〕公式閘門（fixture 注入兩題：一題公式寫錯）、溫度 0 的重現性（6 對連送兩次，回答都相同）、既有題庫補標
        assert.match(markdown, /\| fixture 題目（`eval\/fixtures\/questions\.public\.json`） \| 2 \| 0（0%） \| 1（50%） \| 0 \| 1／1 \|/);
        assert.match(markdown, /\| `qwen3:8b` 出的變式（12 支回放檔） \| 12 \| 2（17%） \|/);
        assert.match(markdown, /\| `variant` \| `qwen3:8b` \| 6 \| 6（100%） \| 6／6 \| — \|/);
        assert.match(markdown, /既有題庫補標知識點（`npm run kc:backfill`；200 題/);
        assert.deepEqual(data.gate.map(g => g.key), ['fixture', 'variant/ollama'], 'lint 的回放檔沒有 cacheKeyParts.questionText');
        assert.equal(data.speeds.byModel[0].pairs, 6);
        assert.ok(Math.abs(data.speeds.byModel[0].outTps - 2) < 0.05, `${data.speeds.byModel[0].outTps}`);
        assert.ok(data.paper && data.paper.rows.some(r => r.key === 'verify'));
        assert.equal(data.paper.uncRate, 2 / 10);
        assert.ok(!/\n{3,}/.test(markdown), '不要有連續空行');

        const big = perf.buildReport(perf.parseArgs(['--cassettes', dir, '--questions', '20', '--pages', '6', '--backfill', '50']), { env: { JOB_PDF_CHUNK_PAGES: '3' }, fixtureQuestions }).markdown;
        assert.match(big, /一份 20 題、6 頁的卷，每塊 3 頁（`JOB_PDF_CHUNK_PAGES`＝3，\.env）＝2 塊/);
        assert.match(big, /既有題庫補標知識點（`npm run kc:backfill`；50 題/);
    });

    test('parseArgs：--questions／--pages 有給才出現 paper；範圍 1～200', () => {
        assert.equal('paper' in perf.parseArgs([]), false, '沒給時 args 的形狀與之前相同');
        assert.deepEqual(perf.parseArgs(['--pages', '6']).paper, { pages: 6 });
        assert.deepEqual(perf.parseArgs(['--questions', '12', '--pages', '3']).paper, { questions: 12, pages: 3 });
        assert.throws(() => perf.parseArgs(['--questions', '0']), /1～200/);
        assert.throws(() => perf.parseArgs(['--pages', 'abc']), /1～200/);
        assert.throws(() => perf.parseArgs(['--pages']), /後面要接一個值/);
        assert.match(perf.USAGE, /--questions <N>/);
        // 〔審查修正〕--backfill 同樣有給才出現
        assert.deepEqual(perf.parseArgs(['--backfill', '198']).paper, { backfill: 198 });
        assert.throws(() => perf.parseArgs(['--backfill', '0']), /1～100000/);
        assert.match(perf.USAGE, /--backfill <N>/);
    });

    test('〔審查修正〕只有 OLLAMA_NO_THINK 錄的驗算：驗算那一列照樣在（用不思考版並加註），選項 c 寫「已經是不思考」；沒有驗算就列進算不出來', () => {
        const d = path.join(tmp, '只有不思考的驗算');
        let t = T0;
        const w = (agent, name, extra = {}) => {
            t += 300 * SEC;
            fs.mkdirSync(path.join(d, agent), { recursive: true });
            fs.writeFileSync(path.join(d, agent, `${name}.json`), JSON.stringify({
                meta: { agent, model: M, template: `${agent}.v1`, recorded_at: new Date(t).toISOString() },
                request: { parts: [{ kind: 'text', chars: 10, sha256: name }], cacheKeyParts: { sampleNo: 1 }, ...extra },
                response: { data: { final_answer: '1' }, usage: { tokenIn: 300, tokenOut: 120, tokenThinking: 0, tokenCached: 0 }, latencyMs: 70 * SEC }
            }));
        };
        for (let i = 0; i < 3; i++) w('verify', `nt${i}`, { ollamaOverrides: { think: false } });
        for (const env of [{}, { OLLAMA_NO_THINK: 'verify' }]) {
            const { markdown, data } = perf.buildReport(perf.parseArgs(['--cassettes', d]), { env, fixtureQuestions: [] });
            const row = data.paper.rows.find(r => r.key === 'verify');
            assert.deepEqual([row.perCallMs.low, row.perCallMs.high], [70 * SEC, 70 * SEC], JSON.stringify(env));
            assert.match(row.basis, env.OLLAMA_NO_THINK ? /設了 `OLLAMA_NO_THINK`：用不思考版/ : /只有不思考版的回放檔/);
            assert.match(data.paper.savings.find(s => s.option === 'c').note, /已經是不思考版/);
            assert.ok(!data.paper.total.missing.includes('verify'));
            assert.ok(data.paper.total.missing.includes('lint') && data.paper.total.missing.includes('ocr'), '沒有回放檔的步驟列進算不出來');
            assert.match(markdown, /\*\*合計[^\n]*（\*\*ocr、extract_ocr、classify、lint 算不出來，沒算進去\*\*）/, 'OCR 整理也算不出來：沒有推得出的速度');
        }
    });

    test('沒有本機資料：第 4 段說明估不出來', () => {
        const empty = path.join(tmp, '空的');
        fs.mkdirSync(empty, { recursive: true });
        const { markdown } = perf.buildReport(perf.parseArgs(['--cassettes', empty]), { env: {} });
        assert.match(markdown, /## 4\. [^\n]*\n\n沒有本機模型（Ollama／PaddleOCR）的資料，估不出來。/);
    });
});
