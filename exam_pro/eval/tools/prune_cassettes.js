// ─────────────────────────────────────────────────────────────
// eval/tools/prune_cassettes.js — 清掉「CI 已經不會再讀到」的過期 cassette
//                                 （npm run cassettes:prune；docs/chapter-restructure.md 第 3.2 條第 3 點、第 5 條第 5 點）
//
//   npm run cassettes:prune               以 CI 的設定回放五個 eval 與 e2e，列出沒被讀到的 cassette（不刪）
//   npm run cassettes:prune -- --apply    確認清單之後才真的刪
//
// 怎麼判斷「過期」：以回放探針（eval/lib/cassetteProbe.js）跑全部 suite，記下實際讀到的鍵；
// 範圍內（extract／classify／lint／verify／nlq／variant）沒被讀到的檔就是過期。
// 化學（*_chem）、tutor、voice 與其他沒見過的目錄**一律不碰**（第 3.2 條第 3 點）。
//
// --apply 的保護（任一條成立就拒絕刪除，只印原因）：
//   1. 這一輪還有 replay miss——代表重錄還沒做完。這時刪掉舊檔，單元測試還在讀的那幾支
//      （例如 test/unit/sourceCheckSample.test.js 讀的 extract.v2）會先不見。要硬刪請加 --allow-misses。
//   2. 某個 suite 沒跑起來，或該有回放紀錄的 suite 一筆都沒有（最常見：沒設 TEST_DATABASE_URL，e2e 整支跳過）——
//      那一個 suite 讀的 cassette 會被誤判成過期。
//   3. 回放時出現 miss 以外的錯誤（例如 cassette 格式壞掉）。
//   4. 只跑了部分 suite（--suites）：沒跑的 suite 讀的 cassette 會被誤判成過期。--suites 只能用來預覽。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(APP_DIR, '.env'), quiet: true });

const { ALL_SUITES } = require('../lib/suiteProcess');
const { analyze, formatSummary } = require('../lib/cassettePlan');

/** 應該要有 LLM 回放紀錄的 suite（retrieval 不呼叫 LLM） */
const EXPECT_LLM = Object.freeze(['classify', 'pipeline', 'nlq', 'variant', 'e2e']);

const USAGE = `用法：npm run cassettes:prune -- [選項]

  （不帶參數）       以 CI 的設定回放五個 eval 與 e2e，列出沒被讀到的 cassette，不刪
  --apply            確認清單後真的刪除（有保護條件，見檔頭）
  --allow-misses     還有 replay miss 時仍然刪除（重錄還沒做完時不要用）
  --suites <a,b>     只回放這幾個 suite（只能預覽，不能與 --apply 一起用）
  --json             輸出機器可讀的 JSON（不含刪除）
  -h, --help         顯示這段說明`;

/**
 * @param {string[]} argv
 * @returns {{apply:boolean, allowMisses:boolean, suites:string[], json:boolean, help:boolean}}
 */
