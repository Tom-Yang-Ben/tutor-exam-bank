// ─────────────────────────────────────────────────────────────
// test/unit/desktopLauncherConfig.test.js — 桌面啟動器的設定（scripts/desktop/lib/config.js）與模型需求（lib/models.js）
//
//   1. config：預設值、型別與範圍檢查（錯的那一項用預設值＋警告）、BOM、範本 config.example.json 與預設值一致。
//   2. models：effectiveModelSpecs 與 config/models.js 的 getter 逐一比對（兩邊的預設與退回鏈不能分岔）；
//      ollamaNeed 在本機模式、Gemini 模式、ocr／cross、遠端 OLLAMA_HOST、OCR 的 Python 各情況的結果。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cfg = require('../../scripts/desktop/lib/config');
const lm = require('../../scripts/desktop/lib/models');

const APP_DIR = path.resolve(__dirname, '..', '..');

describe('config', () => {
    test('沒有設定檔 → 全部預設、沒有警告', () => {
        const { config, warnings } = cfg.resolveConfig(null);
        assert.deepEqual(config, { ...cfg.DEFAULTS, browserArgs: [] });
        assert.deepEqual(warnings, []);
        assert.equal(config.stopDocker, 'no');
        assert.equal(config.stopOllama, false);
        assert.equal(config.dockerDesktopPath, 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe');
        // 〔Owner 第六輪 DL-4＝2，2026-09-27〕錄製中開的後端預設暫停背景工作
        assert.equal(config.jobsWhileRecording, 'pause');
        // DL-1＝1（每次問）、DL-3＝1（都不關）維持原本的預設
        assert.equal(config.askBeforeStopWithJobs, true);
        assert.equal(config.stopGraceSec, 120);
    });

    test('合法的覆寫照用；字串前後空白與大小寫', () => {
        const { config, warnings } = cfg.resolveConfig({
            dockerDesktopPath: ' D:\\Docker\\Docker Desktop.exe ', dockerReadyTimeoutSec: 600, browser: 'Chrome',
            stopDocker: 'Containers', stopOllama: true, browserArgs: [' --start-maximized ', ''], _註解: '略過', jobsWhileRecording: ' Run '
        });
        assert.deepEqual(warnings, []);
        assert.equal(config.jobsWhileRecording, 'run');
        assert.equal(cfg.resolveConfig({ jobsWhileRecording: ' PAUSE ' }).config.jobsWhileRecording, 'pause');
        assert.equal(config.dockerDesktopPath, 'D:\\Docker\\Docker Desktop.exe');
        assert.equal(config.dockerReadyTimeoutSec, 600);
        assert.equal(config.browser, 'chrome');
        assert.equal(config.stopDocker, 'containers');
        assert.equal(config.stopOllama, true);
        assert.deepEqual(config.browserArgs, ['--start-maximized']);
    });

    test('錯的那一項用預設值並警告，其他照用', () => {
        const { config, warnings } = cfg.resolveConfig({
            dockerReadyTimeoutSec: 5, serverReadyTimeoutSec: '120', browser: 'firefox', stopDocker: 'yes', stopOllama: 'true',
            browserArgs: '--x', nope: 1, ollamaReadyTimeoutSec: 90, jobsWhileRecording: 'stop'
        });
        assert.equal(config.jobsWhileRecording, 'pause', '寫錯時退回預設（pause），不是 run');
        assert.equal(config.dockerReadyTimeoutSec, cfg.DEFAULTS.dockerReadyTimeoutSec);
        assert.equal(config.serverReadyTimeoutSec, cfg.DEFAULTS.serverReadyTimeoutSec);
        assert.equal(config.browser, 'auto');
        assert.equal(config.stopDocker, 'no');
        assert.equal(config.stopOllama, false);
        assert.deepEqual(config.browserArgs, []);
        assert.equal(config.ollamaReadyTimeoutSec, 90);
        assert.equal(warnings.length, 8);
        assert.ok(warnings.some(x => x.includes('jobsWhileRecording 只接受 run／pause')));
        assert.ok(warnings.some(x => x.includes('nope')));
    });

    test('不是物件 → 整個不採用', () => {
        assert.equal(cfg.resolveConfig([1]).warnings.length, 1);
        assert.equal(cfg.resolveConfig('x').warnings.length, 1);
    });

    test('readConfigFile：不存在不是錯誤、記事本存的 BOM、壞掉的 JSON', () => {
        const fake = content => ({ readFileSync: () => { if (content === null) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return content; } });
        assert.deepEqual(cfg.readConfigFile('x', fake(null)).warnings, []);
        assert.equal(cfg.readConfigFile('x', fake(null)).found, false);
        const bom = cfg.readConfigFile('x', fake('\uFEFF{"stopOllama": true}'));
        assert.equal(bom.config.stopOllama, true);
        assert.deepEqual(bom.warnings, []);
        const bad = cfg.readConfigFile('x', fake('{ stopOllama: true }'));
        assert.equal(bad.found, true);
        assert.match(bad.warnings[0], /不是合法的 JSON/);
        assert.equal(bad.config.stopOllama, false);
    });

    test('範本 scripts/desktop/config.example.json 的鍵與值＝預設值（改預設要一起改範本）', () => {
        const raw = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'scripts', 'desktop', 'config.example.json'), 'utf8'));
        const { config, warnings } = cfg.resolveConfig(raw);
        assert.deepEqual(warnings, []);
        assert.deepEqual(config, { ...cfg.DEFAULTS, browserArgs: [] });
        const keys = Object.keys(raw).filter(k => !k.startsWith('_'));
        assert.deepEqual(keys.sort(), Object.keys(cfg.DEFAULTS).sort());
    });

    test('文件第 6 節的表列出每一個設定', () => {
        const doc = fs.readFileSync(path.join(APP_DIR, '..', 'docs', 'desktop-launcher.md'), 'utf8');
        for (const key of Object.keys(cfg.DEFAULTS)) assert.ok(doc.includes(`\`${key}\``), `docs/desktop-launcher.md 沒有提到 ${key}`);
    });
});

