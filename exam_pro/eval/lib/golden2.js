// ─────────────────────────────────────────────────────────────
// eval/lib/golden2.js — 階段 2 三份 golden 的載入與硬閘門
//
//   classify.json   章節分類（60 題 fixture + 30 筆漂移變體）
//   answer.json     答案比對（50 題 × 3 等價 + 2 錯答）
//   dedup.json      重複判定（30 組）
//
// 為什麼閘門放在「載入時」而不是寫檔時：golden 是純檔案，沒有 DB 的 CHECK 幫忙擋。
// 一個手滑改錯的章節名只會讓那一題永遠算錯，卻不會有任何錯誤訊息——
// 症狀是 accuracy 少了 1/90，看起來像模型退步，其實是標註爛掉。
// 這與 eval/lib/fixtures.js、eval/lib/golden.js（階段 1）的做法一致。
//
// 三份都回同一個形狀 { file, isPrivate, entries, pendingConfirm }，
// 讓 run.js 對「公開／私有」與「待人工確認」只需要處理一種介面。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { isValidChapter, isValidSubject, isValidQuestionType } = require('../../config/chapters');
const { isPrivatePath } = require('./golden');

const GOLDEN_DIR = path.resolve(__dirname, '..', 'golden');

const ANSWER_FORMS = ['option', 'number', 'expression', 'text'];
const DEDUP_KINDS = ['verbatim', 'resend', 'numeric_change', 'different'];
const DEDUP_L1 = ['duplicate', 'variant', 'unique', 'skipped'];
const DRIFT_KINDS = ['stem_rewrite', 'chapter_synonym'];

/**
 * 共用的讀檔 + 驗證外殼。
 * @param {string} file
 * @param {(entries:Array<object>) => string[]} validate 回傳「所有」問題（不是遇到第一個就停）
 * @param {string} label 錯誤訊息裡的名稱
 * @returns {{file:string, isPrivate:boolean, version:number, entries:Array<object>, pendingConfirm:number}}
 */
function loadWithGate(file, validate, label) {
    const target = path.resolve(file);
    if (!fs.existsSync(target)) {
        throw new Error(`找不到 ${label} golden：${target}`);
    }
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const entries = raw.entries;
    const problems = validate(entries);
    if (problems.length > 0) {
        throw new Error(`${label} golden 未通過硬閘門（${target}）：\n  - ${problems.join('\n  - ')}`);
    }
    return {
        file: target,
        isPrivate: isPrivatePath(target),
        version: raw.version,
        entries,
        pendingConfirm: entries.filter(e => e.needs_human_confirm).length
    };
}

/** id 唯一性檢查，三份共用 */
function checkIds(entries, problems) {
    const seen = new Set();
    for (const e of entries) {
        const id = e && e.id;
        if (typeof id !== 'string' || id === '') { problems.push(`id 必須是非空字串（收到 ${JSON.stringify(id)}）`); continue; }
        if (seen.has(id)) problems.push(`id「${id}」重複`);
        seen.add(id);
    }
}

// ───────────────────────── classify ─────────────────────────

/**
 * @param {Array<object>} entries
 * @returns {string[]}
 */
function validateClassify(entries) {
    const problems = [];
    if (!Array.isArray(entries) || entries.length === 0) return ['classify golden 的 entries 必須是非空陣列'];
    checkIds(entries, problems);

    for (const e of entries) {
        const at = `entry=${e && e.id}`;
        if (typeof e.question_text !== 'string' || e.question_text.trim() === '') {
            problems.push(`${at}：question_text 不可為空`);
        }
        // golden 本身也要過硬閘門（規劃 §5.3.2）——標的答案不在白名單內，
        // classify 就永遠不可能答對，而報表上看起來只是「模型很爛」。
        if (!isValidSubject(e.subject)) problems.push(`${at}：subject「${e.subject}」不在白名單`);
        else if (!isValidChapter(e.subject, e.chapter)) problems.push(`${at}：chapter「${e.chapter}」不在「${e.subject}」的白名單`);

        if (e.source !== 'fixture' && e.source !== 'drift') {
            problems.push(`${at}：source 只能是 'fixture' 或 'drift'（收到「${e.source}」）`);
            continue;
        }
        if (e.source === 'fixture') {
            if (e.drift_kind !== null) problems.push(`${at}：source='fixture' 時 drift_kind 必須是 null`);
        } else {
            if (!DRIFT_KINDS.includes(e.drift_kind)) {
                problems.push(`${at}：drift_kind 必須是 ${DRIFT_KINDS.join('｜')}（收到「${e.drift_kind}」）`);
            }
            if (!Number.isInteger(e.from)) problems.push(`${at}：source='drift' 時 from 必須是來源 fixture 題的整數 id`);
        }
        // decoy_chapter 刻意「不」檢查白名單：它記的就是「會被擋下來的那個值」，
        // 多半本來就不在白名單內。檢查它反而會把有價值的案例擋掉。
        if (e.decoy_chapter !== null && typeof e.decoy_chapter !== 'string') {
            problems.push(`${at}：decoy_chapter 必須是字串或 null`);
        }
        if (e.decoy_chapter === e.chapter) {
            problems.push(`${at}：decoy_chapter 不得等於正解 chapter（那樣「漂移」就沒有意義了）`);
        }
        if (typeof e.needs_human_confirm !== 'boolean') problems.push(`${at}：needs_human_confirm 必須是布林`);
    }
    return problems;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.file] 預設 eval/golden/classify.json
 * @param {Map<number,object>} [opts.fixtureById] 給了就檢查 from 指到存在的 fixture 題
 */
