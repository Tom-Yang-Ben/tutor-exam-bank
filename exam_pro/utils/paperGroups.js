// ─────────────────────────────────────────────────────────────
// paperGroups.js — 組卷的承上題整組抽取（FR-019 PR2，ACPT-019-5）
//
// 問題：questions.follows_question_id（0008）把承上題綁到前題。組卷若逐題抽，
// 會抽到「承上題」卻沒有前題——學生拿到的是缺前情、根本寫不了的題。
//
// 規則（docs/interfaces-stage1.md 第 7 條〔修訂 2026-09-15g〕）：
//   1. 選題的單位是「組」：前題＋所有承接它的題（可多層鏈、可分岔），
//      以 follows_question_id 的無向連通分量界定；沒有綁定的題自成一組（1 題）。
//   2. **組內任一題不可用，整組不抽**。「不可用」＝不在候選池：已作答、在排除清單
//      （換這題）、已封存、題源不符、科目或章節與本次組卷不同。
//      理由：只抽得到其中幾題時，抽出來的就是孤兒承上題或缺後續的前題；
//      寧可少一組，不出寫不了的題。代價是「前題寫過、承上題沒寫過」的承上題
//      之後不會再被抽到（見 PR 描述「待 owner 決定」）。
//   3. 抽到就整組納入、組內依承接順序相鄰排列；計入題數時整組算多題。
//   4. 家族互斥（pickOnePerFamily）照舊：組的家族鍵取組首題；另外組內任一題的
//      家族若已被先選的組／題占用，這一組跳過——同一變式家族在一張卷仍至多一題。
//   5. 裝箱依洗牌順序、以子集和保證「有組合能剛好湊滿 N 題就一定湊滿」（packUnits）；
//      真的沒有任何組合湊得到 N 題時，取 ≤ N 的最大可達題數。此時怎麼辦由呼叫端的政策決定，
//      這裡只回報 actual／availableCount。
//
// 純函式：無 I/O、無時間、不讀 process.env；隨機性全經注入的 shuffleFn。
// 沒有任何承上綁定時，抽題結果與 shuffleFn 被呼叫的次數都與舊版
// 「pickOnePerFamily → slice(0, N) → sortForPaper」完全相同。
// ─────────────────────────────────────────────────────────────
const { shuffle } = require('./shuffle');
const { pickOnePerFamily } = require('./pickOnePerFamily');

/** 題型權重（sortForPaper 用；與 controllers/examController.js 歷來的權重相同）。 */
const TYPE_WEIGHTS = { '單選': 1, '多選': 2, '填空': 3, '計算': 4, '證明': 5 };

/**
 * 依 follows_question_id 把題目分組（無向連通分量），每組內依承接順序排列。
 * 只看 rows 裡的題：指向 rows 之外的邊忽略（該題在這批資料裡視為組首）。
 *
 * 組內順序：從組首（沒有前題、或前題不在本批）開始深度優先前序走訪；
 * 同一個前題有多個承上題時依 id 由小到大。資料若有環（DB 只擋自指，
 * 更長的環由 followUpLinker 的成環檢查擋），剩下沒走到的題依 id 補在後面，不會無窮迴圈。
 *
 * 組與組之間的順序＝各組第一次在 rows 中出現的順序（決定性）。
 *
 * @param {Array<{id:number, follows_question_id?:number|null}>} rows
 * @returns {number[][]} 每組的 id 陣列（承接順序）
 */
function groupFollowUps(rows) {
    const byId = new Map();
    for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);

    // union-find
    const parent = new Map();
    const find = (x) => {
        let root = x;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
        return root;
    };
    for (const id of byId.keys()) parent.set(id, id);
    for (const r of byId.values()) {
        const p = r.follows_question_id;
        if (p != null && byId.has(p)) {
            const a = find(r.id), b = find(p);
            if (a !== b) parent.set(a, b);
        }
    }

    const components = new Map();   // root → ids（保留第一次出現的順序）
    for (const id of byId.keys()) {
        const root = find(id);
        if (!components.has(root)) components.set(root, []);
        components.get(root).push(id);
    }

    const groups = [];
    for (const ids of components.values()) {
        if (ids.length === 1) { groups.push(ids); continue; }
        const member = new Set(ids);
        const children = new Map();
        const heads = [];
        for (const id of ids) {
            const p = byId.get(id).follows_question_id;
            if (p != null && member.has(p)) {
                if (!children.has(p)) children.set(p, []);
                children.get(p).push(id);
            } else {
                heads.push(id);
            }
        }
        for (const list of children.values()) list.sort((a, b) => a - b);
        heads.sort((a, b) => a - b);

        const ordered = [];
        const seen = new Set();
        const visit = (start) => {
            const stack = [start];
            while (stack.length) {
                const id = stack.pop();
                if (seen.has(id)) continue;
                seen.add(id);
                ordered.push(id);
                const kids = children.get(id) || [];
                for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
            }
        };
        heads.forEach(visit);
        for (const id of [...ids].sort((a, b) => a - b)) visit(id);   // 環：沒有組首可走到的題
        groups.push(ordered);
    }
    return groups;
}

