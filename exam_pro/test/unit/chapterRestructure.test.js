// ─────────────────────────────────────────────────────────────
// chapterRestructure.test.js — 數學／物理章節重整後的白名單與周邊（章節重整 CH-A；docs/chapter-restructure.md 第 3.1 條）
//
// 釘住的東西：
//   1. config/chapters.js 的數學／物理 VOLUMES 就是 config/chapterPlan.js 的 PLAN_VOLUMES（不重抄清單），化學不動；
//   2. MIGRATION 的舊→新對照自洽：舊章＝重整前的 34＋32 章、去處都在新白名單、純新增章與契約第 2 條一致；
//   3. 周邊跟著換：別名（拆分舊章的別名改指新章、刪除章的別名移除、改名舊章名收成別名）、
//      few-shot 例句（改名的章把例句搬過去）、分詞詞典（新章名與新名詞）、prompt 白名單、schema enum。
// 不連 DB、不連 LLM。執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PLAN_VOLUMES, PLAN_CHAPTERS, MIGRATION } = require('../../config/chapterPlan');
const { CHEMISTRY_VOLUMES } = require('../../config/chemistryChapters');
const {
    VOLUMES, CHAPTERS, SUBJECTS, LEGACY_SUBJECTS, LEGACY_CHAPTERS, volumeOf, isValidChapter
} = require('../../config/chapters');
const aliases = require('../../config/chapterAliases');
const { CHAPTER_EXAMPLES, getChapterExample } = require('../../config/chapterExamples');
const { tokenize, MATH_PHYSICS_TERMS } = require('../../utils/tokenize');
const { parseQuery, isChemistryOnlyQuery } = require('../../utils/nlqHeuristics');
const { chapterWhitelistText } = require('../../agents/promptParts');
const nlq = require('../../services/nlqService');
const { buildSchema } = require('../../agents/schemas');

/** 重整前被改名、拆掉名字或刪除的舊章（新白名單裡已經沒有） */
const GONE = {
    '數學': ['多項式除法', '三次函數', '數列與級數', '三角函數的定義', '矩陣的加減與乘法', '克拉瑪公式'],
    '物理': ['宇宙學簡介', '流體的壓力與浮力']
};
const parse = (text) => parseQuery(text, { aliases: aliases.CHAPTER_ALIASES });

describe('config/chapters.js 改讀 chapterPlan（第 3.1 條第 1 點）', () => {
    test('數學／物理的 VOLUMES 就是 PLAN_VOLUMES；化學仍是 chemistryChapters 的 44 章', () => {
        assert.equal(VOLUMES['數學'], PLAN_VOLUMES['數學']);
        assert.equal(VOLUMES['物理'], PLAN_VOLUMES['物理']);
        assert.equal(VOLUMES['化學'], CHEMISTRY_VOLUMES);
        assert.deepEqual(SUBJECTS, ['數學', '物理', '化學']);
        assert.deepEqual(CHAPTERS['數學'], PLAN_CHAPTERS['數學']);
        assert.deepEqual(CHAPTERS['物理'], PLAN_CHAPTERS['物理']);
        assert.equal(CHAPTERS['數學'].length, 52);
        assert.equal(CHAPTERS['物理'].length, 34);
        assert.equal(CHAPTERS['化學'].length, 44);
    });

    test('LEGACY_*＝數學／物理這一組的值域：數學各冊 → 物理各冊，共 86 章', () => {
        assert.deepEqual(LEGACY_SUBJECTS, ['數學', '物理']);
        assert.deepEqual(LEGACY_CHAPTERS, [...PLAN_CHAPTERS['數學'], ...PLAN_CHAPTERS['物理']]);
        assert.equal(LEGACY_CHAPTERS.length, 86);
    });

    test('被刪、被改名或拆掉名字的舊章不再合法；新章合法', () => {
        for (const [s, list] of Object.entries(GONE)) for (const c of list) assert.equal(isValidChapter(s, c), false, c);
        for (const c of ['拋物線', '線性規劃', '條件機率與貝氏定理', '多項式的運算與應用']) assert.equal(isValidChapter('數學', c), true, c);
        for (const c of ['電與磁的統一', '測量與不確定度', '質心與角動量', '理想氣體與氣體動力論']) assert.equal(isValidChapter('物理', c), true, c);
    });

    test('物理五章換冊、章名不變（簡諧運動、重力場、動量兩章、電流與電路）', () => {
        assert.equal(volumeOf('物理', '簡諧運動(SHM)'), '選修物理一');
        assert.equal(volumeOf('物理', '重力場與重力位能'), '選修物理一');
        assert.equal(volumeOf('物理', '動量與衝量'), '選修物理二');
        assert.equal(volumeOf('物理', '動量守恆與碰撞'), '選修物理二');
        assert.equal(volumeOf('物理', '電流與電路'), '選修物理五');
        assert.equal(volumeOf('數學', '拋物線'), '選修數學');
    });
});

