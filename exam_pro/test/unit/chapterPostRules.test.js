// utils/chapterPostRules.js 與它在 agents/classify.js、services/nlqService.js 的接線（dec/local-classify-nlq-prep）
//
// 每條界線規則都有「該觸發」與「不該觸發」的例句；例句是自撰的，不取自 golden（golden 上的效果見 localV1Regression.test.js）。
// 另有一組「不誤觸」：知識點（config/kc）的名稱與說明、各章例句、fixture 題、classify golden 題幹——
// 屬於規則 from 那一章的文字，規則一律不得觸發（否則模型答對的題會被程式改錯）。
// 執行：npm test（不連 DB、不呼叫模型）。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pr = require('../../utils/chapterPostRules');
const { CHAPTERS, isValidChapter } = require('../../config/chapters');
const { KEYWORD_RULES } = require('../../config/chapterMigrationRules');
const classify = require('../../agents/classify');
const nlq = require('../../services/nlqService');

const ROOT = path.resolve(__dirname, '..', '..');

describe('規則表', () => {
    test('每條規則的 from／to 是同一科的兩個不同白名單章；每個 from 只屬於一條規則；都寫了出處', () => {
        const froms = new Set();
        for (const rule of pr.RULES) {
            const subject = ['數學', '物理'].find(s => isValidChapter(s, rule.from));
            assert.ok(subject, `${rule.id} 的 from「${rule.from}」不是數學或物理的章`);
            assert.ok(isValidChapter(subject, rule.to), `${rule.id} 的 to「${rule.to}」不在${subject}`);
            assert.notEqual(rule.from, rule.to);
            assert.ok(!froms.has(rule.from), `「${rule.from}」有兩條規則（先後順序會變成語意）`);
            froms.add(rule.from);
            assert.ok(typeof rule.source === 'string' && rule.source.length > 10, `${rule.id} 要寫出處`);
            assert.equal(typeof rule.test, 'function');
        }
        assert.deepEqual(pr.RULES.map(r => r.id), [
            'exp_log_third', 'exp_log_first',
            'dimension_space', 'dimension_plane', 'dimension_space', 'dimension_plane',
            'field_potential', 'coulomb', 'relative_1d', 'relative_2d', 'free_fall_computation'
        ]);
    });

    test('第三冊的關鍵字直接取自舊題搬章的規則表（不另抄一份）', () => {
        const fromMigration = KEYWORD_RULES['數學'].filter(r => r.to === '指數函數與對數函數').flatMap(r => r.keywords || []);
        assert.deepEqual([...pr.THIRD_VOLUME_KEYWORDS], fromMigration);
        assert.ok(pr.THIRD_VOLUME_KEYWORDS.includes('換底') && pr.THIRD_VOLUME_KEYWORDS.includes('指數方程式'));
    });
});