describe('models：與 config/models.js 同一條退回鏈', () => {
    const KEYS = ['MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_KC_TAG', 'MODEL_OCR_STRUCTURE', 'EMBED_MODEL', 'MODEL_TUTOR'];
    const ENVS = [
        {},
        { MODEL_EXTRACT: 'gemini:gemini-3.5-flash', MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview', EMBED_MODEL: 'gemini-embedding-001' },
        { MODEL_EXTRACT: 'gemini:gemini-3.5-flash' },
        { MODEL_TEXT: '  ollama:qwen3:4b  ', MODEL_KC_TAG: '', MODEL_OCR_STRUCTURE: 'ollama:qwen3:14b' },
        { MODEL_VERIFY: 'ollama:qwen3:14b', MODEL_TUTOR: ' ' },
        { EMBED_MODEL: '  ' }
    ];

    test('各種 .env 組合下，每個角色的模型都與 config/models.js 的 getter 相同', () => {
        const models = require('../../config/models');
        const saved = { ...process.env };
        try {
            for (const env of ENVS) {
                for (const k of [...KEYS, 'MODEL_VARIANT', 'MODEL_NLQ', 'MODEL_ASSISTANT']) delete process.env[k];
                Object.assign(process.env, env);
                const mine = lm.effectiveModelSpecs(env);
                for (const k of KEYS) assert.equal(mine[k], models[k], `${k}（env ${JSON.stringify(env)}）`);
                assert.equal(mine.MODEL_VARIANT, models.MODEL_VARIANT || models.MODEL_VERIFY, 'MODEL_VARIANT 沒設＝MODEL_VERIFY（jobRunner）');
            }
        } finally {
            for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
            Object.assign(process.env, saved);
        }
    });

    test('MODEL_NLQ 的預設與 services/nlqService.js 的 DEFAULT_MODEL_NLQ 相同；MODEL_ASSISTANT 沒設＝MODEL_TEXT', () => {
        const src = fs.readFileSync(path.join(APP_DIR, 'services', 'nlqService.js'), 'utf8');
        const m = src.match(/const DEFAULT_MODEL_NLQ = '([^']+)'/);
        assert.equal(m[1], lm.DEFAULT_MODEL_NLQ);
        const assistant = fs.readFileSync(path.join(APP_DIR, 'services', 'assistantService.js'), 'utf8');
        assert.match(assistant, /process\.env\.MODEL_ASSISTANT \|\| ''\)\.trim\(\) \|\| models\.MODEL_TEXT/);
        assert.equal(lm.effectiveModelSpecs({}).MODEL_ASSISTANT, lm.effectiveModelSpecs({}).MODEL_TEXT);
    });
});

