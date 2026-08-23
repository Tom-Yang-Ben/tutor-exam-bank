// utils/nlqHeuristics.js 的規則解析（docs/interfaces-stage3.md 第 6.1 條，P-07）
//
// 這一支是「規則覆蓋率 ≥ 70%」那個驗收指標的第一道防線（規劃 §4.8）：
// `confident` 決定要不要花錢呼叫 LLM，所以它的定義（命中 ≥ 1 章）必須被逐字釘住。
//
// 純函式，不連 DB、不連 Gemini。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseQuery } = require('../../utils/nlqHeuristics');
const { CHAPTER_ALIASES } = require('../../config/chapterAliases');
const { QUESTION_TYPES, isValidChapter } = require('../../config/chapters');

const OPTS = { aliases: CHAPTER_ALIASES };
const parse = (text) => parseQuery(text, OPTS);

describe('parseQuery：回傳形狀（第 6.1 條）', () => {
    test('七個 filters 鍵一律出現，型別固定', () => {
        for (const q of ['', '   ', '隨便打一串沒有意義的字', '牛頓第二定律的計算題']) {
            const r = parse(q);
            assert.deepEqual(Object.keys(r.filters).sort(), [
                'chapters', 'difficulty_max', 'difficulty_min',
                'exclude_student_name', 'keywords', 'question_types', 'subject'
            ]);
            assert.ok(Array.isArray(r.filters.chapters));
            assert.ok(Array.isArray(r.filters.question_types));
            assert.ok(Array.isArray(r.filters.keywords));
            assert.equal(typeof r.confident, 'boolean');
            assert.equal(typeof r.semantic_text, 'string');
        }
    });

    test('null／undefined 不丟例外', () => {
        for (const q of [null, undefined, 123]) {
            const r = parseQuery(q, OPTS);
            assert.equal(r.confident, false);
        }
    });

    test('純函式：同一句話呼叫兩次結果完全相同，且不會污染 opts', () => {
        const q = '牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過';
        const a = parse(q);
        const b = parse(q);
        assert.deepEqual(a, b);
        assert.equal(Object.keys(CHAPTER_ALIASES).length, Object.keys(OPTS.aliases).length);
    });
});

describe('parseQuery：confident 的定義凍結（命中 ≥ 1 章即 true）', () => {
    test('有章節 → true', () => {
        assert.equal(parse('向量內積').confident, true);
        assert.equal(parse('牛頓第二定律').confident, true);
    });

    test('沒章節 → false，即使抓到難度與題型', () => {
        const r = parse('難度 4 以上的計算題');
        assert.equal(r.filters.chapters.length, 0);
        assert.equal(r.confident, false);
        assert.equal(r.filters.difficulty_min, 4);
        assert.deepEqual(r.filters.question_types, ['計算']);
    });

    test('confident 恆等於 chapters.length >= 1', () => {
        for (const q of ['浮力', '沒有任何章節詞', '難度3', '', '對數的填空題']) {
            const r = parse(q);
            assert.equal(r.confident, r.filters.chapters.length >= 1);
        }
    });
});

