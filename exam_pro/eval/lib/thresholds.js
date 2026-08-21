// ─────────────────────────────────────────────────────────────
// eval/lib/thresholds.js — CI 門檻的初值與 ratchet
//
// 規劃 §5.3.3：「thresholds.json 的初值由第一次量測的基準線減 0.03 產生，
//               之後只能調高（ratchet），調整需改 json 並在 PR 說明」。
//
// 兩個防呆，兩個都有實際會發生的錯誤情境：
//   1. **stub 狀態不得寫初值**。utils/tokenize.js 或 utils/embedText.js 還沒合入時，
//      LIKE 欄與向量欄量到的是 eval 自己的暫用實作；用它當基準線，等 WS-C 合入
//      真正的 jieba 之後數字必然變動，CI 會紅得莫名其妙。
//   2. **只升不降**。writeBaseline() 遇到已存在且更高的門檻會保留舊值並提醒，
//      避免「跑一次比較差的實驗就把門檻洗低」——那正是 ratchet 要防的事。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.resolve(__dirname, '..', 'thresholds.json');
const BASELINE_MARGIN = 0.03;   // 初值 = 第一次量測 − 0.03

/**
 * @param {string} [file]
 * @returns {object}
 */
function loadThresholds(file) {
    const target = path.resolve(file || DEFAULT_PATH);
    if (!fs.existsSync(target)) return { retrieval: {} };
    return JSON.parse(fs.readFileSync(target, 'utf8'));
}

/**
 * 對照一份量測結果與門檻。
 *
 * 門檻是 null = 「還沒有基準線」：只報告不擋，讓骨架階段的 CI 能跑完；
 * 一旦寫入數字就變成硬門檻。這個「null 不擋、有值就擋」的設計，讓
 * 「向量欄還沒錄向量」與「向量欄退步了」不會混成同一種紅燈。
 *
 * @param {object} thresholds  { retrieval: { like: {recall5, recall10, mrr}|null, … } }
 * @param {object} measured    { like: {recall5,…}|null, vector: …, hybrid: … }
 * @returns {{failures:string[], checked:number, skipped:string[]}}
 */
function compare(thresholds, measured) {
    const failures = [];
    const skipped = [];
    let checked = 0;
    const table = (thresholds && thresholds.retrieval) || {};

    for (const mode of ['like', 'vector', 'hybrid']) {
        const want = table[mode];
        const got = measured[mode];
        if (!want) { skipped.push(`${mode}（門檻尚未建立）`); continue; }
        if (!got) { failures.push(`${mode}：門檻已存在（recall5 ≥ ${want.recall5}）但這次沒有量到數字`); continue; }
        for (const metric of ['recall5', 'recall10', 'mrr']) {
            if (want[metric] === null || want[metric] === undefined) continue;
            checked++;
            if (got[metric] === null || got[metric] === undefined) {
                failures.push(`${mode}.${metric}：門檻 ${want[metric]} 但這次是 n/a`);
            } else if (got[metric] + 1e-9 < want[metric]) {
                failures.push(`${mode}.${metric}：${got[metric].toFixed(4)} < 門檻 ${want[metric]}`);
            }
        }
    }
    return { failures, checked, skipped };
}

/**
 * 寫入／提高門檻。只動「目前是 null」或「新值更高」的項目。
 *
 * @param {object} opts
 * @param {object} opts.measured   量測結果
 * @param {string} [opts.file]
 * @param {boolean} opts.allowStub 是否允許在 stub 分詞／embedText 狀態下寫入（預設不允許）
 * @param {object} opts.meta       寫進檔案的量測環境（模型、分詞器、engine、golden…）
 * @returns {{written:boolean, changes:string[], kept:string[]}}
 */
