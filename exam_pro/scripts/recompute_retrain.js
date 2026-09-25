// scripts/recompute_retrain.js — 依目前的排程參數重算全部錯題重練項目（PR-2；docs/retrain-and-review.md 第 5.2 節）
//
// 用法：
//   npm run retrain:recompute                         重算 DATABASE_URL 上的全部項目
//   npm run retrain:recompute -- --dry-run            交易內跑完再 ROLLBACK，只印結果
//   npm run retrain:recompute -- --student 3          只重算這位學生的項目
//   npm run retrain:recompute -- --test               改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//
// 什麼時候用：Owner 改了 .env 的 RETRAIN_STEP_DAYS、RETRAIN_MASTERY_STREAK、RETRAIN_STUCK_LAPSES（第 5.1 節）並重啟之後，
// 跑一次讓清單上的到期日、關卡、練到會照新參數重排（排程是作答歷史的純函式，重算不會丟資料）。
//
// 行為：
//   - **只重算既有項目**的排程快取，**不建立任何項目**〔Owner 決策單 2026-09-26 R11 選 3：不補建；R1 選 2：進清單要老師勾〕。
//   - 全部在一個交易內（先鎖住項目再讀作答歷史，與批改同一套 services/retrainService.js 的 recomputeAll）；
//     --dry-run 跑完 ROLLBACK，不寫任何東西。
//   - 冪等：只 UPDATE 快取真的有變的列；參數沒變時再跑一次「更新 0 個項目」。
//   - 不呼叫 LLM、不需金鑰；輸出只有學生 id 與題數，不印學生姓名。

require('dotenv').config();
const fs = require('fs');

// ───────────────────────── 參數 ─────────────────────────

/**
 * @param {string[]} argv
 * @returns {{dryRun:boolean, test:boolean, studentId:number|null, help:boolean}}
 */
function parseArgs(argv) {
    const args = { dryRun: false, test: false, studentId: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--test') args.test = true;
        else if (a === '--student') {
            const raw = argv[++i];
            const n = Number(raw);
            if (raw === undefined || !/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 2147483647) {
                throw new Error('--student 後面要接學生 id（正整數）');
            }
            args.studentId = n;
        } else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--dry-run --student <id> --test`);
    }
    return args;
}

/**
 * 取得連線池：與 scripts/reindex_search_tsv.js 同一套規則。--test 時自建連線並沿用 migrate.js 的防呆。
 * @returns {{pool:object}}
 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');
    const { Pool } = require('pg');
    return { pool: new Pool({ connectionString: url, max: 2 }) };
}

// ───────────────────────── 核心 ─────────────────────────

/**
 * 重算（一個交易）。
 * @param {{pool:object, dryRun?:boolean, studentId?:number|null, params?:object}} opts
 * @returns {Promise<{total:number, updated:number, statuses:{active:number, mastered:number, retired:number},
 *                    students:number, dryRun:boolean}>}
 *   total＝重算了幾個項目；updated＝快取有變（正式跑時寫回、dry-run 時只算）的項目數；statuses＝重算後各狀態題數
 */
async function recomputeRetrain({ pool, dryRun = false, studentId = null, params } = {}) {
    const retrain = require('../services/retrainService');
    const { loadRetrainConfig } = require('../config/retrain');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const changes = await retrain.recomputeAll(client, { studentId, params: params || loadRetrainConfig() });
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        const statuses = { active: 0, mastered: 0, retired: 0 };
        let updated = 0;
        for (const c of changes) {
            statuses[c.after.status] += 1;
            if (['status', 'step', 'due_on', 'streak', 'lapses', 'last_attempt_on', 'mastered_on']
                .some(k => (c.before[k] ?? null) !== (c.after[k] ?? null))) updated += 1;
        }
        return { total: changes.length, updated, statuses, students: new Set(changes.map(c => c.student_id)).size, dryRun };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/**
 * 結果的文字報告（純函式）。
 * @param {Awaited<ReturnType<typeof recomputeRetrain>>} r
 * @param {{stepDays:ReadonlyArray<number>, masteryStreak:number, stuckLapses:number}} params
 * @returns {string[]}
 */
function formatReport(r, params) {
    return [
        `排程參數：每關間隔 ${params.stepDays.join(',')} 天、連對 ${params.masteryStreak} 次練到會、錯 ${params.stuckLapses} 次標卡關`,
        `重算 ${r.total} 個項目（${r.students} 位學生）；${r.dryRun ? '會更新' : '更新'} ${r.updated} 個項目`
            + (r.dryRun ? '（dry-run，已 ROLLBACK，未寫入）' : ''),
        `各狀態題數：進行中 ${r.statuses.active}、練到會 ${r.statuses.mastered}、移出 ${r.statuses.retired}`
    ];
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 7).join('\n'));
        return 0;
    }
    const { loadRetrainConfig } = require('../config/retrain');
    const params = loadRetrainConfig();
    const db = resolveDb(args.test);
    const target = args.test ? 'TEST_DATABASE_URL（測試庫）' : 'DATABASE_URL（開發／正式庫）';
    console.log(`重算錯題重練項目 → ${target}${args.studentId ? `，學生 #${args.studentId}` : ''}`
        + `${args.dryRun ? '（dry-run，不寫入）' : ''}`);
    console.log('只重算既有項目，不建立任何項目；不呼叫 LLM。');
    try {
        const r = await recomputeRetrain({ pool: db.pool, dryRun: args.dryRun, studentId: args.studentId, params });
        for (const line of formatReport(r, params)) console.log(line);
    } finally {
        await db.pool.end();
    }
    return 0;
}

module.exports = { parseArgs, recomputeRetrain, formatReport };

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error('❌ ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}
