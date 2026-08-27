// textFormatter 單元測試
//
// 為什麼特別測這支：它是專案唯一手寫的解析器（LaTeX → Word OOXML），
// 輸入來自 AI 的自由輸出而不可控，且解析失敗時會「靜默降級」成純文字而不丟例外
// （見 textFormatter.js 的 try/catch fallback）——沒有測試就完全看不見退化。
//
// 執行：npm test   （Node 18+ 內建測試執行器，無額外相依）

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildParagraphComponents,
    parseLatexToMath,
    xmlSafeClean,
} = require('../../utils/textFormatter');

// ───────────────────────── 測試輔助 ─────────────────────────

/** 取出每個元件對應的 OOXML 元素名（m:f = 分數、m:sSup = 上標…） */
const kinds = (nodes) => nodes.map((n) => n.rootKey);

/** 遞迴走訪 docx 物件樹，收集所有文字節點 */
function textOf(node, out = []) {
    if (node == null) return out;
    if (typeof node === 'string') { out.push(node); return out; }
    if (Array.isArray(node)) { node.forEach((c) => textOf(c, out)); return out; }
    if (typeof node === 'object' && node.root !== undefined) textOf(node.root, out);
    return out;
}

/** 把整串元件攤平成一個字串，方便斷言「內容有沒有掉」 */
const flatText = (nodes) => nodes.map((n) => textOf(n).join('')).join('');

// ═════════════════════ 1. 結構對應 ═════════════════════
// 契約：每種 LaTeX 語法必須產生正確的 Word 數學元素。
// 這是「公式在 Word 裡長對」的根本前提——分數若退化成 m:r，
// 印出來就會是 1/2 而不是直式分數。

