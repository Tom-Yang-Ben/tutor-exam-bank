// ─────────────────────────────────────────────────────────────
// 出題閉環的輸入驗證單元測試（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 2、3、4 項）
//
//   - controllers/remedialController.js：補救卷 body、覆蓋率 query
//   - controllers/examController.js：generate-paper 的 blueprint 與候選池 SQL 的參數順序
//
// 兩個 controller 在模組頂層 require config/db（缺 DATABASE_URL 會直接丟錯）。
// node --test 每個測試檔各自一個子行程，所以這裡只在**本檔的行程**塞一個假的連線字串：
// pg 的 Pool 在第一次 query 之前不會連線，本檔也從不 query。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit:unit@127.0.0.1:1/unit_never_connects_test';

const { _internals: remedialInternals } = require('../../controllers/remedialController');
const exam = require('../../controllers/examController');

const { parseRemedialBody, parseCoverageQuery } = remedialInternals;
const { parseBlueprint, parseExcludeIds, parseSourceTypes, shortfallReason, blueprintPolicyError, blueprintTitle, MAX_BLUEPRINT_ROWS } = exam._blueprintInternals;

describe('parseRemedialBody', () => {
    test('只給 subject：套用預設 total 20、mix 0.6／0.2／0.2、days 90、不限題源', () => {
        assert.deepEqual(parseRemedialBody({ subject: '數學' }), {
            value: { subject: '數學', total: 20, mix: { remedial: 0.6, prerequisite: 0.2, extension: 0.2 }, days: 90, sourceTypes: null }
        });
    });

    test('subject 必填且在白名單內', () => {
        for (const body of [{}, { subject: '' }, { subject: '生物' }, { subject: 1 }, null, undefined]) {
            assert.match(parseRemedialBody(body).error, /subject/, JSON.stringify(body));
        }
    });

    test('total：5–50 的整數', () => {
        for (const total of [4, 51, 0, 5.5, '20', -1]) {
            assert.match(parseRemedialBody({ subject: '數學', total }).error, /total/, String(total));
        }
        assert.equal(parseRemedialBody({ subject: '數學', total: 5 }).value.total, 5);
        assert.equal(parseRemedialBody({ subject: '數學', total: 50 }).value.total, 50);
    });

    test('mix：三個非負數、總和 > 0；不認得的鍵與缺鍵都 400', () => {
        const bad = [
            [], 'x', { remedial: 1, prerequisite: 0 }, { remedial: -1, prerequisite: 1, extension: 1 },
            { remedial: 0, prerequisite: 0, extension: 0 }, { remedial: '1', prerequisite: 0, extension: 0 },
            { remedial: 1, prerequisite: 0, extension: 0, stretch: 1 }, { remedial: Infinity, prerequisite: 0, extension: 0 }
        ];
        for (const mix of bad) {
            assert.match(parseRemedialBody({ subject: '數學', mix }).error, /mix/, JSON.stringify(mix));
        }
        // 每個值有限、總和卻溢位成 Infinity：配額會算出 NaN、草稿 0 題卻回 200——一律 400
        for (const mix of [{ remedial: 1e308, prerequisite: 1e308, extension: 0 }, { remedial: Number.MAX_VALUE, prerequisite: 0, extension: Number.MAX_VALUE }]) {
            assert.match(parseRemedialBody({ subject: '數學', mix }).error, /mix/, JSON.stringify(mix));
        }
        assert.deepEqual(parseRemedialBody({ subject: '數學', mix: { remedial: 1e308, prerequisite: 0, extension: 0 } }).value.mix,
            { remedial: 1e308, prerequisite: 0, extension: 0 }, '單一極大值、總和有限仍合法（只看比例）');
        assert.deepEqual(parseRemedialBody({ subject: '數學', mix: { remedial: 0, prerequisite: 0, extension: 2 } }).value.mix,
            { remedial: 0, prerequisite: 0, extension: 2 });
    });

    test('days：1–365 的整數', () => {
        for (const days of [0, 366, 1.5, '30']) {
            assert.match(parseRemedialBody({ subject: '數學', days }).error, /days/, String(days));
        }
        assert.equal(parseRemedialBody({ subject: '數學', days: 365 }).value.days, 365);
    });

    test('source_types：合法題源陣列；空陣列 = 不限制', () => {
        assert.match(parseRemedialBody({ subject: '數學', source_types: ['bogus'] }).error, /source_types/);
        assert.match(parseRemedialBody({ subject: '數學', source_types: 'official' }).error, /source_types/);
        assert.equal(parseRemedialBody({ subject: '數學', source_types: [] }).value.sourceTypes, null);
        assert.deepEqual(parseRemedialBody({ subject: '數學', source_types: ['official', 'official', 'self'] }).value.sourceTypes, ['official', 'self']);
    });
});

