// ─────────────────────────────────────────────────────────────
// eval/lib/cassetteAudit.js — cassette 盤點、鍵的靜態稽核、重錄估算（純函式為主）
//
// 給 eval/tools/rerecord_all.js 與 eval/tools/prune_cassettes.js 共用
// （docs/chapter-restructure.md 第 3.2 條第 2、3 點）。三件事：
//
//   1. inventory()      盤點 eval/cassettes/ 底下「在範圍內」的 cassette。
//                       範圍＝五個 eval 與 e2e 會回放的六個 agent：extract／classify／lint／verify／nlq／variant，
//                       〔本機模式 L4〕加上本機拆題的 ocr／extract_vision／extract_ocr（docs/local-mode.md 第 6 條）。
//                       化學（*_chem）、tutor、voice 依第 3.2 條第 3 點**不在範圍內**；
//                       其他沒見過的目錄也一律不碰（寧可少清，不可誤刪別人的錄音）。
//   2. auditKeys()      靜態稽核：拿 cassette 自己記下的 meta.model／meta.template／request.cacheKeyParts，
//                       以「現在的」schema 重算一次鍵（services/llm/cassette.js 的同一條公式）。
//                       重算出來的鍵與檔名不同＝這支 cassette 已經不可能再被讀到（schema／模板／模型改了）。
//                       章節白名單可以**注入**：測試用 config/chapterPlan.js 的新清單模擬「CH-A 合入之後」。
//   3. summarize()      把探針紀錄（eval/lib/cassetteProbe.js）與盤點結果合成每個 suite 的
//                       命中／缺／錄製時呼叫次數與費用估計（費用用 config/pricing.js）。
//
// 為什麼錄製呼叫次數要「命中＋缺」而不是只算缺：repo 既有的錄製機制是 LLM_MODE=record，
// 它對一個 suite 的每一次呼叫都會真的打模型（services/llm/index.js），沒有「只補缺的」這種模式。
// 本檔照實估，不另造一套只補缺的機制（第 3.2 條第 2 點）。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { cassetteKey, cassetteDir } = require('../../services/llm/cassette');
const { estimateCost } = require('../../config/pricing');

const APP_DIR = path.resolve(__dirname, '..', '..');

/**
 * 五個 eval 與 e2e 會回放的 agent（第 3.2 條第 3 點的清除範圍）。
 * 〔本機模式 L4〕docs/local-mode.md 第 6 條第 2 點：本機拆題新增的三個 cassette 目錄
 * （ocr、extract_vision、extract_ocr；第 4 條第 2、3 點）一併納入盤點與清除。化學版（*_chem）照舊不碰。
 */
const IN_SCOPE_AGENTS = Object.freeze(['extract', 'classify', 'lint', 'verify', 'nlq', 'variant', 'ocr', 'extract_vision', 'extract_ocr']);

/** 不呼叫 LLM 的 suite（只讀向量檔）：缺向量不會「擋住下游的 LLM 呼叫」 */
const NO_LLM_SUITES = Object.freeze(['retrieval']);
/**
 * 缺向量時照樣跑得完的 suite：e2e 存題時算不到向量只記 log（services/embedService.js），
 * 不會讓 e2e 失敗，也不會擋住後面的節點。
 */
const EMBED_TOLERANT_SUITES = Object.freeze(['e2e']);

/**
 * agent 目錄 → schema 檔名（agents/schemas/<name>.json）。
 * 〔本機模式 L4〕視覺版與 OCR 版拆題用與 extract「同一份」schema（docs/local-mode.md 第 4 條第 3 點）。
 */
const SCHEMA_OF_AGENT = Object.freeze({
    extract: 'extract', classify: 'classify', lint: 'lint', verify: 'verify', nlq: 'nlq', variant: 'variant',
    extract_vision: 'extract', extract_ocr: 'extract'
});
/**
 * 〔本機模式 L4〕沒有 schema 的 agent：鍵的 schemaHash 是空字串的雜湊（services/llm/cassette.js）。
 * ocr 的鍵＝cassetteKey({agent:'ocr', modelId:'paddleocr@<版本>', template:'ocr.v1', cacheKeyParts})（第 4 條第 2 點）。
 */
const NO_SCHEMA_AGENTS = Object.freeze(['ocr']);

/**
 * 這個 agent 目錄為什麼不在範圍內；在範圍內回 null。
 * @param {string} name 目錄名（＝agent 名）
 * @returns {string|null}
 */
