// services/llm/index.js — LLM 與 embedding 的唯一出入口（docs/interfaces-stage1.md 第 4 條）
//
//   embed({ model, texts, dim })
//     → { vectors: number[][], usage: { tokenIn } }      vectors[i] 對應 texts[i]，已 L2 正規化
//   generateJson({ model, system, parts, schema, maxOutputTokens, signal })
//     → { data, usage: { tokenIn, tokenOut, tokenThinking, tokenCached }, latencyMs, raw }
//
// 模式旗標（.env）：
//   EMBED_MODE = live | record | fixture      CI 恆為 fixture
//   LLM_MODE   = live | record | replay       CI 恆為 replay
//
// 階段 1 只要求 embed() 可用；generateJson() 留簽名與 gemini 骨架，階段 2 才接上五個 sub-agent。
//
// 階段 5（WS-E，docs/interfaces-stage5.md 第 5.1 條）新增：
//   generateText({ model, system, parts, tools:{codeExecution?}, maxOutputTokens, thinkingBudget, signal,
//                  agent, template, cacheKeyParts })
//     → { text, codeRuns: [{ language, code, outcome, output }], finishReason, usage, latencyMs }
//   record／replay 規則與 generateJson 相同（同一條鍵公式，schema 欄恆為空）；
//   cassette 存 { text, codeRuns, finishReason, usage }（finishReason 不在鍵內；舊 cassette 沒有這欄時回放為 null）。
//   generateJson 的行為與簽名一個字都沒改。
//
// 〔本機模式 L1，docs/local-mode.md 第 3 條第 5 點〕新增 ollama 供應商（services/llm/ollama.js）：
//   - generateJson／generateText 依 vendor 分派：gemini → gemini.js、ollama → ollama.js、其他照舊丟錯
//   - embed 依 EMBED_MODEL 分派：有 vendor 前綴才走該供應商；沒有前綴的舊值（gemini-embedding-001）一律是 Gemini；
//     未設時是本機預設 ollama:qwen3-embedding:0.6b（config/models.js 的 EMBED_MODEL getter）
//   - record／replay 分支、cassette 鍵、meta 一律不變（modelId 就是 qwen3:8b 這種裸 ID）
//   - Gemini 路徑送出的內容逐位元不變：分派前後呼叫 gemini.js 的參數與之前完全相同
//   - 模組載入時檢查一次 OLLAMA_HOST（非本機就警告；伺服器與 worker 啟動時都會載入本檔）
//
// 〔看圖拆題逾時〕ollama adapter 的 usage 可能多一個 timing（載入／讀 prompt／輸出的毫秒數）；
// record 模式照樣把 usage 原樣寫進 cassette 的 response.usage（鍵不含 usage，不受影響），npm run perf:local 讀它。
// replay（fake.js）只回四個 token 欄位，所以回放結果與之前相同。
//
// 〔dec/local-thinking-speed〕vendor 是 ollama 時套用本機的可選調整（services/llm/localTuning.js；docs/local-mode.md 第 10.14 條）：
// OLLAMA_NO_THINK（這些 agent 不思考）、OLLAMA_MAX_OUTPUT_<AGENT>（輸出上限只降不升）、OLLAMA_NUM_CTX_<AGENT>。
// 都沒寫＝轉交給 adapter 的參數與之前逐位元相同；Gemini 路徑與 replay 一個字都不讀。
// 三者都不在 cassette 的鍵裡；record 時有套用才在 request.ollamaOverrides 記下實際送出的值（沒套用就沒有這個欄位）。
// 〔審查 dec/r10-variant-cap〕generateJson 呼叫 Ollama 失敗時，錯誤物件另帶 appliedNumPredict（這一次實際送出的 num_predict，
// 沒送＝null；replay 與 Gemini 不帶），runner 記截斷事件的輸出上限用（markAppliedNumPredict）。
// 〔審查修正〕模組載入時（live／record）印一行生效的本機調整，寫錯的名稱另外警告（localTuning.announceOverrides）。
// 〔dec/latex-escape-repair〕generateJson 在「解析完模型的 JSON 之後、交給 agent 之前」多一步：
// 把被 JSON 跳脫吃掉的 LaTeX 反斜線補回去（\frac 的 \f 被 JSON.parse 當成換頁字元，留下「換頁＋rac」），
// 規則見 services/llm/latexEscapeRepair.js 與 docs/llm.md 第 10 節。live／record／replay 三條路、Ollama 與 Gemini 都套用；
// record 寫進 cassette 的是**模型的原始回應**（未修），cassette 的鍵一個字都沒動，回放時照樣修。
// 有修到或有救不回來的時候，回傳物件多一個 latexRepair 摘要；什麼都沒碰時回傳物件與之前逐位元相同。
// generateText 不經 JSON.parse，不受這個問題影響，不套用。
//
// 〔dec/r9-record-tooling〕重錄工具補強（docs/local-mode.md 10.23）。兩件事都只動 record 這一條路，
// replay、live、cassette 的鍵（cassetteKey 的算法、模板、schema、prompt、cacheKeyParts）一個字都沒改：
//   1. 只補錄缺的：LLM_MODE=record 再加 LLM_RECORD_ONLY_MISSING=1（或 true）——回放檔已經在（含錯誤回放檔）就走 replay 的
//      同一條路回傳（services/llm/fake.js，含 latexEscapeRepair），不呼叫模型、不覆寫；不在才 live 呼叫並寫入。
//      向量同理：EMBED_MODE=record 再加 EMBED_RECORD_ONLY_MISSING=1——向量檔已有的那幾段照 fixture 回傳，
//      只把缺的送去算（「有沒有」與 eval/record_embeddings.js --only-missing 同一個判斷：sha256(文字) 在不在向量檔裡）。
//      沒寫這兩個變數＝與之前逐位元相同（record 把每一次呼叫都重新 live 呼叫並覆寫）。
//   2. 錯誤回放檔：record（兩種方式都算）時 live 呼叫被截斷（finishReason MAX_TOKENS）或單次逾時（ollama 的 OLLAMA_TIMEOUT_MS），
//      照樣寫一支回放檔記下錯誤，再把原本的錯丟出去（錯誤物件多帶 errorCassette／cassetteKey）。
//      判斷準則與存哪些欄位見 services/llm/cassette.js 的 errorCassetteKind／errorResponse；環境錯誤不錄。

