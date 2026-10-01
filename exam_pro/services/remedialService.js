// ─────────────────────────────────────────────────────────────
// services/remedialService.js — 依弱點出補救卷（階段 5 WS-D；docs/interfaces-stage5.md 第 4.4 條第 2 項；DEC-016）
//
//   POST /api/students/:id/remedial-paper   **只產草稿、不寫入**；老師確認沿用既有的 POST /api/confirm-paper
//
// 流程（完整規則與給老師的說明見 docs/remedial.md）：
//
//   1. basis：該生在此科、時間窗內「有知識點標註的已批改題」≥ WEAKNESS_MIN_N（且至少 1 題）→ 'kc'；
//      否則退回 'chapter'。兩種單位都用 Wilson 下界（kcWeaknessService.rankUnits）由弱到強排序。
//   2. 配額：total × mix 以最大餘數法分成 remedial／prerequisite／extension 三桶，總和恰為 total。
//   3. 目標單位（只看時間窗內有批改的單位）：
//        remedial      最弱的 k 個，k = min(3, ⌈n/2⌉)（n＝有批改的單位數）；
//                      難度 ≤ ⌊該生在此單位答錯題的平均難度 + 1⌋（沒有答錯題時改用已批改題的平均難度）。
//        prerequisite  kc 基底：remedial 知識點的直接先備（kc_prerequisites），同科、不與 remedial 重複，最多 3 個；
//                      選基礎題（難度 ≤ 3）。chapter 基底沒有先備資料：配額併回 remedial 並寫進 notes。
//        extension     remedial 以外、mastery_lb 最高的最多 3 個；難度 ≥ ⌊已批改題平均難度⌋ + 1（上限 5）。
//      某桶有配額卻沒有任何目標單位時，配額併回 remedial 並寫進 notes（不悄悄少出）。
//      一桶的題數平均分給該桶的目標，餘數給排在前面的（remedial＝最弱的、extension＝最強的）。
//   4. 選題：全部目標依 remedial → prerequisite → extension 的順序交給 examController.pickByQuotas，
//      與 generate-paper 同一段候選池 SQL（未封存、該生沒寫過、同科、source_types）與
//      同一個 pickPaperUnits（家族互斥＋承上題整組）；跨目標不重複、家族互斥。
//   5. 不足量逐目標回報在 shortfalls，不自動拿別的單位補——補什麼由老師決定（可用題目 ID 加題）。
//   6. items 每題帶 follows_question_id 與 group_ids（同一承上組在草稿裡的全部成員，承接順序），
//      前端據此「整組刪、整組加」，不會把承上題和它的前題拆開（confirm-paper 也會整組檢查，〔Owner 決策單 2026-09-25 B7〕）。
//
// 另有 lookupItems（GET /api/students/:id/remedial-paper/items）：草稿「用題目 ID 加題」前查題目資料與
// 所在承上組的完整成員（含封存、已寫過的旗標），讓前端能整組加入或拒絕（docs/remedial.md 第 2.5 節）。
//
// 純函式（allocateQuotas、splitCount、chooseUnits、choosePrereqTargets、buildPlan…）不連 DB、無隨機，
// 由 test/unit/remedialService.test.js 釘住；I/O 的 planRemedialPaper 由整合測試驗。
// ─────────────────────────────────────────────────────────────
const kcWeakness = require('./kcWeaknessService');
const { groupFollowUps } = require('../utils/paperGroups');

/** 契約第 4.4 條第 2 項的預設與區間。 */
const DEFAULT_TOTAL = 20;
const MIN_TOTAL = 5;
const MAX_TOTAL = 50;
const DEFAULT_DAYS = 90;
const DEFAULT_MIX = Object.freeze({ remedial: 0.6, prerequisite: 0.2, extension: 0.2 });
/** 三個桶的固定順序：配額分配的同分次序、選題次序、回應的分組次序都用它。 */
const BUCKETS = Object.freeze(['remedial', 'prerequisite', 'extension']);

