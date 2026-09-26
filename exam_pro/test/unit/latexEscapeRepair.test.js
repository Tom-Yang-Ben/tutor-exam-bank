// services/llm/latexEscapeRepair.js 與 services/llm 的接點（dec/latex-escape-repair）
//
// 問題：模型在 JSON 字串裡寫 LaTeX 只寫一個反斜線，\frac 的 \f、\times 的 \t、\beta 的 \b、\rho 的 \r、\neq 的 \n
// 被 JSON.parse 當成換頁／定位／退格／歸位／換行。本檔的 asModelWrote() 就是把「模型寫出來的 JSON 字串內容」
// 原樣交給 JSON.parse——得到的正是 agent 會拿到的壞字串；修好之後應該等於原本的 LaTeX。
//
// 六組：
//   1. 指令表：由 utils/textFormatter.js 的白名單產生（掃 parseCommand 的原始碼防漏列）
//   2. 正例：指令表裡每一個 b f n r t 開頭的指令、Ollama 文法換字母（\rcirc）、各種上下文
//   3. 反例：真的換行、真的定位、文字裡 n／t 開頭的英文字、反斜線之後、救不回來的
//   4. services/llm 的接點：replay／record（Ollama 與 Gemini）都修、cassette 存原始回應、鍵不變
//   5. 回歸：repo 內 2026-09-25 的本機 cassette（f77d1a3）與 Gemini 的 variant cassette（04e9bd3），
//      修回後「帶控制字元的支數」與公式閘門（agents/lint.js 的 gate）的結果逐支釘住
//   6. 審查意見（dec/latex-escape-repair-fix）：連在一起的指令一次修完（冪等，含固定種子的隨機字串）、
//      數連續反斜線、多行行內公式與 $ 配錯對不誤改、指令表補齊與公式外的定位
//
// 執行：npm test

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repair = require('../../services/llm/latexEscapeRepair');
const tf = require('../../utils/textFormatter');
const cassette = require('../../services/llm/cassette');
const templates = require('../../services/llm/templates');
const fake = require('../../services/llm/fake');
const throttle = require('../../services/llm/throttle');
const ollama = require('../../services/llm/ollama');
const gemini = require('../../services/llm/gemini');
const llm = require('../../services/llm');
const lint = require('../../agents/lint');

const { repairString, repairLatexEscapes, applyToResult, decide, mathSpans, commandTable } = repair;

/**
 * 模型在 JSON 字串裡寫了 s（反斜線只寫一個）→ JSON.parse 之後 agent 拿到的字串。
 * 不是合法跳脫的（\c、\l、\( …）JSON.parse 會直接丟錯、Ollama 的文法也不允許，實際輸出一定是寫成 \\ 的
 *（或被換字母，那另外測）——這裡照「寫成 \\」模擬；\\ 本身（模型有正確跳脫的）原樣保留。
 */
function asModelWrote(s) {
    const json = s.replace(/"/g, '\\"').replace(/\\(\\|[^bfnrtu"/])/g, (m, c) => (c === '\\' ? '\\\\' : `\\\\${c}`));
    return JSON.parse(`"${json}"`);
}

/** 修一個字串，只回文字 */
const fix = (s) => repairString(s).text;

const CTRL_OF = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// ───────────────────────── 1. 指令表 ─────────────────────────

describe('指令表：由 textFormatter 的白名單產生，不手抄', () => {
    const SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'utils', 'textFormatter.js'), 'utf8');
    const start = SRC.indexOf('function parseCommand(');
    const end = SRC.indexOf('return { parseSequence', start);
    const body = SRC.slice(start, end);

    test('parseCommand 裡每一個 `name === \'…\'` 都列在 PARSER_COMMANDS，反之亦然（新增特判漏列就紅燈）', () => {
        assert.ok(start > 0 && end > start, '找不到 parseCommand 的原始碼（函式改名了？）');
        const literal = new Set([...body.matchAll(/(?<![.\w])name === '([A-Za-z]+)'/g)].map(m => m[1]));
        assert.deepEqual([...literal].sort(), [...tf.PARSER_COMMANDS].sort());
    });

    test('parseCommand 以名字查的對照表只有這七張，全都進了 supportedCommandNames（新增一張表就紅燈）', () => {
        const tables = new Set([
            ...[...body.matchAll(/\b([A-Z_]+)\[name\]/g)].map(m => m[1]),
            ...[...body.matchAll(/\b([A-Z_]+)\.has\(name\)/g)].map(m => m[1])
        ]);
        // MATRIX_ENVS[name] 只在 name === 'matrix'…'cases' 的特判裡用，那四個名字已在 PARSER_COMMANDS
        assert.deepEqual([...tables].sort(),
            ['ACCENTS', 'EXTRA_SYMBOLS', 'FUNCTIONS', 'GREEK', 'MATRIX_ENVS', 'STRETCH_ARROWS', 'SYMBOLS']);
        const names = new Set(tf.supportedCommandNames());
        for (const k of [...Object.keys(tf.GREEK), ...Object.keys(tf.SYMBOLS), ...tf.FUNCTIONS, ...Object.keys(tf.ACCENTS),
            ...Object.keys(tf.EXTRA_SYMBOLS), ...Object.keys(tf.STRETCH_ARROWS), ...tf.PARSER_COMMANDS]) {
            assert.ok(names.has(k), k);
        }
    });

    test('supportedCommandNames() 的每一個名字 parseLatexStrict 都認得（不發 unknown_command）', () => {
        for (const name of tf.supportedCommandNames()) {
            let src = `$\\${name}{x}$`;
            if (name === 'begin' || name === 'end') src = '$\\begin{matrix} a \\end{matrix}$';
            const { events } = tf.parseLatexStrict(src);
            assert.ok(!events.some(e => e.kind === 'unknown_command'), `${name}：${JSON.stringify(events)}`);
        }
    });

    test('修復用的指令表＝解析器支援的全部 ∪ 少數「解析器不支援的 LaTeX 指令」；常見的都在（\\not 在不支援清單）', () => {
        const table = commandTable();
        for (const n of tf.supportedCommandNames()) assert.ok(table.has(n), n);
        for (const n of repair.UNSUPPORTED_LATEX_COMMANDS) {
            assert.ok(table.has(n), n);
            assert.match(n, /^[bfnrt]/, '只收 b f n r t 開頭的（其他字母不會被 JSON 吃掉）');
        }
        for (const n of ['frac', 'dfrac', 'times', 'theta', 'tan', 'to', 'text', 'beta', 'bar', 'rho', 'right',
            'rightarrow', 'neq', 'nabla', 'nu', 'not', 'ne']) {
            assert.ok(table.has(n), n);
        }
    });

    test('不支援清單裡的名字，還原後公式閘門看得到（unknown_command），不會安靜地通過', () => {
        for (const n of repair.UNSUPPORTED_LATEX_COMMANDS) {
            if (tf.supportedCommandNames().includes(n)) continue;   // 解析器之後支援了就不在此限
            const { events } = tf.parseLatexStrict(`$\\${n}{x}$`);
            assert.ok(events.some(e => e.kind === 'unknown_command'), n);
        }
    });
});

// ───────────────────────── 2. 正例 ─────────────────────────

