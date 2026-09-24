// scripts/migrate_chapters.js — 數學／物理章節重整：舊題搬章（docs/chapter-restructure.md 第 3.1 條第 7 點、ADR-016）
//
// 用法：
//   npm run chapters:migrate                            ＝ --dry-run：產生提議檔 data/chapter-migration-<日期>.csv、印出統計
//   npm run chapters:migrate -- --out <檔名>.csv        提議檔改存到指定路徑
//   npm run chapters:migrate -- --apply <檔名>.csv      套用老師確認（改過）的提議檔
//   加 --test 改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//
// 為什麼要有這一支：2026-09-25 數學／物理的章節白名單依 108 龍騰目錄重整（config/chapterPlan.js），
// 題庫裡的舊題還掛著舊章名（例：三次函數、三角函數的定義），不在新白名單裡——編輯時存不回去、弱點統計與
// 覆蓋率也對不上新章。舊→新有三種：一對一改名（rename）、一拆多（split）、章被刪除（removed）。
// 改名可以自動，拆分與刪除要看題目內容，所以流程是「規則提議 → 老師確認 → 套用」：
//
//   --dry-run（預設）**只讀不寫**。依 MIGRATION 替每一題提議新章，寫成 CSV（Excel 開得起來，UTF-8 含 BOM）：
//       id、subject、舊章、提議新章、依據、題幹前 60 字
//     依據：rename（改名，直接提議新章）、keyword:<命中詞>（拆分，config/chapterMigrationRules.js 的規則命中）、
//          default（拆分但沒有規則命中，提議 to[0]）、removed（章被刪除，提議 to[0]，沒有 to 就留空，一律要老師確認）。
//     已封存的題也列出來（作答紀錄還在，弱點統計會用到），題幹欄前面加「（已封存）」。
//   --apply <csv>：老師在 Excel 改好「提議新章」欄後存檔再跑。**單一交易**：
//       - 先逐列驗證（id、科目、新章在該科白名單內、沒有重複列、沒有留空），有任何錯誤整批不寫；
//       - 真的換章的題：chapter 改成新章、chapter_src='human'（老師確認過）、embed_hash 清成 NULL
//         （embed_text 第一行含章名，同 PUT /api/questions/:id）、search_tsv 依新章重算（同 PUT，同一筆交易）、
//         刪除這題 src='ai' 的知識點標註（AI 是從舊章的知識點裡挑的；human 的保留，同裁決 S5-42）；
//       - 老師確認留在原章的題不改題目，只記進 chapter_migration_log；
//       - 每一列處理完都記進 chapter_migration_log（migrations/0014），之後的 --dry-run 不再列出它；
//       - 產生提議檔之後題目又被改過章（題庫現在的章既不是「舊章」也不是「提議新章」）→ 略過並警告，以題庫現值為準；
//       - 重跑同一份 CSV：已記錄、而且題庫已是新章的列直接略過，不再改任何東西（冪等）。老師先在題庫頁
//         改成提議的章再跑，也算已套用（只補記錄）。
//     結束時印出之後必跑的指令：npm run embed:backfill（embed_text 含章名）與 npm run search:reindex。
//
// **不呼叫 LLM、不需金鑰、不打網路。**
// CSV 的解碼：UTF-8（含或不含 BOM）；Excel 若另存成一般「CSV（逗號分隔）」會是 Big5，也自動辨識。

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { PLAN_CHAPTERS, MIGRATION } = require('../config/chapterPlan');
const { CHAPTERS, isValidChapter } = require('../config/chapters');
const { matchKeywordRule, validateRules } = require('../config/chapterMigrationRules');
// search_tsv 的組法與 controllers/questionController.js（PUT）、npm run search:reindex 相同（同一段 SQL）
const { TSV_EXPR } = require('./reindex_search_tsv');

// ───────────────────────── 常數 ─────────────────────────

/** 這一次重整的代號（chapter_migration_log.plan）。之後若再重整，換一個新代號。 */
const PLAN_ID = 'chapters-2026-09';

/** 本工具處理的科目（化學章名不動，docs/chapter-restructure.md 第 1 條） */
const MIGRATED_SUBJECTS = Object.freeze(['數學', '物理']);

