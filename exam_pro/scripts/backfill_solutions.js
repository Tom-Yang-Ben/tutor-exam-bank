// scripts/backfill_solutions.js — 回填既有題目的文字詳解（階段 5 WS-A；DEC-017、缺口 G05）
//
// 用法：
//   npm run solution:backfill                         對 DATABASE_URL 回填（整批一個交易）
//   npm run solution:backfill -- --dry-run            只算、不寫（交易內執行後 ROLLBACK），印出會回填幾題
//   npm run solution:backfill -- --limit 20           最多回填 20 題（先小批試跑）
//   node scripts/backfill_solutions.js --test         改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//   node scripts/backfill_solutions.js --report eval/local/solutions.json   另存報告
//
// 契約：docs/interfaces-stage5.md 第 4.1 條第 5 項。**不呼叫 LLM**：素材是管線 verify 節點
// 當初已經解出來、存在 job_questions.payload.verify.steps_summary 的逐步摘要，這支只是把它搬進
// questions.solution_text（solution_src = 'verify'）。判定規則與 save 節點共用同一支
// workers/jobRunner.js 的 buildSolutionFields：verify 判定一致（compare = 'agree'）且摘要非空。
//
// 安全規則（可以重複跑）：
//   1. 已經有詳解的題一律不動——teacher（老師寫的）絕不覆寫，verify／ai 也不重寫。
//      UPDATE 本身再加 `solution_text IS NULL`，跑的同時老師剛好存了詳解也不會被蓋掉。
//   2. 題幹或答案在入庫之後被改過（複核時老師修正、或事後在編輯視窗改過）的題不回填：
//      那份摘要解的是改之前的題目，貼上去可能是錯的詳解。這類題列為 edited，留給老師自己寫。
//   3. 一題對到多列 job_questions（例如重跑）時，取 id 最小、且可用的那一列。
//   4. 〔stage5 審查修正 S5-41〕老師在編輯視窗把既有詳解清空過的題（questions.solution_cleared_at
//      非 NULL）不回填：清空就是老師決定「這題不要這段詳解」，重跑回填不能把它原樣寫回來。
//      UPDATE 本身同樣帶 `solution_cleared_at IS NULL`。

const fs = require('fs');
const path = require('path');

const { buildSolutionFields, buildSaveFields } = require('../workers/jobRunner');

// ───────────────────────── 參數 ─────────────────────────

/**
 * @param {string[]} argv
 * @returns {{dryRun:boolean, limit:number|null, test:boolean, report:string|null, help:boolean}}
 */