describe('正例：被吃掉的反斜線補回去', () => {
    const affected = [...commandTable()].filter(n => /^[bfnrt]/.test(n)).sort();

    test('指令表裡每一個 b f n r t 開頭的指令，在 $…$ 裡後面接 { 都修回（共 ' + affected.length + ' 個）', () => {
        assert.ok(affected.length >= 40, `只有 ${affected.length} 個，指令表產生壞了？`);
        for (const name of affected) {
            const broken = `$a ${CTRL_OF[name[0]]}${name.slice(1)}{x}$`;
            assert.equal(fix(broken), `$a \\${name}{x}$`, name);
            assert.equal(fix(asModelWrote(`$a \\${name}{x}$`)), `$a \\${name}{x}$`, `${name}（經 JSON.parse）`);
        }
    });

    test('b f r 開頭的（退格／換頁／歸位在文字裡沒有正當用途）：公式外、後面接什麼都修', () => {
        for (const name of affected.filter(n => /^[bfr]/.test(n))) {
            assert.equal(fix(`角度為 ${CTRL_OF[name[0]]}${name.slice(1)}。`), `角度為 \\${name}。`, name);
        }
    });

    test('t 開頭的在公式外：後面接 { ( [ ^ _ \\ 修；接空白時 W 至少三個字母才修', () => {
        for (const name of affected.filter(n => n[0] === 't')) {
            for (const next of ['{', '(', '[', '^', '_', '\\']) {
                assert.equal(fix(`題幹 \t${name.slice(1)}${next}x`), `題幹 \\${name}${next}x`, `${name}${next}`);
            }
        }
        assert.equal(fix('k \times 3 = 6'), 'k \\times 3 = 6');
        assert.equal(fix('\theta 為夾角'), '\\theta 為夾角');
    });

    test('換行（\\neq、\\nu、\\nabla…）：行內公式裡一律修', () => {
        assert.equal(fix(asModelWrote('$|\\frac{1}{2}| \\neq 1$')), '$|\\frac{1}{2}| \\neq 1$');
        assert.equal(fix(asModelWrote('動摩擦係數 $\\nu = 0.2$')), '動摩擦係數 $\\nu = 0.2$');
        assert.equal(fix(asModelWrote('$\\nabla f$、$x \\ne 0$、$a \\ni b$、$\\neg p$、$x \\notin A$')),
            '$\\nabla f$、$x \\ne 0$、$a \\ni b$、$\\neg p$、$x \\notin A$');
        assert.equal(fix(asModelWrote('\\(x \\neq y\\)')), '\\(x \\neq y\\)');
    });

    test('換行在展示公式（$$…$$、\\[…\\]）裡：W 至少兩個字母才修', () => {
        assert.equal(fix(asModelWrote('$$a \\neq b$$')), '$$a \\neq b$$');
        assert.equal(fix(asModelWrote('\\[\\nabla \\cdot E = 0\\]')), '\\[\\nabla \\cdot E = 0\\]');
    });

    test('Ollama 文法把 \\c 換成 \\r（「歸位＋circ」）：整個指令名還在 → \\circ（只在公式裡）', () => {
        assert.equal(fix(asModelWrote('傾角 $37^\\rcirc$ 的斜面（$\\tan 37^\\rcirc = \\frac{3}{4}$）')),
            '傾角 $37^\\circ$ 的斜面（$\\tan 37^\\circ = \\frac{3}{4}$）');
        assert.deepEqual(decide({ ch: '\r', word: 'circ', prev: '^', next: '$', math: 'inline' }),
            { action: 'repair', name: 'circ', rule: 'substituted' });
        // 同一個樣式的其他字母也適用（\fdfrac → \dfrac、\tcdot → \cdot）
        assert.equal(fix('$\fdfrac{1}{2} \tcdot 3$'), '$\\dfrac{1}{2} \\cdot 3$');
    });

    test('連在一起的指令（\\tan\\theta）、上下標裡、大括號裡都修', () => {
        assert.equal(fix(asModelWrote('$\\tan\\theta$ 與 $\\theta$')), '$\\tan\\theta$ 與 $\\theta$');
        assert.equal(fix(asModelWrote('$\\frac{\\bar{a} \\bullet \\bar{b}}{|\\bar{b}|}$')),
            '$\\frac{\\bar{a} \\bullet \\bar{b}}{|\\bar{b}|}$');
        assert.equal(fix(asModelWrote('$F_{\\text{friction}} = \\theta \\times N$')), '$F_{\\text{friction}} = \\theta \\times N$');
        assert.equal(fix(asModelWrote('$\\boldsymbol{u} \\bullet \\boldsymbol{v}$')), '$\\boldsymbol{u} \\bullet \\boldsymbol{v}$');
        assert.equal(fix(asModelWrote('$\\left( \\frac{1}{2} \\right)^{2} \\rightarrow 0$')), '$\\left( \\frac{1}{2} \\right)^{2} \\rightarrow 0$');
    });

    test('結尾沒關的 $（模型輸出被截斷）之後也算公式', () => {
        assert.equal(fix(asModelWrote('$\\tilde{a} \\times \\tilde{b} = \\begin{vmatrix} 1')),
            '$\\tilde{a} \\times \\tilde{b} = \\begin{vmatrix} 1');
    });

    test('有正確跳脫的（\\\\frac）與壞掉的混在同一個字串：只修壞掉的', () => {
        const s = asModelWrote('(A)。$\\\\text{log}_2 8 + \\text{log}_2 4 = 5$');
        assert.equal(fix(s), '(A)。$\\text{log}_2 8 + \\text{log}_2 4 = 5$');
    });
});

// ───────────────────────── 3. 反例 ─────────────────────────