/**
 * 以「組」為單位抽題。
 *
 * @param {object} p
 * @param {Array<{id:number, variant_of:number|null, follows_question_id:number|null}>} p.candidates
 *        候選池（已套用科目、章節、封存、已作答、排除清單、題源等全部條件）
 * @param {Array<{id:number, follows_question_id:number|null}>} p.related
 *        候選題所在的完整承上組（含不在候選池的成員）；只用來判斷「整組是否都可用」
 * @param {number} p.limitCount 要求題數
 * @param {(items:Array)=>Array} [p.shuffleFn]
 * @returns {{ ids:number[], actual:number, availableCount:number, minUnitSize:number|null,
 *             droppedGroups:number, unitSizes:number[] }}
 *   ids            抽中的題（組內已相鄰且依承接順序；組間順序待 sortForPaperGrouped 決定）
 *   actual         ids.length（≤ limitCount）
 *   availableCount 家族互斥後可用的總題數（「庫存不足」的 n）
 *   minUnitSize    家族互斥後最小的一組題數（沒有可用組時為 null）
 *   droppedGroups  因組內有題不可用而整組不抽的組數（僅供附註／除錯）
 *   unitSizes      家族互斥後每個可用組的題數（洗牌後順序；總和＝availableCount）。
 *                  〔Owner 決策單 2026-09-25 B10〕湊不滿時回 400，訊息要建議老師改成哪個題數，
 *                  呼叫端拿它給 nearestReachableCounts 算「剛好湊得滿」的題數
 */
function pickPaperUnits({ candidates, related = [], limitCount, shuffleFn = shuffle }) {
    const candById = new Map(candidates.map(c => [c.id, c]));
    const allRows = new Map();
    for (const r of related) allRows.set(r.id, r);
    for (const c of candidates) allRows.set(c.id, c);   // 候選池的欄位為準

    // 分組後再依候選池的原順序排組（組首題在候選池第一次出現的位置），
    // 讓「沒有任何綁定」時單位順序與候選池順序一致 → shuffleFn 看到的輸入與舊版相同。
    const groups = groupFollowUps([...candidates, ...related.filter(r => !candById.has(r.id))]);
    let droppedGroups = 0;
    const units = [];
    for (const ids of groups) {
        if (!ids.some(id => candById.has(id))) continue;          // 純 related、沒有候選題：不是這次的組
        if (!ids.every(id => candById.has(id))) { droppedGroups++; continue; }
        const familyKeys = ids.map(id => candById.get(id).variant_of ?? id);
        units.push({ ids, familyKeys, variant_of: familyKeys[0] });
    }

    // 家族互斥：組首的家族鍵當 pickOnePerFamily 的鍵（variant_of 恆非 null，所以鍵就是它）
    const reps = pickOnePerFamily(units, shuffleFn);

    // 組內其他題的家族可能與別組／別題相撞：先到先得
    const usedFamilies = new Set();
    const available = [];
    for (const u of reps) {
        if (u.familyKeys.some(k => usedFamilies.has(k))) continue;
        u.familyKeys.forEach(k => usedFamilies.add(k));
        available.push(u);
    }
    const availableCount = available.reduce((n, u) => n + u.ids.length, 0);
    const minUnitSize = available.length ? Math.min(...available.map(u => u.ids.length)) : null;

    const unitSizes = available.map(u => u.ids.length);
    const chosen = packUnits(unitSizes, limitCount);
    const ids = chosen.flatMap(i => available[i].ids);
    return { ids, actual: ids.length, availableCount, minUnitSize, droppedGroups, unitSizes };
}

