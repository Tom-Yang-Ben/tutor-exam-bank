// eval/lib/suiteVariant.js：錄製時 dedup1 的向量也要走 EMBED_MODE=record（dec/fix-variant-embed-record）
//
// 重現 Owner 2026-09-26 以本機模型重錄 variant suite 時的失敗：
//   LLM_MODE=record、EMBED_MODE=record 跑完，最後卻報
//   「dedup1 取不到變式題的向量（EMBED_MODE=fixture）：embedding fixture 查無此文本（sha256=0e0b50ad…）」
//   文本開頭「數學｜向量內積｜計算｜難度3\n設平面向量 a = (3, 1)、b = (2, 4)，求兩向量的夾角 θ。」
//
// 根因：dedup1 的記憶體版（dedup1InMemory）寫死 embedFromFixture，不看 EMBED_MODE。
// 平常看不出來，是因為 generateVariant 的跑題檢查剛剛才用 record 把「同一段文字」錄進 fixture；
// 只有在 classify 換章或 lint 改寫題幹、讓 dedup1 的 embed_text 與跑題檢查那一段不同時才會 miss。
// 這裡用 lint 的第三層（LLM 重寫）把 \overrightarrow 改成 \vec——改寫後的 embed_text 的 sha256
// 正好就是 Owner 那一行的 0e0b50ad…。
//
// 不連 Ollama：模型與向量都走 services/llm/ollama.js 既有的測試注入點（_setTransportForTest）；
// cassette 與向量檔一律寫到系統暫存目錄，不碰 repo 的 eval/。
//
// 執行：npm test

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_KEYS = [
    'LLM_MODE', 'EMBED_MODE', 'EMBED_MODEL', 'EMBED_DIM', 'EMBED_FIXTURE_DIR', 'EVAL_CASSETTE_DIR',
    'MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_VARIANT', 'MODEL_TEXT', 'OLLAMA_HOST', 'OLLAMA_RPM',
    'OLLAMA_CONCURRENCY', 'CLASSIFY_MIN_CONF', 'DEDUP_DUP_THRESHOLD'
];
const envBackup = {};
for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-varembed-'));
// 與 ci.yml 相同的本機模型（檔名 embeddings.ollama-qwen3-embedding-0.6b.768.json 與 Owner 的那一份相同）
process.env.EMBED_MODEL = 'ollama:qwen3-embedding:0.6b';
process.env.EMBED_DIM = '768';
process.env.MODEL_EXTRACT = 'ollama:qwen3-vl:8b';
process.env.MODEL_VERIFY = 'ollama:qwen3:8b';
process.env.EMBED_FIXTURE_DIR = path.join(tmpDir, 'fixtures');
process.env.EVAL_CASSETTE_DIR = path.join(tmpDir, 'cassettes');

const ollama = require('../../services/llm/ollama');
const llmFixture = require('../../services/llm/fixture');
const suite = require('../../eval/lib/suiteVariant');
const { loadFixture } = require('../../eval/lib/fixtures');
const { buildEmbedText } = require('../../utils/embedText');

/** Owner 那一行錯誤訊息裡的 sha256 */
const OWNER_MISS_SHA = '0e0b50ad2988e3d0cef567b3b42b0caef0a14d087a8c804a1c9c9f132017bbc6';
const OWNER_MISS_TEXT = '數學｜向量內積｜計算｜難度3\n設平面向量 a = (3, 1)、b = (2, 4)，求兩向量的夾角 θ。';

// 藍本 #11（數學／向量內積／難度 3／計算），golden 的 var-006
const GOLDEN = {
    entries: [{
        id: 'var-006', source_question_id: 11, subject: '數學', chapter: '向量內積', difficulty: 3,
        question_type: '計算', expect: { min_retrieved: 2 }, needs_human_confirm: false
    }]
};