describe('反例：真的換行、真的定位、文字裡的英文字不能誤改', () => {
    test('一般的換行：分行、選項、段落，一個字都不動', () => {
        for (const s of [
            '第一行\n第二行',
            '(A) 3\n(B) 4\n(C) 5\n(D) 6',
            '求 $x$ 的值。\n故答案為 $5$。',
            '$x = 1$\n$y = 2$',
            '解：\n1. 先求 $a$\n2. 再求 $b$'
        ]) {
            const r = repairString(s);
            assert.equal(r.text, s);
            assert.deepEqual(r.unresolved, []);
        }
    });

    test('換行後面是 n 開頭指令的剩餘字母、但在公式外：不修（公式外的換行一律當真的換行）', () => {
        for (const s of [
            '答案如下：\nu = 3',               // \nu？還是換行＋u？公式外分不開
            '由此得\ne^{x} = 5',               // 換行＋e^{x}，不是 \ne
            'Note:\nnumber of terms\nnever\nabla',
            '下一題\not included'
        ]) {
            assert.equal(fix(s), s);
            assert.deepEqual(repairString(s).unresolved, [], '換行不列進 unresolved');
        }
    });

    test('展示公式裡換行＋單一字母（u、e、i）：與「換行＋變數」分不開，不修', () => {
        for (const s of ['$$a = 1\nu = 2$$', '$$\ne^{x} = y$$', '\\[x\ni\\]']) assert.equal(fix(s), s);
    });

    test('換行緊接在反斜線之後（表格換列 \\\\ 再換行）：不修', () => {
        const s = '$$\\begin{aligned} a &= 1 \\\\\nu &= 2 \\\\\neq \\end{aligned}$$';
        assert.equal(fix(s), s);
    });

    test('真的定位字元：後面不是字母、或公式外接英文單字，不修', () => {
        for (const s of ['姓名\t座號', '(A)\t(B)\t(C)', 'Name\to be', 'Name\tto be continued', '項目\tan apple', '欄位\ttheta值', '\tau 是希臘字母 tau']) {
            assert.equal(fix(s), s, JSON.stringify(s));
        }
    });

    test('文字裡 n／t／b／r／f 開頭的英文字（前面沒有控制字元）：本來就不會碰', () => {
        const s = 'the rate of return, not bad, frac is not a word, then theta and nabla';
        assert.equal(fix(s), s);
    });

    test('字母湊不成指令（Ollama 把 \\circ 寫成「換頁＋dg」、Gemini 寫成「歸位＋d」）：原樣保留、列進 unresolved', () => {
        const a = repairString('$240^\fdg - 180^\fdg$');
        assert.equal(a.text, '$240^\fdg - 180^\fdg$');
        assert.deepEqual(a.unresolved.map(u => [u.char, u.letters, u.reason]),
            [['\\f', 'dg', 'no_command'], ['\\f', 'dg', 'no_command']]);
        const b = repairString('$850^\rd$');
        assert.deepEqual(b.unresolved.map(u => [u.char, u.letters]), [['\\r', 'd']]);
        // 公式裡的定位＋湊不成指令的字母也列（「\timesx」之類）；換行不列
        assert.deepEqual(repairString('$a \timesx$').unresolved.map(u => u.letters), ['imesx']);
        assert.deepEqual(repairString('$a\nb$').unresolved, []);
    });

    test('指令名要取到最長：\\textbf 不會被切成 \\text＋bf，\\thetax 不會變成 \\theta＋x', () => {
        assert.equal(fix('$\textbf{a}$'), '$\\textbf{a}$');                 // textbf 在「不支援」清單，整個還原
        assert.equal(fix('$\thetax$'), '$\thetax$');                          // thetax 不是指令，不動
    });

    test('反斜線之後的退格／換頁／歸位：意思不明，不修但列出', () => {
        const r = repairString('$a \\\frac{1}{2}$');
        assert.equal(r.text, '$a \\\frac{1}{2}$');
        assert.deepEqual(r.unresolved.map(u => u.reason), ['after_backslash']);
    });

    test('沒有控制字元的字串：回傳同一個字串，零成本', () => {
        const s = '$\\frac{1}{2}$ 與 $\\theta$';
        const r = repairString(s);
        assert.equal(r.text, s);
        assert.deepEqual(r.repairs, []);
    });
});

describe('混合：真的換行與壞掉的指令在同一個字串', () => {
    test('只修公式裡的，換行、選項、段落原樣', () => {
        const model = '解：\\n$\\frac{1}{2} \\times 4 = 2$，且 $\\theta \\neq 0$。\\n(A) $\\beta$\\n(B) $\\rho$\\nnote: \\tab';
        const out = fix(asModelWrote(model));
        assert.equal(out, '解：\n$\\frac{1}{2} \\times 4 = 2$，且 $\\theta \\neq 0$。\n(A) $\\beta$\n(B) $\\rho$\nnote: \tab');
    });

    test('repairs 記下位置與前後（from 用跳脫寫法，方便印 log）', () => {
        const r = repairString('$\frac{1}{2}$\n$\neq$');
        assert.deepEqual(r.repairs, [
            { at: 1, from: '\\frac', to: '\\frac', rule: 'escape' },
            { at: 14, from: '\\neq', to: '\\neq', rule: 'escape' }
        ]);
    });
});

describe('mathSpans：跨行配對、四種界定符、跳過 \\$', () => {
    test('行內、展示、\\( \\)、\\[ \\]、沒關的 $', () => {
        const s = 'a $x$ b $$y$$ c \\(z\\) d \\[w\\] e \\$5 $open';
        assert.deepEqual(mathSpans(s).map(x => [s.slice(x.start, x.end), x.kind]), [
            ['$x$', 'inline'], ['$$y$$', 'display'], ['\\(z\\)', 'inline'], ['\\[w\\]', 'display'], ['$open', 'open']
        ]);
    });

    test('行內公式裡有換行（壞掉的 \\neq）仍配成一對', () => {
        const s = '$a \neq b$ 與 $c$';
        assert.deepEqual(mathSpans(s).map(x => x.kind), ['inline', 'inline']);
    });
});

describe('repairLatexEscapes：深度走訪、不就地修改', () => {
    test('物件、陣列、巢狀都修；鍵與非字串不動；原物件不變', () => {
        const data = {
            question_text: '$\frac{1}{2}$',
            options: ['$\theta$', 3, null, true],
            nested: { steps: [{ text: '$x \times y$' }] },
            'key\twith tab': 'plain',
            chapter: '向量內積'
        };
        const snapshot = JSON.stringify(data);
        const r = repairLatexEscapes(data);
        assert.equal(JSON.stringify(data), snapshot, '原物件不能被改');
        assert.deepEqual(r.value, {
            question_text: '$\\frac{1}{2}$',
            options: ['$\\theta$', 3, null, true],
            nested: { steps: [{ text: '$x \\times y$' }] },
            'key\twith tab': 'plain',
            chapter: '向量內積'
        });
        assert.deepEqual(r.repairs.map(x => x.path), ['question_text', 'options[0]', 'nested.steps[0].text']);
        assert.equal(r.value.chapter, data.chapter);
    });

    test('什麼都沒改：回傳同一個物件（逐位元不變）', () => {
        const data = { a: '$\\frac{1}{2}$', b: ['x\ny'] };
        assert.equal(repairLatexEscapes(data).value, data);
    });

    test('沒改到的子樹共用原物件', () => {
        const untouched = { deep: ['ok'] };
        const data = { a: '$\frac{1}{2}$', b: untouched };
        assert.equal(repairLatexEscapes(data).value.b, untouched);
    });
});

describe('applyToResult：generateJson 回傳物件', () => {
    test('沒修到也沒救不回來：回傳同一個物件（形狀與之前逐位元相同）', () => {
        const res = { data: { a: 'x' }, usage: {}, latencyMs: 1, raw: null };
        assert.equal(applyToResult(res), res);
    });

    test('修到了：data 換成修過的、多一個 latexRepair 摘要；raw 不動', () => {
        const raw = { text: '{"q":"$\\frac{1}{2}$"}' };
        const res = { data: { q: '$\frac{1}{2} \times 2^\fdg$' }, usage: { tokenIn: 1 }, latencyMs: 1, raw, replayed: true };
        const out = applyToResult(res);
        assert.notEqual(out, res);
        assert.equal(out.raw, raw);
        assert.equal(out.replayed, true);
        assert.deepEqual(out.data, { q: '$\\frac{1}{2} \\times 2^\fdg$' });
        assert.deepEqual(out.latexRepair, {
            repaired: 2,
            commands: { frac: 1, times: 1 },
            unresolved: [{ path: 'q', at: 20, char: '\\f', letters: 'dg', reason: 'no_command' }]
        });
        assert.deepEqual(res.data, { q: '$\frac{1}{2} \times 2^\fdg$' }, '原本的 data 不變');
    });
});

// ───────────────────────── 4. services/llm 的接點 ─────────────────────────

