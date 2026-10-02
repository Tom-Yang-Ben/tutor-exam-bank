// ─────────────────────────────────────────────────────────────
// test/unit/extractFixesR13.test.js — 本機拆題修正（〔dec/r13-extract-fixes〕Owner 2026-10-02 同意；docs/local-mode.md 10.25）
//
// 起因：114-2 興大附中高二期末考數學 A（5 頁，第 5 頁是解答表）用本機模式（PaddleOCR＋qwen3:8b，LOCAL_EXTRACT_MODE=ocr）拆題的
// 交叉驗證。這裡用那份卷的結構與實際壞例子：
//   1. 解答頁：單選 1～5、多選 6～8、選填 A～H；表格文字「1. 2. 3. 4. 5. 1 3 4 5 2」「6. 7. 8. 12 245 145」
//      「A. B. C. D. E. 2 -2 12 5 7-9 72」「F. G. H. 4-3 -7 31 27 17'7」（分數被 OCR 拆成上下兩個數字：解析不確定就不回填）。
//   2. 拆題不准編答案：題目頁沒有答案時清成空字串；解答頁的元素不建題；回填只在題號與題數對得上時做。
//   3. LaTeX 確定性修復：\\ 只剩一個、\end 斷成換行＋end{…}、cases 配 \right.、\textcircled 的填答格與度數、開頭上標。
//   4. 答案比對：「(5)。θ=84°」對「84°」、「(3)」對「14」看選項內容、\textcircled{\circ}。
//   5. verify：沒有答案 → no_claim、建議答案；不進 answer_mismatch。
//   6. 本機 lint／verify 逾時：30 分鐘本機預設、不重試直接進複核（provider_error）；Gemini 不變。
//   7. runner：答案是空的題 save 前停在 awaiting_approval；lint 的空答案不蓋掉解答頁回填的答案。
// 不連 DB、不呼叫模型（OCR、模型、資料庫都是假的）。真 PG 的版本在 test/integration/extractAnswerKey.pg.test.js。
// 執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

const answerKey = require('../../utils/answerKey');
const { repairText, repairElement, BLANK } = require('../../utils/extractLatexRepair');
const { answerCompare, toNumber, parseOptions } = require('../../utils/answerCompare');
const { formulaLint } = require('../../utils/formulaLint');
const sm = require('../../pipeline/stateMachine');
const runner = require('../../workers/jobRunner');
const tuning = require('../../services/llm/localTuning');
const extract = require('../../agents/extract');
const models = require('../../config/models');

const QUIET = { info() { }, warn() { }, error() { } };

// ───────────── 114-2 興大附中高二期末考數學 A 的結構 ─────────────

const HEADER = '臺中市立興大附中 114 學年度第 2 學期 高二 期末考 數學科 A 卷';
const KEY_ROWS = [
    '1. 2. 3. 4. 5. 1 3 4 5 2',
    '6. 7. 8. 12 245 145',
    'A. B. C. D. E. 2 -2 12 5 7-9 72',
    "F. G. H. 4-3 -7 31 27 17'7"
];
const KEY_PAGE = [HEADER, '## 解答', ...KEY_ROWS].join('\n\n');
/** 題目頁：頁首、作答說明（「答案卡」不是解答）、題目，沒有任何答案 */
const Q_PAGE_1 = [HEADER, '一、單選題（每題 5 分）請將答案畫記在答案卡上。',
    '1. 設 a,b 為實數，若聯立方程組 ax+y=1、x+by=2 無解，則下列何者正確？(1) a=1 (2) b=1 (3) ab=1 (4) a+b=1 (5) a-b=1',
    '2. 多項式函數 f(x) 的圖形… 則 f(2) 之值為何？(1) 10 (2) 12 (3) 14 (4) 16 (5) 18'].join('\n\n');
const Q_PAGE_4 = [HEADER, '三、選填題', 'H. 已知向量… 則 a·b = ⑮⑯ 。'].join('\n\n');

const LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const TYPES = [...Array(5).fill('單選'), ...Array(3).fill('多選'), ...Array(8).fill('填空')];
/** 存活的 16 題（idx：第 1 塊 1001–1009＝第 1～8 題＋A，第 2 塊 2001–2007＝B～H） */
function sixteen(overrides = {}) {
    return LABELS.map((label, i) => ({
        id: 100 + i,
        idx: i < 9 ? 1001 + i : 2001 + (i - 9),
        question_type: TYPES[i],
        question_text: `${label}. 第 ${label} 題的題幹`,
        answer_text: '',
        ...(overrides[label] || {})
    }));
}