function loadClassifyGolden(opts = {}) {
    const res = loadWithGate(
        opts.file || path.join(GOLDEN_DIR, 'classify.json'),
        entries => {
            const problems = validateClassify(entries);
            if (opts.fixtureById) {
                for (const e of entries) {
                    if (e.from !== null && e.from !== undefined && !opts.fixtureById.has(e.from)) {
                        problems.push(`entry=${e.id}：from=${e.from} 不在 fixture 裡`);
                    }
                }
            }
            return problems;
        },
        'classify'
    );
    return res;
}

// ───────────────────────── answer ─────────────────────────

function validateAnswer(entries) {
    const problems = [];
    if (!Array.isArray(entries) || entries.length === 0) return ['answer golden 的 entries 必須是非空陣列'];
    checkIds(entries, problems);

    for (const e of entries) {
        const at = `entry=${e && e.id}`;
        if (!isValidQuestionType(e.question_type)) problems.push(`${at}：question_type「${e.question_type}」不在白名單`);
        if (!ANSWER_FORMS.includes(e.answer_form)) {
            problems.push(`${at}：answer_form 必須是 ${ANSWER_FORMS.join('｜')}（收到「${e.answer_form}」）`);
        }
        if (typeof e.claimed !== 'string' || e.claimed.trim() === '') problems.push(`${at}：claimed 不可為空`);

        // 「3 種等價寫法 + 2 種典型錯答」是分工文件寫死的規格，不是建議值。
        // 少寫一種，這一題就少測一條規則，而報表不會有任何提示。
        if (!Array.isArray(e.equivalents) || e.equivalents.length !== 3) {
            problems.push(`${at}：equivalents 必須剛好 3 項（收到 ${Array.isArray(e.equivalents) ? e.equivalents.length : 'non-array'}）`);
        }
        if (!Array.isArray(e.wrong) || e.wrong.length !== 2) {
            problems.push(`${at}：wrong 必須剛好 2 項（收到 ${Array.isArray(e.wrong) ? e.wrong.length : 'non-array'}）`);
        }
        for (const s of [...(e.equivalents || []), ...(e.wrong || [])]) {
            if (typeof s !== 'string' || s.trim() === '') problems.push(`${at}：equivalents／wrong 的每一項都必須是非空字串`);
        }
        const ex = e.expect || {};
        if (!['agree', 'uncertain'].includes(ex.equivalent)) {
            problems.push(`${at}：expect.equivalent 只能是 'agree' 或 'uncertain'（等價寫法不該被判 disagree）`);
        }
        if (!['disagree', 'uncertain'].includes(ex.wrong)) {
            problems.push(`${at}：expect.wrong 只能是 'disagree' 或 'uncertain'（錯答不該被判 agree）`);
        }
        if (e.question_type === '證明' && (ex.equivalent !== 'uncertain' || ex.wrong !== 'uncertain')) {
            // 第 4.2 條：「證明」一律 uncertain。golden 若寫別的，等於在要求一個違反凍結介面的行為。
            problems.push(`${at}：question_type='證明' 時 expect 兩欄都必須是 'uncertain'（interfaces-stage2.md 第 4.2 條）`);
        }
        if (typeof e.extraction_hazard !== 'boolean') problems.push(`${at}：extraction_hazard 必須是布林`);
        if (typeof e.needs_human_confirm !== 'boolean') problems.push(`${at}：needs_human_confirm 必須是布林`);
    }
    return problems;
}