describe('parseLatexToMath — LaTeX 語法對應到正確的 OOXML 元素', () => {
    test('分數 \\frac 產生 m:f（直式分數，而非斜線）', () => {
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\frac{1}{2}`)), ['m:f']);
    });

    test('\\dfrac 與 \\tfrac 同樣產生分數', () => {
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\dfrac{a}{b}`)), ['m:f']);
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\tfrac{a}{b}`)), ['m:f']);
    });

    test('上標 x^2 產生 m:sSup', () => {
        assert.deepEqual(kinds(parseLatexToMath('x^2')), ['m:sSup']);
    });

    test('下標 a_n 產生 m:sSub', () => {
        assert.deepEqual(kinds(parseLatexToMath('a_n')), ['m:sSub']);
    });

    test('上下標並存產生 m:sSubSup（且與書寫順序無關）', () => {
        assert.deepEqual(kinds(parseLatexToMath('x_1^2')), ['m:sSubSup']);
        assert.deepEqual(kinds(parseLatexToMath('x^2_1')), ['m:sSubSup']);
    });

    test('根號 \\sqrt 產生 m:rad，含次方根 \\sqrt[3]{8} 亦同', () => {
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\sqrt{2}`)), ['m:rad']);
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\sqrt[3]{8}`)), ['m:rad']);
    });

    test('級數 \\sum 與積分 \\int 產生 m:nary', () => {
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\sum_{n=1}^{5} n`)), ['m:nary']);
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\int_0^1 x`)), ['m:nary']);
    });

    test('極限 \\lim_{x \\to 0} 產生 m:limLow', () => {
        const k = kinds(parseLatexToMath(String.raw`\lim_{x \to 0} x`));
        assert.equal(k[0], 'm:limLow');
    });

    test('巢狀分數 \\frac{\\frac{1}{2}}{3} 仍是單一分數', () => {
        assert.deepEqual(kinds(parseLatexToMath(String.raw`\frac{\frac{1}{2}}{3}`)), ['m:f']);
    });
});

// ═════════════════════ 2. 符號轉換 ═════════════════════
// 契約：LaTeX 指令要轉成對應的 Unicode 字元。
// 若漏轉，Word 裡會直接印出「\theta」這種原始指令。

describe('parseLatexToMath — 指令轉為 Unicode 字元', () => {
    test('希臘字母（含大寫）', () => {
        assert.equal(flatText(parseLatexToMath(String.raw`\theta`)), 'θ');
        assert.equal(flatText(parseLatexToMath(String.raw`\pi`)), 'π');
        assert.equal(flatText(parseLatexToMath(String.raw`\Omega`)), 'Ω');
    });

    test('運算與關係符號', () => {
        assert.equal(flatText(parseLatexToMath(String.raw`\times`)), '×');
        assert.equal(flatText(parseLatexToMath(String.raw`\leq`)), '≤');
        assert.equal(flatText(parseLatexToMath(String.raw`\neq`)), '≠');
        assert.equal(flatText(parseLatexToMath(String.raw`\infty`)), '∞');
    });

    test('函數名保持原樣（sin 不該被當成 s·i·n 三個變數）', () => {
        assert.equal(flatText(parseLatexToMath(String.raw`\sin`)), 'sin');
        assert.equal(flatText(parseLatexToMath(String.raw`\log`)), 'log');
    });

    test('重音符號 \\vec{v} 附加組合字元', () => {
        const t = flatText(parseLatexToMath(String.raw`\vec{v}`));
        assert.ok(t.startsWith('v'), `應以 v 開頭，實際為 ${JSON.stringify(t)}`);
        assert.ok(t.length > 1, '應附加組合用的向量符號');
    });
});

// ═════════════════════ 3. 中英混排 ═════════════════════
// 契約：中文敘述與公式必須切開——中文進 TextRun(w:r)、公式進 Math(m:oMath)。
// 這是本專案最容易出錯的地方：中文若被吞進公式，Word 會用數學斜體排中文。

describe('buildParagraphComponents — 中文與公式正確分離', () => {
    test('$...$ 行內公式：中文留在文字、公式獨立成 Math', () => {
        const c = buildParagraphComponents('圓 $x^2$ 半徑');
        assert.deepEqual(kinds(c), ['w:r', 'm:oMath', 'w:r']);
        assert.equal(textOf(c[0]).join(''), '圓 ');
        assert.equal(textOf(c[2]).join(''), ' 半徑');
    });

    test('中文不會被吞進公式（公式元件內不含中日韓字元）', () => {
        const c = buildParagraphComponents('設半徑為 $r$ 則面積為 $\\pi r^2$ 平方公分');
        const mathText = c.filter((n) => n.rootKey === 'm:oMath').map((n) => textOf(n).join('')).join('');
        assert.ok(!/[一-鿿]/.test(mathText), `公式內不應有中文，實際為 ${JSON.stringify(mathText)}`);
    });

    test('$$...$$ 展示公式', () => {
        const c = buildParagraphComponents('推導：$$E=mc^2$$');
        assert.ok(kinds(c).includes('m:oMath'));
    });

    test('\\( \\) 與 \\[ \\] 分隔符同樣支援', () => {
        assert.ok(kinds(buildParagraphComponents(String.raw`值為 \(x^2\) 單位`)).includes('m:oMath'));
        assert.ok(kinds(buildParagraphComponents(String.raw`值為 \[x^2\] 單位`)).includes('m:oMath'));
    });

    test('未包在 $ 內的裸露上標仍會轉成公式', () => {
        // AI 偶爾會漏掉錢號，這條路徑走的是 renderMixedInto 而非分隔符比對
        const c = buildParagraphComponents('面積 x^2 平方');
        assert.ok(kinds(c).includes('m:oMath'), '裸露的 x^2 應被辨識為公式');
    });

    test('換行會產生斷行元件，且行數正確', () => {
        const c = buildParagraphComponents('第一行\n第二行');
        assert.equal(c.filter((n) => n.rootKey === 'w:r').length, 3); // 兩行文字 + 一個 break
        assert.ok(flatText(c).includes('第一行'));
        assert.ok(flatText(c).includes('第二行'));
    });

    test('純中文題目不產生任何公式元件', () => {
        const c = buildParagraphComponents('下列敘述何者正確？請說明理由。');
        assert.deepEqual(kinds(c), ['w:r']);
    });

    test('空輸入回傳空陣列', () => {
        assert.deepEqual(buildParagraphComponents(''), []);
        assert.deepEqual(buildParagraphComponents(null), []);
        assert.deepEqual(buildParagraphComponents(undefined), []);
    });
});

// ═════════════════════ 4. 不可信輸入的健壯性 ═════════════════════
// 契約：AI 的輸出格式不受控，任何畸形輸入都不能讓匯出流程整個炸掉。
// 這組測試守的是「Word 匯出不會中斷」這條底線。

describe('健壯性 — 畸形輸入不得拋出例外', () => {
    test('未知指令降級為純文字而非崩潰', () => {
        const t = flatText(parseLatexToMath(String.raw`\foobar`));
        assert.equal(t, 'foobar', '未知指令應去掉反斜線輸出名稱');
    });

    test('不成對的錢號不會拋出例外', () => {
        assert.doesNotThrow(() => buildParagraphComponents('公式 $x^2 沒有收尾'));
        const c = buildParagraphComponents('公式 $x^2 沒有收尾');
        assert.ok(flatText(c).includes('沒有收尾'), '內容不應遺失');
    });

    test('未閉合的大括號不會拋出例外', () => {
        assert.doesNotThrow(() => parseLatexToMath(String.raw`\frac{1}{2`));
        assert.doesNotThrow(() => buildParagraphComponents(String.raw`$\sqrt{2$`));
    });

    test('空的分數參數不會拋出例外', () => {
        assert.doesNotThrow(() => parseLatexToMath(String.raw`\frac{}{}`));
    });

    test('emoji 與控制字元會被移除', () => {
        const c = buildParagraphComponents('題目😀內容結尾');
        const t = flatText(c);
        assert.ok(!/😀/u.test(t), 'emoji 應被移除');
        assert.ok(!/[ -]/.test(t), '控制字元應被移除');
        assert.ok(t.includes('題目') && t.includes('結尾'), '正常文字應保留');
    });

    test('真實題目格式（含選項）可完整處理', () => {
        // 取自 seed_questions.js 的實際格式
        const raw = '不等式 $|2x - 3| < 5$ 的解為下列何者？\n(A) $-1 < x < 4$　(B) $x < -1$ 或 $x > 4$';
        assert.doesNotThrow(() => buildParagraphComponents(raw));
        const c = buildParagraphComponents(raw);
        assert.ok(kinds(c).includes('m:oMath'), '應辨識出公式');
        assert.ok(flatText(c).includes('不等式'), '中文敘述應保留');
        assert.ok(flatText(c).includes('(A)'), '選項代號應保留');
    });
});

// ═════════════════════ 5. xmlSafeClean ═════════════════════

describe('xmlSafeClean — 舊版相容的清理函式', () => {
    test('null 與 undefined 回傳空字串（不得拋出例外）', () => {
        assert.equal(xmlSafeClean(null), '');
        assert.equal(xmlSafeClean(undefined), '');
    });

    test('移除控制字元但保留數學語法', () => {
        assert.equal(xmlSafeClean('ab'), 'ab');
        assert.equal(xmlSafeClean(String.raw`$\frac{1}{2}$`), String.raw`$\frac{1}{2}$`);
    });
});

// ═════════════════════ 6. 矩陣類環境（2026-08-27，job #5 修正） ═════════════════════
// docx 沒有原生矩陣元件，MATRIX_ENVS 以線性形式（欄空白、列分號）呈現；
// 契約是「內容一字不失、lint 不再判 error」，不是二維排版（那個在 roadmap §6.5 擱置區）。

describe('矩陣類環境 — 線性呈現', () => {
    test('begin{bmatrix} 產生方括號線性形式，內容與列分隔符都在', () => {
        const c = parseLatexToMath(String.raw`\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}`);
        const t = flatText(c);
        assert.ok(t.startsWith('[') && t.endsWith(']'), t);
        for (const piece of ['1', '2', '3', '4', ';']) assert.ok(t.includes(piece), `缺 ${piece}：${t}`);
    });

    test('pmatrix 用圓括號、cases 用左大括號、matrix 不帶括號', () => {
        assert.ok(flatText(parseLatexToMath(String.raw`\begin{pmatrix} a \\ b \end{pmatrix}`)).startsWith('('));
        assert.ok(flatText(parseLatexToMath(String.raw`\begin{cases} x = 1 \\ y = 2 \end{cases}`)).startsWith('{'));
        assert.ok(!/^[[({]/.test(flatText(parseLatexToMath(String.raw`\begin{matrix} a & b \end{matrix}`))));
    });

    test('舊式 plain TeX matrix{…}（含 cr 列分隔）同樣支援——考卷數位化常見', () => {
        const t = flatText(parseLatexToMath(String.raw`\matrix{1 & 0 \cr 0 & 2}`));
        assert.ok(t.includes(';') && t.includes('1') && t.includes('2'), t);
    });

    test('儲存格內容走完整解析（frac 仍是 m:f 直式分數）', () => {
        const c = parseLatexToMath(String.raw`\begin{pmatrix} \frac{1}{2} & 0 \\ 0 & 1 \end{pmatrix}`);
        function collect(node, out = []) {
            if (node == null || typeof node !== 'object') return out;
            if (Array.isArray(node)) { node.forEach(n => collect(n, out)); return out; }
            if (typeof node.rootKey === 'string') out.push(node.rootKey);
            if (node.root !== undefined) collect(node.root, out);
            return out;
        }
        assert.ok(collect(c).includes('m:f'), JSON.stringify(collect(c)));
    });

    test('群組裡的 & 不會被當成欄分隔符', () => {
        const t = flatText(parseLatexToMath(String.raw`\begin{matrix} {a & b} & c \end{matrix}`));
        assert.ok(t.includes('a & b'), t);
    });

    test('同名巢狀環境正確配對 end', () => {
        const c = parseLatexToMath(String.raw`\begin{bmatrix} \begin{bmatrix} 1 \end{bmatrix} \end{bmatrix}`);
        assert.doesNotThrow(() => JSON.stringify(c));
        assert.ok(flatText(c).includes('1'));
    });
});