describe('MIGRATION 舊→新對照自洽', () => {
    test('舊章＝重整前的數學 34 章＋物理 32 章；每個去處都在新白名單', () => {
        assert.equal(Object.keys(MIGRATION['數學']).length, 34);
        assert.equal(Object.keys(MIGRATION['物理']).length, 32);
        for (const s of ['數學', '物理']) {
            for (const [old, m] of Object.entries(MIGRATION[s])) {
                assert.ok(['same', 'rename', 'split', 'removed'].includes(m.kind), `${old}：${m.kind}`);
                for (const t of m.to) assert.ok(PLAN_CHAPTERS[s].includes(t), `${s}「${old}」的去處「${t}」不在新白名單`);
                if (m.kind === 'same') assert.deepEqual(m.to, [old]);
                if (m.kind === 'rename') assert.equal(m.to.length, 1);
                if (m.kind === 'split') assert.ok(m.to.length >= 2, old);
            }
        }
        for (const [s, list] of Object.entries(GONE)) for (const c of list) assert.ok(MIGRATION[s][c], c);
    });

    test('純新增、沒有舊題會搬入的章：數學 4 章（〔CR-8〕線性規劃改由直線方程式拆出）；物理 3 章', () => {
        const pureNew = s => PLAN_CHAPTERS[s].filter(c => !Object.values(MIGRATION[s]).some(m => m.to.includes(c)));
        assert.deepEqual(pureNew('數學'), ['複數的幾何意涵', '拋物線', '橢圓', '雙曲線']);
        assert.deepEqual(pureNew('物理'), ['電與磁的統一', '測量與不確定度', '理想氣體與氣體動力論']);
    });
});

