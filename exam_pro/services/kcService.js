// ─────────────────────────────────────────────────────────────
// services/kcService.js — 知識點的讀寫與種子檔載入（階段 5，擁有者：WS-C）
//
// 契約：docs/interfaces-stage5.md 第 4.3 條（API 形狀、載入規則）、第 3.4 條（欄位規則）、
//       第 2 條（knowledge_components／question_kcs／kc_prerequisites 三張表，migration 0012）。
//
// 分兩半：
//   上半部是**純函式**（參數驗證、排序鍵、載入計畫、環偵測）——不碰 DB，單元測試直接測。
//   下半部是**DB 函式**，第一個參數一律是 `db`（{ pool, query }，interfaces-stage1.md 第 8 條），
//   由呼叫端注入：controller 給 config/db，載入腳本的 --test 給測試庫連線，整合測試給測試庫。
//   本檔**不在頂層 require('../config/db')**——那一支缺 DATABASE_URL 就丟錯，
//   會讓純函式的單元測試無法載入本檔。
//
// 四條設計規則（理由見 docs/knowledge-components.md 與 ADR-011）：
//   1. 以 code 對照，不以自增 id 對照：種子檔、先備、AI 標註都用 code，id 只在 API 回應裡出現。
//   2. 科目與章節的順序一律來自白名單（utils/kcSeed.js 的 defaultChapters：config/chapters.js，
//      化學還沒併入時退回 config/chemistryChapters.js），不寫死任何科目。
//   3. 人工標註（src='human'）與 AI 標註（src='ai'）分權：PUT 以 human 取代全部；
//      自動標註遇到 human 就不動（services/kcTagService.js）。
//   4. 已審定（approved）的知識點，載入腳本不覆寫內容（除非 --force）；API 的 PATCH 是老師
//      親手改，不受這條限制。
// ─────────────────────────────────────────────────────────────

const {
    validateSeeds, defaultChapters, checkKcField, EDITABLE_FIELDS, STATUSES
} = require('../utils/kcSeed');

/** PUT /api/questions/:id/kcs 一題最多幾個知識點（第 4.3 條第 2 點） */
const MAX_QUESTION_KCS = 5;

// ─────────────────────────── 純函式 ───────────────────────────

/**
 * 路徑上的 `:id` → 正整數，不合法回 null（與 paperController 的 parseId 同一套規則：
 * '12abc'、'1.0'、' 12' 都不收）。
 * @param {any} raw
 * @returns {number|null}
 */
function parseId(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || String(n) !== s) return null;
    if (n > 2147483647) return null;   // INT 欄位：超出範圍的 id 查了也只會讓 PG 丟錯
    return n;
}

/**
 * 排序鍵：科目順序與「科目|章名」順序，都照白名單。
 * @param {Record<string,string[]>} chapters
 * @returns {{subjects:string[], chapterKeys:string[]}}
 */
function orderKeys(chapters) {
    const subjects = Object.keys(chapters);
    const chapterKeys = subjects.flatMap(s => (chapters[s] || []).map(c => `${s}|${c}`));
    return { subjects, chapterKeys };
}

/** 查詢字串的單值：沒給或空字串 → null；給了多個（?a=1&a=2）→ undefined（呼叫端回 400） */
function singleQueryValue(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    return s === '' ? null : s;
}

/**
 * 驗證 GET /api/kc 的查詢參數。
 * @param {object} query req.query
 * @param {Record<string,string[]>} chapters 章節白名單（defaultChapters()）
 * @returns {{error:string}|{subject:string|null, chapter:string|null, status:string|null}}
 */
function parseListQuery(query, chapters) {
    const q = query || {};
    const subject = singleQueryValue(q.subject);
    const chapter = singleQueryValue(q.chapter);
    const status = singleQueryValue(q.status);
    const subjects = Object.keys(chapters);

    if (subject === undefined || chapter === undefined || status === undefined) {
        return { error: 'subject、chapter、status 各只能給一個值。' };
    }
    if (subject !== null && !subjects.includes(subject)) {
        return { error: `subject 只接受 ${subjects.join('、')}。` };
    }
    if (chapter !== null) {
        const ok = subject !== null
            ? chapters[subject].includes(chapter)
            : subjects.some(s => chapters[s].includes(chapter));
        if (!ok) return { error: `chapter「${chapter}」不在${subject ?? ''}章節白名單內。` };
    }
    if (status !== null && !STATUSES.includes(status)) {
        return { error: 'status 只接受 draft 或 approved。' };
    }
    return { subject, chapter, status };
}

