// ─────────────────────────────────────────────────────────────
// extractCheckpoints.test.js — 〔Owner 第六輪 DA-13＝2，dec/r7-checkpoints〕拆題的逐塊檢查點（不連 DB）
//
// 1. planResumeChunks（純函式）：重新認領時哪幾塊已經拆完、哪幾塊要跑、塊號怎麼編。
//    重點是「塊號＝題號的千位」（agents/extract.js：idx = 塊號 × 1000 ＋ 塊內位置）：
//    切法沒變時塊號與一次跑完相同；切法變了時新塊的塊號接在舊的後面，題號不會撞到已經建好的列。
// 2. runExtractJob（假 db＋當場寫的假 extract agent）：有檢查點的塊不再呼叫 agent；
//    建題目列與寫檢查點事件在同一個交易（client），寫事件失敗時整個 ROLLBACK、不留半塊的題目列。
//
// 真的 PostgreSQL 上「拆到一半被殺、租約到期、重新認領」的端到端驗證在 test/integration/extractCheckpoints.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planChunks, planResumeChunks, createRunner } = require('../../workers/jobRunner');

/** 把 planChunks 的前 n 塊寫成檢查點（created 依序給 3、2、1…） */
function checkpointsOf(chunks, n, created = (i) => 3 - (i % 3)) {
    return chunks.slice(0, n).map((c, i) => ({ chunk: c.no, page_range: [c.fromPage, c.toPage], created: created(i) }));
}

describe('planResumeChunks — 切法沒變（最常見）', () => {
    test('沒有檢查點 → fresh，與 planChunks 完全相同', () => {
        for (const [pages, size] of [[6, 2], [45, 20], [null, 20], [1, 1]]) {
            assert.deepEqual(planResumeChunks(pages, size, []),
                { todo: planChunks(pages, size), done: [], doneCreated: 0, mode: 'fresh' }, `${pages}/${size}`);
            assert.deepEqual(planResumeChunks(pages, size, undefined).todo, planChunks(pages, size));
        }
    });

    test('第 1 塊拆完：跳過第 1 塊，其餘照原本的塊號（題號與一次跑完相同）', () => {
        const r = planResumeChunks(6, 2, [{ chunk: 1, page_range: [1, 2], created: 3 }]);
        assert.equal(r.mode, 'resume');
        assert.deepEqual(r.done, [{ no: 1, fromPage: 1, toPage: 2, created: 3 }]);
        assert.deepEqual(r.todo, [{ no: 2, fromPage: 3, toPage: 4 }, { no: 3, fromPage: 5, toPage: 6 }]);
        assert.equal(r.doneCreated, 3);
    });

    test('全部拆完（在「刪檔、轉 processing」之前被殺）→ 沒有要跑的塊，created 是全部的合計', () => {
        const all = planChunks(5, 2);
        const r = planResumeChunks(5, 2, checkpointsOf(all, all.length));
        assert.equal(r.mode, 'resume');
        assert.deepEqual(r.todo, []);
        assert.deepEqual(r.done.map(c => c.no), [1, 2, 3]);
        assert.equal(r.doneCreated, 3 + 2 + 1);
    });

    test('頁數不明（page_count NULL）整份一塊：[1, null] 的檢查點也認得', () => {
        const r = planResumeChunks(null, 20, [{ chunk: 1, page_range: [1, null], created: 4 }]);
        assert.equal(r.mode, 'resume');
        assert.deepEqual(r.todo, []);
        assert.equal(r.doneCreated, 4);
    });

    test('skipped 的塊（created 0）也算拆完', () => {
        const r = planResumeChunks(4, 2, [{ chunk: 1, page_range: [1, 2], created: 0 }]);
        assert.deepEqual(r.done, [{ no: 1, fromPage: 1, toPage: 2, created: 0 }]);
        assert.deepEqual(r.todo.map(c => c.no), [2]);
    });

    test('舊版整份重拆留下的重複檢查點：同一個頁碼範圍只算一次、created 取最大', () => {
        const r = planResumeChunks(4, 2, [
            { chunk: 1, page_range: [1, 2], created: 3 },
            { chunk: 1, page_range: [1, 2], created: 0 },    // 舊版重拆同一塊：ON CONFLICT 全撞，created 0
            { chunk: 2, page_range: [3, 4], created: 1 }
        ]);
        assert.equal(r.mode, 'resume');
        assert.deepEqual(r.todo, []);
        assert.equal(r.doneCreated, 4);
    });

    test('形狀不對的事件不當成檢查點（寧可重拆）', () => {
        const junk = [
            { chunk: 1 }, { chunk: 1, page_range: null }, { chunk: 'x', page_range: [1, 2] }, { chunk: 0, page_range: [1, 2] },
            { chunk: 1, page_range: [0, 2] }, { chunk: 1, page_range: [3, 2] }, { chunk: 1, page_range: [1] }, null
        ];
        assert.deepEqual(planResumeChunks(4, 2, junk), { todo: planChunks(4, 2), done: [], doneCreated: 0, mode: 'fresh' });
    });

    test('檢查點的數字是字串（->> 取出來的）也認得', () => {
        const r = planResumeChunks(4, 2, [{ chunk: '1', page_range: ['1', '2'], created: '2' }]);
        assert.equal(r.mode, 'resume');
        assert.deepEqual(r.done, [{ no: 1, fromPage: 1, toPage: 2, created: 2 }]);
    });

    test('性質：任何頁數、每塊頁數、中斷點 → 拆完的＋要跑的＝一次跑完的清單（塊號與頁碼範圍逐一相同）', () => {
        for (const pages of [1, 2, 3, 5, 7, 8, 20, 21, 45]) {
            for (const size of [1, 2, 3, 20]) {
                const all = planChunks(pages, size);
                for (let n = 0; n <= all.length; n++) {
                    const r = planResumeChunks(pages, size, checkpointsOf(all, n));
                    const merged = [...r.done.map(({ created, ...c }) => c), ...r.todo].sort((a, b) => a.no - b.no);
                    assert.deepEqual(merged, all, `${pages} 頁、每塊 ${size} 頁、拆完 ${n} 塊`);
                    assert.equal(r.done.length, n);
                    assert.equal(r.mode, n === 0 ? 'fresh' : 'resume');
                }
            }
        }
    });
});

