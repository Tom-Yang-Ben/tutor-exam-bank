// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherRun.test.js — 桌面啟動器從頭跑到尾（lib/launcher.js＋lib/actions.js＋lib/ui.js）
//
// 用 test/unit/lib/desktopWorld.js 模擬 Owner 的 Windows 筆電（Docker Desktop、資料庫、Ollama、node server.js、Edge、
// PowerShell 訊息框都是假的；時間也是假的），雲端 Linux 上把每一種情境真的執行一遍，斷言：
// 做了哪些步驟、有沒有碰 Docker、開了幾個視窗、後端怎麼開、啟動畫面最後顯示什麼。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createWorld, decodePs, TODAY, NODE, DOCKER_DESKTOP, EDGE, CHROME, OLLAMA_APP, LOCAL, SERVER_PID } = require('./lib/desktopWorld');
const { resolveConfig } = require('../../scripts/desktop/lib/config');
const { createProbes, appPaths, portFromEnv } = require('../../scripts/desktop/lib/probes');
const { createActions, drainingFrom } = require('../../scripts/desktop/lib/actions');
const { createUi } = require('../../scripts/desktop/lib/ui');
const { runLaunch, lockDecision, acquireLock, summarize } = require('../../scripts/desktop/lib/launcher');
const { listMigrationFiles } = require('../../utils/migrationStatus');

const STATUS_URL = 'http://127.0.0.1:50123/';
const path = require('node:path');
/** 假的 exam_pro 底下的路徑（用 path.join：在 Windows 上跑 npm test 也對得上 appPaths 的結果） */
const P = (...s) => path.join('/app', ...s);
const PY = 'C:\\py\\python.exe';
const BASE_ENV = Object.freeze({ DATABASE_URL: 'postgres://exam:exam@localhost:5442/tutor_exam_bank', OCR_PYTHON: PY });

/**
 * 跑一次啟動器。
 * @param {object} [worldOpts]  createWorld 的設定
 * @param {object} [o]
 * @param {object} [o.env]       .env（＋系統環境）
 * @param {object} [o.config]    data/launcher/config.json
 * @param {boolean} [o.pageWorks=true] 啟動頁會不會載入並輪詢（false＝視窗開了但頁面沒回應）
 * @param {boolean} [o.envFile=true]   .env 在不在
 * @param {object} [o.actionsOverride]
 */
async function launch(worldOpts = {}, { env = {}, config = {}, pageWorks = true, envFile = true, actionsOverride = {} } = {}) {
    const world = createWorld({ ...worldOpts, exists: [...(worldOpts.exists || [DOCKER_DESKTOP, EDGE, OLLAMA_APP]), PY] });
    const paths = appPaths('/app');
    if (envFile) world.existing.add(paths.envFile);
    world.existing.add(paths.nodeModules);
    const fullEnv = { ...BASE_ENV, ...env };
    const { config: cfg } = resolveConfig(config);
    const port = portFromEnv(fullEnv);
    const ctx = {
        port, appUrl: `http://localhost:${port}/`, nodePath: NODE,
        dockerDesktopPath: cfg.dockerDesktopPath, dockerReadyTimeoutSec: cfg.dockerReadyTimeoutSec,
        ollamaReadyTimeoutSec: cfg.ollamaReadyTimeoutSec, serverReadyTimeoutSec: cfg.serverReadyTimeoutSec,
        serverLog: P('data', 'logs', `server-${TODAY}.log`), launcherLog: P('data', 'logs', `launcher-${TODAY}.log`)
    };
    const lines = [];
    const log = l => lines.push(l);

    // 假的啟動頁伺服器：視窗開到它的網址、而且 pageWorks 時，每次 sleep 就當成頁面讀了一次 /state
    const page = { getState: null, onDelivered: null, states: [] };
    const startServer = async ({ getState, onDelivered }) => {
        page.getState = getState;
        page.onDelivered = onDelivered;
        return { url: STATUS_URL, port: 50123, close: async () => { } };
    };
    const realSleep = world.sys.sleep;
    world.sys.sleep = async ms => {
        await realSleep(ms);
        if (pageWorks && page.getState && world.windows.some(x => x.url === STATUS_URL)) {
            const s = page.getState();
            page.states.push(s);
            page.onDelivered(s.version);
        }
    };

    const ui = createUi({ sys: world.sys, config: cfg, statusHtml: '<html></html>', log, startServer });
    const probes = createProbes({ sys: world.sys, config: cfg, env: fullEnv, paths, port });
    const actions = { ...createActions({ sys: world.sys, config: cfg, env: fullEnv, paths, ctx, ui, probes, log }), ...actionsOverride };
    const result = await runLaunch({ actions, ui, ctx, log });
    const steps = lines.filter(l => l.startsWith('→ ')).map(l => l.slice(2));
    const finalState = page.states.length ? page.states[page.states.length - 1] : ui.getState();
    return { world, result, steps, lines, ui, paths, finalState, cfg };
}

