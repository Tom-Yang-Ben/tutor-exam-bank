// ─────────────────────────────────────────────────────────────
// eval/tools/local_bench_text.js — 文字模型的本機量測（npm run local:bench-text；docs/local-mode.md 第 10.14 條）
//
// 給 Owner 在自己的電腦上比較「思考開／關」「num_ctx 16384／8192」「執行緒數」對一次呼叫的影響，
// 再決定要不要開 OLLAMA_NO_THINK、改 OLLAMA_NUM_CTX（加速選項 a～e）——不必重錄、也不必上傳一份卷。
//
//   npm run local:bench-text -- --agent lint                     照目前的設定（.env）量 lint 的 LLM 重寫一次
//   npm run local:bench-text -- --agent lint --no-think          同一題、關掉思考（選項 a）
//   npm run local:bench-text -- --agent verify --num-ctx 8192    驗算、num_ctx 8192（選項 d）
//   npm run local:bench-text -- --agent classify --num-thread 4  分類、指定執行緒數（選項 e）
//
// 做的事（只有這些）：
//   1. 從 eval/fixtures/questions.public.json 挑一題（--id 可指定）；
//   2. 用 agent 本身的 run() 組出請求（系統提示詞、提示詞、schema、輸出上限、thinkingBudget 與正式流程一模一樣：
//      給 agent 一個「只記下請求、不呼叫模型」的假 llm，拿到請求就停）；
//      〔審查修正〕例外是 classify：這裡沒有資料庫（ctx.db=null），few-shot 全部來自設定檔的自製例句（同一科每題相同，
//      與 eval 的 classify 回放檔同一種 prompt）；正式上傳時 few-shot 由題庫組（FEATURE_SIMILAR 開時是向量近鄰、每題不同），
//      prompt 的長度與內容都不一樣，量到的讀 prompt 秒數只能參考（報告裡會註明）；
//   3. 套上 .env 裡的本機調整（OLLAMA_NO_THINK、OLLAMA_MAX_OUTPUT_<AGENT>、OLLAMA_NUM_CTX_<AGENT>；services/llm/localTuning.js），
//      再套上這次的參數（--no-think／--think、--max-output、--num-ctx、--num-thread）——不加參數＝正式上傳現在的樣子；
//   4. 先請 Ollama 卸載模型（--warm 可略過），**只呼叫一次**，印出載入、讀 prompt、輸出（含思考）的時間、token 數與速度，
//      思考約占多少、回答對不對（驗算對照 fixture 的答案、分類對照 fixture 的章節），以及「一份 10 題卷這一步大約多久」。
//
// 不寫 cassette（直接呼叫 services/llm/ollama.js，不經 services/llm 的 record／replay）、不碰資料庫、不改 .env。
// 逾時用 --timeout-min（預設 60 分）取代 OLLAMA_TIMEOUT_MS，只在這一次量測有效。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const FIXTURE_FILE = path.join(APP_DIR, 'eval', 'fixtures', 'questions.public.json');

/** 可以量的 agent（都是本機模式下用 qwen3:8b 的文字步驟） */
const AGENTS = Object.freeze(['lint', 'verify', 'classify', 'kc_tag']);
/** --think 時、agent 本來不思考的 thinkingBudget（Ollama 只看 >0，數字本身沒有作用） */
const THINK_ON_BUDGET = 1024;
/**
 * 「字數 → token 數」：2026-09-26 以 repo 裡 160 支 qwen3:8b 不思考的回放檔（classify、nlq、variant）擬合，平均誤差約 5%
 *（npm run perf:local 第 1.4 段會用當時的回放檔重算）。估回答佔幾個 token，輸出減回答＝思考。
 */
const TOKENS_PER_CHAR = Object.freeze({ cjk: 0.88, other: 0.5 });

