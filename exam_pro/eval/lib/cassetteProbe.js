// ─────────────────────────────────────────────────────────────
// eval/lib/cassetteProbe.js — 回放探針：記下「哪一支 cassette／哪一筆向量被查過、有沒有查到」
//
// 給 eval/tools/rerecord_all.js（--dry-run）與 eval/tools/prune_cassettes.js 用
// （docs/chapter-restructure.md 第 3.2 條第 2、3 點）。兩支工具都要回答同一個問題：
// **以 CI 的設定回放全部 suite 時，實際讀了哪些 cassette、哪些讀不到**。
//
// 做法：工具以 `node --require eval/lib/cassetteProbe.js …` 啟動各 suite 的**既有入口**
// （eval/run.js、node --test test/e2e），本檔在行程啟動時包住兩個查表點：
//   services/llm/fake.js      generateJson／generateText（LLM_MODE=replay 的唯一出入口）
//   services/llm/fixture.js   embedFromFixture（EMBED_MODE=fixture 的唯一出入口）
//   eval/lib/embeddings.js    loadEmbeddings（retrieval／variant 直接讀向量檔的那條路）
//   services/ocr/index.js     ocrPdf（〔本機模式 L4〕本機 OCR 的 cassette；檔案不存在就不包）
// 被包住的函式**行為一個字都沒變**（回傳值、丟的錯、訊息都原樣），只是多寫一行紀錄。
// 不另造回放機制：miss 仍是 fake.js 的凍結訊息，判斷仍走 eval/lib/replayMiss.js。
//
// 只有設了 EVAL_PROBE_DIR 才會包；一般 require（工具讀紀錄）不會動任何東西。
// 每個行程寫自己的 <EVAL_PROBE_DIR>/<pid>.jsonl：node --test 會為每個測試檔另開子行程
//（--require 會跟著傳下去），各寫各的檔就不必處理多行程同時 append 的交錯。
//
// 紀錄只留在工具建立的暫存目錄（不進版控）；cacheKeyParts 可能含題幹，所以同樣不得寫進 repo。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');

/** 行程啟動時設好的紀錄檔；沒設 EVAL_PROBE_DIR 時為 null */
let logFile = null;

/**
 * 寫一行紀錄（同步 append：行程被 process.exit() 收掉時也不會掉資料）。
 * @param {object} event
 */
function record(event) {
    if (!logFile) return;
    const line = JSON.stringify({ suite: process.env.EVAL_PROBE_SUITE || null, pid: process.pid, ...event });
    fs.appendFileSync(logFile, line + '\n', 'utf8');
}

/**
 * 讀一個探針目錄底下的全部紀錄。
 * @param {string} dir EVAL_PROBE_DIR
 * @returns {Array<object>} 事件（依檔名、行序）；壞行略過並回報在 { kind:'corrupt' } 事件裡
 */
function readProbeDir(dir) {
    if (!dir || !fs.existsSync(dir)) return [];
    const events = [];
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
        const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                events.push(JSON.parse(line));
            } catch (err) {
                events.push({ kind: 'corrupt', file: name, line: line.slice(0, 80) });
            }
        }
    }
    return events;
}

/**
 * 包住 services/llm/fake.js 的兩個回放函式。
 * @param {object} fake require('services/llm/fake') 的匯出物件（就地替換屬性）
 */
function wrapFake(fake) {
    const { isReplayMiss, parseReplayMiss } = require('./replayMiss');
    for (const method of ['generateJson', 'generateText']) {
        const original = fake[method];
        if (typeof original !== 'function' || original.__probed) continue;
        const probed = function probedReplay(opts = {}) {
            const base = {
                kind: 'llm',
                method,
                agent: opts.agent ?? null,
                model: opts.model ?? null,
                template: opts.template ?? null
            };
            let res;
            try {
                res = original.call(this, opts);
            } catch (err) {
                if (isReplayMiss(err)) {
                    const { key } = parseReplayMiss(err);
                    // cacheKeyParts 只為了讓工具找出「同一呼叫的舊版 cassette」估費用；只寫暫存目錄
                    record({ ...base, key, hit: false, cacheKeyParts: opts.cacheKeyParts ?? {} });
                } else {
                    record({ ...base, key: null, hit: false, error: String(err && err.message).split('\n')[0] });
                }
                throw err;
            }
            record({ ...base, key: res && res.cassetteKey ? res.cassetteKey : null, hit: true });
            return res;
        };
        probed.__probed = true;
        fake[method] = probed;
    }
}

/**
 * 包住 services/llm/fixture.js 的 embedFromFixture：逐段文字記下 sha256 與有沒有查到。
 * @param {object} fixture require('services/llm/fixture') 的匯出物件
 */
