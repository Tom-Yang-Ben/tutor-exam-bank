// ─────────────────────────────────────────────────────────────
// figureBackfill.test.js — 舊題補附圖（〔Owner 決策單 2026-09-25 B20〕scripts/backfill_figures.js、utils/figureLayout.js、
// services/pdfLayout.js）的單元測試
//
//   1. 版面規則（純函式）：找圖（太小、太大、白色、表格、行內算式不算圖；短標註併進框、題號不併）、雙欄判斷、
//      題號／大題標題、定位題幹（去掉附圖描述）、分段與分題（範圍內、大半、跨兩題、頁首接續、卷首、雙欄）、分數。
//   2. 提議檔：表頭凍結、BOM＋CRLF、讀回來逐列驗證（缺欄、題號、重複、空路徑）、Big5、欄位順序被 Excel 調動。
//   3. 圖檔路徑：只接受提議檔所在資料夾裡的 PNG；資料夾搬家時以檔名找回；寫進題庫的路徑過得了 Word 匯出的白名單。
//   4. 參數解析、依據欄、多份卷取一、預覽頁跳脫。
//   5. dry-run（假的 DB，真的 mupdf＋自製小 PDF，放在中文資料夾）：CSV／預覽頁／暫存圖都產生、內容正確；
//      **沒加 --use-llm 時一次都不呼叫拆題 agent**；加了以後只對掃描檔呼叫，模型框的圖以題幹相似度對題。
//   6. Windows 雙擊腳本 scripts/windows/backfill_figures.bat：CRLF、無 BOM、只跑 dry-run、每個出口都 pause。
//   7. 〔審查修正 2026-09-26〕數字與英文字母一律納入比對分數（原卷該題的段落、相符度、數字係數、依據寫「數字不一致」、
//      多份卷取數字相符的那份）；需要注意的列不論分數都標橘底；--apply 核對「題幹前60字」；--use-llm 的花費煞車
//      （每份卷 JOB_COST_BUDGET_USD、當日 DAILY_COST_BUDGET_USD，假的 LLM 回 usage 估價）。
//   8. 〔審查修正 2 2026-09-26〕跨頁的題：夾在中間的上一頁頁尾與下一頁頁首（頁首帶 headerRatio、頁尾帶 footerRatio）
//      不算進段落——數字與題庫相同的題相符度 1、不標數字不一致（單欄跨頁、雙欄右欄跨到下一頁左欄）；同頁跨欄照舊整段都算；
//      壓到帶上的正文、題目起點與終點那一行不略過。
// 不連資料庫、不呼叫任何 LLM。題目文字取自本專案自製的公開樣卷（eval/fixtures/sample_exam.pdf）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../utils/figureLayout');
const bf = require('../../scripts/backfill_figures');
const { decodeCsvBuffer } = require('../../scripts/migrate_chapters');
const { resolveFigurePath } = require('../../services/wordService');
const fx = require('../fixtures/figureBackfillPdf');

const APP_DIR = path.resolve(__dirname, '..', '..');
const BAT = path.join(APP_DIR, 'scripts', 'windows', 'backfill_figures.bat');

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'figure-backfill-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ───────── 小工具：合成頁面 ─────────
const line = (text, x0, y0, x1, y1) => ({ text, bbox: [x0, y0, x1, y1] });
const vec = (bbox, extra = {}) => ({ bbox, kind: 'stroke', axis: false, white: false, hLines: [], vLines: [], ...extra });
const hline = (x0, x1, y) => ({ bbox: [x0, y - 0.4, x1, y + 0.4], kind: 'stroke', axis: true, white: false, hLines: [{ y, len: x1 - x0 }], vLines: [] });
const vline = (x, y0, y1) => ({ bbox: [x - 0.4, y0, x + 0.4, y1], kind: 'stroke', axis: true, white: false, hLines: [], vLines: [{ x, len: y1 - y0 }] });
const page = (lines, graphics = [], extra = {}) => ({ page: 1, width: 595, height: 842, lines, graphics, ...extra });

// 兩題的單欄卷：第 1 題 y 100–150、第 2 題 y 200–250
const Q1 = '設物體沿斜面下滑，斜面傾角為三十度，求物體下滑的加速度大小。';
const Q2 = '一質點作等速率圓周運動，下列關於其速度與加速度的敘述何者正確？';
function twoQuestionDoc(pages = null) {
    const p1 = page([
        line('1. 設物體沿斜面下滑，斜面傾角為三十度，', 56, 100, 400, 114),
        line('求物體下滑的加速度大小。', 70, 116, 300, 130),
        line('2. 一質點作等速率圓周運動，下列關於其速', 56, 200, 400, 214),
        line('度與加速度的敘述何者正確？', 70, 216, 300, 230)
    ]);
    return L.buildDocIndex(pages || [p1]);
}

describe('utils/figureLayout — 找圖', () => {
    test('向量線條相距 6pt 內併成一張；太小（底線）不算圖', () => {
        const p = page([], [
            vec([100, 300, 160, 340]), vec([163, 310, 200, 345]),     // 相距 3pt → 同一張
            hline(70, 200, 400)                                          // 底線：高度不到 24pt
        ]);
        const r = L.detectFigures(p);
        assert.equal(r.figures.length, 1);
        assert.deepEqual(r.figures[0].bbox, [100, 300, 200, 345]);
        assert.equal(r.figures[0].kind, 'vector');
        assert.equal(r.figures[0].parts, 2);
        assert.equal(r.dropped.small, 1);
    });

    test('整頁底圖／外框、白色填色不算圖；點陣圖照算', () => {
        const p = page([], [
            { bbox: [0, 0, 595, 842], kind: 'image', axis: false, white: false },       // 掃描頁
            vec([20, 20, 575, 822]),                                                    // 頁框
            { bbox: [100, 100, 300, 300], kind: 'fill', axis: true, white: true },      // 白底
            { bbox: [300, 400, 380, 460], kind: 'image', axis: false, white: false }
        ]);
        const r = L.detectFigures(p);
        assert.deepEqual(r.figures.map(f => [f.kind, f.bbox]), [['image', [300, 400, 380, 460]]]);
        assert.equal(r.dropped.large, 2);
        assert.equal(r.dropped.white, 1);
    });

    test('表格（橫豎線各兩條以上貫穿、框內有字）不算圖；同樣的格線裡沒有字、或有斜線，照算圖', () => {
        const grid = [hline(100, 300, 100), hline(100, 300, 130), hline(100, 300, 160), vline(100, 100, 160), vline(200, 100, 160), vline(300, 100, 160)];
        const cells = [line('溫度', 120, 105, 150, 120), line('壓力', 220, 105, 250, 120), line('10', 120, 135, 140, 150)];
        assert.equal(L.detectFigures(page(cells, grid)).dropped.table, 1);
        assert.equal(L.detectFigures(page(cells, grid)).figures.length, 0);
        assert.equal(L.detectFigures(page([], grid)).figures.length, 1, '沒有字的格線（方格紙）是圖');
        const withDiagonal = grid.concat([vec([100, 100, 300, 160])]);
        assert.equal(L.detectFigures(page(cells, withDiagonal)).figures.length, 1, '有斜線或曲線就不是表格');
    });

    test('行內算式：圖框大半被一般文字行蓋住 → 不算圖', () => {
        const p = page([line('已知函數 f(x) 的圖形通過兩點，求其斜率與截距', 56, 300, 500, 330)], [vec([200, 298, 260, 332])]);
        const r = L.detectFigures(p);
        assert.equal(r.figures.length, 0);
        assert.equal(r.dropped.inline, 1);
    });

    test('圖旁的短字（頂點標註、選項代號）併進圖框；題號行、長句不併', () => {
        const p = page([
            line('A', 92, 330, 98, 340),                // 左下角外面 → 併
            line('(B)', 205, 300, 222, 312),            // 右側 → 併
            line('3.', 80, 342, 90, 354),               // 題號（就在圖旁）→ 不併
            line('求三角形的面積為多少平方公分', 100, 350, 400, 364)   // 長句 → 不併
        ], [vec([100, 300, 200, 340])]);
        const [f] = L.detectFigures(p).figures;
        assert.deepEqual(f.bbox, [92, 300, 222, 340]);
    });

    test('座標軸下方的刻度列（沒有中文字、落在圖的寬度內）併進圖框；比圖寬的算式行不併', () => {
        const fig = vec([100, 200, 300, 300]);
        const ticks = line('0   1   2   3   4   5   t(s)', 104, 304, 296, 314);
        const wide = line('(A) 1  (B) 2  (C) 3  (D) 4  (E) 5', 60, 304, 400, 314);
        assert.deepEqual(L.detectFigures(page([ticks], [fig])).figures[0].bbox, [100, 200, 300, 314]);
        assert.deepEqual(L.detectFigures(page([wide], [fig])).figures[0].bbox, [100, 200, 300, 300]);
    });

    test('扁長的圖（寬高比 > 5、高 < 40pt）標 flat，提醒可能是算式圖片', () => {
        const [f] = L.detectFigures(page([], [{ bbox: [100, 100, 400, 130], kind: 'image', axis: false, white: false }])).figures;
        assert.equal(f.flat, true);
    });

    test('lineBoundaryKind：題號、作答括號在前、大題標題、題組；小數與一般句子不是', () => {
        assert.equal(L.lineBoundaryKind('12. 設 a 為實數'), 'number');
        assert.equal(L.lineBoundaryKind('１２．設 a 為實數'), 'number');
        assert.equal(L.lineBoundaryKind('(   )3. 下列何者正確'), 'number');
        assert.equal(L.lineBoundaryKind('二、多選題'), 'section');
        assert.equal(L.lineBoundaryKind('第 21-23 題為題組'), 'section');
        assert.equal(L.lineBoundaryKind('1.5 公尺長的木棒'), null);
        assert.equal(L.lineBoundaryKind('求 x 的值。'), null);
    });

    test('pageColumns：左右兩半各有多行、幾乎沒有橫跨中線的行 → 雙欄', () => {
        const left = [0, 1, 2, 3].map(i => line('左欄的題目文字內容很長', 40, 100 + i * 20, 280, 114 + i * 20));
        const right = [0, 1, 2, 3].map(i => line('右欄的題目文字內容很長', 320, 100 + i * 20, 560, 114 + i * 20));
        assert.equal(L.pageColumns(page(left.concat(right))), 2);
        const wide = [0, 1, 2, 3, 4, 5].map(i => line('整行橫跨版面的題目文字內容很長很長', 40, 100 + i * 20, 560, 114 + i * 20));
        assert.equal(L.pageColumns(page(wide)), 1);
    });
});

