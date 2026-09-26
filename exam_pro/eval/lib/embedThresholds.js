// ─────────────────────────────────────────────────────────────
// eval/lib/embedThresholds.js — 三個餘弦門檻的分布分析：純函式（npm run embed:thresholds）
//
// 〔Owner 決策單 2026-09-26 第四輪 V5〕換成本機 embedding（ollama:qwen3-embedding:0.6b）之後，
// VARIANT_RETRIEVE_SIM_MIN（0.80）、VARIANT_OFFTOPIC_SIM_MIN（0.90）、DEDUP_DUP_THRESHOLD（0.97；
// 另查 DEDUP_VARIANT_THRESHOLD 0.90）都還是照 Gemini 向量的分布定的（docs/variants.md 第 3 節）。
// 本檔是 eval/tools/embed_threshold_report.js 用到的計算，全部是純函式（不讀檔、不讀 env、不呼叫模型），
// 單元測試 test/unit/embedThresholds.test.js 釘住。
//
// 方法與 docs/variants.md 第 3 節相同：
//   - 題對依 fixture 的結構標註分四組（relationOf）：同概念換數字（同 variant_group）、同章不同概念、
//     跨章同科、跨科。fixture 的 `lookalike_of`（2D／3D 內積那幾對）照 3.1 的算法仍算「跨章同科」，
//     另外用 isLookalike 標出來，檢索那一段分開計。
//   - 門檻掃描的「跨章誤收率」照 3.2 的算法：分母是「不同章」的全部題對（跨章同科＋跨科）。
//     （3.2 表 0.80 → 0.1226 就是這樣算的：0.1226 × (675＋899) ≈ 193 對。）
//   - 百分位數用線性內插（R-7，與 numpy／Excel PERCENTILE.INC 相同）。
//
// 〔2026-09-26 審查修正〕另有兩組：
//   - 「JSON 跳脫吃掉 LaTeX 反斜線」（scanEscapeDamage、repairEscapeDamage、damagedStringFields）：
//     算「反斜線補回去之後文字閘門會不會擋」與各 agent 的 cassette 有幾支受損（docs/local-mode.md 10.12 第 4 點）；
//   - 生成題依「不同題幹」計數與 Claude 初判的分類（distinctGenerations、offtopicCategory、offtopicDistinctAt、
//     findLabel）：初判存在 eval/tools/embed_threshold_labels.json，以題幹 sha256 對上，重錄後對不上就算「未標註」。
//
// 本檔**不決定**門檻：候選值（equivalentThreshold、lowestCleanThreshold、justAbove）只是
// 「照某一條寫明的規則算出來的數字」，要不要採用由 Owner 裁決（docs/local-mode.md 10.12）。
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

/** 四組題對（docs/variants.md 3.1 的四列） */
const RELATIONS = Object.freeze(['same_concept', 'same_chapter', 'cross_chapter', 'cross_subject']);

const RELATION_LABELS = Object.freeze({
    same_concept: '同概念換數字（同 variant_group）',
    same_chapter: '同章不同概念',
    cross_chapter: '跨章同科',
    cross_subject: '跨科'
});

/** 檢索推薦出去的題屬於哪一種（跨章再分「fixture 標的 lookalike」與其他） */
const PICK_KINDS = Object.freeze(['same_concept', 'same_chapter', 'lookalike', 'cross_chapter', 'cross_subject']);

/** 兩個向量的餘弦（自己除範數；與 eval/lib/suiteVariant.js 的 cosine 同一個公式） */
function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return null;
    return dot / Math.sqrt(na * nb);
}

/**
 * 兩題的關係（docs/variants.md 3.1 的分組）。
 * @param {{subject:string, chapter:string, variant_group?:string}} a
 * @param {{subject:string, chapter:string, variant_group?:string}} b
 * @returns {'same_concept'|'same_chapter'|'cross_chapter'|'cross_subject'}
 */
function relationOf(a, b) {
    if (a.subject !== b.subject) return 'cross_subject';
    if (a.variant_group && a.variant_group === b.variant_group) return 'same_concept';
    if (a.chapter === b.chapter) return 'same_chapter';
    return 'cross_chapter';
}

/** fixture 標的「跨章字面相近」對照組：一題的 lookalike_of 指向另一題的 variant_group */
function isLookalike(a, b) {
    return Boolean((a.lookalike_of && a.lookalike_of === b.variant_group)
        || (b.lookalike_of && b.lookalike_of === a.variant_group));
}

