// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherStop.test.js — 「關閉出題系統」的流程（scripts/desktop/lib/stopper.js；docs/desktop-launcher.md 第 4 節）
//
// 用 test/unit/lib/desktopWorld.js 的假機器：後端的 /api/launcher/* 回應、訊息框的回答、行程何時結束都由測試決定。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createWorld, SERVER_PID } = require('./lib/desktopWorld');
const { resolveConfig } = require('../../scripts/desktop/lib/config');
const { createProbes, appPaths } = require('../../scripts/desktop/lib/probes');
const { createUi } = require('../../scripts/desktop/lib/ui');
const { runStop, askText, fmtDuration, WAIT_ALL_MS } = require('../../scripts/desktop/lib/stopper');
const launcherControl = require('../../services/launcherControl');

const TOKEN = 'a'.repeat(64);

/**
 * @param {object} worldOpts
 * @param {{env?:object, config?:object, serverInfo?:object|null}} [o]
 */
async function stop(worldOpts, { env = {}, config = {}, serverInfo = { pid: SERVER_PID, port: 3000, token: TOKEN } } = {}) {
    const world = createWorld(worldOpts);
    const paths = appPaths('/app');
    if (serverInfo) world.files.set(paths.serverInfo, JSON.stringify(serverInfo));
    const { config: cfg } = resolveConfig(config);
    const lines = [];
    const log = l => lines.push(l);
    const ui = createUi({ sys: world.sys, config: cfg, statusHtml: '', log });
    const probes = createProbes({ sys: world.sys, config: cfg, env, paths, port: 3000 });
    const out = await runStop({ sys: world.sys, config: cfg, env, paths, probes, ui, log });
    const posts = world.calls.filter(c => c.kind === 'request' && c.method === 'POST');
    return { world, out, lines, paths, posts };
}

/** 假的 /api/launcher/*：status 回 inFlight 件，shutdown 回 202 */
function launcher({ inFlight = 0, shuttingDown = false, statusCode = 200 } = {}) {
    return (req) => {
        if (req.url.endsWith('/status')) {
            if (statusCode !== 200) return { status: statusCode, json: { message: 'x' }, text: '', errorCode: null };
            return { status: 200, json: { pid: SERVER_PID, in_flight: inFlight, shutting_down: shuttingDown }, text: '', errorCode: null };
        }
        const grace = req.body && req.body.grace_ms;
        return { status: 202, json: { pid: SERVER_PID, in_flight: inFlight, grace_ms: grace, already: false }, text: '', errorCode: null };
    };
}

describe('關閉：先認清楚 3000 埠上是誰', () => {
    test('後端沒在跑 → 告訴 Owner 不需要關閉；預設不碰 Docker／Ollama', async () => {
        const r = await stop({ health: 'down' });
        assert.equal(r.out.result, 'not-running');
        assert.match(r.world.popups[0].text, /沒有在執行/);
        assert.ok(!r.world.calls.some(c => c.kind === 'exec' && /docker|taskkill/.test(c.file)));
    });

    test('埠上是別的程式 → 不動它', async () => {
        const r = await stop({ health: 'other' });
        assert.equal(r.out.result, 'other');
        assert.equal(r.posts.length, 0);
    });

    // 〔審查 dec/desktop-launcher 第 5 件〕
    test('健康檢查逾時、而聽著埠的是 server.json 記的後端 → 說「後端正忙」（不說不是出題系統），請 Owner 稍後再按', async () => {
        const r = await stop({
            health: 'busy',
            netstat: '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       7100\r\n',
            tasklist: '"node.exe","7100","Console","1","300,000 K"'
        });
        assert.equal(r.out.result, 'busy');
        assert.match(r.world.popups[0].text, /PID 7100/);
        assert.match(r.world.popups[0].text, /稍後|等一兩分鐘/);
        assert.doesNotMatch(r.world.popups[0].text, /不是出題系統/);
        // 〔dec/desktop-launcher-fix2〕強制結束的後果照實說：單題接著做
        // 〔DA-13，dec/r7-checkpoints〕拆題與變式從中斷的那一塊／那一題重做（原本整份重跑）
        // 〔dec/r7-checkpoints-fix，依審查〕變式照實說「只補還沒建成的題」
        assert.match(r.world.popups[0].text, /單題的檢查從中斷那一步接著做/);
        assert.match(r.world.popups[0].text, /整份卷的拆題從中斷的那一塊重拆，已經拆完的塊不會重拆/);
        assert.match(r.world.popups[0].text, /變式生成只補還沒建成的題，已經建好的題不會重做/);
        assert.doesNotMatch(r.world.popups[0].text, /變式生成從中斷的那一題重做/);
        assert.doesNotMatch(r.world.popups[0].text, /從頭再跑一次/);
        assert.doesNotMatch(r.world.popups[0].text, /沒跑完的那一步下次開啟時會自動重跑/);
        assert.equal(r.posts.length, 0);
        // 聽著埠的是別的 PID → 照舊說不是出題系統
        const other = await stop({ health: 'busy', netstat: '  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   55\r\n', tasklist: '"java.exe","55","Console","1","1 K"' });
        assert.equal(other.out.result, 'other');
    });

    test('後端不是啟動器開的（沒有 server.json）→ 請 Owner 到那個視窗按 Ctrl+C，不強制結束', async () => {
        const r = await stop({ health: 'ours', db: true }, { serverInfo: null });
        assert.equal(r.out.result, 'not-launcher');
        assert.match(r.world.popups[0].text, /Ctrl\+C/);
        assert.equal(r.posts.length, 0);
        assert.ok(!r.world.calls.some(c => c.kind === 'exec' && c.file === 'taskkill'));
    });

    test('有 server.json 但後端沒有關閉通道（404，例如之後改用 npm start 開）或權杖對不上（403）→ 同上', async () => {
        for (const statusCode of [404, 403]) {
            const r = await stop({ health: 'ours', db: true, launcherStatus: statusCode === 404 ? null : launcher({ statusCode }) });
            assert.equal(r.out.result, 'not-launcher', String(statusCode));
            assert.equal(r.posts.length, 0);
        }
    });

    test('API_KEY 對不上（401）→ 說明原因', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher({ statusCode: 401 }) });
        assert.equal(r.out.result, 'api-key');
        assert.match(r.world.popups[0].text, /API_KEY/);
    });
});

