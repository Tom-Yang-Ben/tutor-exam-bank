// 公開 fixture 與檢索 golden 的硬閘門測試
//
// 這一支同時是**資料**的測試，不只是程式的測試：它每次 CI 都會把
// eval/fixtures/questions.public.json 的 60 題與 eval/golden/retrieval.json 的 40 筆
// 重新過一次章節白名單與交叉參照。
//
// 為什麼值得：fixture 是純檔案，沒有 DB 的 CHECK 幫忙擋。一個手滑改錯的章節名、
// 一個指到不存在題目的 golden id，都**不會**讓任何東西壞掉——只會讓 Recall 安靜地變低，
// 看起來像檢索退步，其實是標註爛掉。規劃 §5.3.2：「golden 本身也要過硬閘門」。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadFixture, validateQuestions, groupByVariant } = require('../../eval/lib/fixtures');
const { loadGolden, validateEntries, isPrivatePath } = require('../../eval/lib/golden');
const { isValidChapter } = require('../../config/chapters');

const fixture = loadFixture();          // 載入本身就會跑硬閘門，不過關會丟錯
const golden = loadGolden({ fixtureById: fixture.byId });

describe('公開 fixture 的結構（D-E1 的驗收條件）', () => {
    test('共 60 題', () => {
        assert.equal(fixture.questions.length, 60);
    });

    test('每一題的章節都在 config/chapters.js 的白名單內', () => {
        for (const q of fixture.questions) {
            assert.ok(isValidChapter(q.subject, q.chapter), `id=${q.id} 的「${q.subject}／${q.chapter}」不在白名單`);
        }
    });

    test('涵蓋 ≥ 6 個白名單章節', () => {
        const chapters = new Set(fixture.questions.map(q => `${q.subject}/${q.chapter}`));
        assert.ok(chapters.size >= 6, `只有 ${chapters.size} 章`);
    });

    test('有「換數字的同一題」配對，且每組至少 2 題', () => {
        const groups = groupByVariant(fixture.questions);
        assert.ok(groups.size >= 10, `只有 ${groups.size} 組`);
        for (const [name, ids] of groups) {
            assert.ok(ids.length >= 2, `variant_group「${name}」只有 ${ids.length} 題，配不成對`);
        }
    });

    test('有跨章字面相近的對照組（向量內積 vs 空間向量內積）', () => {
        const pairs = fixture.questions.filter(q => q.lookalike_of);
        assert.ok(pairs.length > 0);
        const chapters = new Set(pairs.map(q => q.chapter));
        assert.ok(chapters.has('向量內積') && chapters.has('空間向量內積'));
    });

    test('有同章不同概念的干擾題，且每個有配對的章節都至少有一題', () => {
        const groups = groupByVariant(fixture.questions);
        const chaptersWithVariants = new Set(
            fixture.questions.filter(q => q.variant_group && groups.get(q.variant_group).length >= 2)
                .map(q => `${q.subject}/${q.chapter}`)
        );
        for (const key of chaptersWithVariants) {
            const has = fixture.questions.some(q => `${q.subject}/${q.chapter}` === key && q.role === 'distractor');
            assert.ok(has, `${key} 沒有 role=distractor 的干擾題`);
        }
    });

    test('剛好 10 題故意寫壞的 LaTeX，且都標了壞法', () => {
        const broken = fixture.questions.filter(q => q.latex_broken);
        assert.equal(broken.length, 10);
        for (const q of broken) {
            assert.ok(q.broken_kind, `id=${q.id} 標了 latex_broken 卻沒寫 broken_kind`);
        }
    });

    test('壞 LaTeX 只壞在題幹，答案仍是完整可解析的（人工核對時要看得懂）', () => {
        for (const q of fixture.questions.filter(x => x.latex_broken)) {
            const braces = (q.answer_text.match(/\{/g) || []).length - (q.answer_text.match(/\}/g) || []).length;
            assert.equal(braces, 0, `id=${q.id} 的 answer_text 大括號不成對`);
        }
    });

    test('檔頭寫明自行編寫、非取自任何考卷（NOTICE 第 2 條）', () => {
        const raw = require('../../eval/fixtures/questions.public.json');
        assert.match(raw._notice, /自行編寫/);
        assert.match(raw._notice, /不取自任何特定考卷/);
    });
});

describe('fixture 硬閘門（validateQuestions）', () => {
    const base = {
        id: 1, subject: '數學', chapter: '向量內積', question_type: '計算',
        difficulty: 3, question_text: 'q', answer_text: 'a'
    };

    test('合法題目回空陣列', () => {
        assert.deepEqual(validateQuestions([base]), []);
    });

    test('章節不在白名單會被擋下', () => {
        const out = validateQuestions([{ ...base, chapter: '量子糾纏' }]);
        assert.equal(out.length, 1);
        assert.match(out[0], /不在「數學」的白名單/);
    });

    test('章節屬於另一個學科也會被擋下（物理的章節不能掛在數學底下）', () => {
        const out = validateQuestions([{ ...base, chapter: '直線運動' }]);
        assert.match(out[0], /不在「數學」的白名單/);
    });

    test('題型、難度、空題幹、空答案各自被擋下', () => {
        assert.match(validateQuestions([{ ...base, question_type: '簡答' }])[0], /question_type/);
        assert.match(validateQuestions([{ ...base, difficulty: 9 }])[0], /difficulty/);
        assert.match(validateQuestions([{ ...base, question_text: '  ' }])[0], /question_text/);
        assert.match(validateQuestions([{ ...base, answer_text: '' }])[0], /answer_text/);
    });

    test('id 重複會被擋下', () => {
        const out = validateQuestions([base, { ...base }]);
        assert.ok(out.some(p => /id 重複/.test(p)));
    });

    test('一次回報所有問題，不是遇到第一個就停', () => {
        const out = validateQuestions([{ ...base, chapter: 'X', question_type: 'Y', difficulty: 0 }]);
        assert.ok(out.length >= 3);
    });
});

