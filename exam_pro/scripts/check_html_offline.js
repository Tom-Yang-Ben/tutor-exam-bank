// ─────────────────────────────────────────────────────────────
// scripts/check_html_offline.js — public/ 不得引用外部資源（本機模式 L3，docs/local-mode.md 第 5 條第 3 點）
//
// 本機模式的原則是「執行期零外連」（第 1 條第 1 點）：網頁本身也不能去抓 CDN、Google Fonts。
// 這支掃 public/ 底下所有 HTML／JS／CSS（含 .htm、.mjs、.svg），找出任何外部網址。
//
// 規則（寫死、刻意嚴格）：
//   1. 任何 http://、https://、ws://、wss://、ftp:// 開頭的網址都算違規——不分它出現在 src、href、
//      url()、@import、fetch() 還是一般字串裡。只要寫在程式或標記裡，就有可能被載入。
//   2. 協定相對網址（//cdn.example/x.js）出現在會載入資源的位置也算違規：
//      src／href／srcset／action／poster／data 屬性、CSS 的 url() 與 @import、JS 的 import … from 與 import()。
//   3. 例外只有兩種：
//      a. **註解**裡的網址（說明文字）：HTML 的 <!-- -->、CSS 的 /* */、JS 的 // 與 /* */
//         （含 HTML 裡 inline <script> 與 <style> 的註解）。JS 的註解用一個小型詞法掃描判斷，
//         字串、樣板字串（含 ${…}）、正規表示式裡的 // 都不會被當成註解——
//         'https://cdn…' 這種字串一定會被抓到，不會因為裡面有 // 就被誤判成註解而漏掉。
//      b. XML 命名空間識別字（ALLOWED_NAMESPACES）：createElementNS('http://www.w3.org/2000/svg', …)
//         這類字串只是名字，瀏覽器不會去連。清單以外的 w3.org 網址照樣違規。
//   畫面上若真的需要一個外部說明連結（<a href="https://…">），不要放寬規則：先問為什麼要在本機模式放外連。
//
// 用法：node scripts/check_html_offline.js（有違規時結束碼 1）。
// npm test 經 test/unit/publicOffline.test.js 執行同一套檢查（package.json 的 scripts 歸 L4，本檔不另加指令）。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/** 要掃的副檔名（public/ 底下其他檔案——圖片、字型——本身不會再去引用別的資源） */
const SCANNED_EXT = ['.html', '.htm', '.js', '.mjs', '.css', '.svg'];

/** 允許出現的網址：只有 XML 命名空間識別字（逐字比對整個網址） */
const ALLOWED_NAMESPACES = [
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/1999/xlink',
    'http://www.w3.org/1999/xhtml',
    'http://www.w3.org/1998/Math/MathML',
    'http://www.w3.org/XML/1998/namespace'
];

/** 把字串裡除了換行以外的字元都換成空白：挖掉註解但保留行列位置，回報才指得到原檔 */
function blank(s) {
    return s.replace(/[^\n]/g, ' ');
}

/** HTML 註解 → 空白 */
function blankHtmlComments(html) {
    return html.replace(/<!--[\s\S]*?-->/g, blank);
}

/** CSS 註解 → 空白（CSS 字串裡出現 /* 的情況不處理：public/ 沒有，也不值得為它寫詞法） */
function blankCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, blank);
}

// 這些關鍵字後面的 / 是正規表示式的開頭，不是除號
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * JS 註解 → 空白；字串、樣板字串、正規表示式原樣保留。
 *
 * 小型詞法掃描（不是完整 parser）：
 *   - '…'、"…"：到同一個引號或換行為止，反斜線跳脫下一個字元
 *   - `…`：樣板字串；遇到 ${ 就進入程式碼模式，對應的 } 再回到樣板（可巢狀）
 *   - /：前一個有意義的記號是運算子、左括號、逗號、關鍵字或檔頭時視為正規表示式（含 [...] 字元類別），
 *        否則是除號
 * 判斷失準的後果只會是「多抓」（註解被當成程式碼而報錯，看得到），不會是「漏抓」字串裡的網址：
 * 只有明確進入 // 或 /* 狀態的文字才會被挖掉。
 * @param {string} src
 * @returns {string} 與 src 等長、換行位置相同
 */
