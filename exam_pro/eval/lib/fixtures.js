// ─────────────────────────────────────────────────────────────
// eval/lib/fixtures.js — 公開 fixture 題庫的載入與硬閘門
//
// 規劃 §5.3.2：「載入時逐題過 isValidChapter（config/chapters.js），golden 本身也要過硬閘門」。
// 閘門放在**載入時**而不是寫入時，是因為 fixture 是純檔案：沒有 DB 的 CHECK 幫忙擋，
// 一個手滑改錯的章節名只會讓那題永遠檢索不到，卻不會有任何錯誤訊息。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { isValidChapter, isValidSubject, isValidQuestionType, normalizeDifficulty } = require('../../config/chapters');

const DEFAULT_PATH = path.resolve(__dirname, '..', 'fixtures', 'questions.public.json');

/**
 * 逐題驗證，回傳「所有」問題（不是遇到第一個就停）——一次修完比修五輪省事。
 * @param {Array<object>} questions
 * @returns {string[]} 問題描述；空陣列 = 全數通過
 */
function validateQuestions(questions) {
    const problems = [];
    const seen = new Set();
    if (!Array.isArray(questions) || questions.length === 0) {
        return ['fixture 的 questions 必須是非空陣列'];
    }
    for (const q of questions) {
        const at = `id=${q && q.id}`;
        if (!Number.isInteger(q.id)) problems.push(`${at}：id 必須是整數`);
        else if (seen.has(q.id)) problems.push(`${at}：id 重複`);
        else seen.add(q.id);

        if (!isValidSubject(q.subject)) problems.push(`${at}：subject「${q.subject}」不在白名單`);
        else if (!isValidChapter(q.subject, q.chapter)) problems.push(`${at}：chapter「${q.chapter}」不在「${q.subject}」的白名單`);

        if (!isValidQuestionType(q.question_type)) problems.push(`${at}：question_type「${q.question_type}」不在白名單`);
        if (normalizeDifficulty(q.difficulty) === null) problems.push(`${at}：difficulty 必須是 1~5 的整數`);
        if (typeof q.question_text !== 'string' || q.question_text.trim() === '') problems.push(`${at}：question_text 不可為空`);
        if (typeof q.answer_text !== 'string' || q.answer_text.trim() === '') problems.push(`${at}：answer_text 不可為空`);
    }
    return problems;
}

/**
 * 載入公開 fixture。
 * @param {string} [file] 預設 eval/fixtures/questions.public.json
 * @returns {{file:string, version:number, needsHumanConfirm:boolean, questions:Array<object>, byId:Map<number,object>}}
 * @throws 任一題沒過閘門就丟錯（列出全部問題）
 */
function loadFixture(file) {
    const target = path.resolve(file || DEFAULT_PATH);
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const questions = raw.questions;
    const problems = validateQuestions(questions);
    if (problems.length > 0) {
        throw new Error(`fixture 未通過章節／題型硬閘門（${target}）：\n  - ${problems.join('\n  - ')}`);
    }
    return {
        file: target,
        version: raw.version,
        needsHumanConfirm: String(raw._status || '').includes('needs_human_confirm'),
        questions,
        byId: new Map(questions.map(q => [q.id, q]))
    };
}

/**
 * 依 variant_group 分組，回 group → id 陣列（升冪）。
 * 「換數字的同一題」家族是檢索 golden 正樣本的來源。
 * @param {Array<object>} questions
 * @returns {Map<string, number[]>}
 */
function groupByVariant(questions) {
    const groups = new Map();
    for (const q of questions) {
        if (!q.variant_group) continue;
        if (!groups.has(q.variant_group)) groups.set(q.variant_group, []);
        groups.get(q.variant_group).push(q.id);
    }
    for (const ids of groups.values()) ids.sort((a, b) => a - b);
    return groups;
}

module.exports = { loadFixture, validateQuestions, groupByVariant, DEFAULT_PATH };
