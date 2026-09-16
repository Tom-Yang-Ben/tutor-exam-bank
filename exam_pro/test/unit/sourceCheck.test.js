// ─────────────────────────────────────────────────────────────
// sourceCheck.test.js — 拆題結果對照原卷文字層（utils/sourceCheck.js、agents/source_check.js）
//
// docs/source-check.md 的演算法逐條釘住：正規化 → 定位 → 比對 → agent 合約。
// **所有題目與「原卷文字層」都是本檔自編**（NOTICE：repo 不得放真實考卷內容）。
// 公開樣卷的端到端斷言在 sourceCheckSample.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULTS, normalizeSourceText, latexToComparable, stripNumbering, tally, hasTextLayer,
    locateSegments, compareSegment, describeMismatch
} = require('../../utils/sourceCheck');
const agent = require('../../agents/source_check');

// ── 自編的「原卷文字層」：模仿 mupdf 抽出來的樣子（題號、選項各一行、公式攤平）──
const PAGE = [
    '一、單選題（每題 5 分）',
    '1. 設函數圖形通過兩點，且斜率為負數，求此直線在 y 軸上的截距。',
    '(A) -3 (B) -1 (C) 1 (D) 3',
    '2. 某班學生共有四十人，其中喜歡數學的人數比喜歡物理的人數多八人，求喜歡物理的人數。',
    '(A) 12 (B) 16 (C) 20 (D) 24',
    '3. 已知兩向量的長度與夾角，求兩向量內積之值（以 m 表示）。',
    '(A) 1/m (B) 2/m (C) 3/m (D) 4/m',
    '4. 一物體由靜止開始沿光滑斜面下滑，斜面長度為十公尺，傾斜角為 30°，求物體到達底端時的速率。',
    ''
].join('\n');

const Q1 = '設函數圖形通過兩點，且斜率為負數，求此直線在 $y$ 軸上的截距。\n(A) $-3$ (B) $-1$ (C) $1$ (D) $3$';
const Q2 = '某班學生共有四十人，其中喜歡數學的人數比喜歡物理的人數多八人，求喜歡物理的人數。\n(A) $12$ (B) $16$ (C) $20$ (D) $24$';
const Q3 = '已知兩向量的長度與夾角，求兩向量內積之值（以 $m$ 表示）。\n(A) $\\frac{1}{m}$ (B) $\\frac{2}{m}$ (C) $\\frac{3}{m}$ (D) $\\frac{4}{m}$';
const Q4 = '一物體由靜止開始沿光滑斜面下滑，斜面長度為 $10$ 公尺，傾斜角為 $30^\\circ$，求物體到達底端時的速率。';

function locatedSegment(questionText, page = PAGE) {
    const [r] = locateSegments([{ question_text: questionText }], page);
    assert.equal(r.status, 'located', `自編題定位失敗：${r.status}`);
    return r.segment;
}

describe('正規化', () => {
    test('\\frac 的分子負號算一個負號，數字與字母都留下', () => {
        const t = tally(latexToComparable('$\\frac{-1}{2m}$'));
        assert.equal(t.minus, 1);
        assert.deepEqual(t.digits, { 1: 1, 2: 1 });
        assert.deepEqual(t.lower, { m: 1 });
    });

    test('\\pm／\\mp 不算負號', () => {
        assert.equal(tally(latexToComparable('$x = \\pm 3$、$y = \\mp 1$')).minus, 0);
    });

    test('array 的欄位格式 {|c|c|} 與環境名不留下字母', () => {
        const t = tally(latexToComparable('$$\\begin{array}{|c|c|} \\hline a & b \\\\ \\hline \\end{array}$$'));
        assert.deepEqual(t.lower, { a: 1, b: 1 });
    });

    test('sin／cos／log 等函數名保留（原卷文字層也印得出來），\\left／\\right 與一般指令名去掉', () => {
        const t = tally(latexToComparable('$\\sin\\theta + \\cos\\left(x\\right) + \\log_{2} 8$'));
        assert.deepEqual(t.lower, { s: 2, i: 1, n: 1, c: 1, o: 2, x: 1, l: 1, g: 1 });
    });

    test('\\text{…} 保留內容（單位要比得到）', () => {
        assert.deepEqual(tally(latexToComparable('$5\\,\\text{kg}$')).lower, { k: 1, g: 1 });
    });

    test('NFKC：全形數字、字母與全形負號轉成半形', () => {
        assert.equal(normalizeSourceText('１２－ａ'), '12-a');
    });

    test('PUA 對映：U+F02D 是負號、U+F030–F039 是數字；U+F070（Symbol 的 π）不對映', () => {
        assert.equal(normalizeSourceText('x'), 'x-10');
        assert.equal(normalizeSourceText(''), '');
        assert.equal(normalizeSourceText('x1', { puaMap: false }), 'x1');
        assert.equal(tally(normalizeSourceText('')).minus, 2);
    });

    test('題號前綴與配分註記不參與比對', () => {
        const t = tally(stripNumbering('12. 求此值（5分），每題 4 分'));
        assert.deepEqual(t.digits, {});
    });

    test('U+2212 也算負號', () => {
        assert.equal(tally('a−b-c').minus, 2);
    });

    test('文字層太少視為掃描檔', () => {
        assert.equal(hasTextLayer('  \n  '), false);
        assert.equal(hasTextLayer(PAGE), true);
    });
});

