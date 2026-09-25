// ─────────────────────────────────────────────────────────────
// test/unit/localModeScripts.test.js — 本機模式的腳本、設定範本與 CI 接線（docs/local-mode.md 第 6 條，L4）
//
//   1. Windows 一鍵腳本（scripts/windows/*.bat）：CRLF、UTF-8 無 BOM、chcp 65001；步驟與順序照契約；
//      每一步失敗都會停下；echo 裡沒有會被 cmd 當成轉向的字元；拉的模型就是 ci.yml 的本機預設。
//   2. .env.example：第 2 條的變數一個不少；本機預設；依模型決定預設的兩個變數刻意不寫死。
//   3. package.json 的 ocr:selftest、ci.yml 的本機模型（CI 仍是 replay＋fixture、不裝 Ollama／Python）。
//   4. eval/tools/tee_run.js（腳本用來同時印畫面與寫 log）、eval/tools/ocr_selftest.js、scripts/record_cassettes.js 的切塊預設。
// 不連網、不跑 Python、不跑 cmd.exe。
// ─────────────────────────────────────────────────────────────

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const local = require('../../eval/lib/localMode');
const sp = require('../../eval/lib/suiteProcess');
const tee = require('../../eval/tools/tee_run');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const WIN = path.join(APP_DIR, 'scripts', 'windows');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-scripts-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 讀 .bat 的原始位元組與文字 */
function readBat(name) {
    const buf = fs.readFileSync(path.join(WIN, name));
    return { buf, text: buf.toString('utf8') };
}

/** 去掉 REM 註解與空行後的指令行（保留順序） */
function commandLines(text) {
    return text.split('\r\n').map(l => l.trim()).filter(l => l && !/^rem(\s|$)/i.test(l) && !l.startsWith('::'));
}

