// services/wordService.js 本機附圖嵌入的單元測試（docs/figures.md「Word 匯出」段）
//
// 圖一律在測試內用 sharp 現做（純色小 PNG），不放任何真實考卷內容進 repo。
// 附圖目錄用 generateExamPaperDocx 的 options.figuresDir 注入暫存目錄，不碰 data/figures/。
// .docx 解壓沿用 e2e 的零相依 zip 讀取器（test/e2e/lib/docx.js）。
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const wordService = require('../../services/wordService');
const { resolveFigurePath, fitFigureSize, FIGURE_MISSING_TEXT, FIGURE_MAX_WIDTH_PX } = wordService;
const { documentXml, readEntry, listEntries } = require('../e2e/lib/docx');

const EMU_PER_PX = 9525;

function makePng(width, height) {
    return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
}

function question(id, question_img) {
    return { id, question_type: '填空', difficulty: 2, question_text: `自製測試題 ${id}`, answer_text: '1', question_img };
}

function captureLogger() {
    const warns = [];
    return { warns, warn: (o) => warns.push(o) };
}

/** document.xml 裡每個 <wp:extent> 的 cx／cy（EMU）。 */
function extents(xml) {
    return [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(m => ({ cx: Number(m[1]), cy: Number(m[2]) }));
}

describe('wordService — resolveFigurePath（防 path traversal）', () => {
    const dir = path.resolve(os.tmpdir(), 'figs-root');

    test('合法 /figures/<檔名> → 附圖目錄內的絕對路徑', () => {
        assert.equal(resolveFigurePath('/figures/12-3.png', dir), path.join(dir, '12-3.png'));
        assert.equal(resolveFigurePath('/figures/a_b-C.JPG', dir), path.join(dir, 'a_b-C.JPG'));
    });

    test('跳目錄、編碼、子目錄、反斜線、非圖檔副檔名一律回 null', () => {
        for (const bad of [
            '/figures/../.env',
            '/figures/../../etc/passwd.png',
            '/figures/%2e%2e%2fsecret.png',
            '/figures/sub/1-1.png',
            '/figures/..\\1-1.png',
            '/figures/1-1.png.exe',
            '/figures/.png',
            '/figures/1-1.svg',
            'figures/1-1.png',
            '/uploads/1-1.png',
            'https://example.com/figures/1-1.png',
            null,
            undefined
        ]) {
            assert.equal(resolveFigurePath(bad, dir), null, `應拒絕：${bad}`);
        }
    });

    test('白名單放寬時，第二道「resolve 後仍在附圖目錄內」檢查仍擋住跳目錄', () => {
        const loose = /^\/figures\/(.+)$/; // 故意放寬：允許 / \ 與 ..
        for (const bad of [
            '/figures/../.env',
            '/figures/../../etc/passwd.png',
            '/figures/sub/1-1.png',
            // 反斜線只在 Windows 是路徑分隔符；POSIX 上 `..\1-1.png` 是目錄內的普通檔名（嚴格白名單另行擋下）
            ...(process.platform === 'win32' ? ['/figures/..\\1-1.png'] : [])
        ]) {
            assert.equal(resolveFigurePath(bad, dir, loose), null, `目錄檢查應拒絕：${bad}`);
        }
        assert.equal(resolveFigurePath('/figures/1-1.png', dir, loose), path.join(dir, '1-1.png'));
    });
});

describe('wordService — fitFigureSize（等比例縮放）', () => {
    test('小圖：144 DPI 換回 96 DPI 的原卷實際大小（×2/3），不放大', () => {
        assert.deepEqual(fitFigureSize(300, 150), { width: 200, height: 100 });
    });

    test('寬圖：夾在可用寬度內，比例不變', () => {
        const r = fitFigureSize(3000, 1000);
        assert.equal(r.width, FIGURE_MAX_WIDTH_PX);
        assert.equal(r.height, 200);
    });

    test('高瘦圖：夾在可用高度內，比例不變', () => {
        const r = fitFigureSize(600, 3000);
        assert.equal(r.height, 800);
        assert.equal(r.width, 160);
    });
});

describe('wordService — generateExamPaperDocx 嵌入本機附圖', () => {
    let figuresDir;
    let outsideDir;

    before(async () => {
        figuresDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-figures-'));
        outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-outside-'));
        fs.writeFileSync(path.join(figuresDir, '900-1.png'), await makePng(300, 150));
        fs.writeFileSync(path.join(figuresDir, '900-2.png'), await makePng(3000, 1000));
        fs.writeFileSync(path.join(figuresDir, '900-3.png'), Buffer.from('這不是圖檔'));
        // 放在附圖目錄**外面**的真圖：路徑檢查若失守，它會被嵌進 Word
        fs.writeFileSync(path.join(outsideDir, 'leak.png'), await makePng(40, 40));
    });

    after(() => {
        fs.rmSync(figuresDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    test('有附圖的題：word/media 有 PNG、document.xml 有 drawing 且關聯到該圖，尺寸等比例', async () => {
        const logger = captureLogger();
        const buf = await wordService.generateExamPaperDocx('測試卷', '測試生', [
            question(1, '/figures/900-1.png'),
            question(2, '/figures/900-2.png')
        ], { figuresDir, logger });

        const media = listEntries(buf).filter(n => n.startsWith('word/media/') && !n.endsWith('/'));
        assert.equal(media.length, 2, `word/media 應有兩張圖，實際：${media.join('、')}`);
        assert.ok(media.every(n => n.endsWith('.png')), `副檔名必須是 .png（缺 type 會落成 .undefined）：${media.join('、')}`);

        const xml = documentXml(buf);
        assert.equal((xml.match(/<w:drawing>/g) || []).length, 2);
        assert.ok(!xml.includes(FIGURE_MISSING_TEXT));

        // drawing 的 r:embed 必須在 document.xml.rels 裡指到 media 檔
        const rels = readEntry(buf, 'word/_rels/document.xml.rels').toString('utf8');
        const embeds = [...xml.matchAll(/r:embed="([^"]+)"/g)].map(m => m[1]);
        assert.equal(embeds.length, 2);
        for (const rid of embeds) {
            assert.match(rels, new RegExp(`Id="${rid}"[^>]*Target="media/[^"]+\\.png"`), `找不到 ${rid} 的圖片關聯`);
        }

        // 題幹後才是圖：第 1 題題幹在第一個 drawing 之前
        assert.ok(xml.indexOf('自製測試題 1') < xml.indexOf('<w:drawing>'));

        const [small, wide] = extents(xml);
        assert.deepEqual(small, { cx: 200 * EMU_PER_PX, cy: 100 * EMU_PER_PX });
        assert.deepEqual(wide, { cx: FIGURE_MAX_WIDTH_PX * EMU_PER_PX, cy: 200 * EMU_PER_PX });
        assert.equal(logger.warns.length, 0);

        const types = readEntry(buf, '[Content_Types].xml').toString('utf8');
        assert.match(types, /Extension="png"/);
    });

    test('圖檔不存在或不是圖：整份照樣產出，放「（附圖遺失）」並 warn', async () => {
        const logger = captureLogger();
        const buf = await wordService.generateExamPaperDocx('測試卷', '測試生', [
            question(11, '/figures/does-not-exist.png'),
            question(12, '/figures/900-3.png'),
            question(13, '/figures/900-1.png')
        ], { figuresDir, logger });

        const xml = documentXml(buf);
        assert.equal((xml.match(new RegExp(FIGURE_MISSING_TEXT, 'g')) || []).length, 2);
        assert.equal((xml.match(/<w:drawing>/g) || []).length, 1, '讀得到的那張仍要嵌入');
        assert.ok(xml.includes('自製測試題 11') && xml.includes('自製測試題 12') && xml.includes('自製測試題 13'));
        assert.deepEqual(logger.warns.map(w => w.question_id), [11, 12]);
    });

    test('path traversal：不讀附圖目錄外的檔，放「（附圖遺失）」並 warn', async () => {
        const logger = captureLogger();
        const rel = path.relative(figuresDir, path.join(outsideDir, 'leak.png')).split(path.sep).join('/');
        const buf = await wordService.generateExamPaperDocx('測試卷', '測試生', [
            question(21, `/figures/${rel}`),
            question(22, '/figures/../leak.png')
        ], { figuresDir, logger });

        assert.equal(listEntries(buf).filter(n => n.startsWith('word/media/') && !n.endsWith('/')).length, 0, '附圖目錄外的圖被嵌進 Word 了');
        const xml = documentXml(buf);
        assert.ok(!xml.includes('<w:drawing>'));
        assert.equal((xml.match(new RegExp(FIGURE_MISSING_TEXT, 'g')) || []).length, 2);
        assert.equal(logger.warns.length, 2);
    });

    test('沒有 question_img 的題：不插圖也不放遺失標示（既有行為不變）', async () => {
        const logger = captureLogger();
        const buf = await wordService.generateExamPaperDocx('測試卷', '測試生', [question(31, null), question(32, '')], { figuresDir, logger });
        const xml = documentXml(buf);
        assert.ok(!xml.includes('<w:drawing>'));
        assert.ok(!xml.includes(FIGURE_MISSING_TEXT));
        assert.equal(logger.warns.length, 0);
    });
});
