// ─────────────────────────────────────────────────────────────
// controllers/paperController.js — 試卷明細與批改回填（P-04，擁有者：WS-A）
//
// 形狀與錯誤訊息**逐字**凍結於 docs/interfaces-stage3.md 第 1.3、1.4 條。
//
//   GET   /api/papers/:id            出題順序 + 每題目前的批改結果
//   PATCH /api/papers/:id/results    單一交易、全有全無地寫回作答
//
// 階段 5 WS-A（docs/interfaces-stage5.md 第 4.1 條第 1、2 項；DEC-015、缺口 G03）：
//   results[i] 另外接受 score／error_types／response／note 四個**可選**鍵（沒送就不動該欄），
//   GET 的 questions[] 多帶科目、章節、標準答案、詳解與批改細節。既有的六個 400 訊息、
//   檢查順序與 { updated } 的語意一個字都沒改；新規則的檢查一律排在既有檢查之後。
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
//
// 〔retrain PR-1〕migrations/0016 把 attempts 拆成 assignments（派題）與 attempt_records（作答）。
// 這兩支是「卷層」讀寫（設計稿 docs/retrain-and-review.md 第 2.3 節 C 類）：要的是這張卷上**所有**派題，
// 含日後的重練派題，所以 GET 改讀檢視 assignment_attempts、PATCH 改寫 attempt_records（經 assignments
// 以（卷, 題）對應，assignments_paper_question_key 保證一張卷同一題至多一筆派題）。
// 沒有重練資料時兩者讀寫到的列與拆表前的 attempts 完全相同：回應形狀、400 訊息、檢查順序、
// 全有全無與 { updated } 的語意都沒有變。
// ─────────────────────────────────────────────────────────────
const { query, pool } = require('../config/db');
const { ERROR_TYPE_CODES, MAX_ERROR_TYPES, isValidErrorType, labelOf } = require('../config/errorTypes');

/** 單次最多批改幾題（第 1.4 條凍結）。 */
const MAX_RESULTS = 100;

const PAPER_NOT_FOUND = '找不到該試卷';

/** 學生答案與老師註記的字數上限（migrations/0010 的 CHECK；第 4.1 條第 1 項）。 */
const MAX_TEXT_LEN = 500;

// ─────────────────────────── 純函式 ───────────────────────────

/**
 * 路徑上的 `:id` → 正整數，不合法回 null（與 studentController 同一套規則）。
 * @param {any} raw
 * @returns {number|null}
 */
function parseId(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    // 〔stage5 審查修正〕超過 int4 上限一律當不存在：交給 PG 會是 out of range 的 500
    if (!Number.isInteger(n) || n < 1 || n > INT4_MAX || String(n) !== s) return null;
    return n;
}

/** PostgreSQL INT（int4）的上限；students／exam_papers／questions 的 id 都是 INT */
const INT4_MAX = 2147483647;

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
 * 〔stage5 WS-A〕既有五條檢查之後，再逐列檢查 score／error_types／response／note
 * （parseDetail）。items 只帶「有送的」可選鍵。
 *
 * @returns {{ error:string } | { items: Array<{question_id:number, result:number|null,
 *            score?:number|null, error_types?:string[], response?:string|null, note?:string|null}> }}
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
    // 〔stage5 WS-A〕四個可選鍵：一律排在既有檢查之後，既有 body 的回應逐字不變。
    for (let i = 0; i < results.length; i++) {
        const detail = parseDetail(results[i], items[i].result);
        if (detail.error) return { error: detail.error };
        Object.assign(items[i], detail.value);
    }
    return { items };
}

/**
 * 以 Unicode code point 計字數（與 PG 的 char_length 同一把尺；JS 的 .length 會把罕用字算成 2）。
 * @param {string} s
 * @returns {number}
 */
function charLength(s) {
    return [...s].length;
}

/**
 * score 的值域：0～1、最多兩位小數（attempt_records.score 是 NUMERIC(3,2)）。
 *
 * 「最多兩位小數」不用 toFixed 比字串：0.29 * 100 = 28.999999999999996，
 * 用容差比對整數化後的差才不會把合法值擋掉。
 * @param {any} v
 * @returns {boolean}
 */
function isValidScore(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return false;
    const scaled = v * 100;
    return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

/**
 * 可為 null 的自由文字（response／note）：trim 後空字串視為 null（清空）。
 * @returns {{ ok:true, value:string|null } | { ok:false }}
 */
function optionalText(raw) {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false };
    const v = raw.trim();
    if (v === '') return { ok: true, value: null };
    if (charLength(v) > MAX_TEXT_LEN) return { ok: false };
    return { ok: true, value: v };
}

