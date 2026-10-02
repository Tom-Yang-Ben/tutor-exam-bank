// ─────────────────────────────────────────────────────────────
// gateEvidenceVeto.test.js — 零成本閘門的證據否決（〔r15 dec/r15-chapter-acc〕docs/local-mode.md 10.28 第 2 點）
//
// utils/chapterPostRules.js 的 gateEvidenceVeto 與它在 agents/classify.js 第一層的接線：
//   拆題模型給的章在否決表（GATE_EVIDENCE_CUES）裡、信心也過了閘門，但題幹一個那一章的線索都沒有 → 閘門不採用，
//   走第二層（kNN 投票／LLM），outcome.data 多一個 gate_veto；沒被否決的題 outcome.data 與改版前逐鍵相同。
//
// 「不誤否決」的驗證：classify golden（數學／物理 92 題、化學 24 題）、fixture 62 題，以**正解的章**當成拆題模型給的章，
// 否決一題都不得觸發。golden 與 fixture 裡**沒有**否決表那一章（位能與能量守恆）的題，所以那一項只證明「別章不受影響」；
// 那一章自己的文字另外用知識點種子檔（名稱、說明、口語版）、各章例句與自撰的典型題驗（下方「量尺自我檢查」把題數釘住）。
// 只讀檔，不連 DB、不呼叫模型。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pr = require('../../utils/chapterPostRules');
const { isValidChapter } = require('../../config/chapters');
const classify = require('../../agents/classify');

const ROOT = path.resolve(__dirname, '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const ENERGY = '位能與能量守恆';

/** 樣卷第 7 題的 OCR 原文（eval/cassettes/extract_ocr/6d90f52e….json；拆題模型給「位能與能量守恆」、信心 0.9，答案卷是直線運動） */
const Q7_OCR = '物體由靜止出發，以2m/s^2的等加速度直線前進，求5秒後的位移。';

/** 有「自己的章」的題：classify golden（含化學）、fixture */
function goldenSets() {
    return {
        'eval/golden/classify.json': readJson('eval/golden/classify.json').entries
            .map(e => ({ id: e.id, subject: e.subject, chapter: e.chapter, text: e.question_text })),
        'eval/golden/classify_chem.json': readJson('eval/golden/classify_chem.json').entries
            .map(e => ({ id: e.id, subject: e.subject, chapter: e.chapter, text: e.question_text })),
        'eval/fixtures/questions.public.json': readJson('eval/fixtures/questions.public.json').questions
            .map(q => ({ id: `fixture #${q.id}`, subject: q.subject, chapter: q.chapter, text: q.question_text }))
    };
}

/** 否決表裡每一章都列成 [科目, 章] */
function tableChapters() {
    return Object.entries(pr.GATE_EVIDENCE_CUES).flatMap(([subject, byChapter]) => Object.keys(byChapter).map(c => [subject, c]));
}

describe('否決表', () => {
    test('只列白名單內的章；線索是正規式；功與能量的線索與界線規則共用同一個（不另抄一份）', () => {
        const list = tableChapters();
        assert.deepEqual(list, [['物理', ENERGY]], '目前只收位能與能量守恆（其他章不收的理由見 docs/local-mode.md 10.28 第 2 點）');
        for (const [subject, chapter] of list) {
            assert.ok(isValidChapter(subject, chapter), `${subject}「${chapter}」不在白名單`);
            const entry = pr.GATE_EVIDENCE_CUES[subject][chapter];
            assert.ok(entry.cues.length > 0 && entry.cues.every(re => re instanceof RegExp));
            assert.ok(typeof entry.label === 'string' && entry.label.length > 0);
            assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.cues));
        }
        assert.ok(pr.GATE_EVIDENCE_CUES['物理'][ENERGY].cues.includes(pr.WORK_ENERGY_MOMENTUM_CUE));
    });
});

