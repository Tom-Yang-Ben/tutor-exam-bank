// ─────────────────────────────────────────────────────────────
// agents/generateVariant.js — 變式題生成節點（P-11a／P-12；docs/interfaces-stage3.md 第 4.2 條）
//
//   input  : { source, neighbors, difficulty_delta, idx, feedback? }
//   outcome: {kind:'pass', data:{…與 payload.extract 同形…, variant_of_root, anchor_ids},
//             gate:{ text_gate, sim }}
//            {kind:'fail', reason:'text_gate'|'off_topic'|'schema_invalid'|'chapter_invalid', feedback}
//            {kind:'error', errorClass:…}
//
// 這個節點是「job 層」的（第 4.1 條）：它把 PDF job 的 `extract` 換掉，產出一列
// `job_questions(state='extracted')`，之後**走完全相同的六個節點**
// （dedup0 → classify → lint → verify → dedup1 → save）。變式題不另開一條管線，
// 也就不會有「變式題的閘門比較鬆」這種事——這是規劃 §4 的核心設計。
//
// 節點內部自己先做兩道閘門，順序是「便宜的先做」：
//   ① 只改字閘門（utils/variantTextGate.js，第 4.3 條）——純文字比對，零成本。
//   ② 跑題檢查（第 4.4 條）——cos(embed(變式), embed(藍本)) ≥ VARIANT_SIM_MIN，一次 embed 呼叫。
// 兩道都不過就 fail，feedback 寫清楚是哪一道、數值多少，下一次重試會餵回 prompt。
//
// ⚠ 兩個「不得」（第 3.1 條的 agent 合約）：不得自己 require('../config/db')、
//   不得自己讀 process.env。模型名走 ctx.config.models、門檻走 ctx.config.thresholds、
//   鄰居由 runner 查好放進 input。
// ─────────────────────────────────────────────────────────────

const Ajv = require('ajv');

const { isValidChapter, isValidSubject } = require('../config/chapters');
const { buildSchema } = require('./schemas');
const { chapterWhitelistText, LATEX_RULES } = require('./promptParts');
const { registerTemplate } = require('../services/llm/templates');
const { textGate } = require('../utils/variantTextGate');
const { buildEmbedText } = require('../utils/embedText');

const TEMPLATE = 'variant.v1';

// ctx.config.thresholds 沒帶到時的保底（值與 .env.example 一致；agent 不讀 process.env）
const DEFAULT_SIM_MIN = 0.80;
const DEFAULT_MIN_EDIT = 0.08;

/** 錨點鄰居最多幾題（第 4.2 條：藍本 + 前 5 題鄰居） */
const MAX_NEIGHBORS = 5;

/** 章節繼承藍本時固定寫這個信心值（第 4.2 條） */
const INHERITED_CHAPTER_CONFIDENCE = 0.9;

const SYSTEM = '你是一位資深的台灣高中數學與物理家教老師，正在替題庫出「換湯不換藥」的變式題：概念與解法不變，情境、數字與敘述全部重寫。你只輸出 JSON，不輸出任何其他文字。';

// 模板原文＝把可變欄位挖空後的字串（第 5.2 條的 promptTemplateHash 就是它的 sha256）。
const PROMPT_TEMPLATE = `請以下面這道「藍本題」為範本，改寫出**一道**同概念的新題目。

{{CHAPTER_WHITELIST}}

【藍本題】
章節：{{SOURCE_CHAPTER}}
題型：{{SOURCE_TYPE}}
難度：{{SOURCE_DIFFICULTY}}
題目：{{SOURCE_QUESTION}}
答案：{{SOURCE_ANSWER}}

{{NEIGHBORS}}

【這一題要做到的事】
1. **考的觀念與解法必須和藍本完全相同**，難度請對齊 {{TARGET_DIFFICULTY}}（1 最簡單、5 最難）。
2. **情境、數字、敘述全部要重寫**：只把數字換掉會被系統的文字閘門直接退回。請換一個具體的生活或物理情境、換一組新的數值、換一種問法。
3. 章節原則上沿用藍本的「{{SOURCE_CHAPTER}}」；只有在改寫後真的落到另一章時才換成白名單裡的另一個字串。
4. answer_text 必須是你**自己算過**的答案，而且要能被一個獨立的模型重算出同樣的結果。單選／多選以選項代號開頭。
5. 不要輸出跟藍本或下面任何一題「同一組數字、同一個情境」的題目——那是重複題，會被去重擋掉。

${LATEX_RULES}

{{FEEDBACK}}`;

