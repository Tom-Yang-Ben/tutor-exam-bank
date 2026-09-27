// Owner 第五輪決策（2026-09-27）的模板與 schema 改動（dec/r6-templates；docs/local-mode.md「第五輪 A 模板與 schema」一節）
//
//   LC-1＝2：agents/schemas/classify.json 的欄位順序改成「理由 → 章節 → 信心」（化學分類共用同一份 schema）。
//            Ollama（format＝toOllamaSchema，語法約束依 properties 的順序）與 Gemini（responseJsonSchema，
//            properties 的鍵序＋propertyOrdering）兩條路徑送出去的 schema 都照這個順序。
//   L-2＝1 ：LATEX_RULES／CHEM_LATEX_RULES 明講「JSON 字串裡的反斜線要寫成兩個」，附正反例；用到它們的
//            8 個模板全部升版。模型照做時（JSON 原文 \\frac → 解析後 \frac），事後修復（latexEscapeRepair）必須是 no-op。
//   V5-6＝2：變式 prompt 加「這是第 N 題（共 M 題）」與已生成的兄弟題幹；total 與兄弟內容進 cassette 的鍵；
//            runner 與 eval 都依序生成、把前面的結果傳進來。
//
// 全部不連 Ollama／Gemini／PG：ollama 用假傳輸、gemini 用假 client、agent 用假 ctx.llm。
// 執行：npm test

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildSchema } = require('../../agents/schemas');
const promptParts = require('../../agents/promptParts');
const extract = require('../../agents/extract');
const variant = require('../../agents/generateVariant');
require('../../agents/classify');
const { getTemplate } = require('../../services/llm/templates');
const ollama = require('../../services/llm/ollama');
const gemini = require('../../services/llm/gemini');
const throttle = require('../../services/llm/throttle');
const fake = require('../../services/llm/fake');
const llm = require('../../services/llm');
const repair = require('../../services/llm/latexEscapeRepair');

const ORDER = ['rationale', 'chapter', 'confidence'];

// ───────────────────────── LC-1：classify 的欄位順序 ─────────────────────────