// 第一題：模型寫了 \overrightarrow（過得了只改字閘門），lint 的硬閘門判 unknown_command，第三層重寫成 \vec
const VARIANT_ARROW = {
    chapter: '向量內積', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
    question_text: '設平面向量 $\\overrightarrow{a} = (3, 1)$、$\\overrightarrow{b} = (2, 4)$，求兩向量的夾角 $\\theta$。',
    answer_text: '$\\cos \\theta = \\frac{10}{\\sqrt{10} \\sqrt{20}} = \\frac{1}{\\sqrt{2}}$，故 $\\theta = 45^\\circ$。'
};
const LINT_REWRITE = {
    question_text: VARIANT_ARROW.question_text.replace(/\\overrightarrow/g, '\\vec'),
    answer_text: VARIANT_ARROW.answer_text,
    notes: '\\overrightarrow 改寫為 \\vec'
};
// 第二題：一般情況（lint 零成本閘門直接過、題幹不變）——其他 59 題走的就是這條
const VARIANT_PLAIN = {
    chapter: '向量內積', chapter_confidence: 0.9, question_type: '計算', difficulty: 3,
    question_text: '一艘船的航行向量為 $\\vec{u} = (4, 3)$，海流向量為 $\\vec{w} = (0, 5)$，求兩向量夾角的餘弦值 $\\cos \\phi$。',
    answer_text: '$\\cos \\phi = \\frac{15}{5 \\times 5} = \\frac{3}{5}$'
};

/** 確定性的假向量（sha256 展開成 768 維）：只給單元測試的假 Ollama 用 */
function fakeVector(text, dim = 768) {
    const out = [];
    for (let k = 0; out.length < dim; k++) {
        const buf = crypto.createHash('sha256').update(`${k}:${text}`, 'utf8').digest();
        for (const b of buf) { if (out.length < dim) out.push(b / 127.5 - 1); }
    }
    return out;
}

/** 假 Ollama：/api/chat 依 system 分辨 variant／lint，/api/embed 回確定性向量；每次呼叫都記下來 */
function installFakeOllama() {
    const calls = { chat: [], embed: [] };
    let variantN = 0;
    ollama._setTransportForTest(async (url, payload) => {
        const reply = (body) => ({ status: 200, text: JSON.stringify(body) });
        if (url.endsWith('/api/embed')) {
            calls.embed.push(...payload.input);
            return reply({ model: payload.model, embeddings: payload.input.map(t => fakeVector(t, payload.dimensions)), prompt_eval_count: 10 });
        }
        if (url.endsWith('/api/chat')) {
            const system = payload.messages[0].content;
            let data;
            if (system.startsWith('你是一位資深的台灣高中數學與物理家教老師')) {
                variantN += 1;
                data = variantN === 1 ? VARIANT_ARROW : VARIANT_PLAIN;
            } else if (system.startsWith('你是數學與物理題庫的 LaTeX 校對員')) {
                data = LINT_REWRITE;
            } else {
                throw new Error(`假 Ollama：沒預期的 /api/chat（${system.slice(0, 30)}）`);
            }
            calls.chat.push(system.slice(0, 12));
            return reply({
                model: payload.model, done: true, done_reason: 'stop',
                message: { role: 'assistant', content: JSON.stringify(data) },
                prompt_eval_count: 100, eval_count: 50
            });
        }
        throw new Error(`假 Ollama：沒預期的網址 ${url}`);
    });
    return calls;
}

/** 回放時不得呼叫任何模型（CI 沒有 Ollama） */
function forbidOllama() {
    ollama._setTransportForTest(async (url) => { throw new Error(`回放模式不得呼叫模型：${url}`); });
}

// verify 用假的（與 evalVariant.test.js 同一招）：這裡要驗的是向量，不是驗算
const fakeVerify = { run: async () => ({ kind: 'pass', data: { compare: 'agree', final_answer: '$45^\\circ$' } }) };

const fixture = loadFixture();
// fixture 題的向量（retrieved 與 dedup1 的比對對象）：與假 Ollama 同一個函式
const emb = { vectorOf: (q) => fakeVector(buildEmbedText(q)) };