describe('services/llm.generateJson：replay／record、Ollama 與 Gemini 都修；cassette 存原始回應、鍵不變', () => {
    const ENV_KEYS = ['LLM_MODE', 'EVAL_CASSETTE_DIR', 'MODEL_EXTRACT', 'GEMINI_API_KEY', 'GEMINI_RPM', 'JOB_CONCURRENCY', 'OLLAMA_HOST'];
    const envBackup = {};
    let tmpDir;

    before(() => {
        for (const k of ENV_KEYS) envBackup[k] = process.env[k];
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-latex-repair-'));
        templates.registerTemplate('latex_rt.v1', '測試用模板（replay）');
        templates.registerTemplate('latex_ol.v1', '測試用模板（record）');
    });
    after(() => {
        for (const [k, v] of Object.entries(envBackup)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        ollama._resetForTest();
        gemini._setClientForTest(null);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    beforeEach(() => {
        for (const k of ENV_KEYS) delete process.env[k];
        process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'cassettes');
        ollama._resetForTest();
        gemini._setClientForTest(null);
        throttle._resetForTest();
        fake._resetForTest();
    });

    /** 模型輸出的 JSON 原文：LaTeX 只寫一個反斜線 */
    const MODEL_JSON = '{"question_text":"$\\frac{1}{2} \\times 4$，$37^\\rcirc$","answer_text":"解：\\n$\\theta \\neq 0$"}';
    const EXPECTED = { question_text: '$\\frac{1}{2} \\times 4$，$37^\\circ$', answer_text: '解：\n$\\theta \\neq 0$' };
    const RAW = JSON.parse(MODEL_JSON);

    function silence(fn) {
        const orig = console.log;
        console.log = () => { };
        return Promise.resolve().then(fn).finally(() => { console.log = orig; });
    }

    test('replay：既有 cassette（原始、未修）回放時修好；cassette 檔一個位元都沒動；鍵照舊公式', async () => {
        process.env.LLM_MODE = 'replay';
        const opts = { model: 'ollama:qwen3:8b', parts: [{ text: 'q' }], schema: { type: 'object' }, agent: 'latex_rt', template: 'latex_rt.v1', cacheKeyParts: { q: 1 } };
        const key = cassette.cassetteKey({ agent: 'latex_rt', modelId: 'qwen3:8b', template: 'latex_rt.v1', schema: { type: 'object' }, cacheKeyParts: { q: 1 } });
        cassette.writeCassette({ agent: 'latex_rt', key, meta: { agent: 'latex_rt', model: 'qwen3:8b' }, request: {}, response: { data: RAW, usage: {} } });
        const file = cassette.cassettePath('latex_rt', key);
        const before = fs.readFileSync(file, 'utf8');

        const res = await llm.generateJson(opts);
        assert.deepEqual(res.data, EXPECTED);
        assert.equal(res.cassetteKey, key);
        assert.equal(res.replayed, true);
        assert.deepEqual(res.latexRepair, { repaired: 5, commands: { frac: 1, times: 1, circ: 1, theta: 1, neq: 1 }, unresolved: [] });
        assert.equal(fs.readFileSync(file, 'utf8'), before, 'replay 不寫 cassette');
    });

    test('record（Ollama）：agent 拿到修好的；cassette 存模型原始回應；再 replay 得到同樣的結果', async () => {
        process.env.LLM_MODE = 'record';
        const calls = [];
        ollama._setTransportForTest(async (url, payload) => {
            calls.push(url);
            return { status: 200, text: JSON.stringify({ model: 'qwen3:8b', done: true, done_reason: 'stop', message: { role: 'assistant', content: MODEL_JSON }, prompt_eval_count: 1, eval_count: 1 }) };
        });
        const opts = { model: 'ollama:qwen3:8b', parts: [{ text: 'q' }], schema: { type: 'object' }, agent: 'latex_ol', template: 'latex_ol.v1', cacheKeyParts: { q: 2 } };
        const recorded = await silence(() => llm.generateJson(opts));
        assert.deepEqual(recorded.data, EXPECTED);
        assert.equal(recorded.raw.message.content, MODEL_JSON, 'raw 是供應商原始回應，不動');

        const key = cassette.cassetteKey({ agent: 'latex_ol', modelId: 'qwen3:8b', template: 'latex_ol.v1', schema: { type: 'object' }, cacheKeyParts: { q: 2 } });
        assert.deepEqual(cassette.readCassette('latex_ol', key).response.data, RAW, 'cassette 存的是修復前的原始回應');

        process.env.LLM_MODE = 'replay';
        const replayed = await llm.generateJson(opts);
        assert.deepEqual(replayed.data, recorded.data);
        assert.deepEqual(replayed.latexRepair, recorded.latexRepair);
        assert.equal(calls.length, 1, 'replay 不連 Ollama');
    });

    // 〔整合 2026-09-27 dec/integration-final5〕與 dec/local-thinking-speed 的本機調整（adapterOpts）合在同一條路上：
    // 有 OLLAMA_NUM_CTX_<AGENT> 時照樣送出覆寫值、cassette 記 ollamaOverrides，LaTeX 修復也照樣套用、cassette 仍存原始回應。
    test('record（Ollama＋本機調整）：num_ctx 覆寫照送、cassette 記 ollamaOverrides 與原始回應；agent 拿到修好的', async () => {
        process.env.LLM_MODE = 'record';
        process.env.OLLAMA_NUM_CTX_LATEX_OT = '4096';
        try {
            templates.registerTemplate('latex_ot.v1', '測試用模板（record＋本機調整）');
            const payloads = [];
            ollama._setTransportForTest(async (url, payload) => {
                payloads.push(typeof payload === 'string' ? JSON.parse(payload) : payload);
                return { status: 200, text: JSON.stringify({ model: 'qwen3:8b', done: true, done_reason: 'stop', message: { role: 'assistant', content: MODEL_JSON }, prompt_eval_count: 1, eval_count: 1 }) };
            });
            const opts = { model: 'ollama:qwen3:8b', parts: [{ text: 'q' }], schema: { type: 'object' }, agent: 'latex_ot', template: 'latex_ot.v1', cacheKeyParts: { q: 3 } };
            const res = await silence(() => llm.generateJson(opts));
            assert.deepEqual(res.data, EXPECTED);
            assert.equal(payloads.length, 1);
            assert.equal(payloads[0].options.num_ctx, 4096, '本機調整照送');

            const key = cassette.cassetteKey({ agent: 'latex_ot', modelId: 'qwen3:8b', template: 'latex_ot.v1', schema: { type: 'object' }, cacheKeyParts: { q: 3 } });
            const c = cassette.readCassette('latex_ot', key);
            assert.deepEqual(c.response.data, RAW, 'cassette 存修復前的原始回應');
            assert.deepEqual(c.request.ollamaOverrides, { numCtx: 4096 }, '有套用本機調整才記');
        } finally {
            delete process.env.OLLAMA_NUM_CTX_LATEX_OT;
        }
    });

    test('live（Gemini）：同樣修；沒有 LaTeX 問題的回應與之前逐位元相同（沒有 latexRepair 鍵）', async () => {
        process.env.LLM_MODE = 'live';
        let text = MODEL_JSON;
        gemini._setClientForTest({
            models: { generateContent: async () => ({ text, candidates: [{ finishReason: 'STOP' }], usageMetadata: {} }) }
        });
        const a = await llm.generateJson({ model: 'gemini:gemini-3.5-flash', parts: [{ text: 'q' }] });
        assert.deepEqual(a.data, EXPECTED);
        assert.ok(a.latexRepair);

        text = '{"question_text":"$\\\\frac{1}{2}$\\n(A) 1"}';
        const b = await llm.generateJson({ model: 'gemini:gemini-3.5-flash', parts: [{ text: 'q' }] });
        assert.deepEqual(b.data, { question_text: '$\\frac{1}{2}$\n(A) 1' });
        assert.ok(!('latexRepair' in b));
        assert.deepEqual(Object.keys(b).sort(), ['data', 'latencyMs', 'raw', 'schemaFallback', 'usage']);
    });

    test('generateText 不經 JSON.parse，不套用（文字原樣）', async () => {
        process.env.LLM_MODE = 'live';
        ollama._setTransportForTest(async () => ({ status: 200, text: JSON.stringify({ done: true, message: { role: 'assistant', content: 'a\tb' } }) }));
        const t = await llm.generateText({ model: 'ollama:qwen3:8b', parts: [{ text: 'q' }] });
        assert.equal(t.text, 'a\tb');
    });
});

// ───────────────────────── 5. 回歸：repo 內的真 cassette ─────────────────────────

const CASSETTE_DIR = path.resolve(__dirname, '..', '..', 'eval', 'cassettes');

/** 讀一組 cassette（agent 目錄、模型、模板、recorded_at 前綴都要對上）；目錄不在回 [] */
function loadSet({ agent, model, template, recordedPrefix = '' }) {
    const dir = path.join(CASSETTE_DIR, agent);
    let files;
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    } catch {
        return [];
    }
    const out = [];
    for (const f of files) {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (c.meta?.model !== model || c.meta?.template !== template) continue;
        if (!String(c.meta?.recorded_at || '').startsWith(recordedPrefix)) continue;
        out.push({ key: f.slice(0, -5), data: c.response.data, cacheKeyParts: c.request?.cacheKeyParts || {} });
    }
    return out;
}

/** 數一組裡「換行以外的控制字元」的支數，修前與修後 */
function ctrlCounts(set) {
    let before = 0;
    let after = 0;
    for (const c of set) {
        if (repair.hasNonNewlineControl(c.data)) before += 1;
        if (repair.hasNonNewlineControl(repairLatexEscapes(c.data).value)) after += 1;
    }
    return { before, after };
}

/** 一組裡全部修復的指令次數與救不回來的樣式 */
function tally(set) {
    const commands = {};
    const unresolved = {};
    for (const c of set) {
        const r = repairLatexEscapes(c.data);
        for (const x of r.repairs) commands[x.to] = (commands[x.to] || 0) + 1;
        for (const x of r.unresolved) unresolved[`${x.char}${x.letters}`] = (unresolved[`${x.char}${x.letters}`] || 0) + 1;
    }
    return { commands, unresolved };
}

/** 走訪所有字串值 */
function eachString(v, fn) {
    if (typeof v === 'string') fn(v);
    else if (Array.isArray(v)) v.forEach(x => eachString(x, fn));
    else if (v && typeof v === 'object') Object.values(v).forEach(x => eachString(x, fn));
}

/** 所有字串值裡真的換行字元（U+000A）的個數 */
function newlineCount(v) {
    let n = 0;
    eachString(v, (s) => { n += (s.match(/\n/g) || []).length; });
    return n;
}

/** 換行以外的控制字元，連同後面的字母，寫成「\f＋dg」→ '\\fdg' */
function leftoverControls(v) {
    const out = [];
    eachString(v, (s) => {
        for (const m of s.matchAll(/([\x00-\x09\x0B-\x1F\x7F])([A-Za-z]*)/g)) {
            out.push(`\\${repair.ESCAPE_LETTER[m[1]] || `x${m[1].charCodeAt(0).toString(16)}`}${m[2]}`);
        }
    });
    return out;
}

/** 公式閘門＝agents/lint.js 的 gate（formulaFix → formulaLint，題幹與答案都要過） */
function gateOf(data) {
    return lint.gate(data.question_text, data.answer_text);
}

const LOCAL = {
    variant: loadSet({ agent: 'variant', model: 'qwen3:8b', template: 'variant.v1', recordedPrefix: '2026-09-25' }),
    classify: loadSet({ agent: 'classify', model: 'qwen3:8b', template: 'classify.v1', recordedPrefix: '2026-09-25' }),
    verify: loadSet({ agent: 'verify', model: 'qwen3:8b', template: 'verify.v1', recordedPrefix: '2026-09-25' })
};
const LOCAL_READY = LOCAL.variant.length === 60 && LOCAL.classify.length === 92 && LOCAL.verify.length === 20;

describe('回歸：2026-09-25 本機 cassette（f77d1a3：qwen3:8b 的 variant 60、classify 92、verify 20）', {
    skip: LOCAL_READY ? false
        : `這一批 cassette 已不完整（variant ${LOCAL.variant.length}/60、classify ${LOCAL.classify.length}/92、verify ${LOCAL.verify.length}/20）——` +
          '重錄或 cassettes:prune 之後本組自動略過；數字與原因寫在 docs/llm.md 第 10 節'
}, () => {
    test('帶控制字元（換行以外）的支數：variant 49→3、classify 10→1、verify 1→0', () => {
        assert.deepEqual(ctrlCounts(LOCAL.variant), { before: 49, after: 3 });
        assert.deepEqual(ctrlCounts(LOCAL.classify), { before: 10, after: 1 });
        assert.deepEqual(ctrlCounts(LOCAL.verify), { before: 1, after: 0 });
    });

    test('剩下的全是「換頁＋dg」（模型想寫度數，被 JSON 文法換掉的字母湊不成任何指令）：原樣保留、列進 unresolved', () => {
        assert.deepEqual(tally(LOCAL.variant).unresolved, { '\\fdg': 29 });
        assert.deepEqual(tally(LOCAL.classify).unresolved, { '\\fdg': 1 });
        assert.deepEqual(tally(LOCAL.verify).unresolved, {});
        for (const c of [...LOCAL.variant, ...LOCAL.classify, ...LOCAL.verify]) {
            for (const left of leftoverControls(repairLatexEscapes(c.data).value)) assert.equal(left, '\\fdg', c.key);
        }
    });

    test('冪等：修過的再修一次，一個字都不變', () => {
        for (const c of [...LOCAL.variant, ...LOCAL.classify, ...LOCAL.verify]) {
            const once = repairLatexEscapes(c.data).value;
            const twice = repairLatexEscapes(once);
            assert.equal(twice.value, once, c.key);
            assert.deepEqual(twice.repairs, [], c.key);
        }
    });

    test('修了哪些指令（逐一釘住；改規則時要有意識地更新這裡）', () => {
        assert.deepEqual(tally(LOCAL.variant).commands, {
            '\\times': 85, '\\frac': 65, '\\boldsymbol': 58, '\\theta': 40, '\\tilde': 36, '\\text': 30, '\\bullet': 22,
            '\\textbf': 16, '\\circ': 10, '\\tan': 8, '\\neq': 4, '\\root': 4, '\\norm': 2, '\\big': 2, '\\bigg': 2,
            '\\begin': 1, '\\nu': 1
        });
        assert.deepEqual(tally(LOCAL.classify).commands, {
            '\\theta': 9, '\\frac': 5, '\\text': 5, '\\tan': 4, '\\bullet': 3, '\\bar': 3, '\\times': 1
        });
        assert.deepEqual(tally(LOCAL.verify).commands, { '\\tilde': 2, '\\times': 2, '\\bullet': 1 });
    });

    test('真的換行一個都沒少：修前的換行數 − 修後的換行數 ＝ 修掉的「換行＋指令」數，而且都在公式裡', () => {
        let kept = 0;
        for (const c of [...LOCAL.variant, ...LOCAL.classify, ...LOCAL.verify]) {
            const r = repairLatexEscapes(c.data);
            const nlRepairs = r.repairs.filter(x => x.from.startsWith('\\n'));
            assert.equal(newlineCount(c.data) - newlineCount(r.value), nlRepairs.length, c.key);
            for (const x of nlRepairs) assert.ok(['\\neq', '\\nu', '\\norm'].includes(x.to), `${c.key}：${x.to}`);
            kept += newlineCount(r.value);
        }
        assert.ok(kept > 0, '這一批裡本來就有真的換行（選項分行），要確認它們留著');
    });

    test('公式閘門（variant 的題幹＋答案）：帶壞公式卻通過的 38 支 → 3 支；整體 49 過／11 擋 → 47 過／13 擋', () => {
        let passedWithCtrl = [0, 0];
        const totals = { before: { ok: 0, fail: 0 }, after: { ok: 0, fail: 0 } };
        const flips = { okToFail: [], failToOk: [] };
        for (const c of LOCAL.variant) {
            const fixed = repairLatexEscapes(c.data).value;
            const g0 = gateOf(c.data);
            const g1 = gateOf(fixed);
            totals.before[g0.ok ? 'ok' : 'fail'] += 1;
            totals.after[g1.ok ? 'ok' : 'fail'] += 1;
            if (g0.ok && repair.hasNonNewlineControl(c.data)) passedWithCtrl[0] += 1;
            if (g1.ok && repair.hasNonNewlineControl(fixed)) passedWithCtrl[1] += 1;
            if (g0.ok && !g1.ok) flips.okToFail.push({ key: c.key.slice(0, 8), fixed, g1 });
            if (!g0.ok && g1.ok) flips.failToOk.push(c.key.slice(0, 8));
        }
        assert.deepEqual(passedWithCtrl, [38, 3]);
        assert.deepEqual(totals, { before: { ok: 49, fail: 11 }, after: { ok: 47, fail: 13 } });

        // 變成擋下的 4 支：還原出來的 \bullet／\textbf 解析器不支援（Word 會印出指令名），閘門第一次看得到它們
        assert.deepEqual(flips.okToFail.map(f => f.key).sort(), ['288f5abc', '42633f8b', '578ea572', 'fc040873']);
        for (const f of flips.okToFail) {
            const errs = f.g1.issues.filter(i => i.sev === 'error');
            assert.ok(errs.length > 0 && errs.every(i => i.rule === 'unknown_command'), f.key);
            for (const text of [f.g1.questionText, f.g1.answerText]) {
                for (const ev of tf.parseLatexStrict(text).events.filter(e => e.kind === 'unknown_command')) {
                    assert.match(text.slice(ev.at), /^\\(bullet|textbf)(?![A-Za-z])/, f.key);
                }
            }
        }
        // 變成通過的 2 支：「歸位＋circ」還原成 \circ 之後，原本被切斷的公式（bare_script／missing_rbrace）恢復正常
        assert.deepEqual(flips.failToOk.sort(), ['8144b7b7', 'f241efa6']);
    });

    test('只改字閘門（utils/variantTextGate.js）：壞掉的 \\times／\\theta 讓 5 支「只換數字」的變式看起來改很多，修回後正確擋下', () => {
        const { textGate } = require('../../utils/variantTextGate');
        const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'questions.public.json'), 'utf8'));
        const byId = new Map(fixture.questions.map(q => [q.id, q]));
        const flips = [];
        for (const c of LOCAL.variant) {
            const src = byId.get(c.cacheKeyParts.sourceQuestionId);
            if (!src) continue;
            const gate = (d) => textGate({ source_text: src.question_text, variant_text: String(d.question_text).trim(), minEdit: 0.08 });
            const g0 = gate(c.data);
            const g1 = gate(repairLatexEscapes(c.data).value);
            if (g0.ok !== g1.ok) flips.push(`${c.key.slice(0, 8)} ${g0.ok ? 'ok' : g0.reason}→${g1.ok ? 'ok' : g1.reason}`);
        }
        assert.deepEqual(flips.sort(), [
            '1b417487 ok→too_close', '2c09c928 ok→numbers_only', 'd05f597b ok→too_close',
            'de97ab1a ok→numbers_only', 'ff1b451c ok→too_close'
        ]);
    });
});

