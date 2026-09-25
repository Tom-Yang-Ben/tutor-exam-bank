// ─────────────────────────────────────────────────────────────
// controllers/studentAdminController.js — 學生管理（階段 4 W1-1，docs/roadmap-plan.md §6.2.1）
//
//   POST   /api/students             建立（唯一合法的「新學生」入口，裁決 S4-1）
//   PATCH  /api/students/:id         改名
//   DELETE /api/students/:id         刪除（連派題、作答與 exam_papers，一個交易）
//   POST   /api/students/:id/merge   併入另一位學生（處理「新題每生每題一次」的唯一鍵）
//
// 為什麼要有這一支：組卷原本「打名字自動建學生」——名字打得稍微不一樣就靜默分裂
// 不重複出題的紀錄（students 表曾出現「小」「名」「華」）。階段 4 把「建學生」變成
// 明確動作，組卷只能選既有學生；這裡的合併／刪除就是清理歷史分裂的工具。
//
// 四支全部掛在核心區（不在 FEATURE_STUDENTS 旗標內）：組卷是核心功能，
// 它依賴的學生管理不該被一個展示用旗標關掉。
//
// 階段 5 WS-A（docs/interfaces-stage5.md 第 4.1 條第 4 項；DEC-017、缺口 G09）：
//   POST 與 PATCH 另外接受學生檔案六欄的任意子集（grade、track、target_exams、school、
//   textbook_version、note；白名單在 config/studentProfile.js）。PATCH 沒送的欄位不動，
//   name 也從「必填」變成「有送才改」——但只送 name 的既有請求，行為與訊息完全不變。
//   兩支的回應都帶回完整檔案（id、name 之後接六欄），前端不必再打一次清單。
//   另加 GET /api/student-profile-options（核心區，唯讀），前端表單的選項從這裡讀。
// ─────────────────────────────────────────────────────────────
const { pool, query } = require('../config/db');
const { PROFILE_FIELDS, parseProfile, profileOptions } = require('../config/studentProfile');
// 〔retrain PR-2〕刪學生、合併學生時的排程項目處理（docs/retrain-and-review.md 第 3.9 節）
const retrainService = require('../services/retrainService');

/** 〔stage5 審查修正〕PostgreSQL INT（int4）上限：超過的 id 在這裡擋成 400，不讓 PG 回 out of range 的 500 */
const INT4_MAX = 2147483647;

const STUDENT_NOT_FOUND = '找不到該學生';
/** students.name 沒有長度 DDL 限制，這裡給一個防呆上限（貼 UI 而不是貼資料庫）。 */
const MAX_NAME_LEN = 50;

/** @returns {string|null} trim 後的合法名字；不合法回 null */
function validName(raw) {
    const name = String(raw ?? '').trim();
    if (!name || name.length > MAX_NAME_LEN) return null;
    return name;
}

/** PG unique_violation */
const UNIQUE_VIOLATION = '23505';

/** 回應的欄位（id、name 之後接學生檔案六欄；順序同 GET /api/students 的後六欄）。 */
const RETURNING = `RETURNING id, name, ${PROFILE_FIELDS.join(', ')}`;

// ─────────────────── GET /api/student-profile-options（〔stage5 WS-A〕）───────────────────
// 前端學生檔案表單的選項。唯讀、純設定，不碰 DB。
exports.getProfileOptions = (req, res) => {
    res.status(200).json(profileOptions());
};

// ─────────────────── POST /api/students ───────────────────
exports.createStudent = async (req, res, next) => {
    const name = validName(req.body?.name);
    if (!name) return res.status(400).json({ message: `學生姓名必填，且長度不得超過 ${MAX_NAME_LEN} 字。` });
    // 〔stage5 WS-A〕檔案欄位可選；沒送的欄位走 DDL 預設（NULL／空陣列）
    const profile = parseProfile(req.body);
    if (profile.error) return res.status(400).json({ message: profile.error });
    const cols = ['name', ...Object.keys(profile.fields)];
    const values = [name, ...Object.values(profile.fields)];
    try {
        const { rows: [row] } = await query(
            `INSERT INTO students (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${RETURNING}`,
            values
        );
        res.status(201).json(row);
    } catch (err) {
        if (err.code === UNIQUE_VIOLATION) {
            return res.status(409).json({ message: `學生「${name}」已存在。` });
        }
        next(err);
    }
};