describe('planResumeChunks — 切法變了（換了本機／Gemini 模式或 JOB_PDF_CHUNK_PAGES）', () => {
    test('本機每塊 2 頁拆完兩塊 → 改成 Gemini 每塊 20 頁：前 4 頁算拆完，第 5 頁起切成新的一塊、塊號接在後面（3）', () => {
        const r = planResumeChunks(7, 20, [
            { chunk: 1, page_range: [1, 2], created: 2 },
            { chunk: 2, page_range: [3, 4], created: 1 }
        ]);
        assert.equal(r.mode, 'replanned');
        assert.deepEqual(r.done.map(c => [c.no, c.fromPage, c.toPage]), [[1, 1, 2], [2, 3, 4]]);
        assert.deepEqual(r.todo, [{ no: 3, fromPage: 5, toPage: 7 }]);
        assert.equal(r.doneCreated, 3);
    });

    test('Gemini 每塊 20 頁拆完第 1 塊 → 改成本機每塊 2 頁：第 21 頁起每 2 頁一塊，塊號從 2 起（不從 1 重來、題號不撞）', () => {
        const r = planResumeChunks(30, 2, [{ chunk: 1, page_range: [1, 20], created: 12 }]);
        assert.equal(r.mode, 'replanned');
        assert.deepEqual(r.todo.map(c => [c.no, c.fromPage, c.toPage]),
            [[2, 21, 22], [3, 23, 24], [4, 25, 26], [5, 27, 28], [6, 29, 30]]);
    });

    test('最後一塊頁碼範圍相同、塊號不同（5 頁：每塊 2 頁的第 3 塊＝每塊 4 頁的第 2 塊）→ 不誤判；全部拆完就沒有要跑的', () => {
        const old = planChunks(5, 2);
        const r = planResumeChunks(5, 4, checkpointsOf(old, 3));
        assert.equal(r.mode, 'replanned');
        assert.deepEqual(r.todo, []);
        assert.deepEqual(r.done.map(c => c.no), [1, 2, 3]);
    });

    test('只比頁碼範圍的舊做法會撞號：新切法的第 1 塊（1001 起）與已建好的舊第 1 塊同號 → 這裡不會排出這種塊', () => {
        const r = planResumeChunks(8, 4, [{ chunk: 1, page_range: [1, 2], created: 2 }]);
        assert.equal(r.mode, 'replanned');
        assert.ok(r.todo.every(c => c.no > 1), '要跑的塊號都要大於已拆完的塊號');
        assert.deepEqual(r.todo, [{ no: 2, fromPage: 3, toPage: 6 }, { no: 3, fromPage: 7, toPage: 8 }]);
    });

    test('性質：新塊號都大於任何已拆完的塊號、頁碼從涵蓋到的下一頁連續到最後一頁', () => {
        for (const pages of [3, 7, 20, 41]) {
            for (const oldSize of [1, 2, 3, 20]) {
                for (const newSize of [1, 2, 4, 20]) {
                    if (oldSize === newSize) continue;
                    const old = planChunks(pages, oldSize);
                    for (let n = 1; n <= old.length; n++) {
                        const r = planResumeChunks(pages, newSize, checkpointsOf(old, n));
                        const maxDone = Math.max(...r.done.map(c => c.no));
                        assert.ok(r.todo.every(c => c.no > maxDone), `${pages}/${oldSize}→${newSize}/${n}`);
                        let next = r.done[r.done.length - 1].toPage + 1;
                        for (const c of r.todo) {
                            assert.equal(c.fromPage, next);
                            assert.ok(c.toPage - c.fromPage + 1 <= newSize);
                            next = c.toPage + 1;
                        }
                        assert.equal(next - 1, pages, '要涵蓋到最後一頁');
                        const nos = [...r.done, ...r.todo].map(c => c.no);
                        assert.deepEqual(nos, [...nos].sort((a, b) => a - b), '塊號照頁碼順序遞增（承上題找前一塊靠它）');
                    }
                }
            }
        }
    });

    test('檢查點不是從第 1 頁連續（不該發生）→ inconsistent：只跳過頁碼範圍相同的塊，其餘照這次的塊號', () => {
        const r = planResumeChunks(40, 20, [{ chunk: 2, page_range: [3, 4], created: 1 }]);
        assert.equal(r.mode, 'inconsistent');
        assert.deepEqual(r.todo, planChunks(40, 20));
        assert.deepEqual(r.done, []);
    });
});