const DEFAULT_DIM = 768;

/**
 * 〔dec/local-thinking-speed〕要交給 adapter 的參數：只有 ollama 而且這次真的有調整時才換掉那幾個欄位。
 * @returns {{callOpts:object, overrides:object|null}}
 */
function adapterOpts(vendor, id, opts) {
    if (vendor !== 'ollama') return { callOpts: { ...opts, model: id }, overrides: null };
    const tuning = require('./localTuning');
    const tuned = tuning.resolveOllamaOverrides(opts);
    // 〔dec/r13-extract-fixes〕lint／verify 的單次逾時（本機預設 30 分；OLLAMA_TIMEOUT_MS_<AGENT> 可覆寫）。呼叫端自己帶了
    // timeoutMs（本機量測工具）時以呼叫端為準。逾時不改模型的輸出：不寫進 overrides（回放檔的 request.ollamaOverrides），鍵也不變。
    const timeout = opts && opts.timeoutMs ? null : tuning.resolveTimeout(opts && opts.agent);
    const withTimeout = (o) => (timeout ? { ...o, timeoutMs: timeout.timeoutMs, timeoutName: timeout.name } : o);
    if (!Object.keys(tuned.applied).length) return { callOpts: withTimeout({ ...opts, model: id }), overrides: null };
    const callOpts = { ...opts, model: id, thinkingBudget: tuned.thinkingBudget, maxOutputTokens: tuned.maxOutputTokens };
    if (tuned.numCtx) callOpts.numCtx = tuned.numCtx;
    return { callOpts: withTimeout(callOpts), overrides: tuned.applied };
}