describe('A5：指數與對數（第一冊）／指數函數與對數函數（第三冊）', () => {
    test('第三冊的證據：底數不是 10、ln、換底等關鍵字、要解出指數或真數裡的未知數', () => {
        const cases = [
            ['求 $\\log_{7} 49$ 的值。', '\\log_{7}'],
            ['化簡 $\\log_3 5 \\cdot \\log_5 9$。', '\\log_3'],
            ['求 $\\ln e^{2}$。', '\\ln'],
            ['利用換底公式把 $\\log 12$ 化成以 2 為底。', '換底'],
            ['畫出指數函數 $y=3^x$ 的圖形並說明其漸近線。', '指數函數'],
            ['某放射性物質的半衰期為 5 年，求 20 年後剩下多少。', '半衰期'],
            ['解不等式 $5^{x-2} < 125$。', '5^{x-2}（解）'],
            ['若 $\\left(\\frac{1}{3}\\right)^{t} = 27$，求 $t$ 的值。', ')^{t}（求 $t）'],
            ['解方程式 $\\log (x+3) = 2$。', '\\log (x+3)（解）']
        ];
        for (const [text, evidence] of cases) assert.equal(pr.thirdVolumeEvidence(text), evidence, text);
    });

    test('不是第三冊：常用對數、指數律（未知數不必解出來）、底數是字母、定義域的不等號', () => {
        for (const text of [
            '已知 $\\log 3 \\approx 0.4771$，求 $3^{40}$ 是幾位數。',
            '求 $\\log_{10} 4 + \\log_{10} 25$ 之值。',
            '已知 $5^{x}=2$，求 $25^{x}+125^{x}$ 的值。',
            '若 $a^{3x}=2$，求 $a^{6x}$ 之值。',
            '當 $x>0$ 時，$\\log x$ 才有意義。',
            '了解指數律並化簡 $8^{\\frac{2}{3}}$。'
        ]) {
            assert.equal(pr.thirdVolumeEvidence(text), null, text);
        }
    });

    test('第一冊的證據：首數、尾數、位數、科學記號、常用對數；有第三冊題材時不算', () => {
        assert.equal(pr.firstVolumeEvidence('求 $\\log 0.0072$ 的首數與尾數。'), '首數');
        assert.equal(pr.firstVolumeEvidence('把 $0.000081$ 寫成科學記號。'), '科學記號');
        assert.equal(pr.firstVolumeEvidence('已知 $\\log 7 \\approx 0.8451$，$7^{30}$ 是幾位數？'), '位數');
        assert.equal(pr.firstVolumeEvidence('對數函數 $y=\\log x$ 的圖形與首數的關係'), null, '有函數／圖形');
        assert.equal(pr.firstVolumeEvidence('$\\log_{2} 1024$ 是幾位數？'), null, '底數不是 10');
        assert.equal(pr.firstVolumeEvidence('化簡 $8^{\\frac{2}{3}}$。'), null, '沒有第一冊的明確題材就不換（指數律本身兩冊都可能出現）');
    });

    test('boundaryTarget：只在模型挑了 from 的那一章時才換', () => {
        const text = '求 $\\log_{7} 49$ 的值。';
        assert.deepEqual(
            (({ to, rule, evidence }) => ({ to, rule, evidence }))(pr.boundaryTarget('指數與對數', text)),
            { to: '指數函數與對數函數', rule: 'exp_log_third', evidence: '\\log_{7}' }
        );
        assert.equal(pr.boundaryTarget('指數函數與對數函數', text), null, '已經是第三冊');
        assert.equal(pr.boundaryTarget('數列與遞迴關係', text), null, '不是這一對的章不碰');
        assert.equal(pr.boundaryTarget('指數函數與對數函數', '求 $\\log 0.0072$ 的首數與尾數。').to, '指數與對數');
    });
});

describe('平面／空間（向量內積、直線方程式）', () => {
    test('坐標分量的個數（半形、全形括號與逗號都認得；選項代號不算）', () => {
        assert.deepEqual(pr.coordinateTuples('點 $P(2,-1,4)$ 與 $Q(0,3,1)$'), { two: null, three: '(2,-1,4)' });
        assert.deepEqual(pr.coordinateTuples('$\\vec{u}=(3, k)$'), { two: '(3, k)', three: null });
        assert.deepEqual(pr.coordinateTuples('向量（1，2）'), { two: '（1，2）', three: null });
        assert.deepEqual(pr.coordinateTuples('(A) 1　(B) 2'), { two: null, three: null });
    });

    test('平面或空間：文字線索＋坐標；互相矛盾或兩種都有時不判斷', () => {
        assert.equal(pr.dimensionEvidence('點 $P(2,-1,4)$ 的位置向量與 $(0,0,1)$ 的內積').dimension, 'space');
        assert.equal(pr.dimensionEvidence('三維空間中兩向量互相垂直').dimension, 'space');
        assert.equal(pr.dimensionEvidence('坐標平面上 $\\vec{u}=(3, k)$ 與 $(1,2)$ 垂直').dimension, 'plane');
        assert.equal(pr.dimensionEvidence('$\\vec{u}=(3, 1)$ 與 $\\vec{v}=(1, 2)$ 的夾角').dimension, 'plane');
        assert.equal(pr.dimensionEvidence('空間中 $(1,2)$ 與 $(3,4)$'), null, '說空間卻只有二維坐標');
        assert.equal(pr.dimensionEvidence('$(1,2)$ 與 $(1,2,3)$'), null, '兩種坐標都有');
        assert.equal(pr.dimensionEvidence('直線在平面上，求直線與平面的交點'), null, '題幹的「平面上」常是空間單元的題材，不算平面線索');
        assert.equal(pr.dimensionEvidence('兩向量的內積為零代表什麼'), null);
    });

    test('向量內積 ↔ 空間向量內積、直線方程式 ↔ 空間直線方程式', () => {
        assert.equal(pr.boundaryTarget('向量內積', '點 $P(2,-1,4)$ 的位置向量與 $(0,0,1)$ 的內積').to, '空間向量內積');
        assert.equal(pr.boundaryTarget('空間向量內積', '$\\vec{u}=(3, 1)$ 與 $\\vec{v}=(1, 2)$ 的夾角').to, '向量內積');
        assert.equal(pr.boundaryTarget('直線方程式', '空間中過點 $(1,0,2)$、方向向量 $(2,1,1)$ 的直線').to, '空間直線方程式');
        assert.equal(pr.boundaryTarget('向量內積', '兩向量的內積為零代表什麼'), null);
        assert.equal(pr.boundaryTarget('向量內積', '點 $P(2,-1,4)$ 的內積', { skipDimension: true }), null, 'nlq 略過（它有自己的平面／空間對齊）');
    });
});