describe('parseCoverageQuery', () => {
    test('全部可省略', () => {
        assert.deepEqual(parseCoverageQuery({}), { subject: null, studentId: null });
        assert.deepEqual(parseCoverageQuery({ subject: '', student_id: '' }), { subject: null, studentId: null });
    });

    test('subject 在白名單內；student_id 是正整數', () => {
        assert.match(parseCoverageQuery({ subject: '生物' }).error, /subject/);
        for (const s of ['abc', '0', '-1', '1.5', '3abc']) {
            assert.match(parseCoverageQuery({ student_id: s }).error, /student_id/, s);
        }
        assert.deepEqual(parseCoverageQuery({ subject: '物理', student_id: '12' }), { subject: '物理', studentId: 12 });
    });
});

describe('generate-paper 的 blueprint 驗證', () => {
    test('合法：補齊 difficulty 的 null', () => {
        assert.deepEqual(parseBlueprint('數學', [{ chapter: '向量內積', count: 3 }, { chapter: '排列', count: 2, difficulty_min: 2, difficulty_max: 4 }]), {
            rows: [
                { chapter: '向量內積', count: 3, difficulty_min: null, difficulty_max: null },
                { chapter: '排列', count: 2, difficulty_min: 2, difficulty_max: 4 }
            ]
        });
    });

    test('1–10 列', () => {
        assert.equal(MAX_BLUEPRINT_ROWS, 10);
        assert.match(parseBlueprint('數學', []).error, /1~10/);
        assert.match(parseBlueprint('數學', 'x').error, /1~10/);
        const eleven = Array.from({ length: 11 }, () => ({ chapter: '向量內積', count: 1 }));
        assert.match(parseBlueprint('數學', eleven).error, /1~10/);
    });

    test('每列：物件、章節在該科白名單內、count 正整數、難度 1–5 且 min ≤ max', () => {
        assert.match(parseBlueprint('數學', [null]).error, /第 1 列必須是物件/);
        assert.match(parseBlueprint('數學', [{ chapter: '靜電學', count: 1 }]).error, /第 1 列的章節「靜電學」不在數學的章節白名單內/);
        assert.match(parseBlueprint('數學', [{ chapter: '向量內積', count: 1 }, { chapter: '向量內積', count: 0 }]).error, /第 2 列的 count/);
        assert.match(parseBlueprint('數學', [{ chapter: '向量內積', count: '2' }]).error, /count/);
        assert.match(parseBlueprint('數學', [{ chapter: '向量內積', count: 1, difficulty_min: 0 }]).error, /1~5/);
        assert.match(parseBlueprint('數學', [{ chapter: '向量內積', count: 1, difficulty_max: 6 }]).error, /1~5/);
        assert.match(parseBlueprint('數學', [{ chapter: '向量內積', count: 1, difficulty_min: 4, difficulty_max: 2 }]).error, /不得大於/);
    });

    test('count 總和 ≤ 50', () => {
        const rows = Array.from({ length: 5 }, () => ({ chapter: '向量內積', count: 10 }));
        assert.ok(parseBlueprint('數學', rows).rows);
        rows[0].count = 11;
        assert.match(parseBlueprint('數學', rows).error, /總和最多 50 題/);
    });

    test('exclude_ids 與 source_types 的訊息與單章路徑逐字相同', () => {
        assert.deepEqual(parseExcludeIds(undefined), { value: [] });
        assert.equal(parseExcludeIds([1, 'x']).error, 'exclude_ids 必須是正整數陣列。');
        assert.equal(parseExcludeIds(Array.from({ length: 201 }, (_, i) => i + 1)).error, 'exclude_ids 最多 200 個。');
        assert.deepEqual(parseExcludeIds([3, 3, 4]), { value: [3, 4] });
        assert.equal(parseSourceTypes(['bogus']).error, 'source_types 必須是合法題源標記的陣列。');
        assert.deepEqual(parseSourceTypes([]), { value: null });
    });

    test('shortfallReason：可用題數不夠＝庫存不足，否則是承上組塞不進', () => {
        assert.equal(shortfallReason({ got: 2, availableCount: 2 }, 5), 'insufficient_stock');
        assert.equal(shortfallReason({ got: 4, availableCount: 6 }, 5), 'follow_up_group');
    });

    test('blueprintPolicyError：FOLLOW_UP_SHORTFALL_POLICY 是單點切換，blueprint 分支也聽它的', () => {
        assert.equal(exam.FOLLOW_UP_SHORTFALL_POLICY, 'note', '預設仍是少出題附註');
        const shortfalls = [
            { row: 1, chapter: '向量內積', wanted: 3, got: 1, reason: 'insufficient_stock' },
            { row: 2, chapter: '實數', wanted: 4, got: 3, reason: 'follow_up_group' }
        ];
        assert.equal(blueprintPolicyError(shortfalls, 'note'), null, "'note'：不回 400");
        assert.equal(blueprintPolicyError(shortfalls, 'error'),
            '承上題須與前題整組出題，blueprint 第 2 列「實數」無法剛好湊滿 4 題（最多可出 3 題），請調整題數。');
        assert.equal(blueprintPolicyError([shortfalls[0]], 'error'), null, '庫存不足不受此政策影響（同單章路徑）');
        assert.equal(blueprintPolicyError([], 'error'), null);
    });

    test('blueprintTitle：1 章同單章路徑、2–3 章列出、4 章以上「等 N 章」', () => {
        assert.equal(blueprintTitle('小明', ['向量內積'], '2026_9_24'), '小明-向量內積特訓卷(2026_9_24)');
        assert.equal(blueprintTitle('小明', ['向量內積', '向量內積'], 'd'), '小明-向量內積特訓卷(d)');
        assert.equal(blueprintTitle('小明', ['向量內積', '排列'], 'd'), '小明-向量內積、排列特訓卷(d)');
        assert.equal(blueprintTitle('小明', ['向量內積', '排列', '組合', '實數'], 'd'), '小明-向量內積等4章特訓卷(d)');
    });
});