/**
 * 〔審查 dec/r10-variant-cap〕generateJson 在 live／record 呼叫 Ollama 失敗時，把**這一次實際送出的** num_predict
 * 掛在錯誤物件的 appliedNumPredict（沒送＝null；services/llm/ollama.js 的 chatBody 只在 maxOutputTokens 有值時才送）。
 * runner 記「被截斷時的輸出上限」讀這個值（workers/jobRunner.js 的 runGenerateOne），不再依事件當下的 env 重算。
 * replay（與「只補缺的」照回放的那條路）沒有送出任何請求，錯誤物件不帶這個鍵；Gemini 也不帶。
 * 不寫進回放檔（services/llm/cassette.js 的 errorResponse 只取固定幾欄），cassette 的鍵與內容都不變。凍結的錯誤物件不標。
 * @param {Error} err
 * @param {{maxOutputTokens?:number}} callOpts  交給 adapter 的參數（adapterOpts 的 callOpts）
 */
function markAppliedNumPredict(err, callOpts) {
    if (!err || typeof err !== 'object') return;
    const n = Number(callOpts && callOpts.maxOutputTokens);
    try {
        err.appliedNumPredict = Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) { /* 凍結的錯誤物件：不標 */ }
}

// 啟動檢查（第 2 條 OLLAMA_HOST：只允許 localhost／127.0.0.1／::1，其他主機名啟動時警告）
require('./ollama').warnIfRemoteHost();
// 〔審查修正 dec/local-thinking-speed-fix〕live／record 時印出生效的本機調整（OLLAMA_NO_THINK 等），名稱寫錯時警告；
// 什麼都沒寫或 replay 時不印（services/llm/localTuning.js 的 announceOverrides）
require('./localTuning').announceOverrides();

/**
 * 依 vendor 取 adapter（generateJson／generateText 用）。
 * @param {string} vendor
 * @returns {object}
 */
function adapterFor(vendor) {
    if (vendor === 'gemini') return require('./gemini');
    if (vendor === 'ollama') return require('./ollama');
    throw new Error(`services/llm：目前只有 gemini 與 ollama adapter，收到 vendor=「${vendor}」（anthropic／openai 留給 A-T17）。`);
}

/**
 * 這個模型支援哪些輸入與工具（本機模式第 3 條第 9、10 點：語音與家教據此決定要不要開）。
 * 只看 vendor：gemini adapter 支援 code execution、音訊與 PDF；ollama 三者都不支援。
 * @param {string} spec 'vendor:id' 或裸 ID（裸 ID 視為 gemini，同 parseModel）
 * @returns {{vendor:string, codeExecution:boolean, audioInput:boolean, pdfInput:boolean}}
 * @throws  spec 無法解析時（同 parseModel）
 */
function capabilitiesOf(spec) {
    const { vendor } = require('../../config/models').parseModel(spec);
    const cloud = vendor === 'gemini';
    return { vendor, codeExecution: cloud, audioInput: cloud, pdfInput: cloud };
}

/** 讀取模式；未設定時走最安全的那一個（不會產生費用、不需金鑰） */
function embedMode() {
    const m = String(process.env.EMBED_MODE || 'fixture').toLowerCase();
    if (m !== 'live' && m !== 'record' && m !== 'fixture') {
        throw new Error(`EMBED_MODE 只能是 live / record / fixture，收到「${process.env.EMBED_MODE}」。`);
    }
    return m;
}

function llmMode() {
    const m = String(process.env.LLM_MODE || 'replay').toLowerCase();
    if (m !== 'live' && m !== 'record' && m !== 'replay') {
        throw new Error(`LLM_MODE 只能是 live / record / replay，收到「${process.env.LLM_MODE}」。`);
    }
    return m;
}

/**
 * 〔dec/r9-record-tooling〕LLM_MODE=record 時只補錄缺的（檔頭第 1 點）。只認 1／true（config/features.js 的 parseBool）；
 * 其他模式不讀。
 * @param {object} [env]
 * @returns {boolean}
 */
function llmRecordOnlyMissing(env = process.env) {
    return require('../../config/features').parseBool(env.LLM_RECORD_ONLY_MISSING);
}

/**
 * 〔dec/r9-record-tooling〕EMBED_MODE=record 時只補錄向量檔裡缺的（檔頭第 1 點）。
 * @param {object} [env]
 * @returns {boolean}
 */
