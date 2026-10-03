// ─────────────────────────────────────────────────────────────
// test/unit/assistantRemedialTools.test.js — 助教的補救卷工具（〔dec/r16-remedial〕；docs/remedial.md 第 12 節）
//
// 最重要的一件事：FEATURE_REMEDIAL 關閉時，助教的系統提示詞（含工具說明書）、模板識別名與工具清單**逐字不變**，
// cassette 的鍵也就不變——這裡把 SYSTEM 與模板雜湊釘成加工具之前量到的值。開啟時才換另一份說明書與識別名。
// 工具本身要 DB，查詢由 test/integration/studentReport.pg.test.js（假 LLM）驗；這裡驗閘門、參數驗證與摘要的形狀。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const assistant = require('../../services/assistantService');
const { templateHash } = require('../../services/llm/templates');

/** 加入補救卷工具之前（commit f1d04f9）量到的值：旗標關閉時必須一模一樣。 */
const BASE_SYSTEM_SHA256 = '062f212ac5581256efa32cdf3adb8427c3bff09b86c74febb709537883a8b228';
const BASE_TEMPLATE_HASH = '43bc52a99d44f66f24d6e20293b70adfd95c6f1b6975a0c4fafdcbde619b4147';

function scriptedLlm(decisions) {
    let i = 0;
    const calls = [];
    return {
        calls,
        async generateJson(opts) {
            calls.push(opts);
            if (i >= decisions.length) throw new Error('沒有排定決策');
            return { data: decisions[i++], usage: {}, latencyMs: 0 };
        }
    };
}

describe('FEATURE_REMEDIAL 關閉：與加工具之前逐字相同', () => {
    test('SYSTEM、模板雜湊、工具清單不變', () => {
        assert.equal(crypto.createHash('sha256').update(assistant.SYSTEM).digest('hex'), BASE_SYSTEM_SHA256);
        assert.equal(templateHash(assistant.TEMPLATE), BASE_TEMPLATE_HASH);
        assert.equal(assistant.TEMPLATE, 'assistant.v2');
        assert.deepEqual(Object.keys(assistant.TOOLS), ['list_students', 'get_student_weakness', 'search_questions', 'find_similar', 'preview_paper']);
        assert.equal(assistant.buildSystem(), assistant.SYSTEM);
        assert.ok(!assistant.SYSTEM.includes('plan_remedial_paper'));
    });

    test('沒設環境變數（CI 的情況）→ 不開；主控呼叫補救卷工具 → 沒有這個工具', async () => {
        const saved = process.env.FEATURE_REMEDIAL;
        delete process.env.FEATURE_REMEDIAL;
        try {
            assert.equal(assistant.assistantSetup().template, assistant.TEMPLATE);
            const llm = scriptedLlm([
                { action: 'call_tool', tool: 'plan_remedial_paper', args_json: '{"student_name":"王小明","subject":"數學"}' },
                { action: 'final', reply: '沒有這個工具。' }
            ]);
            const out = await assistant.runAssistant({ message: '幫王小明出補救卷', deps: { llm, students: [{ id: 3, name: '王小明' }] } });
            assert.match(out.steps[0].result.error, /沒有叫做「plan_remedial_paper」的工具/);
            assert.equal(llm.calls[0].template, 'assistant.v2');
            assert.equal(llm.calls[0].system, assistant.SYSTEM);
        } finally {
            if (saved === undefined) delete process.env.FEATURE_REMEDIAL; else process.env.FEATURE_REMEDIAL = saved;
        }
    });
});