describe('別名（第 3.1 條第 2 點）', () => {
    test('指向被拆分舊章的別名改指到正確的新章（契約舉的四個例子）', () => {
        assert.equal(aliases.CHAPTER_ALIASES['和角公式'], '和角與差角公式');
        assert.equal(aliases.CHAPTER_ALIASES['條件機率'], '條件機率與貝氏定理');
        // 〔CR-8〕「複數」會吞掉「複數平面」，改收較窄的詞；複數平面歸複數的幾何意涵
        assert.equal(aliases.CHAPTER_ALIASES['虛數'], '複數與多項式方程式');
        assert.equal(aliases.CHAPTER_ALIASES['複數平面'], '複數的幾何意涵');
        // 「二項式定理」已經是章名：不再是「組合」的別名，由 parseQuery 的章節本名表直接認得
        assert.equal(aliases.CHAPTER_ALIASES['二項式定理'], undefined);
        assert.deepEqual(parse('二項式定理的題目').filters.chapters, ['二項式定理']);
        assert.ok(!aliases.ALIASES_BY_CHAPTER['組合'].includes('二項式定理'));
    });

    test('〔CR-8〕跨章別名依知識點歸屬：對數分冊、巴斯卡在組合、動能不吞分子平均動能', () => {
        const expect = {
            '常用對數': '指數與對數', '對數方程式': '指數函數與對數函數', '對數函數': '指數函數與對數函數',
            '指數方程式': '指數函數與對數函數', '換底公式': '指數函數與對數函數',
            '巴斯卡公式': '組合', '巴斯卡三角形': '組合', '分子平均動能': '理想氣體與氣體動力論',
            '質能互換': '能量的形式與守恆', '空間柯西不等式': '空間向量內積'
        };
        for (const [a, c] of Object.entries(expect)) assert.equal(aliases.CHAPTER_ALIASES[a], c, a);
        for (const gone of ['對數', 'log', '三角函數', '三角形面積', '複數', '動能']) {
            assert.equal(aliases.CHAPTER_ALIASES[gone], undefined, `「${gone}」跨章，不應再是別名`);
        }
    });

    test('其他拆分後的別名去處', () => {
        const expect = {
            '倍角公式': '和角與差角公式', '疊合': '三角函數的疊合', '二項分布': '二項分布與幾何分布',
            '轉移矩陣': '矩陣的應用', '角動量': '質心與角動量', '有效數字': '測量與不確定度',
            '象限角': '廣義角與極坐標', '弧度量': '三角函數的圖形', '三角函數圖形': '三角函數的圖形',
            '級數求和': '級數', '等差數列': '數列與遞迴關係', '克拉瑪法則': '面積與行列式',
            '三元一次聯立方程式': '一次方程組', '二次不等式': '多項式不等式'
        };
        for (const [a, c] of Object.entries(expect)) assert.equal(aliases.CHAPTER_ALIASES[a], c, a);
    });

    test('改名／拆掉名字的舊章名收成別名（老師照舊習慣打字仍查得到）', () => {
        assert.equal(aliases.CHAPTER_ALIASES['多項式除法'], '多項式的運算與應用');
        assert.equal(aliases.CHAPTER_ALIASES['三次函數'], '多項式函數的圖形');
        assert.equal(aliases.CHAPTER_ALIASES['矩陣的加減與乘法'], '矩陣的運算');
        assert.equal(aliases.CHAPTER_ALIASES['克拉瑪公式'], '面積與行列式');
        assert.deepEqual(parse('多項式除法的計算題').filters.chapters, ['多項式的運算與應用']);
    });

    test('被刪的物理章：章名不在別名表，舊別名一併移除', () => {
        for (const c of GONE['物理']) assert.equal(aliases.ALIASES_BY_CHAPTER[c], undefined, c);
        for (const a of ['浮力', '阿基米德', '液體壓力', '帕斯卡原理', '宇宙膨脹', '大霹靂', '哈伯定律', '宇宙學']) {
            assert.equal(aliases.CHAPTER_ALIASES[a], undefined, a);
        }
        assert.deepEqual(parse('浮力').filters.chapters, []);
    });

    test('新章每章至少 3 個別名，規則路徑查得到', () => {
        const expect = {
            '拋物線的準線': '拋物線', '雙曲線的漸近線': '雙曲線', '線性規劃的目標函數': '線性規劃',
            '棣美弗定理': '複數的幾何意涵', '貝氏定理': '條件機率與貝氏定理', '文氏圖': '集合與計數原理',
            '高斯消去法': '一次方程組', '馬克士威': '電與磁的統一', '因次分析': '測量與不確定度',
            '氣體動力論': '理想氣體與氣體動力論', '質心運動': '質心與角動量'
        };
        for (const [text, chapter] of Object.entries(expect)) {
            const r = parse(text);
            assert.equal(r.filters.chapters[0], chapter, text);
            assert.equal(r.confident, true, text);
        }
    });
});

describe('few-shot 例句（第 3.1 條第 3 點）', () => {
    test('例句的章與新白名單逐章相同（同序）；被刪、改名的舊章沒有例句', () => {
        assert.deepEqual(Object.keys(CHAPTER_EXAMPLES['數學']), PLAN_CHAPTERS['數學']);
        assert.deepEqual(Object.keys(CHAPTER_EXAMPLES['物理']), PLAN_CHAPTERS['物理']);
        for (const [s, list] of Object.entries(GONE)) for (const c of list) assert.equal(getChapterExample(s, c), '', c);
    });

    test('改名的章把原例句搬過去；拆分章依題意分給新章', () => {
        assert.equal(getChapterExample('數學', '多項式的運算與應用'), '以綜合除法求 $x^3-2x^2+5$ 除以 $x-3$ 的商式與餘式。');
        assert.equal(getChapterExample('數學', '級數'), '等差數列首項為 $3$、公差為 $4$，求前 $20$ 項的和。');
        assert.equal(getChapterExample('數學', '二項分布與幾何分布'), '隨機變數 $X$ 服從 $n=5$、$p=0.4$ 的二項分布，求 $E(X)$ 與變異數。');
    });

    test('新章例句各不相同（沒有複製貼上），而且沒有教材版權標記', () => {
        const all = [...Object.values(CHAPTER_EXAMPLES['數學']), ...Object.values(CHAPTER_EXAMPLES['物理'])];
        assert.equal(new Set(all).size, all.length);
        for (const e of all) assert.ok(!/龍騰|翰林|南一|康熹|學測|指考|分科/.test(e), e);
    });
});