describe('定位', () => {
    test('依卷面順序定位，每題的片段含自己的選項、不含下一題', () => {
        const r = locateSegments([Q1, Q2, Q3, Q4].map(q => ({ question_text: q })), PAGE);
        assert.deepEqual(r.map(x => x.status), ['located', 'located', 'located', 'located']);
        assert.ok(r[0].segment.includes('(D) 3'), r[0].segment);
        assert.ok(!r[0].segment.includes('某班'), '選項之後遇到「換行＋題號」就要截斷');
        assert.ok(r[2].segment.includes('4/m'));
        assert.equal(r[0].locate_score, 1);
        assert.ok(r.every(x => !x.shared));
    });

    test('題目中文字太少 → low_anchor', () => {
        const [r] = locateSegments([{ question_text: '求 $x^2$ 之值。' }], PAGE);
        assert.deepEqual(r, { status: 'low_anchor', locate_score: null });
    });

    test('原卷上找不到 → not_found（附覆蓋率）', () => {
        const [r] = locateSegments([{ question_text: '甲乙丙三人參加比賽，丁戊己三人負責裁判，請問共有幾種安排方式？' }], PAGE);
        assert.equal(r.status, 'not_found');
        assert.ok(r.locate_score === null || r.locate_score < DEFAULTS.minCoverage);
    });

    test('掃描頁（沒有文字層）→ 整塊 no_text_layer', () => {
        const r = locateSegments([{ question_text: Q1 }, { question_text: Q2 }], ' \n \n ');
        assert.deepEqual(r.map(x => x.status), ['no_text_layer', 'no_text_layer']);
    });

    test('兩題題幹一字不差時，依序各自落在自己的位置', () => {
        const page = [
            '1. 下列關於等速圓周運動的敘述，何者正確？請寫出理由。',
            '(A) 2 (B) 3',
            '2. 下列關於等速圓周運動的敘述，何者正確？請寫出理由。',
            '(A) 4 (B) 5',
            PAGE
        ].join('\n');
        const stem = '下列關於等速圓周運動的敘述，何者正確？請寫出理由。';
        const r = locateSegments([{ question_text: `${stem}\n(A) $2$ (B) $3$` }, { question_text: `${stem}\n(A) $4$ (B) $5$` }], page);
        assert.ok(r[0].segment.includes('(A) 2'), r[0].segment);
        assert.ok(r[1].segment.includes('(A) 4'), r[1].segment);
    });

    test('題組前導語被放進每個小題（承上題）→ 片段重疊，第二題標 shared', () => {
        const lead = '某商店販售甲乙兩種商品，甲商品每件售價一百元，乙商品每件售價八十元。';
        const page = [
            `題組：${lead}`,
            '(1) 若小華買了三件甲商品，應付多少元？',
            '(2) 若小明買了兩件乙商品，應付多少元？',
            PAGE
        ].join('\n');
        const r = locateSegments([
            { question_text: `${lead}若小華買了三件甲商品，應付多少元？` },
            { question_text: `${lead}若小明買了兩件乙商品，應付多少元？` }
        ], page);
        assert.equal(r[0].status, 'located');
        assert.equal(r[1].status, 'located');
        assert.equal(r[0].shared, undefined);
        assert.equal(r[1].shared, true);
    });

    test('上一題結尾與本題共用詞組時，不從上一題尾巴起算', () => {
        const page = [
            '5. 設點在 z 軸上，求兩點距離之最小值為多少。',
            '6. 設三點座標皆已知，若動點在線段上，且兩向量內積之最小值為多少，最大值又為多少。',
            PAGE
        ].join('\n');
        const q6 = '設三點座標皆已知，若動點在線段上，且兩向量內積之最小值為多少，最大值又為多少。';
        const [r5, r6] = locateSegments([{ question_text: '設點在 $z$ 軸上，求兩點距離之最小值為多少。' }, { question_text: q6 }], page);
        assert.equal(r5.status, 'located');
        assert.ok(!r6.segment.includes('z'), `第 6 題的片段帶進了第 5 題的字母：${r6.segment}`);
    });

    test('上一題以小數結尾（1.5 cm）時，本題片段不把它當題號吞進來、也不誤標 shared', () => {
        const page = [
            '8. 一條繩子的長度為多少，請以公分表示並寫出算式過程。',
            '(A) 1.5 cm',
            '9. 一物體沿水平面等速移動，求其在十秒內移動的距離。',
            PAGE
        ].join('\n');
        const [r8, r9] = locateSegments([
            { question_text: '一條繩子的長度為多少，請以公分表示並寫出算式過程。\n(A) $1.5$ cm' },
            { question_text: '一物體沿水平面等速移動，求其在十秒內移動的距離。' }
        ], page);
        assert.ok(r8.segment.includes('1.5 cm'), r8.segment);
        assert.ok(!r9.segment.includes('cm'), `第 9 題片段帶進了第 8 題的結尾：${r9.segment}`);
        assert.equal(r9.shared, undefined);
    });

    test('片段長度上限 segmentMax', () => {
        const [r] = locateSegments([{ question_text: Q1 }], PAGE, { segmentMax: 20 });
        assert.equal(r.segment.length, 20);
    });
});

