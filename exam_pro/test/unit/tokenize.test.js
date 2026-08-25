// utils/tokenize.js 單元測試（WS-C / D-T1）
//
// 這支的契約寫在 docs/interfaces-stage1.md 第 2 條：全案唯一的分詞器，寫入、查詢、eval 三處共用。
// 因此測的是「不會爆、輸出穩定、學科名詞不被切爛」，而不是逐詞比對 jieba 的內部行為。
//
// 執行：npm test（Node 內建 node:test，不連 DB、不呼叫外部服務）

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { tokenize } = require('../../utils/tokenize');
const { CHAPTERS } = require('../../config/chapters');

describe('tokenize — 邊界輸入不得拋出例外', () => {
    test('null / undefined / 空字串 / 純空白 → []', () => {
        assert.deepEqual(tokenize(null), []);
        assert.deepEqual(tokenize(undefined), []);
        assert.deepEqual(tokenize(''), []);
        assert.deepEqual(tokenize('   \n\t '), []);
    });

    test('純標點 → []（純符號 token 一律丟掉）', () => {
        assert.deepEqual(tokenize('，。！？：；「」（）'), []);
    });

    test('非字串輸入也不拋例外', () => {
        assert.ok(Array.isArray(tokenize(123)));
        assert.ok(Array.isArray(tokenize(0)));
    });
});

describe('tokenize — 輸出形狀', () => {
    test('回傳 string[]，每個 token 不含前後空白、不是空字串', () => {
        const toks = tokenize('一質量 2 kg 的物體以等速率作圓周運動，求其向心力大小');
        assert.ok(toks.length > 0);
        for (const t of toks) {
            assert.equal(typeof t, 'string');
            assert.equal(t, t.trim());
            assert.notEqual(t, '');
        }
    });

    test('順序 = 出現順序', () => {
        const toks = tokenize('向心力 之後 才是 摩擦力');
        assert.ok(toks.indexOf('向心力') < toks.indexOf('摩擦力'));
    });

    test('同一輸入呼叫兩次結果完全相同（純函式，可重現）', () => {
        const s = '已知三角形兩邊與夾角，利用正弦定理求外接圓半徑';
        assert.deepEqual(tokenize(s), tokenize(s));
    });
});

describe('tokenize — 學科名詞（自訂詞典）', () => {
    const CASES = [
        ['一質量 2 kg 的物體以等速率作圓周運動，求其向心力大小', ['圓周運動', '向心力']],
        ['利用克拉瑪公式解二元一次聯立方程式', ['克拉瑪公式', '聯立方程式']],
        ['已知三角形兩邊與夾角，利用正弦定理求外接圓半徑', ['正弦定理', '外接圓']],
        ['求兩向量的向量內積與夾角', ['向量內積']],
        ['光滑斜面上的物體受重力與正向力作用', ['正向力']],
        ['由電磁感應與楞次定律判斷感應電流方向', ['電磁感應', '楞次定律']],
    ];
    for (const [text, expected] of CASES) {
        test(`「${text.slice(0, 12)}…」切出 ${expected.join('、')}`, () => {
            const toks = tokenize(text);
            for (const w of expected) assert.ok(toks.includes(w), `缺少 token「${w}」：${JSON.stringify(toks)}`);
        });
    }

    test('章節白名單的每個章節名，至少能切出一個屬於自己的長詞', () => {
        // 不要求整串章節名成為單一 token（含括號的章節名一定會被切開），
        // 只要求切出來的 token 裡有長度 ≥ 2 且是章節名子字串的詞——否則等於章節詞全被打散。
        for (const [subject, list] of Object.entries(CHAPTERS)) {
            for (const chapter of list) {
                const toks = tokenize(chapter);
                const hit = toks.some(t => t.length >= 2 && chapter.includes(t));
                assert.ok(hit, `${subject}／${chapter} 被切成 ${JSON.stringify(toks)}`);
            }
        }
    });
});

describe('tokenize — 數學符號與全半形', () => {
    test('$...$ 界定符被移除，內容仍保留', () => {
        const toks = tokenize('求下列函數的導函數：$f(x)=x^2+3x-5$');
        assert.ok(!toks.includes('$'));
        assert.ok(toks.includes('導函數'));
        assert.ok(toks.includes('f'));
    });

    test('LaTeX 指令去掉反斜線（\\theta → theta）', () => {
        const toks = tokenize('設 $\\theta$ 為銳角，求 $\\sin\\theta$ 之值');
        assert.ok(toks.includes('theta'), JSON.stringify(toks));
        assert.ok(!toks.some(t => t.includes('\\')));
    });

    test('f(x) 這類殘留：括號自成純標點被丟掉，字母與數字留著', () => {
        const toks = tokenize('f(x)');
        assert.deepEqual(toks.filter(t => t === '(' || t === ')'), []);
        assert.ok(toks.includes('f'));
        assert.ok(toks.includes('x'));
    });

    test('a:b 這類比值不會讓分詞器失敗', () => {
        const toks = tokenize('比值 a:b = 3:4，求 a+b');
        assert.ok(toks.length > 0);
        assert.ok(!toks.includes(':'));
    });

    test('全形英數（NFKC）與半形結果一致', () => {
        assert.deepEqual(tokenize('ＡＢ１２３'), tokenize('AB123'));
    });

    test('英文一律轉小寫，與 to_tsvector(simple) 的行為一致', () => {
        assert.deepEqual(tokenize('KG'), tokenize('kg'));
    });
});

describe('tokenize — 虛詞過濾', () => {
    test('「的」「了」「是」這類單字虛詞不會出現在輸出裡', () => {
        const toks = tokenize('這是一個很好的題目，於是就把它做了');
        for (const w of ['的', '了', '是', '就', '把', '這', '個', '很']) {
            assert.ok(!toks.includes(w), `虛詞「${w}」不該留下：${JSON.stringify(toks)}`);
        }
    });

    test('學科單字（功、力、波）不在虛詞表裡，必須留下', () => {
        assert.ok(tokenize('功').includes('功'));
        assert.ok(tokenize('波').includes('波'));
    });
});