/**
 * 百分位數（線性內插，R-7）。
 * @param {number[]} values 不必先排序
 * @param {number} p 0～1
 * @returns {number|null} 空陣列回 null
 */
function quantile(values, p) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const s = [...values].sort((x, y) => x - y);
    const pos = (s.length - 1) * Math.min(1, Math.max(0, p));
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * 分布摘要：min／p5／p25／p50／p75／p95／max。
 * @param {number[]} values
 * @returns {{n:number, min:number|null, p5:number|null, p25:number|null, p50:number|null,
 *            p75:number|null, p95:number|null, max:number|null}}
 */
function summarize(values) {
    const v = Array.isArray(values) ? values : [];
    return {
        n: v.length,
        min: v.length ? Math.min(...v) : null,
        p5: quantile(v, 0.05),
        p25: quantile(v, 0.25),
        p50: quantile(v, 0.5),
        p75: quantile(v, 0.75),
        p95: quantile(v, 0.95),
        max: v.length ? Math.max(...v) : null
    };
}

/**
 * 全部題對的餘弦與關係。只算兩題都有向量的題對；順序依 questions 的順序（i < j）。
 * @param {Array<object>} questions fixture 題
 * @param {(q:object)=>number[]|null} vectorOf
 * @returns {Array<{a:number, b:number, cos:number, relation:string, lookalike:boolean}>}
 */
function pairwise(questions, vectorOf) {
    const qs = questions.filter(q => Array.isArray(vectorOf(q)));
    const out = [];
    for (let i = 0; i < qs.length; i++) {
        for (let j = i + 1; j < qs.length; j++) {
            out.push({
                a: qs[i].id,
                b: qs[j].id,
                cos: cosine(vectorOf(qs[i]), vectorOf(qs[j])),
                relation: relationOf(qs[i], qs[j]),
                lookalike: isLookalike(qs[i], qs[j])
            });
        }
    }
    return out;
}

/**
 * 題對依關係分組，多一組 `different_chapter`＝跨章同科＋跨科（docs/variants.md 3.2「跨章誤收率」的分母）。
 * @param {Array<{cos:number, relation:string}>} pairs
 * @returns {Record<string, number[]>}
 */
function groupByRelation(pairs) {
    const g = Object.fromEntries([...RELATIONS, 'different_chapter'].map(r => [r, []]));
    for (const p of pairs) {
        g[p.relation].push(p.cos);
        if (p.relation === 'cross_chapter' || p.relation === 'cross_subject') g.different_chapter.push(p.cos);
    }
    return g;
}

/** 有幾個值 ≥ t（門檻的語意一律是「≥ 門檻算通過／算相似」，與程式相同） */
function countAtOrAbove(values, t) {
    let n = 0;
    for (const v of values) if (v >= t) n += 1;
    return n;
}

/** ≥ t 的比例；空陣列回 null */
function rateAtOrAbove(values, t) {
    return values.length ? countAtOrAbove(values, t) / values.length : null;
}

/**
 * 「等效門檻」：參考模型在 refT 時，某一組題對有 r 比例 ≥ refT；在目標模型上找一個門檻，
 * 讓同一組題對也差不多是 r 比例 ≥ 它（分位對應）。
 *
 * 做法：k＝round(r × 目標對數)；k＝0 → 沒有門檻能做到「一對都不收」以外的事，回 threshold=null、
 * 並給 aboveMax（目標的最大值，門檻要「高於它」）；否則門檻＝目標值由大到小第 k 個（恰好 ≥ k 對，同分時可能更多）。
 *
 * @param {number[]} refValues 參考模型（例：Gemini）的一組餘弦
 * @param {number} refT 參考模型現行門檻
 * @param {number[]} targetValues 目標模型（例：本機）同一組題對的餘弦
 * @returns {{refCount:number, refN:number, refRate:number|null, k:number, n:number,
 *            threshold:number|null, targetCount:number, aboveMax:number|null}}
 */