describe('比對', () => {
    test('原樣抄對 → match', () => {
        for (const q of [Q1, Q2, Q3]) {
            const r = compareSegment({ questionText: q, segment: locatedSegment(q) });
            assert.equal(r.verdict, 'match', `${q.slice(0, 10)}：${JSON.stringify(r.signals)}`);
        }
    });

    test('多一個負號（原卷段落有負號字形）→ mismatch，說得出多幾個', () => {
        const wrong = Q1.replace('(C) $1$', '(C) $-1$');
        const r = compareSegment({ questionText: wrong, segment: locatedSegment(Q1) });
        assert.equal(r.verdict, 'mismatch');
        assert.deepEqual(r.rules, ['extra_minus']);
        assert.equal(r.signals.extraMinus, 1);
        assert.match(describeMismatch(r), /負號比原卷多 1 個（拆題 3、原卷 2）/);
    });

    test('選項分母漏一個字母 → mismatch，指名漏了哪個字母', () => {
        const wrong = Q3.replace('\\frac{4}{m}', '\\frac{4}{}');
        const r = compareSegment({ questionText: wrong, segment: locatedSegment(Q3) });
        assert.equal(r.verdict, 'mismatch');
        assert.deepEqual(r.rules, ['missing_lower']);
        assert.match(describeMismatch(r), /原卷有、拆題漏掉的字母：m/);
    });

    test('矩陣一格一行、有一格是行首小數（0.5）→ 不當成下一題題號截斷，抄對仍 match', () => {
        const page = [
            '7. 求下列矩陣的行列式值並選出正確答案',
            '-1',
            '0.5',
            '-2',
            '3',
            '(A) 2 (B) -2 (C) 4 (D) 1',
            PAGE
        ].join('\n');
        const q = '求下列矩陣的行列式值並選出正確答案 $\\begin{bmatrix} -1 & 0.5 \\\\ -2 & 3 \\end{bmatrix}$\n(A) $2$ (B) $-2$ (C) $4$ (D) $1$';
        const segment = locatedSegment(q, page);
        assert.ok(segment.includes('(D) 1'), segment);
        const r = compareSegment({ questionText: q, segment });
        assert.equal(r.verdict, 'match', JSON.stringify(r.signals));
    });

    test('原卷段落沒有任何負號字形時，負號規則不觸發（有些 PDF 的算式負號不在文字層）', () => {
        const wrong = Q2.replace('$12$', '$-12$');
        const r = compareSegment({ questionText: wrong, segment: locatedSegment(Q2) });
        assert.equal(r.signals.extraMinus, 0);
        assert.equal(r.verdict, 'match');
    });

    test('附圖題不跑字母規則（圖上的標籤會混進文字層）', () => {
        const wrong = Q3.replace('\\frac{4}{m}', '\\frac{4}{}');
        const r = compareSegment({ questionText: wrong, segment: locatedSegment(Q3), hasFigure: true });
        assert.equal(r.verdict, 'match');
        assert.equal(r.signals.missLower, 0);
    });

    test('等價改寫（原卷「十公尺」vs 拆題 $10$ 公尺、30° vs 30^\\circ）→ match；extraDigitsRule 預設關閉', () => {
        const seg = locatedSegment(Q4);
        assert.equal(compareSegment({ questionText: Q4, segment: seg }).verdict, 'match');
        const strict = compareSegment({ questionText: Q4, segment: seg }, { extraDigitsRule: true });
        assert.equal(strict.verdict, 'mismatch', '打開多出數字規則時，這種改寫就會誤報——這正是預設關閉的理由');
        assert.deepEqual(strict.rules, ['extra_digits']);
    });

    test('\\pm 不算負號：原卷寫 ±、拆題寫 \\pm → match', () => {
        const seg = '設直線方程式為 x - 1 = ±3，求所有滿足條件的實數解，並寫出兩解之和。';
        const q = '設直線方程式為 $x-1=\\pm 3$，求所有滿足條件的實數解，並寫出兩解之和。';
        assert.equal(compareSegment({ questionText: q, segment: seg }).verdict, 'match');
    });

    test('定位錯段（片段與題幹對不上）→ skipped locate_mismatch', () => {
        const r = compareSegment({ questionText: Q2, segment: locatedSegment(Q1) });
        assert.equal(r.verdict, 'skipped');
        assert.equal(r.reason, 'locate_mismatch');
    });

    test('題幹中文字太少 → skipped low_anchor', () => {
        assert.equal(compareSegment({ questionText: '求 $x$。', segment: PAGE }).reason, 'low_anchor');
    });

    test('describeMismatch 對 match／skipped 回空字串', () => {
        assert.equal(describeMismatch({ verdict: 'match' }), '');
        assert.equal(describeMismatch(null), '');
    });
});