describe('parseQuery：章節本名與別名的子字串比對（長的優先）', () => {
    test('第 6 條的凍結範例逐字重現', () => {
        const r = parse('牛頓第二定律加摩擦力的計算題，難度 4 以上，小明沒寫過');
        assert.equal(r.filters.subject, '物理');
        assert.deepEqual(r.filters.chapters, ['牛頓運動定律', '摩擦力與向心力']);
        assert.deepEqual(r.filters.question_types, ['計算']);
        assert.equal(r.filters.difficulty_min, 4);
        assert.equal(r.filters.difficulty_max, 5);
        assert.equal(r.filters.exclude_student_name, '小明');
        assert.equal(r.semantic_text, '牛頓第二定律 摩擦力');
        assert.equal(r.confident, true);
    });

    test('長的別名優先：「空間向量內積」不會被「向量內積」吃掉半截', () => {
        const r = parse('空間向量內積的計算題');
        assert.deepEqual(r.filters.chapters, ['空間向量內積']);
    });

    test('長的別名優先：「靜摩擦力」不會同時命中「摩擦力」兩次', () => {
        const r = parse('靜摩擦力的題目');
        assert.deepEqual(r.filters.chapters, ['摩擦力與向心力']);
        assert.deepEqual(r.filters.keywords, ['靜摩擦力']);
    });

    test('章節本名本身也認得', () => {
        const r = parse('電場與電位');
        assert.deepEqual(r.filters.chapters, ['電場與電位']);
        assert.equal(r.filters.subject, '物理');
    });

    test('多章依「在句子裡出現的順序」排列', () => {
        const a = parse('先問摩擦力再問牛頓第二定律');
        assert.deepEqual(a.filters.chapters, ['摩擦力與向心力', '牛頓運動定律']);
        const b = parse('先問牛頓第二定律再問摩擦力');
        assert.deepEqual(b.filters.chapters, ['牛頓運動定律', '摩擦力與向心力']);
    });

    test('subject 由第一個命中的章節反推；沒命中章節時為 null', () => {
        assert.equal(parse('向量內積').filters.subject, '數學');
        assert.equal(parse('浮力').filters.subject, '物理');
        assert.equal(parse('難度 3 的計算題').filters.subject, null);
    });

    test('解析出的章節一定過得了 isValidChapter', () => {
        const samples = ['對數', '力矩', '干涉', '克拉瑪法則', '半衰期', '常態分布', '斜率'];
        for (const q of samples) {
            const r = parse(q);
            assert.equal(r.filters.chapters.length, 1, `「${q}」應該命中一章`);
            assert.ok(isValidChapter(r.filters.subject, r.filters.chapters[0]));
        }
    });
});

describe('parseQuery：難度', () => {
    const cases = [
        ['難度 4 以上', 4, 5],
        ['難度4以上', 4, 5],
        ['難度 2 以下', 1, 2],
        ['難度 2~4', 2, 4],
        ['難度 2～4', 2, 4],
        ['難度 2 到 4', 2, 4],
        ['3 星', 3, 3],
        ['3星以上', 3, 5],
        ['5 星以下', 1, 5 - 0],   // 1~5
        ['難度 3', 3, 3],
        ['難度是 5', 5, 5]
    ];
    for (const [q, min, max] of cases) {
        test(`「${q}」→ ${min}~${max}`, () => {
            const r = parse(q);
            assert.equal(r.filters.difficulty_min, min);
            assert.equal(r.filters.difficulty_max, max);
        });
    }

    test('難度片段不會殘留在 semantic_text 裡', () => {
        for (const [q] of cases) {
            assert.equal(parse(q).semantic_text, '', `「${q}」的 semantic_text 應該是空的，實際是「${parse(q).semantic_text}」`);
        }
    });

    test('沒提到難度就是 null（不是 1 與 5）', () => {
        const r = parse('向量內積的計算題');
        assert.equal(r.filters.difficulty_min, null);
        assert.equal(r.filters.difficulty_max, null);
    });

    test('顛倒的區間會被正過來', () => {
        const r = parse('難度 4~2');
        assert.equal(r.filters.difficulty_min, 2);
        assert.equal(r.filters.difficulty_max, 4);
    });

    test('沒有「難度／星／級」當錨點的數字區間不被當成難度', () => {
        const r = parse('求 3~5 之間的整數解');
        assert.equal(r.filters.difficulty_min, null);
    });
});