const MAX_REMEDIAL_UNITS = 3;     // 契約：最弱的 1–3 個單位
const MAX_EXTENSION_UNITS = 3;
const MAX_PREREQ_TARGETS = 3;
const PREREQ_DIFFICULTY_MAX = 3;  // 先備題取基礎題（設計取捨，見 docs/remedial.md）
const PREVIEW_LEN = 80;           // question_text_preview 的長度（同助教 preview_paper）

// ───────────────────────── 純函式 ─────────────────────────

/**
 * 把 total 依 mix 分成三桶（最大餘數法）：先各取 floor，剩下的題數依小數部分由大到小補，
 * 小數部分相同時依 BUCKETS 順序（remedial 優先）。三桶總和恰為 total。
 *
 * @param {number} total 題數（正整數）
 * @param {{remedial:number, prerequisite:number, extension:number}} mix 非負、總和 > 0（呼叫端已驗證）
 * @returns {{remedial:number, prerequisite:number, extension:number}}
 */
function allocateQuotas(total, mix) {
    const sum = BUCKETS.reduce((s, b) => s + mix[b], 0);
    const exact = BUCKETS.map(b => (total * mix[b]) / sum);
    const counts = exact.map(Math.floor);
    let left = total - counts.reduce((s, n) => s + n, 0);
    const order = BUCKETS.map((b, i) => i)
        .sort((i, j) => (exact[j] - counts[j]) - (exact[i] - counts[i]) || i - j);
    for (const i of order) {
        if (left <= 0) break;
        counts[i]++;
        left--;
    }
    return Object.fromEntries(BUCKETS.map((b, i) => [b, counts[i]]));
}

/**
 * 把 count 平均分成 k 份，餘數給前面的（呼叫端把「優先的」排在前面）。
 * @param {number} count
 * @param {number} k
 * @returns {number[]} 長度 k；k ≤ 0 時為 []
 */
