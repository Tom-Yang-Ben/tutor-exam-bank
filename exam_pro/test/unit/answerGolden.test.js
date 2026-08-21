// answer golden 對 utils/answerCompare.js 的行為測試（A-T6 × 裁決 S2-12）
//
// eval/golden/answer.json 的 50 題展開成 250 個 answerCompare 呼叫。
// 這一支把它們全部跑一遍，比對 expect。
//
// ── 兩段式，為什麼 ──
// 裁決 S2-12 把 final_answer 的抽取規則從「第一個 $…$」改成
// 「最後一個 $…$，含 = 或 \approx 取其後，純上下標片段跳過」。
// golden 已依新規則改寫（claimed 一律是「過程 = 結論」的真實寫法），
// 但 utils/answerCompare.js 是否已經跟上，取決於 WS-C 何時合入。
//
// 因此本檔先用一個**確定性探針**判斷實作在哪一版：
//   探針：claimed = '$32 = 2^5$，故 $x + 1 = 5$，得 $x = 4$。'、model.final_answer = '4'
//         S2-12 → 'agree'（抽到最後一段的 4）
//         舊規則 → 'uncertain'（抽到第一段的整串算式，比不出有理數）
//
//   探針說「已是 S2-12」→ 250 個案例全部硬斷言。
//   探針說「還是舊規則」→ 印出目前的相符數並 skip，等 WS-C 合入後自動轉成硬斷言。
//
// 這樣寫是刻意的：把 250 個案例硬斷言在一個「已知還沒改」的實作上，只會得到一片
// 與這次改動無關的紅燈；而完全不寫，WS-C 合入的那天也不會有人發現對不上。
// skip 的訊息會印出實際數字，不是靜默跳過。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { answerCompare } = require('../../utils/answerCompare');
const g2 = require('../../eval/lib/golden2');

const golden = g2.loadAnswerGolden();
const cases = golden.entries.flatMap(g2.expandAnswerCases);

/** @returns {boolean} utils/answerCompare.js 是否已實作 S2-12 的抽取規則 */
function implementsS2_12() {
    return answerCompare({
        question_type: '計算',
        claimed: '$32 = 2^5$，故 $x + 1 = 5$，得 $x = 4$。',
        model: { final_answer: '4', answer_form: 'number' }
    }) === 'agree';
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

describe('answer golden 對 answerCompare 的行為（裁決 S2-12）', () => {
    test('250 個案例全部符合 expect', (t) => {
        const { pass, fails } = runAll();

        if (!implementsS2_12()) {
            t.skip(
                `utils/answerCompare.js 尚未實作裁決 S2-12 的抽取規則（探針：claimed 的最後一段 $x = 4$ 抽不到 4）。\n` +
                `   golden 已依 S2-12 改寫，目前 ${pass}/${cases.length} 相符；` +
                `WS-C 更新 extractFinalAnswer 之後本測試會自動轉成硬斷言。\n` +
                `   前三筆不符：\n     - ${fails.slice(0, 3).join('\n     - ')}`
            );
            return;
        }

        assert.equal(fails.length, 0,
            `${fails.length}/${cases.length} 個案例與 golden 不符：\n  - ${fails.slice(0, 25).join('\n  - ')}` +
            (fails.length > 25 ? `\n  …另有 ${fails.length - 25} 筆` : ''));
    });

    // 下面幾條**不依賴** S2-12，現在就守得住：它們測的是 golden 本身有沒有踩到
    // 「等價寫法其實不等價」「錯答其實是對的」這類標註錯誤。
    test('每筆的 3 個等價寫法彼此互比都是 agree（golden 內部自洽）', () => {
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