describe('scripts/windows/*.bat（第 6 條第 4 點）', () => {
    const BATS = ['setup_local_ai.bat', 'record_local.bat'];

    test('CRLF 行尾、UTF-8 無 BOM、開頭 @echo off＋chcp 65001', () => {
        for (const name of BATS) {
            const { buf, text } = readBat(name);
            assert.notEqual(buf.subarray(0, 3).toString('hex'), 'efbbbf', `${name} 不可以有 BOM（cmd 會把第一行讀壞）`);
            assert.equal(Buffer.from(text, 'utf8').equals(buf), true, `${name} 不是合法的 UTF-8`);
            assert.ok(!/[^\r]\n/.test(text) && !text.startsWith('\n'), `${name} 有只用 LF 的行（Windows 的 cmd 要 CRLF）`);
            assert.ok(text.endsWith('\r\n'), `${name} 最後一行要換行`);
            const lines = text.split('\r\n');
            assert.equal(lines[0], '@echo off');
            assert.equal(lines[1], 'chcp 65001 >nul');
        }
    });

    test('每一個 goto／call 的標籤都存在；結束前都有 pause（雙擊時視窗不會一閃就關）', () => {
        for (const name of BATS) {
            const { text } = readBat(name);
            const labels = new Set(text.split('\r\n').filter(l => /^:[A-Za-z_]\w*\s*$/.test(l)).map(l => l.trim().slice(1).toLowerCase()));
            for (const m of text.matchAll(/(?:goto|call)\s+:(\w+)/gi)) {
                if (m[1].toLowerCase() === 'eof') continue;
                assert.ok(labels.has(m[1].toLowerCase()), `${name}：找不到標籤 :${m[1]}`);
            }
            const exits = commandLines(text).filter(l => /^exit \/b (0|1|%RC%)$/i.test(l));
            assert.ok(exits.length >= 2, `${name}：成功與失敗都要有明確的 exit /b`);
            assert.ok((text.match(/\r\npause\r\n/g) || []).length >= 2, `${name}：成功與失敗的出口前都要 pause`);
        }
    });

    test('echo 與 :log 的訊息裡沒有會被 cmd 當成轉向或管線的字元（< > | &；引號內與 ^ 跳脫的除外）', () => {
        for (const name of BATS) {
            for (const line of commandLines(readBat(name).text)) {
                if (!/^(echo|call :log)/i.test(line)) continue;
                if (/^echo yes\|/.test(line)) continue;   // 刻意的管線：自動輸入 yes
                const bare = line.replace(/"[^"]*"/g, '').replace(/\^[|<>&]/g, '');
                assert.ok(!/[<>|&]/.test(bare), `${name}：${line}`);
            }
        }
    });

    test('log 寫到 exam_pro\\data\\local_ai\\（data/ 已 gitignore），輸出經 eval\\tools\\tee_run.js 同時印畫面與寫 log', () => {
        for (const name of BATS) {
            const { text } = readBat(name);
            assert.ok(text.includes('set "LOGDIR=%APP%\\data\\local_ai"'), name);
            assert.ok(text.includes('cd /d "%~dp0..\\.."'), `${name} 要切到 exam_pro\\（雙擊時工作目錄不一定在那裡）`);
            assert.ok(text.includes('eval\\tools\\tee_run.js'), name);
        }
        const ignore = fs.readFileSync(path.join(APP_DIR, '.gitignore'), 'utf8');
        assert.match(ignore, /^data\/$/m, 'exam_pro/.gitignore 要擋 data/（log 不進版控）');
    });

    test('setup_local_ai.bat：Ollama 在跑 → pull 三個模型 → Python → venv → pip install → --warmup → --selftest，每步失敗就停', () => {
        const lines = commandLines(readBat('setup_local_ai.bat').text);
        const at = (re) => {
            const i = lines.findIndex(l => re.test(l));
            assert.ok(i >= 0, `找不到 ${re}`);
            return i;
        };
        const failsAfter = (i, label) => assert.match(lines[i + 1], new RegExp(`^if errorlevel 1 goto :${label}$`), `${lines[i]} 之後要檢查失敗並停下`);

        const list = at(/^"%OLLAMA%" list /);
        failsAfter(list, 'ollama_down');
        // 三個模型＝CI 的本機預設（ci.yml 的 MODEL_EXTRACT／MODEL_VERIFY／EMBED_MODEL）
        const ci = sp.readCiModels();
        const want = [ci.MODEL_EXTRACT, ci.MODEL_VERIFY, ci.EMBED_MODEL].map(local.modelIdOf);
        assert.deepEqual(want, ['qwen3-vl:8b', 'qwen3:8b', 'qwen3-embedding:0.6b']);
        const pulls = want.map(id => at(new RegExp(`^call :pull ${id.replace(/[.]/g, '\\.')}$`)));
        for (const i of pulls) failsAfter(i, 'pull_failed');
        assert.ok(pulls.every(i => i > list));

        const py = at(/^py -3 --version/);
        const venv = at(/^%PY% -m venv "%VENV%"/);
        failsAfter(venv, 'venv_failed');
        const pip = at(/^%TEE% "%VPY%" -m pip install -r "%OCR_DIR%\\requirements\.txt"$/);
        failsAfter(pip, 'pip_failed');
        const warm = at(/^%TEE% "%VPY%" "%OCR_DIR%\\ocr_pdf\.py" --warmup$/);
        failsAfter(warm, 'warmup_failed');
        const self = at(/^%TEE% "%VPY%" "%OCR_DIR%\\ocr_pdf\.py" --selftest$/);
        failsAfter(self, 'selftest_failed');
        assert.ok(Math.max(...pulls) < py && py < venv && venv < pip && pip < warm && warm < self, '順序照契約第 6 條第 4 點');

        // venv 的位置＝OCR_PYTHON 的預設（第 2 條）
        const { text } = readBat('setup_local_ai.bat');
        assert.ok(text.includes('set "VENV=%OCR_DIR%\\.venv"') && text.includes('set "VPY=%VENV%\\Scripts\\python.exe"'));
        assert.ok(local.ocrPython({}, 'win32').endsWith(path.join('ocr_service', '.venv', 'Scripts', 'python.exe')));
        // Python：先 py -3 再 python；3.9 以上、64 位元
        assert.ok(lines.some(l => l.startsWith('%PY% -c') && l.includes('(3, 9)') && l.includes("calcsize('P') == 8")));
        assert.ok(text.includes('set "PYTHONUTF8=1"'), 'Python 的輸出要是 UTF-8，log 才不會亂碼');
    });

    test('record_local.bat：db:up → migrate:test → echo yes| cassettes:rerecord；前兩步失敗就停；結束碼照 rerecord', () => {
        const lines = commandLines(readBat('record_local.bat').text);
        const idx = (s) => lines.indexOf(s);
        const up = idx('%TEE% npm run db:up');
        const mig = idx('%TEE% npm run migrate:test');
        const rec = idx('echo yes| %TEE% npm run cassettes:rerecord %SUITES%');
        assert.ok(up > 0 && mig > up && rec > mig, lines.join('\n'));
        assert.equal(lines[up + 1], 'if errorlevel 1 goto :dbup_failed');
        assert.equal(lines[mig + 1], 'if errorlevel 1 goto :migrate_failed');
        assert.equal(lines[rec + 1], 'set "RC=%ERRORLEVEL%"');
        assert.ok(lines.includes('exit /b %RC%'));
        assert.ok(lines.includes('if not "%~1"=="" set "SUITES=-- --suites %*"'), '命令列帶 classify,nlq 時只錄那幾個 suite');
        assert.ok(lines.indexOf('docker info >nul 2>&1') < up, '先確認 Docker 在跑');
    });

    test('不做 switch_to_gemini.bat／switch_to_local.bat（第 6 條第 4 點：改 .env 由 Owner 自己來）', () => {
        const names = fs.readdirSync(WIN);
        assert.ok(!names.some(n => /switch/i.test(n)), names.join(', '));
    });
});