function equivalentThreshold(refValues, refT, targetValues) {
    const refN = refValues.length;
    const refCount = countAtOrAbove(refValues, refT);
    const refRate = refN ? refCount / refN : null;
    const n = targetValues.length;
    const desc = [...targetValues].sort((x, y) => y - x);
    const k = refRate === null ? 0 : Math.round(refRate * n);
    if (n === 0 || k === 0) {
        return { refCount, refN, refRate, k: 0, n, threshold: null, targetCount: 0, aboveMax: n ? desc[0] : null };
    }
    const threshold = desc[Math.min(k, n) - 1];
    return { refCount, refN, refRate, k, n, threshold, targetCount: countAtOrAbove(targetValues, threshold), aboveMax: null };
}

/**
 * 門檻格點（避免浮點累加誤差：一律以整數步進再除回去）。
 * @param {number} from
 * @param {number} to 含
 * @param {number} step
 * @returns {number[]}
 */
function thresholdGrid(from, to, step) {
    const scale = 10000;
    const a = Math.round(from * scale), b = Math.round(to * scale), s = Math.round(step * scale);
    if (!(s > 0) || a > b) return [];
    const out = [];
    for (let x = a; x <= b; x += s) out.push(x / scale);
    return out;
}

/** 「高於 x 的最小格點」：例 justAbove(0.99812, 0.001) → 0.999（用在「不擋任何換數字題」這一類規則） */
function justAbove(x, step = 0.001) {
    const scale = Math.round(1 / step);
    return (Math.floor(x * scale + 1e-9) + 1) / scale;
}

// ───────────────────────── 檢索（VARIANT_RETRIEVE_SIM_MIN） ─────────────────────────

/**
 * 某個藍本的一個候選屬於哪一種（推薦出去的是同概念、同章、fixture 標的 lookalike、還是其他跨章）。
 * @returns {'same_concept'|'same_chapter'|'lookalike'|'cross_chapter'|'cross_subject'}
 */
function pickKindOf(source, q) {
    const rel = relationOf(source, q);
    if (rel === 'cross_chapter' && isLookalike(source, q)) return 'lookalike';
    return rel;
}

/**
 * 門檻 t 時的覆蓋率與「推薦出去的前 minRetrieved 題」的組成。
 * 覆蓋＝≥ t 的候選至少 minRetrieved 題（與 eval/lib/suiteVariant.js 的 retrieved_coverage 同一條規則）。
 *
 * @param {Array<{id:string, minRetrieved:number, hits:Array<{id:number, cosine:number, kind:string}>}>} entries
 *        hits 已依餘弦由大到小排好（eval/lib/suiteVariant.js 的 retrieveInMemory 加上 pickKindOf）
 * @param {number} t
 * @returns {{t:number, covered:number, total:number, coverage:number|null, picks:Record<string,number>, coveredIds:string[]}}
 */
function coverageAt(entries, t) {
    const picks = Object.fromEntries(PICK_KINDS.map(k => [k, 0]));
    const coveredIds = [];
    for (const e of entries) {
        const hit = e.hits.filter(h => h.cosine >= t);
        const need = Number.isInteger(e.minRetrieved) && e.minRetrieved > 0 ? e.minRetrieved : 2;
        if (hit.length < need) continue;
        coveredIds.push(e.id);
        for (const h of hit.slice(0, need)) picks[h.kind] = (picks[h.kind] || 0) + 1;
    }
    return {
        t,
        covered: coveredIds.length,
        total: entries.length,
        coverage: entries.length ? coveredIds.length / entries.length : null,
        picks,
        coveredIds
    };
}

/**
 * 「推薦出去的題沒有一般跨章題」的最低門檻（fixture 標的 lookalike 不算：那是刻意放的 2D／3D 對照組，
 * 任何門檻都擋不掉——docs/variants.md 3.2 最後一段）。格點由小到大找第一個符合且至少覆蓋 1 個藍本的。
 * @returns {{t:number, covered:number, total:number, coverage:number|null, picks:object}|null}
 */
function lowestCleanThreshold(entries, grid) {
    for (const t of [...grid].sort((x, y) => x - y)) {
        const c = coverageAt(entries, t);
        if (c.covered > 0 && c.picks.cross_chapter === 0 && c.picks.cross_subject === 0) return c;
    }
    return null;
}

// ───────────────────────── 跑題檢查（VARIANT_OFFTOPIC_SIM_MIN） ─────────────────────────

