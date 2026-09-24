// ─────────────────────────────────────────────────────────────
// kcCli.test.js — npm run kc:load／kc:backfill 的參數解析與輸出（階段 5 WS-C；第 4.3 條第 1、3 點）
//
// 兩支腳本 require 時不跑 main、不讀 .env、不連 DB（dotenv 只在直接執行時載入），
// 所以這裡可以直接測純函式。真的對資料庫跑的版本在 test/integration/kcLoad.pg.test.js
// 與 kcTagging.pg.test.js（以子行程執行 CLI）。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = require('../../scripts/load_kc');
const backfill = require('../../scripts/backfill_kc');
const pkg = require('../../package.json');

describe('package.json 的三個 script（第 4.3 條）', () => {
    test('kc:load、kc:validate、kc:backfill 指向正確的檔', () => {
        assert.equal(pkg.scripts['kc:load'], 'node scripts/load_kc.js');
        assert.equal(pkg.scripts['kc:validate'], 'node scripts/validate_kc_seed.js');
        assert.equal(pkg.scripts['kc:backfill'], 'node scripts/backfill_kc.js');
    });

    test('require 腳本不會把 .env 讀進行程、不建連線池', () => {
        assert.equal(process.env.DATABASE_URL, undefined);
    });
});

describe('load_kc.js parseArgs', () => {
    test('預設值', () => {
        assert.deepEqual(load.parseArgs([]), { files: [], dryRun: false, force: false, test: false });
    });

    test('--file 可重複，--dry-run／--force／--test', () => {
        assert.deepEqual(load.parseArgs(['--file', 'a.json', '--dry-run', '--file', 'b.json', '--force', '--test']),
            { files: ['a.json', 'b.json'], dryRun: true, force: true, test: true });
    });

    test('--file 後面沒有路徑、未知參數 → 丟錯（不默默忽略）', () => {
        assert.throws(() => load.parseArgs(['--file']), /--file/);
        assert.throws(() => load.parseArgs(['--file', '--force']), /--file/);
        assert.throws(() => load.parseArgs(['--forse']), /未知的參數/);
    });

    test('resolveFiles：有 --file 就只讀那些（轉成絕對路徑）', () => {
        const files = load.resolveFiles({ files: ['test/fixtures/kc/數學.json'] });
        assert.equal(files.length, 1);
        assert.ok(path.isAbsolute(files[0]));
    });

    test('formatReport：新增、更新、略過（內容相同＋受保護）分開列；受保護時提示 --force', () => {
        const res = {
            stats: { '數學': { components: 9, chapters: 2, approved: 4 } },
            counts: { inserted: 3, updated: 2, unchanged: 1, protected: 4, prereqInserted: 5, prereqRemoved: 1, orphans: 2 }
        };
        const lines = load.formatReport(res, { dryRun: false, force: false });
        assert.ok(lines.some(l => l.includes('新增 3、更新 2、略過 5（內容相同 1、已審定受保護 4）')), lines.join('\n'));
        assert.ok(lines.some(l => l.includes('--force')));
        assert.ok(lines.some(l => l.includes('2 個知識點不在這次的種子檔中')));
        assert.ok(load.formatReport(res, { dryRun: true, force: false }).some(l => l.startsWith('（dry-run，已回滾）')));
        assert.ok(!load.formatReport({ ...res, counts: { ...res.counts, protected: 0, orphans: 0 } }, { dryRun: false, force: false })
            .some(l => l.includes('--force')));
    });

    // 〔stage5 審查修正 S5-43〕
    test('formatReport：老師改過的草稿另列一類並逐條列出 code；--force 時改說「已覆寫」', () => {
        const res = {
            stats: {},
            counts: { inserted: 0, updated: 1, unchanged: 5, protected: 1, edited: 2, prereqInserted: 0, prereqRemoved: 0, orphans: 0 },
            editedCodes: ['CHEM.化學計量.02', 'CHEM.化學計量.03']
        };
        const lines = load.formatReport(res, { dryRun: false, force: false });
        assert.ok(lines.some(l => l.includes('略過 8（內容相同 5、已審定受保護 1、老師改過的草稿受保護 2）')), lines.join('\n'));
        assert.ok(lines.some(l => l.includes('老師在「知識點」分頁改過，沒有被覆寫：CHEM.化學計量.02、CHEM.化學計量.03')), lines.join('\n'));
        const forced = load.formatReport({ ...res, counts: { ...res.counts, edited: 0, updated: 3 } }, { dryRun: false, force: true });
        assert.ok(forced.some(l => l.startsWith('⚠️ --force') && l.includes('已用種子檔的內容覆寫：CHEM.化學計量.02、CHEM.化學計量.03')), forced.join('\n'));
    });
});

describe('backfill_kc.js parseArgs', () => {
    test('預設值與全部參數', () => {
        assert.deepEqual(backfill.parseArgs([]), { dryRun: false, limit: null, subject: null, test: false });
        assert.deepEqual(backfill.parseArgs(['--dry-run', '--limit', '20', '--subject', '物理', '--test']),
            { dryRun: true, limit: 20, subject: '物理', test: true });
    });

    test('--limit 只收正整數；--subject 要有值；未知參數丟錯', () => {
        for (const bad of ['0', '-3', '1.5', 'abc', undefined]) {
            assert.throws(() => backfill.parseArgs(['--limit', bad]), /--limit/, String(bad));
        }
        assert.throws(() => backfill.parseArgs(['--subject']), /--subject/);
        assert.throws(() => backfill.parseArgs(['--subject', '--dry-run']), /--subject/);
        assert.throws(() => backfill.parseArgs(['--all']), /未知的參數/);
    });

    test('progressLine：各狀態一行，不印題幹', () => {
        assert.equal(backfill.progressLine(1, 3, {
            question_id: 12, status: 'tagged', written: [{ code: 'MATH.向量內積.02', confidence: 0.912 }], dropped: []
        }), '[1/3] #12 tagged：MATH.向量內積.02(0.91)');
        assert.equal(backfill.progressLine(2, 3, { question_id: 13, status: 'skipped', reason: 'has_human', written: [], dropped: [] }),
            '[2/3] #13 skipped（has_human）');
        assert.ok(backfill.progressLine(3, 3, { question_id: 14, status: 'failed', reason: 'provider_error', message: 'x\ny', written: [], dropped: [] })
            .endsWith('（provider_error）x'));
        assert.ok(backfill.progressLine(3, 3, {
            question_id: 15, status: 'low_confidence', written: [], dropped: [{ code: 'MATH.向量內積.01', confidence: 0.3 }]
        }).includes('MATH.向量內積.01(0.30) 都低於門檻'));
    });
});