const USAGE = `用法：npm run local:bench-text -- --agent <${AGENTS.join('|')}> [選項]

  --agent <名稱>        要量哪一步（必填）：lint（公式 LLM 重寫）、verify（驗算）、classify（分類）、kc_tag（知識點標註）
  --id <題號>           eval/fixtures/questions.public.json 的哪一題（預設：lint 挑第一題規則修不好的、verify 挑第一題計算題、
                        classify 挑第一題、kc_tag 挑第一題有知識點清單的章）
  --no-think            這一次不思考（選項 a／b／c）
  --think               這一次強制思考（agent 本來不思考的也開，例如 classify）
  --num-ctx <N>         這一次的 num_ctx（預設 .env 的 OLLAMA_NUM_CTX_<AGENT>，再來 OLLAMA_NUM_CTX，沒寫是 16384）
  --max-output <N>      這一次的輸出上限（num_predict；預設照 agent 與 .env 的 OLLAMA_MAX_OUTPUT_<AGENT>）
  --num-thread <N>      這一次用幾個 CPU 執行緒（Ollama 的 num_thread；預設不送，Ollama 自己決定）
  --model <模型>        預設照 .env（lint／classify：MODEL_TEXT；verify：MODEL_VERIFY；kc_tag：MODEL_KC_TAG）
  --warm                不先卸載模型（預設先卸載：時間含載入、也不會吃到上一次的 prompt 快取）
  --timeout-min <分>    這一次量測的逾時（預設 60；不改 .env 的 OLLAMA_TIMEOUT_MS）
  --progress-sec <秒>   每隔幾秒印一次輸出進度（預設 30；0＝不印）
  -h, --help            顯示這段說明

只呼叫一次文字模型：不寫 cassette、不碰資料庫、不改 .env。Ollama 要開著；一次可能要幾分鐘到十幾分鐘。
要比較，同一題換參數各跑一次（例：先不加參數、再加 --no-think），把兩段「══ 文字模型量測」貼在一起看。`;

// ───────────────────────── 參數 ─────────────────────────

