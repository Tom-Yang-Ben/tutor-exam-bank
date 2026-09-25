// agents/classify.js 與 config/chapterExamples.js 的單元測試（WS-B / A-T9）
//
// ctx.llm、ctx.db 全部注入：不連 Gemini、不連 PG。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const classify = require('../../agents/classify');
const { CHAPTERS, SUBJECTS } = require('../../config/chapters');
const { CHAPTER_EXAMPLES, getChapterExample, missingExamples } = require('../../config/chapterExamples');

const QUESTION = '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求兩向量的夾角。';

function fakeCtx({ data, db = null, features = {}, minConf = 0.8 } = {}) {
    const calls = [];
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    return { data, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 1, tokenCached: 0 }, latencyMs: 1, raw: null };
                },
                embed: async () => { throw new Error('這個測試不該呼叫 embed'); }
            },
            db,
            job: { id: 1, budget_usd: 1, cost_usd: 0 },
            jq: { id: 1, idx: 1001, payload: {}, retries: {} },
            logger: { info() {}, warn() {}, error() {} },
            config: {
                models: { extract: 'gemini:gemini-3.5-flash' },
                thresholds: { classifyMinConf: minConf },
                features
            },
            signal: undefined
        }
    };
}

// ───────────────────────── config/chapterExamples.js ─────────────────────────

describe('config/chapterExamples.js', () => {
    test('鍵集合與 CHAPTERS 完全相同（一個都不能少、也不能多）', () => {
        for (const subject of SUBJECTS) {
            const expected = [...CHAPTERS[subject]].sort();
            const actual = Object.keys(CHAPTER_EXAMPLES[subject]).sort();
            assert.deepEqual(actual, expected, `${subject} 的例句鍵集合與 CHAPTERS 不一致`);
        }
        assert.deepEqual(Object.keys(CHAPTER_EXAMPLES).sort(), [...SUBJECTS].sort());
    });

    // 〔章節重整 CH-A〕標題原為「66 章」；斷言本來就涵蓋 CHAPTERS 全部科目（重整後數學 52＋物理 34＋化學 44）
    test('每一章都填好，沒有空殼', () => {
        assert.deepEqual(missingExamples(), []);
    });

    test('每一句都在合理長度內，且提到該章的關鍵字或帶公式', () => {
        for (const subject of SUBJECTS) {
            for (const chapter of CHAPTERS[subject]) {
                const example = getChapterExample(subject, chapter);
                assert.ok(example.length >= 10, `${chapter} 的例句太短`);
                assert.ok(example.length <= 80, `${chapter} 的例句太長：${example.length} 字`);
            }
        }
    });

    test('查無此科／此章回空字串，不丟例外', () => {
        assert.equal(getChapterExample('化學', '有機'), '');
        assert.equal(getChapterExample('數學', '不存在的章'), '');
    });
});

// ───────────────────────── 最接近的章節 ─────────────────────────

describe('nearestChapters／invalidChapterFeedback', () => {
    test('feedback 格式凍結（第 3.3 條）', () => {
        const msg = classify.invalidChapterFeedback('數學', '平面向量');
        assert.equal(msg, '「平面向量」不在白名單內，最接近的是「向量內積」「平面方程式」');
    });

    test('連一個 bigram 都對不上時仍給得出有意義的候選', () => {
        // 只用 bigram 的話「電磁學」對每一章都是 0 分，會回宣告順序的前兩章（毫無幫助）
        assert.deepEqual(classify.nearestChapters('物理', '電磁學', 2), ['電磁感應', '靜電學']);
    });

    test('同一個輸入永遠回同一組候選（確定性）', () => {
        const a = classify.nearestChapters('數學', '三角函數', 3);
        const b = classify.nearestChapters('數學', '三角函數', 3);
        assert.deepEqual(a, b);
        // 〔章節重整 CH-A〕舊章「三角函數的定義」已拆分（docs/chapter-restructure.md 第 2 條）。
        // 「三角函數的圖形」與「三角函數的疊合」分數相同，依宣告順序取前者——仍是確定的單一答案。
        assert.equal(a[0], '三角函數的圖形');
        assert.equal(a[1], '三角函數的疊合');
    });
});

// ───────────────────────── 第一層零成本閘門 ─────────────────────────

describe('第一層：零成本閘門', () => {
    test('章節在白名單內且信心 ≥ 門檻 → pass，一次 LLM 都不呼叫', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '不該被用到' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.92, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'gate');
        assert.equal(outcome.data.chapter, '向量內積');
        assert.equal(outcome.data.confidence, 0.92);
        assert.equal(calls.length, 0, '零成本閘門不得呼叫 LLM');
        assert.ok(!('few_shot_ids' in outcome.data), 'gate 路徑不該有 few_shot_ids');
    });

    test('chapter_confidence 缺值 → 閘門不過（不得當成 1.0；裁決 S2-13）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '向量內積', question_text: QUESTION });
        assert.equal(outcome.data.source, 'llm');
        assert.equal(calls.length, 1);
    });

    test('chapter_confidence 為 0 → 閘門不過，連 CLASSIFY_MIN_CONF=0 也擋得住（裁決 S2-13）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, minConf: 0 });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0, question_text: QUESTION
        });
        assert.equal(outcome.data.source, 'llm', '門檻設 0 時仍不得讓 confidence=0 的題矇混過關');
        assert.equal(calls.length, 1);
    });

    test('信心剛好等於門檻也算通過', async () => {
        const { ctx, calls } = fakeCtx({ data: {}, minConf: 0.8 });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.8, question_text: QUESTION
        });
        assert.equal(outcome.data.source, 'gate');
        assert.equal(calls.length, 0);
    });

    test('信心不足 → 落到第二層（要呼叫 LLM）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.95, rationale: '用到內積公式' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.5, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'llm');
        assert.equal(calls.length, 1);
    });

    test('章節不在白名單 → 落到第二層（即使信心 1.0）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: '平面向量', chapter_confidence: 1, question_text: QUESTION
        });
        assert.equal(calls.length, 1);
        assert.equal(outcome.data.chapter, '向量內積');
    });
});

