// ─────────────────────────────────────────────────────────────
// kcLoad.pg.test.js — 種子檔載入（npm run kc:load）的整合測試（階段 5 WS-C；第 4.3 條第 1 點）
//
// 兩層：
//   1. services/kcService.loadSeeds 直接對 PostgreSQL 跑：以 code upsert、已審定不覆寫（除非 force）、
//      先備 upsert（src='ai'）與解析失敗整批回滾、跨科先備、環檢查、dry-run、同章換名。
//   2. scripts/load_kc.js 以子行程跑（--test 打測試庫）：用本檔臨時產生的「完整涵蓋數學 34 章」種子檔，
//      證明 CLI 能載入**任何**符合第 3.4 條的檔案；不合法的檔整批拒絕、exit 1、資料庫不動。
//
// 防線同其他 *.pg.test.js：只讀 TEST_DATABASE_URL、庫名必須以 _test 結尾、不 require('dotenv')。
// ─────────────────────────────────────────────────────────────
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const APP_DIR = path.resolve(__dirname, '..', '..');

if (!TEST_DATABASE_URL) {
    test('知識點載入整合測試（需要 PostgreSQL）', { skip: '未設定 TEST_DATABASE_URL；npm test 不連資料庫。' }, () => { });
} else {
    if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
        throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾，拒絕在非測試庫上執行整合測試');
    }
    runSuite();
}

