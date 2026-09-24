// kcSeed 單元測試 —— 知識點種子檔驗證（docs/interfaces-stage5.md 第 3.4 條；contract 階段建立）
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateSeeds } = require('../../utils/kcSeed');

const CH = { '數學': ['向量內積', '向量的加減與係數積'], '物理': ['功與動能'], '化學': ['化學計量'] };
const SPOKEN = '有坐標就不用管角度：x 跟 x 乘、y 跟 y 乘，全部加起來。三維就多加一個 z 乘 z。記得算出來是一個數字，不是向量。';

function kc(code, extra = {}) {
    const [, chapter, nn] = code.split('.');
    return { code, chapter, sort: Number(nn), name: `知識點${nn}`, curriculum_code: null,
        description: '說明', spoken_text: SPOKEN, status: 'draft', prereqs: [], ...extra };
}
function chapterOf(prefix, chapter, n = 3) {
    return Array.from({ length: n }, (_, i) => kc(`${prefix}.${chapter}.${String(i + 1).padStart(2, '0')}`));
}
const mathSeed = () => ({ subject: '數學', components: [...chapterOf('MATH', '向量內積'), ...chapterOf('MATH', '向量的加減與係數積')] });

describe('validateSeeds', () => {
    test('合法種子檔零 error', () => {
        const { errors, stats } = validateSeeds([mathSeed()], { chapters: CH });
        assert.deepEqual(errors, []);
        assert.equal(stats['數學'].components, 6);
    });

    test('每章 3–8 個：少於 3 報錯、沒涵蓋的章也報錯', () => {
        const seed = { subject: '數學', components: chapterOf('MATH', '向量內積', 2) };
        const { errors } = validateSeeds([seed], { chapters: CH });
        assert.ok(errors.some(e => e.includes('向量內積') && e.includes('2 個')));
        assert.ok(errors.some(e => e.includes('向量的加減與係數積') && e.includes('0 個')));
    });

    test('code 前綴、章名、格式不符都擋', () => {
        const seed = mathSeed();
        seed.components[0].code = 'PHYS.向量內積.01';
        seed.components[1].code = 'MATH.向量內積.2';
        const { errors } = validateSeeds([seed], { chapters: CH });
        assert.ok(errors.some(e => e.includes('前綴')));
        assert.ok(errors.some(e => e.includes('格式')));
    });

    test('口語版不可含 LaTeX、長度有上下限', () => {
        const seed = mathSeed();
        seed.components[0].spoken_text = '內積 $\\vec a\\cdot\\vec b$ 等於長度相乘再乘夾角餘弦，這句話故意寫很長很長很長很長很長';
        seed.components[1].spoken_text = '太短';
        const { errors } = validateSeeds([seed], { chapters: CH });
        assert.ok(errors.some(e => e.includes('LaTeX')));
        assert.ok(errors.some(e => e.includes('spoken_text 必須是')));
    });

    test('先備：同批解析不到是 error、指向未載入科目是 warning、環要擋', () => {
        const seed = mathSeed();
        seed.components[0].prereqs = ['MATH.向量的加減與係數積.01', 'PHYS.功與動能.01'];
        seed.components[3].prereqs = ['MATH.向量內積.01'];            // 01 → 加減.01 → 內積.01：環
        seed.components[4].prereqs = ['MATH.向量內積.99'];
        const { errors, warnings } = validateSeeds([seed], { chapters: CH });
        assert.ok(warnings.some(w => w.includes('PHYS.功與動能.01')));
        assert.ok(errors.some(e => e.includes('MATH.向量內積.99') && e.includes('不存在')));
        assert.ok(errors.some(e => e.startsWith('先備關係有環')));
    });

    test('repo 內的 config/kc/*.json 全部通過（沒有種子檔時跳過）', () => {
        const dir = path.resolve(__dirname, '..', '..', 'config', 'kc');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
        if (!files.length) return;
        const seeds = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        const { errors } = validateSeeds(seeds);
        assert.deepEqual(errors, [], errors.slice(0, 10).join('\n'));
    });
});