/**
 * 解析 results[i] 的四個可選鍵（第 4.1 條第 1 項）。
 *
 * 「有沒有送」看 hasOwnProperty，不看值：`note: null` 是「清空」，沒有 note 鍵是「不動」。
 * 回傳的 value 只含有送的鍵（has_* 旗標由組 SQL 的那一層依鍵是否存在決定）。
 *
 * 科目相依的規則（chem_equation 只能標化學題）要查 DB，不在這裡；
 * 見 patchResults 交易內的 subjectConflict。
 *
 * @param {object} row     results[i]（已確認是物件且 question_id、result 合法）
 * @param {0|1|null} result
 * @returns {{ error:string } | { value: object }}
 */
function parseDetail(row, result) {
    const has = k => Object.prototype.hasOwnProperty.call(row, k);
    const value = {};

    if (has('score')) {
        const v = row.score;
        if (v !== null && !isValidScore(v)) {
            return { error: 'score 必須是 0～1、最多兩位小數的數字，或 null。' };
        }
        if (v !== null && result === null) {
            return { error: 'score 只能搭配 result 為 0 或 1。' };
        }
        value.score = v;
    }

    if (has('error_types')) {
        const v = row.error_types === null ? [] : row.error_types;
        if (!Array.isArray(v)) return { error: 'error_types 必須是陣列或 null。' };
        const unknown = v.find(code => !isValidErrorType(code));
        if (unknown !== undefined) {
            return { error: `error_types 含有不在白名單內的代碼：${String(unknown)}。` };
        }
        if (new Set(v).size !== v.length) return { error: 'error_types 不可重複。' };
        if (v.length > MAX_ERROR_TYPES) return { error: `error_types 最多 ${MAX_ERROR_TYPES} 個。` };
        if (v.length > 0 && result !== 0) {
            return { error: 'error_types 只能在 result 為 0（答錯）時填寫。' };
        }
        // 存成白名單的順序：同一組錯因不論老師先點哪個，存進去都一樣，前端比對「有沒有改」才不會誤判
        value.error_types = ERROR_TYPE_CODES.filter(code => v.includes(code));
    }

    if (has('response')) {
        const r = optionalText(row.response);
        if (!r.ok) return { error: `response 必須是字串或 null，且不得超過 ${MAX_TEXT_LEN} 字。` };
        value.response = r.value;
    }

    if (has('note')) {
        const r = optionalText(row.note);
        if (!r.ok) return { error: `note 必須是字串或 null，且不得超過 ${MAX_TEXT_LEN} 字。` };
        value.note = r.value;
    }
    return { value };
}

/**
 * 找第一個「錯因與題目科目不相容」的題（例：chem_equation 標在數學題上）。
 *
 * @param {Array<{question_id:number, error_types?:string[]}>} items
 * @param {Map<number,string>} subjectOf question_id → 科目
 * @returns {{ question_id:number, subject:string, code:string } | null}
 */
function subjectConflict(items, subjectOf) {
    for (const it of items) {
        for (const code of it.error_types || []) {
            const subject = subjectOf.get(it.question_id);
            if (!isValidErrorType(code, subject)) return { question_id: it.question_id, subject, code };
        }
    }
    return null;
}

/**
 * 把解析後的 items 轉成 jsonb_to_recordset 吃的列。
 *
 * 為什麼改用 jsonb 而不是既有的「每欄一個陣列參數 + unnest」：error_types 本身是陣列，
 * PG 的多維陣列要求每一列等長，TEXT[][] 裝不下「這題 2 個錯因、那題 0 個」。
 * has_* 旗標把「沒送（不動）」與「送 null（清空）」分開——COALESCE 分不出這兩者。
 *
 * @param {Array<object>} items parseResultsBody 的輸出
 * @returns {Array<object>}
 */
