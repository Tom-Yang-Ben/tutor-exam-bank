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

module.exports = { loadThresholds, compare, writeBaseline, DEFAULT_PATH, BASELINE_MARGIN };
