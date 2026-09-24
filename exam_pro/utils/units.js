// ─────────────────────────────────────────────────────────────
// utils/units.js — 答案比對用的單位解析（階段 5 WS-B；docs/interfaces-stage5.md 第 4.2 條第 4 點）
//
// 為什麼要有這一支：utils/answerCompare.js 的 toNumber 一律把單位當後綴剝掉再比數值（裁決 S2-26），
// 於是「5 cm」對「5 m」會被判 agree——數字一樣、單位差了一百倍。這一支只做一件事：
// 把答案後面的單位讀成「因次 + 換算到 SI 的倍率」，讓比對器能分辨：
//   - 兩邊都有**認得**的單位、因次不同（N 對 J）或換算後數值不同（5 cm 對 5 m）→ 不一致；
//   - 因次相同就換算後再比（0.5 m 對 50 cm、0.25 M 對 0.25 mol/L 一致）；
//   - 任何一邊沒有單位、或單位不在下表（「位數」「個」「次」）→ 回 null，比對器照原本的規則比。
//     認不得就不判——這與 answerCompare「比不出來就不回 disagree」的取捨一致。
//
// 單位表只收高中數理化會出現、寫法不含糊的單位。刻意不收：
//   「度」（角度還是攝氏？）、「%」（toNumber 另有處理）、「米」（大陸用語）。
//
// 純函式：無 I/O、無隨機、無時間、不讀 process.env。
// ─────────────────────────────────────────────────────────────

/** 因次的六個基本量（長度、質量、時間、電流、溫度、物質的量）＋角度 */
const DIMS = ['L', 'M', 'T', 'I', 'K', 'N', 'A'];

/** 簡寫：因次字串 → 物件，例 'M1L1T-2' */
function dims(spec) {
    const out = {};
    for (const m of String(spec).matchAll(/([LMTIKNA])(-?\d+)/g)) out[m[1]] = Number(m[2]);
    return out;
}

const D = {
    length: dims('L1'), mass: dims('M1'), time: dims('T1'), current: dims('I1'), temp: dims('K1'),
    amount: dims('N1'), angle: dims('A1'), force: dims('M1L1T-2'), energy: dims('M1L2T-2'),
    power: dims('M1L2T-3'), pressure: dims('M1L-1T-2'), voltage: dims('M1L2T-3I-1'),
    resistance: dims('M1L2T-3I-2'), charge: dims('I1T1'), tesla: dims('M1T-2I-1'), freq: dims('T-1'),
    volume: dims('L3'), molarity: dims('N1L-3')
};

/**
 * 符號 → [因次, 換算到 SI 的倍率, 溫度的位移]。大小寫有別（m／M、s／S 意義不同）。
 * 中文單位名一併收錄，老師的答案常寫「25 公尺」「2 秒」。
 */