function toRecordset(items) {
    const has = (it, k) => Object.prototype.hasOwnProperty.call(it, k);
    return items.map(it => ({
        question_id: it.question_id,
        result: it.result,
        has_score: has(it, 'score'),
        score: has(it, 'score') ? it.score : null,
        has_error_types: has(it, 'error_types'),
        error_types: has(it, 'error_types') ? it.error_types : [],
        has_response: has(it, 'response'),
        response: has(it, 'response') ? it.response : null,
        has_note: has(it, 'note'),
        note: has(it, 'note') ? it.note : null
    }));
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
        // 派題與作答用 LEFT JOIN：查不到對應列時 result 是 null（第 1.3 條），
        // 不是「這題不存在」。questions 用 INNER JOIN 是安全的——
        // 這張卷上的每一題都有派題，而 assignments.question_id 的
        // ON DELETE RESTRICT 保證那些題目刪不掉（0001_init.sql、0016）。
        // 〔retrain PR-1〕讀 assignment_attempts（全部派題，含重練），不是只含新題派題的檢視 attempts。
        //
        // 〔stage5 WS-A〕第 4.1 條第 2 項：多帶題目的科目、章節、標準答案、詳解與批改細節，
        // 批改卡才能「展開答案與詳解」、錯因 chip 才能依科目過濾。score 是 NUMERIC，
        // pg 預設回字串，這裡轉 float8；沒有派題列時 error_types 回 []（不是 null）。
        // solution_src 是契約以外多帶的一欄：批改卡要標示詳解是驗算模型產生還是老師寫的。
        const { rows: questions } = await query(
            `SELECT q.id AS question_id, q.question_text, q.question_type, q.difficulty, a.result,
                    q.subject, q.chapter, q.answer_text, q.solution_text, q.solution_src,
                    a.score::float8 AS score, COALESCE(a.error_types, '{}') AS error_types,
                    a.response, a.teacher_note
               FROM unnest($2::int[]) WITH ORDINALITY AS u(qid, ord)
               JOIN questions q ON q.id = u.qid
               LEFT JOIN assignment_attempts a ON a.paper_id = $1 AND a.question_id = u.qid
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

        // 〔stage5 WS-A〕錯因的科目限制（chem_equation 只能標化學題）要看題目的科目，
        // 所以放在交易內、題號都確認在卷上之後才查。只查有標錯因的題。
        const tagged = items.filter(it => (it.error_types || []).length > 0);
        if (tagged.length > 0) {
            const { rows: subjects } = await client.query(
                'SELECT id, subject FROM questions WHERE id = ANY($1::int[])',
                [tagged.map(it => it.question_id)]
            );
            const conflict = subjectConflict(tagged, new Map(subjects.map(r => [r.id, r.subject])));
            if (conflict) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `題目 ${conflict.question_id} 是${conflict.subject}題，不能標記「${labelOf(conflict.code)}」（${conflict.code}）。`
                });
            }
        }

        // 一句 UPDATE 打完，不逐題 round-trip：
        //   result 非 null → result = $v, graded_at = now()
        //   result 為 null → result = NULL, graded_at = NULL   （取消批改要把時間一起清掉）
        //
        // CASE 判的是「這一筆送來的值」而不是「欄位現值」。
        //
        // 〔stage5 WS-A〕四個批改細節欄（第 4.1 條第 1 項），SET 右邊的欄位一律是**舊值**：
        //   score        取消批改一併清掉；有送就覆寫；沒送不動
        //   error_types  result ≠ 0 時一律清空（只有答錯的題有錯因——改判成對時不清掉，
        //                面板會把「對的題」算進錯因分布）；result = 0 時有送就覆寫、沒送不動
        //   response／teacher_note  有送就覆寫（null＝清空），沒送不動；取消批改也保留
        //
        // 〔retrain PR-1〕寫的是作答表 attempt_records（別名仍是 a，SET 右邊的 a.* 照舊是舊值），
        // 經派題表 s 以（卷, 題）對應。每一筆派題在建立時就有一筆作答（writePaper、0016 的搬資料），
        // 題號在卷上卻沒有派題時照舊只是沒 UPDATE 到（updated 較少）。
        const updated = await client.query(
            `UPDATE attempt_records a
                SET result       = r.result,
                    graded_at    = CASE WHEN r.result IS NULL THEN NULL ELSE now() END,
                    score        = CASE WHEN r.result IS NULL THEN NULL
                                        WHEN r.has_score THEN r.score
                                        ELSE a.score END,
                    error_types  = CASE WHEN r.result IS DISTINCT FROM 0 THEN '{}'::text[]
                                        WHEN r.has_error_types THEN
                                             ARRAY(SELECT e.code
                                                     FROM jsonb_array_elements_text(r.error_types)
                                                          WITH ORDINALITY AS e(code, ord)
                                                    ORDER BY e.ord)
                                        ELSE a.error_types END,
                    response     = CASE WHEN r.has_response THEN r.response ELSE a.response END,
                    teacher_note = CASE WHEN r.has_note THEN r.note ELSE a.teacher_note END
               FROM assignments s,
                    jsonb_to_recordset($2::jsonb) AS r(
                        question_id int, result smallint,
                        has_score boolean, score numeric,
                        has_error_types boolean, error_types jsonb,
                        has_response boolean, response text,
                        has_note boolean, note text)
              WHERE s.id = a.assignment_id AND s.paper_id = $1 AND s.question_id = r.question_id`,
            [paperId, JSON.stringify(toRecordset(items))]
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
exports._internals = {
    parseId, parseResultsBody, MAX_RESULTS,
    // 〔stage5 WS-A〕
    parseDetail, isValidScore, subjectConflict, toRecordset, MAX_TEXT_LEN
};
