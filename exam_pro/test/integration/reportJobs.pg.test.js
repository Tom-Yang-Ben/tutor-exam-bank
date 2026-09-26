// ─────────────────────────────────────────────────────────────
// reportJobs.pg.test.js — npm run report:jobs 的取數（scripts/report_jobs.js 的 collect）
//
// 〔dec/local-thinking-speed-fix〕驗證新加的「answer_mismatch 之後原地重跑的結果」：同一題（jq_id）下一次 verify 事件
// 是 pass／又是 answer_mismatch／其他，還是沒有下一次。其餘既有的欄位順便確認查得出來（不丟 SQL 錯）。
//
// 與其他整合測試同樣的防線：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、require config/db.js 之前覆寫 DATABASE_URL。
// 開頭 TRUNCATE jobs（連帶 job_questions、job_events）：整合測試依序跑（--test-concurrency=1），不影響別的檔。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('report:jobs 的取數（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 npm run test:integration'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const db = require(path.join(APP_DIR, 'config', 'db'));
    const { collect, parseSince, renderMarkdown } = require(path.join(APP_DIR, 'scripts', 'report_jobs'));
    const query = (sql, params) => db.query(sql, params);

    describe('report_jobs.collect × PostgreSQL', () => {
        before(async () => {
            await query('TRUNCATE jobs RESTART IDENTITY CASCADE');
            const { rows } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count) VALUES ('pdf', $1, 'processing', 0.5, 4) RETURNING id`,
                [crypto.randomBytes(32).toString('hex')]);
            const jobId = rows[0].id;
            const jq = [];
            for (let i = 1; i <= 5; i++) {
                const { rows: r } = await query(`INSERT INTO job_questions (job_id, idx, state) VALUES ($1, $2, 'verified') RETURNING id`, [jobId, i]);
                jq.push(r[0].id);
            }
            // 依序插入（id 就是時間順序）：
            //   jq1：不一致 → 重跑通過；jq2：不一致 → 重跑又不一致（之後沒有）；jq3：不一致 → 重跑 error；
            //   jq4：不一致、之後沒有；jq5：一次就通過；另有一支 classify 的不一致不算（不是 verify）
            const ev = (jqId, node, attempt, outcome, errorClass = null) => query(
                `INSERT INTO job_events (job_id, jq_id, node, attempt, latency_ms, outcome, error_class) VALUES ($1, $2, $3, $4, 1000, $5, $6)`,
                [jobId, jqId, node, attempt, outcome, errorClass]);
            await ev(jq[0], 'verify', 1, 'fail', 'answer_mismatch');
            await ev(jq[1], 'verify', 1, 'fail', 'answer_mismatch');
            await ev(jq[0], 'verify', 2, 'pass');
            await ev(jq[1], 'verify', 2, 'fail', 'answer_mismatch');
            await ev(jq[2], 'verify', 1, 'fail', 'answer_mismatch');
            await ev(jq[2], 'verify', 2, 'error', 'provider_error');
            await ev(jq[3], 'verify', 1, 'fail', 'answer_mismatch');
            await ev(jq[4], 'verify', 1, 'pass');
            await ev(jq[4], 'classify', 1, 'fail', 'chapter_invalid');
        });

        after(async () => {
            await query('TRUNCATE jobs RESTART IDENTITY CASCADE');
            await db.pool.end();
        });

        test('answer_mismatch 之後原地重跑的結果：通過 1、又不一致 1、其他 1；之後沒有再跑的 2（jq2 的第二次、jq4）', async () => {
            const r = await collect(db, parseSince('1d'));
            assert.deepEqual({ ...r.verify.rerun }, { reruns: 3, rerun_pass: 1, rerun_mismatch: 1, rerun_other: 1, no_next: 2 });
            assert.equal(r.verify.mismatch, 5);
            assert.equal(r.verify.calls, 8);
            const md = renderMarkdown(r);
            assert.ok(md.includes('| 　重跑後通過 | 1 |'), md);
            assert.equal(/NaN|undefined/.test(md), false);
        });

        // 〔整合 2026-09-26 dec/integration-r5〕collect 的回傳在合併時兩邊都加了欄位（本分支 verify.rerun、
        // dec/local-ocr-first-fix 的 ocrFigures）：同一次 collect 兩個都要算得對，報表兩節都印。
        test('〔整合 r5〕同一次 collect 同時帶 verify.rerun 與 ocrFigures，報表兩節都印', async () => {
            const { rows } = await query('SELECT job_id FROM job_questions ORDER BY id LIMIT 1');
            const jobId = rows[0].job_id;
            const figures = { detected: 3, assigned: 2, hinted: 1, layout: 'ok', truncated: false };
            await query(
                `INSERT INTO job_events (job_id, jq_id, node, attempt, latency_ms, outcome, detail)
                 VALUES ($1, NULL, 'extract', 1, 1000, 'pass', $2)`,
                [jobId, JSON.stringify({ cross_check: { mode: 'ocr', figures } })]);
            // cross 模式的拆題事件不算進 OCR 版面配圖
            await query(
                `INSERT INTO job_events (job_id, jq_id, node, attempt, latency_ms, outcome, detail)
                 VALUES ($1, NULL, 'extract', 1, 1000, 'pass', $2)`,
                [jobId, JSON.stringify({ cross_check: { mode: 'cross' } })]);
            const r = await collect(db, parseSince('1d'));
            assert.deepEqual({ ...r.verify.rerun }, { reruns: 3, rerun_pass: 1, rerun_mismatch: 1, rerun_other: 1, no_next: 2 });
            assert.deepEqual({ ...r.ocrFigures }, { chunks: 1, detected: 3, assigned: 2, hinted: 1, no_layout: 0, truncated: 0 });
            const md = renderMarkdown(r);
            assert.ok(md.includes('| 　重跑後通過 | 1 |'), md);
            assert.ok(md.includes('要不要關掉見 docs/local-mode.md 第 10.14 條'), md);
            assert.ok(md.includes('## OCR 版面配圖（LOCAL_EXTRACT_MODE=ocr）'), md);
            assert.ok(md.includes('| 自動配到題目 | 2 |'), md);
            assert.equal(/NaN|undefined/.test(md), false);
        });

        test('期間外的事件不算', async () => {
            await query(`UPDATE job_events SET created_at = now() - interval '3 days'`);
            const r = await collect(db, parseSince('1d'));
            assert.deepEqual({ ...r.verify.rerun }, { reruns: 0, rerun_pass: 0, rerun_mismatch: 0, rerun_other: 0, no_next: 0 });
        });
    });
}
