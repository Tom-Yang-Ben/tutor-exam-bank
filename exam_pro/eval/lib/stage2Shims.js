// ─────────────────────────────────────────────────────────────
// eval/lib/stage2Shims.js — 轉接階段 2 的四支凍結介面（WS-B／WS-C 的產出）
//
// WS-D 的 eval 骨架要在 B/C 合入**之前**就能跑（分工總表：「B/C 合入前先對 interfaces
// 的 outcome 形狀寫，用 stub」）。這一檔集中處理「有真的就用真的、沒有就用標示清楚的暫用實作」，
// 沿用階段 1 eval/lib/tokenize.js 與 embedText.js 已經證明可行的做法。
//
// 轉接四支：
//   utils/normalizeStem.js   → normalizeStem / textHash   （WS-C，A-T5）
//   utils/answerCompare.js   → answerCompare              （WS-C，A-T5）
//   utils/textFormatter.js   → parseLatexStrict           （WS-C，A-T4）
//   config/pricing.js        → estimateCost               （WS-B，A-T3）
//
// 三條規矩，每一條都是為了不留下「看起來有數字、其實是假的」的痕跡：
//   1. 每一支都回報 source（'real' 或 'stub'），報表的 meta 一定要記。
//   2. stub 狀態下**不得**寫 thresholds 初值（見 thresholds.js 的 guard，本檔提供判斷用的
//      anyStub()）——基準線一定會被真實作推翻，CI 會紅得莫名其妙。
//   3. 沒有 stub 可寫的（parseLatexStrict 的事件語意、pricing 的實際單價）一律回
//      **n/a 而不是 0**：0 看起來像「量到了而且很好」，n/a 看起來像「沒量到」。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

/** @param {string} rel @returns {object|null} */
function tryRequire(rel) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) return null;
    try {
        return require(abs);
    } catch (err) {
        // 檔案存在但載不進來是真的壞掉，不該被當成「還沒合入」而靜靜退回 stub。
        throw new Error(`${rel} 存在但無法載入：${err.message}`);
    }
}

// ───────────────────── normalizeStem / textHash ─────────────────────

// 暫用實作＝ scripts/backfill_text_hash.js 裡那一份（S0 對介面第 4.1 條的逐條落地）。
// 兩邊必須產出逐位元相同的雜湊，所以規則一字不改地抄過來；
// WS-C 的 utils/normalizeStem.js 合入後這段就不再被執行。
const FIGURE_DESC_RE = /\[附圖描述[：:][\s\S]*?\]/g;
const BRACKET_OPTION_RE = /[（(［[【]\s*([A-Ha-h])\s*[）)］\]】]/g;
const BARE_OPTION_RE = /(^|[\s\n])([A-Ha-h])[.、．:：]/gm;

function stubNormalizeStem(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    let s = text;
    s = s.replace(FIGURE_DESC_RE, '');                                              // 2
    s = s.normalize('NFKC');                                                        // 3
    s = s.replace(BRACKET_OPTION_RE, (m, ch) => `(${ch.toUpperCase()})`);           // 4a
    s = s.replace(BARE_OPTION_RE, (m, pre, ch) => `${pre}(${ch.toUpperCase()})`);   // 4b
    s = s.replace(/\$/g, '');                                                       // 5
    s = s.replace(/\s+/g, '');                                                      // 6
    return s.toLowerCase();                                                         // 7
}