describe('〔Owner 第五輪 LC-1〕classify schema：理由 → 章節 → 信心', () => {
    for (const group of ['math_physics', 'chemistry']) {
        test(`${group}：properties 鍵序、propertyOrdering、required 都是 ${ORDER.join(' → ')}`, () => {
            const s = buildSchema('classify', { group });
            assert.deepEqual(Object.keys(s.properties), ORDER);
            assert.deepEqual([...s.propertyOrdering], ORDER);
            assert.deepEqual([...s.required], ORDER);
            assert.ok(Array.isArray(s.properties.chapter.enum) && s.properties.chapter.enum.length > 0, 'chapter 仍是白名單 enum');
            assert.match(s.properties.rationale.description, /^先寫這一欄/);
        });
    }

    test('化學分類與數學／物理用同一份 schema 檔：只差 chapter 的值域', () => {
        const mp = JSON.parse(JSON.stringify(buildSchema('classify')));
        const ch = JSON.parse(JSON.stringify(buildSchema('classify', { group: 'chemistry' })));
        delete mp.properties.chapter.enum;
        delete ch.properties.chapter.enum;
        assert.deepEqual(ch, mp);
    });

    describe('Ollama 路徑：format 與欄位說明都照 schema 順序', () => {
        const ENV_KEYS = ['OLLAMA_HOST', 'OLLAMA_NUM_CTX', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_CONCURRENCY', 'OLLAMA_RPM', 'OLLAMA_TIMEOUT_MS'];
        const backup = {};
        before(() => { for (const k of ENV_KEYS) { backup[k] = process.env[k]; delete process.env[k]; } });
        after(() => {
            for (const [k, v] of Object.entries(backup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
            ollama._resetForTest();
        });
        beforeEach(() => { ollama._resetForTest(); throttle._resetForTest(); });

        for (const group of ['math_physics', 'chemistry']) {
            test(`${group}：/api/chat 的 format.properties 依序、系統提示裡的欄位說明也依序`, async () => {
                const payloads = [];
                ollama._setTransportForTest(async (url, payload) => {
                    payloads.push(JSON.parse(JSON.stringify(payload)));
                    const chapter = buildSchema('classify', { group }).properties.chapter.enum[0];
                    const content = JSON.stringify({ rationale: '理由', chapter, confidence: 0.9 });
                    return { status: 200, text: JSON.stringify({ model: 'qwen3:8b', done: true, done_reason: 'stop', message: { role: 'assistant', content }, prompt_eval_count: 1, eval_count: 1 }) };
                });
                const res = await ollama.generateJson({ model: 'qwen3:8b', system: 'S', parts: [{ text: 'q' }], schema: buildSchema('classify', { group }) });
                assert.deepEqual(Object.keys(res.data), ORDER);

                const { format, messages } = payloads[0];
                assert.deepEqual(Object.keys(format.properties), ORDER, 'Ollama 的文法依 properties 的順序產生');
                assert.equal('propertyOrdering' in format, false);
                assert.deepEqual(format.required, ORDER);
                const sys = messages[0].content;
                const at = ORDER.map(k => sys.indexOf(`- ${k}（`));
                assert.ok(at.every(i => i >= 0), sys);
                assert.deepEqual([...at].sort((a, b) => a - b), at, '欄位說明依「理由 → 章節 → 信心」列出');
            });
        }
    });

    describe('Gemini 路徑：responseJsonSchema 的鍵序與 propertyOrdering', () => {
        after(() => gemini._setClientForTest(null));
        beforeEach(() => throttle._resetForTest());

        for (const group of ['math_physics', 'chemistry']) {
            test(`${group}：送出的 responseJsonSchema 就是這份 schema（鍵序與 propertyOrdering 都是理由先）`, async () => {
                const calls = [];
                gemini._setClientForTest({
                    models: {
                        generateContent: async (req) => {
                            calls.push(req);
                            return { text: '{"rationale":"r","chapter":"x","confidence":0.5}', candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
                        }
                    }
                });
                const schema = buildSchema('classify', { group });
                await gemini.generateJson({ model: 'gemini-3.5-flash', system: 'S', parts: [{ text: 'q' }], schema });
                const sent = calls[0].config.responseJsonSchema;
                assert.equal(sent, schema);
                assert.deepEqual(Object.keys(sent.properties), ORDER);
                assert.deepEqual([...sent.propertyOrdering], ORDER);
            });
        }

        test('退路（拆掉 enum 重送）也保持同樣的順序', () => {
            const { schema } = gemini.stripEnums(buildSchema('classify'));
            assert.deepEqual(Object.keys(schema.properties), ORDER);
            assert.deepEqual(schema.propertyOrdering, ORDER);
        });
    });
});

// ───────────────────────── L-2：JSON 字串裡的反斜線寫兩個 ─────────────────────────

/** 從規則文字取出「正確（JSON 原文）：」後面、引號括起來的正例（原文，未解析） */
function positivesOf(ruleText) {
    const seg = ruleText.slice(ruleText.indexOf('正確（JSON 原文）：'), ruleText.indexOf('；LaTeX 的換列'));
    return seg.match(/"(?:[^"\\]|\\.)*"/g) || [];
}

describe('〔Owner 第五輪 L-2〕公式規範：JSON 字串裡的反斜線要寫成兩個', () => {
    const RULES = { LATEX_RULES: promptParts.LATEX_RULES, CHEM_LATEX_RULES: promptParts.CHEM_LATEX_RULES };

    test('兩份規範的最後一條就是這條規則；原本各條一字未改', () => {
        const math = promptParts.LATEX_RULES.split('\n');
        const chem = promptParts.CHEM_LATEX_RULES.split('\n');
        assert.equal(math.length, 6);
        assert.equal(chem.length, 7);
        assert.ok(math[5].startsWith('(5) 你的輸出是 JSON'));
        assert.ok(chem[6].startsWith('(6) 你的輸出是 JSON'));
        for (const line of [math[5], chem[6]]) {
            assert.ok(line.includes('每一個反斜線都要寫成兩個'));
            assert.ok(line.includes('錯誤："$\\frac{1}{2}$"'), '反例是單一反斜線');
            assert.ok(line.includes('在 JSON 裡要寫成 "\\\\\\\\"'), 'LaTeX 的換列寫四個');
        }
        // (4)／(5) 之前的內容：與改版前逐字相同（改版前的最後一行，釘住開頭與結尾）
        assert.ok(math[4].startsWith('(4) 請使用 LaTeX 指令而非 Unicode 符號'));
        assert.ok(chem[5].startsWith('(5) 請使用 LaTeX 指令而非 Unicode 符號'));
    });

    for (const [name, text] of Object.entries(RULES)) {
        test(`${name} 的正例：當 JSON 解析後是單一反斜線的 LaTeX，事後修復對它們是 no-op`, () => {
            const pos = positivesOf(text);
            assert.ok(pos.length >= 3, pos.join(' '));
            for (const raw of pos) {
                assert.ok(raw.includes('\\\\'), `正例的 JSON 原文要是兩個反斜線：${raw}`);
                const parsed = JSON.parse(raw);
                assert.ok(!/\\\\/.test(parsed), '解析後是單一反斜線');
                assert.ok(/^\$\\[a-z]+/.test(parsed), parsed);
                assert.equal(repair.hasNonNewlineControl(parsed), false);
                const r = repair.repairString(parsed);
                assert.equal(r.text, parsed, `修復不得動照做的輸出：${raw}`);
                const res = { data: { question_text: parsed } };
                assert.equal(repair.applyToResult(res), res, '沒有修到任何東西 → 回傳原物件（沒有 latexRepair 鍵）');
            }
            // 換列的正例："\\\\" 解析後是 LaTeX 的 \\
            assert.equal(JSON.parse('"\\\\\\\\"'), '\\\\');
        });

        test(`${name} 的反例：單一反斜線真的會被 JSON 吃掉（規則說的是事實），修復仍會補回（第二道防線）`, () => {
            const parsed = JSON.parse('"$\\frac{1}{2}$"');
            assert.equal(parsed, '$\frac{1}{2}$');
            assert.equal(repair.repairString(parsed).text, '$\\frac{1}{2}$');
        });
    }

    describe('services/llm.generateJson：模型照做（JSON 原文一律兩個反斜線）時修復是 no-op', () => {
        const ENV_KEYS = ['LLM_MODE', 'EVAL_CASSETTE_DIR', 'OLLAMA_HOST', 'GEMINI_API_KEY', 'GEMINI_RPM', 'JOB_CONCURRENCY'];
        const backup = {};
        let tmp;
        before(() => {
            for (const k of ENV_KEYS) { backup[k] = process.env[k]; delete process.env[k]; }
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-r6-'));
            process.env.EVAL_CASSETTE_DIR = tmp;
        });
        after(() => {
            for (const [k, v] of Object.entries(backup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
            ollama._resetForTest();
            gemini._setClientForTest(null);
            fs.rmSync(tmp, { recursive: true, force: true });
        });
        beforeEach(() => { ollama._resetForTest(); throttle._resetForTest(); fake._resetForTest(); gemini._setClientForTest(null); });

        // b f n r t 開頭的指令（會被 JSON 吃掉的那五個字母）、Ollama 會換字母的 \circ、化學的 \ce、換列 \\、
        // 真的換行（\n）與公式外的定位字元旁的英文字，全部照規則寫兩個反斜線
        const INTENDED = {
            question_text: '已知 $\\frac{1}{2}\\times\\theta \\neq \\beta$，$\\rho=\\nu\\bar{x}$，$37^\\circ$，$\\tan\\theta\\to\\infty$。\n(A) $\\sqrt{2}$',
            answer_text: '$$\\begin{array}{|c|c|} \\hline a & b \\\\ \\hline \\end{array}$$，$\\ce{2H2 + O2 -> 2H2O}$，$\\ce{Fe^{3+}}$',
            steps: ['$\\left(\\frac{a}{b}\\right)$', '$\\bm{F}=m\\bm{a}$，$\\text{kg}$']
        };
        const MODEL_JSON = JSON.stringify(INTENDED);   // JSON.stringify 就是「每個反斜線寫兩個」

        test('JSON 原文確實每個反斜線都寫兩個（前提）', () => {
            assert.ok(MODEL_JSON.includes('\\\\frac') && MODEL_JSON.includes('\\\\\\\\ '));
            assert.ok(!/(^|[^\\])\\f/.test(MODEL_JSON.replace(/\\\\/g, '')), '沒有單一反斜線的 \\f');
        });

        test('live（Ollama）：data 等於原意、沒有 latexRepair 鍵', async () => {
            process.env.LLM_MODE = 'live';
            ollama._setTransportForTest(async () => ({
                status: 200,
                text: JSON.stringify({ model: 'qwen3:8b', done: true, done_reason: 'stop', message: { role: 'assistant', content: MODEL_JSON }, prompt_eval_count: 1, eval_count: 1 })
            }));
            const res = await llm.generateJson({ model: 'ollama:qwen3:8b', parts: [{ text: 'q' }] });
            assert.deepEqual(res.data, INTENDED);
            assert.ok(!('latexRepair' in res), JSON.stringify(res.latexRepair));
        });

        test('live（Gemini）：同樣是 no-op', async () => {
            process.env.LLM_MODE = 'live';
            gemini._setClientForTest({ models: { generateContent: async () => ({ text: MODEL_JSON, candidates: [{ finishReason: 'STOP' }], usageMetadata: {} }) } });
            const res = await llm.generateJson({ model: 'gemini:gemini-3.5-flash', parts: [{ text: 'q' }] });
            assert.deepEqual(res.data, INTENDED);
            assert.ok(!('latexRepair' in res));
        });

        test('repo 內全部 cassette：把「修好的內容」當成模型照做的輸出（JSON 原文寫兩個反斜線）再解析，修復一處都不動', () => {
            // 修好、而且沒有殘留控制字元的回應，就是「模型照規則寫」時解析出來的樣子
            const root = path.resolve(__dirname, '..', '..', 'eval', 'cassettes');
            let checked = 0;
            for (const agent of fs.readdirSync(root)) {
                const dir = path.join(root, agent);
                if (!fs.statSync(dir).isDirectory()) continue;
                for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
                    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                    const data = c && c.response && c.response.data;
                    if (data === undefined) continue;
                    const fixedOnce = repair.applyToResult({ data });
                    if (fixedOnce.latexRepair && fixedOnce.latexRepair.unresolved.length) continue;   // 救不回來的不是「照做」的樣子
                    const obeyed = JSON.parse(JSON.stringify(fixedOnce.data));
                    if (repair.hasNonNewlineControl(obeyed)) continue;
                    const again = repair.applyToResult({ data: obeyed });
                    assert.ok(!again.latexRepair, `${agent}/${f}：${JSON.stringify(again.latexRepair)}`);
                    checked += 1;
                }
            }
            assert.ok(checked > 400, `至少要比對到大部分 cassette（實際 ${checked}）`);
        });
    });

    test('用到這段規範的 8 個模板都已升版、註冊內容含這條規則；舊版號不再註冊', () => {
        const rule = '每一個反斜線都要寫成兩個';
        const current = ['extract.v3', 'extract_chem.v2', 'extract_vision.v2', 'extract_vision_chem.v2',
            'extract_ocr.v2', 'extract_ocr_chem.v2', 'variant.v2', 'variant_chem.v2'];
        for (const name of current) {
            const t = getTemplate(name);
            assert.ok(t, `${name} 沒有註冊`);
            assert.ok(t.includes(rule), `${name} 不含新規則`);
        }
        for (const old of ['extract.v2', 'extract_chem.v1', 'extract_vision.v1', 'extract_vision_chem.v1',
            'extract_ocr.v1', 'extract_ocr_chem.v1', 'variant.v1', 'variant_chem.v1']) {
            assert.equal(getTemplate(old), null, `${old} 不該再被註冊（改了模板要升版）`);
        }
        assert.deepEqual(
            [extract.TEMPLATE, extract.TEMPLATE_CHEM, extract.TEMPLATE_VISION, extract.TEMPLATE_VISION_CHEM, extract.TEMPLATE_OCR, extract.TEMPLATE_OCR_CHEM, variant.TEMPLATE, variant.TEMPLATE_CHEM],
            current, 'agent 實際送出的識別名就是新版號');
        // classify／lint／verify／nlq 的模板不含公式規範（本次不動）
        for (const name of ['classify.v2', 'classify_chem.v1']) {
            assert.ok(!getTemplate(name).includes(rule), name);
        }
    });
});

// ───────────────────────── V5-6：兄弟變式不一樣 ─────────────────────────

const SOURCE = {
    id: 12, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3,
    question_text: '設 $\\vec{a}=(3,4)$、$\\vec{b}=(1,2)$，求兩向量的夾角餘弦值。',
    answer_text: '$\\frac{11}{5\\sqrt{5}}$', variant_of: null
};
const CHEM_SOURCE = {
    id: 40, subject: '化學', chapter: CHEM_CHAPTER(), question_type: '計算', difficulty: 2,
    question_text: '取 $0.10\\ \\mathrm{M}$ 的 $\\ce{HCl}$ 溶液 $25\\ \\mathrm{mL}$，以 $\\ce{NaOH}$ 滴定，求所需體積。',
    answer_text: '$25\\ \\mathrm{mL}$', variant_of: null
};
function CHEM_CHAPTER() { return require('../../config/chapters').CHAPTERS['化學'][0]; }

const GOOD = {
    chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
    question_text: '在平面上，甲船的位移為 $\\vec{p}=(6,8)$ 公里，乙船的位移為 $\\vec{q}=(5,-12)$ 公里。試求兩船位移方向之間夾角的餘弦值為何？',
    answer_text: '$-\\frac{27}{65}$'
};

function fakeCtx(data = GOOD) {
    const calls = [];
    const a = new Array(768).fill(0); a[0] = 1;
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => { calls.push(opts); return { data, usage: {}, latencyMs: 1, raw: null, schemaFallback: false }; },
                embed: async () => ({ vectors: [a, a], usage: {} })
            },
            config: { thresholds: { variantOfftopicSimMin: 0.9, variantMinEdit: 0.08 }, models: { variant: 'gemini:gemini-3.1-pro-preview' } },
            job: { kind: 'variant' }
        }
    };
}

const SIB1 = { idx: 1, question_text: '小明騎腳踏車，位移 $\\vec{u}=(3,4)$ 公里，求與 $\\vec{v}=(4,3)$ 的夾角餘弦（含 $& 與 $1 字樣）。' };
const SIB2 = { idx: 2, question_text: '無人機的航向為 $\\vec{w}=(1,1)$，求與 $x$ 軸的夾角。' };

describe('〔Owner 第五輪 V5-6〕變式 prompt：第 N 題（共 M 題）與兄弟題幹', () => {
    test('prompt 寫出「第 N 題（共 M 題）」並逐題列出兄弟題幹（含 $ 的題幹原樣照列）', () => {
        const p = variant.buildPrompt({ source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 3, total: 3, siblings: [SIB2, SIB1] });
        assert.ok(p.includes('【這是這次要出的第 3 題（共 3 題）】'));
        assert.ok(p.includes('【這次已經出好的題目（同一道藍本），這一題的情境與數字必須和它們都不一樣】'));
        const i1 = p.indexOf(`- 第 1 題：${SIB1.question_text}`);
        const i2 = p.indexOf(`- 第 2 題：${SIB2.question_text}`);
        assert.ok(i1 > 0 && i2 > i1, '依 idx 由小到大列出，$& 與 $1 不被當成替換樣式');
        assert.ok(p.includes('6. 同一道藍本這次要出好幾題'));
    });

    test('第 1 題沒有兄弟：不出現兄弟區塊的標題；total 沒給時當作 idx、比 idx 小時也當作 idx', () => {
        const p1 = variant.buildPrompt({ source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 1, total: 2 });
        assert.ok(p1.includes('第 1 題（共 2 題）'));
        assert.ok(!p1.includes('【這次已經出好的題目'));
        assert.ok(variant.buildPrompt({ source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 2 }).includes('第 2 題（共 2 題）'));
        assert.ok(variant.buildPrompt({ source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 3, total: 1 }).includes('第 3 題（共 3 題）'));
    });

    test('兄弟之間 prompt 的前段（白名單、藍本、鄰居、規則 1～6）逐字相同：本機 prompt 快取可以重用', () => {
        const a = variant.buildPrompt({ source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 1, total: 2 });
        const b = variant.buildPrompt({ source: SOURCE, neighbors: [], difficulty_delta: 0, idx: 2, total: 2, siblings: [SIB1] });
        let n = 0;
        while (n < a.length && a[n] === b[n]) n += 1;
        const common = a.slice(0, n);
        assert.ok(common.includes('6. 同一道藍本這次要出好幾題'), '分岔點在規則之後');
        assert.ok(common.includes('【數學科精細章節白名單'));
    });

    test('兄弟題幹太長時截斷（一題最多 SIBLING_TEXT_MAX 字），換行壓成一行', () => {
        const long = { idx: 1, question_text: `第一行\n${'甲'.repeat(variant.SIBLING_TEXT_MAX + 50)}` };
        const text = variant.siblingsText([long]);
        const line = text.split('\n')[1];
        assert.equal(line.length, '- 第 1 題：'.length + variant.SIBLING_TEXT_MAX);
        assert.ok(line.startsWith('- 第 1 題：第一行 甲'));
    });

    test('化學藍本走 variant_chem.v2，同樣有第幾題與兄弟區塊（規則 7）', async () => {
        const chemGood = { ...GOOD, chapter: CHEM_SOURCE.chapter, question_text: '以 $0.20\\ \\mathrm{M}$ 的 $\\ce{KOH}$ 滴定 $\\ce{HNO3}$ 溶液 $40\\ \\mathrm{mL}$，求所需體積與當量點的 pH。' };
        const f = fakeCtx(chemGood);
        await variant.run(f.ctx, { source: CHEM_SOURCE, neighbors: [], difficulty_delta: 0, idx: 2, total: 2, siblings: [SIB1] });
        const opts = f.calls[0];
        assert.equal(opts.template, 'variant_chem.v2');
        assert.equal(opts.agent, 'variant_chem');
        const p = opts.parts[0].text;
        assert.ok(p.includes('【這是這次要出的第 2 題（共 2 題）】'));
        assert.ok(p.includes(`- 第 1 題：${SIB1.question_text}`));
        assert.ok(p.includes('7. 同一道藍本這次要出好幾題'));
    });

    test('註冊的模板（cassette 雜湊的來源）含 {{IDX}}、{{TOTAL}}、{{SIBLINGS}} 三個占位', () => {
        for (const name of ['variant.v2', 'variant_chem.v2']) {
            const t = getTemplate(name);
            for (const ph of ['{{IDX}}', '{{TOTAL}}', '{{SIBLINGS}}']) assert.ok(t.includes(ph), `${name} 缺 ${ph}`);
        }
    });
});

describe('〔Owner 第五輪 V5-6〕cassette 的鍵：idx、total 與兄弟內容都要進鍵（否則 replay 撞鍵）', () => {
    async function keyOf(input) {
        const f = fakeCtx();
        await variant.run(f.ctx, { source: SOURCE, neighbors: [], difficulty_delta: 0, ...input });
        return f.calls[0].cacheKeyParts;
    }

    test('鍵的形狀：原本五個鍵＋total＋siblings（兄弟全文 sha256 前 16 碼，不含題幹原文）', async () => {
        const k = await keyOf({ idx: 2, total: 3, siblings: [SIB1] });
        assert.deepEqual(Object.keys(k), ['template', 'sourceQuestionId', 'difficultyDelta', 'idx', 'anchorIds', 'total', 'siblings']);
        assert.equal(k.template, 'variant.v2');
        assert.equal(k.total, 3);
        assert.equal(k.siblings.length, 1);
        assert.match(k.siblings[0], /^[0-9a-f]{16}$/);
        assert.ok(!JSON.stringify(k).includes('腳踏車'), '鍵不得含題幹原文（cassette 只存摘要）');
    });

    test('前面兄弟的內容不同 → 鍵不同；相同 → 鍵相同；兄弟傳入的順序不影響鍵', async () => {
        const a = await keyOf({ idx: 3, total: 3, siblings: [SIB1, SIB2] });
        const b = await keyOf({ idx: 3, total: 3, siblings: [SIB2, SIB1] });
        const c = await keyOf({ idx: 3, total: 3, siblings: [SIB1, { ...SIB2, question_text: `${SIB2.question_text}改` }] });
        const d = await keyOf({ idx: 3, total: 3, siblings: [SIB1] });
        assert.deepEqual(a, b);
        assert.notDeepEqual(a, c);
        assert.notDeepEqual(a, d);
    });

    test('idx 或 total 不同 → 鍵不同；題幹空白的兄弟不算', async () => {
        const base = await keyOf({ idx: 2, total: 2, siblings: [SIB1] });
        assert.notDeepEqual(base, await keyOf({ idx: 2, total: 3, siblings: [SIB1] }));
        assert.notDeepEqual(await keyOf({ idx: 1, total: 2 }), await keyOf({ idx: 2, total: 2 }));
        assert.deepEqual(await keyOf({ idx: 2, total: 2, siblings: [SIB1, { idx: 0, question_text: '   ' }] }), base);
    });

    test('feedback 仍不進鍵（重試回放同一捲帶）', async () => {
        const a = await keyOf({ idx: 2, total: 2, siblings: [SIB1] });
        const b = await keyOf({ idx: 2, total: 2, siblings: [SIB1], feedback: '上次太像藍本' });
        assert.deepEqual(a, b);
    });
});

describe('〔Owner 第五輪 V5-6〕eval 的變式 suite：依序生成、把前面通過的兄弟傳給下一題', () => {
    test('每個藍本 idx 1→2 依序呼叫；第 2 題收到 total＝2 與第 1 題（只有通過生成節點的才算兄弟）', async () => {
        const suite = require('../../eval/lib/suiteVariant');
        const seen = [];
        const generateFn = async (ctx, input) => {
            seen.push({ sourceId: input.source.id, idx: input.idx, total: input.total, siblings: input.siblings.map(s => ({ ...s })) });
            const s = input.source;
            // 藍本 id 為奇數時第 1 題不過文字閘門（fail），用來確認失敗的不算兄弟
            if (input.idx === 1 && s.id % 2 === 1) return { kind: 'fail', reason: 'text_gate', feedback: 'x' };
            return {
                kind: 'pass',
                data: {
                    idx: input.idx, subject: s.subject, chapter: s.chapter, chapter_confidence: 0.9,
                    question_type: s.question_type, difficulty: s.difficulty,
                    question_text: `假變式 ${s.id}-${input.idx}：甲乙兩地相距 $${input.idx * 11}$ 公里，求對應的結果。`,
                    answer_text: '$1$', chunk_no: 0, page_range: null, variant_of_root: s.id, anchor_ids: []
                },
                gate: { text_gate: { ok: true, reason: null, edit_ratio: 0.9 }, sim: 0.9 }
            };
        };
        const fakeVerify = { run: async () => ({ kind: 'pass', data: { compare: 'agree', final_answer: '$1$' } }) };
        await suite.runVariantSuite({ generateFn, agents: { verify: fakeVerify } });

        assert.equal(seen.length, 60);
        for (let i = 0; i < seen.length; i += 2) {
            const [first, second] = [seen[i], seen[i + 1]];
            assert.equal(first.sourceId, second.sourceId);
            assert.deepEqual([first.idx, second.idx], [1, 2]);
            assert.equal(first.total, 2);
            assert.equal(second.total, 2);
            assert.deepEqual(first.siblings, []);
            if (first.sourceId % 2 === 1) {
                assert.deepEqual(second.siblings, [], '第 1 題沒過生成節點，不是兄弟');
            } else {
                assert.deepEqual(second.siblings, [{ idx: 1, question_text: `假變式 ${first.sourceId}-1：甲乙兩地相距 $11$ 公里，求對應的結果。` }]);
            }
        }
        assert.ok(seen.some(s => s.sourceId % 2 === 1) && seen.some(s => s.sourceId % 2 === 0), '兩種情形都要有');
    });
});