// 〔修訂 2026-09-16〕docs/source-check.md 第 5 節「跨 20 頁切塊邊界」限制的現況行為。
// extract 以 JOB_PDF_CHUNK_PAGES（預設 20）頁切塊，attachSourceText 只讀該塊的頁；
// 題目若跨到下一塊，這一塊的文字層在題目中途就結束。以下斷言釘住**目前**的結果，
// 不代表這是期望行為——真實原卷上尚未實測過跨界題，改善前改動這些斷言要同步改文件。
describe('已知限制：題目跨切塊邊界、文字層在題目中途結束', () => {
    const HEAD = [
        '一、單選題（每題 5 分）',
        '說明：本卷共二十題，每題選出一個最適當的選項，答錯不倒扣，請以黑色原子筆作答並寫在指定的位置上。',
        '2. 某班學生共有四十人，其中喜歡數學的人數比喜歡物理的人數多八人，求喜歡物理的人數。',
        '(A) 12 (B) 16 (C) 20 (D) 24',
        '3. 已知兩向量的長度與夾角，求兩向量內積之值（以 m 表示）。',
        '(A) 1/m (B) 2/m (C) 3/m (D) 4/m',
        '4. 一物體由靜止開始沿光滑斜面下滑，斜面長度為十公尺，傾斜角為 30°，求物體到達底端時的速率。'
    ].join('\n');
    const Q1_STEM = '5. 設函數圖形通過兩點，且斜率為負數，求此直線在 y 軸上的截距。';
    const Q3_STEM = '5. 已知兩向量的長度與夾角，求兩向量內積之值（以 m 表示）。';

    /** 把 tail 接在前面幾題之後，當成「這一塊最後一頁」的文字層，回傳最後一題的定位結果 */
    function locateLast(questionText, tail) {
        const pageText = `${HEAD}\n${tail}`;
        assert.ok(hasTextLayer(pageText), '自編文字層要夠長，才不會被當成掃描檔');
        const r = locateSegments([{ question_text: Q2 }, { question_text: Q3 }, { question_text: Q4 }, { question_text: questionText }], pageText);
        return r[3];
    }

    test('選項跨界、被截掉的部分原卷有負號 → 片段只剩部分負號，判 extra_minus（誤報）', () => {
        const r = locateLast(Q1, `${Q1_STEM}\n(A) -3 (B)`);
        assert.equal(r.status, 'located');
        assert.ok(r.segment.endsWith('(A) -3 (B)'), `片段停在文字層末端：${r.segment}`);
        const cmp = compareSegment({ questionText: Q1, segment: r.segment });
        assert.equal(cmp.verdict, 'mismatch');
        assert.deepEqual(cmp.rules, ['extra_minus']);
        assert.deepEqual({ a: cmp.detail.minus_extracted, p: cmp.detail.minus_source }, { a: 2, p: 1 });
    });

    test('截在題幹之後、片段完全沒有負號字形 → 負號規則不觸發，判 match', () => {
        const r = locateLast(Q1, Q1_STEM);
        assert.equal(r.status, 'located');
        const cmp = compareSegment({ questionText: Q1, segment: r.segment });
        assert.equal(cmp.verdict, 'match');
        assert.equal(cmp.detail.minus_source, 0);
    });

    test('截掉的選項只有字母與數字 → 「漏字母」只看原卷有的字，截斷不會造成誤報，判 match', () => {
        const r = locateLast(Q3, `${Q3_STEM}\n(A) 1/m (B) 2/`);
        assert.equal(r.status, 'located');
        const cmp = compareSegment({ questionText: Q3, segment: r.segment });
        assert.equal(cmp.verdict, 'match');
        assert.ok(cmp.signals.extraDigits >= 1, 'extraDigitsRule 預設關閉，拆題多出的數字不判定');
    });

    test('題幹本身跨界 → 覆蓋率不足，not_found（跳過，不表態）', () => {
        const r = locateLast(Q1, '5. 設函數圖形通過兩點，且斜率為');
        assert.equal(r.status, 'not_found');
        assert.ok(r.locate_score < DEFAULTS.minCoverage);
    });
});

