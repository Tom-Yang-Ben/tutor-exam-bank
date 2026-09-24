// ─────────────────────────────────────────────────────────────
// kcService.test.js — 知識點服務的純函式（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條）
//
// DB 那一半在 test/integration/kc.pg.test.js 與 kcLoad.pg.test.js；
// 這裡只測「不連資料庫也該正確」的部分：參數驗證（每一條 400 的來源）、載入計畫、
// 環偵測、PATCH 的 SQL 組裝，以及 utils/kcSeed.js 新增的逐欄檢查與種子檔驗證「判定一致」。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const kc = require('../../services/kcService');
const { validateSeeds, checkKcField, parseKcCode, LATEX_RE, EDITABLE_FIELDS, defaultChapters } = require('../../utils/kcSeed');

const CH = { '數學': ['向量的加減與係數積', '向量內積'], '物理': ['功與動能'] };
const SPOKEN = '有坐標就不用管角度：x 跟 x 乘、y 跟 y 乘，全部加起來。三維就多加一個 z 乘 z。記得算出來是一個數字，不是向量。';

describe('parseId', () => {
    test('只收正整數字串', () => {
        assert.equal(kc.parseId('12'), 12);
        assert.equal(kc.parseId(7), 7);
        for (const bad of ['0', '-1', '1.0', '1.5', '12abc', ' 12x', '', null, undefined, 'abc', '2147483648']) {
            assert.equal(kc.parseId(bad), null, `「${bad}」應該被擋`);
        }
    });
});

describe('orderKeys', () => {
    test('科目順序與「科目|章名」順序都照白名單', () => {
        const { subjects, chapterKeys } = kc.orderKeys(CH);
        assert.deepEqual(subjects, ['數學', '物理']);
        assert.deepEqual(chapterKeys, ['數學|向量的加減與係數積', '數學|向量內積', '物理|功與動能']);
    });

    test('預設白名單：數學、物理在前，化學還沒併入時由 chemistryChapters 補在最後', () => {
        const { subjects } = kc.orderKeys(defaultChapters());
        assert.equal(subjects[0], '數學');
        assert.equal(subjects[1], '物理');
        assert.ok(subjects.includes('化學'));
    });
});

describe('parseListQuery（GET /api/kc）', () => {
    test('全部不給 → 三個 null', () => {
        assert.deepEqual(kc.parseListQuery({}, CH), { subject: null, chapter: null, status: null });
        assert.deepEqual(kc.parseListQuery({ subject: '', chapter: ' ', status: '' }, CH), { subject: null, chapter: null, status: null });
    });

    test('合法組合', () => {
        assert.deepEqual(kc.parseListQuery({ subject: '數學', chapter: '向量內積', status: 'approved' }, CH),
            { subject: '數學', chapter: '向量內積', status: 'approved' });
        // 只給章：任何一科的章都可以
        assert.deepEqual(kc.parseListQuery({ chapter: '功與動能' }, CH), { subject: null, chapter: '功與動能', status: null });
    });

    test('白名單外的科目、章節、狀態 → error', () => {
        assert.ok(kc.parseListQuery({ subject: '生物' }, CH).error.includes('數學、物理'));
        assert.ok(kc.parseListQuery({ subject: '數學', chapter: '功與動能' }, CH).error.includes('功與動能'));
        assert.ok(kc.parseListQuery({ chapter: '不存在的章' }, CH).error);
        assert.ok(kc.parseListQuery({ status: 'published' }, CH).error.includes('draft'));
    });

    test('同一個參數給兩次（?subject=a&subject=b）→ error，不猜要用哪一個', () => {
        assert.ok(kc.parseListQuery({ subject: ['數學', '物理'] }, CH).error);
    });
});

