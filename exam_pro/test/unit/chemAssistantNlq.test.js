// 助教與 NLQ 的 LLM 路徑加上化學（〔Owner 決策單 2026-09-25 B5〕；原裁決 S5-13 維持不支援，Owner 改判支援並接受重錄）
//
// 釘住的東西：
//   - NLQ 規則路徑：化學章節本名／別名＋難度＋題型＋「沒寫過」照樣在規則層解析完，不呼叫 LLM；
//     規則層的化學科目推定（chemistrySubjectPrior）：只有化學線索、或明確點名化學，數理句子不受影響；
//   - NLQ 的 LLM 輔路徑（nlq.v2）：模板升版、註冊字串含 SYSTEM、白名單與 schema 的值域是三科（含化學 44 章）、
//     LLM 給的化學章節被採用、非法章名（打錯、跨科）仍被伺服器端擋下、LLM 空手或失敗時化學推定當退路；
//   - 數學／物理句子的行為不變（沒有化學推定、LLM 空手時 subject 仍為 null）；
//   - 助教（assistant.v2）：工具說明書的科目由 SUBJECTS 產生、preview_paper 的章節改驗白名單（非法章名給候選）、
//     模板升版且註冊字串含 SYSTEM（說明書一改 cassette 鍵就變）。
// 純單元測試：不連 DB、不連 LLM（全部用注入的假 llm）。執行：npm test

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { CHAPTERS, SUBJECTS, isValidChapter } = require('../../config/chapters');
const { CHEMISTRY_CHAPTERS } = require('../../config/chemistryChapters');
const { CHAPTER_ALIASES } = require('../../config/chapterAliases');
const { buildSchema, ENUM_SOURCES, GROUP_ENUM_SOURCES } = require('../../agents/schemas');
const { getTemplate } = require('../../services/llm/templates');
const { cassetteKey } = require('../../services/llm/cassette');
const {
    parseQuery, namesChemistry, chemistrySubjectPrior, isChemistryOnlyQuery
} = require('../../utils/nlqHeuristics');
const { MATH_PHYSICS_TERMS } = require('../../utils/tokenize');
const nlq = require('../../services/nlqService');
const assistant = require('../../services/assistantService');
const audit = require('../../eval/lib/cassetteAudit');

const ALL_CHAPTERS = SUBJECTS.flatMap(s => CHAPTERS[s]);

/** 假 llm：記下每次 generateJson 的參數，回傳排好的 data（或丟錯） */
function fakeLlm(respond) {
    const calls = [];
    return {
        calls,
        async generateJson(opts) {
            calls.push(opts);
            const out = typeof respond === 'function' ? respond(opts) : respond;
            if (out instanceof Error) throw out;
            return { data: out, usage: {}, latencyMs: 0 };
        }
    };
}

const EMPTY = { chapters: [], question_types: [], semantic_text: '', keywords: [] };

// ───────────────────────── NLQ：規則路徑 ─────────────────────────

