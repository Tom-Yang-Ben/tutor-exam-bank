// ─────────────────────────────────────────────────────────────
// scripts/report_jobs.js — 管線的可觀測性報表（A-T15，擁有者：WS-A）
//
// 對應規劃 §3.9：`job_events` 是唯一的事實來源，這支只做聚合、不改任何資料。
//
//   node scripts/report_jobs.js --since=7d
//   node scripts/report_jobs.js --since=24h --json      # 整份報表壓成一行 JSON
//   node scripts/report_jobs.js --since=7d --test       # 打測試庫（TEST_DATABASE_URL）
//
// npm script（report:jobs）由 WS-D 統一加進 package.json（第 10.1 條）。
//
// 輸出分兩路（Windows 提醒：PowerShell 5.1 的 `>` 會寫成 UTF-16LE，
// 要留檔請用 `node scripts/report_jobs.js | Out-File -Encoding utf8 report.md` 或 cmd.exe）：
//   stdout —— 報表本體（Markdown 表格，或 --json 時的一行 JSON）
//   stderr —— 程序日誌，**一行一個 JSON**（第 7.5 條的格式），不會汙染報表
// ─────────────────────────────────────────────────────────────
require('dotenv').config();

// ─────────────────────────── 純函式 ───────────────────────────

/**
 * 解析 --since：`7d`／`24h`／`90m`／純數字（視為天）。
 * @param {string} value
 * @returns {{ms:number, label:string}}
 * @throws  格式不對時丟錯（寧可停下來，也不要默默用預設值算出一份錯的報表）
 */
function parseSince(value) {
    const raw = String(value ?? '7d').trim();
    const m = /^(\d+(?:\.\d+)?)([dhm]?)$/i.exec(raw);
    if (!m) throw new Error(`--since 格式不正確：「${raw}」。可用 7d／24h／90m 或純數字（天）。`);
    const n = Number(m[1]);
    if (!(n > 0)) throw new Error(`--since 必須大於 0，收到「${raw}」。`);
    const unit = (m[2] || 'd').toLowerCase();
    const per = { d: 86400000, h: 3600000, m: 60000 }[unit];
    return { ms: n * per, label: `${m[1]}${unit}` };
}

/** 極簡參數解析：只認 `--key=value` 與 `--flag`。 */
function parseArgs(argv) {
    const out = {};
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
        if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}

/** `'gemini:gemini-3.7-flash'` → `{vendor:'gemini', id:'gemini-3.7-flash'}`；沒有冒號時 vendor 視為 gemini。 */
function splitModel(spec) {
    const s = String(spec ?? '').trim();
    if (!s) return { vendor: null, id: null };
    const i = s.indexOf(':');
    return i < 0 ? { vendor: 'gemini', id: s } : { vendor: s.slice(0, i), id: s.slice(i + 1) };
}

/**
 * verify 的「同家／異家」標示（規劃 §3.3.8、介面第 0.3 條裁決 S0-5）。
 *
 * 同一家又同一個 ID 的自驗幾乎沒有偵錯力，報表要把這件事講白；
 * 免費層拿不到 Pro 系列，所以第一版預期就是「同家不同級」。
 *
 * @param {string|null} extractModel 拆題／分類實際用的模型
 * @param {string|null} verifyModel  驗證實際用的模型
 * @returns {{label:string, sameVendor:boolean|null, sameModel:boolean|null}}
 */
function verifyRelation(extractModel, verifyModel) {
    const a = splitModel(extractModel);
    const b = splitModel(verifyModel);
    if (!a.id || !b.id) return { label: '資料不足（期間內沒有 verify 或 extract 的 LLM 呼叫）', sameVendor: null, sameModel: null };
    if (a.id === b.id) return { label: `同模型自驗（${b.id}）——偵錯力極低，建議換一個模型`, sameVendor: true, sameModel: true };
    if (a.vendor === b.vendor) return { label: `同家異級驗證（${a.vendor}：${a.id} → ${b.id}）`, sameVendor: true, sameModel: false };
    return { label: `異家驗證（${a.vendor}:${a.id} → ${b.vendor}:${b.id}）`, sameVendor: false, sameModel: false };
}

/** 數字格式：成本留 6 位、比率留 1 位百分比、其餘四捨五入到整數。 */
const usd = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(6));
const ms = (v) => (v === null || v === undefined ? '—' : String(Math.round(Number(v))));
const pct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
const int = (v) => (v === null || v === undefined ? '—' : String(Number(v)));

