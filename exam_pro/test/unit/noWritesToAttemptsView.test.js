// ─────────────────────────────────────────────────────────────
// test/unit/noWritesToAttemptsView.test.js — 禁止程式對相容檢視 attempts 寫入（〔retrain PR-1〕TC-036-6）
//
// migrations/0016 之後 attempts 是唯讀的相容檢視（只含「新題」派題，每生每題最多一列），
// 作答歷史的實體表是 assignments（派題）與 attempt_records（作答）。對檢視寫入在執行時會立刻報錯，
// 但那要真的走到那一行才知道——這支在 npm test 就擋下來：掃描產品程式碼（controllers、services、
// workers、scripts、queries、routes、middleware、utils、agents、pipeline、config、eval 與根目錄的 .js），
// 不得出現對 attempts（或 assignment_attempts）的 INSERT／UPDATE／DELETE／TRUNCATE。
//
// 不掃：test/（夾具走 test/helpers/attempts.js，整合測試另外驗檢視是唯讀的）、
//       migrate/（2026-08-21 MySQL 切換用的一次性工具，檔頭已註明只適用於 0016 之前的 schema）、
//       public/（前端不寫 SQL）、node_modules/。
// 註解先挖掉再比對：說明文字裡提到「TRUNCATE attempts 會報錯」不算。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['controllers', 'services', 'workers', 'scripts', 'queries', 'routes', 'middleware',
    'utils', 'agents', 'pipeline', 'config', 'eval'];
const SKIP_DIRS = new Set(['node_modules', 'fixtures', 'cassettes', 'reports']);

/** 兩個唯讀檢視（名字前面不能接底線或英數字，attempt_records 等實體表不會誤中）。 */
const VIEW = String.raw`(?:"?public"?\.)?"?(?:assignment_)?attempts"?(?![\w])`;
const WRITE_PATTERNS = [
    new RegExp(String.raw`\bINSERT\s+INTO\s+${VIEW}`, 'i'),
    new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${VIEW}`, 'i'),
    new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${VIEW}`, 'i'),
    // TRUNCATE a, b, attempts, c …：只看同一句（遇到分號或引號就停）
    new RegExp(String.raw`\bTRUNCATE\b[^;'"\`]*?(?<![\w.])${VIEW}`, 'i'),
    // MERGE INTO attempts（PG 15+）也一樣不行
    new RegExp(String.raw`\bMERGE\s+INTO\s+${VIEW}`, 'i')
];

/** 挖掉 JS 的區塊註解與行註解（粗略版：字串裡的 // 會讓那一行後段被略過，對找 SQL 寫入無妨）。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** @returns {Array<{file:string, line:number, text:string}>} */
function findWrites(src, file) {
    const hits = [];
    const code = stripComments(src);
    for (const re of WRITE_PATTERNS) {
        const g = new RegExp(re.source, 'gi');
        let m;
        while ((m = g.exec(code)) !== null) {
            const line = code.slice(0, m.index).split('\n').length;
            hits.push({ file, line, text: m[0].replace(/\s+/g, ' ').slice(0, 80) });
        }
    }
    return hits;
}

function listJs(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) out.push(...listJs(path.join(dir, ent.name)));
        } else if (/\.(c|m)?js$/.test(ent.name)) {
            out.push(path.join(dir, ent.name));
        }
    }
    return out;
}

describe('產品程式碼不得寫入相容檢視 attempts（migrations/0016）', () => {
    test('掃描器本身抓得到寫入、也不會誤判讀取與實體表', () => {
        const bad = [
            'INSERT INTO attempts (student_id, question_id) VALUES ($1, $2)',
            'insert into public.attempts (student_id) values (1)',
            'UPDATE attempts a SET result = 1',
            'DELETE FROM attempts WHERE paper_id = $1',
            'TRUNCATE attempts, exam_papers RESTART IDENTITY CASCADE',
            'TRUNCATE job_events, jobs,\n   attempts, questions CASCADE',
            'DELETE FROM assignment_attempts WHERE 1 = 1',
            'MERGE INTO attempts a USING x ON true WHEN MATCHED THEN DO NOTHING'
        ];
        for (const sql of bad) assert.equal(findWrites(`q(\`${sql}\`)`, 'x').length, 1, sql);
        const ok = [
            'SELECT 1 FROM attempts a WHERE a.question_id = q.id',
            'INSERT INTO attempt_records (assignment_id) SELECT id FROM ins',
            'UPDATE attempt_records a SET result = r.result FROM assignments s',
            'DELETE FROM assignments WHERE paper_id = $1',
            'TRUNCATE attempt_records, assignments, exam_papers RESTART IDENTITY CASCADE',
            'LEFT JOIN assignment_attempts a ON a.paper_id = $1',
            '// 舊寫法 INSERT INTO attempts … 已改掉',
            '/* TRUNCATE attempts 會報錯 */ SELECT 1'
        ];
        for (const sql of ok) assert.deepEqual(findWrites(sql, 'x'), [], sql);
    });

    test('controllers／services／workers／scripts／queries／eval 等產品程式碼沒有任何寫入', () => {
        const files = [
            ...SCAN_DIRS.flatMap(d => listJs(path.join(ROOT, d))),
            ...fs.readdirSync(ROOT).filter(f => /\.js$/.test(f)).map(f => path.join(ROOT, f))
        ];
        assert.ok(files.length > 100, `掃到的檔案太少（${files.length}），目錄清單可能錯了`);
        assert.ok(files.some(f => f.endsWith(path.join('controllers', 'examController.js'))));
        const hits = files.flatMap(f => findWrites(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f)));
        assert.deepEqual(hits, [],
            '以下程式對唯讀檢視 attempts 寫入（改寫 assignments／attempt_records）：\n' +
            hits.map(h => `  ${h.file}:${h.line}  ${h.text}`).join('\n'));
    });
});