describe('NLQ 規則路徑認得化學（不呼叫 LLM）', () => {
    beforeEach(() => nlq._resetCacheForTest());

    test('化學別名＋題型＋難度區間＋「沒寫過」一起在規則層解析', () => {
        const r = parseQuery('勒沙特列的計算題，難度 3~5，小明沒寫過', { aliases: CHAPTER_ALIASES });
        assert.equal(r.confident, true);
        assert.equal(r.filters.subject, '化學');
        assert.deepEqual(r.filters.chapters, ['勒沙特列原理']);
        assert.deepEqual(r.filters.question_types, ['計算']);
        assert.equal(r.filters.difficulty_min, 3);
        assert.equal(r.filters.difficulty_max, 5);
        assert.equal(r.filters.exclude_student_name, '小明');
        assert.equal(r.semantic_text, '勒沙特列');
    });

    test('化學章節本名（含「pH值」「碰撞學說與催化」）與別名（Ksp）：parseOnly 一次 LLM 都不呼叫', async () => {
        const cases = [
            ['酸鹼解離與pH值 單選題', ['酸鹼解離與pH值'], ['單選']],
            ['碰撞學說與催化 多選題', ['碰撞學說與催化'], ['多選']],
            ['Ksp 的題目', ['溶解平衡與溶度積'], []],
            ['緩衝溶液的計算題', ['緩衝溶液'], ['計算']]      // 助教 search_questions 說明書裡的化學例句
        ];
        for (const [query, chapters, types] of cases) {
            const llm = fakeLlm(EMPTY);
            const r = await nlq.parseOnly({ query, llm, noCache: true });
            assert.equal(llm.calls.length, 0, query);
            assert.equal(r.parse_path, 'rules', query);
            assert.equal(r.filters.subject, '化學', query);
            assert.deepEqual(r.filters.chapters, chapters, query);
            assert.deepEqual(r.filters.question_types, types, query);
        }
    });

    test('namesChemistry：點名化學才算；「化學能」不算；同時點名數學／物理不算', () => {
        assert.equal(namesChemistry('化學 溶液的密度怎麼算'), true);
        assert.equal(namesChemistry('有沒有化學的難題'), true);
        assert.equal(namesChemistry('化學能轉換成電能'), false, '化學能是物理的能量形式');
        assert.equal(namesChemistry('化學能與化學平衡'), true, '挖掉「化學能」之後仍點名化學');
        assert.equal(namesChemistry('化學和物理的綜合題'), false);
        assert.equal(namesChemistry('數學的溶液混合濃度應用題'), false);
        assert.equal(namesChemistry('斜面上物體受力平衡的題目'), false);
    });

    test('chemistrySubjectPrior：只有化學線索，或明確點名化學；有數理線索且沒點名化學 → false', () => {
        const opts = { mathPhysicsTerms: MATH_PHYSICS_TERMS };
        assert.equal(chemistrySubjectPrior('有沒有化學的難題', opts), true);
        assert.equal(chemistrySubjectPrior('哪些離子會產生沉澱', opts), true);
        // 「密度」是數理名詞：只有 isChemistryOnlyQuery 時是 false，點名化學之後推定為化學
        assert.equal(isChemistryOnlyQuery('化學 溶液的密度怎麼算', opts), false);
        assert.equal(chemistrySubjectPrior('化學 溶液的密度怎麼算', opts), true);
        for (const q of ['溶液的密度怎麼算', '物理 濃度梯度造成的擴散', '數學的溶液混合濃度應用題', '化學能轉換成電能', '核反應式的題目']) {
            assert.equal(chemistrySubjectPrior(q, opts), false, q);
        }
    });
});

// ───────────────────────── NLQ：LLM 輔路徑（nlq.v2） ─────────────────────────

