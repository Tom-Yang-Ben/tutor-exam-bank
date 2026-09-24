// scripts/load_kc.js — 把知識點種子檔載入資料庫（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條第 1 點）
//
// 用法：
//   npm run kc:load                                  載入 config/kc/ 底下全部 *.json（先備跨檔解析）
//   npm run kc:load -- --file config/kc/數學.json    只載入指定檔（可重複 --file）
//   npm run kc:load -- --dry-run                     全部照做、最後回滾：只看會新增／更新／略過幾個
//   npm run kc:load -- --force                       連 DB 裡已審定（approved）的也用種子檔覆寫
//   npm run kc:load -- --test                        改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//
// 行為：
//   1. 先跑 utils/kcSeed.js 的 validateSeeds（第 3.4 條）；有任何 error 就整批拒絕，一列都不寫。
//   2. 以 code upsert；DB 中已是 approved 的列不覆寫內容（除非 --force）。
//   3. 先備關係以 src='ai' upsert；code 在本批與 DB 都解析不到就整批回滾。
//   4. 整批一個交易。印出新增、更新、略過（內容相同／已審定受保護）的數量。
// 有 error 時 exit code 1。不呼叫 LLM。
//
// dotenv 只在「直接執行」時載入（檔尾）：單元測試 require 本檔測 parseArgs 時不該把 .env 讀進行程。
const fs = require('fs');
const path = require('path');

const KC_DIR = path.resolve(__dirname, '..', 'config', 'kc');

/**
 * @param {string[]} argv
 * @returns {{files:string[], dryRun:boolean, force:boolean, test:boolean, help?:boolean}}
 */
function parseArgs(argv) {
    const args = { files: [], dryRun: false, force: false, test: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--force') args.force = true;
        else if (a === '--test') args.test = true;
        else if (a === '--file') {
            const f = argv[++i];
            if (!f || f.startsWith('--')) throw new Error('--file 後面要接種子檔路徑');
            args.files.push(f);
        } else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--file <path> --dry-run --force --test`);
    }
    return args;
}

/** 要讀的檔：有 --file 就只讀那些，否則 config/kc/*.json（依檔名排序，輸出才穩定） */
function resolveFiles(args) {
    if (args.files.length) return args.files.map(f => path.resolve(f));
    if (!fs.existsSync(KC_DIR)) return [];
    return fs.readdirSync(KC_DIR).filter(f => f.endsWith('.json')).sort().map(f => path.join(KC_DIR, f));
}

/**
 * 取得 { pool, query }：預設 config/db.js；--test 時自建連線打測試庫（同 backfill_embeddings.js 的防呆）。
 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 2 });
    return { pool, query: (text, values) => pool.query(text, values) };
}

/**
 * 把結果印成老師看得懂的幾行（純函式，回傳字串陣列）。
 * @param {{counts:object, stats:object}} res
 * @param {{dryRun:boolean, force:boolean}} args
 * @returns {string[]}
 */
function formatReport(res, args) {
    const c = res.counts;
    const lines = [];
    for (const [subject, s] of Object.entries(res.stats || {})) {
        lines.push(`${subject}：種子檔 ${s.components} 個知識點、${s.chapters} 章、標記已審定 ${s.approved} 個`);
    }
    lines.push(`${args.dryRun ? '（dry-run，已回滾）' : ''}新增 ${c.inserted}、更新 ${c.updated}、略過 ${c.unchanged + c.protected}` +
        `（內容相同 ${c.unchanged}、已審定受保護 ${c.protected}）`);
    lines.push(`先備關係：新增 ${c.prereqInserted}、移除過時的 AI 先備 ${c.prereqRemoved}`);
    if (c.protected > 0 && !args.force) lines.push('ℹ️ 已審定的知識點沒有被覆寫；確定要用種子檔蓋過去請加 --force。');
    if (c.orphans > 0) lines.push(`⚠️ 資料庫裡有 ${c.orphans} 個知識點不在這次的種子檔中（沒有刪除，可能已有題目標到它們）。`);
    return lines;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 16).join('\n'));
        return 0;
    }
    const files = resolveFiles(args);
    if (!files.length) {
        console.log('config/kc/ 沒有種子檔，沒有東西可以載入。');
        return 0;
    }

    const seeds = [];
    for (const f of files) {
        try { seeds.push(JSON.parse(fs.readFileSync(f, 'utf8'))); }
        catch (err) { console.error(`❌ ${f} 不是合法 JSON：${err.message}`); return 1; }
    }
    console.log(`讀入 ${files.length} 份種子檔：${files.map(f => path.basename(f)).join('、')}` +
        `${args.dryRun ? '（dry-run）' : ''}${args.force ? '（--force）' : ''}${args.test ? '（測試庫）' : ''}`);

    const db = resolveDb(args.test);
    try {
        const { loadSeeds } = require('../services/kcService');
        const res = await loadSeeds(db, seeds, { force: args.force, dryRun: args.dryRun });
        for (const w of res.warnings.slice(0, 50)) console.log(`⚠️ ${w}`);
        if (!res.ok) {
            for (const e of res.errors.slice(0, 200)) console.error(`❌ ${e}`);
            console.error(`\n共 ${res.errors.length} 個 error，整批拒絕，資料庫沒有任何變動。`);
            return 1;
        }
        for (const line of formatReport(res, args)) console.log(line);
        console.log(args.dryRun ? '✅ dry-run 完成（沒有寫入）。' : '✅ 載入完成。');
        return 0;
    } finally {
        if (args.test && db.pool && typeof db.pool.end === 'function') await db.pool.end().catch(() => { });
        else if (!args.test) await require('../config/db').pool.end().catch(() => { });
    }
}

if (require.main === module) {
    require('dotenv').config();
    main()
        .then(code => process.exit(code))
        .catch(err => { console.error('❌ ' + err.message); process.exit(1); });
}

module.exports = { parseArgs, resolveFiles, formatReport, main };