/** 提議檔的欄位（docs/chapter-restructure.md 第 3.1 條第 7 點，順序凍結） */
const CSV_HEADER = Object.freeze(['id', 'subject', '舊章', '提議新章', '依據', '題幹前60字']);

const STEM_PREVIEW = 60;
const ARCHIVED_MARK = '（已封存）';
const ERROR_LIST_MAX = 20;
const INT4_MAX = 2147483647;
const DEFAULT_OUT_DIR = path.resolve(__dirname, '..', 'data');

/** 之後必跑的指令（--apply 結束時印出；docs/chapter-restructure.md 第 6 條） */
const NEXT_COMMANDS = Object.freeze([
    { cmd: 'npm run embed:backfill', why: 'embed_text 第一行含章名，搬過章的題要重算向量（會呼叫 embedding API，費用很小）' },
    { cmd: 'npm run search:reindex', why: '章名與分詞詞典都改了，全部題目的 search_tsv 依新詞典重切（不呼叫 LLM）' }
]);

// ───────────────────────── 提議（純函式） ─────────────────────────

/**
 * 需要處理的舊章：MIGRATION 裡 kind 為 rename／split／removed 的章（same 的題不用動）。
 * @returns {Array<{subject:string, chapter:string, kind:string, to:string[]}>} 依 MIGRATION 的宣告順序
 */
function movableChapters() {
    const out = [];
    for (const subject of MIGRATED_SUBJECTS) {
        for (const [chapter, m] of Object.entries(MIGRATION[subject] || {})) {
            if (m.kind !== 'same') out.push({ subject, chapter, kind: m.kind, to: m.to.slice() });
        }
    }
    return out;
}

/**
 * 替一題提議新章。純函式。
 *
 * @param {{subject:string, chapter:string, question_text?:string, keywords?:string[]|null, concept_summary?:string|null}} q
 * @returns {{chapter:string, basis:string}|null} 不需要處理（same、化學、不在對照表）時回 null
 */
function proposeChapter(q) {
    const m = MIGRATION[q.subject] && MIGRATION[q.subject][q.chapter];
    if (!m || m.kind === 'same') return null;
    if (m.kind === 'rename') return { chapter: m.to[0], basis: 'rename' };
    if (m.kind === 'removed') return { chapter: m.to[0] || '', basis: 'removed' };
    // split：先題幹、再 metadata（config/chapterMigrationRules.js 檔頭）
    const meta = [...(Array.isArray(q.keywords) ? q.keywords : []), q.concept_summary || ''];
    const hit = matchKeywordRule(q.subject, m.to, [[q.question_text || ''], meta]);
    if (hit) return { chapter: hit.to, basis: `keyword:${hit.keyword}` };
    return { chapter: m.to[0], basis: 'default' };
}

/** 依據欄 → 統計用的類別（keyword:<詞> 一律算 keyword） */
function basisKind(basis) {
    return String(basis).startsWith('keyword:') ? 'keyword' : String(basis);
}

/**
 * 題幹預覽：換行與連續空白壓成一個空白、取前 60 字；已封存加註。
 * 開頭是 = + - @ 時前面補一個 '（Excel 會把它當公式；這一欄 --apply 不讀，只給老師看）。
 * @param {string} text
 * @param {boolean} archived
 * @returns {string}
 */
function stemPreview(text, archived = false) {
    let s = String(text ?? '').replace(/\s+/g, ' ').trim();
    s = Array.from(s).slice(0, STEM_PREVIEW).join('');
    if (archived) s = ARCHIVED_MARK + s;
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return s;
}

/**
 * 候選題 → 提議列（依 MIGRATION 的宣告順序、再依 id 排序）。純函式。
 * @param {Array<object>} rows DB 撈出的題（id, subject, chapter, question_text, keywords, concept_summary, archived）
 * @returns {Array<{id:number, subject:string, oldChapter:string, newChapter:string, basis:string, stem:string, kind:string}>}
 */