describe('NLQ 的 LLM 輔路徑（nlq.v2）支援化學', () => {
    beforeEach(() => nlq._resetCacheForTest());

    test('模板升版為 nlq.v2，註冊字串 = SYSTEM + ---- + 模板；nlq.v1 不再註冊', () => {
        assert.equal(nlq.TEMPLATE, 'nlq.v2');
        assert.equal(getTemplate('nlq.v2'), `${nlq.SYSTEM}\n---\n${nlq.PROMPT_TEMPLATE}`);
        assert.equal(getTemplate('nlq.v1'), null, 'nlq.v1 的 cassette 鍵不得再被算出來');
        assert.match(nlq.SYSTEM, /化學/);
        assert.match(nlq.PROMPT_TEMPLATE, /「」/, '模板要交代化學章名的「」輸出時拿掉');
    });

    test('schema：subject 三科、chapters 是三科全部章節（依 SUBJECTS 順序），其他 schema 的值域不變', () => {
        const schema = buildSchema('nlq');
        assert.deepEqual(schema.properties.subject.enum, ['數學', '物理', '化學']);
        assert.deepEqual(schema.properties.chapters.items.enum, ALL_CHAPTERS);
        assert.equal(schema.properties.chapters.items.enum.length, CHAPTERS['數學'].length + CHAPTERS['物理'].length + 44);
        for (const c of CHEMISTRY_CHAPTERS) assert.ok(schema.properties.chapters.items.enum.includes(c), c);
        assert.match(schema.title, /^nlq\.v2/);
        // 新增的是新鍵：subject／chapter 的值域（extract／classify／variant 用的）逐字不變
        assert.deepEqual(ENUM_SOURCES.subject, ['數學', '物理']);
        assert.deepEqual(ENUM_SOURCES.subject_all, SUBJECTS);
        assert.deepEqual(ENUM_SOURCES.chapter_all, ALL_CHAPTERS);
        assert.deepEqual(buildSchema('extract').properties.questions.items.properties.subject.enum, ['數學', '物理']);
        assert.deepEqual(buildSchema('classify').properties.chapter.enum, ENUM_SOURCES.chapter);
        assert.equal(GROUP_ENUM_SOURCES.math_physics, ENUM_SOURCES);
        assert.equal(buildSchema('nlq', { group: 'math_physics' }), schema, '同一個凍結實例');
    });

    test('送出的請求：agent=nlq、template=nlq.v2、schema 就是 buildSchema(nlq)、prompt 含化學白名單、cacheKeyParts 帶新版號', async () => {
        const llm = fakeLlm(EMPTY);
        await nlq.parseOnly({ query: '水的沸點為什麼比硫化氫高', llm, noCache: true });
        assert.equal(llm.calls.length, 1);
        const call = llm.calls[0];
        assert.equal(call.agent, 'nlq');
        assert.equal(call.template, 'nlq.v2');
        assert.equal(call.system, nlq.SYSTEM);
        assert.equal(call.schema, buildSchema('nlq'));
        assert.deepEqual(call.cacheKeyParts, { template: 'nlq.v2', query: '水的沸點為什麼比硫化氫高' });
        const prompt = call.parts[0].text;
        assert.ok(prompt.includes('化學：「物質的分類與分離」'), '化學一行、每章加「」');
        assert.ok(prompt.includes('「醇、酚、醚」'));
        assert.ok(prompt.includes(`數學：${CHAPTERS['數學'].join('、')}`), '數學一行與 nlq.v1 相同');
        assert.ok(!prompt.includes('{{'), '佔位符都要換掉');
    });

    test('cassette 鍵：同一句話在 nlq.v2 與舊識別名下不同（舊 cassette 自然失效）', () => {
        const base = { agent: 'nlq', modelId: 'qwen3:8b', schema: buildSchema('nlq') };
        const v2 = cassetteKey({ ...base, template: 'nlq.v2', cacheKeyParts: { template: 'nlq.v2', query: 'q' } });
        const v1 = cassetteKey({ ...base, template: 'nlq.v1', cacheKeyParts: { template: 'nlq.v1', query: 'q' } });
        assert.notEqual(v1, v2);
    });

    test('沒有化學線索的化學句子：LLM 給的化學科目與章節被採用', async () => {
        const llm = fakeLlm({ subject: '化學', chapters: ['分子極性與分子間作用力'], question_types: [], semantic_text: '沸點 氫鍵', keywords: ['沸點'] });
        const r = await nlq.parseOnly({ query: '水的沸點為什麼比硫化氫高', llm, noCache: true });
        assert.equal(r.parse_path, 'llm');
        assert.equal(r.filters.subject, '化學');
        assert.deepEqual(r.filters.chapters, ['分子極性與分子間作用力']);
        assert.equal(r.semantic_text, '沸點 氫鍵');
        assert.deepEqual(r.warnings, []);
    });

    test('混了數理名詞的化學句子（原本只能交給兩科的 LLM）：LLM 挑化學章節，subject 由章節反推', async () => {
        const llm = fakeLlm({ chapters: ['溶液的種類與濃度'], question_types: [], semantic_text: '溶液 密度', keywords: [] });
        const r = await nlq.parseOnly({ query: '溶液的密度怎麼算', llm, noCache: true });
        assert.equal(llm.calls.length, 1);
        assert.equal(r.parse_path, 'llm');
        assert.equal(r.filters.subject, '化學');
        assert.deepEqual(r.filters.chapters, ['溶液的種類與濃度']);
    });

    test('非法章名仍被擋：打錯的章名、跨科的章名丟掉那一個並附警告，合法的留下', async () => {
        const llm = fakeLlm({ subject: '化學', chapters: ['化學平衡', '向量內積', '勒沙特列原理'], question_types: ['計算', '論述'], semantic_text: '反應進行的方向', keywords: [] });
        const r = await nlq.parseOnly({ query: '化學 反應進行的方向', llm, noCache: true });
        assert.equal(llm.calls.length, 1, '規則沒抓到章節，走 LLM');
        assert.equal(r.filters.subject, '化學');
        assert.deepEqual(r.filters.chapters, ['勒沙特列原理']);
        assert.deepEqual(r.filters.question_types, ['計算']);
        assert.ok(r.warnings.includes('章節「化學平衡」不在白名單內，已忽略。'));
        assert.ok(r.warnings.includes('章節「向量內積」不在白名單內，已忽略。'), '化學科配數學章節要擋');
        assert.ok(r.warnings.includes('題型「論述」不在白名單內，已忽略。'));
        // 章節全部不合法、LLM 也沒給科目 → 化學推定當退路（不是三科全查）
        const bad = fakeLlm({ chapters: ['化學平衡'], question_types: [], semantic_text: '', keywords: [] });
        const b = await nlq.parseOnly({ query: '有沒有化學的難題', llm: bad, noCache: true });
        assert.deepEqual(b.filters.chapters, []);
        assert.equal(b.filters.subject, '化學');
        assert.ok(b.warnings.includes('章節「化學平衡」不在白名單內，已忽略。'));
    });

    test('LLM 給了科目就以 LLM 為準（化學推定只補空的科目）', async () => {
        const llm = fakeLlm({ subject: '物理', chapters: [], question_types: [], semantic_text: '濃度', keywords: [] });
        const r = await nlq.parseOnly({ query: '有沒有化學的難題', llm, noCache: true });
        assert.equal(r.filters.subject, '物理');
    });

    test('點名化學、帶數理名詞的句子：LLM 失敗時 subject 推定為化學（原本是 null，三科全查）', async () => {
        const llm = fakeLlm(new Error('逾時'));
        const r = await nlq.parseOnly({ query: '化學 溶液的密度怎麼算', llm, noCache: true });
        assert.equal(llm.calls.length, 1);
        assert.equal(r.parse_path, 'llm_failed');
        assert.equal(r.filters.subject, '化學');
        assert.deepEqual(r.warnings, [nlq.WARN.llmFailed]);
    });

    test('數學／物理句子不受化學推定影響：LLM 空手或失敗時 subject 仍為 null', async () => {
        for (const query of ['斜面上物體受力平衡的題目', '物理 濃度梯度造成的擴散', '化學能轉換成電能']) {
            for (const respond of [EMPTY, new Error('逾時')]) {
                const llm = fakeLlm(respond);
                const r = await nlq.parseOnly({ query, llm, noCache: true });
                assert.equal(llm.calls.length, 1, query);
                assert.equal(r.filters.subject, null, `${query}：${respond instanceof Error ? '失敗' : '空手'}`);
            }
        }
    });
});

