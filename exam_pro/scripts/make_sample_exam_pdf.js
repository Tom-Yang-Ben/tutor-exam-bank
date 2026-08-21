// scripts/make_sample_exam_pdf.js — 產生公開的自製考卷 eval/fixtures/sample_exam.pdf（WS-B 暫用）
//
// 為什麼有這一支：A-T8／A-T9 要錄 cassette，而 cassette **只能錄公開 fixture 與自製 PDF**
// （NOTICE 第 4 條：真實考卷、真題的 LLM 回應一律不得進版控）。WS-D 的
// eval/fixtures/make_sample_pdf.js 才是這份 PDF 的最終擁有者；在它合入之前，先由本腳本頂著。
//
// ⚠ 換 PDF ＝ 換 pdfSha256 ＝ extract 的 cassette 鍵全部失效（interfaces-stage2.md 第 5.2 條：
//   extract 的 cacheKeyParts 是 {template, chunkNo, pdfSha256}）。WS-D 的版本合入時，
//   必須重錄 eval/cassettes/extract/**，見 docs/llm.md「怎麼重錄」。
//
// 執行：node scripts/make_sample_exam_pdf.js [--out <路徑>] [--font <ttf 路徑>]
//   字型預設找 Windows 內建的 Noto Sans TC（OFL 授權，可安心內嵌進版控的 PDF）。
//   六題全部自撰，未參考任何考卷。
//
// Windows 提醒：路徑含中文（期中專案-wsB），一律 path.resolve；檔案由 Node 寫，不經 PowerShell。

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_CANDIDATES = [
    'C:\\Windows\\Fonts\\NotoSansTC-VF.ttf',
    'C:\\Windows\\Fonts\\NotoSerifTC-VF.ttf',
    'C:\\Windows\\Fonts\\kaiu.ttf'
];

// 六題：涵蓋 4 個章節、5 種題型中的 4 種、一題附圖、一題證明（證明題的 verify 節點會 skipped）
const QUESTIONS = [
    {
        no: 1,
        head: '一、單選題（每題 10 分）',
        body: '設平面向量 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，則 $\\vec{a}\\cdot\\vec{b}$ 之值為何？\n(A) $-1$　(B) $1$　(C) $3$　(D) $5$'
    },
    {
        no: 2,
        body: '若 $\\log_2 x+\\log_2 (x-2)=3$，則 $x$ 之值為何？\n(A) $2$　(B) $4$　(C) $6$　(D) $8$'
    },
    {
        no: 3,
        head: '二、填空題（每題 10 分）',
        body: '圓 $x^2+y^2-4x+2y-4=0$ 的圓心為 ________，半徑為 ________。'
    },
    {
        no: 4,
        body: '三角形三邊長分別為 $5$、$7$、$8$，則最大內角的餘弦值為 ________。'
    },
    {
        no: 5,
        head: '三、計算題（每題 15 分）',
        body: '如右圖，質量 $2$ 公斤的木塊置於傾角 $30^\\circ$ 的光滑斜面上，由靜止釋放。取重力加速度 $g=10$，求木塊沿斜面下滑的加速度大小，以及釋放後 $2$ 秒的速率。\n（附圖：一個直角三角形斜面，底邊水平、左下角標示夾角 $30^\\circ$，斜邊上有一個方塊，方塊旁畫一箭頭沿斜面向下，斜面下方標註「光滑」。）'
    },
    {
        no: 6,
        head: '四、證明題（15 分）',
        body: '設 $\\vec{a}$、$\\vec{b}$ 為任意兩個平面向量，試證明 $|\\vec{a}+\\vec{b}|^2+|\\vec{a}-\\vec{b}|^2=2(|\\vec{a}|^2+|\\vec{b}|^2)$。'
    }
];

function parseArgs(argv) {
    const args = { out: null, font: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--out') args.out = argv[++i];
        else if (argv[i] === '--font') args.font = argv[++i];
    }
    return args;
}

function pickFont(explicit) {
    const candidates = explicit ? [explicit] : FONT_CANDIDATES;
    for (const file of candidates) {
        if (fs.existsSync(file)) return file;
    }
    throw new Error(
        `找不到可用的中文字型。請用 --font 指到一支 .ttf，或安裝 Noto Sans TC。\n已找過：${candidates.join('、')}`
    );
}

function main() {
    const args = parseArgs(process.argv);
    const fontFile = pickFont(args.font);
    const outFile = path.resolve(args.out || path.join(__dirname, '..', 'eval', 'fixtures', 'sample_exam.pdf'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });

    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 56, right: 56 },
        // 固定 CreationDate：讓同一份內容每次產出的位元組盡量一致，
        // pdfSha256 不會因為「今天重跑了一次」就換掉整批 cassette
        info: {
            Title: 'sample_exam',
            Author: 'tutor-exam-bank (self-authored fixture)',
            CreationDate: new Date(Date.UTC(2026, 7, 22, 0, 0, 0)),
            ModDate: new Date(Date.UTC(2026, 7, 22, 0, 0, 0))
        }
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise(resolve => doc.on('end', resolve));

    doc.registerFont('tc', fontFile);
    doc.font('tc');

    doc.fontSize(18).text('高中數理綜合練習卷（自製範例）', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).text('本卷全部題目為自行撰寫，僅供 eval／cassette 測試使用，未參考任何考卷。', { align: 'center' });
    doc.moveDown(1.2);

    for (const q of QUESTIONS) {
        if (q.head) {
            doc.moveDown(0.5);
            doc.fontSize(13).text(q.head);
            doc.moveDown(0.3);
        }
        doc.fontSize(12).text(`${q.no}. ${q.body}`, { lineGap: 3 });
        doc.moveDown(0.6);
    }

    doc.end();

    return done.then(() => {
        fs.writeFileSync(outFile, Buffer.concat(chunks));
        const crypto = require('crypto');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
        console.log(`已寫入 ${outFile}`);
        console.log(`字型：${fontFile}`);
        console.log(`sha256：${sha}`);
        console.log('⚠ 這份 PDF 一換，eval/cassettes/extract/** 全部失效，必須重錄。');
    });
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = { QUESTIONS, pickFont };
