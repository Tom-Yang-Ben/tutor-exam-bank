// ─────────────────────────────────────────────────────────────
// kcPhysicsDraftLoad.test.js — Owner 第五輪 K-P 核准（選 3：物理知識點維持草稿，但允許載入）
//
// 決定：物理 198 個知識點全部維持 status: draft，但允許 `npm run kc:load` 載入（先前 HANDOFF A10／B15
// 的「物理先不跑 kc:load」解除）。查過 scripts/load_kc.js、services/kcService.loadSeeds、utils/kcSeed.js：
// 程式本來就沒有擋 draft、也沒有擋物理（擋的只是 HANDOFF 的操作規則）。這裡把「不擋」釘住，
// 以後若有人加了「只載入已審定」或「跳過物理」之類的過濾，這組測試會紅：
//   ① repo 內的物理種子檔全部是 draft、驗證零 error（單科驗證時，指向數學的先備只算 warning）；
//   ② 三科一起驗證也零 error；
//   ③ 載入計畫對草稿列照常 insert／unchanged／update（沒有「草稿不載入」這一種計畫）；
//   ④ kc:load 預設讀 config/kc/ 全部種子檔（含物理），--file 指定物理也照讀；參數沒有科目或狀態過濾。
// 對 PostgreSQL 的實際載入在 test/integration/kcLoadPhysicsDraft.pg.test.js。只讀檔，不連 DB。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const KC_DIR = path.join(APP_DIR, 'config', 'kc');
const { validateSeeds } = require('../../utils/kcSeed');
const { seedRowOf, planSeedUpsert } = require('../../services/kcService');
const loadKc = require('../../scripts/load_kc');

const readSeed = (subject) => JSON.parse(fs.readFileSync(path.join(KC_DIR, `${subject}.json`), 'utf8'));

describe('Owner 第五輪 K-P：物理知識點維持草稿、允許 kc:load', () => {
    const phys = readSeed('物理');

    test('① 物理種子檔 198 個知識點全部是 draft，單獨驗證零 error', () => {
        assert.equal(phys.subject, '物理');
        assert.equal(phys.components.length, 198);
        assert.ok(phys.components.every(c => c.status === 'draft'), 'K-P＝3：維持草稿，不標 approved');
        const { errors, warnings, stats } = validateSeeds([phys]);
        assert.deepEqual(errors, [], errors.slice(0, 10).join('\n'));
        // 單科驗證時，指向另一科（數學）的先備只算 warning，不擋載入
        assert.ok(warnings.every(w => /屬於這次沒有驗證的科目/.test(w)), warnings.slice(0, 5).join('\n'));
        assert.deepEqual(stats['物理'], { components: 198, chapters: 34, approved: 0 });
    });

    test('② 三科一起驗證零 error（物理草稿與數學、化學一起載入不受影響）', () => {
        const seeds = ['數學', '物理', '化學'].map(readSeed);
        const { errors, stats } = validateSeeds(seeds);
        assert.deepEqual(errors, [], errors.slice(0, 10).join('\n'));
        assert.equal(stats['物理'].approved, 0);
        // 其他科不受影響：數學的已審定數照舊（Q 系列之前就有的 4 條）
        assert.equal(stats['數學'].approved, 4);
    });

    test('③ 載入計畫：物理草稿列照常 insert；內容相同 unchanged；種子檔改了 update（沒有「草稿不載入」）', () => {
        for (const c of phys.components) {
            const row = seedRowOf(c, '物理');
            assert.equal(row.status, 'draft');
            assert.equal(planSeedUpsert(row, undefined), 'insert', c.code);
            assert.equal(planSeedUpsert(row, { ...row, edited_at: null }), 'unchanged', c.code);
        }
        const row = seedRowOf(phys.components[0], '物理');
        assert.equal(planSeedUpsert(row, { ...row, description: '舊的說明', edited_at: null }), 'update');
    });

    test('④ kc:load 預設讀 config/kc/ 全部種子檔（含物理）；--file 指定物理照讀；參數沒有科目或狀態過濾', () => {
        const all = loadKc.resolveFiles(loadKc.parseArgs([])).map(f => path.basename(f));
        assert.ok(all.includes('物理.json'), all.join('、'));
        assert.ok(all.includes('數學.json') && all.includes('化學.json'), all.join('、'));
        const only = loadKc.resolveFiles(loadKc.parseArgs(['--file', path.join(KC_DIR, '物理.json')]));
        assert.deepEqual(only.map(f => path.basename(f)), ['物理.json']);
        assert.deepEqual(Object.keys(loadKc.parseArgs([])).sort(), ['dryRun', 'files', 'force', 'test']);
        assert.throws(() => loadKc.parseArgs(['--subject', '物理']), /未知的參數/);
    });
});