// ───────────────────────── 第二層 ─────────────────────────

describe('第二層：few-shot + LLM', () => {
    test('沒有 DB 時 few-shot 用 config/chapterExamples.js，few_shot_ids 是空陣列', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.deepEqual(outcome.data.few_shot_ids, []);
        assert.deepEqual(calls[0].cacheKeyParts.fewShotIds, []);
        // prompt 裡要有自製例句
        assert.ok(calls[0].parts[0].text.includes(getChapterExample('數學', '向量內積')));
    });

    test('有 DB 時各章取例，few_shot_ids 排序後進 cacheKeyParts（第 5.2 條）', async () => {
        const db = {
            query: async () => ({
                rows: [
                    { id: 87, chapter: '向量內積', question_text: '題 A' },
                    { id: 12, chapter: '圓方程式', question_text: '題 B' }
                ]
            })
        };
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, db });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.deepEqual(calls[0].cacheKeyParts.fewShotIds, [12, 87]);   // 由小到大
        assert.deepEqual(outcome.data.few_shot_ids, [12, 87]);
        assert.ok(calls[0].parts[0].text.includes('題 A'));
        // 題庫沒有的章由自製例句補上，prompt 才不會只認得那兩章
        assert.ok(calls[0].parts[0].text.includes(getChapterExample('數學', '外積')));
    });

    test('A 層向量 few-shot 只在 ctx.config.features.similar 為真時才走（裁決 S2-8）', async () => {
        const queries = [];
        const db = { query: async (sql) => { queries.push(sql); return { rows: [] }; } };

        // 旗標關閉：不得呼叫 embed（fakeCtx 的 embed 一被叫到就丟錯），只走 B 層那一句 SQL
        const off = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, db, features: {} });
        const outcome = await classify.run(off.ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'pass');
        assert.equal(queries.length, 1);
        assert.ok(!queries[0].includes('<=>'), '旗標關閉時不該下向量查詢');

        // 舊的大寫鍵名（FEATURE_SIMILAR）不再算數——第 3.1 條凍結的是 features.similar
        queries.length = 0;
        const legacyKey = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, db, features: { FEATURE_SIMILAR: true } });
        await classify.run(legacyKey.ctx, { subject: '數學', chapter: null, chapter_confidence: 0, question_text: QUESTION });
        assert.ok(!queries[0].includes('<=>'));
    });

    test('features.similar 為真時走向量最近鄰，few_shot_ids 是鄰居的 id', async () => {
        const queries = [];
        const db = {
            query: async (sql) => {
                queries.push(sql);
                return { rows: [{ id: 87, chapter: '向量內積', question_text: '鄰居題' }] };
            }
        };
        const ctx = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, db, features: { similar: true } }).ctx;
        ctx.llm.embed = async () => ({ vectors: [new Array(768).fill(0.01)], usage: { tokenIn: 1 } });

        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0, question_text: QUESTION
        });
        assert.ok(queries[0].includes('<=>'), '旗標開啟時第一句就該是向量查詢');
        assert.deepEqual(outcome.data.few_shot_ids, [87]);
    });

    test('DB 壞掉不算失敗：退回自製例句繼續跑', async () => {
        const db = { query: async () => { throw new Error('connection refused'); } };
        const { ctx } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' }, db });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(outcome.data.few_shot_ids, []);
    });

    test('cacheKeyParts 的鍵與順序照第 5.2 條', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        await classify.run(ctx, { subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION });
        assert.deepEqual(Object.keys(calls[0].cacheKeyParts), ['template', 'questionText', 'fewShotIds']);
        assert.equal(calls[0].agent, 'classify');
        // 〔決策單 2026-09-26 A5／A7；CR-9〕原為 'classify.v1'：改了指數／對數兩章的例句並補規則 5，
        // 鍵不含例句文字，所以識別名升版讓 classify cassette 全部失效、重錄（docs/chapter-restructure.md CR-9）。
        assert.equal(calls[0].template, 'classify.v2');
        assert.equal(calls[0].cacheKeyParts.template, 'classify.v2');
    });

    test('prompt 只列該科的白名單（物理題不該看到數學章節）', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '電磁感應', confidence: 0.9, rationale: 'r' } });
        await classify.run(ctx, { subject: '物理', chapter: null, chapter_confidence: 0.1, question_text: '線圈磁通量變化' });
        const prompt = calls[0].parts[0].text;
        assert.ok(prompt.includes('電磁感應'));
        // 〔章節重整 CH-A〕原本用「克拉瑪公式」，那已不是章名（拆成一次方程組／面積與行列式），
        // 留著會讓這條斷言恆真；改用重整後的數學章名，意圖不變。
        assert.ok(!prompt.includes('一次方程組'), '物理題的 prompt 不該混進數學章節');
        assert.ok(!prompt.includes('面積與行列式'), '物理題的 prompt 不該混進數學章節');
    });

    test('上一次的 feedback 會進 prompt', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: 'r' } });
        ctx.jq.payload = { classify: { feedback: '「平面向量」不在白名單內，最接近的是「向量內積」「平面方程式」' } };
        await classify.run(ctx, { subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION });
        assert.ok(calls[0].parts[0].text.includes('「平面向量」不在白名單內'));
    });
});

