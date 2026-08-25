// ─────────────────────────────────────────────────────────────
// controllers/paperController.js — 試卷明細與批改回填（P-04，擁有者：WS-A）
//
// 形狀與錯誤訊息**逐字**凍結於 docs/interfaces-stage3.md 第 1.3、1.4 條。
//
//   GET   /api/papers/:id            出題順序 + 每題目前的批改結果
//   PATCH /api/papers/:id/results    單一交易、全有全無地寫回 attempts
//
// 兩件事在這一層是硬規則：
//
//  1. **不排除已封存題**（裁決 S3-2、interfaces-stage1.md 第 12.3 條的同一條線）：
//     舊卷必須顯示得出全部題目。老師手上那張紙沒有因為題目被封存就少一題。
//
//  2. **PATCH 是全有全無**：任何一筆不合法就整包 400 並 ROLLBACK。
//     半套用的批改比完全沒批更難發現——老師以為存好了，面板卻只算到一半。
//     取消批改（result: null）要把 graded_at 一起清掉，否則面板會看到
//     「批改過但沒有結果」這種不存在的狀態。
// ─────────────────────────────────────────────────────────────
const { query, pool } = require('../config/db');

/** 單次最多批改幾題（第 1.4 條凍結）。 */
const MAX_RESULTS = 100;

const PAPER_NOT_FOUND = '找不到該試卷';

// ─────────────────────────── 純函式 ───────────────────────────

/**
 * 路徑上的 `:id` → 正整數，不合法回 null（與 studentController 同一套規則）。
 * @param {any} raw
 * @returns {number|null}
 */
function parseId(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || String(n) !== s) return null;
    return n;
}

/**
 * 驗證 PATCH 的 body（不碰 DB 的那一半）。
 *
 * 檢查順序照第 1.4 條表格的列順序走：非空陣列 → 100 筆上限 → 重複 →
 * question_id 型別 → result 值域。表格是這份契約唯一給出的順序訊號，
 * 就照它；同一份 body 同時違反兩條時，回哪一個訊息才不會隨實作漂移。
 *
 * 重複檢查放在型別檢查之前是刻意的：它比對的是使用者送來的原始值，
 * 不需要先確定那些值是正整數（送兩筆 'abc' 一樣是重複）。
 *
 * @param {any} body
 * @returns {{ error:string } | { items: Array<{question_id:number, result:number|null}> }}
 */
function parseResultsBody(body) {
    const results = body && body.results;
    if (!Array.isArray(results) || results.length === 0) {
        return { error: 'results 必須是非空陣列。' };
    }
    if (results.length > MAX_RESULTS) {
        return { error: `results 最多 ${MAX_RESULTS} 筆。` };
    }

    const seen = new Set();
    for (const row of results) {
        const key = JSON.stringify(row && typeof row === 'object' ? row.question_id : undefined);
        if (seen.has(key)) return { error: 'results 內有重複的 question_id。' };
        seen.add(key);
    }

    const items = [];
    for (const row of results) {
        const qid = row && typeof row === 'object' ? row.question_id : undefined;
        // 只收真正的正整數：'12' 這種字串也擋掉。JSON body 裡的題號本來就該是數字，
        // 放行字串等於把型別轉換的責任推給 Postgres，錯了才在 UPDATE 那一刻爆。
        if (!Number.isInteger(qid) || qid < 1) {
            return { error: 'question_id 必須是正整數。' };
        }
        items.push({ question_id: qid });
    }
    for (let i = 0; i < results.length; i++) {
        const value = results[i] && typeof results[i] === 'object' ? results[i].result : undefined;
        // undefined 也不接受：漏寫 result 與「明確要取消批改」是兩回事，
        // 前者多半是前端組 body 組錯了，靜默當成 null 會把老師批好的結果清掉。
        if (!(value === 0 || value === 1 || value === null)) {
            return { error: 'result 只接受 0、1 或 null。' };
        }
        items[i].result = value;
    }
    return { items };
}

// ─────────────────── 1.3 GET /api/papers/:id ───────────────────

