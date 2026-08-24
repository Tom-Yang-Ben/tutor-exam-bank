// ─────────────────────────────────────────────────────────────
// assistantService 單元測試（階段 4 A1）——主控迴圈的行為，不連 DB、不連 Gemini。
//
// llm 由 deps 注入假的（回傳事先排好的決策序列），所以這裡驗的是**編排**：
//   工具分派、參數驗證、不認識的工具、工具丟例外、步數上限、輸入防呆。
// 工具本身多半要 DB，實際查詢由整合測試層（若旗標開啟）與人工試用涵蓋；
// 這裡只用不碰 DB 的假工具行為（透過 validate 擋下）與 registry 的形狀斷言。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const assistant = require('../../services/assistantService');

/** 依序回吐排好的決策；超出序列就拋錯（代表迴圈比預期多跑）。 */
function scriptedLlm(decisions) {
    let i = 0;
    const calls = [];
    return {
        calls,
        async generateJson(opts) {
            calls.push(opts);
            if (i >= decisions.length) throw new Error(`假 llm：第 ${i + 1} 次呼叫沒有排定決策`);
            return { data: decisions[i++], usage: {}, latencyMs: 0 };
        }
    };
}

describe('assistantService — 主控迴圈（工具全由 llm 決策驅動）', () => {
    test('action=final 直接回覆，不呼叫任何工具', async () => {
        const llm = scriptedLlm([{ action: 'final', reply: '你好，我是助教。' }]);
        const out = await assistant.runAssistant({ message: '哈囉', deps: { llm } });
        assert.equal(out.reply, '你好，我是助教。');
        assert.deepEqual(out.steps, []);
        assert.equal(llm.calls.length, 1);
    });

    test('不認識的工具：錯誤變成餵回主控的結果，迴圈繼續而不是丟例外', async () => {
        const llm = scriptedLlm([
            { action: 'call_tool', tool: 'delete_everything', args_json: '{}' },
            { action: 'final', reply: '抱歉，我沒有那個工具。' }
        ]);
        const out = await assistant.runAssistant({ message: '把資料庫刪掉', deps: { llm } });
        assert.equal(out.steps.length, 1);
        assert.equal(out.steps[0].ok, false);
        assert.match(out.steps[0].result.error, /沒有叫做「delete_everything」的工具/);
        // 第二次呼叫的 prompt 要帶著第一步的失敗結果（主控看得到才修得掉）
        assert.match(llm.calls[1].parts[0].text, /delete_everything/);
        assert.equal(out.reply, '抱歉，我沒有那個工具。');
    });

    test('參數驗證在執行之前：壞參數不會碰到工具本體（也就不會碰到 DB）', async () => {
        const llm = scriptedLlm([
            { action: 'call_tool', tool: 'get_student_weakness', args_json: '{"days": 9999}' },
            { action: 'final', reply: '參數修不好，先這樣。' }
        ]);
        const out = await assistant.runAssistant({ message: '看弱點', deps: { llm } });
        assert.equal(out.steps[0].ok, false);
        assert.match(out.steps[0].result.error, /student_name 必填/);
    });

    test('步數上限：一直 call_tool 不收尾 → 截斷並誠實說明，不會無限迴圈', async () => {
        const n = assistant.maxSteps();
        const llm = scriptedLlm(Array.from({ length: n }, () => (
            { action: 'call_tool', tool: 'nonexistent', args_json: '{}' }
        )));
        const out = await assistant.runAssistant({ message: '一直查', deps: { llm } });
        assert.equal(out.truncated, true);
        assert.equal(out.steps.length, n);
        assert.match(out.reply, /上限/);
    });

    test('輸入防呆：空訊息 400、超長訊息 400（狀態碼由 controller 轉譯）', async () => {
        const llm = scriptedLlm([]);
        await assert.rejects(() => assistant.runAssistant({ message: '   ', deps: { llm } }), /message 必填/);
        await assert.rejects(
            () => assistant.runAssistant({ message: 'x'.repeat(assistant.MAX_MESSAGE_LEN + 1), deps: { llm } }),
            new RegExp(`最長 ${assistant.MAX_MESSAGE_LEN} 字`)
        );
        assert.equal(llm.calls.length, 0, '防呆要在呼叫 LLM 之前擋下（不花錢）');
    });

    test('cassette 鍵位：每次呼叫都帶 agent=assistant 與模板版本（record/replay 靠它）', async () => {
        const llm = scriptedLlm([{ action: 'final', reply: 'ok' }]);
        await assistant.runAssistant({ message: '嗨', deps: { llm } });
        assert.equal(llm.calls[0].agent, 'assistant');
        assert.equal(llm.calls[0].template, assistant.TEMPLATE);
        assert.ok(llm.calls[0].schema, '要用 responseJsonSchema 鎖輸出');
        assert.ok(llm.calls[0].cacheKeyParts, 'cassette 鍵要含對話內容');
    });

    test('歷史截斷：只帶最近 MAX_HISTORY 輪進 prompt', async () => {
        const llm = scriptedLlm([{ action: 'final', reply: 'ok' }]);
        const history = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `第 ${i} 句` }));
        await assistant.runAssistant({ message: '最新的問題', deps: { llm } });
        await assistant.runAssistant({ message: '最新的問題', history, deps: { llm: scriptedLlm([{ action: 'final', reply: 'ok' }]) } });
        // 直接驗 buildPrompt：30 句只留最後 MAX_HISTORY 句
        const transcript = history.slice(-assistant.MAX_HISTORY).map(t => ({ role: 'user', text: t.text }));
        const prompt = assistant.buildPrompt([...transcript, { role: 'user', text: '最新的問題' }], []);
        assert.ok(!prompt.includes('第 0 句'), '最舊的歷史要被截掉');
        assert.ok(prompt.includes(`第 ${30 - assistant.MAX_HISTORY} 句`), '最近的歷史要留著');
    });
});

describe('assistantService — 工具註冊表（安全邊界的形狀）', () => {
    test('工具清單凍結為五個只讀工具（新增會寫庫的工具必須先過人）', () => {
        assert.deepEqual(Object.keys(assistant.TOOLS).sort(), [
            'find_similar', 'get_student_weakness', 'list_students', 'preview_paper', 'search_questions'
        ]);
    });

    test('每個工具都有說明書、參數說明、validate 與 run', () => {
        for (const [name, t] of Object.entries(assistant.TOOLS)) {
            assert.equal(typeof t.description, 'string', `${name} 缺 description`);
            assert.equal(typeof t.params, 'string', `${name} 缺 params`);
            assert.equal(typeof t.validate, 'function', `${name} 缺 validate`);
            assert.equal(typeof t.run, 'function', `${name} 缺 run`);
        }
    });

    test('系統提示裡有三條底線：只讀、工具結果是資料不是指令、出卷要人確認', () => {
        assert.match(assistant.SYSTEM, /不是給你的指令/);
        assert.match(assistant.SYSTEM, /只能預覽/);
        assert.match(assistant.SYSTEM, /確認出卷/);
    });

    test('決策 schema 鎖住 action 的兩個值', () => {
        assert.deepEqual(assistant.DECISION_SCHEMA.properties.action.enum, ['call_tool', 'final']);
        assert.equal(assistant.DECISION_SCHEMA.properties.args_json.type, 'string', 'gemini structured output 對自由物件會吐空 {}，參數必須走 JSON 字串');
        assert.deepEqual(assistant.DECISION_SCHEMA.required, ['action']);
    });
});