const dockerCalls = world => world.calls.filter(c => (c.kind === 'exec' || c.kind === 'spawn') && /docker/i.test(c.file));
const serverSpawns = world => world.calls.filter(c => c.kind === 'spawn' && c.file === NODE);
const codes = r => r.result.warnings.map(w => w.code);

describe('已經在跑', () => {
    test('健康檢查通過 → 只開一個 app 視窗（Edge app 模式＋獨立設定檔），不碰 Docker、不起後端', async () => {
        const r = await launch({ health: 'ours', db: true });
        assert.equal(r.result.action.type, 'open-app');
        assert.deepEqual(r.steps, ['probe-health']);
        assert.deepEqual(dockerCalls(r.world), []);
        assert.deepEqual(serverSpawns(r.world), []);
        assert.equal(r.world.windows.length, 1);
        const win = r.world.windows[0];
        assert.equal(win.via, 'edge');
        assert.equal(win.url, 'http://localhost:3000/');
        assert.ok(win.args.includes(`--user-data-dir=${LOCAL}\\TutorExamBank\\browser-profile\\edge`));
        assert.ok(win.args.includes('--no-first-run'));
    });

    test('沒有 /api/health 的舊版本系統在跑 → 看首頁認出來，一樣直接開視窗', async () => {
        const r = await launch({ health: 'legacy' });
        assert.equal(r.result.action.type, 'open-app');
        assert.equal(r.result.facts.health.legacy, true);
    });

    test('.env 的 PORT 改過 → 健康檢查與 app 網址都跟著改', async () => {
        const r = await launch({ health: 'ours', db: true }, { env: { PORT: '3100' } });
        assert.ok(r.world.calls.some(c => c.kind === 'request' && c.url === 'http://127.0.0.1:3100/api/health'));
        assert.equal(r.world.windows[0].url, 'http://localhost:3100/');
    });

    test('後端在跑、但 Docker 被關掉 → 開 Docker、起容器，然後直接開畫面（不另起後端）', async () => {
        const r = await launch({ health: 'ours', db: false });
        assert.equal(r.result.action.type, 'finish');
        assert.equal(r.result.action.reason, 'db-restored');
        assert.ok(r.steps.includes('launch-docker'));
        assert.ok(r.steps.includes('compose-up'));
        assert.ok(!r.steps.includes('check-setup'));
        assert.deepEqual(serverSpawns(r.world), []);
    });
});