// ───────────────── 〔CR-9〕指數與對數的分冊界線（決策單 A5） ─────────────────
//
// 2026-09-25 以本機模型重錄 classify：錯的 15 題有 8 題是第三冊「指數函數與對數函數」被分成第一冊「指數與對數」。
// 這裡釘住三件事：模板寫明界線、兩章例句本身符合界線、例句不洩漏 golden 題幹（CR-8 的去洩題原則）。

describe('〔CR-9〕指數與對數的分冊界線（決策單 A5）', () => {
    const fs = require('fs');
    const path = require('path');
    const { findNonCommonLogBase } = require('../../config/chapterMigrationRules');
    const FIRST = '指數與對數';
    const THIRD = '指數函數與對數函數';

    function bigramSet(text) {
        const s = String(text || '');
        const set = new Set();
        for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
        return set;
    }
    function dice(a, b) {
        const A = bigramSet(a);
        const B = bigramSet(b);
        let common = 0;
        for (const g of A) if (B.has(g)) common += 1;
        return (2 * common) / (A.size + B.size);
    }
    function mathGolden() {
        const file = path.join(__dirname, '..', '..', 'eval', 'golden', 'classify.json');
        return JSON.parse(fs.readFileSync(file, 'utf8')).entries.filter(e => e.subject === '數學');
    }

    // 〔CR-9 審查〕原為「數學／物理模板寫明兩章的界線」並斷言 classify.PROMPT_TEMPLATE 含這些字：
    // 界線規則已從共用模板移到只給數學看的 SUBJECT_RULES（物理題不該看到數學章名），
    // 同一組字串改對「數學的第 5 條規則」斷言，一條都沒少；共用模板改斷言「不含」。
    test('數學的規則 5 寫明兩章的界線；共用模板與化學模板都不含這條', () => {
        const math = classify.subjectRulesText('數學');
        assert.ok(math.startsWith('5. 冊別依 108 課綱。'), `數學的界線規則要從第 5 條開始：${math.slice(0, 20)}`);
        const rule5 = math.split('\n')[0];
        for (const s of [`第一冊「${FIRST}」`, `第三冊「${THIRD}」`, '以 10 為底的常用對數', '底數不是 10 的對數', '換底公式', '指數或對數方程式']) {
            assert.ok(rule5.includes(s), `數學的規則 5 缺「${s}」`);
        }
        assert.ok(!classify.PROMPT_TEMPLATE.includes(THIRD), '共用模板不該寫死數學的分冊界線');
        assert.ok(!classify.PROMPT_TEMPLATE.includes('底數不是 10 的對數'), '共用模板不該寫死數學的分冊界線');
        assert.ok(!classify.PROMPT_TEMPLATE_CHEM.includes(THIRD), '化學模板不該出現數學的分冊界線');
    });

    test('數學題的 prompt 帶著界線規則，兩章的新例句都進了 few-shot', async () => {
        const { ctx, calls } = fakeCtx({ data: { chapter: THIRD, confidence: 0.9, rationale: 'r' } });
        await classify.run(ctx, { subject: '數學', chapter: null, chapter_confidence: 0, question_text: '求 $\\log_{7} 49$ 的值。' });
        const prompt = calls[0].parts[0].text;
        assert.ok(prompt.includes('底數不是 10 的對數'));
        assert.ok(prompt.includes(`${getChapterExample('數學', FIRST)}\n  章節：${FIRST}`));
        assert.ok(prompt.includes(`${getChapterExample('數學', THIRD)}\n  章節：${THIRD}`));
    });

    test('第一冊例句只用常用對數；第三冊例句示範底數不是 10 的對數、換底與指數方程式', () => {
        const first = getChapterExample('數學', FIRST);
        const third = getChapterExample('數學', THIRD);
        assert.equal(findNonCommonLogBase(first), null, `第一冊例句不該出現底數不是 10 的對數：${first}`);
        assert.ok(first.includes('常用對數') && first.includes('科學記號'), first);
        assert.ok(!first.includes('方程式'), '指數／對數方程式屬第三冊');
        assert.ok(findNonCommonLogBase(third), `第三冊例句要有底數不是 10 的對數：${third}`);
        assert.ok(third.includes('換底公式') && third.includes('指數方程式'), third);
        assert.ok(!/函數|圖形/.test(third), '第三冊例句刻意示範「不含函數／圖形字樣的計算題」也屬第三冊');
    });

    test('兩章例句不洩漏 golden 題幹（CR-8 去洩題）', () => {
        const golden = mathGolden();
        assert.ok(golden.length > 0);
        // 量尺自我檢查：CR-8 判為洩題而換掉的舊第一冊例句，對 golden 的 bigram Dice 最高約 0.59
        const leaked = '已知 $\\log 2 \\approx 0.3010$，利用常用對數估計 $3^{20}$ 是幾位數。';
        assert.ok(Math.max(...golden.map(e => dice(leaked, e.question_text))) >= 0.5, '量尺抓不到已知的洩題例句');
        for (const chapter of [FIRST, THIRD]) {
            const example = getChapterExample('數學', chapter);
            const segments = (example.match(/\$[^$]+\$/g) || []).filter(s => s.length >= 6);
            for (const e of golden) {
                assert.ok(dice(example, e.question_text) < 0.5, `${chapter} 的例句與 ${e.id} 太像`);
                for (const seg of segments) assert.ok(!e.question_text.includes(seg), `${chapter} 的例句含 ${e.id} 的算式 ${seg}`);
            }
        }
    });
});

