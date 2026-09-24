// ─────────────────────────────────────────────────────────────
// 本機模式 L3：前端離線化（docs/local-mode.md 第 5 條；原則見第 1 條第 1 點「執行期零外連」）
//
// 四組：
//   1. public/ 底下沒有外部資源網址（scripts/check_html_offline.js），以及規則本身的自我測試：
//      字串裡的 CDN 網址一定抓得到；例外只有註解與 XML 命名空間。
//   2. index.html／package.json 的接點：MathJax、gsap、Tailwind、字型都指向 /vendor/…，
//      版本與原本 CDN 的主版本相同，voice-route 的注入點三方（index.html、app.js、tutor.js）對得上。
//   3. 真的把 app.js 載起來（supertest；不連資料庫——pg 的 Pool 是惰性的，這裡的請求都不碰 /api）：
//      index.html 會自動載入的每一個本機資源都回 200；MathJax 的 mhchem、ui/safe、CHTML 字型、SRE 規則，
//      兩套字型的每一個切片也都在；/vendor 不會把其他套件或 package.json 公開出去；
//      __VOICE_ROUTE__ 依路由表注入 mounted／none。
//   4. tutor.js：伺服器沒掛語音路由時不渲染「按住說話」，改顯示「本機模式不提供語音」（miniDom）；
//      UI 不預告「會用程式驗算」（第 3 條第 10 點：本機模式沒有 code execution）。
// ─────────────────────────────────────────────────────────────
const { test, describe, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const offline = require('../../scripts/check_html_offline');
const checkHtml = require('../../eval/tools/check_html');
const { install, fakeBridge, flush } = require('./lib/miniDom');

const APP_DIR = path.resolve(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(APP_DIR, 'public', 'index.html'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
const TUTOR_FILE = path.join(APP_DIR, 'public', 'js', 'tutor.js');
const TUTOR_SRC = fs.readFileSync(TUTOR_FILE, 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));

// ───────────────────────── 1. 不得有外部網址 ─────────────────────────

describe('public/ 沒有外部資源網址（docs/local-mode.md 第 5 條第 3 點）', () => {
    test('public/ 底下所有 HTML／JS／CSS 都沒有 http(s)／ws(s) 網址或協定相對的資源網址', () => {
        const { files, problems } = offline.checkPublicOffline();
        assert.deepEqual(problems, [], `本機模式執行期不得連外，改從 /vendor/… 供應：\n  ${problems.join('\n  ')}`);
        assert.ok(files.includes('public/index.html'), files.join('、'));
        assert.ok(files.filter(f => f.startsWith('public/js/')).length >= 8, `只掃到 ${files.join('、')}`);
    });

    test('原本的四個 CDN 引用（Tailwind、gsap、Google Fonts、MathJax）都會被抓到', () => {
        const before = [
            '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>',
            '<script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js"></script>',
            '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400&display=swap" rel="stylesheet">',
            '<script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>'
        ].join('\n');
        const problems = offline.checkText('public/index.html', before);
        assert.equal(problems.length, 4, problems.join('\n'));
        assert.match(problems[0], /^public\/index\.html:1:\d+ https:\/\/cdn\.jsdelivr\.net/);
        assert.match(problems[2], /^public\/index\.html:3:\d+ https:\/\/fonts\.googleapis\.com/);
    });

    test('HTML：註解裡的網址是說明文字（放行），標記與 inline script 裡的不行', () => {
        const lines = [
            '<!-- 參考 https://example.com/docs -->',
            '<script>',
            '  // 參考 https://example.com/a',
            '  /* 參考 https://example.com/b */',
            "  const s = document.createElement('script'); s.src = 'https://cdn.example/x.js';",
            '</script>',
            '<style>/* https://example.com/c */ body { background: url(https://cdn.example/bg.png); }</style>',
            '<img src="//cdn.example/x.png">'
        ];
        const problems = offline.checkText('public/x.html', lines.join('\n'));
        // 回報格式「檔名:行:欄 網址」，行列指向原始檔（挖註解時保留了位置）
        const at = (line, url) => `public/x.html:${line}:${lines[line - 1].indexOf(url) + 1} ${url}`;
        assert.deepEqual(problems, [
            at(5, 'https://cdn.example/x.js'),
            at(7, 'https://cdn.example/bg.png'),
            at(8, '//cdn.example/x.png')
        ]);
    });

    test('JS：字串裡的 // 不會被當成註解（CDN 網址一定抓得到）', () => {
        const hits = (src) => offline.checkText('public/js/x.js', src).map(p => p.slice(p.indexOf(' ') + 1));
        assert.deepEqual(hits("const u = 'https://cdn.example/x.js'; // 說明 https://example.com"), ['https://cdn.example/x.js']);
        assert.deepEqual(hits('const u = "http://cdn.example/y.js";'), ['http://cdn.example/y.js']);
        assert.deepEqual(hits('// 整行註解 https://example.com\n/**\n * https://example.com/jsdoc\n */\nconst a = 1;'), []);
        // 樣板字串的文字裡出現 // 也不是註解；${…} 裡面才是程式碼（可以有註解）
        assert.deepEqual(hits('const h = `<a> // https://cdn.example/t.js`;'), ['https://cdn.example/t.js']);
        assert.deepEqual(hits('const h = `x${ { a: 1 }.a /* https://example.com/in-expr */ }y https://cdn.example/after`;'),
            ['https://cdn.example/after']);
        assert.deepEqual(hits('const h = `a${`b${1}`}c`; fetch("wss://live.example/socket");'), ['wss://live.example/socket']);
    });

    test('JS：正規表示式與除號分得開（regex 裡的斜線不會讓後面的註解或字串錯位）', () => {
        const hits = (src) => offline.checkText('public/js/x.js', src).map(p => p.slice(p.indexOf(' ') + 1));
        assert.deepEqual(hits("const re = /https?:\\/\\//i; // https://example.com\nconst u = 'https://cdn.example/z.js';"),
            ['https://cdn.example/z.js']);
        assert.deepEqual(hits("const r = a / b; // https://example.com\nconst q = x.replace(/[/*]/g, ''); const u = 'https://cdn.example/w.js';"),
            ['https://cdn.example/w.js']);
        assert.deepEqual(hits("if (ok) return /\\/\\*/.test(s); const u = 'https://cdn.example/v.js';"), ['https://cdn.example/v.js']);
    });

    test('協定相對網址在會載入資源的位置違規：src／href、url()、@import、import', () => {
        // 同時符合 url() 與 @import 兩條規則，只算一次
        assert.deepEqual(offline.checkText('public/a.css', '@import url("//fonts.example/a.css");'),
            ['public/a.css:1:14 //fonts.example/a.css']);
        assert.equal(offline.checkText('public/a.css', "@import '//fonts.example/b.css';").length, 1);
        assert.equal(offline.checkText('public/a.css', '.x { background: url(//cdn.example/b.png) }').length, 1);
        assert.equal(offline.checkText('public/a.css', '/* url(//cdn.example/c.png) */ .x { color: red }').length, 0);
        assert.equal(offline.checkText('public/js/a.js', "import x from '//cdn.example/m.js';").length, 1);
        assert.equal(offline.checkText('public/js/a.js', "await import('//cdn.example/m.js');").length, 1);
        assert.equal(offline.checkText('public/js/a.js', "img.src = '//cdn.example/p.png';").length, 1);
        assert.equal(offline.checkText('public/js/a.js', 'const half = a // 2\n;').length, 0);
    });

    test('XML 命名空間只放行清單裡那幾個（逐字比對），其他 w3.org 網址照樣違規', () => {
        assert.deepEqual(offline.checkText('public/js/a.js', "document.createElementNS('http://www.w3.org/2000/svg', 'svg');"), []);
        assert.equal(offline.checkText('public/js/a.js', "link.href = 'http://www.w3.org/StyleSheets/x.css';").length, 1);
        assert.equal(offline.checkText('public/js/a.js', "const ns = 'http://www.w3.org/2000/svg/extra';").length, 1);
        assert.ok(offline.ALLOWED_NAMESPACES.every(u => /^http:\/\/www\.w3\.org\//.test(u)));
    });

    test('挖掉註解不會吃到程式碼：public/ 的每一支 JS 與 inline script 挖完仍 parse 得過、長度不變', () => {
        let checked = 0;
        for (const abs of offline.listPublicFiles()) {
            const src = fs.readFileSync(abs, 'utf8');
            const label = path.relative(APP_DIR, abs);
            if (abs.endsWith('.js') || abs.endsWith('.mjs')) {
                const blanked = offline.blankJsComments(src);
                assert.equal(blanked.length, src.length, label);
                const res = checkHtml.checkSyntax(blanked, true, label);
                assert.ok(res.ok, res.message);
                checked++;
            } else if (abs.endsWith('.html')) {
                const blanked = offline.blankHtmlAllComments(src);
                assert.equal(blanked.length, src.length, label);
                for (const block of checkHtml.extractInlineScripts(blanked)) {
                    const res = checkHtml.checkSyntax(block.code, block.isModule, `${label}:${block.line}`);
                    assert.ok(res.ok, res.message);
                    checked++;
                }
            }
        }
        assert.ok(checked >= 10, `只檢查到 ${checked} 段`);
    });
});

// ───────────────────────── 2. 接點與版本 ─────────────────────────

describe('index.html 與 package.json 的接點（第 5 條第 1、2 點）', () => {
    test('四種第三方資源都從 /vendor/… 載入，MathJax 保留 id="MathJax-script"', () => {
        const refs = offline.localResourceRefs(INDEX_HTML);
        for (const ref of ['/vendor/tailwindcss/index.global.js', '/vendor/gsap/gsap.min.js',
            '/vendor/fonts/manrope/index.css', '/vendor/fonts/noto-sans-tc/index.css', '/vendor/mathjax/tex-mml-chtml.js']) {
            assert.ok(refs.includes(ref), `index.html 沒有引用 ${ref}`);
        }
        // document.currentScript 拿不到時，MathJax 靠這個 id 找自己的網址、推出元件與字型的根目錄
        assert.ok(INDEX_HTML.includes('<script id="MathJax-script" async src="/vendor/mathjax/tex-mml-chtml.js"></script>'));
    });

    test('MathJax 設定沒有被動到：mhchem、ui/safe、URLs none 都在（check:html 的同一組檢查），也沒有改寫路徑', () => {
        assert.deepEqual(checkHtml.checkContracts(), []);
        const config = INDEX_HTML.match(/window\.MathJax\s*=\s*\{[\s\S]*?\n\s*\};/)[0];
        assert.ok(config.includes("loader: { load: ['[tex]/mhchem', 'ui/safe'] }"), config);
        assert.ok(config.includes("options: { safeOptions: { allow: { URLs: 'none' } } }"), config);
        assert.ok(!/paths|fontURL/.test(config), '路徑由腳本網址推出，設定裡不該另外寫死');
    });

    test('body 的字族名與 @fontsource-variable 宣告的一致，後面接系統中文字型', () => {
        const body = INDEX_HTML.match(/body\s*\{[^}]*font-family:\s*([^;]+);/)[1];
        const families = body.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        assert.deepEqual(families.slice(0, 2), ['Manrope Variable', 'Noto Sans TC Variable']);
        assert.ok(families.includes('Microsoft JhengHei') && families.at(-1) === 'sans-serif', body);
        for (const [pkg, family] of [['@fontsource-variable/manrope', 'Manrope Variable'], ['@fontsource-variable/noto-sans-tc', 'Noto Sans TC Variable']]) {
            const css = fs.readFileSync(require.resolve(`${pkg}/index.css`), 'utf8');
            assert.ok(css.includes(`font-family: '${family}'`), `${pkg} 的字族名不是 ${family}`);
        }
    });

    test('dependencies：五個前端套件都在，主版本與原本的 CDN 相同（gsap 照原本釘死 3.13.0）', () => {
        const deps = PKG.dependencies;
        assert.match(deps.mathjax, /^\^?3\./, 'CDN 用的是 mathjax@3');
        assert.equal(deps.gsap, '3.13.0', 'CDN 用的是 gsap@3.13.0');
        assert.match(deps['@tailwindcss/browser'], /^\^?4\./, 'CDN 用的是 @tailwindcss/browser@4');
        assert.ok(deps['@fontsource-variable/manrope']);
        assert.ok(deps['@fontsource-variable/noto-sans-tc']);
    });

    test('voice-route 注入點：index.html 有佔位字串、app.js 用 replaceAll 換、tutor.js 從 <meta> 讀', () => {
        assert.ok(INDEX_HTML.includes('<meta name="voice-route" content="__VOICE_ROUTE__">'));
        assert.match(APP_SRC, /\.replaceAll\('__VOICE_ROUTE__', VOICE_ROUTE\)/);
        assert.ok(!/\.replace\(\s*'__VOICE_ROUTE__'/.test(APP_SRC), '要用 replaceAll（佔位字串可能也出現在說明註解裡）');
        assert.match(APP_SRC, /hasRoute\(routes, 'post', '\/voice\/transcribe'\)/);
        assert.ok(TUTOR_SRC.includes('meta[name="voice-route"]'));
    });
});

// ───────────────────────── 3. 把 app.js 載起來 ─────────────────────────

const APP_PATH = path.join(APP_DIR, 'app.js');
const ROUTES_PATH = path.join(APP_DIR, 'routes', 'index.js');

/**
 * 依 env 重新 require app.js 與 routes/index.js（routes 在 require 當下讀旗標；同 tutor.pg.test.js 的 loadApp）。
 * config/db.js 在 require 當下要求 DATABASE_URL：沒有就給一個連不到的測試用字串——Pool 是惰性的，
 * 本檔只打靜態檔與首頁，從不查資料庫。
 */
function loadApp(env = {}) {
    if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgres://offline:offline@127.0.0.1:1/offline_unit_test';
    delete require.cache[require.resolve(APP_PATH)];
    delete require.cache[require.resolve(ROUTES_PATH)];
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
        return { app: require(APP_PATH), routes: require(ROUTES_PATH) };
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

function metaContent(html, name) {
    const m = html.match(new RegExp(`<meta name="${name}" content="([^"]*)">`));
    return m ? m[1] : null;
}

function routeMounted(routes, method, routePath) {
    return routes.stack.some(l => l.route && l.route.path === routePath && l.route.methods[method]);
}

describe('app.js 供應 /vendor/…（第 5 條第 1、2 點；以 supertest 真的打）', () => {
    const request = require('supertest');
    let app;
    before(() => { ({ app } = loadApp({ FEATURE_TUTOR: 'false', FEATURE_VOICE: 'false' })); });

    test('index.html 會自動載入的每一個本機資源都回 200，型別正確', async () => {
        const refs = offline.localResourceRefs(INDEX_HTML);
        assert.ok(refs.length >= 13, refs.join('、'));
        for (const ref of refs) {
            const res = await request(app).get(ref);
            assert.equal(res.status, 200, `${ref} 回 ${res.status}`);
            const expected = ref.endsWith('.css') ? /text\/css/ : /javascript/;
            assert.match(res.headers['content-type'], expected, ref);
        }
    });

    test('MathJax 從本機相對載入的東西都在：mhchem、ui/safe、CHTML 字型、SRE 規則', async () => {
        const main = await request(app).get('/vendor/mathjax/tex-mml-chtml.js');
        assert.equal(main.status, 200);
        const src = main.text || main.body.toString('utf8');
        // 這三段是「根目錄由腳本網址推出」與「字型、SRE 走相對路徑」的依據（MathJax 3.2）；升級後這裡失敗，
        // 要重新確認新版會不會回頭去抓 CDN（MathJax 4 把字型拆成另外的套件）。
        assert.ok(src.includes('document.getElementById("MathJax-script")'), '找不到以 #MathJax-script 推根目錄的邏輯');
        assert.ok(src.includes('resolvePath("output/chtml/fonts/woff-v2"'), 'CHTML 字型不是相對於根目錄');
        assert.ok(src.includes('sre:"[mathjax]/sre/mathmaps"'), 'SRE 規則不是相對於根目錄');

        for (const ref of ['/vendor/mathjax/input/tex/extensions/mhchem.js', '/vendor/mathjax/ui/safe.js',
            '/vendor/mathjax/sre/mathmaps/base.json', '/vendor/mathjax/sre/mathmaps/en.json']) {
            const res = await request(app).get(ref);
            assert.equal(res.status, 200, `${ref} 回 ${res.status}`);
        }
        const fontDir = path.join(path.dirname(require.resolve('mathjax/es5/tex-mml-chtml.js')), 'output', 'chtml', 'fonts', 'woff-v2');
        const fonts = fs.readdirSync(fontDir).filter(f => f.endsWith('.woff'));
        assert.ok(fonts.includes('MathJax_Main-Regular.woff'), fonts.join('、'));
        for (const f of fonts) {
            const res = await request(app).get(`/vendor/mathjax/output/chtml/fonts/woff-v2/${f}`);
            assert.equal(res.status, 200, f);
            assert.match(res.headers['content-type'], /font\/woff/, f);
        }
    });

    test('兩套字型 CSS 引用的每一個 woff2 切片都回 200（不會有漏掉的字去找 Google）', async () => {
        for (const route of ['/vendor/fonts/manrope', '/vendor/fonts/noto-sans-tc']) {
            const css = await request(app).get(`${route}/index.css`);
            assert.equal(css.status, 200, route);
            assert.ok(!/https?:\/\//.test(css.text), `${route}/index.css 引用了外部網址`);
            const urls = [...css.text.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/^['"]|['"]$/g, ''));
            assert.ok(urls.length > 0 && urls.every(u => u.startsWith('./files/')), `${route}：${urls.slice(0, 3).join('、')}`);
            for (const u of urls) {
                const res = await request(app).get(`${route}/${u.slice(2)}`);
                assert.equal(res.status, 200, `${route}/${u}`);
                assert.match(res.headers['content-type'], /font\/woff2/, u);
            }
        }
    });

    test('/vendor 只公開指定的目錄：套件的 package.json、其他套件都拿不到', async () => {
        for (const ref of ['/vendor/mathjax/package.json', '/vendor/pg/package.json', '/vendor/express/index.js',
            '/vendor/mathjax/%2e%2e/package.json', '/vendor/gsap/../package.json']) {
            const res = await request(app).get(ref);
            assert.ok(res.status === 404 || res.status === 403, `${ref} 回 ${res.status}`);
        }
    });

    test('首頁注入 voice-route：旗標關閉時是 none', async () => {
        const res = await request(app).get('/');
        assert.equal(res.status, 200);
        assert.equal(metaContent(res.text, 'voice-route'), 'none');
        assert.ok(!res.text.includes('__VOICE_ROUTE__'));
    });
});

describe('__VOICE_ROUTE__ 依路由表注入（第 3 條第 9 點、第 5 條第 4 點）', () => {
    const request = require('supertest');

    test('家教與語音都開、MODEL_VOICE 是 Gemini → 路由有掛 → mounted', async () => {
        const { app, routes } = loadApp({ FEATURE_TUTOR: 'true', FEATURE_VOICE: 'true', MODEL_VOICE: 'gemini:gemini-3.5-flash' });
        assert.equal(routeMounted(routes, 'post', '/voice/transcribe'), true);
        assert.equal(metaContent((await request(app).get('/')).text, 'voice-route'), 'mounted');
    });

    test('FEATURE_VOICE 關閉 → 路由沒掛 → none', async () => {
        const { app, routes } = loadApp({ FEATURE_TUTOR: 'true', FEATURE_VOICE: 'false', MODEL_VOICE: 'gemini:gemini-3.5-flash' });
        assert.equal(routeMounted(routes, 'post', '/voice/transcribe'), false);
        assert.equal(metaContent((await request(app).get('/index.html')).text, 'voice-route'), 'none');
    });

    test('MODEL_VOICE 是本機模型時，注入值與路由表一致（L1 不掛載語音路由 → none）', async () => {
        // L1（routes/index.js）決定掛不掛；這裡只驗「前端看到的就是路由表的實情」，不自己重算那條規則
        const { app, routes } = loadApp({ FEATURE_TUTOR: 'true', FEATURE_VOICE: 'true', MODEL_VOICE: 'ollama:qwen3-vl:8b' });
        const expected = routeMounted(routes, 'post', '/voice/transcribe') ? 'mounted' : 'none';
        assert.equal(metaContent((await request(app).get('/')).text, 'voice-route'), expected);
    });
});

// ───────────────────────── 4. tutor.js 的語音呈現 ─────────────────────────

let seq = 0;
const loadTutor = () => import('data:text/javascript;charset=utf-8,'
    + encodeURIComponent(TUTOR_SRC + `\n// publicOffline instance ${++seq}\n`));

describe('voiceMode（純函式）', () => {
    test('旗標關閉一律 off；旗標開著時只有明確的 none 才是 local，其餘維持原本的行為', async () => {
        const { voiceMode } = await loadTutor();
        assert.equal(voiceMode(false, 'none'), 'off');
        assert.equal(voiceMode(false, 'mounted'), 'off');
        assert.equal(voiceMode(true, 'none'), 'local');
        assert.equal(voiceMode(true, ' NONE '), 'local');
        assert.equal(voiceMode(true, 'mounted'), 'on');
        // 讀不到路由狀態：沒有這個 meta、佔位字串沒被換掉 → 同本機模式之前
        assert.equal(voiceMode(true, null), 'on');
        assert.equal(voiceMode(true, undefined), 'on');
        assert.equal(voiceMode(true, '__VOICE_ROUTE__'), 'on');
    });

    test('說明文字包含契約的原話「本機模式不提供語音」', async () => {
        const { LOCAL_VOICE_NOTE } = await loadTutor();
        assert.ok(LOCAL_VOICE_NOTE.includes('本機模式不提供語音'), LOCAL_VOICE_NOTE);
    });
});

describe('tutor.js 依 voice-route 決定要不要有按住說話（miniDom）', () => {
    let env = null;
    const saved = {};
    function setGlobal(name, value) {
        if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
    }
    afterEach(() => {
        if (env) env.restore();
        env = null;
        for (const [name, desc] of Object.entries(saved)) {
            if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name];
            delete saved[name];
        }
    });

    /** 麥克風環境一律「可用」：安全連線、有 getUserMedia 與 MediaRecorder——排除其他隱藏按鈕的原因 */
    async function mount(meta) {
        env = install({ meta: { 'feature-tutor': 'true', ...meta }, sections: ['tutor'], examApp: fakeBridge() });
        env.window.isSecureContext = true;
        setGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
        setGlobal('MediaRecorder', class { static isTypeSupported() { return true; } });
        // module 在 import 當下就會自己跑一次 init（document 已就緒），所以 import 也要包在攔截裡
        const infos = [];
        const real = console.info;
        console.info = (...a) => infos.push(a.join(' '));
        try {
            const mod = await loadTutor();
            await mod.init();
            await flush();
            return { mod, infos };
        } finally { console.info = real; }
    }
    const byId = (id) => env.document.getElementById(id);

    test('語音旗標開著、伺服器沒掛語音路由（本機模式）→ 沒有按鈕、沒有逐字稿面板，說明「本機模式不提供語音」', async () => {
        const { mod, infos } = await mount({ 'feature-voice': 'true', 'voice-route': 'none' });
        assert.equal(byId('tutorMic'), null, '按鈕不渲染（不是隱藏）');
        assert.equal(byId('tutorVoiceReview'), null);
        assert.equal(byId('tutorMicNote').textContent, mod.LOCAL_VOICE_NOTE);
        assert.match(byId('tutor').textContent, /本機模式不提供語音/);
        assert.ok(infos.some(s => s.startsWith('[tutor]') && s.includes('本機模式')), infos.join('\n'));
        // 打字提問照常可用
        assert.ok(byId('tutorInput') && byId('tutorSend'));
    });

    test('路由有掛（mounted）→ 按住說話照常渲染、可按', async () => {
        await mount({ 'feature-voice': 'true', 'voice-route': 'mounted' });
        const mic = byId('tutorMic');
        assert.ok(mic);
        assert.ok(!mic.classList.contains('hidden'));
        assert.ok(byId('tutorVoiceReview'));
        assert.doesNotMatch(byId('tutor').textContent, /本機模式不提供語音/);
    });

    test('語音旗標關閉 → 什麼都不放（不需要解釋一個沒開的功能）', async () => {
        await mount({ 'feature-voice': 'false', 'voice-route': 'none' });
        assert.equal(byId('tutorMic'), null);
        assert.equal(byId('tutorMicNote'), null);
        assert.doesNotMatch(byId('tutor').textContent, /本機模式不提供語音/);
    });

    test('沒有 voice-route 這個 meta（舊版頁面）→ 維持原本只看 feature-voice 的行為', async () => {
        await mount({ 'feature-voice': 'true' });
        assert.ok(byId('tutorMic'));
        assert.ok(!byId('tutorMic').classList.contains('hidden'));
    });

    test('UI 不預告「會用程式驗算」（本機模式沒有 code execution；有沒有驗算看每則回覆下方）', async () => {
        await mount({ 'feature-voice': 'false' });
        const text = byId('tutor').textContent;
        assert.doesNotMatch(text, /數值與代數結果由程式驗算/);
        assert.match(text, /沒有驗算的會標明/);
        assert.ok(!TUTOR_SRC.includes('家教正在解題並用程式驗算'), '送出後的等待訊息不得宣稱正在用程式驗算');
    });
});