// ─────────────────── PATCH /api/students/:id ───────────────────
// 〔stage5 WS-A〕改名之外也改學生檔案：body 可以是 name 與六個檔案欄位的任意子集，沒送的不動。
// 有送 name 時照舊驗證（同一句 400 訊息）；一個可改的欄位都沒送才回「至少要提供一個欄位」。
// 匯出名維持 renameStudent（routes/index.js 核心區那一行不動），另掛 updateStudent 別名。
exports.renameStudent = async (req, res, next) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1 || id > INT4_MAX) return res.status(400).json({ message: '學生 id 無效。' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
    const name = hasName ? validName(body.name) : null;
    if (hasName && !name) return res.status(400).json({ message: `學生姓名必填，且長度不得超過 ${MAX_NAME_LEN} 字。` });
    const profile = parseProfile(body);
    if (profile.error) return res.status(400).json({ message: profile.error });

    const sets = { ...(hasName ? { name } : {}), ...profile.fields };
    const cols = Object.keys(sets);
    if (cols.length === 0) {
        return res.status(400).json({
            message: `至少要提供一個要修改的欄位（name、${PROFILE_FIELDS.join('、')}）。`
        });
    }
    try {
        const { rows } = await query(
            `UPDATE students SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
              WHERE id = $${cols.length + 1} ${RETURNING}`,
            [...Object.values(sets), id]
        );
        if (rows.length === 0) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        res.status(200).json(rows[0]);
    } catch (err) {
        if (err.code === UNIQUE_VIOLATION) {
            return res.status(409).json({ message: `學生「${name}」已存在。` });
        }
        next(err);
    }
};

// ─────────────────── DELETE /api/students/:id ───────────────────
// 連同該生的派題（作答跟著 ON DELETE CASCADE）與 exam_papers 一起刪（順序：派題 → papers → student，
// 反著刪會撞 FK）。不可逆——UI 端要二次確認，這裡不再多問。
// 〔retrain PR-1〕migrations/0016 之後作答歷史在 assignments＋attempt_records（檢視 attempts 是唯讀的）。
// 一句 DELETE 刪掉該生**全部**派題（新題與重練一起，不會留下缺了新題派題的重練列）；
// 回應的 deleted.attempts 維持「刪掉幾筆派題」的語意（拆表前一筆 attempts＝一筆派題），
// 沒有重練資料時數字與拆表前相同（docs/retrain-and-review.md 第 3.9 節）。
// 〔retrain PR-2〕migrations/0017 之後同一交易依序刪：重練派題 → 排程項目 → 其餘派題 → 卷 → 學生
// （反著刪會撞 assignments_retrain_item_fk、retrain_items_source_fk 與 retrain_items.student_id 的外鍵）。
// deleted.attempts 仍是派題筆數（重練派題＋其餘派題）。
exports.deleteStudent = async (req, res, next) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1 || id > INT4_MAX) return res.status(400).json({ message: '學生 id 無效。' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const retrainRows = await retrainService.deleteStudentRetrainData(client, id);
        const a = await client.query('DELETE FROM assignments WHERE student_id = $1', [id]);
        const p = await client.query('DELETE FROM exam_papers WHERE student_id = $1', [id]);
        const s = await client.query('DELETE FROM students WHERE id = $1', [id]);
        if (s.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: STUDENT_NOT_FOUND });
        }
        await client.query('COMMIT');
        res.status(200).json({ deleted: { attempts: retrainRows + a.rowCount, papers: p.rowCount } });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};

