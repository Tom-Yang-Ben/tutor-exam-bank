// 化學併入白名單的單元測試（階段 5 WS-B；docs/interfaces-stage5.md 第 3.2、3.3、4.2 條）
//
// 釘住的東西：
//   - config/chapters.js：SUBJECTS 三科、化學 44 章、LEGACY_* 與併入前逐字相同、SUBJECT_GROUPS；
//   - agents/schemas：buildSchema(name) 行為不變、buildSchema(name, {group:'chemistry'}) 給化學值域；
//   - agents/promptParts：沒指定科目時只列數學與物理、resolveSubjectGroup 的判準順序；
//   - 別名、few-shot 例句、分詞詞典、NLQ 規則路徑都把化學補齊；NLQ 的 LLM 輔路徑不碰化學；
//   - POST /api/jobs 的 subject_group 解析、助教工具與題目驗證的科目清單。
// 純單元測試：不連 DB、不連 LLM。執行：npm test

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const chapters = require('../../config/chapters');
const { CHEMISTRY_VOLUMES, CHEMISTRY_CHAPTERS } = require('../../config/chemistryChapters');
const { buildSchema, ENUM_SOURCES, GROUP_ENUM_SOURCES } = require('../../agents/schemas');
const { chapterWhitelistText, resolveSubjectGroup, CHEM_LATEX_RULES } = require('../../agents/promptParts');
const aliases = require('../../config/chapterAliases');
const { getChapterExample } = require('../../config/chapterExamples');
const { tokenize, MATH_PHYSICS_TERMS } = require('../../utils/tokenize');
const {
    parseQuery, mentionsChemistry, mentionsMathPhysics, isChemistryOnlyQuery, CHEMISTRY_HINTS
} = require('../../utils/nlqHeuristics');
const nlq = require('../../services/nlqService');
const { TOOLS } = require('../../services/assistantService');
const { validateQuestionFields } = require('../../utils/questionValidation');

const {
    SUBJECTS, CHAPTERS, VOLUMES, LEGACY_SUBJECTS, LEGACY_CHAPTERS, SUBJECT_GROUPS, SUBJECT_GROUP_KEYS,
    isValidSubject, isValidChapter, isValidSubjectGroup, subjectGroupOf, volumeOf, subjectChoiceText,
    normalizeSubjectGroup: parseSubjectGroup
} = chapters;

// ───────────────────────── config/chapters.js ─────────────────────────