describe('物理的三組界線', () => {
    test('靜電學 → 電場與電位：電位差、電位能、作功、電力線、等位面（有庫侖就不換）', () => {
        assert.equal(pr.boundaryTarget('靜電學', '兩平行板間的電位差為 12 V，求板間的電場。').to, '電場與電位');
        assert.equal(pr.boundaryTarget('靜電學', '畫出正電荷周圍的電力線與等位線。').to, '電場與電位');
        assert.equal(pr.boundaryTarget('靜電學', '外力把電荷從 A 移到 B 作了多少功？').to, '電場與電位');
        assert.equal(pr.boundaryTarget('靜電學', '兩點電荷間的庫侖力，以及系統的電位能。'), null);
        assert.equal(pr.boundaryTarget('靜電學', '帶電玻璃棒靠近金屬球後接地，球帶什麼電？'), null);
    });

    test('電場與電位 → 靜電學：只問兩電荷之間的庫侖力（有電場、電位就不換）', () => {
        assert.equal(pr.boundaryTarget('電場與電位', '兩點電荷相距 3 m，求兩者間的庫侖力。').to, '靜電學');
        assert.equal(pr.boundaryTarget('電場與電位', '利用庫侖定律推導點電荷的電場。'), null);
    });

    test('K2：相對速度一維 → 直線運動、二維 → 平面運動；只有上下一條軸、或沒有「相對」時不判斷', () => {
        assert.deepEqual(pr.relativeMotionEvidence('甲以 5 m/s 向北、乙以 3 m/s 向南，求甲相對於乙的速度。'), { dimension: 1, evidence: '北' });
        assert.deepEqual(pr.relativeMotionEvidence('兩車同向行駛，求後車相對前車的速度。'), { dimension: 1, evidence: '同向' });
        assert.equal(pr.relativeMotionEvidence('船頭垂直河岸行駛，求船相對於岸的速度。').dimension, 2);
        assert.equal(pr.relativeMotionEvidence('雨滴鉛直落下、車向東行駛，求雨滴相對於車的速度。').dimension, 2);
        assert.equal(pr.relativeMotionEvidence('飛機向東北飛，求相對於地面的速度。').dimension, 2);
        assert.equal(pr.relativeMotionEvidence('電梯向上等速運動，球相對電梯靜止。'), null, '只有上下一條軸');
        assert.equal(pr.relativeMotionEvidence('甲車向東行駛 20 m/s。'), null, '沒有相對');
        assert.equal(pr.boundaryTarget('平面運動', '甲以 5 m/s 向北、乙以 3 m/s 向南，求甲相對於乙的速度。').to, '直線運動');
        assert.equal(pr.boundaryTarget('直線運動', '船頭垂直河岸行駛，求船相對於岸的速度。').to, '平面運動');
    });

    test('第 8.0 節第三條：自由落體、上拋給了數值又要求數值 → 直線運動；只問觀念不換', () => {
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '球以 20 m/s 鉛直上拋，求最高點的高度。').to, '直線運動');
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '石頭自 80 m 高處自由落下，幾秒後落地？').to, '直線運動');
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '自由落體的加速度和物體的質量有沒有關係？'), null);
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '下列關於自由落體的敘述何者正確？(A) 第 1 秒內…'), null);
    });
});