// ───────────────────────── cassette 稽核（eval/lib/cassetteAudit.js） ─────────────────────────

describe('cassetteAudit 的 schemaFor(nlq) 跟上三科值域', () => {
    test('注入與現行相同的數學／物理清單 → 與 buildSchema(nlq) 逐字相同（化學沿用現行）', () => {
        const same = audit.schemaFor('nlq', { 數學: CHAPTERS['數學'], 物理: CHAPTERS['物理'] });
        assert.equal(JSON.stringify(same), JSON.stringify(buildSchema('nlq')));
    });

    test('注入的章節進 chapter_all：數學／物理用注入的，化學有注入就用注入的', () => {
        const injected = audit.schemaFor('nlq', { 數學: ['甲'], 物理: ['乙'], 化學: ['丙'] });
        assert.deepEqual(injected.properties.chapters.items.enum, ['甲', '乙', '丙']);
        assert.deepEqual(injected.properties.subject.enum, ['數學', '物理', '化學']);
        const noChem = audit.schemaFor('nlq', { 數學: ['甲'], 物理: ['乙'] });
        assert.deepEqual(noChem.properties.chapters.items.enum, ['甲', '乙', ...CHAPTERS['化學']]);
        assert.throws(() => audit.schemaFor('nlq', { 數學: ['甲'] }), /缺少「物理」/);
    });
});

