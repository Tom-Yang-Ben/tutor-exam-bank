// desktop/test/security.test.js — 導覽、開新視窗、權限（lib/security.js；docs/desktop-app-design.md 第 2.4 節、第 3 條第 6 項）
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../lib/security');

const APP = 'http://127.0.0.1:53124';
const STATUS = 'http://127.0.0.1:40001';

describe('導覽', () => {
    test('自己的來源（後端、啟動畫面）放行', () => {
        assert.equal(S.navigationDecision(`${APP}/`, [APP, STATUS]), 'allow');
        assert.equal(S.navigationDecision(`${APP}/index.html?x=1#y`, [APP, STATUS]), 'allow');
        assert.equal(S.navigationDecision(`${STATUS}/`, [APP, STATUS]), 'allow');
    });

    test('外部 http(s) 交給預設瀏覽器', () => {
        assert.equal(S.navigationDecision('https://example.com/a', [APP]), 'external');
        assert.equal(S.navigationDecision('http://192.168.1.5:3000/', [APP]), 'external');
    });

    test('其他一律擋：本機其他埠、localhost 別名、file:、javascript:、data:、自訂協定、壞網址', () => {
        for (const url of ['http://127.0.0.1:3000/', 'http://localhost:53124/', 'http://[::1]:53124/', 'file:///C:/Windows/win.ini',
            'javascript:alert(1)', 'data:text/html,hi', 'ms-settings:privacy', 'not a url', 'http://127.1.2.3/']) {
            assert.equal(S.navigationDecision(url, [APP, STATUS]), 'deny', url);
        }
    });

    test('開新視窗：一律不開 Electron 視窗；外部網址交給預設瀏覽器', () => {
        assert.equal(S.windowOpenDecision(`${APP}/print`), 'deny');
        assert.equal(S.windowOpenDecision('blob:http://127.0.0.1:53124/abc'), 'deny');
        assert.equal(S.windowOpenDecision('about:blank'), 'deny');
        assert.equal(S.windowOpenDecision('https://example.com/'), 'external');
    });

    test('originOf', () => {
        assert.equal(S.originOf(`${APP}/x`), APP);
        assert.equal(S.originOf('blob:http://127.0.0.1:1/abc'), 'http://127.0.0.1:1');
        assert.equal(S.originOf('data:text/plain,x'), null);
        assert.equal(S.originOf(''), null);
        assert.equal(S.originOf(null), null);
    });
});

describe('權限請求（setPermissionRequestHandler）', () => {
    const req = o => S.permissionRequestDecision({ permission: 'media', appOrigin: APP, requestingUrl: `${APP}/`, mediaTypes: ['audio'], ...o });

    test('自己的來源只要聲音：放行（家教的「按住說話」）', () => {
        assert.equal(req({}), true);
        assert.equal(req({ securityOrigin: `${APP}/` }), true);
    });

    test('要攝影機、聲音＋攝影機、沒寫要什麼：拒絕', () => {
        assert.equal(req({ mediaTypes: ['video'] }), false);
        assert.equal(req({ mediaTypes: ['audio', 'video'] }), false);
        assert.equal(req({ mediaTypes: [] }), false);
        assert.equal(req({ mediaTypes: undefined }), false);
    });

    test('別的來源、後端還沒開好（沒有 appOrigin）：拒絕', () => {
        assert.equal(req({ requestingUrl: 'https://evil.example/' }), false);
        assert.equal(req({ requestingUrl: `${STATUS}/` }), false);
        assert.equal(req({ securityOrigin: 'http://127.0.0.1:1' }), false);
        assert.equal(req({ appOrigin: null }), false);
    });

    test('其他權限一律拒絕（Electron 預設是全部自動核准）', () => {
        for (const permission of ['notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'fullscreen',
            'openExternal', 'midi', 'hid', 'serial', 'usb', 'pointerLock', 'keyboardLock', 'fileSystem', 'unknown']) {
            assert.equal(S.permissionRequestDecision({ permission, appOrigin: APP, requestingUrl: `${APP}/`, mediaTypes: ['audio'] }), false, permission);
        }
    });
});

describe('權限檢查（setPermissionCheckHandler）', () => {
    test('只有自己的來源＋media＋audio 為真', () => {
        assert.equal(S.permissionCheckDecision({ permission: 'media', appOrigin: APP, requestingOrigin: `${APP}/`, mediaType: 'audio' }), true);
        assert.equal(S.permissionCheckDecision({ permission: 'media', appOrigin: APP, requestingOrigin: APP, securityOrigin: `${APP}/`, mediaType: 'audio' }), true);
        assert.equal(S.permissionCheckDecision({ permission: 'media', appOrigin: APP, requestingOrigin: APP, mediaType: 'video' }), false);
        assert.equal(S.permissionCheckDecision({ permission: 'media', appOrigin: APP, requestingOrigin: APP, mediaType: 'unknown' }), false);
        assert.equal(S.permissionCheckDecision({ permission: 'media', appOrigin: APP, requestingOrigin: STATUS, mediaType: 'audio' }), false);
        assert.equal(S.permissionCheckDecision({ permission: 'notifications', appOrigin: APP, requestingOrigin: APP }), false);
        assert.equal(S.permissionCheckDecision({ permission: 'media', appOrigin: null, requestingOrigin: APP, mediaType: 'audio' }), false);
    });
});

describe('執行期零外連', () => {
    test('拼字字典的下載網址指到本機迴路（不從 Google 的 CDN 下載）', () => {
        const u = new URL(S.SPELLCHECK_DICTIONARY_URL);
        assert.equal(u.protocol, 'http:');
        assert.ok(S.isLoopbackHost(u.hostname), u.hostname);
    });
});
