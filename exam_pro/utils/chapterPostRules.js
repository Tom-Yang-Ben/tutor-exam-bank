// utils/chapterPostRules.js — 模型挑出來的章節的後處理：名稱容錯＋相鄰兩章的界線（classify 與 nlq 共用）
//
// **純函式**：無 I/O、無隨機、無時間、不讀 process.env。
//
// 〔2026-09-26 dec/local-classify-nlq-prep〕為什麼有這一支（docs/local-mode.md 10.15）：
//   2026-09-25 以本機模型（ollama:qwen3:8b）重錄 classify.v1，92 題錯 15 題，**15 題全都落在相鄰兩章之間**，
//   而且每一組界線 Owner 都已經寫成規則（決策單 A5、K2、K3；eval/CHAPTER_RELABEL-2026-09.md 第 8.0 節；
//   classify.v2 的 SUBJECT_RULES 已把這些規則寫進 prompt）。但 8B 模型在「先寫章節、再寫理由」的輸出順序下
//   不一定照規則走（同一批題 Gemini 用 classify.v1 也錯了其中 8 題）；重錄一次要好幾個小時，
//   所以題幹裡有**明確、可機械判斷的證據**時，由程式照 Owner 的規則把章換過去，不必賭模型這一次有沒有照做。
//
// 兩條原則（與 services/nlqService.js 的 mergeLlm「句子裡要找得到證據」同一條線）：
//   1. **只在兩章之間換**：每條規則只管一對相鄰的章（from → to），模型挑的不是 from 就不碰；
//      證據不夠明確（兩種線索都有、或一種都沒有）就不換——寧可留模型自己的選擇，也不要換錯。
//   2. **只收能逐字對到 Owner 書面規則的證據**：每條規則的 source 欄寫出處。界線要靠「解這題要不要代公式、
//      要不要求力」這類理解才分得出來的（必修運動學／直線運動的一般情形、圓周運動的運動學／受力、
//      直角三角形／疊合），這裡**刻意不寫**，留給模型與模板規則（決策草稿 LC-2）。
//
// 名稱容錯（canonicalChapter）：模型回的章名與白名單只差空白、「」引號、全形／半形（NFKC）或前面多了「第三冊」
// 時，對回白名單那一個；對到零個或兩個以上就不對（交給原本的 chapter_invalid）。Ollama 與 Gemini 都以 schema 的
// enum 做約束，2026-09-25 的 100 支本機 cassette 沒有一支需要它——這是給 Gemini 拆掉 enum 的退路
// （services/llm/gemini.js 的 schemaFallback）與不支援文法約束的模型用的防線。
//
// 這些規則寫的時候看過 2026-09-25 的 15 題錯題（證據字是照著錯題的型態挑的）；回歸測試在同一批題上的改善
// 會高估對新題的效果。每條規則另有「不該觸發」的反例測試（test/unit/chapterPostRules.test.js）。

const { CHAPTERS, isValidChapter } = require('../config/chapters');
const { KEYWORD_RULES, findNonCommonLogBase, findVariableExponent } = require('../config/chapterMigrationRules');
const { PLANE_CUES, SPACE_CUES, SPACE_TO_PLANE } = require('./nlqHeuristics');

// ───────────────────────── 名稱容錯 ─────────────────────────

