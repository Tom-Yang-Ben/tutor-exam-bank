// eval/lib/suiteVariant.js 與 eval/golden/variant.json 的單元測試（WS-B / P-11b）
//
// 不連 DB、不連 Gemini：retrieved_coverage 用 eval/fixtures 的向量在記憶體裡算；
// gate_pass_rate 那條路徑用注入的假 generateFn 走一遍（真的跑六個閘門，只是不呼叫 LLM）。
//
// 執行：npm test

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const suite = require('../../eval/lib/suiteVariant');
const { loadFixture } = require('../../eval/lib/fixtures');

// eval 的三個模式旗標：單元測試一律 fixture／replay（與 eval/.env.replay 一致）
process.env.EMBED_MODE = process.env.EMBED_MODE || 'fixture';
process.env.LLM_MODE = process.env.LLM_MODE || 'replay';

describe('eval/golden/variant.json 的硬閘門（第 8.4 條）', () => {
    const fixture = loadFixture();

    test('30 個藍本全部過閘門，全部取自公開 fixture', () => {
        const golden = suite.loadVariantGolden({ fixtureById: fixture.byId });
        assert.equal(golden.entries.length, 30);
        assert.equal(golden.version, 1);
        for (const e of golden.entries) {
            assert.ok(fixture.byId.has(e.source_question_id), `${e.id} 的藍本不在 fixture 內`);
        }
    });

    test('涵蓋兩科 8 章與五種題型（證明題的 verify 會 skipped，那條路徑必須量得到）', () => {
        const golden = suite.loadVariantGolden({ fixtureById: fixture.byId });
        const chapters = new Set(golden.entries.map(e => `${e.subject}/${e.chapter}`));
        const types = new Set(golden.entries.map(e => e.question_type));
        assert.equal(chapters.size, 8);
        assert.deepEqual([...types].sort(), ['single', '單選', '多選', '填空', '計算', '證明'].filter(t => types.has(t)).sort());
        assert.ok(types.has('證明'), 'golden 要有證明題');
        assert.ok(types.has('多選'), 'golden 要有多選題');
    });

    test('golden 已於 2026-08-24 定案：needs_human_confirm 全為 false、_status 以 confirmed 開頭', () => {
        // 定案之前這一條釘的是 pendingConfirm === 30（沒定案不得寫 thresholds 初值）。
        const golden = suite.loadVariantGolden({ fixtureById: fixture.byId });
        assert.equal(golden.pendingConfirm, 0);
        const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'eval', 'golden', 'variant.json'), 'utf8'));
        assert.match(String(raw._status), /^confirmed 2026-08-24/);
    });

    test('抓得到壞掉的標註：id 格式、藍本不在 fixture、欄位與 fixture 不符、重複藍本', () => {
        const ok = { id: 'var-001', source_question_id: 1, subject: '數學', chapter: '指數與對數', difficulty: 1, question_type: '單選', expect: { min_retrieved: 2 }, needs_human_confirm: true };
        assert.deepEqual(suite.validateGoldenEntries([ok], fixture.byId), []);

        const bad = suite.validateGoldenEntries([
            { ...ok, id: 'x1' },
            { ...ok, id: 'var-002', source_question_id: 9999 },
            { ...ok, id: 'var-003', chapter: '圓方程式' },
            { ...ok, id: 'var-004', difficulty: 5 },
            { ...ok, id: 'var-005', expect: { min_retrieved: 0 } },
            { ...ok, id: 'var-006', needs_human_confirm: 'true' }
        ], fixture.byId);
        assert.ok(bad.some(p => p.includes('var-NNN')));
        assert.ok(bad.some(p => p.includes('不在 fixture 內')));
        assert.ok(bad.some(p => p.includes('chapter 與 fixture 不符')));
        assert.ok(bad.some(p => p.includes('difficulty 與 fixture 不符')));
        assert.ok(bad.some(p => p.includes('min_retrieved')));
        assert.ok(bad.some(p => p.includes('needs_human_confirm')));
        assert.ok(bad.some(p => p.includes('重複')), '同一題當兩次藍本要抓出來');
    });
});

