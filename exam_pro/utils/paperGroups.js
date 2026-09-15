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
//   5. 湊不到剛好 N 題（剩的名額塞不下下一組）時怎麼辦由呼叫端的政策決定，
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
 *             droppedGroups:number }}
 *   ids            抽中的題（組內已相鄰且依承接順序；組間順序待 sortForPaperGrouped 決定）
 *   actual         ids.length（≤ limitCount）
 *   availableCount 家族互斥後可用的總題數（「庫存不足」的 n）
 *   minUnitSize    家族互斥後最小的一組題數（沒有可用組時為 null）
 *   droppedGroups  因組內有題不可用而整組不抽的組數（僅供附註／除錯）
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

    // 依洗牌後順序裝箱：塞得下就整組收、塞不下就看下一組；剛好滿就停
    const ids = [];
    for (const u of available) {
        if (ids.length === limitCount) break;
        if (ids.length + u.ids.length <= limitCount) ids.push(...u.ids);
    }
    return { ids, actual: ids.length, availableCount, minUnitSize, droppedGroups };
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

module.exports = { groupFollowUps, pickPaperUnits, sortForPaperGrouped, TYPE_WEIGHTS };
