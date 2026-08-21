// ─────────────────────────────────────────────────────────────
// eval/lib/golden.js — 檢索 golden 的載入與硬閘門
//
// schema（規劃 §5.3.2、分工文件 E-X2）：
//   { id, query: { kind: 'question_id', value }, relevant: [qid…], hard_negatives: [qid…] }
//
// 閘門做三件事：
//   1. 形狀對不對；
//   2. 每一個 id 都要在 fixture 裡存在——golden 指到一個不存在的題，
//      Recall 會安靜地變低，看起來像檢索變差，其實是標註爛掉；
//   3. relevant 與 hard_negatives 不得相交，query 自己也不得出現在兩者裡。
//
// 私有層防呆（規劃 §5.3.2）：--golden 落在 eval/private/ 時，呼叫端必須把 cassette 目錄
//   一起切到 eval/private/cassettes。判斷用的 isPrivatePath() 放在這裡，讓 run.js 只問一次。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.resolve(__dirname, '..', 'golden', 'retrieval.json');
const PRIVATE_DIR = path.resolve(__dirname, '..', 'private');

/**
 * 這條 golden 路徑是否屬於私有層（含逐字真實試題，絕不可外流）。
 * @param {string} file
 * @returns {boolean}
 */
function isPrivatePath(file) {
    const rel = path.relative(PRIVATE_DIR, path.resolve(file));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {Array<object>} entries
 * @param {Map<number,object>} fixtureById
 * @returns {string[]} 問題描述；空 = 通過
 */
function validateEntries(entries, fixtureById) {
    const problems = [];
    if (!Array.isArray(entries) || entries.length === 0) return ['golden 的 entries 必須是非空陣列'];

    const seenId = new Set();
    for (const e of entries) {
        const at = `entry=${e && e.id}`;
        if (!e.id || typeof e.id !== 'string') problems.push(`${at}：id 必須是非空字串`);
        else if (seenId.has(e.id)) problems.push(`${at}：id 重複`);
        else seenId.add(e.id);

        if (!e.query || e.query.kind !== 'question_id') {
            problems.push(`${at}：階段 1 只評 ID→ID，query.kind 必須是 'question_id'（自然語言查詢留階段 3）`);
            continue;
        }
        if (!Number.isInteger(e.query.value)) { problems.push(`${at}：query.value 必須是整數 id`); continue; }
        if (!fixtureById.has(e.query.value)) { problems.push(`${at}：query.value=${e.query.value} 不在 fixture 裡`); continue; }

        const rel = Array.isArray(e.relevant) ? e.relevant : null;
        const neg = Array.isArray(e.hard_negatives) ? e.hard_negatives : [];
        if (!rel) { problems.push(`${at}：relevant 必須是陣列（可以是空陣列，但不能沒有這個鍵）`); continue; }

        for (const id of [...rel, ...neg]) {
            if (!fixtureById.has(id)) problems.push(`${at}：參照到 fixture 沒有的 id=${id}`);
        }
        if (rel.includes(e.query.value)) problems.push(`${at}：query 題本身不得列為 relevant（--exclude-self 會把它排除，永遠拿不到分）`);
        if (neg.includes(e.query.value)) problems.push(`${at}：query 題本身不得列為 hard_negatives`);
        const overlap = rel.filter(id => neg.includes(id));
        if (overlap.length) problems.push(`${at}：id ${overlap.join(', ')} 同時被列為 relevant 與 hard_negatives`);
    }
    return problems;
}

/**
 * 載入 golden。
 * @param {object} opts
 * @param {string} [opts.file] 預設 eval/golden/retrieval.json
 * @param {Map<number,object>} opts.fixtureById
 * @returns {{file:string, isPrivate:boolean, entries:Array<object>, pendingConfirm:number}}
 */
function loadGolden(opts) {
    const file = path.resolve(opts.file || DEFAULT_PATH);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = raw.entries;
    const problems = validateEntries(entries, opts.fixtureById);
    if (problems.length > 0) {
        throw new Error(`golden 未通過硬閘門（${file}）：\n  - ${problems.join('\n  - ')}`);
    }
    return {
        file,
        isPrivate: isPrivatePath(file),
        entries,
        pendingConfirm: entries.filter(e => e.needs_human_confirm).length
    };
}

module.exports = { loadGolden, validateEntries, isPrivatePath, DEFAULT_PATH, PRIVATE_DIR };
