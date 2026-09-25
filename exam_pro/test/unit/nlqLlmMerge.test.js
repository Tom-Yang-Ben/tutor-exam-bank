// NLQ 的 LLM 輔路徑改善（〔dec/x-nlq-improve〕2026-09-26；docs/retrieval.md 第 9 條）
//
// 釘住的東西：
//   - utils/nlqHeuristics.js 的證據檢查：題型／難度字眼、平面／空間線索、空間章 ↔ 同名平面章的對照表；
//   - nlqService.mergeLlm 帶原句時：句子沒提到的題型／難度／學生不採用、只明講平面或只明講空間時換成同名的另一章
//     （同名的另一章模型也列了、或句子兩種都講時不換——〔dec/x-nlq-improve-fix〕審查意見），
//     被擋下或換掉的項目記在 adjustments；不帶原句時行為與改版前相同；
//   - parseOnly：adjustments 進解析結果與 log，不產生新的 warning（第 6 條的回應形狀不變）；
//   - nlq.v2 模板：【容易混淆的章】裡的章名都在白名單、【範例】合 schema 且與證據檢查一致、
//     模板與 schema 說明不含 eval/golden/nlq.json 的查詢原句（範例不得洩漏 golden）。
// 例句一律自撰，刻意避開 golden 的 50 句。純單元測試：不連 DB、不連 LLM。執行：npm test

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const { CHAPTERS, SUBJECTS, isValidChapter, isValidQuestionType } = require('../../config/chapters');
const { CHAPTER_ALIASES } = require('../../config/chapterAliases');
const { buildSchema } = require('../../agents/schemas');
const {
    parseQuery, TYPE_ALIASES,
    mentionsQuestionType, mentionsDifficulty, dimensionCue, alignChapterDimension,
    SPACE_TO_PLANE, PLANE_TO_SPACE, QUESTION_TYPE_CUES
} = require('../../utils/nlqHeuristics');
const nlq = require('../../services/nlqService');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'eval', 'golden', 'nlq.json'), 'utf8'));

/** 規則層的空結果（parseQuery 對「沒有任何條件」的句子給的 filters） */
const EMPTY_RULES = {
    subject: null, chapters: [], question_types: [], difficulty_min: null,
    difficulty_max: null, exclude_student_name: null, keywords: []
};

function fakeLlm(data) {
    const calls = [];
    return {
        calls,
        async generateJson(opts) { calls.push(opts); return { data, usage: {}, latencyMs: 0 }; }
    };
}

// ───────────────────────── 證據字 ─────────────────────────

describe('mentionsQuestionType／mentionsDifficulty：句子有沒有講到題型、難度', () => {
    test('題型：規則層不處理的講法（選擇、非選、試證、填格子、白名單外的題型名）也算有講', () => {
        for (const q of ['出幾題選擇給他練', '非選的部分', '試證三角形全等', '要能填格子的', '要問答的', '應用題']) {
            assert.equal(mentionsQuestionType(q), true, q);
        }
    });

    test('題型：計算題的別稱「演算題」「運算題」與「非選題」也算有講（規則層不認得，也不含「計算」兩字）', () => {
        for (const q of ['等比級數出幾題演算題', '對數的運算題', '圓錐曲線的非選題']) {
            assert.equal(mentionsQuestionType(q), true, q);
        }
        for (const w of ['演算', '運算', '非選']) assert.ok(QUESTION_TYPE_CUES.includes(w), w);
    });

    test('題型：「求…」「是多少」「怎麼算」不是題型', () => {
        for (const q of ['求拋物線的焦點', '兩車相遇的時間是多少', '鹽類的溶解度怎麼算', '單擺週期跟擺長的關係']) {
            assert.equal(mentionsQuestionType(q), false, q);
        }
    });

    test('題型：規則層認得的寫法（TYPE_ALIASES）都含證據字——規則抓到時題型本來就以規則為準', () => {
        for (const alias of Object.keys(TYPE_ALIASES)) assert.equal(mentionsQuestionType(alias), true, alias);
        assert.ok(!QUESTION_TYPE_CUES.includes('算'), '「算」刻意不收');
    });

    test('難度：模糊講法（難一點、有挑戰性、簡單、基礎、進階、N 星）算有講；沒講就 false', () => {
        for (const q of ['來幾題難一點的', '有挑戰性的', '簡單的暖身題', '基礎觀念', '進階一點', '3 星的', '深一點的', '高階一點的']) {
            assert.equal(mentionsDifficulty(q), true, q);
        }
        for (const q of ['球從桌邊水平滾出去落地點多遠', '鐵釘放進硫酸銅溶液會怎樣']) {
            assert.equal(mentionsDifficulty(q), false, q);
        }
    });
});