/**
 * 已錄的生成題在門檻 t 下會怎樣。
 * @param {Array<{entryId:string, idx:number, status:string, sim?:number}>} gens
 *        status：'sim'（有跑題餘弦）、'text_gate'（文字閘門先擋下，沒有向量）、其他（schema_invalid、miss、no_cassette）
 * @param {number} t
 * @returns {{t:number, withSim:number, blocked:number, passed:number, entries:number, entriesNoneThrough:number}}
 *          entriesNoneThrough：這個藍本的生成題沒有一題同時過文字閘門與跑題（≥ t）
 */
function offtopicAt(gens, t) {
    const byEntry = new Map();
    let withSim = 0, blocked = 0, passed = 0;
    for (const g of gens) {
        if (!byEntry.has(g.entryId)) byEntry.set(g.entryId, false);
        if (g.status !== 'sim') continue;
        withSim += 1;
        if (g.sim >= t) { passed += 1; byEntry.set(g.entryId, true); } else blocked += 1;
    }
    let none = 0;
    for (const ok of byEntry.values()) if (!ok) none += 1;
    return { t, withSim, blocked, passed, entries: byEntry.size, entriesNoneThrough: none };
}

// ───────────────────────── 去重（DEDUP_DUP_THRESHOLD／DEDUP_VARIANT_THRESHOLD） ─────────────────────────

/** agents/dedup.js 的 runDedup1 判定（≥ dup → duplicate；≥ variant → variant；其餘 unique） */
function dedupVerdict(cos, dupTh, variantTh) {
    if (cos >= dupTh) return 'duplicate';
    if (cos >= variantTh) return 'variant';
    return 'unique';
}

/**
 * 題幹裡的數字（連續數字，含小數點），排序後回傳。只拿來判斷「兩題是不是同一組數字」這個粗略標記：
 * 同一組數字的兩題幾乎是同一題換句話說（重複候選）；不同數字就不是。LaTeX 的 10^{-6} 會拆成 10 與 6。
 * @param {string} text
 * @returns {string[]}
 */
function numberTokens(text) {
    return (String(text || '').match(/\d+(?:\.\d+)?/g) || []).sort();
}

/** 兩題的數字完全相同（且至少有一個數字） */
function sameNumbers(a, b) {
    const x = numberTokens(a), y = numberTokens(b);
    return x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * 報表用的三態：'same'（同一組數字）、'different'、'none'（兩題都沒有數字——觀念題，數字標記判斷不了）。
 * @returns {'same'|'different'|'none'}
 */
function numbersRelation(a, b) {
    if (numberTokens(a).length === 0 && numberTokens(b).length === 0) return 'none';
    return sameNumbers(a, b) ? 'same' : 'different';
}

/**
 * 文字裡有沒有「JSON 跳脫把 LaTeX 吃掉」的痕跡：模型在 JSON 字串裡寫 `\times`、`\theta`、`\boldsymbol`、`\frac`、
 * `\right` 沒有寫成 `\\times`，JSON.parse 會把 `\t`、`\b`、`\f`、`\r` 變成定位字元、退格、換頁、歸位字元
 * （`\n` 開頭的指令如 `\neq`、`\nu` 也會壞，但換行本來就合法，這裡不算，所以是**下限**）。
 */
function hasEscapeDamage(text) {
    return /[\t\x08\x0c\r]/.test(String(text || ''));
}

/** JSON 跳脫把 `\t`、`\b`、`\f`、`\r` 變成的控制字元 → 原本的字母 */
const ESCAPE_CONTROL = Object.freeze({ '\t': 't', '\x08': 'b', '\x0c': 'f', '\r': 'r' });

/**
 * 逐字掃描「JSON 跳脫吃掉的 LaTeX 反斜線」，同時產生補回反斜線的文字與壞掉的指令清單。
 * **只給分析用**（估計「反斜線修好之後」會怎樣）；產品的修補另有分支（`dec/latex-escape-repair`），規則不一定相同。
 *
 * 規則（保守：只補得出原字的地方）：
 *   - `\t`／`\b`／`\f`／`\r` 的控制字元**後面緊接英文字母** → 補回 `\` 與原字母（`\t`＋`imes` → `\times`）；
 *     後面不是字母的（例如真的定位字元）不動。
 *   - 換行字元只有在 `$…$` 裡面、而且後面緊接英文字母時才補回 `\n`（`\neq`、`\nu`、`\norm`）；
 *     數學式外的換行（選項之間）是合法的，不動。`\$` 不算數學式的開關。
 *
 * @param {string} text JSON.parse 之後的字串
 * @returns {{repaired:string, commands:string[]}} commands：依出現順序的壞掉指令（例 ['\\times', '\\text']）
 */
function scanEscapeDamage(text) {
    const s = String(text == null ? '' : text);
    let repaired = '';
    let inMath = false;
    const commands = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '$' && s[i - 1] !== '\\') { inMath = !inMath; repaired += ch; continue; }
        const letter = ESCAPE_CONTROL[ch] || (ch === '\n' && inMath ? 'n' : null);
        if (letter && /[A-Za-z]/.test(s[i + 1] || '')) {
            const rest = /^[A-Za-z]+/.exec(s.slice(i + 1))[0];
            commands.push(`\\${letter}${rest}`);
            repaired += `\\${letter}`;
            continue;
        }
        repaired += ch;
    }
    return { repaired, commands };
}