describe('名稱容錯', () => {
    test('只差空白、引號、全形半形、開頭的冊名 → 對回白名單；對不到或跨科 → null', () => {
        assert.equal(pr.canonicalChapter('物理', '物體的運動(速度與加速度)'), '物體的運動（速度與加速度）');
        assert.equal(pr.canonicalChapter('數學', '「向量內積」'), '向量內積');
        assert.equal(pr.canonicalChapter('數學', ' 向量 內積 '), '向量內積');
        assert.equal(pr.canonicalChapter('數學', '第三冊指數函數與對數函數'), '指數函數與對數函數');
        assert.equal(pr.canonicalChapter('數學', '向量內積'), '向量內積', '本來就合法的原樣回傳');
        assert.equal(pr.canonicalChapter('數學', '平面向量'), null);
        assert.equal(pr.canonicalChapter('數學', '靜電學'), null, '跨科照樣不對');
        assert.equal(pr.canonicalChapter('數學', null), null);
        assert.equal(pr.canonicalChapter('數學', ''), null);
        assert.equal(pr.canonicalChapter('不存在', '向量內積'), null);
    });

    test('科目不知道時在三科裡找，恰好一科對得到才回（化學章名含頓號）', () => {
        const chem = CHAPTERS['化學'].find(c => c.includes('、'));
        assert.ok(chem);
        assert.equal(pr.canonicalChapterAny(null, `「${chem}」`), chem);
        assert.equal(pr.canonicalChapterAny(null, '「向量內積」'), '向量內積');
        assert.equal(pr.canonicalChapterAny('數學', '「靜電學」'), null, '給了科目就只在那一科找');
        assert.equal(pr.canonicalChapterAny(null, '不存在的章'), null);
    });
});

describe('alignChapters（nlq 的多章清單）', () => {
    test('換過去的章已經列了就不換；順序不變、去重；沒有證據不動', () => {
        const q = '求 2 的 40 次方是幾位數';
        assert.deepEqual(pr.alignChapters(['指數函數與對數函數'], q), {
            chapters: ['指數與對數'],
            changes: [{ from: '指數函數與對數函數', to: '指數與對數', rule: 'exp_log_first', evidence: '位數' }]
        });
        assert.deepEqual(pr.alignChapters(['指數函數與對數函數', '指數與對數'], q).chapters, ['指數函數與對數函數', '指數與對數']);
        assert.deepEqual(pr.alignChapters(['數列與遞迴關係', '數列與遞迴關係'], q), { chapters: ['數列與遞迴關係'], changes: [] });
        assert.deepEqual(pr.alignChapters([], q), { chapters: [], changes: [] });
        assert.deepEqual(pr.alignChapters(undefined, q), { chapters: [], changes: [] });
    });
});

describe('不誤觸：屬於 from 那一章的文字，規則一律不觸發', () => {
    test('知識點名稱與說明、各章例句、fixture 題、classify golden 題幹', () => {
        const texts = [];
        for (const subject of ['數學', '物理']) {
            const kc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kc', `${subject}.json`), 'utf8'));
            const items = Array.isArray(kc) ? kc : (kc.kcs || kc.items || Object.values(kc).find(Array.isArray) || []);
            assert.ok(items.length > 100, `${subject} 的知識點要讀得到`);
            for (const k of items) texts.push({ tag: k.code, chapter: k.chapter, text: [k.name, k.description, (k.aliases || []).join(' ')].join(' ') });
        }
        const { CHAPTER_EXAMPLES } = require('../../config/chapterExamples');
        for (const subject of ['數學', '物理']) {
            for (const [chapter, text] of Object.entries(CHAPTER_EXAMPLES[subject])) texts.push({ tag: `例句 ${chapter}`, chapter, text });
        }
        const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'fixtures', 'questions.public.json'), 'utf8')).questions;
        for (const q of fixture) texts.push({ tag: `fixture #${q.id}`, chapter: q.chapter, text: `${q.question_text} ${q.answer_text || ''}` });
        const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'golden', 'classify.json'), 'utf8')).entries;
        for (const e of golden) texts.push({ tag: e.id, chapter: e.chapter, text: e.question_text });

        const misfires = [];
        let checked = 0;
        for (const t of texts) {
            const hit = pr.boundaryTarget(t.chapter, t.text);
            if (pr.RULES.some(r => r.from === t.chapter)) checked += 1;
            if (hit) misfires.push(`${t.tag}（${t.chapter} → ${hit.to}，證據「${hit.evidence}」）`);
        }
        assert.ok(checked > 80, `量尺自我檢查：屬於 from 章的文字要夠多（${checked}）`);
        assert.deepEqual(misfires, []);
    });
});

