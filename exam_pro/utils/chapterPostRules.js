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
//
// 〔Owner 2026-09-27 改答 LC-2：加四條規則〕上面第 2 點「刻意不寫」的兩組（圓周運動的運動學／受力、直角三角形／疊合），
//   Owner 在 2026-09-27 classify.v2 本機重錄（92 題錯 6 題）之後改答 LC-2（原選 1＝不加），加四條界線（docs/local-mode.md
//   10.22「classify 重錄後的四條界線規則（2026-09-27，改答 LC-2）」）：
//     trig_square_relation  三角函數的疊合 → 直角三角形的邊角關係（只有 sin²＋cos² 這類平方關係，K3）
//     general_angle         直角三角形的邊角關係 → 廣義角與極坐標（求三角函數值的角度 >90° 或 <0°）
//     friction_coefficient  牛頓運動定律 → 摩擦力與向心力（題幹出現摩擦係數）
//     circular_kinematics   摩擦力與向心力 → 平面運動（等速圓周運動只問運動學量，沒有受力計算）
//   原則照舊：每條只管一對章、證據不明確（兩種線索都有、有別章的線索）就不換。這四條是**看著 2026-09-27 的錯題**
//   （cls-fx-025、026、027、041、046）寫的，同一批題上的改善會高估對新題的效果；必修運動學／直線運動的一般情形
//   （cls-fx-051 那一組）仍然不寫。
// 〔審查修正 dec/r6-classify-rules-fix〕審查用自撰反例找到規則 1、4 的誤觸（課本常見的疊合二次式、只寫 μ 的轉盤／彎道、
//   沒寫繩的圓錐擺）與規則 3 的約化質量 \mu=\frac{m_1m_2}{…}；三處都往「不換」的方向收窄（docs/local-mode.md 10.22 第 7 點），
//   golden 上改對的 5 題不受影響。

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

// ───────────────────────── 〔Owner 2026-09-27 改答 LC-2〕證據：三角（K3 的平方關係、廣義角） ─────────────────────────

const RIGHT_TRIANGLE = '直角三角形的邊角關係';
const GENERAL_ANGLE = '廣義角與極坐標';
const TRIG_COMBINATION = '三角函數的疊合';

const SUPERSCRIPT_DIGITS = Object.freeze({
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-'
});

/**
 * 三角題的比對用文字：一串上標數字先寫成 ^{n} 再做 NFKC（直接 NFKC 會把「sin²40°」變成「sin240°」，被當成 240°；
 * 寫成 ^2 也不行，「sin^240°」分不出 2 次方與 40°），º、˚ 當成度的符號，減號（U+2212）當成 -。
 * @param {string} text
 * @returns {string}
 */
function normalizeTrigText(text) {
    return String(text ?? '')
        .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, run => `^{${[...run].map(ch => SUPERSCRIPT_DIGITS[ch]).join('')}}`)
        .replace(/[º˚]/g, '°')
        .normalize('NFKC')
        .replace(/−/g, '-');
}

const TRIG_FN = String.raw`(?<![A-Za-z])\\?(?:sin|cos|tan|cot|sec|csc)(?![A-Za-z])`;
/** 函數名後面的次方（\sin^2、\sin^{2}、\sin^{-1}）：只吃一位數或大括號，「\sin^240^\circ」才分得出 2 次方與 40° */
const TRIG_POWER = String.raw`(?:\s*\^\s*(?:\{\s*-?\d+\s*\}|-?\d))?`;
/** 度的寫法：^\circ、^{\circ}、°、\degree、「度」；數字與 ^ 之間可以夾一個空的 {} */
const DEGREE = String.raw`(?:\{\s*\})?\s*(?:\^\s*\{?\s*\\circ\s*\}?|°|\\degree(?![A-Za-z])|度)`;
const CN_TRIG_FN = '(?:正弦|餘弦|正切|餘切|正割|餘割)';