describe('ollamaNeed', () => {
    const PY = 'C:\\py\\python.exe';
    const need = (env, found = true) => lm.ollamaNeed({ OCR_PYTHON: PY, ...env }, { exists: p => found && p === PY, platform: 'win32' });

    test('本機模式預設（.env 沒寫模型、LOCAL_EXTRACT_MODE 預設 ocr）→ 需要；不要求看圖模型', () => {
        const n = need({});
        assert.equal(n.needed, true);
        assert.deepEqual(n.models.sort(), ['qwen3-embedding:0.6b', 'qwen3:8b']);
        assert.equal(n.host, 'http://127.0.0.1:11434');
        assert.equal(n.local, true);
        assert.equal(n.ocrNeeded, true);
        assert.equal(n.ocrFound, true);
        assert.equal(n.error, undefined);
    });

    test('LOCAL_EXTRACT_MODE=cross → 也要看圖模型', () => {
        assert.ok(need({ LOCAL_EXTRACT_MODE: 'cross' }).models.includes('qwen3-vl:8b'));
    });

    test('Gemini 模式（照 .env.example 改五行）→ 不需要 Ollama、不需要 OCR', () => {
        const n = need({ MODEL_EXTRACT: 'gemini:gemini-3.5-flash', MODEL_VERIFY: 'gemini:gemini-3.1-pro-preview', MODEL_NLQ: 'gemini:gemini-3.5-flash', EMBED_MODEL: 'gemini-embedding-001' });
        assert.equal(n.needed, false);
        assert.deepEqual(n.models, []);
        assert.equal(n.ocrNeeded, false);
        assert.equal(n.ocrFound, null);
    });

    test('只有向量模型是本機的 → 仍需要', () => {
        const n = need({ MODEL_EXTRACT: 'gemini:a', MODEL_VERIFY: 'gemini:b', MODEL_NLQ: 'gemini:c' });
        assert.equal(n.needed, true);
        assert.deepEqual(n.models, ['qwen3-embedding:0.6b']);
    });

    test('AI 家教、助教有開才列它們的模型', () => {
        assert.ok(!need({ MODEL_TUTOR: 'ollama:big:70b' }).models.includes('big:70b'));
        assert.ok(need({ MODEL_TUTOR: 'ollama:big:70b', FEATURE_TUTOR: 'true' }).models.includes('big:70b'));
        assert.ok(need({ MODEL_ASSISTANT: 'ollama:helper:1b', FEATURE_ASSISTANT: '1' }).models.includes('helper:1b'));
    });

    test('OLLAMA_HOST：0.0.0.0 當本機、別台電腦 local:false、寫錯 → error', () => {
        assert.equal(need({ OLLAMA_HOST: '0.0.0.0' }).host, 'http://127.0.0.1:11434');
        const remote = need({ OLLAMA_HOST: 'http://192.168.1.20:11434' });
        assert.equal(remote.local, false);
        assert.match(need({ OLLAMA_HOST: 'ftp://x' }).error, /OLLAMA_HOST/);
    });

    test('OCR：Python 不在 → ocrFound:false；OCR_ENGINE=none → 不需要；只寫指令名 → 判斷不了（null）', () => {
        assert.equal(need({}, false).ocrFound, false);
        assert.equal(need({ OCR_ENGINE: 'none', LOCAL_EXTRACT_MODE: 'cross' }).ocrNeeded, false);
        assert.equal(need({ OCR_PYTHON: 'python' }).ocrFound, null);
    });

    test('模型字串寫錯 → error（後端啟動時也會報同一個錯）', () => {
        assert.match(need({ MODEL_VERIFY: 'mistral:foo' }).error, /未知的供應商/);
    });

    test('hasModel／missingModels：沒寫 tag＝:latest、不分大小寫', () => {
        const body = { models: [{ name: 'Qwen3:8B' }, { model: 'llama3:latest' }] };
        assert.deepEqual(lm.missingModels(body, ['qwen3:8b', 'llama3', 'qwen3-embedding:0.6b']), ['qwen3-embedding:0.6b']);
        assert.deepEqual(lm.missingModels(null, ['a']), ['a']);
    });
});