// ───────────────────────── runExtractJob（假 db）─────────────────────────

const QUIET = { info() { }, warn() { }, error() { } };

describe('runExtractJob — 逐塊檢查點（假 db）', () => {
    let agentsDir;
    let tmpDir;

    before(() => {
        agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-agents-'));
        // 每塊回一題（塊號寫進題幹），並記下被叫到的塊號
        fs.writeFileSync(path.join(agentsDir, 'extract.js'), `
            module.exports = {
                async run(ctx, input) {
                    (globalThis.__ckptCalls = globalThis.__ckptCalls || []).push(input.chunk.no);
                    const q = { subject: '數學', chapter: '向量內積', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
                        question_text: '第 ' + input.chunk.no + ' 塊的題', answer_text: '1', idx: input.chunk.no * 1000 + 1 };
                    return { kind: 'pass', data: { questions: [q], rejected: [] } };
                }
            };`);
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-pdf-'));
    });
    after(() => {
        fs.rmSync(agentsDir, { recursive: true, force: true });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete globalThis.__ckptCalls;
    });
    beforeEach(() => { globalThis.__ckptCalls = []; });

    /**
     * 假 db：jobs 的 SELECT 回一份 6 頁的卷；檢查點查詢回 checkpoints；交易的 client 另外記。
     * failEventForChunk：client 寫那一塊的 extract 事件時丟錯（模擬寫到一半當機）。
     */
    function fakeDb({ checkpoints = [], failEventForChunk = null } = {}) {
        const pdfPath = path.join(tmpDir, `job-${Math.random().toString(16).slice(2)}.pdf`);
        fs.writeFileSync(pdfPath, 'x');
        const log = [];
        const tx = [];
        const db = {
            log, tx,
            pool: {
                connect: async () => ({
                    async query(text, params) {
                        tx.push({ text, params });
                        if (failEventForChunk !== null && /INSERT INTO job_events/.test(text)
                            && JSON.parse(params[14]).chunk === failEventForChunk) {
                            throw new Error('模擬當機');
                        }
                        return { rows: [], rowCount: 1 };
                    },
                    release() { tx.push({ text: 'RELEASE' }); }
                })
            },
            async query(text, params) {
                log.push({ text, params });
                if (/SELECT id, pdf_path, pdf_sha256, page_count/.test(text)) {
                    return {
                        rows: [{ id: 7, pdf_path: pdfPath, pdf_sha256: 'c'.repeat(64), page_count: 6, subject_group: 'math_physics', budget_usd: 0.5, cost_usd: 0 }],
                        rowCount: 1
                    };
                }
                if (/FROM job_events/.test(text) && /outcome IN \('pass', 'skipped'\)/.test(text)) return { rows: checkpoints, rowCount: checkpoints.length };
                if (/SELECT cost_usd::float8 AS cost_usd FROM jobs/.test(text)) return { rows: [{ cost_usd: 0 }], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            }
        };
        return { db, pdfPath };
    }

    function makeRunner(db) {
        return createRunner({
            db, llm: {}, logger: QUIET, agentsDir, sleep: async () => { },
            estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
            config: { localExtract: false, pdfChunkPages: 2, nodeTimeoutMs: 5000, renewIntervalMs: 60000 }
        });
    }

    test('沒有檢查點：三塊都跑；每塊的題目列與 extract 事件都經同一個交易（BEGIN → INSERT job_questions → INSERT job_events → COMMIT）', async () => {
        const { db, pdfPath } = fakeDb();
        await makeRunner(db).runExtractJob(7);
        assert.deepEqual(globalThis.__ckptCalls, [1, 2, 3]);
        const shape = db.tx.map(q => q.text === 'RELEASE' ? 'RELEASE'
            : /^BEGIN|^COMMIT|^ROLLBACK/.test(q.text) ? q.text
                : /INSERT INTO job_questions/.test(q.text) ? 'jq' : /INSERT INTO job_events/.test(q.text) ? 'ev' : q.text);
        assert.deepEqual(shape, Array(3).fill(['BEGIN', 'jq', 'ev', 'COMMIT', 'RELEASE']).flat());
        assert.ok(!db.log.some(q => /INSERT INTO job_questions|INSERT INTO job_events/.test(q.text)), '題目列與檢查點不走交易外的連線');
        const done = db.log.find(q => /SET pdf_path = NULL, state = 'processing'/.test(q.text));
        assert.ok(done, '全部拆完轉 processing');
        assert.ok(!fs.existsSync(pdfPath), '拆完刪檔');
        assert.ok(db.log.some(q => /UPDATE jobs SET state = 'done'/.test(q.text)), '拆完一律檢查一次能不能收尾');
    });

    test('第 1 塊已有檢查點：只跑第 2、3 塊（塊號不變），第 1 塊不再呼叫 agent', async () => {
        const { db } = fakeDb({ checkpoints: [{ chunk: 1, page_range: [1, 2], created: 1 }] });
        await makeRunner(db).runExtractJob(7);
        assert.deepEqual(globalThis.__ckptCalls, [2, 3]);
        const idx = db.tx.filter(q => /INSERT INTO job_questions/.test(q.text)).map(q => q.params[1]);
        assert.deepEqual(idx, [2001, 3001]);
        const chunks = db.tx.filter(q => /INSERT INTO job_events/.test(q.text)).map(q => JSON.parse(q.params[14]).chunk);
        assert.deepEqual(chunks, [2, 3], '拆完的那一塊不再寫一次事件');
    });

    test('全部塊都有檢查點：不呼叫 agent，直接刪檔、轉 processing', async () => {
        const { db, pdfPath } = fakeDb({ checkpoints: planChunks(6, 2).map(c => ({ chunk: c.no, page_range: [c.fromPage, c.toPage], created: 1 })) });
        await makeRunner(db).runExtractJob(7);
        assert.deepEqual(globalThis.__ckptCalls, []);
        assert.equal(db.tx.length, 0);
        assert.ok(db.log.some(q => /SET pdf_path = NULL, state = 'processing'/.test(q.text)));
        assert.ok(!fs.existsSync(pdfPath));
    });

    test('寫第 2 塊的檢查點時當機：ROLLBACK（第 2 塊的題目列不留）、例外往上丟、job 不轉 processing、PDF 不刪', async () => {
        const { db, pdfPath } = fakeDb({ failEventForChunk: 2 });
        await assert.rejects(makeRunner(db).runExtractJob(7), /模擬當機/);
        assert.deepEqual(globalThis.__ckptCalls, [1, 2]);
        const texts = db.tx.map(q => q.text);
        const second = texts.slice(texts.indexOf('RELEASE') + 1);
        assert.equal(second[0], 'BEGIN');
        assert.match(second[1], /INSERT INTO job_questions/);
        assert.match(second[2], /INSERT INTO job_events/);
        assert.equal(second[3], 'ROLLBACK');
        assert.equal(second[4], 'RELEASE');
        assert.ok(!db.log.some(q => /state = 'processing'|state = 'failed'/.test(q.text)), '留在 extracting 等重新認領');
        assert.ok(fs.existsSync(pdfPath), 'PDF 要留著給重新認領時接著拆');
    });
});