describe('冷開機：什麼都沒開', () => {
    test('依序開 Docker Desktop → 等就緒 → compose up → Ollama → 背景起後端 → 啟動頁轉到系統首頁', async () => {
        const r = await launch({});
        assert.equal(r.result.action.type, 'finish');
        assert.equal(r.result.action.reason, 'started');
        assert.deepEqual(r.steps, [
            'probe-health', 'open-status-window', 'check-setup', 'detect-recording', 'probe-db',
            'probe-docker', 'launch-docker', 'wait-docker', 'compose-up', 'wait-db',
            'resolve-ollama-need', 'probe-ollama', 'launch-ollama', 'wait-ollama',
            'check-migrations', 'spawn-server', 'wait-server'
        ]);
        // docker compose up -d --wait（＝npm run db:up），在 exam_pro 裡執行
        const compose = r.world.calls.find(c => c.kind === 'exec' && c.args[0] === 'compose');
        assert.deepEqual(compose.args, ['compose', 'up', '-d', '--wait']);
        assert.equal(compose.opts.cwd, P());
        assert.ok(r.world.calls.some(c => c.kind === 'spawn' && c.file === DOCKER_DESKTOP));
        assert.ok(r.world.calls.some(c => c.kind === 'spawn' && c.file === OLLAMA_APP));
        assert.deepEqual(codes(r), []);
        // 只開了一個視窗（啟動頁），完成時由啟動頁自己轉頁
        assert.equal(r.world.windows.length, 1);
        assert.equal(r.world.windows[0].url, STATUS_URL);
        assert.equal(r.finalState.phase, 'done');
        assert.equal(r.finalState.appUrl, 'http://localhost:3000/');
        assert.deepEqual(r.finalState.warnings, []);
    });

    test('後端：node server.js 在背景、log 寫到 data/logs/server-日期.log、環境與 npm start 相同只多權杖、權杖寫進 server.json', async () => {
        const r = await launch({});
        const [spawn] = serverSpawns(r.world);
        assert.deepEqual(spawn.args, [P('server.js')]);
        assert.equal(spawn.opts.cwd, P());
        assert.equal(spawn.opts.logFile, P('data', 'logs', `server-${TODAY}.log`));
        const token = spawn.opts.env.LAUNCHER_CONTROL_TOKEN;
        assert.match(token, /^[0-9a-f]{64}$/);
        // 不把啟動器讀到的 .env 帶給後端（後端自己讀 .env）：環境＝系統環境＋權杖
        assert.deepEqual(Object.keys(spawn.opts.env).sort(), [...Object.keys(r.world.env), 'LAUNCHER_CONTROL_TOKEN'].sort());
        assert.equal(spawn.opts.env.DATABASE_URL, undefined);
        const info = JSON.parse(r.world.files.get(r.paths.serverInfo));
        assert.equal(info.pid, SERVER_PID);
        assert.equal(info.token, token);
        assert.equal(info.port, 3000);
        assert.match(r.world.files.get(P('data', 'logs', `server-${TODAY}.log`)), /桌面啟動器啟動後端/);
        // 權杖不寫進 launcher log
        assert.ok(!r.lines.join('\n').includes(token));
    });

    test('只提示、不自動升級：整個流程沒有執行任何 migrate', async () => {
        const r = await launch({ applied: listMigrationFiles().slice(0, -2) });
        assert.equal(r.result.action.type, 'finish');
        assert.deepEqual(codes(r), ['migrations-pending']);
        assert.ok(!r.world.calls.some(c => c.kind === 'exec' && /npm|migrate/.test(`${c.file} ${c.args.join(' ')}`)));
        assert.ok(!r.world.calls.some(c => c.kind === 'pg' && !/^SELECT/i.test(c.sql)), '只下 SELECT');
        // 有警告時啟動頁停在「注意事項」等 Owner 按
        assert.equal(r.finalState.phase, 'done');
        assert.equal(r.finalState.warnings.length, 1);
    });

    test('全新的空資料庫（沒有 schema_migrations）→ 提示先 npm run migrate', async () => {
        const r = await launch({ applied: null });
        assert.deepEqual(codes(r), ['migrations-empty']);
    });

    test('Docker 已在跑、資料庫已開 → 完全不碰 Docker', async () => {
        const r = await launch({ dockerEngine: true, db: true });
        assert.deepEqual(dockerCalls(r.world), []);
        assert.ok(!r.steps.includes('probe-docker'));
    });

    test('Docker 引擎在跑、只是容器沒開 → 不開 Docker Desktop、直接 compose up', async () => {
        const r = await launch({ dockerEngine: true });
        assert.ok(!r.world.calls.some(c => c.kind === 'spawn' && c.file === DOCKER_DESKTOP));
        assert.ok(r.steps.includes('compose-up'));
        assert.equal(r.result.action.type, 'finish');
    });

    test('docker 不在 PATH 上 → 改用 Docker Desktop 旁的 resources\\bin\\docker.exe', async () => {
        const cli = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
        const r = await launch({ dockerCliOnPath: false, exists: [DOCKER_DESKTOP, EDGE, OLLAMA_APP, cli] });
        assert.equal(r.result.action.type, 'finish');
        assert.ok(r.world.calls.some(c => c.kind === 'exec' && c.file === cli && c.args[0] === 'compose'));
    });
});

describe('Docker 的失敗', () => {
    test('Docker Desktop 一直沒就緒 → 等滿 240 秒後報錯（逾時可設定）', async () => {
        const r = await launch({ dockerStartsInMs: Infinity });
        assert.equal(r.result.action.code, 'docker-timeout');
        assert.ok(r.result.facts.dockerWait.waitedMs >= 240_000);
        assert.equal(r.finalState.phase, 'failed');
        assert.equal(r.finalState.failure.title, 'Docker Desktop 太久沒有就緒');
        const r2 = await launch({ dockerStartsInMs: Infinity }, { config: { dockerReadyTimeoutSec: 30 } });
        assert.ok(r2.result.facts.dockerWait.waitedMs < 40_000);
        assert.match(r2.result.action.message, /30 秒/);
    });

    test('Docker Desktop 沒裝在預設位置 → 報找不到，並指出可以在 config.json 設 dockerDesktopPath', async () => {
        const r = await launch({ exists: [EDGE, OLLAMA_APP] });
        assert.equal(r.result.action.code, 'docker-not-found');
        assert.match(r.result.action.hint.join('\n'), /dockerDesktopPath/);
        const custom = 'D:\\Apps\\Docker\\Docker Desktop.exe';
        const r2 = await launch({ exists: [EDGE, OLLAMA_APP, custom] }, { config: { dockerDesktopPath: custom } });
        assert.ok(r2.world.calls.some(c => c.kind === 'spawn' && c.file === custom));
    });

    test('compose up 失敗 → 報錯，detail 帶出 docker 的輸出', async () => {
        const r = await launch({ dockerEngine: true, composeCode: 1 });
        assert.equal(r.result.action.code, 'compose-failed');
        assert.match(r.result.action.detail, /Ports are not available/);
        assert.deepEqual(serverSpawns(r.world), []);
    });
});