exports.getPaper = async (req, res, next) => {
    const paperId = parseId(req.params.id);
    if (paperId === null) return res.status(404).json({ message: PAPER_NOT_FOUND });

    try {
        const { rows: [paper] } = await query(
            'SELECT id, title, student_id, created_at, question_ids FROM exam_papers WHERE id = $1',
            [paperId]
        );
        if (!paper) return res.status(404).json({ message: PAPER_NOT_FOUND });

        // questions 的順序 = question_ids 的**陣列順序**（出題順序），
        // 所以用 unnest(...) WITH ORDINALITY 帶出序號再 ORDER BY 它。
        // 直接 `WHERE id = ANY($1)` 會拿到資料庫喜歡的順序，那不是出題順序。
        //
        // attempts 用 LEFT JOIN：查不到對應列時 result 是 null（第 1.3 條），
        // 不是「這題不存在」。questions 用 INNER JOIN 是安全的——
        // 這張卷上的每一題都有 attempts 列，而 attempts.question_id 的
        // ON DELETE RESTRICT 保證那些題目刪不掉（0001_init.sql）。
        const { rows: questions } = await query(
            `SELECT q.id AS question_id, q.question_text, q.question_type, q.difficulty, a.result
               FROM unnest($2::int[]) WITH ORDINALITY AS u(qid, ord)
               JOIN questions q ON q.id = u.qid
               LEFT JOIN attempts a ON a.paper_id = $1 AND a.question_id = u.qid
              ORDER BY u.ord`,
            [paperId, paper.question_ids || []]
        );

        res.status(200).json({
            id: paper.id,
            title: paper.title,
            student_id: paper.student_id,
            created_at: paper.created_at,
            questions
        });
    } catch (err) {
        next(err);
    }
};

// ───────────── 1.4 PATCH /api/papers/:id/results ─────────────

exports.patchResults = async (req, res, next) => {
    const paperId = parseId(req.params.id);
    if (paperId === null) return res.status(404).json({ message: PAPER_NOT_FOUND });

    const parsed = parseResultsBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const { items } = parsed;

    const client = await pool.connect();
    try {
        // 「讀 question_ids → 驗題號 → 寫回」整段在同一個交易內。
        // 分開做的話，兩個老師同時批同一張卷時可能一邊讀到舊的 question_ids。
        await client.query('BEGIN');

        const { rows: [paper] } = await client.query(
            'SELECT question_ids FROM exam_papers WHERE id = $1',
            [paperId]
        );
        if (!paper) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: PAPER_NOT_FOUND });
        }

        const inPaper = new Set(paper.question_ids || []);
        const stray = items.find(it => !inPaper.has(it.question_id));
        if (stray) {
            await client.query('ROLLBACK');
            // 第一個不在 question_ids 內的題號（第 1.4 條）
            return res.status(400).json({ message: `題目 ${stray.question_id} 不在這張試卷內。` });
        }

        // 一句 UPDATE 打完，不逐題 round-trip：
        //   result 非 null → result = $v, graded_at = now()
        //   result 為 null → result = NULL, graded_at = NULL   （取消批改要把時間一起清掉）
        //
        // unnest 兩個陣列時 smallint[] 內的 null 會被 pg 序列化成 NULL，
        // 所以 CASE 判的是「這一筆送來的值」而不是「欄位現值」。
        const updated = await client.query(
            `UPDATE attempts a
                SET result    = r.result,
                    graded_at = CASE WHEN r.result IS NULL THEN NULL ELSE now() END
               FROM unnest($2::int[], $3::smallint[]) AS r(question_id, result)
              WHERE a.paper_id = $1 AND a.question_id = r.question_id`,
            [paperId, items.map(it => it.question_id), items.map(it => it.result)]
        );

        await client.query('COMMIT');
        // updated = 實際 UPDATE 到的列數；重送同樣的值也算數（第 1.4 條）
        res.status(200).json({ updated: updated.rowCount });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        next(err);
    } finally {
        client.release();
    }
};

// 給整合測試用（不對外掛成路由）
exports._internals = { parseId, parseResultsBody, MAX_RESULTS };