function embedRecordOnlyMissing(env = process.env) {
    return require('../../config/features').parseBool(env.EMBED_RECORD_ONLY_MISSING);
}

/**
 * 〔dec/r9-record-tooling〕只補錄缺的：這一次呼叫的回放檔在不在（錯誤回放檔也算「在」）。
 * 鍵與 replay／record 同一條公式（services/llm/cassette.js 的 cassetteKey；agent 沒給時照舊丟錯）。
 * @returns {{key:string, file:string}|null}
 */
function existingCassette(opts, id, schema) {
    const cassette = require('./cassette');
    const key = cassette.cassetteKey({
        agent: opts.agent, modelId: id, template: opts.template, schema, cacheKeyParts: opts.cacheKeyParts
    });
    const file = cassette.cassettePath(opts.agent, key);
    return require('fs').existsSync(file) ? { key, file } : null;
}

/**
 * 〔dec/r9-record-tooling〕record 時 live 呼叫丟錯：被截斷或單次逾時就寫一支錯誤回放檔（其餘不錄），
 * 並在錯誤物件上標記 errorCassette／cassetteKey。一律由呼叫端把原本的錯丟出去。
 * @param {{err:Error, opts:object, id:string, vendor:string, overrides:object|null, schema?:object, text:boolean, startedAt:number}} o
 */
function recordErrorCassette({ err, opts, id, vendor, overrides, schema, text, startedAt }) {
    const cassette = require('./cassette');
    const kind = cassette.errorCassetteKind(err, { signal: opts.signal, vendor });
    if (!kind) {
        console.log(`[llm:record] 呼叫失敗（${(err && err.errorClass) || '未分類'}），不錄回放檔：只有「被截斷」與「單次逾時」會錄成錯誤回放檔（docs/local-mode.md 10.23）`);
        return;
    }
    let key;
    try {
        key = cassette.cassetteKey({ agent: opts.agent, modelId: id, template: opts.template, schema, cacheKeyParts: opts.cacheKeyParts });
    } catch (_) {
        return;   // agent 沒給：record 本來就要 agent，原本的錯照樣往上丟
    }
    // 〔審查 dec/r9-record-tooling〕完整重錄時，原本正常的回放檔這一次被截斷或逾時就會被錯誤回放檔蓋掉：先記下原本是什麼，寫完印醒目警告
    let before = null;
    try {
        before = cassette.readCassette(opts.agent, key);
    } catch (_) {
        before = null;   // 原本的檔壞了（不是合法 JSON）：照舊覆寫，不另外警告
    }
    const replacedNormal = Boolean(before) && !cassette.isErrorCassette(before);
    let written;
    try {
        written = cassette.writeCassette({
            agent: opts.agent,
            key,
            // meta、request 與一般回放檔逐欄相同（kind:'text' 只有 generateText 才有）
            meta: {
                agent: opts.agent,
                model: id,
                template: opts.template ?? null,
                ...(text ? { kind: 'text' } : {}),
                recorded_at: new Date().toISOString(),
                fixtureHash: cassette.fixtureHash()
            },
            request: {
                parts: cassette.summarizeParts(opts.parts),
                ...(text ? { tools: { codeExecution: !!(opts.tools && opts.tools.codeExecution) } } : {}),
                cacheKeyParts: opts.cacheKeyParts ?? {},
                ...(overrides ? { ollamaOverrides: overrides } : {})
            },
            response: cassette.errorResponse(err, kind, { elapsedMs: Date.now() - startedAt })
        });
    } catch (writeErr) {
        // 寫檔失敗（磁碟滿、權限）不能蓋掉原本的錯：印出來，原本的錯照樣往上丟
        console.warn(`[llm:record] 錯誤回放檔寫不進去（${writeErr.message}）；原本的錯照樣往上丟`);
        return;
    }
    const { file, overwritten } = written;
    cassette.noteErrorCassette({
        agent: opts.agent, key, kind, errorClass: err.errorClass ?? null, finishReason: err.finishReason ?? null, source: 'record'
    });
    try {
        err.errorCassette = { agent: opts.agent, key, kind };
        err.cassetteKey = key;
    } catch (_) { /* 凍結的錯誤物件：不標也不影響回放檔 */ }
    const what = kind === 'timeout' ? '單次逾時' : '被截斷';
    console.log(`[llm:record] ${overwritten ? '覆寫' : '寫入'}錯誤回放檔（${what}）→ ${file}`);
    if (replacedNormal) console.warn(replacedNormalWarning({ agent: opts.agent, key, what, file }));
}

