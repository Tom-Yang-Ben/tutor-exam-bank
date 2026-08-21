// ─────────────────────────────────────────────────────────────
// eval/lib/pdfGolden.js — 「答案卷」的載入與硬閘門（E-X12a）
//
// 規劃 §5.3.5：「老師先為每份私有 PDF 建答案卷 pdf_golden/<sha256>.json
//               （題數、每題章節、標準答案）」。
//
// **檔名就是 PDF 的 sha256**，不是人取的名字。理由：compare_pipeline 拿到一份 PDF 時，
// 唯一能百分之百確定「這份答案卷是不是這份 PDF 的」的方法就是算雜湊。
// 用檔名對應（sample_exam.pdf ↔ sample_exam.json）遲早會發生「換了 PDF 沒換答案卷」，
// 而症狀是 extract_recall 突然掉到 0，看起來像模型壞掉。
//
// 兩層：
//   公開層 eval/golden/pdf_sample/<sha256>.json   自製樣卷，進版控
//   私有層 eval/private/pdf_golden/<sha256>.json  真實考卷的人工標註，永不進版控
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { isValidChapter, isValidSubject, isValidQuestionType } = require('../../config/chapters');
const { isPrivatePath } = require('./golden');

const EVAL_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(EVAL_DIR, 'golden', 'pdf_sample');
const PRIVATE_DIR = path.join(EVAL_DIR, 'private', 'pdf_golden');
const ANSWER_FORMS = ['option', 'number', 'expression', 'text'];

/**
 * @param {string} file
 * @returns {string} 小寫 hex
 */
function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex');
}

/**
 * @param {object} doc
 * @param {string} expectSha 由 PDF 實際算出來的 sha256
 * @returns {string[]} 問題描述；空 = 通過
 */
function validateSheet(doc, expectSha) {
    const problems = [];
    if (!doc || typeof doc !== 'object') return ['答案卷必須是 JSON 物件'];

    if (doc.sha256 !== expectSha) {
        problems.push(`答案卷的 sha256 欄（${doc.sha256}）與 PDF 實際的雜湊（${expectSha}）不符——` +
            '多半是換了 PDF 卻沿用舊答案卷，或反過來。');
    }
    const qs = doc.questions;
    if (!Array.isArray(qs) || qs.length === 0) return [...problems, 'questions 必須是非空陣列'];
    if (Number.isInteger(doc.question_count) && doc.question_count !== qs.length) {
        problems.push(`question_count=${doc.question_count} 與 questions.length=${qs.length} 不一致`);
    }

    const seenNo = new Set();
    for (const q of qs) {
        const at = `no=${q && q.no}`;
        if (!Number.isInteger(q.no) || q.no < 1) problems.push(`${at}：no 必須是 ≥ 1 的整數`);
        else if (seenNo.has(q.no)) problems.push(`${at}：no 重複`);
        else seenNo.add(q.no);

        if (!isValidSubject(q.subject)) problems.push(`${at}：subject「${q.subject}」不在白名單`);
        else if (!isValidChapter(q.subject, q.chapter)) problems.push(`${at}：chapter「${q.chapter}」不在「${q.subject}」的白名單`);
        if (!isValidQuestionType(q.question_type)) problems.push(`${at}：question_type「${q.question_type}」不在白名單`);

        if (typeof q.question_text !== 'string' || q.question_text.trim() === '') problems.push(`${at}：question_text 不可為空`);
        if (typeof q.answer_text !== 'string' || q.answer_text.trim() === '') problems.push(`${at}：answer_text 不可為空`);

        if (!ANSWER_FORMS.includes(q.answer_form)) {
            problems.push(`${at}：answer_form 必須是 ${ANSWER_FORMS.join('｜')}（收到「${q.answer_form}」）`);
        }
        if (typeof q.final_answer !== 'string' || q.final_answer.trim() === '') {
            problems.push(`${at}：final_answer 不可為空（answer_agree_rate 要靠它跟驗證模型比）`);
        }
    }
    return problems;
}

/**
 * 載入一份 PDF 對應的答案卷。
 * @param {object} opts
 * @param {string} opts.pdfPath
 * @param {string} [opts.dir] 答案卷目錄；未給時先找公開層再找私有層
 * @returns {{file:string, isPrivate:boolean, sha256:string, doc:object, pendingConfirm:boolean}}
 * @throws 找不到或沒過閘門
 */
function loadSheet(opts) {
    const pdfPath = path.resolve(opts.pdfPath);
    const sha = sha256File(pdfPath);
    const dirs = opts.dir ? [path.resolve(opts.dir)] : [PUBLIC_DIR, PRIVATE_DIR];

    for (const dir of dirs) {
        const file = path.join(dir, `${sha}.json`);
        if (!fs.existsSync(file)) continue;
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        const problems = validateSheet(doc, sha);
        if (problems.length > 0) {
            throw new Error(`答案卷未通過硬閘門（${file}）：\n  - ${problems.join('\n  - ')}`);
        }
        return {
            file,
            isPrivate: isPrivatePath(file),
            sha256: sha,
            doc,
            pendingConfirm: !!doc.needs_human_confirm
        };
    }

    throw new Error(
        `找不到 ${path.basename(pdfPath)} 的答案卷（sha256=${sha}）。\n` +
        `  找過：\n    - ${dirs.map(d => path.join(d, `${sha}.json`)).join('\n    - ')}\n` +
        '  答案卷的檔名必須是 PDF 的 sha256（規劃 §5.3.5）。私有 PDF 的答案卷請放 eval/private/pdf_golden/。'
    );
}

/**
 * 列出一個目錄底下所有 PDF（不遞迴）。單一檔案路徑也接受。
 * @param {string} target
 * @returns {string[]} 絕對路徑，已排序（讓兩次執行的列順序一致）
 */
function listPdfs(target) {
    // 路徑含中文（期中專案-wsD）：一律 path.resolve 後再交給 fs（硬規則 6）。
    const abs = path.resolve(target);
    const stat = fs.statSync(abs);
    if (stat.isFile()) return [abs];
    return fs.readdirSync(abs)
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .sort()
        .map(f => path.join(abs, f));
}

module.exports = { loadSheet, validateSheet, sha256File, listPdfs, PUBLIC_DIR, PRIVATE_DIR, ANSWER_FORMS };