/**
 * 驗證 PATCH /api/kc/:id 的 body（第 4.3 條第 2 點；長度規則同第 3.4 條）。
 *
 * 不認得的鍵一律 400：前端把 spoken_text 拼成 spokenText 時，靜默略過會讓老師以為存好了。
 * @param {any} body
 * @returns {{error:string}|{fields:object}} fields 的字串已 trim
 */
function validateKcPatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body 必須是 JSON 物件。' };
    const keys = Object.keys(body);
    const unknown = keys.filter(k => !EDITABLE_FIELDS.includes(k));
    if (unknown.length) {
        return { error: `不接受的欄位：${unknown.join('、')}（可改的欄位：${EDITABLE_FIELDS.join('、')}）。` };
    }
    if (keys.length === 0) return { error: '沒有要更新的欄位。' };

    const fields = {};
    for (const key of EDITABLE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        const err = checkKcField(key, body[key]);
        if (err) return { error: `${err}。` };
        const v = body[key];
        fields[key] = typeof v === 'string' ? v.trim() : v;
    }
    return { fields };
}

/**
 * 驗證 PUT /api/questions/:id/kcs 的 body（第 4.3 條第 2 點）。
 * `weight` 沒給就是 1（與 DB 預設一致），給了必須落在 (0, 1]（與 DDL CHECK 一致）。
 * @param {any} body
 * @returns {{error:string}|{items:Array<{kc_id:number, weight:number}>}}
 */
function parseQuestionKcsBody(body) {
    const items = body && typeof body === 'object' ? body.items : undefined;
    if (!Array.isArray(items)) return { error: 'items 必須是陣列（0–5 個 { kc_id, weight? }）。' };
    if (items.length > MAX_QUESTION_KCS) return { error: `items 最多 ${MAX_QUESTION_KCS} 個。` };

    const out = [];
    const seen = new Set();
    for (const it of items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return { error: 'items 的每一項都必須是 { kc_id, weight? }。' };
        // 上限同 parseId：kc_id 是 INT 欄位，超出範圍的值送進 PG 只會變成 500
        if (!Number.isInteger(it.kc_id) || it.kc_id < 1 || it.kc_id > 2147483647) return { error: 'kc_id 必須是正整數。' };
        if (seen.has(it.kc_id)) return { error: 'items 內有重複的 kc_id。' };
        seen.add(it.kc_id);
        let weight = 1;
        if (it.weight !== undefined) {
            if (typeof it.weight !== 'number' || !Number.isFinite(it.weight) || it.weight <= 0 || it.weight > 1) {
                return { error: 'weight 必須是大於 0、不超過 1 的數字。' };
            }
            weight = it.weight;
        }
        out.push({ kc_id: it.kc_id, weight });
    }
    return { items: out };
}

/** 種子檔的一個知識點 → 要寫進 DB 的欄位（字串 trim；curriculum_code 缺值一律 null） */
function seedRowOf(component, subject) {
    const t = v => (typeof v === 'string' ? v.trim() : v);
    return {
        code: component.code,
        subject,
        chapter: component.chapter,
        name: t(component.name),
        curriculum_code: component.curriculum_code === undefined || component.curriculum_code === null
            ? null : t(component.curriculum_code),
        description: t(component.description),
        spoken_text: t(component.spoken_text),
        status: component.status,
        sort: component.sort
    };
}

/** 比對內容時看的欄位（code／subject／chapter 由 code 決定，不會變） */
const CONTENT_FIELDS = ['name', 'curriculum_code', 'description', 'spoken_text', 'status', 'sort'];

/**
 * 載入計畫：一個知識點要新增、更新、不變，還是因為已審定而保護起來（第 4.3 條第 1 點）。
 * @param {object} seedRow seedRowOf() 的輸出
 * @param {object|undefined} dbRow DB 現有的列（沒有就 undefined）
 * @param {{force?:boolean}} [opts]
 * @returns {'insert'|'update'|'unchanged'|'protected'}
 */
