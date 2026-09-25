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