// ───────────────── 〔CR-9 審查〕界線規則只給該科看 ─────────────────
//
// 規則 5 原本寫在數學與物理共用的 PROMPT_TEMPLATE，物理題也會看到「指數函數與對數函數」。
// 改成模板只留 {{SUBJECT_RULES}} 占位，由 classify.js 依科目填入該科的規則（agents/classify.js 的 SUBJECT_RULES）。
// 同時補上已有書面原則的界線：數學 6（平面／空間向量內積，章名本身的定義）、
// 物理 5～7（eval/CHAPTER_RELABEL-2026-09.md 第 8.0 節）。

describe('〔CR-9 審查〕界線規則只給該科看', () => {
    const fs = require('fs');
    const path = require('path');
    const { isValidChapter } = require('../../config/chapters');
    const { sha256Hex } = require('../../services/llm/templates');

    async function promptFor(subject, questionText) {
        const { ctx, calls } = fakeCtx({ data: { chapter: CHAPTERS[subject][0], confidence: 0.9, rationale: 'r' } });
        await classify.run(ctx, { subject, chapter: null, chapter_confidence: 0, question_text: questionText });
        assert.equal(calls.length, 1);
        return calls[0].parts[0].text;
    }

    /** 兩段文字最長的共同子字串（逐字；給去洩題檢查用） */
    function longestCommon(a, b) {
        let best = '';
        for (let i = 0; i < a.length; i++) {
            for (let j = i + best.length + 1; j <= a.length; j++) {
                if (b.includes(a.slice(i, j))) best = a.slice(i, j);
                else break;
            }
        }
        return best;
    }

    test('共用模板只留占位：不含任何一科的章名界線', () => {
        const t = classify.PROMPT_TEMPLATE;
        assert.ok(t.includes('\n{{SUBJECT_RULES}}\n'), '模板要有獨立一行的 {{SUBJECT_RULES}} 占位');
        assert.ok(t.includes('\n4. confidence'), '共用規則是 1～4，各科規則從 5 接下去');
        assert.ok(!/\n5\. /.test(t), '共用模板不該再寫死第 5 條');
        for (const subject of ['數學', '物理']) {
            for (const rule of classify.SUBJECT_RULES[subject]) {
                assert.ok(!t.includes(rule), `共用模板不該含${subject}的界線規則：${rule.slice(0, 20)}…`);
            }
        }
        assert.ok(!classify.PROMPT_TEMPLATE_CHEM.includes('{{SUBJECT_RULES}}'), '化學模板（classify_chem.v1）逐字不變，沒有這個占位');
    });

    // 〔重練與收尾決策單 2026-09-26 K2〕原標題「…帶著物理自己的規則 5～7」、條數 3：K2 補了第 8 條，條數改 4（仍是精確值）
    test('物理題的 prompt 不含數學的界線規則與章名，帶著物理自己的規則 5～8', async () => {
        const prompt = await promptFor('物理', '一顆球在水平面上滾動，求它的動能。');
        for (const s of ['指數函數與對數函數', '指數與對數', '底數不是 10 的對數', '空間向量內積', '冊別依 108 課綱']) {
            assert.ok(!prompt.includes(s), `物理題的 prompt 不該出現「${s}」`);
        }
        const rules = classify.subjectRulesText('物理').split('\n');
        assert.equal(rules.length, 4);
        rules.forEach((rule, i) => {
            assert.ok(rule.startsWith(`${5 + i}. `), rule);
            assert.ok(prompt.includes(`\n${rule}\n`), `物理題的 prompt 缺第 ${5 + i} 條`);
        });
        assert.ok(!prompt.includes('{{SUBJECT_RULES}}'));
    });

    test('數學題的 prompt 含規則 5（指數與對數的分冊界線）與規則 6（平面／空間向量內積），不含物理的規則', async () => {
        const prompt = await promptFor('數學', '已知兩向量的坐標，求它們的內積。');
        const rules = classify.subjectRulesText('數學').split('\n');
        // 〔重練與收尾決策單 2026-09-26 K3〕原為 2 條、只檢查 5、6 緊接：K3 補了第 7 條（內容另見下方 K2／K3 的測試）
        assert.equal(rules.length, 3);
        assert.ok(prompt.includes(`\n4. confidence`) && prompt.includes(`\n${rules[0]}\n${rules[1]}\n${rules[2]}\n`), '數學的規則 5、6、7 要緊接在共用規則 4 後面');
        assert.ok(rules[0].startsWith('5. ') && rules[0].includes('第三冊「指數函數與對數函數」'));
        assert.ok(rules[1].startsWith('6. ') && rules[1].includes('第三冊「向量內積」') && rules[1].includes('第四冊「空間向量內積」'));
        assert.ok(rules[1].includes('二維') && rules[1].includes('三維'), '平面與空間的分別要寫出維度');
        for (const s of ['摩擦力與向心力', '電場與電位', '直線運動', '庫侖定律']) {
            assert.ok(!prompt.includes(s), `數學題的 prompt 不該出現物理的「${s}」`);
        }
        assert.ok(!prompt.includes('{{SUBJECT_RULES}}'));
    });

    test('物理的三條規則照第 8.0 節：必修／直線運動、平面運動／摩擦力與向心力、靜電學／電場與電位', () => {
        const [r5, r6, r7] = classify.SUBJECT_RULES['物理'];
        assert.ok(/「物體的運動（速度與加速度）」.*定性說明.*「直線運動」/.test(r5) && r5.includes('等加速度公式') && r5.includes('從圖求數值'), r5);
        assert.ok(r6.includes('向心加速度') && r6.includes('歸「平面運動」') && r6.includes('向心力、張力或摩擦力') && r6.includes('歸「摩擦力與向心力」'), r6);
        assert.ok(r7.includes('兩個電荷之間的力') && r7.includes('歸「靜電學」') && r7.includes('等位面') && r7.includes('歸「電場與電位」'), r7);
        // 第 8.0 節沒有涵蓋直線運動／平面運動的分界（CHAPTER_RELABEL 第 8.6 節第 3 點，待 Owner）：不得自己發明。
        // 下面兩組「不含」是在記錄「還沒有書面原則」；Owner 定了原則、寫進 SUBJECT_RULES 時連同這裡一起改。
        // 〔重練與收尾決策單 2026-09-26 K2／K3〕Owner 已定這兩組原則（K2、K3 都選 1），照上一行「連同這裡一起改」：
        //   原本對「全部規則」斷言不含，改成對第 8.0 節的三條（物理 r5～r7）與原有的數學兩條斷言不含——這幾條仍不得碰這兩組分界；
        //   兩組分界各只能由 Owner 定的那一條寫（物理第 8 條＝K2、數學第 7 條＝K3），多寫或寫到別條都會紅燈。
        for (const rule of [r5, r6, r7]) {
            assert.ok(!(rule.includes('「直線運動」') && rule.includes('「平面運動」')), `第 8.0 節的規則不該涉及直線運動／平面運動的分界：${rule}`);
            assert.ok(!rule.includes('相對'), `第 8.0 節的規則不該涉及相對運動／相對速度：${rule}`);
        }
        const physK2 = classify.SUBJECT_RULES['物理'].filter(rule => rule.includes('「直線運動」') && rule.includes('「平面運動」'));
        assert.deepEqual(physK2, [classify.SUBJECT_RULES['物理'][3]], '直線運動／平面運動的分界只由 K2（物理第 8 條）寫');
        const physRelative = classify.SUBJECT_RULES['物理'].filter(rule => rule.includes('相對'));
        assert.deepEqual(physRelative, [classify.SUBJECT_RULES['物理'][3]], '相對速度的歸屬只由 K2（物理第 8 條）寫');
        const mathK3 = classify.SUBJECT_RULES['數學'].filter(rule => rule.includes('三角函數的疊合') || rule.includes('直角三角形的邊角關係'));
        assert.deepEqual(mathK3, [classify.SUBJECT_RULES['數學'][2]], '直角三角形的邊角關係／三角函數的疊合只由 K3（數學第 7 條）寫');
    });

    test('規則裡「」括起來的都是該科的章名（打錯字或跨科會紅燈），每條只寫一句', () => {
        for (const subject of ['數學', '物理']) {
            const other = subject === '數學' ? '物理' : '數學';
            for (const rule of classify.SUBJECT_RULES[subject]) {
                const quoted = [...rule.matchAll(/「([^」]+)」/g)].map(m => m[1]);
                assert.ok(quoted.length >= 2, `每條界線至少要點名兩章：${rule}`);
                for (const name of quoted) {
                    assert.ok(isValidChapter(subject, name), `「${name}」不是${subject}的章名`);
                    assert.ok(!isValidChapter(other, name), `「${name}」也是${other}的章名`);
                }
                // 數學規則 5 沿用 CR-9 的原文（前面兩句是前言），其餘每條一句
                if (!rule.startsWith('冊別依 108 課綱。')) {
                    assert.equal((rule.match(/。/g) || []).length, 1, `一條規則一句：${rule}`);
                    assert.ok(rule.endsWith('。'), rule);
                }
                assert.ok(!rule.includes('$'), '界線規則不用 LaTeX');
            }
        }
        assert.equal(classify.subjectRulesText('化學'), '', '化學沒有界線規則（走 classify_chem.v1，模板逐字不變）');
        assert.equal(classify.subjectRulesText('不存在的科目'), '');
        assert.equal(classify.subjectRulesText('constructor'), '', '只認自己的鍵，不讀原型鏈');
    });

    test('沒有界線規則的科目：占位連同換行一起拿掉，不留空行', () => {
        const filled = classify.fillSubjectRules(classify.PROMPT_TEMPLATE, '化學');
        assert.ok(!filled.includes('{{SUBJECT_RULES}}'));
        assert.ok(filled.includes('便宜得多。\n\n{{FEW_SHOT}}'), '規則 4 後面直接接原本的空行與 few-shot');
        assert.equal(classify.fillSubjectRules(classify.PROMPT_TEMPLATE_CHEM, '化學'), classify.PROMPT_TEMPLATE_CHEM, '化學模板原樣回傳');
    });

    test('界線規則不洩漏 golden 題幹（不為特定題寫死文字）', () => {
        const file = path.join(__dirname, '..', '..', 'eval', 'golden', 'classify.json');
        const golden = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
        const LIMIT = 8;
        // 量尺自我檢查：規則若抄進一段題幹，一定抓得到
        const sample = golden.find(e => e.subject === '物理');
        assert.ok(longestCommon(`規則${sample.question_text.slice(0, LIMIT)}`, sample.question_text).length >= LIMIT, '量尺抓不到抄進去的題幹');
        for (const subject of ['數學', '物理']) {
            for (const rule of classify.SUBJECT_RULES[subject]) {
                // 章名本身不算洩題（題幹可能正好提到章名）：先把該科章名挖掉再比
                const stripped = CHAPTERS[subject].reduce((s, name) => s.split(name).join('｜'), rule);
                for (const e of golden) {
                    const common = longestCommon(stripped, e.question_text);
                    assert.ok(common.length < LIMIT, `${subject}的規則與 ${e.id} 共用了一段 ${common.length} 字的文字：「${common}」`);
                }
            }
        }
    });

    test('界線規則改了要升版：規則文字的雜湊與模板識別名一起釘住', () => {
        // 規則文字不進 cassette 的鍵（templates.js 註冊的是挖空後的模板；第 5.2 條的 cacheKeyParts 也沒有它），
        // 只改規則不升版的話，回放會拿到用舊規則錄的答案。所以改了 SUBJECT_RULES 就要：
        //   ① 把 agents/classify.js 的 TEMPLATE 版號 +1（數學＋物理的 classify cassette 全部重錄，docs/llm.md）；
        //   ② 再把這裡改成新版號與新雜湊。只改雜湊、不升版，等於讓回放拿舊答案。
        // 〔重練與收尾決策單 2026-09-26〕上面第一句已不成立：SUBJECT_RULES 已併進註冊的模板文字（REGISTERED_TEMPLATE），
        //   改規則鍵會自己變，回放是 miss、不會拿到舊答案（見下方 K2／K3 的測試）。這條照審查意見保留，當作升版的提醒；
        //   K2（物理 8）、K3（數學 7）是在 v2 發布前補的（v2 還沒有任何 cassette），所以版號不動、只更新雜湊。
        //   原雜湊（K2／K3 之前）：19640b2fe610087a64de3759a559b31b45e0eb15ce3dcc6b606f10b85ab461d8
        const PINNED = { template: 'classify.v2', sha256: '3c955ba3930303614c9c9ba1447faee78b59010377c9717d3cbf59ae391764d4' };
        assert.deepEqual(
            { template: classify.TEMPLATE, sha256: sha256Hex(JSON.stringify(classify.SUBJECT_RULES)) },
            PINNED,
            '界線規則或識別名變了：改規則要把 classify.vN 的版號 +1，再更新這裡');
    });
});