describe('parseQuery：題型', () => {
    test('五種題型都認得', () => {
        for (const t of QUESTION_TYPES) {
            assert.deepEqual(parse(`${t}題`).filters.question_types, [t]);
        }
    });

    test('口語寫法：複選→多選、填充→填空、選擇題→單選', () => {
        assert.deepEqual(parse('複選題').filters.question_types, ['多選']);
        assert.deepEqual(parse('填充題').filters.question_types, ['填空']);
        assert.deepEqual(parse('選擇題').filters.question_types, ['單選']);
    });

    test('多個題型依白名單宣告順序排列（語序不影響結果）', () => {
        const a = parse('計算題或單選題');
        const b = parse('單選題或計算題');
        assert.deepEqual(a.filters.question_types, ['單選', '計算']);
        assert.deepEqual(a.filters.question_types, b.filters.question_types);
    });
});

describe('parseQuery：X 沒寫過', () => {
    const cases = ['小明沒寫過', '小明沒做過', '小明沒寫', '小明還沒寫過', '小明同學沒有寫過', '王小明沒做過'];
    for (const q of cases) {
        test(`「${q}」抓得到學生名`, () => {
            const r = parse(`向量內積，${q}`);
            assert.ok(r.filters.exclude_student_name, `「${q}」沒抓到`);
            assert.ok(q.startsWith(r.filters.exclude_student_name));
        });
    }

    test('學生名不會往前吃到章節', () => {
        const r = parse('摩擦力小明沒寫過');
        assert.equal(r.filters.exclude_student_name, '小明');
        assert.deepEqual(r.filters.chapters, ['摩擦力與向心力']);
        assert.equal(r.semantic_text, '摩擦力');
    });

    test('沒提到就是 null', () => {
        assert.equal(parse('向量內積的計算題').filters.exclude_student_name, null);
    });
});

describe('parseQuery：keywords 與 semantic_text', () => {
    test('keywords = 被吃掉的實詞（章節別名原文 + 題型）', () => {
        const r = parse('牛頓第二定律的計算題');
        assert.deepEqual(r.filters.keywords, ['牛頓第二定律', '計算']);
    });

    test('keywords 記的是「原文」而不是正規化後的章節名', () => {
        const r = parse('摩擦力');
        assert.deepEqual(r.filters.chapters, ['摩擦力與向心力']);
        assert.deepEqual(r.filters.keywords, ['摩擦力']);
    });

    test('完全沒章節時，剩餘概念詞進 semantic_text', () => {
        const r = parse('有沒有跟斜面上物體受力平衡有關的計算題');
        assert.equal(r.confident, false);
        assert.equal(r.semantic_text, '斜面上物體受力平衡');
    });

    test('口語套話被剝掉，學科名詞留著', () => {
        assert.equal(parse('幫我找一些關於熱傳導方式的題目').semantic_text, '熱傳導方式');
        assert.equal(parse('我想複習一下等加速度運動跟自由落體').semantic_text, '等加速度運動 自由落體');
    });

    test('命中的別名原文留在 semantic_text 裡，與前後自由文字以空白分段', () => {
        // 「雙狹縫」是「物理光學（干涉繞射）」的別名，「楊氏」「實驗」是自由文字。
        // 概念詞被抽掉的話這一句的向量查詢字串只剩「楊氏 實驗」，等於規則越準、檢索越差。
        const r = parse('楊氏雙狹縫實驗');
        assert.deepEqual(r.filters.chapters, ['物理光學（干涉繞射）']);
        assert.equal(r.semantic_text, '楊氏 雙狹縫 實驗');
    });

    test('虛詞只從頭尾剝，不動中間（「不等式」不會變成「等式」）', () => {
        // 「的」在 EDGE_FILLER 裡，但它出現在句子中間，必須原封不動留著
        assert.equal(parse('三角不等式的推導').semantic_text, '三角不等式的推導');
        // 頭尾才剝：「的」在尾巴就會被剝掉
        assert.equal(parse('三角不等式的').semantic_text, '三角不等式');
    });

    test('整句都被規則吃掉時 semantic_text 是空字串', () => {
        assert.equal(parse('難度 4 以上的計算題').semantic_text, '');
    });
});