describe('解答頁偵測與解析（utils/answerKey.js）', () => {
    test('解答頁：有「解答」標題＋兩串以上連號題號 → 是；題目頁（含「答案卡」作答說明）→ 不是', () => {
        assert.equal(answerKey.isAnswerKeyPage(KEY_PAGE), true);
        assert.equal(answerKey.isAnswerKeyPage(Q_PAGE_1), false);
        assert.equal(answerKey.isAnswerKeyPage(Q_PAGE_4), false);
        assert.equal(answerKey.isAnswerKeyPage(KEY_ROWS.join('\n')), false, '沒有「解答／答案」標題不算');
        assert.equal(answerKey.isAnswerKeyPage(`${HEADER}\n請將答案畫記在答案卡上\n${KEY_ROWS.join('\n')}`), false, '「答案卡」「將答案」不是標題');
        // HTML 表格（PaddleOCR 常見）也認得
        const html = `${HEADER}\n<h2>答案</h2><table><tr><td>1.</td><td>2.</td><td>3.</td></tr><tr><td>4</td><td>1</td><td>2</td></tr>` +
            '<tr><td>4.</td><td>5.</td><td>6.</td></tr><tr><td>3</td><td>5</td><td>2</td></tr></table>';
        assert.equal(answerKey.isAnswerKeyPage(html), true);
        // 「1. 3 2. 4 3. 1 …」一題一格的排法
        assert.equal(answerKey.isAnswerKeyPage('參考答案\n1. 3 2. 4 3. 1 4. 2 5. 5 6. 3'), true);
    });

    test('解析：單選 1～5、多選 6～8 確定；A～E 六個值對五個題號、F～H 五個值對三個題號（分數被拆開）→ 不確定，不給值', () => {
        const { entries, rows } = answerKey.parseAnswerKey(KEY_PAGE, 5);
        assert.deepEqual(entries.map(e => e.label), LABELS);
        assert.deepEqual(entries.slice(0, 8).map(e => [e.value, e.certain]), [
            ['1', true], ['3', true], ['4', true], ['5', true], ['2', true], ['12', true], ['245', true], ['145', true]
        ]);
        assert.ok(entries.slice(8).every(e => e.value === null && e.certain === false && e.page === 5));
        assert.deepEqual(rows.map(r => r.certain), [true, true, false, false]);
        assert.deepEqual(rows[2].values, ['2', '-2', '12', '5', '7-9', '72']);
        assert.deepEqual(rows[3].values, ['4-3', '-7', '31', '27', "17'7"]);
    });

    test('個數對得上但出現 7-9、17\'7 這種樣子：仍然不確定', () => {
        const { entries } = answerKey.parseAnswerKey("解答\n\nA. B. C. 7-9 2 3\n\nD. E. 17'7 5");
        assert.ok(entries.every(e => !e.certain && e.value === null), JSON.stringify(entries));
    });

    test('回填（mapAnswerKey）：1～8 依題型寫成 (1)…(2)(4)(5)；A～H 不確定不回填；題數或題號對不上整份不回填', () => {
        const { entries } = answerKey.parseAnswerKey(KEY_PAGE, 5);
        const plan = answerKey.mapAnswerKey(entries, sixteen());
        assert.equal(plan.ok, true, plan.reason);
        assert.deepEqual(plan.updates.map(u => [u.idx, u.label, u.answer_text]), [
            [1001, '1', '(1)'], [1002, '2', '(3)'], [1003, '3', '(4)'], [1004, '4', '(5)'], [1005, '5', '(2)'],
            [1006, '6', '(1)(2)'], [1007, '7', '(2)(4)(5)'], [1008, '8', '(1)(4)(5)']
        ]);
        assert.deepEqual(plan.skipped.map(s => [s.label, s.reason]), LABELS.slice(8).map(l => [l, 'uncertain_row']));

        // 題數不同（例如解答頁的垃圾題沒擋下來，多了 8 題）→ 不回填
        const extra = [...sixteen(), ...Array.from({ length: 8 }, (_, i) => ({ id: 900 + i, idx: 3001 + i, question_type: '填空', question_text: KEY_PAGE, answer_text: '' }))];
        assert.deepEqual([answerKey.mapAnswerKey(entries, extra).ok, answerKey.mapAnswerKey(entries, extra).reason], [false, 'count_mismatch:16/24']);
        // 題幹開頭寫的題號對不上 → 不回填
        const bad = answerKey.mapAnswerKey(entries, sixteen({ 3: { question_text: '4. 題號寫錯的那一題' } }));
        assert.equal(bad.ok, false);
        assert.match(bad.reason, /^label_mismatch:1003/);
        // 題幹沒寫題號（模型把題號拿掉了）不算對不上
        assert.equal(answerKey.mapAnswerKey(entries, sixteen({ 3: { question_text: '設 a,b 為實數…' } })).ok, true);
        // 題型與值對不上（單選卻是 245）、已經有答案：那一題不回填
        const mixed = answerKey.mapAnswerKey(entries, sixteen({ 7: { question_type: '單選' }, 1: { answer_text: '(1)' } }));
        assert.deepEqual(mixed.skipped.filter(s => s.reason !== 'uncertain_row').map(s => [s.label, s.reason]), [['1', 'has_answer'], ['7', 'type_mismatch']]);
    });

    test('formatKeyAnswer：多選要由小到大不重複；填空的整數、負數、分數', () => {
        assert.equal(answerKey.formatKeyAnswer('542', '多選'), null);
        assert.equal(answerKey.formatKeyAnswer('22', '多選'), null);
        assert.equal(answerKey.formatKeyAnswer('-2', '填空'), '$-2$');
        assert.equal(answerKey.formatKeyAnswer('3/4', '填空'), '$\\frac{3}{4}$');
        assert.equal(answerKey.formatKeyAnswer('12', '單選'), null);
        assert.equal(answerKey.formatKeyAnswer('3', '證明'), null);
    });

    test('題目頁有沒有寫答案：「答：」「【解答】」「解析：」算；「請將答案畫記在答案卡上」「回答：」不算', () => {
        assert.equal(answerKey.hasAnswerOnPage(Q_PAGE_1), false);
        assert.equal(answerKey.hasAnswerOnPage('請回答：下列何者正確'), false);
        for (const s of ['1. 求 x。答：3', '【解答】(2)', '解析：由題意…', '答案：(B)']) assert.equal(answerKey.hasAnswerOnPage(s), true, s);
    });

    test('填答格記號不是答案：⑮⑯、\\textcircled{m}\\textcircled{q}、底線；真的答案不是', () => {
        for (const s of ['⑮⑯', '$\\textcircled{m}\\textcircled{q}$', '＿＿＿＿', '⑨、⑩']) assert.equal(answerKey.isBlankMarkerAnswer(s), true, s);
        for (const s of ['(3)', '$72$', '', '⑮⑯＝72']) assert.equal(answerKey.isBlankMarkerAnswer(s), false, s);
    });
});