// ───────────────────────── 平面／空間 ─────────────────────────

describe('dimensionCue／alignChapterDimension：句子明講平面或空間時，挑錯維度的章換成同名的另一章', () => {
    test('對照表由 CHAPTERS 算出：空間 + X 而且 X 也是數學章節', () => {
        assert.deepEqual(SPACE_TO_PLANE, { '空間向量內積': '向量內積', '空間直線方程式': '直線方程式' });
        for (const [space, plane] of Object.entries(SPACE_TO_PLANE)) {
            assert.ok(isValidChapter('數學', space), space);
            assert.ok(isValidChapter('數學', plane), plane);
            assert.equal(PLANE_TO_SPACE[plane], space);
        }
    });

    test('dimensionCue：「平面上」「坐標平面」「二維」→ plane；「空間」「三維」「z 軸」→ space；兩者都有或都沒有 → null', () => {
        assert.equal(dimensionCue('坐標平面上兩點的距離'), 'plane');
        assert.equal(dimensionCue('二維的向量夾角'), 'plane');
        assert.equal(dimensionCue('xy 平面上的直線'), 'plane');
        assert.equal(dimensionCue('三維的兩向量夾角'), 'space');
        assert.equal(dimensionCue('投影到 Z 軸'), 'space');
        assert.equal(dimensionCue('空間中的平面上一點'), null, '兩種線索都有');
        assert.equal(dimensionCue('兩向量的夾角'), null);
        assert.equal(dimensionCue('過三點的平面方程式'), null, '單一個「平面」不算平面線索');
    });

    test('dimensionCue：有空間線索、又另外講了「平面」→ 兩個維度都要 → null（審查意見：原本判成 space）', () => {
        for (const q of [
            '兩向量互相垂直求未知數，平面和空間的都要',
            '向量夾角的題，平面跟空間各來幾題',
            '求兩直線交點，平面和空間的都要',
            '平面或立體的都可以',
            '二維和三維的都要'
        ]) {
            assert.equal(dimensionCue(q), null, q);
        }
    });

    test('dimensionCue：空間句子裡「平面」是空間單元的題材（平面方程式、過…的平面、點到平面、兩平面、法向量）→ 仍是 space', () => {
        for (const q of [
            '空間中過三點的平面方程式',
            '空間中點到平面的距離',
            '空間中兩平面的夾角',
            '空間中平面與平面的夾角',
            '空間中平面的法向量'
        ]) {
            assert.equal(dimensionCue(q), 'space', q);
        }
    });

    test('平面線索：空間章換成同名平面章、順序不變；沒有對應的章原樣保留', () => {
        const r = alignChapterDimension(['向量的加減與係數積', '空間向量內積', '外積'], '平面上兩向量的夾角');
        assert.deepEqual(r.chapters, ['向量的加減與係數積', '向量內積', '外積']);
        assert.deepEqual(r.changes, [{ from: '空間向量內積', to: '向量內積' }]);
    });

    test('模型重複列同一章：只留一個、changes 只記一次', () => {
        const r = alignChapterDimension(['空間向量內積', '空間向量內積'], '平面上兩向量的夾角');
        assert.deepEqual(r.chapters, ['向量內積']);
        assert.deepEqual(r.changes, [{ from: '空間向量內積', to: '向量內積' }]);
    });

    test('同名的另一章已經在清單裡：不換、兩章都留（即使句子只明講一個維度）', () => {
        assert.deepEqual(alignChapterDimension(['空間向量內積', '向量內積'], '平面上兩向量的夾角'),
            { chapters: ['空間向量內積', '向量內積'], changes: [] });
        assert.deepEqual(alignChapterDimension(['直線方程式', '空間直線方程式'], '空間中兩直線的交點'),
            { chapters: ['直線方程式', '空間直線方程式'], changes: [] });
    });

    test('句子平面、空間都要（審查意見的例句）：兩章都列 → 兩章都留；只列一章 → 也不換', () => {
        assert.deepEqual(alignChapterDimension(['向量內積', '空間向量內積'], '兩向量互相垂直求未知數，平面和空間的都要'),
            { chapters: ['向量內積', '空間向量內積'], changes: [] });
        assert.deepEqual(alignChapterDimension(['直線方程式', '空間直線方程式'], '求兩直線交點，平面和空間的都要'),
            { chapters: ['直線方程式', '空間直線方程式'], changes: [] });
        assert.deepEqual(alignChapterDimension(['向量內積'], '向量夾角的題，平面跟空間各來幾題'),
            { chapters: ['向量內積'], changes: [] });
    });

    test('空間線索：平面章換成同名空間章', () => {
        const r = alignChapterDimension(['直線方程式'], '空間中兩條直線是否相交');
        assert.deepEqual(r.chapters, ['空間直線方程式']);
        assert.deepEqual(r.changes, [{ from: '直線方程式', to: '空間直線方程式' }]);
    });

    test('沒有線索：一個都不換；非陣列當空陣列', () => {
        assert.deepEqual(alignChapterDimension(['空間向量內積', '向量內積'], '兩向量的夾角'),
            { chapters: ['空間向量內積', '向量內積'], changes: [] });
        assert.deepEqual(alignChapterDimension(undefined, '平面上'), { chapters: [], changes: [] });
    });
});