describe('retrieveInMemory（第 3.1 條的候選條件）', () => {
    const fixture = loadFixture();
    const { loadEmbeddings } = require('../../eval/lib/embeddings');
    const emb = loadEmbeddings({ questions: fixture.questions });

    test('鎖定單一難度、排除自己、只收同學科', () => {
        const source = fixture.byId.get(9);      // 數學／向量內積／難度 2
        const hits = suite.retrieveInMemory({
            source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: 0
        });
        assert.ok(hits.every(h => h.id !== source.id));
        for (const h of hits) {
            const q = fixture.byId.get(h.id);
            assert.equal(q.subject, '數學');
            assert.equal(q.difficulty, 2);
        }
    });

    test('difficulty_delta 是字面語意（+1 就只收 difficulty+1）', () => {
        const source = fixture.byId.get(9);
        const hits = suite.retrieveInMemory({
            source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: 0, difficultyDelta: 1
        });
        for (const h of hits) assert.equal(fixture.byId.get(h.id).difficulty, 3);
    });

    test('依 cosine 由大到小排序，門檻拉高只會變少不會變多', () => {
        const source = fixture.byId.get(9);
        const all = suite.retrieveInMemory({ source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: 0 });
        for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].cosine >= all[i].cosine);

        const strict = suite.retrieveInMemory({ source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: 0.9 });
        assert.ok(strict.length <= all.length);
        assert.ok(strict.every(h => h.cosine >= 0.9));
    });

    test('「同概念換數字」的那一題一定排在最前面（這就是 embed_text 的設計目的）', () => {
        const source = fixture.byId.get(9);       // dot-basic base
        const hits = suite.retrieveInMemory({ source, questions: fixture.questions, vectorOf: emb.vectorOf, simMin: 0 });
        assert.equal(hits[0].id, 10, 'dot-basic 的 numeric_variant');
        assert.ok(hits[0].cosine > 0.9);
    });
});