describe('gateEvidenceVeto（純函式）', () => {
    test('否決：樣卷第 7 題、水平的運動學、只有牛頓第二定律', () => {
        for (const text of [
            Q7_OCR,
            '物體由靜止出發，以 $2$ m/s$^2$ 的等加速度直線前進，求 $5$ 秒後的位移。',
            '汽車以 20 m/s 等速行駛 10 秒，求行駛的距離。',
            '質量 2 kg 的物體受到合力 10 N，求其加速度。',
            '光滑水平面上，以 6 N 的水平力拉 3 kg 的木塊，求 4 秒後的速度。'   // 「光滑」的滑不算位能的線索
        ]) {
            const v = pr.gateEvidenceVeto('物理', ENERGY, text);
            assert.ok(v, text);
            assert.equal(v.rule, 'gate_evidence_veto');
            assert.equal(v.chapter, ENERGY);
            assert.equal(v.reason, '題幹沒有「位能與能量守恆」的線索（功與能量的字眼、位能的來源（高度、彈簧、重力場））');
        }
    });

    test('不否決：典型的力學能守恆題（高度、斜面、單擺、彈簧、雲霄飛車、上拋、衛星、明寫能量）', () => {
        for (const text of [
            '小球自高 5 公尺的光滑斜面由靜止滑下，求到達底端時的速率。',
            '長 0.8 m 的單擺自水平位置釋放，求擺錘到達最低點時的速率。',
            '質量 0.5 kg 的物體以 4 m/s 撞上彈簧常數 200 N/m 的彈簧，求彈簧的最大壓縮量。',
            '雲霄飛車要能通過半徑 R 的迴圈頂端，求出發點的最低高度。',
            '以 20 m/s 鉛直上拋一球，不計空氣阻力，求球能到達的最大高度。',
            '物體沿光滑的四分之一圓弧軌道由頂端滑到底端，求底端的速度。',
            '人造衛星由低軌道移到高軌道，總力學能如何改變？',
            '一物體的動能為 50 J，速率加倍後動能為多少焦耳？',
            '下列何者的力學能守恆？(A) 等速上升的電梯 (B) 自由落下的石頭',
            '把物體沿粗糙斜面等速推上 2 m，摩擦生熱多少？'
        ]) {
            assert.equal(pr.gateEvidenceVeto('物理', ENERGY, text), null, text);
        }
    });

    test('不在表裡的章、別的科目、空題幹：只有表裡的章會被否決', () => {
        assert.equal(pr.gateEvidenceVeto('物理', '直線運動', Q7_OCR), null);
        assert.equal(pr.gateEvidenceVeto('物理', '功與動能', Q7_OCR), null, '功與動能刻意不收');
        assert.equal(pr.gateEvidenceVeto('物理', '動量守恆與碰撞', '一靜止的 6 kg 物體突然炸裂為 2 kg 與 4 kg 兩塊。'), null, '動量守恆與碰撞刻意不收');
        assert.equal(pr.gateEvidenceVeto('數學', ENERGY, Q7_OCR), null, '科目不對');
        assert.equal(pr.gateEvidenceVeto('化學', ENERGY, Q7_OCR), null);
        assert.equal(pr.gateEvidenceVeto(undefined, ENERGY, Q7_OCR), null);
        assert.equal(pr.gateEvidenceVeto('物理', 'constructor', Q7_OCR), null, '原型鏈上的名字不算');
        assert.ok(pr.gateEvidenceVeto('物理', ENERGY, ''), '空題幹沒有線索（閘門前已擋掉空題幹，這裡只確認不會丟錯）');
        assert.ok(pr.gateEvidenceVeto('物理', ENERGY, undefined));
    });

    test('全形英數先做 NFKC：全形的 Ｊ 也算焦耳', () => {
        assert.equal(pr.gateEvidenceVeto('物理', ENERGY, '某物體的動量為 4 kg·m/s'), null);
        assert.equal(pr.gateEvidenceVeto('物理', ENERGY, '一物體獲得 30 Ｊ，求其速率。'), null);
        assert.ok(pr.gateEvidenceVeto('物理', ENERGY, '以 Joule 為單位'), 'J 後面接字母不算焦耳');
    });
});

