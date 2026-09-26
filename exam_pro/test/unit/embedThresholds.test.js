// ─────────────────────────────────────────────────────────────
// test/unit/embedThresholds.test.js — 餘弦門檻分布報告（eval/lib/embedThresholds.js、eval/tools/embed_threshold_report.js，
// npm run embed:thresholds；docs/local-mode.md 10.12）
//
//   1. 純函式：分組、百分位數、≥ 門檻的語意、等效門檻（分位對應）、格點、覆蓋率與推薦組成、跑題掃描、
//      去重判定、數字標記、跳脫受損、Markdown 儲存格；
//   2. 工具：參數、讀 cassette（挑最新、濾模型與難度差）、把錄好的生成結果餵回 generateVariant
//      （向量檔放系統暫存目錄；有餘弦／文字閘門／缺向量／沒有 cassette 四種狀態）、現行預設值讀的是程式；
//   3. 拿 repo 裡錄好的資料跑一次整份報告：只檢查段落都在、不改任何門檻（數字不釘，重錄後會變）。
//   〔2026-09-26 審查修正〕補：JSON 跳脫受損的補回與指令清單、補回後文字閘門（var-028／var-016 那兩種）、
//   各 agent 的 cassette 掃描、初判標註（sha256 對上）、不同題幹計數、第 5 節的 dedup1 措辭與第 7 節。
// 不呼叫模型、不連網、不碰資料庫。
// ─────────────────────────────────────────────────────────────

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const T = require('../../eval/lib/embedThresholds');
const tool = require('../../eval/tools/embed_threshold_report');
const { buildEmbedText } = require('../../utils/embedText');

const APP_DIR = path.resolve(__dirname, '..', '..');
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

const q = (id, extra) => ({ id, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 2, question_text: `題${id}`, answer_text: 'x', ...extra });

describe('純函式：分組與分布', () => {
    test('relationOf：跨科 → 同 variant_group → 同章 → 跨章', () => {
        assert.equal(T.relationOf(q(1, { variant_group: 'g' }), q(2, { variant_group: 'g' })), 'same_concept');
        assert.equal(T.relationOf(q(1), q(2)), 'same_chapter');
        assert.equal(T.relationOf(q(1), q(2, { chapter: '空間向量內積' })), 'cross_chapter');
        assert.equal(T.relationOf(q(1, { variant_group: 'g' }), q(2, { subject: '物理', variant_group: 'g' })), 'cross_subject');
        assert.deepEqual(T.RELATIONS, ['same_concept', 'same_chapter', 'cross_chapter', 'cross_subject']);
    });

    test('isLookalike：任一邊的 lookalike_of 指向另一邊的 variant_group', () => {
        const a = q(9, { variant_group: 'dot-basic', lookalike_of: 'sdot-basic' });
        const b = q(17, { chapter: '空間向量內積', variant_group: 'sdot-basic', lookalike_of: 'dot-basic' });
        const c = q(21, { chapter: '空間向量內積', lookalike_of: 'dot-perp' });
        const d = q(13, { variant_group: 'dot-perp' });
        assert.equal(T.isLookalike(a, b), true);
        assert.equal(T.isLookalike(d, c), true);
        assert.equal(T.isLookalike(a, d), false);
        assert.equal(T.pickKindOf(a, b), 'lookalike');
        assert.equal(T.pickKindOf(a, q(3, { chapter: '空間向量內積' })), 'cross_chapter');
    });

    test('cosine：自己除範數；長度不符或零向量回 null', () => {
        close(T.cosine([1, 0], [2, 0]), 1);
        close(T.cosine([1, 0], [0, 3]), 0);
        close(T.cosine([1, 1], [1, 0]), Math.SQRT1_2);
        assert.equal(T.cosine([1], [1, 2]), null);
        assert.equal(T.cosine([0, 0], [1, 1]), null);
    });

    test('quantile 是線性內插（R-7）；summarize 給七個數', () => {
        close(T.quantile([4, 1, 3, 2], 0.5), 2.5);
        close(T.quantile([1, 2, 3, 4], 0.25), 1.75);
        close(T.quantile([1, 2, 3, 4], 0.95), 3.85);
        assert.equal(T.quantile([], 0.5), null);
        const s = T.summarize([0.2, 0.4, 0.6, 0.8, 1.0]);
        assert.equal(s.n, 5);
        close(s.min, 0.2); close(s.max, 1.0); close(s.p50, 0.6); close(s.p5, 0.24);
        assert.equal(T.summarize([]).p50, null);
    });

    test('pairwise 只算兩題都有向量的題對；groupByRelation 多一組 different_chapter＝跨章同科＋跨科', () => {
        const qs = [q(1, { variant_group: 'g' }), q(2, { variant_group: 'g' }), q(3, { chapter: '空間向量內積' }),
            q(4, { subject: '物理', chapter: '牛頓運動定律' }), q(5)];
        const vec = { 1: [1, 0], 2: [0.9, 0.1], 3: [0, 1], 4: [1, 1] };      // #5 沒向量
        const pairs = T.pairwise(qs, x => vec[x.id] || null);
        assert.equal(pairs.length, 6);                                     // C(4,2)
        const g = T.groupByRelation(pairs);
        assert.equal(g.same_concept.length, 1);
        assert.equal(g.cross_chapter.length, 2);
        assert.equal(g.cross_subject.length, 3);
        assert.equal(g.different_chapter.length, 5);
    });
});