describe('config/chapters.js：化學併入（第 3.2 條）', () => {
    test('SUBJECTS = 數學、物理、化學（化學排在物理之後）', () => {
        assert.deepEqual(SUBJECTS, ['數學', '物理', '化學']);
        assert.deepEqual(Object.keys(VOLUMES), ['數學', '物理', '化學']);
    });

    test('化學 44 章，唯一真相是 config/chemistryChapters.js（同一個陣列內容、同一順序）', () => {
        assert.equal(CHAPTERS['化學'].length, 44);
        assert.deepEqual(CHAPTERS['化學'], CHEMISTRY_CHAPTERS);
        assert.equal(VOLUMES['化學'], CHEMISTRY_VOLUMES);
        assert.deepEqual(VOLUMES['化學'].map(v => v.name), ['必修化學', '選修化學一', '選修化學二', '選修化學三', '選修化學四', '選修化學五']);
        assert.ok(CHAPTERS['化學'].includes('醇、酚、醚'), '「醇、酚、醚」是一章');
    });

    // 〔章節重整 CH-A〕LEGACY 指「數學／物理這一組的 schema 值域」，2026-09-25 起為重整後的 52＋34＝86 章
    // （docs/chapter-restructure.md 第 2 條）。逐字等於兩科攤平、首尾兩章、凍結，這幾條斷言都照舊。
    test('LEGACY_SUBJECTS／LEGACY_CHAPTERS 是數學＋物理兩科攤平（重整後 86 章）', () => {
        assert.deepEqual(LEGACY_SUBJECTS, ['數學', '物理']);
        assert.equal(LEGACY_CHAPTERS.length, 86);
        assert.deepEqual(LEGACY_CHAPTERS, [...CHAPTERS['數學'], ...CHAPTERS['物理']]);
        assert.equal(LEGACY_CHAPTERS[0], '實數');
        assert.equal(LEGACY_CHAPTERS[85], '核物理與基本粒子');
        assert.ok(Object.isFrozen(LEGACY_CHAPTERS));
    });

    test('三科章節名互不重複（別名表與 NLQ 用章節名反推科目）', () => {
        const all = Object.values(CHAPTERS).flat();
        assert.equal(new Set(all).size, all.length);
    });

    test('SUBJECT_GROUPS 與 migrations/0011 的 CHECK 一致', () => {
        assert.deepEqual(SUBJECT_GROUPS, { math_physics: ['數學', '物理'], chemistry: ['化學'] });
        assert.deepEqual(SUBJECT_GROUP_KEYS, ['math_physics', 'chemistry']);
        const sql = require('node:fs').readFileSync(
            require('node:path').resolve(__dirname, '..', '..', 'migrations', '0011_chemistry_solution_subject_group.sql'), 'utf8');
        for (const g of SUBJECT_GROUP_KEYS) assert.ok(sql.includes(`'${g}'`), `0011 的 CHECK 缺 ${g}`);
    });

    test('isValidSubject／isValidChapter／isValidSubjectGroup／subjectGroupOf／volumeOf', () => {
        assert.equal(isValidSubject('化學'), true);
        assert.equal(isValidSubject('生物'), false);
        assert.equal(isValidChapter('化學', '勒沙特列原理'), true);
        assert.equal(isValidChapter('化學', '向量內積'), false, '跨科錯配仍然擋');
        assert.equal(isValidSubjectGroup('chemistry'), true);
        assert.equal(isValidSubjectGroup('biology'), false);
        assert.equal(subjectGroupOf('化學'), 'chemistry');
        assert.equal(subjectGroupOf('物理'), 'math_physics');
        assert.equal(subjectGroupOf('亂寫'), 'math_physics');
        assert.equal(volumeOf('化學', '緩衝溶液'), '選修化學三');
    });

    test('subjectChoiceText：三科時列三科；訊息不再寫死兩科', () => {
        assert.equal(subjectChoiceText(), '「數學」、「物理」或「化學」');
        assert.deepEqual(validateQuestionFields({ subject: '生物', chapter: 'x', question_text: 'y' }).errors,
            ['學科僅能為「數學」、「物理」或「化學」！']);
        assert.equal(validateQuestionFields({ subject: '化學', chapter: '溶解度', question_text: 'y' }).ok, true);
    });
});

// ───────────────────────── agents/schemas ─────────────────────────

describe('buildSchema 的卷別（第 3.2 條）', () => {
    test('ENUM_SOURCES 讀 LEGACY_*：數學／物理 schema 的值域與併入前相同', () => {
        assert.deepEqual(ENUM_SOURCES.subject, ['數學', '物理']);
        assert.deepEqual(ENUM_SOURCES.chapter, [...LEGACY_CHAPTERS]);
        assert.equal(GROUP_ENUM_SOURCES.math_physics, ENUM_SOURCES);
    });

    test('沒給 group 與 group=math_physics 拿到同一個凍結實例', () => {
        for (const name of ['extract', 'classify', 'variant', 'nlq', 'verify', 'lint']) {
            assert.equal(buildSchema(name, { group: 'math_physics' }), buildSchema(name), name);
        }
    });

    test('group=chemistry：subject 只能是化學、chapter 是化學 44 章；快取鍵含 group', () => {
        const chem = buildSchema('extract', { group: 'chemistry' });
        const props = chem.properties.questions.items.properties;
        assert.deepEqual(props.subject.enum, ['化學']);
        assert.deepEqual(props.chapter.enum, CHAPTERS['化學']);
        assert.notEqual(chem, buildSchema('extract'));
        assert.equal(chem, buildSchema('extract', { group: 'chemistry' }), '同一個卷別只組一次');
        assert.ok(Object.isFrozen(props.chapter.enum));
        assert.deepEqual(buildSchema('classify', { group: 'chemistry' }).properties.chapter.enum, CHAPTERS['化學']);
        assert.deepEqual(buildSchema('variant', { group: 'chemistry' }).properties.chapter.enum, CHAPTERS['化學']);
    });

    test('未知的 group 丟錯（不靜默退回數學／物理的值域）', () => {
        assert.throws(() => buildSchema('extract', { group: 'biology' }), /未知的卷別/);
    });
});

