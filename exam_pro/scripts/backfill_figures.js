// scripts/backfill_figures.js — 舊題補附圖（〔Owner 決策單 2026-09-25 B20〕roadmap 待決策第 19 項、docs/figures.md「舊題補附圖」）
//
// 用法：
//   npm run figures:backfill -- --dir "<原卷資料夾>"     ＝ --dry-run：掃描資料夾（含子資料夾）裡的 PDF、裁圖、對題，產生
//                                                       data/figure-backfill/<日期>/ 底下的 proposals.csv、preview.html 與暫存圖
//   npm run figures:backfill -- --dir <資料夾> --out-dir <資料夾>    提議檔與暫存圖改放指定資料夾（裡面不可已有 proposals.csv）
//   npm run figures:backfill -- --dir <資料夾> --use-llm   另外呼叫拆題模型（MODEL_EXTRACT）框圖（預設不呼叫任何 LLM；說明見本檔檔頭）
//   npm run figures:backfill -- --apply <proposals.csv>   套用老師確認（刪過列）的提議檔
//   加 --test 改打 TEST_DATABASE_URL（庫名必須以 _test 結尾）
//
// 為什麼要有這一支：附圖裁切（docs/figures.md）只在新拆題時做，2026-08-27 前入庫的題沒有圖。Owner 決定用原卷 PDF
// （老師電腦上的「各校考卷」資料夾，路徑由 --dir 給，程式不寫死）重跑裁圖並比對題目；會寫入正式庫，所以流程照
// scripts/migrate_chapters.js 的「提議 → 老師確認 → 套用」：
//
//   --dry-run（預設）**只讀資料庫、不寫資料庫、預設不呼叫任何 LLM**。
//     候選題：題庫裡 question_img 是空的題（含已封存，題幹欄加「（已封存）」；不含變式題——變式題不在原卷上，
//     而且改過數字，原題的圖不適用）。
//     每份 PDF：讀文字層與圖形（services/pdfLayout.js）→ 找圖、定位候選題、判斷每張圖屬於哪一題
//     （utils/figureLayout.js，確定性規則，檔頭有說明）→ 每題取一個提議（多份卷都有時，優先「原卷與入庫紀錄相符」＝
//     題目當初就是從這份 PDF 拆的〔jobs.pdf_sha256〕，其次來源註記〔questions.source_detail〕與檔名相符，再來分數高者）
//     → 裁圖（與新管線相同的 144 DPI）存成暫存圖 q<題號>.png → 寫提議檔（UTF-8 含 BOM，Excel 直接開）：
//         題號、科目、章、題幹前60字、來源PDF、頁碼、圖檔暫存路徑、比對分數、依據
//       比對分數＝題幹在原卷文字層的覆蓋率 × 版面係數（圖跨兩題、或是頁首接續上一頁的圖時打折），0–1。
//     另外產生 preview.html：逐題並排「裁出來的圖」與題目，老師看圖用（Excel 看不到圖）。
//   --apply <csv>：老師刪掉不要的列（刪列＝不套用）後存檔再跑。**單一交易**：
//       - 先逐列驗證（題號、沒有重複列、暫存圖存在且是 PNG、圖檔必須在提議檔同一個資料夾裡），有任何錯誤整批不寫；
//       - 題號不存在 → 整批不寫（回滾）；
//       - 已經有附圖的題略過並警告（以題庫現值為準）：是本工具先前套用的同一張圖＝重跑（冪等），不是的列出題號；
//       - 其餘：暫存圖複製到 data/figures/backfill-<題號>-<圖檔雜湊前 8 碼>.png（與新管線同一個目錄，
//         檔名符合 Word 匯出的白名單），questions.question_img 寫 /figures/<檔名>（與新管線入庫的形狀相同）。
//     不需要紀錄表（沒有新 migration）：question_img 本身就是「補過了」的標記——之後的 --dry-run 不再列出、
//     重跑同一份 CSV 不會重寫；提議檔與暫存圖留在 data/figure-backfill/ 當紀錄。
//
// --use-llm（只在明確加這個旗標時才呼叫模型）：新管線「哪張圖屬於哪一題」本來就靠拆題模型回框（docs/figures.md），
//   這個旗標讓本工具對「確定性比對用不上」的卷——掃描檔（沒有文字層），以及題幹提到圖、原卷也找到了、卻沒偵測到圖的卷——
//   照新管線呼叫 agents/extract.js（MODEL_EXTRACT；本機模式是 OCR＋視覺模型），拿模型回的框裁圖、以模型抄的題幹對題庫
//   （中文字 5-gram 相似度 ≥ 0.8）。卷別（數學／物理 或 化學）預設依定位到的題判斷，判斷不出來當數學／物理；
//   可用 --subject-group math_physics|chemistry 指定。
//
// CSV 的解碼沿用 scripts/migrate_chapters.js：UTF-8（含或不含 BOM）；Excel 另存成一般「CSV（逗號分隔）」的 Big5 也自動辨識。
// 中文路徑：PDF、暫存圖一律以 Node 的 fs 讀寫位元組（mupdf 吃 buffer），「各校考卷」這類資料夾在 Windows 上照常可用。

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { parseCsv, decodeCsvBuffer, stemPreview, localDate } = require('./migrate_chapters');
const layout = require('../utils/figureLayout');
const { hasTextLayer } = require('../utils/sourceCheck');

// ───────────────────────── 常數 ─────────────────────────

/** 提議檔的欄位（順序凍結；--apply 以表頭名稱找欄，Excel 調過欄位順序也讀得到） */
const CSV_HEADER = Object.freeze(['題號', '科目', '章', '題幹前60字', '來源PDF', '頁碼', '圖檔暫存路徑', '比對分數', '依據']);
const REQUIRED_APPLY_COLUMNS = Object.freeze(['題號', '圖檔暫存路徑']);

const CSV_NAME = 'proposals.csv';
const PREVIEW_NAME = 'preview.html';
const APP_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUT_ROOT = path.join(APP_DIR, 'data', 'figure-backfill');
const SUBJECT_GROUPS = Object.freeze(['auto', 'math_physics', 'chemistry']);
const ERROR_LIST_MAX = 20;
const INT4_MAX = 2147483647;
const LOW_SCORE = 0.8;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 本工具寫進 question_img 的形狀：/figures/backfill-<題號>-<圖檔 sha256 前 8 碼>.png */
const BACKFILL_IMG = /^\/figures\/backfill-(\d+)-([0-9a-f]{8})\.png$/;