describe('拆出來的元素：解答表不建題、題目頁沒寫答案就清掉（processChunkAnswers）', () => {
    const el = (question_text, answer_text = '(4)', question_type = '單選') => ({ question_text, answer_text, question_type });

    test('第 3 塊只有第 5 頁（解答頁）：拆出的 8 題垃圾（頁首＋解答表文字）全部不建題；解析出 16 個題號', () => {
        const garbage = Array.from({ length: 8 }, () => el(`${HEADER} 解答 ${KEY_ROWS.join(' ')}`, '1'));
        const r = answerKey.processChunkAnswers(garbage, [{ page: 5, markdown: KEY_PAGE }]);
        assert.equal(r.skip.size, 8);
        assert.ok([...r.skip.values()].every(v => v === 'key_chunk'));
        assert.deepEqual(r.summary.pages, [5]);
        assert.equal(r.summary.entries.length, 16);
        assert.equal(r.summary.skipped.length, 8);
    });

    test('題目頁與解答頁同一塊：有連號題號串的元素、字幾乎都出自解答頁的元素不建題；真題保留', () => {
        const real = el('2. 多項式函數 f(x) 的圖形… 則 f(2) 之值為何？(1) 10 (2) 12 (3) 14 (4) 16 (5) 18');
        const r = answerKey.processChunkAnswers(
            [real, el(`${HEADER} 6. 7. 8. 12 245 145`), el('解答 2 -2 12 5 7-9 72 4-3 -7 31 27')],
            [{ page: 4, markdown: Q_PAGE_1 }, { page: 5, markdown: KEY_PAGE }]);
        assert.deepEqual([...r.skip.entries()], [[1, 'label_run'], [2, 'key_text']]);
    });

    test('沒偵測到解答頁也認得：同一塊 3 題以上題幹幾乎相同而且都有連號題號串', () => {
        const g = `${HEADER} 1. 2. 3. 4. 5. 1 3 4 5 2`;
        const r = answerKey.processChunkAnswers([el(g), el(g), el(g), el('1. 真的題目 (1) a (2) b')], [{ page: 1, markdown: '（OCR 沒有標題）' }]);
        assert.deepEqual([...r.skip.keys()].sort(), [0, 1, 2]);
        assert.equal(r.skip.get(0), 'duplicate_stems');
    });

    test('題目頁沒有寫答案：模型編的答案清成空字串，原文記在 notes；選填題抄的 ⑮⑯ 一樣清掉', () => {
        const els = [el('1. 設 a,b 為實數…', '(4)'), el('H. 已知向量… a·b = ＿＿＿＿', '⑮⑯', '填空'), el('沒有答案的題', '')];
        const r = answerKey.processChunkAnswers(els, [{ page: 1, markdown: Q_PAGE_1 }, { page: 4, markdown: Q_PAGE_4 }]);
        assert.deepEqual(els.map(e => e.answer_text), ['', '', '']);
        assert.deepEqual(r.notes.get(0), { reason: 'not_on_page', text: '(4)' });
        assert.deepEqual(r.notes.get(1), { reason: 'not_on_page', text: '⑮⑯' });
        assert.equal(r.notes.has(2), false, '本來就是空的不記');
        assert.equal(r.summary.answers_on_page, false);
        assert.equal(r.summary.answers_dropped, 2);
    });

    test('題目頁有寫答案（「答：」）：答案保留；只有填答格記號的答案仍清掉（blank_marker）', () => {
        const els = [el('1. 求 x', '$3$', '填空'), el('2. 求 y', '\\textcircled{m}\\textcircled{q}', '填空')];
        const r = answerKey.processChunkAnswers(els, [{ page: 1, markdown: '1. 求 x。答：3\n2. 求 y。答：⑨⑩' }]);
        assert.deepEqual(els.map(e => e.answer_text), ['$3$', '']);
        assert.equal(r.notes.get(1).reason, 'blank_marker');
    });

    test('沒有 OCR 頁面（OCR_ENGINE=none）：什麼都不做', () => {
        const els = [el('1. 題', '(3)')];
        const r = answerKey.processChunkAnswers(els, null);
        assert.equal(r.summary, null);
        assert.equal(els[0].answer_text, '(3)');
    });
});

describe('LaTeX 確定性修復（utils/extractLatexRepair.js）：這份卷的實際壞例子', () => {
    test('矩陣：換列的 \\\\ 只剩一個反斜線、\\end{bmatrix} 斷成「換行＋end{bmatrix}」→ 補回；修完公式閘門過', () => {
        const bad = '設 $A=\\begin{bmatrix} 1 & 2 \\ 3 & 4\nend{bmatrix}$，求 $A^2$。';
        const r = repairText(bad);
        assert.equal(r.text, '設 $A=\\begin{bmatrix} 1 & 2 \\\\ 3 & 4\\end{bmatrix}$，求 $A^2$。');
        assert.deepEqual(r.repairs, [{ rule: 'end_newline', count: 1 }, { rule: 'row_break', count: 1 }]);
        assert.equal(formulaLint(r.text).ok, true, JSON.stringify(formulaLint(r.text)));
        // 三列、換列後面直接換行的寫法
        const r3 = repairText('$\\begin{bmatrix} 1 & 0 \\\n0 & 1 \\ 2 & 3 \n end{bmatrix}$');
        assert.equal(r3.text, '$\\begin{bmatrix} 1 & 0 \\\\\n0 & 1 \\\\ 2 & 3 \\end{bmatrix}$');
    });

    test('聯立方程組：\\begin{cases} 用 \\right. 收尾 → \\end{cases}，配對的 \\left\\{ 一併拿掉', () => {
        const r = repairText('$\\left\\{ \\begin{cases} ax+y=1 \\\\ x+by=2 \\right.$ 無解');
        assert.equal(r.text, '$\\begin{cases} ax+y=1 \\\\ x+by=2 \\end{cases}$ 無解');
        assert.deepEqual(r.repairs, [{ rule: 'cases_right', count: 1 }]);
        assert.equal(formulaLint(r.text).ok, true);
        // 沒有 \left\{ 的版本、換列也壞掉的版本
        assert.equal(repairText('$\\begin{cases} x+y=3 \\ x-y=1 \\right.$').text, '$\\begin{cases} x+y=3 \\\\ x-y=1 \\end{cases}$');
        // 本來就寫對的不動
        const ok = '$\\left\\{ \\begin{cases} x=1 \\end{cases} \\right.$';
        assert.deepEqual(repairText(ok), { text: ok, repairs: [] });
    });

    test('填答格：連續的 \\textcircled{m}\\textcircled{q} → ＿＿＿＿（只在單選／多選以外的題型）；單個不動', () => {
        const r = repairText('$\\vec{a}\\cdot\\vec{b}=\\textcircled{m}\\textcircled{q}$', { questionType: '填空' });
        assert.equal(r.text, `$\\vec{a}\\cdot\\vec{b}=${BLANK}$`);
        assert.deepEqual(r.repairs, [{ rule: 'blank_boxes', count: 1 }]);
        assert.equal(formulaLint(r.text).ok, true);
        const choice = '(A) $\\textcircled{1}\\textcircled{2}$ (B) $\\textcircled{1}\\textcircled{3}$';
        assert.equal(repairText(choice, { questionType: '單選' }).text, choice, '單選的「①②」是敘述代號的組合');
        assert.equal(repairText('敘述 $\\textcircled{1}$ 正確', { questionType: '填空' }).repairs.length, 0, '單個不動');
    });

    test('度數：\\textcircled{\\circ} → ^\\circ（前面已經有 ^ 或包在 ^{…} 裡也對）', () => {
        assert.equal(repairText('$\\theta=84\\textcircled{\\circ}$').text, '$\\theta=84^\\circ$');
        assert.equal(repairText('$84^{\\textcircled{\\circ}}$').text, '$84^{\\circ}$');
        assert.equal(repairText('$84^\\textcircled{\\circ}$').text, '$84^\\circ$');
        assert.deepEqual(repairText('$84^\\circ$').repairs, []);
    });

    test('開頭上標：$^{a,b}$ → $a,b$；10$^{2}$、x$^{a,b}$ 那是真的上標，不動', () => {
        assert.equal(repairText('設 $^{a,b}$ 為實數').text, '設 $a,b$ 為實數');
        assert.equal(repairText('$^{a, b, c}$ 為正數').text, '$a,b,c$ 為正數');
        for (const s of ['10$^{2}$', 'x$^{a,b}$', '設 $^{2}$ 為', '$x^{a,b}$']) assert.deepEqual(repairText(s).repairs, [], s);
    });

    test('冪等：修過的再修一次一個字都不變；repairElement 記下欄位與規則', () => {
        const el = {
            question_type: '填空',
            question_text: '$\\begin{bmatrix} 1 & 2 \\ 3 & 4\nend{bmatrix}$ 且 $\\theta=\\textcircled{m}\\textcircled{q}$',
            answer_text: '$84\\textcircled{\\circ}$'
        };
        const log = repairElement(el);
        assert.deepEqual(log, [
            { field: 'question_text', rule: 'end_newline', count: 1 }, { field: 'question_text', rule: 'row_break', count: 1 },
            { field: 'question_text', rule: 'blank_boxes', count: 1 }, { field: 'answer_text', rule: 'degree_circled', count: 1 }
        ]);
        const again = { ...el };
        assert.deepEqual(repairElement(again), []);
        assert.deepEqual(again, el);
    });
});