function buildProposals(rows) {
    const order = new Map(movableChapters().map((c, i) => [`${c.subject}｜${c.chapter}`, i]));
    const out = [];
    for (const q of rows) {
        const p = proposeChapter(q);
        if (!p) continue;
        out.push({
            id: Number(q.id), subject: q.subject, oldChapter: q.chapter, newChapter: p.chapter, basis: p.basis,
            stem: stemPreview(q.question_text, Boolean(q.archived)),
            kind: MIGRATION[q.subject][q.chapter].kind
        });
    }
    out.sort((a, b) => (order.get(`${a.subject}｜${a.oldChapter}`) - order.get(`${b.subject}｜${b.oldChapter}`)) || (a.id - b.id));
    return out;
}

/**
 * 提議列的統計。純函式。
 * @param {Array<object>} proposals buildProposals 的輸出
 */
function summarizeProposals(proposals) {
    const byBasis = { rename: 0, keyword: 0, default: 0, removed: 0 };
    const bySubject = {};
    const byOld = new Map();
    let removedBlank = 0;
    let unchanged = 0;
    for (const p of proposals) {
        byBasis[basisKind(p.basis)] = (byBasis[basisKind(p.basis)] || 0) + 1;
        bySubject[p.subject] = (bySubject[p.subject] || 0) + 1;
        const key = `${p.subject}｜${p.oldChapter}`;
        if (!byOld.has(key)) byOld.set(key, { subject: p.subject, chapter: p.oldChapter, kind: p.kind, total: 0, to: new Map() });
        const g = byOld.get(key);
        g.total += 1;
        const dest = p.newChapter || '（留空，待老師決定）';
        g.to.set(dest, (g.to.get(dest) || 0) + 1);
        if (p.basis === 'removed' && !p.newChapter) removedBlank += 1;
        if (p.newChapter === p.oldChapter) unchanged += 1;
    }
    return {
        total: proposals.length, bySubject, byBasis, removedBlank, unchanged,
        byOld: [...byOld.values()].map(g => ({ ...g, to: [...g.to.entries()].map(([chapter, n]) => ({ chapter, n })) }))
    };
}

// ───────────────────────── CSV（純函式） ─────────────────────────

/** RFC 4180 的單一欄位：含逗號、雙引號、換行時加雙引號，內部的雙引號變兩個。 */
function csvField(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 提議列 → CSV 文字（UTF-8 BOM、CRLF 換行：Excel 直接雙擊就不會亂碼）。純函式。
 * @param {Array<object>} proposals
 * @returns {string}
 */
function toCsv(proposals) {
    const lines = [CSV_HEADER.map(csvField).join(',')];
    for (const p of proposals) {
        lines.push([p.id, p.subject, p.oldChapter, p.newChapter, p.basis, p.stem].map(csvField).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * CSV 文字 → 二維陣列（RFC 4180：雙引號包住的欄位可含逗號、換行、兩個雙引號代表一個）。純函式。
 * 開頭的 BOM 會去掉；完全空白的列略過，但回傳每一列在檔案裡的行號（給錯誤訊息用）。
 * @param {string} text
 * @returns {Array<{line:number, cells:string[]}>}
 */
function parseCsv(text) {
    const src = String(text ?? '').replace(/^﻿/, '');
    const rows = [];
    let cells = [];
    let cell = '';
    let quoted = false;
    let line = 1;
    let rowLine = 1;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else {
                if (ch === '\n') line++;
                cell += ch;
            }
            continue;
        }
        if (ch === '"' && cell === '') { quoted = true; continue; }
        if (ch === ',') { cells.push(cell); cell = ''; continue; }
        if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            cells.push(cell);
            if (cells.some(c => c.trim() !== '')) rows.push({ line: rowLine, cells });
            cells = []; cell = '';
            line++; rowLine = line;
            continue;
        }
        cell += ch;
    }
    if (quoted) throw new Error(`CSV 第 ${rowLine} 行起的雙引號沒有收尾`);
    cells.push(cell);
    if (cells.some(c => c.trim() !== '')) rows.push({ line: rowLine, cells });
    return rows;
}

/**
 * 檔案位元組 → 文字。UTF-8（含 BOM 與否）優先；不是合法 UTF-8 時試 Big5
 * （Excel 在繁中 Windows 上「另存成 CSV（逗號分隔）」的預設編碼）。純函式。
 * @param {Buffer|Uint8Array} buf
 * @returns {{text:string, encoding:'utf-8'|'big5'}}
 */
function decodeCsvBuffer(buf) {
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
    } catch (e) { /* 不是 UTF-8，往下試 Big5 */ }
    let decoder;
    try {
        decoder = new TextDecoder('big5', { fatal: true });
    } catch (e) {
        throw new Error('CSV 不是 UTF-8，而這台電腦的 Node 不支援 Big5 解碼。請在 Excel 用「CSV UTF-8（逗號分隔）」另存後再試。');
    }
    try {
        return { text: decoder.decode(buf), encoding: 'big5' };
    } catch (e) {
        throw new Error('CSV 既不是 UTF-8 也不是 Big5，無法辨識。請在 Excel 用「CSV UTF-8（逗號分隔）」另存後再試。');
    }
}

