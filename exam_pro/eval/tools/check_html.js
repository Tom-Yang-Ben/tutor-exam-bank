// ─────────────────────────────────────────────────────────────
// eval/tools/check_html.js — `npm run check:html`（A-T13）
//
// 對 public/*.html 的每一段 inline <script> 與 public/js/*.js 做語法檢查（`node --check`）。
//
// 為什麼需要這一支：`public/index.html` 有一段一千多行的 inline script，
// 它**不在任何測試的路徑上**——`npm test` 只跑 test/unit/，整合測試打的是 API。
// 少一個右大括號，唯一的症狀是打開瀏覽器之後整頁沒有反應，而 CI 全綠。
// 這支腳本補的就是那個洞：它不驗行為，只驗「這段程式碼 parse 得過」。
//
// 兩種 parse 模式要分開：
//   inline <script>（沒有 type="module"）→ 腳本模式，寫成暫存 .js 後 `node --check`
//   <script type="module"> 與 public/js/*.js → 模組模式，寫成暫存 .mjs 後 `node --check`
// 混用會誤判：`export` 在腳本模式是語法錯誤，`await` 在頂層則相反。
//
// 位置說明：本檔放在 eval/tools/ 是所有權的結果——WS-D 在階段 2 擁有 eval/**、test/**、
// public/index.html、public/js/review.js 與 package.json 的 scripts，但**不擁有 scripts/**。
// 放這裡不需要動別人的目錄。對應的單元測試在 test/unit/publicAssets.test.js。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * 把 HTML 註解挖空，但**保留原有的換行數**。
 *
 * 不先挖掉註解就會踩到一個很煩的雷：註解裡只要出現 `<script …>` 這串字
 * （例如「index.html 只插一個 section 與一行 <script type="module">」這種說明文字），
 * 底下的 extractInlineScripts 就會把註解本身當成一段程式碼送去 parse，
 * 然後報一個位置與內容都對不上的語法錯誤。實際發生過。
 *
 * 用等量的換行填回去，是為了讓回報的行號仍然指得到原始檔案的正確位置。
 * @param {string} html
 * @returns {string}
 */
function stripHtmlComments(html) {
    return html.replace(/<!--[\s\S]*?-->/g, m => '\n'.repeat((m.match(/\n/g) || []).length));
}

/**
 * 從 HTML 抽出所有 <script> 區塊。
 *
 * 只抽「沒有 src 的」——有 src 的是外部檔案（CDN 或 public/js/*.js），
 * 前者不歸我們管，後者會被本腳本另外單獨檢查。
 *
 * @param {string} rawHtml
 * @returns {Array<{code:string, isModule:boolean, line:number}>} line = 該區塊在檔案中的起始行（1-based）
 */
