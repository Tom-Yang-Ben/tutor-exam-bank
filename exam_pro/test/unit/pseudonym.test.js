// ─────────────────────────────────────────────────────────────
// utils/pseudonym.js 單元測試——姓名 ↔ 代號的替換規則（DEC-009 學生姓名不出境）。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createPseudonymizer, IDENTITY, ALIAS_PREFIX } = require('../../utils/pseudonym');

describe('pseudonym — mask／unmask', () => {
    const p = createPseudonymizer([{ id: 3, name: '小明' }, { id: 7, name: '王小明' }, { id: 12, name: '小華' }]);

    test('姓名換成「學生#<id>」，代號換回姓名', () => {
        assert.equal(p.mask('小華沒寫過的向量題'), '學生#12沒寫過的向量題');
        assert.equal(p.unmask('學生#12沒寫過的向量題'), '小華沒寫過的向量題');
        assert.equal(p.aliasOf(12), `${ALIAS_PREFIX}12`);
        assert.equal(p.aliasOf(99), null);
    });

    test('長姓名先比：「王小明」不會被拆成「王」＋「小明」的代號', () => {
        assert.equal(p.mask('王小明和小明都錯了'), '學生#7和學生#3都錯了');
        assert.equal(p.unmask('學生#7和學生#3都錯了'), '王小明和小明都錯了');
    });

    test('不認識的代號原樣保留（unmask 不會憑空造名字）', () => {
        assert.equal(p.unmask('學生#99 最弱'), '學生#99 最弱');
    });

    test('mask → unmask 是可逆的（同一句話來回一次不變）', () => {
        const s = '小明、王小明、小華三個人，向量內積都不熟';
        assert.equal(p.unmask(p.mask(s)), s);
    });

    test('maskDeep／unmaskDeep 走遍物件與陣列，非字串原樣', () => {
        const v = { student_name: '小華', n: 3, list: ['小明', { note: '王小明' }], nil: null };
        const masked = p.maskDeep(v);
        assert.deepEqual(masked, { student_name: '學生#12', n: 3, list: ['學生#3', { note: '學生#7' }], nil: null });
        assert.deepEqual(p.unmaskDeep(masked), v);
        assert.notEqual(masked, v, '要回新物件，不改原物件');
    });

    test('單字姓名與壞列不遮（誤傷常用字的風險高於價值）', () => {
        const q = createPseudonymizer([{ id: 1, name: '明' }, { id: 0, name: '零號' }, { id: 5, name: '' }, null]);
        assert.equal(q.size, 0);
        assert.equal(q.mask('明天考明'), '明天考明');
    });

    test('沒有學生時是恆等函式（eval／單元測試路徑的行為不變）', () => {
        assert.equal(IDENTITY.size, 0);
        assert.equal(IDENTITY.mask('小明沒寫過'), '小明沒寫過');
        assert.equal(IDENTITY.unmask('學生#3'), '學生#3');
        assert.deepEqual(IDENTITY.maskDeep({ a: ['小明'] }), { a: ['小明'] });
    });

    test('姓名含正規表達式特殊字元也安全', () => {
        const q = createPseudonymizer([{ id: 2, name: 'A.B(C)' }]);
        assert.equal(q.mask('A.B(C) 的題'), '學生#2 的題');
        assert.equal(q.mask('AxB(C) 的題'), 'AxB(C) 的題');
    });
});