describe('答案比對（utils/answerCompare.js）：選項＋數值混寫、數字選項、度數', () => {
    const cmp = (type, claimed, final, form = 'option', question_text) => answerCompare({ question_type: type, claimed, model: { final_answer: final, answer_form: form }, question_text });
    const Q2 = '多項式函數 f(x) 的圖形… 則 f(2) 之值為何？(1) $10$ (2) $12$ (3) $14$ (4) $16$ (5) $18$';
    const Q4 = '求兩向量的夾角 $\\theta$。(1) $24^\\circ$ (2) $36^\\circ$ (3) $48^\\circ$ (4) $60^\\circ$ (5) $84^\\circ$';

    test('Q4：claimed「(5)。$\\theta$=84^\\circ」對 verify「84°」→ agree（原本 uncertain）；有題幹或沒有都一樣', () => {
        assert.equal(cmp('單選', '(5)。$\\theta$=84^\\circ', '84°', 'number'), 'agree');
        assert.equal(cmp('單選', '(5)。$\\theta$=84^\\circ', '84°', 'number', Q4), 'agree');
        assert.equal(cmp('單選', '(5)', '$84^\\circ$', 'number', Q4), 'agree');
        assert.equal(cmp('單選', '(4)', '84°', 'number', Q4), 'disagree', '選項 (4) 是 60°');
    });

    test('Q2：「(3)」對「14」看選項內容 → agree；對「16」→ disagree；讀不到選項 → uncertain（不判 disagree）', () => {
        assert.equal(cmp('單選', '(3)', '14', 'number', Q2), 'agree');
        assert.equal(cmp('單選', '(3)', '16', 'number', Q2), 'disagree');
        assert.equal(cmp('單選', '(3)', '14', 'number'), 'uncertain');
        assert.equal(cmp('單選', '(3)', '15', 'number', Q2), 'uncertain', '數值不是任何一個選項');
    });

    test('數字代號兩邊都有：單選、多選照集合比；度數 \\textcircled{\\circ}', () => {
        assert.equal(cmp('單選', '(3)', '(3)'), 'agree');
        assert.equal(cmp('多選', '(2)(4)(5)', '(2)(4)(5)'), 'agree');
        assert.equal(cmp('多選', '(2)(4)(5)', '(2)(4)'), 'disagree');
        assert.equal(cmp('單選', '(3)', '(C)'), 'uncertain', '數字對字母不比');
        assert.equal(toNumber('84\\textcircled{\\circ}'), 84);
        assert.equal(toNumber('84^{\\textcircled{\\circ}}'), 84);
        assert.equal(cmp('填空', '$84\\textcircled{\\circ}$', '84°', 'number'), 'agree');
    });

    test('字母代號照舊（凍結的比法不變）；中文句號分隔', () => {
        assert.equal(cmp('單選', '(C)。$f(3)=7$', '(C)'), 'agree');
        assert.equal(cmp('單選', '(C)', '(B)'), 'disagree');
        assert.equal(cmp('單選', '(A)', '互相垂直'), 'uncertain');
        assert.equal(cmp('單選', '(5)。84°。', '84', 'number'), 'agree');
    });

    test('parseOptions：取最後一串從 (1)／(A) 開始的連號代號', () => {
        assert.deepEqual([...parseOptions(Q2)], [['1', '$10$'], ['2', '$12$'], ['3', '$14$'], ['4', '$16$'], ['5', '$18$']]);
        assert.equal(parseOptions('沒有選項').size, 0);
    });
});

describe('verify：拆題沒有答案 → no_claim（不比對、不進 answer_mismatch）', () => {
    const verify = require('../../agents/verify');
    function ctxWith(final) {
        const calls = [];
        return {
            calls,
            ctx: {
                llm: { generateJson: async (opts) => { calls.push(opts); return { data: { final_answer: final, answer_form: 'number', steps_summary: '算出來' }, usage: {} }; } },
                config: { models: { verify: 'ollama:qwen3:8b' } }, logger: QUIET
            }
        };
    }

    test('claimed 是空字串：採樣一次、compare=no_claim、pass，建議答案存成 suggested_answer', async () => {
        const { ctx, calls } = ctxWith('84°');
        const o = await verify.run(ctx, { question_text: '求夾角', question_type: '單選', claimed_answer: '' });
        assert.equal(o.kind, 'pass');
        assert.equal(o.data.compare, 'no_claim');
        assert.equal(o.data.suggested_answer, '84°');
        assert.equal(o.data.samples, 1);
        assert.equal(calls.length, 1, '沒有東西可比，不再採樣');
        const o2 = await verify.run(ctxWith('3').ctx, { question_text: 'q', question_type: '填空', claimed_answer: '   ' });
        assert.equal(o2.data.compare, 'no_claim', '只有空白也算沒有答案');
    });

    test('有答案時照舊比（題幹給比對器讀選項）；agree 的 data 沒有 suggested_answer', async () => {
        const { ctx } = ctxWith('14');
        const o = await verify.run(ctx, { question_text: '(1) $10$ (2) $12$ (3) $14$ (4) $16$ (5) $18$', question_type: '單選', claimed_answer: '(3)' });
        assert.equal(o.kind, 'pass');
        assert.equal(o.data.compare, 'agree');
        assert.equal('suggested_answer' in o.data, false);
    });

    test('runner 的 buildSolutionFields：no_claim 不寫詳解（詳解只在 agree 時寫）', () => {
        assert.deepEqual(runner.buildSolutionFields({ verify: { compare: 'no_claim', steps_summary: '算出來' } }), { solution_text: null, solution_src: null });
    });
});

