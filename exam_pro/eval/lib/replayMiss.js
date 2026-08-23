// ─────────────────────────────────────────────────────────────
// eval/lib/replayMiss.js — replay miss 的辨識與 fork PR 降級（介面第 5.2 條、裁決 S2-14）
//
// 第 5.2 條把兩件事分給兩邊：
//   `services/llm/fake.js`  —— miss 一律丟錯，訊息逐字凍結，`<suite>` **保持字面不代換**
//                              （它不知道自己在跑哪個 suite）。
//   `eval/`（WS-D）         —— 判斷「這是不是 replay miss」，以及 fork PR 要不要降成 warning。
//                              「**這個判斷不在 services/llm 裡**」是介面的原話。
//
// 裁決 S2-14：**比對訊息只比到 `--suite ` 為止**。
//   理由：`<suite>` 之後的內容是給人看的（實作還會另接一行預期路徑），
//   拿整串去比會讓「多印一行有用的提示」變成一個破壞性改動。
//   凍結的是前綴，不是整句。
// ─────────────────────────────────────────────────────────────

const { parseBool } = require('../../config/features');

/** 第 5.2 條凍結訊息中，`--suite ` 之前的那一段（含它自己） */
const REPLAY_MISS_PREFIX = 'LLM_MODE=replay 找不到 cassette';
const REPLAY_MISS_SUITE_MARKER = 'npm run eval:record -- --suite ';

/**
 * 這個錯誤是不是 replay miss？
 *
 * 只比對兩段固定字串：開頭的「找不到 cassette」與「-- --suite 」這個標記。
 * 兩者之間的 agent／key、之後的 suite 名與預期路徑一律不比（裁決 S2-14）。
 *
 * @param {Error|string} err
 * @returns {boolean}
 */
function isReplayMiss(err) {
    const msg = typeof err === 'string' ? err : (err && err.message) || '';
    return msg.startsWith(REPLAY_MISS_PREFIX) && msg.includes(REPLAY_MISS_SUITE_MARKER);
}

/**
 * 從 replay miss 的訊息裡撈出 agent 與 key（給報表分組用）。
 * 撈不到不算錯——訊息的中段不是凍結的比對對象。
 * @param {Error|string} err
 * @returns {{agent:string|null, key:string|null}}
 */
function parseReplayMiss(err) {
    const msg = typeof err === 'string' ? err : (err && err.message) || '';
    const m = msg.match(/agent=([^\s）)]+)\s+key=([0-9a-f]+)/);
    return m ? { agent: m[1], key: m[2] } : { agent: null, key: null };
}

/**
 * 這一輪要不要把 replay miss 降成 warning？
 *
 * 規劃 §5.3.3：「例外：`github.event.pull_request.head.repo.fork == true` 的 PR 把 miss
 * 降為 warning（外部貢獻者拿不到金鑰、無法自救）；main 與同 repo 分支強制。」
 *
 * 判斷只看 `EVAL_FORK_PR` 這一個環境變數，由 `.github/workflows/ci.yml` 從
 * `${{ github.event.pull_request.head.repo.fork }}` 傳進來。本機一律不降級——
 * 本機跑得出 miss 就是真的少錄了 cassette，那正是要被擋下來的事。
 *
 * @returns {boolean}
 */
function shouldDowngradeMiss() {
    return parseBool(process.env.EVAL_FORK_PR);
}

/**
 * 把一批失敗訊息分成「replay miss」與「其他」。
 * @param {string[]} failures
 * @returns {{misses:string[], others:string[]}}
 */
function partitionFailures(failures) {
    const misses = [];
    const others = [];
    for (const f of failures || []) {
        (isReplayMiss(f) ? misses : others).push(f);
    }
    return { misses, others };
}

module.exports = {
    isReplayMiss, parseReplayMiss, shouldDowngradeMiss, partitionFailures,
    REPLAY_MISS_PREFIX, REPLAY_MISS_SUITE_MARKER
};