describe('utils/figureLayout — 定位與分題', () => {
    test('locateInDoc：題幹在原卷的覆蓋率；附圖描述不算；中文字太少回 low_anchor', () => {
        const doc = twoQuestionDoc();
        const r = L.locateInDoc(`${Q1}\n[附圖描述：斜面上的木塊，傾角 30 度]`, doc);
        assert.equal(r.status, 'located');
        assert.equal(r.coverage, 1);
        assert.equal(r.startLine.lineNo, 0);
        assert.equal(r.endLine.lineNo, 1);
        assert.equal(L.locateInDoc('求 $x^2+1=0$ 的解', doc).status, 'low_anchor');
        assert.equal(L.locateInDoc('這一題完全不在這份卷上面，題幹文字都不一樣喔', doc).status, 'not_found');
    });

    test('題號下方一行起算的題目認領題號；圖在範圍內 inside、大半 mostly、跨兩題 ambiguous', () => {
        const p1 = page([
            line('1.（物理・計算）', 56, 100, 152, 114),
            line('設物體沿斜面下滑，斜面傾角為三十度，求物體下滑的加速度大小。', 70, 116, 400, 130),
            line('2.（物理・單選）', 56, 200, 152, 214),
            line('一質點作等速率圓周運動，下列關於其速度與加速度的敘述何者正確？', 70, 216, 400, 230)
        ]);
        const doc = L.buildDocIndex([p1]);
        const located = [Q1, Q2].map((t, i) => ({ key: i + 1, startLine: L.locateInDoc(t, doc).startLine }));
        const bs = L.buildBoundaries(doc, located);
        assert.deepEqual(bs.map(b => [b.y, b.owners]), [[100, [1]], [200, [2]]], '題幹在題號下一行：認領題號行');

        const inside = L.assignFigure({ bbox: [420, 132, 520, 190] }, p1, 1, bs);
        assert.equal(inside.boundary.owners[0], 1);
        assert.equal(inside.layout, 'inside');
        const mostly = L.assignFigure({ bbox: [420, 150, 520, 210] }, p1, 1, bs);
        assert.equal(mostly.boundary.owners[0], 1);
        assert.equal(mostly.layout, 'mostly');
        assert.equal(mostly.ratio, 0.83);
        const amb = L.assignFigure({ bbox: [420, 170, 520, 240] }, p1, 1, bs);
        assert.equal(amb.boundary.owners[0], 2);
        assert.equal(amb.layout, 'ambiguous');
        assert.equal(L.proposalScore({ coverage: 1, layout: amb.layout, ratio: amb.ratio }), Number((amb.ratio / 0.6).toFixed(2)));
    });

    test('頁首的圖接續上一頁最後一題（carry，分數 ×0.9）；卷首還沒有任何題號的圖是 header', () => {
        const p1 = page([line('1. 設物體沿斜面下滑，斜面傾角為三十度，求物體下滑的加速度大小。', 56, 700, 540, 714)]);
        const p2 = page([line('2. 一質點作等速率圓周運動，下列關於其速度與加速度的敘述何者正確？', 56, 300, 540, 314)], [], { page: 2 });
        const doc = L.buildDocIndex([p1, p2]);
        const bs = L.buildBoundaries(doc, [{ key: 1, startLine: L.locateInDoc(Q1, doc).startLine }]);
        const carry = L.assignFigure({ bbox: [100, 40, 300, 200] }, p2, 1, bs);
        assert.equal(carry.layout, 'carry');
        assert.deepEqual(carry.boundary.owners, [1]);
        assert.equal(L.proposalScore({ coverage: 1, layout: 'carry', ratio: 1 }), 0.9);
        assert.equal(L.proposalScore({ coverage: 0.9, layout: 'inside', ratio: 1 }), 0.9);
        const header = L.assignFigure({ bbox: [20, 20, 60, 50] }, p1, 1, bs);
        assert.equal(header.layout, 'header');
        assert.equal(header.boundary, null);
        const unowned = L.assignFigure({ bbox: [100, 330, 300, 400] }, p2, 1, bs);
        assert.deepEqual(unowned.boundary.owners, [], '第 2 題不是候選題：段落沒有主人');
    });

    test('雙欄：右欄最上方的圖接續左欄最後一題', () => {
        const left = [0, 1, 2, 3].map(i => line(i === 0 ? '1. 設物體沿斜面下滑，斜面傾角為三十度，' : '求物體下滑的加速度大小，並說明理由。', 40, 600 + i * 20, 280, 614 + i * 20));
        const right = [0, 1, 2, 3].map(i => line(i === 0 ? '2. 一質點作等速率圓周運動，下列關於其' : '速度與加速度的敘述何者正確？請說明。', 320, 300 + i * 20, 560, 314 + i * 20));
        const p = page(left.concat(right));
        const doc = L.buildDocIndex([p]);
        assert.equal(doc.columnsByPage.get(1), 2);
        const bs = L.buildBoundaries(doc, [{ key: 1, startLine: doc.lines[0] }]);
        const r = L.assignFigure({ bbox: [340, 60, 520, 200] }, p, 2, bs);
        assert.equal(r.layout, 'carry');
        assert.deepEqual(r.boundary.owners, [1]);
    });

    test('題號已被起點在別行的題認領 → 自成一段；起點同一行的兩題（題庫重複）一起當主人', () => {
        const doc = twoQuestionDoc();
        const other = { key: 9, startLine: doc.lines[1] };
        const bs = L.buildBoundaries(doc, [{ key: 1, startLine: doc.lines[0] }, other, { key: 2, startLine: doc.lines[2] }, { key: 3, startLine: doc.lines[2] }]);
        assert.deepEqual(bs.map(b => [b.lineNo, b.owners]), [[0, [1]], [1, [9]], [2, [2, 3]]]);
    });

    test('detailSimilarity：中文字一樣、數字不同的兩題分得出來；textSimilarity 忽略附圖描述、中文字太少回 null', () => {
        const seg = '質量 2 kg 的物體受到合力 10 N,求其加速度。';
        const same = L.detailSimilarity('質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。', seg);
        const other = L.detailSimilarity('質量 $3$ kg 的物體受到合力 $12$ N，求其加速度。', seg);
        assert.equal(same, 1);
        assert.ok(other < same, `數字不同的題分數要比較低（${other}）`);
        assert.equal(L.textSimilarity(`${Q1}[附圖描述：斜面]`, Q1), 1);
        assert.equal(L.textSimilarity('求 $x$', Q1), null);
    });
});