describe('錄製進行中（record_local.bat／cassettes:rerecord）', () => {
    const recording = [
        { ProcessId: 501, Name: 'cmd.exe', CommandLine: 'C:\\Windows\\system32\\cmd.exe /c ""D:\\期中專案\\exam_pro\\scripts\\windows\\record_local.bat" "' },
        { ProcessId: 502, Name: 'node.exe', CommandLine: '"C:\\node\\node.exe" eval/tools/rerecord_all.js' }
    ];

    test('資料庫沒開 → 報錯，完全不碰 Docker、不起後端', async () => {
        const r = await launch({ processes: recording });
        assert.equal(r.result.action.code, 'recording-db-down');
        assert.deepEqual(dockerCalls(r.world), []);
        assert.deepEqual(serverSpawns(r.world), []);
        assert.match(r.result.action.detail, /record_local\.bat/);
    });

    test('資料庫本來就開著 → 照常啟動後端（不碰 Docker、不 migrate），但警告會搶 CPU', async () => {
        const r = await launch({ processes: recording, dockerEngine: true, db: true });
        assert.equal(r.result.action.type, 'finish');
        assert.deepEqual(dockerCalls(r.world), []);
        assert.deepEqual(codes(r), ['recording']);
    });

    test('PowerShell 自己的命令列、其他程式碰巧含這些字 → 不算', async () => {
        const r = await launch({
            processes: [
                { ProcessId: 600, Name: 'powershell.exe', CommandLine: 'powershell -Command "rerecord_all.js"' },
                { ProcessId: 601, Name: 'node.exe', CommandLine: 'node server.js' }
            ]
        });
        assert.equal(r.result.facts.recording.active, false);
    });

    // 〔審查 dec/desktop-launcher 第 4 件；DL-4〕
    test('預設（jobsWhileRecording:run）：後端照常跑背景工作，警告寫明佇列裡的工作也會開跑', async () => {
        const r = await launch({ processes: recording, dockerEngine: true, db: true });
        assert.equal(r.world.serverEnv.JOB_RUNNER, undefined);
        assert.match(r.result.warnings[0].text, /佇列裡已有的背景工作/);
    });

    test('jobsWhileRecording:pause → 後端以 JOB_RUNNER=off 啟動，警告說明錄完後怎麼恢復；沒在錄製時不受影響', async () => {
        const r = await launch({ processes: recording, dockerEngine: true, db: true }, { config: { jobsWhileRecording: 'pause' } });
        assert.equal(r.result.action.type, 'finish');
        assert.equal(r.world.serverEnv.JOB_RUNNER, 'off');
        assert.equal(r.result.facts.server.jobsPaused, true);
        assert.equal(JSON.parse(r.world.files.get(r.paths.serverInfo)).jobsPaused, true);
        assert.match(r.result.warnings[0].text, /暫停背景工作/);
        const normal = await launch({ dockerEngine: true, db: true }, { config: { jobsWhileRecording: 'pause' } });
        assert.equal(normal.world.serverEnv.JOB_RUNNER, undefined);
        assert.equal(normal.result.facts.server.jobsPaused, undefined);
    });

    test('讀不到程序清單 → 不當成錄製中（照常開 Docker），但警告無法確認', async () => {
        const r = await launch({ psFails: true });
        assert.equal(r.result.facts.recording.active, null);
        assert.equal(r.result.action.type, 'finish');
        assert.ok(codes(r).includes('recording-unknown'));
    });
});