// ───────────────────────── 助教（assistant.v2） ─────────────────────────

describe('助教：工具說明書與參數驗證接受化學', () => {
    test('說明書的科目選項由 SUBJECTS 產生（數學|物理|化學），不再寫死兩科', () => {
        const choices = SUBJECTS.join('|');
        assert.equal(choices, '數學|物理|化學');
        assert.ok(assistant.TOOLS.get_student_weakness.params.includes(`"subject": "${choices}（選填）"`));
        assert.ok(assistant.TOOLS.preview_paper.params.includes(`"subject": "${choices}（必填）"`));
        assert.ok(assistant.SYSTEM.includes(`"subject": "${choices}（選填）"`), '說明書是 SYSTEM 的一部分');
        assert.ok(!/"數學\|物理（/.test(assistant.SYSTEM), '不得再出現只有兩科的選項');
        assert.match(assistant.TOOLS.search_questions.description, /化學/);
        assert.match(assistant.SYSTEM, /題庫涵蓋數學、物理、化學共 3 科/);
    });

    test('說明書裡舉例的章名都在白名單內', () => {
        const examples = [...assistant.TOOLS.preview_paper.params.matchAll(/「([^」]+)」/g)].map(m => m[1]);
        assert.ok(examples.length >= 1);
        for (const c of examples) assert.ok(isValidChapter('化學', c), c);
    });

    test('preview_paper：化學科＋化學章節合法；數學／物理的合法章節照舊合法', () => {
        const ok = (subject, chapter) => assistant.TOOLS.preview_paper.validate({ student_name: '小明', subject, chapter, count: 5 });
        assert.equal(ok('化學', '勒沙特列原理'), null);
        assert.equal(ok('化學', '醇、酚、醚'), null);
        assert.equal(ok('化學', ' 緩衝溶液 '), null, '前後空白 trim 後再驗（run 也是 trim 後才用）');
        assert.equal(ok('數學', CHAPTERS['數學'][0]), null);
        assert.equal(ok('物理', CHAPTERS['物理'][0]), null);
    });

    test('preview_paper：非法章名在 validate 就擋下，錯誤訊息給候選', () => {
        const v = (subject, chapter) => assistant.TOOLS.preview_paper.validate({ student_name: '小明', subject, chapter, count: 5 });
        assert.equal(v('化學', '勒沙特列'), 'chapter「勒沙特列」不在化學的章節白名單內；可能是：「勒沙特列原理」', '別名 → 本名');
        assert.match(v('化學', 'pH'), /可能是：「酸鹼解離與pH值」/, '子字串');
        assert.match(v('化學', '碰撞'), /可能是：「碰撞學說與催化」/, '「碰撞」是物理別名，化學科給化學的章');
        assert.equal(v('化學', '向量內積'), 'chapter「向量內積」是數學的章節，subject 要填「數學」', '跨科');
        assert.match(v('物理', '勒沙特列原理'), /是化學的章節，subject 要填「化學」/);
        assert.match(v('化學', '不存在的章'), /^chapter「不存在的章」不在化學的章節白名單內；章名要與白名單完全相同/);
        assert.match(v('數學', '不存在的章'), /不在數學的章節白名單內/, '三科一視同仁');
        // 其餘欄位的驗證照舊
        assert.match(assistant.TOOLS.preview_paper.validate({ student_name: '小明', subject: '生物', chapter: '細胞', count: 5 }), /subject 只接受 數學、物理、化學/);
        assert.equal(assistant.TOOLS.preview_paper.validate({ student_name: '小明', subject: '化學', chapter: '  ', count: 5 }), 'chapter 必填');
        assert.equal(assistant.TOOLS.preview_paper.validate({ student_name: '小明', subject: '化學', chapter: '溶解度', count: 99 }), 'count 要是 1~50 的整數');
    });

    test('get_student_weakness：subject=化學 合法', () => {
        assert.equal(assistant.TOOLS.get_student_weakness.validate({ student_name: '小明', subject: '化學', days: 30 }), null);
    });

    test('主控迴圈：非法化學章名變成餵回主控的錯誤（含候選），不碰工具本體', async () => {
        const decisions = [
            { action: 'call_tool', tool: 'preview_paper', args_json: '{"student_name":"小明","subject":"化學","chapter":"勒沙特列","count":3}' },
            { action: 'final', reply: '章名要用「勒沙特列原理」。' }
        ];
        let i = 0;
        const llm = fakeLlm(() => decisions[i++]);
        const out = await assistant.runAssistant({ message: '幫小明預覽勒沙特列 3 題', deps: { llm, students: [] } });
        assert.equal(out.steps.length, 1);
        assert.equal(out.steps[0].ok, false);
        assert.equal(out.steps[0].result.error, '參數不合法：chapter「勒沙特列」不在化學的章節白名單內；可能是：「勒沙特列原理」');
        assert.ok(llm.calls[1].parts[0].text.includes('勒沙特列原理'), '候選要進下一步的 prompt');
    });
});

describe('助教：模板 assistant.v2（說明書進 cassette 鍵）', () => {
    test('識別名升版、註冊字串 = SYSTEM + ---- + PROMPT_TEMPLATE；呼叫帶新版號', async () => {
        assert.equal(assistant.TEMPLATE, 'assistant.v2');
        assert.equal(getTemplate('assistant.v2'), `${assistant.SYSTEM}\n---\n${assistant.PROMPT_TEMPLATE}`);
        const llm = fakeLlm({ action: 'final', reply: 'ok' });
        await assistant.runAssistant({ message: '化學有哪些章節最弱', deps: { llm, students: [] } });
        assert.equal(llm.calls[0].template, 'assistant.v2');
        assert.equal(llm.calls[0].system, assistant.SYSTEM);
    });

    test('PROMPT_TEMPLATE 就是 buildPrompt 的骨架（挖空可變欄位後逐字相同）', () => {
        const prompt = assistant.buildPrompt(
            [{ role: 'user', text: '甲' }, { role: 'assistant', text: '乙' }],
            [{ tool: 'search_questions', args: { query: '緩衝溶液' }, result: { results: [] } }]
        );
        const expected = assistant.PROMPT_TEMPLATE
            .replace('{{TEXT}}', '甲')
            .replace('{{TEXT}}', '乙')
            .replace('{{TOOL}}', 'search_questions')
            .replace('{{ARGS_JSON}}', JSON.stringify({ query: '緩衝溶液' }))
            .replace('{{RESULT_JSON}}', JSON.stringify({ results: [] }));
        assert.equal(prompt, expected);
    });

    test('說明書改一個字 → 模板雜湊就變（SYSTEM 在註冊字串裡）', () => {
        const { sha256Hex } = require('../../services/llm/templates');
        const now = sha256Hex(getTemplate('assistant.v2'));
        const tweaked = sha256Hex(`${assistant.SYSTEM.replace('數學|物理|化學', '數學|物理')}\n---\n${assistant.PROMPT_TEMPLATE}`);
        assert.notEqual(now, tweaked);
    });
});
