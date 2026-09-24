// ─────────────────────────────────────────────────────────────
// studentProfile.pg.test.js — 學生檔案的整合測試（階段 5 WS-A；DEC-017、缺口 G09）
//
// 契約：docs/interfaces-stage5.md 第 4.1 條第 4 項。
//   GET   /api/students                    每列多 grade、track、target_exams、school、textbook_version、note
//   POST  /api/students                    接受檔案欄位的任意子集
//   PATCH /api/students/:id                任意子集，沒送的不動；只送 name 的既有行為不變
//   GET   /api/student-profile-options     表單選項（核心區，不吃 FEATURE_STUDENTS）
//
// 三道防線與其他整合測試相同。每個案例前 TRUNCATE … RESTART IDENTITY。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('學生檔案整合測試（需要 PostgreSQL）', {
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
    delete process.env.API_KEY;

    const request = require('supertest');
    const APP_PATH = path.join(APP_DIR, 'app');
    const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');
    function loadApp(featureStudents) {
        delete require.cache[require.resolve(APP_PATH)];
        delete require.cache[require.resolve(ROUTES_PATH)];
        const saved = process.env.FEATURE_STUDENTS;
        process.env.FEATURE_STUDENTS = featureStudents;
        try {
            return require(APP_PATH);
        } finally {
            if (saved === undefined) delete process.env.FEATURE_STUDENTS;
            else process.env.FEATURE_STUDENTS = saved;
        }
    }
    // 學生管理與清單都在核心區：旗標關閉的 app 也要能用（裁決 S4-1、S4-2）
    const appDisabled = loadApp('false');
    const app = loadApp('true');
    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const { profileOptions } = require(path.join(APP_DIR, 'config', 'studentProfile'));

    const EMPTY = { grade: null, track: null, target_exams: [], school: null, textbook_version: null, note: null };
    const FULL = { grade: 11, track: '自然組', target_exams: ['學測', '分科'], school: '示範高中', textbook_version: '龍騰', note: '週三上課' };

    async function dbRow(id) {
        const { rows } = await query(
            'SELECT id, name, grade, track, target_exams, school, textbook_version, note FROM students WHERE id = $1', [id]);
        return rows[0];
    }

    describe('學生檔案 × PostgreSQL（interfaces-stage5.md 第 4.1 條第 4 項）', () => {
        before(() => {
            execFileSync(process.execPath, ['migrate.js', 'up', '--test'], {
                cwd: APP_DIR, env: { ...process.env, TEST_DATABASE_URL }, encoding: 'utf8'
            });
        });

        beforeEach(async () => {
            await query('TRUNCATE attempts, exam_papers, students, questions RESTART IDENTITY CASCADE');
        });

        after(async () => {
            await pool.end();
        });

        describe('GET /api/student-profile-options', () => {
            test('回 config/studentProfile.js 的選項；FEATURE_STUDENTS 關閉時照樣掛載（核心區）', async () => {
                for (const a of [app, appDisabled]) {
                    const res = await request(a).get('/api/student-profile-options');
                    assert.equal(res.status, 200);
                    assert.deepEqual(res.body, profileOptions());
                }
            });
        });

        describe('POST /api/students', () => {
            test('只送 name：201，檔案欄位是 NULL／空陣列（既有入口行為不變，只是回應多帶檔案）', async () => {
                const res = await request(appDisabled).post('/api/students').send({ name: '只有名字' });
                assert.equal(res.status, 201);
                assert.deepEqual(res.body, { id: 1, name: '只有名字', ...EMPTY });
                assert.deepEqual(Object.keys(res.body).slice(0, 2), ['id', 'name']);
            });

            test('帶完整檔案：201 並寫進 DB；target_exams 存成白名單順序', async () => {
                const res = await request(app).post('/api/students')
                    .send({ name: '有檔案', ...FULL, target_exams: ['分科', '學測'] });
                assert.equal(res.status, 201, JSON.stringify(res.body));
                assert.deepEqual(res.body, { id: 1, name: '有檔案', ...FULL });
                assert.deepEqual(await dbRow(1), { id: 1, name: '有檔案', ...FULL });
            });

            test('檔案欄位不合法 → 400，而且不建學生', async () => {
                const cases = [
                    [{ grade: 9 }, 'grade 只接受 10、11、12 或 null。'],
                    [{ track: '數A' }, 'track 只接受 自然組、社會組、未分組 或 null。'],
                    [{ target_exams: ['指考'] }, 'target_exams 必須是 學測、分科、統測、段考、其他 的子集。'],
                    [{ textbook_version: '康軒' }, 'textbook_version 只接受 龍騰、翰林、南一、泰宇、三民、全華、康熹、其他 或 null。'],
                    [{ school: 'x'.repeat(51) }, 'school 必須是字串或 null，且不得超過 50 字。'],
                    [{ note: 'x'.repeat(501) }, 'note 必須是字串或 null，且不得超過 500 字。']
                ];
                for (const [extra, message] of cases) {
                    const res = await request(app).post('/api/students').send({ name: '不合法', ...extra });
                    assert.equal(res.status, 400, JSON.stringify(extra));
                    assert.deepEqual(res.body, { message });
                }
                const { rows } = await query('SELECT COUNT(*)::int AS n FROM students');
                assert.equal(rows[0].n, 0);
            });

            test('name 的既有規則與訊息不變（缺名 400、重名 409）', async () => {
                const missing = await request(app).post('/api/students').send({ grade: 10 });
                assert.equal(missing.status, 400);
                assert.deepEqual(missing.body, { message: '學生姓名必填，且長度不得超過 50 字。' });
                await request(app).post('/api/students').send({ name: '重名' });
                const dup = await request(app).post('/api/students').send({ name: '重名', grade: 12 });
                assert.equal(dup.status, 409);
                assert.deepEqual(dup.body, { message: '學生「重名」已存在。' });
            });
        });

        describe('PATCH /api/students/:id', () => {
            async function created(extra = {}) {
                const res = await request(app).post('/api/students').send({ name: '檔案生', ...extra });
                assert.equal(res.status, 201);
                return res.body.id;
            }

            test('只送 name：只改名，檔案欄位不動（既有行為）', async () => {
                const id = await created(FULL);
                const res = await request(app).patch(`/api/students/${id}`).send({ name: '改名後' });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { id, name: '改名後', ...FULL });
            });

            test('只送部分檔案欄位：沒送的不動，name 也不動', async () => {
                const id = await created(FULL);
                const res = await request(app).patch(`/api/students/${id}`).send({ grade: 12, school: '新學校' });
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(await dbRow(id), { id, name: '檔案生', ...FULL, grade: 12, school: '新學校' });
            });

            test('送 null 清空；target_exams: null 清成空陣列', async () => {
                const id = await created(FULL);
                const res = await request(app).patch(`/api/students/${id}`)
                    .send({ grade: null, track: null, target_exams: null, school: '', textbook_version: null, note: null });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { id, name: '檔案生', ...EMPTY });
            });

            test('一個可改的欄位都沒送 → 400；不認得的鍵不算', async () => {
                const id = await created();
                for (const body of [{}, { hobby: '籃球' }]) {
                    const res = await request(app).patch(`/api/students/${id}`).send(body);
                    assert.equal(res.status, 400, JSON.stringify(body));
                    assert.deepEqual(res.body, {
                        message: '至少要提供一個要修改的欄位（name、grade、track、target_exams、school、textbook_version、note）。'
                    });
                }
            });

            test('有送 name 但不合法 → 沿用既有訊息，而且整筆不寫（檔案欄位也不動）', async () => {
                const id = await created(FULL);
                const res = await request(app).patch(`/api/students/${id}`).send({ name: '  ', grade: 10 });
                assert.equal(res.status, 400);
                assert.deepEqual(res.body, { message: '學生姓名必填，且長度不得超過 50 字。' });
                assert.equal((await dbRow(id)).grade, 11);
            });

            test('檔案欄位不合法 → 400 且不動；不存在 404；id 無效 400；改成別人的名字 409', async () => {
                const id = await created(FULL);
                const bad = await request(app).patch(`/api/students/${id}`).send({ grade: 13, note: '不該寫進去' });
                assert.equal(bad.status, 400);
                assert.deepEqual(await dbRow(id), { id, name: '檔案生', ...FULL });

                const missing = await request(app).patch('/api/students/9999').send({ grade: 10 });
                assert.equal(missing.status, 404);
                assert.deepEqual(missing.body, { message: '找不到該學生' });

                const invalid = await request(app).patch('/api/students/abc').send({ grade: 10 });
                assert.equal(invalid.status, 400);
                assert.deepEqual(invalid.body, { message: '學生 id 無效。' });

                await request(app).post('/api/students').send({ name: '另一位' });
                const dup = await request(app).patch(`/api/students/${id}`).send({ name: '另一位', grade: 10 });
                assert.equal(dup.status, 409);
                assert.equal((await dbRow(id)).grade, 11, '409 時檔案欄位也不得被寫入');
            });
        });

        describe('GET /api/students 帶檔案欄位', () => {
            test('每列在既有四欄之後接六個檔案欄位', async () => {
                // 名字只差尾端的 A／B：排序依 name，中文字的先後取決於資料庫 collation，不拿它來釘
                await request(app).post('/api/students').send({ name: '檔案生A', ...FULL });
                await request(app).post('/api/students').send({ name: '檔案生B' });
                const res = await request(appDisabled).get('/api/students');
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.items, [
                    { id: 1, name: '檔案生A', papers: 0, graded_ratio: 0, ...FULL },
                    { id: 2, name: '檔案生B', papers: 0, graded_ratio: 0, ...EMPTY }
                ]);
                assert.deepEqual(Object.keys(res.body.items[0]),
                    ['id', 'name', 'papers', 'graded_ratio', 'grade', 'track', 'target_exams', 'school', 'textbook_version', 'note']);
            });

            test('合併學生不受檔案欄位影響（來源學生刪除、目標的檔案保留）', async () => {
                await request(app).post('/api/students').send({ name: '本尊', ...FULL });
                await request(app).post('/api/students').send({ name: '分身', grade: 10 });
                const res = await request(app).post('/api/students/2/merge').send({ into_id: 1 });
                assert.equal(res.status, 200);
                assert.deepEqual(await dbRow(1), { id: 1, name: '本尊', ...FULL });
            });
        });
    });
}