describe('埠與後端的失敗', () => {
    test('3000 埠被別的程式佔用 → 用 netstat／tasklist 查出是誰，報錯，不起後端', async () => {
        const r = await launch({
            health: 'other',
            netstat: '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321\r\n  TCP    [::]:3000              [::]:0                 LISTENING       4321\r\n',
            tasklist: '"java.exe","4321","Console","1","120,000 K"\r\n'
        });
        assert.equal(r.result.action.code, 'port-in-use');
        assert.match(r.result.action.message, /java\.exe（PID 4321）/);
        assert.deepEqual(serverSpawns(r.world), []);
        assert.deepEqual(dockerCalls(r.world), []);
        const check = r.finalState.steps.find(s => s.id === 'check');
        assert.equal(check.state, 'error');
    });

    test('後端起來後因 EADDRINUSE 結束 → 查佔用者、報埠被佔用（歸在「啟動後端」）', async () => {
        const r = await launch({ db: true, dockerEngine: true, server: 'exit-addrinuse', netstat: '  TCP    127.0.0.1:3000   0.0.0.0:0   LISTENING   77\r\n', tasklist: '"python.exe","77","Console","1","9 K"' });
        assert.equal(r.result.action.code, 'port-in-use');
        assert.equal(r.result.facts.serverWait.addrInUse, true);
        assert.match(r.result.action.message, /python\.exe（PID 77）/);
        assert.equal(r.finalState.steps.find(s => s.id === 'server').state, 'error');
    });

    test('後端啟動後立刻結束 → 報錯，detail 是 log 最後幾行（只含這一次啟動寫的）', async () => {
        const logFile = P('data', 'logs', `server-${TODAY}.log`);
        const r = await launch({ db: true, dockerEngine: true, server: 'exit-crash', files: { [logFile]: '舊的一次：Error: something else\n' } });
        assert.equal(r.result.action.code, 'server-exited');
        assert.match(r.result.action.detail, /缺少 DATABASE_URL/);
        assert.doesNotMatch(r.result.action.detail, /舊的一次/);
    });

    test('後端一直沒回應 → 等滿 serverReadyTimeoutSec 後報逾時', async () => {
        const r = await launch({ db: true, dockerEngine: true, server: 'hang' }, { config: { serverReadyTimeoutSec: 30 } });
        assert.equal(r.result.action.code, 'server-timeout');
        assert.match(r.result.action.message, /30 秒/);
    });

    // 〔審查 dec/desktop-launcher 第 2 件〕以下三個用 Express 5 的真實行為（desktopWorld 檔頭）
    test('後端因 EACCES 結束、查不到誰在聽 → 報埠被 Windows 保留（提示 netsh），不說被佔用', async () => {
        const r = await launch({ db: true, dockerEngine: true, server: 'exit-eacces' });
        assert.equal(r.result.action.code, 'port-reserved');
        assert.equal(r.result.facts.serverWait.listenError, 'EACCES');
        assert.match(r.result.action.hint.join('\n'), /excludedportrange/);
        assert.match(r.result.action.detail, /listen EACCES/);
        assert.equal(r.finalState.steps.find(s => s.id === 'server').state, 'error');
    });

    test('修正前的 server.js（listen 錯誤被吞、不結束、不聽埠）：逾時時查到埠被別的程式聽著 → 結束自己開的後端，再報埠被佔用', async () => {
        const r = await launch({
            db: true, dockerEngine: true, server: 'listen-swallowed',
            netstat: '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       77\r\n',
            tasklist: '"python.exe","77","Console","1","9 K"'
        }, { config: { serverReadyTimeoutSec: 30 } });
        assert.equal(r.result.action.code, 'port-in-use');
        assert.deepEqual(r.steps.slice(-3), ['wait-server', 'describe-port', 'stop-server']);
        const kill = r.world.calls.find(c => c.kind === 'exec' && c.file === 'taskkill');
        assert.deepEqual(kill.args, ['/PID', String(SERVER_PID), '/T', '/F']);
        assert.equal(r.world.sys.pidAlive(SERVER_PID), false, '不留下孤兒後端');
        assert.equal(r.world.files.has(r.paths.serverInfo), false, 'server.json 一併清掉（關閉捷徑不會去找它）');
        assert.deepEqual(r.result.facts.serverStop, { pid: SERVER_PID, stopped: true });
        assert.match(r.result.action.message, /python\.exe（PID 77）/);
        assert.match(r.result.action.hint[0], /已經由啟動器結束/);
    });

    test('後端逾時、埠上沒人在聽（只是慢）→ 不結束它，照舊報逾時', async () => {
        const r = await launch({ db: true, dockerEngine: true, server: 'hang' }, { config: { serverReadyTimeoutSec: 30 } });
        assert.equal(r.result.action.code, 'server-timeout');
        assert.equal(r.result.facts.serverWait.childAlive, true);
        assert.ok(!r.world.calls.some(c => (c.kind === 'exec' && c.file === 'taskkill') || c.kind === 'kill'));
        assert.equal(r.world.sys.pidAlive(SERVER_PID), true);
    });

    // 〔審查 dec/desktop-launcher 第 5 件〕
    test('健康檢查一直逾時、聽著埠的是 server.json 記的後端 → 報「後端沒有回應」（不說被其他程式佔用、不起第二個後端）', async () => {
        const logFile = P('data', 'logs', 'server-2026-09-26.log');
        const r = await launch({
            health: 'busy', alive: [SERVER_PID],
            netstat: '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       7100\r\n',
            tasklist: '"node.exe","7100","Console","1","300,000 K"',
            files: { [P('data', 'launcher', 'server.json')]: JSON.stringify({ pid: SERVER_PID, port: 3000, token: 't', logFile }) }
        });
        assert.equal(r.result.action.code, 'server-busy');
        assert.match(r.result.action.hint.join('\n'), /server-2026-09-26\.log/);
        assert.deepEqual(serverSpawns(r.world), []);
        assert.deepEqual(dockerCalls(r.world), []);
    });

    test('開不起 node → server-spawn-failed', async () => {
        const r = await launch({ db: true, dockerEngine: true, server: 'spawn-fail' });
        assert.equal(r.result.action.code, 'server-spawn-failed');
    });

    test('.env 不在 → 報錯、不碰任何東西；DATABASE_URL 沒設 → 報錯', async () => {
        const r = await launch({}, { envFile: false });
        assert.equal(r.result.action.code, 'env-missing');
        assert.deepEqual(dockerCalls(r.world), []);
        const r2 = await launch({}, { env: { DATABASE_URL: '' } });
        assert.equal(r2.result.action.code, 'db-url-missing');
    });
});