/**
 * 「改成幾題就剛好湊得滿」（子集和）：〔Owner 決策單 2026-09-25 B10〕承上題整組湊不滿 limit 題時
 * 直接回 400，訊息要告訴老師把題數改成多少——這裡找離 limit 最近、由可用組剛好湊得出的兩個題數。
 *
 *   below  < limit 的最大可達題數（≥ 1）；沒有則 null。limit 本身湊不到時，它就是 packUnits 會抽的題數。
 *   above  > limit 的最小可達題數，且不超過 cap（組卷單次上限，blueprint 則是扣掉其他列後剩下的名額）；沒有則 null。
 *
 * 可達與否只看組的大小（家族互斥之後的可用組），與實際抽中哪幾組無關；
 * 家族互斥的代表是洗牌挑的，所以不同次呼叫的 sizes 可能略有不同，建議值以「這一次」為準。
 *
 * 複雜度 O(sizes.length × cap)；cap 為組卷題數上限，很小。
 *
 * @param {number[]} sizes 各組題數
 * @param {number} limit   要求題數
 * @param {number} cap     建議值的上限（含）
 * @returns {{below:number|null, above:number|null}}
 */
function nearestReachableCounts(sizes, limit, cap) {
    const max = Math.max(0, Math.min(cap, sizes.reduce((s, n) => s + n, 0)));
    const reach = new Array(max + 1).fill(false);
    reach[0] = true;
    for (const size of sizes) {
        if (!(size > 0)) continue;
        for (let s = max; s >= size; s--) if (reach[s - size]) reach[s] = true;
    }
    let below = null;
    for (let s = Math.min(limit - 1, max); s >= 1; s--) if (reach[s]) { below = s; break; }
    let above = null;
    for (let s = Math.max(limit + 1, 1); s <= max; s++) if (reach[s]) { above = s; break; }
    return { below, above };
}

/**
 * 整組裝箱（子集和）：從各組題數 sizes 挑一組子集，總和為「≤ limit 中可達的最大值」，
 * 同樣可達時依 sizes 的順序（＝洗牌後順序）優先收前面的組。
 *
 * 為什麼不用貪婪（塞得下就收）：組大小 [3,2,2]、要 4 題時貪婪先收 3 就卡住，
 * 其實 2＋2 剛好 4——會誤報「無法剛好湊滿」（'error' 政策下則是隨機 400）。
 * 貪婪能湊滿的情況，本函式挑出的組與貪婪完全相同（每一步「收得下且之後仍湊得到」
 * 由貪婪自己的後續選擇證明），所以沒有綁定（每組 1 題）時結果與舊版一致。
 *
 * 複雜度 O(sizes.length × limit)；limit 為組卷題數，很小。
 *
 * @param {number[]} sizes 各組題數（洗牌後順序）
 * @param {number} limit   要求題數
 * @returns {number[]} 選中的組在 sizes 裡的索引（遞增）
 */
function packUnits(sizes, limit) {
    const n = sizes.length;
    if (!(limit > 0) || n === 0) return [];
    // reach[i][s]：只用第 i 組（含）之後的組，能否剛好湊出 s 題
    const reach = Array.from({ length: n + 1 }, () => new Array(limit + 1).fill(false));
    reach[n][0] = true;
    for (let i = n - 1; i >= 0; i--) {
        const size = sizes[i];
        for (let s = 0; s <= limit; s++) {
            reach[i][s] = reach[i + 1][s] || (size <= s && reach[i + 1][s - size]);
        }
    }
    let target = limit;
    while (target > 0 && !reach[0][target]) target--;

    const chosen = [];
    let remaining = target;
    for (let i = 0; i < n && remaining > 0; i++) {
        if (sizes[i] <= remaining && reach[i + 1][remaining - sizes[i]]) {
            chosen.push(i);
            remaining -= sizes[i];
        }
    }
    return chosen;
}

/**
 * 考卷內排序：組為單位依「組首題」的題型權重 → 難度排（穩定排序），組內保持承接順序相鄰。
 * questions 須帶 follows_question_id；沒有任何綁定時結果與舊版 sortForPaper 相同。
 * @param {object[]} questions
 * @returns {object[]} 新陣列
 */
function sortForPaperGrouped(questions) {
    const byId = new Map(questions.map(q => [q.id, q]));
    const units = groupFollowUps(questions).map(ids => ids.map(id => byId.get(id)));
    units.sort((ua, ub) => {
        const a = ua[0], b = ub[0];
        const wA = TYPE_WEIGHTS[a.question_type] || 99;
        const wB = TYPE_WEIGHTS[b.question_type] || 99;
        if (wA !== wB) return wA - wB;
        return (a.difficulty || 3) - (b.difficulty || 3);
    });
    return units.flat();
}

module.exports = { groupFollowUps, pickPaperUnits, packUnits, nearestReachableCounts, sortForPaperGrouped, TYPE_WEIGHTS };
