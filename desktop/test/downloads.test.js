// desktop/test/downloads.test.js — Word 下載的「另存新檔」預設值（lib/downloads.js；第 3 條第 5 項）
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DL = require('../lib/downloads');

const W = path.win32;
const DOCS = 'C:\\Users\\Administrator\\Documents';

describe('另存新檔的預設值', () => {
    test('第一次：文件\\出卷＋前端 download 屬性給的檔名；.docx 列 Word 文件', () => {
        const o = DL.saveDialogOptions({ filename: '112 上 段考一（學生版）.docx', lastDir: null, documentsDir: DOCS, pathImpl: W });
        assert.equal(o.title, '另存新檔');
        assert.equal(o.defaultPath, 'C:\\Users\\Administrator\\Documents\\出卷\\112 上 段考一（學生版）.docx');
        assert.deepEqual(o.filters.map(f => f.name), ['Word 文件', '所有檔案']);
        assert.deepEqual(o.filters[0].extensions, ['docx']);
    });

    test('之後：上次存檔的資料夾（還在的話）', () => {
        const o = DL.saveDialogOptions({ filename: 'a.docx', lastDir: 'D:\\教材\\段考', documentsDir: DOCS, exists: () => true, pathImpl: W });
        assert.equal(o.defaultPath, 'D:\\教材\\段考\\a.docx');
        const gone = DL.saveDialogOptions({ filename: 'a.docx', lastDir: 'E:\\隨身碟', documentsDir: DOCS, exists: () => false, pathImpl: W });
        assert.equal(gone.defaultPath, 'C:\\Users\\Administrator\\Documents\\出卷\\a.docx');
    });

    test('不是 .docx：只列所有檔案', () => {
        assert.deepEqual(DL.saveDialogOptions({ filename: 'x.csv', documentsDir: DOCS, pathImpl: W }).filters.map(f => f.name), ['所有檔案']);
    });

    test('記住的資料夾＝存檔路徑的上一層；沒選（取消）不記', () => {
        assert.equal(DL.rememberedDir('D:\\教材\\段考\\a.docx', W), 'D:\\教材\\段考');
        assert.equal(DL.rememberedDir('', W), null);
        assert.equal(DL.rememberedDir(null, W), null);
    });
});

describe('檔名清理', () => {
    test('Windows 不能用的字元換成 _；中文、全形括號保留', () => {
        assert.equal(DL.sanitizeFileName('期中考 1/2：幾何*版本?.docx'), '期中考 1_2：幾何_版本_.docx');
        assert.equal(DL.sanitizeFileName('a<b>c"d|e.docx'), 'a_b_c_d_e.docx');
        assert.equal(DL.sanitizeFileName('112 上 段考一（學生版）.docx'), '112 上 段考一（學生版）.docx');
    });

    test('結尾的點與空白去掉；空的、全是非法字元、保留裝置名都有替代', () => {
        assert.equal(DL.sanitizeFileName('abc. . '), 'abc');
        assert.equal(DL.sanitizeFileName(''), '下載的檔案');
        assert.equal(DL.sanitizeFileName('///'), '下載的檔案');
        assert.equal(DL.sanitizeFileName('CON.docx'), '_CON.docx');
        assert.equal(DL.sanitizeFileName('\u0001x.docx'), '_x.docx');
    });
});