registerTemplate(TEMPLATE, PROMPT_TEMPLATE);

// ───────────────────────── 純函式 ─────────────────────────

/** 夾在 [min, max] 之間 */
function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

/**
 * 目標難度＝clamp(藍本難度 + delta, 1, 5)（與第 3.1 條的 retrieved 分支同一個算法）。
 * @param {number} difficulty
 * @param {number} delta
 * @returns {number}
 */
function targetDifficulty(difficulty, delta) {
    const base = Number.parseInt(difficulty, 10);
    const d = Number.parseInt(delta, 10);
    return clamp((Number.isFinite(base) ? base : 3) + (Number.isFinite(d) ? d : 0), 1, 5);
}

/**
 * 家族根節點（第 4.2 條）：`COALESCE(藍本.variant_of, 藍本.id)`。
 * variant_of 永遠指向根節點（interfaces.md 第 1.2 條），所以不必遞迴。
 * @param {{id:number, variant_of?:number|null}} source
 * @returns {number|null}
 */
function familyRoot(source) {
    const s = source || {};
    const root = s.variant_of ?? s.id;
    return Number.isInteger(root) ? root : null;
}

/** 一行化（鄰居只當風格錨點，不需要全文） */
function oneLine(text, max = 160) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 鄰居區塊。空清單時回空字串（題庫初期只有藍本可參考，不是失敗）。
 * @param {Array<{id:number, chapter:string, question_text:string}>} neighbors
 * @returns {string}
 */
function neighborsText(neighbors) {
    const list = Array.isArray(neighbors) ? neighbors.slice(0, MAX_NEIGHBORS) : [];
    if (!list.length) return '';
    const lines = list.map(n => `- （${n.chapter}）${oneLine(n.question_text)}`);
    return `【題庫裡風格相近的題目，請照這個敘述風格與詳細程度寫，但不要抄它們的情境與數字】\n${lines.join('\n')}`;
}

/**
 * 這次用到的錨點 id，由小到大（第 4.2 條的 anchor_ids 與 cassette 鍵都用它）。
 * @param {Array<{id:number}>} neighbors
 * @returns {number[]}
 */
function anchorIdsOf(neighbors) {
    const list = Array.isArray(neighbors) ? neighbors.slice(0, MAX_NEIGHBORS) : [];
    return list.map(n => n && n.id).filter(id => Number.isInteger(id)).sort((a, b) => a - b);
}

/**
 * 組出真正送出去的 prompt。
 * @param {{source:object, neighbors:Array<object>, difficulty_delta:number, feedback?:string}} input
 * @returns {string}
 */
function buildPrompt(input) {
    const s = input.source || {};
    return PROMPT_TEMPLATE
        .replace('{{CHAPTER_WHITELIST}}', chapterWhitelistText(s.subject))
        .replace(/\{\{SOURCE_CHAPTER\}\}/g, String(s.chapter ?? ''))
        .replace('{{SOURCE_TYPE}}', String(s.question_type ?? ''))
        .replace('{{SOURCE_DIFFICULTY}}', String(s.difficulty ?? ''))
        .replace('{{SOURCE_QUESTION}}', String(s.question_text ?? ''))
        .replace('{{SOURCE_ANSWER}}', String(s.answer_text ?? ''))
        .replace('{{NEIGHBORS}}', neighborsText(input.neighbors))
        .replace('{{TARGET_DIFFICULTY}}', String(targetDifficulty(s.difficulty, input.difficulty_delta)))
        .replace('{{FEEDBACK}}', input.feedback ? `【上一次生成被退回的理由，請不要再犯】\n${input.feedback}` : '');
}

let validator = null;
/** ajv validator（只編譯一次；schema 是深凍結的，複製一份再交給 ajv） */
function getValidator() {
    if (validator) return validator;
    const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    validator = ajv.compile(JSON.parse(JSON.stringify(buildSchema('variant'))));
    return validator;
}