const GEMINI = {
    variant: loadSet({ agent: 'variant', model: 'gemini-3.1-pro-preview', template: 'variant.v1' }),
    verify: loadSet({ agent: 'verify', model: 'gemini-3.1-pro-preview', template: 'verify.v1' })
};
const GEMINI_READY = GEMINI.variant.length === 87 && GEMINI.verify.length === 58;

describe('回歸：Gemini 的 variant 87／verify 58（04e9bd3 以前錄的）', {
    skip: GEMINI_READY ? false
        : `這一批 cassette 已不完整（variant ${GEMINI.variant.length}/87、verify ${GEMINI.verify.length}/58）——重錄或清除之後本組自動略過`
}, () => {
    test('帶控制字元（換行以外）的支數：variant 11→1、verify 1→0；剩下的是「歸位＋d」（救不回來）', () => {
        assert.deepEqual(ctrlCounts(GEMINI.variant), { before: 11, after: 1 });
        assert.deepEqual(ctrlCounts(GEMINI.verify), { before: 1, after: 0 });
        assert.deepEqual(tally(GEMINI.variant).unresolved, { '\\rd': 13 });
        assert.deepEqual(tally(GEMINI.variant).commands, { '\\times': 20, '\\frac': 7, '\\theta': 4, '\\text': 3, '\\boldsymbol': 1 });
    });

    test('Gemini 的真換行（variant 71 處、verify 120 處）一個都沒動；公式閘門 86 過／1 擋不變，帶壞公式卻通過的 10 支 → 0', () => {
        let nlBefore = 0;
        let nlAfter = 0;
        let passedWithCtrl = [0, 0];
        const totals = { before: 0, after: 0 };
        for (const c of [...GEMINI.variant, ...GEMINI.verify]) {
            nlBefore += newlineCount(c.data);
            nlAfter += newlineCount(repairLatexEscapes(c.data).value);
        }
        assert.ok(nlBefore > 100, `Gemini 這一批有大量真的換行，實際 ${nlBefore}`);
        assert.equal(nlAfter, nlBefore);
        for (const c of GEMINI.variant) {
            const fixed = repairLatexEscapes(c.data).value;
            const g0 = gateOf(c.data);
            const g1 = gateOf(fixed);
            if (g0.ok) totals.before += 1;
            if (g1.ok) totals.after += 1;
            if (g0.ok && repair.hasNonNewlineControl(c.data)) passedWithCtrl[0] += 1;
            if (g1.ok && repair.hasNonNewlineControl(fixed)) passedWithCtrl[1] += 1;
        }
        assert.deepEqual(totals, { before: 86, after: 86 });
        assert.deepEqual(passedWithCtrl, [10, 0]);
    });
});