function parseArgs(argv) {
    const args = { apply: false, allowMisses: false, suites: ALL_SUITES.slice(), json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--apply': args.apply = true; break;
            case '--allow-misses': args.allowMisses = true; break;
            case '--json': args.json = true; break;
            case '--suites': {
                const list = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
                for (const s of list) {
                    if (!ALL_SUITES.includes(s)) throw new Error(`--suites 的「${s}」不存在（可用：${ALL_SUITES.join(',')}）`);
                }
                if (!list.length) throw new Error('--suites 後面要接至少一個 suite');
                args.suites = ALL_SUITES.filter(s => list.includes(s));
                break;
            }
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${a}」\n\n${USAGE}`);
        }
    }
    if (args.json && args.apply) throw new Error('--json 只用來預覽，不能與 --apply 一起用');
    return args;
}

/**
 * --apply 前的保護條件。純函式。
 * @param {object} opts
 * @param {object} opts.summary   cassetteAudit.summarize() 的回傳
 * @param {string[]} opts.suites  這一輪跑了哪些 suite
 * @param {boolean} [opts.allowMisses=false]
 * @returns {string[]} 拒絕刪除的理由；空陣列＝可以刪
 */
function pruneGuard({ summary, suites, allowMisses = false }) {
    const reasons = [];
    const missing = ALL_SUITES.filter(s => !suites.includes(s));
    if (missing.length) {
        reasons.push(`只回放了部分 suite（缺 ${missing.join('、')}）：沒跑到的 suite 讀的 cassette 會被誤判成過期。--suites 只能用來預覽。`);
    }
    for (const s of suites) {
        const row = summary.suites[s];
        if (!row) { reasons.push(`${s}：沒有任何紀錄`); continue; }
        if (!row.ran) reasons.push(`${s}：子行程沒有跑起來（沒有探針紀錄）`);
        else if (EXPECT_LLM.includes(s) && row.llmCalls === 0) {
            reasons.push(`${s}：一筆回放紀錄都沒有${s === 'e2e' ? '（多半是沒設 TEST_DATABASE_URL，整支跳過）' : ''}——它讀的 cassette 會被誤判成過期`);
        }
        if (row.errors.length) reasons.push(`${s}：回放時有 ${row.errors.length} 筆 miss 以外的錯誤（${row.errors[0]}）`);
    }
    const misses = suites.reduce((a, s) => a + ((summary.suites[s] && summary.suites[s].misses) || 0), 0);
    if (misses > 0 && !allowMisses) {
        reasons.push(`這一輪還有 ${misses} 筆 replay miss：重錄還沒做完（先跑 npm run cassettes:rerecord）。` +
            '現在刪除會把單元測試仍在讀的舊檔一起刪掉；確定要刪請加 --allow-misses。');
    }
    return reasons;
}

/**
 * 刪檔。只刪 cassette 目錄底下、範圍內 agent 的 .json（多一層防呆：清單被竄改也刪不到別處）。
 * @param {object} opts
 * @param {string} opts.dir      cassette 根目錄
 * @param {Array<{agent:string, key:string}>} opts.items
 * @returns {{deleted:string[], skipped:string[]}}
 */
function applyPrune({ dir, items }) {
    const { IN_SCOPE_AGENTS } = require('../lib/cassetteAudit');
    const root = path.resolve(dir);
    const deleted = [];
    const skipped = [];
    for (const it of items) {
        const ok = IN_SCOPE_AGENTS.includes(it.agent) && /^[0-9a-f]{64}$/.test(it.key);
        const file = path.join(root, it.agent, `${it.key}.json`);
        if (!ok || path.dirname(path.dirname(file)) !== root) { skipped.push(`${it.agent}/${it.key}（不在清除範圍）`); continue; }
        try {
            fs.unlinkSync(file);
            deleted.push(file);
        } catch (err) {
            skipped.push(`${it.agent}/${it.key}（${err.code || err.message}）`);
        }
    }
    return { deleted, skipped };
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { console.log(USAGE); return 0; }

    if (!args.json) {
        console.log(`以 CI 的設定回放：${args.suites.join(' → ')}（不連網；每個 suite 要幾秒到幾分鐘）`);
        if (!String(process.env.TEST_DATABASE_URL || '').trim()) {
            console.log('⚠️ 沒有設 TEST_DATABASE_URL：e2e 會整支跳過，它讀的 cassette 會被誤判成過期（--apply 會拒絕執行）。');
        }
    }
    const res = await analyze({ suites: args.suites, onStart: args.json ? undefined : (s) => console.log(`  · ${s} …`) });
    const { summary } = res;
    const list = summary.unhit;
    const guard = pruneGuard({ summary, suites: args.suites, allowMisses: args.allowMisses });

    if (args.json) {
        console.log(JSON.stringify({
            dir: res.inventory.dir, suites: args.suites, summary, guard,
            skippedDirs: res.inventory.skipped
        }, null, 2));
        return 0;
    }

    console.log('');
    console.log(formatSummary(res));
    console.log(`\n沒被任何 suite 讀到的 cassette：${list.length} 支`);
    const byAgent = {};
    for (const u of list) (byAgent[u.agent] = byAgent[u.agent] || []).push(u);
    for (const [agent, rows] of Object.entries(byAgent)) {
        console.log(`  ${agent}/（${rows.length} 支）`);
        for (const u of rows) {
            const why = u.keyValid === false ? '鍵已失效' : (u.previousVersion ? '某次 miss 的舊版' : '沒被讀到');
            console.log(`    - ${u.rel}　${why}`);
        }
    }

    if (!args.apply) {
        console.log('\n這是預覽，沒有刪任何檔。確認清單後執行：npm run cassettes:prune -- --apply');
        if (guard.length) console.log(`（目前 --apply 會被擋下：\n  - ${guard.join('\n  - ')}）`);
        return 0;
    }
    if (guard.length) {
        console.error(`\n❌ 拒絕刪除：\n  - ${guard.join('\n  - ')}`);
        return 1;
    }
    if (!list.length) {
        console.log('\n✅ 沒有過期的 cassette，不需要刪除。');
        return 0;
    }
    const out = applyPrune({ dir: res.inventory.dir, items: list });
    console.log(`\n✅ 已刪除 ${out.deleted.length} 支過期 cassette。` + (out.skipped.length ? `略過 ${out.skipped.length} 支：${out.skipped.join('、')}` : ''));
    console.log('   接著 npm test 確認單元測試全綠，再 git add -A eval/cassettes 並 commit。');
    return out.skipped.length ? 1 : 0;
}

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error(`\n❌ ${err.message}`);
        process.exit(1);
    });
}

module.exports = { main, parseArgs, pruneGuard, applyPrune, EXPECT_LLM, USAGE };