describe('scripts/backfill_figures — 參數、提議檔、圖檔路徑', () => {
    test('parseArgs：預設 dry-run 且必須給 --dir；--apply 與 dry-run 專用參數互斥；--subject-group 只在 --use-llm', () => {
        assert.deepEqual(bf.parseArgs(['--dir', 'D:/各校考卷']), {
            mode: 'dry-run', dir: 'D:/各校考卷', outDir: null, apply: null, useLlm: false, subjectGroup: 'auto', test: false, help: false
        });
        assert.equal(bf.parseArgs(['--dir', 'x', '--use-llm', '--subject-group', 'chemistry']).subjectGroup, 'chemistry');
        assert.equal(bf.parseArgs(['--apply', 'p.csv', '--test']).mode, 'apply');
        assert.throws(() => bf.parseArgs([]), /缺少 --dir/);
        assert.throws(() => bf.parseArgs(['--apply', 'p.csv', '--dry-run']), /只能擇一/);
        assert.throws(() => bf.parseArgs(['--apply', 'p.csv', '--use-llm']), /--use-llm 只用在 --dry-run/);
        assert.throws(() => bf.parseArgs(['--apply', 'p.csv', '--dir', 'x']), /--dir 只用在/);
        assert.throws(() => bf.parseArgs(['--dir', 'x', '--subject-group', 'chemistry']), /只在 --use-llm/);
        assert.throws(() => bf.parseArgs(['--dir', 'x', '--use-llm', '--subject-group', '生物']), /只能是/);
        assert.throws(() => bf.parseArgs(['--dir']), /--dir 後面要接/);
        assert.throws(() => bf.parseArgs(['--dir', 'x', '--force']), /未知的參數/);
        assert.equal(bf.parseArgs(['--help']).help, true);
    });

    const sampleRows = [
        { id: 12, subject: '數學', chapter: '平面向量', stem: '求向量的夾角', pdfRel: '高一\\段考.pdf', page: 1, image: 'C:\\x\\q12.png', score: 0.953, basis: '題幹覆蓋 1.00；圖在該題範圍內' },
        { id: 7, subject: '物理', chapter: '力學', stem: '含有,逗號與"引號"', pdfRel: 'b.pdf', page: 2, image: '/tmp/q7.png', score: 0.7, basis: 'x' }
    ];

    test('toCsv：UTF-8 BOM、CRLF、表頭凍結、逗號與引號加引號；讀回來逐列一致', () => {
        const text = bf.toCsv(sampleRows);
        assert.ok(text.startsWith('\uFEFF'));
        assert.ok(text.endsWith('\r\n') && !/[^\r]\n/.test(text));
        assert.equal(text.split('\r\n')[0], '\uFEFF題號,科目,章,題幹前60字,來源PDF,頁碼,圖檔暫存路徑,比對分數,依據');
        assert.match(text, /"含有,逗號與""引號"""/);
        assert.match(text, /,0\.95,/);
        const { rows, errors } = bf.readApplyRows(decodeCsvBuffer(Buffer.from(text, 'utf8')).text);
        assert.deepEqual(errors, []);
        assert.deepEqual(rows.map(r => [r.id, r.image, r.pdfRel, r.page]), [[12, 'C:\\x\\q12.png', '高一\\段考.pdf', '1'], [7, '/tmp/q7.png', 'b.pdf', '2']]);
    });

    test('readApplyRows：缺必要欄、題號不是正整數、重複題號、圖檔路徑留空都報錯；欄位順序可被調動', () => {
        assert.match(bf.readApplyRows('科目,章\r\n數學,x\r\n').errors[0], /缺少欄位：題號、圖檔暫存路徑/);
        const r = bf.readApplyRows('圖檔暫存路徑,題號\r\nq1.png,1\r\nq2.png,abc\r\nq3.png,1\r\n,4\r\n');
        assert.deepEqual(r.rows.map(x => [x.id, x.image]), [[1, 'q1.png']]);
        assert.equal(r.errors.length, 3);
        assert.match(r.errors[0], /題號「abc」不是正整數/);
        assert.match(r.errors[1], /題號 1 與第 2 行重複/);
        assert.match(r.errors[2], /「圖檔暫存路徑」是空的/);
        assert.deepEqual(bf.readApplyRows('').errors, ['CSV 是空的']);
    });

    test('Excel 另存的 Big5 提議檔也讀得懂', () => {
        const big5 = Buffer.from('c344b8b92caceca5d82cb3b92cc344b746ab653630a6722ca8d3b7bd5044462cadb6bd582cb9cfc0c9bcc8a673b8f4ae7c2ca4f1b9efa4c0bcc62ca8ccbeda0d0a31322cbcc6bec72ca5adadb1a656b6712ca844a656b671aabaa7a8a8a42cb0aaa4405cac71a6d22e7064662c312c7131322e706e672c302e39352cc344b746c2d0bb5c20312e30300d0a', 'hex');
        const d = decodeCsvBuffer(big5);
        assert.equal(d.encoding, 'big5');
        const { rows, errors } = bf.readApplyRows(d.text);
        assert.deepEqual(errors, []);
        assert.deepEqual(rows.map(r => [r.id, r.image, r.pdfRel]), [[12, 'q12.png', '高一\\段考.pdf']]);
    });

    test('resolveImagePath：只接受提議檔資料夾裡的檔案；整個資料夾搬家時以檔名找回；Windows 路徑也認', () => {
        const dir = path.join(TMP, '提議 資料夾');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'q1.png'), 'x');
        fs.writeFileSync(path.join(TMP, 'outside.png'), 'x');
        const real = fs.realpathSync(path.join(dir, 'q1.png'));
        assert.deepEqual(bf.resolveImagePath('q1.png', dir), { file: real });
        assert.deepEqual(bf.resolveImagePath(path.join(dir, 'q1.png'), dir), { file: real });
        assert.deepEqual(bf.resolveImagePath('/舊的位置/figure-backfill/2026-09-26/q1.png', dir), { file: real });
        assert.deepEqual(bf.resolveImagePath('C:\\Users\\老師\\data\\figure-backfill\\2026-09-26\\q1.png', dir), { file: real });
        assert.match(bf.resolveImagePath(path.join(TMP, 'outside.png'), dir).error, /不在提議檔所在的資料夾裡/);
        assert.match(bf.resolveImagePath('../outside.png', dir).error, /不在提議檔所在的資料夾裡/);
        assert.match(bf.resolveImagePath('q404.png', dir).error, /找不到圖檔/);
        assert.match(bf.resolveImagePath('  ', dir).error, /是空的/);
    });

    test('checkImages：不是 PNG 的檔案擋下；PNG 補上 sha8；寫進題庫的路徑過得了 Word 匯出的白名單', async () => {
        const dir = path.join(TMP, 'check');
        fs.mkdirSync(dir, { recursive: true });
        const sharp = require('sharp');
        fs.writeFileSync(path.join(dir, 'q1.png'), await sharp({ create: { width: 4, height: 3, channels: 3, background: '#fff' } }).png().toBuffer());
        fs.writeFileSync(path.join(dir, 'q2.png'), 'not a png');
        fs.writeFileSync(path.join(dir, 'q3.png'), await sharp({ create: { width: 4, height: 3, channels: 3, background: '#fff' } }).jpeg().toBuffer());
        const rows = [{ line: 2, id: 1, image: 'q1.png' }, { line: 3, id: 2, image: 'q2.png' }, { line: 4, id: 3, image: 'q3.png' }];
        const errors = await bf.checkImages(rows, dir);
        assert.equal(errors.length, 2);
        assert.match(errors[0], /題號 2.*不是 PNG/);
        assert.match(errors[1], /題號 3.*不是 PNG/);
        assert.match(rows[0].sha8, /^[0-9a-f]{8}$/);
        const url = bf.figureUrl(1, rows[0].sha8);
        assert.match(url, bf.BACKFILL_IMG);
        assert.equal(resolveFigurePath(url, '/srv/figures'), path.join('/srv/figures', bf.figureFileName(1, rows[0].sha8)));
    });

    test('basisText／sourceDetailMatches／pickBest', () => {
        const base = { method: 'layout', coverage: 0.95, layout: 'ambiguous', ratio: 0.42, figures: 2, otherPages: 1, flat: true, jobIds: [3], sourceDetailMatch: true, hint: false, alsoIn: 1 };
        assert.equal(bf.basisText(base),
            '題幹覆蓋 0.95；圖跨兩題（重疊 0.42），請特別確認；併 2 張圖；另有 1 頁的圖未採用；扁長，可能是算式圖片；原卷與入庫紀錄相符（job #3）；來源註記與檔名相符；題幹沒有提到圖；另見於 1 份卷');
        assert.equal(bf.basisText({ method: 'llm', model: 'ollama:qwen3-vl:8b', coverage: 0.9, jobIds: [], hint: true }),
            '模型框圖（ollama:qwen3-vl:8b）；題幹相似 0.90；題幹提到圖');
        assert.equal(bf.sourceDetailMatches('北一女 2024 段考', '高一/北一女113上第一次段考.pdf'), true);
        assert.equal(bf.sourceDetailMatches('建中', '北一女.pdf'), false);
        assert.equal(bf.sourceDetailMatches(null, 'a.pdf'), false);

        const p = (o) => ({ jobIds: [], sourceDetailMatch: false, score: 0.9, pdfRel: 'b.pdf', page: 1, ...o });
        assert.equal(bf.pickBest([p({ score: 0.99, pdfRel: 'a.pdf' }), p({ jobIds: [1], score: 0.8 })]).pdfRel, 'b.pdf', '入庫紀錄相符優先');
        assert.equal(bf.pickBest([p({ score: 0.99, pdfRel: 'a.pdf' }), p({ sourceDetailMatch: true, score: 0.8, pdfRel: 'c.pdf' })]).pdfRel, 'c.pdf');
        const best = bf.pickBest([p({ score: 0.8, pdfRel: 'a.pdf' }), p({ score: 0.95, pdfRel: 'c.pdf' })]);
        assert.equal(best.pdfRel, 'c.pdf');
        assert.equal(best.alsoIn, 1);
    });

    test('renderPreview：題幹與依據一律跳脫；圖用相對路徑', () => {
        const html = bf.renderPreview([{ id: 3, subject: '數學', chapter: '<章>', text: '<script>alert(1)</script> & 題', pdfRel: 'a&b.pdf', page: 1, imageName: 'q3.png', score: 0.5, basis: '"x"' }], { csvPath: 'C:\\p\\proposals.csv' });
        assert.ok(!html.includes('<script>alert'));
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; 題/);
        assert.match(html, /src="q3\.png"/);
        assert.match(html, /class="low"/);
        assert.match(html, /&quot;x&quot;/);
    });

    test('defaultOutDir：同一天第二次改用 -2，絕不覆寫', () => {
        const root = path.join(TMP, 'outroot');
        assert.equal(bf.defaultOutDir(root, '2026-09-26'), path.join(root, '2026-09-26'));
        fs.mkdirSync(path.join(root, '2026-09-26'), { recursive: true });
        assert.equal(bf.defaultOutDir(root, '2026-09-26'), path.join(root, '2026-09-26-2'));
    });

    test('inferSubjectGroup：多數是化學 → chemistry；判斷不出來 → math_physics', () => {
        assert.equal(bf.inferSubjectGroup(['化學', '化學', '物理']), 'chemistry');
        assert.equal(bf.inferSubjectGroup(['化學', '物理']), 'math_physics');
        assert.equal(bf.inferSubjectGroup([]), 'math_physics');
    });
});

