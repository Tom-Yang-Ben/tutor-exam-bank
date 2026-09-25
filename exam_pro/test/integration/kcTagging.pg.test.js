// ─────────────────────────────────────────────────────────────
// kcTagging.pg.test.js — 自動標註的整合測試（階段 5 WS-C；docs/interfaces-stage5.md 第 4.3 條第 3 點）
//
// 三層，全部對真的 PostgreSQL、LLM 一律注入假的（第 1.2 條：不得打網路、CI 不需要新 cassette）：
//   1. kcTagService.tagQuestion：寫入 src='ai'、門檻、human 不動、該章沒有知識點略過、失敗不寫、重標取代舊的 ai。
//   2. kc:backfill：挑題規則（未封存、沒有任何標註、所在章節有知識點）；CLI 的 --dry-run 印題數與預估費用；
//      不是 dry-run 但 LLM_MODE=replay 時 cassette miss → 該題 failed、exit 1、不寫任何東西（證明不會打網路）。
//   3. workers/jobRunner.js 的 save 掛鉤：旗標關閉時一次都不呼叫；開啟時用**預設的** tagger
//      （真的 kcTagService＋runner 的 llm）寫進 question_kcs；tagger 失敗時 job 照樣 saved／done。
//
// 防線同其他 *.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('知識點自動標註整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JOB_RUNNER = 'off';

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const kc = require(path.join(APP_DIR, 'services', 'kcService'));
    const svc = require(path.join(APP_DIR, 'services', 'kcTagService'));
    const { createRunner } = require(path.join(APP_DIR, 'workers', 'jobRunner'));
    const db = { pool, query };

    const FIX = path.join(APP_DIR, 'test', 'fixtures', 'kc');
    const readSeed = name => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
    const CH = { '數學': ['向量的加減與係數積', '向量內積'], '物理': ['功與動能', '位能與能量守恆'] };
    const CFG = { minConfidence: 0.6, model: 'gemini:gemini-3.5-flash' };

    /**
     * 假 LLM：依題幹裡的標記決定回什麼（`[[MATH.向量內積.02:0.9]]` → 那個 code、那個信心）。
     * 沒有標記就回清單裡第一個 code、信心 0.9。記下每一次呼叫。
     */
    function fakeLlm({ throws = null } = {}) {
        const calls = [];
        return {
            calls,
            async generateJson(opts) {
                calls.push(opts);
                if (throws) throw new Error(throws);
                const text = opts.parts[0].text;
                const marks = [...text.matchAll(/\[\[([A-Z]+\.[^.\]]+\.\d{2}):([\d.]+)\]\]/g)].map(m => ({ code: m[1], confidence: Number(m[2]) }));
                const first = opts.schema.properties.kc_codes.items.properties.code.enum[0];
                return {
                    data: { kc_codes: marks.length ? marks : [{ code: first, confidence: 0.9 }], rationale: '測試用' },
                    usage: { tokenIn: 1000, tokenOut: 50, tokenThinking: 0, tokenCached: 0 }
                };
            },
            async embed() { return { vectors: [], usage: { tokenIn: 0 } }; }
        };
    }

    async function seedQuestion(subject, chapter, text, { archived = false } = {}) {
        const { rows: [r] } = await query(
            `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, archived_at)
             VALUES ($1, $2, '計算', 3, $3, '略', $4) RETURNING id`,
            [subject, chapter, text, archived ? new Date() : null]);
        return r.id;
    }
    async function tagsOf(questionId) {
        const { rows } = await query(
            `SELECT k.code, qk.src, qk.confidence, qk.weight FROM question_kcs qk JOIN knowledge_components k ON k.id = qk.kc_id
              WHERE qk.question_id = $1 ORDER BY k.code`, [questionId]);
        return rows;
    }
    async function idOf(code) {
        return (await query('SELECT id FROM knowledge_components WHERE code = $1', [code])).rows[0].id;
    }

    /** 同 jobs.pg.test.js：入庫後 fire-and-forget 的補向量可能與 TRUNCATE 搶鎖，死結就重試 */
    async function truncateAll() {
        for (let i = 0; i < 5; i++) {
            try {
                await query('TRUNCATE job_events, job_questions, jobs CASCADE');
                await query('TRUNCATE attempt_records, assignments, exam_papers, students, questions RESTART IDENTITY CASCADE');
                await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
                return;
            } catch (err) {
                if (err.code !== '40P01' || i === 4) throw err;
                await new Promise(r => setTimeout(r, 100));
            }
        }
    }

    async function freshData() {
        await truncateAll();
        const r = await kc.loadSeeds(db, [readSeed('數學'), readSeed('物理')], { chapters: CH });
        assert.equal(r.ok, true, r.errors.join('\n'));
    }

    // ─────────────────────────────────────────────────────────────
    describe('tagQuestion（真 DB、假 LLM）', () => {
        beforeEach(freshData);

        test('達標的 code 寫成 src=ai、weight 1、confidence；未達標的丟掉', async () => {
            const q = await seedQuestion('數學', '向量內積', '求 |a+b|。[[MATH.向量內積.05:0.92]][[MATH.向量內積.01:0.4]]');
            const llm = fakeLlm();
            const r = await svc.tagQuestion(q, { db, llm, config: CFG });
            assert.equal(r.status, 'tagged');
            assert.deepEqual(r.written.map(w => w.code), ['MATH.向量內積.05']);
            assert.deepEqual(r.dropped.map(d => d.code), ['MATH.向量內積.01']);
            const rows = await tagsOf(q);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].code, 'MATH.向量內積.05');
            assert.equal(rows[0].src, 'ai');
            assert.equal(rows[0].weight, 1);
            assert.ok(Math.abs(rows[0].confidence - 0.92) < 1e-6);
            // agent 看到的是「該章」的 6 個知識點，不是整科
            assert.equal(llm.calls[0].schema.properties.kc_codes.items.properties.code.enum.length, 6);
            assert.equal(llm.calls[0].agent, 'kc_tag');
        });

        test('重新標註：先刪舊的 ai、再寫新的', async () => {
            const q = await seedQuestion('數學', '向量內積', '題目 [[MATH.向量內積.02:0.9]]');
            await svc.tagQuestion(q, { db, llm: fakeLlm(), config: CFG });
            await query(`UPDATE questions SET question_text = '題目 [[MATH.向量內積.04:0.8]][[MATH.向量內積.06:0.7]]' WHERE id = $1`, [q]);
            const r = await svc.tagQuestion(q, { db, llm: fakeLlm(), config: CFG });
            assert.equal(r.status, 'tagged');
            assert.deepEqual((await tagsOf(q)).map(t => t.code), ['MATH.向量內積.04', 'MATH.向量內積.06']);
        });

        test('一個都沒達標 → low_confidence，既有的 ai 標註維持原樣', async () => {
            const q = await seedQuestion('數學', '向量內積', '題目 [[MATH.向量內積.02:0.9]]');
            await svc.tagQuestion(q, { db, llm: fakeLlm(), config: CFG });
            await query(`UPDATE questions SET question_text = '題目 [[MATH.向量內積.04:0.3]]' WHERE id = $1`, [q]);
            const r = await svc.tagQuestion(q, { db, llm: fakeLlm(), config: CFG });
            assert.equal(r.status, 'low_confidence');
            assert.deepEqual((await tagsOf(q)).map(t => t.code), ['MATH.向量內積.02']);
        });

        test('已有人工標註（PUT 寫的）→ 不呼叫 LLM、不動', async () => {
            const q = await seedQuestion('數學', '向量內積', '題目 [[MATH.向量內積.02:0.99]]');
            await kc.replaceQuestionKcs(db, q, [{ kc_id: await idOf('MATH.向量內積.01'), weight: 1 }]);
            const llm = fakeLlm();
            const r = await svc.tagQuestion(q, { db, llm, config: CFG });
            assert.deepEqual([r.status, r.reason], ['skipped', 'has_human']);
            assert.equal(llm.calls.length, 0);
            assert.deepEqual((await tagsOf(q)).map(t => [t.code, t.src]), [['MATH.向量內積.01', 'human']]);
        });

        test('該章沒有知識點 → skipped(no_kcs)，不呼叫 LLM', async () => {
            const q = await seedQuestion('數學', '實數', '實數的題目');
            const llm = fakeLlm();
            const r = await svc.tagQuestion(q, { db, llm, config: CFG });
            assert.deepEqual([r.status, r.reason], ['skipped', 'no_kcs']);
            assert.equal(llm.calls.length, 0);
        });

        test('LLM 失敗 → failed、不寫；題目不存在 → not_found', async () => {
            const q = await seedQuestion('物理', '功與動能', '功的題目');
            const r = await svc.tagQuestion(q, { db, llm: fakeLlm({ throws: '模擬 429 rate limit' }), config: CFG });
            assert.equal(r.status, 'failed');
            assert.ok(r.message.includes('429'));
            assert.deepEqual(await tagsOf(q), []);
            assert.equal((await svc.tagQuestion(99999, { db, llm: fakeLlm(), config: CFG })).status, 'not_found');
        });

        test('模型給了別章的 code → schema 擋下（failed），不會寫進不相干的知識點', async () => {
            const q = await seedQuestion('物理', '功與動能', '題目 [[PHYS.位能與能量守恆.01:0.95]]');
            const r = await svc.tagQuestion(q, { db, llm: fakeLlm(), config: CFG });
            assert.equal(r.status, 'failed');
            assert.equal(r.reason, 'schema_invalid');
            assert.deepEqual(await tagsOf(q), []);
        });
    });

    // ─────────────────────────────────────────────────────────────
    describe('kc:backfill', () => {
        beforeEach(freshData);

        test('selectBackfillIds：未封存、沒有任何標註、所在章節有知識點；--subject、--limit', async () => {
            const a = await seedQuestion('數學', '向量內積', 'a');
            const b = await seedQuestion('物理', '功與動能', 'b');
            const c = await seedQuestion('數學', '向量內積', 'c（已標）');
            await seedQuestion('數學', '向量內積', 'd（封存）', { archived: true });
            await seedQuestion('數學', '實數', 'e（章節沒有知識點）');
            const f = await seedQuestion('數學', '向量的加減與係數積', 'f');
            await kc.replaceQuestionKcs(db, c, [{ kc_id: await idOf('MATH.向量內積.02'), weight: 1 }]);

            assert.deepEqual(await svc.selectBackfillIds(db), [a, b, f]);
            assert.deepEqual(await svc.selectBackfillIds(db, { subject: '數學' }), [a, f]);
            assert.deepEqual(await svc.selectBackfillIds(db, { limit: 1 }), [a]);
            assert.equal(await svc.countUntaggedWithoutKcs(db), 1);
            assert.equal(await svc.countUntaggedWithoutKcs(db, { subject: '物理' }), 0);
        });

        function cli(args) {
            return spawnSync(process.execPath, [path.join('scripts', 'backfill_kc.js'), ...args], {
                cwd: APP_DIR, encoding: 'utf8',
                env: { ...process.env, TEST_DATABASE_URL, DATABASE_URL: '', LLM_MODE: 'replay', EMBED_MODE: 'fixture', MODEL_KC_TAG: '' }
            });
        }

        test('CLI --dry-run：印出題數與預估費用，不呼叫 LLM、不寫入', async () => {
            await seedQuestion('數學', '向量內積', 'a');
            await seedQuestion('物理', '功與動能', 'b');
            await seedQuestion('數學', '實數', 'c');
            const r = cli(['--dry-run', '--test']);
            assert.equal(r.status, 0, r.stderr);
            assert.ok(r.stdout.includes('待標註題數：2'), r.stdout);
            assert.ok(r.stdout.includes('另有 1 題所在的章節還沒有知識點'), r.stdout);
            assert.match(r.stdout, /預估費用：約 US\$\d+\.\d{4}/);
            assert.equal((await query('SELECT COUNT(*)::int AS n FROM question_kcs')).rows[0].n, 0);
        });

        test('CLI 非 dry-run、LLM_MODE=replay：cassette miss → failed、exit 1、不寫入（不會打網路）', async () => {
            const q = await seedQuestion('數學', '向量內積', 'CI 裡沒有錄過的題');
            const r = cli(['--limit', '1', '--test']);
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.ok(r.stdout.includes('LLM_MODE=replay'), r.stdout);
            assert.ok(r.stdout.includes(`#${q} failed`), r.stdout);
            assert.ok(r.stdout.includes('failed 1'), r.stdout);
            assert.deepEqual(await tagsOf(q), []);
        });

        test('CLI --subject 不在白名單 → exit 1', () => {
            const r = cli(['--subject', '生物', '--dry-run', '--test']);
            assert.equal(r.status, 1);
            assert.ok(r.stderr.includes('--subject'), r.stderr);
        });
    });

    // ─────────────────────────────────────────────────────────────
    describe('jobRunner 的 save 掛鉤（〔stage5 WS-C〕）', () => {
        const savedFlag = process.env.FEATURE_KC_TAGGING;
        const quiet = { info() { }, warn() { }, error() { } };

        beforeEach(freshData);
        after(async () => {
            if (savedFlag === undefined) delete process.env.FEATURE_KC_TAGGING; else process.env.FEATURE_KC_TAGGING = savedFlag;
            await new Promise(r => setTimeout(r, 200));   // 讓 fire-and-forget 的補向量跑完再關池
            await truncateAll();
            await pool.end();
        });

        /** 直接建一列停在 deduped（下一步就是 save）的 job_questions */
        async function seedDedupedJob(text) {
            const { rows: [job] } = await query(
                `INSERT INTO jobs (kind, pdf_sha256, state, budget_usd, page_count)
                 VALUES ('pdf', $1, 'processing', 0.5, 1) RETURNING id`, [crypto.randomBytes(32).toString('hex')]);
            const payload = {
                extract: {
                    idx: 1, subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_type: '計算', difficulty: 3,
                    question_text: text, answer_text: '$11$', chunk_no: 1, page_range: [1, 1]
                },
                dedup0: { text_hash: crypto.createHash('sha256').update(text).digest('hex') },
                classify: { chapter: '向量內積', confidence: 0.95, source: 'gate' }
            };
            const { rows: [jq] } = await query(
                `INSERT INTO job_questions (job_id, idx, state, payload) VALUES ($1, 1, 'deduped', $2::jsonb) RETURNING id`,
                [job.id, JSON.stringify(payload)]);
            return { jobId: job.id, jqId: jq.id };
        }

        function makeRunner(llm, extra = {}) {
            return createRunner({
                db, llm, logger: quiet, sleep: async () => { },
                agentsDir: path.join(APP_DIR, 'test', 'fixtures', 'fakeAgents'),
                estimateCost: () => ({ cost_usd: 0, cost_estimated: false }),
                config: { nodeTimeoutMs: 5000, leaseMs: 60000 },
                ...extra
            });
        }

        /** 等 fire-and-forget 的標註寫進 DB（最多 3 秒） */
        async function waitForTags(questionId) {
            for (let i = 0; i < 60; i++) {
                const rows = await tagsOf(questionId);
                if (rows.length) return rows;
                await new Promise(r => setTimeout(r, 50));
            }
            return [];
        }

        async function stateOf(jqId, jobId) {
            const { rows: [jq] } = await query('SELECT state, question_id FROM job_questions WHERE id = $1', [jqId]);
            const { rows: [job] } = await query('SELECT state FROM jobs WHERE id = $1', [jobId]);
            return { jq: jq.state, questionId: jq.question_id, job: job.state };
        }

        test('旗標關閉：入庫照常，標註一次都不呼叫', async () => {
            delete process.env.FEATURE_KC_TAGGING;
            const { jobId, jqId } = await seedDedupedJob('自製題：求 $\\vec a\\cdot\\vec b$。[[MATH.向量內積.02:0.9]]');
            const llm = fakeLlm();
            await makeRunner(llm).runJobQuestion(jqId);
            await new Promise(r => setTimeout(r, 150));
            const s = await stateOf(jqId, jobId);
            assert.deepEqual([s.jq, s.job], ['saved', 'done']);
            assert.equal(llm.calls.length, 0);
            assert.deepEqual(await tagsOf(s.questionId), []);
        });

        test('旗標開啟：預設 tagger（真的 kcTagService）在入庫後寫進 question_kcs', async () => {
            process.env.FEATURE_KC_TAGGING = 'true';
            const { jobId, jqId } = await seedDedupedJob('自製題：設 $\\vec a=(1,2)$、$\\vec b=(3,4)$，求內積。[[MATH.向量內積.02:0.9]]');
            const llm = fakeLlm();
            await makeRunner(llm).runJobQuestion(jqId);
            const s = await stateOf(jqId, jobId);
            assert.deepEqual([s.jq, s.job], ['saved', 'done']);
            const rows = await waitForTags(s.questionId);
            assert.deepEqual(rows.map(r => [r.code, r.src]), [['MATH.向量內積.02', 'ai']]);
            assert.equal(llm.calls.filter(c => c.agent === 'kc_tag').length, 1);
        });

        test('當日花費已達 DAILY_COST_BUDGET_USD：入庫照常（save 是零成本節點），標註不呼叫 LLM', async () => {
            process.env.FEATURE_KC_TAGGING = 'true';
            const { jobId, jqId } = await seedDedupedJob('自製題：設 $\\vec a=(2,1)$，求 $\\vec a\\cdot\\vec a$。[[MATH.向量內積.02:0.9]]');
            await query(
                `INSERT INTO job_events (job_id, node, attempt, latency_ms, outcome, cost_usd)
                 VALUES ($1, 'classify', 1, 10, 'pass', 2)`, [jobId]);
            const llm = fakeLlm();
            await makeRunner(llm, { config: { nodeTimeoutMs: 5000, leaseMs: 60000, dailyCostBudgetUsd: 1 } }).runJobQuestion(jqId);
            await new Promise(r => setTimeout(r, 150));
            const s = await stateOf(jqId, jobId);
            assert.deepEqual([s.jq, s.job], ['saved', 'done']);
            assert.equal(llm.calls.filter(c => c.agent === 'kc_tag').length, 0);
            assert.deepEqual(await tagsOf(s.questionId), []);
        });

        test('旗標開啟但標註失敗（LLM 丟錯／tagger 丟錯）：job 照樣 saved、done', async () => {
            process.env.FEATURE_KC_TAGGING = 'true';
            const a = await seedDedupedJob('自製題 A：[[MATH.向量內積.02:0.9]]');
            await makeRunner(fakeLlm({ throws: 'LLM_MODE=replay 找不到 cassette' })).runJobQuestion(a.jqId);
            const b = await seedDedupedJob('自製題 B：[[MATH.向量內積.04:0.9]]');
            await makeRunner(fakeLlm(), { kcTagger: async () => { throw new Error('tagger 爆了'); } }).runJobQuestion(b.jqId);
            await new Promise(r => setTimeout(r, 150));
            for (const { jobId, jqId } of [a, b]) {
                const s = await stateOf(jqId, jobId);
                assert.deepEqual([s.jq, s.job], ['saved', 'done']);
                assert.deepEqual(await tagsOf(s.questionId), []);
            }
            const { rows } = await query(`SELECT outcome FROM job_events WHERE node = 'save' ORDER BY id`);
            assert.deepEqual(rows.map(r => r.outcome), ['pass', 'pass']);
        });
    });
}