// ───────────────── 〔重練與收尾決策單 2026-09-26〕K2／K3、規則進註冊模板、複數的幾何意涵例句 ─────────────────
//
// K2 選 1（物理 8）：同一直線上（一維）的運動，含一維相對速度 → 直線運動；要用向量分解或二維才解得出 → 平面運動。
// K3 選 1（數學 7）：只用到銳角與平方、商數、餘角關係 → 直角三角形的邊角關係（第二冊）；
//                    化成 r sin(x＋φ) 的疊合才歸三角函數的疊合（第三冊）。
// 審查意見：SUBJECT_RULES（序列化）併進註冊的模板文字，改規則就會改 cassette 的鍵。
// M15：「複數的幾何意涵」不教極式、棣美弗定理、n 次方根，例句改成乘法對應的旋轉與伸縮。

describe('〔重練與收尾決策單 2026-09-26〕K2／K3 的界線規則與註冊模板', () => {
    const fs = require('fs');
    const path = require('path');
    const { getTemplate, templateHash, sha256Hex } = require('../../services/llm/templates');

    async function promptFor(subject, questionText) {
        const { ctx, calls } = fakeCtx({ data: { chapter: CHAPTERS[subject][0], confidence: 0.9, rationale: 'r' } });
        await classify.run(ctx, { subject, chapter: null, chapter_confidence: 0, question_text: questionText });
        assert.equal(calls.length, 1);
        return calls[0].parts[0].text;
    }

    test('K2：物理題的 prompt 含第 8 條（一維含相對速度歸直線運動；向量分解或二維歸平面運動）', async () => {
        const prompt = await promptFor('物理', '兩人在同一條直線跑道上相向而跑，求甲相對於乙的速度。');
        const rules = classify.subjectRulesText('物理').split('\n');
        const r8 = rules[3];
        assert.ok(r8.startsWith('8. 「直線運動」與「平面運動」：'), r8);
        for (const s of ['同一直線上', '一維', '相對速度', '歸「直線運動」', '向量分解', '二維', '歸「平面運動」']) {
            assert.ok(r8.includes(s), `K2 的規則缺「${s}」：${r8}`);
        }
        // 一維（含相對速度）在前、向量分解或二維在後，分別對到直線運動、平面運動
        assert.ok(r8.indexOf('相對速度') < r8.indexOf('歸「直線運動」'), r8);
        assert.ok(r8.indexOf('歸「直線運動」') < r8.indexOf('向量分解'), r8);
        assert.ok(r8.indexOf('向量分解') < r8.indexOf('歸「平面運動」'), r8);
        assert.ok(prompt.includes(`\n${rules[2]}\n${r8}\n`), '第 8 條要緊接在第 7 條後面');
    });

    test('K3：數學題的 prompt 含第 7 條（銳角與平方、商數、餘角關係歸第二冊；r sin(x＋φ) 的疊合歸第三冊）', async () => {
        const prompt = await promptFor('數學', '已知銳角的一個三角比，求另外兩個三角比。');
        const rules = classify.subjectRulesText('數學').split('\n');
        const r7 = rules[2];
        assert.ok(r7.startsWith('7. '), r7);
        for (const s of ['銳角', '平方、商數、餘角關係', '第二冊「直角三角形的邊角關係」', 'r sin(x＋φ)', '疊合', '第三冊「三角函數的疊合」']) {
            assert.ok(r7.includes(s), `K3 的規則缺「${s}」：${r7}`);
        }
        assert.ok(r7.indexOf('銳角') < r7.indexOf('「直角三角形的邊角關係」'), r7);
        assert.ok(r7.indexOf('r sin(x＋φ)') < r7.indexOf('「三角函數的疊合」'), r7);
        assert.ok(prompt.includes(`\n${rules[1]}\n${r7}\n`), '第 7 條要緊接在第 6 條後面');
        // 數學題看不到物理的 K2
        assert.ok(!prompt.includes(classify.SUBJECT_RULES['物理'][3]), '數學題的 prompt 不該出現物理的 K2 規則');
        assert.ok(!prompt.includes('平面運動'), '數學題的 prompt 不該出現物理章名');
    });

    test('物理題的 prompt 仍不含數學章名（K2／K3 加了規則之後）', async () => {
        // 共用模板的規則 2 早就用「向量內積」當舉例（CR-9 之前就有，不是界線規則；物理題也看得到）。
        // 這條測試管的是「各科界線規則不把數學章名帶進物理題」，所以先把共用模板裡已有的章名列出來、精確釘住，其餘一律不得出現。
        const inShared = CHAPTERS['數學'].filter(name => classify.PROMPT_TEMPLATE.includes(name));
        assert.deepEqual(inShared, ['向量內積'], '共用模板裡的數學章名變了：請確認是不是把數學的內容寫進了共用模板');
        const physRules = classify.subjectRulesText('物理');
        for (const name of CHAPTERS['數學']) {
            assert.ok(!physRules.includes(name), `物理的界線規則不該出現數學章名「${name}」`);
        }
        for (const question of ['兩人在同一條直線跑道上相向而跑，求甲相對於乙的速度。', '一顆球在水平面上滾動，求它的動能。']) {
            const prompt = await promptFor('物理', question);
            for (const name of CHAPTERS['數學']) {
                if (inShared.includes(name)) continue;
                assert.ok(!prompt.includes(name), `物理題的 prompt 不該出現數學章名「${name}」`);
            }
            assert.ok(!prompt.includes(classify.SUBJECT_RULES['數學'][2]), '物理題的 prompt 不該出現數學的 K3 規則');
            assert.ok(!prompt.includes('r sin(x＋φ)'));
        }
    });

    test('註冊的模板文字＝PROMPT_TEMPLATE＋「\\n---\\n」＋序列化的 SUBJECT_RULES（改規則就改 cassette 的鍵）', () => {
        const expected = `${classify.PROMPT_TEMPLATE}\n---\n${JSON.stringify(classify.SUBJECT_RULES)}`;
        assert.equal(classify.REGISTERED_TEMPLATE, expected);
        assert.equal(getTemplate(classify.TEMPLATE), expected);
        assert.equal(templateHash(classify.TEMPLATE), sha256Hex(expected));
        // 挖空後的模板本身不再等於註冊內容：只雜湊 PROMPT_TEMPLATE 的話，規則改了鍵不會變
        assert.notEqual(templateHash(classify.TEMPLATE), sha256Hex(classify.PROMPT_TEMPLATE));
        // 序列化可以還原成同一份規則（兩科、每一條都在）
        const [template, rulesJson, ...rest] = getTemplate(classify.TEMPLATE).split('\n---\n');
        assert.equal(rest.length, 0, 'PROMPT_TEMPLATE 與規則裡都不該再出現分隔符');
        assert.equal(template, classify.PROMPT_TEMPLATE);
        assert.deepEqual(JSON.parse(rulesJson), classify.SUBJECT_RULES);
        // 改任何一條規則（即使只改一個字），註冊內容的雜湊都會變
        for (const subject of ['數學', '物理']) {
            classify.SUBJECT_RULES[subject].forEach((rule, i) => {
                const altered = { ...classify.SUBJECT_RULES, [subject]: classify.SUBJECT_RULES[subject].map((r, j) => (j === i ? `${r.slice(0, -1)}！` : r)) };
                assert.notEqual(sha256Hex(`${classify.PROMPT_TEMPLATE}\n---\n${JSON.stringify(altered)}`), templateHash(classify.TEMPLATE), `${subject}第 ${5 + i} 條`);
            });
        }
        // 化學的註冊內容不受影響（classify_chem.v1 逐字不變）
        assert.equal(getTemplate(classify.TEMPLATE_CHEM), `${classify.SYSTEM_CHEM}\n---\n${classify.PROMPT_TEMPLATE_CHEM}`);
    });

    test('送給模型的 prompt 不變：規則仍只填該科的、不帶序列化的 JSON 與分隔符', async () => {
        for (const subject of ['數學', '物理']) {
            const prompt = await promptFor(subject, '請判斷這一題的章節。');
            assert.ok(!prompt.includes('\n---\n'), `${subject}題的 prompt 不該帶註冊用的分隔符`);
            assert.ok(!prompt.includes(JSON.stringify(classify.SUBJECT_RULES)), `${subject}題的 prompt 不該帶序列化的規則`);
            assert.ok(prompt.includes(`\n${classify.subjectRulesText(subject)}\n`), `${subject}題的 prompt 要有該科的規則`);
        }
    });

    test('M15：「複數的幾何意涵」的例句只用複數平面與乘法的幾何意義，不含極式、棣美弗定理、n 次方根，也不洩漏 golden 題幹', () => {
        const CHAPTER = '複數的幾何意涵';
        const example = getChapterExample('數學', CHAPTER);
        for (const s of ['棣美弗', '極式', '次方根', 'cis', '\\cos', '\\sin', '^']) {
            assert.ok(!example.includes(s), `例句超出 M15 的範圍（「${s}」）：${example}`);
        }
        assert.ok(example.includes('複數平面') && example.includes('旋轉') && example.includes('伸縮'), example);
        // 與〔CR-9〕兩章例句同一套去洩題檢查：bigram Dice < 0.5，6 字以上的算式不得逐字出現在 golden
        function bigramSet(text) {
            const set = new Set();
            for (let i = 0; i + 1 < text.length; i++) set.add(text.slice(i, i + 2));
            return set;
        }
        function dice(a, b) {
            const A = bigramSet(String(a));
            const B = bigramSet(String(b));
            let common = 0;
            for (const g of A) if (B.has(g)) common += 1;
            return (2 * common) / (A.size + B.size);
        }
        const file = path.join(__dirname, '..', '..', 'eval', 'golden', 'classify.json');
        const golden = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
        assert.ok(golden.length > 0);
        const segments = (example.match(/\$[^$]+\$/g) || []).filter(s => s.length >= 6);
        for (const e of golden) {
            assert.ok(dice(example, e.question_text) < 0.5, `${CHAPTER} 的例句與 ${e.id} 太像`);
            for (const seg of segments) assert.ok(!e.question_text.includes(seg), `${CHAPTER} 的例句含 ${e.id} 的算式 ${seg}`);
        }
    });
});

