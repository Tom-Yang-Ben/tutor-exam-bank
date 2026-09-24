// ─────────────────────────────────────────────────────────────
// eval/lib/cassettePlan.js — 重錄／清除兩支工具共用的「盤點一輪」與輸出格式
//
//   analyze()       以回放探針跑一組 suite（CI 的設定、LLM_MODE=replay、EMBED_MODE=fixture，**不連網**），
//                   再盤點 cassette、做鍵的靜態稽核、算 nlq 查詢句缺的向量，合成 summarize() 的摘要。
//   formatSummary() 印給 Owner 看的表（中文）。
//   thresholdRows() 把一份 eval 報表（eval/reports/*.json）與 eval/thresholds.json 對照成逐列結果。
//
// 探針紀錄寫在系統暫存目錄，用完就刪（cacheKeyParts 可能含題幹，不得留在 repo 裡）。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readProbeDir } = require('./cassetteProbe');
const { probeSuites, readCiModels, APP_DIR } = require('./suiteProcess');
const audit = require('./cassetteAudit');
const thresholds = require('./thresholds');

/**
 * nlq golden 的查詢向量（expect.semantic_text，沒有就用 query）在向量檔裡缺哪幾句。
 * 探針看不到這一段：suiteNlq 先直接讀向量檔判斷「在不在」，不在就改走 LIKE，根本不呼叫 embed()。
 * @param {object} [opts]
 * @param {string} [opts.goldenFile]
 * @param {Record<string, number[]>|null} [opts.table] 向量檔內容；未給時讀 eval/fixtures 的那一份
 * @returns {Array<{id:string, hash:string, chars:number}>} 依 hash 去重
 */
function nlqQueryGaps(opts = {}) {
    const { sha256Hex, fixturePath } = require('../../services/llm/fixture');
    const goldenFile = opts.goldenFile || path.join(APP_DIR, 'eval', 'golden', 'nlq.json');
    let table = opts.table;
    if (!table) {
        const file = fixturePath(process.env.EMBED_MODEL || 'gemini-embedding-001', Number(process.env.EMBED_DIM || 768));
        table = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    }
    const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
    const seen = new Map();
    for (const e of golden.entries || []) {
        const text = (e.expect && e.expect.semantic_text) || e.query || '';
        const hash = sha256Hex(text);
        if (!Object.prototype.hasOwnProperty.call(table, hash) && !seen.has(hash)) {
            seen.set(hash, { id: e.id, hash, chars: text.length });
        }
    }
    return [...seen.values()];
}

/**
 * 盤點一輪（不連網）。
 * @param {object} opts
 * @param {string[]} opts.suites
 * @param {boolean} [opts.echo=false] 是否轉印各 suite 的輸出
 * @param {(suite:string)=>void} [opts.onStart]
 * @param {Record<string,string[]>} [opts.chapters] 靜態稽核用的章節白名單（測試注入；正式執行不給）
 * @returns {Promise<{runs:object, events:Array<object>, inventory:object, entries:Array<object>, summary:object, models:object}>}
 */
async function analyze({ suites, echo = false, onStart, chapters } = {}) {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cassette-probe-'));
    let runs, events;
    try {
        runs = await probeSuites({ suites, probeDir, echo, onStart });
        events = readProbeDir(probeDir);
    } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
    }
    const inv = audit.inventory();
    const entries = audit.auditKeys(inv.entries, { chapters });
    const summary = audit.summarize({
        events, entries, suites, runs,
        extraEmbedGaps: suites.includes('nlq') ? nlqQueryGaps() : []
    });
    return { runs, events, inventory: inv, entries, summary, models: readCiModels() };
}

const usd = (x) => (typeof x === 'number' ? `$${x.toFixed(4)}` : '—');

/**
 * 把摘要排成給人看的文字（中文、Markdown 表）。
 * @param {object} res analyze() 的回傳
 * @returns {string}
 */
