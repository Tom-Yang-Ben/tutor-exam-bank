// ─────────────────────────────────────────────────────────────
// r6Interactions.test.js — 第五輪五組併進 dec/integration-r6 之後，兩組之間的交互（〔整合 2026-09-27〕）
//
// 五組各自在 local/integration-r5（a670783）上開、各自的測試只看得到自己那一組。這裡釘住「兩組同時生效」時的行為：
//   ① A（variant.v2：兄弟題幹、L-2 反斜線寫兩個）× C（L-1 control_char、L-3 \bullet／\textbf）× latexEscapeRepair
//   ② A（classify schema：理由 → 章節 → 信心）× C（LC-3：零成本閘門也套界線規則）
//   ③ D（LOCAL_EXTRACT_MODE 程式預設 ocr）× C（D-2：OCR 模式 saved_rate 不比門檻）
//   ④ B（migration 0020 output_truncated）× 0019 的 review_reason 完整值域 × D（預設 ocr 時 runner 檢查 0019）
// 只讀檔與純函式，不連 DB、不呼叫模型。docs/local-mode.md 10.16～10.20。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');

const generateVariant = require('../../agents/generateVariant');
const { LATEX_RULES, CHEM_LATEX_RULES } = require('../../agents/promptParts');
const { repairLatexEscapes, UNSUPPORTED_LATEX_COMMANDS } = require('../../services/llm/latexEscapeRepair');
const { formulaLint, findControlChars } = require('../../utils/formulaLint');
const classify = require('../../agents/classify');
const classifySchema = require('../../agents/schemas/classify.json');

const errorRules = (text) => formulaLint(text).issues.filter(i => i.sev === 'error').map(i => i.rule);

/** 從 L-2 規則裡取出「正確（JSON 原文）：…；」那一段的每個 JSON 字串 */
function jsonPositives(rules) {
    const m = rules.match(/正確（JSON 原文）：(.*?)；/);
    assert.ok(m, '規則裡要有正例');
    return m[1].split('、').map(s => JSON.parse(s));
}

describe('① A variant.v2 × C L-1／L-3 × latexEscapeRepair', () => {
    test('variant.v2／variant_chem.v2 的 prompt 同時帶 L-2 規則與兄弟區塊', () => {
        assert.equal(generateVariant.TEMPLATE, 'variant.v2');
        assert.equal(generateVariant.TEMPLATE_CHEM, 'variant_chem.v2');
        const prompt = generateVariant.buildPrompt({
            source: { id: 1, subject: '數學', chapter: '指數與對數', difficulty: 3, question_text: '求 $\\log_2 8$。', answer_text: '3' },
            neighbors: [], difficulty_delta: 0, idx: 2, total: 3,
            siblings: [{ idx: 1, question_text: '求 $\\log_3 27$。' }]
        });
        assert.ok(prompt.includes('每一個反斜線都要寫成兩個'), 'L-2 規則進了 variant 的 prompt');
        assert.ok(prompt.includes('第 1 題：求 $\\log_3 27$。'), '兄弟題幹');
        assert.ok(prompt.includes('【這是這次要出的第 2 題（共 3 題）】'));
    });

    test('L-2 的正例照做時：解析後沒有控制字元（C 的 control_char 不擋）、修復層不動、公式閘門沒有 error', () => {
        for (const rules of [LATEX_RULES, CHEM_LATEX_RULES]) {
            for (const latex of jsonPositives(rules)) {
                assert.deepEqual(findControlChars(latex), [], latex);
                const r = repairLatexEscapes({ question_text: latex });
                assert.deepEqual([r.repairs.length, r.unresolved.length], [0, 0], latex);
                assert.deepEqual(errorRules(latex), [], latex);
            }
        }
    });

    test('L-2 的反例（只寫一個反斜線）：解析後是控制字元，control_char 擋下；修復層救得回來，修完閘門就不擋', () => {
        const bad = JSON.parse('"$\\frac{1}{2}$"');
        assert.equal(bad, '$\frac{1}{2}$');
        assert.deepEqual(errorRules(bad).filter(r => r === 'control_char'), ['control_char']);
        const fixed = repairLatexEscapes({ question_text: bad }).value.question_text;
        assert.equal(fixed, '$\\frac{1}{2}$');
        assert.deepEqual(errorRules(fixed), []);
    });

    test('C 的 L-3 之後 \\bullet、\\textbf 解析器支援：被 JSON 吃掉時修復層照樣認得（不在不支援清單也修），修完閘門不擋', () => {
        assert.equal(UNSUPPORTED_LATEX_COMMANDS.includes('bullet'), false);
        assert.equal(UNSUPPORTED_LATEX_COMMANDS.includes('textbf'), false);
        const eaten = { question_text: '甲 $a\bullet b$，乙 $\textbf{v}$' };   // \b＝退格、\t＝定位
        const r = repairLatexEscapes(eaten);
        assert.equal(r.value.question_text, '甲 $a\\bullet b$，乙 $\\textbf{v}$');
        assert.deepEqual(r.unresolved, []);
        assert.deepEqual(errorRules(r.value.question_text), []);
    });

    test('修復層救不回來的（換頁＋dg）：control_char 擋下送 lint；這種題幹若成了兄弟，prompt 裡不帶換頁字元', () => {
        const stuck = '$240^\fdg$';
        const r = repairLatexEscapes({ question_text: stuck });
        assert.equal(r.value.question_text, stuck, '不猜');
        assert.equal(r.unresolved.length, 1);
        assert.ok(errorRules(stuck).includes('control_char'));
        // 兄弟題幹經 oneLine 收成一行：換頁、定位、歸位、換行都是 \s，變成空白（variant.v2 的兄弟區塊不會把控制字元送給模型）
        const block = generateVariant.siblingsText([{ idx: 1, question_text: `題幹 ${stuck}\r\n第二行\t結尾` }]);
        assert.deepEqual(findControlChars(block), [], JSON.stringify(block));
    });

    test('兄弟題幹的鍵用全文雜湊：修復前後的題幹是不同的鍵（replay 不會拿修復前的兄弟回答修復後的請求）', () => {
        const before = generateVariant.siblingKeyOf([{ idx: 1, question_text: '$\frac{1}{2}$' }]);
        const after = generateVariant.siblingKeyOf([{ idx: 1, question_text: '$\\frac{1}{2}$' }]);
        assert.equal(before.length, 1);
        assert.notDeepEqual(before, after);
    });
});