/**
 * 〔審查 dec/r9-record-tooling〕錯誤回放檔蓋掉「正常回放檔」時的警告（一行，醒目）。
 * 以前這種情況（錄製失敗）會保留舊檔；現在照實錄下這一次的結果，所以要讓 Owner 看得到、決定要不要還原。
 * @param {{agent:string, key:string, what:string, file:string}} o
 * @returns {string}
 */
function replacedNormalWarning({ agent, key, what, file }) {
    return `⚠️ [llm:record] 注意：原本是正常回放檔，這次${what}，已覆寫成錯誤回放檔（agent=${agent} key=${key.slice(0, 12)}…）→ ${file}。` +
        '若錄製期間電腦睡眠、Ollama 卡住或被關掉，這不是模型的結果：用 git checkout -- <上面的檔> 還原舊檔（docs/local-mode.md 10.23 第 5 點第 4 步）';
}

/** L2 正規化。cosine 距離與內積因此等價，pgvector 的 <=> 也才穩定 */
function l2Normalize(vec) {
    let sum = 0;
    for (const v of vec) sum += v * v;
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm === 0) {
        throw new Error('向量的 L2 範數為 0 或非有限值，無法正規化（多半代表上游回了空向量）。');
    }
    return vec.map(v => v / norm);
}

/**
 * 取得一批文本的向量。
 * @param {{model?:string, texts:string[], dim?:number, taskType?:string}} opts
 *        taskType 為選用擴充：寫入用 'RETRIEVAL_DOCUMENT'（預設），
 *        階段 3 的自然語言查詢用 'RETRIEVAL_QUERY'；fixture 模式不受影響。
 * @returns {Promise<{vectors:number[][], usage:{tokenIn:number}}>}
 */
async function embed({ model, texts, dim, taskType } = {}) {
    const useModel = model || require('../../config/models').EMBED_MODEL;
    const useDim = Number.parseInt(dim || process.env.EMBED_DIM || DEFAULT_DIM, 10);

    if (!Array.isArray(texts)) throw new Error('embed({ texts }) 的 texts 必須是字串陣列。');
    if (!Number.isInteger(useDim) || useDim <= 0) throw new Error(`EMBED_DIM 無效：${dim ?? process.env.EMBED_DIM}`);
    if (texts.length === 0) return { vectors: [], usage: { tokenIn: 0 } };

    const mode = embedMode();

    if (mode === 'fixture') {
        // fixture 檔名用 EMBED_MODEL 原字串（冒號等字元由 fixture.js 換成 '-'），不分 vendor
        const { embedFromFixture } = require('./fixture');
        const res = embedFromFixture({ model: useModel, texts, dim: useDim });
        return { vectors: res.vectors.map(l2Normalize), usage: res.usage };
    }

    // 〔dec/r9-record-tooling〕EMBED_MODE=record＋EMBED_RECORD_ONLY_MISSING=1：向量檔已有的不重算（檔頭第 1 點）
    if (mode === 'record' && embedRecordOnlyMissing()) {
        return embedRecordMissing({ model: useModel, texts, dim: useDim, taskType });
    }

    const res = await embedLive({ model: useModel, texts, dim: useDim, taskType });
    const vectors = res.vectors.map(l2Normalize);

    if (mode === 'record') {
        // 錄成 eval/fixtures/embeddings.<model>.<dim>.json，之後 CI 就只讀這個檔
        const { saveToFixture, sha256Hex } = require('./fixture');
        const entries = texts.map((text, i) => [sha256Hex(text), vectors[i]]);
        const file = saveToFixture({ model: useModel, dim: useDim, entries });
        console.log(`[embed:record] 已寫入 ${entries.length} 筆向量 → ${file}`);
    }

    return { vectors, usage: res.usage };
}