describe('scripts/backfill_figures — dry-run（假的 DB、自製小 PDF、中文資料夾）', () => {
    const ROWS = [
        { id: 5, subject: '物理', chapter: '牛頓運動定律', question_text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。' },
        { id: 55, subject: '物理', chapter: '牛頓運動定律', question_text: '質量 $3$ kg 的物體受到合力 $12$ N，求其加速度。' },
        { id: 9, subject: '物理', chapter: '牛頓運動定律', question_text: '馬拉車前進時，馬對車的作用力 $F$ 與車對馬的反作用力，兩者的關係為何？\n[附圖描述：馬拉著車]', archived: true },
        { id: 6, subject: '物理', chapter: '圓周運動', question_text: '長 $1$ m 的輕繩繫住質量 $2$ kg 的小球，在光滑水平面上以 $3$ m/s 的速率作等速圓周運動，求繩的張力。' },
        { id: 7, subject: '物理', chapter: '直線運動', question_text: '物體由靜止出發，以 $2\\ \\text{m/s}^2$ 的等加速度直線前進，求 $5$ 秒後的位移。\n[附圖描述：v-t 圖]' }
    ];
    const fakeDb = (rows = ROWS) => ({
        query: async (sql) => {
            assert.match(sql, /question_img IS NULL/);
            return { rows: rows.map(r => ({ source_detail: null, archived: false, pdf_shas: [], job_ids: [], ...r })) };
        }
    });
    let dir;
    before(async () => {
        dir = path.join(TMP, '各校考卷');
        fs.mkdirSync(path.join(dir, '高一 段考'), { recursive: true });
        fs.mkdirSync(path.join(dir, '掃描'), { recursive: true });
        fs.writeFileSync(path.join(dir, '高一 段考', '自製附圖卷（測試）.pdf'), await fx.makeFigurePdf());
        fs.writeFileSync(path.join(dir, '掃描', '掃描卷.PDF'), await fx.makeScannedPdf());
        fs.writeFileSync(path.join(dir, '說明.txt'), '不是 PDF');
    });

    test('只讀、不呼叫拆題 agent：提議第 5、9 題；同文異數的第 55 題讓位；題幹提到圖卻沒偵測到圖的第 7 題列入警告', async () => {
        const out = path.join(TMP, 'out-1');
        let called = 0;
        const r = await bf.dryRun({
            db: fakeDb(), dir, outDir: out, logger: { warn() { } },
            extractRun: async () => { called += 1; throw new Error('不該呼叫'); }
        });
        assert.equal(called, 0, '沒加 --use-llm 不得呼叫拆題 agent');
        const loaded = Object.keys(require.cache);
        assert.ok(!loaded.some(k => /[\\/]agents[\\/]extract\.js$/.test(k)), '沒加 --use-llm 連 agents/extract.js 都不載入');
        assert.ok(!loaded.some(k => /[\\/]services[\\/]llm[\\/]/.test(k)), '沒加 --use-llm 連 services/llm 都不載入');
        assert.deepEqual(r.proposals.map(p => p.id), [5, 9]);
        assert.equal(r.stats.pdfs, 2);
        assert.deepEqual(r.stats.noTextLayer, [path.join('掃描', '掃描卷.PDF')]);
        assert.equal(r.stats.tieLost, 1);
        assert.equal(r.stats.header, 1);
        assert.equal(r.stats.unowned, 1, '第 10 題的圖：第 10 題不是候選題');
        assert.equal(r.stats.dropped.table, 1);
        assert.deepEqual(r.stats.hintedWithoutFigure, [7]);
        assert.equal(r.stats.llm, null);

        const q5 = r.proposals[0];
        assert.equal(q5.page, 1);
        assert.equal(q5.layout, 'mostly');
        assert.ok(q5.rect[0] < fx.FIGURES.q5Vector[0] && q5.rect[2] > fx.FIGURES.q5Vector[2], 'A、B 標註併進裁切範圍');
        assert.deepEqual(r.proposals[1].rect, fx.FIGURES.q9Image);

        // 提議檔、預覽頁、暫存圖
        assert.equal(r.csvPath, path.join(out, 'proposals.csv'));
        const { rows, errors } = bf.readApplyRows(decodeCsvBuffer(fs.readFileSync(r.csvPath)).text);
        assert.deepEqual(errors, []);
        assert.deepEqual(rows.map(x => [x.id, x.pdfRel, x.page]), [
            [5, path.join('高一 段考', '自製附圖卷（測試）.pdf'), '1'], [9, path.join('高一 段考', '自製附圖卷（測試）.pdf'), '1']]);
        const csv = decodeCsvBuffer(fs.readFileSync(r.csvPath)).text;
        assert.match(csv, /（已封存）馬拉車前進時/);
        assert.match(csv, /題幹覆蓋 1\.00；圖在該題範圍內；題幹提到圖/);
        const sharp = require('sharp');
        const meta = await sharp(fs.readFileSync(path.join(out, 'q9.png'))).metadata();
        assert.equal(meta.format, 'png');
        assert.equal(meta.width, Math.ceil((585 + 4) * 2) - Math.floor((520 - 4) * 2), '144 DPI（×2）＋四周 4pt');
        const html = fs.readFileSync(r.previewPath, 'utf8');
        assert.match(html, /src="q5\.png"/);
        assert.match(html, /src="q9\.png"/);
        assert.equal(await bf.checkImages(rows, out).then(e => e.length), 0);
    });

    test('--out-dir 已有 proposals.csv → 拒絕（不蓋掉老師可能正在改的提議檔）；沒有提議時不建資料夾', async () => {
        await assert.rejects(bf.dryRun({ db: fakeDb(), dir, outDir: path.join(TMP, 'out-1') }), /已經存在/);
        const empty = path.join(TMP, 'out-empty');
        const r = await bf.dryRun({ db: fakeDb([]), dir, outDir: empty });
        assert.equal(r.proposals.length, 0);
        assert.equal(r.csvPath, null);
        assert.equal(fs.existsSync(empty), false);
        await assert.rejects(bf.dryRun({ db: fakeDb(), dir: path.join(TMP, '不存在') }), /找不到原卷資料夾/);
    });

    test('--use-llm：只對掃描檔（與「提到圖卻沒偵測到」的卷）呼叫；模型框的圖以題幹相似度對到第 6 題', async () => {
        const calls = [];
        const extractRun = async (ctx, input) => {
            calls.push({ group: ctx.job.subject_group, chunk: input.chunk, bytes: input.pdfBytes.length });
            const scanned = input.pdfBytes.length === fs.statSync(path.join(dir, '掃描', '掃描卷.PDF')).size;
            return {
                kind: 'pass',
                data: {
                    questions: scanned ? [
                        { question_text: '長 1 m 的輕繩繫住質量 2 kg 的小球，在光滑水平面上以 3 m/s 的速率作等速圓周運動，求繩的張力。', figure_page: 1, figure_box: [460, 700, 560, 980] },
                        { question_text: '這一題不在題庫裡，模型抄的題幹完全對不上任何一題喔', figure_page: 1, figure_box: [10, 10, 50, 50] },
                        { question_text: '質量 2 kg 的物體受到合力 10 N，求其加速度。' }
                    ] : []
                }
            };
        };
        const makeCtx = (group) => ({ job: { subject_group: group }, config: { models: { extract: 'fake:vision' }, thresholds: { pdfChunkPages: 20 } } });
        const out = path.join(TMP, 'out-llm');
        const r = await bf.dryRun({ db: fakeDb(), dir, outDir: out, useLlm: true, extractRun, makeCtx, logger: { warn() { } } });
        assert.equal(calls.length, 2, '掃描檔一塊＋有「提到圖卻沒偵測到」題（第 7 題）的卷一塊');
        assert.ok(calls.every(c => c.group === 'math_physics' && c.chunk.fromPage === 1 && c.chunk.toPage === 1));
        assert.deepEqual(r.proposals.map(p => [p.id, p.method]).sort((a, b) => a[0] - b[0]), [[5, 'layout'], [6, 'llm'], [9, 'layout']]);
        const q6 = r.proposals.find(p => p.id === 6);
        assert.equal(q6.pdfRel, path.join('掃描', '掃描卷.PDF'));
        assert.deepEqual(q6.box, [460, 700, 560, 980]);
        assert.deepEqual(r.stats.llm, { pdfs: 2, chunks: 2, failedChunks: 0, boxes: 2, matched: 1 });
        const csv = decodeCsvBuffer(fs.readFileSync(r.csvPath)).text;
        assert.match(csv, /模型框圖（fake:vision）；題幹相似 1\.00/);
        assert.ok(fs.existsSync(path.join(out, 'q6.png')));
    });

    test('buildExtractCtx：模型、切塊與新管線相同（本機模式的切塊預設也照 workers/jobRunner.js）；只建 Ctx、不呼叫模型', () => {
        const models = require('../../config/models');
        const runner = require('../../workers/jobRunner');
        const ctx = bf.buildExtractCtx('chemistry', { warn() { } });
        assert.equal(ctx.job.subject_group, 'chemistry');
        assert.equal(ctx.config.models.extract, models.MODEL_EXTRACT);
        assert.equal(ctx.config.models.verify, models.MODEL_VERIFY);
        assert.equal(ctx.config.thresholds.pdfChunkPages, { ...runner.loadConfig(), ...runner.loadLocalModeConfig() }.pdfChunkPages);
        assert.equal(typeof ctx.llm.generateJson, 'function');
    });

    test('llmProposals：拆題失敗的塊只記數；中文字太少的題不比', async () => {
        const cands = [{ id: 1, text: '求 $x$', lowAnchor: true, pdfShas: [], jobIds: [], hint: false, subject: '數學' }];
        const r = await bf.llmProposals({
            bytes: Buffer.from('x'), pageCount: 3, pdfRel: 'a.pdf', pdfAbs: '/a.pdf', sha: 's', candidates: cands, group: 'math_physics',
            extractRun: async (ctx, { chunk }) => (chunk.no === 1 ? { kind: 'fail', reason: 'schema_invalid' } : { kind: 'pass', data: { questions: [{ question_text: '求 x', figure_page: 3, figure_box: [1, 1, 2, 2] }] } }),
            makeCtx: () => ({ config: { thresholds: { pdfChunkPages: 2 } } })
        });
        assert.deepEqual(r.stats, { chunks: 2, failedChunks: 1, boxes: 1, matched: 0 });
        assert.deepEqual(r.proposals, []);
    });
});

// ───────── 審查修正（2026-09-26）：數字一律納入分數、需要注意的列不論分數都標橘、--apply 核對題幹、--use-llm 花費煞車 ─────────

describe('utils/figureLayout — 數字與英文字母（審查修正）', () => {
    // 單欄卷：第 5 題題號與題幹同一行、下一行接著題幹、再下一行是只有數字的選項；右邊一張圖（框裡有刻度列）；第 6 題
    const P5 = [
        line('5. 質量 2 kg 的物體受到合力 10 N，', 56, 100, 400, 114),
        line('求其加速度的大小為何？', 70, 116, 300, 130),
        line('(A) 5　(B) 2　(C) 20　(D) 0.2', 70, 132, 300, 146),
        line('0   1   2   3   t(s)', 422, 172, 518, 182),
        line('6. 一質點作等速率圓周運動，下列關於其速度與加速度的敘述何者正確？', 56, 200, 540, 214)
    ];
    const FIG = { bbox: [420, 120, 520, 184] };
    const STORED = '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度的大小為何？\n(A) $5$ (B) $2$ (C) $20$ (D) $0.2$';
    const segmentOf = (lines, text, figs = [FIG], extra = {}) => {
        const p = page(lines, [], extra);
        const doc = L.buildDocIndex([p]);
        const loc = L.locateInDoc(text, doc);
        assert.equal(loc.status, 'located');
        return L.questionSegment(doc, loc, new Map([[p.page, figs]]));
    };

    test('questionSegment：題號拿掉、只有數字的選項行接進來、圖框裡的刻度不算、遇到下一題就停', () => {
        const seg = segmentOf(P5, STORED);
        assert.ok(!/^\s*5\./.test(seg), `題號不算進段落：${seg}`);
        assert.match(seg, /\(A\) 5/, '選項行（沒有中文字）接進段落');
        assert.ok(!/t\(s\)/.test(seg), '圖框裡的刻度列不算');
        assert.ok(!/質點/.test(seg), '下一題不算');
        assert.deepEqual(L.detailCompare(STORED, seg), {
            similarity: 1, exact: true, compared: true,
            missing: { digits: [], letters: [] }, extra: { digits: [], letters: [] }
        });
    });

    test('questionSegment：頁尾的頁碼、內容流裡排在後面卻在上方的字（表格格子）不接', () => {
        const tail = [
            line('5. 質量 2 kg 的物體受到合力 10 N，求其加速度的大小為何？', 56, 760, 540, 774),
            line('(A) 5　(B) 2　(C) 20　(D) 0.2', 70, 776, 300, 790),
            line('- 1 -', 280, 815, 310, 825)                       // 頁尾（842 × 0.95 以下）
        ];
        const seg = segmentOf(tail, STORED, []);
        assert.match(seg, /\(D\) 0\.2/);
        assert.ok(!/- 1 -/.test(seg), `頁碼不算：${seg}`);
        const upward = [P5[0], P5[1], P5[2], line('7', 500, 40, 506, 50)];   // 內容流最後才畫的格子，位置在頁首
        assert.ok(!/7/.test(segmentOf(upward, STORED, [])));
        // 圖裡的中文標註（內容流排在題幹之後）不是停下來的理由：後面的選項行照接
        const label = [P5[0], P5[1], line('木塊', 430, 122, 460, 134), P5[2], P5[4]];
        const withLabel = segmentOf(label, STORED);
        assert.ok(!/木塊/.test(withLabel));
        assert.match(withLabel, /\(D\) 0\.2/);
    });

    test('detailCompare：中文一樣、數字不同 → 相符度低、列出兩邊各多了什麼；兩邊都沒有數字字母 → 沒得比', () => {
        const seg = '質量 2 kg 的物體受到合力 10 N,求其加速度。';
        const d = L.detailCompare('質量 $7$ kg 的物體受到合力 $99$ N，求其加速度。', seg);
        assert.equal(d.exact, false);
        assert.equal(d.similarity, 0.25, 'k、g 相符；7、9、9 與 2、1、0 不符：2 ÷ 8');
        assert.deepEqual(d.missing, { digits: ['7', '9', '9'], letters: [] });
        assert.deepEqual(d.extra, { digits: ['0', '1', '2'], letters: [] });
        const letters = L.detailCompare('設 $f(x)$ 為實係數多項式，求 $f$ 的次數為何', '設 g(x) 為實係數多項式,求 g 的次數為何');
        assert.deepEqual([letters.missing.letters, letters.extra.letters], [['f', 'f'], ['g', 'g']]);
        const none = L.detailCompare('關於等速圓周運動，下列敘述何者正確？', '關於等速圓周運動,下列敘述何者正確?');
        assert.deepEqual([none.similarity, none.exact, none.compared], [1, true, false]);
        assert.equal(L.detailCompare('第 $10$ 題', '1. 第 10 題').exact, true, '原卷行首的題號不算');
    });

    test('detailCompare：只要有一個字對不上，相符度無條件捨去且最多 0.99（399/400 不會顯示成 1.00）', () => {
        const d = L.detailCompare(`數字很多的題目${'1'.repeat(399)}`, `數字很多的題目${'1'.repeat(400)}`);
        assert.equal(d.exact, false);
        assert.equal(d.similarity, 0.99);
    });

    test('proposalScore：數字係數——相符 1；不一致時乘上相符度且最多 0.7；和版面係數相乘', () => {
        assert.equal(L.proposalScore({ coverage: 1, layout: 'inside', ratio: 1, detail: 1 }), 1);
        assert.equal(L.proposalScore({ coverage: 1, layout: 'inside', ratio: 1, detail: 0.95 }), 0.7, '只差一兩個數字也封在 0.7');
        assert.equal(L.proposalScore({ coverage: 1, layout: 'inside', ratio: 1, detail: 0.25 }), 0.25);
        assert.equal(L.proposalScore({ coverage: 1, layout: 'carry', ratio: 1, detail: 0.5 }), 0.45);
        assert.equal(L.proposalScore({ coverage: 0.9, layout: 'mostly', ratio: 0.8, detail: null }), 0.9, '沒有比（null）視為 1');
        assert.equal(L.detailFactor(0.99), 0.7);
        assert.equal(L.detailFactor(1), 1);
    });
});

// ───────── 審查修正 2（2026-09-26）：跨頁、跨欄的題，頁尾與下一頁的頁首不算進段落 ─────────

describe('utils/figureLayout — 跨頁、跨欄的題：頁首頁尾不算進段落（審查修正 2）', () => {
    // 題庫的題與原卷數字完全相同；原卷上這一題跨兩頁，中間夾著上一頁的頁尾與下一頁的頁首（都帶數字）
    const STORED = '質量 $2$ kg 的木塊靜置於水平桌面上，以 $10$ N 的水平力推動，木塊與桌面間的動摩擦係數為 $0.3$，'
        + '求木塊在 $3$ 秒末的速度大小為何？\n(A) $1.2$ (B) $2.4$ (C) $3.6$ (D) $4.8$';
    const EXACT = {
        similarity: 1, exact: true, compared: true,
        missing: { digits: [], letters: [] }, extra: { digits: [], letters: [] }
    };
    const FOOTER = line('第 2 頁，共 4 頁', 260, 812, 335, 824);       // 頁尾：y0 812 ≥ 842 × 0.95
    const HEADER = line('112 學年度　段考', 240, 20, 355, 32);         // 頁首：y1 32 ≤ 842 × 0.05
    const segmentOf = (pages, options) => {
        const doc = L.buildDocIndex(pages);
        const loc = L.locateInDoc(STORED, doc);
        assert.equal(loc.status, 'located');
        assert.notEqual(loc.startLine.page, loc.matchEndLine.page, '前提：這一題跨兩頁');
        return { doc, seg: L.questionSegment(doc, loc, new Map(), options) };
    };

    test('單欄卷跨頁：上一頁頁尾「第 2 頁，共 4 頁」、下一頁頁首「112 學年度」不算——數字相同的題相符度 1、不標數字不一致', () => {
        const p2 = page([
            line('6. 一質點作等速率圓周運動，下列關於其速度與加速度的敘述何者正確？', 56, 700, 540, 714),
            line('7. 質量 2 kg 的木塊靜置於水平桌面上，以 10 N 的水平力推動，', 56, 752, 540, 766),
            line('木塊與桌面間的動摩擦係數為 0.3，', 70, 770, 400, 784),
            FOOTER
        ], [], { page: 2 });
        const p3 = page([
            HEADER,
            line('求木塊在 3 秒末的速度大小為何？', 70, 56, 400, 70),
            line('(A) 1.2　(B) 2.4　(C) 3.6　(D) 4.8', 70, 74, 400, 88),
            line('8. 設物體沿斜面下滑，斜面傾角為三十度，求物體下滑的加速度大小。', 56, 110, 540, 124)
        ], [], { page: 3 });
        const { seg } = segmentOf([p2, p3]);
        assert.ok(!/頁/.test(seg), `頁尾不算：${seg}`);
        assert.ok(!/學年度/.test(seg), `頁首不算：${seg}`);
        assert.match(seg, /動摩擦係數為 0\.3/, '跨頁前的題目文字照算');
        assert.match(seg, /\(D\) 4\.8/, '下一頁的選項行照接');
        const d = L.detailCompare(STORED, seg);
        assert.deepEqual(d, EXACT);
        const score = L.proposalScore({ coverage: 1, layout: 'inside', ratio: 1, detail: d.similarity });
        assert.equal(score, 1, '分數不被數字係數壓到 0.7');
        assert.deepEqual(bf.attentionReasons({
            method: 'layout', layout: 'inside', score, flat: false, otherPages: 0,
            detail: d.similarity, detailMismatch: !d.exact, detailExtra: d.extra
        }), [], '不標「數字不一致」');

        // headerRatio／footerRatio 設 0 ＝ 不認頁首頁尾：頁碼與學年度的數字就會混進來（修正前第一個迴圈的行為）
        const raw = L.detailCompare(STORED, segmentOf([p2, p3], { headerRatio: 0, footerRatio: 0 }).seg);
        assert.equal(raw.exact, false);
        assert.deepEqual(raw.extra.digits, ['1', '1', '2', '2', '4']);
    });

    test('雙欄卷跨頁：右欄最下方接到下一頁左欄最上方，中間的頁尾頁首不算', () => {
        const p2 = page([
            line('5. 一質點作等速率圓周運動，下列關於其', 40, 100, 280, 114),
            line('速度與加速度的敘述何者正確？請說明。', 40, 120, 280, 134),
            line('6. 設物體沿斜面下滑，斜面傾角為三十度，', 40, 140, 280, 154),
            line('求物體下滑的加速度大小，並說明理由。', 40, 160, 280, 174),
            line('7. 質量 2 kg 的木塊靜置於水平桌面上，', 320, 740, 560, 754),
            line('以 10 N 的水平力推動，木塊與桌面間的', 320, 758, 560, 772),
            line('動摩擦係數為 0.3，', 320, 776, 420, 790),
            FOOTER
        ], [], { page: 2 });
        const p3 = page([
            HEADER,
            line('求木塊在 3 秒末的速度大小為何？', 40, 56, 280, 70),
            line('(A) 1.2　(B) 2.4　(C) 3.6　(D) 4.8', 40, 74, 280, 88),
            line('8. 下列何者為向量？請選出所有正確的選項。', 40, 110, 280, 124),
            line('(A) 速度　(B) 速率　(C) 質量　(D) 位移', 40, 130, 280, 144),
            line('9. 設物體沿斜面下滑，斜面傾角為三十度，', 320, 56, 560, 70),
            line('求物體下滑的加速度大小，並說明理由。', 320, 74, 560, 88),
            line('10. 一質點作等速率圓周運動，下列關於其', 320, 110, 560, 124)
        ], [], { page: 3 });
        const { doc, seg } = segmentOf([p2, p3]);
        assert.deepEqual([doc.columnsByPage.get(2), doc.columnsByPage.get(3)], [2, 2], '前提：兩頁都判成雙欄');
        assert.ok(!/頁|學年度/.test(seg), `頁首頁尾不算：${seg}`);
        assert.ok(!/速率/.test(seg), '下一題不算');
        assert.deepEqual(L.detailCompare(STORED, seg), EXACT);
    });

    test('雙欄卷跨欄（同一頁左欄接右欄）照舊整段都算；頁首帶只略過「整行都在帶內」的行，題目起點與終點那一行一律不略過', () => {
        // 右欄最上方那一行壓到頁首帶（y0 40 < 42.1）但下緣在帶外（y1 54）：是正文，照算
        const p = page([
            line('5. 設物體沿斜面下滑，斜面傾角為三十度，', 40, 100, 280, 114),
            line('求物體下滑的加速度大小，並說明理由。', 40, 120, 280, 134),
            line('7. 質量 2 kg 的木塊靜置於水平桌面上，', 40, 740, 280, 754),
            line('以 10 N 的水平力推動，木塊與桌面間的', 40, 758, 280, 772),
            line('動摩擦係數為 0.3，', 320, 40, 420, 54),
            line('求木塊在 3 秒末的速度大小為何？', 320, 58, 560, 72),
            line('(A) 1.2　(B) 2.4　(C) 3.6　(D) 4.8', 320, 76, 560, 90),
            line('8. 下列何者為向量？請選出所有正確的選項。', 320, 110, 560, 124)
        ]);
        const doc = L.buildDocIndex([p]);
        assert.equal(doc.columnsByPage.get(1), 2);
        const loc = L.locateInDoc(STORED, doc);
        assert.equal(loc.status, 'located');
        assert.deepEqual(L.detailCompare(STORED, L.questionSegment(doc, loc)), EXACT);

        // 版面極窄的卷：題目第一行就在頁首帶內、最後一行在頁尾帶內——它們是定位到的題目本身，不略過
        const narrow = page([
            line('1. 質量 2 kg 的木塊靜置於水平桌面上，以 10 N 的水平力推動，', 56, 26, 540, 38),
            line('木塊與桌面間的動摩擦係數為 0.3，', 70, 400, 400, 414),
            line('求木塊在 3 秒末的速度大小為何？(A) 1.2　(B) 2.4　(C) 3.6　(D) 4.8', 70, 802, 540, 814)
        ]);
        const nd = L.buildDocIndex([narrow]);
        const nl = L.locateInDoc(STORED, nd);
        assert.equal(nl.status, 'located');
        assert.deepEqual(L.detailCompare(STORED, L.questionSegment(nd, nl)), EXACT);
    });

    test('LAYOUT_DEFAULTS：頁首帶 headerRatio 比照頁尾帶 footerRatio（各 5%）', () => {
        assert.equal(L.LAYOUT_DEFAULTS.headerRatio, 0.05);
        assert.equal(L.LAYOUT_DEFAULTS.footerRatio, 0.05);
    });
});

describe('scripts/backfill_figures — 數字不一致、橘底、過期檢查（審查修正）', () => {
    const fakeDb = (rows) => ({
        query: async (sql) => {
            assert.match(sql, /question_img IS NULL/);
            return { rows: rows.map(r => ({ source_detail: null, archived: false, pdf_shas: [], job_ids: [], ...r })) };
        }
    });
    let dir;
    before(async () => {
        dir = path.join(TMP, '各校考卷-數字');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '自製附圖卷.pdf'), await fx.makeFigurePdf());
    });

    test('中文完全一樣、數字不同的題（題庫沒有數字相符的另一版）：明顯降分、依據寫「數字不一致」、預覽頁橘底', async () => {
        const out = path.join(TMP, 'out-mismatch');
        const r = await bf.dryRun({
            db: fakeDb([{ id: 70, subject: '物理', chapter: '牛頓運動定律', question_text: '質量 $7$ kg 的物體受到合力 $99$ N，求其加速度。' }]),
            dir, outDir: out, logger: { warn() { } }
        });
        assert.deepEqual(r.proposals.map(p => p.id), [70]);
        const p = r.proposals[0];
        assert.equal(p.coverage, 1, '中文字覆蓋率照樣是 1');
        assert.equal(p.detailMismatch, true);
        assert.equal(p.score, 0.25, '分數乘上數字相符度（原本是 1.00）');
        assert.ok(bf.attentionReasons(p).includes('數字不一致'));
        const csv = decodeCsvBuffer(fs.readFileSync(r.csvPath)).text;
        assert.match(csv, /,0\.25,題幹覆蓋 1\.00；數字不一致（相符 0\.25；題庫有、原卷沒有：7、9、9；原卷有、題庫沒有：0、1、2），請確認圖上數值；/);
        const html = fs.readFileSync(r.previewPath, 'utf8');
        assert.match(html, /<tr class="low">/);
        assert.match(html, /請特別確認：分數低於 0\.8、數字不一致/);
    });

    test('數字相符的題：依據寫「數字與英文字母相符」、不標橘；同文異數的兩題都在題庫時，相符的那題得圖', async () => {
        const r = await bf.dryRun({
            db: fakeDb([
                { id: 5, subject: '物理', chapter: '牛頓運動定律', question_text: '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。' },
                { id: 70, subject: '物理', chapter: '牛頓運動定律', question_text: '質量 $7$ kg 的物體受到合力 $99$ N，求其加速度。' }
            ]),
            dir, outDir: path.join(TMP, 'out-match'), logger: { warn() { } }
        });
        assert.deepEqual(r.proposals.map(p => p.id), [5]);
        assert.equal(r.stats.tieLost, 1);
        const p = r.proposals[0];
        assert.equal(p.detail, 1);
        assert.match(bf.basisText(p), /^題幹覆蓋 1\.00；數字與英文字母相符；圖大半在該題範圍內/);
        assert.deepEqual(bf.attentionReasons(p), []);
        assert.ok(!fs.readFileSync(r.previewPath, 'utf8').includes('<tr class="low">'));
    });

    test('pickBest：多份卷都有這一題時，數字相符的那份勝過分數與路徑順序、也勝過來源註記；入庫紀錄相符仍最優先', () => {
        const p = (o) => ({ jobIds: [], sourceDetailMatch: false, score: 0.9, pdfRel: 'b.pdf', page: 1, detail: 1, ...o });
        assert.equal(bf.pickBest([p({ pdfRel: 'a-別校.pdf', detail: 0.25, score: 0.25 }), p({ pdfRel: 'b-原卷.pdf', score: 0.9 })]).pdfRel, 'b-原卷.pdf');
        assert.equal(bf.pickBest([p({ pdfRel: 'a.pdf', detail: 0.6, score: 0.6, sourceDetailMatch: true }), p({ pdfRel: 'c.pdf' })]).pdfRel, 'c.pdf',
            '來源註記只要有兩字詞出現在路徑就算，比不上數字相符');
        assert.equal(bf.pickBest([p({ pdfRel: 'a.pdf', detail: 0.9, score: 0.7, jobIds: [4] }), p({ pdfRel: 'c.pdf' })]).pdfRel, 'a.pdf');
    });

    test('attentionReasons／renderPreview：頁首接續、跨兩題、模型框圖、扁長、另有他頁的圖——分數 0.8 以上也標橘底', () => {
        const base = { method: 'layout', layout: 'inside', score: 1, detail: 1, detailMismatch: false, flat: false, otherPages: 0 };
        assert.deepEqual(bf.attentionReasons(base), []);
        assert.deepEqual(bf.attentionReasons({ ...base, layout: 'carry', score: 0.9 }), ['頁首接續上一頁（欄）']);
        assert.deepEqual(bf.attentionReasons({ ...base, layout: 'ambiguous', score: 0.85 }), ['圖跨兩題']);
        assert.deepEqual(bf.attentionReasons({ ...base, method: 'llm', layout: 'llm' }), ['模型框圖']);
        assert.deepEqual(bf.attentionReasons({ ...base, flat: true, otherPages: 1 }), ['扁長', '另有其他頁的圖']);
        assert.deepEqual(bf.attentionReasons({ ...base, score: 0.7, detail: 0.9, detailMismatch: true, detailExtra: { digits: [], letters: ['g'] } }),
            ['分數低於 0.8', '英文字母不一致']);

        const row = (id, o) => ({ id, subject: '物理', chapter: 'x', text: 't', pdfRel: 'a.pdf', page: 1, imageName: `q${id}.png`, basis: 'b', ...o });
        const html = bf.renderPreview([
            row(1, { score: 0.9, attention: bf.attentionReasons({ ...base, layout: 'carry', score: 0.9 }) }),
            row(2, { score: 0.85, attention: bf.attentionReasons({ ...base, layout: 'ambiguous', score: 0.85 }) }),
            row(3, { score: 1, attention: [] })
        ]);
        assert.equal((html.match(/<tr class="low">/g) || []).length, 2, '頁首接續 0.9、跨兩題 0.85 都標橘底');
        assert.match(html, /請特別確認：頁首接續上一頁（欄）/);
        assert.match(html, /橘底 2 題/);
        assert.match(html, /不論分數多少/);
    });

    test('readApplyRows：帶出「題幹前60字」；有這一欄時留空報錯；整欄不見時回報 stemColumn=false（CLI 擋下）', () => {
        const ok = bf.readApplyRows('題號,題幹前60字,圖檔暫存路徑\r\n3,質量 2 kg 的物體,q3.png\r\n4,,q4.png\r\n');
        assert.equal(ok.stemColumn, true);
        assert.deepEqual(ok.rows.map(r => [r.id, r.stem]), [[3, '質量 2 kg 的物體']]);
        assert.equal(ok.errors.length, 1);
        assert.match(ok.errors[0], /題號 4.*「題幹前60字」是空的/);
        const none = bf.readApplyRows('題號,圖檔暫存路徑\r\n3,q3.png\r\n');
        assert.equal(none.stemColumn, false);
        assert.deepEqual(none.errors, []);
    });

    test('stemMatches：以 stemPreview 重算題庫現值逐字比；已封存前綴、Excel 公式防護的 \'、Big5 另存的「?」不算不同', () => {
        const { stemPreview } = require('../../scripts/migrate_chapters');
        const text = '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。這一題很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長。';
        assert.equal(bf.stemMatches(stemPreview(text), text), true);
        assert.equal(bf.stemMatches(stemPreview(text, true), text), true, '產生提議檔時已封存、現在解除封存');
        assert.equal(bf.stemMatches(stemPreview(text), text.replace('$2$', '$3$')), false, '題目被改過');
        assert.equal(bf.stemMatches(stemPreview('另一題：物體由靜止出發'), text), false, '同題號是別的題（另一個資料庫）');
        assert.equal(bf.stemMatches(stemPreview('-3 是方程式的根嗎？'), '-3 是方程式的根嗎？'), true);
        assert.equal(bf.stemMatches(stemPreview(text).replace('質', '?'), text), true, 'Big5 沒有的字變成「?」');
        assert.equal(bf.stemMatches('  ', text), false);
        assert.equal(bf.stemMatches(stemPreview(text), null), false);
    });
});