/** \sin 150^\circ、\cos(-30°)、\tan\left(210^{\circ}\right)、\sin^2 40^\circ */
const TRIG_ANGLE_RE = new RegExp(String.raw`${TRIG_FN}${TRIG_POWER}\s*(?:\\left\s*)?[({]?\s*(-)?\s*(\d+(?:\.\d+)?)${DEGREE}`, 'g');
/** 「150° 的正弦（函數）值」「$-30^\circ$ 角的餘弦」 */
const ANGLE_THEN_CN_RE = new RegExp(String.raw`(-)?\s*(\d+(?:\.\d+)?)${DEGREE}\s*\$?\s*角?\s*的\s*(?:三角函數|三角比|${CN_TRIG_FN})`, 'g');
/** 「正弦 150°」「餘弦函數值 (-30°)」 */
const CN_THEN_ANGLE_RE = new RegExp(String.raw`${CN_TRIG_FN}(?:函數)?值?\s*\$?\s*(?:\\left\s*)?[({]?\s*(-)?\s*(\d+(?:\.\d+)?)${DEGREE}`, 'g');

/**
 * 題幹裡「三角函數作用在一個以度表示的數字角」的每一處。只收直接寫成數字的角：
 * 「θ＝150°，求 sin θ」「sin(180°−θ)」不收（證據不夠直接）。
 * @param {string} text 已經過 normalizeTrigText
 * @returns {Array<{deg:number, raw:string}>}
 */
function trigAngles(text) {
    const out = [];
    for (const re of [TRIG_ANGLE_RE, ANGLE_THEN_CN_RE, CN_THEN_ANGLE_RE]) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
            const deg = Number(m[2]) * (m[1] ? -1 : 1);
            if (Number.isFinite(deg)) out.push({ deg, raw: m[0].trim() });
        }
    }
    return out;
}

/** 和角、差角、倍角、半角、疊合、和差化積：屬第三冊「和角與差角公式」「三角函數的疊合」的題材 */
const COMPOUND_ANGLE_CUE = /疊合|和角|差角|倍角|半角|和差|積化|化積/;
/** 角度裡有 ±（\sin(x+\phi)、\cos(60°+45°)、\sin(180°-30°)）：開頭的負號（\sin(-30°)）不算 */
const COMPOUND_ARGUMENT_RE = new RegExp(String.raw`${TRIG_FN}${TRIG_POWER}\s*(?:\\left\s*)?\(\s*[^()]*?[0-9A-Za-z}°\u0370-\u03FF]\s*[+-]\s*[^()]*\)`);
/**
 * 倍角：\sin 2\theta、\cos(2x)、\sin 3α、\sin 2A。
 * 〔審查修正 dec/r6-classify-rules-fix〕變數原本只認 x、t、θ、α、β、γ、φ，「求 \sin 2A」這種大寫字母的倍角漏掉；
 * 改成任一個單一英文字母或希臘字母（後面不能再接字母，「\sin 2 rad」的 rad 不算）。只讓規則 1 更少觸發。
 */
const MULTIPLE_ANGLE_RE = new RegExp(String.raw`${TRIG_FN}${TRIG_POWER}\s*(?:\\left\s*)?\(?\s*\d+\s*(?:\\(?:theta|alpha|beta|gamma|phi|varphi)(?![A-Za-z])|[A-Za-zͰ-Ͽ](?![A-Za-z]))`);
/** 一次的 sin 與 cos 相加減（a sinθ＋b cosθ 的疊合形式，或 (sinθ＋cosθ)² 這種要另外判斷的題） */
const LINEAR_COMBINATION_RE = new RegExp(String.raw`(?<![A-Za-z])\\?(sin|cos)(?![A-Za-z])(?!\s*\^)[^=，。,;；？?]{0,25}?[+-][^=，。,;；？?]{0,15}?\\?(?!\1)(?:sin|cos)(?![A-Za-z])(?!\s*\^)`);
/**
 * 〔審查修正 dec/r6-classify-rules-fix〕sin 與 cos 的一次乘積（\sin\theta\cos\theta、sin x cos x、\cos x\sin x）：
 * 「a sin²θ＋b sinθcosθ＋c cos²θ 求範圍／極值／化簡」要用倍角化成 A＋B sin(2θ＋φ)，是第三冊疊合的典型題，
 * 題幹同時有 sin²、cos² 也不是只用平方關係。兩個函數都不帶次方，中間不能夾加減號、等號、標點、$ 或中文字
 * （那是兩個分開的式子，例如「由 \sin\theta 求 \cos\theta」，不是乘積）。只讓規則 1 更少觸發。
 */