/** 補回反斜線之後的文字（scanEscapeDamage 的 repaired） */
function repairEscapeDamage(text) {
    return scanEscapeDamage(text).repaired;
}

/**
 * 一份 JSON（cassette 的 response.data）裡哪些字串欄位帶控制字元（hasEscapeDamage，下限）。
 * 陣列的索引不列出來（`a.b[0]` 記成 `a.b`），同一個欄位只記一次。
 * @param {*} value
 * @returns {string[]} 欄位路徑，依字母排序
 */
function damagedStringFields(value) {
    const out = new Set();
    const walk = (v, p) => {
        if (typeof v === 'string') { if (hasEscapeDamage(v)) out.add(p || '(字串)'); return; }
        if (Array.isArray(v)) { for (const x of v) walk(x, p); return; }
        if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], p ? `${p}.${k}` : k);
    };
    walk(value, '');
    return [...out].sort();
}

// ───────────────────────── 初判標註與「不同題幹」計數 ─────────────────────────

/** 文字的 sha256（小寫 hex）：初判標註用它對上題幹，重錄後題幹變了就對不上、算「未標註」 */
function textSha256(text) {
    return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/** 跑題表的分類（V5-2）：換了概念／同概念改寫／補回反斜線後文字閘門就擋／未標註 */
const OFFTOPIC_CATEGORIES = Object.freeze(['concept_changed', 'same_concept', 'gate_after_repair', 'unlabeled']);

/**
 * 在初判標註裡找這一題（藍本 id 與題幹 sha256 都要對上）。
 * @param {Array<{entry:string, sha256:string|string[], label:string}>} list
 * @param {string} entryId
 * @param {string|string[]} text 一段題幹；兄弟變式傳兩段（順序不拘）
 * @returns {object|null}
 */
function findLabel(list, entryId, text) {
    if (!Array.isArray(list)) return null;
    const want = (Array.isArray(text) ? text : [text]).map(textSha256).sort().join(',');
    for (const l of list) {
        if (!l || l.entry !== entryId) continue;
        const have = (Array.isArray(l.sha256) ? l.sha256 : [l.sha256]).map(String).sort().join(',');
        if (have === want) return l;
    }
    return null;
}

/**
 * 一題生成題在跑題表裡算哪一類：補回反斜線後文字閘門就擋的優先（那一題本來就到不了跑題檢查），
 * 其次是初判標註，都沒有就是未標註。
 * @param {{label?:string|null, gateAfterRepair?:{ok:boolean}|null}} g
 */
function offtopicCategory(g) {
    if (g && g.gateAfterRepair && g.gateAfterRepair.ok === false) return 'gate_after_repair';
    if (g && (g.label === 'concept_changed' || g.label === 'same_concept')) return g.label;
    return 'unlabeled';
}

/**
 * 有餘弦的生成題依「藍本＋題幹」去重（同一藍本兩題逐字相同只算一段；餘弦必定相同）。
 * @param {Array<{entryId:string, idx:number, status:string, text?:string}>} gens
 * @returns {Array<object>} 每段一筆：第一次出現的那一題，多一個 `gens`（例 ['var-003#1','var-003#2']）
 */
function distinctGenerations(gens) {
    const seen = new Map();
    for (const g of gens) {
        if (g.status !== 'sim') continue;
        const key = `${g.entryId}\u0000${g.text}`;
        if (seen.has(key)) { seen.get(key).gens.push(`${g.entryId}#${g.idx}`); continue; }
        seen.set(key, { ...g, gens: [`${g.entryId}#${g.idx}`] });
    }
    return [...seen.values()];
}

/**
 * 門檻 t 時「不同題幹」擋下幾段、各屬哪一類，放過的換了概念有幾段（V5-2 的表）。
 * @param {Array<{sim:number, category:string}>} items distinctGenerations 的結果加上 offtopicCategory
 * @param {number} t
 * @returns {{t:number, total:number, blocked:number, byCategory:Record<string,number>, passedChanged:number}}
 */
function offtopicDistinctAt(items, t) {
    const byCategory = Object.fromEntries(OFFTOPIC_CATEGORIES.map(c => [c, 0]));
    let blocked = 0, passedChanged = 0;
    for (const it of items) {
        if (it.sim < t) { blocked += 1; byCategory[it.category] = (byCategory[it.category] || 0) + 1; }
        else if (it.category === 'concept_changed') passedChanged += 1;
    }
    return { t, total: items.length, blocked, byCategory, passedChanged };
}

/**
 * 「補回反斜線後文字閘門就擋」的題改記成沒過文字閘門（status 'text_gate_after_repair'），
 * 給 offtopicAt 算「兩題都沒過的藍本」的補回後版本。餘弦沿用受損文字算的（沒有重錄就量不到新的）。
 */
function withGateAfterRepair(gens) {
    return gens.map(g => (g.status === 'sim' && g.gateAfterRepair && g.gateAfterRepair.ok === false
        ? { ...g, status: 'text_gate_after_repair' } : g));
}

// ───────────────────────── Markdown ─────────────────────────

/** 數字格式：null → '—' */
function fmt(x, digits = 4) {
    return (x === null || x === undefined || !Number.isFinite(x)) ? '—' : Number(x).toFixed(digits);
}

/** 百分比：0.1226 → '12.3%' */
function pct(x, digits = 1) {
    return (x === null || x === undefined || !Number.isFinite(x)) ? '—' : `${(x * 100).toFixed(digits)}%`;
}

/**
 * 表格儲存格：跳脫 `|`、把換行與控制字元變成看得見的樣子，超過 max 個字截斷。
 * 定位字元／退格／換頁照 JSON 的寫法顯示成 `\t`／`\b`／`\f`（讀起來就是模型原本想寫的 LaTeX 開頭）。
 */
function cell(text, max = 0) {
    let s = String(text == null ? '' : text)
        .replace(/\t/g, '\\t').replace(/\x08/g, '\\b').replace(/\x0c/g, '\\f').replace(/\r/g, '\\r')
        .replace(/\n+/g, ' ⏎ ')
        .replace(/\|/g, '\\|');
    if (max > 0 && [...s].length > max) s = [...s].slice(0, max).join('') + '…';
    return s;
}

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @param {string} [align] 每欄一個字元：'l' 靠左、'r' 靠右（預設第一欄靠左、其餘靠右）
 * @returns {string[]} 一行一個元素
 */
function mdTable(headers, rows, align) {
    const al = align || ('l' + 'r'.repeat(Math.max(0, headers.length - 1)));
    const sep = headers.map((_, i) => (al[i] === 'r' ? '---:' : '---'));
    return [
        `| ${headers.join(' | ')} |`,
        `|${sep.join('|')}|`,
        ...rows.map(r => `| ${r.join(' | ')} |`)
    ];
}

module.exports = {
    RELATIONS, RELATION_LABELS, PICK_KINDS,
    cosine, relationOf, isLookalike, quantile, summarize, pairwise, groupByRelation,
    countAtOrAbove, rateAtOrAbove, equivalentThreshold, thresholdGrid, justAbove,
    pickKindOf, coverageAt, lowestCleanThreshold,
    offtopicAt,
    dedupVerdict, numberTokens, sameNumbers, numbersRelation, hasEscapeDamage,
    ESCAPE_CONTROL, scanEscapeDamage, repairEscapeDamage, damagedStringFields,
    textSha256, OFFTOPIC_CATEGORIES, findLabel, offtopicCategory, distinctGenerations, offtopicDistinctAt, withGateAfterRepair,
    fmt, pct, cell, mdTable
};
