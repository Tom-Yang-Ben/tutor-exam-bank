const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isPdfBuffer, SNIFF_WINDOW } = require('../../utils/pdfSniff');

describe('pdfSniff — 上傳檔頭判定', () => {
    test('標準 PDF 檔頭', () => {
        assert.equal(isPdfBuffer(Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj', 'latin1')), true);
    });
    test('檔頭前有少量垃圾位元組仍接受（規範允許）', () => {
        assert.equal(isPdfBuffer(Buffer.concat([Buffer.alloc(100, 0x20), Buffer.from('%PDF-1.4')])), true);
    });
    test('改名的文字檔、空檔、太短的 buffer 都拒絕', () => {
        assert.equal(isPdfBuffer(Buffer.from('hello world')), false);
        assert.equal(isPdfBuffer(Buffer.alloc(0)), false);
        assert.equal(isPdfBuffer(null), false);
        assert.equal(isPdfBuffer(Buffer.from('%PD')), false);
    });
    test('檔頭出現在 1024 bytes 之後不算', () => {
        assert.equal(isPdfBuffer(Buffer.concat([Buffer.alloc(SNIFF_WINDOW, 0x41), Buffer.from('%PDF-1.4')])), false);
    });
    test('Uint8Array 也接受', () => {
        assert.equal(isPdfBuffer(new TextEncoder().encode('%PDF-1.5 x')), true);
    });
});
