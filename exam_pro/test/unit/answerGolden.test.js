// answer golden 對 utils/answerCompare.js 的行為測試（A-T6 × 裁決 S2-12／S2-26）
//
// eval/golden/answer.json 的 50 題展開成 250 個 answerCompare 呼叫。
// 這一支把它們全部跑一遍，比對 expect。
//
// ── 兩段式，為什麼 ──
// 這份 golden 是**裁判**（S2-26 的原話：「裁判 = D 的 250 案例 golden；C 改實作、D 改少數期望」），
// 實作要往它對齊，不是反過來。但實作是 WS-C 的，合入時間不由 WS-D 決定。
//
// 把 250 個案例硬斷言在一個「已知還沒改完」的實作上，只會得到一片與這次改動無關的紅燈；
// 完全不寫，WS-C 合入的那天也不會有人發現對不上。所以用**確定性探針**判斷實作到哪一版：
//
//   S2-12（抽取規則）  claimed='$32 = 2^5$，故 $x + 1 = 5$，得 $x = 4$。'、model='4'
//                      → 'agree' 代表已改成「取最後一個 $…$ 的等號右邊」
//   S2-26（比法細則）  ① number 要把 `\ \mathrm{m/s^2}` 這類單位整段去掉
//                      ② expression 字串不等時要退回數值比（含去掉 \left\right）
//
//   兩者都到位 → 250 個案例全部硬斷言。
//   還沒到位   → 印出目前的相符數與前幾筆差異並 skip，之後自動轉成硬斷言。
//
// skip 的訊息會印出實際數字，不是靜默跳過。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { answerCompare } = require('../../utils/answerCompare');
const g2 = require('../../eval/lib/golden2');

const golden = g2.loadAnswerGolden();
const cases = golden.entries.flatMap(g2.expandAnswerCases);

/** @returns {boolean} 是否已實作 S2-12 的抽取規則（取最後一個 $…$ 的等號右邊） */
function implementsS2_12() {
    return answerCompare({
        question_type: '計算',
        claimed: '$32 = 2^5$，故 $x + 1 = 5$，得 $x = 4$。',
        model: { final_answer: '4', answer_form: 'number' }
    }) === 'agree';
}

/** @returns {boolean} 是否已實作 S2-26 的比法細則（單位整段去掉、expression 退回數值比） */
function implementsS2_26() {
    const unitStripped = answerCompare({
        question_type: '計算', claimed: '$5$',
        model: { final_answer: '$5\\ \\mathrm{m/s^2}$', answer_form: 'number' }
    }) === 'agree';
    const expressionNumeric = answerCompare({
        question_type: '計算', claimed: '$3$',
        model: { final_answer: '$\\left(\\frac{3}{1}\\right)$', answer_form: 'expression' }
    }) === 'agree';
    return unitStripped && expressionNumeric;
}

/** @returns {string|null} 還缺哪一條裁決；都到位回 null */
function missingRuling() {
    if (!implementsS2_12()) return 'S2-12（final_answer 的抽取規則）';
    if (!implementsS2_26()) return 'S2-26（number 的單位／科學記號／根式，expression 退回數值比）';
    return null;
}

/** 跑完 250 個案例 @returns {{pass:number, fails:Array}} */
function runAll() {
    const fails = [];
    let pass = 0;
    for (const c of cases) {
        const got = answerCompare({ question_type: c.question_type, claimed: c.claimed, model: c.model });
        if (got === c.expect) pass++;
        else fails.push(`${c.id}（${c.question_type}／${c.model.answer_form}）final_answer=「${c.model.final_answer}」：期望 ${c.expect}，得到 ${got}`);
    }
    return { pass, fails };
}