async function runOnce() {
    const failures = [];
    const warnings = [];
    const res = await suite.runGeneration({
        golden: GOLDEN, fixture, emb,
        offtopicSimMin: -1,            // 假向量彼此幾乎正交；跑題檢查不是這裡要驗的
        generateFn: null,              // 走真的 agents/generateVariant.js（它自己的跑題檢查會 embed 兩段文字）
        failures, warnings,
        agentOverrides: { verify: fakeVerify }
    });
    return { ...res, failures, warnings };
}

function embedFixtureFile() {
    return llmFixture.fixturePath(process.env.EMBED_MODEL, 768);
}

function readEmbedTable() {
    return JSON.parse(fs.readFileSync(embedFixtureFile(), 'utf8'));
}

after(() => {
    ollama._resetForTest();
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('variant suite 錄製：dedup1 的向量走 EMBED_MODE（Owner 2026-09-26 的 dedup1 miss）', () => {
    let recorded;
    let calls;

    before(async () => {
        process.env.LLM_MODE = 'record';
        process.env.EMBED_MODE = 'record';
        calls = installFakeOllama();
        recorded = await runOnce();
    });

    test('前提：lint 改寫後的 embed_text 就是 Owner 那一筆（sha256=0e0b50ad…），與跑題檢查錄的那一段不同', () => {
        assert.equal(llmFixture.sha256Hex(OWNER_MISS_TEXT), OWNER_MISS_SHA);
        const afterLint = buildEmbedText({ subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: LINT_REWRITE.question_text });
        assert.equal(afterLint, OWNER_MISS_TEXT);
        const offTopic = buildEmbedText({ subject: '數學', chapter: '向量內積', question_type: '計算', difficulty: 3, question_text: VARIANT_ARROW.question_text });
        assert.notEqual(offTopic, afterLint, '跑題檢查 embed 的是 lint 之前的題幹');
        // lint 的第三層真的呼叫了模型（就是這一步讓兩段文字分岔）
        assert.ok(calls.chat.some(s => s.startsWith('你是數學與物理題庫')), `沒有走到 lint 的重寫：${calls.chat.join('、')}`);
    });

    test('LLM_MODE=record＋EMBED_MODE=record：dedup1 不再去 fixture 查，改呼叫模型並錄進向量檔', () => {
        assert.deepEqual(recorded.failures, [], recorded.failures.join('\n'));
        assert.ok(!recorded.warnings.some(w => w.includes('查不到變式題的向量')), recorded.warnings.join('\n'));
        assert.equal(recorded.generations, 2);
        assert.equal(recorded.counts.dedup1, 2, '兩題都走到 dedup1 而且量得到');
        assert.equal(recorded.rate, 1, 'gate_pass_rate 量得到（不是 n/a）');

        assert.ok(calls.embed.includes(OWNER_MISS_TEXT), 'dedup1 的 embed_text 要送去模型算');
        const table = readEmbedTable();
        assert.ok(table[OWNER_MISS_SHA], `向量檔沒有 ${OWNER_MISS_SHA}：${embedFixtureFile()}`);
        assert.equal(table[OWNER_MISS_SHA].length, 768);
    });

    test('錄完再以 CI 的設定回放（LLM_MODE=replay、EMBED_MODE=fixture）：不呼叫模型、零 miss、數字與錄製時相同', async () => {
        process.env.LLM_MODE = 'replay';
        process.env.EMBED_MODE = 'fixture';
        forbidOllama();
        const replayed = await runOnce();
        assert.deepEqual(replayed.failures, [], replayed.failures.join('\n'));
        assert.equal(replayed.rate, recorded.rate);
        assert.deepEqual(replayed.counts, recorded.counts);
    });

    test('Owner 的補錄路徑：cassette 都在、只缺 dedup1 那一筆 → LLM_MODE=replay＋EMBED_MODE=record 只補向量、不呼叫 LLM，之後回放零 miss', async () => {
        // 重現 Owner 錄完第 4 步那一刻的向量檔：其他都在，只少 lint 改寫後那一段
        const file = embedFixtureFile();
        const table = readEmbedTable();
        delete table[OWNER_MISS_SHA];
        fs.writeFileSync(file, JSON.stringify(table) + '\n', 'utf8');

        process.env.LLM_MODE = 'replay';
        process.env.EMBED_MODE = 'record';
        const chats = [];
        ollama._setTransportForTest(async (url, payload) => {
            if (!url.endsWith('/api/embed')) { chats.push(url); throw new Error(`補錄向量時不得呼叫 LLM：${url}`); }
            return { status: 200, text: JSON.stringify({ embeddings: payload.input.map(t => fakeVector(t, payload.dimensions)) }) };
        });
        const filled = await runOnce();
        assert.deepEqual(filled.failures, [], filled.failures.join('\n'));
        assert.deepEqual(chats, [], 'variant／lint 全部從 cassette 回放');
        assert.ok(readEmbedTable()[OWNER_MISS_SHA], '缺的那一筆補回來了');

        process.env.EMBED_MODE = 'fixture';
        forbidOllama();
        const replayed = await runOnce();
        assert.deepEqual(replayed.failures, [], replayed.failures.join('\n'));
        assert.equal(replayed.rate, recorded.rate);
    });

    test('回放時向量檔少了 dedup1 那一筆：照舊誠實回 n/a，訊息寫的是實際的 EMBED_MODE（不回退成假向量）', async () => {
        process.env.LLM_MODE = 'replay';
        process.env.EMBED_MODE = 'fixture';
        forbidOllama();
        const file = embedFixtureFile();
        const backup = fs.readFileSync(file, 'utf8');
        try {
            const table = JSON.parse(backup);
            delete table[OWNER_MISS_SHA];
            fs.writeFileSync(file, JSON.stringify(table) + '\n', 'utf8');
            const res = await runOnce();
            assert.equal(res.rate, null);
            assert.ok(res.failures.some(f => f.startsWith('dedup1 取不到變式題的向量（EMBED_MODE=fixture）') && f.includes(OWNER_MISS_SHA)),
                res.failures.join('\n'));
            assert.ok(res.warnings.some(w => w.includes('EMBED_MODE=record')), '警告仍要指出錄製時兩個 record 必須一起開（裁決 S3-20）');
        } finally {
            fs.writeFileSync(file, backup, 'utf8');
        }
    });

    test('錄製時 dedup1 的向量呼叫失敗：算 n/a 並照實說是 EMBED_MODE=record 的呼叫失敗，不說成「fixture 查不到」', async () => {
        process.env.LLM_MODE = 'replay';
        process.env.EMBED_MODE = 'record';
        let n = 0;
        ollama._setTransportForTest(async (url, payload) => {
            if (!url.endsWith('/api/embed')) throw new Error(`回放模式不得呼叫 /api/chat：${url}`);
            n += 1;
            // 跑題檢查（兩段一起送）照常；dedup1（一段）模擬 Ollama 掛掉
            if (payload.input.length === 1) return { status: 500, text: JSON.stringify({ error: 'model crashed' }) };
            return { status: 200, text: JSON.stringify({ embeddings: payload.input.map(t => fakeVector(t, payload.dimensions)) }) };
        });
        const res = await runOnce();
        assert.ok(n > 0);
        assert.equal(res.rate, null);
        const bad = res.failures.filter(f => f.startsWith('dedup1 取不到變式題的向量（EMBED_MODE=record）'));
        assert.equal(bad.length, 2, res.failures.join('\n'));
        assert.ok(res.warnings.some(w => w.includes('EMBED_MODE=record') && w.includes('呼叫失敗')), res.warnings.join('\n'));
        assert.ok(!res.warnings.some(w => w.includes('在 embedding fixture 查不到')), res.warnings.join('\n'));
    });
});