// ───────────────────────── agents/promptParts ─────────────────────────

describe('agents/promptParts', () => {
    test('沒指定科目時只列數學與物理（進的是既有 prompt）', () => {
        const text = chapterWhitelistText();
        // 〔章節重整 CH-A〕34／32 → 52／34（docs/chapter-restructure.md 第 2 條）
        assert.ok(text.includes('【數學科精細章節白名單（共 52 章）】'));
        assert.ok(text.includes('【物理科精細章節白名單（共 34 章）】'));
        for (const c of CHAPTERS['化學']) assert.ok(!text.includes(c), `不該列化學章節「${c}」`);
    });

    test('化學白名單每章加「」（「醇、酚、醚」不會被看成三章）；數學不加', () => {
        const chem = chapterWhitelistText('化學');
        assert.ok(chem.includes('【化學科精細章節白名單（共 44 章）】'));
        assert.ok(chem.includes('「醇、酚、醚」'));
        assert.ok(!chapterWhitelistText('數學').includes('「'));
    });

    test('CHEM_LATEX_RULES 要求 \\ce{…}，且只用 textFormatter 支援的語法', () => {
        for (const s of ['\\ce{', '->', '<=>', '(aq)', '\\mathrm']) assert.ok(CHEM_LATEX_RULES.includes(s), s);
    });

    test('resolveSubjectGroup：科目 > payload.extract.subject > ctx.job.subject_group > 預設', () => {
        assert.equal(resolveSubjectGroup(null, { subject: '化學' }), 'chemistry');
        assert.equal(resolveSubjectGroup({ job: { subject_group: 'chemistry' } }, { subject: '數學' }), 'math_physics');
        assert.equal(resolveSubjectGroup({ jq: { payload: { extract: { subject: '化學' } } } }, {}), 'chemistry');
        assert.equal(resolveSubjectGroup({ jq: { payload: { extract: { subject: '物理' } } }, job: { subject_group: 'chemistry' } }, {}), 'math_physics');
        assert.equal(resolveSubjectGroup({ job: { subject_group: 'chemistry' } }, {}), 'chemistry');
        assert.equal(resolveSubjectGroup({ job: { subject_group: 'weird' } }, {}), 'math_physics');
        assert.equal(resolveSubjectGroup(null, null), 'math_physics');
    });
});

// ───────────────────────── 別名、例句、分詞 ─────────────────────────

describe('化學的別名、few-shot 例句與分詞詞典', () => {
    test('每一個化學章節至少 3 個別名；老師常用的簡稱都在', () => {
        for (const c of CHAPTERS['化學']) {
            assert.ok((aliases.ALIASES_BY_CHAPTER[c] || []).length >= 3, `${c} 的別名不足 3 個`);
        }
        const expect = {
            '莫耳': '原子量與莫耳', '平衡常數': '化學平衡與平衡常數', 'Ksp': '溶解平衡與溶度積', 'pH': '酸鹼解離與pH值',
            '勒沙特列': '勒沙特列原理', '赫斯': '反應熱與赫斯定律', '氧化數': '氧化數與氧化還原滴定', '電解': '電解與電鍍', '酯化': '羧酸與酯'
        };
        for (const [alias, chapter] of Object.entries(expect)) assert.equal(aliases.CHAPTER_ALIASES[alias], chapter, alias);
        assert.equal(aliases.subjectOfChapter('緩衝溶液'), '化學');
    });

    test('化學例句：44 章都有、長度 10～80 字，只取自己那一科', () => {
        for (const c of CHAPTERS['化學']) {
            const e = getChapterExample('化學', c);
            assert.ok(e.length >= 10 && e.length <= 80, `${c}：${e.length} 字`);
        }
        assert.equal(getChapterExample('數學', '勒沙特列原理'), '');
    });

    test('分詞：化學名詞切得出來', () => {
        const toks = tokenize('依勒沙特列原理，加入催化劑後平衡常數不變，但反應速率變快');
        for (const w of ['勒沙特列原理', '催化劑', '平衡常數', '反應速率']) assert.ok(toks.includes(w), `${w}：${JSON.stringify(toks)}`);
        assert.ok(tokenize('醇、酚、醚').includes('醇'));
    });
});

