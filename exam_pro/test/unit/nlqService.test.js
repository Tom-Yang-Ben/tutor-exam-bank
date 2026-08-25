// services/nlqService.js（docs/interfaces-stage3.md 第 6 條，P-08）
//
// 這一支**不連 DB、不連 Gemini**：資料庫與 llm 都以假物件注入。
// 真正要對 PostgreSQL 跑的東西在 test/integration/nlq.pg.test.js。
//
// 重點在三件事：
//   ① 400 的訊息字串與 200 的回應形狀（八個 filters 鍵一律出現）逐字凍結；
//   ② 伺服器再驗一次的六條規則（第 6.4 條）；
//   ③ 回退階梯 0/1/2/3 的觸發條件與 warning 字串（第 6.6 條）。

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const nlq = require('../../services/nlqService');

const DIM = Number(process.env.EMBED_DIM || 768);
const unitVector = () => {
    const v = new Array(DIM).fill(0);
    v[0] = 1;
    return v;
};

// ───────────────────────── 假的 db / llm ─────────────────────────

/**
 * 依 SQL 的特徵字串分派回應。真的 pg 介面只需要 { pool.connect(), query() }。
 * @param {{students?:Array, hybrid?:Array<Array>, like?:Array<Array>, details?:Array}} plan
 */