describe('runVariantSuite', () => {
    test('形狀符合第 8.1 條，retrieved_coverage 永遠量得到', async () => {
        const res = await suite.runVariantSuite({});
        assert.equal(res.suite, 'variant');
        assert.deepEqual(Object.keys(res.measured), ['variant']);
        assert.deepEqual(Object.keys(res.measured.variant).sort(), ['gate_pass_rate', 'retrieved_coverage']);
        assert.equal(typeof res.measured.variant.retrieved_coverage, 'number');
        assert.ok(Array.isArray(res.failures));
        assert.ok(Array.isArray(res.warnings));
        assert.ok(Array.isArray(res.perEntry));
        assert.equal(res.perEntry.length, 30);
        assert.equal(res.meta.goldenEntries, 30);
        assert.equal(res.meta.fixture, 'eval/fixtures/questions.public.json');
        assert.equal(res.isPrivate, false);
    });

    test('沒有 cassette 時 gate_pass_rate 是 null，而且說清楚為什麼', async () => {
        const res = await suite.runVariantSuite({});
        const dir = path.resolve(__dirname, '..', '..', 'eval', 'cassettes', 'variant');
        const recorded = fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'));
        if (recorded) return;      // cassette 錄好之後這個案例就沒有意義了

        assert.equal(res.measured.variant.gate_pass_rate, null);
        assert.ok(res.warnings.some(w => w.includes('eval/cassettes/variant/')));
        assert.ok(res.warnings.some(w => w.includes('EMBED_MODE=record')),
            '警告要提醒「兩個 record 必須一起開」（裁決 S3-20）');
        assert.deepEqual(res.failures, [], '沒錄 cassette 不是失敗，是還沒量');
    });

    test('golden 定案後不再出現 needs_human_confirm 的 warning（run.js 的 stub guard 同一條線）', async () => {
        const res = await suite.runVariantSuite({});
        assert.ok(!res.warnings.some(w => w.includes('needs_human_confirm')), res.warnings.join('；'));
    });

    test('校準旁欄：門檻越高覆蓋率單調不增', async () => {
        const res = await suite.runVariantSuite({});
        const keys = Object.keys(res.coverageSweep).sort();
        for (let i = 1; i < keys.length; i++) {
            assert.ok(res.coverageSweep[keys[i]] <= res.coverageSweep[keys[i - 1]] + 1e-9,
                `${keys[i]} 的覆蓋率不該高於 ${keys[i - 1]}`);
        }
    });

    test('注入 generateFn → 六個閘門真的跑得起來；缺變式題的向量時誠實回 n/a', async () => {
        // 假生成：情境與數字全部重寫（過得了真的 textGate），embed 走 fixture 會查不到新字串，
        // 所以這裡也一併注入 ctx.llm.embed 用不到的路徑——真 agent 才需要 embed。
        const generateFn = async (ctx, input) => {
            const s = input.source;
            const n = input.idx * 7;
            return {
                kind: 'pass',
                data: {
                    idx: input.idx, subject: s.subject, chapter: s.chapter, chapter_confidence: 0.9,
                    question_type: s.question_type, difficulty: s.difficulty,
                    question_text: `假變式 ${s.id}-${input.idx}：某工程師量到甲乙兩點的讀數分別是 $${n}$ 與 $${n + 3}$，` +
                        `請依本章的公式求出對應的結果，並說明每一步用到的性質。`,
                    answer_text: `$${n + 1}$`,
                    chunk_no: 0, page_range: null,
                    variant_of_root: s.id, anchor_ids: input.neighbors.map(x => x.id).sort((a, b) => a - b)
                },
                gate: { text_gate: { ok: true, reason: null, edit_ratio: 0.9 }, sim: 0.9 }
            };
        };

        // verify 節點每題都要呼叫 LLM（證明題除外），沒有 cassette 就會 replay miss；
        // 這裡把它換成一支「照 answerCompare 的 agree 路徑回 pass」的假 agent，
        // 六個閘門與 gate_pass_rate 的算法才有東西可以真的跑過一遍。
        const fakeVerify = { run: async () => ({ kind: 'pass', data: { compare: 'agree', final_answer: '$1$' } }) };

        const res = await suite.runVariantSuite({ generateFn, agents: { verify: fakeVerify } });
        assert.equal(res.generations, 60, '30 藍本 × 2 題');
        assert.ok(res.gateCounts, '各閘門通過數要報出來（只報告不設門檻）');
        for (const gate of suite.GATES) {
            assert.equal(typeof res.gateCounts[gate], 'number', `缺 ${gate} 的通過數`);
            assert.ok(res.gateCounts[gate] <= 60);
        }
        // 前五道真的跑過：text_gate 與跑題由假生成直接給過，classify 走第一層零成本閘門，
        // lint 是純程式（formulaFix + formulaLint），verify 用注入的假 agent
        assert.equal(res.gateCounts.text_gate, 60);
        assert.equal(res.gateCounts.off_topic, 60);
        assert.equal(res.gateCounts.classify, 60, 'chapter 繼承藍本、confidence 0.9 → 第一層閘門直接過');
        assert.equal(res.gateCounts.lint, 60);
        assert.equal(res.gateCounts.verify, 60);

        // dedup1 需要「變式題幹」的向量，fixture 裡不會有。
        // interfaces.md 第 4 條：**不得靜默回退成假向量**——所以這一道回 0、留下 failure，
        // 而且整個 gate_pass_rate 誠實回 n/a（部分量到的比例不能拿來跟完整的一輪比）。
        assert.equal(res.gateCounts.dedup1, 0);
        assert.equal(res.measured.variant.gate_pass_rate, null);
        assert.ok(res.failures.some(f => f.includes('dedup1 取不到變式題的向量')));
        assert.ok(res.warnings.some(w => w.includes('EMBED_MODE=record')),
            '警告要指出「兩個 record 必須一起開」才是這個 n/a 的解法（裁決 S3-20）');
    });

    test('gate_pass_rate 是「六道全過」的比例，缺一道就不算過', async () => {
        const generateFn = async (ctx, input) => ({
            kind: 'fail', reason: 'text_gate', feedback: '只改字閘門未通過（identical）'
        });
        const res = await suite.runVariantSuite({ generateFn });
        assert.equal(res.measured.variant.gate_pass_rate, 0);
        assert.equal(res.gateCounts.text_gate, 0);
        assert.equal(res.gateCounts.classify, 0, '第一道就卡住，後面的閘門連跑都沒跑');
    });
});