/**
 * 把一筆 golden 展開成 5 個 answerCompare 呼叫案例。
 * @param {object} entry
 * @returns {Array<{id:string, question_type:string, claimed:string,
 *                  model:{final_answer:string, answer_form:string}, expect:string, role:'equivalent'|'wrong'}>}
 */
function expandAnswerCases(entry) {
    const cases = [];
    entry.equivalents.forEach((final, i) => cases.push({
        id: `${entry.id}#eq${i + 1}`,
        question_type: entry.question_type,
        claimed: entry.claimed,
        model: { final_answer: final, answer_form: entry.answer_form },
        expect: entry.expect.equivalent,
        role: 'equivalent'
    }));
    entry.wrong.forEach((final, i) => cases.push({
        id: `${entry.id}#wrong${i + 1}`,
        question_type: entry.question_type,
        claimed: entry.claimed,
        model: { final_answer: final, answer_form: entry.answer_form },
        expect: entry.expect.wrong,
        role: 'wrong'
    }));
    return cases;
}

function loadAnswerGolden(opts = {}) {
    return loadWithGate(opts.file || path.join(GOLDEN_DIR, 'answer.json'), validateAnswer, 'answer');
}

// ───────────────────────── dedup ─────────────────────────

function validateDedup(entries) {
    const problems = [];
    if (!Array.isArray(entries) || entries.length === 0) return ['dedup golden 的 entries 必須是非空陣列'];
    checkIds(entries, problems);

    for (const e of entries) {
        const at = `entry=${e && e.id}`;
        if (!DEDUP_KINDS.includes(e.kind)) {
            problems.push(`${at}：kind 必須是 ${DEDUP_KINDS.join('｜')}（收到「${e.kind}」）`);
        }
        for (const side of ['a', 'b']) {
            const s = e[side];
            if (!s || typeof s.text !== 'string' || s.text.trim() === '') {
                problems.push(`${at}：${side}.text 不可為空`);
            }
            if (s && s.from !== null && s.from !== undefined && !Number.isInteger(s.from)) {
                problems.push(`${at}：${side}.from 必須是整數或 null`);
            }
        }
        if (!['hit', 'miss'].includes(e.expect_l0)) problems.push(`${at}：expect_l0 只能是 'hit' 或 'miss'`);
        if (!DEDUP_L1.includes(e.expect_l1)) problems.push(`${at}：expect_l1 必須是 ${DEDUP_L1.join('｜')}`);

        // kind 與期望值必須自洽：這是「改了一邊忘了改另一邊」唯一擋得住的地方。
        const wantL0 = (e.kind === 'verbatim' || e.kind === 'resend') ? 'hit' : 'miss';
        if (e.expect_l0 !== wantL0) {
            problems.push(`${at}：kind='${e.kind}' 的 expect_l0 應該是 '${wantL0}'（收到 '${e.expect_l0}'）`);
        }
        if (e.expect_l0 === 'hit' && e.expect_l1 !== 'duplicate') {
            problems.push(`${at}：L0 命中的組，L1 也必然是 duplicate`);
        }
        if (typeof e.needs_human_confirm !== 'boolean') problems.push(`${at}：needs_human_confirm 必須是布林`);
    }
    return problems;
}

function loadDedupGolden(opts = {}) {
    return loadWithGate(
        opts.file || path.join(GOLDEN_DIR, 'dedup.json'),
        entries => {
            const problems = validateDedup(entries);
            if (opts.fixtureById) {
                for (const e of entries) {
                    for (const side of ['a', 'b']) {
                        const from = e[side] && e[side].from;
                        if (from !== null && from !== undefined && !opts.fixtureById.has(from)) {
                            problems.push(`entry=${e.id}：${side}.from=${from} 不在 fixture 裡`);
                        }
                    }
                }
            }
            return problems;
        },
        'dedup'
    );
}

module.exports = {
    loadClassifyGolden, validateClassify,
    loadAnswerGolden, validateAnswer, expandAnswerCases,
    loadDedupGolden, validateDedup,
    GOLDEN_DIR, ANSWER_FORMS, DEDUP_KINDS, DRIFT_KINDS
};
