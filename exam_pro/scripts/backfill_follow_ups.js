// scripts/backfill_follow_ups.js — 回填承上題綁定（DEC-012／FR-019）
//
// 用法：
//   node scripts/backfill_follow_ups.js                  對 DATABASE_URL 回填（逐 job 一個交易）
//   node scripts/backfill_follow_ups.js --dry-run        整批在一個交易內跑完後 ROLLBACK，只出報告
//   node scripts/backfill_follow_ups.js --test           改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//   node scripts/backfill_follow_ups.js --report eval/local/follow_ups.json   另存報告
//
// 做法：對所有 kind='pdf' 的 job 依 id 呼叫 services/followUpLinker.js 的 linkJob(…, {src:'backfill'})。
// linkJob 冪等：已綁好的不寫、follows_src='human' 不覆寫，因此可以重複跑。
// 舊題（legacy，不在任何 job 裡）靠 linkJob 的補強規則，透過重拆紀錄命中它們的那幾列回填。
//
// 報告另列「題幹是承上題、follows_question_id 為 NULL、且不在任何 job_questions 的題」為待人工綁定：
// 這些題沒有任何拆題紀錄可推前題，腳本**不猜**。

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { linkJob } = require('../services/followUpLinker');
const { isFollowUp } = require('../utils/followUp');

// ───────────────────────── 參數 ─────────────────────────

function parseArgs(argv) {
    const args = { dryRun: false, test: false, report: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--test') args.test = true;
        else if (a === '--report') args.report = argv[++i];
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--dry-run --test --report`);
    }
    if (args.report === undefined) throw new Error('--report 後面要接檔案路徑');
    return args;
}

/** 與 scripts/backfill_text_hash.js 同一套規則：--test 自建連線並檢查庫名以 _test 結尾 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');

    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 2 });
    return { pool, query: (text, values) => pool.query(text, values) };
}

// ───────────────────────── 主流程 ─────────────────────────

/** 題幹是承上題、未綁定、且沒有任何拆題紀錄指向它的題（待人工綁定） */
async function findOrphans(executor) {
    const { rows } = await executor.query(
        `SELECT q.id, q.subject, q.chapter, q.origin, q.question_text
           FROM questions q
          WHERE q.follows_question_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM job_questions jq WHERE jq.question_id = q.id)
          ORDER BY q.id`);
    return rows.filter(r => isFollowUp(r.question_text)).map(r => ({
        question_id: r.id, subject: r.subject, chapter: r.chapter, origin: r.origin,
        stem_preview: String(r.question_text).replace(/\s+/g, ' ').trim().slice(0, 60)
    }));
}

/**
 * 回填本體（給 CLI 與整合測試共用）。
 * @param {{pool:{connect:Function}}} db
 * @param {{dryRun?:boolean}} [opts]
 * @returns {Promise<{dryRun:boolean, jobs:number, bound:Array, unresolved:Array, orphans:Array}>}
 */
async function backfill(db, { dryRun = false } = {}) {
    const client = await db.pool.connect();
    const report = { dryRun, jobs: 0, bound: [], unresolved: [], orphans: [] };
    try {
        const { rows: jobs } = await client.query(`SELECT id FROM jobs WHERE kind = 'pdf' ORDER BY id`);
        report.jobs = jobs.length;

        if (dryRun) await client.query('BEGIN');
        for (const { id } of jobs) {
            const jobId = Number(id);
            if (!dryRun) await client.query('BEGIN');
            try {
                const r = await linkJob(client, jobId, { src: 'backfill' });
                if (!dryRun) await client.query('COMMIT');
                report.bound.push(...r.bound.map(b => ({ job_id: jobId, ...b })));
                report.unresolved.push(...r.unresolved.map(u => ({ job_id: jobId, ...u })));
            } catch (err) {
                if (!dryRun) await client.query('ROLLBACK');
                throw err;
            }
        }
        // dry-run 時在回滾前查孤兒：看到的是「假如寫入之後」還剩哪些題沒綁
        report.orphans = await findOrphans(client);
        if (dryRun) await client.query('ROLLBACK');
        return report;
    } catch (err) {
        if (dryRun) await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 14).join('\n'));
        return 0;
    }

    const db = resolveDb(args.test);
    const target = args.test ? 'TEST_DATABASE_URL（測試庫）' : 'DATABASE_URL（開發／正式庫）';
    console.log(`回填承上題綁定 → ${target}${args.dryRun ? '（dry-run，交易內執行後回滾）' : ''}`);

    try {
        const report = await backfill(db, { dryRun: args.dryRun });

        console.log('\n──────── 結果 ────────');
        console.log(`掃描 pdf job ${report.jobs} 個；${args.dryRun ? '將綁定' : '已綁定'} ${report.bound.length} 題；無法解析 ${report.unresolved.length} 列；待人工綁定 ${report.orphans.length} 題`);
        for (const b of report.bound) console.log(`  ✔ #${b.question_id} → 承接 #${b.follows_question_id}（job ${b.job_id}）`);
        for (const u of report.unresolved) console.log(`  ⚠ job ${u.job_id} 的 jq ${u.jq_id}：${u.reason}`);
        for (const o of report.orphans) console.log(`  ? #${o.question_id} ${o.subject}｜${o.chapter}（${o.origin}）：${o.stem_preview}…`);

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

module.exports = { backfill, findOrphans, parseArgs };

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error('❌ ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}
