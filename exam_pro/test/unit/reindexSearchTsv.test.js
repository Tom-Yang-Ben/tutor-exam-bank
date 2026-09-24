// scripts/reindex_search_tsv.js 的純函式部分（階段 5 WS-B；docs/chemistry.md 第 4.3 節）
//
// 連資料庫的部分（重算、dry-run、與題目 API 寫入端逐字相同）在 test/integration/searchReindex.pg.test.js。
// 純單元測試：不連 DB、不連 LLM。執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, lexemesOf, TSV_EXPR, reindexSearchTsv } = require('../../scripts/reindex_search_tsv');

describe('scripts/reindex_search_tsv.js', () => {
    test('參數：預設值、四個旗標；未知參數與不合法的 --limit 丟錯', () => {
        assert.deepEqual(parseArgs([]), { dryRun: false, test: false, limit: null, help: false });
        assert.deepEqual(parseArgs(['--dry-run', '--test', '--limit', '5']), { dryRun: true, test: true, limit: 5, help: false });
        assert.equal(parseArgs(['-h']).help, true);
        assert.throws(() => parseArgs(['--force']), /未知的參數/);
        for (const bad of ['0', '-1', 'x', '1.5', undefined]) {
            assert.throws(() => parseArgs(bad === undefined ? ['--limit'] : ['--limit', bad]), /--limit/, String(bad));
        }
    });

    test('lexemesOf：tsvector 文字形式 → 詞位（含單引號跳脫）', () => {
        assert.deepEqual(lexemesOf("'238':3B '數為':2B '質量':1B"), ['238', '數為', '質量']);
        assert.deepEqual(lexemesOf("'it''s':1A"), ["it's"]);
        assert.deepEqual(lexemesOf(null), []);
        assert.deepEqual(lexemesOf(''), []);
    });

    test('權重與寫入端相同：章節 A、關鍵詞 A、題幹 B（$2／$3／$4）', () => {
        const flat = TSV_EXPR.replace(/\s+/g, ' ');
        assert.match(flat, /array_to_string\(\$2::text\[\], ' '\)\), 'A'\)/);
        assert.match(flat, /array_to_string\(\$3::text\[\], ' '\)\), 'A'\)/);
        assert.match(flat, /array_to_string\(\$4::text\[\], ' '\)\), 'B'\)/);
    });

    // 〔stage5 審查修正〕與老師同時編輯的競態
    test('正式跑時每批 SELECT … FOR UPDATE 鎖列（讀題幹到寫回之間不讓 PUT 插進來）；dry-run 不鎖', async () => {
        for (const dryRun of [false, true]) {
            const sqls = [];
            const client = {
                async query(text) {
                    sqls.push(text);
                    if (/FROM questions WHERE id = ANY/.test(text)) return { rows: [] };
                    return { rows: [] };
                },
                release() { }
            };
            const db = {
                async query() { return { rows: [{ id: 1 }] }; },
                pool: { async connect() { return client; } }
            };
            await reindexSearchTsv({ db, dryRun });
            const select = sqls.find(t => /FROM questions WHERE id = ANY/.test(t));
            assert.equal(/FOR UPDATE/.test(select), !dryRun, `dryRun=${dryRun}：${select}`);
        }
    });
});