function blankJsComments(src) {
    const out = [];
    const n = src.length;
    // 模式堆疊：code（記錄大括號深度，才知道哪個 } 是 ${…} 的結尾）或 template
    const stack = [{ mode: 'code', depth: 0 }];
    let prev = '';        // 前一個有意義的記號：單一標點、'id'、'str'、'regex'；檔頭是 ''
    let i = 0;
    while (i < n) {
        const top = stack[stack.length - 1];
        const c = src[i];
        if (top.mode === 'template') {
            if (c === '\\') { out.push(src.slice(i, i + 2)); i += 2; continue; }
            if (c === '`') { out.push(c); i++; stack.pop(); prev = 'str'; continue; }
            if (c === '$' && src[i + 1] === '{') { out.push('${'); i += 2; stack.push({ mode: 'code', depth: 0 }); prev = '{'; continue; }
            out.push(c); i++; continue;
        }
        const d = src[i + 1];
        if (c === '/' && d === '/') {
            let j = src.indexOf('\n', i);
            if (j === -1) j = n;
            out.push(blank(src.slice(i, j))); i = j; continue;
        }
        if (c === '/' && d === '*') {
            let j = src.indexOf('*/', i + 2);
            j = j === -1 ? n : j + 2;
            out.push(blank(src.slice(i, j))); i = j; continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
            j = Math.min(j + 1, n);
            out.push(src.slice(i, j)); i = j; prev = 'str'; continue;
        }
        if (c === '`') { out.push(c); i++; stack.push({ mode: 'template' }); continue; }
        if (c === '{') { top.depth++; out.push(c); i++; prev = '{'; continue; }
        if (c === '}') {
            out.push(c); i++;
            if (top.depth === 0 && stack.length > 1) { stack.pop(); continue; }   // ${…} 結束，回到樣板字串
            top.depth--; prev = '}'; continue;
        }
        if (c === '/' && (prev === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev))) {
            let j = i + 1;
            let inClass = false;
            while (j < n && src[j] !== '\n') {
                const ch = src[j];
                if (ch === '\\') { j += 2; continue; }
                if (inClass) { if (ch === ']') inClass = false; }
                else if (ch === '[') inClass = true;
                else if (ch === '/') break;
                j++;
            }
            j = Math.min(j + 1, n);
            while (j < n && /[a-z]/i.test(src[j])) j++;
            out.push(src.slice(i, j)); i = j; prev = 'regex'; continue;
        }
        if (/\s/.test(c)) { out.push(c); i++; continue; }
        if (/[A-Za-z0-9_$]/.test(c)) {
            let j = i;
            while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
            const word = src.slice(i, j);
            out.push(word); i = j;
            prev = REGEX_AFTER_WORD.has(word) ? '(' : 'id';
            continue;
        }
        out.push(c); i++; prev = c;
    }
    return out.join('');
}

/**
 * HTML：先挖 HTML 註解，再挖 inline <script>（沒有 src 的）與 <style> 裡的註解。
 * <script type="application/json"> 之類非 JS 的區塊不挖（原樣掃）。
 */
function blankHtmlAllComments(html) {
    let s = blankHtmlComments(html);
    s = s.replace(/(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi, (m, open, attrs, body, close) => {
        const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
        const isJs = !type || /^(module|text\/javascript|application\/javascript)$/i.test(type);
        return open + (isJs ? blankJsComments(body) : body) + close;
    });
    s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, body, close) => open + blankCssComments(body) + close);
    return s;
}

/** 依副檔名挖掉註解 */
function stripComments(ext, text) {
    if (ext === '.html' || ext === '.htm' || ext === '.svg') return blankHtmlAllComments(text);
    if (ext === '.css') return blankCssComments(text);
    return blankJsComments(text);
}