/** 比對用的鍵：NFKC（全形括號、英數 → 半形）、拿掉空白與引號、拿掉開頭的「第 N 冊」 */
function chapterKey(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .replace(/[\s「」『』"“”'‘’]/g, '')
        .replace(/^第[一二三四五六]冊[:：]?/, '');
}

/**
 * 模型回的章名 → 白名單裡的那一章（名稱容錯）。
 * 已經在白名單內就原樣回傳；否則只在「比對鍵相同的章恰好一個」時回那一章，其餘回 null。
 * @param {string} subject
 * @param {unknown} value
 * @returns {string|null}
 */
function canonicalChapter(subject, value) {
    if (typeof value !== 'string') return null;
    if (isValidChapter(subject, value)) return value;
    const list = Object.prototype.hasOwnProperty.call(CHAPTERS, subject) ? CHAPTERS[subject] : [];
    const key = chapterKey(value);
    if (!key) return null;
    const hits = list.filter(c => chapterKey(c) === key);
    return hits.length === 1 ? hits[0] : null;
}

/**
 * 同 canonicalChapter，但科目可以不知道（nlq 的 LLM 不一定給科目）：subject 不是合法科目時在三科裡找，
 * 恰好一科對得到才回。
 * @param {string|null} subject
 * @param {unknown} value
 * @returns {string|null}
 */
function canonicalChapterAny(subject, value) {
    if (Object.prototype.hasOwnProperty.call(CHAPTERS, subject)) return canonicalChapter(subject, value);
    const hits = [...new Set(Object.keys(CHAPTERS).map(s => canonicalChapter(s, value)).filter(Boolean))];
    return hits.length === 1 ? hits[0] : null;
}

/** 題型的比對鍵：NFKC、拿掉空白與引號（「計算 」「『填空』」） */
function questionTypeKey(text) {
    return String(text ?? '').normalize('NFKC').replace(/[\s「」『』"“”'‘’]/g, '');
}

// ───────────────────────── 證據：指數與對數（決策單 A5） ─────────────────────────

const EXP_LOG_FIRST = '指數與對數';
const EXP_LOG_THIRD = '指數函數與對數函數';

/**
 * 第三冊的關鍵字：直接沿用舊題搬章的規則表（config/chapterMigrationRules.js，CH-C／CR-8，去處是第三冊的那幾條），
 * 不另抄一份——兩邊對「哪些字眼屬第三冊」的判斷永遠一致。
 */
const THIRD_VOLUME_KEYWORDS = Object.freeze(
    (KEYWORD_RULES['數學'] || [])
        .filter(rule => rule.to === EXP_LOG_THIRD)
        .flatMap(rule => rule.keywords || [])
);

/** A5：第一冊只收指數律與常用對數（科學記號、首數與尾數、位數估計） */
const FIRST_VOLUME_CUE = /首數|尾數|位數|科學記號|常用對數/;

/** 第一冊的線索出現時仍不得往第一冊換的字眼（函數、圖形、方程式、不等式都是第三冊的題材） */
const FIRST_VOLUME_BLOCK = /函數|圖形|圖像|方程式|不等式|遞增|遞減|漸近線/;

/**
 * 「解」「求 x」「x 的值／範圍」：題目要求出指數或真數裡的那個未知數（指數／對數方程式或不等式）。
 * 「解答」「解析」「解釋」「了解」不算。單獨的不等號不算：「當 x>0 時，log x=c」是定義域，不是要解的不等式。
 */
const SOLVE_CUE = /(?<!了)解(?!答|析|釋|說)|求\s*(?:出\s*)?(?:未知數|實數)?\s*\$?\s*[xyt](?![A-Za-z])|(?<![A-Za-z\\])[xyt]\s*\$?\s*(?:的|之)(?:值|範圍)/;

/**
 * 真數含未知數的對數：$\log (x-1)$、$\log_{2} x$、\log x。只看 log 後面緊接的一小段。
 * @param {string} text
 * @returns {string|null}
 */
function findVariableLogArgument(text) {
    const re = /\\?log(?:_\s*(?:\{[^}]*\}|[A-Za-z0-9]))?\s*(?:\\left\s*)?\(?\s*([^\s$=<>,，。；;、]{1,12})/g;
    let m;
    while ((m = re.exec(String(text ?? ''))) !== null) {
        const arg = m[1].replace(/\\[A-Za-z]+/g, '');
        if (/(?<![A-Za-z])[xyt](?![A-Za-z])/.test(arg)) return m[0].trim();
    }
    return null;
}

/**
 * 題幹屬第三冊「指數函數與對數函數」的證據（A5：底數不是 10 的對數、換底、指數或對數方程式與不等式、函數與圖形）。
 * @param {string} text
 * @returns {string|null} 命中的原文
 */
function thirdVolumeEvidence(text) {
    const s = String(text ?? '').normalize('NFKC');
    const keyword = THIRD_VOLUME_KEYWORDS.find(k => s.includes(k));
    if (keyword) return keyword;
    const base = findNonCommonLogBase(s);
    if (base) return base;
    const ln = s.match(/\\ln(?![A-Za-z])/);
    if (ln) return ln[0];
    // 「未知數＋解／求 x」只是推論，不是明確證據：題幹有第一冊的題材（首數、尾數、位數、科學記號、常用對數）時，
    // 「求 x 的首數」「3^x 是 10 位數，求 x」都是 A5 明定的第一冊題，不得往第三冊換（審查意見 major-1）。
    // 上面三種明確證據（第三冊關鍵字、底數不是 10、\ln）不受這道檢查影響。
    if (FIRST_VOLUME_CUE.test(s)) return null;
    const variable = findVariableExponent(s) || findVariableLogArgument(s);
    if (variable) {
        const cue = s.match(SOLVE_CUE);
        if (cue) return `${variable}（${cue[0].trim()}）`;
    }
    return null;
}

/**
 * 題幹屬第一冊「指數與對數」的證據：有 A5 列舉的第一冊題材，而且沒有任何第三冊的證據與題材。
 * @param {string} text
 * @returns {string|null}
 */
function firstVolumeEvidence(text) {
    const s = String(text ?? '').normalize('NFKC');
    if (thirdVolumeEvidence(s) || FIRST_VOLUME_BLOCK.test(s)) return null;
    const m = s.match(FIRST_VOLUME_CUE);
    return m ? m[0] : null;
}

// ───────────────────────── 證據：平面／空間（classify.v2 數學規則 6；章名本身的定義） ─────────────────────────

/** 括號裡以逗號分隔的 2 或 3 個分量（坐標、向量）；分量不含中文與括號 */
const TUPLE_RE = /[(（]\s*([^,，()（）$㐀-鿿]{1,12}?)\s*[,，]\s*([^,，()（）$㐀-鿿]{1,12}?)\s*(?:[,，]\s*([^,，()（）$㐀-鿿]{1,12}?)\s*)?[)）]/g;

/**
 * 題幹裡的坐標是二維還是三維。
 * @param {string} text
 * @returns {{two:string|null, three:string|null}} 各自第一個命中的原文
 */
function coordinateTuples(text) {
    let two = null;
    let three = null;
    for (const m of String(text ?? '').matchAll(TUPLE_RE)) {
        if (m[3] !== undefined) three = three || m[0];
        else two = two || m[0];
    }
    return { two, three };
}

/**
 * 題幹裡「明講平面坐標系」的寫法。比 nlq 的 PLANE_CUES 少了「平面上」：查詢句的「平面上」是在講二維，
 * 題幹裡卻常是空間單元的題材（「直線在平面上」「平面上一點到平面的距離」）。
 */
const PLANE_TEXT_CUES = Object.freeze(PLANE_CUES.filter(w => w !== '平面上'));

/**
 * 題幹講的是平面還是空間：文字線索（「平面向量」「坐標平面」「二維」／nlq 的 SPACE_CUES「空間」「三維」「z 軸」）
 * 加上坐標分量的個數。兩種文字線索都有、兩種坐標都有、或文字與坐標互相矛盾（說空間卻只有二維坐標、或反過來）時回 null。
 * @param {string} text
 * @returns {{dimension:'plane'|'space', evidence:string}|null}
 */
function dimensionEvidence(text) {
    const raw = String(text ?? '');
    const s = raw.replace(/\s+/g, '').toLowerCase();
    const space = SPACE_CUES.find(w => s.includes(w)) || null;
    const plane = PLANE_TEXT_CUES.find(w => s.includes(w)) || null;
    const { two, three } = coordinateTuples(raw);
    if ((space && plane) || (two && three)) return null;
    if (space) return two ? null : { dimension: 'space', evidence: three || space };
    if (plane) return three ? null : { dimension: 'plane', evidence: two || plane };
    if (three) return { dimension: 'space', evidence: three };
    if (two) return { dimension: 'plane', evidence: two };
    return null;
}

// ───────────────────────── 證據：物理 ─────────────────────────

const ELECTROSTATICS = '靜電學';
const FIELD_POTENTIAL = '電場與電位';
const LINEAR_MOTION = '直線運動';
const PLANAR_MOTION = '平面運動';
const REQUIRED_MOTION = '物體的運動（速度與加速度）';

/** 第 8.0 節第一條＋第 8.6 節第 5 點：電位差、電位能、作功、電力線（電場線）與等位面歸「電場與電位」 */
const FIELD_POTENTIAL_CUE = /等位[面線]|電力線|電場線|電位差|電位能|[作做]了?(?:多少)?的?功/;
/** 第 8.0 節第一條：求兩電荷之間的力（庫侖定律）歸「靜電學」 */
const COULOMB_CUE = /庫侖/;

/**
 * K2：相對速度是一維還是二維。
 *   二維：方向字落在兩條軸以上（東西、南北、上下），或出現夾角／分量／偏角，或是渡河、雨滴、風這類典型的二維題材
 *         （渡河的第二條軸是「水流」，題幹不一定寫方向字）；
 *   一維：方向字只有水平的一條軸（只有東西、或只有南北），或寫明同一直線／同向／反向／迎面，而且沒有任何二維線索。
 * 只有上下一條軸（「垂直河岸」「鉛直落下」）不算一維：渡河、雨滴題常只寫這一個方向。沒有「相對」兩字或分不出來回 null。
 * @param {string} text
 * @returns {{dimension:1|2, evidence:string}|null}
 */
function relativeMotionEvidence(text) {
    const s = String(text ?? '');
    if (!s.includes('相對')) return null;
    const ew = s.match(/[東西]/);
    const ns = s.match(/[南北]/);
    const vertical = s.match(/鉛直|垂直|向上|向下|上升|下降|落下|上拋|下拋/);
    const axes = [ew, ns, vertical].filter(Boolean);
    const planar = s.match(/夾角|角度|分量|分解|偏|°|\\circ|度角|渡河|過河|河岸|水流|流速|雨滴|風速|側風|斜向/);
    if (axes.length >= 2 || planar) {
        return { dimension: 2, evidence: [...axes.map(m => m[0]), ...(planar ? [planar[0]] : [])].join('＋') };
    }
    if ((ew || ns) && !vertical) return { dimension: 1, evidence: (ew || ns)[0] };
    const collinear = s.match(/同一直線|同向|反向|迎面/);
    if (collinear && !vertical) return { dimension: 1, evidence: collinear[0] };
    return null;
}

/**
 * 第 8.0 節第三條：自由落體、鉛直上拋／下拋而且給了數值、要求數值——一定要代等加速度公式，歸「直線運動」。
 * 只問觀念（沒有數字、或沒有「求／多少」）不算。
 * @param {string} text
 * @returns {string|null}
 */
function freeFallComputationEvidence(text) {
    const s = String(text ?? '');
    const topic = s.match(/自由落[下體]|鉛直上拋|鉛直下拋|上拋|下拋/);
    if (!topic || !/\d/.test(s)) return null;
    const ask = s.match(/求|多少|多久|多高|多遠|幾秒|若干/);
    return ask ? `${topic[0]}＋${ask[0]}` : null;
}

// ───────────────────────── 規則表 ─────────────────────────

/**
 * 每條規則：{ id, from, to, source, test(text) → 證據原文|null, dimension? }。
 * from／to 都必須是同一科的白名單章名（單元測試逐條檢查）。規則之間不會同時命中同一個 from（單元測試檢查）。
 * dimension：平面／空間那兩條另外標記——nlq 已有自己的平面／空間對齊（alignChapterDimension，句子不寫坐標），
 * 套用到 nlq 時略過它們（見 alignChapters 的 opts.skipDimension）。
 */
const RULES = Object.freeze([
    {
        id: 'exp_log_third', from: EXP_LOG_FIRST, to: EXP_LOG_THIRD,
        source: '決策單 A5：底數不是 10 的對數、換底、指數或對數方程式與不等式、函數與圖形屬第三冊（classify.v2 數學規則 5）',
        test: thirdVolumeEvidence
    },
    {
        id: 'exp_log_first', from: EXP_LOG_THIRD, to: EXP_LOG_FIRST,
        source: '決策單 A5：第一冊只收指數律與常用對數（科學記號、首數與尾數、位數估計）（classify.v2 數學規則 5）',
        test: firstVolumeEvidence
    },
    ...Object.entries(SPACE_TO_PLANE).flatMap(([space, plane]) => [
        {
            id: 'dimension_space', from: plane, to: space, dimension: true,
            source: '章名的定義：平面（二維坐標）與空間（三維坐標）分屬兩章（classify.v2 數學規則 6）',
            test: (text) => { const d = dimensionEvidence(text); return d && d.dimension === 'space' ? d.evidence : null; }
        },
        {
            id: 'dimension_plane', from: space, to: plane, dimension: true,
            source: '章名的定義：平面（二維坐標）與空間（三維坐標）分屬兩章（classify.v2 數學規則 6）',
            test: (text) => { const d = dimensionEvidence(text); return d && d.dimension === 'plane' ? d.evidence : null; }
        }
    ]),
    {
        id: 'field_potential', from: ELECTROSTATICS, to: FIELD_POTENTIAL,
        source: 'CHAPTER_RELABEL 第 8.0 節第一條、第 8.6 節第 5 點：電位差、電位能、作功、電力線與等位面歸電場與電位（classify.v2 物理規則 7）',
        test: (text) => {
            const s = String(text ?? '');
            if (COULOMB_CUE.test(s)) return null;
            const m = s.match(FIELD_POTENTIAL_CUE);
            return m ? m[0] : null;
        }
    },
    {
        id: 'coulomb', from: FIELD_POTENTIAL, to: ELECTROSTATICS,
        source: 'CHAPTER_RELABEL 第 8.0 節第一條：求兩電荷之間的力（庫侖定律）歸靜電學（classify.v2 物理規則 7）',
        test: (text) => {
            const s = String(text ?? '');
            if (FIELD_POTENTIAL_CUE.test(s) || /電場|電位/.test(s)) return null;
            const m = s.match(COULOMB_CUE);
            return m ? m[0] : null;
        }
    },
    {
        id: 'relative_1d', from: PLANAR_MOTION, to: LINEAR_MOTION,
        source: '重練與收尾決策單 K2（選 1）：同一直線上（一維）的運動，包含一維的相對速度，歸直線運動（classify.v2 物理規則 8）',
        test: (text) => { const r = relativeMotionEvidence(text); return r && r.dimension === 1 ? `相對＋${r.evidence}` : null; }
    },
    {
        id: 'relative_2d', from: LINEAR_MOTION, to: PLANAR_MOTION,
        source: '重練與收尾決策單 K2（選 1）：要用向量分解或在二維平面上才解得出來的，歸平面運動（classify.v2 物理規則 8）',
        test: (text) => { const r = relativeMotionEvidence(text); return r && r.dimension === 2 ? `相對＋${r.evidence}` : null; }
    },
    {
        id: 'free_fall_computation', from: REQUIRED_MOTION, to: LINEAR_MOTION,
        source: 'CHAPTER_RELABEL 第 8.0 節第三條：需要代入等加速度公式求數值的歸直線運動（classify.v2 物理規則 5）',
        test: freeFallComputationEvidence
    }
].map(rule => Object.freeze(rule)));

/**
 * 模型挑的一章 → 依界線規則該換成哪一章。
 * @param {string} chapter 模型挑的章（已過白名單）
 * @param {string} text 題幹或查詢句
 * @param {{skipDimension?:boolean}} [opts]
 * @returns {{to:string, rule:string, evidence:string, source:string}|null} 不換回 null
 */
function boundaryTarget(chapter, text, opts = {}) {
    for (const rule of RULES) {
        if (rule.from !== chapter) continue;
        if (opts.skipDimension && rule.dimension) continue;
        const evidence = rule.test(text);
        if (evidence) return { to: rule.to, rule: rule.id, evidence: String(evidence), source: rule.source };
    }
    return null;
}

/**
 * 一串章（nlq 的 LLM 可以回多章）逐一套用界線規則。
 * 與 nlq 的 alignChapterDimension 同一個原則：**換過去的那一章模型已經列了就不換**（兩章都留），
 * 順序不變、去重。
 * @param {string[]} chapters
 * @param {string} text
 * @param {{skipDimension?:boolean}} [opts]
 * @returns {{chapters:string[], changes:Array<{from:string, to:string, rule:string, evidence:string}>}}
 */
function alignChapters(chapters, text, opts = {}) {
    const list = Array.isArray(chapters) ? chapters : [];
    const out = [];
    const changes = [];
    for (const chapter of list) {
        const hit = typeof chapter === 'string' ? boundaryTarget(chapter, text, opts) : null;
        const mapped = hit && !list.includes(hit.to) ? hit.to : chapter;
        if (out.includes(mapped)) continue;
        out.push(mapped);
        if (mapped !== chapter) changes.push({ from: chapter, to: mapped, rule: hit.rule, evidence: hit.evidence });
    }
    return { chapters: out, changes };
}

module.exports = {
    canonicalChapter, canonicalChapterAny, chapterKey, questionTypeKey,
    boundaryTarget, alignChapters, RULES,
    // 證據函式（單元測試用）
    thirdVolumeEvidence, firstVolumeEvidence, findVariableLogArgument, THIRD_VOLUME_KEYWORDS,
    coordinateTuples, dimensionEvidence, relativeMotionEvidence, freeFallComputationEvidence
};