describe('lint：原本沒有答案時，模型回的答案不採用', () => {
    const lint = require('../../agents/lint');
    test('第三層重寫回了 answer_text「(3)」或「（空）」：仍是空字串', async () => {
        for (const back of ['(3)', '（空）']) {
            const ctx = {
                llm: { generateJson: async () => ({ data: { question_text: '求 $\\frac{1}{2}$ 的值', answer_text: back }, usage: {} }) },
                config: { models: { text: 'ollama:qwen3:8b' } }, logger: QUIET
            };
            const o = await lint.run(ctx, { question_text: '求 $\\frac{1}{2$ 的值', answer_text: '' });
            assert.equal(o.kind, 'pass', JSON.stringify(o));
            assert.equal(o.data.answer_text, '', back);
        }
    });
});

describe('狀態機規則 6b：本機 lint／verify 逾時不重試', () => {
    const TIMEOUT = Object.freeze({ kind: 'error', errorClass: 'timeout', message: 'Ollama 呼叫超過 OLLAMA_TIMEOUT_MS_LINT（1800000 ms）仍未完成' });
    test('retryTimeout:false → needs_review(provider_error)、計數器不動；沒給（Gemini）照舊重試', () => {
        for (const state of ['classified', 'source_checked']) {
            const r = sm.transition({ state, retries: { lint: 1 }, outcome: TIMEOUT, limits: { ...sm.DEFAULT_LIMITS, retryTimeout: false } });
            assert.deepEqual(r, { state: 'needs_review', retries: { lint: 1 }, review_reason: 'provider_error' });
        }
        const g = sm.transition({ state: 'classified', retries: {}, outcome: TIMEOUT });
        assert.deepEqual([g.state, g.retries], ['classified', { 'lint:error': 1 }]);
        const other = sm.transition({ state: 'classified', retries: {}, outcome: { ...TIMEOUT, errorClass: 'provider_error' }, limits: { retryTimeout: false } });
        assert.equal(other.state, 'classified', '不是逾時的錯照舊重試');
        assert.equal('retryTimeout' in sm.DEFAULT_LIMITS, false, 'DEFAULT_LIMITS 沒有多欄位');
    });

    test('isLocalTimeout：只有本機模型的 lint／verify 逾時；classify、Gemini、沒呼叫到模型都不算', () => {
        assert.equal(runner.isLocalTimeout('lint', TIMEOUT, 'ollama:qwen3:8b'), true);
        assert.equal(runner.isLocalTimeout('verify', TIMEOUT, 'ollama:qwen3:8b'), true);
        assert.equal(runner.isLocalTimeout('classify', TIMEOUT, 'ollama:qwen3:8b'), false);
        assert.equal(runner.isLocalTimeout('verify', TIMEOUT, 'gemini:gemini-3.1-pro-preview'), false);
        assert.equal(runner.isLocalTimeout('verify', TIMEOUT, null), false);
        assert.equal(runner.isLocalTimeout('verify', { ...TIMEOUT, errorClass: 'schema_invalid' }, 'ollama:qwen3:8b'), false);
    });
});

