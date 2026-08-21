// ─────────────────────────────────────────────────────────────
// eval/lib/stateMachineShim.js — 轉接 WS-A 的 pipeline/stateMachine.js
//
// pipeline/ 是 WS-A 的檔案，WS-D 不得改也不能等（分工總表：「B/C 合入前先對 interfaces 的
// outcome 形狀寫，用 stub」）。本檔沿用 eval/lib/tokenize.js 的做法：
//   有 pipeline/stateMachine.js 就用它，一個字都不改；沒有就用這裡這份**逐條抄自
//   docs/interfaces-stage2.md 第 2 條**的暫用實作，並在報表的 meta 記下用了哪一份。
//
// 「逐條抄」不是客氣話：這份實作的每一個分支都對應第 2.3 條的一條編號規則，
// 註解裡標了規則編號。兩份行為若有出入，那是**本檔的錯**，不是介面的錯——
// WS-A 合入後 eval 的數字若因此變動，要改的是這裡。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const REAL_PATH = path.resolve(__dirname, '..', '..', 'pipeline', 'stateMachine.js');

// 第 2.1 條：推進序列（每個非終態恰好對應一個節點）
const NODE_FOR_STATE = {
    extracted: 'dedup0',
    hashed: 'classify',
    classified: 'lint',
    linted: 'verify',
    verified: 'dedup1',
    deduped: 'save'
};

const NEXT_STATE = {
    extracted: 'hashed',
    hashed: 'classified',
    classified: 'linted',
    linted: 'verified',
    verified: 'deduped',
    deduped: 'saved'
};

const TERMINAL_STATES = ['saved', 'needs_review', 'rejected'];

// 第 2.2 條
const DEFAULT_LIMITS = {
    maxRetries: { classify: 2, lint: 2, verify: 1 },
    maxErrorRetries: 3,
    budgetLeft: Infinity
};

const KNOWN_FAIL_REASONS = [
    'chapter_invalid', 'formula_unparsable', 'answer_mismatch',
    'duplicate', 'schema_invalid', 'budget_exceeded', 'provider_error'
];

/** 第 2.3 條的 REVIEW_REASON_FOR_FAIL（全函式，查不到一律落到 awaiting_approval） */
function REVIEW_REASON_FOR_FAIL(reason) {
    return KNOWN_FAIL_REASONS.includes(reason) ? reason : 'awaiting_approval';
}

/** 第 2.3 條的 REVIEW_REASON_FOR_ERROR */
function REVIEW_REASON_FOR_ERROR(errorClass) {
    if (['rate_limited', 'timeout', 'provider_error'].includes(errorClass)) return 'provider_error';
    return REVIEW_REASON_FOR_FAIL(errorClass);
}

/**
 * 第 2 條的純函式狀態機（暫用實作）。
 * @param {{state:string, retries:object, outcome:object, limits:object}} args
 * @returns {{state:string, retries:object, review_reason:string|null}}
 */
function shimTransition({ state, retries, outcome, limits }) {
    const lim = limits || DEFAULT_LIMITS;
    const r = retries || {};

    // 規則 1
    if (!Object.prototype.hasOwnProperty.call(NODE_FOR_STATE, state)) {
        throw new Error(`transition：狀態 ${state} 不可推進`);
    }
    // 規則 2
    const kind = outcome && outcome.kind;
    if (!['pass', 'skipped', 'fail', 'error'].includes(kind)) {
        throw new Error(`transition：未知的 outcome.kind ${kind}`);
    }

    const node = NODE_FOR_STATE[state];
    const budgetLeft = lim.budgetLeft === undefined ? Infinity : lim.budgetLeft;

    // 規則 3：預算用盡且不是 pass／skipped
    if (budgetLeft <= 0 && kind !== 'pass' && kind !== 'skipped') {
        return { state: 'needs_review', retries: { ...r }, review_reason: 'budget_exceeded' };
    }
    // 規則 4
    if (kind === 'pass' || kind === 'skipped') {
        return { state: NEXT_STATE[state], retries: { ...r }, review_reason: null };
    }
    // 規則 5
    if (kind === 'fail') {
        if (outcome.reason === 'budget_exceeded') {
            return { state: 'needs_review', retries: { ...r }, review_reason: 'budget_exceeded' };
        }
        const max = (lim.maxRetries && lim.maxRetries[node]) ?? 0;
        const used = r[node] ?? 0;
        if (used < max) {
            return { state, retries: { ...r, [node]: used + 1 }, review_reason: null };
        }
        return { state: 'needs_review', retries: { ...r }, review_reason: REVIEW_REASON_FOR_FAIL(outcome.reason) };
    }
    // 規則 6：kind === 'error'
    if (outcome.errorClass === 'budget_exceeded') {
        return { state: 'needs_review', retries: { ...r }, review_reason: 'budget_exceeded' };
    }
    const key = `${node}:error`;
    const usedErr = r[key] ?? 0;
    if (usedErr < (lim.maxErrorRetries ?? 3)) {
        return { state, retries: { ...r, [key]: usedErr + 1 }, review_reason: null };
    }
    return { state: 'needs_review', retries: { ...r }, review_reason: REVIEW_REASON_FOR_ERROR(outcome.errorClass) };
}

let _impl = null;
function impl() {
    if (_impl) return _impl;
    if (fs.existsSync(REAL_PATH)) {
        const real = require(REAL_PATH);
        if (typeof real.transition === 'function') {
            _impl = {
                source: 'pipeline/stateMachine.js',
                transition: real.transition,
                NODE_FOR_STATE: real.NODE_FOR_STATE || NODE_FOR_STATE,
                NEXT_STATE: real.NEXT_STATE || NEXT_STATE,
                TERMINAL_STATES: real.TERMINAL_STATES || TERMINAL_STATES,
                DEFAULT_LIMITS: real.DEFAULT_LIMITS || DEFAULT_LIMITS
            };
            return _impl;
        }
    }
    _impl = {
        source: 'eval/lib/stateMachineShim.js（暫用）',
        transition: shimTransition,
        NODE_FOR_STATE, NEXT_STATE, TERMINAL_STATES, DEFAULT_LIMITS
    };
    return _impl;
}

/** @returns {string} 報表 meta 用 */
function source() { return impl().source; }
/** @returns {boolean} */
function isShim() { return impl().source.includes('暫用'); }
/** @param {object} args @returns {object} */
function transition(args) { return impl().transition(args); }
/** @returns {object} */
function tables() {
    const i = impl();
    return {
        NODE_FOR_STATE: i.NODE_FOR_STATE,
        NEXT_STATE: i.NEXT_STATE,
        TERMINAL_STATES: i.TERMINAL_STATES,
        DEFAULT_LIMITS: i.DEFAULT_LIMITS
    };
}

module.exports = {
    transition, source, isShim, tables,
    shimTransition, REVIEW_REASON_FOR_FAIL, REVIEW_REASON_FOR_ERROR,
    NODE_FOR_STATE, NEXT_STATE, TERMINAL_STATES, DEFAULT_LIMITS, REAL_PATH
};