function splitCount(count, k) {
    if (!(k > 0)) return [];
    const base = Math.floor(count / k);
    const rem = count - base * k;
    return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * remedial 的難度上限：⌊答錯題平均難度 + 1⌋，沒有答錯題時用已批改題平均難度；夾在 1–5。
 * 兩者都沒有（不該發生：remedial 單位一定有批改）時回 null＝不限。
 * @param {{avg_wrong_difficulty?:number|null, avg_graded_difficulty?:number|null}} unit
 * @returns {number|null}
 */
function remedialDifficultyMax(unit) {
    const base = unit.avg_wrong_difficulty ?? unit.avg_graded_difficulty;
    if (base === null || base === undefined || !Number.isFinite(Number(base))) return null;
    return Math.min(5, Math.max(1, Math.floor(Number(base) + 1)));
}

/**
 * extension 的難度下限：⌊已批改題平均難度⌋ + 1，上限 5（「比他在這個單位寫過的難一點」）。
 * @param {{avg_graded_difficulty?:number|null}} unit
 * @returns {number|null}
 */
function extensionDifficultyMin(unit) {
    const base = unit.avg_graded_difficulty;
    if (base === null || base === undefined || !Number.isFinite(Number(base))) return null;
    return Math.min(5, Math.floor(Number(base)) + 1);
}

/**
 * 從已排序（mastery_lb 由低到高）的單位挑 remedial 與 extension 目標。
 * 只看 graded > 0 的單位（沒有批改＝不知道，不當弱點也不當強項）。
 *
 * @param {object[]} ranked kcWeaknessService.rankUnits 的輸出
 * @returns {{ remedial:object[], extension:object[] }}
 */
function chooseUnits(ranked) {
    const graded = ranked.filter(u => u.graded > 0 && u.mastery_lb !== null);
    const k = Math.min(MAX_REMEDIAL_UNITS, Math.ceil(graded.length / 2));
    const remedial = graded.slice(0, k);
    const extension = graded.slice(k)
        .slice()
        .sort((a, b) => (b.mastery_lb - a.mastery_lb) || (b.graded - a.graded))
        .slice(0, MAX_EXTENSION_UNITS);
    return { remedial, extension };
}

/**
 * 挑先備目標：依 remedial 知識點的順序（最弱的先），各自的直接先備依 strength 由高到低、code 由小到大。
 * 跳過：本身已是 remedial 目標、已挑過、不同科（補救卷限單科，寫進 skipped 供 notes 說明）。
 *
 * @param {object[]} remedialUnits kc 基底的 remedial 目標（需有 kc_id、name）
 * @param {Array<{kc_id:number, prereq_kc_id:number, code:string, name:string, subject:string,
 *                chapter:string, strength:number}>} prereqRows kc_prerequisites JOIN knowledge_components
 * @param {string} subject
 * @returns {{ targets:object[], skipped:object[] }}
 *          targets: [{ kc_id, code, name, chapter, for_code, for_name }]
 */
function choosePrereqTargets(remedialUnits, prereqRows, subject) {
    const remedialIds = new Set(remedialUnits.map(u => u.kc_id));
    const chosen = new Set();
    const skippedIds = new Set();
    const targets = [];
    const skipped = [];
    for (const u of remedialUnits) {
        const mine = prereqRows
            .filter(r => r.kc_id === u.kc_id)
            .sort((a, b) => (Number(b.strength) - Number(a.strength)) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
        for (const r of mine) {
            if (remedialIds.has(r.prereq_kc_id) || chosen.has(r.prereq_kc_id)) continue;
            if (r.subject !== subject) {
                if (!skippedIds.has(r.prereq_kc_id)) {
                    skippedIds.add(r.prereq_kc_id);
                    skipped.push({ code: r.code, name: r.name, subject: r.subject, for_name: u.name });
                }
                continue;
            }
            if (targets.length >= MAX_PREREQ_TARGETS) continue;
            chosen.add(r.prereq_kc_id);
            targets.push({ kc_id: r.prereq_kc_id, code: r.code, name: r.name, chapter: r.chapter, for_code: u.code, for_name: u.name });
        }
    }
    return { targets, skipped };
}

/** 顯示用數字：整數原樣，小數留一位（加權後的題數可能是小數）。 */
function fmtNum(x) {
    const n = Number(x);
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 顯示用百分比（mastery_lb 0~1 → 「12%」）。 */
function fmtPct(x) {
    return `${Math.round(Number(x) * 100)}%`;
}

/**
 * 契約的 target 物件。
 * @param {'kc'|'chapter'} type
 * @param {object} u 單位（kc：code、name、chapter；chapter：chapter）
 * @returns {{type:string, code?:string, chapter:string, name:string}}
 */
function targetOf(type, u) {
    return type === 'kc'
        ? { type: 'kc', code: u.code, chapter: u.chapter, name: u.name }
        : { type: 'chapter', chapter: u.chapter, name: u.chapter };
}

/**
 * 組出選題計畫（純函式）：每個目標一段配額，依 remedial → prerequisite → extension 排列。
 *
 * @param {object} p
 * @param {'kc'|'chapter'} p.basis
 * @param {number} p.total
 * @param {{remedial:number, prerequisite:number, extension:number}} p.mix
 * @param {object[]} p.ranked     rankUnits 的輸出（kc 基底為知識點、chapter 基底為章節，章節列須帶 chapter）
 * @param {object[]} [p.prereqRows] kc 基底時的先備列（見 choosePrereqTargets）
 * @param {string} p.subject
 * @returns {{ quotas: Array<{bucket:string, target:object, wanted:number, pool:object,
 *                            difficulty_min:number|null, difficulty_max:number|null, rationale:string}>,
 *             notes: string[], counts: object }}
 */
function buildPlan({ basis, total, mix, ranked, prereqRows = [], subject }) {
    const notes = [];
    const counts = allocateQuotas(total, mix);
    const { remedial: remUnits, extension: extUnits } = chooseUnits(ranked);

    if (remUnits.length === 0) {
        notes.push(`該生在${subject}、這段時間內沒有已批改的題，無法判斷弱點。請先到學生分頁批改最近的考卷，再產生補救卷。`);
        return { quotas: [], notes, counts };
    }

    let remCount = counts.remedial;
    let prereqTargets = [];
    if (basis === 'chapter') {
        if (counts.prerequisite > 0) {
            notes.push(`以章節為單位時沒有先備資料：先備配額 ${counts.prerequisite} 題併入補救。`);
            remCount += counts.prerequisite;
        }
    } else {
        const picked = choosePrereqTargets(remUnits, prereqRows, subject);
        prereqTargets = picked.targets;
        for (const s of picked.skipped) {
            notes.push(`「${s.for_name}」的先備知識點「${s.name}」屬於${s.subject}，補救卷限單科，未納入。`);
        }
        if (counts.prerequisite > 0 && prereqTargets.length === 0) {
            notes.push(`最弱的知識點沒有登錄同科的先備知識點：先備配額 ${counts.prerequisite} 題併入補救。`);
            remCount += counts.prerequisite;
        }
    }
    const extTargets = extUnits;
    if (counts.extension > 0 && extTargets.length === 0) {
        notes.push(`只有 ${remUnits.length} 個${basis === 'kc' ? '知識點' : '章節'}有批改紀錄，沒有其他單位可延伸：延伸配額 ${counts.extension} 題併入補救。`);
        remCount += counts.extension;
    }

    const quotas = [];
    const remSplit = splitCount(remCount, remUnits.length);
    remUnits.forEach((u, i) => {
        if (remSplit[i] <= 0) return;
        const dMax = remedialDifficultyMax(u);
        quotas.push({
            bucket: 'remedial',
            target: targetOf(basis, u),
            wanted: remSplit[i],
            pool: basis === 'kc' ? { kcIds: [u.kc_id], difficultyMax: dMax } : { chapters: [u.chapter], difficultyMax: dMax },
            difficulty_min: null,
            difficulty_max: dMax,
            rationale: `掌握度下界 ${fmtPct(u.mastery_lb)}（批改 ${fmtNum(u.graded)} 題、答對 ${fmtNum(u.correct)}）`
                + (dMax !== null ? `；選難度 ≤ ${dMax} 的題` : '')
        });
    });

    const preSplit = splitCount(prereqTargets.length ? counts.prerequisite : 0, prereqTargets.length);
    prereqTargets.forEach((t, i) => {
        if (preSplit[i] <= 0) return;
        quotas.push({
            bucket: 'prerequisite',
            target: targetOf('kc', t),
            wanted: preSplit[i],
            pool: { kcIds: [t.kc_id], difficultyMax: PREREQ_DIFFICULTY_MAX },
            difficulty_min: null,
            difficulty_max: PREREQ_DIFFICULTY_MAX,
            rationale: `「${t.for_name}」的先備知識點；選基礎題（難度 ≤ ${PREREQ_DIFFICULTY_MAX}）`
        });
    });

    const extSplit = splitCount(extTargets.length ? counts.extension : 0, extTargets.length);
    extTargets.forEach((u, i) => {
        if (extSplit[i] <= 0) return;
        const dMin = extensionDifficultyMin(u);
        quotas.push({
            bucket: 'extension',
            target: targetOf(basis, u),
            wanted: extSplit[i],
            pool: basis === 'kc' ? { kcIds: [u.kc_id], difficultyMin: dMin } : { chapters: [u.chapter], difficultyMin: dMin },
            difficulty_min: dMin,
            difficulty_max: null,
            rationale: `已相對掌握（掌握度下界 ${fmtPct(u.mastery_lb)}）`
                + (dMin !== null ? `；選難度 ≥ ${dMin} 的題` : '')
        });
    });

    return { quotas, notes, counts };
}

/**
 * 題幹預覽：壓掉連續空白，超過 n 字截斷加「…」。
 * @param {string|null} text
 * @param {number} [n]
 * @returns {string}
 */
function previewText(text, n = PREVIEW_LEN) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 每題所在承上組的成員（純函式）：依 follows_question_id 分組（utils/paperGroups.groupFollowUps，
 * 與組卷同一個分組函式），回 id → 該組全部 id（承接順序）。沒有綁定的題對應 [自己]。
 * 只看 rows 裡的題：指向 rows 之外的前題不算（該題在這批資料裡視為組首）。
 *
 * @param {Array<{id:number, follows_question_id?:number|null}>} rows
 * @returns {Map<number, number[]>}
 */
function groupIdsById(rows) {
    const out = new Map();
    for (const ids of groupFollowUps(rows)) for (const id of ids) out.set(id, ids);
    return out;
}

// ───────────────────────── SQL builder（純函式）─────────────────────────

/**
 * 章節基底的聚合（$1 studentId、$2 days、$3 subject，同 weaknessService 的凍結順序）。
 * 正確度 = COALESCE(score, result)；答錯題＝正確度 < 1。
 * @param {{studentId:number, days:number, subject:string}} opts
 * @returns {{text:string, values:any[]}}
 */
function buildChapterMastery({ studentId, days, subject }) {
    return {
        text: `SELECT q.chapter,
       COUNT(*) FILTER (WHERE a.result IS NOT NULL)::float8 AS graded,
       COALESCE(SUM(COALESCE(a.score::float8, a.result::float8)) FILTER (WHERE a.result IS NOT NULL), 0) AS correct,
       (AVG(q.difficulty) FILTER (WHERE a.result IS NOT NULL
                                    AND COALESCE(a.score::float8, a.result::float8) < 1))::float8 AS avg_wrong_difficulty,
       (AVG(q.difficulty) FILTER (WHERE a.result IS NOT NULL))::float8 AS avg_graded_difficulty
  FROM attempts a JOIN questions q ON q.id = a.question_id
 WHERE a.student_id = $1
   AND a.assigned_at >= CURRENT_DATE - $2::int
   AND ($3::text IS NULL OR q.subject = $3)
 GROUP BY q.chapter`,
        values: [studentId, days, subject]
    };
}

/**
 * 一組知識點的直接先備（含先備本身的科目，供跨科判斷）。
 * @param {number[]} kcIds
 * @returns {{text:string, values:any[]}}
 */
function buildPrereqQuery(kcIds) {
    return {
        text: `SELECT p.kc_id, p.prereq_kc_id, p.strength::float8 AS strength,
       k.code, k.name, k.subject, k.chapter
  FROM kc_prerequisites p JOIN knowledge_components k ON k.id = p.prereq_kc_id
 WHERE p.kc_id = ANY($1::int[])`,
        values: [kcIds]
    };
}

/**
 * 「用題目 ID 加題」前的查詢（$1 ids、$2 studentId）：題目本身＋所在承上組的全部成員。
 *
 * 承上組的走訪與 examController.fetchCandidatePool 同一段遞迴（無向走訪 follows_question_id：
 * 往下找承上題、往上找前題；UNION 去重，資料有環也會停）。這裡**不排除**封存題與已寫過的題——
 * 它們正是「這一組能不能加」要知道的事，改用 archived／answered 兩個旗標回報。
 * 不存在的 id 自然不會出現在結果裡。
 * confirm-paper 的承上題整組檢查也用這一段（〔Owner 決策單 2026-09-25 B7〕，controllers/examController.js）：
 * 改欄位時要保留 id、follows_question_id、archived、answered。
 *
 * @param {number[]} ids
 * @param {number} studentId
 * @returns {{text:string, values:any[]}}
 */
function buildItemLookupQuery(ids, studentId) {
    return {
        text: `WITH RECURSIVE grp(id) AS (
    SELECT unnest($1::int[])
    UNION
    SELECT CASE WHEN q.id = g.id THEN q.follows_question_id ELSE q.id END
      FROM questions q JOIN grp g
        ON q.follows_question_id = g.id
        OR (q.id = g.id AND q.follows_question_id IS NOT NULL)
)
SELECT q.id, q.subject, q.chapter, q.difficulty, q.question_text, q.follows_question_id,
       (q.archived_at IS NOT NULL) AS archived,
       EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.student_id = $2) AS answered
  FROM questions q JOIN grp g ON g.id = q.id`,
        values: [ids, studentId]
    };
}

// ───────────────────────── I/O ─────────────────────────

/** 正式環境的依賴（測試可整包替換）。 */
function defaultDeps() {
    const { query } = require('../config/db');
    const exam = require('../controllers/examController');
    return { query, pickByQuotas: exam.pickByQuotas, sortForPaper: exam.sortForPaper, shortfallReason: exam._blueprintInternals.shortfallReason };
}

/**
 * 產生補救卷草稿（只讀不寫）。
 *
 * @param {object} p
 * @param {number} p.studentId
 * @param {string} p.subject
 * @param {number} p.total
 * @param {{remedial:number, prerequisite:number, extension:number}} p.mix
 * @param {number} p.days
 * @param {string[]|null} p.sourceTypes
 * @param {number} p.minN WEAKNESS_MIN_N
 * @param {object} [deps]
 * @returns {Promise<object>} 契約第 4.4 條第 2 項的回應（不含 student_id／subject 以外的輸入回聲）
 */
async function planRemedialPaper({ studentId, subject, total, mix, days, sourceTypes, minN }, deps = defaultDeps()) {
    const kc = await kcWeakness.loadKcWeakness({ studentId, subject, days, minN }, deps);
    // WEAKNESS_MIN_N 可以設成 0：至少要 1 題有標註的已批改題才談得上知識點基底
    const basis = kc.taggedGraded >= Math.max(minN, 1) ? 'kc' : 'chapter';

    let ranked;
    let prereqRows = [];
    if (basis === 'kc') {
        ranked = kc.units.filter(u => u.subject === subject);
        const ids = ranked.filter(u => u.graded > 0).map(u => u.kc_id);
        if (ids.length) {
            const q = buildPrereqQuery(ids);
            ({ rows: prereqRows } = await deps.query(q.text, q.values));
        }
    } else {
        const q = buildChapterMastery({ studentId, days, subject });
        const { rows } = await deps.query(q.text, q.values);
        ranked = kcWeakness.rankUnits(rows.map(r => ({ ...r, name: r.chapter })), minN, u => u.chapter);
    }

    const plan = buildPlan({ basis, total, mix, ranked, prereqRows, subject });
    const notes = [...plan.notes];
    if (basis === 'chapter' && kc.taggedGraded > 0) {
        notes.unshift(`有知識點標註的已批改題只有 ${kc.taggedGraded} 題（少於 ${Math.max(minN, 1)}），先以章節為單位判斷弱點。`);
    }

    const results = plan.quotas.length
        ? await deps.pickByQuotas({
            studentId, subject, sourceTypes,
            quotas: plan.quotas.map(q => ({ count: q.wanted, pool: q.pool }))
        })
        : [];

    const allIds = results.flatMap(r => r.ids);
    let rowsById = new Map();
    let groupsById = new Map();
    let questionIds = [];
    if (allIds.length) {
        const { rows } = await deps.query(
            `SELECT id, question_text, question_type, difficulty, chapter, follows_question_id
               FROM questions WHERE id = ANY($1::int[])`,
            [allIds]
        );
        rowsById = new Map(rows.map(r => [r.id, r]));
        // pickPaperUnits 整組抽，所以草稿裡的承上組一定完整；group_ids 讓前端整組刪（不拆散前題與承上題）
        groupsById = groupIdsById(rows);
        // 與 confirm-paper 同一個排序函式：草稿的 question_ids 就是確認後的出題順序
        questionIds = deps.sortForPaper(rows).map(r => r.id);
    }

    const items = [];
    plan.quotas.forEach((q, i) => {
        for (const id of results[i].ids) {
            const row = rowsById.get(id) || {};
            items.push({
                question_id: id,
                bucket: q.bucket,
                target: q.target,
                chapter: row.chapter ?? null,
                difficulty: row.difficulty ?? null,
                question_text_preview: previewText(row.question_text),
                follows_question_id: row.follows_question_id ?? null,
                group_ids: groupsById.get(id) || [id]
            });
        }
    });

    const blueprint = plan.quotas.map((q, i) => ({
        bucket: q.bucket, target: q.target, wanted: q.wanted, got: results[i].got,
        difficulty_min: q.difficulty_min, difficulty_max: q.difficulty_max, rationale: q.rationale
    }));
    const shortfalls = plan.quotas
        .map((q, i) => ({ bucket: q.bucket, target: q.target, wanted: q.wanted, got: results[i].got,
            reason: deps.shortfallReason(results[i], q.wanted) }))
        .filter(s => s.got < s.wanted);
    if (plan.quotas.length && items.length < total) {
        notes.push(`本草稿實際 ${items.length} 題（要求 ${total} 題）。不足的部分可以用題目 ID 手動加題，或到「題庫覆蓋率」看哪一章該補題。`);
    }

    return { student_id: studentId, subject, basis, question_ids: questionIds, items, blueprint, shortfalls, notes };
}

/**
 * 查草稿要手動加的題（只讀）：每題的資料，以及它所在承上組的**全部**成員。
 *
 * 前端用它決定「整組加入」或「拒絕」：承上題要與前題整組出（同 generate-paper 的 pickPaperUnits），
 * confirm-paper 也用同一段查詢（buildItemLookupQuery）做伺服器端整組檢查（〔Owner 決策單 2026-09-25 B7〕），
 * 兩邊對「整組」與「封存／已寫過就不能出」的判斷一致。
 *
 * @param {{studentId:number, ids:number[]}} p
 * @param {{query:Function}} deps
 * @returns {Promise<{items:Array<{question_id:number, subject:string, chapter:string, difficulty:number,
 *           question_text_preview:string, follows_question_id:number|null, group_ids:number[],
 *           archived:boolean, answered:boolean}>, missing:number[]}>}
 *   items   依要求的順序，每題後面緊接同組的其他成員（組內承接順序），不重複
 *   missing 資料庫裡沒有的 id（依要求的順序）
 */
async function lookupItems({ studentId, ids }, deps) {
    const q = buildItemLookupQuery(ids, studentId);
    const { rows } = await deps.query(q.text, q.values);
    const byId = new Map(rows.map(r => [r.id, r]));
    const groups = groupIdsById(rows);

    const items = [];
    const seen = new Set();
    const missing = [];
    for (const id of ids) {
        if (!byId.has(id)) { missing.push(id); continue; }
        for (const member of groups.get(id)) {
            if (seen.has(member)) continue;
            seen.add(member);
            const r = byId.get(member);
            items.push({
                question_id: r.id,
                subject: r.subject,
                chapter: r.chapter,
                difficulty: r.difficulty,
                question_text_preview: previewText(r.question_text),
                follows_question_id: r.follows_question_id ?? null,
                group_ids: groups.get(member),
                archived: Boolean(r.archived),
                answered: Boolean(r.answered)
            });
        }
    }
    return { items, missing };
}

module.exports = {
    DEFAULT_TOTAL, MIN_TOTAL, MAX_TOTAL, DEFAULT_DAYS, DEFAULT_MIX, BUCKETS,
    MAX_REMEDIAL_UNITS, MAX_EXTENSION_UNITS, MAX_PREREQ_TARGETS, PREREQ_DIFFICULTY_MAX, PREVIEW_LEN,
    allocateQuotas,
    splitCount,
    remedialDifficultyMax,
    extensionDifficultyMin,
    chooseUnits,
    choosePrereqTargets,
    buildPlan,
    previewText,
    groupIdsById,
    buildChapterMastery,
    buildPrereqQuery,
    buildItemLookupQuery,
    planRemedialPaper,
    lookupItems
};