describe('agents/source_check.js 合約', () => {
    const located = (q) => ({ v: 1, status: 'located', pages: [1, 1], locate_score: 1, segment: locatedSegment(q) });
    const ctxOf = (mode, extra = {}) => ({
        config: { sourceCheck: { mode } },
        llm: { generateJson() { throw new Error('source_check 不得呼叫 LLM'); } },
        logger: { info() { }, warn() { }, error() { } },
        ...extra
    });
    const wrongQ1 = Q1.replace('(C) $1$', '(C) $-1$');

    test('enforce ＋ 不一致 → fail(transcription_mismatch)，feedback 是具體的繁體中文', async () => {
        const o = await agent.run(ctxOf('enforce'), { question_text: wrongQ1, source_text: located(Q1), has_figure: false });
        assert.equal(o.kind, 'fail');
        assert.equal(o.reason, 'transcription_mismatch');
        assert.match(o.feedback, /負號比原卷多 1 個/);
        assert.equal(o.data.verdict, 'mismatch');
        assert.equal(o.data.message, o.feedback, 'data.message 要留在 payload，進複核後 feedback 不會寫回');
    });

    test('shadow ＋ 不一致 → pass，但 data.verdict=mismatch、shadow:true', async () => {
        const o = await agent.run(ctxOf('shadow'), { question_text: wrongQ1, source_text: located(Q1) });
        assert.equal(o.kind, 'pass');
        assert.equal(o.data.verdict, 'mismatch');
        assert.equal(o.data.shadow, true);
        assert.equal(o.data.mode, 'shadow');
    });

    test('off → skipped(disabled)，連比都不比', async () => {
        const o = await agent.run(ctxOf('off'), { question_text: wrongQ1, source_text: located(Q1) });
        assert.deepEqual(o, { kind: 'skipped', data: { reason: 'disabled', mode: 'off' } });
    });

    test('一致 → pass', async () => {
        const o = await agent.run(ctxOf('enforce'), { question_text: Q1, source_text: located(Q1) });
        assert.equal(o.kind, 'pass');
        assert.equal(o.data.verdict, 'match');
    });

    test('沒有片段、未定位、掃描檔 → skipped 並帶原因', async () => {
        assert.equal((await agent.run(ctxOf('enforce'), { question_text: Q1 })).data.reason, 'no_source_text');
        for (const status of ['no_text_layer', 'not_found', 'low_anchor', 'error']) {
            const o = await agent.run(ctxOf('enforce'), { question_text: Q1, source_text: { v: 1, status } });
            assert.deepEqual([o.kind, o.data.reason], ['skipped', status]);
        }
    });

    test('模式缺漏或非法 → 視為 enforce', async () => {
        for (const ctx of [{}, { config: {} }, ctxOf('loud')]) {
            const o = await agent.run(ctx, { question_text: wrongQ1, source_text: located(Q1) });
            assert.equal(o.kind, 'fail');
        }
    });

    test('內部例外不 throw，回 skipped(internal_error)', async () => {
        const evil = { v: 1, status: 'located', get segment() { throw new Error('爆炸'); } };
        const o = await agent.run(ctxOf('enforce'), { question_text: Q1, source_text: evil });
        assert.deepEqual(o, { kind: 'skipped', data: { reason: 'internal_error' } });
        const o2 = await agent.run(undefined, undefined);
        assert.equal(o2.kind, 'skipped');
    });

    test('ctx.llm 一呼叫就 throw 時照樣通過（零成本節點）', async () => {
        const o = await agent.run(ctxOf('enforce'), { question_text: Q3, source_text: located(Q3) });
        assert.equal(o.kind, 'pass');
    });
});