function fakeDb(plan = {}) {
    const calls = { hybrid: 0, like: 0, students: 0, excluded: 0 };
    const hybridPlan = plan.hybrid || [];
    const likePlan = plan.like || [];

    const run = async (text, values) => {
        if (/FROM students WHERE name/.test(text)) {
            calls.students += 1;
            const found = (plan.students || []).find(s => s.name === values[0]);
            return { rows: found ? [{ id: found.id }] : [] };
        }
        if (/NOT \(question_type = ANY/.test(text)) {
            calls.excluded += 1;
            return { rows: (plan.excludedIds || []).map(id => ({ id })) };
        }
        if (/ILIKE/.test(text)) {
            const rows = likePlan[calls.like] || [];
            calls.like += 1;
            return { rows };
        }
        if (/cand AS/.test(text)) {
            const rows = hybridPlan[calls.hybrid] || [];
            calls.hybrid += 1;
            return { rows };
        }
        if (/WHERE id = ANY/.test(text)) {
            const want = new Set(values[0]);
            return { rows: (plan.details || []).filter(d => want.has(d.id)) };
        }
        return { rows: [] };
    };

    const client = {
        query: async (text, values) => (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(String(text).trim())
            ? { rows: [] }
            : run(text, values)),
        release() {}
    };

    return { calls, pool: { connect: async () => client }, query: run };
}

function fakeLlm({ embedThrows = false, data = null, generateThrows = false } = {}) {
    const calls = { embed: 0, generateJson: 0 };
    return {
        calls,
        async embed() {
            calls.embed += 1;
            if (embedThrows) throw new Error('FixtureEmbedProvider：查無此鍵，請在本機執行 npm run eval:record');
            return { vectors: [unitVector()], usage: { tokenIn: 0 } };
        },
        async generateJson() {
            calls.generateJson += 1;
            if (generateThrows) throw new Error('逾時');
            return { data, usage: {}, latencyMs: 1, raw: null };
        }
    };
}

const DETAILS = [
    { id: 9, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: '題 9' },
    { id: 12, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: '題 12' },
    { id: 40, subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3, question_text: '題 40' }
];

beforeEach(() => nlq._resetCacheForTest());

// ───────────────────────── parseBody（400 的訊息字串凍結）─────────────────────────

describe('parseBody：第 6 條的驗證表', () => {
    test('query 必填、非空', () => {
        for (const body of [{}, { query: '' }, { query: '   ' }, { query: 123 }, { query: null }]) {
            const r = nlq.parseBody(body);
            assert.equal(r.ok, false);
            assert.equal(r.message, 'query 必須是非空字串。');
        }
    });

    test('query 最多 200 字', () => {
        assert.equal(nlq.parseBody({ query: '向'.repeat(200) }).ok, true);
        assert.equal(nlq.parseBody({ query: '向'.repeat(201) }).message, 'query 最多 200 字。');
    });

    test('student_id 必須是正整數（null／未給 = 不限）', () => {
        assert.equal(nlq.parseBody({ query: 'x', student_id: null }).value.studentId, null);
        assert.equal(nlq.parseBody({ query: 'x' }).value.studentId, null);
        assert.equal(nlq.parseBody({ query: 'x', student_id: 7 }).value.studentId, 7);
        for (const bad of [0, -1, 1.5, 'abc']) {
            assert.equal(nlq.parseBody({ query: 'x', student_id: bad }).message, 'student_id 必須是正整數。');
        }
    });

    test('limit 預設 20，範圍 1~50', () => {
        assert.equal(nlq.parseBody({ query: 'x' }).value.limit, 20);
        assert.equal(nlq.parseBody({ query: 'x', limit: 50 }).value.limit, 50);
        for (const bad of [0, 51, -3, 2.5, 'x']) {
            assert.equal(nlq.parseBody({ query: 'x', limit: bad }).message, 'limit 必須是 1~50 的整數。');
        }
    });

    test('query 前後空白會被 trim（長度也以 trim 後計算）', () => {
        assert.equal(nlq.parseBody({ query: '  向量內積  ' }).value.query, '向量內積');
    });
});

// ───────────────────────── 伺服器再驗一次（第 6.4 條）─────────────────────────

describe('validateFilters：第 6.4 條的六條規則', () => {
    const base = {
        subject: null, chapters: [], question_types: [],
        difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: []
    };

    test('1. 不合法的章節「丟掉那一個」而不是整包退回，並附凍結的 warning', () => {
        const r = nlq.validateFilters({ ...base, subject: '物理', chapters: ['牛頓運動定律', '不存在的章'] });
        assert.deepEqual(r.filters.chapters, ['牛頓運動定律']);
        assert.deepEqual(r.warnings, ['章節「不存在的章」不在白名單內，已忽略。']);
    });

    test('1b. 跨科的錯配也會被丟掉（物理題配到數學章節）', () => {
        const r = nlq.validateFilters({ ...base, subject: '物理', chapters: ['向量內積'] });
        assert.deepEqual(r.filters.chapters, []);
        assert.equal(r.filters.subject, '物理');
        assert.ok(r.warnings[0].includes('向量內積'));
    });

    test('2. 不合法的題型丟掉那一個', () => {
        const r = nlq.validateFilters({ ...base, question_types: ['計算', '簡答'] });
        assert.deepEqual(r.filters.question_types, ['計算']);
        assert.deepEqual(r.warnings, ['題型「簡答」不在白名單內，已忽略。']);
    });

    test('3. 難度：min > max 對調；只有一邊時另一邊補 1 或 5；不合法的變 null', () => {
        assert.deepEqual(pick(nlq.validateFilters({ ...base, difficulty_min: 5, difficulty_max: 2 })), [2, 5]);
        assert.deepEqual(pick(nlq.validateFilters({ ...base, difficulty_min: 4 })), [4, 5]);
        assert.deepEqual(pick(nlq.validateFilters({ ...base, difficulty_max: 2 })), [1, 2]);
        assert.deepEqual(pick(nlq.validateFilters({ ...base, difficulty_min: 9, difficulty_max: 0 })), [null, null]);
        assert.deepEqual(pick(nlq.validateFilters({ ...base })), [null, null]);

        function pick(r) { return [r.filters.difficulty_min, r.filters.difficulty_max]; }
    });

    test('4. 章節超過 3 個時只採用前 3 個（buildHybridQuery 只吃單一 chapter）', () => {
        const r = nlq.validateFilters({
            ...base, subject: '數學',
            chapters: ['向量內積', '空間向量內積', '外積', '平面方程式']
        });
        assert.deepEqual(r.filters.chapters, ['向量內積', '空間向量內積', '外積']);
        assert.equal(r.warnings[0], '章節條件過多，只採用前 3 個：向量內積、空間向量內積、外積');
    });

    test('6. subject 為 null 且 chapters 非空時，由第一個章節反推', () => {
        const r = nlq.validateFilters({ ...base, chapters: ['牛頓運動定律'] });
        assert.equal(r.filters.subject, '物理');
        assert.deepEqual(r.filters.chapters, ['牛頓運動定律']);
    });

    test('重複的章節與題型會去重', () => {
        const r = nlq.validateFilters({ ...base, subject: '數學', chapters: ['向量內積', '向量內積'], question_types: ['計算', '計算'] });
        assert.deepEqual(r.filters.chapters, ['向量內積']);
        assert.deepEqual(r.filters.question_types, ['計算']);
    });

    test('七個鍵一律出現', () => {
        const r = nlq.validateFilters({});
        assert.deepEqual(Object.keys(r.filters).sort(), [
            'chapters', 'difficulty_max', 'difficulty_min',
            'exclude_student_name', 'keywords', 'question_types', 'subject'
        ]);
    });
});

describe('resolveStudent：第 6.4 條第 5 點（查不到就忽略，不自動建）', () => {
    test('查得到 → id，沒有 warning', async () => {
        const db = fakeDb({ students: [{ id: 3, name: '小明' }] });
        const r = await nlq.resolveStudent(db, '小明');
        assert.deepEqual(r, { id: 3, warnings: [] });
    });

    test('查不到 → id 為 null + 凍結的 warning，且沒有任何 INSERT', async () => {
        const db = fakeDb({ students: [] });
        const r = await nlq.resolveStudent(db, '查無此人');
        assert.equal(r.id, null);
        assert.deepEqual(r.warnings, ['找不到學生「查無此人」，已忽略「沒寫過」的條件。']);
    });

    test('沒有名字就不查 DB', async () => {
        const db = fakeDb();
        const r = await nlq.resolveStudent(db, null);
        assert.deepEqual(r, { id: null, warnings: [] });
        assert.equal(db.calls.students, 0);
    });
});

// ───────────────────────── LLM 輔路徑（第 6.3 條）─────────────────────────

describe('parseOnly：LLM 只在「規則沒抓到章節且剩餘有實詞」時才呼叫', () => {
    test('規則抓到章節 → 一次 LLM 都不呼叫', async () => {
        const llm = fakeLlm({ data: {} });
        const r = await nlq.parseOnly({ query: '向量內積的計算題', llm });
        assert.equal(llm.calls.generateJson, 0);
        assert.equal(r.parse_path, 'rules');
        assert.equal(r.confident, true);
    });

    test('沒抓到章節、但剩餘沒有實詞 → 也不呼叫', async () => {
        const llm = fakeLlm({ data: {} });
        const r = await nlq.parseOnly({ query: '難度 4 以上的計算題', llm });
        assert.equal(r.semantic_text, '');
        assert.equal(llm.calls.generateJson, 0);
        assert.equal(r.parse_path, 'rules');
    });

    test('沒抓到章節、剩餘有實詞 → 呼叫，且 LLM 的章節會過白名單', async () => {
        const llm = fakeLlm({
            data: {
                subject: '物理', chapters: ['摩擦力與向心力', '亂寫的章'],
                question_types: ['計算'], semantic_text: '斜面上物體受力平衡', keywords: ['斜面']
            }
        });
        const r = await nlq.parseOnly({ query: '斜面上物體受力平衡的題目', llm });
        assert.equal(llm.calls.generateJson, 1);
        assert.equal(r.parse_path, 'llm');
        assert.deepEqual(r.filters.chapters, ['摩擦力與向心力']);
        assert.equal(r.filters.subject, '物理');
        assert.ok(r.warnings.some(w => w.includes('亂寫的章')));
    });

    test('LLM 逾時／丟錯 → 不 throw，parse_path=llm_failed 並附凍結的 warning', async () => {
        const llm = fakeLlm({ generateThrows: true });
        const r = await nlq.parseOnly({ query: '斜面上物體受力平衡的題目', llm });
        assert.equal(r.parse_path, 'llm_failed');
        assert.deepEqual(r.warnings, ['LLM 解析逾時或不合 schema，只用規則解析的結果。']);
        assert.deepEqual(r.filters.chapters, []);
    });

    test('規則抓到的難度／題型／學生名不會被 LLM 覆寫', async () => {
        const llm = fakeLlm({
            data: { chapters: ['摩擦力與向心力'], question_types: ['單選'], difficulty_min: 1, difficulty_max: 2, exclude_student_name: '別人' }
        });
        const r = await nlq.parseOnly({ query: '斜面上物體受力平衡的計算題，難度 4 以上，小明沒寫過', llm });
        assert.deepEqual(r.filters.question_types, ['計算']);
        assert.equal(r.filters.difficulty_min, 4);
        assert.equal(r.filters.difficulty_max, 5);
        assert.equal(r.filters.exclude_student_name, '小明');
        assert.deepEqual(r.filters.chapters, ['摩擦力與向心力']);
    });
});

describe('mergeLlm', () => {
    const rules = {
        subject: null, chapters: [], question_types: [], difficulty_min: null,
        difficulty_max: null, exclude_student_name: null, keywords: ['斜面']
    };

    test('LLM 給空陣列時不覆蓋規則的章節', () => {
        const withChapter = { ...rules, chapters: ['向量內積'] };
        const m = nlq.mergeLlm(withChapter, 'x', { chapters: [] });
        assert.deepEqual(m.filters.chapters, ['向量內積']);
    });

    test('semantic_text：LLM 給了非空字串就用它，否則沿用規則的', () => {
        assert.equal(nlq.mergeLlm(rules, '規則值', { semantic_text: 'LLM 值' }).semantic_text, 'LLM 值');
        assert.equal(nlq.mergeLlm(rules, '規則值', { semantic_text: '  ' }).semantic_text, '規則值');
        assert.equal(nlq.mergeLlm(rules, '規則值', {}).semantic_text, '規則值');
    });

    test('keywords 取聯集且去重', () => {
        const m = nlq.mergeLlm(rules, '', { keywords: ['斜面', '受力'] });
        assert.deepEqual(m.filters.keywords, ['斜面', '受力']);
    });
});

// ───────────────────────── LRU（第 6.7 條）─────────────────────────

describe('解析快取：sha1(query) 的 100 筆 LRU', () => {
    test('同一句話第二次不再呼叫 LLM', async () => {
        const llm = fakeLlm({ data: { chapters: ['摩擦力與向心力'], question_types: [], semantic_text: '斜面', keywords: [] } });
        await nlq.parseOnly({ query: '斜面上物體受力平衡的題目', llm });
        const second = await nlq.parseOnly({ query: '斜面上物體受力平衡的題目', llm });
        assert.equal(llm.calls.generateJson, 1);
        assert.equal(second.cacheHit, true);
        assert.deepEqual(second.filters.chapters, ['摩擦力與向心力']);
    });

    test('鍵是 sha1(query.trim())：前後空白視為同一句', async () => {
        const llm = fakeLlm({ data: { chapters: ['摩擦力與向心力'], question_types: [], semantic_text: '斜面', keywords: [] } });
        await nlq.parseOnly({ query: '斜面上物體受力平衡的題目', llm });
        const second = await nlq.parseOnly({ query: '  斜面上物體受力平衡的題目  ', llm });
        assert.equal(second.cacheHit, true);
        assert.equal(llm.calls.generateJson, 1);
    });

    test('回傳的是拷貝：呼叫端改它不會污染快取', async () => {
        const first = await nlq.parseOnly({ query: '向量內積' });
        first.filters.chapters.push('污染');
        const second = await nlq.parseOnly({ query: '向量內積' });
        assert.deepEqual(second.filters.chapters, ['向量內積']);
    });

    test('超過 100 筆時淘汰最久沒用的那一筆', async () => {
        for (let i = 0; i < nlq.CACHE_MAX; i++) await nlq.parseOnly({ query: `向量內積 第${i}題` });
        // 讓第 0 句變成「最近使用」，再塞一句新的：被淘汰的應該是第 1 句
        assert.equal((await nlq.parseOnly({ query: '向量內積 第0題' })).cacheHit, true);
        await nlq.parseOnly({ query: '向量內積 全新的一句' });
        assert.equal((await nlq.parseOnly({ query: '向量內積 第0題' })).cacheHit, true);
        assert.equal((await nlq.parseOnly({ query: '向量內積 第1題' })).cacheHit, false);
    });

    test('noCache 完全不碰快取', async () => {
        const a = await nlq.parseOnly({ query: '向量內積', noCache: true });
        const b = await nlq.parseOnly({ query: '向量內積', noCache: true });
        assert.equal(a.cacheHit, false);
        assert.equal(b.cacheHit, false);
    });
});

// ───────────────────────── 回應形狀與回退階梯（第 6、6.6 條）─────────────────────────

describe('searchNl：200 的回應形狀', () => {
    test('filters 的八個鍵一律出現', async () => {
        const db = fakeDb({ hybrid: [[{ id: 9, score: 0.03, vec_rank: 1, kw_rank: 2 }]], details: DETAILS });
        const body = await nlq.searchNl({ query: '向量內積的計算題', limit: 20 }, { db, llm: fakeLlm() });
        assert.deepEqual(Object.keys(body.filters), [
            'subject', 'chapters', 'question_types', 'difficulty_min',
            'difficulty_max', 'exclude_student_name', 'semantic_text', 'keywords'
        ]);
        assert.deepEqual(Object.keys(body).sort(), ['fallback_level', 'filters', 'parse_path', 'results', 'warnings']);
    });

    test('results 的形狀與 /similar 相同', async () => {
        const db = fakeDb({ hybrid: [[{ id: 9, score: 0.0325, vec_rank: 1, kw_rank: 2 }]], details: DETAILS });
        const body = await nlq.searchNl({ query: '向量內積', limit: 20 }, { db, llm: fakeLlm() });
        assert.equal(body.results.length, 1);
        for (const key of ['id', 'subject', 'chapter', 'question_type', 'difficulty', 'question_text', 'score']) {
            assert.ok(key in body.results[0], `results[0] 少了 ${key}`);
        }
        assert.equal(body.results[0].score, 0.0325);
    });

    test('level 0：正常路徑沒有 warning', async () => {
        const db = fakeDb({ hybrid: [[{ id: 9, score: 0.03 }]], details: DETAILS });
        const body = await nlq.searchNl({ query: '向量內積', limit: 20 }, { db, llm: fakeLlm() });
        assert.equal(body.fallback_level, 0);
        assert.deepEqual(body.warnings, []);
        assert.equal(body.parse_path, 'rules');
    });

    test('level 1：LLM 逾時 → parse_path=llm_failed，只用規則的結果', async () => {
        const db = fakeDb({ hybrid: [[{ id: 40, score: 0.02 }]], details: DETAILS });
        const llm = fakeLlm({ generateThrows: true });
        const body = await nlq.searchNl({ query: '斜面上物體受力平衡的題目', limit: 20 }, { db, llm });
        assert.equal(body.parse_path, 'llm_failed');
        assert.equal(body.fallback_level, 1);
        assert.ok(body.warnings.includes('LLM 解析逾時或不合 schema，只用規則解析的結果。'));
    });

    test('level 2：hybrid 回 0 筆 → 放寬條件重查', async () => {
        // 第一段（帶章節）0 筆、第二段（只留 subject）也 0 筆、第三段（純向量）才有
        const db = fakeDb({ hybrid: [[], [], [{ id: 9, score: 0.01 }]], details: DETAILS });
        const body = await nlq.searchNl({ query: '向量內積難度 5', limit: 20 }, { db, llm: fakeLlm() });
        assert.equal(body.fallback_level, 2);
        assert.ok(body.warnings.includes('hybrid 檢索 0 筆，已放寬條件重查。'));
        assert.equal(body.results.length, 1);
    });

    test('level 2 走完仍是 0 筆 → results:[] 且 fallback_level:2（不是 3）', async () => {
        const db = fakeDb({ hybrid: [[], [], []], details: DETAILS });
        const body = await nlq.searchNl({ query: '向量內積', limit: 20 }, { db, llm: fakeLlm() });
        assert.deepEqual(body.results, []);
        assert.equal(body.fallback_level, 2);
    });

    test('level 3：embed() 丟錯 → LIKE，score 一律 null', async () => {
        const db = fakeDb({ like: [[{ id: 9, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: '題 9' }]] });
        const llm = fakeLlm({ embedThrows: true });
        const body = await nlq.searchNl({ query: '向量內積', limit: 20 }, { db, llm });
        assert.equal(body.fallback_level, 3);
        assert.ok(body.warnings.includes('embedding 服務不可用，改用關鍵字 LIKE 檢索。'));
        assert.equal(body.results[0].score, null);
        assert.equal(db.calls.hybrid, 0, 'embedding 掛了就不該再去跑 hybrid');
    });

    test('兩級同時成立 → 回較高的那一級，warnings 兩句都要有', async () => {
        // embedding 掛了（3）而且第一段 LIKE 也 0 筆（2）
        const db = fakeDb({ like: [[], [{ id: 9, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: '題 9' }]] });
        const llm = fakeLlm({ embedThrows: true });
        const body = await nlq.searchNl({ query: '向量內積', limit: 20 }, { db, llm });
        assert.equal(body.fallback_level, 3);
        assert.ok(body.warnings.includes('embedding 服務不可用，改用關鍵字 LIKE 檢索。'));
        assert.ok(body.warnings.includes('hybrid 檢索 0 筆，已放寬條件重查。'));
    });

    test('查無此學生的 warning 會出現在回應裡，且不影響 results', async () => {
        const db = fakeDb({ hybrid: [[{ id: 9, score: 0.03 }]], details: DETAILS, students: [] });
        const body = await nlq.searchNl({ query: '向量內積，小明沒寫過', limit: 20 }, { db, llm: fakeLlm() });
        assert.ok(body.warnings.includes('找不到學生「小明」，已忽略「沒寫過」的條件。'));
        assert.equal(body.filters.exclude_student_name, '小明');
        assert.equal(body.results.length, 1);
    });

    test('subject 全空時兩科各跑一次（裁決 S3-16）', async () => {
        // 第一段：數學 0 筆、物理 1 筆 → 合併後非空，不會再往下一段走
        const db = fakeDb({ hybrid: [[], [{ id: 40, score: 0.02 }]], details: DETAILS });
        // 規則抓不到章節、LLM 也給不出 subject → subject 為 null
        const llm = fakeLlm({ data: { chapters: [], question_types: [], semantic_text: '熱傳導', keywords: [] } });
        const body = await nlq.searchNl({ query: '熱傳導方式的題目', limit: 20 }, { db, llm });
        assert.equal(body.filters.subject, null);
        assert.equal(db.calls.hybrid, 2, '第一段應該是「數學一次、物理一次」');
        assert.equal(body.fallback_level, 0);
        assert.deepEqual(body.results.map(r => r.id), [40]);
    });

    test('limit 會夾在 1~50 並實際截斷 results', async () => {
        const rows = [9, 12, 40].map((id, i) => ({ id, score: 1 - i * 0.1 }));
        const db = fakeDb({ hybrid: [rows], details: DETAILS });
        const body = await nlq.searchNl({ query: '向量內積', limit: 2 }, { db, llm: fakeLlm() });
        assert.equal(body.results.length, 2);
        assert.deepEqual(body.results.map(r => r.id), [9, 12]);
    });
});

describe('isNlqEnabled：FEATURE_NLQ 的布林解讀（interfaces-stage1.md 第 9 條）', () => {
    test('只有 1 與 true（不分大小寫）算開啟', () => {
        const before = process.env.FEATURE_NLQ;
        try {
            for (const [value, want] of [['1', true], ['true', true], ['TRUE', true], ['false', false], ['0', false], ['', false], ['yes', false]]) {
                process.env.FEATURE_NLQ = value;
                assert.equal(nlq.isNlqEnabled(), want, `FEATURE_NLQ=${value}`);
            }
            delete process.env.FEATURE_NLQ;
            assert.equal(nlq.isNlqEnabled(), false);
        } finally {
            if (before === undefined) delete process.env.FEATURE_NLQ;
            else process.env.FEATURE_NLQ = before;
        }
    });
});
