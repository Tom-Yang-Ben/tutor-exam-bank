// ─────────────────────────────────────────────────────────────
// test/unit/recordEmbeddings.test.js — eval/record_embeddings.js 的純函式（〔章節重整 CH-B〕）
//
// 章節重整後 `npm run cassettes:rerecord` 的第一步是 `node eval/record_embeddings.js --only-missing`，
// 寫檔也從「整檔覆寫」改成「併入」（eval/README.md 第 3f 節）。這一支守的是這兩個行為：
//   1. embedTargets：同一段 embed_text 只列一次、present 旗標照向量檔判斷；
//   2. selectTargets：--only-missing 只挑向量檔裡沒有的，沒加就全部；
//   3. mergeTable：鍵依字典序、新錄的值蓋過舊值、不改動傳入的表；舊鍵一律保留（孤兒向量不清，見 README 第 3f 節）；
//   4. readTable：檔案不存在回空表，壞檔照樣丟錯。
// 不連網、不呼叫 embed()：main() 的錄製迴圈要金鑰，只在 Owner 本機跑。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rec = require('../../eval/record_embeddings');
const { buildEmbedText, embedHash } = require('../../eval/lib/embedText');
const { loadEmbeddings } = require('../../eval/lib/embeddings');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'record-embeddings-test-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 最小的 fixture 題（buildEmbedText 需要的欄位） */
function q(id, over = {}) {
    return { id, subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 2, question_text: `題 ${id}`, ...over };
}
const hashOf = (question) => embedHash(buildEmbedText(question));

describe('embedTargets：fixture 題 → 相異的 embed_text', () => {
    test('同一段 embed_text 只列一次，ids 依出現順序收齊；順序是第一次出現的順序', () => {
        const a = q(1, { question_text: '甲' });
        const b = q(2, { question_text: '乙' });
        const aDup = q(3, { question_text: '甲' });   // 與 #1 的 embed_text 完全相同
        const targets = rec.embedTargets([a, b, aDup], {});
        assert.equal(targets.length, 2);
        assert.deepEqual(targets.map(t => t.ids), [[1, 3], [2]]);
        assert.equal(targets[0].hash, hashOf(a));
        assert.equal(targets[0].text, buildEmbedText(a));
    });

    test('present 照向量檔判斷：有這個鍵就是 true（值是什麼不管）', () => {
        const a = q(1, { question_text: '甲' });
        const b = q(2, { question_text: '乙' });
        const targets = rec.embedTargets([a, b], { [hashOf(a)]: [0.1, 0.2] });
        assert.deepEqual(targets.map(t => t.present), [true, false]);
    });

    test('章名改了 → embed_text 第一行變了 → 鍵不同，舊向量對不上（改標的題因此要補錄）', () => {
        const before = q(1, { chapter: '指數與對數' });
        const after = q(1, { chapter: '指數函數與對數函數' });
        const targets = rec.embedTargets([after], { [hashOf(before)]: [0.1] });
        assert.equal(targets[0].present, false);
    });
});

describe('selectTargets：--only-missing 的挑選', () => {
    const targets = [
        { hash: 'h1', text: 't1', ids: [1], present: true },
        { hash: 'h2', text: 't2', ids: [2, 5], present: false },
        { hash: 'h3', text: 't3', ids: [3], present: true },
        { hash: 'h4', text: 't4', ids: [4], present: false }
    ];

    test('--only-missing：只挑向量檔裡沒有的，保持原順序', () => {
        assert.deepEqual(rec.selectTargets(targets, true).map(t => t.hash), ['h2', 'h4']);
    });

    test('沒加 --only-missing：全部重送（回傳新陣列，不是同一個參照）', () => {
        const all = rec.selectTargets(targets, false);
        assert.deepEqual(all.map(t => t.hash), ['h1', 'h2', 'h3', 'h4']);
        assert.notEqual(all, targets);
    });

    test('全部都有向量時 --only-missing 挑出空陣列（main 會印「不需要錄製」並結束）', () => {
        assert.deepEqual(rec.selectTargets(targets.map(t => ({ ...t, present: true })), true), []);
    });

    test('parseArgs 認得 --only-missing，未知參數丟錯', () => {
        assert.equal(rec.parseArgs([]).onlyMissing, false);
        assert.equal(rec.parseArgs(['--only-missing', '--dry-run']).onlyMissing, true);
        assert.throws(() => rec.parseArgs(['--only-missin']), /未知的參數/);
    });

    test('對 repo 的 fixture 與向量檔：--only-missing 挑出來的題號，就是 eval 判為「查不到向量」的那幾題', () => {
        // 讀原始 fixture（不經章節閘門：CH-A 合入前，本分支 config/chapters.js 還是舊白名單）
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'eval', 'fixtures', 'questions.public.json'), 'utf8'));
        const emb = loadEmbeddings({ questions: raw.questions });
        const table = rec.readTable(emb.file);
        const picked = rec.selectTargets(rec.embedTargets(raw.questions, table), true).flatMap(t => t.ids).sort((a, b) => a - b);
        assert.deepEqual(picked, emb.missing.slice().sort((a, b) => a - b));
    });
});

describe('mergeTable：併入既有的向量檔', () => {
    test('鍵依字典序排好；新錄的值蓋過舊值；只在舊表的鍵保留', () => {
        const table = { b: [1], d: [2], a: [3] };
        const fresh = { c: [9], b: [8] };
        const merged = rec.mergeTable(table, fresh);
        assert.deepEqual(Object.keys(merged), ['a', 'b', 'c', 'd']);
        assert.deepEqual(merged.b, [8], '同一個鍵以新錄的為準');
        assert.deepEqual(merged.a, [3]);
        assert.deepEqual(merged.d, [2], '舊鍵保留：改標前舊 embed_text 的向量不會被清掉（README 第 3f 節）');
    });

    test('不改動傳入的兩張表', () => {
        const table = { b: [1] };
        const fresh = { a: [2] };
        rec.mergeTable(table, fresh);
        assert.deepEqual(table, { b: [1] });
        assert.deepEqual(fresh, { a: [2] });
    });

    test('與 JSON.stringify 的輸出相符：寫出來的檔案鍵序固定（diff 只出現真的變動）', () => {
        const merged = rec.mergeTable({ z: [1], m: [2] }, { a: [3] });
        assert.equal(JSON.stringify(merged), '{"a":[3],"m":[2],"z":[1]}');
    });
});

describe('readTable', () => {
    test('檔案不存在回空表', () => {
        assert.deepEqual(rec.readTable(path.join(tmp, '沒有這個檔.json')), {});
    });

    test('壞檔照樣丟錯（不能當成空表整份重錄，那會洗掉其他 suite 補錄的向量）', () => {
        const bad = path.join(tmp, 'bad.json');
        fs.writeFileSync(bad, '{"a":[1', 'utf8');
        assert.throws(() => rec.readTable(bad), SyntaxError);
    });

    test('正常檔讀回原內容', () => {
        const ok = path.join(tmp, 'ok.json');
        fs.writeFileSync(ok, '{"a":[0.1,0.2]}\n', 'utf8');
        assert.deepEqual(rec.readTable(ok), { a: [0.1, 0.2] });
    });
});