// ───────────────────────── 6. 審查意見（dec/latex-escape-repair-fix）─────────────────────────

/** 固定種子的亂數（mulberry32）：同一個種子每次產生同一串，失敗可重現 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('審查 1：公式外連在一起的壞指令一次修完（冪等）', () => {
    test('\\tan\\theta、\\times\\frac、三個連在一起：前一個也修（修前一個時看的是後一個修好之後的反斜線）', () => {
        for (const [model, want] of [
            ['由 \\tan\\theta = 1 得', '由 \\tan\\theta = 1 得'],
            ['所以 \\times\\frac{1}{2}', '所以 \\times\\frac{1}{2}'],
            ['所以 \\tan\\theta\\times 2', '所以 \\tan\\theta\\times 2'],
            ['\\tan\\frac{\\pi}{4} = 1', '\\tan\\frac{\\pi}{4} = 1'],
            ['\\to\\beta', '\\to\\beta']
        ]) {
            const broken = asModelWrote(model);
            const r = repairString(broken);
            assert.equal(r.text, want, JSON.stringify(broken));
            assert.deepEqual(r.unresolved, [], JSON.stringify(broken));
            assert.equal(fix(r.text), r.text, `再修一次不變：${JSON.stringify(broken)}`);
        }
    });

    test('後一個候選沒被修（湊不成指令）時，前一個照「真的定位＋英文字」處理：不修', () => {
        const s = '項目\tan\tapple';
        assert.equal(fix(s), s);
        assert.deepEqual(decide({ ch: '\t', word: 'an', prev: '目', next: '\t', math: null }), { action: 'keep' });
        assert.deepEqual(decide({ ch: '\t', word: 'an', prev: '目', next: '\\', math: null }),
            { action: 'repair', name: 'tan', rule: 'escape' });
    });

    test('固定種子的隨機字串 10 萬筆：修過的再修一次一個字都不變；修復只動「控制字元＋字母」那一段', () => {
        const TOKENS = [
            '\tan', '\theta', '\times', '\to', '\tau', '\top', '\text', '\frac', '\fdg', '\neq', '\nu', '\ne', '\ni', '\nabla',
            '\bot', '\beta', '\bm', '\rho', '\rd', '\rcirc', '\begin', '\tapple',
            '\t', '\n', '\b', '\f', '\r', 'an', 'o', 'e', 'u', 'x', 'y',
            ' ', ' ', '$', '$', '$$', '\\', '\\\\', '{', '}', '(', ')', '^', '_', '&', '=', '中', '1', '，',
            '\\(', '\\)', '\\[', '\\]'
        ];
        const rnd = mulberry32(20260926);
        let totalRepairs = 0;
        let adjacent = 0;
        for (let n = 0; n < 100000; n++) {
            const len = 1 + Math.floor(rnd() * 16);
            let s = '';
            for (let k = 0; k < len; k++) s += TOKENS[Math.floor(rnd() * TOKENS.length)];
            if (/[\x08-\x0D][A-Za-z]+[\x08-\x0D][A-Za-z]/.test(s)) adjacent += 1;
            const once = repairString(s);
            const twice = repairString(once.text);
            if (twice.text !== once.text || twice.repairs.length) {
                assert.fail(`不冪等：${JSON.stringify(s)} → ${JSON.stringify(once.text)} → ${JSON.stringify(twice.text)}`);
            }
            // 把每一處修復套回原字串，要得到同一個結果；被換掉的那一段一定是「控制字元＋字母」
            let rebuilt = '';
            let last = 0;
            for (const r of once.repairs) {
                const span = r.from.length - 1;                   // from 是跳脫寫法（'\\f'＋字母），原字串裡少一個字
                const original = s.slice(r.at, r.at + span);
                const expected = CTRL_OF[r.from[1]] + r.from.slice(2);
                if (original !== expected || !r.to.endsWith(r.from.slice(2))) {
                    assert.fail(`修復位置不對：${JSON.stringify(s)} ${JSON.stringify(r)}`);
                }
                rebuilt += s.slice(last, r.at) + r.to;
                last = r.at + span;
            }
            rebuilt += s.slice(last);
            if (rebuilt !== once.text) assert.fail(`repairs 與 text 對不上：${JSON.stringify(s)}`);
            totalRepairs += once.repairs.length;
        }
        // 產生器本身要涵蓋到審查指出的樣式，不然這個測試是空轉
        assert.ok(adjacent > 20000, `連在一起的候選只有 ${adjacent} 筆`);
        assert.ok(totalRepairs > 100000, `修復只有 ${totalRepairs} 處`);
    });
});

describe('審查 2：控制字元前面的反斜線要數個數', () => {
    test('偶數個（前面是完整的換列 \\\\）：控制字元沒有被跳脫，照一般規則修', () => {
        for (const [broken, want] of [
            ['$x=1\\\\\theta=2$', '$x=1\\\\\\theta=2$'],
            ['$\\begin{cases} x = 1 \\\\\theta = 2 \\end{cases}$', '$\\begin{cases} x = 1 \\\\\\theta = 2 \\end{cases}$'],
            ['$$\\begin{aligned} a &= 1 \\\\\frac{1}{2} &= b \\end{aligned}$$', '$$\\begin{aligned} a &= 1 \\\\\\frac{1}{2} &= b \\end{aligned}$$'],
            ['$\\begin{pmatrix} 1 \\\\\beta \\end{pmatrix}$', '$\\begin{pmatrix} 1 \\\\\\beta \\end{pmatrix}$'],
            ['$a \\\\\\\\\rho$', '$a \\\\\\\\\\rho$']                        // 四個反斜線（兩個換列）
        ]) {
            const r = repairString(broken);
            assert.equal(r.text, want, JSON.stringify(broken));
            assert.deepEqual(r.unresolved, [], JSON.stringify(broken));
        }
    });

    test('奇數個：最後一個反斜線沒有配對，意思不明——不修、列 after_backslash', () => {
        for (const s of ['$a \\\frac{1}{2}$', '$a \\\\\\\frac{1}{2}$', '$x=1\\\\\\\theta$']) {
            const r = repairString(s);
            assert.equal(r.text, s, JSON.stringify(s));
            assert.deepEqual(r.unresolved.map(u => u.reason), ['after_backslash'], JSON.stringify(s));
        }
    });

    test('換列 \\\\ 之後的換行：換列的標準寫法，不修（行內、展示都一樣）', () => {
        for (const s of ['$\\begin{cases} x=1 \\\\\neq 2 \\end{cases}$', '$a \\\\\nu$']) {
            assert.equal(fix(s), s, JSON.stringify(s));
            assert.deepEqual(repairString(s).unresolved, []);
        }
    });

    test('decide：backslashes 參數；省略時由 prev 推（prev 是反斜線算 1 個）', () => {
        const base = { ch: '\t', word: 'heta', prev: '\\', next: '=', math: 'inline' };
        assert.deepEqual(decide({ ...base, backslashes: 2 }), { action: 'repair', name: 'theta', rule: 'escape' });
        assert.deepEqual(decide({ ...base, backslashes: 3 }), { action: 'unresolved', reason: 'after_backslash' });
        assert.deepEqual(decide(base), { action: 'unresolved', reason: 'after_backslash' });
    });
});

describe('審查 3：多行的行內公式、$ 配錯對，不把真的換行改成 \\nu \\ni \\ne \\neq', () => {
    test('審查列的四個誤改：原樣保留；行內公式裡意思不明的單一字母列 ambiguous_newline', () => {
        for (const [s, reasons] of [
            ['解聯立 $\\begin{cases}\nu+v=3 \\\\ u-v=1\n\\end{cases}$', []],
            ['$\\vec a\\times\\vec b=\\begin{vmatrix}\ni & j & k \\\\ 1 & 2 & 3\\end{vmatrix}$', ['ambiguous_newline']],
            ['設 $f(x) =\ne^{x}$', ['ambiguous_newline']],
            ['甲：$x = 1\n乙：$y$ 與\neq 無關', []],
            ['甲：$x = 1\n乙：$y$ 與\neq 無關 $z$', []]                   // 配錯的 $ 後面又關上了
        ]) {
            const r = repairString(s);
            assert.equal(r.text, s, JSON.stringify(s));
            assert.deepEqual(r.unresolved.map(u => u.reason), reasons, JSON.stringify(s));
        }
    });

    test('行內公式真的寫成兩行：第二行後面的文字不因此變成公式（跨行、逐行兩種配對都說是公式才算）', () => {
        const s = '設 $x +\n y$ 項目\tan apple';
        assert.equal(fix(s), s);
    });

    test('單一字母仍然修的情形：公式開頭、空白、左括號、上下標之後，而且公式片段裡沒有多行結構', () => {
        for (const [model, want] of [
            ['動摩擦係數 $\\nu = 0.2$', '動摩擦係數 $\\nu = 0.2$'],
            ['$x \\ne 0$', '$x \\ne 0$'],
            ['$a \\ni b$', '$a \\ni b$'],
            ['$v = \\nu\\lambda$', '$v = \\nu\\lambda$'],
            ['$\\frac{\\nu}{2}$', '$\\frac{\\nu}{2}$'],
            ['$x_\\nu$', '$x_\\nu$'],
            ['\\(\\nu\\)', '\\(\\nu\\)']
        ]) {
            assert.equal(fix(asModelWrote(model)), want, model);
        }
    });

    test('Windows 換行（\\r\\n）後面接字母：真的換行，不修', () => {
        for (const s of ['$a = 1\r\neq 2$', '$a\r\nu$']) {
            assert.equal(fix(s), s, JSON.stringify(s));
            assert.deepEqual(repairString(s).unresolved, []);
        }
    });

    test('mathSpans：預設跨行配對；lineAware 時單一 $ 不跨越真的換行，「可能是被吃掉的 \\n」不算斷行', () => {
        const s = '甲：$x = 1\n乙：$y$ 與\neq 無關';
        const show = (spans) => spans.map(x => [s.slice(x.start, x.end), x.kind]);
        assert.deepEqual(show(mathSpans(s)), [['$x = 1\n乙：$', 'inline'], ['$ 與\neq 無關', 'open']]);
        assert.deepEqual(show(mathSpans(s, { lineAware: true })), [['$x = 1', 'open'], ['$y$', 'inline']]);
        const t = '$a \neq b$ 與 $c$\n$$x\ny$$';
        assert.deepEqual(mathSpans(t, { lineAware: true }).map(x => [t.slice(x.start, x.end), x.kind]),
            [['$a \neq b$', 'inline'], ['$c$', 'inline'], ['$$x\ny$$', 'display']]);
    });
});

describe('審查 4：指令表補齊；公式外的定位不再「不修也不列」', () => {
    const REVIEW_NAMES = ['bot', 'top', 'bm', 'bf', 'rm', 'bmod', 'bigcup', 'bigcap', 'breve', 'nmid', 'nsubseteq', 'ncong',
        'nexists', 'nparallel', 'triangleq', 'textdegree', 'textcircled', 'texttt', 'textsf', 'rbrace', 'rvert', 'tbinom', 'newline'];

    test('審查列的 23 個指令都在指令表裡；還原後公式閘門看得到（unknown_command）', () => {
        const table = commandTable();
        for (const n of REVIEW_NAMES) {
            assert.ok(table.has(n), n);
            if (tf.supportedCommandNames().includes(n)) continue;
            const fixed = fix(`$a ${CTRL_OF[n[0]]}${n.slice(1)}{x}$`);
            assert.equal(fixed, `$a \\${n}{x}$`, n);
            const g = lint.gate(fixed, '');
            assert.equal(g.ok, false, n);
            assert.ok(g.issues.some(i => i.rule === 'unknown_command'), n);
        }
    });

    test('審查的重現：\\bot、\\bm、\\bigcup 修回、不列 unresolved，公式閘門擋下（不再安靜通過）', () => {
        const s = '$L_1 \bot L_2$，$\bm{a}$，$A \bigcup B$';
        const r = repairString(s);
        assert.equal(r.text, '$L_1 \\bot L_2$，$\\bm{a}$，$A \\bigcup B$');
        assert.deepEqual(r.unresolved, []);
        const g = lint.gate(r.text, '');
        assert.equal(g.ok, false);
        assert.ok(g.issues.filter(i => i.sev === 'error').every(i => i.rule === 'unknown_command'));
    });

    test('換行開頭的（\\nsubseteq、\\nmid）在行內公式裡修', () => {
        assert.equal(fix('$A \nsubseteq B$'), '$A \\nsubseteq B$');
        assert.equal(fix(asModelWrote('$3 \\nmid 7$')), '$3 \\nmid 7$');
    });

    test('公式外的定位＋指令名，後面緊接中文、數字、標點或字串結尾：修', () => {
        for (const [broken, want] of [
            ['夾角\theta為銳角', '夾角\\theta為銳角'],
            ['3\times4=12', '3\\times4=12'],
            ['故 \tan45° = 1', '故 \\tan45° = 1'],
            ['時間常數\tau為 RC', '時間常數\\tau為 RC'],
            ['所以夾角為\theta', '所以夾角為\\theta'],
            ['所以 x\to∞', '所以 x\\to∞']
        ]) {
            const r = repairString(broken);
            assert.equal(r.text, want, JSON.stringify(broken));
            assert.deepEqual(r.unresolved, []);
        }
    });

    test('指令表裡每一個 t 開頭的指令，公式外後面接中文、數字、標點都修（沒有「不修也不列」）', () => {
        const tNames = [...commandTable()].filter(n => n[0] === 't');
        for (const name of tNames) {
            for (const next of ['為', '4', '。', ',']) {
                const r = repairString(`題幹\t${name.slice(1)}${next}`);
                assert.equal(r.text, `題幹\\${name}${next}`, `${name}${next}`);
            }
        }
    });

    test('只剩一種樣子不修：一兩個字母＋空白或結尾（真的定位＋英文單字 an、o、au、op）', () => {
        for (const s of ['項目\tan apple', 'Name\to be', '\tau 是希臘字母', '欄\top', '欄\top\t下一欄']) {
            assert.equal(fix(s), s, JSON.stringify(s));
            assert.deepEqual(repairString(s).unresolved, []);
        }
    });
});