function planSeedUpsert(seedRow, dbRow, { force = false } = {}) {
    if (!dbRow) return 'insert';
    const same = CONTENT_FIELDS.every(f => (dbRow[f] ?? null) === (seedRow[f] ?? null));
    if (same) return 'unchanged';
    if (dbRow.status === 'approved' && !force) return 'protected';
    return 'update';
}

/**
 * 找先備關係裡的一個環（DFS 三色標記）。
 * @param {Array<[number|string, number|string]>} edges [知識點, 它的先備]
 * @returns {Array<number|string>|null} 環上的節點（首尾相同），沒有環回 null
 */
function findCycle(edges) {
    const adj = new Map();
    for (const [from, to] of edges || []) {
        if (!adj.has(from)) adj.set(from, []);
        adj.get(from).push(to);
    }
    const color = new Map();
    const stack = [];
    let found = null;

    function visit(node) {
        color.set(node, 1);
        stack.push(node);
        for (const next of adj.get(node) || []) {
            if (found) return;
            const c = color.get(next) || 0;
            if (c === 1) {
                found = [...stack.slice(stack.indexOf(next)), next];
                return;
            }
            if (c === 0) visit(next);
        }
        stack.pop();
        color.set(node, 2);
    }
    for (const node of adj.keys()) {
        if (found) break;
        if (!color.get(node)) visit(node);
    }
    return found;
}

// ─────────────────────────── SQL ───────────────────────────

/**
 * GET /api/kc 與單筆回讀共用的查詢。參數：
 *   $1 科目順序、$2「科目|章名」順序、$3 subject、$4 chapter、$5 status、$6 id（皆可為 NULL）
 *
 * question_count 只數**未封存**的題：封存的題在題庫管理看不到，算進去老師會對不上。
 * prereqs 的順序同樣照白名單，跨科的先備排在自己科目的位置。
 */
const LIST_SQL = `
SELECT kc.id, kc.code, kc.subject, kc.chapter, kc.name, kc.curriculum_code, kc.description,
       kc.spoken_text, kc.status, kc.sort,
       COALESCE(pr.prereqs, '[]'::json) AS prereqs,
       COALESCE(qc.n, 0)::int AS question_count
  FROM knowledge_components kc
  LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.name,
                                          'subject', p.subject, 'chapter', p.chapter)
                        ORDER BY array_position($1::text[], p.subject),
                                 array_position($2::text[], p.subject || '|' || p.chapter),
                                 p.sort, p.id) AS prereqs
          FROM kc_prerequisites kp
          JOIN knowledge_components p ON p.id = kp.prereq_kc_id
         WHERE kp.kc_id = kc.id
  ) pr ON true
  LEFT JOIN LATERAL (
        SELECT COUNT(*) AS n
          FROM question_kcs qk
          JOIN questions q ON q.id = qk.question_id
         WHERE qk.kc_id = kc.id AND q.archived_at IS NULL
  ) qc ON true
 WHERE ($3::text IS NULL OR kc.subject = $3)
   AND ($4::text IS NULL OR kc.chapter = $4)
   AND ($5::text IS NULL OR kc.status = $5)
   AND ($6::int IS NULL OR kc.id = $6)
 ORDER BY array_position($1::text[], kc.subject) NULLS LAST,
          array_position($2::text[], kc.subject || '|' || kc.chapter) NULLS LAST,
          kc.sort, kc.id`;

/**
 * PATCH 的 UPDATE 句（純函式）：只 SET 有給的欄位，並更新 updated_at。
 * @param {number} id
 * @param {object} fields validateKcPatch() 的 fields
 * @returns {{text:string, values:any[]}}
 */
