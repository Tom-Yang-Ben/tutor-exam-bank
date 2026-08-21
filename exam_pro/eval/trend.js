// ─────────────────────────────────────────────────────────────
// eval/trend.js — 印出與上一份報表的差值
//
// 用法：node eval/trend.js [--dir eval/reports] [--n 2]
//
// 規劃 §5.6.7 的取捨：不做 dashboard、不把數字自動 commit 進 README，
// 「印差值」就夠了。一個人開發時，真正需要回答的問題只有一句——
// **這次改動讓哪一欄動了、動了多少**。
//
// 報表檔名是 <日期>-<sha>.json，字典序即時間序（日期在前），所以排序不需要讀檔內時間。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { round4 } = require('./lib/metrics');
const { REPORT_DIR } = require('./lib/report');

function parseArgs(argv) {
    const args = { dir: REPORT_DIR, n: 2 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dir') args.dir = path.resolve(argv[++i]);
        else if (argv[i] === '--n') args.n = Number(argv[++i]);
        else throw new Error(`未知的參數「${argv[i]}」`);
    }
    return args;
}

/**
 * @param {string} dir
 * @returns {Array<{file:string, doc:object}>} 由舊到新
 */
function listReports(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => {
            const full = path.join(dir, f);
            try {
                return { file: f, doc: JSON.parse(fs.readFileSync(full, 'utf8')) };
            } catch {
                return null;   // 半寫入或手動塞進來的檔案略過，不讓趨勢工具因此爆掉
            }
        })
        .filter(Boolean);
}

function fmtDelta(prev, curr) {
    if (prev === null || prev === undefined || curr === null || curr === undefined) return 'n/a';
    const d = round4(curr - prev);
    if (d === 0) return '±0';
    return `${d > 0 ? '+' : ''}${d.toFixed(4)}`;
}

function cell(v) {
    return (v === null || v === undefined) ? 'n/a' : round4(v).toFixed(4);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const reports = listReports(args.dir);
    if (reports.length === 0) {
        console.log(`${args.dir} 裡沒有報表。先跑一次 npm run eval -- --suite retrieval。`);
        return;
    }
    if (reports.length === 1) {
        console.log(`只有一份報表（${reports[0].file}），沒有可比較的前一份。`);
        return;
    }

    const curr = reports[reports.length - 1];
    const prev = reports[reports.length - 2];

    console.log(`\n## 檢索 eval 趨勢：${prev.file} → ${curr.file}\n`);

    // 量測環境不同的比較是沒有意義的，先把差異點出來再列數字
    const keys = ['engine', 'scope', 'fuseMode', 'model', 'dim', 'tokenizer', 'embedText', 'golden', 'goldenEntries'];
    const envDiff = keys.filter(k => JSON.stringify(prev.doc.meta?.[k]) !== JSON.stringify(curr.doc.meta?.[k]));
    if (envDiff.length) {
        console.log('⚠️  量測環境有變，以下差值不是同條件的比較：');
        for (const k of envDiff) console.log(`   - ${k}：${JSON.stringify(prev.doc.meta?.[k])} → ${JSON.stringify(curr.doc.meta?.[k])}`);
        console.log('');
    }

    console.log('| 檢索方式 | 指標 | 上一份 | 這一份 | 差值 |');
    console.log('|---|---|---:|---:|---:|');
    const label = { like: 'LIKE（基準）', vector: '純向量', hybrid: 'hybrid' };
    for (const mode of ['like', 'vector', 'hybrid']) {
        for (const metric of ['recall5', 'recall10', 'mrr']) {
            const p = prev.doc.measured?.[mode]?.[metric] ?? null;
            const c = curr.doc.measured?.[mode]?.[metric] ?? null;
            if (p === null && c === null) continue;
            console.log(`| ${label[mode]} | ${metric} | ${cell(p)} | ${cell(c)} | ${fmtDelta(p, c)} |`);
        }
    }
    console.log('');
}

if (require.main === module) {
    try { main(); } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }
}

module.exports = { listReports, fmtDelta };