/** 比對章名用的寬鬆形式：NFKC（全形括號 → 半形）＋去掉所有空白 */
function looseChapterKey(s) {
    return String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
}

/**
 * 老師填的章名 → 白名單裡的正式章名。逐字相同優先；否則容許全形／半形括號與多打的空白
 * （「物質的組成(夸克與原子)」→「物質的組成（夸克與原子）」）。查不到回 null。純函式。
 * @param {string} subject
 * @param {string} text
 * @returns {string|null}
 */
function resolveChapter(subject, text) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    if (isValidChapter(subject, s)) return s;
    const key = looseChapterKey(s);
    for (const c of CHAPTERS[subject] || []) {
        if (looseChapterKey(c) === key) return c;
    }
    return null;
}

/**
 * 解析並逐列驗證老師改過的提議檔（不碰 DB）。純函式。
 *
 * 必要欄位：id、subject、舊章、提議新章（以表頭名稱找欄，欄位順序可以被 Excel 調動）；依據、題幹欄可有可無。
 *
 * @param {string} text CSV 文字
 * @returns {{rows:Array<{line:number, id:number, subject:string, oldChapter:string, newChapter:string, basis:string}>, errors:string[]}}
 */
function readApplyRows(text) {
    const errors = [];
    let table;
    try {
        table = parseCsv(text);
    } catch (e) {
        return { rows: [], errors: [e.message] };
    }
    if (table.length === 0) return { rows: [], errors: ['CSV 是空的'] };

    const header = table[0].cells.map(h => h.trim().replace(/^﻿/, ''));
    const col = {};
    for (const name of ['id', 'subject', '舊章', '提議新章', '依據']) col[name] = header.indexOf(name);
    const missing = ['id', 'subject', '舊章', '提議新章'].filter(n => col[n] < 0);
    if (missing.length) {
        return { rows: [], errors: [`第 ${table[0].line} 行（表頭）缺少欄位：${missing.join('、')}。表頭應為 ${CSV_HEADER.join(',')}`] };
    }

    const rows = [];
    const seen = new Map();
    for (const { line, cells } of table.slice(1)) {
        const get = (name) => (col[name] >= 0 && col[name] < cells.length ? String(cells[col[name]]) : '').trim();
        const rawId = get('id');
        const subject = get('subject');
        const oldChapter = get('舊章');
        const newRaw = get('提議新章');
        const basis = get('依據');

        const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
        if (!Number.isInteger(id) || id < 1 || id > INT4_MAX) { errors.push(`第 ${line} 行：id「${rawId}」不是正整數`); continue; }
        if (seen.has(id)) { errors.push(`第 ${line} 行：題號 ${id} 與第 ${seen.get(id)} 行重複`); continue; }
        seen.set(id, line);
        if (!MIGRATED_SUBJECTS.includes(subject)) { errors.push(`第 ${line} 行（題號 ${id}）：subject「${subject}」必須是數學或物理`); continue; }
        if (!oldChapter) { errors.push(`第 ${line} 行（題號 ${id}）：「舊章」是空的`); continue; }
        if (!newRaw) {
            errors.push(`第 ${line} 行（題號 ${id}）：「提議新章」是空的——請填新章；這題想暫緩的話，把整列刪掉`);
            continue;
        }
        const newChapter = resolveChapter(subject, newRaw);
        if (!newChapter) { errors.push(`第 ${line} 行（題號 ${id}）：「${newRaw}」不在${subject}的新章節白名單內`); continue; }
        rows.push({ line, id, subject, oldChapter, newChapter, basis });
    }
    return { rows, errors };
}