// ───────────────────────── NLQ ─────────────────────────

describe('NLQ：化學走規則路徑（第 4.2 條第 2 點）', () => {
    beforeEach(() => nlq._resetCacheForTest());

    test('規則抓得到化學章節本名與別名，subject 反推為化學', () => {
        const a = parseQuery('緩衝溶液的計算題，難度 3 以上', { aliases: aliases.CHAPTER_ALIASES });
        assert.equal(a.confident, true);
        assert.deepEqual(a.filters.chapters, ['緩衝溶液']);
        assert.equal(a.filters.subject, '化學');
        assert.equal(a.filters.difficulty_min, 3);
        const b = parseQuery('Ksp 跟勒沙特列的題目', { aliases: aliases.CHAPTER_ALIASES });
        assert.deepEqual(b.filters.chapters, ['溶解平衡與溶度積', '勒沙特列原理']);
        assert.equal(b.filters.subject, '化學');
    });

    test('mentionsChemistry：只收數理題不會出現的詞', () => {
        assert.equal(mentionsChemistry('有沒有化學的難題'), true);
        assert.equal(mentionsChemistry('斜面上物體受力平衡的題目'), false);
        assert.equal(mentionsChemistry('把電荷從一點移到另一點需要作多少功'), false);
        assert.ok(CHEMISTRY_HINTS.includes('化學'));
    });

    test('規則沒抓到章節但有化學線索：不呼叫 LLM，subject 設成化學，parse_path 是 rules', async () => {
        let called = 0;
        const llm = { generateJson: async () => { called += 1; return { data: {} }; } };
        const r = await nlq.parseOnly({ query: '有沒有化學的難題', llm, noCache: true });
        assert.equal(called, 0, '化學句子不得走 LLM 輔路徑');
        assert.equal(r.parse_path, 'rules');
        assert.equal(r.filters.subject, '化學');
    });

    test('數學／物理的句子照舊走 LLM 輔路徑（行為不變）', async () => {
        let called = 0;
        const llm = { generateJson: async () => { called += 1; return { data: { chapters: [], question_types: [], semantic_text: 'x', keywords: [] } }; } };
        const r = await nlq.parseOnly({ query: '斜面上物體受力平衡的題目', llm, noCache: true });
        assert.equal(called, 1);
        assert.equal(r.parse_path, 'llm');
    });

    // 審查回報：句子有化學線索字、但老師點名物理／數學（或用的是數理名詞）時，曾被鎖成化學、不走 LLM。
    // 這些句子必須維持化學分支加進來之前的行為：走 LLM 輔路徑，subject 由 LLM 決定（這裡的假 LLM 不給 → null）。
    test('點名數學／物理、或帶數理名詞的句子：化學線索字不能把它鎖成化學，照舊走 LLM', async () => {
        const queries = [
            '物理 濃度梯度造成的擴散',        // 點名物理
            '數學的溶液混合濃度應用題',        // 點名數學
            '數甲 藥物濃度的題目',             // 考科簡稱
            '藥物濃度衰減的應用題',            // 數學指數衰減（MATH_PHYSICS_COMPOUNDS）
            '核反應式的題目',                  // 物理核反應（「反應式」是化學線索字）
            '化學能轉換成電能',                // 物理能量形式（「化學」是化學線索字）
            '溶液的密度怎麼算'                 // 數理名詞「密度」（MATH_PHYSICS_TERMS）
        ];
        for (const query of queries) {
            let called = 0;
            const llm = { generateJson: async () => { called += 1; return { data: { chapters: [], question_types: [], semantic_text: 'x', keywords: [] } }; } };
            const r = await nlq.parseOnly({ query, llm, noCache: true });
            assert.equal(called, 1, `${query}：應該走 LLM 輔路徑`);
            assert.equal(r.parse_path, 'llm', query);
            assert.equal(r.filters.subject, null, `${query}：subject 不得被鎖成化學`);
        }
    });

    test('LLM 回了科目就用 LLM 的（點名物理的句子，subject 由 LLM 讀出物理）', async () => {
        const llm = { generateJson: async () => ({ data: { subject: '物理', chapters: [], question_types: [], semantic_text: '濃度梯度 擴散', keywords: [] } }) };
        const r = await nlq.parseOnly({ query: '物理 濃度梯度造成的擴散', llm, noCache: true });
        assert.equal(r.parse_path, 'llm');
        assert.equal(r.filters.subject, '物理');
    });

    test('沒有數理線索的化學句子仍只走規則（化合物、酸鹼、沉澱）', async () => {
        for (const query of ['化合物的命名規則', '酸鹼的填充題', '哪些離子會產生沉澱']) {
            let called = 0;
            const llm = { generateJson: async () => { called += 1; return { data: {} }; } };
            const r = await nlq.parseOnly({ query, llm, noCache: true });
            assert.equal(called, 0, query);
            assert.equal(r.parse_path, 'rules', query);
            assert.equal(r.filters.subject, '化學', query);
        }
    });

    test('mentionsMathPhysics／isChemistryOnlyQuery：科目名、數理複合詞、注入的數理名詞', () => {
        const opts = { mathPhysicsTerms: MATH_PHYSICS_TERMS };
        assert.equal(mentionsMathPhysics('物理 濃度梯度'), true);
        assert.equal(mentionsMathPhysics('數學的溶液'), true);
        assert.equal(mentionsMathPhysics('化學能'), true);
        assert.equal(mentionsMathPhysics('溶液的密度'), false, '沒注入數理名詞表時只看科目名與複合詞');
        assert.equal(mentionsMathPhysics('溶液的密度', { terms: MATH_PHYSICS_TERMS }), true);
        // 化學線索詞先挖掉：「週期表」不因為含「週期」（物理名詞）就算數理
        assert.ok(MATH_PHYSICS_TERMS.includes('週期'));
        assert.equal(mentionsMathPhysics('週期表的趨勢', { terms: MATH_PHYSICS_TERMS }), false);
        assert.equal(isChemistryOnlyQuery('有沒有化學的難題', opts), true);
        assert.equal(isChemistryOnlyQuery('物理 濃度梯度造成的擴散', opts), false);
        assert.equal(isChemistryOnlyQuery('數學的溶液混合濃度應用題', opts), false);
        assert.equal(isChemistryOnlyQuery('斜面上物體受力平衡的題目', opts), false, '沒有化學線索');
    });

    test('送給 LLM 的章節白名單只列數學與物理（nlq.v1 的既有 prompt）', () => {
        const text = nlq.chapterWhitelistText();
        assert.ok(text.includes('數學：') && text.includes('物理：'));
        assert.ok(!text.includes('化學：'));
        for (const c of CHAPTERS['化學']) assert.ok(!text.includes(c), c);
        assert.deepEqual(buildSchema('nlq').properties.subject.enum, ['數學', '物理']);
    });
});

