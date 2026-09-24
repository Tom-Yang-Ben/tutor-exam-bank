// ─────────────────────────────────────────────────────────────
// studentProfile 單元測試（階段 5 WS-A；docs/interfaces-stage5.md 第 4.1 條第 4 項）
//
// parseProfile 是 POST／PATCH /api/students 共用的閘門。它有兩件事最容易寫錯而且不會噴錯：
//   1. 「沒送」與「送 null」要分開——PATCH 沒送的欄位不動，送 null 才是清空。
//   2. 型別不替前端轉：grade 的 '11'（字串）不收，否則前端組錯 body 也會被靜默接受。
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    GRADES, TRACKS, TARGET_EXAMS, TEXTBOOK_VERSIONS, SCHOOL_MAX_LEN, NOTE_MAX_LEN, PROFILE_FIELDS,
    parseProfile, profileOptions, charLength
} = require('../../config/studentProfile');

describe('config/studentProfile — 白名單逐字凍結（第 4.1 條第 4 項）', () => {
    test('四份白名單與兩個字數上限', () => {
        assert.deepEqual([...GRADES], [10, 11, 12]);
        assert.deepEqual([...TRACKS], ['自然組', '社會組', '未分組']);
        assert.deepEqual([...TARGET_EXAMS], ['學測', '分科', '統測', '段考', '其他']);
        assert.deepEqual([...TEXTBOOK_VERSIONS], ['龍騰', '翰林', '南一', '泰宇', '三民', '全華', '康熹', '其他']);
        assert.equal(SCHOOL_MAX_LEN, 50);
        assert.equal(NOTE_MAX_LEN, 500);
        assert.deepEqual([...PROFILE_FIELDS], ['grade', 'track', 'target_exams', 'school', 'textbook_version', 'note']);
    });

    test('profileOptions 是白名單的複本（改它不會改到白名單）', () => {
        const o = profileOptions();
        assert.deepEqual(o, {
            grades: [10, 11, 12], tracks: [...TRACKS], target_exams: [...TARGET_EXAMS],
            textbook_versions: [...TEXTBOOK_VERSIONS], school_max_length: 50, note_max_length: 500
        });
        o.tracks.push('亂加的');
        assert.equal(TRACKS.length, 3);
    });
});

describe('parseProfile — 只取有送的鍵', () => {
    test('什麼都沒送 → 空物件；只送 name 也是空物件（name 不歸這一支管）', () => {
        assert.deepEqual(parseProfile({}), { fields: {} });
        assert.deepEqual(parseProfile({ name: '小明' }), { fields: {} });
        assert.deepEqual(parseProfile(undefined), { fields: {} });
        assert.deepEqual(parseProfile(null), { fields: {} });
    });

    test('合法的完整檔案', () => {
        assert.deepEqual(parseProfile({
            grade: 11, track: '自然組', target_exams: ['分科', '學測'], school: '  示範高中 ',
            textbook_version: '龍騰', note: '週三上課'
        }), {
            fields: {
                grade: 11, track: '自然組',
                target_exams: ['學測', '分科'],        // 存成白名單的順序
                school: '示範高中',                     // trim
                textbook_version: '龍騰', note: '週三上課'
            }
        });
    });

    test('送 null 是清空（target_exams 的清空是空陣列）；空字串視同 null', () => {
        assert.deepEqual(parseProfile({
            grade: null, track: null, target_exams: null, school: null, textbook_version: null, note: null
        }), { fields: { grade: null, track: null, target_exams: [], school: null, textbook_version: null, note: null } });
        assert.deepEqual(parseProfile({ track: '', textbook_version: '', school: '   ', note: '' }),
            { fields: { track: null, textbook_version: null, school: null, note: null } });
    });
});

describe('parseProfile — 400 的情況', () => {
    const cases = [
        [{ grade: 9 }, 'grade 只接受 10、11、12 或 null。'],
        [{ grade: '11' }, 'grade 只接受 10、11、12 或 null。'],
        [{ grade: 10.5 }, 'grade 只接受 10、11、12 或 null。'],
        [{ track: '數A' }, 'track 只接受 自然組、社會組、未分組 或 null。'],
        [{ target_exams: '學測' }, 'target_exams 必須是 學測、分科、統測、段考、其他 的子集。'],
        [{ target_exams: ['指考'] }, 'target_exams 必須是 學測、分科、統測、段考、其他 的子集。'],
        [{ target_exams: ['學測', '學測'] }, 'target_exams 不可重複。'],
        [{ textbook_version: '康軒' }, 'textbook_version 只接受 龍騰、翰林、南一、泰宇、三民、全華、康熹、其他 或 null。'],
        [{ school: 123 }, 'school 必須是字串或 null，且不得超過 50 字。'],
        [{ school: '校'.repeat(51) }, 'school 必須是字串或 null，且不得超過 50 字。'],
        [{ note: '記'.repeat(501) }, 'note 必須是字串或 null，且不得超過 500 字。'],
        [{ note: ['x'] }, 'note 必須是字串或 null，且不得超過 500 字。']
    ];
    for (const [body, message] of cases) {
        test(`${JSON.stringify(body).slice(0, 50)} → ${message}`, () => {
            assert.deepEqual(parseProfile(body), { error: message });
        });
    }

    test('邊界值合法：school 剛好 50 字、note 剛好 500 字', () => {
        assert.equal(parseProfile({ school: '校'.repeat(50) }).fields.school.length, 50);
        assert.equal(parseProfile({ note: '記'.repeat(500) }).fields.note.length, 500);
    });

    test('字數以 code point 計（與 PG 的 char_length 同一把尺）', () => {
        // 𠮷 是 BMP 以外的字：JS 的 .length 是 2，PG 的 char_length 是 1
        assert.equal('𠮷'.length, 2);
        assert.equal(charLength('𠮷'), 1);
        assert.ok(parseProfile({ school: '𠮷'.repeat(50) }).fields, '50 個 code point 應該合法');
    });
});