describe('validateKcPatch（PATCH /api/kc/:id）', () => {
    test('合法：字串會 trim，curriculum_code 可以是 null', () => {
        const r = kc.validateKcPatch({ name: '  內積  ', spoken_text: ` ${SPOKEN} `, curriculum_code: null, status: 'approved' });
        assert.deepEqual(r, { fields: { name: '內積', spoken_text: SPOKEN, curriculum_code: null, status: 'approved' } });
    });

    test('不認得的鍵一律擋（spokenText 這種拼錯不能靜默略過）', () => {
        const r = kc.validateKcPatch({ spokenText: SPOKEN });
        assert.ok(r.error.includes('spokenText'));
        assert.ok(kc.validateKcPatch({ code: 'MATH.x.01' }).error.includes('code'));
        assert.ok(kc.validateKcPatch({ chapter: '向量內積' }).error);
    });

    test('空 body、非物件 → error', () => {
        assert.equal(kc.validateKcPatch({}).error, '沒有要更新的欄位。');
        for (const bad of [null, undefined, [], 'x', 3]) assert.ok(kc.validateKcPatch(bad).error, String(bad));
    });

    test('長度規則同第 3.4 條', () => {
        assert.ok(kc.validateKcPatch({ name: '' }).error.includes('name'));
        assert.ok(kc.validateKcPatch({ name: 'x'.repeat(31) }).error.includes('name'));
        assert.equal(kc.validateKcPatch({ name: 'x'.repeat(30) }).fields.name.length, 30);
        assert.ok(kc.validateKcPatch({ description: '   ' }).error.includes('description'));
        assert.ok(kc.validateKcPatch({ description: 'x'.repeat(201) }).error);
        assert.ok(kc.validateKcPatch({ description: null }).error, 'description 不可清成 null（第 3.4 條要求 1–200 字）');
        assert.ok(kc.validateKcPatch({ spoken_text: '太短了' }).error.includes('spoken_text'));
        assert.ok(kc.validateKcPatch({ spoken_text: 'x'.repeat(301) }).error);
        assert.ok(kc.validateKcPatch({ spoken_text: null }).error);
        assert.ok(kc.validateKcPatch({ curriculum_code: '' }).error);
        assert.ok(kc.validateKcPatch({ curriculum_code: 'x'.repeat(41) }).error);
        assert.equal(kc.validateKcPatch({ curriculum_code: 'N-10-3' }).fields.curriculum_code, 'N-10-3');
        assert.ok(kc.validateKcPatch({ status: 'published' }).error);
        assert.ok(kc.validateKcPatch({ name: 12 }).error, '非字串的 name');
    });

    test('口語版不可含 LaTeX', () => {
        const r = kc.validateKcPatch({ spoken_text: `${SPOKEN}，寫成 $\\vec a\\cdot\\vec b$` });
        assert.ok(r.error.includes('LaTeX'));
        assert.ok(kc.validateKcPatch({ spoken_text: `${SPOKEN}\\frac 也不行` }).error.includes('LaTeX'));
    });
});

