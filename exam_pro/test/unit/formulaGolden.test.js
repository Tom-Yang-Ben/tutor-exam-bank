// 公式解析 golden 表格測試（A-T4 / WS-C）
//
// eval/golden/formula.json 是純函式的 golden，規劃 §5.3.2 明講「直接以 node --test
// 表格測試跑，不另設 cassette」。這支就是那張表。
//
// ⚠️ 現況：expect 欄是由 parseLatexStrict 自動預填的**草稿**，所以「expect 對得上」
//    這條斷言目前是恆真的——它的價值要等開發者開 Word 逐筆目視、把 expect 改成
//    「Word 裡實際長什麼樣」並把 needs_human_confirm 改成 false 之後才出現：
//    那時它就變成解析器的回歸鎖，任何人改壞 textFormatter 都會在這裡紅燈。
//    待目視的清單在檔頭的 _needs_word_check（目前 28 筆）。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseLatexStrict } = require('../../utils/textFormatter');
const golden = require('../../eval/golden/formula.json');

/** 收集 docx 物件樹裡出現過的 m:* 元素名（與產生 golden 時同一套規則） */
function ooxmlOf(node, out = [], seen = new Set()) {
    if (node == null) return out;
    if (Array.isArray(node)) { node.forEach(n => ooxmlOf(n, out, seen)); return out; }
    if (typeof node !== 'object') return out;
    const key = node.rootKey;
    if (typeof key === 'string' && key.startsWith('m:') && !key.endsWith('Pr') && key !== 'm:t' && key !== 'm:r') {
        if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
    if (node.root !== undefined) ooxmlOf(node.root, out, seen);
    return out;
}

describe('eval/golden/formula.json — 檔案本身的結構', () => {
    test('150 筆、id 唯一且連號', () => {
        assert.equal(golden.entries.length, 150);
        const ids = golden.entries.map(e => e.id);
        assert.equal(new Set(ids).size, 150, 'id 有重複');
        assert.deepEqual(ids, golden.entries.map((_, i) => 'F' + String(i + 1).padStart(3, '0')));
    });

    test('每筆都有必填欄位，且 expect 只能是 ok / degrade', () => {
        for (const e of golden.entries) {
            assert.equal(typeof e.latex, 'string', `${e.id} 缺 latex`);
            assert.ok(['ok', 'degrade'].includes(e.expect), `${e.id} 的 expect 非法：${e.expect}`);
            assert.ok(Array.isArray(e.ooxml), `${e.id} 的 ooxml 不是陣列`);
            assert.equal(typeof e.group, 'string');
            assert.equal(typeof e.source, 'string');
            assert.equal(typeof e.needs_human_confirm, 'boolean');
        }
    });

    test('八個來源分組的筆數符合規劃（既有 20 + fix 型樣 10 + 六類規則各 20）', () => {
        const count = (g) => golden.entries.filter(e => e.group === g).length;
        assert.equal(count('existing_test'), 20);
        assert.equal(count('fix_formulas_pattern'), 10);
        assert.equal(count('rule:dollar_unbalanced'), 20);
        assert.equal(count('rule:brace_unbalanced'), 20);
        assert.equal(count('rule:slash_fraction'), 20);
        assert.equal(count('rule:unicode_math'), 20);
        assert.equal(count('rule:latex_without_dollar'), 20);
        assert.equal(count('rule:parse_events'), 20);
    });

    test('latex 不得重複（重複案例等於白跑）', () => {
        const seen = new Map();
        for (const e of golden.entries) {
            const prev = seen.get(e.latex);
            assert.equal(prev, undefined, `${e.id} 與 ${prev} 的 latex 相同`);
            seen.set(e.latex, e.id);
        }
    });

    test('_needs_word_check 的每個 id 都存在於 entries', () => {
        const ids = new Set(golden.entries.map(e => e.id));
        for (const x of golden._needs_word_check) {
            assert.ok(ids.has(x.id), `_needs_word_check 指到不存在的 ${x.id}`);
            assert.equal(typeof x.reason, 'string');
        }
    });
});

describe('eval/golden/formula.json — parseLatexStrict 的表格測試', () => {
    for (const e of golden.entries) {
        test(`${e.id} [${e.group}] ${e.latex.slice(0, 40)}`, () => {
            const r = parseLatexStrict(e.latex);
            assert.equal(r.ok, e.expect === 'ok',
                `${e.id} 期望 ${e.expect}，實際事件為 ${JSON.stringify(r.events)}`);
            for (const el of e.ooxml) {
                assert.ok(ooxmlOf(r.children).includes(el),
                    `${e.id} 期望產生 ${el}，實際為 ${JSON.stringify(ooxmlOf(r.children))}`);
            }
        });
    }
});

describe('eval/golden/formula.json — 定案進度', () => {
    test('印出還沒人工定案的筆數（不擋 CI，只是提醒）', () => {
        const pending = golden.entries.filter(e => e.needs_human_confirm);
        console.log(`  ℹ 公式 golden：${golden.entries.length} 筆，待人工定案 ${pending.length} 筆；`
            + `其中 ${golden._needs_word_check.length} 筆機器判不了，必須開 Word 目視。`);
        assert.ok(pending.length <= golden.entries.length);
    });
});