function figureFileName(id, sha8) {
    return `backfill-${id}-${sha8}.png`;
}
function figureUrl(id, sha8) {
    return `/figures/${figureFileName(id, sha8)}`;
}

// ───────────────────────── 參數 ─────────────────────────

function parseArgs(argv) {
    const args = {
        mode: 'dry-run', dir: null, outDir: null, apply: null, useLlm: false, subjectGroup: 'auto', test: false, help: false
    };
    let sawDryRun = false;
    let sawGroup = false;
    const value = (i, flag, what) => {
        const v = argv[i];
        if (!v || v.startsWith('--')) throw new Error(`${flag} 後面要接${what}`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') sawDryRun = true;
        else if (a === '--dir') args.dir = value(++i, '--dir', '放原卷 PDF 的資料夾');
        else if (a === '--out-dir') args.outDir = value(++i, '--out-dir', '提議檔與暫存圖要放的資料夾');
        else if (a === '--apply') { args.apply = value(++i, '--apply', '老師確認過的提議檔（proposals.csv）'); args.mode = 'apply'; }
        else if (a === '--use-llm') args.useLlm = true;
        else if (a === '--subject-group') {
            const g = value(++i, '--subject-group', ' math_physics 或 chemistry');
            if (!SUBJECT_GROUPS.includes(g)) throw new Error(`--subject-group 只能是 ${SUBJECT_GROUPS.join('／')}，收到「${g}」`);
            args.subjectGroup = g; sawGroup = true;
        } else if (a === '--test') args.test = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`未知的參數「${a}」，可用：--dir <資料夾> --out-dir <資料夾> --use-llm --subject-group <卷別> --apply <檔名> --test`);
    }
    if (args.help) return args;
    if (args.mode === 'apply') {
        if (sawDryRun) throw new Error('--dry-run 與 --apply 只能擇一');
        if (args.dir) throw new Error('--dir 只用在 --dry-run（產生提議檔）；--apply 只讀提議檔');
        if (args.outDir) throw new Error('--out-dir 只用在 --dry-run（產生提議檔）');
        if (args.useLlm) throw new Error('--use-llm 只用在 --dry-run；--apply 不呼叫任何模型');
        if (sawGroup) throw new Error('--subject-group 只用在 --dry-run --use-llm');
    } else {
        if (!args.dir) throw new Error('缺少 --dir：請給放原卷 PDF 的資料夾（例：--dir "C:\\Users\\你\\Desktop\\各校考卷"）');
        if (sawGroup && !args.useLlm) throw new Error('--subject-group 只在 --use-llm 時有用');
    }
    return args;
}

// ───────────────────────── 檔案 ─────────────────────────

/** 資料夾裡（含子資料夾）的 PDF，依相對路徑排序。符號連結不跟（避免繞圈）。 */
function walkPdfs(dir) {
    const out = [];
    const visit = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) visit(p);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) out.push(p);
        }
    };
    visit(dir);
    return out;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 預設的輸出資料夾：data/figure-backfill/<日期>；已存在時改用 -2、-3…，**絕不覆寫**（老師可能正在改上一份）。
 */
function defaultOutDir(root = DEFAULT_OUT_ROOT, date = localDate()) {
    for (let n = 1; ; n++) {
        const dir = path.join(root, n === 1 ? date : `${date}-${n}`);
        if (!fs.existsSync(dir)) return dir;
    }
}

/** 路徑的最後一段（Windows 的 \ 與 / 都認，提議檔在另一台電腦產生時也讀得懂） */
function lastSegment(p) {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || '';
}

