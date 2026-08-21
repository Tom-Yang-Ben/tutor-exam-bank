// ─────────────────────────────────────────────────────────────
// scripts/spike_genai.js — A-T0 Spike：@google/genai 的當日事實查核
//
// 目的：階段 2 的 extract／classify／verify 三個 agent 的合約，取決於三件無法從文件
//       百分百確定、且會隨模型版本變動的事實。這支腳本用「最少的真呼叫」把它們釘死，
//       結論寫進 docs/interfaces-stage2.md 第 0 條；日後換模型時重跑本檔即可重驗。
//
//   1. responseJsonSchema／responseSchema 能不能吃「66 個中文章節 enum + 5 個題型 enum
//      + additionalProperties:false」——決定 agents/schemas/*.json 要不要含 enum。
//   2. inlineData 送 PDF 的大小門檻、每頁 token 成本——決定 JOB_PDF_CHUNK_PAGES 與
//      GEMINI_INLINE_MAX_BYTES 的預設值。
//   3. 當日可用的模型 ID（Flash 系列拆題、Pro 系列驗證）與 usageMetadata 的欄位名
//      ——決定 MODEL_EXTRACT／MODEL_VERIFY 與 config/pricing.js 的計費欄位。
//
// 用法（PowerShell 沒有行內 VAR=x 語法，金鑰一律讀 .env）：
//   node scripts/spike_genai.js            全部跑（約 5 次生成呼叫 + 1 次模型列表）
//   node scripts/spike_genai.js models     只列當日可用模型（不產生 token 費用）
//   node scripts/spike_genai.js schema     只測 enum schema 的三種寫法（3 次呼叫）
//   node scripts/spike_genai.js pdf        只測 inlineData PDF（1 次呼叫）
//   node scripts/spike_genai.js inline-limit --mb=15   量 inlineData 的請求大小門檻（不含在 all）
//   node scripts/spike_genai.js verify     只測 Pro 模型與 usageMetadata（1 次呼叫）
//
// 選項：--model-extract=<id> --model-verify=<id> --out=<檔案>（把結論存成 JSON）
//
// 注意：本檔是「量測工具」不是產品程式碼，刻意直接用 @google/genai 而非 services/llm，
//       才能看到 SDK 的原始行為（services/llm 會吞掉 raw、也會被 LLM_MODE 攔截）。
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { CHAPTERS, QUESTION_TYPES } = require('../config/chapters');

const ALL_CHAPTERS = Object.values(CHAPTERS).flat();

// 預設候選 ID：真正可用的以 models 子指令的輸出為準
const DEFAULT_EXTRACT = 'gemini-2.5-flash';
const DEFAULT_VERIFY = 'gemini-2.5-pro';

const args = process.argv.slice(2);
const cmd = args.find(a => !a.startsWith('--')) || 'all';
const opt = (name, fallback) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const MODEL_EXTRACT = opt('model-extract', DEFAULT_EXTRACT);
const MODEL_VERIFY = opt('model-verify', DEFAULT_VERIFY);
const OUT = opt('out', null);

function getClient() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !apiKey.trim()) {
        throw new Error('缺少 GEMINI_API_KEY：本腳本一定會真的呼叫 Gemini，請先在 .env 填入金鑰。');
    }
    return new GoogleGenAI({ apiKey });
}

const results = { ranAt: new Date().toISOString(), sdkVersion: readSdkVersion(), node: process.version, cases: [] };