describe('純函式：門檻', () => {
    test('「≥ 門檻」算通過（與程式相同）', () => {
        assert.equal(T.countAtOrAbove([0.8, 0.79999, 0.9], 0.8), 2);
        close(T.rateAtOrAbove([0.8, 0.7, 0.9, 0.6], 0.8), 0.5);
        assert.equal(T.rateAtOrAbove([], 0.8), null);
    });

    test('equivalentThreshold：分位對應，恰好 k＝round(r×n) 個 ≥ 門檻', () => {
        const eq = T.equivalentThreshold([0.9, 0.8, 0.7, 0.6], 0.75, [0.5, 0.4, 0.3, 0.2, 0.1, 0.05]);
        assert.equal(eq.refCount, 2);
        close(eq.refRate, 0.5);
        assert.equal(eq.k, 3);
        close(eq.threshold, 0.3);
        assert.equal(eq.targetCount, 3);
        const none = T.equivalentThreshold([0.5, 0.6], 0.97, [0.91, 0.95]);
        assert.equal(none.threshold, null);
        close(none.aboveMax, 0.95);
        const all = T.equivalentThreshold([0.9, 0.95], 0.8, [0.7, 0.6, 0.65]);
        close(all.threshold, 0.6);
        assert.equal(all.targetCount, 3);
    });

    test('thresholdGrid 沒有浮點累加誤差；justAbove 取「嚴格高於」的格點', () => {
        const g = T.thresholdGrid(0.5, 0.9, 0.02);
        assert.equal(g.length, 21);
        assert.ok(g.includes(0.8) && g.includes(0.72) && g.includes(0.9));
        assert.deepEqual(T.thresholdGrid(0.9, 0.5, 0.1), []);
        close(T.justAbove(0.99812), 0.999);
        close(T.justAbove(0.998), 0.999);
        close(T.justAbove(0.9, 0.01), 0.91);
    });

    test('coverageAt：第 minRetrieved 近 ≥ 門檻才算覆蓋，只數推薦出去的前 minRetrieved 題', () => {
        const entries = [
            { id: 'a', minRetrieved: 2, hits: [{ id: 1, cosine: 0.95, kind: 'same_concept' }, { id: 2, cosine: 0.76, kind: 'same_chapter' }, { id: 3, cosine: 0.70, kind: 'cross_chapter' }] },
            { id: 'b', minRetrieved: 2, hits: [{ id: 4, cosine: 0.94, kind: 'lookalike' }, { id: 5, cosine: 0.74, kind: 'cross_chapter' }] },
            { id: 'c', minRetrieved: 2, hits: [] }
        ];
        const at70 = T.coverageAt(entries, 0.70);
        assert.equal(at70.covered, 2);
        assert.deepEqual(at70.coveredIds, ['a', 'b']);
        assert.equal(at70.picks.same_concept, 1);
        assert.equal(at70.picks.cross_chapter, 1);              // b 的 #5；a 的 #3 是第 3 近，不推薦
        close(at70.coverage, 2 / 3);
        const at75 = T.coverageAt(entries, 0.75);
        assert.equal(at75.covered, 1);
        assert.equal(at75.picks.cross_chapter, 0);
        const clean = T.lowestCleanThreshold(entries, T.thresholdGrid(0.60, 0.90, 0.01));
        close(clean.t, 0.75);
        assert.equal(T.lowestCleanThreshold([entries[1]], [0.70, 0.74]), null);
    });

    test('offtopicAt：< 門檻擋下；藍本的生成題沒有一題過（含文字閘門先擋）就算「兩題都沒過」', () => {
        const gens = [
            { entryId: 'a', idx: 1, status: 'sim', sim: 0.91 },
            { entryId: 'a', idx: 2, status: 'sim', sim: 0.85 },
            { entryId: 'b', idx: 1, status: 'text_gate' },
            { entryId: 'b', idx: 2, status: 'sim', sim: 0.88 },
            { entryId: 'c', idx: 1, status: 'miss' }
        ];
        const r = T.offtopicAt(gens, 0.90);
        assert.deepEqual({ withSim: r.withSim, blocked: r.blocked, passed: r.passed, entries: r.entries, none: r.entriesNoneThrough },
            { withSim: 3, blocked: 2, passed: 1, entries: 3, none: 2 });
        assert.equal(T.offtopicAt(gens, 0.88).entriesNoneThrough, 1);
    });

    test('dedupVerdict 與 agents/dedup.js 相同：≥ dup → duplicate；≥ variant → variant', () => {
        assert.equal(T.dedupVerdict(0.97, 0.97, 0.90), 'duplicate');
        assert.equal(T.dedupVerdict(0.9699, 0.97, 0.90), 'variant');
        assert.equal(T.dedupVerdict(0.90, 0.97, 0.90), 'variant');
        assert.equal(T.dedupVerdict(0.8999, 0.97, 0.90), 'unique');
    });
});