function outOfScopeReason(name) {
    if (/_chem$/.test(name)) return '化學 cassette（*_chem）不在範圍內';
    if (name === 'tutor' || name === 'voice') return 'tutor／voice 不在範圍內';
    if (!IN_SCOPE_AGENTS.includes(name)) return '不是五個 eval 與 e2e 會回放的 agent，一律不碰';
    return null;
}

/** 顯示用路徑：在 exam_pro/ 底下就用相對路徑（正斜線），否則原樣 */
function displayPath(file) {
    const rel = path.relative(APP_DIR, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
}

/**
 * 盤點 cassette 目錄。
 * @param {string} [dir] 預設 services/llm/cassette.js 的 cassetteDir()（EVAL_CASSETTE_DIR 可覆寫）
 * @returns {{dir:string, entries:Array<object>, skipped:Array<{name:string, reason:string, files:number}>}}
 *          entries[i] = { agent, key, file, rel, model, template, recordedAt, usage, cacheKeyParts, error? }
 */
function inventory(dir = cassetteDir()) {
    const root = path.resolve(dir);
    const entries = [];
    const skipped = [];
    if (!fs.existsSync(root)) return { dir: root, entries, skipped };

    for (const name of fs.readdirSync(root).sort()) {
        const agentDir = path.join(root, name);
        if (!fs.statSync(agentDir).isDirectory()) continue;
        const files = fs.readdirSync(agentDir).filter(f => f.endsWith('.json')).sort();
        const reason = outOfScopeReason(name);
        if (reason) { skipped.push({ name, reason, files: files.length }); continue; }

        for (const f of files) {
            const file = path.join(agentDir, f);
            const entry = { agent: name, key: f.slice(0, -'.json'.length), file, rel: displayPath(file) };
            try {
                const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
                const meta = doc.meta || {};
                const response = doc.response || {};
                Object.assign(entry, {
                    model: meta.model ?? null,
                    template: meta.template ?? null,
                    recordedAt: meta.recorded_at ?? null,
                    usage: response.usage || null,
                    cacheKeyParts: (doc.request && doc.request.cacheKeyParts) ?? null
                });
            } catch (err) {
                entry.error = `不是合法 JSON：${err.message.split('\n')[0]}`;
            }
            entries.push(entry);
        }
    }
    return { dir: root, entries, skipped };
}

// ───────────────────────── 靜態稽核：以現在的 schema 重算鍵 ─────────────────────────

/**
 * 依 enum 值域把 agents/schemas/<name>.json 的 x-enum 換成 enum。
 * 與 agents/schemas/index.js 的 injectEnums **逐鍵同序**（schemaHash 是 JSON.stringify 的雜湊，
 * 鍵順序差一點就是另一個鍵）；單元測試釘住「不注入時與 buildSchema() 逐字相同」。
 * @param {*} node
 * @param {Record<string, string[]>} sources
 * @returns {*}
 */
function injectEnums(node, sources) {
    if (Array.isArray(node)) return node.map(v => injectEnums(v, sources));
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === 'x-enum') {
            const values = sources[value];
            if (!values) throw new Error(`cassetteAudit：未知的 x-enum「${value}」`);
            out.enum = values.slice();
            continue;
        }
        out[key] = injectEnums(value, sources);
    }
    return out;
}

/**
 * 數學／物理卷別的 enum 值域；可注入章節白名單。
 *
 * 〔Owner 決策單 2026-09-25 B5〕nlq.json（nlq.v2）改讀三科的 chapter_all（agents/schemas/index.js）：
 * 注入時 chapter_all 也要跟著換——數學、物理取注入的清單（必填，同 chapter），化學有注入就用注入的，
 * 沒有就沿用現行 config/chapters.js（CH-B 的重標只注入數學與物理）。順序與 ENUM_SOURCES.chapter_all 相同（SUBJECTS 序）。
 * @param {Record<string,string[]>} [chapters] 注入的 { 科目: 章節[] }；chapter 只取 LEGACY_SUBJECTS（數學、物理）兩科
 * @returns {Record<string, string[]>}
 */