// ───────────────────────── 參數與檔案 ─────────────────────────

function parseArgs(argv) {
    const args = { mode: 'dry-run', apply: null, out: null, test: false, help: false };
    let sawDryRun = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') sawDryRun = true;
        else if (a === '--apply') {
            const f = argv[++i];
            if (!f || f.startsWith('--')) throw new Error('--apply 後面要接老師確認過的 CSV 檔名');
            args.mode = 'apply'; args.apply = f;
        } else if (a === '--out') {
            const f = argv[++i];
            if (!f || f.startsWith('--')) throw new Error('--out 後面要接提議檔的檔名');
            args.out = f;
        } else if (a === '--test') args.test = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--dry-run --out <檔名> --apply <檔名> --test`);
    }
    if (sawDryRun && args.mode === 'apply') throw new Error('--dry-run 與 --apply 只能擇一');
    if (args.out && args.mode === 'apply') throw new Error('--out 只用在 --dry-run（產生提議檔）');
    return args;
}

/** 本機日期 YYYY-MM-DD（老師的電腦時區；檔名用） */
function localDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 提議檔的預設路徑：data/chapter-migration-<日期>.csv；同名檔已存在（老師可能正在改）時
 * 改用 -2、-3…，**絕不覆寫**。
 * @param {string} [dir]
 * @param {string} [date]
 * @returns {string}
 */
function defaultOutPath(dir = DEFAULT_OUT_DIR, date = localDate()) {
    let n = 1;
    for (;;) {
        const name = n === 1 ? `chapter-migration-${date}.csv` : `chapter-migration-${date}-${n}.csv`;
        const full = path.join(dir, name);
        if (!fs.existsSync(full)) return full;
        n += 1;
    }
}

/** 同 scripts/reindex_search_tsv.js：--test 時自建連線並檢查庫名以 _test 結尾 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 4 });
    return { pool, query: (text, values) => pool.query(text, values) };
}

/** chapter_migration_log 不在 → 提示先跑 migrate（比 PG 的「relation does not exist」好懂） */
async function assertLogTable(executor) {
    const { rows } = await executor.query(`SELECT to_regclass('public.chapter_migration_log') IS NOT NULL AS ok`);
    if (!rows[0].ok) throw new Error('資料庫還沒有 chapter_migration_log 表：請先執行 npm run migrate（migrations/0014）');
}

// ───────────────────────── DB：dry-run ─────────────────────────

/**
 * 撈出需要處理、而且還沒記進 chapter_migration_log 的題（含已封存）。
 * @param {{query:Function}} db
 * @returns {Promise<Array<object>>}
 */
async function selectCandidates(db) {
    await assertLogTable(db);
    const movable = movableChapters();
    const { rows } = await db.query(
        `SELECT q.id, q.subject, q.chapter, q.question_text, q.keywords, q.concept_summary,
                (q.archived_at IS NOT NULL) AS archived
           FROM questions q
           JOIN unnest($1::text[], $2::text[]) AS m(subject, chapter)
             ON m.subject = q.subject AND m.chapter = q.chapter
          WHERE NOT EXISTS (SELECT 1 FROM chapter_migration_log l WHERE l.question_id = q.id AND l.plan = $3)
          ORDER BY q.id`,
        [movable.map(c => c.subject), movable.map(c => c.chapter), PLAN_ID]);
    return rows;
}

/**
 * 數學／物理裡章名既不在新白名單、也不在對照表的題（多半是舊系統匯入的髒資料）。本工具不處理，只回報。
 * @param {{query:Function}} db
 * @returns {Promise<Array<{id:number, subject:string, chapter:string}>>}
 */
async function selectOrphans(db) {
    const known = [];
    for (const s of MIGRATED_SUBJECTS) {
        for (const c of PLAN_CHAPTERS[s]) known.push([s, c]);
        for (const c of Object.keys(MIGRATION[s] || {})) known.push([s, c]);
    }
    const { rows } = await db.query(
        `SELECT q.id, q.subject, q.chapter FROM questions q
          WHERE q.subject = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS k(subject, chapter)
                             WHERE k.subject = q.subject AND k.chapter = q.chapter)
          ORDER BY q.id`,
        [MIGRATED_SUBJECTS.slice(), known.map(k => k[0]), known.map(k => k[1])]);
    return rows.map(r => ({ id: Number(r.id), subject: r.subject, chapter: r.chapter }));
}

/**
 * --dry-run：產生提議。只讀 DB；有提議時把 CSV 寫到 outPath（沒有需要處理的題就不寫檔）。
 * @param {{db:{query:Function}, outPath?:string|null, write?:boolean}} opts
 * @returns {Promise<{proposals:Array<object>, stats:object, orphans:Array<object>, outPath:string|null, alreadyLogged:number}>}
 */
async function dryRun({ db, outPath = null, write = true } = {}) {
    const problems = validateRules();
    if (problems.length) throw new Error(`config/chapterMigrationRules.js 有問題：\n  - ${problems.join('\n  - ')}`);

    const candidates = await selectCandidates(db);
    const proposals = buildProposals(candidates);
    const stats = summarizeProposals(proposals);
    const orphans = await selectOrphans(db);
    const { rows: logged } = await db.query('SELECT COUNT(*)::int AS n FROM chapter_migration_log WHERE plan = $1', [PLAN_ID]);

    let written = null;
    if (write && proposals.length > 0) {
        written = outPath ? path.resolve(outPath) : defaultOutPath();
        fs.mkdirSync(path.dirname(written), { recursive: true });
        fs.writeFileSync(written, toCsv(proposals), 'utf8');
    }
    return { proposals, stats, orphans, outPath: written, alreadyLogged: logged[0].n };
}

// ───────────────────────── DB：apply ─────────────────────────

/**
 * --apply：單一交易套用。任何驗證錯誤或例外都整批回滾。
 *
 * @param {{db:{pool:object}, rows:Array<object>, onRow?:Function}} opts
 *   rows = readApplyRows(...).rows；onRow(row) 在每一列寫入後呼叫（測試用來模擬中途失敗）
 * @returns {Promise<{ok:boolean, errors:string[], moved:number, confirmed:number, alreadyApplied:number,
 *                    stale:Array<{id:number, line:number, csvOld:string, csvNew:string, dbChapter:string}>, kcsRemoved:number,
 *                    movedIds:number[]}>}
 */
async function applyRows({ db, rows, onRow } = {}) {
    const result = { ok: false, errors: [], moved: 0, confirmed: 0, alreadyApplied: 0, stale: [], kcsRemoved: 0, movedIds: [] };
    if (!rows || rows.length === 0) { result.ok = true; return result; }

    const { buildTsvTokens } = require('../services/embedService');   // 會載入 jieba 詞典
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await assertLogTable(client);

        // 鎖住要動的題（與 PUT /api/questions/:id、PUT /kcs、自動標註同一把列鎖，互相排隊）
        const ids = rows.map(r => r.id);
        const { rows: current } = await client.query(
            'SELECT id, subject, chapter FROM questions WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
        const byId = new Map(current.map(r => [Number(r.id), r]));

        for (const r of rows) {
            const q = byId.get(r.id);
            if (!q) result.errors.push(`第 ${r.line} 行：題號 ${r.id} 不存在`);
            else if (q.subject !== r.subject) result.errors.push(`第 ${r.line} 行：題號 ${r.id} 在題庫裡是${q.subject}，CSV 寫的是${r.subject}`);
        }
        if (result.errors.length) {
            await client.query('ROLLBACK');
            return result;
        }
        // 已經記錄過的題（重跑同一份 CSV）：「確認留在原章」的列在題庫裡本來就是新章＝舊章，
        // 只看 questions.chapter 分不出第一次與重跑，所以以遷移紀錄為準。
        const { rows: loggedRows } = await client.query(
            'SELECT question_id FROM chapter_migration_log WHERE plan = $1 AND question_id = ANY($2::int[])', [PLAN_ID, ids]);
        const logged = new Set(loggedRows.map(x => Number(x.question_id)));

        for (const r of rows) {
            const q = byId.get(r.id);
            let logIt = true;
            if (q.chapter === r.newChapter && (logged.has(r.id) || r.newChapter !== r.oldChapter)) {
                result.alreadyApplied += 1;                   // 重跑、或老師已經在題庫頁改成提議的章
            } else if (q.chapter !== r.oldChapter) {
                result.stale.push({ id: r.id, line: r.line, csvOld: r.oldChapter, csvNew: r.newChapter, dbChapter: q.chapter });
                logIt = false;                                // 以題庫現值為準，下次 dry-run 視情況再列
            } else if (r.newChapter === r.oldChapter) {
                result.confirmed += 1;                        // 老師確認留在原章：題目不動
            } else {
                const { rows: upd } = await client.query(
                    `UPDATE questions
                        SET chapter = $2, chapter_src = 'human', embed_hash = NULL
                      WHERE id = $1 AND chapter = $3
                  RETURNING id, subject, chapter, question_type, difficulty, question_text, concept_summary, keywords`,
                    [r.id, r.newChapter, r.oldChapter]);
                const row = upd[0];
                const { chapterTokens, keywordTokens, stemTokens } = buildTsvTokens(row);
                await client.query(`UPDATE questions SET search_tsv = ${TSV_EXPR} WHERE id = $1`,
                    [row.id, chapterTokens, keywordTokens, stemTokens]);
                const del = await client.query(`DELETE FROM question_kcs WHERE question_id = $1 AND src = 'ai'`, [r.id]);
                result.kcsRemoved += del.rowCount || 0;
                result.moved += 1;
                result.movedIds.push(r.id);
            }
            if (logIt) {
                await client.query(
                    `INSERT INTO chapter_migration_log (question_id, plan, subject, from_chapter, to_chapter, basis)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (question_id, plan) DO NOTHING`,
                    [r.id, PLAN_ID, r.subject, r.oldChapter, r.newChapter, r.basis ? r.basis.slice(0, 80) : null]);
            }
            if (onRow) await onRow(r);
        }

        await client.query('COMMIT');
        result.ok = true;
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

// ───────────────────────── 主流程 ─────────────────────────

function printErrors(errors) {
    for (const e of errors.slice(0, ERROR_LIST_MAX)) console.log(`  - ${e}`);
    if (errors.length > ERROR_LIST_MAX) console.log(`  …其餘 ${errors.length - ERROR_LIST_MAX} 筆不逐一列出`);
}

function printDryRun(r, target) {
    console.log(`章節重整：舊題搬章的提議（${PLAN_ID}）→ ${target}`);
    console.log('只讀資料庫、不呼叫 LLM。');
    if (r.alreadyLogged > 0) console.log(`之前已處理並記錄的題：${r.alreadyLogged} 題（這次不再列出）`);
    const s = r.stats;
    if (s.total === 0) {
        console.log('\n沒有需要搬章的題。');
    } else {
        console.log(`\n需要老師確認的題：${s.total} 題（${Object.entries(s.bySubject).map(([k, v]) => `${k} ${v}`).join('、')}）`);
        for (const g of s.byOld) {
            console.log(`  ${g.subject}｜${g.chapter}（${g.kind}）${g.total} 題 → ${g.to.map(t => `${t.chapter} ${t.n}`).join('、')}`);
        }
        console.log(`依據：rename ${s.byBasis.rename}、keyword ${s.byBasis.keyword}、default ${s.byBasis.default}、removed ${s.byBasis.removed}`
            + `（提議新章與舊章相同、確認後題目不動的有 ${s.unchanged} 題）`);
        if (s.byBasis.removed > 0) {
            console.log(`⚠ removed 的 ${s.byBasis.removed} 題所在的章已刪除，一律要老師決定去處`
                + (s.removedBlank > 0 ? `；其中 ${s.removedBlank} 題沒有建議去處，「提議新章」留空，必須填上才能套用` : ''));
        }
        if (s.byBasis.default > 0) console.log(`⚠ default 的 ${s.byBasis.default} 題沒有關鍵字命中，提議的是預設去處，請特別看一下。`);
    }
    if (r.orphans.length > 0) {
        const ids = r.orphans.slice(0, 10).map(o => `#${o.id}（${o.subject}｜${o.chapter}）`).join('、');
        console.log(`\n⚠ 另有 ${r.orphans.length} 題的章名既不在新白名單、也不在對照表，本工具不處理，請在題庫頁手動改章：${ids}${r.orphans.length > 10 ? '…' : ''}`);
    }
    if (r.outPath) {
        console.log(`\n提議檔：${r.outPath}`);
        console.log('下一步：');
        console.log('  1. 用 Excel 開啟提議檔，逐列看「提議新章」；要改就直接改那一格（章名要與白名單一字不差）。');
        console.log('     某一題想暫緩，就把整列刪掉。其他欄位不要改。');
        console.log('  2. 存檔時選「CSV UTF-8（逗號分隔）」（選一般 CSV 也可以，本工具會自動辨識 Big5）。');
        console.log(`  3. npm run chapters:migrate -- --apply "${r.outPath}"`);
    }
}