function parseArgs(argv) {
    const args = { dryRun: false, limit: null, test: false, report: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--test') args.test = true;
        else if (a === '--limit') {
            const raw = argv[++i];
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 1 || String(n) !== String(raw)) {
                throw new Error('--limit 後面要接正整數');
            }
            args.limit = n;
        } else if (a === '--report') {
            args.report = argv[++i];
            if (!args.report) throw new Error('--report 後面要接檔案路徑');
        } else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--dry-run --limit N --test --report <檔案>`);
    }
    return args;
}

/** 與 scripts/backfill_follow_ups.js 同一套規則：--test 自建連線並檢查庫名以 _test 結尾 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');

    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 2 });
    return { pool, query: (text, values) => pool.query(text, values) };
}

// ───────────────────────── 純函式（單元測試釘的就是這幾支）─────────────────────────

/**
 * payload 為什麼**沒有**可用的詳解（buildSolutionFields 回 null 時才問）。只用來分類報告。
 * @param {object} payload
 * @returns {'no_verify'|'verify_skipped'|'not_agree'|'empty_steps'|'too_long'}
 */
function unusableReason(payload) {
    const v = payload && payload.verify;
    if (!v || typeof v !== 'object') return 'no_verify';
    if (v.skipped === true) return 'verify_skipped';
    if (v.compare !== 'agree') return 'not_agree';
    const text = typeof v.steps_summary === 'string' ? v.steps_summary.trim() : '';
    return text === '' ? 'empty_steps' : 'too_long';
}

/**
 * 題目入庫之後有沒有被改過題幹或答案。
 *
 * 入庫時（save 節點）寫進去的是 buildSaveFields(payload) 的題幹與答案、trim 過；
 * 答案是空字串時落成 '略'（與 save 節點同一條規則）。兩者都相同才算「沒改過」。
 *
 * @param {object} payload
 * @param {{question_text:string, answer_text:string}} current questions 的現值
 * @returns {boolean}
 */
function isEditedSinceSave(payload, current) {
    const f = buildSaveFields(payload);
    const stem = String(f.question_text || '').trim();
    const answer = String(f.answer_text || '').trim() || '略';
    return stem !== String(current.question_text || '').trim()
        || answer !== String(current.answer_text || '').trim();
}

/**
 * 決定哪些題要回填（不碰 DB）。
 *
 * @param {Array<{question_id:number, jq_id:number, payload:object, question_text:string,
 *                answer_text:string, solution_text:string|null, solution_src:string|null,
 *                solution_cleared_at?:Date|string|null}>} rows
 *        依 question_id、jq_id 遞增排好
 * @param {{limit?:number|null}} [opts]
 * @returns {{ scanned:number, updates:Array<{question_id:number, jq_id:number, solution_text:string}>,
 *             skipped:object, remaining:number }}
 *          remaining = 可回填、但因 --limit 這一輪沒寫的題數
 */
function planBackfill(rows, { limit = null } = {}) {
    const byQuestion = new Map();
    for (const r of rows) {
        if (!byQuestion.has(r.question_id)) byQuestion.set(r.question_id, []);
        byQuestion.get(r.question_id).push(r);
    }

    const skipped = {
        has_teacher: 0, has_verify: 0, has_ai: 0, cleared: 0,
        edited: 0, no_verify: 0, verify_skipped: 0, not_agree: 0, empty_steps: 0, too_long: 0
    };
    const updates = [];
    let remaining = 0;

    for (const [questionId, list] of byQuestion) {
        const head = list[0];
        if (head.solution_text !== null && head.solution_text !== undefined) {
            const key = `has_${head.solution_src}`;
            skipped[key in skipped ? key : 'has_ai'] += 1;
            continue;
        }
        if (head.solution_cleared_at !== null && head.solution_cleared_at !== undefined) {
            skipped.cleared += 1;
            continue;
        }

        let pick = null;
        let reason = null;
        for (const r of list) {
            const { solution_text } = buildSolutionFields(r.payload);
            if (solution_text === null) { reason = reason || unusableReason(r.payload); continue; }
            if (isEditedSinceSave(r.payload, r)) { reason = 'edited'; continue; }
            pick = { question_id: questionId, jq_id: r.jq_id, solution_text };
            break;
        }
        if (!pick) { skipped[reason] += 1; continue; }
        if (limit !== null && updates.length >= limit) { remaining += 1; continue; }
        updates.push(pick);
    }
    return { scanned: byQuestion.size, updates, skipped, remaining };
}

// ───────────────────────── 主流程 ─────────────────────────

/**
 * 回填本體（給 CLI 與整合測試共用）。
 *
 * 整批一個交易：寫到一半失敗就全部回滾，不會留下「回填了一半」的題庫。
 * dry-run 同樣在交易內把 UPDATE 真的跑一次再 ROLLBACK，報的「會回填」數字因此包含
 * `solution_text IS NULL` 這道閘門的效果，不是只看規劃。
 *
 * @param {{pool:{connect:Function}}} db
 * @param {{dryRun?:boolean, limit?:number|null}} [opts]
 * @returns {Promise<{dryRun:boolean, limit:number|null, scanned:number, updated:number,
 *                    question_ids:number[], skipped:object, remaining:number}>}
 */
async function backfill(db, { dryRun = false, limit = null } = {}) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT jq.question_id, jq.id AS jq_id, jq.payload,
                    q.question_text, q.answer_text, q.solution_text, q.solution_src, q.solution_cleared_at
               FROM job_questions jq JOIN questions q ON q.id = jq.question_id
              WHERE jq.question_id IS NOT NULL
              ORDER BY jq.question_id, jq.id`);
        const plan = planBackfill(rows.map(r => ({ ...r, jq_id: Number(r.jq_id) })), { limit });

        const written = [];
        for (const u of plan.updates) {
            const res = await client.query(
                `UPDATE questions SET solution_text = $2, solution_src = 'verify'
                  WHERE id = $1 AND solution_text IS NULL AND solution_cleared_at IS NULL`,
                [u.question_id, u.solution_text]);
            if (res.rowCount === 1) written.push(u.question_id);
        }
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        return {
            dryRun, limit, scanned: plan.scanned, updated: written.length, question_ids: written,
            skipped: plan.skipped, remaining: plan.remaining
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/** 報告的中文說明（CLI 印出用）。 */
const SKIP_LABELS = {
    has_teacher: '已有老師寫的詳解（不覆寫）',
    has_verify: '已有驗算詳解',
    has_ai: '已有 AI 詳解',
    cleared: '老師清空過詳解（不寫回）',
    edited: '入庫後題幹或答案被改過',
    no_verify: '沒有 verify 結果',
    verify_skipped: 'verify 跳過（證明題）',
    not_agree: 'verify 與答案不一致或無法判定',
    empty_steps: '解題摘要是空的',
    too_long: '解題摘要超過 4000 字'
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 23).join('\n'));
        return 0;
    }

    const db = resolveDb(args.test);
    const target = args.test ? 'TEST_DATABASE_URL（測試庫）' : 'DATABASE_URL（開發／正式庫）';
    console.log(`回填文字詳解 → ${target}${args.dryRun ? '（dry-run，交易內執行後回滾）' : ''}`
        + `${args.limit ? `，本輪最多 ${args.limit} 題` : ''}；不呼叫 LLM`);

    try {
        const report = await backfill(db, { dryRun: args.dryRun, limit: args.limit });
        const skippedTotal = Object.values(report.skipped).reduce((a, b) => a + b, 0);

        console.log('\n──────── 結果 ────────');
        console.log(`掃描 ${report.scanned} 題（有拆題紀錄的題）；${args.dryRun ? '將回填' : '已回填'} ${report.updated} 題；略過 ${skippedTotal} 題`
            + (report.remaining ? `；另有 ${report.remaining} 題可回填但超過 --limit，下一輪再跑` : ''));
        for (const [key, n] of Object.entries(report.skipped)) {
            if (n > 0) console.log(`  略過 ${String(n).padStart(4)} 題：${SKIP_LABELS[key]}`);
        }
        if (report.question_ids.length) {
            console.log(`  ${args.dryRun ? '將回填' : '已回填'}的題號：${report.question_ids.map(id => `#${id}`).join('、')}`);
        }

        if (args.report) {
            const out = path.resolve(args.report);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), target, ...report }, null, 2), 'utf8');
            console.log(`報告已寫入 ${out}`);
        }
    } finally {
        if (args.test) await db.pool.end();
    }
    return 0;
}

module.exports = { backfill, planBackfill, parseArgs, unusableReason, isEditedSinceSave, SKIP_LABELS };

if (require.main === module) {
    // .env 只在當 CLI 跑時載入：被單元測試 require 時不該把開發機的 DATABASE_URL 灌進測試行程
    require('dotenv').config({ quiet: true });
    main().then(code => process.exit(code)).catch(err => {
        console.error('❌ ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}