/** 把一組列組成 Markdown 表格；空集合印一行「（期間內沒有資料）」。 */
function table(headers, rows) {
    if (rows.length === 0) return '（期間內沒有資料）\n';
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    return [head, sep, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n') + '\n';
}

/**
 * 把 collect() 的結果排成 Markdown。純函式，可單元測試。
 * @param {object} r collect() 的輸出
 */
function renderMarkdown(r) {
    const out = [];
    out.push(`# 管線報表（最近 ${r.since.label}，自 ${r.since.from}）\n`);
    out.push(`資料來源：\`job_events\`（只追加）。事件 ${r.totals.events} 列、涉及 ${r.totals.jobs} 份 job。\n`);

    out.push('\n## 每節點的延遲、用量與成本\n');
    out.push(table(
        ['節點', '次數', 'p50 ms', 'p95 ms', 'token_in', 'token_out', 'thinking', 'cost_usd', '未查證定價'],
        r.nodes.map(n => [n.node, int(n.calls), ms(n.p50), ms(n.p95), int(n.token_in),
        int(n.token_out), int(n.token_thinking), usd(n.cost_usd), int(n.unpriced)])));

    out.push('\n## outcome 分佈\n');
    out.push(table(['節點', 'pass', 'fail', 'error', 'skipped'],
        r.outcomes.map(o => [o.node, int(o.pass), int(o.fail), int(o.error), int(o.skipped)])));

    out.push('\n## error_class 分佈（job_events）\n');
    out.push(table(['error_class', '次數'], r.errorClasses.map(e => [e.error_class, int(e.n)])));

    out.push('\n## review_reason 分佈（目前仍在 needs_review 的列）\n');
    out.push(table(['review_reason', '題數'], r.reviewReasons.map(e => [e.review_reason, int(e.n)])));

    out.push('\n## 每份 PDF 的成本\n');
    out.push(table(['指標', '值'], [
        ['期間內有事件的 job 數', int(r.perJob.jobs)],
        ['總成本 USD', usd(r.perJob.total_cost)],
        ['每份 PDF 平均成本 USD', usd(r.perJob.avg_cost)],
        ['每份 PDF 成本中位數 USD', usd(r.perJob.p50_cost)],
        ['每份 PDF 最高成本 USD', usd(r.perJob.max_cost)],
        ['入庫題數 / 每份 PDF 平均', `${int(r.perJob.saved)} / ${r.perJob.jobs ? (r.perJob.saved / r.perJob.jobs).toFixed(1) : '—'}`]
    ]));

    out.push('\n## classify 零成本閘門\n');
    out.push(table(['指標', '值'], [
        ['classify 事件總數', int(r.classifyGate.calls)],
        ['零成本通過（沒有呼叫 LLM）', int(r.classifyGate.gate_pass)],
        ['閘門通過率', pct(r.classifyGate.rate)],
        ['第二層 LLM 呼叫次數', int(r.classifyGate.llm_calls)]
    ]));
    out.push('> 通過率 > 95% 且正確率不低於現況時，第二層可降為抽樣（規劃 §3.8 驗收表）。\n');

    out.push('\n## verify 的驗證關係\n');
    out.push(`${r.verify.label}\n`);
    out.push(table(['指標', '值'], [
        ['verify 事件數', int(r.verify.calls)],
        ['skipped（證明題）', int(r.verify.skipped)],
        ['answer_mismatch 次數', int(r.verify.mismatch)],
        ['不一致率', pct(r.verify.mismatch_rate)]
    ]));
    out.push('> 線上 `answer_mismatch` 比例 > 15% 時先查 prompt，不要急著接第二家模型（規劃 §3.8）。\n');

    return out.join('');
}

// ─────────────────────────── 取數（唯一會碰 DB 的地方）───────────────────────────

/**
 * @param {{query:Function}} db
 * @param {{ms:number, label:string}} since
 */
async function collect(db, since) {
    const from = new Date(Date.now() - since.ms).toISOString();
    const P = [from];

    const one = async (sql, params = P) => (await db.query(sql, params)).rows[0] || {};
    const all = async (sql, params = P) => (await db.query(sql, params)).rows;

    const totals = await one(
        `SELECT COUNT(*)::int AS events, COUNT(DISTINCT job_id)::int AS jobs
           FROM job_events WHERE created_at >= $1`);

    // percentile_cont 是 PG 內建的有序集合聚合，不必把 latency 全撈回 Node 排序
    const nodes = await all(
        `SELECT node,
                COUNT(*)::int                                              AS calls,
                percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)   AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)   AS p95,
                COALESCE(SUM(token_in), 0)::int                            AS token_in,
                COALESCE(SUM(token_out), 0)::int                           AS token_out,
                COALESCE(SUM(token_thinking), 0)::int                      AS token_thinking,
                COALESCE(SUM(cost_usd), 0)::float8                         AS cost_usd,
                COUNT(*) FILTER (WHERE cost_estimated = false AND model IS NOT NULL)::int AS unpriced
           FROM job_events WHERE created_at >= $1
          GROUP BY node ORDER BY node`);

    const outcomes = await all(
        `SELECT node,
                COUNT(*) FILTER (WHERE outcome = 'pass')::int    AS pass,
                COUNT(*) FILTER (WHERE outcome = 'fail')::int    AS fail,
                COUNT(*) FILTER (WHERE outcome = 'error')::int   AS error,
                COUNT(*) FILTER (WHERE outcome = 'skipped')::int AS skipped
           FROM job_events WHERE created_at >= $1
          GROUP BY node ORDER BY node`);

    const errorClasses = await all(
        `SELECT error_class, COUNT(*)::int AS n FROM job_events
          WHERE created_at >= $1 AND error_class IS NOT NULL
          GROUP BY error_class ORDER BY n DESC, error_class`);

    // 複核原因看的是「現在還卡著的題」，不是歷史事件——老師要決定先審哪一類
    const reviewReasons = await all(
        `SELECT review_reason, COUNT(*)::int AS n FROM job_questions
          WHERE state = 'needs_review' AND updated_at >= $1
          GROUP BY review_reason ORDER BY n DESC, review_reason`);

    const perJob = await one(
        `WITH per AS (
             SELECT job_id, SUM(cost_usd) AS cost FROM job_events
              WHERE created_at >= $1 GROUP BY job_id)
         SELECT COUNT(*)::int                                        AS jobs,
                COALESCE(SUM(cost), 0)::float8                       AS total_cost,
                COALESCE(AVG(cost), 0)::float8                       AS avg_cost,
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY cost), 0)::float8 AS p50_cost,
                COALESCE(MAX(cost), 0)::float8                       AS max_cost,
                (SELECT COUNT(*)::int FROM job_questions q
                  WHERE q.state = 'saved' AND q.job_id IN (SELECT job_id FROM per)) AS saved
           FROM per`);

    // 零成本閘門＝這一列事件完全沒有 LLM 呼叫（runner 只在真的叫過模型時才寫 model 與 token）
    const classifyGate = await one(
        `SELECT COUNT(*)::int                                          AS calls,
                COUNT(*) FILTER (WHERE model IS NULL AND outcome = 'pass')::int AS gate_pass,
                COUNT(*) FILTER (WHERE model IS NOT NULL)::int         AS llm_calls
           FROM job_events WHERE created_at >= $1 AND node = 'classify'`);
    classifyGate.rate = classifyGate.calls > 0 ? classifyGate.gate_pass / classifyGate.calls : null;

    const verifyStats = await one(
        `SELECT COUNT(*)::int                                             AS calls,
                COUNT(*) FILTER (WHERE outcome = 'skipped')::int          AS skipped,
                COUNT(*) FILTER (WHERE error_class = 'answer_mismatch')::int AS mismatch
           FROM job_events WHERE created_at >= $1 AND node = 'verify'`);
    const judged = verifyStats.calls - verifyStats.skipped;
    verifyStats.mismatch_rate = judged > 0 ? verifyStats.mismatch / judged : null;

    // 「同家／異家」用**實際跑過的模型**判定，不是 .env 寫什麼就信什麼
    const models = await all(
        `SELECT node, model, COUNT(*)::int AS n FROM job_events
          WHERE created_at >= $1 AND model IS NOT NULL
          GROUP BY node, model ORDER BY n DESC`);
    const topModel = (node) => models.find(m => m.node === node)?.model ?? null;
    const relation = verifyRelation(topModel('extract') ?? topModel('classify'), topModel('verify'));

    return {
        since: { ...since, from },
        totals, nodes, outcomes, errorClasses, reviewReasons, perJob,
        classifyGate, verify: { ...verifyStats, ...relation }, models
    };
}

// ─────────────────────────── 入口 ───────────────────────────

/** 程序日誌：一行一個 JSON，走 stderr，不汙染 stdout 的報表。 */
function log(level, obj) {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, tool: 'report_jobs', ...obj }) + '\n');
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const since = parseSince(args.since);

    // --test 打測試庫；config/db.js 只認 DATABASE_URL，所以在 require 之前換掉
    if (args.test) {
        const url = (process.env.TEST_DATABASE_URL || '').trim();
        if (!url) throw new Error('--test 需要 TEST_DATABASE_URL。');
        if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾。');
        process.env.DATABASE_URL = url;
    }
    const db = require('../config/db');

    log('info', { msg: '開始彙整', since: since.label, target: args.test ? 'test' : 'default' });
    const started = Date.now();
    try {
        const report = await collect(db, since);
        process.stdout.write(args.json ? JSON.stringify(report) + '\n' : renderMarkdown(report));
        log('info', { msg: '彙整完成', since: since.label, events: report.totals.events, jobs: report.totals.jobs, latency_ms: Date.now() - started });
    } finally {
        await db.pool.end();
    }
}

module.exports = { parseSince, parseArgs, splitModel, verifyRelation, renderMarkdown, table, collect, main };

if (require.main === module) {
    main().catch(err => {
        log('error', { msg: '彙整失敗', error: err.message });
        process.exitCode = 1;
    });
}
