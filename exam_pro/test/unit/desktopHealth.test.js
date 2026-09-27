// ─────────────────────────────────────────────────────────────
// test/unit/desktopHealth.test.js — GET /api/health（controllers/healthController.js）與 migration 對照（utils/migrationStatus.js）
//
//   1. buildHealth：資料庫正常 → 200＋migration 版本；連不上、逾時 → 503；還沒跑過 migrate → pending 全部；
//      回應只有固定的幾個鍵（不含錯誤原文、連線字串）。
//   2. compareMigrations／listMigrationFiles／readAppliedVersions。
//   3. 真的載入 app.js（**沒有** LAUNCHER_CONTROL_TOKEN＝npm start 的情況）：/api/launcher 不存在（404）、
//      /api/health 不必金鑰、no-store。連資料庫的版本在 test/integration/health.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.DATABASE_URL = 'postgres://nobody:secret-pw@127.0.0.1:1/never_used_test';
process.env.API_KEY = 'unit-key';
process.env.JOB_RUNNER = 'off';
delete process.env.LAUNCHER_CONTROL_TOKEN;

const hc = require('../../controllers/healthController');
const ms = require('../../utils/migrationStatus');
const probes = require('../../scripts/desktop/lib/probes');

const FILES = ['0001_init.sql', '0002_b.sql', '0003_c.sql'];
const q = rows => async () => ({ rows });

describe('buildHealth', () => {
    test('資料庫正常、migration 都套了 → 200、ok', async () => {
        const r = await hc.buildHealth({ query: q(FILES.map(version => ({ version }))), listFiles: () => FILES, version: '1.2.3' });
        assert.equal(r.httpStatus, 200);
        assert.deepEqual(r.body, {
            service: 'tutor-exam-bank', status: 'ok', version: '1.2.3', db: { ok: true },
            migrations: { applied: '0003_c.sql', latest: '0003_c.sql', pending: [], unknown: [] }
        });
    });

    test('有沒套的 migration → 仍是 200（服務在跑），pending 列出來', async () => {
        const r = await hc.buildHealth({ query: q([{ version: '0001_init.sql' }]), listFiles: () => FILES, version: '1' });
        assert.equal(r.httpStatus, 200);
        assert.deepEqual(r.body.migrations.pending, ['0002_b.sql', '0003_c.sql']);
        assert.equal(r.body.migrations.applied, '0001_init.sql');
    });

    test('還沒跑過 migrate（沒有 schema_migrations，42P01）→ 200，pending 是全部', async () => {
        const query = async () => { throw Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' }); };
        const r = await hc.buildHealth({ query, listFiles: () => FILES, version: '1' });
        assert.equal(r.httpStatus, 200);
        assert.deepEqual(r.body.migrations.pending, FILES);
        assert.equal(r.body.migrations.applied, null);
    });

    test('連不上資料庫 → 503、db.ok:false，不回錯誤原文（可能含帳號）', async () => {
        const query = async () => { throw new Error('password authentication failed for user "exam" at secret-host'); };
        const r = await hc.buildHealth({ query, listFiles: () => FILES, version: '1' });
        assert.equal(r.httpStatus, 503);
        assert.deepEqual(r.body, { service: 'tutor-exam-bank', status: 'degraded', version: '1', db: { ok: false }, migrations: null });
        assert.doesNotMatch(JSON.stringify(r.body), /password|secret|exam"/);
    });

    test('資料庫查詢卡住 → timeoutMs 後回 503，不把請求卡住', async () => {
        const started = Date.now();
        const r = await hc.buildHealth({ query: () => new Promise(() => { }), listFiles: () => FILES, version: '1', timeoutMs: 50 });
        assert.equal(r.httpStatus, 503);
        assert.ok(Date.now() - started < 1000);
    });

    test('讀不到 migrations 資料夾 → 服務仍回 200，migrations:null', async () => {
        const r = await hc.buildHealth({ query: q([]), listFiles: () => { throw new Error('ENOENT'); }, version: '1' });
        assert.equal(r.httpStatus, 200);
        assert.equal(r.body.migrations, null);
    });

    test('withTimeout：逾時後原本的 promise 才失敗也不會變成 unhandled rejection', async () => {
        let reject;
        const p = new Promise((_, rj) => { reject = rj; });
        await assert.rejects(hc.withTimeout(p, 10), /timeout/);
        reject(new Error('late'));
        await new Promise(r => setImmediate(r));
    });

    test('服務名稱與啟動器認的是同一個', () => {
        assert.equal(hc.SERVICE_NAME, probes.SERVICE_NAME);
    });
});

describe('utils/migrationStatus', () => {
    test('compareMigrations：pending、unknown、最新，去重排序', () => {
        assert.deepEqual(ms.compareMigrations(['0002_b.sql', '0001_a.sql', '0001_a.sql'], ['0001_a.sql', '0099_z.sql']), {
            latestFile: '0002_b.sql', latestApplied: '0099_z.sql', pending: ['0002_b.sql'], unknown: ['0099_z.sql']
        });
        assert.deepEqual(ms.compareMigrations([], []), { latestFile: null, latestApplied: null, pending: [], unknown: [] });
    });

    test('listMigrationFiles：只取 .sql、依檔名排序（與 migrate.js 同一條規則）；真的目錄有 0001 起的檔', () => {
        const fake = { readdirSync: () => ['0002_b.sql', 'README.md', '0001_a.sql'] };
        assert.deepEqual(ms.listMigrationFiles('/x', fake), ['0001_a.sql', '0002_b.sql']);
        const real = ms.listMigrationFiles();
        assert.ok(real.length >= 20);
        assert.equal(real[0], '0001_init.sql');
        const migrateSrc = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'migrate.js'), 'utf8');
        assert.match(migrateSrc, /\.filter\(f => f\.endsWith\('\.sql'\)\)\s*\.sort\(\)/, 'migrate.js 的排序規則改了，utils/migrationStatus.js 要跟著改');
    });

    test('readAppliedVersions：其他錯誤照丟（交給呼叫端決定 503）', async () => {
        await assert.rejects(ms.readAppliedVersions(async () => { throw Object.assign(new Error('x'), { code: '57P01' }); }), /x/);
    });
});

describe('app.js（npm start 的情況：沒有 LAUNCHER_CONTROL_TOKEN）', () => {
    const app = require('../../app');

    test('沒有權杖 → /api/launcher 不存在（落到既有的 /api 路由，照舊要金鑰；帶了金鑰也是 404）', async () => {
        const noKey = await request(app).get('/api/launcher/status').set('x-launcher-token', 'x'.repeat(64));
        assert.equal(noKey.status, 401);
        const withKey = await request(app).post('/api/launcher/shutdown').set('x-api-key', 'unit-key').set('x-launcher-token', 'x'.repeat(64));
        assert.equal(withKey.status, 404);
    });

    test('/api/health 不必金鑰；Cache-Control: no-store；不洩漏 DATABASE_URL', async () => {
        const res = await request(app).get('/api/health');
        assert.equal(res.status, 503);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(res.body).sort(), ['db', 'migrations', 'service', 'status', 'version']);
        assert.doesNotMatch(res.text, /secret-pw|nobody|127\.0\.0\.1:1/);
    });

    test('POST /api/health 不存在（只有 GET）', async () => {
        const res = await request(app).post('/api/health').set('x-api-key', 'unit-key');
        assert.equal(res.status, 404);
    });
});