describe('buildCandidatePoolQuery：參數順序凍結', () => {
    test('$1 subject、$2 chapters、$3 studentId、$4 excludeIds、$5 sourceTypes、$6 dMin、$7 dMax、$8 kcIds', () => {
        const { text, values } = exam.buildCandidatePoolQuery({
            subject: '數學', chapters: ['向量內積'], studentId: 7, excludeIds: [1], sourceTypes: ['self'],
            difficultyMin: 2, difficultyMax: 4, kcIds: [9]
        });
        assert.deepEqual(values, ['數學', ['向量內積'], 7, [1], ['self'], 2, 4, [9]]);
        assert.match(text, /q\.subject = \$1/);
        assert.match(text, /q\.chapter = ANY\(\$2::text\[\]\)/);
        assert.match(text, /a\.student_id = \$3/);
        assert.match(text, /NOT \(q\.id = ANY\(\$4::int\[\]\)\)/);
        assert.match(text, /q\.source_type = ANY\(\$5::text\[\]\)/);
        assert.match(text, /q\.difficulty >= \$6::int/);
        assert.match(text, /q\.difficulty <= \$7::int/);
        assert.match(text, /qk\.kc_id = ANY\(\$8::int\[\]\)/);
        // 五條硬閘門仍在：未封存、NOT EXISTS（不是 NOT IN）
        assert.match(text, /q\.archived_at IS NULL/);
        assert.match(text, /NOT EXISTS \(SELECT 1 FROM attempts a/);
    });

    test('新條件的預設全是 NULL（＝不限制），單章路徑的語意因此不變', () => {
        const { values } = exam.buildCandidatePoolQuery({ subject: '物理', chapters: ['靜電學'], studentId: 1 });
        assert.deepEqual(values, ['物理', ['靜電學'], 1, [], null, null, null, null]);
    });
});