describe('checkKcField 與 validateSeeds 的判定一致（同一份第 3.4 條）', () => {
    function seedWith(field, value) {
        const base = {
            code: 'MATH.向量內積.01', chapter: '向量內積', sort: 1, name: '內積的意義', curriculum_code: null,
            description: '說明', spoken_text: SPOKEN, status: 'draft', prereqs: []
        };
        const comps = [base, { ...base, code: 'MATH.向量內積.02', sort: 2, name: '二' }, { ...base, code: 'MATH.向量內積.03', sort: 3, name: '三' }];
        comps[0] = { ...comps[0], [field]: value };
        return [{ subject: '數學', components: comps }];
    }
    const SAMPLES = {
        name: ['', ' ', 'a', 'x'.repeat(30), 'x'.repeat(31)],
        description: ['', '說明', 'x'.repeat(200), 'x'.repeat(201)],
        spoken_text: [SPOKEN, '短', 'x'.repeat(40), 'x'.repeat(39), 'x'.repeat(300), 'x'.repeat(301),
            `${SPOKEN}$x$`, `${SPOKEN}\\alpha`, `${SPOKEN} 5 美元不寫符號`, `${SPOKEN} a·b、|a|、cosθ、x²、H₂O、→`],
        curriculum_code: [null, 'N-10-3', '', ' ', 'x'.repeat(40), 'x'.repeat(41)],
        status: ['draft', 'approved', 'published', '']
    };
    for (const [field, values] of Object.entries(SAMPLES)) {
        test(`${field}：兩邊對每個樣本都給出同樣的「過／不過」`, () => {
            for (const v of values) {
                const seedErr = validateSeeds(seedWith(field, v), { chapters: { '數學': ['向量內積'] } }).errors
                    .some(e => e.includes(field));
                const fieldErr = checkKcField(field, v) !== null;
                assert.equal(fieldErr, seedErr, `${field}=「${String(v).slice(0, 20)}」：checkKcField ${fieldErr}、validateSeeds ${seedErr}`);
            }
        });
    }

    test('LATEX_RE 與 EDITABLE_FIELDS 的形狀', () => {
        assert.ok(LATEX_RE.test('$x$'));
        assert.ok(LATEX_RE.test('\\cdot'));
        assert.ok(!LATEX_RE.test('a·b 與 |a|'));
        assert.deepEqual(EDITABLE_FIELDS, ['name', 'description', 'spoken_text', 'curriculum_code', 'status']);
    });

    test('parseKcCode：由 code 推回科目、章名、序號', () => {
        assert.deepEqual(parseKcCode('MATH.向量內積.02'), { subject: '數學', chapter: '向量內積', seq: 2 });
        assert.deepEqual(parseKcCode('CHEM.醇、酚、醚.03'), { subject: '化學', chapter: '醇、酚、醚', seq: 3 });
        assert.equal(parseKcCode('BIO.細胞.01'), null);
        assert.equal(parseKcCode('MATH.向量內積.2'), null);
        assert.equal(parseKcCode(null), null);
    });
});

describe('parseQuestionKcsBody（PUT /api/questions/:id/kcs）', () => {
    test('weight 沒給就是 1；給了原樣保留', () => {
        assert.deepEqual(kc.parseQuestionKcsBody({ items: [{ kc_id: 3 }, { kc_id: 5, weight: 0.5 }] }),
            { items: [{ kc_id: 3, weight: 1 }, { kc_id: 5, weight: 0.5 }] });
    });

    test('0 個是合法的（清掉全部標註）', () => {
        assert.deepEqual(kc.parseQuestionKcsBody({ items: [] }), { items: [] });
    });

    test('每一條 400 的來源', () => {
        assert.ok(kc.parseQuestionKcsBody({}).error.includes('items'));
        assert.ok(kc.parseQuestionKcsBody(null).error);
        assert.ok(kc.parseQuestionKcsBody({ items: 'x' }).error);
        assert.ok(kc.parseQuestionKcsBody({ items: [1, 2, 3, 4, 5, 6].map(k => ({ kc_id: k })) }).error.includes('5'));
        assert.ok(kc.parseQuestionKcsBody({ items: [{ kc_id: 1 }, { kc_id: 1 }] }).error.includes('重複'));
        for (const bad of [0, -1, 1.5, '3', null]) {
            assert.ok(kc.parseQuestionKcsBody({ items: [{ kc_id: bad }] }).error.includes('kc_id'), `kc_id=${bad}`);
        }
        for (const bad of [0, -0.1, 1.01, '0.5', NaN, null]) {
            assert.ok(kc.parseQuestionKcsBody({ items: [{ kc_id: 1, weight: bad }] }).error.includes('weight'), `weight=${bad}`);
        }
        assert.ok(kc.parseQuestionKcsBody({ items: [3] }).error);
    });

    test('上限就是 MAX_QUESTION_KCS = 5', () => {
        assert.equal(kc.MAX_QUESTION_KCS, 5);
        assert.equal(kc.parseQuestionKcsBody({ items: [1, 2, 3, 4, 5].map(k => ({ kc_id: k })) }).items.length, 5);
    });
});