function intArg(v, flag, { min = 1, max = 1_000_000 } = {}) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} 要是 ${min}～${max} 的整數，收到「${v}」`);
    return n;
}

/**
 * @param {string[]} argv
 * @returns {{agent:string|null, id:number|null, think:boolean|null, numCtx:number|null, maxOutput:number|null,
 *            numThread:number|null, model:string|null, warm:boolean, timeoutMin:number, progressSec:number, help:boolean}}
 */
function parseArgs(argv) {
    const args = {
        agent: null, id: null, think: null, numCtx: null, maxOutput: null, numThread: null, model: null,
        warm: false, timeoutMin: 60, progressSec: 30, help: false
    };
    const value = (i, flag) => {
        const v = argv[i];
        if (v === undefined || v === '' || /^--?[a-z]/i.test(v)) throw new Error(`${flag} 後面要接一個值\n\n${USAGE}`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--agent': {
                const v = String(value(++i, a)).trim().toLowerCase();
                if (!AGENTS.includes(v)) throw new Error(`--agent 只能是 ${AGENTS.join('／')}，收到「${v}」`);
                args.agent = v;
                break;
            }
            case '--id': args.id = intArg(value(++i, a), a); break;
            case '--no-think':
                if (args.think === true) throw new Error('--think 與 --no-think 只能選一個');
                args.think = false; break;
            case '--think':
                if (args.think === false) throw new Error('--think 與 --no-think 只能選一個');
                args.think = true; break;
            case '--num-ctx': args.numCtx = intArg(value(++i, a), a, { min: 2048, max: 262_144 }); break;
            case '--max-output': args.maxOutput = intArg(value(++i, a), a, { min: 16, max: 65_536 }); break;
            case '--num-thread': args.numThread = intArg(value(++i, a), a, { min: 1, max: 256 }); break;
            case '--model': args.model = String(value(++i, a)).trim(); break;
            case '--warm': args.warm = true; break;
            case '--timeout-min': args.timeoutMin = intArg(value(++i, a), a, { min: 1, max: 24 * 60 }); break;
            case '--progress-sec': args.progressSec = intArg(value(++i, a), a, { min: 0, max: 3600 }); break;
            case '-h': case '--help': args.help = true; break;
            default: throw new Error(`未知的參數「${a}」\n\n${USAGE}`);
        }
    }
    if (!args.help && !args.agent) throw new Error(`要用 --agent 指定量哪一步（${AGENTS.join('／')}）\n\n${USAGE}`);
    return args;
}

// ───────────────────────── 題目、模型、請求 ─────────────────────────

/** fixture 的題目（依 id 排序） */
function loadFixtureQuestions(file = FIXTURE_FILE) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const qs = Array.isArray(doc) ? doc : (doc.questions || []);
    return qs.slice().sort((a, b) => a.id - b.id);
}

/**
 * 該章的知識點清單（config/kc/<科目>.json；與 services/kcTagService.js 送給 agent 的欄位相同：code、name、description）。
 * @returns {Array<{code:string, name:string, description:string}>}
 */
function kcsFor(subject, chapter, { dir = path.join(APP_DIR, 'config', 'kc') } = {}) {
    const file = path.join(dir, `${subject}.json`);
    if (!fs.existsSync(file)) return [];
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (doc.components || [])
        .filter(c => c && c.chapter === chapter && typeof c.code === 'string')
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
        .map(c => ({ code: c.code, name: c.name, description: c.description || '' }));
}

/**
 * 挑題。純函式（kcsLookup 可注入）。
 * @returns {{question:object, why:string}}
 */
function pickQuestion(agent, questions, { id = null, kcsLookup = kcsFor } = {}) {
    const lint = require('../../agents/lint');
    if (id !== null) {
        const q = questions.find(x => x.id === id);
        if (!q) throw new Error(`fixture 裡沒有 id=${id} 的題目（共 ${questions.length} 題）`);
        if (agent === 'lint' && lint.gate(q.question_text || '', q.answer_text || '').ok) {
            throw new Error(`id=${id} 的公式用規則就修得好，lint 不會呼叫 LLM；換一題（不加 --id 會自動挑一題規則修不好的）`);
        }
        if (agent === 'verify' && q.question_type === '證明') throw new Error(`id=${id} 是證明題，驗算會直接跳過；換一題`);
        if (agent === 'kc_tag' && !kcsLookup(q.subject, q.chapter).length) throw new Error(`id=${id} 的章「${q.chapter}」沒有知識點清單；換一題`);
        return { question: q, why: '--id 指定' };
    }
    let q;
    let why;
    if (agent === 'lint') {
        q = questions.find(x => !lint.gate(x.question_text || '', x.answer_text || '').ok);
        why = '第一題公式用規則修不好（lint 才會呼叫 LLM 重寫）';
    } else if (agent === 'verify') {
        q = questions.find(x => x.question_type === '計算') || questions.find(x => x.question_type !== '證明');
        why = '第一題計算題';
    } else if (agent === 'kc_tag') {
        q = questions.find(x => kcsLookup(x.subject, x.chapter).length > 0);
        why = '第一題有知識點清單的章';
    } else {
        q = questions[0];
        why = '第一題';
    }
    if (!q) throw new Error(`fixture 裡找不到適合 ${agent} 的題目`);
    return { question: q, why };
}

/**
 * 這個 agent 在正式流程用哪個模型（與 config/models.js 的 getter 同一套規則，但讀注入的 env）。純函式。
 *   lint、classify → MODEL_TEXT（沒寫時：拆題模型是 ollama＝MODEL_VERIFY，否則＝MODEL_EXTRACT；LM-15）
 *   verify → MODEL_VERIFY；kc_tag → MODEL_KC_TAG（沒寫＝MODEL_TEXT）
 */
function modelSpecFor(agent, env = {}) {
    const models = require('../../config/models');
    const s = (k) => String(env[k] ?? '').trim();
    const extract = s('MODEL_EXTRACT') || models.DEFAULT_EXTRACT;
    const verify = s('MODEL_VERIFY') || models.DEFAULT_VERIFY;
    let extractVendor = null;
    try { extractVendor = models.parseModel(extract).vendor; } catch (err) { extractVendor = null; }
    const text = s('MODEL_TEXT') || (extractVendor === 'ollama' ? verify : extract);
    if (agent === 'verify') return verify;
    if (agent === 'kc_tag') return s('MODEL_KC_TAG') || text;
    return text;
}

/** agent 的 input（與 workers/jobRunner.js 的 buildInput、services/kcTagService.js 給的欄位相同） */
function inputFor(agent, q, { kcsLookup = kcsFor } = {}) {
    switch (agent) {
        case 'lint': return { question_text: q.question_text, answer_text: q.answer_text || '' };
        case 'verify': return { question_text: q.question_text, question_type: q.question_type, claimed_answer: q.answer_text || '' };
        // chapter_confidence 0：第一層閘門一律不過，才會走到 LLM（量的就是那一次呼叫）
        case 'classify': return { subject: q.subject, chapter: q.chapter, chapter_confidence: 0, question_text: q.question_text };
        case 'kc_tag': return { question_text: q.question_text, subject: q.subject, chapter: q.chapter, answer_text: q.answer_text || '', kcs: kcsLookup(q.subject, q.chapter) };
        default: throw new Error(`inputFor：未知的 agent ${agent}`);
    }
}

const AGENT_MODULES = Object.freeze({ lint: 'agents/lint', verify: 'agents/verify', classify: 'agents/classify', kc_tag: 'agents/tagKc' });

/** 〔審查修正〕classify 的量測與正式上傳不同的地方（報告印在「題目」下面） */
const CLASSIFY_NOTE = '注意（分類）：量測不碰資料庫，few-shot 全部來自設定檔的自製例句（同一科每題相同，與 eval 的 classify 回放檔同一種 prompt）；' +
    '正式上傳時 few-shot 由題庫組（`FEATURE_SIMILAR` 開時是向量近鄰、每題不同），prompt 的長度與內容都不一樣，讀 prompt 的秒數只能參考。' +
    '回放檔的分類 51 秒是這種 prompt 同一科連續送、前綴快取是熱的結果（npm run perf:local 第 4 段）。';

/**
 * 用 agent 自己的 run() 組出請求：給它一個只記下請求就丟錯的 llm，拿到請求就停。
 * 所以送出的內容（系統提示詞、提示詞、schema、maxOutputTokens、thinkingBudget、agent 名稱）與正式流程逐字相同——
 * 〔審查修正〕classify 除外：ctx.db=null，few-shot 來自設定檔的例句，不是正式上傳時題庫組出來的（見檔頭第 2 點與 CLASSIFY_NOTE）。
 * @returns {Promise<object>} generateJson 收到的 opts
 */
async function captureRequest(agent, input, modelSpec) {
    const mod = require(path.join(APP_DIR, AGENT_MODULES[agent]));
    let captured = null;
    const stop = Object.assign(new Error('bench：只取請求，不呼叫模型'), { errorClass: 'provider_error' });
    const ctx = {
        llm: { generateJson: async (opts) => { captured = opts; throw stop; } },
        config: { models: { text: modelSpec, extract: modelSpec, verify: modelSpec, kcTag: modelSpec }, features: {}, thresholds: {} },
        db: null,
        logger: { warn() { }, info() { }, error() { } }
    };
    await mod.run(ctx, input);
    if (!captured) throw new Error(`${agent} 沒有呼叫模型（這一題不需要 LLM？）`);
    return captured;
}

/**
 * 這一次實際送出的參數：agent 的請求 → .env 的本機調整（正式上傳現在的樣子）→ 這次的參數。純函式。
 * @param {object} captured  captureRequest 的結果
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} env
 */
function resolveCallParams(captured, args, env = {}) {
    const tuning = require('../../services/llm/localTuning');
    const ollama = require('../../services/llm/ollama');
    const agentBudget = Number(captured.thinkingBudget) > 0 ? Number(captured.thinkingBudget) : 0;
    const t = tuning.resolveOllamaOverrides({ agent: captured.agent, thinkingBudget: captured.thinkingBudget, maxOutputTokens: captured.maxOutputTokens }, env);
    let thinkingBudget = Number(t.thinkingBudget) > 0 ? Number(t.thinkingBudget) : 0;
    let thinkWhy = agentBudget > 0 ? (t.applied.think === false ? '關（.env 的 OLLAMA_NO_THINK）' : '開（agent 預設）') : '關（agent 本來就不思考）';
    if (args.think === false) { thinkingBudget = 0; thinkWhy = '關（--no-think）'; }
    if (args.think === true) { thinkingBudget = agentBudget || THINK_ON_BUDGET; thinkWhy = '開（--think）'; }

    let maxOutputTokens = t.maxOutputTokens;
    let maxWhy = t.applied.numPredict ? `.env 的 OLLAMA_MAX_OUTPUT_${tuning.agentEnvSuffix(captured.agent)}（或基本名稱）` : (maxOutputTokens ? 'agent 預設' : 'agent 不設上限');
    if (args.maxOutput) { maxOutputTokens = args.maxOutput; maxWhy = '--max-output'; }

    let numCtx = t.numCtx || ollama.numCtx(env);
    let ctxWhy = t.applied.numCtx ? `.env 的 OLLAMA_NUM_CTX_${tuning.agentEnvSuffix(captured.agent)}（或基本名稱）`
        : (String(env.OLLAMA_NUM_CTX ?? '').trim() ? '.env 的 OLLAMA_NUM_CTX' : '預設');
    if (args.numCtx) { numCtx = args.numCtx; ctxWhy = '--num-ctx'; }

    return {
        thinkingBudget, think: thinkingBudget > 0, thinkWhy,
        maxOutputTokens: maxOutputTokens || undefined, maxWhy,
        numCtx, ctxWhy,
        numThread: args.numThread || undefined
    };
}

// ───────────────────────── 推估（純函式） ─────────────────────────

/** 字數 → token 數（TOKENS_PER_CHAR；只是估計） */
function estimateTokens(text) {
    const s = String(text ?? '');
    const cjk = (s.match(/[⺀-鿿豈-﫿＀-￯　-〿]/g) || []).length;
    return TOKENS_PER_CHAR.cjk * cjk + TOKENS_PER_CHAR.other * (s.length - cjk);
}

/**
 * 一份卷裡這一步大約呼叫幾次（與 npm run perf:local 第 4 段同一組假設：PAPER_ASSUMPTIONS）。
 * @returns {{low:number, high:number, note:string}}
 */
function callsPerPaper(agent, { questions } = {}) {
    const A = require('./local_perf_report').PAPER_ASSUMPTIONS;
    const Q = questions || A.QUESTIONS;
    switch (agent) {
        case 'lint': return { low: Q * A.LINT_LLM_RATE.low, high: Q * A.LINT_LLM_RATE.high, note: `規則修不好的題才呼叫（${Math.round(A.LINT_LLM_RATE.low * 100)}%～${Math.round(A.LINT_LLM_RATE.high * 100)}%）` };
        case 'verify': return { low: Q, high: Q * (1 + A.VERIFY_UNCERTAIN_RATE_FALLBACK) * (1 + A.VERIFY_FAIL_RATE.high), note: '每題一次；uncertain 再採樣、判定不一致整個節點再跑一次' };
        case 'classify': return { low: Q * A.CLASSIFY_LLM_RATE.low, high: Q * A.CLASSIFY_LLM_RATE.high, note: '拆題模型的信心不夠才呼叫（0%～100%，本機還沒有資料）' };
        case 'kc_tag': return { low: Q, high: Q, note: '開了自動標知識點（FEATURE_KC_TAGGING）才有；預設關' };
        default: return { low: 0, high: 0, note: '' };
    }
}

/** 回答對不對（只看這一題；判斷品質要多量幾題） */
function checkAnswer(agent, question, data) {
    const d = data || {};
    if (agent === 'verify') {
        const { answerCompare } = require('../../utils/answerCompare');
        const compare = answerCompare({
            question_type: question.question_type,
            claimed: question.answer_text || '',
            model: { final_answer: d.final_answer || '', answer_form: d.answer_form || '' }
        });
        const label = { agree: '一致', disagree: '**不一致**', uncertain: '比不出來（uncertain）' }[compare] || compare;
        return `驗算答案「${oneLine(d.final_answer, 60)}」 vs fixture 的答案「${oneLine(question.answer_text, 60)}」→ ${label}`;
    }
    if (agent === 'lint') {
        const lint = require('../../agents/lint');
        const g = lint.gate(d.question_text || '', typeof d.answer_text === 'string' ? d.answer_text : (question.answer_text || ''));
        return `重寫後${g.ok ? '通過' : '**仍不通過**'}公式閘門；題幹：「${oneLine(d.question_text, 80)}」`;
    }
    if (agent === 'classify') {
        return `分到「${d.chapter || '（空）'}」（信心 ${d.confidence ?? '—'}）；fixture 標的是「${question.chapter}」→ ${d.chapter === question.chapter ? '相同' : '**不同**'}`;
    }
    if (agent === 'kc_tag') {
        const codes = Array.isArray(d.kc_codes) ? d.kc_codes.map(c => `${c.code}（${c.confidence}）`).join('、') : '（沒有）';
        return `標到 ${codes}`;
    }
    return '';
}

function oneLine(text, max) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ───────────────────────── 輸出 ─────────────────────────

function fmtInt(n) {
    return n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');
}

function fmtRate(tokens, ms) {
    return ms > 0 && Number.isFinite(tokens) ? `${(tokens / (ms / 1000)).toFixed(2)} token/秒` : '—';
}

/**
 * 組報告（純函式）。
 * @param {object} r main() 收集的結果
 * @returns {string}
 */
function formatReport(r) {
    const { fmtDur } = require('./local_perf_report');
    const L = [];
    const p = r.params;
    L.push('');
    L.push('══ 文字模型量測（npm run local:bench-text）══════════════════════════');
    L.push(`步驟：${r.agent}（agent 名稱 ${r.agentName}）；模型：${r.model}（Ollama ${r.host}）`);
    L.push(`題目：fixture id=${r.question.id}（${r.question.subject}／${r.question.chapter}／${r.question.question_type}；${r.why}）`);
    if (r.agent === 'classify') L.push(CLASSIFY_NOTE);
    L.push(`思考：${p.thinkWhy}；num_ctx：${fmtInt(p.numCtx)}（${p.ctxWhy}）；輸出上限：${p.maxOutputTokens ? fmtInt(p.maxOutputTokens) : '不設'}（${p.maxWhy}）；` +
        `執行緒：${p.numThread ? `${p.numThread}（--num-thread）` : 'Ollama 預設'}`);
    L.push(`載入：${r.warm ? '沒有先卸載（--warm）：時間可能不含載入，也可能吃到上一次的 prompt 快取' : '量測前先卸載模型，時間含載入、prompt 是冷的'}`);
    L.push('');
    if (r.outcome === 'error') {
        L.push(`❌ 沒有量到：${r.error}`);
        if (r.errorClass === 'timeout') L.push(`   ${fmtDur(r.timeoutMs)} 內沒有做完；加大 --timeout-min 再量，或看工作管理員裡 Ollama 的 CPU 是不是掉到 0（卡住）。`);
        L.push(`   牆鐘 ${fmtDur(r.wallMs)}。`);
        return `${L.join('\n')}\n`;
    }
    const t = r.timing;
    const u = r.usage;
    const answerTok = r.answerTokens;
    const thinkTok = r.params.think ? Math.max(0, u.tokenOut - answerTok) : 0;
    L.push(r.outcome === 'ok'
        ? '結果：JSON 合法。'
        : `結果：模型輸出的 JSON 不合法${r.finishReason ? `（finishReason ${r.finishReason}${r.finishReason === 'MAX_TOKENS' ? '：寫到輸出上限被截斷——思考把額度用光了，調大 --max-output 或關掉思考' : ''}）` : ''}；下面的時間照樣有效。`);
    L.push('');
    L.push('| 階段 | 時間 | token | 速度 |');
    L.push('|---|---:|---:|---:|');
    L.push(`| 載入模型 | ${fmtDur(t.loadMs)} | — | — |`);
    L.push(`| 讀 prompt | ${fmtDur(t.promptEvalMs)} | ${fmtInt(u.tokenIn)} | ${fmtRate(u.tokenIn, t.promptEvalMs)} |`);
    L.push(`| 輸出${p.think ? '（含思考）' : ''} | ${fmtDur(t.evalMs)} | ${fmtInt(u.tokenOut)} | ${fmtRate(u.tokenOut, t.evalMs)} |`);
    if (r.params.think) {
        L.push(`| 　其中思考（估） | ${t.evalMs && u.tokenOut ? fmtDur(t.evalMs * thinkTok / u.tokenOut) : '—'} | ${fmtInt(thinkTok)} | 思考文字 ${fmtInt(r.thinkingChars)} 字 |`);
        L.push(`| 　其中回答（估） | ${t.evalMs && u.tokenOut ? fmtDur(t.evalMs * Math.min(answerTok, u.tokenOut) / u.tokenOut) : '—'} | ${fmtInt(Math.min(answerTok, u.tokenOut))} | — |`);
    }
    L.push(`| Ollama 計時合計 | ${fmtDur(t.totalMs)} | — | — |`);
    L.push(`| 牆鐘（含傳輸） | ${fmtDur(r.wallMs)} | — | — |`);
    L.push('');
    L.push(`回答：${r.check}`);
    L.push('');
    const used = u.tokenIn + u.tokenOut;
    L.push(`num_ctx：這一次讀＋寫 ${fmtInt(used)} token，num_ctx ${fmtInt(p.numCtx)}` +
        (used > p.numCtx ? ' → **超過了**：前面的內容可能被截掉，結果不可信。' : ` → 放得下（剩 ${fmtInt(p.numCtx - used)}）`) +
        (p.maxOutputTokens && u.tokenIn + p.maxOutputTokens > p.numCtx ? `；讀＋輸出上限 ${fmtInt(u.tokenIn + p.maxOutputTokens)} 會超過（只有寫得異常長時才會碰到）。` : '。'));
    const perCall = (t.promptEvalMs || 0) + (t.evalMs || 0);
    const c = r.calls;
    const range = (lo, hi) => (Math.abs(lo - hi) < 500 ? fmtDur(lo) : `${fmtDur(lo)}～${fmtDur(hi)}`);
    L.push(`一份 ${r.paperQuestions} 題的卷：這一步大約 ${c.low === c.high ? c.low : `${Math.round(c.low * 10) / 10}～${Math.round(c.high * 10) / 10}`} 次（${c.note}）` +
        ` × 這一次的讀 prompt＋輸出 ${fmtDur(perCall)} ≈ ${range(c.low * perCall, c.high * perCall)}（不含載入；prompt 是冷的，同一段 prompt 剛讀過時會更快）。`);
    L.push('');
    L.push('比較的方法：同一題換一個參數再跑一次（例 `--no-think`、`--num-ctx 8192`、`--num-thread 4`），看「輸出（含思考）」與「讀 prompt」各少了多少、' +
        '回答還對不對。只看一題判斷不了品質：驗算與分類請用 `--id` 多量幾題（docs/local-mode.md 第 10.14 條）。');
    return `${L.join('\n')}\n`;
}

// ───────────────────────── 主流程 ─────────────────────────

/** exam_pro/.env 疊到 process.env（已存在的不覆寫；與 dotenv 相同） */
function loadDotenv() {
    try {
        require('dotenv').config({ path: path.join(APP_DIR, '.env'), quiet: true });
    } catch (_) { /* 沒有 .env 也能跑 */ }
}

/**
 * @param {string[]} [argv]
 * @param {{stdout?:{write:Function}, env?:object, questions?:object[], kcsLookup?:Function,
 *          generateJson?:Function, unloadModel?:Function, now?:()=>number}} [io] 測試注入點
 * @returns {Promise<number>} 結束碼（量到時間＝0）
 */
async function main(argv = process.argv.slice(2), io = {}) {
    const out = io.stdout || process.stdout;
    const write = (s) => out.write(s.endsWith('\n') ? s : `${s}\n`);
    const args = parseArgs(argv);
    if (args.help) { write(USAGE); return 0; }
    if (!io.env) loadDotenv();
    const env = io.env || process.env;
    const now = io.now || Date.now;

    const models = require('../../config/models');
    const spec = args.model || modelSpecFor(args.agent, env);
    const { vendor, id } = models.parseModel(spec);
    if (vendor !== 'ollama') throw new Error(`這個量測只量本機模型：「${spec}」不是 ollama:…（用 --model ollama:qwen3:8b 指定）`);

    const ollama = require('../../services/llm/ollama');
    const generateJson = io.generateJson || ollama.generateJson;
    const unloadModel = io.unloadModel || ollama.unloadModel;
    const kcsLookup = io.kcsLookup || kcsFor;
    const questions = io.questions || loadFixtureQuestions();

    const { question, why } = pickQuestion(args.agent, questions, { id: args.id, kcsLookup });
    const captured = await captureRequest(args.agent, inputFor(args.agent, question, { kcsLookup }), spec);
    const params = resolveCallParams(captured, args, env);
    let host = '';
    try { host = ollama.resolveHost(env).url; } catch (err) { host = `（OLLAMA_HOST 寫錯：${err.message}）`; }
    const report = {
        agent: args.agent, agentName: captured.agent, model: id, host, question, why, params, warm: args.warm,
        timeoutMs: args.timeoutMin * 60_000, paperQuestions: require('./local_perf_report').PAPER_ASSUMPTIONS.QUESTIONS,
        calls: callsPerPaper(args.agent)
    };

    if (!args.warm) {
        write(`[bench] 先請 Ollama 卸載 ${id}（量到的時間才含載入、prompt 才是冷的）…`);
        await unloadModel({ model: id });
    }
    write(`[bench] 呼叫 ${id}（${args.agent}、思考${params.think ? '開' : '關'}、num_ctx ${params.numCtx}）；逾時 ${args.timeoutMin} 分 …`);
    const startedAt = now();
    let res = null;
    let usage = null;
    try {
        res = await generateJson({
            model: id, system: captured.system, parts: captured.parts, schema: captured.schema,
            maxOutputTokens: params.maxOutputTokens, thinkingBudget: params.thinkingBudget,
            numCtx: params.numCtx, numThread: params.numThread,
            progressMs: args.progressSec * 1000, onProgress: (line) => write(line), timeoutMs: report.timeoutMs
        });
        usage = res.usage;
        report.outcome = 'ok';
    } catch (err) {
        if (err.errorClass === 'schema_invalid' && err.usage) {
            usage = err.usage;
            report.outcome = 'invalid_json';
            report.finishReason = err.finishReason || null;
        } else {
            report.outcome = 'error';
            report.error = String(err.message || err).split('\n')[0];
            report.errorClass = err.errorClass || null;
        }
    }
    report.wallMs = now() - startedAt;
    if (report.outcome === 'error') {
        write(formatReport(report));
        return 1;
    }
    const tm = usage.timing || {};
    report.usage = { tokenIn: usage.tokenIn, tokenOut: usage.tokenOut + (usage.tokenThinking || 0) };
    report.timing = { loadMs: tm.loadMs ?? null, promptEvalMs: tm.promptEvalMs ?? null, evalMs: tm.evalMs ?? null, totalMs: tm.totalMs ?? null };
    if (report.timing.promptEvalMs === null || report.timing.evalMs === null) {
        report.outcome = 'error';
        report.error = 'Ollama 的回應沒有分段時間（prompt_eval_duration／eval_duration），請把 Ollama 更新到最新版';
        write(formatReport(report));
        return 1;
    }
    const data = res ? res.data : null;
    const thinkingText = res && res.raw && res.raw.message && typeof res.raw.message.thinking === 'string' ? res.raw.message.thinking : '';
    report.thinkingChars = thinkingText.length;
    report.answerTokens = data ? estimateTokens(JSON.stringify(data)) : report.usage.tokenOut;
    report.check = data ? checkAnswer(args.agent, question, data) : '（JSON 不合法，沒有回答可以比）';
    write(formatReport(report));
    return 0;
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }).catch((err) => {
        console.error(`\n❌ ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    main, parseArgs, loadFixtureQuestions, kcsFor, pickQuestion, modelSpecFor, inputFor, captureRequest, resolveCallParams,
    estimateTokens, callsPerPaper, checkAnswer, formatReport, USAGE,
    AGENTS, AGENT_MODULES, THINK_ON_BUDGET, TOKENS_PER_CHAR, FIXTURE_FILE, CLASSIFY_NOTE
};
