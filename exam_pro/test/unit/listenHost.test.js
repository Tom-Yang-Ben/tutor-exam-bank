// ─────────────────────────────────────────────────────────────
// test/unit/listenHost.test.js — 後端聽的位址 HOST（config/listenHost.js；〔Owner 第六輪 DA-11＝1，2026-09-27〕）
//
//   1. resolveListenHost：沒寫／空白 → 127.0.0.1；去空白、去 IPv6 方括號；其他照設定。
//   2. hostScope／localProbeHost：本機、萬用、特定位址三種，以及桌面啟動器要連哪個位址。
//   3. startupText：啟動訊息（本機只接受本機、0.0.0.0 提醒防火牆與 API_KEY、特定位址印那個網址）。
//   4. 文件與範本：.env.example 不啟用 HOST（複製成 .env 仍只聽本機）、寫了區網的三件事；
//      README、deployment 文件寫明 HOST=0.0.0.0 與防火牆、API_KEY。
// 真的執行 server.js 的驗證（沒寫 HOST 時區網連不到、0.0.0.0 連得到）在 desktopServerListen.test.js，
// 連真的資料庫的在 test/integration/listenHost.pg.test.js。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lh = require('../../config/listenHost');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('resolveListenHost', () => {
    test('沒寫、空白、null → 127.0.0.1（Owner 第六輪 DA-11＝1 的預設）', () => {
        assert.equal(lh.DEFAULT_HOST, '127.0.0.1');
        for (const env of [{}, { HOST: '' }, { HOST: '   ' }, { HOST: undefined }, { HOST: null }, undefined, null]) {
            assert.equal(lh.resolveListenHost(env === undefined ? {} : env), '127.0.0.1', JSON.stringify(env));
        }
    });

    test('照設定：去掉前後空白；IPv6 的方括號寫法去掉括號（listen 不認得括號）', () => {
        assert.equal(lh.resolveListenHost({ HOST: '0.0.0.0' }), '0.0.0.0');
        assert.equal(lh.resolveListenHost({ HOST: ' 0.0.0.0\t' }), '0.0.0.0');
        assert.equal(lh.resolveListenHost({ HOST: '[::1]' }), '::1');
        assert.equal(lh.resolveListenHost({ HOST: '::' }), '::');
        assert.equal(lh.resolveListenHost({ HOST: '192.168.1.10' }), '192.168.1.10');
        assert.equal(lh.resolveListenHost({ HOST: 'localhost' }), 'localhost');
    });

    test('不帶參數時讀 process.env.HOST', () => {
        const saved = process.env.HOST;
        try {
            delete process.env.HOST;
            assert.equal(lh.resolveListenHost(), '127.0.0.1');
            process.env.HOST = '0.0.0.0';
            assert.equal(lh.resolveListenHost(), '0.0.0.0');
        } finally {
            if (saved === undefined) delete process.env.HOST; else process.env.HOST = saved;
        }
    });
});

describe('hostScope／localProbeHost（桌面啟動器從本機要連哪個位址）', () => {
    test('本機：127.x.x.x、::1、localhost、::ffff:127.x.x.x', () => {
        for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1']) assert.equal(lh.hostScope(h), 'loopback', h);
    });

    test('萬用：0.0.0.0、::', () => {
        for (const h of ['0.0.0.0', '::']) assert.equal(lh.hostScope(h), 'wildcard', h);
    });

    test('其他都算特定位址（網卡位址、主機名稱、看起來像但不是本機的）', () => {
        for (const h of ['192.168.1.10', '10.0.0.5', 'fe80::1', 'mypc', '1127.0.0.1', '::ffff:10.0.0.1', '']) assert.equal(lh.hostScope(h), 'specific', h);
    });

    test('localProbeHost：萬用 → 127.0.0.1；本機 → 原值（::ffff:127.0.0.1 → 127.0.0.1）；特定位址 → null', () => {
        assert.equal(lh.localProbeHost('127.0.0.1'), '127.0.0.1');
        assert.equal(lh.localProbeHost('0.0.0.0'), '127.0.0.1');
        assert.equal(lh.localProbeHost('::'), '127.0.0.1');
        assert.equal(lh.localProbeHost('localhost'), 'localhost');
        assert.equal(lh.localProbeHost('::1'), '::1');
        assert.equal(lh.localProbeHost('127.0.0.2'), '127.0.0.2');
        assert.equal(lh.localProbeHost('::ffff:127.0.0.1'), '127.0.0.1');
        assert.equal(lh.localProbeHost('192.168.1.10'), null);
    });

    test('urlHost：IPv6 加方括號', () => {
        assert.equal(lh.urlHost('::1'), '[::1]');
        assert.equal(lh.urlHost('127.0.0.1'), '127.0.0.1');
        assert.equal(lh.urlHost('localhost'), 'localhost');
    });
});

