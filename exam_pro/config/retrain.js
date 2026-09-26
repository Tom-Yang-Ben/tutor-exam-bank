// ─────────────────────────────────────────────────────────────
// config/retrain.js — 錯題重練與間隔複習的排程參數（docs/retrain-and-review.md 第 4.3、5.1 節）
//
// 數字依 Owner 2026-09-26「重練與收尾決策單」第三輪的答覆：
//   〔Owner 決策單 2026-09-26 R3 選 2〕對 3 次才算練到會：重做（下一份卷）→ 隔 1 週 → 再隔 2 週
//                                      ⇒ STEP_DAYS = [1, 7, 14]、MASTERY_STREAK = 3
//   〔Owner 決策單 2026-09-26 R4 選 1〕重練或回測又錯 → 回第一關、錯的次數加一；錯滿 3 次標「卡關」
//                                      提醒老師（仍留在清單，不自動移出）⇒ STUCK_LAPSES = 3
//   〔Owner 決策單 2026-09-26 R5 選 1〕固定關卡（Leitner 式），排程是作答歷史的純函式
//                                      （services/retrainSchedule.js）
//   〔Owner 決策單 2026-09-26 R6 選 1〕出新卷時可勾「附上到期的重練題」，預設上限為新題數的三成（出卷時可改）
//                                      ⇒ ATTACH_RATIO = 0.3
//   〔Owner 決策單 2026-09-26 R2 選 1〕只有全對才算對（沒給部分分，或給 100%）
//                                      ⇒ CORRECT_THRESHOLD = 1（固定，不開放環境變數覆寫）
//
// 「第 1 關＝下一份卷」寫成 1 天：到期日＝派題日＋1 天，派題之後的任何一份卷都可以出
// （設計稿第 4.5 節的例子：10/1 錯 → 10/2 到期）。
//
// 環境變數覆寫（與 KC_TAG_MIN_CONFIDENCE、OCR_DPI 同一種讀法：合法才採用，非法退回預設）：
//   RETRAIN_STEP_DAYS       每一關的間隔天數，逗號分隔的整數（0～365），1～9 關（預設 1,7,14）
//   RETRAIN_MASTERY_STREAK  連續答對幾次算練到會，1～9 的整數（預設 3）
//   RETRAIN_STUCK_LAPSES    錯幾次標卡關，1～99 的整數（預設 3）
//   RETRAIN_ATTACH_RATIO    附在新卷時的預設上限比例，0～2 的數字（預設 0.3）
//
//   - 未設或空字串＝預設，**不警告**：eval 的子行程會把 .env 裡有、CI 沒設的變數設成空字串
//     （eval/lib/suiteProcess.js），那等於沒設。
//   - 非法值退回預設並 console.warn **一次**（同一個鍵、同一個值只印一次；設定會被反覆讀取，
//     每讀一次就印一行會把 log 洗掉）。
//   - 第 k 關用第 k 個間隔，連對 K 次時用到第 K 關，所以關數必須 ≥ MASTERY_STREAK：
//     關數較多時只用前 K 個（例：K＝2 就是「重做、隔 1 週」＝R3 的選項 1）；
//     關數較少時兩者一起退回預設並警告一次（只退其中一個，另一個可能仍然對不上）。
//
// 一律即時讀 process.env（函式與 getter），不在 require 當下固定住值——同 config/features.js 規則 3。
// 本檔不讀 DB、不看時鐘；services/retrainSchedule.js 是純函式，參數由呼叫端從這裡取來傳入。
// ─────────────────────────────────────────────────────────────

/** 每一關的間隔天數（第 1 關＝下一份卷、第 2 關 7 天、第 3 關 14 天）。〔R3 選 2〕 */
const DEFAULT_STEP_DAYS = Object.freeze([1, 7, 14]);
/** 連續答對幾次算練到會。〔R3 選 2〕 */
const DEFAULT_MASTERY_STREAK = 3;
/** 錯幾次標「卡關」（只提醒，仍留在清單）。〔R4 選 1〕 */
const DEFAULT_STUCK_LAPSES = 3;
/** 附在新卷時，重練題的預設上限＝新題數 × 這個比例（無條件捨去）。〔R6 選 1〕 */
const DEFAULT_ATTACH_RATIO = 0.3;
/** COALESCE(score, result) ≥ 這個值才算對：只有全對才算對。〔R2 選 1〕固定，不開放覆寫。 */
const CORRECT_THRESHOLD = 1;
/** 一份卷最多幾題：同 controllers/examController.js 的 MAX_QUESTIONS（confirm-paper 上限）。 */
const MAX_PAPER_QUESTIONS = 50;

/** 關數上限：設計稿第 3.4 節 retrain_items.step 的 CHECK (step BETWEEN 1 AND 9)。 */
const MAX_STEPS = 9;
const MAX_STEP_DAYS = 365;
const MAX_STUCK_LAPSES = 99;
const MAX_ATTACH_RATIO = 2;

/** 環境變數名稱（文件與測試共用）。 */
const ENV_KEYS = Object.freeze({
    stepDays: 'RETRAIN_STEP_DAYS',
    masteryStreak: 'RETRAIN_MASTERY_STREAK',
    stuckLapses: 'RETRAIN_STUCK_LAPSES',
    attachRatio: 'RETRAIN_ATTACH_RATIO'
});

/**
 * 預設參數（常數，不讀 env）。services/retrainSchedule.js 在呼叫端沒給參數時用它。
 * @type {Readonly<{stepDays:ReadonlyArray<number>, masteryStreak:number, stuckLapses:number,
 *                  attachRatio:number, correctThreshold:number}>}
 */