const UNIT_TABLE = {
    // 長度
    m: [D.length, 1], cm: [D.length, 1e-2], mm: [D.length, 1e-3], km: [D.length, 1e3],
    'μm': [D.length, 1e-6], um: [D.length, 1e-6], nm: [D.length, 1e-9], 'Å': [D.length, 1e-10],
    '公尺': [D.length, 1], '公分': [D.length, 1e-2], '公釐': [D.length, 1e-3], '毫米': [D.length, 1e-3],
    '公里': [D.length, 1e3], '奈米': [D.length, 1e-9],
    // 質量
    kg: [D.mass, 1], g: [D.mass, 1e-3], mg: [D.mass, 1e-6],
    '公斤': [D.mass, 1], '公克': [D.mass, 1e-3], '克': [D.mass, 1e-3], '毫克': [D.mass, 1e-6],
    // 時間
    s: [D.time, 1], ms: [D.time, 1e-3], min: [D.time, 60], h: [D.time, 3600], hr: [D.time, 3600],
    '秒': [D.time, 1], '分鐘': [D.time, 60], '小時': [D.time, 3600],
    // 電流、溫度、物質的量
    A: [D.current, 1], mA: [D.current, 1e-3], '安培': [D.current, 1],
    K: [D.temp, 1, 0], '℃': [D.temp, 1, 273.15],
    mol: [D.amount, 1], mmol: [D.amount, 1e-3], '莫耳': [D.amount, 1],
    // 角度
    '°': [D.angle, Math.PI / 180], rad: [D.angle, 1],
    // 力、能量、功率、壓力
    N: [D.force, 1], kN: [D.force, 1e3], '牛頓': [D.force, 1],
    J: [D.energy, 1], kJ: [D.energy, 1e3], cal: [D.energy, 4.184], kcal: [D.energy, 4184],
    eV: [D.energy, 1.602176634e-19], '焦耳': [D.energy, 1], '卡': [D.energy, 4.184], '大卡': [D.energy, 4184],
    '仟卡': [D.energy, 4184],
    W: [D.power, 1], kW: [D.power, 1e3], '瓦特': [D.power, 1],
    Pa: [D.pressure, 1], kPa: [D.pressure, 1e3], atm: [D.pressure, 101325], mmHg: [D.pressure, 133.322],
    cmHg: [D.pressure, 1333.22], '大氣壓': [D.pressure, 101325], '帕': [D.pressure, 1],
    // 電磁
    V: [D.voltage, 1], mV: [D.voltage, 1e-3], kV: [D.voltage, 1e3], '伏特': [D.voltage, 1],
    'Ω': [D.resistance, 1], 'kΩ': [D.resistance, 1e3], ohm: [D.resistance, 1], '歐姆': [D.resistance, 1],
    C: [D.charge, 1], mC: [D.charge, 1e-3], 'μC': [D.charge, 1e-6], '庫侖': [D.charge, 1],
    T: [D.tesla, 1], '特斯拉': [D.tesla, 1],
    Hz: [D.freq, 1], kHz: [D.freq, 1e3], '赫茲': [D.freq, 1],
    // 體積與濃度（化學）
    L: [D.volume, 1e-3], mL: [D.volume, 1e-6], cc: [D.volume, 1e-6],
    '升': [D.volume, 1e-3], '公升': [D.volume, 1e-3], '毫升': [D.volume, 1e-6],
    M: [D.molarity, 1e3]
};

/** 中文單位名（trailingUnitText 用；長的先比） */
const CJK_UNITS = Object.keys(UNIT_TABLE).filter(k => /[一-鿿]/.test(k)).sort((a, b) => b.length - a.length);

const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

/**
 * 單位字串的正規化：去掉 $、LaTeX 外殼與間距，指數寫成 ^n。
 * @param {string} text
 * @returns {string}
 */
function normalizeUnitText(text) {
    let s = String(text ?? '')
        .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, m => `^${[...m].map(c => SUPERSCRIPTS[c]).join('')}`);
    s = s.normalize('NFKC')
        .replace(/\$/g, ' ')
        .replace(/\\(?:,|;|:|!| )/g, ' ')
        .replace(/~/g, ' ');
    for (let k = 0; k < 4; k++) s = s.replace(/\\(?:mathrm|text|rm|mbox|operatorname|mathit)\s*\{([^{}]*)\}/g, '$1');
    s = s.replace(/\^\s*\{?\s*\\(?:circ|degree)\s*\}?/g, '°')
        .replace(/\\(?:circ|degree)\b/g, '°')
        .replace(/\\Omega\b/g, 'Ω')
        .replace(/\\mu\b\s*/g, 'μ')
        .replace(/\\(?:cdot|times)\b/g, '·')
        .replace(/[*⋅•]/g, '·')
        .replace(/µ/g, 'μ')
        .replace(/°\s*C/g, '℃')
        .replace(/\^\s*\{\s*([+\-−]?\d+)\s*\}/g, '^$1')
        .replace(/−/g, '-')
        .replace(/[{}]/g, '')
        .replace(/\s*([/·^])\s*/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    return s;
}