describe('startupText（後端啟動成功時印的一行）', () => {
    test('預設（127.0.0.1）：網址照舊是 http://localhost:<埠>，寫明只接受本機', () => {
        const t = lh.startupText('127.0.0.1', 3000);
        assert.match(t, /^🚀 家教題庫後端系統已成功安全啟動：http:\/\/localhost:3000（只接受這台電腦的連線；HOST=127\.0\.0\.1）$/);
    });

    test('0.0.0.0：網址仍是 localhost，另外提醒防火牆、ALLOWED_ORIGINS、API_KEY 不是存取控制', () => {
        const t = lh.startupText('0.0.0.0', 3100);
        assert.match(t, /成功安全啟動：http:\/\/localhost:3100（HOST=0\.0\.0\.0：同一個網路的其他裝置也連得到/);
        assert.match(t, /防火牆/);
        assert.match(t, /ALLOWED_ORIGINS/);
        assert.match(t, /API_KEY 會注入首頁，不是存取控制/);
        assert.match(t, /區網存取/);
    });

    test('特定位址：印那個位址的網址（IPv6 加方括號），並說 localhost 連不到', () => {
        assert.match(lh.startupText('192.168.1.10', 3000), /成功安全啟動：http:\/\/192\.168\.1\.10:3000（只聽 HOST=192\.168\.1\.10；這台電腦的 localhost 連不到）/);
        assert.match(lh.startupText('fe80::1', 3000), /http:\/\/\[fe80::1\]:3000/);
    });
});

describe('範本與文件（DA-11＝1：預設只聽本機；要區網存取時設 HOST=0.0.0.0，並處理防火牆與 API_KEY）', () => {
    test('.env.example：HOST 只寫在註解裡（照範本複製的 .env 仍只聽本機），並寫明區網的三件事', () => {
        const text = read('exam_pro/.env.example');
        const parsed = require('dotenv').parse(text);
        assert.equal(parsed.HOST, undefined, '.env.example 不可以啟用 HOST');
        assert.match(text, /^# HOST=0\.0\.0\.0$/m);
        assert.match(text, /127\.0\.0\.1/);
        assert.match(text, /防火牆/);
        assert.match(text, /ALLOWED_ORIGINS/);
        assert.match(text, /API_KEY/);
        assert.equal(lh.resolveListenHost(parsed), '127.0.0.1');
    });

    test('exam_pro/README.md：環境變數表有 HOST（預設 127.0.0.1），「區網存取」一節寫防火牆、ALLOWED_ORIGINS、API_KEY', () => {
        const text = read('exam_pro/README.md');
        assert.match(text, /\| `HOST`[^|\n]*\|[^\n]*`127\.0\.0\.1`/);
        const i = text.indexOf('### 區網存取');
        assert.ok(i >= 0, 'README 要有「### 區網存取」一節');
        const section = text.slice(i, text.indexOf('\n### ', i + 5) === -1 ? undefined : text.indexOf('\n### ', i + 5));
        for (const needle of ['HOST=0.0.0.0', '防火牆', 'ALLOWED_ORIGINS', 'API_KEY', '私人網路']) assert.ok(section.includes(needle), `區網存取一節少了 ${needle}`);
    });

    test('deployment_and_operations.md：環境變數表有 HOST；對外部署前置條件提到 HOST', () => {
        const text = read('engineering_docs/06_ops/deployment_and_operations.md');
        assert.match(text, /\| `HOST`[^\n]*127\.0\.0\.1/);
        const i = text.indexOf('### 4.1 對外部署前置條件');
        assert.ok(i >= 0);
        assert.match(text.slice(i, i + 3000), /HOST=0\.0\.0\.0/);
    });
});
