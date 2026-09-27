// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/launcher.js — 啟動器的主迴圈與單一執行個體鎖（docs/desktop-launcher.md 第 7.1 節）
//
//   runLaunch：facts → plan.nextAction → actions[type]() → 併回 facts → …，直到 open-app／finish／fail，
//              再交給 ui（啟動頁或系統訊息框）。每一步更新啟動頁的步驟與警告，並寫一行 log。
//   lockDecision／acquireLock：同時點兩次圖示時，第二個只把第一個的啟動頁再開一次，不會起兩個後端。
// 本檔不直接碰作業系統（actions、ui、sys 都注入），單元測試用假的 sys 把整個流程跑一遍。
// ─────────────────────────────────────────────────────────────
const plan = require('./plan');

/** 同一種步驟最多做幾次（每一步都會寫進 facts，正常只會各做一次；多了就是決策迴圈沒前進） */
const MAX_REPEAT = 2;
/** 鎖多舊就視為殘留（啟動器當掉沒清掉） */
const LOCK_STALE_MS = 20 * 60 * 1000;

/**
 * 一步的結果縮成一行給 log（不印權杖等敏感值）。純函式。
 * @param {object} patch
 */
function summarize(patch) {
    return Object.entries(patch || {}).map(([k, v]) => {
        const safe = v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).filter(([kk]) => !/token/i.test(kk)).map(([kk, vv]) => [kk, typeof vv === 'string' && vv.length > 300 ? `${vv.slice(0, 300)}…` : vv]))
            : v;
        return `${k}=${JSON.stringify(safe)}`;
    }).join(' ');
}

/**
 * @param {object} o
 * @param {Record<string, (facts:object, action:object) => Promise<object>>} o.actions
 * @param {ReturnType<import('./ui').createUi>} o.ui
 * @param {import('./plan').PlanContext} o.ctx
 * @param {(line:string)=>void} [o.log]
 * @param {object} [o.facts]  一開始就知道的事實（例：configWarnings）
 * @returns {Promise<{action:object, facts:object, warnings:Array<{code:string,text:string}>}>}
 */
async function runLaunch({ actions, ui, ctx, log = () => { }, facts: initial = {} }) {
    const facts = { ...initial };
    const counts = new Map();
    let action = null;
    const publish = a => ui.set({ steps: plan.describeSteps(facts, a), warnings: plan.collectWarnings(facts), note: '' });
    try {
        for (;;) {
            action = plan.nextAction(facts, ctx);
            publish(action);
            if (plan.isTerminal(action)) break;
            const n = (counts.get(action.type) || 0) + 1;
            counts.set(action.type, n);
            if (n > MAX_REPEAT) throw new Error(`決策迴圈沒有前進（${action.type} 做了第 ${n} 次）`);
            const fn = actions[action.type];
            if (typeof fn !== 'function') throw new Error(`沒有實作的步驟：${action.type}`);
            log(`→ ${action.type}`);
            const patch = await fn(facts, action);
            Object.assign(facts, patch);
            log(`  ${summarize(patch)}`);
        }
    } catch (err) {
        log(`！啟動程式內部錯誤：${(err && err.stack) || err}`);
        action = plan.fail('internal', facts, ctx, { detail: String((err && err.message) || err) });
        publish(action);
    }

    const warnings = plan.collectWarnings(facts);
    for (const x of warnings) log(`⚠ ${x.text}`);
    if (action.type === 'open-app') {
        log(`系統已在執行，開啟 app 視窗：${action.url}`);
        await ui.openApp(action.url);
    } else if (action.type === 'finish') {
        log(`啟動完成（${action.reason}）：${action.url}`);
        await ui.finish(action.url, warnings);
    } else {
        log(`✕ ${action.title}：${action.message}`);
        await ui.fail(action, warnings);
    }
    return { action, facts, warnings };
}

// ─────────────────────────── 單一執行個體 ───────────────────────────

/**
 * 已有的鎖檔 → 要不要接手。純函式。
 * @param {{pid?:number, startedAt?:string, statusUrl?:string}|null} existing
 * @param {{now:number, alive:(pid:number)=>boolean, selfPid:number}} o
 * @returns {'take'|'busy'}
 */
function lockDecision(existing, { now, alive, selfPid }) {
    if (!existing || !existing.pid || existing.pid === selfPid) return 'take';
    const started = Date.parse(existing.startedAt || '');
    if (!Number.isFinite(started) || now - started > LOCK_STALE_MS) return 'take';
    return alive(existing.pid) ? 'busy' : 'take';
}

/**
 * 取得啟動鎖（data/launcher/launch.lock）。
 * @param {ReturnType<import('./system').createSystem>} sys
 * @param {string} file
 * @returns {{acquired:true, update:(patch:object)=>void, release:()=>void}|{acquired:false, other:object}}
 */
function acquireLock(sys, file) {
    const mine = { pid: sys.pid, startedAt: new Date(sys.now()).toISOString() };
    const write = obj => sys.writeText(file, `${JSON.stringify(obj)}\n`);
    for (let attempt = 0; attempt < 2; attempt++) {
        if (sys.createExclusive(file, `${JSON.stringify(mine)}\n`)) {
            let current = { ...mine };
            return {
                acquired: true,
                update: patch => { current = { ...current, ...patch }; write(current); },
                release: () => {
                    let onDisk = null;
                    try { onDisk = JSON.parse(sys.readText(file) || 'null'); } catch (_) { onDisk = null; }
                    if (!onDisk || onDisk.pid === mine.pid) sys.remove(file);
                }
            };
        }
        let existing = null;
        try { existing = JSON.parse(sys.readText(file) || 'null'); } catch (_) { existing = null; }
        if (lockDecision(existing, { now: sys.now(), alive: pid => sys.pidAlive(pid), selfPid: sys.pid }) === 'busy') {
            return { acquired: false, other: existing };
        }
        sys.remove(file);   // 殘留的鎖：清掉再試一次
    }
    return { acquired: false, other: {} };
}

module.exports = { runLaunch, summarize, lockDecision, acquireLock, MAX_REPEAT, LOCK_STALE_MS };