describe('檢索 golden 的結構（E-X2 的驗收條件）', () => {
    test('共 40 筆', () => {
        assert.equal(golden.entries.length, 40);
    });

    test('每一筆的 query.kind 都是 question_id（階段 1 只評 ID→ID）', () => {
        for (const e of golden.entries) assert.equal(e.query.kind, 'question_id');
    });

    test('每一筆都有非空的 relevant——沒有正確答案的 query 不會被計分', () => {
        for (const e of golden.entries) {
            assert.ok(Array.isArray(e.relevant) && e.relevant.length > 0, `${e.id} 的 relevant 是空的`);
        }
    });

    test('所有引用到的 id 都在 fixture 裡（loadGolden 會擋，這裡再確認一次）', () => {
        for (const e of golden.entries) {
            assert.ok(fixture.byId.has(e.query.value));
            for (const id of [...e.relevant, ...(e.hard_negatives || [])]) assert.ok(fixture.byId.has(id), `${e.id} 引用了不存在的 id=${id}`);
        }
    });

    test('relevant 與 hard_negatives 不相交', () => {
        for (const e of golden.entries) {
            const neg = new Set(e.hard_negatives || []);
            for (const id of e.relevant) assert.ok(!neg.has(id), `${e.id} 的 id=${id} 兩邊都列了`);
        }
    });

    test('relevant 的題與 query 屬於同一個 variant_group（正樣本＝換數字的同一題）', () => {
        for (const e of golden.entries) {
            const q = fixture.byId.get(e.query.value);
            for (const id of e.relevant) {
                assert.equal(fixture.byId.get(id).variant_group, q.variant_group, `${e.id}：id=${id} 不同組`);
            }
        }
    });

    test('hard_negatives 不是同一個 variant_group（否則就是把正樣本標成負樣本）', () => {
        for (const e of golden.entries) {
            const q = fixture.byId.get(e.query.value);
            for (const id of e.hard_negatives || []) {
                assert.notEqual(fixture.byId.get(id).variant_group, q.variant_group, `${e.id}：id=${id} 與 query 同組`);
            }
        }
    });

    test('尚未定稿時全部標記 needs_human_confirm（不得默默當成人工標註過）', () => {
        // 定稿後這個測試會變成 0，屆時把斷言改成「全部都不是 needs_human_confirm」
        assert.ok(golden.pendingConfirm === 0 || golden.pendingConfirm === golden.entries.length,
            '不該出現「一半確認過一半沒有」的中間狀態');
    });
});

describe('golden 硬閘門（validateEntries）', () => {
    const byId = new Map([[1, {}], [2, {}], [3, {}]]);
    const ok = { id: 'R001', query: { kind: 'question_id', value: 1 }, relevant: [2], hard_negatives: [3] };

    test('合法 entry 回空陣列', () => {
        assert.deepEqual(validateEntries([ok], byId), []);
    });

    test('自然語言 query 在階段 1 被擋下', () => {
        const out = validateEntries([{ ...ok, query: { kind: 'text', value: '向量內積怎麼算' } }], byId);
        assert.match(out[0], /question_id/);
    });

    test('指到不存在的 id 被擋下', () => {
        assert.match(validateEntries([{ ...ok, relevant: [99] }], byId)[0], /沒有的 id=99/);
    });

    test('query 題自己被列為 relevant 會被擋下（--exclude-self 會排除它，永遠拿不到分）', () => {
        assert.match(validateEntries([{ ...ok, relevant: [1] }], byId)[0], /不得列為 relevant/);
    });

    test('relevant 與 hard_negatives 相交會被擋下', () => {
        assert.match(validateEntries([{ ...ok, relevant: [2], hard_negatives: [2] }], byId)[0], /同時被列為/);
    });
});

describe('私有層防呆', () => {
    test('eval/private/ 底下的 golden 會被判為私有', () => {
        assert.equal(isPrivatePath('eval/private/golden/retrieval.json'), true);
        assert.equal(isPrivatePath(require('path').resolve(__dirname, '../../eval/private/golden/x.json')), true);
    });

    test('公開層與試圖用 .. 繞出去的路徑都不算私有', () => {
        assert.equal(isPrivatePath('eval/golden/retrieval.json'), false);
        assert.equal(isPrivatePath('eval/private/../golden/retrieval.json'), false);
    });
});