function formatSummary(res) {
    const { summary, models, inventory } = res;
    const lines = [];
    lines.push(`CI 的設定：MODEL_EXTRACT=${models.MODEL_EXTRACT}、MODEL_VERIFY=${models.MODEL_VERIFY}（取自 ${models.source}）；LLM_MODE=replay、EMBED_MODE=fixture`);
    lines.push(`cassette 目錄：${audit.displayPath(inventory.dir)}`);
    lines.push('');
    lines.push('| suite | 有跑 | 命中 | 缺 cassette | 缺向量 | 錄製時 LLM 呼叫（估） | 估計費用 | 備註 |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---|');
    for (const [name, s] of Object.entries(summary.suites)) {
        const notes = [];
        if (s.blocked && s.misses) notes.push('miss 之後的下游節點這一輪看不到，實際呼叫會更多');
        else if (s.blocked) notes.push('缺向量，量測前就停下：這一輪看不到任何 LLM 呼叫，實際會更多');
        if (name === 'retrieval' && s.embed.misses) notes.push('只缺向量（第 1 步補錄）');
        if (s.embed.tolerated && s.embed.misses) notes.push('缺的是存題時的向量：查不到只記 log，不影響 e2e');
        if (s.errors.length) notes.push(`其他錯誤 ${s.errors.length} 筆`);
        if (!s.ran) notes.push('子行程沒有跑起來');
        if (s.exitCode !== null && s.exitCode !== 0 && !s.misses && !s.embed.misses) notes.push(`結束碼 ${s.exitCode}`);
        const isE2e = name === 'e2e';
        const calls = isE2e ? '（由 pipeline 那一步錄）' : (s.blocked ? `≥ ${s.llmCalls}` : String(s.llmCalls));
        lines.push(`| ${name} | ${s.ran ? '是' : '否'} | ${s.hits} | ${s.misses} | ${s.embed.misses} | ${calls} | ${isE2e ? '—' : usd(s.estCostUsd)} | ${notes.join('；')} |`);
    }
    const byAgent = {};
    for (const s of Object.values(summary.suites)) {
        for (const [agent, c] of Object.entries(s.byAgent)) {
            byAgent[agent] = byAgent[agent] || { hits: 0, misses: 0 };
            byAgent[agent].hits += c.hits; byAgent[agent].misses += c.misses;
        }
    }
    if (Object.keys(byAgent).length) {
        lines.push('');
        lines.push('依 agent（跨 suite 加總，同一支 cassette 被兩個 suite 讀到會算兩次）：' +
            Object.entries(byAgent).map(([a, c]) => `${a} 命中 ${c.hits}／缺 ${c.misses}`).join('、'));
    }
    if (summary.e2eOnly.length) {
        lines.push(`⚠️ e2e 有 ${summary.e2eOnly.length} 支 cassette 不在 pipeline 的呼叫裡：重錄時 pipeline 那一步錄不到，需要另外處理。`);
    }
    const c = summary.cassettes;
    lines.push('');
    lines.push(`cassette（範圍內 ${c.total} 支）：這一輪被讀到 ${c.hit}、沒被讀到 ${c.unhit}` +
        `（其中鍵已失效 ${c.unhitKeyInvalid}；是某次 miss 的舊版 ${c.previousVersions}；下游被擋或孤兒 ${c.downstreamOrOrphan}）`);
    for (const s of inventory.skipped) lines.push(`  略過 ${s.name}/（${s.files} 支）：${s.reason}`);
    const e = summary.embeddings;
    lines.push(`向量：缺 ${e.missing} 段，約 ${e.chars} 字元，估 ${usd(e.estCostUsd)}（以字元數當 token 數，偏保守）`);
    const est = summary.estimate;
    lines.push(`預估：錄製時 LLM 呼叫 ${est.callsLower}～${est.callsUpper} 次、費用 ${usd(est.costLowerUsd)}～${usd(est.costUpperUsd)}（未含向量）。` +
        '下限＝這一輪回放看得到的呼叫；上限再加上「沒被讀到、也不是某次 miss 舊版」的 cassette 數（被 miss 擋住的下游多半在這裡）。');
    lines.push('費用依 config/pricing.js；每次呼叫的 token 數取同一呼叫的舊版 cassette，沒有舊版就取同 agent 的平均。');
    return lines.join('\n');
}

/**
 * 一份 eval 報表對照門檻，排成逐列結果。
 * @param {object} doc eval/reports/*.json 的內容（retrieval 或 stage2／3 的形狀）
 * @param {object} [table] thresholds.json 的內容；未給時讀 eval/thresholds.json
 * @returns {{suite:string, rows:Array<{metric:string, measured:number|null, threshold:number, ok:boolean}>, failures:string[], skipped:string[]}}
 */
function thresholdRows(doc, table = thresholds.loadThresholds()) {
    const suite = doc.suite;
    const measured = doc.measured || {};
    const spec = thresholds.SUITE_METRICS[suite];
    if (!spec) throw new Error(`未知的 suite「${suite}」`);
    const cmp = suite === 'retrieval' ? thresholds.compare(table, measured) : thresholds.compareSuite(table, suite, measured);
    const want = table[suite] || {};
    const rows = [];
    for (const column of spec.columns) {
        for (const metric of spec.metrics) {
            const t = want[column] && want[column][metric];
            if (typeof t !== 'number') continue;
            const got = measured[column] ? measured[column][metric] : null;
            const v = typeof got === 'number' ? got : null;
            rows.push({ metric: `${column}.${metric}`, measured: v, threshold: t, ok: v !== null && v + 1e-9 >= t });
        }
    }
    return { suite, rows, failures: cmp.failures, skipped: cmp.skipped };
}

module.exports = { analyze, formatSummary, thresholdRows, nlqQueryGaps };