// ─────────────────── POST /api/students/:id/merge ───────────────────
// 把 :id（來源）併入 into_id（目標）。「新題」派題每生每題一次（assignments_first_exposure_key）：
// 兩邊都寫過同一題時**保留目標側**（目標的批改紀錄比較可信——來源通常是打錯字
// 產生的分身），來源側那幾列直接刪除並計入 dropped_conflicts。
//
// 〔retrain PR-1〕docs/retrain-and-review.md 第 3.9 節：衝突看「目標側有沒有這一題的新題派題」；
// 衝突題在來源側的**全部**派題（新題與重練）與作答一起刪，這一題只留目標側的紀錄——
// 只刪來源側的新題派題會留下缺了「第一次」的重練列。其餘派題（含重練）整批搬到目標學生。
// moved_attempts／dropped_conflicts 是搬走／刪掉的派題筆數；沒有重練資料時與拆表前的
// attempts 筆數相同（一筆 attempts＝一筆新題派題）。
//
// 〔retrain PR-2〕排程項目（migrations/0017）跟著同一條規則：衝突題在來源側的項目一起刪，其餘項目搬到目標學生，
// 最後重算目標學生搬過來的項目。派題與項目的 student_id 要同時改，兩個複合外鍵在交易內
// SET CONSTRAINTS … DEFERRED，到 COMMIT 才檢查（services/retrainService.js 的 deferRetrainConstraints）。
// 回應的三個數字語意不變（派題筆數與卷數）。
exports.mergeStudent = async (req, res, next) => {
    const from = Number.parseInt(req.params.id, 10);
    const into = Number.parseInt(req.body?.into_id, 10);
    if (!Number.isInteger(from) || from < 1 || from > INT4_MAX) return res.status(400).json({ message: '學生 id 無效。' });
    if (!Number.isInteger(into) || into < 1 || into > INT4_MAX) return res.status(400).json({ message: 'into_id 無效。' });
    if (from === into) return res.status(400).json({ message: '不能把學生併入自己。' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // 兩位學生都要存在，訊息才分得出是誰不見了
        const { rows: found } = await client.query('SELECT id FROM students WHERE id = ANY($1::int[])', [[from, into]]);
        const ids = new Set(found.map(r => r.id));
        if (!ids.has(from) || !ids.has(into)) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: STUDENT_NOT_FOUND });
        }
        // 〔retrain PR-2〕派題與排程項目的 student_id 要一起改：兩個複合外鍵延到 COMMIT 才檢查
        await retrainService.deferRetrainConstraints(client);
        // ① 衝突題（目標已有這一題的新題派題）→ 刪來源側這一題的全部派題（作答跟著 CASCADE）
        const dropped = await client.query(
            `DELETE FROM assignments a
              WHERE a.student_id = $1
                AND EXISTS (SELECT 1 FROM assignments b
                             WHERE b.student_id = $2 AND b.question_id = a.question_id AND b.purpose = 'new')`,
            [from, into]
        );
        // 〔retrain PR-2〕排程項目：衝突題的來源側項目刪掉、其餘搬到目標。
        // 必須在②之前：「目標有沒有這一題的新題派題」只能看目標原本的派題（搬完再看，來源搬過去的也會算成衝突）。
        const movedItemQids = await retrainService.mergeRetrainItems(client, from, into);
        // ② 其餘搬家（衝突已排除，UPDATE 不會撞新題的部分唯一索引）
        const moved = await client.query(
            'UPDATE assignments SET student_id = $2 WHERE student_id = $1', [from, into]
        );
        // ③ 考卷搬家（exam_papers 沒有唯一鍵問題）
        const papers = await client.query(
            'UPDATE exam_papers SET student_id = $2 WHERE student_id = $1', [from, into]
        );
        // 〔retrain PR-2〕最後重算目標學生搬過來的項目（同一交易）
        await retrainService.recompute(client, into, movedItemQids);
        // ④ 刪來源學生
        await client.query('DELETE FROM students WHERE id = $1', [from]);
        await client.query('COMMIT');
        res.status(200).json({
            moved_attempts: moved.rowCount,
            dropped_conflicts: dropped.rowCount,
            moved_papers: papers.rowCount
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* 不覆蓋原始錯誤 */ }
        next(err);
    } finally {
        client.release();
    }
};

// 〔stage5 WS-A〕PATCH 現在不只改名，給一個名實相符的別名（路由仍掛 renameStudent）
exports.updateStudent = exports.renameStudent;