// ───────────────────────── API 與服務的科目清單 ─────────────────────────

describe('POST /api/jobs 的 subject_group 解析（第 4.2 條第 1 點）', () => {
    test('沒帶或空字串 → math_physics；合法值原樣；其他 → null（controller 回 400）', () => {
        assert.equal(parseSubjectGroup(undefined), 'math_physics');
        assert.equal(parseSubjectGroup(null), 'math_physics');
        assert.equal(parseSubjectGroup('  '), 'math_physics');
        assert.equal(parseSubjectGroup('chemistry'), 'chemistry');
        assert.equal(parseSubjectGroup(' math_physics '), 'math_physics');
        for (const bad of ['Chemistry', 'biology', '化學', '1']) assert.equal(parseSubjectGroup(bad), null, bad);
    });
});

describe('助教工具的科目驗證改讀 SUBJECTS（SYSTEM 不動）', () => {
    test('化學合法、生物不合法', () => {
        assert.equal(TOOLS.get_student_weakness.validate({ student_name: '小明', subject: '化學' }), null);
        assert.match(TOOLS.get_student_weakness.validate({ student_name: '小明', subject: '生物' }), /數學、物理、化學/);
        assert.equal(TOOLS.preview_paper.validate({ student_name: '小明', subject: '化學', chapter: '溶解度', count: 5 }), null);
        assert.ok(TOOLS.preview_paper.validate({ student_name: '小明', subject: '生物', chapter: 'x', count: 5 }));
    });
});