/** ajv 的錯誤壓成人看得懂的短句（與 agents/extract.js 同一套格式） */
function formatErrors(errors) {
    return (errors || []).map((e) => {
        const where = e.instancePath ? e.instancePath.replace(/^\//, '') : '(整筆)';
        if (e.keyword === 'enum') return `${where}：「${e.data}」不在白名單內`;
        if (e.keyword === 'required') return `缺少必填欄位 ${e.params.missingProperty}`;
        if (e.keyword === 'additionalProperties') return `多了不該有的欄位 ${e.params.additionalProperty}`;
        return `${where} ${e.message}`;
    });
}

/** 兩個 L2 正規化過的向量的餘弦＝內積（services/llm 已正規化，interfaces.md 第 4 條） */
function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}

function thresholdsOf(ctx) {
    const t = (ctx && ctx.config && ctx.config.thresholds) || {};
    const simMin = Number(t.variantSimMin);
    const minEdit = Number(t.variantMinEdit);
    return {
        variantSimMin: Number.isFinite(simMin) ? simMin : DEFAULT_SIM_MIN,
        variantMinEdit: Number.isFinite(minEdit) ? minEdit : DEFAULT_MIN_EDIT
    };
}

/**
 * 模型：`MODEL_VARIANT`，未設退回 `MODEL_VERIFY`（第 4.2、9 條）。
 * agent 不讀 process.env，所以退回的來源是 runner 組好的 ctx.config.models。
 */
function modelOf(ctx) {
    const m = (ctx && ctx.config && ctx.config.models) || {};
    return m.variant || m.verify || undefined;
}

/** 送去 embed 的文本：與寫入題庫時同一支 buildEmbedText，量的才是同一個東西 */
function embedTextFor(fields) {
    return buildEmbedText({
        subject: fields.subject,
        chapter: fields.chapter,
        question_type: fields.question_type,
        difficulty: fields.difficulty,
        question_text: fields.question_text
    });
}

// ───────────────────────── 節點主體 ─────────────────────────

/**
 * @param {object} ctx  第 3.1 條的 Ctx（第 4.5 條加了 ctx.job.kind／pdf_sha256 與三個 thresholds）
 * @param {{ source:{id, subject, chapter, question_type, difficulty, question_text, answer_text, variant_of?},
 *           neighbors: Array<{id, chapter, question_text}>,
 *           difficulty_delta: -1|0|1,
 *           idx: number,
 *           feedback?: string }} input
 * @returns {Promise<object>} outcome；**不得 throw**
 */