const ABSOLUTE_URL = /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>()\\]*/gi;
const PROTOCOL_RELATIVE = [
    /\b(?:src|href|srcset|action|poster|data)\s*=\s*["']?\s*\/\/[^\s'"`<>]*/gi,
    /\burl\(\s*["']?\s*\/\/[^\s'"`)]*/gi,
    /@import\s+(?:url\(\s*)?["']?\s*\/\/[^\s'"`)]*/gi,
    /\bfrom\s*["']\/\/[^'"]*/g,
    /\bimport\s*\(\s*["']\/\/[^'"]*/g
];

/**
 * 在已經挖掉註解的文字裡找外部網址。
 * 同一個網址被兩條規則抓到（例如 @import url("//…") 同時符合 url() 與 @import）只算一次：以網址起點去重。
 * @param {string} text
 * @returns {Array<{index:number, url:string}>} index＝網址（協定或 //）在 text 裡的起點
 */
function findExternalUrls(text) {
    const hits = new Map();
    for (const m of text.matchAll(ABSOLUTE_URL)) {
        if (ALLOWED_NAMESPACES.includes(m[0])) continue;
        hits.set(m.index, m[0]);
    }
    for (const re of PROTOCOL_RELATIVE) {
        for (const m of text.matchAll(re)) {
            const at = m.index + m[0].indexOf('//');
            if (!hits.has(at)) hits.set(at, m[0].slice(at - m.index));
        }
    }
    return [...hits].map(([index, url]) => ({ index, url })).sort((a, b) => a.index - b.index);
}

/**
 * 掃一個檔案的內容。
 * @param {string} label 回報用的名字，例如 public/index.html
 * @param {string} text
 * @returns {string[]} 問題清單（「label:行:欄 網址」）
 */
function checkText(label, text) {
    const ext = path.extname(label).toLowerCase();
    const stripped = stripComments(ext, text);
    return findExternalUrls(stripped).map(({ index, url }) => {
        const before = stripped.slice(0, index);
        const line = before.split('\n').length;
        const col = index - before.lastIndexOf('\n');
        return `${label}:${line}:${col} ${url.trim()}`;
    });
}

/** public/ 底下要掃的檔案（遞迴、排序） */
function listPublicFiles(dir = PUBLIC_DIR) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listPublicFiles(abs));
        else if (SCANNED_EXT.includes(path.extname(entry.name).toLowerCase())) out.push(abs);
    }
    return out;
}

/**
 * 掃整個 public/。
 * @returns {{files:string[], problems:string[]}} files 為相對 exam_pro 的路徑
 */
function checkPublicOffline() {
    const files = [];
    const problems = [];
    if (!fs.existsSync(PUBLIC_DIR)) return { files, problems: [`找不到 ${PUBLIC_DIR}`] };
    for (const abs of listPublicFiles()) {
        const label = path.relative(ROOT, abs).split(path.sep).join('/');
        files.push(label);
        problems.push(...checkText(label, fs.readFileSync(abs, 'utf8')));
    }
    return { files, problems };
}

/**
 * HTML 會自動載入的本機資源（<script src>、<link href>、<img src>…），給「每一個都要回 200」的測試用。
 * 註解裡的不算；#錨點與 <a href> 導覽不算（不會自動載入）。
 * @param {string} html
 * @returns {string[]} 以 / 開頭的路徑（去重、保留順序）
 */
function localResourceRefs(html) {
    const s = blankHtmlComments(html);
    const out = [];
    const re = /<(script|link|img|source|iframe|video|audio)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    for (const m of s.matchAll(re)) {
        const ref = m[2].trim();
        if (ref.startsWith('/') && !ref.startsWith('//') && !out.includes(ref)) out.push(ref);
    }
    return out;
}

function main() {
    const { files, problems } = checkPublicOffline();
    console.log(`掃了 ${files.length} 個檔案：${files.join('、')}`);
    if (problems.length === 0) {
        console.log('✅ public/ 沒有外部資源網址（本機模式 L3，docs/local-mode.md 第 5 條第 3 點）。');
        return;
    }
    console.error(`\n❌ 發現 ${problems.length} 個外部網址（本機模式執行期不得連外，改從 /vendor/… 本機供應）：\n\n  ${problems.join('\n  ')}`);
    process.exit(1);
}

if (require.main === module) main();

module.exports = {
    checkPublicOffline, checkText, findExternalUrls, localResourceRefs, listPublicFiles,
    blankHtmlComments, blankCssComments, blankJsComments, blankHtmlAllComments,
    ALLOWED_NAMESPACES, SCANNED_EXT, PUBLIC_DIR
};