describe('scripts/backfill_figures — --use-llm 的花費煞車（審查修正）', () => {
    const GEMINI = 'gemini:gemini-3.5-flash';                 // input US$1.5／百萬 token
    const pricedCtx = (models, pdfChunkPages = 1) => ({
        job: {},
        llm: { generateJson: async () => ({ data: {}, usage: { tokenIn: 1_000_000, tokenOut: 0 } }) },
        config: { models, thresholds: { pdfChunkPages } }
    });
    const spending = async (ctx) => {
        await ctx.llm.generateJson({ model: ctx.config.models.extract });
        return { kind: 'pass', data: { questions: [] } };
    };
    const run = (budget, models = { extract: GEMINI }, pageCount = 5) => bf.llmProposals({
        bytes: Buffer.from('x'), pageCount, pdfRel: 'a.pdf', pdfAbs: '/a.pdf', sha: 's', candidates: [], group: 'math_physics',
        extractRun: spending, makeCtx: () => pricedCtx(models), budget
    });

    test('callCostUsd：照 config/pricing.js；本機模型 0；價目表查不到的雲端模型以最貴的單價估', () => {
        const pricing = require('../../config/pricing');
        assert.equal(bf.callCostUsd(GEMINI, { tokenIn: 1_000_000 }), 1.5);
        assert.equal(bf.callCostUsd('ollama:qwen3-vl:8b', { tokenIn: 1_000_000 }), 0);
        const maxIn = Math.max(...Object.values(pricing.PRICING).filter(r => r.verified_on).map(r => r.input));
        assert.equal(bf.callCostUsd('gemini:gemini-9-unknown', { tokenIn: 1_000_000 }), maxIn);
        assert.equal(bf.isFreeModel('ollama:qwen3:8b'), true);
        assert.equal(bf.isFreeModel(GEMINI), false);
        assert.deepEqual(bf.extractModelSpecs({ extract: 'ollama:qwen3-vl:8b', ocrStructure: 'ollama:qwen3:8b' }), ['ollama:qwen3-vl:8b', 'ollama:qwen3:8b'],
            '本機路徑另外呼叫 OCR 結構化模型');
        assert.deepEqual(bf.extractModelSpecs({ extract: GEMINI, verify: 'gemini:gemini-3.7-flash' }), [GEMINI]);
    });

    test('當日上限 DAILY_COST_BUDGET_USD：job_events 今天已花的＋這一次已花的 ≥ 上限就不再呼叫', async () => {
        let reads = 0;
        const budget = bf.createLlmBudget({ perPdfUsd: 100, dailyUsd: 5, readDailySpent: async () => { reads += 1; return 2; } });
        const r = await run(budget);
        assert.equal(r.stats.chunks, 2, '2＋1.5＝3.5 < 5 → 再一塊；2＋3＝5 → 停');
        assert.deepEqual(r.spend, { usd: 3, skippedChunks: 3, stoppedBy: 'daily_budget' });
        assert.equal(reads, 1, '當日花費只查一次');
        assert.equal(budget.state.spentUsd, 3);
        const next = await run(budget);
        assert.equal(next.stats.chunks, 0, '下一份卷一塊都不呼叫');
        assert.equal(budget.state.skippedPdfs, 1);
        assert.equal(budget.state.stoppedBy, 'daily_budget');
    });

    test('每份卷上限 JOB_COST_BUDGET_USD：這份卷已花 ≥ 上限就停；下一份卷重新計算', async () => {
        const budget = bf.createLlmBudget({ perPdfUsd: 0.5, dailyUsd: 100, readDailySpent: async () => 0 });
        const a = await run(budget);
        assert.equal(a.stats.chunks, 1);
        assert.deepEqual(a.spend, { usd: 1.5, skippedChunks: 4, stoppedBy: 'pdf_budget' });
        const b = await run(budget);
        assert.equal(b.stats.chunks, 1, '下一份卷照樣可以呼叫');
        assert.equal(budget.state.spentUsd, 3);
    });

    test('本機模型不查帳、不擋；查帳失敗就不呼叫', async () => {
        const local = bf.createLlmBudget({ perPdfUsd: 0.01, dailyUsd: 0.01, readDailySpent: async () => { throw new Error('不該查帳'); } });
        assert.deepEqual(bf.describeLlmSpend(local.state), [], '沒有卷需要模型時不印花費');
        const r = await run(local, { extract: 'ollama:qwen3-vl:8b', ocrStructure: 'ollama:qwen3:8b' });
        assert.equal(r.stats.chunks, 5);
        assert.equal(r.spend.usd, 0);
        assert.equal(local.state.paid, false);
        assert.match(bf.describeLlmSpend(local.state).join('\n'), /本機模型（不花錢）/);

        const broken = bf.createLlmBudget({ perPdfUsd: 100, dailyUsd: 100, readDailySpent: async () => { throw new Error('連不上資料庫'); } });
        const b = await run(broken);
        assert.equal(b.stats.chunks, 0);
        assert.equal(b.spend.stoppedBy, 'ledger_error');
        assert.match(bf.describeLlmSpend(broken.state).join('\n'), /讀不到今天的花費.*連不上資料庫/);
    });

    test('dry-run：當日上限已用完 → 一次都不呼叫模型，確定性比對照做；結尾印出原因', async () => {
        const dir = path.join(TMP, '各校考卷-預算');
        fs.mkdirSync(path.join(dir, '掃描'), { recursive: true });
        fs.writeFileSync(path.join(dir, '自製附圖卷.pdf'), await fx.makeFigurePdf());
        fs.writeFileSync(path.join(dir, '掃描', '掃描卷.pdf'), await fx.makeScannedPdf());
        const db = {
            query: async () => ({ rows: [{ id: 9, subject: '物理', chapter: 'x', source_detail: null, archived: false, pdf_shas: [], job_ids: [],
                question_text: '馬拉車前進時，馬對車的作用力 $F$ 與車對馬的反作用力，兩者的關係為何？' }] })
        };
        let called = 0;
        const llmBudget = bf.createLlmBudget({ perPdfUsd: 0.5, dailyUsd: 5, readDailySpent: async () => 5 });
        const r = await bf.dryRun({
            db, dir, outDir: path.join(TMP, 'out-budget'), useLlm: true, llmBudget, logger: { warn() { } },
            extractRun: async () => { called += 1; return { kind: 'pass', data: { questions: [] } }; },
            makeCtx: () => pricedCtx({ extract: GEMINI }, 20)
        });
        assert.equal(called, 0);
        assert.deepEqual(r.proposals.map(p => p.id), [9], '不花錢的確定性比對照常提議');
        assert.equal(r.stats.llm.pdfs, 0);
        assert.equal(r.stats.llmSpend.stoppedBy, 'daily_budget');
        assert.equal(r.stats.llmSpend.skippedPdfs, 1, '只有掃描檔需要模型');
        assert.match(bf.describeLlmSpend(r.stats.llmSpend).join('\n'), /已達當日上限 DAILY_COST_BUDGET_USD＝US\$5\.0000/);
    });

    test('describeLlmPlan：雲端付費模型先印出上限；本機模型說明不花錢', () => {
        const paid = bf.describeLlmPlan({ models: { extract: GEMINI, verify: 'gemini:gemini-3.7-flash' }, perPdfUsd: 0.5, dailyUsd: 5 }).join('\n');
        assert.match(paid, /雲端付費模型：gemini:gemini-3\.5-flash/);
        assert.match(paid, /每份卷 US\$0\.5000（JOB_COST_BUDGET_USD）、當日 US\$5\.0000（DAILY_COST_BUDGET_USD/);
        const local = bf.describeLlmPlan({ models: { extract: 'ollama:qwen3-vl:8b', ocrStructure: 'ollama:qwen3:8b' }, perPdfUsd: 0.5, dailyUsd: 5 }).join('\n');
        assert.match(local, /本機模型.*不花錢/);
    });

    test('模型框圖也比數字：中文相似度同分時數字相符的題得；只有數字不符的題時標「數字不一致」、分數 ≤ 0.7', async () => {
        const cand = (id, text) => ({ id, text, subject: '物理', chapter: 'x', lowAnchor: false, pdfShas: [], jobIds: [], hint: false, sourceDetail: null });
        const five = cand(5, '質量 $2$ kg 的物體受到合力 $10$ N，求其加速度。');
        const fiftyFive = cand(55, '質量 $3$ kg 的物體受到合力 $12$ N，求其加速度。');
        const extractRun = async () => ({ kind: 'pass', data: { questions: [
            { question_text: '質量 $3$ kg 的物體受到合力 $12$ N，求其加速度。', figure_page: 1, figure_box: [100, 100, 300, 300] }
        ] } });
        const args = { bytes: Buffer.from('x'), pageCount: 1, pdfRel: 'a.pdf', pdfAbs: '/a.pdf', sha: 's', group: 'math_physics', extractRun,
            makeCtx: () => ({ config: { models: { extract: 'fake:vision' }, thresholds: { pdfChunkPages: 20 } } }) };
        const both = await bf.llmProposals({ ...args, candidates: [five, fiftyFive] });
        assert.deepEqual(both.proposals.map(p => [p.id, p.detail, p.score]), [[55, 1, 1]]);
        const only = await bf.llmProposals({ ...args, candidates: [five] });
        const p = only.proposals[0];
        assert.equal(p.detailMismatch, true);
        assert.ok(p.score <= 0.7);
        assert.match(bf.basisText(p), /^模型框圖（fake:vision）；題幹相似 1\.00；數字不一致（/);
        assert.deepEqual(bf.attentionReasons(p).sort(), ['分數低於 0.8', '數字不一致', '模型框圖'].sort());
    });
});

