// ─────────────────────────────────────────────────────────────
// health.pg.test.js — GET /api/health 連真的資料庫（桌面啟動器 A；docs/desktop-launcher.md 第 7.3 節）
//
// 與 controllers.pg.test.js 同一套防呆：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、require config/db 之前先覆寫 DATABASE_URL。
// 本檔**不寫資料庫**（健康檢查只讀；pending 的情況用注入的 migration 清單造，不動 schema_migrations）。
//   1. 200、db.ok、migration 版本與資料庫的 schema_migrations 一致；
//   2. 設了 API_KEY 也不必帶金鑰（掛在 apiKeyAuth 之前），其他 /api 照舊要金鑰；
//   3. 回應只有固定的五個鍵，不含連線字串、帳號、題目；
//   4. 程式比資料庫多一支 migration → pending 列出來（仍是 200）；
//   5. 桌面啟動器的判讀（scripts/desktop/lib/probes.js 的 classifyHealth）把這個回應認成「本系統、資料庫正常」。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('健康檢查整合測試（需要 PostgreSQL）', {
        skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。請跑 node -r dotenv/config --test "test/integration/**/*.test.js"'
    }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.API_KEY = 'integration-key';
    delete process.env.LAUNCHER_CONTROL_TOKEN;

    const request = require('supertest');
    const app = require(path.join(APP_DIR, 'app'));
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const hc = require(path.join(APP_DIR, 'controllers', 'healthController'));
    const ms = require(path.join(APP_DIR, 'utils', 'migrationStatus'));
    const probes = require(path.join(APP_DIR, 'scripts', 'desktop', 'lib', 'probes'));

    let appliedInDb;
    before(async () => {
        try {
            const { rows } = await query('SELECT version FROM schema_migrations ORDER BY version');
            appliedInDb = rows.map(r => r.version);
        } catch (err) {
            if (err.code !== '42P01') throw err;
            appliedInDb = [];
        }
    });
    after(async () => { await pool.end(); });

    describe('GET /api/health（真的資料庫）', () => {
        test('200、ok、migration 版本與 schema_migrations 一致；不帶金鑰也可以', async () => {
            const res = await request(app).get('/api/health');
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.service, 'tutor-exam-bank');
            assert.equal(res.body.status, 'ok');
            assert.deepEqual(res.body.db, { ok: true });
            assert.equal(res.body.version, require(path.join(APP_DIR, 'package.json')).version);
            const expected = ms.compareMigrations(ms.listMigrationFiles(), appliedInDb);
            assert.deepEqual(res.body.migrations, {
                applied: expected.latestApplied, latest: expected.latestFile, pending: expected.pending, unknown: expected.unknown
            });
            assert.equal(res.headers['cache-control'], 'no-store');
        });

        test('回應只有五個鍵，不含連線字串、帳號', async () => {
            const res = await request(app).get('/api/health');
            assert.deepEqual(Object.keys(res.body).sort(), ['db', 'migrations', 'service', 'status', 'version']);
            const u = new URL(TEST_DATABASE_URL);
            // CI 的帳密是 exam／exam，剛好是服務名稱 tutor-exam-bank 的一段：先拿掉服務名稱再比
            const text = res.text.replaceAll('tutor-exam-bank', '');
            assert.ok(!text.includes(TEST_DATABASE_URL));
            if (u.password) assert.ok(!text.includes(u.password), '不回密碼');
            if (u.username) assert.ok(!text.includes(u.username), '不回帳號');
            assert.ok(!text.includes(u.pathname.slice(1)), '不回資料庫名稱');
            assert.ok(!text.includes(u.hostname), '不回主機');
        });

        test('其他 /api 路由照舊要金鑰', async () => {
            assert.equal((await request(app).get('/api/chapters')).status, 401);
            assert.equal((await request(app).get('/api/chapters').set('x-api-key', 'integration-key')).status, 200);
        });

        test('程式多一支 migration（資料庫還沒套）→ 仍是 200，pending 列出那一支', async () => {
            const express = require('express');
            const mini = express();
            const extra = 'zzzz_9999_not_yet_applied.sql';
            mini.get('/api/health', hc.createHealthHandler({
                query, version: 'test', listFiles: () => [...ms.listMigrationFiles(), extra]
            }));
            const res = await request(mini).get('/api/health');
            assert.equal(res.status, 200);
            assert.ok(res.body.migrations.pending.includes(extra));
            assert.equal(res.body.migrations.latest, extra);
        });

        test('桌面啟動器把這個回應認成「本系統、資料庫正常」', async () => {
            const res = await request(app).get('/api/health');
            const h = probes.classifyHealth({ status: res.status, json: res.body, errorCode: null }, 3000);
            assert.equal(h.state, 'ours');
            assert.equal(h.dbOk, true);
        });
    });
}