describe('分詞詞典（第 3.1 條第 4 點）', () => {
    test('新章名與拆出的子詞切得出來', () => {
        const toks = tokenize('條件機率與貝氏定理、二項分布與幾何分布、拋物線的準線、質心與角動量');
        for (const w of ['條件機率與貝氏定理', '二項分布與幾何分布', '拋物線', '準線', '質心與角動量']) {
            assert.ok(toks.includes(w), `${w}：${JSON.stringify(toks)}`);
        }
        const sub = tokenize('先講條件機率，再講貝氏定理');
        assert.ok(sub.includes('條件機率') && sub.includes('貝氏定理'), JSON.stringify(sub));
    });

    test('新名詞切得出來（題幹常見、不是章名的詞）', () => {
        const toks = tokenize('角的終邊落在第二象限，以棣美弗定理與漸近線討論，再做因次分析');
        for (const w of ['棣美弗定理', '漸近線', '因次分析']) assert.ok(toks.includes(w), `${w}：${JSON.stringify(toks)}`);
        assert.ok(tokenize('標準位置角的三角比').includes('三角比'));
        assert.ok(tokenize('第二象限角').includes('象限角'));
    });

    test('只收數理專用詞：化學也常用的詞不進 MATH_PHYSICS_TERMS（NLQ 的科目判斷）', () => {
        for (const w of ['理想氣體', '絕對溫度', '有效數字', '電磁波', '方均根速率']) assert.ok(!MATH_PHYSICS_TERMS.includes(w), w);
        assert.equal(new Set(MATH_PHYSICS_TERMS).size, MATH_PHYSICS_TERMS.length, 'MATH_PHYSICS_TERMS 有重複詞');
        // 跨科詞仍然進詞典（切得出來），只是不算數理線索
        const toks = tokenize('電磁波與方均根速率');
        assert.ok(toks.includes('電磁波') && toks.includes('方均根速率'), JSON.stringify(toks));
    });

    test('跨科詞不收成物理別名：明寫化學的查詢不會被改判成物理（與重整前相同）', () => {
        const opts = { mathPhysicsTerms: MATH_PHYSICS_TERMS };
        for (const a of ['電磁波', '電磁波譜', '方均根速率']) assert.equal(aliases.CHAPTER_ALIASES[a], undefined, a);
        const r1 = parse('化學 電磁波的計算');
        assert.deepEqual(r1.filters.chapters, []);
        assert.equal(isChemistryOnlyQuery('化學 電磁波的計算', opts), true);
        const r2 = parse('光譜與電磁波 莫耳');
        assert.deepEqual(r2.filters.chapters, ['原子量與莫耳']);
        assert.equal(r2.filters.subject, '化學');
        assert.deepEqual(parse('方均根速率 化學').filters.chapters, []);
        // 物理的講法照樣走規則路徑
        assert.deepEqual(parse('馬克士威預測了電磁波').filters.chapters, ['電與磁的統一']);
    });
});

describe('prompt 白名單與 schema enum（第 3.1 條第 5 點）', () => {
    test('promptParts：沒指定科目時列出新的兩科清單，沒有舊章名', () => {
        const text = chapterWhitelistText();
        for (const c of [...PLAN_CHAPTERS['數學'], ...PLAN_CHAPTERS['物理']]) assert.ok(text.includes(c), c);
        for (const c of [...GONE['數學'], ...GONE['物理']]) assert.ok(!text.includes(c), c);
    });

    test('nlqService：送 LLM 的白名單是新清單', () => {
        const text = nlq.chapterWhitelistText();
        assert.ok(text.includes(`數學：${PLAN_CHAPTERS['數學'].join('、')}`));
        assert.ok(text.includes(`物理：${PLAN_CHAPTERS['物理'].join('、')}`));
        for (const c of [...GONE['數學'], ...GONE['物理']]) assert.ok(!text.includes(c), c);
    });

    test('extract／classify／variant／nlq 的 chapter enum 是新的 86 章', () => {
        for (const name of ['extract', 'classify', 'variant']) {
            const s = buildSchema(name);
            const enumOf = (node) => {
                if (!node || typeof node !== 'object') return null;
                if (node.properties && node.properties.chapter && node.properties.chapter.enum) return node.properties.chapter.enum;
                for (const v of Object.values(node)) { const r = enumOf(v); if (r) return r; }
                return null;
            };
            assert.deepEqual(enumOf(s), LEGACY_CHAPTERS, name);
        }
        const nlqSchema = JSON.stringify(buildSchema('nlq'));
        assert.ok(nlqSchema.includes('拋物線') && !nlqSchema.includes('宇宙學簡介'));
    });
});