const SIN_COS_PRODUCT_RE = new RegExp(String.raw`(?<![A-Za-z])\\?(sin|cos)(?![A-Za-z])(?!\s*\^)[^+\-=，。,;；？?$　-鿿]{0,20}?\\?(?!\1)(?:sin|cos)(?![A-Za-z])(?!\s*\^)`);
/** 弧度：108 課綱的弧度在第三冊「三角函數的圖形」，出現弧度時「直角三角形／廣義角」這一對不一定是答案 */
const RADIAN_CUE = /\\pi(?![A-Za-z])|π|弧度|(?<![A-Za-z])rad(?![A-Za-z])/;
/**
 * 第三冊的函數題材：最大最小值、範圍、極值（疊合的典型用途）、週期、振幅、圖形。
 * 〔審查修正 dec/r6-classify-rules-fix〕加「範圍、極值、可能值」：「求 …sin²θ＋…cos²θ 的範圍／極值」是疊合題。
 */
const TRIG_FUNCTION_CUE = /最大值|最小值|極大|極小|極值|值域|範圍|可能值|可能的值|週期|周期|振幅|圖形|圖像/;
/** 廣義角的題材（CHAPTER_RELABEL 第 0 節：廣義角與同界角、以坐標定義的三角比、參考角與象限正負號、極坐標） */
const GENERAL_ANGLE_CUE = /廣義角|象限|終邊|同界|標準位置|參考角|單位圓|極坐標|極座標/;
/** 解三角形的題材：鈍角三角形的角可以大於 90°，那是「正弦與餘弦定理」「三角測量」，不一定是廣義角 */
const TRIANGLE_SOLVING_CUE = /三角形|正弦定理|餘弦定理|面積|仰角|俯角|測量|方位/;

/**
 * 題幹裡平方的三角函數（\sin^2、\sin^{2}、sin²、(\sin\theta)^2）。
 * @param {string} s 已經過 normalizeTrigText
 * @param {string} fn sin、cos、tan、sec、cot、csc
 * @returns {string|null}
 */
function squaredTrig(s, fn) {
    const re = new RegExp(String.raw`(?<![A-Za-z])\\?${fn}(?![A-Za-z])\s*\^\s*(?:\{\s*2\s*\}|2(?!\d))|\(\s*\\?${fn}(?![A-Za-z])[^()]{0,20}\)\s*\^\s*(?:\{\s*2\s*\}|2(?!\d))`);
    const m = s.match(re);
    return m ? m[0].trim() : null;
}

/**
 * K3＋Owner 2026-09-27 規則 1：題幹的三角運算只有平方關係（sin²θ＋cos²θ＝1、1＋tan²θ＝sec²θ 這類），
 * 沒有和角、差角、倍角、疊合（a sinθ＋b cosθ）、第三冊的函數題材、弧度，也沒有廣義角的線索（角度 >90° 或 <0°、象限、終邊…）。
 * 平方關係對廣義角也成立（第二冊「廣義角與極坐標」也教），有廣義角線索時不判斷。
 * 〔審查修正 dec/r6-classify-rules-fix〕sinθcosθ 的一次乘積（SIN_COS_PRODUCT_RE）、範圍／極值（TRIG_FUNCTION_CUE）、
 * 大寫字母的倍角（MULTIPLE_ANGLE_RE）也不判斷：「求 sin²θ＋sinθcosθ＋2cos²θ 的範圍」是疊合題，原本會被改錯。
 * @param {string} text
 * @returns {string|null} 命中的原文
 */
function squareRelationEvidence(text) {
    const s = normalizeTrigText(text);
    if (COMPOUND_ANGLE_CUE.test(s) || COMPOUND_ARGUMENT_RE.test(s) || MULTIPLE_ANGLE_RE.test(s) || LINEAR_COMBINATION_RE.test(s)) return null;
    if (SIN_COS_PRODUCT_RE.test(s)) return null;   // 〔審查修正 dec/r6-classify-rules-fix〕sinθcosθ 交叉項：倍角／疊合
    if (RADIAN_CUE.test(s) || TRIG_FUNCTION_CUE.test(s) || GENERAL_ANGLE_CUE.test(s) || /正弦定理|餘弦定理/.test(s)) return null;
    if (trigAngles(s).some(a => a.deg > 90 || a.deg < 0)) return null;
    const word = s.match(/平方關係/);
    if (word) return word[0];
    const sq = (fn) => squaredTrig(s, fn);
    const pairs = [['sin', 'cos'], ['tan', 'sec'], ['tan', 'cos'], ['cot', 'csc'], ['cot', 'sin']];
    for (const [a, b] of pairs) {
        const ma = sq(a);
        const mb = ma && sq(b);
        if (mb) return `${ma}＋${mb}`;
    }
    return null;
}

