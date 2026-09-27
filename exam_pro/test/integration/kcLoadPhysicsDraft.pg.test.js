// ─────────────────────────────────────────────────────────────
// kcLoadPhysicsDraft.pg.test.js — Owner 第五輪 K-P 核准（選 3：物理知識點維持草稿，但允許載入）
//
// 用 repo 裡真正的 config/kc/*.json，以子行程跑 scripts/load_kc.js --test（跟 Owner 執行 npm run kc:load 同一條路）：
//   ① 數學已在庫裡時只載入物理（--file）：exit 0，198 列全部是 draft，數學的列不受影響；
//      空庫只載物理會被擋，原因是跨科先備（物理 6 條先備指向數學）解析不到——既有規則，與草稿／物理無關；
//   ② 三科一起載入：物理 198 列仍是 draft；數學、化學的列數與已審定數照種子檔（其他科不受影響）；
//      跨科先備（物理 → 數學）有寫進 kc_prerequisites；再跑一次全部「內容相同」。
// 防線同其他 *.pg.test.js：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、不 require('dotenv')。
// ─────────────────────────────────────────────────────────────
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('物理草稿知識點載入整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));

    const KC_DIR = path.join(APP_DIR, 'config', 'kc');
    const seed = (subject) => JSON.parse(fs.readFileSync(path.join(KC_DIR, `${subject}.json`), 'utf8'));
    const reset = () => query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');

    function runLoad(args) {
        return spawnSync(process.execPath, [path.join('scripts', 'load_kc.js'), '--test', ...args], {
            cwd: APP_DIR, encoding: 'utf8',
            env: { ...process.env, TEST_DATABASE_URL, DATABASE_URL: '' }
        });
    }
    async function bySubject() {
        const { rows } = await query(
            `SELECT subject, status, COUNT(*)::int AS n FROM knowledge_components GROUP BY 1, 2 ORDER BY 1, 2`);
        return rows.map(r => `${r.subject}/${r.status}=${r.n}`);
    }

    describe('Owner 第五輪 K-P：kc:load 載入物理草稿（真的種子檔、子行程）', () => {
        beforeEach(reset);
        after(async () => {
            await reset();
            await pool.end();
        });

        test('① 數學已在庫裡時，只載入物理：exit 0，198 列全部是草稿；空庫只載物理會因跨科先備被擋（既有規則，不是擋草稿）', async () => {
            const phys = path.join('config', 'kc', '物理.json');
            // 空庫：物理有 6 條先備指向數學，數學不在本批也不在庫裡 → 整批拒絕（先備解析規則，與草稿／物理無關）
            const empty = runLoad(['--file', phys]);
            assert.equal(empty.status, 1, empty.stdout + empty.stderr);
            assert.match(empty.stderr, /先備 MATH\.[^ ]+ 在本批與資料庫中都找不到/);
            assert.doesNotMatch(empty.stdout + empty.stderr, /draft|草稿|approved|已審定才/);
            assert.deepEqual(await bySubject(), []);

            const m = runLoad(['--file', path.join('config', 'kc', '數學.json')]);
            assert.equal(m.status, 0, m.stdout + m.stderr);
            const before = await bySubject();

            const r = runLoad(['--file', phys]);
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /物理：種子檔 198 個知識點、34 章、標記已審定 0 個/);
            assert.match(r.stdout, /新增 198、更新 0/);
            assert.match(r.stdout, /✅ 載入完成/);
            const after = await bySubject();
            assert.deepEqual(after.filter(x => x.startsWith('物理/')), ['物理/draft=198']);
            assert.deepEqual(after.filter(x => !x.startsWith('物理/')), before, '數學的列不受影響');
        });

        test('② 三科一起載入：物理仍是草稿；數學、化學照種子檔；跨科先備寫入；重跑全部內容相同', async () => {
            const want = ['數學', '物理', '化學'].map(s => {
                const cs = seed(s).components;
                return { s, total: cs.length, approved: cs.filter(c => c.status === 'approved').length };
            });
            const r = runLoad([]);
            assert.equal(r.status, 0, r.stdout + r.stderr);

            const got = await bySubject();
            const expected = [];
            for (const { s, total, approved } of want) {
                if (approved) expected.push(`${s}/approved=${approved}`);
                expected.push(`${s}/draft=${total - approved}`);
            }
            assert.deepEqual(got.sort(), expected.sort());
            assert.ok(got.includes('物理/draft=198'));

            const { rows: [cross] } = await query(
                `SELECT COUNT(*)::int AS n FROM kc_prerequisites e
                   JOIN knowledge_components k ON k.id = e.kc_id JOIN knowledge_components p ON p.id = e.prereq_kc_id
                  WHERE k.subject = '物理' AND p.subject <> '物理'`);
            const seedCross = seed('物理').components.flatMap(c => c.prereqs || []).filter(p => !p.startsWith('PHYS.')).length;
            assert.equal(cross.n, seedCross, '跨科先備（物理 → 其他科）照種子檔寫入');

            const again = runLoad([]);
            assert.equal(again.status, 0, again.stdout + again.stderr);
            const total = want.reduce((a, w) => a + w.total, 0);
            assert.match(again.stdout, new RegExp(`新增 0、更新 0、略過 ${total}（內容相同 ${total}、已審定受保護 0）`));
        });
    });
}