describe('② A classify schema 順序 × C LC-3 閘門', () => {
    function ctxWith(data) {
        const calls = [];
        return {
            calls,
            ctx: {
                llm: { generateJson: async (opts) => { calls.push(opts); return { data, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 }, latencyMs: 1, raw: null }; } },
                db: null,
                job: { id: 1, budget_usd: 1, cost_usd: 0 },
                jq: { id: 1, idx: 1, payload: {}, retries: {} },
                logger: { info() {}, warn() {}, error() {} },
                config: { models: { extract: 'ollama:qwen3-vl:8b', text: 'ollama:qwen3:8b' }, thresholds: { classifyMinConf: 0.8 }, features: {} },
                signal: undefined
            }
        };
    }

    test('schema 三處都是 rationale → chapter → confidence（A 的 LC-1）', () => {
        const order = ['rationale', 'chapter', 'confidence'];
        assert.deepEqual(Object.keys(classifySchema.properties), order);
        assert.deepEqual(classifySchema.propertyOrdering, order);
        assert.deepEqual(classifySchema.required, order);
    });

    test('閘門套界線規則換章（C 的 LC-3）：不呼叫模型、不用到 schema；data 的鍵與第二層同一組（多 adjustments）', async () => {
        const { ctx, calls } = ctxWith({});
        const gate = await classify.run(ctx, { subject: '數學', chapter: '指數與對數', chapter_confidence: 0.9, question_text: '求 $\\log_{7} 49$ 的值。' });
        assert.equal(calls.length, 0);
        assert.equal(gate.kind, 'pass');
        assert.equal(gate.data.source, 'gate');
        assert.equal(gate.data.chapter, '指數函數與對數函數');

        // 第二層：模型照新 schema 的順序回（理由在前），界線規則照樣換章
        const llm = ctxWith({ rationale: '用到對數律。', chapter: '指數與對數', confidence: 0.95 });
        const second = await classify.run(llm.ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '求 $\\log_{7} 49$ 的值。' });
        assert.equal(llm.calls.length, 1);
        assert.deepEqual(Object.keys(llm.calls[0].schema.properties), ['rationale', 'chapter', 'confidence'], '送出去的 schema 是新順序');
        assert.equal(second.data.source, 'llm');
        assert.equal(second.data.chapter, '指數函數與對數函數');

        // 第二層另有 few_shot_ids（閘門沒有挑範例），其餘欄位兩層相同，下游（save、複核頁）不必分辨
        const keys = (d) => Object.keys(d).filter(k => k !== 'source' && k !== 'few_shot_ids').sort();
        assert.deepEqual(keys(gate.data), keys(second.data));
        assert.deepEqual(keys(gate.data), ['adjustments', 'chapter', 'confidence', 'rationale']);
        assert.deepEqual(gate.data.adjustments.map(a => a.rule), second.data.adjustments.map(a => a.rule));
    });
});