/**
 * Owner 2026-09-27 規則 2：題幹求三角函數值的角度大於 90° 或小於 0°（150°、-30°、210°）→ 廣義角。0°～90° 不判斷。
 * 不判斷的情形：弧度（第三冊，見 RADIAN_CUE）、解三角形的題材（鈍角三角形）、和角／差角／倍角／疊合的題材。
 * @param {string} text
 * @returns {string|null} 命中的原文（第一個超出 0°～90° 的角）
 */
function generalAngleEvidence(text) {
    const s = normalizeTrigText(text);
    if (RADIAN_CUE.test(s) || TRIANGLE_SOLVING_CUE.test(s)) return null;
    if (COMPOUND_ANGLE_CUE.test(s) || COMPOUND_ARGUMENT_RE.test(s)) return null;
    const hit = trigAngles(s).find(a => a.deg > 90 || a.deg < 0);
    return hit ? hit.raw : null;
}

// ───────────────────────── 〔Owner 2026-09-27 改答 LC-2〕證據：物理（摩擦係數、等速圓周運動的運動學） ─────────────────────────

const NEWTON_LAWS = '牛頓運動定律';
const FRICTION_CENTRIPETAL = '摩擦力與向心力';

/** 摩擦係數的字眼（Owner 規則 3：μ、摩擦係數、動摩擦、靜摩擦） */
const FRICTION_WORD_RE = /[動靜]?摩擦係數|動摩擦|靜摩擦/g;
/** 前後文說「沒有摩擦」：不計、忽略、無、為零 */
const FRICTION_NEGATION_BEFORE = /(?:不計|忽略|無|沒有|不考慮|不含)[^，。；,;？?]{0,2}$/;
const FRICTION_NEGATION_AFTER = /^[^，。；,;？?]{0,4}?(?:不計|可忽略|忽略不計|為零|=\s*0(?![.\d])|為\s*0(?![.\d]))/;
/**
 * 〔審查修正 dec/r6-classify-rules-fix〕μ 後面的「數」：小數、整數、數字的 \sqrt、分子分母都是數字的 \frac
 * （\frac{1}{2}、\frac12、\frac{\sqrt{3}}{3}）。原本只要是 \frac 或 \sqrt 就算，
 * 「定義 \mu=\frac{m_1m_2}{m_1+m_2}（約化質量）」會被當成摩擦係數；分子或分母有字母就不算。
 */
const MU_PLAIN_NUMBER = String.raw`\d+(?:\.\d+)?|\.\d+`;
const MU_SQRT_NUMBER = String.raw`\\sqrt\s*(?:\{\s*\d+(?:\.\d+)?\s*\}|\d)`;
const MU_FRAC_ARG = String.raw`(?:\{\s*(?:${MU_PLAIN_NUMBER}|${MU_SQRT_NUMBER})\s*\}|\d)`;
const MU_FRAC_NUMBER = String.raw`\\[dt]?frac\s*${MU_FRAC_ARG}\s*${MU_FRAC_ARG}`;
/**
 * 符號 μ 當摩擦係數：後面是關係符號再接一個數（μ＝0.2、\mu_k = 0.1、μs 為 0.4、\mu = \frac{1}{2}）。
 * μm、μC、μs（微秒）後面沒有關係符號；「μ 為線密度」後面不是數；\mu_0（磁導率）的下標不是 k／s。
 * micro 符號 µ（U+00B5）經 NFKC 變成 μ。第 1 組是那個數（＝0 表示沒有摩擦，不算）。
 */
const MU_RELATION_RE = new RegExp(String.raw`(?:\\mu|μ)(?![A-Za-z])\s*(?:_\s*\{?\s*(?:\\(?:text|mathrm)\s*\{\s*)?[ksKS靜動]\s*\}?\s*\}?)?\s*(?:=|為|是|<|>|≤|≥|≈|\\(?:le|ge|leq|geq|approx)(?![A-Za-z]))\s*\$?\s*(${MU_FRAC_NUMBER}|${MU_SQRT_NUMBER}|${MU_PLAIN_NUMBER})`);
/**
 * μ 的其他意思：磁導率（μ₀）、電學的微（μC、μA）、弦的線密度、約化質量；題幹有這些題材時，只有符號 μ 不算證據。
 * 〔審查修正 dec/r6-classify-rules-fix〕加「約化質量」（「約化質量 μ＝0.5 kg」後面是數，靠這一條排除）。
 */