function buildPatchSql(id, fields) {
    const sets = [];
    const values = [id];
    for (const key of EDITABLE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
        values.push(fields[key]);
        sets.push(`${key} = $${values.length}`);
    }
    sets.push('updated_at = now()');
    return {
        text: `UPDATE knowledge_components SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
        values
    };
}

const QUESTION_KCS_SQL = `
SELECT qk.kc_id, kc.code, kc.name, qk.weight, qk.src, qk.confidence
  FROM question_kcs qk
  JOIN knowledge_components kc ON kc.id = qk.kc_id
 WHERE qk.question_id = $1
 ORDER BY qk.weight DESC,
          array_position($2::text[], kc.subject || '|' || kc.chapter) NULLS LAST,
          kc.sort, kc.id`;

// ─────────────────────────── DB 函式 ───────────────────────────

/** 目前的章節白名單與排序鍵（每次呼叫都重讀：測試會換 CHAPTERS 之外的東西時不會吃到舊值） */
function whitelist() {
    const chapters = defaultChapters();
    return { chapters, ...orderKeys(chapters) };
}

/**
 * GET /api/kc 的資料。
 * @param {{query:Function}} db
 * @param {{subject?:string|null, chapter?:string|null, status?:string|null, id?:number|null}} [filter]
 * @returns {Promise<object[]>}
 */
async function listKcs(db, filter = {}) {
    const { subjects, chapterKeys } = whitelist();
    const { rows } = await db.query(LIST_SQL, [
        subjects, chapterKeys,
        filter.subject ?? null, filter.chapter ?? null, filter.status ?? null, filter.id ?? null
    ]);
    return rows;
}

/**
 * 單一知識點（形狀同 GET /api/kc 的一列），不存在回 null。
 * @returns {Promise<object|null>}
 */
async function getKc(db, id) {
    const rows = await listKcs(db, { id });
    return rows[0] || null;
}

/**
 * PATCH /api/kc/:id。
 * @returns {Promise<{status:200, item:object}|{status:400|404, message:string}>}
 */
async function patchKc(db, id, fields) {
    const { text, values } = buildPatchSql(id, fields);
    try {
        const { rows } = await db.query(text, values);
        if (rows.length === 0) return { status: 404, message: '找不到該知識點。' };
    } catch (err) {
        // UNIQUE (subject, chapter, name)：同一章不能有兩個同名知識點
        if (err && err.code === '23505') return { status: 400, message: '同一章已經有同名的知識點。' };
        throw err;
    }
    return { status: 200, item: await getKc(db, id) };
}

/**
 * GET /api/questions/:id/kcs。題目不存在回 null。
 * @param {{query:Function}} db
 * @param {number} questionId
 * @returns {Promise<{question:object, items:object[]}|null>}
 */
async function getQuestionKcs(db, questionId) {
    const { rows: [question] } = await db.query(
        `SELECT id, subject, chapter, question_type, difficulty, question_text,
                (archived_at IS NOT NULL) AS archived
           FROM questions WHERE id = $1`, [questionId]);
    if (!question) return null;
    const { chapterKeys } = whitelist();
    const { rows } = await db.query(QUESTION_KCS_SQL, [questionId, chapterKeys]);
    return { question, items: rows };
}

/**
 * PUT /api/questions/:id/kcs：以 src='human' 取代該題**全部**標註（含 AI 標的）。
 *
 * 科目一致性在伺服器端檢查（知識點必須與題目同科，可以不同章）。
 * 題目列用 FOR UPDATE 鎖住：與自動標註（kcTagService）同時寫同一題時，兩者排隊，
 * 不會出現「人工剛存好、AI 的交易又插進 ai 列」這種交錯。
 *
 * @param {{pool:{connect:Function}}} db
 * @param {number} questionId
 * @param {Array<{kc_id:number, weight:number}>} items parseQuestionKcsBody() 的輸出
 * @returns {Promise<{status:200, items:object[]}|{status:400|404, message:string}>}
 */
async function replaceQuestionKcs(db, questionId, items) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [question] } = await client.query(
            'SELECT id, subject FROM questions WHERE id = $1 FOR UPDATE', [questionId]);
        if (!question) {
            await client.query('ROLLBACK');
            return { status: 404, message: '找不到該題目。' };
        }

        const ids = items.map(i => i.kc_id);
        if (ids.length) {
            const { rows: kcs } = await client.query(
                'SELECT id, subject FROM knowledge_components WHERE id = ANY($1::int[])', [ids]);
            const byId = new Map(kcs.map(k => [k.id, k]));
            const missing = ids.filter(id => !byId.has(id));
            if (missing.length) {
                await client.query('ROLLBACK');
                return { status: 400, message: `找不到知識點：${missing.join('、')}。` };
            }
            const wrong = ids.filter(id => byId.get(id).subject !== question.subject);
            if (wrong.length) {
                await client.query('ROLLBACK');
                return {
                    status: 400,
                    message: `知識點必須與題目同科（題目是「${question.subject}」，知識點 ${wrong
                        .map(id => `${id} 是「${byId.get(id).subject}」`).join('、')}）。`
                };
            }
        }

        await client.query('DELETE FROM question_kcs WHERE question_id = $1', [questionId]);
        if (ids.length) {
            await client.query(
                `INSERT INTO question_kcs (question_id, kc_id, weight, src, confidence)
                 SELECT $1, k, w, 'human', NULL
                   FROM unnest($2::int[], $3::real[]) AS t(k, w)`,
                [questionId, ids, items.map(i => i.weight)]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
    const out = await getQuestionKcs(db, questionId);
    return { status: 200, items: out ? out.items : [] };
}

// ─────────────────────────── 種子檔載入（npm run kc:load）───────────────────────────

/**
 * 載入一批種子檔（第 4.3 條第 1 點）。整批一個交易；任何錯誤整批回滾。
 *
 * 步驟：
 *   1. validateSeeds（第 3.4 條）有 error → 整批拒絕，一列都不寫。
 *   2. 以 code upsert。已審定的列不覆寫內容（除非 force）。
 *      更新分兩段：先把要改的列 name 換成暫名、再寫真值——同章知識點互換名稱或整排位移時，
 *      逐列 UPDATE 會先撞到 UNIQUE (subject, chapter, name)。新增排在更新之後，理由相同。
 *   3. 先備關係以 src='ai' upsert；code 先在本批找、再到 DB 找，都找不到就整批回滾。
 *      未受保護的知識點，**本批沒有列出的 ai 先備會被移除**（內容組改了先備，舊的不能永遠留著）；
 *      human／curriculum 來源的先備一律不動。
 *   4. 寫完之後對 DB 全部先備關係再做一次環檢查（單檔載入時，跨科的環只有這裡看得到）。
 *   5. dryRun：以上全部照做，最後 ROLLBACK——數字與真的載入完全相同。
 *
 * 併發：讀現有列時 `FOR UPDATE`（依 id 排序上鎖）。載入計畫（更新／受保護）是依這份快照決定的，
 * 若不鎖，老師在載入途中按「審定通過」（PATCH），剛審定的內容會被當成草稿覆寫掉；鎖住之後
 * PATCH 會排隊到載入結束才生效。
 * 撞名：新名稱與「這次不會改到的列」（已審定受保護的列，或種子檔已沒有的舊列）同章同名時，
 * UNIQUE (subject, chapter, name) 會擋下；這裡把 PG 的 23505 翻成指出是哪一個知識點、撞到誰的
 * error，整批回滾（不再只丟出一行看不懂的 duplicate key）。
 *
 * @param {{pool:{connect:Function}}} db
 * @param {object[]} seeds 已 JSON.parse 的種子檔
 * @param {{force?:boolean, dryRun?:boolean, chapters?:Record<string,string[]>}} [opts]
 *        chapters 只給測試用（小型 fixture 不必涵蓋每一章）；CLI 一律用完整白名單。
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], stats:object, counts?:object}>}
 */
async function loadSeeds(db, seeds, opts = {}) {
    const force = Boolean(opts.force);
    const dryRun = Boolean(opts.dryRun);
    const { errors, warnings, stats } = validateSeeds(seeds, opts.chapters ? { chapters: opts.chapters } : {});
    if (errors.length) return { ok: false, errors, warnings, stats };

    const rows = seeds.flatMap(s => s.components.map(c => ({ seed: seedRowOf(c, s.subject), prereqs: c.prereqs || [] })));
    const codes = rows.map(r => r.seed.code);
    const subjects = seeds.map(s => s.subject);
    const counts = {
        inserted: 0, updated: 0, unchanged: 0, protected: 0,
        prereqInserted: 0, prereqRemoved: 0, orphans: 0
    };
    const fail = (msgs) => ({ ok: false, errors: msgs, warnings, stats, counts });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: existing } = await client.query(
            `SELECT id, code, name, curriculum_code, description, spoken_text, status, sort
               FROM knowledge_components WHERE code = ANY($1::text[])
              ORDER BY id FOR UPDATE`, [codes]);
        const dbByCode = new Map(existing.map(r => [r.code, r]));
        const idByCode = new Map(existing.map(r => [r.code, r.id]));
        const protectedCodes = new Set();

        const plans = rows.map(r => ({ ...r, plan: planSeedUpsert(r.seed, dbByCode.get(r.seed.code), { force }) }));
        const toUpdate = plans.filter(p => p.plan === 'update');

        // 2a. 要更新的列先換暫名（id 保證唯一；name 上限 60 字，暫名遠短於此）
        if (toUpdate.length) {
            await client.query(
                `UPDATE knowledge_components SET name = '__kc_tmp_' || id WHERE id = ANY($1::int[])`,
                [toUpdate.map(p => dbByCode.get(p.seed.code).id)]);
        }
        // 2b. 寫真值
        for (const p of plans) {
            if (p.plan === 'update') {
                const s = p.seed;
                await client.query(
                    `UPDATE knowledge_components
                        SET name = $2, curriculum_code = $3, description = $4, spoken_text = $5,
                            status = $6, sort = $7, updated_at = now()
                      WHERE id = $1`,
                    [idByCode.get(s.code), s.name, s.curriculum_code, s.description, s.spoken_text, s.status, s.sort])
                    .catch(tagSeedRow(s));
                counts.updated++;
            } else if (p.plan === 'unchanged') {
                counts.unchanged++;
            } else if (p.plan === 'protected') {
                counts.protected++;
                protectedCodes.add(p.seed.code);
            }
        }
        // 2c. 新增
        for (const p of plans) {
            if (p.plan !== 'insert') continue;
            const s = p.seed;
            const { rows: [ins] } = await client.query(
                `INSERT INTO knowledge_components
                    (code, subject, chapter, name, curriculum_code, description, spoken_text, status, sort)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                [s.code, s.subject, s.chapter, s.name, s.curriculum_code, s.description, s.spoken_text, s.status, s.sort])
                .catch(tagSeedRow(s));
            idByCode.set(s.code, ins.id);
            counts.inserted++;
        }

        // 3. 先備：本批解析不到的 code 到 DB 找
        const wanted = [...new Set(rows.flatMap(r => r.prereqs))].filter(c => !idByCode.has(c));
        if (wanted.length) {
            const { rows: found } = await client.query(
                'SELECT id, code FROM knowledge_components WHERE code = ANY($1::text[])', [wanted]);
            for (const f of found) idByCode.set(f.code, f.id);
        }
        const unresolved = wanted.filter(c => !idByCode.has(c));
        if (unresolved.length) {
            await client.query('ROLLBACK');
            return fail(unresolved.slice(0, 50).map(c => `先備 ${c} 在本批與資料庫中都找不到（請先載入該科的種子檔）`));
        }

        for (const r of rows) {
            const kcId = idByCode.get(r.seed.code);
            const preIds = [...new Set(r.prereqs.map(c => idByCode.get(c)))];
            if (!protectedCodes.has(r.seed.code)) {
                const del = await client.query(
                    `DELETE FROM kc_prerequisites
                      WHERE kc_id = $1 AND src = 'ai' AND NOT (prereq_kc_id = ANY($2::int[]))`,
                    [kcId, preIds]);
                counts.prereqRemoved += del.rowCount || 0;
            }
            if (preIds.length) {
                const ins = await client.query(
                    `INSERT INTO kc_prerequisites (kc_id, prereq_kc_id, src)
                     SELECT $1, p, 'ai' FROM unnest($2::int[]) AS t(p)
                     ON CONFLICT (kc_id, prereq_kc_id) DO NOTHING`,
                    [kcId, preIds]);
                counts.prereqInserted += ins.rowCount || 0;
            }
        }

        // 4. DB 全體的環檢查
        const { rows: edges } = await client.query('SELECT kc_id, prereq_kc_id FROM kc_prerequisites');
        const cycle = findCycle(edges.map(e => [e.kc_id, e.prereq_kc_id]));
        if (cycle) {
            const { rows: named } = await client.query(
                'SELECT id, code FROM knowledge_components WHERE id = ANY($1::int[])', [cycle]);
            const codeOf = new Map(named.map(n => [n.id, n.code]));
            await client.query('ROLLBACK');
            return fail([`先備關係有環（與資料庫既有的先備合併後）：${cycle.map(id => codeOf.get(id) || id).join(' → ')}`]);
        }

        // DB 有、種子檔沒有的知識點（同科）：不刪（可能已有題目標到它），只回報
        const { rows: [orphan] } = await client.query(
            `SELECT COUNT(*)::int AS n FROM knowledge_components
              WHERE subject = ANY($1::text[]) AND NOT (code = ANY($2::text[]))`, [subjects, codes]);
        counts.orphans = orphan.n;

        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        if (err && err.code === '23505' && err.kcSeedRow) {
            return fail([await describeUniqueConflict(client, err.kcSeedRow, err, { force, codes })]);
        }
        throw err;
    } finally {
        client.release();
    }
    return { ok: true, errors: [], warnings, stats, counts };
}