/**
 * 真的呼叫 embedding 模型（live／record）。回傳 adapter 的原樣（未正規化）。
 * 前綴規則（第 2 條）：沒有前綴＝Gemini（舊 .env 不必改）；'ollama:…' → Ollama。
 * 舊值 'gemini-embedding-001' 解析出來的 id 就是它自己，送給 gemini.embed 的參數與之前逐位元相同。
 * @returns {Promise<{vectors:number[][], usage:{tokenIn:number}}>}
 */
async function embedLive({ model, texts, dim, taskType }) {
    const { vendor, id } = require('../../config/models').parseModel(model);
    if (vendor === 'gemini') return require('./gemini').embed({ model: id, texts, dim, taskType });
    if (vendor === 'ollama') return require('./ollama').embed({ model: id, texts, dim });
    throw new Error(`services/llm：embed 目前只支援 gemini 與 ollama，收到 EMBED_MODEL=「${model}」。`);
}

/**
 * 〔dec/r9-record-tooling〕只補錄缺的向量：向量檔（eval/fixtures/embeddings.<model>.<dim>.json）已有的那幾段照 fixture 回傳
 *（與 EMBED_MODE=fixture 回放時拿到的向量相同），缺的才送去算、併入向量檔。全部都有時一次模型都不呼叫。
 * 「有沒有」的判斷與 eval/record_embeddings.js --only-missing 相同：sha256(文字) 是不是向量檔的鍵。
 * 向量檔壞掉（不是合法 JSON）照樣丟錯——壞檔要修，不能當成空表整份重錄。
 * @returns {Promise<{vectors:number[][], usage:{tokenIn:number}}>}
 */
async function embedRecordMissing({ model, texts, dim, taskType }) {
    const fs = require('fs');
    const fixture = require('./fixture');
    const file = fixture.fixturePath(model, dim);
    let table = {};
    if (fs.existsSync(file)) {
        try {
            table = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            throw new Error(`embedding fixture 格式錯誤（應為 {"<sha256>": [數字…]}），不能只補缺的：${file}\n${err.message}`);
        }
    }
    const has = (text) => Object.prototype.hasOwnProperty.call(table, fixture.sha256Hex(text));
    const present = [];
    const missing = [];
    texts.forEach((text, i) => (has(text) ? present : missing).push(i));

    const vectors = new Array(texts.length);
    if (present.length) {
        const r = fixture.embedFromFixture({ model, texts: present.map(i => texts[i]), dim });
        present.forEach((i, k) => { vectors[i] = l2Normalize(r.vectors[k]); });
    }
    if (!missing.length) return { vectors, usage: { tokenIn: 0 } };

    const res = await embedLive({ model, texts: missing.map(i => texts[i]), dim, taskType });
    const fresh = res.vectors.map(l2Normalize);
    missing.forEach((i, k) => { vectors[i] = fresh[k]; });
    const saved = fixture.saveToFixture({ model, dim, entries: missing.map((i, k) => [fixture.sha256Hex(texts[i]), fresh[k]]) });
    console.log(`[embed:record] 只補缺的：寫入 ${missing.length} 筆向量（另 ${present.length} 筆向量檔已有，不重算）→ ${saved}`);
    return { vectors, usage: res.usage };
}

/**
 * 受限 JSON 生成（docs/interfaces-stage2.md 第 5.1 條）。
 *
 * 三個模式：
 *   live   —— 真的呼叫供應商，不留 cassette
 *   record —— 真的呼叫，把回應寫成 cassette（同鍵覆寫並印一行 log）
 *             〔dec/r9-record-tooling〕LLM_RECORD_ONLY_MISSING=1 時回放檔已在就照 replay 回傳、不呼叫；
 *             被截斷或單次逾時時寫錯誤回放檔再丟出原本的錯（檔頭）
 *   replay —— 只讀 cassette；miss 一律丟錯（訊息逐字凍結於第 5.2 條），CI 恆為這個模式
 *
 * @param {{model?:string, system?:string, parts:Array<object>, schema?:object,
 *          maxOutputTokens?:number, thinkingBudget?:number, signal?:AbortSignal,
 *          agent?:string, cacheKeyParts?:object, template?:string}} opts
 *        agent／cacheKeyParts／template 是階段 2 新增的三個選用欄位；
 *        record／replay 模式下 **agent 必填**（它是 cassette 的第一段鍵與子目錄名）。
 * @returns {Promise<{data:object, usage:{tokenIn,tokenOut,tokenThinking,tokenCached},
 *                    latencyMs:number, raw:any, latexRepair?:{repaired:number, commands:object, unresolved:Array}}>}
 *          data 已補回被 JSON 吃掉的 LaTeX 反斜線；latexRepair 只在有修到或有救不回來的時候才有（見檔頭）
 */
