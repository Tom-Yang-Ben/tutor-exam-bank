// scripts/backfill_kc.js — 為既有題目補標知識點（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條第 3 點）
//
// 用法：
//   npm run kc:backfill -- --dry-run                 只印出題數與預估費用，不呼叫 LLM、不寫 DB
//   npm run kc:backfill -- --limit 20                先試 20 題
//   npm run kc:backfill -- --subject 物理            只補物理
//   npm run kc:backfill -- --test                    改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//
// 對象：未封存、**沒有任何**知識點標註、所在章節已有知識點的題（依題號由小到大）。
// 每題走 services/kcTagService.tagQuestion：已有人工標註的不動、信心不足的不寫。
//
// ⚠ 會呼叫 LLM（花錢）。執行前一定先印出題數與預估費用；LLM_MODE 必須是 live 或 record
//   （預設 replay 只讀 cassette，沒錄過的題會全部失敗——不會打網路、也不會花錢）。
// 結尾印出各狀態的題數與實際費用；有任何一題失敗就以 exit code 1 結束。
const fs = require('fs');

/**
 * @param {string[]} argv
 * @returns {{dryRun:boolean, limit:number|null, subject:string|null, test:boolean, help?:boolean}}
 */
function parseArgs(argv) {
    const args = { dryRun: false, limit: null, subject: null, test: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--test') args.test = true;
        else if (a === '--limit') {
            const raw = argv[++i];
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 1 || String(n) !== String(raw).trim()) throw new Error('--limit 後面要接正整數');
            args.limit = n;
        } else if (a === '--subject') {
            const s = argv[++i];
            if (!s || s.startsWith('--')) throw new Error('--subject 後面要接科目名稱（例：數學）');
            args.subject = s;
        } else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--dry-run --limit N --subject X --test`);
    }
    return args;
}

/** 同 load_kc.js：--test 打測試庫，庫名必須以 _test 結尾 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 2 });
    return { pool, query: (text, values) => pool.query(text, values) };
}

/** 美元金額：小數第 4 位（成本報表同一個精度） */
function usd(n) {
    return `US$${Number(n || 0).toFixed(4)}`;
}

/**
 * 一題的結果 → 一行進度（純函式）。不印題幹：log 可能被貼到別處，題目內容不需要出現在這裡。
 * @param {number} i 從 1 起算
 * @param {number} n
 * @param {object} r tagQuestion 的結果
 * @returns {string}
 */
function progressLine(i, n, r) {
    const head = `[${i}/${n}] #${r.question_id} ${r.status}`;
    if (r.status === 'tagged') return `${head}：${r.written.map(w => `${w.code}(${w.confidence.toFixed(2)})`).join('、')}`;
    if (r.status === 'failed') return `${head}（${r.reason}）${String(r.message || '').split('\n')[0].slice(0, 160)}`;
    if (r.status === 'low_confidence') return `${head}：${r.dropped.map(d => `${d.code}(${Number(d.confidence).toFixed(2)})`).join('、')} 都低於門檻`;
    return r.reason ? `${head}（${r.reason}）` : head;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 15).join('\n'));
        return 0;
    }
    const { defaultChapters } = require('../utils/kcSeed');
    const subjects = Object.keys(defaultChapters());
    if (args.subject !== null && !subjects.includes(args.subject)) {
        throw new Error(`--subject 只接受 ${subjects.join('、')}`);
    }

    const svc = require('../services/kcTagService');
    const { llmMode } = require('../services/llm');
    const cfg = svc.loadTagConfig();
    const mode = llmMode();
    console.log(`模型 ${cfg.model}、信心門檻 ${cfg.minConfidence}、LLM_MODE=${mode}` +
        `${args.dryRun ? '（dry-run）' : ''}${args.test ? '（測試庫）' : ''}`);
    if (mode === 'replay' && !args.dryRun) {
        console.log('⚠️ LLM_MODE=replay：只讀 cassette、不打網路；沒有錄過的題會標為 failed。真的要補標請在 .env 設 LLM_MODE=live。');
    }

    const db = resolveDb(args.test);
    let exitCode = 0;
    try {
        const ids = await svc.selectBackfillIds(db, { subject: args.subject, limit: args.limit });
        const noKc = await svc.countUntaggedWithoutKcs(db, { subject: args.subject });
        const est = svc.estimateTagCost(ids.length, cfg.model);

        console.log(`待標註題數：${ids.length}${args.limit ? `（--limit ${args.limit}）` : ''}`);
        if (noKc > 0) console.log(`另有 ${noKc} 題所在的章節還沒有知識點，這次不會處理（先 npm run kc:load）。`);
        console.log(est.estimated
            ? `預估費用：約 ${usd(est.totalUsd)}（每題約 ${est.tokens.tokenIn} input／${est.tokens.tokenOut} output` +
                `${est.tokens.tokenThinking ? `＋至多 ${est.tokens.tokenThinking} thinking` : ''} token，${est.modelId} 單價）`
            : `預估費用：無法估算（config/pricing.js 查不到 ${est.modelId} 的單價）`);

        if (args.dryRun || ids.length === 0) {
            console.log(args.dryRun ? '✅ dry-run 完成（沒有呼叫 LLM、沒有寫入）。' : '✅ 沒有需要標註的題。');
            return 0;
        }

        const tally = {};
        let cost = 0;
        for (let i = 0; i < ids.length; i++) {
            let r;
            try {
                r = await svc.tagQuestion(ids[i], { db });
            } catch (err) {
                r = { question_id: ids[i], status: 'failed', reason: 'exception', message: err.message, written: [], dropped: [], usage: { costUsd: 0 } };
            }
            tally[r.status] = (tally[r.status] || 0) + 1;
            cost += Number(r.usage && r.usage.costUsd) || 0;
            console.log(progressLine(i + 1, ids.length, r));
        }

        console.log(`\n完成：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join('、')}；實際費用約 ${usd(cost)}`);
        if (tally.failed) exitCode = 1;
    } finally {
        if (db.pool && typeof db.pool.end === 'function') await db.pool.end().catch(() => { });
    }
    return exitCode;
}

if (require.main === module) {
    require('dotenv').config();
    main()
        .then(code => process.exit(code))
        .catch(err => { console.error('❌ ' + err.message); process.exit(1); });
}

module.exports = { parseArgs, progressLine, main };