function enumSources(chapters) {
    const { ENUM_SOURCES } = require('../../agents/schemas');
    if (!chapters) return ENUM_SOURCES;
    const { LEGACY_SUBJECTS, SUBJECTS, CHAPTERS } = require('../../config/chapters');
    const legacyOf = (s) => {
        if (!Array.isArray(chapters[s])) throw new Error(`cassetteAudit：注入的 chapters 缺少「${s}」`);
        return chapters[s];
    };
    return {
        ...ENUM_SOURCES,
        chapter: LEGACY_SUBJECTS.flatMap(legacyOf),
        chapter_all: SUBJECTS.flatMap(s => (LEGACY_SUBJECTS.includes(s)
            ? legacyOf(s)
            : (Array.isArray(chapters[s]) ? chapters[s] : CHAPTERS[s])))
    };
}

/**
 * 某個 schema 在指定值域下的樣子。
 * @param {string} name agents/schemas/<name>.json
 * @param {Record<string,string[]>} [chapters]
 * @returns {object}
 */
function schemaFor(name, chapters) {
    const raw = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'agents', 'schemas', `${name}.json`), 'utf8'));
    return injectEnums(raw, enumSources(chapters));
}

let templatesLoaded = false;
/**
 * 載入六個 agent 的模組，讓模板註冊表（services/llm/templates.js）有原文可以雜湊。
 * 〔本機模式 L4〕本機拆題的兩份模板（extract_vision.v1、extract_ocr.v1）由 agents/extract.js 註冊；
 * services/ocr 若註冊了 ocr.v1 也一併載入（檔案不存在＝本機 OCR 還沒合入，略過）。
 */
function ensureTemplatesRegistered() {
    if (templatesLoaded) return;
    require('../../agents/extract');
    require('../../agents/classify');
    require('../../agents/lint');
    require('../../agents/verify');
    require('../../agents/generateVariant');
    require('../../services/nlqService');
    const ocrIndex = path.join(APP_DIR, 'services', 'ocr', 'index.js');
    if (fs.existsSync(ocrIndex)) require(ocrIndex);
    templatesLoaded = true;
}

/**
 * 靜態稽核：每支 cassette 以「現在的」schema（可注入章節）重算鍵。
 *
 * 只看得到 schema／模板／模型這三種失效；「題幹或輸入變了」（cacheKeyParts 不同）
 * 要靠探針回放才看得到——那種 cassette 在這裡仍顯示有效，但不會被任何 suite 讀到。
 *
 * @param {Array<object>} entries inventory().entries
 * @param {{chapters?:Record<string,string[]>}} [opts]
 * @returns {Array<object>} entries 的淺拷貝，多了 { expectedKey, keyValid }
 */
function auditKeys(entries, opts = {}) {
    ensureTemplatesRegistered();
    const schemas = new Map();
    const schemaOf = (agent) => {
        const name = SCHEMA_OF_AGENT[agent];
        if (!schemas.has(name)) schemas.set(name, schemaFor(name, opts.chapters));
        return schemas.get(name);
    };
    return entries.map((e) => {
        const noSchema = NO_SCHEMA_AGENTS.includes(e.agent);
        if (e.error || (!SCHEMA_OF_AGENT[e.agent] && !noSchema)) return { ...e, expectedKey: null, keyValid: false };
        const expectedKey = cassetteKey({
            agent: e.agent,
            modelId: e.model || '',
            template: e.template || undefined,
            schema: noSchema ? undefined : schemaOf(e.agent),
            cacheKeyParts: e.cacheKeyParts ?? {}
        });
        return { ...e, expectedKey, keyValid: expectedKey === e.key };
    });
}

// ───────────────────────── 探針紀錄 → 每個 suite 的計數 ─────────────────────────

/** 同一個 agent 的平均 token 用量（估「沒有舊版可參考」的新呼叫） */
function averageUsage(entries, agent) {
    const rows = entries.filter(e => e.agent === agent && e.usage);
    if (!rows.length) return null;
    const sum = { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 };
    for (const r of rows) for (const k of Object.keys(sum)) sum[k] += Number(r.usage[k]) || 0;
    for (const k of Object.keys(sum)) sum[k] = Math.round(sum[k] / rows.length);
    return sum;
}

/**
 * 一次呼叫的費用估計（config/pricing.js；查不到價格回 0 並標 estimated=false）。
 * @returns {{usd:number, estimated:boolean}}
 */
function callCost(modelId, usage) {
    if (!usage) return { usd: 0, estimated: false };
    const { cost_usd, cost_estimated } = estimateCost({ modelId, ...usage });
    return { usd: cost_usd, estimated: cost_estimated };
}