// ───────────────────────── mergeLlm ─────────────────────────

describe('mergeLlm 帶原句：句子裡找不到證據的條件不採用', () => {
    test('題型：句子沒講 → 不採用並記在 adjustments；有講（規則不認得的「選擇」）→ 採用', () => {
        const noCue = nlq.mergeLlm(EMPTY_RULES, 'x', { chapters: ['拋物線'], question_types: ['計算'] }, { query: '求拋物線的焦點' });
        assert.deepEqual(noCue.filters.question_types, []);
        assert.equal(noCue.adjustments.length, 1);
        assert.match(noCue.adjustments[0], /題型 計算 不採用/);

        const cue = nlq.mergeLlm(EMPTY_RULES, 'x', { question_types: ['單選'] }, { query: '出幾題拋物線焦點的選擇' });
        assert.deepEqual(cue.filters.question_types, ['單選']);
        assert.deepEqual(cue.adjustments, []);
    });

    test('題型：規則已抓到時照舊以規則為準（LLM 的不看，也不記 adjustments）', () => {
        const rules = { ...EMPTY_RULES, question_types: ['填空'] };
        const m = nlq.mergeLlm(rules, 'x', { question_types: ['計算'] }, { query: '拋物線焦點的填空題' });
        assert.deepEqual(m.filters.question_types, ['填空']);
        assert.deepEqual(m.adjustments, []);
    });

    test('難度：句子沒講 → 不採用；講了「難一點」→ 採用', () => {
        const noCue = nlq.mergeLlm(EMPTY_RULES, 'x', { difficulty_min: 4 }, { query: '拋物線的焦點與準線' });
        assert.equal(noCue.filters.difficulty_min, null);
        assert.equal(noCue.filters.difficulty_max, null);
        assert.match(noCue.adjustments[0], /難度 4~ 不採用/);

        const cue = nlq.mergeLlm(EMPTY_RULES, 'x', { difficulty_min: 4 }, { query: '拋物線的焦點，難一點的' });
        assert.equal(cue.filters.difficulty_min, 4);
        assert.deepEqual(cue.adjustments, []);
    });

    test('學生：名字要逐字出現在句子裡，否則不採用', () => {
        const made = nlq.mergeLlm(EMPTY_RULES, 'x', { exclude_student_name: '小安' }, { query: '拋物線焦點的題' });
        assert.equal(made.filters.exclude_student_name, null);
        assert.match(made.adjustments[0], /學生「小安」不採用/);

        const said = nlq.mergeLlm(EMPTY_RULES, 'x', { exclude_student_name: ' 小安 ' }, { query: '小安常錯的拋物線焦點' });
        assert.equal(said.filters.exclude_student_name, '小安');
        assert.deepEqual(said.adjustments, []);
    });

    test('章節：明講平面時空間章換成平面章，記在 adjustments；subject 照舊採用 LLM 的', () => {
        const m = nlq.mergeLlm(EMPTY_RULES, 'x', { subject: '數學', chapters: ['空間向量內積'] }, { query: '平面上兩向量夾角的餘弦' });
        assert.deepEqual(m.filters.chapters, ['向量內積']);
        assert.equal(m.filters.subject, '數學');
        assert.deepEqual(m.adjustments, ['章節「空間向量內積」→「向量內積」（句子明講了平面或空間）']);
    });

    test('不帶原句：行為與改版前相同（全部照收，adjustments 為空陣列）', () => {
        const data = { chapters: ['空間向量內積'], question_types: ['計算'], difficulty_min: 2, difficulty_max: 3, exclude_student_name: '小安' };
        const m = nlq.mergeLlm(EMPTY_RULES, 'x', data);
        assert.deepEqual(m.filters.chapters, ['空間向量內積']);
        assert.deepEqual(m.filters.question_types, ['計算']);
        assert.equal(m.filters.difficulty_min, 2);
        assert.equal(m.filters.difficulty_max, 3);
        assert.equal(m.filters.exclude_student_name, '小安');
        assert.deepEqual(m.adjustments, []);
    });

    test('不改到呼叫端的物件（規則的 filters 與 LLM 的 data）', () => {
        const rules = { ...EMPTY_RULES, keywords: ['拋物線'] };
        const data = { chapters: ['空間向量內積'], question_types: ['計算'] };
        const before = JSON.stringify([rules, data]);
        nlq.mergeLlm(rules, 'x', data, { query: '平面上兩向量夾角' });
        assert.equal(JSON.stringify([rules, data]), before);
    });
});