function isWithin(dir, file) {
    const rel = path.relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 提議檔裡的圖檔路徑 → 本機檔案。先照寫的路徑找（相對路徑以提議檔所在資料夾為準）；找不到時改找
 * 「提議檔同一個資料夾裡的同名檔」（整個資料夾搬過位置時）。**圖檔必須在提議檔同一個資料夾（含子資料夾）裡**：
 * 提議檔是可以被改的文字檔，不能讓它指向任意檔案、被複製進對外供圖的 data/figures/。
 *
 * @returns {{file:string}|{error:string}}
 */
function resolveImagePath(raw, csvDir) {
    const s = String(raw ?? '').trim().replace(/^'/, '');
    if (!s) return { error: '「圖檔暫存路徑」是空的' };
    let base;
    try { base = fs.realpathSync(csvDir); } catch (e) { return { error: `找不到提議檔所在的資料夾：${csvDir}` }; }
    const tries = [path.isAbsolute(s) ? s : path.resolve(csvDir, s), path.join(csvDir, lastSegment(s))];
    let outside = false;
    for (const t of tries) {
        let st;
        try { st = fs.statSync(t); } catch (e) { continue; }
        if (!st.isFile()) continue;
        const real = fs.realpathSync(t);
        if (isWithin(base, real)) return { file: real };
        outside = true;
    }
    if (outside) return { error: `圖檔「${s}」不在提議檔所在的資料夾裡；只接受 --dry-run 產生在同一個資料夾的暫存圖` };
    return { error: `找不到圖檔「${s}」` };
}

// ───────────────────────── CSV（純函式） ─────────────────────────

function csvField(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 分數兩位小數 */
function fmt(n) {
    return Number(n).toFixed(2);
}

/**
 * 提議列 → CSV 文字（UTF-8 BOM、CRLF：Excel 直接雙擊不亂碼）。純函式。
 * @param {Array<{id:number, subject:string, chapter:string, stem:string, pdfRel:string, page:number, image:string, score:number, basis:string}>} rows
 */
function toCsv(rows) {
    const lines = [CSV_HEADER.map(csvField).join(',')];
    for (const r of rows) {
        lines.push([r.id, r.subject, r.chapter, r.stem, r.pdfRel, r.page, r.image, fmt(r.score), r.basis].map(csvField).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/**
 * 解析並逐列驗證老師改過的提議檔（只看文字，不碰檔案與 DB）。純函式。
 * 必要欄位：題號、圖檔暫存路徑（以表頭名稱找欄）；其餘欄位只用來印訊息。
 *
 * @param {string} text
 * @returns {{rows:Array<{line:number, id:number, image:string, pdfRel:string, page:string, score:string}>, errors:string[]}}
 */
function readApplyRows(text) {
    let table;
    try {
        table = parseCsv(text);
    } catch (e) {
        return { rows: [], errors: [e.message] };
    }
    if (table.length === 0) return { rows: [], errors: ['CSV 是空的'] };
    const header = table[0].cells.map(h => h.trim().replace(/^\uFEFF/, ''));
    const col = {};
    for (const name of CSV_HEADER) col[name] = header.indexOf(name);
    const missing = REQUIRED_APPLY_COLUMNS.filter(n => col[n] < 0);
    if (missing.length) {
        return { rows: [], errors: [`第 ${table[0].line} 行（表頭）缺少欄位：${missing.join('、')}。表頭應為 ${CSV_HEADER.join(',')}`] };
    }
    const errors = [];
    const rows = [];
    const seen = new Map();
    for (const { line, cells } of table.slice(1)) {
        const get = (name) => (col[name] >= 0 && col[name] < cells.length ? String(cells[col[name]]) : '').trim();
        const rawId = get('題號');
        const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
        if (!Number.isInteger(id) || id < 1 || id > INT4_MAX) { errors.push(`第 ${line} 行：題號「${rawId}」不是正整數`); continue; }
        if (seen.has(id)) { errors.push(`第 ${line} 行：題號 ${id} 與第 ${seen.get(id)} 行重複（一題只能補一張圖）`); continue; }
        seen.set(id, line);
        const image = get('圖檔暫存路徑');
        if (!image) { errors.push(`第 ${line} 行（題號 ${id}）：「圖檔暫存路徑」是空的——這題不要套用的話，把整列刪掉`); continue; }
        rows.push({ line, id, image, pdfRel: get('來源PDF'), page: get('頁碼'), score: get('比對分數') });
    }
    return { rows, errors };
}

/**
 * 逐列確認暫存圖：找得到、在提議檔的資料夾裡、是 PNG。通過的列補上 file、bytes、sha8。
 * @returns {Promise<string[]>} 錯誤訊息
 */
async function checkImages(rows, csvDir) {
    const sharp = require('sharp');
    const errors = [];
    for (const r of rows) {
        const res = resolveImagePath(r.image, csvDir);
        if (res.error) { errors.push(`第 ${r.line} 行（題號 ${r.id}）：${res.error}`); continue; }
        const bytes = fs.readFileSync(res.file);
        let ok = bytes.subarray(0, 8).equals(PNG_MAGIC);
        if (ok) {
            try {
                const meta = await sharp(bytes).metadata();
                ok = meta.format === 'png' && meta.width > 0 && meta.height > 0;
            } catch (e) { ok = false; }
        }
        if (!ok) { errors.push(`第 ${r.line} 行（題號 ${r.id}）：「${lastSegment(res.file)}」不是 PNG 圖檔（只接受 --dry-run 產生的 .png）`); continue; }
        r.file = res.file;
        r.bytes = bytes;
        r.sha8 = sha256(bytes).slice(0, 8);
    }
    return errors;
}

// ───────────────────────── 預覽頁（純函式） ─────────────────────────

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * preview.html：逐題並排裁出來的圖與題目（圖用相對路徑，整個資料夾搬走也看得到）。純函式。
 * @param {Array<object>} rows 與 toCsv 相同的列，另帶 text（完整題幹）與 imageName
 */
function renderPreview(rows, { csvPath, generatedAt = new Date() } = {}) {
    const body = rows.map(r => `
<tr class="${r.score < LOW_SCORE ? 'low' : ''}">
  <td class="id">#${escapeHtml(r.id)}<br><small>${escapeHtml(r.subject)}｜${escapeHtml(r.chapter)}</small></td>
  <td class="fig"><img src="${escapeHtml(encodeURI(r.imageName))}" alt="題號 ${escapeHtml(r.id)} 的提議附圖" loading="lazy"></td>
  <td class="stem">${escapeHtml(Array.from(String(r.text ?? '')).slice(0, 300).join(''))}</td>
  <td class="src">${escapeHtml(r.pdfRel)}<br>第 ${escapeHtml(r.page)} 頁</td>
  <td class="basis"><b>${fmt(r.score)}</b><br>${escapeHtml(r.basis)}</td>
</tr>`).join('');
    return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>舊題補附圖預覽</title>
<style>
  body { font-family: system-ui, "Microsoft JhengHei", sans-serif; margin: 16px; color: #1f2937; background: #fff; }
  h1 { font-size: 20px; }
  p { max-width: 60em; line-height: 1.6; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; vertical-align: top; text-align: left; font-size: 14px; }
  th { background: #f3f4f6; position: sticky; top: 0; }
  td.fig img { max-width: 360px; max-height: 280px; border: 1px solid #e5e7eb; background: #fff; }
  td.stem { max-width: 32em; white-space: pre-wrap; }
  tr.low td { background: #fff7ed; }
  small { color: #6b7280; }
</style>
</head>
<body>
<h1>舊題補附圖：提議預覽（${rows.length} 題）</h1>
<p>這一頁只給你看圖對不對。<b>要不要套用以提議檔為準</b>：用 Excel 開啟 ${escapeHtml(csvPath || CSV_NAME)}，
不要的題把整列刪掉、存檔，再執行 <code>npm run figures:backfill -- --apply "提議檔路徑"</code>。
橘底的列分數低於 ${LOW_SCORE}（圖跨兩題、頁首接續上一頁，或題幹在原卷只找到一部分），請特別確認。</p>
<p><small>產生時間：${escapeHtml(generatedAt.toLocaleString('zh-TW'))}</small></p>
<table>
<thead><tr><th>題號</th><th>附圖（裁切結果）</th><th>題目</th><th>來源</th><th>分數／依據</th></tr></thead>
<tbody>${body}
</tbody>
</table>
</body>
</html>
`;
}

// ───────────────────────── 依據（純函式） ─────────────────────────

const LAYOUT_TEXT = Object.freeze({
    inside: () => '圖在該題範圍內',
    mostly: (p) => `圖大半在該題範圍內（重疊 ${fmt(p.ratio)}）`,
    ambiguous: (p) => `圖跨兩題（重疊 ${fmt(p.ratio)}），請特別確認`,
    carry: () => '頁首的圖，接續上一頁（欄）最後一題，請特別確認'
});

/**
 * 提議的「依據」欄（給老師看的一句話，--apply 不讀）。純函式。
 */
function basisText(p) {
    const parts = [];
    if (p.method === 'llm') {
        parts.push(`模型框圖（${p.model}）`, `題幹相似 ${fmt(p.coverage)}`);
    } else {
        parts.push(`題幹覆蓋 ${fmt(p.coverage)}`);
        parts.push((LAYOUT_TEXT[p.layout] || (() => p.layout))(p));
        if (p.figures > 1) parts.push(`併 ${p.figures} 張圖`);
        if (p.otherPages > 0) parts.push(`另有 ${p.otherPages} 頁的圖未採用`);
        if (p.flat) parts.push('扁長，可能是算式圖片');
    }
    if (p.jobIds && p.jobIds.length) parts.push(`原卷與入庫紀錄相符（job #${p.jobIds.join('、#')}）`);
    if (p.sourceDetailMatch) parts.push('來源註記與檔名相符');
    parts.push(p.hint ? '題幹提到圖' : '題幹沒有提到圖');
    if (p.alsoIn > 0) parts.push(`另見於 ${p.alsoIn} 份卷`);
    return parts.join('；');
}

/** 來源註記（例：「北一女 2024 段考」）裡至少一個兩字以上的中文詞出現在 PDF 的相對路徑 */
function sourceDetailMatches(sourceDetail, pdfRel) {
    const tokens = String(sourceDetail ?? '').normalize('NFKC').match(/[一-鿿]{2,}/g) || [];
    const hay = String(pdfRel ?? '').normalize('NFKC');
    return tokens.some(t => hay.includes(t));
}

/**
 * 同一題在多份卷都有提議時取一個：原卷與入庫紀錄相符 → 來源註記相符 → 分數高 → 路徑、頁碼小。純函式。
 * @returns {object} 取中的提議（alsoIn＝其餘份數）
 */
function pickBest(list) {
    const sorted = list.slice().sort((a, b) =>
        (Number(b.jobIds.length > 0) - Number(a.jobIds.length > 0))
        || (Number(b.sourceDetailMatch) - Number(a.sourceDetailMatch))
        || (b.score - a.score)
        || a.pdfRel.localeCompare(b.pdfRel)
        || (a.page - b.page));
    return { ...sorted[0], alsoIn: new Set(list.map(p => p.pdfRel)).size - 1 };
}

// ───────────────────────── 單份 PDF：確定性比對 ─────────────────────────

/** 這份卷要找哪些候選題：題目當初若是從資料夾裡的某一份拆的（jobs.pdf_sha256），只在那一份找 */
function eligibleFor(candidates, sha, folderShas) {
    return candidates.filter(c => {
        const own = c.pdfShas.filter(s => folderShas.has(s));
        return own.length === 0 || own.includes(sha);
    });
}

/**
 * 一份有文字層的卷：找圖、定位、分題，回傳每題的提議（還沒裁圖）。純計算（layoutData 由呼叫端讀好）。
 *
 * @param {{layoutData:object, pdfRel:string, pdfAbs:string, sha:string, candidates:Array<object>, options?:object}} input
 * @returns {{proposals:Array<object>, located:Map<number,object>, stats:object}}
 */
function analyzeLayout({ layoutData, pdfRel, pdfAbs, sha, candidates, options }) {
    const stats = { figures: 0, assigned: 0, header: 0, unowned: 0, dropped: { small: 0, table: 0, inline: 0, large: 0, white: 0 }, tieLost: 0 };
    const doc = layout.buildDocIndex(layoutData.pages, options);

    const figuresByPage = new Map();
    for (const p of layoutData.pages) {
        const r = layout.detectFigures(p, options);
        figuresByPage.set(p.page, r.figures);
        stats.figures += r.figures.length;
        for (const k of Object.keys(stats.dropped)) stats.dropped[k] += r.dropped[k] || 0;
    }

    // 定位候選題
    const located = [];
    for (const c of candidates) {
        if (c.lowAnchor) continue;
        const loc = layout.locateInDoc(c.text, doc, options);
        if (loc.status === 'located') located.push({ key: c.id, cand: c, loc, startLine: loc.startLine });
    }
    // 同一個起點被兩題以上定位到、而兩題題幹不同（中文字一樣、只差數字）：數字與字母較相符的留下
    const byStart = new Map();
    for (const it of located) {
        const k = it.startLine.lineNo;
        if (!byStart.has(k)) byStart.set(k, []);
        byStart.get(k).push(it);
    }
    const kept = [];
    for (const group of byStart.values()) {
        if (group.length === 1) { kept.push(group[0]); continue; }
        const scored = group.map(it => ({ it, d: layout.detailSimilarity(it.cand.text, doc.text.slice(it.loc.from, it.loc.to + 40)) }));
        const top = Math.max(...scored.map(s => s.d));
        for (const s of scored) {
            if (s.d === top) kept.push(s.it); else stats.tieLost += 1;
        }
    }
    const locatedMap = new Map(kept.map(it => [it.cand.id, it]));

    // 分段、分題
    const boundaries = layout.buildBoundaries(doc, kept, figuresByPage, options);
    const assigned = new Map();
    for (const p of layoutData.pages) {
        const columns = doc.columnsByPage.get(p.page) || 1;
        for (const fig of figuresByPage.get(p.page) || []) {
            const a = layout.assignFigure(fig, p, columns, boundaries, options);
            if (!a.boundary) { stats.header += 1; continue; }
            if (a.boundary.owners.length === 0) { stats.unowned += 1; continue; }
            stats.assigned += 1;
            for (const id of a.boundary.owners) {
                if (!assigned.has(id)) assigned.set(id, []);
                assigned.get(id).push({ page: p.page, fig, layout: a.layout, ratio: a.ratio });
            }
        }
    }

    const rank = { inside: 0, mostly: 1, carry: 2, ambiguous: 3 };
    const proposals = [];
    for (const [id, list] of assigned) {
        const it = locatedMap.get(id);
        const byPage = new Map();
        for (const a of list) {
            if (!byPage.has(a.page)) byPage.set(a.page, []);
            byPage.get(a.page).push(a);
        }
        const pages = [...byPage.entries()].map(([page, arr]) => ({
            page, arr, area: arr.reduce((s, a) => s + layout.area(a.fig.bbox), 0)
        })).sort((a, b) => (b.area - a.area) || (a.page - b.page));
        const chosen = pages[0];
        const rect = chosen.arr.map(a => a.fig.bbox).reduce(layout.union);
        const worst = chosen.arr.slice().sort((a, b) => (rank[b.layout] - rank[a.layout]) || (a.ratio - b.ratio))[0];
        const coverage = it.loc.coverage;
        const c = it.cand;
        proposals.push({
            method: 'layout', id, cand: c, pdfRel, pdfAbs, sha, page: chosen.page, rect,
            coverage, layout: worst.layout, ratio: worst.ratio,
            score: layout.proposalScore({ coverage, layout: worst.layout, ratio: worst.ratio }, options),
            figures: chosen.arr.length, otherPages: pages.length - 1,
            flat: chosen.arr.length === 1 && Boolean(chosen.arr[0].fig.flat),
            hint: c.hint, jobIds: c.pdfShas.includes(sha) ? c.jobIds.slice() : [],
            sourceDetailMatch: sourceDetailMatches(c.sourceDetail, pdfRel)
        });
    }
    return { proposals, located: locatedMap, stats };
}

// ───────────────────────── 單份 PDF：--use-llm ─────────────────────────

/** 卷別：定位到的題多數是化學 → chemistry，否則 math_physics */
function inferSubjectGroup(subjects) {
    const chem = subjects.filter(s => s === '化學').length;
    return subjects.length > 0 && chem * 2 > subjects.length ? 'chemistry' : 'math_physics';
}

/** 組一個最小的 Ctx 給 agents/extract.js（agent 不讀 process.env；模型與切塊設定與新管線相同） */
function buildExtractCtx(group, logger) {
    const models = require('../config/models');
    const runner = require('../workers/jobRunner');
    const cfg = { ...runner.loadConfig(), ...runner.loadLocalModeConfig() };
    const verify = models.MODEL_VERIFY;
    return {
        llm: require('../services/llm'),
        db: null, job: { subject_group: group }, jq: null, logger,
        config: {
            models: {
                extract: models.MODEL_EXTRACT, verify,
                ocrStructure: String(process.env.MODEL_OCR_STRUCTURE || '').trim() || verify,
                text: models.MODEL_TEXT || models.MODEL_EXTRACT
            },
            thresholds: { pdfChunkPages: cfg.pdfChunkPages, inlineMaxBytes: cfg.inlineMaxBytes }
        },
        signal: undefined
    };
}

/**
 * 以拆題模型框圖：逐塊呼叫 extract（與新管線相同），模型回了 figure_page＋figure_box 的題，以題幹相似度對到候選題。
 *
 * @param {{bytes:Buffer, pageCount:number, pdfRel:string, pdfAbs:string, sha:string, candidates:Array<object>,
 *          group:'math_physics'|'chemistry', extractRun:Function, makeCtx:Function, options?:object}} input
 *   makeCtx(group) 回 agents/extract.js 的 Ctx；切塊頁數取 ctx.config.thresholds.pdfChunkPages（與新管線相同）
 * @returns {Promise<{proposals:Array<object>, stats:{chunks:number, failedChunks:number, boxes:number, matched:number}}>}
 */
async function llmProposals({ bytes, pageCount, pdfRel, pdfAbs, sha, candidates, group, extractRun, makeCtx, options }) {
    const o = { ...layout.LAYOUT_DEFAULTS, ...(options || {}) };
    const stats = { chunks: 0, failedChunks: 0, boxes: 0, matched: 0 };
    const ctx = makeCtx(group);
    const chunkPages = ctx?.config?.thresholds?.pdfChunkPages || 20;
    const model = ctx?.config?.models?.extract || '拆題模型';
    const items = [];
    for (let from = 1; from <= pageCount; from += chunkPages) {
        const chunk = { no: Math.floor((from - 1) / chunkPages) + 1, fromPage: from, toPage: Math.min(pageCount, from + chunkPages - 1) };
        stats.chunks += 1;
        let outcome;
        try {
            outcome = await extractRun(ctx, { pdfBytes: bytes, chunk });
        } catch (err) {
            outcome = { kind: 'error', message: err.message };
        }
        if (!outcome || outcome.kind !== 'pass') { stats.failedChunks += 1; continue; }
        for (const q of outcome.data?.questions || []) {
            if (Number.isInteger(q.figure_page) && Array.isArray(q.figure_box)) items.push(q);
        }
    }
    stats.boxes = items.length;

    const best = new Map();   // 題號 → {sim, item}
    for (const q of items) {
        let top = 0;
        let hits = [];
        for (const c of candidates) {
            if (c.lowAnchor) continue;
            const sim = layout.textSimilarity(c.text, q.question_text, options);
            if (sim === null || sim < o.minCoverage) continue;
            if (sim > top + 1e-9) { top = sim; hits = [c]; } else if (Math.abs(sim - top) <= 1e-9) hits.push(c);
        }
        for (const c of hits) {
            const prev = best.get(c.id);
            if (!prev || top > prev.sim) best.set(c.id, { sim: top, item: q, cand: c });
        }
    }
    const proposals = [];
    for (const [id, { sim, item, cand }] of best) {
        stats.matched += 1;
        proposals.push({
            method: 'llm', model, id, cand, pdfRel, pdfAbs, sha, page: item.figure_page, box: item.figure_box.slice(),
            coverage: sim, layout: 'llm', ratio: 1, score: sim, figures: 1, otherPages: 0, flat: false,
            hint: cand.hint, jobIds: cand.pdfShas.includes(sha) ? cand.jobIds.slice() : [],
            sourceDetailMatch: sourceDetailMatches(cand.sourceDetail, pdfRel)
        });
    }
    return { proposals, stats };
}

// ───────────────────────── DB ─────────────────────────

/** 同 scripts/migrate_chapters.js：--test 時自建連線並檢查庫名以 _test 結尾 */
function resolveDb(useTest) {
    if (!useTest) return require('../config/db');
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('缺少 TEST_DATABASE_URL');
    if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 4 });
    return { pool, query: (text, values) => pool.query(text, values) };
}

/**
 * 候選題：question_img 是空的、不是變式題。帶上它入庫時的原卷（jobs.pdf_sha256，新管線入庫的才有）。
 * @param {{query:Function}} db
 */
async function selectCandidates(db, options) {
    const o = { ...layout.LAYOUT_DEFAULTS, ...(options || {}) };
    const { rows } = await db.query(
        `SELECT q.id, q.subject, q.chapter, q.question_text, q.source_detail,
                (q.archived_at IS NOT NULL) AS archived,
                COALESCE(array_agg(DISTINCT j.pdf_sha256::text) FILTER (WHERE j.pdf_sha256 IS NOT NULL), '{}') AS pdf_shas,
                COALESCE(array_agg(DISTINCT j.id) FILTER (WHERE j.pdf_sha256 IS NOT NULL), '{}') AS job_ids
           FROM questions q
           LEFT JOIN job_questions jq ON jq.question_id = q.id
           LEFT JOIN jobs j ON j.id = jq.job_id AND j.kind = 'pdf'
          WHERE (q.question_img IS NULL OR btrim(q.question_img) = '')
            AND q.origin <> 'variant'
          GROUP BY q.id
          ORDER BY q.id`);
    return rows.map(r => ({
        id: Number(r.id), subject: r.subject, chapter: r.chapter, text: r.question_text || '',
        sourceDetail: r.source_detail, archived: Boolean(r.archived),
        pdfShas: (r.pdf_shas || []).map(s => String(s).trim()), jobIds: (r.job_ids || []).map(Number).sort((a, b) => a - b),
        hint: layout.hasFigureHint(r.question_text),
        lowAnchor: layout.questionCjk(r.question_text).length < o.minCjk
    }));
}

// ───────────────────────── dry-run ─────────────────────────

/**
 * --dry-run：只讀 DB。有提議時把暫存圖、提議檔、預覽頁寫到 outDir（沒有提議就不建資料夾）。
 *
 * @param {{db:{query:Function}, dir:string, outDir?:string|null, write?:boolean, useLlm?:boolean,
 *          subjectGroup?:'auto'|'math_physics'|'chemistry', extractRun?:Function, makeCtx?:Function,
 *          logger?:object, options?:object}} opts
 *   extractRun／makeCtx：--use-llm 時呼叫的拆題 agent 與 Ctx 工廠（測試注入假的；預設 agents/extract.js 的 run）。
 *   useLlm=false 時**完全不載入** services/llm 與 agents/extract.js。
 */
async function dryRun({ db, dir, outDir = null, write = true, useLlm = false, subjectGroup = 'auto',
    extractRun = null, makeCtx = null, logger = console, options } = {}) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`找不到原卷資料夾：${root}`);
    if (outDir && fs.existsSync(path.join(path.resolve(outDir), CSV_NAME))) {
        throw new Error(`${path.join(path.resolve(outDir), CSV_NAME)} 已經存在；為了不蓋掉老師可能正在改的提議檔，請換一個 --out-dir`);
    }

    const candidates = await selectCandidates(db, options);
    const files = walkPdfs(root);
    const stats = {
        pdfs: files.length, unreadable: [], noTextLayer: [], candidates: candidates.length,
        lowAnchor: candidates.filter(c => c.lowAnchor).length, located: 0,
        figures: 0, assigned: 0, header: 0, unowned: 0, tieLost: 0,
        dropped: { small: 0, table: 0, inline: 0, large: 0, white: 0 },
        hintedWithoutFigure: [], cropFailed: 0,
        llm: useLlm ? { pdfs: 0, chunks: 0, failedChunks: 0, boxes: 0, matched: 0 } : null
    };

    // 第一輪：雜湊（題目當初若由資料夾裡的某份卷拆出，只在那一份找）
    const pdfs = [];
    for (const f of files) {
        try {
            pdfs.push({ abs: f, rel: path.relative(root, f), sha: sha256(fs.readFileSync(f)) });
        } catch (e) {
            stats.unreadable.push(path.relative(root, f));
        }
    }
    const folderShas = new Set(pdfs.map(p => p.sha));

    let runExtract = extractRun;
    let ctxFactory = makeCtx;
    if (useLlm) {
        runExtract = runExtract || require('../agents/extract').run;
        ctxFactory = ctxFactory || ((group) => buildExtractCtx(group, logger));
    }

    const byQuestion = new Map();
    const locatedAnywhere = new Set();
    const hintedLocated = new Set();
    const add = (p) => {
        if (!byQuestion.has(p.id)) byQuestion.set(p.id, []);
        byQuestion.get(p.id).push(p);
    };

    const { readPdfLayout } = require('../services/pdfLayout');
    for (const pdf of pdfs) {
        const bytes = fs.readFileSync(pdf.abs);
        let layoutData;
        try {
            layoutData = await readPdfLayout(bytes);
        } catch (e) {
            stats.unreadable.push(pdf.rel);
            continue;
        }
        const eligible = eligibleFor(candidates, pdf.sha, folderShas);
        const allText = layoutData.pages.map(p => p.lines.map(l => l.text).join('\n')).join('\n');
        let deterministic = { proposals: [], located: new Map() };
        const textLayer = hasTextLayer(allText);
        if (!textLayer) {
            stats.noTextLayer.push(pdf.rel);
        } else {
            deterministic = analyzeLayout({ layoutData, pdfRel: pdf.rel, pdfAbs: pdf.abs, sha: pdf.sha, candidates: eligible, options });
            for (const k of ['figures', 'assigned', 'header', 'unowned', 'tieLost']) stats[k] += deterministic.stats[k];
            for (const k of Object.keys(stats.dropped)) stats.dropped[k] += deterministic.stats.dropped[k];
            for (const [id, it] of deterministic.located) {
                locatedAnywhere.add(id);
                if (it.cand.hint) hintedLocated.add(id);
            }
            deterministic.proposals.forEach(add);
        }

        // --use-llm：只對確定性比對用不上的卷呼叫（掃描檔；或題幹提到圖、找到了題卻沒偵測到圖）
        if (useLlm) {
            const proposedHere = new Set(deterministic.proposals.map(p => p.id));
            const gaps = [...deterministic.located.values()].filter(it => it.cand.hint && !proposedHere.has(it.cand.id));
            if (!textLayer || gaps.length > 0) {
                const subjects = [...deterministic.located.values()].map(it => it.cand.subject);
                const group = subjectGroup !== 'auto' ? subjectGroup : inferSubjectGroup(subjects);
                const pool = eligible.filter(c => !proposedHere.has(c.id));
                const r = await llmProposals({
                    bytes, pageCount: layoutData.pageCount, pdfRel: pdf.rel, pdfAbs: pdf.abs, sha: pdf.sha,
                    candidates: pool, group, extractRun: runExtract, makeCtx: ctxFactory, options
                });
                stats.llm.pdfs += 1;
                for (const k of ['chunks', 'failedChunks', 'boxes', 'matched']) stats.llm[k] += r.stats[k];
                r.proposals.forEach(add);
            }
        }
    }
    stats.located = locatedAnywhere.size;

    // 每題取一個提議；確定性的優先於模型框圖（框是向量線條的精確外框），同一種再比來源與分數
    let chosen = [];
    for (const list of byQuestion.values()) {
        const det = list.filter(p => p.method === 'layout');
        chosen.push(pickBest(det.length ? det : list));
    }
    for (const id of hintedLocated) {
        if (!byQuestion.has(id)) stats.hintedWithoutFigure.push(id);
    }
    stats.hintedWithoutFigure.sort((a, b) => a - b);
    chosen.sort((a, b) => a.pdfRel.localeCompare(b.pdfRel) || (a.page - b.page)
        || ((a.rect ? a.rect[1] : a.box[0]) - (b.rect ? b.rect[1] : b.box[0])) || (a.id - b.id));

    const result = { proposals: chosen, stats, outDir: null, csvPath: null, previewPath: null };
    if (!write || chosen.length === 0) return result;

    // 裁圖 → 提議檔 → 預覽頁
    const target = outDir ? path.resolve(outDir) : defaultOutDir();
    fs.mkdirSync(target, { recursive: true });
    const { cropToFiles } = require('../services/pdfLayout');
    const byPdf = new Map();
    for (const p of chosen) {
        p.imageName = `q${p.id}.png`;
        p.image = path.join(target, p.imageName);
        if (!byPdf.has(p.pdfAbs)) byPdf.set(p.pdfAbs, []);
        byPdf.get(p.pdfAbs).push(p);
    }
    const failed = new Set();
    for (const [abs, list] of byPdf) {
        const res = await cropToFiles({
            pdfBytes: fs.readFileSync(abs),
            items: list.map(p => ({ page: p.page, file: p.image, ...(p.rect ? { rect: p.rect } : { box: p.box }) })),
            logger
        });
        res.forEach((r, i) => { if (!r.ok) failed.add(list[i].id); });
    }
    stats.cropFailed = failed.size;
    chosen = chosen.filter(p => !failed.has(p.id));
    result.proposals = chosen;
    if (chosen.length === 0) return { ...result, outDir: target };

    const rows = chosen.map(p => ({
        id: p.id, subject: p.cand.subject, chapter: p.cand.chapter, stem: stemPreview(p.cand.text, p.cand.archived),
        text: p.cand.text, pdfRel: p.pdfRel, page: p.page, image: p.image, imageName: p.imageName,
        score: p.score, basis: basisText(p)
    }));
    const csvPath = path.join(target, CSV_NAME);
    const previewPath = path.join(target, PREVIEW_NAME);
    fs.writeFileSync(csvPath, toCsv(rows), 'utf8');
    fs.writeFileSync(previewPath, renderPreview(rows, { csvPath }), 'utf8');
    return { ...result, rows, outDir: target, csvPath, previewPath };
}

// ───────────────────────── apply ─────────────────────────

/**
 * --apply：單一交易。任何驗證錯誤或例外都整批回滾（這次新放進 data/figures/ 的圖檔也刪掉）。
 *
 * @param {{db:{pool:object}, rows:Array<object>, figuresDir?:string, onRow?:Function}} opts
 *   rows 需已通過 readApplyRows 與 checkImages（帶 file、bytes、sha8）；onRow(row) 在每一列寫入後呼叫（測試用來模擬中途失敗）
 * @returns {Promise<{ok:boolean, errors:string[], applied:number, alreadyApplied:number,
 *                    hasOther:Array<{id:number, line:number, current:string}>, appliedIds:number[]}>}
 */
async function applyRows({ db, rows, figuresDir = null, onRow } = {}) {
    const result = { ok: false, errors: [], applied: 0, alreadyApplied: 0, hasOther: [], appliedIds: [] };
    if (!rows || rows.length === 0) { result.ok = true; return result; }
    const dir = figuresDir || require('../services/figureService').FIGURES_DIR;

    const client = await db.pool.connect();
    const created = [];
    try {
        await client.query('BEGIN');
        const ids = rows.map(r => r.id);
        // 與 PUT /api/questions/:id 同一把列鎖
        const { rows: current } = await client.query(
            'SELECT id, question_img FROM questions WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
        const byId = new Map(current.map(r => [Number(r.id), r]));
        for (const r of rows) {
            if (!byId.has(r.id)) result.errors.push(`第 ${r.line} 行：題號 ${r.id} 不存在`);
        }
        if (result.errors.length) {
            await client.query('ROLLBACK');
            return result;
        }

        fs.mkdirSync(dir, { recursive: true });
        for (const r of rows) {
            const cur = String(byId.get(r.id).question_img ?? '').trim();
            const url = figureUrl(r.id, r.sha8);
            const dest = path.join(dir, figureFileName(r.id, r.sha8));
            if (cur) {
                if (cur === url) {
                    result.alreadyApplied += 1;                      // 重跑同一份 CSV
                    if (!fs.existsSync(dest)) { fs.writeFileSync(dest, r.bytes); created.push(dest); }   // 圖檔被刪過就補回
                } else {
                    result.hasOther.push({ id: r.id, line: r.line, current: cur });
                }
                continue;
            }
            if (!fs.existsSync(dest)) {
                fs.writeFileSync(dest, r.bytes);
                created.push(dest);
            } else if (sha256(fs.readFileSync(dest)).slice(0, 8) !== r.sha8) {
                throw new Error(`data/figures/${path.basename(dest)} 已存在但內容不同，請先確認這個檔案`);
            }
            await client.query(
                `UPDATE questions SET question_img = $2
                  WHERE id = $1 AND (question_img IS NULL OR btrim(question_img) = '')`, [r.id, url]);
            result.applied += 1;
            result.appliedIds.push(r.id);
            if (onRow) await onRow(r);
        }
        await client.query('COMMIT');
        result.ok = true;
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        for (const f of created) { try { fs.unlinkSync(f); } catch (e) { /* 已不在 */ } }
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

function listIds(ids) {
    const shown = ids.slice(0, ERROR_LIST_MAX).map(id => `#${id}`).join('、');
    return ids.length > ERROR_LIST_MAX ? `${shown}…（共 ${ids.length} 題）` : shown;
}

function printDryRun(r, target, useLlm) {
    const s = r.stats;
    console.log(`舊題補附圖：提議（只讀資料庫${useLlm ? '；有加 --use-llm，會對部分卷呼叫拆題模型' : '、不呼叫 LLM'}）→ ${target}`);
    console.log(`原卷：${s.pdfs} 份 PDF`
        + (s.noTextLayer.length ? `（沒有文字層的掃描檔 ${s.noTextLayer.length} 份）` : '')
        + (s.unreadable.length ? `；讀不開 ${s.unreadable.length} 份：${s.unreadable.slice(0, 5).join('、')}${s.unreadable.length > 5 ? '…' : ''}` : ''));
    console.log(`候選題（題庫裡沒有附圖的題，不含變式題）：${s.candidates} 題；題幹中文字太少、無法比對 ${s.lowAnchor} 題；在原卷找到 ${s.located} 題`);
    console.log(`偵測到的圖：${s.figures} 張；對到候選題 ${s.assigned} 張；卷首裝飾 ${s.header} 張；`
        + `所在的題不是候選題（已經有圖、題庫裡沒有、或找不到題幹）${s.unowned} 張`);
    console.log(`不算圖的圖形：表格 ${s.dropped.table}、行內算式 ${s.dropped.inline}、太小（底線、分隔線）${s.dropped.small}、`
        + `整頁底圖或外框 ${s.dropped.large}`);
    if (s.llm) {
        console.log(`拆題模型：呼叫 ${s.llm.pdfs} 份卷、${s.llm.chunks} 塊（失敗 ${s.llm.failedChunks} 塊）；模型回框 ${s.llm.boxes} 張、對到候選題 ${s.llm.matched} 題`);
    }
    if (s.cropFailed > 0) console.log(`⚠ 裁圖失敗 ${s.cropFailed} 題，這次不提議（詳見上方警告）`);
    const low = r.proposals.filter(p => p.score < LOW_SCORE).length;
    console.log(`\n提議補圖：${r.proposals.length} 題${low ? `（分數低於 ${LOW_SCORE} 的 ${low} 題請特別確認）` : ''}`);
    if (s.hintedWithoutFigure.length) {
        console.log(`⚠ 題幹提到圖、原卷也找到了，卻沒有偵測到圖的題（圖可能是掃描進去的整頁、或被當成表格）：${listIds(s.hintedWithoutFigure)}`);
    }
    if (s.noTextLayer.length && !s.llm) {
        console.log(`⚠ 沒有文字層的掃描檔 ${s.noTextLayer.length} 份，確定性比對用不上：${s.noTextLayer.slice(0, 5).join('、')}${s.noTextLayer.length > 5 ? '…' : ''}`);
        console.log('  要處理這些卷可加 --use-llm，讓拆題模型框圖（會呼叫 MODEL_EXTRACT；本機模型在 CPU 上很慢）。');
    }
    if (r.csvPath) {
        console.log(`\n提議檔：${r.csvPath}`);
        console.log(`預覽頁：${r.previewPath}`);
        console.log('下一步：');
        console.log('  1. 用瀏覽器打開預覽頁，逐題看裁出來的圖是不是這一題的圖。');
        console.log('  2. 用 Excel 開啟提議檔，不要套用的題把整列刪掉（其他欄位不用改），存檔時選「CSV UTF-8（逗號分隔）」。');
        console.log(`  3. npm run figures:backfill -- --apply "${r.csvPath}"`);
    } else if (r.proposals.length === 0) {
        console.log('沒有可以提議的圖，這次不產生提議檔。');
    }
}

function printApply(r, file) {
    console.log(`\n──────── 結果（${path.basename(file)}）────────`);
    console.log(`補上附圖 ${r.applied} 題；先前已由本工具套用（同一張圖，重跑）${r.alreadyApplied} 題`);
    if (r.hasOther.length > 0) {
        console.log(`⚠ ${r.hasOther.length} 題已經有附圖（不是這份提議檔的圖），已略過（以題庫現值為準）：`);
        for (const h of r.hasOther.slice(0, ERROR_LIST_MAX)) {
            console.log(`  - 第 ${h.line} 行 題號 ${h.id}：題庫現在的附圖是 ${h.current}`);
        }
    }
    if (r.applied > 0) {
        console.log('圖檔已放進 data/figures/（檔名 backfill-<題號>-<雜湊>.png），題庫頁、複核頁與 Word 匯出會直接顯示。');
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 9).join('\n'));
        return 0;
    }

    let applyInput = null;
    if (args.mode === 'apply') {
        const file = path.resolve(args.apply);
        if (!fs.existsSync(file)) throw new Error(`找不到提議檔：${file}`);
        const { text, encoding } = decodeCsvBuffer(fs.readFileSync(file));
        const { rows, errors } = readApplyRows(text);
        const imageErrors = errors.length ? [] : await checkImages(rows, path.dirname(file));
        console.log(`讀入 ${file}（${encoding}）：${rows.length + errors.length} 列`);
        const all = errors.concat(imageErrors);
        if (all.length) {
            console.log(`❌ ${all.length} 列沒通過驗證，整批不寫入：`);
            printErrors(all);
            return 1;
        }
        applyInput = { file, rows };
    }

    const db = resolveDb(args.test);
    const target = args.test ? 'TEST_DATABASE_URL（測試庫）' : 'DATABASE_URL（開發／正式庫）';
    try {
        if (args.mode === 'dry-run') {
            const r = await dryRun({ db, dir: args.dir, outDir: args.outDir, useLlm: args.useLlm, subjectGroup: args.subjectGroup });
            printDryRun(r, target, args.useLlm);
            return 0;
        }
        console.log(`套用到 ${target}；單一交易，任何一列有問題整批不寫。`);
        const r = await applyRows({ db, rows: applyInput.rows });
        if (!r.ok) {
            console.log(`❌ ${r.errors.length} 列與題庫對不上，整批不寫入（已回滾）：`);
            printErrors(r.errors);
            return 1;
        }
        printApply(r, applyInput.file);
        return 0;
    } finally {
        await db.pool.end();
    }
}

module.exports = {
    CSV_HEADER, CSV_NAME, PREVIEW_NAME, BACKFILL_IMG, DEFAULT_OUT_ROOT,
    figureFileName, figureUrl, parseArgs, walkPdfs, defaultOutDir, resolveImagePath, lastSegment,
    toCsv, readApplyRows, checkImages, renderPreview, basisText, sourceDetailMatches, pickBest,
    eligibleFor, analyzeLayout, inferSubjectGroup, llmProposals, buildExtractCtx,
    selectCandidates, dryRun, applyRows
};

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => {
        console.error('❌ ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}