/**
 * embedding 的費用估計：以字元數當 token 數（中文約一字一 token，偏保守）。
 * @param {number} chars
 * @returns {number} USD
 */
function embedCost(chars) {
    const { PRICING } = require('../../config/pricing');
    const row = PRICING['gemini-embedding-001'];
    if (!row || !row.verified_on) return 0;
    return Number(((chars * row.input) / 1_000_000).toFixed(6));
}

const r6 = (x) => Number(x.toFixed(6));

/**
 * 合成摘要。
 *
 * @param {object} opts
 * @param {Array<object>} opts.events   eval/lib/cassetteProbe.js 的紀錄（每行帶 suite）
 * @param {Array<object>} opts.entries  inventory().entries（最好先過 auditKeys，才有 keyValid）
 * @param {string[]} opts.suites        這一輪跑了哪些 suite（依序）
 * @param {Record<string,{exitCode:number|null}>} [opts.runs] 各 suite 子行程的結束碼
 * @param {Array<{id:string, hash:string, chars:number}>} [opts.extraEmbedGaps] 探針看不到、另外靜態算出的缺向量
 *        （nlq 的查詢向量：suiteNlq 直接讀向量檔，不經 embed()）
 * @returns {object} 見檔頭；所有數字都是「distinct 鍵」數
 */