function stubTextHash(text) {
    const norm = stubNormalizeStem(text);
    if (norm === '') return null;
    return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

let _stem = null;
function stemImpl() {
    if (_stem) return _stem;
    const real = tryRequire('utils/normalizeStem.js');
    _stem = real && typeof real.normalizeStem === 'function'
        ? { source: 'utils/normalizeStem.js', normalizeStem: real.normalizeStem, textHash: real.textHash }
        : { source: 'eval/lib/stage2Shims.js（暫用）', normalizeStem: stubNormalizeStem, textHash: stubTextHash };
    return _stem;
}

/** @param {string} text @returns {string} */
function normalizeStem(text) { return stemImpl().normalizeStem(text); }
/** @param {string} text @returns {string|null} */
function textHash(text) { return stemImpl().textHash(text); }
/** @returns {string} */
function normalizeStemSource() { return stemImpl().source; }

// ───────────────────── answerCompare ─────────────────────

let _cmp = null;
function cmpImpl() {
    if (_cmp) return _cmp;
    const real = tryRequire('utils/answerCompare.js');
    _cmp = real && typeof real.answerCompare === 'function'
        ? { source: 'utils/answerCompare.js', fn: real.answerCompare }
        : { source: null, fn: null };
    return _cmp;
}

/**
 * @param {object} opts {question_type, claimed, model:{final_answer, answer_form}}
 * @returns {'agree'|'disagree'|'uncertain'|null} 尚未合入 utils/answerCompare.js 時回 **null**（不是 uncertain）
 *
 * 為什麼不寫 stub：answerCompare 的整個價值就在那幾條正規化規則（有理數容差、\frac、
 * 單位後綴、選項代號集合）。寫一個「差不多」的暫用版，量出來的 answer_agree_rate 會是
 * 一個**看起來合理但沒有意義**的數字，而且很可能被抄進 README。回 null 讓報表印 n/a。
 */
function answerCompare(opts) {
    const impl = cmpImpl();
    return impl.fn ? impl.fn(opts) : null;
}
/** @returns {boolean} */
function answerCompareReady() { return cmpImpl().fn !== null; }
/** @returns {string} */
function answerCompareSource() { return cmpImpl().source || '（未合入：utils/answerCompare.js）'; }

// ───────────────────── parseLatexStrict ─────────────────────

let _strict = null;
function strictImpl() {
    if (_strict) return _strict;
    const real = tryRequire('utils/textFormatter.js');
    _strict = real && typeof real.parseLatexStrict === 'function'
        ? { source: 'utils/textFormatter.js', fn: real.parseLatexStrict }
        : { source: null, fn: null };
    return _strict;
}

/**
 * @param {string} str
 * @returns {{ok:boolean, events:Array<{kind:string, at:number}>}|null}
 *          尚未合入時回 **null**（不是 {ok:true}）——見上面第 3 條規矩。
 */
function parseLatexStrict(str) {
    const impl = strictImpl();
    return impl.fn ? impl.fn(str) : null;
}
/** @returns {boolean} */
function parseLatexStrictReady() { return strictImpl().fn !== null; }
/** @returns {string} */
function parseLatexStrictSource() { return strictImpl().source || '（未合入：utils/textFormatter.js 的 parseLatexStrict）'; }

/**
 * 對一段可能含多個 $…$ 的文字算「嚴格解析通過率」。
 * @param {string[]} texts
 * @returns {{rate:number|null, ok:number, total:number, events:Object<string,number>}}
 *          未合入時 rate = null、total = 0。
 */
function formulaStrictRate(texts) {
    if (!parseLatexStrictReady()) return { rate: null, ok: 0, total: 0, events: {} };
    const events = {};
    let ok = 0, total = 0;
    for (const t of texts || []) {
        if (typeof t !== 'string' || t === '') continue;
        total++;
        const res = parseLatexStrict(t);
        if (res && res.ok) ok++;
        for (const e of (res && res.events) || []) {
            events[e.kind] = (events[e.kind] || 0) + 1;
        }
    }
    return { rate: total === 0 ? null : ok / total, ok, total, events };
}

// ───────────────────── pricing ─────────────────────

let _pricing = null;
function pricingImpl() {
    if (_pricing) return _pricing;
    const real = tryRequire('config/pricing.js');
    _pricing = real && typeof real.estimateCost === 'function'
        ? { source: 'config/pricing.js', fn: real.estimateCost }
        : { source: null, fn: null };
    return _pricing;
}

/**
 * @param {{modelId:string, tokenIn:number, tokenOut:number, tokenThinking:number, tokenCached:number}} usage
 * @returns {{cost_usd:number, cost_estimated:boolean}}
 *          未合入 config/pricing.js 時回 { cost_usd: 0, cost_estimated: false }——
 *          與第 5.5 條「查不到模型 → 記 0 且 cost_estimated=false」同一個語意，
 *          報表會把 cost_estimated=false 的列另外標示，不會被誤讀成「這次很便宜」。
 */
function estimateCost(usage) {
    const impl = pricingImpl();
    if (!impl.fn) return { cost_usd: 0, cost_estimated: false };
    return impl.fn(usage);
}
/** @returns {boolean} */
function pricingReady() { return pricingImpl().fn !== null; }
/** @returns {string} */
function pricingSource() { return pricingImpl().source || '（未合入：config/pricing.js）'; }

// ───────────────────── 彙總 ─────────────────────

/**
 * 報表 meta 用的一覽。
 * @returns {{normalizeStem:string, answerCompare:string, parseLatexStrict:string, pricing:string, anyStub:boolean}}
 */
function sources() {
    const s = {
        normalizeStem: normalizeStemSource(),
        answerCompare: answerCompareSource(),
        parseLatexStrict: parseLatexStrictSource(),
        pricing: pricingSource()
    };
    s.anyStub = Object.values(s).some(v => typeof v === 'string' && (v.includes('暫用') || v.includes('未合入')));
    return s;
}

/**
 * @returns {string[]} 給 run.js 直接塞進 warnings 的句子（沒有缺件時回空陣列）
 */
function warnings() {
    const out = [];
    if (normalizeStemSource().includes('暫用')) {
        out.push('normalizeStem 仍是 eval 暫用實作（utils/normalizeStem.js 尚未合入）：規則抄自 scripts/backfill_text_hash.js，' +
            'WS-C 合入後必須確認雜湊逐位元相同。');
    }
    if (!answerCompareReady()) {
        out.push('utils/answerCompare.js 尚未合入：answer_agree_rate 與 answer golden 的比對結果一律印 n/a（不寫假數字）。');
    }
    if (!parseLatexStrictReady()) {
        out.push('utils/textFormatter.js 的 parseLatexStrict 尚未合入：formula_strict_rate 一律印 n/a。');
    }
    if (!pricingReady()) {
        out.push('config/pricing.js 尚未合入：cost_usd 一律記 0 且 cost_estimated=false（第 5.5 條的語意）。');
    }
    return out;
}

module.exports = {
    normalizeStem, textHash, normalizeStemSource,
    answerCompare, answerCompareReady, answerCompareSource,
    parseLatexStrict, parseLatexStrictReady, parseLatexStrictSource, formulaStrictRate,
    estimateCost, pricingReady, pricingSource,
    sources, warnings, tryRequire, ROOT
};