/** 一個因子（符號＋可選的指數）→ {dims, factor, offset, exp} 或 null */
function parseFactor(token) {
    const m = /^([^\^]+?)(?:\^(-?\d+))?$/.exec(token);
    if (!m) return null;
    let sym = m[1];
    let exp = m[2] === undefined ? 1 : Number(m[2]);
    let entry = UNIT_TABLE[sym];
    if (!entry && m[2] === undefined) {
        // cm3、s2 這種省略 ^ 的寫法：尾端一位數字當指數（前半段必須是認得的單位）
        const tail = /^(.+?)(\d)$/.exec(sym);
        if (tail && UNIT_TABLE[tail[1]]) { sym = tail[1]; exp = Number(tail[2]); entry = UNIT_TABLE[sym]; }
    }
    if (!entry) return null;
    return { dims: entry[0], factor: entry[1], offset: entry[2] || 0, exp };
}

/**
 * 解析單位字串。
 * @param {string|null} text 例：'m/s^2'、'\mathrm{kJ/mol}'、'公尺'、'mol/L'、'J/(mol·K)'
 * @returns {{dims:Object<string,number>, factor:number, offset:number, text:string}|null}
 *          空字串或任何一個因子認不得 → null
 */
function parseUnit(text) {
    if (text === null || text === undefined) return null;
    const s = normalizeUnitText(text);
    if (!s || !/[A-Za-zΩμ°℃Å一-鿿]/.test(s)) return null;

    const groups = s.split('/');
    const total = {};
    let factor = 1;
    let offset = 0;
    let factorCount = 0;
    for (let g = 0; g < groups.length; g++) {
        const sign = g === 0 ? 1 : -1;
        const inner = groups[g].replace(/^\(|\)$/g, '');
        if (!inner) return null;
        for (const token of inner.split(/[·\s]+/).filter(Boolean)) {
            const f = parseFactor(token);
            if (!f) return null;
            const exp = f.exp * sign;
            for (const [d, n] of Object.entries(f.dims)) total[d] = (total[d] || 0) + n * exp;
            factor *= Math.pow(f.factor, exp);
            offset = f.offset;
            factorCount += 1;
        }
    }
    // 溫度的位移只在「單一個溫度單位」時有意義（J/℃ 這種組合單位裡的 ℃ 是溫差）
    if (factorCount !== 1) offset = 0;
    for (const d of Object.keys(total)) if (total[d] === 0) delete total[d];
    return { dims: total, factor, offset, text: s };
}

/** 兩個單位的因次是否相同 */
function sameDims(a, b) {
    const keys = new Set([...Object.keys(a.dims), ...Object.keys(b.dims)]);
    for (const k of keys) if ((a.dims[k] || 0) !== (b.dims[k] || 0)) return false;
    return true;
}

/** 數值換算到 SI（℃ → K 要加位移） */
function toBase(value, unit) {
    return value * unit.factor + unit.offset;
}

/** 高中課本慣用的 0 ℃ = 273 K（UNIT_TABLE 的 ℃ 用精確值 273.15） */
const SCHOOL_CELSIUS_OFFSET = 273;

/**
 * 兩個同因次單位「可以怎麼換算」的候選組：通常只有 [a, b] 一組。
 * 一邊帶溫度位移（℃）、另一邊沒有（K）時，另加「℃ 以 273 換算」的一組——高中數理化一律用 273，
 * 25 ℃ 對 298 K、27 ℃ 對 300 K 都是對的答案，只認 273.15 會把它們判成不一致、丟進複核。
 * 兩邊都是 ℃（或都是 K）時位移互相抵消，不另加：否則 25 ℃ 對 25.15 ℃ 會被當成一樣。
 * @param {{offset:number}} a
 * @param {{offset:number}} b
 * @returns {Array<[object, object]>}
 */
function conversionVariants(a, b) {
    const variants = [[a, b]];
    if ((a.offset || 0) !== (b.offset || 0)) {
        const school = (u) => (u.offset ? Object.assign({}, u, { offset: SCHOOL_CELSIUS_OFFSET }) : u);
        variants.push([school(a), school(b)]);
    }
    return variants;
}