async function generateJson(opts = {}) {
    const mode = llmMode();
    const { parseModel } = require('../../config/models');
    const models = require('../../config/models');
    const { vendor, id } = parseModel(opts.model || models.MODEL_EXTRACT);
    // 〔dec/latex-escape-repair〕解析完 JSON、交給 agent 之前補回被吃掉的反斜線（見檔頭）
    const { applyToResult: repairLatex } = require('./latexEscapeRepair');

    if (mode === 'replay') {
        const fake = require('./fake');
        // vendor 只用來決定 miss 訊息指向哪一種重錄（〔dec/r8-b1-abandon〕）；cassette 的鍵照舊只看裸模型 ID
        return repairLatex(fake.generateJson({ ...opts, model: id, vendor }));
    }

    // 〔dec/r9-record-tooling〕只補錄缺的：回放檔在（含錯誤回放檔）就走 replay 的同一條路，不呼叫模型、不覆寫
    if (mode === 'record' && llmRecordOnlyMissing()) {
        const hit = existingCassette(opts, id, opts.schema);
        if (hit) {
            console.log(`[llm:record] 只補缺的：已有回放檔，照回放、不呼叫模型（agent=${opts.agent} key=${hit.key.slice(0, 12)}…）`);
            return repairLatex(require('./fake').generateJson({ ...opts, model: id, vendor }));
        }
    }

    const { callOpts, overrides } = adapterOpts(vendor, id, opts);
    const startedAt = Date.now();
    let res;
    try {
        res = await adapterFor(vendor).generateJson(callOpts);
    } catch (err) {
        // 〔審查 dec/r10-variant-cap〕本機呼叫失敗時，錯誤物件帶上這一次實際送出的 num_predict（見 markAppliedNumPredict）
        if (vendor === 'ollama') markAppliedNumPredict(err, callOpts);
        // 〔dec/r9-record-tooling〕被截斷／單次逾時錄成錯誤回放檔（環境錯誤不錄），原本的錯照樣丟出去
        if (mode === 'record') recordErrorCassette({ err, opts, id, vendor, overrides, schema: opts.schema, text: false, startedAt });
        throw err;
    }

    if (mode === 'record') {
        const cassette = require('./cassette');
        const key = cassette.cassetteKey({
            agent: opts.agent, modelId: id, template: opts.template,
            schema: opts.schema, cacheKeyParts: opts.cacheKeyParts
        });
        const { file, overwritten } = cassette.writeCassette({
            agent: opts.agent,
            key,
            meta: {
                agent: opts.agent,
                model: id,
                template: opts.template ?? null,
                recorded_at: new Date().toISOString(),
                fixtureHash: cassette.fixtureHash()
            },
            // 只存摘要：PDF base64 與逐字試題絕不進版控（NOTICE 第 4 條）
            request: {
                parts: cassette.summarizeParts(opts.parts),
                cacheKeyParts: opts.cacheKeyParts ?? {},
                // 〔dec/local-thinking-speed〕有套用本機調整才記（不在鍵內）
                ...(overrides ? { ollamaOverrides: overrides } : {})
            },
            // 〔dec/latex-escape-repair〕存模型的原始回應（修復前）；回放時由 repairLatex 再修一次，結果與這裡回傳的相同
            response: { data: res.data, usage: res.usage, latencyMs: res.latencyMs }
        });
        console.log(`[llm:record] ${overwritten ? '覆寫' : '寫入'} cassette → ${file}`);
    }

    return repairLatex(res);
}