/** 寫入知識點失敗時，把「正在寫哪一列」掛在例外上，讓 loadSeeds 的 catch 能指名道姓（原例外照樣往上丟） */
function tagSeedRow(seedRow) {
    return (err) => {
        if (err && typeof err === 'object') err.kcSeedRow = seedRow;
        throw err;
    };
}

/**
 * 23505 → 給老師看的一句話（loadSeeds 已 ROLLBACK 之後呼叫）。
 *
 * 回滾之後 DB 回到載入前的樣子，而撞到的那一列一定是「這次沒有要改的列」（受保護的已審定列，
 * 或種子檔已沒有的舊列——同一份種子檔內同章不會同名，validateSeeds 擋過了），所以回滾後
 * 還查得到它是誰。查詢本身失敗就退回不指名的版本，不讓錯誤訊息把原本的錯蓋掉。
 *
 * @param {{query:Function}} client
 * @param {object} s seedRowOf() 的輸出（撞名的那一列）
 * @param {Error & {constraint?:string}} err
 * @param {{force:boolean, codes:string[]}} ctx
 * @returns {Promise<string>}
 */
async function describeUniqueConflict(client, s, err, { force, codes }) {
    const where = `${s.code}（${s.subject}／${s.chapter}）`;
    if (err.constraint === 'knowledge_components_code_key') {
        return `${where}寫入時 code 已存在：可能有另一個 kc:load 同時在跑，請等它結束後再試一次。`;
    }
    let holder = null;
    try {
        const { rows } = await client.query(
            `SELECT code, status FROM knowledge_components
              WHERE subject = $1 AND chapter = $2 AND name = $3 AND code <> $4
              ORDER BY id LIMIT 1`, [s.subject, s.chapter, s.name, s.code]);
        holder = rows[0] || null;
    } catch { /* 查不到就不指名 */ }

    const head = `${where}的名稱「${s.name}」與同一章`;
    if (!holder) {
        return `${head}另一個知識點撞名（同一章的名稱不可重複），整批回滾。請改種子檔的名稱，或先在「知識點」分頁把資料庫裡那一條改名。`;
    }
    const inSeed = codes.includes(holder.code);
    const state = holder.status === 'approved' ? '已審定' : '草稿';
    const hint = inSeed && holder.status === 'approved' && !force
        ? `${holder.code} 是已審定的列，載入不覆寫它，資料庫裡保留的是它目前的名稱。要以種子檔為準覆寫它請加 --force；否則請改 ${s.code} 在種子檔裡的名稱。`
        : inSeed
            ? `請檢查種子檔裡 ${holder.code} 與 ${s.code} 的名稱。`
            : `${holder.code} 已不在這次的種子檔中（載入不會刪除它）。請先在「知識點」分頁把它改名，或改 ${s.code} 在種子檔裡的名稱。`;
    return `${head}的 ${holder.code}（${state}）撞名（同一章的名稱不可重複），整批回滾。${hint}`;
}

module.exports = {
    // 純函式
    parseId, orderKeys, parseListQuery, validateKcPatch, parseQuestionKcsBody,
    seedRowOf, planSeedUpsert, findCycle, buildPatchSql,
    // DB
    listKcs, getKc, patchKc, getQuestionKcs, replaceQuestionKcs, loadSeeds, whitelist,
    // 常數
    MAX_QUESTION_KCS, CONTENT_FIELDS, LIST_SQL, QUESTION_KCS_SQL
};