describe('純函式：文字', () => {
    test('numberTokens／sameNumbers：同一組數字（順序不拘）', () => {
        assert.deepEqual(T.numberTokens('質量 $6$ kg、$24$ N、$1.5$ 秒'), ['1.5', '24', '6']);
        assert.equal(T.sameNumbers('$q = 3 \\times 10^{-6}$、$0.4$ m', '距離 $0.4$ m、$Q = 3 \\times 10^{-6}$'), true);
        assert.equal(T.sameNumbers('$100$ 個', '$125$ 個'), false);
        assert.equal(T.sameNumbers('沒有數字', '也沒有'), false);
        assert.equal(T.numbersRelation('$6$ kg', '6 公斤'), 'same');
        assert.equal(T.numbersRelation('$6$ kg', '$7$ kg'), 'different');
        assert.equal(T.numbersRelation('速度計顯示的是？', '里程表顯示的是？'), 'none');
        assert.equal(T.numbersRelation('速度計顯示的是？', '$3$ 秒後'), 'different');
    });

    test('hasEscapeDamage：JSON 跳脫吃掉 LaTeX 的控制字元；正常的換行不算', () => {
        assert.equal(T.hasEscapeDamage('$10 \\times 2$'), false);
        assert.equal(T.hasEscapeDamage('(A) 1\n(B) 2'), false);
        assert.equal(T.hasEscapeDamage(JSON.parse('"$10 \\times 2$"')), true);      // 模型寫 \times 沒寫成 \\times
        assert.equal(T.hasEscapeDamage(JSON.parse('"$\\boldsymbol{u}$"')), true);
        assert.equal(T.hasEscapeDamage(JSON.parse('"$\\frac{1}{2}$"')), true);
    });

    test('scanEscapeDamage：控制字元後面接英文字母才補回反斜線；列出壞掉的指令', () => {
        const damaged = JSON.parse('"$q = 6 \\times 10^{-6}$、$\\tan \\theta$ 與 $\\frac{1}{2}$、$\\boldsymbol{u}$、$37^\\rcirc$"');
        assert.equal(T.hasEscapeDamage(damaged), true);
        const s = T.scanEscapeDamage(damaged);
        assert.equal(s.repaired, '$q = 6 \\times 10^{-6}$、$\\tan \\theta$ 與 $\\frac{1}{2}$、$\\boldsymbol{u}$、$37^\\rcirc$');
        assert.deepEqual(s.commands, ['\\times', '\\tan', '\\theta', '\\frac', '\\boldsymbol', '\\rcirc']);
        assert.equal(T.repairEscapeDamage(damaged), s.repaired);
        // 沒受損的原樣回傳
        const clean = '$10 \\times 2$\n(A) 1\t(B) 2';
        assert.deepEqual(T.scanEscapeDamage(clean), { repaired: clean, commands: [] });
        assert.deepEqual(T.scanEscapeDamage(null), { repaired: '', commands: [] });
    });

    test('scanEscapeDamage：換行只在 $…$ 裡、後面接字母時才補 \\n；\\$ 不算數學式的開關', () => {
        const damaged = JSON.parse('"$a \\neq b$\\n(A) 對\\nB 錯 $\\nu = 0.2$"');
        const s = T.scanEscapeDamage(damaged);
        assert.equal(s.repaired, '$a \\neq b$\n(A) 對\nB 錯 $\\nu = 0.2$');
        assert.deepEqual(s.commands, ['\\neq', '\\nu']);
        assert.equal(T.hasEscapeDamage(damaged), false);                 // 下限：換行不算
        const dollar = '售價 \\$5\nabc';                                   // 跳脫的 $ 不開數學式
        assert.deepEqual(T.scanEscapeDamage(dollar), { repaired: dollar, commands: [] });
    });

    test('補回反斜線之後文字閘門會擋（var-028 那一種：只換數字）；受損時過得了', () => {
        const { textGate } = require('../../utils/variantTextGate');
        const src = '兩點電荷 $q_1 = 4 \\times 10^{-6}$ C 與 $q_2 = 3 \\times 10^{-6}$ C 相距 $0.6$ m，求兩者間的靜電力（取 $k = 9 \\times 10^9$ N·m$^2$/C$^2$）。';
        const damaged = JSON.parse('"兩點電荷 $q_1 = 6 \\times 10^{-6}$ C 與 $q_2 = 5 \\times 10^{-6}$ C 相距 $0.5$ m，求兩者間的靜電力（取 $k = 9 \\times 10^9$ N·m$^2$/C$^2$）。"');
        assert.equal(textGate({ source_text: src, variant_text: damaged, minEdit: 0.08 }).ok, true);
        const after = textGate({ source_text: src, variant_text: T.repairEscapeDamage(damaged), minEdit: 0.08 });
        assert.equal(after.ok, false);
        assert.equal(after.reason, 'numbers_only');
    });

    test('damagedStringFields：列出帶控制字元的欄位（陣列索引不列、同欄位只記一次）', () => {
        const data = {
            chapter: '向量內積',
            rationale: JSON.parse('"a \\times b"'),
            questions: [{ question_text: '\text{x}', answer_text: 'ok' }, { question_text: JSON.parse('"\\frac{1}{2}"') }],
            confidence: 0.9
        };
        assert.deepEqual(T.damagedStringFields(data), ['questions.question_text', 'rationale']);
        assert.deepEqual(T.damagedStringFields({ a: 'ok', b: ['x', 1, null] }), []);
        assert.deepEqual(T.damagedStringFields(JSON.parse('"\\theta"')), ['(字串)']);
        assert.deepEqual(T.damagedStringFields(undefined), []);
    });

    test('cell：跳脫 |、控制字元照 JSON 寫法顯示、換行變 ⏎、截斷；mdTable 的形狀', () => {
        assert.equal(T.cell('a|b'), 'a\\|b');
        assert.equal(T.cell('x\timesy'), 'x\\timesy');
        assert.equal(T.cell('一\n\n二'), '一 ⏎ 二');
        assert.equal(T.cell('一二三四五', 3), '一二三…');
        assert.equal(T.fmt(null), '—');
        assert.equal(T.pct(0.1226), '12.3%');
        assert.deepEqual(T.mdTable(['a', 'b'], [[1, 2]]), ['| a | b |', '|---|---:|', '| 1 | 2 |']);
    });
});