// ───────────────── agents/classify.js 的接線 ─────────────────

function classifyCtx(data) {
    const calls = [];
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    return { data, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 }, latencyMs: 1, raw: null };
                }
            },
            db: null,
            job: { id: 1, budget_usd: 1, cost_usd: 0 },
            jq: { id: 1, idx: 1, payload: {}, retries: {} },
            logger: { info() {}, warn() {}, error() {} },
            config: { models: { extract: 'ollama:qwen3-vl:8b', text: 'ollama:qwen3:8b' }, thresholds: { classifyMinConf: 0.8 }, features: {} },
            signal: undefined
        }
    };
}

describe('agents/classify.js：第二層的章節後處理', () => {
    test('界線規則換章：chapter、adjustments、rationale 前面的說明；cacheKeyParts 與模板不變', async () => {
        const { ctx, calls } = classifyCtx({ chapter: '指數與對數', confidence: 0.95, rationale: '用到對數律。' });
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '求 $\\log_{7} 49$ 的值。' });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.chapter, '指數函數與對數函數');
        assert.equal(outcome.data.source, 'llm');
        assert.equal(outcome.data.confidence, 0.95, '信心照模型給的');
        assert.deepEqual(outcome.data.adjustments, [{ rule: 'exp_log_third', from: '指數與對數', to: '指數函數與對數函數', evidence: '\\log_{7}' }]);
        assert.equal(outcome.data.rationale, '〔界線規則：模型選「指數與對數」，依題幹的「\\log_{7}」改為「指數函數與對數函數」〕用到對數律。');
        assert.equal(calls[0].template, 'classify.v2');
        assert.deepEqual(Object.keys(calls[0].cacheKeyParts), ['template', 'questionText', 'fewShotIds'], '鍵的組成不變');
    });

    test('沒有改的題：outcome.data 的鍵與改版前逐一相同（沒有 adjustments）、rationale 原樣', async () => {
        const { ctx } = classifyCtx({ chapter: '向量內積', confidence: 0.9, rationale: '夾角公式。' });
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求夾角。' });
        assert.deepEqual(Object.keys(outcome.data), ['chapter', 'confidence', 'rationale', 'source', 'few_shot_ids']);
        assert.equal(outcome.data.rationale, '夾角公式。');
    });

    test('名稱容錯：「」包起來的章名對回白名單並記一筆；對不到的照舊 chapter_invalid（feedback 用模型原字）', async () => {
        const ok = classifyCtx({ chapter: '「向量內積」', confidence: 0.9, rationale: 'r' });
        const passed = await classify.run(ok.ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '設 $\\vec{a}=(1,2)$，求長度。' });
        assert.equal(passed.kind, 'pass');
        assert.equal(passed.data.chapter, '向量內積');
        assert.deepEqual(passed.data.adjustments, [{ rule: 'chapter_name', from: '「向量內積」', to: '向量內積' }]);
        assert.equal(passed.data.rationale, 'r', '只改名稱不加說明');

        const bad = classifyCtx({ chapter: '「平面向量」', confidence: 0.9, rationale: 'r' });
        const failed = await classify.run(bad.ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '設 $\\vec{a}=(1,2)$，求長度。' });
        assert.equal(failed.reason, 'chapter_invalid');
        assert.match(failed.feedback, /^「「平面向量」」不在白名單內/);
    });

    test('零成本閘門不套用（拆題模型給的章照舊直接採用；見決策草稿 LC-3）', async () => {
        const { ctx, calls } = classifyCtx({});
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '指數與對數', chapter_confidence: 0.9, question_text: '求 $\\log_{7} 49$ 的值。' });
        assert.equal(outcome.data.source, 'gate');
        assert.equal(outcome.data.chapter, '指數與對數');
        assert.equal(calls.length, 0);
    });

    test('化學題：界線規則全是數學／物理的章，不會動到化學', async () => {
        const chem = CHAPTERS['化學'][0];
        const { ctx } = classifyCtx({ chapter: chem, confidence: 0.9, rationale: 'r' });
        const outcome = await classify.run(ctx, { subject: '化學', chapter: '', chapter_confidence: 0, question_text: '電位差與等位面（刻意放物理的證據字）' });
        assert.equal(outcome.data.chapter, chem);
        assert.equal(outcome.data.adjustments, undefined);
    });
});