const DEFAULTS = Object.freeze({
    stepDays: DEFAULT_STEP_DAYS,
    masteryStreak: DEFAULT_MASTERY_STREAK,
    stuckLapses: DEFAULT_STUCK_LAPSES,
    attachRatio: DEFAULT_ATTACH_RATIO,
    correctThreshold: CORRECT_THRESHOLD
});

const warned = new Set();
function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
}

/** 讀原始字串；未設與空字串一律視為 ''（＝用預設）。 */
function rawOf(env, name) {
    return String(env[name] ?? '').trim();
}

/**
 * 「1,7,14」→ [1, 7, 14]。全形逗號也收（Windows 上用中文輸入法改 .env 很常見）。
 * @param {string} raw 已 trim、非空
 * @returns {number[]|null} 非法回 null
 */
function parseStepDays(raw) {
    const parts = raw.split(/[,，]/).map(s => s.trim());
    if (parts.length < 1 || parts.length > MAX_STEPS) return null;
    const days = [];
    for (const p of parts) {
        if (!/^\d+$/.test(p)) return null;
        const n = Number(p);
        if (n > MAX_STEP_DAYS) return null;
        days.push(n);
    }
    return days;
}

/**
 * 十進位整數字串 → 整數；不在 [min, max] 或不是整數回 null（'3.0'、'3a'、'-1' 都不收）。
 * @returns {number|null}
 */
function parseIntInRange(raw, min, max) {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= min && n <= max ? n : null;
}

/**
 * 比例字串 → 數字；只收 0～MAX_ATTACH_RATIO 的一般十進位寫法（'0.3'、'1'、'1.5'），
 * '.5'、'3e-1'、'30%' 這類寫法一律不收（退回預設並警告，免得打錯字被悄悄解讀成別的數字）。
 * @returns {number|null}
 */
function parseRatio(raw) {
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= MAX_ATTACH_RATIO ? n : null;
}

/**
 * 讀一個設定值：空＝預設（不警告）；合法＝照用；非法＝預設＋警告一次。
 */
function readValue(env, key, parse, fallback, rule) {
    const raw = rawOf(env, key);
    if (raw === '') return fallback;
    const v = parse(raw);
    if (v !== null) return v;
    warnOnce(`${key}=${raw}`, `[retrain] ${key} 只接受${rule}，收到「${raw}」，改用預設 ${Array.isArray(fallback) ? fallback.join(',') : fallback}。`);
    return fallback;
}

/**
 * 讀目前的排程參數（env 可注入，方便測試）。
 * 回傳的物件可以直接交給 services/retrainSchedule.js 的函式當 params。
 *
 * @param {object} [env] 預設 process.env
 * @returns {Readonly<{stepDays:ReadonlyArray<number>, masteryStreak:number, stuckLapses:number,
 *                     attachRatio:number, correctThreshold:number}>}
 */
function loadRetrainConfig(env = process.env) {
    let stepDays = readValue(env, ENV_KEYS.stepDays, parseStepDays, [...DEFAULT_STEP_DAYS],
        `逗號分隔、1～${MAX_STEPS} 個 0～${MAX_STEP_DAYS} 的整數`);
    let masteryStreak = readValue(env, ENV_KEYS.masteryStreak, raw => parseIntInRange(raw, 1, MAX_STEPS),
        DEFAULT_MASTERY_STREAK, `1～${MAX_STEPS} 的整數`);
    const stuckLapses = readValue(env, ENV_KEYS.stuckLapses, raw => parseIntInRange(raw, 1, MAX_STUCK_LAPSES),
        DEFAULT_STUCK_LAPSES, `1～${MAX_STUCK_LAPSES} 的整數`);
    const attachRatio = readValue(env, ENV_KEYS.attachRatio, parseRatio,
        DEFAULT_ATTACH_RATIO, `0～${MAX_ATTACH_RATIO} 的數字`);

    if (stepDays.length < masteryStreak) {
        warnOnce(`mismatch:${stepDays.join(',')}:${masteryStreak}`,
            `[retrain] 連對 ${masteryStreak} 次才練到會，需要至少 ${masteryStreak} 關的間隔，` +
            `但 ${ENV_KEYS.stepDays} 只有 ${stepDays.length} 關（${stepDays.join(',')}）；` +
            `兩者一起改用預設 ${DEFAULT_STEP_DAYS.join(',')}／${DEFAULT_MASTERY_STREAK}。`);
        stepDays = [...DEFAULT_STEP_DAYS];
        masteryStreak = DEFAULT_MASTERY_STREAK;
    } else {
        stepDays = stepDays.slice(0, masteryStreak);
    }

    return Object.freeze({
        stepDays: Object.freeze(stepDays),
        masteryStreak,
        stuckLapses,
        attachRatio,
        correctThreshold: CORRECT_THRESHOLD
    });
}

/** 測試用：清掉「已警告過」的紀錄 */
function _resetForTest() {
    warned.clear();
}

module.exports = {
    DEFAULTS,
    DEFAULT_STEP_DAYS,
    DEFAULT_MASTERY_STREAK,
    DEFAULT_STUCK_LAPSES,
    DEFAULT_ATTACH_RATIO,
    CORRECT_THRESHOLD,
    MAX_PAPER_QUESTIONS,
    MAX_STEPS,
    ENV_KEYS,
    loadRetrainConfig,
    parseStepDays,
    parseIntInRange,
    parseRatio,
    _resetForTest,
    // 即時讀 process.env 的 getter（名稱同設計稿第 5.1 節）
    get STEP_DAYS() { return loadRetrainConfig().stepDays; },
    get MASTERY_STREAK() { return loadRetrainConfig().masteryStreak; },
    get STUCK_LAPSES() { return loadRetrainConfig().stuckLapses; },
    get ATTACH_RATIO() { return loadRetrainConfig().attachRatio; }
};
