// ─────────────────────────────────────────────────────────────
// eval/lib/report.js — 報表輸出：stdout Markdown 表 + eval/reports/<日期>-<sha>.json + GITHUB_STEP_SUMMARY
//
// 規劃 §5.3.3 與 §5.6.7：報表不自動 commit 進 README（會污染歷史，也容易讓公開層數字被
// 誤讀成真實題庫的表現），只留三個出口：終端機看得到、CI 的 step summary 看得到、
// artifact 保留 30 天可下載比對。趨勢由 eval/trend.js 印差值，不另建 dashboard。
//
// 報表**一定**要帶「量測環境」：模型、維度、分詞器、engine、golden 路徑、是否還有待人工確認。
// 沒有這幾欄的數字不能拿來比較——三欄對照最容易犯的錯，就是拿兩次條件不同的量測互相對照。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { round4 } = require('./metrics');

const REPORT_DIR = path.resolve(__dirname, '..', 'reports');

/** @returns {string} 短 sha；拿不到（例如 tarball 部署）時回 'nogit' */
function shortSha() {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
    try {
        return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return 'nogit';
    }
}

/** @returns {string} YYYY-MM-DD（UTC，讓本機與 CI 產生的檔名可以直接排序比較） */
function today() {
    return new Date().toISOString().slice(0, 10);
}

/** 把 null 顯示成 n/a，數字一律四位小數，避免欄寬跳動 */
function cell(v) {
    return (v === null || v === undefined) ? 'n/a' : round4(v).toFixed(4);
}

/**
 * 三欄對照的 Markdown 表。
 * @param {object} measured { like|vector|hybrid: {recall5,recall10,mrr,n,scored}|null }
 * @returns {string}
 */
function markdownTable(measured) {
    const lines = [
        '| 檢索方式 | Recall@5 | Recall@10 | MRR | 納入平均的題數 |',
        '|---|---:|---:|---:|---:|'
    ];
    const label = { like: 'LIKE（基準）', vector: '純向量', hybrid: 'hybrid' };
    for (const mode of ['like', 'vector', 'hybrid']) {
        const m = measured[mode];
        if (!m) { lines.push(`| ${label[mode]} | n/a | n/a | n/a | — |`); continue; }
        lines.push(`| ${label[mode]} | ${cell(m.recall5)} | ${cell(m.recall10)} | ${cell(m.mrr)} | ${m.scored}/${m.n} |`);
    }
    return lines.join('\n');
}

/**
 * hybrid 必須 ≥ LIKE（規劃 §5.8）。差值只報不設數字門檻——
 * 「差多少才算贏」很容易被 baseline 的定義操弄，所以只守「不得更差」這條不可爭辯的線。
 * @param {object} measured
 * @returns {{ok:boolean, message:string}|null} 兩欄有一欄沒量到就回 null
 */
function hybridVsLike(measured) {
    const h = measured.hybrid, l = measured.like;
    if (!h || !l || h.recall5 === null || l.recall5 === null) return null;
    const delta = h.recall5 - l.recall5;
    return {
        ok: delta >= -1e-9,
        message: `hybrid Recall@5 ${cell(h.recall5)} vs LIKE ${cell(l.recall5)}（差值 ${delta >= 0 ? '+' : ''}${round4(delta).toFixed(4)}）`
    };
}

/**
 * 輸出報表。
 * @param {object} opts
 * @param {object} opts.measured
 * @param {object} opts.meta      量測環境
 * @param {Array<object>} [opts.perQuery] 逐題明細，只進 json 不進 stdout
 * @param {string[]} [opts.warnings]
 * @param {string} [opts.dir]
 * @returns {{file:string, doc:object}}
 */
function emit(opts) {
    const table = markdownTable(opts.measured);
    const cmp = hybridVsLike(opts.measured);

    const head = [
        '',
        '## 檢索 eval — 三欄對照',
        '',
        table,
        '',
        `- 量測環境：模型 \`${opts.meta.model}\` / ${opts.meta.dim} 維 · 分詞器 \`${opts.meta.tokenizer}\` · engine \`${opts.meta.engine}\` · scope \`${opts.meta.scope}\` · 融合 \`${opts.meta.fuseMode}\``,
        `- golden：\`${opts.meta.golden}\`（${opts.meta.goldenEntries} 筆${opts.meta.goldenPending ? `，其中 ${opts.meta.goldenPending} 筆仍是 needs_human_confirm 建議稿` : ''}）`,
        `- fixture：\`${opts.meta.fixture}\`（${opts.meta.fixtureQuestions} 題${opts.meta.fixturePending ? '，尚待人工核對答案' : ''}）`,
        cmp ? `- ${cmp.ok ? '✅' : '❌'} ${cmp.message}` : '- hybrid 與 LIKE 的對照：本次未同時量到，略過'
    ];
    for (const w of opts.warnings || []) head.push(`- ⚠️ ${w}`);
    const md = head.join('\n') + '\n';

    console.log(md);

    const dir = path.resolve(opts.dir || REPORT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${today()}-${shortSha()}.json`);
    const doc = {
        generated_at: new Date().toISOString(),
        suite: 'retrieval',
        meta: opts.meta,
        measured: opts.measured,
        hybrid_ge_like: cmp,
        warnings: opts.warnings || [],
        per_query: opts.perQuery || []
    };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`報表已寫入 ${file}`);

    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md, 'utf8');
    }
    return { file, doc };
}

module.exports = { emit, markdownTable, hybridVsLike, shortSha, today, REPORT_DIR };