/**
 * 自由文字生成，可選 code execution 驗算（docs/interfaces-stage5.md 第 5.1 條）。
 *
 * 三個模式與 generateJson 相同；replay miss 的訊息也是同一串（services/llm/fake.js）。
 * record 模式的 cassette：request 只存 parts 摘要（音訊只留位元組數與 sha256），
 * response 存 { text, codeRuns, finishReason, usage, latencyMs }（finishReason 讓回放也重現「被截斷」）。
 *
 * @param {{model?:string, system?:string, parts:Array<object>, tools?:{codeExecution?:boolean},
 *          maxOutputTokens?:number, thinkingBudget?:number, signal?:AbortSignal,
 *          agent?:string, template?:string, cacheKeyParts?:object}} opts
 *        record／replay 模式下 agent 必填（同 generateJson）。
 * @returns {Promise<{text:string, codeRuns:Array<{language:string,code:string,outcome:string|null,output:string}>,
 *                    finishReason:string|null, usage:{tokenIn,tokenOut,tokenThinking,tokenCached}, latencyMs:number}>}
 */
async function generateText(opts = {}) {
    const mode = llmMode();
    const { parseModel } = require('../../config/models');
    const models = require('../../config/models');
    const { vendor, id } = parseModel(opts.model || models.MODEL_EXTRACT);

    if (mode === 'replay') {
        const fake = require('./fake');
        return fake.generateText({ ...opts, model: id, vendor });
    }

    // 〔dec/r9-record-tooling〕只補錄缺的（同 generateJson；schema 欄恆為空）
    if (mode === 'record' && llmRecordOnlyMissing()) {
        const hit = existingCassette(opts, id, undefined);
        if (hit) {
            console.log(`[llm:record] 只補缺的：已有回放檔，照回放、不呼叫模型（agent=${opts.agent} key=${hit.key.slice(0, 12)}…）`);
            return require('./fake').generateText({ ...opts, model: id, vendor });
        }
    }

    const { callOpts, overrides } = adapterOpts(vendor, id, opts);
    const startedAt = Date.now();
    let res;
    try {
        res = await adapterFor(vendor).generateText(callOpts);
    } catch (err) {
        // 〔dec/r9-record-tooling〕單次逾時錄成錯誤回放檔（generateText 被截斷不丟錯，照一般回放檔錄 finishReason）
        if (mode === 'record') recordErrorCassette({ err, opts, id, vendor, overrides, schema: undefined, text: true, startedAt });
        throw err;
    }

    if (mode === 'record') {
        const cassette = require('./cassette');
        const key = cassette.cassetteKey({
            agent: opts.agent, modelId: id, template: opts.template,
            schema: undefined, cacheKeyParts: opts.cacheKeyParts
        });
        const { file, overwritten } = cassette.writeCassette({
            agent: opts.agent,
            key,
            meta: {
                agent: opts.agent,
                model: id,
                template: opts.template ?? null,
                kind: 'text',
                recorded_at: new Date().toISOString(),
                fixtureHash: cassette.fixtureHash()
            },
            request: {
                parts: cassette.summarizeParts(opts.parts),
                tools: { codeExecution: !!(opts.tools && opts.tools.codeExecution) },
                cacheKeyParts: opts.cacheKeyParts ?? {},
                ...(overrides ? { ollamaOverrides: overrides } : {})
            },
            response: {
                text: res.text, codeRuns: res.codeRuns, finishReason: res.finishReason ?? null,
                usage: res.usage, latencyMs: res.latencyMs
            }
        });
        console.log(`[llm:record] ${overwritten ? '覆寫' : '寫入'} cassette → ${file}`);
    }

    return res;
}

module.exports = {
    embed, generateJson, generateText, l2Normalize, embedMode, llmMode, capabilitiesOf,
    llmRecordOnlyMissing, embedRecordOnlyMissing,   // 〔dec/r9-record-tooling〕
    replacedNormalWarning                            // 〔審查 dec/r9-record-tooling〕
};