// ───────────────────────── parseOnly ─────────────────────────

describe('parseOnly：證據檢查接在 LLM 之後、白名單再驗之前', () => {
    beforeEach(() => nlq._resetCacheForTest());

    test('句子沒講題型：LLM 的「計算」不採用；adjustments 寫進結果與 log；不多出任何 warning', async () => {
        const llm = fakeLlm({ subject: '物理', chapters: ['平面運動'], question_types: ['計算'], semantic_text: '球從桌邊水平滾出去落地點多遠', keywords: [] });
        const logs = [];
        const r = await nlq.parseOnly({
            query: '球從桌邊水平滾出去落地點多遠', llm, noCache: true,
            logger: { info: (o) => logs.push(o), warn() {} }
        });
        assert.equal(llm.calls.length, 1);
        assert.equal(r.parse_path, 'llm');
        assert.deepEqual(r.filters.chapters, ['平面運動']);
        assert.deepEqual(r.filters.question_types, []);
        assert.deepEqual(r.warnings, [], '證據檢查不是錯誤，不進 warnings（第 6 條的回應形狀不變）');
        assert.equal(r.adjustments.length, 1);
        assert.equal(logs.length, 1);
        assert.match(logs[0].msg, /題型 計算 不採用/);
    });

    test('明講平面：LLM 的空間章換成平面章之後才過白名單；subject 由 LLM 給或由章節反推', async () => {
        const llm = fakeLlm({ chapters: ['空間向量內積'], question_types: [], semantic_text: 'x', keywords: [] });
        const r = await nlq.parseOnly({ query: '平面上兩向量夾角的餘弦值', llm, noCache: true });
        assert.equal(r.parse_path, 'llm');
        assert.deepEqual(r.filters.chapters, ['向量內積']);
        assert.equal(r.filters.subject, '數學');
    });

    test('平面、空間都要（審查意見）：規則抓不到章節、走 LLM；LLM 兩章都回 → 兩章都留、沒有 adjustments', async () => {
        for (const [query, chapters] of [
            ['兩向量互相垂直求未知數，平面和空間的都要', ['向量內積', '空間向量內積']],
            ['向量夾角的題，平面跟空間各來幾題', ['向量內積', '空間向量內積']],
            ['求兩直線交點，平面和空間的都要', ['直線方程式', '空間直線方程式']]
        ]) {
            const llm = fakeLlm({ subject: '數學', chapters, question_types: [], semantic_text: query, keywords: [] });
            const r = await nlq.parseOnly({ query, llm, noCache: true });
            assert.equal(llm.calls.length, 1, `${query}：應走 LLM 輔路徑`);
            assert.equal(r.parse_path, 'llm', query);
            assert.deepEqual(r.filters.chapters, chapters, query);
            assert.deepEqual(r.adjustments, [], query);
        }
    });

    test('規則路徑（抓到章節）與 LLM 失敗：adjustments 為空陣列', async () => {
        const rulesOnly = await nlq.parseOnly({ query: '向量內積的計算題', llm: fakeLlm({}), noCache: true });
        assert.equal(rulesOnly.parse_path, 'rules');
        assert.deepEqual(rulesOnly.adjustments, []);

        const failing = { async generateJson() { throw new Error('逾時'); } };
        const f = await nlq.parseOnly({ query: '球從桌邊水平滾出去落地點多遠', llm: failing, noCache: true });
        assert.equal(f.parse_path, 'llm_failed');
        assert.deepEqual(f.adjustments, []);
    });

    test('快取命中時 adjustments 一起回來', async () => {
        const llm = fakeLlm({ chapters: ['平面運動'], question_types: ['計算'], semantic_text: 'x', keywords: [] });
        await nlq.parseOnly({ query: '球從桌邊水平滾出去落地點多遠', llm });
        const second = await nlq.parseOnly({ query: '球從桌邊水平滾出去落地點多遠', llm });
        assert.equal(second.cacheHit, true);
        assert.equal(llm.calls.length, 1);
        assert.equal(second.adjustments.length, 1);
    });
});

