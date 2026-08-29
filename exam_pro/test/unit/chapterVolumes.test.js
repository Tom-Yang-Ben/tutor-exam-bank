// config/chapters.js 的分冊結構（2026-08-27）
//
// VOLUMES 是唯一真相、CHAPTERS 由它攤平導出。這支測試釘住兩件事：
//   1. 導出的 CHAPTERS 與歷史順序逐字相同（agentExtract.test.js 另釘 enum 內容與 66）——
//      順序一變 schemaHash 就變，extract cassette 全部失效，那必須是刻意的決定。
//   2. 每個章節恰好屬於一冊（不重複、不遺漏），volumeOf 才查得到唯一答案。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CHAPTERS, VOLUMES, volumeOf, SUBJECTS } = require('../../config/chapters');

describe('config/chapters — VOLUMES 分冊結構', () => {
    test('CHAPTERS 是 VOLUMES 的攤平（同序、同內容），數學 34、物理 32', () => {
        for (const s of SUBJECTS) {
            assert.deepEqual(CHAPTERS[s], VOLUMES[s].flatMap(v => v.chapters), s);
        }
        assert.equal(CHAPTERS['數學'].length, 34);
        assert.equal(CHAPTERS['物理'].length, 32);
    });

    test('每個章節恰好屬於一冊（跨冊不重複）', () => {
        for (const s of SUBJECTS) {
            const seen = new Set();
            for (const v of VOLUMES[s]) {
                for (const c of v.chapters) {
                    assert.ok(!seen.has(c), `${s}「${c}」出現在多個冊`);
                    seen.add(c);
                }
            }
        }
    });

    test('冊名不重複，且每冊至少一章', () => {
        for (const s of SUBJECTS) {
            const names = VOLUMES[s].map(v => v.name);
            assert.equal(new Set(names).size, names.length, `${s} 冊名重複`);
            for (const v of VOLUMES[s]) assert.ok(v.chapters.length > 0, `${s}${v.name} 是空的`);
        }
    });

    test('volumeOf：白名單內查得到、白名單外回 null', () => {
        assert.equal(volumeOf('數學', '向量內積'), '第三冊(A/B)');
        assert.equal(volumeOf('物理', '靜電學'), '選修物理四');
        assert.equal(volumeOf('數學', '不存在的章節'), null);
        assert.equal(volumeOf('不存在的科', '實數'), null);
    });
});

describe('config/chapters — SOURCE_TYPES 題源標記（0006）', () => {
    const { SOURCE_TYPES, isValidSourceType } = require('../../config/chapters');

    test('五個值凍結，與 migrations/0006 的 CHECK 一致', () => {
        assert.deepEqual(SOURCE_TYPES, ['official', 'school', 'publisher', 'self', 'unknown']);
        const sql = require('node:fs').readFileSync(
            require('node:path').resolve(__dirname, '..', '..', 'migrations', '0006_source_type.sql'), 'utf8');
        for (const v of SOURCE_TYPES) assert.ok(sql.includes(`'${v}'`), `0006 的 CHECK 缺 ${v}`);
    });

    test('isValidSourceType：白名單內 true、其餘（含大小寫不符與空值）false', () => {
        for (const v of SOURCE_TYPES) assert.equal(isValidSourceType(v), true, v);
        for (const bad of ['Official', '官方', '', null, undefined, 123]) {
            assert.equal(isValidSourceType(bad), false, String(bad));
        }
    });
});

describe('config/chapters — normalizeSourceDetail 來源註記（0007）', () => {
    const { normalizeSourceDetail, SOURCE_DETAIL_MAX } = require('../../config/chapters');

    test('trim 後有內容 → 回 trim 後字串', () => {
        assert.equal(normalizeSourceDetail('北一女 2024 段考'), '北一女 2024 段考');
        assert.equal(normalizeSourceDetail('  北一女 2024 段考  '), '北一女 2024 段考');
        assert.equal(normalizeSourceDetail(2024), '2024'); // 非字串轉字串後處理
    });

    test('未帶／null／空白 → 一律 NULL（DB 不存空字串）', () => {
        for (const empty of [undefined, null, '', '   ', '\t\n']) {
            assert.equal(normalizeSourceDetail(empty), null, JSON.stringify(empty));
        }
    });

    test(`超過 ${100} 字 → undefined（呼叫端應拒絕，不默默截斷）`, () => {
        assert.equal(SOURCE_DETAIL_MAX, 100);
        assert.equal(normalizeSourceDetail('a'.repeat(100)), 'a'.repeat(100));
        assert.equal(normalizeSourceDetail('a'.repeat(101)), undefined);
        // trim 後恰好貼線也要放行
        assert.equal(normalizeSourceDetail(' ' + 'a'.repeat(100) + ' '), 'a'.repeat(100));
    });

    test('上限與 migrations/0007 的 CHECK 一致', () => {
        const sql = require('node:fs').readFileSync(
            require('node:path').resolve(__dirname, '..', '..', 'migrations', '0007_source_detail.sql'), 'utf8');
        assert.ok(sql.includes(`char_length(source_detail) <= ${SOURCE_DETAIL_MAX}`), '0007 的 CHECK 上限與程式側不一致');
    });
});