const MU_OTHER_CONTEXT = /磁|電荷|電場|電流|電位|電壓|電容|電阻|導線|線圈|線密度|弦|波|約化質量|\\mu\s*_\s*\{?\s*0|μ\s*_?\s*\{?\s*0/;
/**
 * 功與能量、動量的題材（功與動能、位能與能量守恆、動量與衝量…另一組章）：題幹有這些題材時，
 * 「牛頓運動定律／摩擦力與向心力」「摩擦力與向心力／平面運動」這兩對不一定是答案，不判斷。
 */
const WORK_ENERGY_MOMENTUM_CUE = /[作做]了?[^，。；,;？?]{0,4}功|功率|功能|力學能|動能|位能|能量|生熱|熱量|動量|衝量|碰撞/;

/**
 * Owner 2026-09-27 規則 3：物理題幹出現摩擦係數（μ、摩擦係數、動摩擦、靜摩擦）。
 * 前後文寫明沒有摩擦（「不計摩擦係數」「摩擦係數為零」「μ＝0」）的那一處不算；
 * 題幹有功與能量、動量的題材時不判斷（WORK_ENERGY_MOMENTUM_CUE）。
 * @param {string} text
 * @returns {string|null} 命中的原文
 */
function frictionCoefficientEvidence(text) {
    const s = String(text ?? '').normalize('NFKC');
    if (WORK_ENERGY_MOMENTUM_CUE.test(s)) return null;
    for (const m of s.matchAll(FRICTION_WORD_RE)) {
        const before = s.slice(Math.max(0, m.index - 6), m.index);
        const after = s.slice(m.index + m[0].length, m.index + m[0].length + 12);
        if (FRICTION_NEGATION_BEFORE.test(before) || FRICTION_NEGATION_AFTER.test(after)) continue;
        return m[0];
    }
    if (MU_OTHER_CONTEXT.test(s)) return null;
    const mu = s.match(MU_RELATION_RE);
    if (mu && !(/^[\d.]+$/.test(mu[1]) && Number(mu[1]) === 0)) return mu[0].trim();
    return null;
}

/** 等速圓周運動（Owner 規則 4 的前提：題幹是等速圓周運動） */
const UNIFORM_CIRCULAR_RE = /等速率?圓周運動|勻速率?圓周運動|等速率?圓周/;
/** 運動學量：速率、速度（方向）、加速度（向心加速度、指向圓心）、角速度、週期、頻率 */
const CIRCULAR_KINEMATIC_RE = /向心加速度|角速度|加速度|速率|速度|週期|周期|頻率|轉速|切線|指向圓心/;
/**
 * 受力計算的線索：向心力、張力、摩擦、各種力的名稱、質量（F＝ma 要用）、力的單位 N、「求…力」「力的大小／方向為何」。
 * 選項裡「合力為零」這種要判斷對錯的敘述不算受力計算（CHAPTER_RELABEL 第 8.1 節 #46 的 Owner 裁決理由：
 * 「四個選項只問速率、速度、加速度方向與合力是否為零，是運動學」）；「求合力」「合力的大小／方向為何」算。
 * 〔審查修正 dec/r6-classify-rules-fix〕加五類線索，都是「只問運動學量、但要做受力分析才解得出來」的寫法：
 *   摩擦係數的符號 μ、\mu（沒寫「摩擦」二字的轉盤、彎道、旋轉圓筒題；規則 3 也把 μ 當摩擦的證據，兩條一致）；
 *   擺（圓錐擺、擺錘、擺長：沒寫「繩」也要拆張力）；滑動、打滑、滑落（不滑動的最大角速度、不打滑的最大速率）；
 *   掉落、不會掉（旋轉圓筒貼壁）。只讓規則 4 更少觸發。
 */
const CIRCULAR_FORCE_RE = /向心力|張力|摩擦|拉力|推力|正向力|法向力|支撐力|離心力|引力|重力|重量|質量|公斤|kg|牛頓|施力|受力|作用力|力矩|繩|細線|彈簧|壓力|\\mathrm\s*\{\s*N\s*\}|(?<![A-Za-z\\])N(?![A-Za-z])|多大的力|求[^。，,；;？?]{0,8}力|力[^。，,；;？?]{0,4}(?:大小|量值|多少|為何|多大|方向)|μ|\\mu(?![A-Za-z])|擺|滑動|打滑|滑落|掉落|不會掉/;
/**
 * 等速圓周運動只是工具、題目屬別章的題材：簡諧運動（圓周運動的投影）、帶電粒子在磁場中、行星與衛星（重力場）、
 * 轉動與角動量。題幹有這些題材時不判斷。
 */
const CIRCULAR_OTHER_TOPIC = /簡諧|投影|磁|電場|電荷|帶電|庫侖|行星|衛星|克卜勒|角動量|轉動慣量|剛體/;

/**
 * Owner 2026-09-27 規則 4：題幹是等速圓周運動，只問速率、速度方向、向心加速度等運動學量，
 * 沒有要算向心力大小、張力、摩擦力提供向心力等受力計算（classify.v2 物理規則 6、CHAPTER_RELABEL 第 8.0 節）。
 * 兩種線索都有（運動學量＋受力）、或題幹屬別章的題材（CIRCULAR_OTHER_TOPIC、功與能量）時不判斷。
 * @param {string} text
 * @returns {string|null} 命中的原文（「等速圓周運動＋速率」）
 */
function circularKinematicsEvidence(text) {
    const s = String(text ?? '').normalize('NFKC');
    const topic = s.match(UNIFORM_CIRCULAR_RE);
    if (!topic || CIRCULAR_FORCE_RE.test(s) || CIRCULAR_OTHER_TOPIC.test(s) || WORK_ENERGY_MOMENTUM_CUE.test(s)) return null;
    // 「等速率圓周運動」本身含「速率」：先拿掉主題字，再找題目問的運動學量
    const cue = s.replace(new RegExp(UNIFORM_CIRCULAR_RE.source, 'g'), '').match(CIRCULAR_KINEMATIC_RE);
    return cue ? `${topic[0]}＋${cue[0]}` : null;
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
    },
    // 〔Owner 2026-09-27 改答 LC-2：加四條規則〕docs/local-mode.md 10.22
    {
        id: 'trig_square_relation', from: TRIG_COMBINATION, to: RIGHT_TRIANGLE,
        source: '重練與收尾決策單 K3（選 1）＋Owner 2026-09-27 改答 LC-2 規則 1：題幹的三角運算只有 sin²θ＋cos²θ＝1 這類平方關係（沒有和角、差角、倍角、疊合）的，歸第二冊直角三角形的邊角關係（classify.v2 數學規則 7）',
        test: squareRelationEvidence
    },
    {
        id: 'general_angle', from: RIGHT_TRIANGLE, to: GENERAL_ANGLE,
        source: 'Owner 2026-09-27 改答 LC-2 規則 2：求三角函數值的角度大於 90° 或小於 0° 屬廣義角（CHAPTER_RELABEL 第 0 節：廣義角與同界角、參考角與象限正負號）',
        test: generalAngleEvidence
    },
    {
        id: 'friction_coefficient', from: NEWTON_LAWS, to: FRICTION_CENTRIPETAL,
        source: 'Owner 2026-09-27 改答 LC-2 規則 3：物理題幹出現摩擦係數（μ、摩擦係數、動摩擦、靜摩擦）的，歸摩擦力與向心力（知識點 PHYS.摩擦力與向心力.01～.03）',
        test: frictionCoefficientEvidence
    },
    {
        id: 'circular_kinematics', from: FRICTION_CENTRIPETAL, to: PLANAR_MOTION,
        source: 'Owner 2026-09-27 改答 LC-2 規則 4：等速圓周運動只問速率、速度方向、向心加速度等運動學量（不求向心力、張力、摩擦）的，歸平面運動（classify.v2 物理規則 6；CHAPTER_RELABEL 第 8.0 節、第 8.1 節 #46）',
        test: circularKinematicsEvidence
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
    coordinateTuples, dimensionEvidence, relativeMotionEvidence, freeFallComputationEvidence,
    // 〔Owner 2026-09-27 改答 LC-2〕
    normalizeTrigText, trigAngles, squareRelationEvidence, generalAngleEvidence,
    frictionCoefficientEvidence, circularKinematicsEvidence
};