describe('runner（假 db）：本機 lint／verify 逾時一次就進複核', () => {
    const KEYS = ['MODEL_VERIFY', 'MODEL_EXTRACT', 'MODEL_TEXT'];
    const saved = {};
    before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
    after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

    async function runOnce(model) {
        process.env.MODEL_VERIFY = model;
        process.env.MODEL_EXTRACT = model.startsWith('ollama:') ? 'ollama:qwen3-vl:8b' : 'gemini:gemini-3.5-flash';
        const jq = {
            id: 88, job_id: 9, idx: 1001, state: 'source_checked', retries: {},
            payload: { extract: { subject: '數學', chapter: '向量', question_text: '求 1+1', answer_text: '', question_type: '計算' } },
            kind: 'pdf', pdf_sha256: 'a'.repeat(64), source_type: 'unknown', source_detail: null, subject_group: 'math_physics', budget_usd: 0.5, cost_usd: 0
        };
        const log = [];
        const db = {
            pool: { connect: async () => { throw new Error('不該開交易'); } },
            async query(text, params) {
                log.push({ text, params });
                if (/FROM job_questions q JOIN jobs j/.test(text)) return { rows: [jq], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            }
        };
        const sleeps = [];
        const err = Object.assign(new Error('Ollama 呼叫超過 OLLAMA_TIMEOUT_MS_VERIFY（1800000 ms）仍未完成：/api/chat(qwen3:8b)'), { errorClass: 'timeout', timedOut: true });
        const llm = { generateJson: async () => { throw err; }, embed: async () => ({ vectors: [], usage: { tokenIn: 0 } }) };
        const r = runner.createRunner({ db, llm, logger: QUIET, sleep: async (ms) => { sleeps.push(ms); }, config: { renewIntervalMs: 60000 } });
        await r.runJobQuestion(jq.id);
        const upd = log.find(q => /UPDATE job_questions SET state = \$2/.test(q.text));
        const ev = log.find(q => /INSERT INTO job_events/.test(q.text));
        return { upd, ev, sleeps, detail: JSON.parse(ev.params[14]) };
    }

    test('本機（ollama）：needs_review(provider_error)、不退避；事件記 timeout＋timeout_no_retry；payload.verify.timed_out', async () => {
        const { upd, ev, sleeps, detail } = await runOnce('ollama:qwen3:8b');
        assert.deepEqual([upd.params[1], JSON.parse(upd.params[2]), upd.params[3]], ['needs_review', {}, 'provider_error']);
        assert.deepEqual(JSON.parse(upd.params[4]).verify, { timed_out: true });
        assert.deepEqual([ev.params[2], ev.params[12], ev.params[13]], ['verify', 'error', 'timeout']);
        assert.equal(detail.timeout_no_retry, true);
        assert.equal(detail.note, runner.LOCAL_TIMEOUT_NOTE);
        assert.deepEqual(sleeps, []);
    });

    test('Gemini：照舊重試（verify:error＋1、退避一次），事件 detail 只有原本的鍵', async () => {
        const { upd, sleeps, detail } = await runOnce('gemini:gemini-3.1-pro-preview');
        assert.deepEqual([upd.params[1], JSON.parse(upd.params[2]), upd.params[3]], ['source_checked', { 'verify:error': 1 }, null]);
        assert.equal(sleeps.length, 1);
        assert.deepEqual(Object.keys(detail).sort(), ['message', 'review_reason']);
    });
});

describe('services/llm：lint／verify 的本機預設單次逾時（localTuning.resolveTimeout）', () => {
    test('全域 OLLAMA_TIMEOUT_MS 沒寫（30 分）或更短：不換；比 30 分長（Owner 的 90 分）：lint、verify（含化學版）換成 30 分', () => {
        assert.equal(tuning.resolveTimeout('verify', {}), null);
        assert.equal(tuning.resolveTimeout('verify', { OLLAMA_TIMEOUT_MS: '600000' }), null);
        const env = { OLLAMA_TIMEOUT_MS: '5400000' };
        assert.deepEqual(tuning.resolveTimeout('verify', env), { timeoutMs: 1800000, name: 'OLLAMA_TIMEOUT_MS_VERIFY', source: 'default' });
        assert.deepEqual(tuning.resolveTimeout('lint_chem', env), { timeoutMs: 1800000, name: 'OLLAMA_TIMEOUT_MS_LINT', source: 'default' });
        for (const a of ['extract_ocr', 'classify', 'variant', 'kc_tag', undefined]) assert.equal(tuning.resolveTimeout(a, env), null, String(a));
    });

    test('OLLAMA_TIMEOUT_MS_<AGENT> 有寫就照寫的（可以比全域長）；亂填＝沒寫', () => {
        const env = { OLLAMA_TIMEOUT_MS: '5400000', OLLAMA_TIMEOUT_MS_VERIFY: '3600000', OLLAMA_TIMEOUT_MS_LINT: 'abc' };
        assert.deepEqual(tuning.resolveTimeout('verify', env), { timeoutMs: 3600000, name: 'OLLAMA_TIMEOUT_MS_VERIFY', source: 'env' });
        assert.deepEqual(tuning.resolveTimeout('verify_chem', env), { timeoutMs: 3600000, name: 'OLLAMA_TIMEOUT_MS_VERIFY', source: 'env' });
        assert.equal(tuning.resolveTimeout('lint', env).source, 'default');
        assert.equal(tuning.OVERRIDE_ENV_PATTERN.test('OLLAMA_TIMEOUT_MS_VERIFY'), true, '錄製子行程放行');
        assert.equal(tuning.OVERRIDE_ENV_PATTERN.test('OLLAMA_TIMEOUT_MS'), false, '全域的不在這一組');
    });

    test('啟動訊息：全域比 30 分長時列出本機預設；寫錯的後綴警告', () => {
        const { defaults, warnings, active } = tuning.checkOverrides({ OLLAMA_TIMEOUT_MS: '5400000', OLLAMA_TIMEOUT_MS_VERIFI: '60000', OLLAMA_TIMEOUT_MS_LINT: '600000' });
        assert.ok(defaults.some(l => /^單次逾時：verify、verify_chem 30 分鐘、逾時不重試（本機預設，Owner 2026-10-02；/.test(l)), defaults.join('\n'));
        assert.ok(!defaults.some(l => /單次逾時：.*lint/.test(l)), 'lint 有寫就不列在預設');
        assert.ok(active.includes('單次逾時：OLLAMA_TIMEOUT_MS_LINT=600000'), active.join('\n'));
        assert.ok(warnings.some(w => /OLLAMA_TIMEOUT_MS_VERIFI/.test(w)));
        assert.ok(!tuning.checkOverrides({}).defaults.some(l => /單次逾時/.test(l)), '沒寫全域（30 分）時不列：與預設相同');
    });

    test('經 services/llm 呼叫 Ollama：verify 帶 30 分的逾時，訊息寫 OLLAMA_TIMEOUT_MS_VERIFY；回放檔的鍵與 ollamaOverrides 不變', async () => {
        const ollama = require('../../services/llm/ollama');
        const throttle = require('../../services/llm/throttle');
        const KEYS = ['LLM_MODE', 'OLLAMA_TIMEOUT_MS', 'OLLAMA_TIMEOUT_MS_VERIFY', 'OLLAMA_MAX_OUTPUT_VERIFY'];
        const saved = {};
        for (const k of KEYS) saved[k] = process.env[k];
        try {
            for (const k of KEYS) delete process.env[k];
            process.env.LLM_MODE = 'live';
            process.env.OLLAMA_TIMEOUT_MS = '5400000';
            process.env.OLLAMA_TIMEOUT_MS_VERIFY = '30';   // 測試用：30 ms 就逾時
            ollama._resetForTest();
            throttle._resetForTest();
            ollama._setTransportForTest((url, payload, { signal }) => new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            }));
            const llm = require('../../services/llm');
            const { buildSchema } = require('../../agents/schemas');
            await assert.rejects(llm.generateJson({
                model: 'ollama:qwen3:8b', system: 's', parts: [{ text: 'x' }], schema: buildSchema('verify'),
                maxOutputTokens: 8192, thinkingBudget: 1024, agent: 'verify', template: 'verify.v1', cacheKeyParts: { sampleNo: 1 }
            }), (err) => err.errorClass === 'timeout' && /超過 OLLAMA_TIMEOUT_MS_VERIFY（30 ms）/.test(err.message));
        } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
            ollama._resetForTest();
            throttle._resetForTest();
        }
    });
});

