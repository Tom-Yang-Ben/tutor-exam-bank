// ─────────────────────────────────────────────────────────────
// eval/fixtures/make_sample_pdf.js — 產生自製的公開考卷 eval/fixtures/sample_exam.pdf
//
// **只在本機跑，不在 CI 路徑上**（規劃 §5.3.1）。產物一次產好、commit 進 repo，
// 之後 E-X12a 的 --method legacy／pipeline 與 A-T14 的 --suite pipeline 都拿它當輸入。
//
// 用法（PowerShell 或 cmd 皆可）：
//   node eval/fixtures/make_sample_pdf.js
//   node eval/fixtures/make_sample_pdf.js --font "C:\\Windows\\Fonts\\NotoSansTC-VF.ttf"
//   node eval/fixtures/make_sample_pdf.js --out eval/local/sample_exam.pdf --check
//   node eval/fixtures/make_sample_pdf.js --check      只驗證現有檔案的 sha256 與本次產物一致
//
// 三個「必須」，每一個都有實際會出錯的理由：
//
//   1. **內容只能來自 eval/fixtures/questions.public.json**（作者自製，NOTICE 第 2 條）。
//      這份 PDF 會被送進 Gemini 錄成 cassette 並進版控，裡面出現的每一個字都會外流。
//
//   2. **輸出必須逐位元可重現**。pdfkit 預設會寫入 info.CreationDate = 現在時間、
//      並產生一組隨機的 file ID，兩者都會讓 sha256 每次不同——那樣 cassette 的
//      cacheKeyParts.pdfSha256（interfaces-stage2.md 第 5.2 條）每次重產都失效。
//      因此這裡把 CreationDate／ModDate 釘在一個固定時間，並關掉 pdfkit 的隨機 ID。
//
//   3. **字型要能嵌入中文，而且授權允許散布**。Windows 內建的 NotoSansTC-VF.ttf 是
//      SIL Open Font License 1.1；標楷體（kaiu.ttf）與微軟正黑體（msjh.ttc）不是，
//      不可拿來嵌進要進版控的檔案。找不到 Noto 時本腳本**直接失敗**，不悄悄換字型。
//
// 已知限制（實測，2026-08-22）：NotoSansTC-VF.ttf 是**可變字型**，它的預設實例是 Thin（wght=100）。
//   pdfkit 的 registerFont(name, src, 'Regular') 這條路在子集化時會丟
//   `First argument to DataView constructor must be an ArrayBuffer`——fontkit 目前無法對
//   可變字型的具名實例做 subset。因此本卷嵌的是 **Thin 字重**，字劃偏細但可讀。
//   若日後換成靜態的 NotoSansTC-Regular.otf（用 --font 指定），字重會變好看，
//   但 **sha256 一定會變**，屆時必須重錄 extract 的 cassette（第 5.2 條的 pdfSha256 在鍵裡）。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PDFDocument = require('pdfkit');

// 路徑含中文（C:\Users\...\期中專案-wsD）：一律先 path.resolve 再用，
// 且所有文字 I/O 明寫 utf8（硬規則 6）。
const EVAL_DIR = path.resolve(__dirname, '..');
const FIXTURE = path.join(EVAL_DIR, 'fixtures', 'questions.public.json');
const DEFAULT_OUT = path.join(EVAL_DIR, 'fixtures', 'sample_exam.pdf');

// 固定時間戳：2026-01-01T00:00:00Z。挑一個與專案任何事件無關的整點，
// 純粹是為了「這個數字不會讓人以為它有意義」。
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

// OFL 授權、可嵌入散布的繁中字型候選（依序找第一個存在的）。
const FONT_CANDIDATES = [
    'C:\\Windows\\Fonts\\NotoSansTC-VF.ttf',
    'C:\\Windows\\Fonts\\NotoSansTC-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJKtc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansTC-Regular.ttf'
];

// 選進考卷的題目（fixture id）。刻意涵蓋：
//   兩個科目、四個章節、四種題型（單選／多選／填空／計算），
//   以及兩題 latex_broken=true 的壞公式（#8 missing_rbrace、#38 bare_script）——
//   pipeline suite 的 lint 節點要有東西可以擋，才量得到「規則修好／LLM 才修好／修不好」三段比例。
const PICKED = [1, 9, 13, 25, 32, 42, 47, 8, 38, 46];