describe('關閉：優雅關閉', () => {
    test('沒有背景工作 → 不問、送出關閉（帶權杖與 API 金鑰）、等行程結束、刪 server.json、告知已關閉', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher() }, { env: { API_KEY: 'k-123' } });
        assert.equal(r.out.result, 'stopped');
        assert.equal(r.posts.length, 1);
        assert.equal(r.posts[0].url, 'http://127.0.0.1:3000/api/launcher/shutdown');
        assert.equal(r.posts[0].headers['x-launcher-token'], TOKEN);
        assert.equal(r.posts[0].headers['x-api-key'], 'k-123');
        assert.deepEqual(r.posts[0].body, { grace_ms: 120_000 });
        assert.equal(r.world.files.has(r.paths.serverInfo), false);
        assert.equal(r.world.popups.length, 1);
        assert.match(r.world.popups[0].text, /已關閉/);
    });

    test('有背景工作 → 先問；「是」＝等它們跑完（6 小時上限）', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher({ inFlight: 2 }), popupAnswers: ['yes'], pidExitAfterMs: 5_000 });
        assert.match(r.world.popups[0].text, /2 件/);
        assert.deepEqual(r.posts[0].body, { grace_ms: WAIT_ALL_MS });
        assert.equal(WAIT_ALL_MS, launcherControl.MAX_GRACE_MS);
        assert.equal(r.out.result, 'stopped');
    });

    test('「否」＝最多等 stopGraceSec；「取消」＝不關', async () => {
        const no = await stop({ health: 'ours', db: true, launcherStatus: launcher({ inFlight: 1 }), popupAnswers: ['no'] }, { config: { stopGraceSec: 30 } });
        assert.deepEqual(no.posts[0].body, { grace_ms: 30_000 });
        const cancel = await stop({ health: 'ours', db: true, launcherStatus: launcher({ inFlight: 1 }), popupAnswers: ['cancel'] });
        assert.equal(cancel.out.result, 'cancelled');
        assert.equal(cancel.posts.length, 0);
    });

    test('askBeforeStopWithJobs:false → 不問，直接用 stopGraceSec', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher({ inFlight: 3 }) }, { config: { askBeforeStopWithJobs: false } });
        assert.equal(r.world.popups.filter(p => /件工作正在跑/.test(p.text)).length, 0);
        assert.deepEqual(r.posts[0].body, { grace_ms: 120_000 });
    });

    test('背景工作沒在時限內收完 → 告訴 Owner 後端會自己關，server.json 記下關閉要求（下次啟動器看得到）', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher({ inFlight: 1 }), popupAnswers: ['yes'], pidExitAfterMs: Infinity });
        assert.equal(r.out.result, 'draining');
        const info = JSON.parse(r.world.files.get(r.paths.serverInfo));
        assert.equal(info.graceMs, WAIT_ALL_MS);
        assert.ok(info.shutdownRequestedAt);
        assert.equal(info.token, TOKEN);
        assert.match(r.world.popups[1].text, /自己關閉/);
        // 〔dec/desktop-launcher-fix2〕等不及就關機的後果照實說
        assert.match(r.world.popups[1].text, /關機或重新開機也可以/);
        assert.match(r.world.popups[1].text, /整份卷的拆題從中斷的那一塊重拆，已經拆完的塊不會重拆/);
        assert.match(r.world.popups[1].text, /變式生成只補還沒建成的題，已經建好的題不會重做/);
    });

    test('已經在關閉中 → 不重送', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher({ shuttingDown: true }) });
        assert.equal(r.out.result, 'already');
        assert.equal(r.posts.length, 0);
    });
});