describe('③ D 預設 ocr × C D-2', () => {
    test('沒寫 LOCAL_EXTRACT_MODE 時：程式預設是 ocr，pipeline eval 把它當 OCR 模式（saved_rate 不比門檻）', () => {
        const { resolveLocalExtractMode, DEFAULT_LOCAL_EXTRACT_MODE } = require('../../config/localExtractMode');
        const { isOcrOnlyRun, OCR_SAVED_RATE_NOTE } = require('../../eval/lib/suitePipeline');
        assert.equal(DEFAULT_LOCAL_EXTRACT_MODE, 'ocr');
        assert.equal(resolveLocalExtractMode({}), 'ocr');
        assert.equal(isOcrOnlyRun({ MODEL_EXTRACT: 'ollama:qwen3-vl:8b' }), true);
        assert.equal(isOcrOnlyRun({ MODEL_EXTRACT: 'gemini:gemini-3.5-flash' }), false, 'Gemini 不受 D-3 影響');
        assert.match(OCR_SAVED_RATE_NOTE, /不比門檻/);
    });

    test('CI 與 eval/.env.replay 都明寫 LOCAL_EXTRACT_MODE=ocr（e2e 與 pipeline 回放走同一條路，不靠程式預設）', () => {
        const ci = fs.readFileSync(path.join(APP_DIR, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
        assert.match(ci, /^\s+LOCAL_EXTRACT_MODE: ocr$/m);
        const replay = fs.readFileSync(path.join(APP_DIR, 'eval', '.env.replay'), 'utf8');
        assert.match(replay, /^LOCAL_EXTRACT_MODE=ocr$/m);
    });
});

describe('④ B migration 0020 × 0019 的完整值域', () => {
    const valuesOf = (file) => {
        const sql = fs.readFileSync(path.join(APP_DIR, 'migrations', file), 'utf8');
        const m = sql.match(/CHECK \(review_reason IN \(([\s\S]*?)\)\);/);
        assert.ok(m, file);
        return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
    };

    test('0020＝0019 的十一個值＋output_truncated（完整值域重建，沒有漏掉 ocr_only）', () => {
        const v19 = valuesOf('0019_ocr_only_review.sql');
        const v20 = valuesOf('0020_output_truncated_review.sql');
        assert.equal(v19.length, 11);
        assert.deepEqual(v20, [...v19, 'output_truncated']);
    });

    test('複核 API 的白名單與 0020 的值域一致', () => {
        // controllers/reviewController.js 一載入就連 DB，這裡讀原始碼裡的陣列
        const src = fs.readFileSync(path.join(APP_DIR, 'controllers', 'reviewController.js'), 'utf8');
        const m = src.match(/const REVIEW_REASONS = \[([\s\S]*?)\];/);
        assert.ok(m);
        const list = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
        assert.deepEqual(list, valuesOf('0020_output_truncated_review.sql'));
    });

    test('套了 0020 的庫：D 的預設 ocr 下 runner 的 0019 檢查照樣通過，0020 檢查也通過', async () => {
        const runner = require('../../workers/jobRunner');
        const def = `CHECK ((review_reason = ANY (ARRAY[${valuesOf('0020_output_truncated_review.sql').map(v => `'${v}'::text`).join(', ')}])))`;
        const db = { query: async () => ({ rows: [{ def }], rowCount: 1 }) };
        assert.equal(await runner.ocrOnlySchemaProblem(db), null);
        assert.equal(await runner.outputTruncatedAccepted(db), true);
    });
});