describe('runner：答案是空的題不自動入庫；lint 的空答案不蓋掉解答頁回填的答案', () => {
    test('answerMissingStopReason／saveStopReason：交叉驗證的原因優先；答案空 → awaiting_approval', () => {
        const ex = { subject: '數學', question_text: 'q', question_type: '填空', answer_text: '' };
        assert.equal(runner.answerMissingStopReason({ extract: ex }), 'awaiting_approval');
        assert.equal(runner.answerMissingStopReason({ extract: { ...ex, answer_text: '$3$' } }), null);
        assert.deepEqual(runner.saveStopReason({ extract: { ...ex, extract_mode: 'ocr' } }), { reason: 'ocr_only', kind: 'cross_check' });
        assert.deepEqual(runner.saveStopReason({ extract: ex }), { reason: 'awaiting_approval', kind: 'no_answer' });
        assert.equal(runner.saveStopReason({ extract: { ...ex, answer_text: '(1)' }, lint: { answer_text: '(1)' } }), null);
        assert.equal(runner.answerMissingStopReason(null), null);
    });

    test('buildSaveFields：lint 的答案是空的、extract 後來有了（解答頁回填）→ 用 extract 的；其餘照舊 lint 優先', () => {
        const base = { extract: { subject: '數學', question_text: 'q', question_type: '單選', answer_text: '(3)', answer_src: 'answer_key' }, lint: { question_text: 'q', answer_text: '' } };
        assert.equal(runner.buildSaveFields(base).answer_text, '(3)');
        assert.equal(runner.buildSaveFields({ ...base, lint: { answer_text: '(4)' } }).answer_text, '(4)');
        assert.equal(runner.buildSaveFields({ extract: { answer_text: '' }, lint: { answer_text: '' } }).answer_text, '');
        assert.equal(runner.buildSaveFields({ extract: { answer_text: '$1$' } }).answer_text, '$1$');
    });

    test('answerKeyDetail／collectAnswerKeyEntries（純函式）', () => {
        assert.deepEqual(runner.answerKeyDetail({ questions: [] }), {});
        const ak = { pages: [5], skipped: [{ position: 1, reason: 'key_chunk' }, { position: 2, reason: 'key_chunk' }], entries: [{ label: '1', value: '3', certain: true }] };
        assert.deepEqual(runner.answerKeyDetail({ answer_key: ak, latex_repaired: 2 }), { answer_key: ak, skipped_answer_key: { pages: [5], count: 2 }, latex_repaired: 2 });
        const rows = [
            { chunk: 3, answer_key: { entries: [{ label: 'A' }] } },
            { chunk: 1, answer_key: { entries: [{ label: '1' }] } },
            { chunk: 3, answer_key: { entries: [{ label: 'A' }, { label: 'B' }] } },   // 同一塊重拆：取最後一筆
            { chunk: 2, answer_key: { pages: [], entries: [] } }
        ];
        assert.deepEqual(runner.collectAnswerKeyEntries(rows).map(e => e.label), ['1', 'A', 'B']);
    });
});

describe('agents/extract.js 本機路徑（ocr 模式，假 OCR 與假模型）：這份卷的三塊', () => {
    const ORIGINAL_PARSE = models.parseModel;
    let pdf;
    before(async () => {
        models.parseModel = (spec) => {
            const raw = String(spec ?? '').trim();
            if (raw.toLowerCase().startsWith('ollama:')) { const id = raw.slice(7).trim(); return { vendor: 'ollama', id, spec: `ollama:${id}` }; }
            return ORIGINAL_PARSE(spec);
        };
        const doc = await PDFDocument.create();
        for (let i = 0; i < 5; i++) doc.addPage([200, 200]);
        pdf = Buffer.from(await doc.save());
    });
    after(() => { models.parseModel = ORIGINAL_PARSE; extract._setLocalDepsForTest({}); });
    afterEach(() => extract._setLocalDepsForTest({}));

    const PAGES = { 1: Q_PAGE_1, 2: `${HEADER}\n\nA. 設矩陣…`, 3: `${HEADER}\n\nB. …`, 4: Q_PAGE_4, 5: KEY_PAGE };
    function useOcr() {
        extract._setLocalDepsForTest({
            ocrPdf: async ({ fromPage, toPage }) => {
                const pages = [];
                for (let p = fromPage; p <= toPage; p++) pages.push({ page: p, markdown: PAGES[p], imagePath: null, figures: [] });
                return { engine: 'paddleocr', engineVersion: '3.7.0', dpi: 200, pages, replayed: false, dispose() { } };
            },
            renderPages: async () => { throw new Error('不該轉圖'); },
            llmMode: () => 'live', ocrConfig: () => ({ engine: 'paddle', dpi: 200 }),
            numCtx: () => 16384, ollamaOverrides: () => ({ applied: {} }), localExtractMode: () => 'ocr'
        });
    }
    const Q = (question_type, question_text, answer_text) => ({
        subject: '數學', chapter: '矩陣的應用', chapter_confidence: 0.8, question_type, difficulty: 3, question_text, answer_text
    });
    function ctx(questions) {
        const calls = [];
        return {
            calls,
            ctx: {
                llm: { generateJson: async (opts) => { calls.push(opts); return { data: { questions }, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 }, latencyMs: 1 }; } },
                db: null, job: { id: 1, kind: 'pdf', budget_usd: 1, cost_usd: 0 }, jq: null, logger: QUIET,
                config: { models: { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b', ocrStructure: 'ollama:qwen3:8b' }, thresholds: { pdfChunkPages: 2 }, localExtract: { mode: 'ocr' } }
            }
        };
    }

    test('第 1 塊（第 1～2 頁）：模型編的答案清掉（answer_dropped）、LaTeX 修好（latex_repairs）；送出的是 extract_ocr.v3 與本機版 schema', async () => {
        useOcr();
        const { ctx: c, calls } = ctx([
            Q('單選', '1. 設 $^{a,b}$ 為實數，若 $\\left\\{ \\begin{cases} ax+y=1 \\\\ x+by=2 \\right.$ 無解，則下列何者正確？(1) $a=1$ (2) $b=1$', '(4)'),
            Q('填空', 'A. 設 $A=\\begin{bmatrix} 1 & 2 \\ 3 & 4\nend{bmatrix}$，則 $\\det A=\\textcircled{m}\\textcircled{q}$', '⑨⑩')
        ]);
        const o = await extract.run(c, { pdfBytes: pdf, chunk: { no: 1, fromPage: 1, toPage: 2 } });
        assert.equal(o.kind, 'pass', JSON.stringify(o));
        assert.equal(calls[0].template, 'extract_ocr.v3');
        assert.equal(calls[0].schema, extract.localExtractSchema('math_physics'));
        assert.match(calls[0].schema.properties.questions.items.properties.answer_text.description, /沒有寫答案時填空字串/);
        assert.match(calls[0].parts[0].text, /answer_text 一律填空字串 ""/);
        assert.match(calls[0].parts[0].text, /\\end\{cases\} 收尾/);
        const [q1, qa] = o.data.questions;
        assert.deepEqual([q1.answer_text, qa.answer_text], ['', '']);
        assert.deepEqual(q1.answer_dropped, { reason: 'not_on_page', text: '(4)' });
        assert.equal(q1.question_text, '1. 設 $a,b$ 為實數，若 $\\begin{cases} ax+y=1 \\\\ x+by=2 \\end{cases}$ 無解，則下列何者正確？(1) $a=1$ (2) $b=1$');
        assert.deepEqual(q1.latex_repairs.map(r => r.rule).sort(), ['cases_right', 'leading_superscript']);
        assert.equal(qa.question_text, `A. 設 $A=\\begin{bmatrix} 1 & 2 \\\\ 3 & 4\\end{bmatrix}$，則 $\\det A=${BLANK}$`);
        assert.equal(o.data.latex_repaired, 2);
        assert.equal(o.data.answer_key.answers_dropped, 2);
        assert.deepEqual(o.data.answer_key.pages, []);
    });

    test('第 3 塊（第 5 頁＝解答頁）：8 題垃圾一題都不建、不算退件；answer_key 記頁碼與 16 個題號（1～8 確定）', async () => {
        useOcr();
        const garbage = Array.from({ length: 8 }, (_, i) => Q('填空', `${HEADER} 解答 ${KEY_ROWS.join(' ')}`, String(i)));
        const { ctx: c } = ctx(garbage);
        const o = await extract.run(c, { pdfBytes: pdf, chunk: { no: 3, fromPage: 5, toPage: 5 } });
        assert.equal(o.kind, 'pass', '空塊不是失敗');
        assert.deepEqual(o.data.questions, []);
        assert.deepEqual(o.data.rejected, []);
        assert.deepEqual(o.data.answer_key.pages, [5]);
        assert.equal(o.data.answer_key.skipped.length, 8);
        assert.deepEqual(o.data.answer_key.entries.filter(e => e.certain).map(e => `${e.label}=${e.value}`),
            ['1=1', '2=3', '3=4', '4=5', '5=2', '6=12', '7=245', '8=145']);
        assert.deepEqual(runner.answerKeyDetail(o.data).skipped_answer_key, { pages: [5], count: 8 });
    });
});

describe('複核頁（public/js/review.js）：建議答案預填、答案來源說明、逾時的說明句', () => {
    const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'js', 'review.js'), 'utf8');
    let cached = null;
    const load = () => (cached = cached || import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE)));

    test('payloadToQuestion：拆題沒有答案時預填驗算的建議答案；有答案（含解答頁回填）時照舊', async () => {
        const { payloadToQuestion, answerSourceNote } = await load();
        const p = { extract: { question_text: 'q', answer_text: '', extract_mode: 'ocr' }, lint: { question_text: 'q', answer_text: '' }, verify: { compare: 'no_claim', final_answer: '84°', suggested_answer: '84°' } };
        assert.equal(payloadToQuestion(p).answer_text, '84°');
        assert.match(answerSourceNote(p), /驗算模型算的建議答案「84°」，請核對後再核准/);
        const keyed = { extract: { question_text: 'q', answer_text: '(3)', answer_src: 'answer_key' }, lint: { answer_text: '' }, verify: { compare: 'no_claim', final_answer: '14' } };
        assert.equal(payloadToQuestion(keyed).answer_text, '(3)');
        assert.equal(answerSourceNote(keyed), '答案取自這份卷的解答頁。');
        assert.equal(answerSourceNote({ extract: { answer_text: '', answer_dropped: { reason: 'not_on_page' } } }), '原卷這一題沒有寫答案，請補上答案再核准。');
        assert.equal(answerSourceNote({ extract: { answer_text: '$1$' }, verify: { compare: 'agree' } }), '');
    });

    test('provider_error：本機逾時不重試的說明（哪一步、可調的變數）；其他情況照舊', async () => {
        const { reasonSentence } = await load();
        assert.match(reasonSentence('provider_error', { verify: { timed_out: true } }), /驗算這一步逾時，依設定不重試.*OLLAMA_TIMEOUT_MS_VERIFY/);
        assert.match(reasonSentence('provider_error', { lint: { timed_out: true } }), /公式檢查這一步逾時.*OLLAMA_TIMEOUT_MS_LINT/);
        assert.match(reasonSentence('provider_error', {}), /^供應商連續錯誤/);
    });
});