/** 數值前綴：正負號、整數／小數／分數、科學記號（e 或 ×10^n） */
const NUM_PREFIX_RE = /^\s*[+\-−]?\s*(?:\\[dt]?frac\s*\{[^{}]*\}\s*\{[^{}]*\}|\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)(?:[eE][+\-]?\d+)?(?:\s*(?:\\times|×|\*|\\cdot|·)\s*10\s*\^\s*(?:\{\s*[+\-−]?\d+\s*\}|[+\-−]?\d+))?/;

/**
 * 從「一個答案」裡取出單位的原文（還沒解析）。
 *   '$5\ \mathrm{m/s^2}$' → 'm/s^2'；'$5\text{ m/s}^2$' → ' m/s^2'；'25 公尺' → '公尺'；
 *   'x = 2.4 \times 10^{-4} J' → 'J'；'2.4e-4' → null；'1 或 4' → null。
 * @param {string} answer
 * @returns {string|null}
 */
function unitTextOfAnswer(answer) {
    if (typeof answer !== 'string' && typeof answer !== 'number') return null;
    // LaTeX 間距指令（\, \; \: \! \ ）先換成空白：\, 的逗號不是多解的分隔符
    let s = String(answer).normalize('NFC').replace(/\$/g, ' ').replace(/\\[,;:! ]/g, ' ').trim();
    if (s.includes('=')) s = s.slice(s.lastIndexOf('=') + 1).trim();
    if (/或|[,，、;；]/.test(s)) return null;            // 多解：單位規則不介入

    // 單位巨集（\mathrm{…}、\text{…}）連同後面的指數；前面必須有數字
    const macros = [...s.matchAll(/\\(?:mathrm|text|rm|mbox|operatorname)\s*\{([^{}]*)\}((?:\s*\^\s*(?:\{[^{}]*\}|\\circ|\d+))?)/g)];
    if (macros.length) {
        const last = macros[macros.length - 1];
        const before = s.slice(0, last.index);
        if (!/\d/.test(before)) return null;
        // 「27^{\circ}\mathrm{C}」：度的符號寫在巨集前面，要一起帶走——只取 \mathrm{C} 會把攝氏讀成庫侖
        const degree = /(?:\^\s*\{?\s*\\(?:circ|degree)\s*\}?|\\degree|°)\s*$/.test(before) ? '°' : '';
        return `${degree}${last[1]}${last[2] || ''}`;
    }
    const m = NUM_PREFIX_RE.exec(s);
    if (!m) return null;
    const rest = s.slice(m[0].length).trim();
    return rest || null;
}

/**
 * 緊接在答案後面的單位原文（claimed「…＝ 25$ m。」的「 m」「 m/s$^2$」「 秒」）。
 * 只讀開頭：ASCII 單位讀到中文或標點為止；中文單位必須後面是標點、空白或結尾（「升高」不算「升」）。
 * 單一個大寫字母後面緊接中文（「$2$ A 點」「C 處」「N 極」）是點名，不是單位 → null；
 * 後面是標點或結尾（「$2$ A。」）才當單位。寧可漏讀單位（照原規則只比數值），不要憑空判 disagree。
 * @param {string} text
 * @returns {string|null}
 */
function trailingUnitText(text) {
    const t = String(text ?? '').replace(/^\s+/, '');
    if (!t) return null;
    const ascii = /^((?:\$?\^?\\?[A-Za-zΩμµ°℃Å][A-Za-z0-9Ωμµ°℃Å\/·\^\{\}\$\-]*)(?:\s*[·/]\s*[A-Za-z0-9Ωμµ°℃\^\{\}\$\-]+)*)(?![A-Za-z])/.exec(t);
    if (ascii) {
        if (/^[A-Z]$/.test(ascii[1]) && /^\s*\p{Script=Han}/u.test(t.slice(ascii[1].length))) return null;
        return ascii[1];
    }
    for (const u of CJK_UNITS) {
        if (t.startsWith(u) && (t.length === u.length || /^[\s，。、；;,.:：)）！!？?]/.test(t.slice(u.length)))) return u;
    }
    return null;
}

module.exports = {
    UNIT_TABLE, DIMS, SCHOOL_CELSIUS_OFFSET,
    normalizeUnitText, parseUnit, sameDims, toBase, conversionVariants, unitTextOfAnswer, trailingUnitText
};