function printApply(r, file) {
    console.log(`\n──────── 結果（${path.basename(file)}）────────`);
    console.log(`搬到新章 ${r.moved} 題；確認留在原章 ${r.confirmed} 題；已經是提議的章（含重跑）${r.alreadyApplied} 題；`
        + `清掉 AI 知識點標註 ${r.kcsRemoved} 筆`);
    if (r.stale.length > 0) {
        console.log(`⚠ ${r.stale.length} 題在產生提議檔之後被改過章，已略過（以題庫現值為準）：`);
        for (const s of r.stale.slice(0, ERROR_LIST_MAX)) {
            console.log(`  - 第 ${s.line} 行 題號 ${s.id}：提議檔寫「${s.csvOld} → ${s.csvNew}」，題庫現在是「${s.dbChapter}」`);
        }
    }
    if (r.moved > 0) {
        console.log('\n之後必跑的指令（依序）：');
        NEXT_COMMANDS.forEach((c, i) => console.log(`  ${i + 1}. ${c.cmd}    # ${c.why}`));
        console.log('  （被清掉 AI 知識點標註的題，npm run kc:load 載入新的知識點種子檔之後，可用 npm run kc:backfill 重標）');
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 7).join('\n'));
        return 0;
    }

    // --apply 先驗證檔案（不需要連 DB）
    let applyRowsInput = null;
    if (args.mode === 'apply') {
        const file = path.resolve(args.apply);
        if (!fs.existsSync(file)) throw new Error(`找不到提議檔：${file}`);
        const { text, encoding } = decodeCsvBuffer(fs.readFileSync(file));
        const { rows, errors } = readApplyRows(text);
        console.log(`讀入 ${file}（${encoding}）：${rows.length + errors.length} 列`);
        if (errors.length) {
            console.log(`❌ ${errors.length} 列沒通過驗證，整批不寫入：`);
            printErrors(errors);
            return 1;
        }
        applyRowsInput = { file, rows };
    }

    const db = resolveDb(args.test);
    const target = args.test ? 'TEST_DATABASE_URL（測試庫）' : 'DATABASE_URL（開發／正式庫）';
    try {
        if (args.mode === 'dry-run') {
            const r = await dryRun({ db, outPath: args.out });
            printDryRun(r, target);
            return 0;
        }
        console.log(`套用到 ${target}；單一交易，任何一列有問題整批不寫。`);
        const r = await applyRows({ db, rows: applyRowsInput.rows });
        if (!r.ok) {
            console.log(`❌ ${r.errors.length} 列與題庫對不上，整批不寫入（已回滾）：`);
            printErrors(r.errors);
            return 1;
        }
        printApply(r, applyRowsInput.file);
        return 0;
    } finally {
        await db.pool.end();
    }
}

module.exports = {
    PLAN_ID, CSV_HEADER, NEXT_COMMANDS, MIGRATED_SUBJECTS,
    movableChapters, proposeChapter, buildProposals, summarizeProposals, stemPreview,
    toCsv, parseCsv, decodeCsvBuffer, resolveChapter, readApplyRows,
    parseArgs, localDate, defaultOutPath,
    selectCandidates, selectOrphans, dryRun, applyRows
};

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error('❌ ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}