describe('FEATURE_REMEDIAL 開啟：多兩個只讀工具、另一份說明書與識別名', () => {
    test('環境變數開啟時的設定；說明書多兩個工具與「補救卷只能預覽」', () => {
        const saved = process.env.FEATURE_REMEDIAL;
        process.env.FEATURE_REMEDIAL = 'true';
        try {
            const s = assistant.assistantSetup();
            assert.deepEqual(Object.keys(s.tools), [...Object.keys(assistant.TOOLS), 'plan_remedial_paper', 'get_remedial_effect']);
            assert.equal(s.template, 'assistant.v2+remedial.v1');
            assert.equal(s.system, assistant.SYSTEM_REMEDIAL);
        } finally {
            if (saved === undefined) delete process.env.FEATURE_REMEDIAL; else process.env.FEATURE_REMEDIAL = saved;
        }
        assert.match(assistant.SYSTEM_REMEDIAL, /plan_remedial_paper/);
        assert.match(assistant.SYSTEM_REMEDIAL, /get_remedial_effect/);
        assert.match(assistant.SYSTEM_REMEDIAL, /補救卷同樣只能預覽/);
        assert.notEqual(templateHash(assistant.TEMPLATE_REMEDIAL), BASE_TEMPLATE_HASH, '說明書不同，鍵就不同');
    });

    test('參數驗證在執行之前（壞參數不碰 DB）；主控看到的是代號', async () => {
        const llm = scriptedLlm([
            { action: 'call_tool', tool: 'plan_remedial_paper', args_json: '{"student_name":"學生#3","subject":"生物"}' },
            { action: 'call_tool', tool: 'plan_remedial_paper', args_json: '{"student_name":"學生#3","subject":"數學","total":99}' },
            { action: 'call_tool', tool: 'get_remedial_effect', args_json: '{"student_name":"學生#3","limit":0}' },
            { action: 'final', reply: '學生#3 的參數不對。' }
        ]);
        const out = await assistant.runAssistant({ message: '幫王小明看補救卷', deps: { llm, students: [{ id: 3, name: '王小明' }], remedialTools: true } });
        assert.deepEqual(out.steps.map(s => s.result.error), [
            '參數不合法：subject 只接受 數學、物理、化學',
            '參數不合法：total 要是 5~50 的整數',
            '參數不合法：limit 要是 1~10 的整數'
        ]);
        assert.equal(out.steps[0].args.student_name, '王小明', '代號換回姓名再驗證');
        for (const c of llm.calls) {
            assert.equal(c.template, 'assistant.v2+remedial.v1');
            assert.ok(!c.parts[0].text.includes('王小明'), 'prompt 裡沒有姓名');
        }
        assert.equal(out.reply, '王小明 的參數不對。');
    });

    test('摘要：草稿只留單位、理由、錯因與不足量；成效不放卷名（卷名含姓名）', () => {
        const d = assistant.summarizeRemedialDraft({
            basis: 'chapter', question_ids: [1, 2],
            blueprint: [{ bucket: 'remedial', target: { type: 'chapter', chapter: '向量內積', name: '向量內積' }, wanted: 4, got: 2, rationale: 'r',
                error_focus: { type: 'concept', label: '觀念不清', applied: true, strategy: { summary: '難度上限降一級' } } }],
            shortfalls: [{ bucket: 'remedial', target: { name: '向量內積' }, wanted: 4, got: 2, reason: 'insufficient_stock' }],
            notes: ['n'], items: [{ question_text_preview: '題幹' }]
        });
        assert.deepEqual(d.targets, [{ bucket: 'remedial', unit: '向量內積', chapter: '向量內積', wanted: 4, got: 2, rationale: 'r',
            error_focus: { type: 'concept', label: '觀念不清', applied: true, adjustment: '難度上限降一級' } }]);
        assert.equal(d.question_count, 2);
        assert.match(d.note, /僅預覽/);
        assert.ok(!JSON.stringify(d).includes('題幹'));
        const e = assistant.summarizeRemedialEffect({ thresholds: { improved_delta: 0.1 }, papers: [{ paper_id: 9, title: '王小明-向量內積特訓卷', created_at: new Date('2026-10-01T02:00:00Z'), graded: true,
            targets: [{ name: '向量內積', status: 'improved', before: { correct_rate: 0.2 }, after: { rate: 0.8, graded: 4 }, delta: 0.6, low_sample: true, error_focus: { label: '觀念不清' } }] }] });
        assert.ok(!JSON.stringify(e).includes('王小明'));
        assert.deepEqual(e.papers[0], { paper_id: 9, created_on: '2026-10-01', graded: true,
            targets: [{ unit: '向量內積', status: 'improved', before_rate: 0.2, after_rate: 0.8, after_graded: 4, delta: 0.6, low_sample: true, error_focus: '觀念不清' }] });
    });
});