describe('關閉：Docker 與 Ollama（預設不關，設定可選）', () => {
    test('stopDocker:containers → 後端結束後 docker compose stop（資料保留）', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher() }, { config: { stopDocker: 'containers' } });
        const docker = r.world.calls.filter(c => c.kind === 'exec' && c.file === 'docker' && c.args[0] !== '--version');
        assert.deepEqual(docker.map(c => c.args), [['compose', 'stop']]);
        assert.equal(docker[0].opts.cwd, require('node:path').join('/app'));
        assert.match(r.world.popups[0].text, /資料庫容器已停止/);
    });

    test('stopDocker:desktop → 再 docker desktop stop；stopOllama → taskkill 兩個程式', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher() }, { config: { stopDocker: 'desktop', stopOllama: true } });
        const docker = r.world.calls.filter(c => c.kind === 'exec' && c.file === 'docker' && c.args[0] !== '--version').map(c => c.args);
        assert.deepEqual(docker, [['compose', 'stop'], ['desktop', 'stop']]);
        const kills = r.world.calls.filter(c => c.kind === 'exec' && c.file === 'taskkill').map(c => c.args);
        assert.deepEqual(kills, [['/IM', 'ollama app.exe', '/F'], ['/IM', 'ollama.exe', '/F']]);
    });

    test('錄製進行中（或無法確認）→ 就算設定要關也不關', async () => {
        const recording = [{ ProcessId: 5, Name: 'node.exe', CommandLine: 'node eval/tools/rerecord_all.js' }];
        for (const opts of [{ processes: recording }, { psFails: true }]) {
            const r = await stop({ health: 'ours', db: true, launcherStatus: launcher(), ...opts }, { config: { stopDocker: 'containers', stopOllama: true } });
            assert.ok(!r.world.calls.some(c => c.kind === 'exec' && (c.args[0] === 'compose' || c.file === 'taskkill')), JSON.stringify(opts));
            assert.match(r.world.popups[0].text, /維持開著/);
        }
    });

    test('後端還在收尾時不關 Docker／Ollama（它還在用）', async () => {
        const r = await stop({ health: 'ours', db: true, launcherStatus: launcher({ inFlight: 1 }), popupAnswers: ['yes'], pidExitAfterMs: Infinity }, { config: { stopDocker: 'containers', stopOllama: true } });
        assert.ok(!r.world.calls.some(c => c.kind === 'exec' && (c.args[0] === 'compose' || c.file === 'taskkill')));
        assert.match(r.world.popups[1].text, /Docker／Ollama 這次沒有關/);
    });

    test('後端本來就沒在跑、但設定要關 Docker → 照設定關（沒有錄製時）', async () => {
        const r = await stop({ health: 'down' }, { config: { stopDocker: 'containers' } });
        assert.ok(r.world.calls.some(c => c.kind === 'exec' && c.args[0] === 'compose' && c.args[1] === 'stop'));
    });
});

describe('文字', () => {
    test('fmtDuration', () => {
        assert.equal(fmtDuration(30_000), '30 秒');
        assert.equal(fmtDuration(120_000), '2 分鐘');
        assert.equal(fmtDuration(6 * 3600_000), '6 小時');
        assert.equal(fmtDuration(90 * 60_000), '1 小時 30 分');
    });
    test('askText 說清楚三個選項各自的後果', () => {
        const t = askText(2, 120_000);
        assert.match(t, /2 件/);
        assert.match(t, /「是」/);
        assert.match(t, /「否」：最多等 2 分鐘/);
        // 〔dec/desktop-launcher-fix2〕原本斷言「重跑」（舊句：從那一步重跑、已完成的不會重做）。
        // 〔DA-13，dec/r7-checkpoints〕拆題與變式改成逐塊／逐題的檢查點（workers/jobRunner.js 的 runExtractJob／runGenerateJob）：
        // 單題的檢查從中斷那一步接著做，拆題從中斷的那一塊重拆，做完的塊不重拆。
        // 〔dec/r7-checkpoints-fix，依審查〕變式不是「只重做中斷的那一題」：還沒建成的題（含之前沒過閘門的）都會再生成
        assert.match(t, /單題的檢查從中斷那一步接著做/);
        assert.match(t, /整份卷的拆題從中斷的那一塊重拆，已經拆完的塊不會重拆（本機拆一塊約 30～45 分鐘）；/);
        assert.match(t, /變式生成只補還沒建成的題，已經建好的題不會重做（中斷的那一題與之前沒通過檢查的題會再生成一次）。/);
        assert.doesNotMatch(t, /變式生成從中斷的那一題重做/);
        assert.doesNotMatch(t, /從頭再跑一次/);
        assert.match(t, /「是」：.*本機拆一份卷可能要 1 小時以上/);
        assert.doesNotMatch(t, /已完成的不會重做/);
        assert.match(t, /「取消」/);
    });
});