function readSdkVersion() {
    try {
        // @google/genai 的 exports 沒有開放 ./package.json，只能自己讀檔
        const p = path.resolve(__dirname, '..', 'node_modules', '@google', 'genai', 'package.json');
        return JSON.parse(fs.readFileSync(p, 'utf8')).version;
    } catch { return 'unknown'; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 503（模型忙碌）與 429（配額）在 spike 期間很常見，尤其是最新的 Flash。
 * 重試三次才判定失敗，否則量到的是「當下塞車」而不是「schema 不被接受」。
 */
async function withRetry(label, fn, max = 3) {
    for (let attempt = 1; ; attempt++) {
        try { return await fn(); }
        catch (err) {
            const msg = String(err?.message || err);
            const retryable = /\b(429|503|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand)\b/i.test(msg);
            if (!retryable || attempt >= max) throw err;
            console.log(`   ↻ ${label} 第 ${attempt} 次遇到暫時性錯誤（${msg.match(/\b(429|503)\b/)?.[0] || '?'}），${attempt * 5} 秒後重試`);
            await sleep(attempt * 5000);
        }
    }
}

function record(name, ok, detail) {
    results.cases.push({ name, ok, ...detail });
    console.log(`\n${ok ? '✅' : '❌'} ${name}`);
    for (const [k, v] of Object.entries(detail)) {
        // 注意：usageMetadata 的某些欄位（cachedContentTokenCount）在沒有快取命中時「整個鍵不存在」，
        // 不是 0——這正是本 spike 要記錄的事實之一，所以這裡不能假設值一定可字串化。
        const s = typeof v === 'string' ? v : (v === undefined ? '（未回傳此欄）' : JSON.stringify(v));
        console.log(`   ${k}: ${s.length > 600 ? s.slice(0, 600) + ' …' : s}`);
    }
}

// ───────────────────────── 1. 模型列表 ─────────────────────────

async function listModels() {
    const ai = getClient();
    const rows = [];
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    for await (const m of pager) {
        const methods = m.supportedActions || m.supportedGenerationMethods || [];
        rows.push({
            name: String(m.name || '').replace(/^models\//, ''),
            methods: Array.isArray(methods) ? methods.join(',') : String(methods),
            inputTokenLimit: m.inputTokenLimit,
            outputTokenLimit: m.outputTokenLimit
        });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));

    const gen = rows.filter(r => /generateContent/.test(r.methods) && !/embedding|aqa|imagen|veo|tts|image|live|native-audio|learnlm/i.test(r.name));
    console.log(`\n可產生內容的模型（${gen.length} 個，已濾掉 embedding／影音／TTS）：`);
    for (const r of gen) console.log(`   ${r.name}  in=${r.inputTokenLimit} out=${r.outputTokenLimit}`);

    const flash = gen.filter(r => /flash/i.test(r.name) && !/thinking|lite|preview|exp/i.test(r.name)).map(r => r.name);
    const pro = gen.filter(r => /pro/i.test(r.name) && !/vision|preview|exp/i.test(r.name)).map(r => r.name);
    record('models.list（不計生成費用）', true, {
        總數: rows.length, 可生成: gen.length,
        'Flash 穩定版候選': flash, 'Pro 穩定版候選': pro
    });
    results.models = gen;
    return gen;
}

// ───────────────────────── 2. enum schema 的三種寫法 ─────────────────────────

/**
 * extract 節點的 schema（規劃 §3.3.4 的輸出欄位）。
 * @param {{enums:boolean, strict:boolean}} o enums=章節／題型是否放 enum；strict=是否加 additionalProperties:false
 */
function buildExtractSchema({ enums, strict }) {
    const item = {
        type: 'object',
        properties: {
            idx: { type: 'integer' },
            subject: enums ? { type: 'string', enum: Object.keys(CHAPTERS) } : { type: 'string' },
            chapter: enums ? { type: 'string', enum: ALL_CHAPTERS } : { type: 'string' },
            chapter_confidence: { type: 'number' },
            question_type: enums ? { type: 'string', enum: QUESTION_TYPES } : { type: 'string' },
            difficulty: { type: 'integer' },
            question_text: { type: 'string' },
            answer_text: { type: 'string' },
            figure_desc: { type: 'string' }
        },
        required: ['idx', 'subject', 'chapter', 'chapter_confidence', 'question_type', 'difficulty', 'question_text', 'answer_text']
    };
    if (strict) item.additionalProperties = false;
    const root = {
        type: 'object',
        properties: { questions: { type: 'array', items: item } },
        required: ['questions']
    };
    if (strict) root.additionalProperties = false;
    return root;
}

const SAMPLE_STEM = [
    '請把下面這一題整理成 JSON（只有一題，idx 給 1）：',
    '',
    '3. 設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$。',
    '答案：$1$',
    '',
    'chapter 必須從 schema 的 enum 中挑一個最貼切的；difficulty 給 1~5 的整數；',
    'chapter_confidence 給 0~1 的小數；沒有附圖就不要輸出 figure_desc。'
].join('\n');

async function callWithSchema(label, { key, enums, strict, model = MODEL_EXTRACT }) {
    const ai = getClient();
    const schema = buildExtractSchema({ enums, strict });
    const config = { responseMimeType: 'application/json', [key]: schema };
    const started = Date.now();
    try {
        const res = await withRetry(label, () => ai.models.generateContent({ model, contents: [{ text: SAMPLE_STEM }], config }));
        const raw = String(res?.text ?? '').trim();
        const data = JSON.parse(raw.startsWith('```') ? raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim() : raw);
        const q = data?.questions?.[0] || {};
        record(label, true, {
            model,
            config欄位: key,
            enum: enums ? `chapter ${ALL_CHAPTERS.length} 個、question_type ${QUESTION_TYPES.length} 個` : '不含 enum',
            additionalProperties: strict ? 'false' : '未設',
            回傳章節: q.chapter,
            章節在白名單內: ALL_CHAPTERS.includes(q.chapter),
            回傳題型: q.question_type,
            題型在白名單內: QUESTION_TYPES.includes(q.question_type),
            usageMetadata: res?.usageMetadata,
            latencyMs: Date.now() - started
        });
        return { ok: true, res };
    } catch (err) {
        record(label, false, {
            model, config欄位: key,
            enum: enums ? `chapter ${ALL_CHAPTERS.length} 個` : '不含 enum',
            additionalProperties: strict ? 'false' : '未設',
            錯誤: String(err?.message || err).split('\n').slice(0, 4).join(' '),
            latencyMs: Date.now() - started
        });
        return { ok: false, err };
    }
}

async function schemaCases() {
    console.log(`\n── enum schema：chapter ${ALL_CHAPTERS.length} 個（數學 ${CHAPTERS['數學'].length} + 物理 ${CHAPTERS['物理'].length}）、question_type ${QUESTION_TYPES.length} 個 ──`);
    // 案例 1：最嚴格的一版——responseJsonSchema + 完整 enum + additionalProperties:false
    await callWithSchema('A1 responseJsonSchema + enum + additionalProperties:false', { key: 'responseJsonSchema', enums: true, strict: true });
    // 案例 2：舊寫法 responseSchema（SDK 會轉成 Google 專用的 Schema 物件）
    await callWithSchema('A2 responseSchema + enum（無 additionalProperties）', { key: 'responseSchema', enums: true, strict: false });
    // 案例 3：退路——schema 不含 enum，白名單改由 prompt 列舉、ajv 在伺服器端把關
    await callWithSchema('A3 退路：responseJsonSchema 不含 enum', { key: 'responseJsonSchema', enums: false, strict: true });
}

// ───────────────────────── 3. inlineData PDF ─────────────────────────

/**
 * 手工組一份最小可用的 PDF（不裝 pdf-lib／pdfkit，spike 不該引入相依）。
 * 只有 Helvetica 的 ASCII 文字：目的是量 inlineData 的機制與每頁 token，不是驗中文字形。
 */
function makeTinyPdf(pageCount) {
    const objs = [];
    const pages = [];
    let nextId = 3 + pageCount * 2; // 1=Catalog 2=Pages，之後每頁 2 個物件（Page + Contents）
    for (let i = 0; i < pageCount; i++) {
        const pageId = 3 + i * 2;
        const contentId = pageId + 1;
        pages.push(pageId);
        const text = `Q${i + 1}. Let a = (1,2) and b = (3,-1). Find the dot product a . b.  [page ${i + 1} of ${pageCount}]`;
        const stream = `BT /F1 12 Tf 60 720 Td (${text}) Tj ET`;
        objs.push([pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${nextId} 0 R >> >> /Contents ${contentId} 0 R >>`]);
        objs.push([contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
    }
    objs.push([nextId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']);
    objs.unshift([2, `<< /Type /Pages /Kids [${pages.map(p => `${p} 0 R`).join(' ')}] /Count ${pageCount} >>`]);
    objs.unshift([1, '<< /Type /Catalog /Pages 2 0 R >>']);

    let out = '%PDF-1.4\n';
    const offsets = {};
    for (const [id, body] of objs) {
        offsets[id] = out.length;
        out += `${id} 0 obj\n${body}\nendobj\n`;
    }
    const xrefAt = out.length;
    const maxId = nextId;
    out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= maxId; id++) {
        out += String(offsets[id] || 0).padStart(10, '0') + ' 00000 n \n';
    }
    out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

async function pdfCase() {
    const ai = getClient();
    const pageCount = 3;
    const pdf = makeTinyPdf(pageCount);
    const b64 = pdf.toString('base64');
    const started = Date.now();
    try {
        const res = await withRetry('B1 inlineData PDF', () => ai.models.generateContent({
            model: MODEL_EXTRACT,
            contents: [
                { inlineData: { mimeType: 'application/pdf', data: b64 } },
                { text: '這份 PDF 有幾題？把每一題整理成 JSON（idx 從 1 開始，chapter 從 schema 的 enum 選）。' }
            ],
            config: { responseMimeType: 'application/json', responseJsonSchema: buildExtractSchema({ enums: true, strict: true }) }
        }));
        const raw = String(res?.text ?? '').trim();
        const data = JSON.parse(raw.startsWith('```') ? raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim() : raw);
        const um = res?.usageMetadata || {};
        const perPage = um.promptTokenCount ? (um.promptTokenCount / pageCount).toFixed(1) : 'n/a';
        record('B1 inlineData PDF（自製最小 PDF）', true, {
            model: MODEL_EXTRACT,
            PDF位元組: pdf.length, base64位元組: b64.length, 頁數: pageCount,
            拆出題數: data?.questions?.length,
            promptTokenCount: um.promptTokenCount,
            每頁約: perPage + ' tokens（含 prompt 本身，故為上界）',
            usageMetadata: um,
            latencyMs: Date.now() - started
        });
        results.pdf = { bytes: pdf.length, pageCount, usage: um };
    } catch (err) {
        record('B1 inlineData PDF', false, { 錯誤: String(err?.message || err).split('\n').slice(0, 4).join(' ') });
    }
}

// ───────────────────────── 3b. inlineData 的大小門檻 ─────────────────────────

/**
 * 把最小 PDF 補到指定 MB：在 %%EOF 之前塞一大段 PDF 註解（% 開頭的行是合法註解，
 * 不增加頁數也不增加 token，只增加傳輸位元組）——這樣測到的是「請求大小」的門檻，
 * 而不是「頁數／token」的門檻，也不會因為誤送 2 萬頁而燒掉配額。
 */
function makePaddedPdf(targetBytes) {
    const base = makeTinyPdf(1);
    const idx = base.lastIndexOf(Buffer.from('%%EOF'));
    const head = base.subarray(0, idx);
    const tail = base.subarray(idx);
    const padLen = Math.max(0, targetBytes - base.length);
    // 註解內容用 'A'，base64 後仍是 padLen*4/3 位元組
    const pad = Buffer.concat([Buffer.from('%'), Buffer.alloc(padLen - 2, 0x41), Buffer.from([0x0a])]);
    return Buffer.concat([head, pad, tail]);
}

async function inlineLimitCase() {
    const ai = getClient();
    const mb = Number.parseFloat(opt('mb', '15'));
    const pdf = makePaddedPdf(Math.round(mb * 1024 * 1024));
    const b64 = pdf.toString('base64');
    const started = Date.now();
    try {
        const res = await withRetry('B2 inlineData 大小門檻', () => ai.models.generateContent({
            model: MODEL_EXTRACT,
            contents: [
                { inlineData: { mimeType: 'application/pdf', data: b64 } },
                { text: '這份 PDF 有幾題？只回 {"questions":[]} 也可以。' }
            ],
            config: { responseMimeType: 'application/json' }
        }), 2);
        record(`B2 inlineData 大小門檻（原始 ${mb} MB）`, true, {
            model: MODEL_EXTRACT,
            原始位元組: pdf.length, base64位元組: b64.length,
            'base64 MB': (b64.length / 1048576).toFixed(2),
            結果: '被接受',
            usageMetadata: res?.usageMetadata,
            latencyMs: Date.now() - started
        });
    } catch (err) {
        record(`B2 inlineData 大小門檻（原始 ${mb} MB）`, false, {
            model: MODEL_EXTRACT,
            原始位元組: pdf.length, base64位元組: b64.length,
            'base64 MB': (b64.length / 1048576).toFixed(2),
            結果: '被拒絕（這正是要量的門檻）',
            錯誤: String(err?.message || err).split(String.fromCharCode(10)).slice(0, 3).join(' '),
            latencyMs: Date.now() - started
        });
    }
}

// ───────────────────────── 4. Pro 模型 + usageMetadata ─────────────────────────

const VERIFY_SCHEMA = {
    type: 'object',
    properties: {
        final_answer: { type: 'string' },
        answer_form: { type: 'string', enum: ['option', 'number', 'expression', 'text'] },
        steps_summary: { type: 'string' }
    },
    required: ['final_answer', 'answer_form', 'steps_summary'],
    additionalProperties: false
};

async function verifyCase() {
    const ai = getClient();
    const started = Date.now();
    try {
        const res = await withRetry('C1 Pro 模型', () => ai.models.generateContent({
            model: MODEL_VERIFY,
            contents: [{ text: '題型：計算。題目：設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$。請自行解題並回傳最終答案（不要參考任何既有答案），steps_summary 限 400 字內。' }],
            config: { responseMimeType: 'application/json', responseJsonSchema: VERIFY_SCHEMA }
        }));
        const raw = String(res?.text ?? '').trim();
        const data = JSON.parse(raw.startsWith('```') ? raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim() : raw);
        const um = res?.usageMetadata || {};
        record('C1 Pro 模型 + usageMetadata 欄位', true, {
            model: MODEL_VERIFY,
            final_answer: data.final_answer, answer_form: data.answer_form,
            'usageMetadata 的鍵': Object.keys(um),
            promptTokenCount: um.promptTokenCount,
            candidatesTokenCount: um.candidatesTokenCount,
            thoughtsTokenCount: um.thoughtsTokenCount,
            cachedContentTokenCount: um.cachedContentTokenCount,
            totalTokenCount: um.totalTokenCount,
            latencyMs: Date.now() - started
        });
        results.verifyUsage = um;
    } catch (err) {
        record('C1 Pro 模型', false, { model: MODEL_VERIFY, 錯誤: String(err?.message || err).split('\n').slice(0, 4).join(' ') });
    }
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
    console.log(`@google/genai ${results.sdkVersion} / Node ${process.version} / ${results.ranAt}`);
    console.log(`MODEL_EXTRACT 候選 = ${MODEL_EXTRACT}；MODEL_VERIFY 候選 = ${MODEL_VERIFY}`);

    if (cmd === 'models' || cmd === 'all') await listModels();
    if (cmd === 'schema' || cmd === 'all') await schemaCases();
    if (cmd === 'pdf' || cmd === 'all') await pdfCase();
    if (cmd === 'inline-limit') await inlineLimitCase();   // 會傳十幾 MB，不放進 all
    if (cmd === 'verify' || cmd === 'all') await verifyCase();
    if (!['models', 'schema', 'pdf', 'inline-limit', 'verify', 'all'].includes(cmd)) {
        throw new Error(`未知的子指令「${cmd}」，可用：models／schema／pdf／inline-limit／verify／all`);
    }

    const failed = results.cases.filter(c => !c.ok);
    console.log(`\n── 小結：${results.cases.length} 個案例，失敗 ${failed.length} 個 ──`);
    for (const c of failed) console.log(`   ❌ ${c.name}`);

    if (OUT) {
        fs.writeFileSync(path.resolve(OUT), JSON.stringify(results, null, 2), 'utf8');
        console.log(`結論已寫入 ${path.resolve(OUT)}`);
    }
}

main().catch(err => { console.error('❌ ' + (err?.stack || err.message)); process.exit(1); });