describe('純函式：初判標註與不同題幹', () => {
    test('textSha256 是 UTF-8 的 sha256', () => {
        assert.equal(T.textSha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        assert.equal(T.textSha256('甲'), crypto.createHash('sha256').update('甲', 'utf8').digest('hex'));
    });

    test('findLabel：藍本與題幹 sha256 都要對上；兄弟變式兩段順序不拘；題幹改過就對不上', () => {
        const list = [
            { entry: 'var-001', sha256: T.textSha256('甲'), label: 'concept_changed' },
            { entry: 'var-002', sha256: [T.textSha256('乙'), T.textSha256('丙')], label: 'same_question' }
        ];
        assert.equal(T.findLabel(list, 'var-001', '甲').label, 'concept_changed');
        assert.equal(T.findLabel(list, 'var-009', '甲'), null);
        assert.equal(T.findLabel(list, 'var-001', '甲 '), null);
        assert.equal(T.findLabel(list, 'var-002', ['丙', '乙']).label, 'same_question');
        assert.equal(T.findLabel(list, 'var-002', ['乙', '丁']), null);
        assert.equal(T.findLabel(undefined, 'var-001', '甲'), null);
    });

    test('offtopicCategory：補回反斜線後文字閘門就擋的優先，其次初判，都沒有算未標註', () => {
        assert.equal(T.offtopicCategory({ label: 'same_concept', gateAfterRepair: { ok: false, reason: 'too_close' } }), 'gate_after_repair');
        assert.equal(T.offtopicCategory({ label: 'same_concept', gateAfterRepair: { ok: true } }), 'same_concept');
        assert.equal(T.offtopicCategory({ label: 'concept_changed', gateAfterRepair: null }), 'concept_changed');
        assert.equal(T.offtopicCategory({ label: 'same_question' }), 'unlabeled');
        assert.equal(T.offtopicCategory({}), 'unlabeled');
        assert.deepEqual(T.OFFTOPIC_CATEGORIES, ['concept_changed', 'same_concept', 'gate_after_repair', 'unlabeled']);
    });

    test('distinctGenerations：同一藍本逐字相同只算一段；別的藍本同字不合併；沒有餘弦的不算', () => {
        const gens = [
            { entryId: 'a', idx: 1, status: 'sim', sim: 0.85, text: '甲' },
            { entryId: 'a', idx: 2, status: 'sim', sim: 0.85, text: '甲' },
            { entryId: 'b', idx: 1, status: 'sim', sim: 0.95, text: '甲' },
            { entryId: 'b', idx: 2, status: 'text_gate', text: '乙' }
        ];
        const d = T.distinctGenerations(gens);
        assert.equal(d.length, 2);
        assert.deepEqual(d.map(x => x.gens), [['a#1', 'a#2'], ['b#1']]);
    });

    test('offtopicDistinctAt：擋下的依分類計，放過的只數換了概念', () => {
        const items = [
            { sim: 0.75, category: 'concept_changed' },
            { sim: 0.85, category: 'same_concept' },
            { sim: 0.88, category: 'gate_after_repair' },
            { sim: 0.886, category: 'concept_changed' },
            { sim: 0.95, category: 'same_concept' },
            { sim: 0.80, category: 'unlabeled' }
        ];
        const r = T.offtopicDistinctAt(items, 0.87);
        assert.deepEqual({ total: r.total, blocked: r.blocked, passedChanged: r.passedChanged }, { total: 6, blocked: 3, passedChanged: 1 });
        assert.deepEqual(r.byCategory, { concept_changed: 1, same_concept: 1, gate_after_repair: 0, unlabeled: 1 });
        const r90 = T.offtopicDistinctAt(items, 0.90);
        assert.equal(r90.blocked, 5);
        assert.equal(r90.byCategory.gate_after_repair, 1);
        assert.equal(r90.passedChanged, 0);
    });

    test('withGateAfterRepair：補回後文字閘門就擋的題改算沒過，offtopicAt 的「兩題都沒過」跟著變', () => {
        const gens = [
            { entryId: 'a', idx: 1, status: 'sim', sim: 0.98, gateAfterRepair: { ok: false, reason: 'numbers_only' } },
            { entryId: 'a', idx: 2, status: 'sim', sim: 0.98, gateAfterRepair: { ok: false, reason: 'numbers_only' } },
            { entryId: 'b', idx: 1, status: 'sim', sim: 0.93, gateAfterRepair: { ok: true } },
            { entryId: 'b', idx: 2, status: 'sim', sim: 0.95, gateAfterRepair: null }
        ];
        assert.equal(T.offtopicAt(gens, 0.90).entriesNoneThrough, 0);
        const rep = T.withGateAfterRepair(gens);
        assert.deepEqual(rep.map(g => g.status), ['text_gate_after_repair', 'text_gate_after_repair', 'sim', 'sim']);
        assert.equal(T.offtopicAt(rep, 0.90).entriesNoneThrough, 1);
        assert.equal(gens[0].status, 'sim');                                  // 不改原陣列
    });
});

describe('工具：eval/tools/embed_threshold_report.js', () => {
    test('package.json 的 embed:thresholds', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['embed:thresholds'], 'node eval/tools/embed_threshold_report.js');
    });

    test('parseArgs：預設看本機 embedding、對照 Gemini；--compare none；壞參數丟錯', () => {
        const a = tool.parseArgs([], { env: {} });
        assert.equal(a.model, 'ollama:qwen3-embedding:0.6b');
        assert.equal(a.compare, 'gemini-embedding-001');
        assert.equal(a.llm, 'qwen3:8b');
        assert.equal(a.compareLlm, 'gemini-3.1-pro-preview');
        assert.equal(a.out, null);
        assert.equal(a.labels, path.join(APP_DIR, 'eval', 'tools', 'embed_threshold_labels.json'));
        assert.equal(tool.parseArgs(['--labels', 'l.json'], { cwd: '/tmp', env: {} }).labels, path.resolve('/tmp', 'l.json'));
        assert.equal(tool.parseArgs([], { env: { MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview' } }).llm, 'gemini-3.1-pro-preview');
        assert.equal(tool.parseArgs([], { env: { MODEL_VARIANT: 'ollama:qwen3:4b', MODEL_VERIFY: 'ollama:qwen3:8b' } }).llm, 'qwen3:4b');
        assert.equal(tool.parseArgs([], { env: { EMBED_MODEL: 'gemini-embedding-001' } }).model, 'gemini-embedding-001');
        const b = tool.parseArgs(['--compare', 'none', '--out', 'x.md', '--llm', 'qwen3:4b'], { cwd: '/tmp', env: {} });
        assert.equal(b.compare, null);
        assert.equal(b.out, path.resolve('/tmp', 'x.md'));
        assert.equal(b.llm, 'qwen3:4b');
        assert.equal(tool.parseArgs(['--help'], { env: {} }).help, true);
        assert.throws(() => tool.parseArgs(['--nope'], { env: {} }), /不認得的參數/);
        assert.throws(() => tool.parseArgs(['--out'], { env: {} }), /後面要接一個值/);
    });

    test('現行預設值直接讀程式（不讀 .env）', () => {
        const cur = tool.currentDefaults();
        assert.deepEqual(cur, {
            retrieve: require('../../services/variantService').simMin({}),
            offtopic: require('../../agents/generateVariant').DEFAULT_OFFTOPIC_SIM_MIN,
            dedupDup: require('../../agents/dedup').DEFAULT_DUP,
            dedupVariant: require('../../agents/dedup').DEFAULT_VARIANT,
            minEdit: require('../../agents/generateVariant').DEFAULT_MIN_EDIT
        });
        // 本分支不改任何門檻：這四個數字與 2026-09-26 之前相同（minEdit 只拿來重算補回反斜線後的文字閘門，也沒改）
        assert.deepEqual(cur, { retrieve: 0.80, offtopic: 0.90, dedupDup: 0.97, dedupVariant: 0.90, minEdit: 0.08 });
    });

    test('loadLabels：repo 的初判檔格式正確；檔案不存在時全部算未標註', () => {
        const l = tool.loadLabels(tool.LABELS_FILE);
        assert.equal(l.llm, 'qwen3:8b');
        assert.ok(l.offtopic.length > 0 && l.siblings.length > 0);
        for (const x of l.offtopic) {
            assert.match(x.entry, /^var-\d{3}$/);
            assert.match(x.sha256, /^[0-9a-f]{64}$/);
            assert.ok(['concept_changed', 'same_concept'].includes(x.label), x.label);
        }
        for (const x of l.siblings) {
            assert.equal(x.sha256.length, 2);
            assert.ok(['same_question', 'numbers_changed', 'different'].includes(x.label), x.label);
        }
        assert.deepEqual(tool.loadLabels(path.join(os.tmpdir(), '不存在的初判檔.json')), { offtopic: [], siblings: [], llm: null });
    });

    test('scanCassetteDamage：依 agent、模型數回應受損的 cassette 與欄位；壞檔略過', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-dmg-'));
        try {
            const put = (agent, name, model, data) => {
                fs.mkdirSync(path.join(root, agent), { recursive: true });
                fs.writeFileSync(path.join(root, agent, `${name}.json`), JSON.stringify({ meta: { model }, response: { data } }));
            };
            put('classify', 'a', 'qwen3:8b', { chapter: '向量內積', rationale: JSON.parse('"用到 \\theta"') });
            put('classify', 'b', 'qwen3:8b', { chapter: '向量內積', rationale: '沒問題' });
            put('classify', 'c', 'gemini-3.5-flash', { chapter: '向量內積', rationale: '沒問題' });
            put('variant', 'd', 'qwen3:8b', { question_text: JSON.parse('"$a \\times b$"'), answer_text: JSON.parse('"$\\frac{1}{2}$"') });
            fs.writeFileSync(path.join(root, 'variant', 'broken.json'), '{');
            fs.writeFileSync(path.join(root, 'README.txt'), '不是資料夾');
            const rows = tool.scanCassetteDamage(root);
            assert.deepEqual(rows.map(r => [r.agent, r.model, r.n, r.damaged]), [
                ['classify', 'gemini-3.5-flash', 1, 0], ['classify', 'qwen3:8b', 2, 1], ['variant', 'qwen3:8b', 1, 1]
            ]);
            assert.deepEqual(rows[1].fields, { rationale: 1 });
            assert.deepEqual(rows[2].fields, { answer_text: 1, question_text: 1 });
            assert.deepEqual(tool.scanCassetteDamage(path.join(root, '不存在')), []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    describe('讀 cassette 與把錄好的生成結果餵回 generateVariant（暫存目錄）', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-thr-'));
        const prevFixtureDir = process.env.EMBED_FIXTURE_DIR;
        after(() => {
            if (prevFixtureDir === undefined) delete process.env.EMBED_FIXTURE_DIR; else process.env.EMBED_FIXTURE_DIR = prevFixtureDir;
            fs.rmSync(tmp, { recursive: true, force: true });
        });

        const source = { id: 1, subject: '數學', chapter: '指數函數與對數函數', question_type: '單選', difficulty: 1,
            question_text: '$\\log_{2} 8 + \\log_{2} 4$ 之值為何？\n(A) $5$　(B) $6$　(C) $7$　(D) $12$', answer_text: '(A)' };
        const src2 = { ...source, id: 3, question_type: '計算', difficulty: 2, question_text: '解方程式 $2^{x+1} = 32$。' };
        const variantData = (text, extra) => ({ chapter: source.chapter, chapter_confidence: 0.9, question_type: '單選', difficulty: 1,
            question_text: text, answer_text: '(A) 5', ...extra });
        const rewritten = variantData('小明計算 $\\log_{3} 9 + \\log_{3} 27$，請問結果為何？\n(A) $5$　(B) $6$　(C) $7$　(D) $8$');
        const numbersOnly = variantData('$\\log_{3} 9 + \\log_{3} 27$ 之值為何？\n(A) $4$　(B) $5$　(C) $6$　(D) $7$');
        const noVector = { ...variantData('另一段沒有錄向量的改寫：$\\log_{5} 25 + \\log_{5} 5$ 的值？'), question_type: '計算', difficulty: 2 };
        const embedTextOf = f => buildEmbedText({ subject: f.subject || '數學', chapter: f.chapter, question_type: f.question_type, difficulty: f.difficulty, question_text: f.question_text });
        const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

        const writeCassette = (dir, name, model, recordedAt, kp, data) => {
            fs.mkdirSync(path.join(dir, 'variant'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'variant', `${name}.json`), JSON.stringify({
                meta: { agent: 'variant', model, template: 'variant.v1', recorded_at: recordedAt },
                request: { cacheKeyParts: { template: 'variant.v1', sourceQuestionId: kp.src, difficultyDelta: kp.delta ?? 0, idx: kp.idx, anchorIds: [] } },
                response: { data, usage: { tokenIn: 1, tokenOut: 1 } }
            }));
        };

        test('loadVariantCassettes：只取指定模型、difficultyDelta=0；同一個藍本#idx 取最新錄的', () => {
            const dir = path.join(tmp, 'c1');
            writeCassette(dir, 'old', 'qwen3:8b', '2026-09-24T00:00:00Z', { src: 1, idx: 1 }, variantData('舊'));
            writeCassette(dir, 'new', 'qwen3:8b', '2026-09-25T00:00:00Z', { src: 1, idx: 1 }, variantData('新'));
            writeCassette(dir, 'gem', 'gemini-3.1-pro-preview', '2026-09-26T00:00:00Z', { src: 1, idx: 1 }, variantData('雙子'));
            writeCassette(dir, 'delta', 'qwen3:8b', '2026-09-26T00:00:00Z', { src: 1, idx: 2, delta: 1 }, variantData('難一點'));
            fs.writeFileSync(path.join(dir, 'variant', 'broken.json'), '{');
            const m = tool.loadVariantCassettes(dir, 'qwen3:8b');
            assert.deepEqual([...m.keys()], ['1#1']);
            assert.equal(m.get('1#1').response.data.question_text, '新');
            assert.equal(tool.loadVariantCassettes(path.join(tmp, '不存在'), 'qwen3:8b').size, 0);
        });

        test('replayGenerations：有餘弦／文字閘門／缺向量／沒有 cassette 四種狀態；餘弦就是兩個向量的餘弦', async () => {
            const dim = 4;
            const vSrc = [1, 0, 0, 0], vVar = [0.8, 0.6, 0, 0], vSrc2 = [0, 0, 1, 0];
            const table = { [sha(embedTextOf(source))]: vSrc, [sha(embedTextOf(rewritten))]: vVar, [sha(embedTextOf(src2))]: vSrc2 };
            const fixtureDir = path.join(tmp, 'fixtures');
            fs.mkdirSync(fixtureDir, { recursive: true });
            fs.writeFileSync(path.join(fixtureDir, `embeddings.ollama-test-embed.${dim}.json`), JSON.stringify(table));
            process.env.EMBED_FIXTURE_DIR = fixtureDir;

            const cassettes = new Map([
                ['1#1', { response: { data: rewritten, usage: {} } }],
                ['1#2', { response: { data: numbersOnly, usage: {} } }],
                ['3#1', { response: { data: noVector, usage: {} } }]
            ]);
            const golden = { entries: [{ id: 'var-001', source_question_id: 1 }, { id: 'var-002', source_question_id: 3 }] };
            const fixture = { byId: new Map([[1, source], [3, src2]]) };
            const gens = await tool.replayGenerations({ golden, fixture, cassettes, embedModel: 'ollama:test-embed', dim });
            assert.deepEqual(gens.map(g => [g.entryId, g.idx, g.status]), [
                ['var-001', 1, 'sim'], ['var-001', 2, 'text_gate'], ['var-002', 1, 'miss'], ['var-002', 2, 'no_cassette']
            ]);
            close(gens[0].sim, 0.8);
            assert.equal(gens[0].vector.length, dim);
            assert.equal(gens[0].damaged, false);
            assert.equal(gens[0].gateAfterRepair, null);                        // 沒受損就不重算
            assert.deepEqual(gens[0].damagedCommands, []);
        });

        test('replayGenerations：題幹受損時，補回反斜線後用同一支文字閘門、同一個 minEdit 重算（gateAfterRepair）', async () => {
            const src7 = { ...source, id: 7, question_type: '計算', difficulty: 3, question_text: '$\\log_{2} 3 \\times \\log_{3} 8$ 之值為何？' };
            // 模型把 \times 寫成 JSON 的 \t：受損的題幹過得了文字閘門，補回去之後只剩數字不同
            const damagedText = JSON.parse('"$\\\\log_{5} 2 \\times \\\\log_{2} 25$ 之值為何？"');
            assert.equal(damagedText, '$\\log_{5} 2 \times \\log_{2} 25$ 之值為何？');
            // var-016 那一種：只改一個字（第二象限 → 第三象限），\theta、\tan 被吃掉
            const src31 = { ...source, id: 31, question_type: '單選', difficulty: 2, question_text: '若 $\\theta$ 落在第二象限，則 $\\tan \\theta$ 的正負為何？\n(A) 恆為正　(B) 恆為負' };
            const oneWord = { ...variantData(JSON.parse('"若 $\\theta$ 落在第三象限，則 $\\tan \\theta$ 的正負為何？\\n(A) 恆為正　(B) 恆為負"')), question_type: '單選', difficulty: 2 };
            const golden = { entries: [{ id: 'var-004', source_question_id: 7 }, { id: 'var-016', source_question_id: 31 }] };
            const fixture = { byId: new Map([[7, src7], [31, src31]]) };
            const cassettes = new Map([
                ['7#1', { response: { data: { ...variantData(damagedText), question_type: '計算', difficulty: 3 }, usage: {} } }],
                ['31#1', { response: { data: oneWord, usage: {} } }]
            ]);
            const gens = await tool.replayGenerations({ golden, fixture, cassettes, embedModel: 'ollama:test-embed-none', dim: 4 });
            const [g7, , g31] = gens;
            assert.equal(g7.status, 'miss');                                    // 沒錄向量；文字閘門照樣算得出來
            assert.equal(g7.damaged, true);
            assert.deepEqual(g7.damagedCommands, ['\\times']);
            assert.equal(g7.gateAfterRepair.ok, false);
            assert.equal(g7.gateAfterRepair.reason, 'numbers_only');
            assert.ok(g7.gateAfterRepair.editRatioNow > g7.gateAfterRepair.editRatio);
            assert.deepEqual(g31.damagedCommands, ['\\theta', '\\tan', '\\theta']);
            assert.equal(g31.gateAfterRepair.reason, 'too_close');              // 預設 minEdit（generateVariant 的 0.08）
            // minEdit 照傳進來的：放寬到 0 時 too_close 就不擋了，numbers_only 仍擋
            const loose = await tool.replayGenerations({ golden, fixture, cassettes, embedModel: 'ollama:test-embed-none', dim: 4, minEdit: 0 });
            assert.equal(loose[0].gateAfterRepair.reason, 'numbers_only');
            assert.equal(loose[2].gateAfterRepair.ok, true);
        });
    });

    test('拿 repo 裡錄好的資料跑整份報告：段落都在、寫明「不改任何門檻」', { timeout: 60000 }, async (t) => {
        const primaryFile = path.join(APP_DIR, 'eval', 'fixtures', 'embeddings.ollama-qwen3-embedding-0.6b.768.json');
        if (!fs.existsSync(primaryFile)) { t.skip('repo 裡沒有本機向量檔'); return; }
        const args = tool.parseArgs([], { env: {} });
        const { lines, candidates } = await tool.run(args);
        const text = lines.join('\n');
        for (const h of ['## 1. ', '## 2. ', '## 3. VARIANT_RETRIEVE_SIM_MIN', '## 4. VARIANT_OFFTOPIC_SIM_MIN', '### 4.3 依不同題幹計',
            '## 5. DEDUP_DUP_THRESHOLD', '### 5.4 ', '## 6. ', '## 7. LaTeX 反斜線', '### 7.1 ', '### 7.3 ']) {
            assert.ok(text.includes(h), `少了段落 ${h}`);
        }
        assert.match(text, /本報告不改任何門檻/);
        // 審查修正：dedup1 的 duplicate 是進複核（不是「不入庫」就結束）；兄弟變式在產品裡不比
        assert.match(text, /review_reason='duplicate'/);
        assert.match(text, /同一藍本的變式（兄弟）在 dedup1 永遠不會互相比對/);
        assert.doesNotMatch(text, /重複、\*\*不入庫\*\*/);
        // V5-2 的三個選項都在 4.3 的表裡
        const s43 = text.slice(text.indexOf('### 4.3'), text.indexOf('## 5. '));
        for (const t of tool.OFFTOPIC_OPTIONS) assert.match(s43, new RegExp(`^\\| ${t.toFixed(2)} \\| \\d+/\\d+ \\| \\d+ \\| \\d+ \\| \\d+ \\| \\d+ \\| \\d+ \\|`, 'm'));
        for (const k of ['retrieve_clean', 'offtopic_equiv_different_chapter', 'dedupDup_equiv_same_concept', 'dedup_above_all_numeric']) {
            assert.ok(k in candidates, `候選值少了 ${k}`);
        }
        // 表格每一列的欄數與表頭相同（儲存格裡的 | 都有跳脫，題幹不會把表格切歪）
        const pipes = l => (l.match(/(?<!\\)\|/g) || []).length;
        let header = null;
        for (const l of lines) {
            if (!l.startsWith('|')) { header = null; continue; }
            if (header === null) { header = pipes(l); continue; }
            assert.equal(pipes(l), header, l);
        }
    });
});