function extractInlineScripts(rawHtml) {
    const html = stripHtmlComments(rawHtml);
    const out = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = m[1] || '';
        if (/\bsrc\s*=/.test(attrs)) continue;
        const code = m[2];
        if (code.trim() === '') continue;
        const line = html.slice(0, m.index).split('\n').length;
        out.push({ code, isModule: /\btype\s*=\s*["']module["']/i.test(attrs), line });
    }
    return out;
}

/**
 * 用 `node --check` 檢查一段程式碼。
 * @param {string} code
 * @param {boolean} isModule
 * @param {string} label 錯誤訊息裡顯示的名字
 * @returns {{ok:boolean, message:string}}
 */
function checkSyntax(code, isModule, label) {
    // node --check 只吃檔案路徑，且靠副檔名決定 script／module，所以要落地成暫存檔。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkhtml-'));
    const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.${isModule ? 'mjs' : 'js'}`);
    try {
        // Node ≥ 22.7 預設開啟「模組語法偵測」：沒有 package.json 的目錄裡，含 export 的 .js
        // 會被當成 ESM 而通過 --check（Linux CI 上就是這樣）。放一個 type=commonjs 的 package.json
        // 把腳本模式釘死，script／module 兩種判定才在所有平台一致。
        fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
        fs.writeFileSync(file, code, 'utf8');
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        return { ok: true, message: '' };
    } catch (err) {
        const stderr = (err.stderr && err.stderr.toString('utf8')) || err.message;
        // 暫存檔名對讀的人沒有意義，換成呼叫端給的 label
        return { ok: false, message: stderr.split('\n').slice(0, 8).join('\n').replace(new RegExp(file.replace(/\\/g, '\\\\'), 'g'), label) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 檢查 public/ 底下所有 HTML 的 inline script 與 public/js/*.js。
 * @returns {{checked:number, problems:string[], files:string[]}}
 */
function checkAll() {
    const problems = [];
    const files = [];
    let checked = 0;

    if (!fs.existsSync(PUBLIC_DIR)) return { checked, problems: [`找不到 ${PUBLIC_DIR}`], files };

    for (const name of fs.readdirSync(PUBLIC_DIR).sort()) {
        if (!name.toLowerCase().endsWith('.html')) continue;
        const abs = path.join(PUBLIC_DIR, name);
        files.push(`public/${name}`);
        const html = fs.readFileSync(abs, 'utf8');
        const blocks = extractInlineScripts(html);
        blocks.forEach((b, i) => {
            checked++;
            const label = `public/${name} 的第 ${i + 1} 段 inline script（第 ${b.line} 行起，${b.isModule ? 'module' : 'script'}）`;
            const res = checkSyntax(b.code, b.isModule, label);
            if (!res.ok) problems.push(`${label}：\n${res.message}`);
        });
    }

    const jsDir = path.join(PUBLIC_DIR, 'js');
    if (fs.existsSync(jsDir)) {
        for (const name of fs.readdirSync(jsDir).sort()) {
            if (!name.toLowerCase().endsWith('.js')) continue;
            const abs = path.join(jsDir, name);
            files.push(`public/js/${name}`);
            checked++;
            const code = fs.readFileSync(abs, 'utf8');
            // public/js/*.js 一律以 module 檢查：第 8 條規定 review.js 是 ES module，
            // 之後新加的檔案也應該是。用 script 模式檢查會讓 import/export 全部誤報。
            const res = checkSyntax(code, true, `public/js/${name}`);
            if (!res.ok) problems.push(`public/js/${name}：\n${res.message}`);
        }
    }

    return { checked, problems, files };
}

// 階段 3 的三個新分頁（interfaces-stage3.md 第 7.2、7.4 條）。
// 三者是同一組東西：一個 <meta> 旗標注入點、一個空 <section> 錨點、一行 <script type="module">。
// 少任何一個，那一頁就是「靜靜地不出現」——沒有語法錯誤、沒有 console 訊息、CI 全綠。
const STAGE3_PAGES = [
    { id: 'students', meta: 'feature-students', placeholder: '__FEATURE_STUDENTS__' },
    { id: 'nlq', meta: 'feature-nlq', placeholder: '__FEATURE_NLQ__' },
    { id: 'variants', meta: 'feature-variants', placeholder: '__FEATURE_VARIANTS__' }
];

// 第 7.1 條凍結的 window.ExamApp 鍵：階段 2 的五個 + 階段 3 的五個。
const BRIDGE_KEYS = [
    'apiFetch', 'showToast', 'renderMath', 'escapeHtml', 'createQuestionEditor',
    'getPaperCache', 'setPaperCache', 'getChapters', 'getChapterWhitelist', 'showSection'
];

/**
 * 額外的結構檢查：確認第 8 條（階段 2）與第 7 條（階段 3）要求的接點都還在。
 *
 * 這比語法檢查更容易在改版時壞掉——刪掉一行 <script type="module"> 不會有任何語法錯誤，
 * 只是那一個分頁從此不再載入，而且沒有人會發現。
 * @returns {string[]} 問題清單
 */
function checkContracts() {
    const problems = [];
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) return ['找不到 public/index.html'];
    const html = fs.readFileSync(indexPath, 'utf8');

    if (!/<section\s+id=["']review["']/.test(html)) {
        problems.push('public/index.html 少了 <section id="review">（interfaces-stage2.md 第 8 條）');
    }
    if (!/<script\s+type=["']module["']\s+src=["']\/js\/review\.js["']/.test(html)) {
        problems.push('public/index.html 少了 <script type="module" src="/js/review.js">（第 8 條）');
    }
    if (!/window\.ExamApp\s*=/.test(html)) {
        problems.push('public/index.html 沒有把五個既有函式掛上 window.ExamApp（第 8 條的橋接）');
    }
    const bridge = html.match(/window\.ExamApp\s*=\s*Object\.assign\([\s\S]*?\n\s*\}\);/);
    for (const fn of BRIDGE_KEYS) {
        if (bridge && !bridge[0].includes(fn)) {
            problems.push(`window.ExamApp 的橋接少了 ${fn}（interfaces-stage2.md 第 8 條五個 + interfaces-stage3.md 第 7.1 條五個）`);
        }
    }

    // ── 階段 3 的三個分頁（第 7.2、7.4 條）──
    //
    // 這裡刻意用**字面比對**而不是 regex：三個接點的寫法在第 7.2 條裡是逐字給定的，
    // 用 regex 去容忍單雙引號只會讓「差一個字」的錯誤悄悄通過，而那正是要擋的東西。
    for (const page of STAGE3_PAGES) {
        if (!html.includes(`<meta name="${page.meta}"`)) {
            problems.push(`public/index.html 少了 <meta name="${page.meta}">（interfaces-stage3.md 第 7.2 條第 1 列）`);
        } else if (!html.includes(`<meta name="${page.meta}" content="${page.placeholder}">`)) {
            // 佔位字串被改成別的東西＝旗標從此不可能由後端控制（app.js 的 replaceAll 換不到）。
            problems.push(`<meta name="${page.meta}"> 的 content 不是佔位字串 ${page.placeholder}（第 7.3 條的 replaceAll 對象）`);
        }
        if (!html.includes(`<section id="${page.id}">`)) {
            problems.push(`public/index.html 少了 <section id="${page.id}">（第 7.2 條第 3 列）`);
        }
        if (!html.includes(`<script type="module" src="/js/${page.id}.js">`)) {
            problems.push(`public/index.html 少了 <script type="module" src="/js/${page.id}.js">（第 7.2 條第 4 列）`);
        }
        const jsPath = path.join(PUBLIC_DIR, 'js', `${page.id}.js`);
        if (!fs.existsSync(jsPath)) {
            problems.push(`找不到 public/js/${page.id}.js（第 7.2 條第 4 列的 module 指向一個不存在的檔）`);
            continue;
        }
        const js = fs.readFileSync(jsPath, 'utf8');
        // 旗標不得寫死（第 7.2 條），且必須從 index.html 的注入點讀。
        if (!js.includes(`meta[name="${page.meta}"]`)) {
            problems.push(`public/js/${page.id}.js 沒有從 <meta name="${page.meta}"> 讀旗標（第 7.2 條）`);
        }
        // parseBool 的規則必須與 config/features.js 逐字相同（第 7.2 條）。
        if (!js.includes("v === '1' || v === 'true'")) {
            problems.push(`public/js/${page.id}.js 的 parseBool 與 config/features.js 的規則不一致（第 7.2 條要求逐字相同）`);
        }
        // 旗標關閉時必須**整段不渲染**（第 7.2 條：不得只是隱藏）。
        if (!js.includes('整段不渲染')) {
            problems.push(`public/js/${page.id}.js 沒有「旗標關閉＝整段不渲染」的處理（第 7.2 條）`);
        }
    }
    // 導覽列的「學生」（第 7.2 條第 2 列）
    if (!html.includes('<a href="#students"')) {
        problems.push('public/index.html 的導覽列少了 <a href="#students">學生</a>（第 7.2 條第 2 列）');
    }
    // 組卷結果區的 paper_id（第 7.2 條第 5 列）：沒有它，「立即批改」跳不到任何一張卷。
    if (!html.includes('paper_id: result.paper_id')) {
        problems.push('public/index.html 的 currentPaperCache 沒有多存 paper_id（第 7.2 條第 5 列）');
    }
    return problems;
}

function main() {
    const { checked, problems, files } = checkAll();
    const contractProblems = checkContracts();
    const all = [...problems, ...contractProblems];

    console.log(`檢查了 ${checked} 段程式碼，來自：${files.join('、')}`);
    if (all.length === 0) {
        console.log('✅ 全部通過（語法 + 階段 2 第 8 條與階段 3 第 7 條的接點）。');
        return;
    }
    console.error(`\n❌ 發現 ${all.length} 個問題：\n\n${all.join('\n\n')}`);
    process.exit(1);
}

if (require.main === module) main();

module.exports = { checkAll, checkContracts, extractInlineScripts, stripHtmlComments, checkSyntax, PUBLIC_DIR, STAGE3_PAGES, BRIDGE_KEYS };
