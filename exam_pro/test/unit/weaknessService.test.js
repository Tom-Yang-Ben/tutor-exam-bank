// ─────────────────────────────────────────────────────────────
// weaknessService 單元測試 —— 只釘「參數順序」與幾個結構不變量
//
// 這支測試的職責被 docs/interfaces-stage3.md 第 1.6 條寫死了，很窄，但很重要：
//
//   純文字單測**擋不了 SQL 語法錯**——`ORDER BY wrong::float / NULLIF(graded,0)`
//   在字串比對眼中完全正常，要送進 Postgres 才會炸。所以「查詢對不對」
//   的責任在 test/integration/students.pg.test.js（1,000 筆 fixture 逐欄比對）。
//
//   它唯一擋得住、而且整合測試不見得擋得住的，是**參數錯位**：
//   把 days 與 subject 對調不會噴錯、不會 500，只會讓弱點面板安靜地回一張空表
//   （`q.subject = 90` 恰好型別相容嗎？不會，但 `assigned_at >= CURRENT_DATE - '數學'`
//   會在執行期才爆；更陰的是兩個同型別參數對調時連爆都不爆）。
//   裁決 S3-4 因此把順序凍結成 [studentId, days, subject, limit]。
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const weakness = require('../../services/weaknessService');

const OPTS = { studentId: 7, subject: '物理', days: 30 };

/** 五支建查詢函式的名稱與「該不該吃 limit」。 */
const BUILDERS = [
    { name: 'buildByChapter', hasLimit: false, groupKey: 'chapter' },
    { name: 'buildByType', hasLimit: false, groupKey: 'question_type' },
    { name: 'buildByDifficulty', hasLimit: false, groupKey: 'difficulty' },
    { name: 'buildTrendWeekly', hasLimit: false, groupKey: null },
    { name: 'buildRecentWrong', hasLimit: true, groupKey: null }
];

describe('weaknessService — 五支都存在且回 { text, values }', () => {
    test('module.exports 有第 1.6 條列的五支函式', () => {
        for (const { name } of BUILDERS) {
            assert.equal(typeof weakness[name], 'function', `缺少 ${name}`);
        }
    });

    test('每一支都回 { text: string, values: array }', () => {
        for (const { name } of BUILDERS) {
            const built = weakness[name](OPTS);
            assert.equal(typeof built.text, 'string', `${name} 的 text 必須是字串`);
            assert.ok(built.text.trim().length > 0, `${name} 的 text 不得為空`);
            assert.ok(Array.isArray(built.values), `${name} 的 values 必須是陣列`);
        }
    });

    test('是純函式：同樣的輸入回同樣的輸出，且不改動傳入的 opts', () => {
        const opts = { studentId: 7, subject: '物理', days: 30, limit: 5 };
        const snapshot = JSON.stringify(opts);
        for (const { name } of BUILDERS) {
            const a = weakness[name](opts);
            const b = weakness[name](opts);
            assert.equal(a.text, b.text, `${name} 兩次呼叫的 SQL 不同`);
            assert.deepEqual(a.values, b.values, `${name} 兩次呼叫的參數不同`);
        }
        assert.equal(JSON.stringify(opts), snapshot, 'opts 不得被修改');
    });
});

// ═════════════ 本檔的核心：參數順序（裁決 S3-4）═════════════