describe('scripts/windows/backfill_figures.bat（老師雙擊用）', () => {
    const buf = () => fs.readFileSync(BAT);
    const text = () => buf().toString('utf8');
    const commandLines = (t) => t.split('\r\n').map(l => l.trim()).filter(l => l && !/^rem(\s|$)/i.test(l) && !l.startsWith('::'));

    test('CRLF 行尾、UTF-8 無 BOM、開頭 @echo off＋chcp 65001', () => {
        assert.notEqual(buf().subarray(0, 3).toString('hex'), 'efbbbf');
        assert.ok(Buffer.from(text(), 'utf8').equals(buf()));
        assert.ok(!/[^\r]\n/.test(text()) && text().endsWith('\r\n'));
        const lines = text().split('\r\n');
        assert.equal(lines[0], '@echo off');
        assert.equal(lines[1], 'chcp 65001 >nul');
    });

    test('只跑 dry-run：執行的指令沒有 --apply；原卷資料夾不寫死（由參數或拖曳給）；輸出寫 log', () => {
        const cmds = commandLines(text()).filter(l => !/^(echo|call :log)/i.test(l));
        assert.ok(cmds.some(l => /backfill_figures\.js" --dir "%PDFDIR%" --out-dir "%OUT%"/.test(l)), '要以 --dir 與 --out-dir 呼叫');
        assert.ok(!cmds.some(l => /--apply|--use-llm/.test(l)), '雙擊只跑 dry-run，不套用、不呼叫 LLM');
        assert.ok(!/Desktop|桌面\\/i.test(cmds.join('\n')), '原卷路徑不可寫死');
        assert.match(text(), /tee_run\.js/);
        assert.match(text(), /proposals\.csv/);
    });

    test('每一個 goto／call 的標籤都存在；成功與失敗的出口前都有 pause；echo 裡沒有會被 cmd 當成轉向的字元', () => {
        const t = text();
        const labels = new Set(t.split('\r\n').filter(l => /^:[A-Za-z_]\w*\s*$/.test(l)).map(l => l.trim().slice(1).toLowerCase()));
        for (const m of t.matchAll(/(?:goto|call)\s+:(\w+)/gi)) {
            if (m[1].toLowerCase() === 'eof') continue;
            assert.ok(labels.has(m[1].toLowerCase()), `找不到標籤 :${m[1]}`);
        }
        assert.ok(commandLines(t).filter(l => /^exit \/b (0|1)$/i.test(l)).length >= 2);
        assert.ok((t.match(/\r\npause\r\n/g) || []).length >= 2);
        for (const l of commandLines(t)) {
            if (!/^(echo|call :log)/i.test(l)) continue;
            const bare = l.replace(/"[^"]*"/g, '').replace(/\^[|<>&]/g, '');
            assert.ok(!/[<>|&]/.test(bare), l);
        }
    });

    test('package.json 有 figures:backfill', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['figures:backfill'], 'node scripts/backfill_figures.js');
    });
});