function summarize({ events, entries, suites, runs = {}, extraEmbedGaps = [] }) {
    const byKey = new Map(entries.map(e => [`${e.agent}/${e.key}`, e]));
    // 「舊版」：與某次 miss 同 agent、同 cacheKeyParts 的既有 cassette——鍵變了（schema／模板／模型），
    // 呼叫本身沒變。它的 token 用量就是那次重錄最好的估計。
    const byParts = new Map();
    for (const e of entries) {
        if (!e.cacheKeyParts) continue;
        const sig = `${e.agent}\n${JSON.stringify(e.cacheKeyParts)}`;
        if (!byParts.has(sig)) byParts.set(sig, []);
        byParts.get(sig).push(e);
    }

    const hitAll = new Set();
    const previousVersions = new Set();
    const perSuite = {};

    for (const suite of suites) {
        const evs = events.filter(ev => ev.suite === suite);
        const hits = new Map();     // agent/key → model
        const misses = new Map();   // agent/key → event
        const errors = [];
        const embedHit = new Set();
        const embedMiss = new Map();   // hash → chars
        for (const ev of evs) {
            if (ev.kind === 'llm') {
                if (ev.hit && ev.key) hits.set(`${ev.agent}/${ev.key}`, ev.model);
                else if (!ev.hit && ev.key) { if (!misses.has(`${ev.agent}/${ev.key}`)) misses.set(`${ev.agent}/${ev.key}`, ev); }
                else if (ev.error) errors.push(`${ev.agent}：${ev.error}`);
            } else if (ev.kind === 'embed') {
                if (ev.hit) embedHit.add(ev.hash);
                else embedMiss.set(ev.hash, ev.chars || 0);
            }
        }
        for (const k of hits.keys()) hitAll.add(k);

        const byAgent = {};
        const bump = (agent, field) => {
            byAgent[agent] = byAgent[agent] || { hits: 0, misses: 0 };
            byAgent[agent][field] += 1;
        };
        let costUsd = 0;
        let costEstimated = true;
        for (const [k, model] of hits) {
            const agent = k.split('/')[0];
            bump(agent, 'hits');
            const e = byKey.get(k);
            const c = callCost(model || (e && e.model), e && e.usage);
            costUsd += c.usd; costEstimated = costEstimated && c.estimated;
        }
        const exitCode = runs[suite] ? runs[suite].exitCode : null;
        let matched = 0;
        for (const ev of misses.values()) {
            bump(ev.agent, 'misses');
            const prev = byParts.get(`${ev.agent}\n${JSON.stringify(ev.cacheKeyParts ?? {})}`) || [];
            let usage = null;
            if (prev.length) {
                matched += 1;
                for (const p of prev) previousVersions.add(`${p.agent}/${p.key}`);
                usage = prev[0].usage;
            } else {
                usage = averageUsage(entries, ev.agent);
            }
            const c = callCost(ev.model, usage);
            costUsd += c.usd; costEstimated = costEstimated && c.estimated;
        }

        const started = evs.some(ev => ev.kind === 'start');
        perSuite[suite] = {
            ran: started,
            exitCode,
            llmCalls: hits.size + misses.size,
            hits: hits.size,
            misses: misses.size,
            missesWithPreviousVersion: matched,
            byAgent,
            errors,
            // miss 之後的下游節點這一輪看不到（replay 在 miss 那一步就停了），實際呼叫只會更多。
            // 缺向量也會擋：variant 在量測前先檢查 fixture 題的向量齊不齊，缺一題就停（不拿假向量湊數字）。
            blocked: misses.size > 0 || (embedMiss.size > 0 && !NO_LLM_SUITES.includes(suite) && !EMBED_TOLERANT_SUITES.includes(suite)
                && hits.size === 0 && exitCode !== 0),
            embed: {
                hits: embedHit.size,
                misses: embedMiss.size,
                missingChars: [...embedMiss.values()].reduce((a, b) => a + b, 0),
                tolerated: EMBED_TOLERANT_SUITES.includes(suite)
            },
            estCostUsd: r6(costUsd),
            costEstimated,
            missKeys: [...misses.keys()].sort(),
            hitKeys: [...hits.keys()].sort()
        };
    }

    // e2e 的呼叫由 pipeline 那一步順帶錄到（同一份樣卷、同一組 agent 與 cacheKeyParts）；
    // e2e 自己不能錄（LLM_MODE 不是 replay 時它會拒絕執行）。列出 pipeline 碰不到的 e2e 鍵。
    let e2eOnly = [];
    if (perSuite.e2e && perSuite.pipeline) {
        const pipelineKeys = new Set([...perSuite.pipeline.hitKeys, ...perSuite.pipeline.missKeys]);
        e2eOnly = [...perSuite.e2e.hitKeys, ...perSuite.e2e.missKeys].filter(k => !pipelineKeys.has(k));
    }

    // 沒被任何 suite 讀到的 cassette：扣掉「某次 miss 的舊版」，剩下的是「下游被擋」或「孤兒」。
    const unhit = entries.filter(e => !hitAll.has(`${e.agent}/${e.key}`));
    const downstream = unhit.filter(e => !previousVersions.has(`${e.agent}/${e.key}`));
    let downstreamCost = 0;
    for (const e of downstream) downstreamCost += callCost(e.model, e.usage).usd;

    const recordSuites = suites.filter(s => s !== 'e2e');   // e2e 由 pipeline 那一步順帶錄
    const callsLower = recordSuites.reduce((a, s) => a + perSuite[s].llmCalls, 0);
    const costLower = recordSuites.reduce((a, s) => a + perSuite[s].estCostUsd, 0);

    // 向量：探針看到的缺（fixture 題、embed() 查不到的字串）＋另外靜態算出的缺（nlq 查詢句）
    const embedMissing = new Map();
    for (const s of suites.filter(x => !EMBED_TOLERANT_SUITES.includes(x))) {
        for (const ev of events.filter(x => x.suite === s && x.kind === 'embed' && !x.hit)) embedMissing.set(ev.hash, ev.chars || 0);
    }
    for (const g of extraEmbedGaps) embedMissing.set(g.hash, g.chars || 0);
    const embedChars = [...embedMissing.values()].reduce((a, b) => a + b, 0);

    return {
        suites: perSuite,
        e2eOnly,
        cassettes: {
            total: entries.length,
            hit: entries.length - unhit.length,
            unhit: unhit.length,
            unhitKeyInvalid: unhit.filter(e => e.keyValid === false).length,
            previousVersions: previousVersions.size,
            downstreamOrOrphan: downstream.length
        },
        embeddings: { missing: embedMissing.size, chars: embedChars, estCostUsd: embedCost(embedChars) },
        estimate: {
            callsLower,
            callsUpper: callsLower + downstream.length,
            costLowerUsd: r6(costLower),
            costUpperUsd: r6(costLower + downstreamCost)
        },
        unhit: unhit.map(e => ({ agent: e.agent, key: e.key, rel: e.rel, keyValid: e.keyValid, previousVersion: previousVersions.has(`${e.agent}/${e.key}`) }))
    };
}

module.exports = {
    IN_SCOPE_AGENTS, SCHEMA_OF_AGENT, NO_SCHEMA_AGENTS, NO_LLM_SUITES, EMBED_TOLERANT_SUITES, outOfScopeReason,
    inventory, auditKeys, schemaFor, injectEnums, enumSources,
    summarize, averageUsage, callCost, embedCost, displayPath
};