function wrapFixtureEmbed(fixture) {
    const original = fixture.embedFromFixture;
    if (typeof original !== 'function' || original.__probed) return;
    const tables = new Map();   // 檔案 → { mtimeMs, keys:Set }
    const keysOf = (file) => {
        let stat;
        try { stat = fs.statSync(file); } catch (err) { return null; }
        const hit = tables.get(file);
        if (hit && hit.mtimeMs === stat.mtimeMs) return hit.keys;
        let keys;
        try { keys = new Set(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch (err) { return null; }
        tables.set(file, { mtimeMs: stat.mtimeMs, keys });
        return keys;
    };
    const probed = function probedEmbed(opts = {}) {
        const file = fixture.fixturePath(opts.model, opts.dim);
        const keys = keysOf(file);
        for (const text of opts.texts || []) {
            const hash = fixture.sha256Hex(text);
            record({ kind: 'embed', via: 'services/llm/fixture.js', hash, hit: !!(keys && keys.has(hash)), chars: String(text).length });
        }
        return original.call(this, opts);
    };
    probed.__probed = true;
    fixture.embedFromFixture = probed;
}

/**
 * 包住 eval/lib/embeddings.js 的 loadEmbeddings：fixture 題的向量在不在。
 * @param {object} embeddings require('eval/lib/embeddings') 的匯出物件
 */
function wrapLoadEmbeddings(embeddings) {
    const original = embeddings.loadEmbeddings;
    if (typeof original !== 'function' || original.__probed) return;
    const { buildEmbedText, embedHash } = require('./embedText');
    const probed = function probedLoadEmbeddings(opts = {}) {
        const res = original.call(this, opts);
        if (res && res.available) {
            const missing = new Set(res.missing || []);
            for (const q of opts.questions || []) {
                const text = buildEmbedText(q);
                record({
                    kind: 'embed', via: 'eval/lib/embeddings.js', hash: embedHash(text),
                    hit: !missing.has(q.id), chars: text.length, questionId: q.id
                });
            }
        } else if (res) {
            record({ kind: 'embed-file-missing', via: 'eval/lib/embeddings.js', file: res.file });
        }
        return res;
    };
    probed.__probed = true;
    embeddings.loadEmbeddings = probed;
}

/**
 * 〔本機模式 L4〕包住 services/ocr 的 ocrPdf（docs/local-mode.md 第 4 條第 2 點）。
 *
 * OCR 的回放不經 fake.js（它讀的是 agent＝ocr 的 cassette），所以另外包；miss 的訊息與 LLM 同一種格式
 * （契約明訂），照樣用 replayMiss 撈 agent 與 key。命中時的鍵：
 *   1. 回傳帶 cassetteKey（與 fake.js 的回傳同一個慣例）就用它；
 *   2. 否則照契約的公式算一次：cassetteKey({agent:'ocr', modelId:'paddleocr@<engineVersion>', template:'ocr.v1',
 *      cacheKeyParts:{pdfSha256, fromPage, toPage, dpi}})，而且那支檔案真的存在才算數；
 *   3. 兩者都不成立就記成「miss 以外的錯誤」——cassettes:prune 會因此拒絕刪除，
 *      寧可不清，也不要把 CI 讀得到的 OCR cassette 當成過期刪掉。
 * 被包住的函式行為不變（回傳值、丟的錯原樣）。
 *
 * @param {object} ocr require('services/ocr') 的匯出物件（就地替換 ocrPdf）
 * @param {{record?:Function, exists?:(agent:string, key:string)=>boolean, env?:object}} [opts] 測試注入點
 */
function wrapOcr(ocr, opts = {}) {
    const original = ocr && ocr.ocrPdf;
    if (typeof original !== 'function' || original.__probed) return;
    const rec = opts.record || record;
    const env = opts.env || process.env;
    const { cassetteKey, cassettePath } = require(path.join(APP_DIR, 'services', 'llm', 'cassette.js'));
    const exists = opts.exists || ((agent, key) => fs.existsSync(cassettePath(agent, key)));
    const { isReplayMiss, parseReplayMiss } = require('./replayMiss');
    const probed = async function probedOcrPdf(args = {}) {
        const cacheKeyParts = {
            pdfSha256: args.pdfSha256 == null ? null : args.pdfSha256,
            fromPage: args.fromPage == null ? null : args.fromPage,
            toPage: args.toPage == null ? null : args.toPage,
            dpi: Number(env.OCR_DPI) || 200
        };
        const base = { kind: 'llm', method: 'ocrPdf', agent: 'ocr', template: 'ocr.v1' };
        let res;
        try {
            res = await original.call(this, args);
        } catch (err) {
            if (isReplayMiss(err)) {
                const { key } = parseReplayMiss(err);
                rec({ ...base, model: null, key, hit: false, cacheKeyParts });
            } else {
                rec({ ...base, model: null, key: null, hit: false, error: String(err && err.message).split('\n')[0] });
            }
            throw err;
        }
        const model = res && res.engineVersion ? `paddleocr@${res.engineVersion}` : null;
        let key = res && res.cassetteKey ? res.cassetteKey : null;
        if (!key && model) {
            const computed = cassetteKey({ agent: 'ocr', modelId: model, template: 'ocr.v1', cacheKeyParts });
            if (exists('ocr', computed)) key = computed;
        }
        if (key) rec({ ...base, model, key, hit: true });
        else rec({ ...base, model, key: null, hit: true, error: 'OCR 回放命中，但算不出是哪一支 cassette（services/ocr 請在回傳帶 cassetteKey）' });
        return res;
    };
    probed.__probed = true;
    ocr.ocrPdf = probed;
}

/**
 * 啟動探針（--require 時自動呼叫；測試也可以直接呼叫）。
 * @param {string} dir 紀錄目錄
 */
function install(dir) {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, `${process.pid}.jsonl`);
    wrapFake(require(path.join(APP_DIR, 'services', 'llm', 'fake.js')));
    wrapFixtureEmbed(require(path.join(APP_DIR, 'services', 'llm', 'fixture.js')));
    wrapLoadEmbeddings(require(path.join(APP_DIR, 'eval', 'lib', 'embeddings.js')));
    const ocrIndex = path.join(APP_DIR, 'services', 'ocr', 'index.js');
    if (fs.existsSync(ocrIndex)) wrapOcr(require(ocrIndex));
    record({ kind: 'start', argv: process.argv.slice(1).map(a => path.basename(a)).join(' ') });
    process.on('exit', (code) => record({ kind: 'exit', code }));
}

if (process.env.EVAL_PROBE_DIR && !logFile) {
    install(path.resolve(process.env.EVAL_PROBE_DIR));
}

module.exports = { install, readProbeDir, wrapFake, wrapFixtureEmbed, wrapLoadEmbeddings, wrapOcr, PROBE_PATH: __filename };