describe('eval pipeline：no_claim 的題改拿答案卷的標準答案（answer_text）跟驗算比（suitePipeline.noClaimCompares）', () => {
    const { noClaimCompares } = require('../../eval/lib/suitePipeline');
    test('配得到答案卷 → 照 answerCompare 比；配不到 → uncertain；不是 no_claim 的列不在結果裡', () => {
        const sheet = { doc: { questions: [
            { question_text: '$\\log_{2} 8 + \\log_{2} 4$ 之值為何？(A) $5$ (B) $6$', question_type: '單選', final_answer: '(A)' },
            // 答案卷的 final_answer 是裸的「5」（沒有 $ 也沒有等號，比對器抽不到）：要用 answer_text 才比得出來
            { question_text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', question_type: '計算', answer_text: '$a = \\frac{10}{2} = 5$ m/s$^2$', final_answer: '5' }
        ] } };
        const row = (question_text, final_answer, compare = 'no_claim', question_type = '單選') => ({
            payload: { extract: { question_text, question_type }, verify: { compare, final_answer, answer_form: question_type === '單選' ? 'option' : 'number' } }
        });
        const a = row('$\\log_{2} 8 + \\log_{2} 4$ 之值為何？(A) $5$ (B) $6$', '(A)');
        const b = row('質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', '6', 'no_claim', '計算');
        const c = row('完全不同的一題，答案卷上沒有', '(B)');
        const d = row('x', '(A)', 'agree');
        const m = noClaimCompares([a, b, c, d], sheet);
        assert.deepEqual([m.get(a), m.get(b), m.get(c), m.has(d)], ['agree', 'disagree', 'uncertain', false]);
    });
});

describe('docs/local-mode.md 10.25 有寫、指到的程式存在', () => {
    test('節名、重錄步驟與 cassette 影響', () => {
        const doc = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'local-mode.md'), 'utf8');
        const start = doc.indexOf('### 10.25 ');
        assert.ok(start > 0, '有 10.25');
        const sec = doc.slice(start);
        for (const s of ['extract_ocr.v3', 'extract_vision.v3', 'record_local.bat pipeline,e2e --only-missing', 'OLLAMA_TIMEOUT_MS_VERIFY', 'no_claim', 'answer_key']) {
            assert.ok(sec.includes(s), `10.25 沒寫到 ${s}`);
        }
    });
});
