// ─────────────────────────────────────────────────────────────
// kcFixtures.test.js — WS-C 自建的知識點 fixture（test/fixtures/kc/*.json）本身要合法
//
// 整合測試拿這兩份小型種子檔當資料；它們自己必須符合第 3.4 條（以「只涵蓋兩章」的白名單驗證），
// 而且數學那份的 4 條 approved 口語版必須與 docs/interfaces-stage5.md 第 3.5 條的表格**逐字**相同——
// 那是 Owner 核可過的文字，fixture 抄錯一個字，測出來的「審定不被覆寫」就不是在保護真的東西。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateSeeds } = require('../../utils/kcSeed');

const FIX = path.resolve(__dirname, '..', 'fixtures', 'kc');
const MATH = JSON.parse(fs.readFileSync(path.join(FIX, '數學.json'), 'utf8'));
const PHYS = JSON.parse(fs.readFileSync(path.join(FIX, '物理.json'), 'utf8'));
const CHAPTERS = { '數學': ['向量的加減與係數積', '向量內積'], '物理': ['功與動能', '位能與能量守恆'] };

describe('test/fixtures/kc', () => {
    test('兩份一起驗證：零 error、零 warning（跨科先備在同批解析得到）', () => {
        const { errors, warnings, stats } = validateSeeds([MATH, PHYS], { chapters: CHAPTERS });
        assert.deepEqual(errors, []);
        assert.deepEqual(warnings, []);
        assert.deepEqual(stats['數學'], { components: 9, chapters: 2, approved: 4 });
        assert.deepEqual(stats['物理'], { components: 6, chapters: 2, approved: 0 });
    });

    test('物理單獨驗證：指向數學的先備只給 warning（第 4.6 條）', () => {
        const { errors, warnings } = validateSeeds([PHYS], { chapters: CHAPTERS });
        assert.deepEqual(errors, []);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('MATH.向量內積.01'));
    });

    test('4 條 approved 與 interfaces-stage5.md 第 3.5 條的 Owner 核可文字逐字相同', () => {
        const doc = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'interfaces-stage5.md'), 'utf8');
        const table = {};
        for (const line of doc.split('\n')) {
            const m = /^\| (內積的坐標算法|正射影|長度平方與展開|柯西不等式) \| (.+) \|$/.exec(line);
            if (m) table[m[1]] = m[2].replace(/\\\|/g, '|');
        }
        assert.equal(Object.keys(table).length, 4, '契約的表格格式變了，這支測試抓不到四條範例');
        const approved = MATH.components.filter(c => c.status === 'approved');
        assert.deepEqual(approved.map(c => c.name).sort(), Object.keys(table).sort());
        for (const c of approved) assert.equal(c.spoken_text, table[c.name], c.name);
    });

    test('Owner 沒核可的兩條（內積的意義、夾角與垂直）維持 draft，且不再用被否決的比喻', () => {
        for (const name of ['內積的意義', '夾角與垂直']) {
            const c = MATH.components.find(x => x.name === name);
            assert.equal(c.status, 'draft', name);
            assert.ok(!/行李箱|紅綠燈/.test(c.spoken_text), name);
        }
    });
});