async function run(ctx, input = {}) {
    try {
        const source = input.source || {};
        const idx = Number.isInteger(input.idx) ? input.idx : 1;
        const delta = Number.isInteger(input.difficulty_delta) ? input.difficulty_delta : 0;
        const { variantSimMin, variantMinEdit } = thresholdsOf(ctx);

        if (!isValidSubject(source.subject)) {
            return {
                kind: 'fail', reason: 'schema_invalid',
                feedback: `generateVariant：藍本的學科「${source.subject}」不在白名單內。`
            };
        }
        if (!String(source.question_text ?? '').trim()) {
            return { kind: 'fail', reason: 'schema_invalid', feedback: 'generateVariant：藍本的題幹是空的。' };
        }
        const root = familyRoot(source);
        if (root === null) {
            return { kind: 'fail', reason: 'schema_invalid', feedback: 'generateVariant：藍本沒有合法的 id，算不出家族根節點。' };
        }

        const anchorIds = anchorIdsOf(input.neighbors);

        const res = await ctx.llm.generateJson({
            model: modelOf(ctx),
            system: SYSTEM,
            parts: [{ text: buildPrompt({ ...input, source, difficulty_delta: delta }) }],
            schema: buildSchema('variant'),
            signal: ctx.signal,
            agent: 'variant',
            template: TEMPLATE,
            // 第 4.2 條：鍵是 { template, sourceQuestionId, difficultyDelta, idx, anchorIds }，
            // **不放題幹全文**（理由同 classify 的 fewShotIds：題庫動一下就換一份 cassette，
            // 紅燈全是噪音）。feedback 也刻意不進鍵——重試時回放同一捲帶是確定性的行為。
            cacheKeyParts: {
                template: TEMPLATE,
                sourceQuestionId: source.id,
                difficultyDelta: delta,
                idx,
                anchorIds
            }
        });

        const data = res.data || {};

        // ── schema：伺服器端的 ajv 是最終閘門（裁決 S0-1，任何情況都不可略過）──
        const validate = getValidator();
        if (!validate(data)) {
            return {
                kind: 'fail', reason: 'schema_invalid',
                feedback: `變式輸出沒通過 schema 驗證：${formatErrors(validate.errors).join('；')}`
            };
        }

        // ── 章節閘門（第 4.2 條）：預設繼承藍本；模型換了章節就要過 isValidChapter ──
        let chapter = source.chapter;
        let chapterConfidence = INHERITED_CHAPTER_CONFIDENCE;
        let chapterOverridden = false;
        if (data.chapter && data.chapter !== source.chapter) {
            if (isValidChapter(source.subject, data.chapter)) {
                chapter = data.chapter;
                const c = Number(data.chapter_confidence);
                chapterConfidence = Number.isFinite(c) ? c : INHERITED_CHAPTER_CONFIDENCE;
            } else {
                chapterOverridden = true;   // 跨科錯配：改用藍本章節並留痕
            }
        }

        const questionText = String(data.question_text).trim();
        const fields = {
            idx,
            subject: source.subject,
            chapter,
            chapter_confidence: chapterConfidence,
            question_type: data.question_type,
            difficulty: data.difficulty,
            question_text: questionText,
            answer_text: String(data.answer_text).trim(),
            ...(String(data.figure_desc ?? '').trim() ? { figure_desc: String(data.figure_desc).trim() } : {}),
            chunk_no: 0,          // 變式沒有 chunk，但鍵要在（同形）
            page_range: null,     // 變式沒有頁碼，同上
            variant_of_root: root,
            anchor_ids: anchorIds,
            ...(chapterOverridden ? { chapter_overridden: true } : {})
        };

        // ── 閘門①：只改字（純文字比對，零成本，所以放在跑題檢查之前）──
        const gate = textGate({
            source_text: source.question_text,
            variant_text: questionText,
            minEdit: variantMinEdit
        });
        if (!gate.ok) {
            return {
                kind: 'fail',
                reason: 'text_gate',
                feedback: `只改字閘門未通過（${gate.reason}）：與藍本的編輯距離比例 ${gate.edit_ratio.toFixed(4)} < ${variantMinEdit}。` +
                    '請整段重寫情境與敘述，不要只換數字。',
                data: { text_gate: gate }
            };
        }

        // ── 閘門②：跑題檢查（第 4.4 條）──
        const { vectors } = await ctx.llm.embed({
            texts: [embedTextFor(fields), embedTextFor(source)],
            taskType: 'RETRIEVAL_DOCUMENT'
        });
        const sim = cosine(vectors && vectors[0], vectors && vectors[1]);
        if (sim === null) {
            return { kind: 'error', errorClass: 'provider_error', message: 'generateVariant：embed 沒有回傳可用的向量，算不出跑題餘弦。' };
        }
        if (sim < variantSimMin) {
            return {
                kind: 'fail',
                reason: 'off_topic',
                feedback: `跑題檢查未通過：與藍本的概念餘弦 ${sim.toFixed(4)} < ${variantSimMin}。` +
                    '請維持與藍本相同的考點與解法，只換情境與數字。',
                data: { sim, text_gate: gate }
            };
        }

        return {
            kind: 'pass',
            data: fields,
            // 第 4.5 條的 payload.variant 由 runner 寫，但 text_gate 與 sim 只有這裡算得出來，
            // 所以放在 outcome 的第二個鍵交棒。data 本身維持「與 payload.extract 同形 + 兩個鍵」。
            gate: { text_gate: gate, sim },
            schema_fallback: res.schemaFallback === true
        };
    } catch (err) {
        return {
            kind: 'error',
            errorClass: err.errorClass || 'provider_error',
            message: err.message
        };
    }
}

module.exports = {
    run,
    // 給 runner、cassette 錄製腳本與單元測試用的內部零件
    buildPrompt, neighborsText, anchorIdsOf, targetDifficulty, familyRoot, cosine,
    TEMPLATE, SYSTEM, PROMPT_TEMPLATE, MAX_NEIGHBORS, INHERITED_CHAPTER_CONFIDENCE
};