/**
 * @param {string[]} argv
 * @returns {{out:string, font:string|null, check:boolean, help:boolean}}
 */
function parseArgs(argv) {
    const args = { out: DEFAULT_OUT, font: null, check: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--out': args.out = path.resolve(argv[++i]); break;
            case '--font': args.font = path.resolve(argv[++i]); break;
            case '--check': args.check = true; break;
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${argv[i]}」，可用：--out --font --check`);
        }
    }
    return args;
}

/**
 * 找一支可嵌入、授權允許散布的繁中字型。
 * @param {string|null} explicit --font 指定的路徑
 * @returns {string}
 * @throws 找不到時丟錯（不退回英文字型——中文會變成空白方框，而 PDF 看起來還是「產出來了」）
 */
function resolveFont(explicit) {
    if (explicit) {
        if (!fs.existsSync(explicit)) throw new Error(`--font 指定的字型不存在：${explicit}`);
        return explicit;
    }
    for (const candidate of FONT_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
        '找不到可嵌入的繁體中文字型（試過：\n  - ' + FONT_CANDIDATES.join('\n  - ') + '\n）。\n' +
        '請用 --font 指定一支**授權允許嵌入散布**的字型（建議 Noto Sans TC，SIL OFL 1.1）。\n' +
        '注意：標楷體 kaiu.ttf 與微軟正黑體 msjh.ttc 不可嵌進要進版控的檔案。'
    );
}

/**
 * 把題幹裡的 LaTeX 轉成「考卷上看得懂的樣子」。
 *
 * 這不是渲染器，是**刻意的降級**：真實考卷是排版好的數學式，PDF 裡沒有 `$…$` 這種東西。
 * 若把 `$\frac{1}{2}$` 原樣印上去，拆題模型只要照抄就贏了——那量到的不是它的能力。
 * 因此這裡把最常見的幾個指令換成 Unicode，其餘去掉 `$` 與反斜線指令的大括號。
 *
 * @param {string} latex
 * @returns {string}
 */
function toPlainMath(latex) {
    let s = latex;
    s = s.replace(/\$/g, '');
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
    s = s.replace(/\\vec\{([^{}]*)\}/g, '$1→');
    s = s.replace(/\\text\{([^{}]*)\}/g, '$1');
    s = s.replace(/\\mathrm\{([^{}]*)\}/g, '$1');
    const SYMBOLS = {
        '\\times': '×', '\\div': '÷', '\\leq': '≤', '\\geq': '≥', '\\neq': '≠',
        '\\pm': '±', '\\cdot': '·', '\\circ': '°', '\\theta': 'θ', '\\alpha': 'α',
        '\\beta': 'β', '\\mu': 'μ', '\\pi': 'π', '\\infty': '∞', '\\approx': '≈',
        '\\sin': 'sin', '\\cos': 'cos', '\\tan': 'tan', '\\log': 'log', '\\sum': 'Σ', '\\int': '∫'
    };
    for (const [cmd, sym] of Object.entries(SYMBOLS)) {
        s = s.split(cmd).join(sym);
    }
    s = s.replace(/\^\{([^{}]*)\}/g, '^$1');
    s = s.replace(/_\{([^{}]*)\}/g, '_$1');
    s = s.replace(/\\([a-zA-Z]+)/g, '$1');   // 沒對應到的指令：去掉反斜線，留名字
    s = s.replace(/[{}]/g, '');
    return s;
}

/**
 * 產生 PDF 的 Buffer。
 * @param {object} opts
 * @param {Array<object>} opts.questions fixture 題（已依 PICKED 挑好）
 * @param {string} opts.fontPath
 * @returns {Promise<Buffer>}
 */
function buildPdf({ questions, fontPath }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 60, bottom: 60, left: 56, right: 56 },
            // 關掉 pdfkit 預設塞進 info 的建立時間；下面再手動釘死。
            info: {
                Title: '評估用自製考卷（sample_exam）',
                Author: 'tutor-exam-bank eval fixture',
                Subject: '本卷 10 題全部取自 eval/fixtures/questions.public.json，由專案作者自行編寫，非任何考卷、題本或出版品',
                Keywords: 'eval fixture public sample',
                CreationDate: FIXED_DATE,
                ModDate: FIXED_DATE
            }
        });

        // 逐位元可重現的兩個關鍵：
        //   (a) 固定 file ID——pdfkit 預設用亂數，同樣的內容每次 sha256 都不同。
        //   (b) 固定 CreationDate／ModDate（上面 info 已設）。
        doc._id = Buffer.from('4556414C53414D504C45504446303031', 'hex');   // 'EVALSAMPLEPDF001'

        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // 只用兩個參數：第三個參數（具名實例）在可變字型上會讓 fontkit 的 subset 失敗，見檔頭「已知限制」。
        doc.registerFont('tc', fontPath);
        doc.font('tc');

        doc.fontSize(18).text('高中數學・物理 綜合練習卷（評估用自製樣卷）', { align: 'center' });
        doc.moveDown(0.4);
        doc.fontSize(9).text(
            '本卷 10 題全部由本專案作者自行編寫，用於展示與評估系統流程，不取自任何特定考卷、題本或出版品。',
            { align: 'center' }
        );
        doc.moveDown(1.2);

        questions.forEach((q, i) => {
            const no = i + 1;
            doc.fontSize(12).text(`${no}. （${q.subject}・${q.question_type}）`, { continued: false });
            doc.moveDown(0.15);
            doc.fontSize(12).text(toPlainMath(q.question_text), { indent: 14, lineGap: 3 });
            doc.moveDown(0.9);
        });

        doc.end();
    });
}

/** @param {Buffer} buf @returns {string} */
function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('用法：node eval/fixtures/make_sample_pdf.js [--out <path>] [--font <ttf>] [--check]');
        return;
    }

    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const byId = new Map(fixture.questions.map(q => [q.id, q]));
    const missing = PICKED.filter(id => !byId.has(id));
    if (missing.length) throw new Error(`fixture 沒有這些 id：${missing.join(', ')}`);
    const questions = PICKED.map(id => byId.get(id));

    const fontPath = resolveFont(args.font);
    const buf = await buildPdf({ questions, fontPath });
    const hash = sha256(buf);

    if (args.check) {
        if (!fs.existsSync(args.out)) throw new Error(`--check：${args.out} 不存在，先不帶 --check 產一次`);
        const existing = sha256(fs.readFileSync(args.out));
        if (existing !== hash) {
            throw new Error(
                `--check 失敗：現有檔案的 sha256 與本次產物不同。\n` +
                `  現有：${existing}\n  本次：${hash}\n` +
                `  多半代表換了字型（本次用 ${fontPath}）或 pdfkit 版本變了。\n` +
                `  cassette 的 cacheKeyParts.pdfSha256 會因此失效，要重錄 extract 的 cassette。`
            );
        }
        console.log(`✅ --check 通過：sha256 = ${hash}`);
        return;
    }

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, buf);
    console.log(`已寫入 ${args.out}`);
    console.log(`  題數：${questions.length}（fixture id：${PICKED.join(', ')}）`);
    console.log(`  字型：${fontPath}`);
    console.log('  字重：可變字型的預設實例（NotoSansTC 的預設是 Thin，見檔頭「已知限制」）');
    console.log(`  大小：${buf.length} bytes`);
    console.log(`  sha256：${hash}`);
    console.log('');
    console.log('⚠️ 根目錄 .gitignore 有一條 `*.pdf`，本檔要進版控必須：');
    console.log('   (a) 由 S0 在 .gitignore 加一行 `!exam_pro/eval/fixtures/sample_exam.pdf`（建議），或');
    console.log('   (b) 用 `git add -f exam_pro/eval/fixtures/sample_exam.pdf`（已追蹤後 .gitignore 就不再作用）。');
}

if (require.main === module) {
    main().catch(err => { console.error(`\n❌ ${err.message}`); process.exit(1); });
}

module.exports = { toPlainMath, PICKED, FIXED_DATE, resolveFont, buildPdf, sha256 };