describe('本機 AI（Ollama）：失敗只警告、不擋開機', () => {
    test('Ollama 沒在跑也找不到 → 照常開系統，警告拆題會失敗', async () => {
        const r = await launch({ db: true, dockerEngine: true, exists: [DOCKER_DESKTOP, EDGE] });
        assert.equal(r.result.action.type, 'finish');
        assert.deepEqual(codes(r), ['ollama-not-found']);
        assert.match(r.finalState.warnings[0].text, /拆題/);
        assert.deepEqual(serverSpawns(r.world).length, 1);
    });

    test('找不到系統匣程式時改用 PATH 上的 ollama serve，並讓它聽 .env 的 OLLAMA_HOST', async () => {
        const r = await launch({ db: true, dockerEngine: true, exists: [DOCKER_DESKTOP, EDGE], ollamaOnPath: true }, { env: { OLLAMA_HOST: '127.0.0.1:11500' } });
        const spawn = r.world.calls.find(c => c.kind === 'spawn' && c.file === 'ollama');
        assert.deepEqual(spawn.args, ['serve']);
        assert.equal(spawn.opts.env.OLLAMA_HOST, '127.0.0.1:11500');
        assert.ok(spawn.opts.logFile.endsWith(`ollama-${TODAY}.log`));
    });

    test('開了但一直沒回應 → 等 ollamaReadyTimeoutSec 後照常開系統、警告', async () => {
        const r = await launch({ db: true, dockerEngine: true, ollamaStartsInMs: Infinity });
        assert.equal(r.result.action.type, 'finish');
        assert.deepEqual(codes(r), ['ollama-timeout']);
    });

    test('缺模型 → 警告列出缺哪些（ocr 模式不要求看圖模型）', async () => {
        const r = await launch({ db: true, dockerEngine: true, ollamaUp: true, ollamaModels: ['qwen3-vl:8b'] });
        assert.deepEqual(codes(r), ['ollama-models']);
        assert.match(r.result.warnings[0].text, /qwen3:8b/);
        assert.doesNotMatch(r.result.warnings[0].text, /qwen3-vl/);
    });

    test('Gemini 模式（五個模型都改成 gemini）→ 不需要 Ollama，完全不問', async () => {
        const r = await launch({ db: true, dockerEngine: true }, {
            env: { MODEL_EXTRACT: 'gemini:gemini-3.5-flash', MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview', MODEL_NLQ: 'gemini:gemini-3.5-flash', EMBED_MODEL: 'gemini-embedding-001' }
        });
        assert.equal(r.result.facts.ollamaNeed.needed, false);
        assert.ok(!r.world.calls.some(c => c.kind === 'request' && c.url.includes('11434')));
        assert.equal(r.finalState.steps.find(s => s.id === 'ai').state, 'skipped');
    });

    test('OLLAMA_HOST 指向別台電腦而且連不上 → 不去開本機的 Ollama，警告', async () => {
        const r = await launch({ db: true, dockerEngine: true }, { env: { OLLAMA_HOST: 'http://192.168.1.20:11434' } });
        assert.deepEqual(codes(r), ['ollama-remote']);
        assert.ok(!r.world.calls.some(c => c.kind === 'spawn' && /ollama/i.test(c.file)));
    });
});

describe('畫面：啟動頁沒回應時的退路、單一執行個體、內部錯誤', () => {
    test('啟動頁沒載入 → 完成時直接開 app 視窗；有警告另跳訊息框', async () => {
        const r = await launch({ db: true, dockerEngine: true, exists: [DOCKER_DESKTOP, EDGE] }, { pageWorks: false });
        assert.equal(r.result.action.type, 'finish');
        assert.deepEqual(r.world.windows.map(x => x.url), [STATUS_URL, 'http://localhost:3000/']);
        assert.equal(r.world.popups.length, 1);
        assert.match(r.world.popups[0].text, /注意事項/);
        assert.match(r.world.popups[0].text, /Ollama/);
    });

    test('啟動頁沒載入 → 失敗時改跳系統訊息框（含處置步驟）', async () => {
        const r = await launch({}, { envFile: false, pageWorks: false });
        assert.equal(r.world.popups.length, 1);
        assert.match(r.world.popups[0].text, /找不到 exam_pro\\\.env/);
        assert.match(r.world.popups[0].text, /處理方式/);
    });

    test('啟動頁正常 → 失敗不另跳訊息框（畫面上就看得到）', async () => {
        const r = await launch({}, { envFile: false });
        assert.equal(r.world.popups.length, 0);
        assert.equal(r.finalState.phase, 'failed');
        assert.equal(r.finalState.failure.title, '找不到 exam_pro\\.env');
    });

    test('沒有 Edge → 用 Chrome 的 app 模式；兩個都沒有 → 預設瀏覽器', async () => {
        const r = await launch({ health: 'ours', db: true, exists: [CHROME] });
        assert.equal(r.world.windows[0].via, 'chrome');
        assert.ok(r.world.windows[0].args.includes(`--user-data-dir=${LOCAL}\\TutorExamBank\\browser-profile\\chrome`));
        const r2 = await launch({ health: 'ours', db: true, exists: [] });
        assert.deepEqual(r2.world.windows, [{ via: 'default', url: 'http://localhost:3000/' }]);
    });

    test('某一步丟例外 → 以 internal 失敗收尾（不會留下沒反應的畫面）', async () => {
        const r = await launch({}, { actionsOverride: { 'check-setup': async () => { throw new TypeError('boom'); } } });
        assert.equal(r.result.action.code, 'internal');
        assert.equal(r.result.action.detail, 'boom');
        assert.equal(r.finalState.phase, 'failed');
        assert.ok(r.lines.some(l => l.includes('TypeError: boom')));
    });

    test('某一步沒有寫回事實 → 偵測到迴圈沒前進，以 internal 失敗收尾', async () => {
        const r = await launch({}, { actionsOverride: { 'check-setup': async () => ({}) } });
        assert.equal(r.result.action.code, 'internal');
        assert.match(r.result.action.detail, /沒有前進/);
    });

    test('lockDecision：沒有鎖、自己的、殘留（行程不在、超過 20 分鐘、壞掉）→ 接手；另一個還在跑 → busy', () => {
        const now = Date.parse('2026-09-27T09:00:00Z');
        const alive = pid => pid === 11;
        const recent = new Date(now - 60_000).toISOString();
        assert.equal(lockDecision(null, { now, alive, selfPid: 1 }), 'take');
        assert.equal(lockDecision({ pid: 1, startedAt: recent }, { now, alive, selfPid: 1 }), 'take');
        assert.equal(lockDecision({ pid: 12, startedAt: recent }, { now, alive, selfPid: 1 }), 'take');
        assert.equal(lockDecision({ pid: 11, startedAt: new Date(now - 21 * 60_000).toISOString() }, { now, alive, selfPid: 1 }), 'take');
        assert.equal(lockDecision({ pid: 11, startedAt: 'garbage' }, { now, alive, selfPid: 1 }), 'take');
        assert.equal(lockDecision({ pid: 11, startedAt: recent }, { now, alive, selfPid: 1 }), 'busy');
    });

    test('acquireLock：第二個啟動器拿不到鎖、看得到第一個的啟動頁網址；釋放後可以再拿', () => {
        const world = createWorld({});
        const file = P('data', 'launcher', 'launch.lock');
        const a = acquireLock(world.sys, file);
        assert.equal(a.acquired, true);
        a.update({ statusUrl: STATUS_URL });
        world.alive.add(world.sys.pid);
        const other = { ...world.sys, pid: 5555 };
        const b = acquireLock(other, file);
        assert.equal(b.acquired, false);
        assert.equal(b.other.statusUrl, STATUS_URL);
        a.release();
        assert.equal(world.files.has(file), false);
        assert.equal(acquireLock(other, file).acquired, true);
    });

    test('drainingFrom：只有在「送過關閉要求、還在時限內、行程還在」才算上一個後端在收尾', () => {
        const now = Date.parse('2026-09-27T10:00:00Z');
        const info = { pid: 70, shutdownRequestedAt: '2026-09-27T09:59:00Z', graceMs: 120_000 };
        assert.deepEqual(drainingFrom(info, { now, alive: () => true }), { pid: 70, untilMs: Date.parse('2026-09-27T09:59:00Z') + 180_000 });
        assert.equal(drainingFrom(info, { now, alive: () => false }), null);
        assert.equal(drainingFrom({ pid: 70 }, { now, alive: () => true }), null);
        assert.equal(drainingFrom(info, { now: now + 3_600_000, alive: () => true }), null);
        assert.equal(drainingFrom(null, { now, alive: () => true }), null);
    });

    test('summarize 不把權杖寫進 log', () => {
        const s = summarize({ server: { spawned: true, token: 'abc123secret', pid: 1 } });
        assert.doesNotMatch(s, /abc123secret/);
        assert.match(s, /"pid":1/);
    });
});

// 〔審查 dec/desktop-launcher 第 1 件〕windowsHide 會把 GUI 程式的第一個視窗藏起來（lib/system.js 檔頭）。
// Linux 會忽略 windowsHide，所以只能在這裡逐一斷言每個呼叫點傳的 hide（system.js 怎麼轉成 windowsHide 見 desktopLauncherSystem.test.js）。
describe('視窗看得到：GUI 程式 hide:false、主控台程式維持隱藏', () => {
    const hidden = c => c.opts.hide !== false;
    const ps = (world, needle) => world.calls.filter(c => c.kind === 'exec' && c.file === 'powershell.exe' && decodePs(c.args).includes(needle));

    test('冷開機：Edge（啟動頁）、Docker Desktop、Ollama 系統匣程式都是 hide:false；node server.js、docker CLI、PowerShell 程序清單維持隱藏', async () => {
        const r = await launch({});
        const spawns = r.world.calls.filter(c => c.kind === 'spawn');
        const byFile = f => spawns.filter(c => c.file === f);
        assert.equal(byFile(EDGE).length, 1);
        assert.equal(byFile(EDGE)[0].opts.hide, false, 'Edge 的 app 視窗');
        assert.equal(byFile(DOCKER_DESKTOP)[0].opts.hide, false, 'Docker Desktop（含它跳出的同意條款／WSL 更新視窗）');
        assert.equal(byFile(OLLAMA_APP)[0].opts.hide, false, 'Ollama 系統匣程式');
        assert.equal(hidden(byFile(NODE)[0]), true, 'node server.js 是主控台程式，維持隱藏');
        for (const c of r.world.calls.filter(x => x.kind === 'exec' && /docker/i.test(x.file))) assert.equal(hidden(c), true, `${c.file} ${c.args.join(' ')}`);
        for (const c of ps(r.world, 'Get-CimInstance')) assert.equal(hidden(c), true, '列程序的 PowerShell 不顯示視窗');
    });

    test('已在跑：直接開的 app 視窗是 hide:false；Chrome 同樣；預設瀏覽器（rundll32）也是', async () => {
        const edge = await launch({ health: 'ours', db: true });
        assert.equal(edge.world.calls.find(c => c.kind === 'spawn' && c.file === EDGE).opts.hide, false);
        const chrome = await launch({ health: 'ours', db: true, exists: [CHROME] });
        assert.equal(chrome.world.calls.find(c => c.kind === 'spawn' && c.file === CHROME).opts.hide, false);
        const dflt = await launch({ health: 'ours', db: true, exists: [] });
        const rundll = dflt.world.calls.find(c => c.kind === 'exec' && c.file === 'rundll32.exe');
        assert.equal(rundll.opts.hide, false, 'rundll32 把自己的顯示狀態交給 ShellExecute');
    });

    test('訊息框的 PowerShell 是 hide:false（訊息框是它的第一個視窗）', async () => {
        const r = await launch({}, { envFile: false, pageWorks: false });
        const popups = ps(r.world, '.Popup(');
        assert.equal(popups.length, 1);
        assert.equal(popups[0].opts.hide, false);
    });

    test('找不到系統匣程式、改用 ollama serve（主控台程式）→ 維持隱藏；結束孤兒後端的 taskkill、查埠的 netstat／tasklist 也是', async () => {
        const r = await launch({ db: true, dockerEngine: true, exists: [DOCKER_DESKTOP, EDGE], ollamaOnPath: true });
        const serve = r.world.calls.find(c => c.kind === 'spawn' && c.file === 'ollama');
        assert.equal(serve.opts.hide, true);
        const orphan = await launch({
            db: true, dockerEngine: true, server: 'listen-swallowed',
            netstat: '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       77\r\n', tasklist: '"x.exe","77","Console","1","9 K"'
        }, { config: { serverReadyTimeoutSec: 10 } });
        for (const c of orphan.world.calls.filter(x => x.kind === 'exec' && /^(taskkill|netstat|tasklist)$/.test(x.file))) assert.equal(hidden(c), true, c.file);
    });
});

describe('ui（lib/ui.js）', () => {
    test('browser:chrome＋browserPath＋browserArgs：用指定的程式與參數開 app 視窗', async () => {
        const custom = 'D:\\PortableChrome\\chrome.exe';
        const world = createWorld({ exists: [custom] });
        const { config } = resolveConfig({ browser: 'chrome', browserPath: custom, browserArgs: ['--start-maximized'], browserProfileDir: 'D:\\profiles' });
        const ui = createUi({ sys: world.sys, config, statusHtml: '' });
        const r = await ui.openWindow('http://localhost:3000/');
        assert.deepEqual(r, { ok: true, via: 'chrome', path: custom });
        assert.deepEqual(world.windows[0].args, ['--app=http://localhost:3000/', '--user-data-dir=D:\\profiles\\chrome', '--no-first-run', '--no-default-browser-check', '--start-maximized']);
    });

    test('Windows 以外：訊息框只寫 log、回 null（開發機上跑 launch.js 不會卡住）', async () => {
        const world = createWorld({ platform: 'linux' });
        const lines = [];
        const ui = createUi({ sys: world.sys, config: resolveConfig(null).config, statusHtml: '', log: l => lines.push(l) });
        assert.equal(await ui.messageBox({ text: '第一行\n第二行' }), null);
        assert.equal(world.popups.length, 0);
        assert.match(lines[0], /第一行 ／ 第二行/);
    });

    test('failureText／warningsText：處置步驟、詳細訊息（過長只留最後 800 字）、附帶的警告', () => {
        const { failureText, warningsText } = require('../../scripts/desktop/lib/ui');
        const t = failureText({ title: 'T', message: 'M', hint: ['h1', 'h2'], detail: 'x'.repeat(1000) }, [{ text: 'w1' }]);
        assert.match(t, /^T\n\nM\n\n處理方式：\n・h1\n・h2\n\n詳細訊息：\n…x{800}\n\n另外：\n・w1$/);
        assert.equal(warningsText([{ text: 'a' }]), '出題系統已經開啟，但有以下注意事項：\n\n・a');
    });
});