// ───────────────────────── 輸出閘門 ─────────────────────────

describe('輸出必須再過一次 isValidChapter', () => {
    // 〔章節重整 CH-A〕enum 由 66 變 86 個（數學 52＋物理 34）。模型回的物理章節由「電磁感應」改成「靜電學」：
    // 重整後的數學章名出現了「應用」（多項式的運算與應用、矩陣的應用），和「電磁感應」共用一個「應」字，
    // 相似度不再是 0，就測不到下面註解說的「落回宣告順序」。「靜電學」與 52 個數學章名沒有任何共同字。
    test('跨科錯配（enum 是兩科合併的 86 個）被伺服器端擋下', async () => {
        const { ctx } = fakeCtx({ data: { chapter: '靜電學', confidence: 0.95, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'chapter_invalid');
        // 跨科時所有數學章節的相似度都是 0，候選就落回宣告順序的前兩章——
        // feedback 的格式是凍結的（第 3.3 條），沒有位置可以說「這是物理的章節」。
        assert.equal(outcome.feedback, '「靜電學」不在白名單內，最接近的是「實數」「絕對值」');
        assert.equal(outcome.data.source, 'llm');
    });

    test('完全不在白名單的字串也擋下', async () => {
        const { ctx } = fakeCtx({ data: { chapter: '平面向量', confidence: 0.99, rationale: 'r' } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.reason, 'chapter_invalid');
        assert.match(outcome.feedback, /^「平面向量」不在白名單內，最接近的是/);
    });

    test('rationale 超過 200 字會被截斷（不讓「話多」變成整題失敗）', async () => {
        const { ctx } = fakeCtx({ data: { chapter: '向量內積', confidence: 0.9, rationale: '很長'.repeat(300) } });
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.data.rationale.length, 200);
        assert.ok(outcome.data.rationale.endsWith('…'));
    });
});

// ───────────────────────── 輸入防呆與錯誤 ─────────────────────────

describe('輸入防呆', () => {
    test('學科不在白名單 → fail(chapter_invalid)，不呼叫 LLM', async () => {
        const { ctx, calls } = fakeCtx({ data: {} });
        // 〔stage5 WS-B〕化學自 DEC-019 起是合法科目（正向測試見 test/unit/chemistryAgents.test.js），
        // 白名單外的科目改用「生物」驗證同一條拒絕路徑（docs/interfaces-stage5.md 第 1.6、4.2 條第 5 點）。
        const outcome = await classify.run(ctx, { subject: '生物', question_text: QUESTION });
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'chapter_invalid');
        assert.match(outcome.feedback, /只接受「數學」「物理」/);
        assert.equal(calls.length, 0);
    });

    test('question_text 是空的 → fail(schema_invalid)', async () => {
        const { ctx } = fakeCtx({ data: {} });
        const outcome = await classify.run(ctx, { subject: '數學', question_text: '   ' });
        assert.equal(outcome.reason, 'schema_invalid');
    });

    test('llm 丟錯 → {kind:error}，agent 自己不 throw', async () => {
        const ctx = {
            llm: { generateJson: async () => { const e = new Error('逾時'); e.errorClass = 'timeout'; throw e; } },
            logger: console, config: { models: {}, thresholds: {} }, jq: null, db: null
        };
        const outcome = await classify.run(ctx, {
            subject: '數學', chapter: null, chapter_confidence: 0.1, question_text: QUESTION
        });
        assert.equal(outcome.kind, 'error');
        assert.equal(outcome.errorClass, 'timeout');
    });
});
