// utils/embedText.js — 產生送去 embedding 的可重現文本（docs/interfaces-stage1.md 第 3 條）
//
// 純函式：無 I/O、無隨機、無時間。同一題永遠得到同一段文字，因此
// embed_hash = sha256(buildEmbedText(q)) 才能當作「該不該重算向量」的唯一依據。
//
// ⚠️ 規則一改，全部向量作廢：必須同時重產 eval/fixtures/embeddings.*.json 並在 PR 說明。
//
// 輸出格式（規劃 §2.3.6，以換行連接、尾端不留空行）：
//   行 1  ${subject}｜${chapter}｜${question_type}｜難度${difficulty}
//   行 2  latexToPlain(question_text)
//   行 3  concept_summary            （沒有就整行不輸出）
//   行 4  keywords.join(' ')         （沒有就整行不輸出）

const { GREEK, SYMBOLS, FUNCTIONS, ACCENTS } = require('./textFormatter');

// ───────────────────────── LaTeX → 口語純文字 ─────────────────────────
//
// 對照表直接重用 textFormatter.js（那支是 Word 匯出的解析器，兩邊共用同一份
// 希臘字母／符號／函數表，才不會出現「Word 看到 θ、embedding 看到 theta」）。

/** 讀出 s[i] 起的一個引數：`{...}`（可巢狀、未閉合就吃到結尾）或單一字元 */
function readGroup(s, i) {
    if (i >= s.length) return { content: '', next: i };
    if (s[i] !== '{') return { content: s[i], next: i + 1 };
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
            depth--;
            if (depth === 0) return { content: s.slice(i + 1, j), next: j + 1 };
        }
    }
    return { content: s.slice(i + 1), next: s.length };   // 未閉合的 `{`：吃到底，不丟例外
}

/** 分數／根號的引數要不要加括號：只有「不是單純的字母數字」才加，避免 (16)/3 這種噪音 */
function wrap(str) {
    return /[^\p{L}\p{N}.]/u.test(str) ? `(${str})` : str;
}

/** 把一段數學（$...$ 內）轉成純文字 */
function convertMath(src) {
    let out = '';
    let i = 0;
    const s = String(src);

    while (i < s.length) {
        const c = s[i];

        if (c === '\\') {
            const m = /^\\([a-zA-Z]+)/.exec(s.slice(i));
            if (!m) {
                // \\ 換行、\, \; \! \  等間距指令 → 空白；其餘跳過反斜線本身
                const next = s[i + 1];
                if (next === '\\' || next === ',' || next === ';' || next === ':' || next === '!' || next === ' ') {
                    out += ' ';
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            const cmd = m[1];
            i += m[0].length;
            while (s[i] === ' ') i += 1;              // LaTeX 語意：指令名後面的空白只是分隔符

            if (cmd === 'quad' || cmd === 'qquad' || cmd === 'thinspace' || cmd === 'enspace') {
                out += ' ';
                continue;
            }
            if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
                const a = readGroup(s, i); i = a.next;
                const b = readGroup(s, i); i = b.next;
                out += `${wrap(convertMath(a.content))}/${wrap(convertMath(b.content))}`;
                continue;
            }
            if (cmd === 'sqrt') {
                // \sqrt[3]{x} 的次數當作前綴：3√x
                let index = '';
                if (s[i] === '[') {
                    const close = s.indexOf(']', i);
                    if (close !== -1) { index = convertMath(s.slice(i + 1, close)); i = close + 1; }
                }
                const a = readGroup(s, i); i = a.next;
                out += `${index}√${wrap(convertMath(a.content))}`;
                continue;
            }
            if (ACCENTS[cmd]) {                       // \vec{a} → a（結合字元對 embedding 只是噪音）
                const a = readGroup(s, i); i = a.next;
                out += convertMath(a.content);
                continue;
            }
            if (cmd === 'text' || cmd === 'mathrm' || cmd === 'mathbf' || cmd === 'mathit' || cmd === 'operatorname') {
                const a = readGroup(s, i); i = a.next;
                out += convertMath(a.content);
                continue;
            }
            if (cmd === 'left' || cmd === 'right') continue;   // 只是括號大小，捨棄
            if (GREEK[cmd]) { out += GREEK[cmd]; continue; }
            if (SYMBOLS[cmd]) { out += SYMBOLS[cmd]; continue; }
            if (FUNCTIONS.has(cmd)) { out += cmd; continue; }  // \sin → sin
            out += cmd;                                        // 未知指令：保留名稱，不留反斜線
            continue;
        }

        // 去掉 {}、^、_（規劃 §2.3.6），保留其後的數字與字母：x^2 → x2、a_{n+1} → an+1
        if (c === '{' || c === '}' || c === '^' || c === '_') { i += 1; continue; }
        if (c === '&') { out += ' '; i += 1; continue; }        // 對齊符號
        out += c;
        i += 1;
    }

    return out;
}

/**
 * 把含 $...$ 行內數學的題幹轉成純文字。
 * $ 之外的中文敘述、「[附圖描述：…]」與選項代號 (A)(B) 原樣保留。
 */
function latexToPlain(text) {
    if (text === null || text === undefined) return '';
    const s = String(text);
    let out = '';
    let i = 0;

    while (i < s.length) {
        if (s[i] === '$') {
            // 支援 $$...$$ 與 $...$；找不到收尾的 $ 就把剩下的當一般文字（不丟例外）
            const isDouble = s[i + 1] === '$';
            const open = isDouble ? 2 : 1;
            const close = s.indexOf(isDouble ? '$$' : '$', i + open);
            if (close === -1) {
                out += s.slice(i + open);
                break;
            }
            out += convertMath(s.slice(i + open, close));
            i = close + open;
            continue;
        }
        out += s[i];
        i += 1;
    }

    // 只壓縮空白，不動任何文字內容；換行一律變空白（embed_text 每題一行才對得上格式）
    return out.replace(/\s+/g, ' ').trim();
}

// ───────────────────────── 主函式 ─────────────────────────

/**
 * 產生送去 embedding 的可重現文本（純函式，無 I/O、無隨機、無時間）。
 * @param {{subject:string, chapter:string, question_type:string, difficulty:number,
 *          question_text:string, concept_summary?:string, keywords?:string[]}} q
 * @returns {string}
 */
function buildEmbedText(q) {
    const src = q || {};
    const val = (v) => (v === null || v === undefined ? '' : String(v));

    const lines = [
        `${val(src.subject)}｜${val(src.chapter)}｜${val(src.question_type)}｜難度${val(src.difficulty)}`,
        latexToPlain(src.question_text),   // 缺 question_text 時輸出空字串，不拋例外
    ];

    const summary = val(src.concept_summary).trim();
    if (summary) lines.push(summary);

    if (Array.isArray(src.keywords)) {
        const kw = src.keywords.map(k => val(k).trim()).filter(Boolean).join(' ');
        if (kw) lines.push(kw);
    }

    return lines.join('\n');   // 尾端不留空行
}

module.exports = { buildEmbedText };