describe('不誤否決：以正解的章當成拆題模型給的章，否決一題都不觸發', () => {
    test('classify golden（數學／物理 92 題、化學 24 題）與 fixture 62 題：誤否決 0', () => {
        const sets = goldenSets();
        assert.deepEqual(Object.values(sets).map(a => a.length), [92, 24, 62], '題數變了要重看這一則的說明');
        const falseVetoes = [];
        for (const [file, list] of Object.entries(sets)) {
            for (const q of list) {
                if (pr.gateEvidenceVeto(q.subject, q.chapter, q.text)) falseVetoes.push(`${file} ${q.id}（${q.chapter}）`);
            }
        }
        assert.deepEqual(falseVetoes, []);
    });

    test('否決表那一章自己的文字：知識點種子檔、各章例句、樣卷答案卷一律不否決（量尺自我檢查：19 段）', () => {
        const texts = [];
        for (const [subject, chapter] of tableChapters()) {
            const kc = readJson(`config/kc/${subject}.json`).components.filter(k => k.chapter === chapter);
            for (const k of kc) {
                // 名稱、說明、口語版各自要有線索（不只是合起來有）
                for (const [part, text] of [['name', k.name], ['description', k.description], ['spoken_text', k.spoken_text]]) {
                    if (text) texts.push({ tag: `${k.code} ${part}`, subject, chapter, text });
                }
            }
            const { CHAPTER_EXAMPLES } = require('../../config/chapterExamples');
            texts.push({ tag: `例句 ${chapter}`, subject, chapter, text: CHAPTER_EXAMPLES[subject][chapter] });
        }
        const pdfDir = path.join(ROOT, 'eval', 'golden', 'pdf_sample');
        for (const f of fs.readdirSync(pdfDir).filter(n => n.endsWith('.json'))) {
            for (const q of readJson(`eval/golden/pdf_sample/${f}`).questions) {
                texts.push({ tag: `pdf_sample ${f.slice(0, 8)} #${q.no}`, subject: q.subject, chapter: q.chapter, text: q.question_text });
            }
        }
        const own = texts.filter(t => pr.GATE_EVIDENCE_CUES[t.subject] && pr.GATE_EVIDENCE_CUES[t.subject][t.chapter]);
        // 知識點 6 個 × 名稱／說明／口語版 ＝ 18 段，加例句 1 段；樣卷答案卷沒有這一章的題
        assert.equal(own.length, 19, `量尺自我檢查：否決表那一章的文字段數（${own.length}）`);
        const misfires = texts.filter(t => pr.gateEvidenceVeto(t.subject, t.chapter, t.text)).map(t => t.tag);
        assert.deepEqual(misfires, []);
    });

    test('涵蓋率（只報告、釘住）：物理題若被拆題模型誤標成「位能與能量守恆」，否決會攔下的題數', () => {
        const sets = goldenSets();
        const count = (list) => {
            const phys = list.filter(q => q.subject === '物理' && q.chapter !== ENERGY);
            return { n: phys.length, vetoed: phys.filter(q => pr.gateEvidenceVeto('物理', ENERGY, q.text)).length };
        };
        assert.deepEqual(count(sets['eval/golden/classify.json']), { n: 43, vetoed: 30 });
        assert.deepEqual(count(sets['eval/fixtures/questions.public.json']), { n: 30, vetoed: 20 });
        // 攔不下的題都有位能的線索（自由落下的高度、斜面、電場力作的功、定滑輪的「滑」…）：那些題就算拆題模型標錯，
        // 也是「看起來像能量題」的錯，留給閘門，不在否決的範圍內。
        const fx47 = sets['eval/fixtures/questions.public.json'].find(q => q.id === 'fixture #47');
        assert.ok(pr.gateEvidenceVeto('物理', ENERGY, fx47.text), '樣卷第 7 題的原題（fixture #47）會被攔下');
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
            jq: { id: 1, idx: 7, payload: {}, retries: {} },
            logger: { info() {}, warn() {}, error() {} },
            config: { models: { extract: 'ollama:qwen3-vl:8b', text: 'ollama:qwen3:8b' }, thresholds: { classifyMinConf: 0.8 }, features: {} },
            signal: undefined
        }
    };
}

describe('agents/classify.js：零成本閘門的證據否決', () => {
    const VETO = {
        rule: 'gate_evidence_veto', chapter: ENERGY, confidence: 0.9,
        reason: '題幹沒有「位能與能量守恆」的線索（功與能量的字眼、位能的來源（高度、彈簧、重力場））'
    };
    const NOTE = '〔閘門否決：拆題模型給「位能與能量守恆」（信心 0.9），題幹沒有這一章的線索，改由第二層判斷〕';

    test('被否決：不走閘門、呼叫一次 LLM；data 多 gate_veto、rationale 前面一句說明；模板與 cassette 的鍵照舊', async () => {
        const { ctx, calls } = classifyCtx({ chapter: '直線運動', confidence: 0.95, rationale: '等加速度公式。' });
        const outcome = await classify.run(ctx, { subject: '物理', chapter: ENERGY, chapter_confidence: 0.9, question_text: Q7_OCR });
        assert.equal(calls.length, 1);
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(outcome.data, {
            chapter: '直線運動', confidence: 0.95, rationale: `${NOTE}等加速度公式。`, source: 'llm', few_shot_ids: [],
            gate_veto: VETO
        });
        assert.equal(calls[0].template, 'classify.v2');
        assert.deepEqual(calls[0].cacheKeyParts, { template: 'classify.v2', questionText: Q7_OCR, fewShotIds: [] }, '鍵與信心不足走第二層時逐字相同');
    });

    test('被否決的鍵＝信心不足走第二層的鍵（cassette 一份就夠，不因否決多一種鍵）', async () => {
        const a = classifyCtx({ chapter: '直線運動', confidence: 0.95, rationale: 'r' });
        await classify.run(a.ctx, { subject: '物理', chapter: ENERGY, chapter_confidence: 0.9, question_text: Q7_OCR });
        const b = classifyCtx({ chapter: '直線運動', confidence: 0.95, rationale: 'r' });
        await classify.run(b.ctx, { subject: '物理', chapter: '', chapter_confidence: 0, question_text: Q7_OCR });
        assert.deepEqual(a.calls[0].cacheKeyParts, b.calls[0].cacheKeyParts);
        assert.equal(a.calls[0].parts[0].text, b.calls[0].parts[0].text, 'prompt 也相同（否決不進 prompt）');
    });

    test('被否決後第二層照舊套界線規則；第二層回的章不在白名單時照舊 chapter_invalid，data 也帶 gate_veto', async () => {
        const ok = classifyCtx({ chapter: '位能與能量守恆', confidence: 0.6, rationale: 'r' });
        const kept = await classify.run(ok.ctx, { subject: '物理', chapter: ENERGY, chapter_confidence: 0.9, question_text: Q7_OCR });
        assert.equal(kept.data.chapter, ENERGY, '否決不決定章：第二層仍選這一章就照第二層');
        assert.deepEqual(kept.data.gate_veto, VETO);

        const bad = classifyCtx({ chapter: '等加速度運動', confidence: 0.6, rationale: 'r' });
        const failed = await classify.run(bad.ctx, { subject: '物理', chapter: ENERGY, chapter_confidence: 0.9, question_text: Q7_OCR });
        assert.equal(failed.kind, 'fail');
        assert.equal(failed.reason, 'chapter_invalid');
        assert.deepEqual(failed.data.gate_veto, VETO);
        assert.equal(failed.data.rationale, `${NOTE}r`);
    });

    test('沒被否決：有線索的能量題照舊走閘門，outcome.data 與改版前逐鍵相同（沒有 gate_veto）', async () => {
        const { ctx, calls } = classifyCtx({});
        const outcome = await classify.run(ctx, { subject: '物理', chapter: ENERGY, chapter_confidence: 0.9, question_text: '小球自高 5 公尺的光滑斜面由靜止滑下，求到達底端時的速率。' });
        assert.equal(calls.length, 0);
        assert.deepEqual(outcome.data, {
            chapter: ENERGY, confidence: 0.9,
            rationale: '拆題模型給的章節在白名單內，且信心 0.9 ≥ 0.8，零成本閘門直接採用。', source: 'gate'
        });
    });

    test('信心不足本來就不走閘門：不做否決、data 沒有 gate_veto', async () => {
        const { ctx, calls } = classifyCtx({ chapter: '直線運動', confidence: 0.95, rationale: 'r' });
        const outcome = await classify.run(ctx, { subject: '物理', chapter: ENERGY, chapter_confidence: 0.5, question_text: Q7_OCR });
        assert.equal(calls.length, 1);
        assert.deepEqual(Object.keys(outcome.data), ['chapter', 'confidence', 'rationale', 'source', 'few_shot_ids']);
        assert.equal(outcome.data.rationale, 'r');
    });

    test('golden 92 題以正確的章、信心 1 走閘門：一題都不被否決、一次 LLM 都不呼叫', async () => {
        const golden = readJson('eval/golden/classify.json').entries;
        for (const e of golden) {
            const { ctx, calls } = classifyCtx({});
            const outcome = await classify.run(ctx, { subject: e.subject, chapter: e.chapter, chapter_confidence: 1, question_text: e.question_text });
            assert.equal(calls.length, 0, e.id);
            assert.equal(outcome.data.source, 'gate', e.id);
            assert.equal(outcome.data.gate_veto, undefined, e.id);
        }
    });
});