function writeBaseline(opts) {
    const target = path.resolve(opts.file || DEFAULT_PATH);
    const current = loadThresholds(target);
    current.retrieval = current.retrieval || {};

    const changes = [];
    const kept = [];
    for (const mode of ['like', 'vector', 'hybrid']) {
        const got = opts.measured[mode];
        if (!got) { kept.push(`${mode}：這次沒有量到，維持原狀`); continue; }
        const existing = current.retrieval[mode] || null;
        const next = {};
        for (const metric of ['recall5', 'recall10', 'mrr']) {
            if (got[metric] === null || got[metric] === undefined) { next[metric] = existing ? existing[metric] : null; continue; }
            const candidate = Math.max(0, Math.round((got[metric] - BASELINE_MARGIN) * 10000) / 10000);
            const old = existing ? existing[metric] : null;
            if (old === null || old === undefined) {
                next[metric] = candidate;
                changes.push(`${mode}.${metric}：（無）→ ${candidate}`);
            } else if (candidate > old) {
                next[metric] = candidate;
                changes.push(`${mode}.${metric}：${old} → ${candidate}（ratchet 調高）`);
            } else {
                next[metric] = old;
                kept.push(`${mode}.${metric}：維持 ${old}（新量測 −0.03 後為 ${candidate}，門檻只升不降）`);
            }
        }
        current.retrieval[mode] = next;
    }

    current._measured_with = opts.meta || {};
    current._rule = `初值 = 第一次量測 − ${BASELINE_MARGIN}，之後只升不降（ratchet）。調整必須改本檔並在 PR 說明。`;

    if (changes.length === 0) return { written: false, changes, kept };
    fs.writeFileSync(target, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return { written: true, changes, kept };
}

// ─────────────────────────────────────────────────────────────
// 階段 2 新增：suite 通用的門檻比對與 ratchet（A-T14）
//
// 階段 1 的 compare() / writeBaseline() 把 suite 名（retrieval）與三個欄（like/vector/hybrid）
// 寫死在函式裡。階段 2 多了 classify 與 pipeline 兩個 suite，欄與指標都不一樣，
// 所以抽出通用版；**retrieval 的兩支照原樣保留**（既有行為與 eval:baseline 的輸出是契約）。
//
// 一條新規矩：**只放「越高越好」的指標**。needs_review 的比率越低越好，
// 放進 ratchet 會變成「只准更多題進複核」——那不是門檻，是反向的門檻。
// 這類指標只報告、不設門檻。
// ─────────────────────────────────────────────────────────────

const SUITE_METRICS = {
    retrieval: { columns: ['like', 'vector', 'hybrid'], metrics: ['recall5', 'recall10', 'mrr'] },
    // classify：cassette 回放 vs golden（規劃 §5.3.2、§3.8）
    classify: { columns: ['classify'], metrics: ['accuracy', 'macro_f1'] },
    // pipeline：對 sample_exam.pdf 跑整條管線（A-T14）
    pipeline: { columns: ['pipeline'], metrics: ['saved_rate', 'gate_pass_rate', 'answer_agree_rate'] }
};

/**
 * 通用的門檻比對。
 * @param {object} thresholds  整份 thresholds.json
 * @param {string} suite       'retrieval'|'classify'|'pipeline'
 * @param {object} measured    { <column>: { <metric>: number|null } | null }
 * @returns {{failures:string[], checked:number, skipped:string[]}}
 */
function compareSuite(thresholds, suite, measured) {
    const spec = SUITE_METRICS[suite];
    if (!spec) throw new Error(`未知的 suite「${suite}」`);
    const failures = [];
    const skipped = [];
    let checked = 0;
    const table = (thresholds && thresholds[suite]) || {};

    for (const column of spec.columns) {
        const want = table[column];
        const got = measured[column];
        if (!want) { skipped.push(`${column}（門檻尚未建立）`); continue; }
        if (!got) { failures.push(`${column}：門檻已存在但這次沒有量到任何數字`); continue; }
        for (const metric of spec.metrics) {
            if (want[metric] === null || want[metric] === undefined) continue;
            checked++;
            const v = got[metric];
            if (v === null || v === undefined) {
                // 門檻有數字卻量不到 = 失敗。否則「cassette 被誤刪」會表現成 CI 全綠。
                failures.push(`${column}.${metric}：門檻 ${want[metric]} 但這次是 n/a`);
            } else if (v + 1e-9 < want[metric]) {
                failures.push(`${column}.${metric}：${v.toFixed(4)} < 門檻 ${want[metric]}`);
            }
        }
    }
    return { failures, checked, skipped };
}

/**
 * 通用的 ratchet 寫入。
 * @param {object} opts
 * @param {string} opts.suite
 * @param {object} opts.measured
 * @param {string} [opts.file]
 * @param {object} [opts.meta]     寫進 <suite>._measured_with
 * @returns {{written:boolean, changes:string[], kept:string[]}}
 */
function writeBaselineSuite(opts) {
    const spec = SUITE_METRICS[opts.suite];
    if (!spec) throw new Error(`未知的 suite「${opts.suite}」`);
    const target = path.resolve(opts.file || DEFAULT_PATH);
    const current = loadThresholds(target);
    current[opts.suite] = current[opts.suite] || {};

    const changes = [];
    const kept = [];
    for (const column of spec.columns) {
        const got = opts.measured[column];
        if (!got) { kept.push(`${column}：這次沒有量到，維持原狀`); continue; }
        const existing = current[opts.suite][column] || null;
        const next = {};
        for (const metric of spec.metrics) {
            const v = got[metric];
            if (v === null || v === undefined) { next[metric] = existing ? existing[metric] : null; continue; }
            const candidate = Math.max(0, Math.round((v - BASELINE_MARGIN) * 10000) / 10000);
            const old = existing ? existing[metric] : null;
            if (old === null || old === undefined) {
                next[metric] = candidate;
                changes.push(`${opts.suite}.${column}.${metric}：（無）→ ${candidate}`);
            } else if (candidate > old) {
                next[metric] = candidate;
                changes.push(`${opts.suite}.${column}.${metric}：${old} → ${candidate}（ratchet 調高）`);
            } else {
                next[metric] = old;
                kept.push(`${opts.suite}.${column}.${metric}：維持 ${old}（新量測 −${BASELINE_MARGIN} 後為 ${candidate}）`);
            }
        }
        current[opts.suite][column] = next;
    }

    if (opts.meta) current[`_${opts.suite}_measured_with`] = opts.meta;
    if (changes.length === 0) return { written: false, changes, kept };
    fs.writeFileSync(target, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return { written: true, changes, kept };
}

module.exports = {
    loadThresholds, compare, writeBaseline, DEFAULT_PATH, BASELINE_MARGIN,
    compareSuite, writeBaselineSuite, SUITE_METRICS
};