describe('planSeedUpsert（npm run kc:load 的載入計畫）', () => {
    const seed = kc.seedRowOf({
        code: 'MATH.向量內積.02', chapter: '向量內積', sort: 2, name: ' 內積的坐標算法 ', curriculum_code: undefined,
        description: '已知兩向量坐標時，內積等於對應分量乘積的和。', spoken_text: SPOKEN, status: 'approved'
    }, '數學');

    test('seedRowOf：trim 字串、curriculum_code 缺值變 null、帶上科目', () => {
        assert.equal(seed.name, '內積的坐標算法');
        assert.equal(seed.curriculum_code, null);
        assert.equal(seed.subject, '數學');
    });

    test('DB 沒有 → insert；內容相同 → unchanged', () => {
        assert.equal(kc.planSeedUpsert(seed, undefined), 'insert');
        assert.equal(kc.planSeedUpsert(seed, { ...seed, id: 1 }), 'unchanged');
    });

    test('DB 是草稿、內容不同 → update', () => {
        assert.equal(kc.planSeedUpsert(seed, { ...seed, status: 'draft' }), 'update');
        const draftSeed = { ...seed, status: 'draft' };
        assert.equal(kc.planSeedUpsert(draftSeed, { ...draftSeed, sort: 9 }), 'update');
    });

    test('DB 已審定、內容不同 → protected；--force 才 update', () => {
        const dbRow = { ...seed, spoken_text: `${SPOKEN}（Owner 改過）`, status: 'approved' };
        assert.equal(kc.planSeedUpsert(seed, dbRow), 'protected');
        assert.equal(kc.planSeedUpsert(seed, dbRow, { force: true }), 'update');
        // 種子檔是 draft、DB 已審定：一樣受保護（不會被種子檔降級回草稿）
        assert.equal(kc.planSeedUpsert({ ...seed, status: 'draft' }, { ...seed, status: 'approved' }), 'protected');
    });

    test('比對的欄位就是內容欄位（code／subject／chapter 由 code 決定，不列入）', () => {
        assert.deepEqual(kc.CONTENT_FIELDS, ['name', 'curriculum_code', 'description', 'spoken_text', 'status', 'sort']);
    });
});

describe('findCycle（先備關係不得成環）', () => {
    test('沒有環 → null', () => {
        assert.equal(kc.findCycle([]), null);
        assert.equal(kc.findCycle([[1, 2], [2, 3], [1, 3]]), null);
    });

    test('兩點環與長環都抓得到，回傳的路徑首尾相同', () => {
        const two = kc.findCycle([[1, 2], [2, 1]]);
        assert.equal(two[0], two[two.length - 1]);
        const long = kc.findCycle([[1, 2], [2, 3], [3, 4], [4, 2], [5, 1]]);
        assert.deepEqual(long, [2, 3, 4, 2]);
    });

    test('code 字串也可以', () => {
        assert.ok(kc.findCycle([['A', 'B'], ['B', 'C'], ['C', 'A']]));
    });
});

describe('buildPatchSql', () => {
    test('只 SET 有給的欄位，順序固定，並更新 updated_at', () => {
        const { text, values } = kc.buildPatchSql(9, { status: 'approved', name: '正射影' });
        assert.equal(text, 'UPDATE knowledge_components SET name = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING id');
        assert.deepEqual(values, [9, '正射影', 'approved']);
    });

    test('curriculum_code: null 也要真的 SET（清空）', () => {
        const { text, values } = kc.buildPatchSql(1, { curriculum_code: null });
        assert.ok(text.includes('curriculum_code = $2'));
        assert.deepEqual(values, [1, null]);
    });
});

describe('kcController 的 ?detail 旗標', () => {
    test('只有 1／true 會切到附加形狀', () => {
        const { _wantsDetail: wants } = require('../../controllers/kcController.js');
        assert.equal(wants({ detail: '1' }), true);
        assert.equal(wants({ detail: 'TRUE' }), true);
        for (const v of [undefined, '', '0', 'false', 'yes']) assert.equal(wants({ detail: v }), false, String(v));
        assert.equal(wants(undefined), false);
    });
});