// ───────────────── services/nlqService.js 的接線 ─────────────────

describe('services/nlqService.js：名稱容錯與界線規則', () => {
    test('validateFilters：章名的空白、引號、全形半形與「計算題」這類題型寫法對回白名單，不附警告', () => {
        const { filters, warnings } = nlq.validateFilters({
            subject: '物理', chapters: ['「物體的運動(速度與加速度)」'], question_types: ['計算題', ' 填充 '],
            difficulty_min: null, difficulty_max: null, keywords: []
        });
        assert.deepEqual(filters.chapters, ['物體的運動（速度與加速度）']);
        assert.deepEqual(filters.question_types, ['計算', '填空']);
        assert.deepEqual(warnings, []);
    });

    test('validateFilters：對不到的照舊丟掉並警告；科目沒給時由容錯後的章名反推', () => {
        const a = nlq.validateFilters({ subject: '數學', chapters: ['平面向量'], question_types: ['申論'], keywords: [] });
        assert.deepEqual(a.filters.chapters, []);
        assert.deepEqual(a.warnings, ['章節「平面向量」不在白名單內，已忽略。', '題型「申論」不在白名單內，已忽略。']);
        const b = nlq.validateFilters({ subject: null, chapters: ['「向量內積」'], question_types: [], keywords: [] });
        assert.equal(b.filters.subject, '數學');
        assert.deepEqual(b.filters.chapters, ['向量內積']);
    });

    test('mergeLlm 帶原句：句子有第一冊的證據時把第三冊換回第一冊，記在 adjustments；已兩章都列就不換', () => {
        const rules = { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: [] };
        const q = '求 3 的 40 次方是幾位數';
        const merged = nlq.mergeLlm(rules, q, { chapters: ['指數函數與對數函數'], question_types: [], semantic_text: q }, { query: q });
        assert.deepEqual(merged.filters.chapters, ['指數與對數']);
        assert.deepEqual(merged.adjustments, ['章節「指數函數與對數函數」→「指數與對數」（句子裡有「位數」）']);
        const both = nlq.mergeLlm(rules, q, { chapters: ['指數函數與對數函數', '指數與對數'], question_types: [], semantic_text: q }, { query: q });
        assert.deepEqual(both.filters.chapters, ['指數函數與對數函數', '指數與對數']);
        assert.deepEqual(both.adjustments, []);
    });

    test('mergeLlm 不帶原句：與改版前相同（不做任何對齊）', () => {
        const rules = { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: [] };
        const merged = nlq.mergeLlm(rules, 'x', { chapters: ['指數函數與對數函數'], question_types: ['計算'] });
        assert.deepEqual(merged.filters.chapters, ['指數函數與對數函數']);
        assert.deepEqual(merged.filters.question_types, ['計算']);
        assert.deepEqual(merged.adjustments, []);
    });

    test('名稱容錯在對齊之前：「」包起來的空間章名，句子明講平面時照樣換成平面那一章', () => {
        const rules = { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: [] };
        const q = '坐標平面上兩個向量互相垂直';
        const merged = nlq.mergeLlm(rules, q, { chapters: ['「空間向量內積」'], question_types: [] }, { query: q });
        assert.deepEqual(merged.filters.chapters, ['向量內積']);
    });
});