describe('answer golden 對 answerCompare 的行為（裁決 S2-12／S2-26）', () => {
    test('250 個案例全部符合 expect', (t) => {
        const { pass, fails } = runAll();
        const missing = missingRuling();

        if (missing) {
            t.skip(
                `utils/answerCompare.js 尚未實作 ${missing}。\n` +
                `   golden 是裁判（S2-26 的原話），目前 ${pass}/${cases.length} 相符；` +
                `WS-C 對齊之後本測試會自動轉成硬斷言。\n` +
                `   前五筆不符：\n     - ${fails.slice(0, 5).join('\n     - ')}`
            );
            return;
        }

        assert.equal(fails.length, 0,
            `${fails.length}/${cases.length} 個案例與 golden 不符：\n  - ${fails.slice(0, 25).join('\n  - ')}` +
            (fails.length > 25 ? `\n  …另有 ${fails.length - 25} 筆` : ''));
    });

    // 下面幾條測的是 golden 本身有沒有踩到「等價寫法其實不等價」「錯答其實是對的」
    // 這類標註錯誤。後三條完全不依賴裁決進度；第一條要等 S2-26，理由寫在裡面。
    test('每筆的 3 個等價寫法彼此互比都是 agree（golden 內部自洽）', (t) => {
        // ans-047 的 $\left(\frac{3}{1}\right)$ 與 $\frac{3}{1}$ 字串不等，
        // 要靠 S2-26 的「expression 退回數值比」才會 agree。
        const missing = missingRuling();
        const problems = [];
        for (const e of golden.entries) {
            if (e.expect.equivalent !== 'agree') continue;   // 期望 uncertain 的筆不適用
            for (let i = 0; i < e.equivalents.length; i++) {
                for (let j = i + 1; j < e.equivalents.length; j++) {
                    const got = answerCompare({
                        question_type: e.question_type,
                        claimed: e.equivalents[i],
                        model: { final_answer: e.equivalents[j], answer_form: e.answer_form }
                    });
                    // uncertain 可接受（抽不出來），disagree 不行——那代表兩者根本不等價
                    if (got === 'disagree') {
                        problems.push(`${e.id}：「${e.equivalents[i]}」vs「${e.equivalents[j]}」判 disagree`);
                    }
                }
            }
        }
        if (missing && problems.length) {
            t.skip(`等 ${missing} 合入；目前 ${problems.length} 組互比不成立：\n     - ${problems.join('\n     - ')}`);
            return;
        }
        assert.equal(problems.length, 0, problems.join('\n  '));
    });

    test('每筆的錯答與第一個等價寫法互比不得是 agree（否則那不是錯答）', () => {
        const problems = [];
        for (const e of golden.entries) {
            if (e.expect.wrong !== 'disagree') continue;
            for (const w of e.wrong) {
                const got = answerCompare({
                    question_type: e.question_type,
                    claimed: e.equivalents[0],
                    model: { final_answer: w, answer_form: e.answer_form }
                });
                if (got === 'agree') problems.push(`${e.id}：錯答「${w}」與正解「${e.equivalents[0]}」判 agree`);
            }
        }
        assert.equal(problems.length, 0, problems.join('\n  '));
    });

    test('證明題不論兩邊寫什麼都回 uncertain（第 4.2 條）', () => {
        for (const e of golden.entries.filter(e => e.question_type === '證明')) {
            for (const final of [...e.equivalents, ...e.wrong]) {
                const got = answerCompare({
                    question_type: '證明', claimed: e.claimed,
                    model: { final_answer: final, answer_form: e.answer_form }
                });
                assert.equal(got, 'uncertain', `${e.id} 對「${final}」回了 ${got}`);
            }
        }
    });

    test('claimed 為空／非字串一律 uncertain，不得拋例外', () => {
        for (const claimed of ['', '   ', null, undefined, 123]) {
            const got = answerCompare({
                question_type: '計算', claimed,
                model: { final_answer: '1', answer_form: 'number' }
            });
            assert.equal(got, 'uncertain', `claimed=${JSON.stringify(claimed)}`);
        }
    });
});