describe('weaknessService — 參數順序凍結為 [studentId, days, subject, limit]', () => {
    test('四支聚合／趨勢查詢的 values = [studentId, days, subject]', () => {
        for (const { name, hasLimit } of BUILDERS.filter(b => !b.hasLimit)) {
            const { values } = weakness[name](OPTS);
            assert.deepEqual(values, [7, 30, '物理'],
                `${name} 的參數順序錯位（凍結為 $1=studentId、$2=days、$3=subject）`);
            assert.equal(hasLimit, false);
        }
    });

    test('buildRecentWrong 的 values = [studentId, days, subject, limit]', () => {
        const { values } = weakness.buildRecentWrong({ ...OPTS, limit: 5 });
        assert.deepEqual(values, [7, 30, '物理', 5]);
    });

    test('buildRecentWrong 的 limit 預設是 20（第 1.5 條凍結）', () => {
        assert.deepEqual(weakness.buildRecentWrong(OPTS).values, [7, 30, '物理', 20]);
        // 明確傳 undefined／null 也走預設，不會變成 `LIMIT NULL`
        assert.deepEqual(weakness.buildRecentWrong({ ...OPTS, limit: undefined }).values[3], 20);
        assert.deepEqual(weakness.buildRecentWrong({ ...OPTS, limit: null }).values[3], 20);
    });

    test('不分科時 subject 收斂成 null（$3::text IS NULL 才會成立）', () => {
        // 三種「沒給」的寫法都要變成 null，否則 ($3::text IS NULL OR q.subject = $3)
        // 會拿空字串去比 subject，整張表變空的
        for (const subject of [undefined, null, '']) {
            const { values } = weakness.buildByChapter({ studentId: 7, days: 90, subject });
            assert.equal(values[2], null, `subject=${JSON.stringify(subject)} 應收斂成 null`);
        }
    });

    test('每支 SQL 用到的最大占位符不超過 values 的長度（少傳參數會在這裡被抓到）', () => {
        for (const { name } of BUILDERS) {
            const { text, values } = weakness[name](OPTS);
            const used = [...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
            const max = used.length ? Math.max(...used) : 0;
            assert.equal(max, values.length,
                `${name} 的 SQL 最大占位符是 $${max}，但只傳了 ${values.length} 個參數`);
            // $1..$max 每一個都要真的出現，中間不得有洞
            for (let i = 1; i <= max; i++) {
                assert.ok(used.includes(i), `${name} 的 SQL 缺少 $${i}`);
            }
        }
    });
});

// ═════════════ 結構不變量：CTE 外包、時間窗、學科、不排除封存 ═════════════

describe('weaknessService — 幾個「改掉就會靜默壞掉」的結構不變量', () => {
    test('三張聚合表都用 CTE 外包一層（PG 的 ORDER BY 不能在運算式裡用輸出別名）', () => {
        for (const name of ['buildByChapter', 'buildByType', 'buildByDifficulty']) {
            const { text } = weakness[name](OPTS);
            assert.match(text, /WITH agg AS \(/, `${name} 必須用 CTE 外包`);
            // wrong_rate 必須是外層算出來的別名，ORDER BY 才拿得到它
            assert.match(text, /AS wrong_rate/, `${name} 必須輸出 wrong_rate 別名`);
            assert.match(text, /ORDER BY wrong_rate DESC NULLS LAST, graded DESC/,
                `${name} 的排序凍結為 wrong_rate DESC NULLS LAST, graded DESC, <分組欄> ASC`);
            // 反面：ORDER BY 裡不得再出現除法運算式（那正是會炸的寫法）
            const orderBy = text.slice(text.lastIndexOf('ORDER BY'));
            assert.ok(!orderBy.includes('NULLIF'),
                `${name} 的 ORDER BY 不得直接寫運算式，會報 column "wrong" does not exist`);
        }
    });

    test('三張聚合表的分組欄名逐字凍結：chapter／question_type／difficulty', () => {
        assert.match(weakness.buildByChapter(OPTS).text, /q\.chapter AS chapter/);
        assert.match(weakness.buildByType(OPTS).text, /q\.question_type AS question_type/);
        assert.match(weakness.buildByDifficulty(OPTS).text, /q\.difficulty AS difficulty/);
    });

    test('wrong_rate 四捨五入到小數第 4 位，且 graded = 0 時是 NULL（裁決 S3-3）', () => {
        for (const name of ['buildByChapter', 'buildByType', 'buildByDifficulty']) {
            const { text } = weakness[name](OPTS);
            // NULLIF(graded, 0) 是「沒批改就回 null，不是 0」的落地方式
            assert.match(text, /round\(\(wrong::numeric \/ NULLIF\(graded, 0\)\), 4\)/,
                `${name} 的 wrong_rate 算法不符第 1.5 條`);
        }
    });

    test('五支都用同一組時間窗與學科條件', () => {
        for (const { name } of BUILDERS) {
            const { text } = weakness[name](OPTS);
            assert.match(text, /a\.assigned_at >= CURRENT_DATE - \$2::int/,
                `${name} 的時間窗必須是 a.assigned_at >= CURRENT_DATE - $2::int`);
            assert.match(text, /\(\$3::text IS NULL OR q\.subject = \$3\)/,
                `${name} 的學科條件必須是 ($3::text IS NULL OR q.subject = $3)`);
            assert.match(text, /a\.student_id = \$1/, `${name} 必須以 $1 篩學生`);
        }
    });

    test('不排除已封存題（裁決 S3-2：歷史紀錄不該因為題目被封存就消失）', () => {
        for (const { name } of BUILDERS) {
            const { text } = weakness[name](OPTS);
            assert.ok(!/archived_at/.test(text),
                `${name} 不得加 archived_at 條件——弱點面板與試卷明細都要看得到已封存題`);
        }
    });

    test('低樣本門檻不寫進 SQL（WEAKNESS_MIN_N 是設定值，由 controller 算）', () => {
        for (const { name } of BUILDERS) {
            const { text } = weakness[name](OPTS);
            assert.ok(!/low_sample|WEAKNESS_MIN_N/.test(text),
                `${name} 不得把 low_sample／門檻寫進 SQL（第 1.6 條）`);
        }
    });

    test('純函式：不讀 process.env（改門檻不該影響組出來的 SQL）', () => {
        const before = weakness.buildRecentWrong(OPTS);
        const saved = process.env.WEAKNESS_MIN_N;
        process.env.WEAKNESS_MIN_N = '999';
        try {
            const after = weakness.buildRecentWrong(OPTS);
            assert.equal(after.text, before.text);
            assert.deepEqual(after.values, before.values);
        } finally {
            if (saved === undefined) delete process.env.WEAKNESS_MIN_N;
            else process.env.WEAKNESS_MIN_N = saved;
        }
    });

    test('trend_weekly 用 ISO 週（週一起算）並依 week_start 遞增', () => {
        const { text } = weakness.buildTrendWeekly(OPTS);
        assert.match(text, /date_trunc\('week', a\.assigned_at\)::date\s+AS week_start/);
        assert.match(text, /ORDER BY week_start ASC/);
    });

    test('recent_wrong 只取 result = 0，排序與 LIMIT 凍結', () => {
        const { text } = weakness.buildRecentWrong(OPTS);
        assert.match(text, /a\.result = 0/);
        assert.match(text, /ORDER BY a\.assigned_at DESC, a\.question_id DESC/);
        assert.match(text, /LIMIT \$4/);
        // 四個輸出欄名逐字凍結（第 1.5 條）
        for (const col of ['a.question_id', 'q.chapter', 'q.question_text', 'a.assigned_at']) {
            assert.ok(text.includes(col), `recent_wrong 缺少輸出欄 ${col}`);
        }
    });
});