describe('.env.example（第 6 條第 5 點：補齊第 2 條全部變數）', () => {
    const text = fs.readFileSync(path.join(APP_DIR, '.env.example'), 'utf8');
    const parsed = require('dotenv').parse(text);
    /** 有寫（不論是否註解掉）的變數名 */
    const mentioned = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]));

    test('docs/local-mode.md 第 2 條表格裡的每一個變數都有寫（含註解掉的範例）', () => {
        const doc = fs.readFileSync(path.join(REPO, 'docs', 'local-mode.md'), 'utf8');
        const section = doc.slice(doc.indexOf('## 2.'), doc.indexOf('## 3.'));
        const vars = [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)`/gm)].map(m => m[1]);
        for (const m of section.matchAll(/`(MODEL_[A-Z]+)`/g)) vars.push(m[1]);
        assert.ok(vars.length >= 18, `第 2 條的表格讀到 ${vars.length} 個變數`);
        const missing = [...new Set(vars)].filter(v => !mentioned.has(v));
        assert.deepEqual(missing, [], '.env.example 缺這些第 2 條的變數');
    });

    test('啟用中的值是本機預設；金鑰留空；MODEL_NLQ 不可以留空（程式預設是 Gemini）', () => {
        assert.equal(parsed.MODEL_EXTRACT, local.LOCAL_DEFAULTS.MODEL_EXTRACT);
        assert.equal(parsed.MODEL_VERIFY, local.LOCAL_DEFAULTS.MODEL_VERIFY);
        assert.equal(parsed.EMBED_MODEL, local.LOCAL_DEFAULTS.EMBED_MODEL);
        assert.equal(parsed.OLLAMA_HOST, local.LOCAL_DEFAULTS.OLLAMA_HOST);
        assert.equal(parsed.OCR_ENGINE, 'paddle');
        assert.equal(parsed.OCR_DPI, '200');
        assert.equal(parsed.OLLAMA_CONCURRENCY, '1');
        assert.equal(parsed.GEMINI_API_KEY, '');
        assert.equal(local.vendorOf(parsed.MODEL_NLQ), 'ollama');
        const cloud = Object.entries(parsed).filter(([k, v]) => /^(MODEL_|EMBED_MODEL$)/.test(k) && v && local.vendorOf(v) === 'gemini');
        assert.deepEqual(cloud, [], '範本啟用的模型不可以走 Gemini（本機模式原則 1：執行期不連外）');
    });

    test('依拆題模型決定預設的兩個變數刻意不寫死（第 2 條：明寫的值一律優先）；空字串與「沒設」不同的變數也不寫空值', () => {
        for (const k of ['JOB_PDF_CHUNK_PAGES', 'JOB_NODE_TIMEOUT_MS', 'OCR_PYTHON', 'OLLAMA_RPM', 'MODEL_OCR_STRUCTURE']) {
            assert.ok(!(k in parsed), `${k} 不該是啟用的設定`);
            assert.ok(mentioned.has(k), `${k} 要以註解的形式寫出來`);
        }
    });

    test('寫清楚「切回 Gemini 要改哪幾行」', () => {
        const block = text.slice(text.indexOf('切回 Gemini：'), text.indexOf('GEMINI_API_KEY=\n'));
        for (const line of ['GEMINI_API_KEY=', 'MODEL_EXTRACT=gemini:gemini-3.5-flash', 'MODEL_VERIFY=gemini:gemini-3.1-pro-preview',
            'MODEL_NLQ=gemini:gemini-3.5-flash', 'EMBED_MODEL=gemini-embedding-001', 'npm run embed:backfill', 'npm run search:reindex']) {
            assert.ok(block.includes(line), `切回 Gemini 的說明少了 ${line}`);
        }
    });
});

describe('package.json 與 ci.yml', () => {
    test('npm run ocr:selftest 跑 eval/tools/ocr_selftest.js', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['ocr:selftest'], 'node eval/tools/ocr_selftest.js');
        assert.ok(fs.existsSync(path.join(APP_DIR, 'eval', 'tools', 'ocr_selftest.js')));
    });

    test('ci.yml：模型與 EMBED_MODEL 是本機預設；CI 仍是 replay＋fixture；不裝 Ollama、不裝 Python、沒有金鑰', () => {
        const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
        const models = sp.readCiModels();
        assert.equal(models.MODEL_EXTRACT, local.LOCAL_DEFAULTS.MODEL_EXTRACT);
        assert.equal(models.MODEL_VERIFY, local.LOCAL_DEFAULTS.MODEL_VERIFY);
        assert.equal(models.EMBED_MODEL, local.LOCAL_DEFAULTS.EMBED_MODEL);
        assert.equal(local.vendorOf(models.MODEL_NLQ), 'ollama', 'nlq 的程式預設是 Gemini，CI 要明寫本機模型，重錄才不會連雲端');
        assert.match(ci, /^\s+LLM_MODE: replay$/m);
        assert.match(ci, /^\s+EMBED_MODE: fixture$/m);
        assert.ok(!/ollama (pull|serve)|setup-python|pip install/.test(ci), 'CI 不裝 Ollama、不裝 Python');
        assert.ok(!/gemini:/.test(ci.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')), 'CI 的設定裡不該再有 gemini: 模型');
    });
});

describe('eval/tools/tee_run.js（Windows 沒有 tee）', () => {
    const TEE = path.join(APP_DIR, 'eval', 'tools', 'tee_run.js');

    test('輸出照樣印出、同時附加到 log（去掉 ANSI 色碼、中文不亂碼）；結束碼照子行程', () => {
        const log = path.join(tmp, 'sub', 'a.log');
        const script = "process.stdout.write('\\x1b[32m綠色 中文\\x1b[0m\\n'); process.stderr.write('錯誤輸出\\n'); process.exit(3)";
        const res = spawnSync(process.execPath, [TEE, log, process.execPath, '-e', script], { encoding: 'utf8' });
        assert.equal(res.status, 3);
        assert.match(res.stdout, /綠色 中文/);
        assert.match(res.stderr, /錯誤輸出/);
        const text = fs.readFileSync(log, 'utf8');
        assert.match(text, /綠色 中文/);
        assert.ok(!text.includes('\x1b['), 'log 不留 ANSI 色碼');
        assert.match(text, /錯誤輸出/);
        assert.match(text, /結束碼 3/);
        // 第二次附加在後面，不覆寫
        spawnSync(process.execPath, [TEE, log, process.execPath, '-e', "console.log('第二次')"], { encoding: 'utf8' });
        const again = fs.readFileSync(log, 'utf8');
        assert.ok(again.startsWith(text) && again.includes('第二次'));
    });

    test('stdin 原樣交給子行程（record_local.bat 的 echo yes| 靠這個）', () => {
        const log = path.join(tmp, 'b.log');
        const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('收到:'+s.trim());process.exit(s.trim()==='yes'?0:9)})";
        const res = spawnSync(process.execPath, [TEE, log, process.execPath, '-e', script], { input: 'yes\r\n', encoding: 'utf8' });
        assert.equal(res.status, 0, res.stdout + res.stderr);
        assert.match(fs.readFileSync(log, 'utf8'), /收到:yes/);
    });

    test('參數不足回 2；指令不存在回 1 並寫進 log', () => {
        const res = spawnSync(process.execPath, [TEE], { encoding: 'utf8' });
        assert.equal(res.status, 2);
        const log = path.join(tmp, 'c.log');
        const bad = spawnSync(process.execPath, [TEE, log, path.join(tmp, '沒有這支程式')], { encoding: 'utf8' });
        assert.equal(bad.status, 1);
        assert.match(fs.readFileSync(log, 'utf8'), /結束碼 1/);
    });

    test('Windows 經 cmd.exe 啟動（npm 是 npm.cmd）；含空白的參數加引號', async () => {
        assert.equal(tee.quoteForCmd('npm'), 'npm');
        assert.equal(tee.quoteForCmd('C:\\Program Files\\x\\python.exe'), '"C:\\Program Files\\x\\python.exe"');
        assert.equal(tee.quoteForCmd('a"b c'), '"a""b c"');
        assert.equal(tee.quoteForCmd(''), '""');
        const calls = [];
        const { EventEmitter } = require('node:events');
        const spawnImpl = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => child.emit('close', 0, null));
            return child;
        };
        const code = await tee.run([path.join(tmp, 'w.log'), 'npm', 'run', 'cassettes:rerecord', '--', '--suites', 'classify,nlq'], { platform: 'win32', spawnImpl });
        assert.equal(code, 0);
        assert.equal(calls[0].opts.shell, true);
        assert.equal(calls[0].cmd, 'npm run cassettes:rerecord -- --suites "classify,nlq"');
        assert.deepEqual(calls[0].opts.stdio, ['inherit', 'pipe', 'pipe']);
        assert.equal(tee.stripAnsi('\x1b[1m粗\x1b[0m\x1b]0;title\x07'), '粗');
    });
});

describe('eval/tools/ocr_selftest.js 與 scripts/record_cassettes.js', () => {
    test('ocr:selftest：通過回 0、沒過回 1 並印處置（setup_local_ai.bat）', async (t) => {
        const { main } = require('../../eval/tools/ocr_selftest');
        t.mock.method(console, 'log', () => {});
        const errors = [];
        t.mock.method(console, 'error', (m) => errors.push(String(m)));
        const seen = [];
        assert.equal(await main({ env: { OCR_PYTHON: '/venv/bin/python' }, checkOcr: async (o) => { seen.push(o.python); return { ok: true, engineVersion: '3.0.0' }; } }), 0);
        assert.deepEqual(seen, ['/venv/bin/python']);
        assert.equal(await main({ env: {}, checkOcr: async () => ({ ok: false, error: '找不到 OCR 用的 Python', detail: [] }) }), 1);
        assert.ok(errors.some(e => e.includes('setup_local_ai.bat')));
    });

    test('record_cassettes：一塊幾頁——明寫的優先，否則 ollama 2 頁、其他 20 頁（第 2 條）', () => {
        const rc = require('../../scripts/record_cassettes');
        assert.equal(rc.chunkPages({}, 'ollama:qwen3-vl:8b'), 2);
        assert.equal(rc.chunkPages({}, 'gemini:gemini-3.5-flash'), 20);
        assert.equal(rc.chunkPages({ JOB_PDF_CHUNK_PAGES: '5' }, 'ollama:qwen3-vl:8b'), 5);
        assert.equal(rc.chunkPages({ JOB_PDF_CHUNK_PAGES: '' }, 'ollama:qwen3-vl:8b'), 2);
        assert.equal(rc.vendorOf('ollama:qwen3:8b'), 'ollama');
        assert.equal(rc.vendorOf('gemini-3.5-flash'), 'gemini');
    });
});