function runSuite() {
    process.env.DATABASE_URL = TEST_DATABASE_URL;

    const { query, pool } = require(path.join(APP_DIR, 'config', 'db'));
    const kc = require(path.join(APP_DIR, 'services', 'kcService'));
    const { CHAPTERS } = require(path.join(APP_DIR, 'config', 'chapters'));
    const db = { pool, query };

    const FIX = path.join(APP_DIR, 'test', 'fixtures', 'kc');
    const readSeed = name => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
    const CH = { '數學': ['向量的加減與係數積', '向量內積'], '物理': ['功與動能', '位能與能量守恆'] };
    const load = (seeds, opts = {}) => kc.loadSeeds(db, seeds, { chapters: CH, ...opts });

    const count = async (table) => (await query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
    const row = async (code) => (await query('SELECT * FROM knowledge_components WHERE code = $1', [code])).rows[0];
    async function edges() {
        const { rows } = await query(
            `SELECT k.code AS kc, p.code AS pre, e.src FROM kc_prerequisites e
               JOIN knowledge_components k ON k.id = e.kc_id JOIN knowledge_components p ON p.id = e.prereq_kc_id
              ORDER BY 1, 2`);
        return rows;
    }
    const component = (seed, code) => seed.components.find(c => c.code === code);

    describe('kcService.loadSeeds（對 PostgreSQL）', () => {
        beforeEach(async () => {
            await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
        });

        test('第一次載入：全部新增，先備以 src=ai 寫入；第二次：全部「內容相同」', async () => {
            const r1 = await load([readSeed('數學'), readSeed('物理')]);
            assert.equal(r1.ok, true, r1.errors.join('\n'));
            // 〔stage5 審查修正 S5-43〕counts 多一個 edited（老師改過而受保護的草稿）
            assert.deepEqual(r1.counts, { inserted: 15, updated: 0, unchanged: 0, protected: 0, edited: 0, prereqInserted: 13, prereqRemoved: 0, orphans: 0 });
            assert.equal(await count('knowledge_components'), 15);
            const e = await edges();
            assert.equal(e.length, 13);
            assert.ok(e.every(x => x.src === 'ai'));
            assert.ok(e.some(x => x.kc === 'PHYS.功與動能.01' && x.pre === 'MATH.向量內積.01'), '跨科先備');
            const r = await row('MATH.向量內積.02');
            assert.equal(r.status, 'approved');
            assert.equal(r.subject, '數學');
            assert.equal(r.sort, 2);

            const r2 = await load([readSeed('數學'), readSeed('物理')]);
            assert.deepEqual(r2.counts, { inserted: 0, updated: 0, unchanged: 15, protected: 0, edited: 0, prereqInserted: 0, prereqRemoved: 0, orphans: 0 });
        });

        test('草稿列：種子檔改了就更新（updated_at 前進）', async () => {
            await load([readSeed('數學')]);
            const before = await row('MATH.向量內積.01');
            const seed = readSeed('數學');
            component(seed, 'MATH.向量內積.01').description = '改過的課綱式說明。';
            const r = await load([seed]);
            assert.equal(r.counts.updated, 1);
            assert.equal(r.counts.unchanged, 8);
            const after = await row('MATH.向量內積.01');
            assert.equal(after.description, '改過的課綱式說明。');
            assert.ok(after.updated_at > before.updated_at);
        });

        test('DB 已審定的列不覆寫（Owner 在畫面上改過的口語版保住了）；--force 才覆寫', async () => {
            await load([readSeed('數學')]);
            const ownerText = '有坐標就直接對應相乘再相加，x 乘 x、y 乘 y，三維再加 z 乘 z；算出來是一個數字，不是向量。（Owner 改）';
            await query(`UPDATE knowledge_components SET spoken_text = $1 WHERE code = 'MATH.向量內積.02'`, [ownerText]);
            // 草稿被老師審定：種子檔仍寫 draft，也不能被降級
            await query(`UPDATE knowledge_components SET status = 'approved' WHERE code = 'MATH.向量內積.03'`);

            const r = await load([readSeed('數學')]);
            assert.equal(r.counts.protected, 2);
            assert.equal((await row('MATH.向量內積.02')).spoken_text, ownerText);
            assert.equal((await row('MATH.向量內積.03')).status, 'approved');

            const forced = await load([readSeed('數學')], { force: true });
            assert.equal(forced.counts.updated, 2);
            assert.equal((await row('MATH.向量內積.02')).spoken_text, component(readSeed('數學'), 'MATH.向量內積.02').spoken_text);
            assert.equal((await row('MATH.向量內積.03')).status, 'draft');
        });

        // 〔stage5 審查修正 S5-43〕
        test('老師在知識點分頁改過、還沒審定的草稿：重載同一份種子檔不覆寫（列為 edited）；--force 才覆寫並清掉標記', async () => {
            await load([readSeed('數學')]);
            const id = (await row('MATH.向量內積.01')).id;
            const teacherText = '老師親手改過的口語版：兩個向量內積，就是一個的長度乘另一個在它方向上的影子長，算出來是數字。';

            // 只改 status（審定再改回草稿）不算改過
            assert.equal((await kc.patchKc(db, id, { status: 'approved' })).status, 200);
            assert.equal((await kc.patchKc(db, id, { status: 'draft' })).status, 200);
            assert.equal((await row('MATH.向量內積.01')).edited_at, null);
            // 送了跟現值一樣的內容也不算
            assert.equal((await kc.patchKc(db, id, { name: (await row('MATH.向量內積.01')).name })).status, 200);
            assert.equal((await row('MATH.向量內積.01')).edited_at, null);

            const res = await kc.patchKc(db, id, { spoken_text: teacherText });
            assert.equal(res.status, 200);
            assert.equal(res.item.status, 'draft');
            assert.ok((await row('MATH.向量內積.01')).edited_at, '改了內容要留下 edited_at');

            const r = await load([readSeed('數學')]);
            assert.equal(r.ok, true, r.errors.join('\n'));
            assert.equal(r.counts.edited, 1);
            assert.equal(r.counts.updated, 0);
            assert.deepEqual(r.editedCodes, ['MATH.向量內積.01']);
            assert.equal((await row('MATH.向量內積.01')).spoken_text, teacherText, '老師的修改不得被種子檔蓋回去');

            const forced = await load([readSeed('數學')], { force: true });
            assert.equal(forced.counts.updated, 1);
            assert.deepEqual(forced.editedCodes, ['MATH.向量內積.01'], '--force 時列出被覆寫的是哪些');
            const after = await row('MATH.向量內積.01');
            assert.equal(after.spoken_text, component(readSeed('數學'), 'MATH.向量內積.01').spoken_text);
            assert.equal(after.edited_at, null, '覆寫後內容回到種子檔版本，標記清掉');

            // 已審定的列按「改回草稿」再修改，同樣受保護
            const approvedId = (await row('MATH.向量內積.02')).id;
            assert.equal((await kc.patchKc(db, approvedId, { status: 'draft' })).status, 200);
            assert.equal((await kc.patchKc(db, approvedId, { description: '老師改寫的說明。' })).status, 200);
            const r2 = await load([readSeed('數學')]);
            assert.equal(r2.counts.edited, 1);
            assert.equal((await row('MATH.向量內積.02')).description, '老師改寫的說明。');
        });

        test('validateSeeds 有 error → 整批拒絕，一列都不寫', async () => {
            const seed = readSeed('數學');
            seed.components[1].code = seed.components[0].code;           // code 重複
            const r = await load([seed, readSeed('物理')]);
            assert.equal(r.ok, false);
            assert.ok(r.errors.some(e => e.includes('重複')));
            assert.equal(await count('knowledge_components'), 0);
        });

        test('先備在本批與 DB 都找不到 → 整批回滾（知識點本身也不留）', async () => {
            const r = await load([readSeed('物理')]);                     // 數學還沒載入
            assert.equal(r.ok, false);
            assert.ok(r.errors[0].includes('MATH.向量內積.01'), r.errors[0]);
            assert.ok(r.warnings.some(w => w.includes('MATH.向量內積.01')), '單檔驗證時跨科先備只是 warning');
            assert.equal(await count('knowledge_components'), 0);
            assert.equal(await count('kc_prerequisites'), 0);
        });

        test('跨科先備：先載數學、再單獨載物理 → 從 DB 解析得到', async () => {
            assert.equal((await load([readSeed('數學')])).ok, true);
            const r = await load([readSeed('物理')]);
            assert.equal(r.ok, true, r.errors.join('\n'));
            assert.ok((await edges()).some(x => x.kc === 'PHYS.功與動能.01' && x.pre === 'MATH.向量內積.01'));
        });

        test('先備改了：過時的 ai 先備移除；human 來源的先備一律不動', async () => {
            await load([readSeed('數學')]);
            await query(`INSERT INTO kc_prerequisites (kc_id, prereq_kc_id, src)
                         SELECT k.id, p.id, 'human' FROM knowledge_components k, knowledge_components p
                          WHERE k.code = 'MATH.向量的加減與係數積.03' AND p.code = 'MATH.向量內積.01'`);
            const seed = readSeed('數學');
            component(seed, 'MATH.向量的加減與係數積.03').prereqs = ['MATH.向量的加減與係數積.01'];   // 拿掉 .02
            const r = await load([seed]);
            assert.equal(r.counts.prereqRemoved, 1);
            const mine = (await edges()).filter(x => x.kc === 'MATH.向量的加減與係數積.03');
            assert.deepEqual(mine.map(x => [x.pre, x.src]), [['MATH.向量內積.01', 'human'], ['MATH.向量的加減與係數積.01', 'ai']]);
        });

        test('單檔載入時跨科成環 → DB 層的環檢查擋下，整批回滾', async () => {
            await load([readSeed('數學'), readSeed('物理')]);
            const seed = readSeed('數學');
            // 物理「功的定義」的先備是數學「內積的意義」；現在反過來也指回去 → 環
            component(seed, 'MATH.向量內積.01').prereqs = ['PHYS.功與動能.01'];
            component(seed, 'MATH.向量內積.01').description = '這次的修改不該留下來。';
            const r = await load([seed]);
            assert.equal(r.ok, false);
            assert.ok(r.errors[0].startsWith('先備關係有環'), r.errors[0]);
            assert.ok(r.errors[0].includes('MATH.向量內積.01') && r.errors[0].includes('PHYS.功與動能.01'));
            assert.notEqual((await row('MATH.向量內積.01')).description, '這次的修改不該留下來。');
            assert.ok(!(await edges()).some(x => x.kc === 'MATH.向量內積.01' && x.pre === 'PHYS.功與動能.01'));
        });

        test('dry-run：數字與真的載入相同，但最後回滾', async () => {
            const r = await load([readSeed('數學'), readSeed('物理')], { dryRun: true });
            assert.equal(r.ok, true);
            assert.equal(r.counts.inserted, 15);
            assert.equal(r.counts.prereqInserted, 13);
            assert.equal(await count('knowledge_components'), 0);
            assert.equal(await count('kc_prerequisites'), 0);
        });

        test('同章兩個草稿互換名稱／整排位移：不會撞 UNIQUE (subject, chapter, name)', async () => {
            await load([readSeed('數學')]);
            const seed = readSeed('數學');
            const a = component(seed, 'MATH.向量的加減與係數積.01');
            const b = component(seed, 'MATH.向量的加減與係數積.02');
            [a.name, b.name] = [b.name, a.name];
            const r = await load([seed]);
            assert.equal(r.ok, true, r.errors.join('\n'));
            assert.equal(r.counts.updated, 2);
            assert.equal((await row('MATH.向量的加減與係數積.01')).name, '向量的係數積');
            assert.equal((await row('MATH.向量的加減與係數積.02')).name, '向量的加法與減法');
        });

        test('新名稱撞到種子檔已沒有的舊列 → 整批回滾，error 指出是哪兩個知識點（不是裸的 23505）', async () => {
            await load([readSeed('數學')]);
            const seed = readSeed('數學');
            const old03 = component(seed, 'MATH.向量內積.03');
            seed.components = seed.components.filter(c => c.code !== 'MATH.向量內積.03');
            seed.components.push({ ...old03, code: 'MATH.向量內積.07', sort: 7 });   // 換了 code、沿用舊名
            const before = await count('knowledge_components');

            const r = await load([seed]);
            assert.equal(r.ok, false);
            assert.equal(r.errors.length, 1);
            const e = r.errors[0];
            assert.ok(!/duplicate key/.test(e), e);
            assert.ok(e.includes('MATH.向量內積.07') && e.includes('MATH.向量內積.03') && e.includes('夾角與垂直'), e);
            assert.ok(e.includes('已不在這次的種子檔中'), e);
            assert.equal(await count('knowledge_components'), before);
            assert.equal(await row('MATH.向量內積.07'), undefined);
        });

        test('新名稱撞到已審定受保護的列 → 整批回滾，error 提示 --force；--force 之後就載得進去', async () => {
            await load([readSeed('數學')]);
            // Owner 在畫面上把 .03 改名並審定；種子檔（仍是舊名）又把草稿 .01 改成同一個名字
            await query(`UPDATE knowledge_components SET name = '老師改過的名字', status = 'approved' WHERE code = 'MATH.向量內積.03'`);
            const seed = readSeed('數學');
            component(seed, 'MATH.向量內積.01').name = '老師改過的名字';

            const r = await load([seed]);
            assert.equal(r.ok, false);
            const e = r.errors[0];
            assert.ok(e.includes('MATH.向量內積.01') && e.includes('MATH.向量內積.03'), e);
            assert.ok(e.includes('已審定') && e.includes('--force'), e);
            assert.equal((await row('MATH.向量內積.03')).name, '老師改過的名字');
            assert.equal((await row('MATH.向量內積.01')).name, '內積的意義', '整批回滾');

            const forced = await load([seed], { force: true });
            assert.equal(forced.ok, true, forced.errors.join('\n'));
            assert.equal((await row('MATH.向量內積.01')).name, '老師改過的名字');
            assert.equal((await row('MATH.向量內積.03')).name, '夾角與垂直');
        });

        test('載入途中老師按「審定通過」：載入已鎖住該列，PATCH 要等載入結束（剛審定的不會被當草稿覆寫）', async () => {
            await load([readSeed('數學')]);
            const seed = readSeed('數學');
            component(seed, 'MATH.向量內積.01').description = '種子檔的新說明。';
            const { id } = await row('MATH.向量內積.01');

            // 包一層 pool：載入交易讀完現有列（載入計畫已定）的那一刻，另一條連線試著審定同一列。
            // 有鎖 → 那條連線等不到鎖（lock_timeout → 55P03）；沒鎖 → PATCH 先生效，再被載入蓋成草稿。
            let probe = null;
            const wrapped = {
                query,
                pool: {
                    async connect() {
                        const client = await pool.connect();
                        return {
                            release: (...a) => client.release(...a),
                            async query(text, values) {
                                const res = await client.query(text, values);
                                if (probe === null && /curriculum_code[\s\S]*FROM knowledge_components WHERE code = ANY/.test(text)) {
                                    const other = await pool.connect();
                                    try {
                                        await other.query("SET lock_timeout = '300ms'");
                                        await kc.patchKc({ query: (t, v) => other.query(t, v) }, id, { status: 'approved' });
                                        probe = 'patched';
                                    } catch (err) {
                                        probe = err.code || err.message;
                                    } finally {
                                        await other.query('RESET lock_timeout').catch(() => { });
                                        other.release();
                                    }
                                }
                                return res;
                            }
                        };
                    }
                }
            };
            const r = await kc.loadSeeds(wrapped, [seed], { chapters: CH });
            assert.equal(r.ok, true, r.errors.join('\n'));
            assert.equal(probe, '55P03', `載入交易讀現有列時沒有上鎖（probe=${probe}）`);
            assert.equal((await row('MATH.向量內積.01')).description, '種子檔的新說明。');

            // 載入結束後，老師再按一次就審定成功，而且再載入一次也不會被覆寫
            const after = await kc.patchKc(db, id, { status: 'approved' });
            assert.equal(after.status, 200);
            const again = await load([seed]);
            assert.equal(again.ok, true);
            assert.equal((await row('MATH.向量內積.01')).status, 'approved');
        });

        test('DB 有、種子檔沒有的知識點：不刪，只回報 orphans', async () => {
            await load([readSeed('數學')]);
            const seed = readSeed('數學');
            seed.components = seed.components.filter(c => c.code !== 'MATH.向量內積.06');
            const r = await kc.loadSeeds(db, [seed], { chapters: { '數學': ['向量的加減與係數積', '向量內積'] } });
            assert.equal(r.ok, true);
            assert.equal(r.counts.orphans, 1);
            assert.ok(await row('MATH.向量內積.06'));
        });
    });

    describe('scripts/load_kc.js（子行程，--test）', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-load-'));
        const SPOKEN = '這是測試用的口語版：直接對學生說，講操作和使用時機，最後一句點出最常見的錯，長度要超過四十個字才合格。';

        /** 完整涵蓋數學白名單每一章（每章 3 個）的合法種子檔——「任何符合第 3.4 條的檔」的代表 */
        function fullMathSeed() {
            const components = [];
            for (const chapter of CHAPTERS['數學']) {
                for (let i = 1; i <= 3; i++) {
                    const nn = String(i).padStart(2, '0');
                    components.push({
                        code: `MATH.${chapter}.${nn}`, chapter, sort: i, name: `${chapter}的知識點${i}`.slice(0, 30),
                        curriculum_code: null, description: `${chapter}的第 ${i} 個知識點（測試用敘述）。`,
                        spoken_text: SPOKEN, status: 'draft', prereqs: i > 1 ? [`MATH.${chapter}.01`] : []
                    });
                }
            }
            return { subject: '數學', version: 1, generated_at: '2026-09-24', source_note: '整合測試臨時產生', components };
        }
        const FULL = path.join(tmp, 'full-math.json');
        const BAD = path.join(tmp, 'bad-math.json');
        fs.writeFileSync(FULL, JSON.stringify(fullMathSeed()), 'utf8');
        const bad = fullMathSeed();
        bad.components = bad.components.filter(c => c.code !== `MATH.${CHAPTERS['數學'][0]}.03`);   // 第一章只剩 2 個
        fs.writeFileSync(BAD, JSON.stringify(bad), 'utf8');
        const total = CHAPTERS['數學'].length * 3;

        function cli(script, args) {
            return spawnSync(process.execPath, [path.join('scripts', script), ...args], {
                cwd: APP_DIR, encoding: 'utf8',
                env: { ...process.env, TEST_DATABASE_URL, DATABASE_URL: '' }
            });
        }

        beforeEach(async () => {
            await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
        });

        after(async () => {
            fs.rmSync(tmp, { recursive: true, force: true });
            await query('TRUNCATE question_kcs, kc_prerequisites, knowledge_components RESTART IDENTITY CASCADE');
            await pool.end();
        });

        test('kc:validate 對完整種子檔零 error', () => {
            const r = cli('validate_kc_seed.js', [FULL]);
            assert.equal(r.status, 0, r.stderr);
            assert.ok(r.stdout.includes(`數學：${total} 個知識點、${CHAPTERS['數學'].length} 章`));
        });

        test('--dry-run：印出數量但不寫入', async () => {
            const r = cli('load_kc.js', ['--file', FULL, '--dry-run', '--test']);
            assert.equal(r.status, 0, r.stderr);
            assert.ok(r.stdout.includes(`新增 ${total}、更新 0、略過 0`), r.stdout);
            assert.ok(r.stdout.includes('dry-run'));
            assert.equal(await count('knowledge_components'), 0);
        });

        test('載入完整種子檔：exit 0，印出新增數；再跑一次全部略過', async () => {
            let r = cli('load_kc.js', ['--file', FULL, '--test']);
            assert.equal(r.status, 0, r.stderr);
            assert.ok(r.stdout.includes(`新增 ${total}、更新 0、略過 0`), r.stdout);
            assert.ok(r.stdout.includes(`先備關係：新增 ${CHAPTERS['數學'].length * 2}`), r.stdout);
            assert.equal(await count('knowledge_components'), total);
            r = cli('load_kc.js', ['--file', FULL, '--test']);
            assert.equal(r.status, 0, r.stderr);
            assert.ok(r.stdout.includes(`新增 0、更新 0、略過 ${total}（內容相同 ${total}、已審定受保護 0）`), r.stdout);
        });

        test('不合法的種子檔：整批拒絕、exit 1、資料庫不動', async () => {
            const r = cli('load_kc.js', ['--file', BAD, '--test']);
            assert.equal(r.status, 1);
            assert.ok(r.stderr.includes('整批拒絕'), r.stderr);
            assert.ok(r.stderr.includes('2 個'), r.stderr);
            assert.equal(await count('knowledge_components'), 0);
        });

        test('未知參數 → exit 1；不是 JSON 的檔 → exit 1', () => {
            assert.equal(cli('load_kc.js', ['--bogus']).status, 1);
            const notJson = path.join(tmp, 'x.json');
            fs.writeFileSync(notJson, '{ 不是 json', 'utf8');
            const r = cli('load_kc.js', ['--file', notJson, '--test']);
            assert.equal(r.status, 1);
            assert.ok(r.stderr.includes('不是合法 JSON'));
        });
    });
}