// ───────────────────────── 模板與 schema ─────────────────────────

/** PROMPT_TEMPLATE 裡某個【區塊】的內容（到下一個【或結尾） */
function section(title) {
    const at = nlq.PROMPT_TEMPLATE.indexOf(`【${title}】`);
    assert.ok(at >= 0, `模板少了【${title}】`);
    const rest = nlq.PROMPT_TEMPLATE.slice(at + title.length + 2);
    const end = rest.indexOf('【');
    return end === -1 ? rest : rest.slice(0, end);
}

/** 【範例】的「老師說：…」與「→ {…}」兩行一組 */
function examples() {
    const lines = section('範例').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^老師說：(.+)$/.exec(lines[i]);
        if (!m) continue;
        const next = /^→ (\{.*\})$/.exec(lines[i + 1] || '');
        assert.ok(next, `範例「${m[1]}」下一行要是 → {JSON}`);
        out.push({ query: m[1], data: JSON.parse(next[1]) });
    }
    return out;
}

describe('nlq.v2 模板：容易混淆的章、範例、不洩漏 golden', () => {
    test('【容易混淆的章】：「」框起的章名與平面／空間兩組清單都在白名單內', () => {
        const text = section('容易混淆的章');
        const all = SUBJECTS.flatMap(s => CHAPTERS[s]);
        const quoted = [...text.matchAll(/「([^」]+)」/g)].map(m => m[1])
            .filter(s => !['平面上', '空間', '三維'].includes(s));
        assert.ok(quoted.length >= 8);
        for (const c of quoted) assert.ok(all.includes(c), `「${c}」不在白名單`);
        for (const label of ['平面：', '空間：']) {
            const m = new RegExp(`${label}([^。]+)。`).exec(text);
            assert.ok(m, label);
            const names = m[1].replace(/（[^）]*）/g, '').split('、').map(s => s.trim());
            assert.ok(names.length >= 3, label);
            for (const c of names) assert.ok(isValidChapter('數學', c), `${label}「${c}」不是數學章節`);
        }
    });

    test('【範例】：合 schema、章節合法；句子本身規則抓不到章節（示範的是 LLM 輔路徑）；條件都有句子裡的證據', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(buildSchema('nlq'));
        const list = examples();
        assert.equal(list.length, 3);
        for (const { query, data } of list) {
            assert.ok(validate(data), `${query}：${JSON.stringify(validate.errors)}`);
            for (const c of data.chapters) assert.ok(isValidChapter(data.subject, c), `${query}：${c}`);
            for (const t of data.question_types) assert.ok(isValidQuestionType(t));
            assert.equal(parseQuery(query, { aliases: CHAPTER_ALIASES }).confident, false, `${query}：規則就抓到章節了`);
            if (data.question_types.length) assert.ok(mentionsQuestionType(query), `${query}：題型沒有證據`);
            if ('difficulty_min' in data || 'difficulty_max' in data) assert.ok(mentionsDifficulty(query), query);
            if (data.exclude_student_name) assert.ok(query.includes(data.exclude_student_name), query);
            // 證據檢查不會改動範例：範例示範的就是伺服器接受的寫法
            const merged = nlq.mergeLlm(EMPTY_RULES, '', data, { query });
            assert.deepEqual(merged.adjustments, [], query);
        }
        assert.ok(list.some(e => e.data.subject === '化學'), '三科各有範例');
        assert.ok(list.some(e => e.data.subject === '數學'));
        assert.ok(list.some(e => e.data.subject === '物理'));
    });

    test('模板與 schema 說明不含 eval/golden/nlq.json 的查詢原句（LLM 路徑另查 semantic_text）', () => {
        const all = SUBJECTS.flatMap(s => CHAPTERS[s]);
        const schemaText = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'schemas', 'nlq.json'), 'utf8');
        const haystacks = { 模板: `${nlq.SYSTEM}\n${nlq.PROMPT_TEMPLATE}`, schema: schemaText };
        for (const e of GOLDEN.entries) {
            const needles = [e.query];
            if (e.expect_path === 'llm') needles.push(e.expect.semantic_text);
            for (const needle of needles) {
                if (all.includes(needle)) continue;   // 查詢就是章名本身（nlq-001～008）：章名本來就在白名單與提示裡
                for (const [where, text] of Object.entries(haystacks)) {
                    assert.ok(!text.includes(needle), `${where}含 golden ${e.id} 的「${needle}」`);
                }
            }
        }
    });

    test('schema：keywords 排第一（本機模型依 schema 順序生成，先寫名詞再挑章），其餘欄位與必填不變', () => {
        const schema = buildSchema('nlq');
        assert.equal(schema.propertyOrdering[0], 'keywords');
        assert.deepEqual([...schema.propertyOrdering].sort(), Object.keys(schema.properties).sort());
        assert.deepEqual([...schema.required].sort(), ['chapters', 'keywords', 'question_types', 'semantic_text']);
        assert.match(schema.properties.question_types.description, /不算指定題型/);
    });
});
