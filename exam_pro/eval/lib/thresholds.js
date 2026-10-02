// ─────────────────────────────────────────────────────────────
// eval/lib/thresholds.js — CI 門檻的初值與 ratchet
//
// 規劃 §5.3.3：「thresholds.json 的初值由第一次量測的基準線減 0.03 產生，
//               之後只能調高（ratchet），調整需改 json 並在 PR 說明」。
//
// 兩個防呆，兩個都有實際會發生的錯誤情境：
//   1. **stub 狀態不得寫初值**。utils/tokenize.js 或 utils/embedText.js 還沒合入時，
//      LIKE 欄與向量欄量到的是 eval 自己的暫用實作；用它當基準線，等 WS-C 合入
//      真正的 jieba 之後數字必然變動，CI 會紅得莫名其妙。
//   2. **只升不降**。writeBaseline() 遇到已存在且更高的門檻會保留舊值並提醒，
//      避免「跑一次比較差的實驗就把門檻洗低」——那正是 ratchet 要防的事。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.resolve(__dirname, '..', 'thresholds.json');
const BASELINE_MARGIN = 0.03;   // 初值 = 第一次量測 − 0.03

/**
 * @param {string} [file]
 * @returns {object}
 */
function loadThresholds(file) {
    const target = path.resolve(file || DEFAULT_PATH);
    if (!fs.existsSync(target)) return { retrieval: {} };
    return JSON.parse(fs.readFileSync(target, 'utf8'));
}

/**
 * 對照一份量測結果與門檻。
 *
 * 門檻是 null = 「還沒有基準線」：只報告不擋，讓骨架階段的 CI 能跑完；
 * 一旦寫入數字就變成硬門檻。這個「null 不擋、有值就擋」的設計，讓
 * 「向量欄還沒錄向量」與「向量欄退步了」不會混成同一種紅燈。
 *
 * @param {object} thresholds  { retrieval: { like: {recall5, recall10, mrr}|null, … } }
 * @param {object} measured    { like: {recall5,…}|null, vector: …, hybrid: … }
 * @returns {{failures:string[], checked:number, skipped:string[]}}
 */
function compare(thresholds, measured) {
    const failures = [];
    const skipped = [];
    let checked = 0;
    const table = (thresholds && thresholds.retrieval) || {};

    for (const mode of ['like', 'vector', 'hybrid']) {
        const want = table[mode];
        const got = measured[mode];
        if (!want) { skipped.push(`${mode}（門檻尚未建立）`); continue; }
        if (!got) { failures.push(`${mode}：門檻已存在（recall5 ≥ ${want.recall5}）但這次沒有量到數字`); continue; }
        for (const metric of ['recall5', 'recall10', 'mrr']) {
            if (want[metric] === null || want[metric] === undefined) continue;
            checked++;
            if (got[metric] === null || got[metric] === undefined) {
                failures.push(`${mode}.${metric}：門檻 ${want[metric]} 但這次是 n/a`);
            } else if (got[metric] + 1e-9 < want[metric]) {
                failures.push(`${mode}.${metric}：${got[metric].toFixed(4)} < 門檻 ${want[metric]}`);
            }
        }
    }
    return { failures, checked, skipped };
}

/**
 * 寫入／提高門檻。只動「目前是 null」或「新值更高」的項目。
 *
 * @param {object} opts
 * @param {object} opts.measured   量測結果
 * @param {string} [opts.file]
 * @param {boolean} opts.allowStub 是否允許在 stub 分詞／embedText 狀態下寫入（預設不允許）
 * @param {object} opts.meta       寫進檔案的量測環境（模型、分詞器、engine、golden…）
 * @returns {{written:boolean, changes:string[], kept:string[]}}
 */
function writeBaseline(opts) {
    const target = path.resolve(opts.file || DEFAULT_PATH);
    const current = loadThresholds(target);
    current.retrieval = current.retrieval || {};

    const changes = [];
    const kept = [];
    for (const mode of ['like', 'vector', 'hybrid']) {
        const got = opts.measured[mode];
        if (!got) { kept.push(`${mode}：這次沒有量到，維持原狀`); continue; }
        const existing = current.retrieval[mode] || null;
        const next = {};
        for (const metric of ['recall5', 'recall10', 'mrr']) {
            if (got[metric] === null || got[metric] === undefined) { next[metric] = existing ? existing[metric] : null; continue; }
            const candidate = Math.max(0, Math.round((got[metric] - BASELINE_MARGIN) * 10000) / 10000);
            const old = existing ? existing[metric] : null;
            if (old === null || old === undefined) {
                next[metric] = candidate;
                changes.push(`${mode}.${metric}：（無）→ ${candidate}`);
            } else if (candidate > old) {
                next[metric] = candidate;
                changes.push(`${mode}.${metric}：${old} → ${candidate}（ratchet 調高）`);
            } else {
                next[metric] = old;
                kept.push(`${mode}.${metric}：維持 ${old}（新量測 −0.03 後為 ${candidate}，門檻只升不降）`);
            }
        }
        current.retrieval[mode] = next;
    }

    current._measured_with = opts.meta || {};
    current._rule = `初值 = 第一次量測 − ${BASELINE_MARGIN}，之後只升不降（ratchet）。調整必須改本檔並在 PR 說明。`;

    if (changes.length === 0) return { written: false, changes, kept };
    fs.writeFileSync(target, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return { written: true, changes, kept };
}

// ─────────────────────────────────────────────────────────────
// 階段 2 新增：suite 通用的門檻比對與 ratchet（A-T14）
//
// 階段 1 的 compare() / writeBaseline() 把 suite 名（retrieval）與三個欄（like/vector/hybrid）
// 寫死在函式裡。階段 2 多了 classify 與 pipeline 兩個 suite，欄與指標都不一樣，
// 所以抽出通用版；**retrieval 的兩支照原樣保留**（既有行為與 eval:baseline 的輸出是契約）。
//
// 一條新規矩：**只放「越高越好」的指標**。needs_review 的比率越低越好，
// 放進 ratchet 會變成「只准更多題進複核」——那不是門檻，是反向的門檻。
// 這類指標只報告、不設門檻。
// ─────────────────────────────────────────────────────────────

const SUITE_METRICS = {
    retrieval: { columns: ['like', 'vector', 'hybrid'], metrics: ['recall5', 'recall10', 'mrr'] },
    // classify：cassette 回放 vs golden（規劃 §5.3.2、§3.8）
    classify: { columns: ['classify'], metrics: ['accuracy', 'macro_f1'] },
    // pipeline：對 sample_exam.pdf 跑整條管線（A-T14）
    // 〔Owner 2026-10-02 A 案〕verify_agree_rate：拆題沒寫答案（verify 記 no_claim）的題，驗算模型的答案對答案卷 answer_text 的
    //   一致率（eval/lib/suitePipeline.js）。與 answer_agree_rate（拆題答案對驗算答案）分開，歷史數字不混在一起。
    // 〔Owner 2026-10-03 第 r14 輪 C-1〕chapter_acc_rate：有 classify 結果的題，最後章節等於答案卷 chapter 的比例（章節正確率）。
    //   OCR 模式的 gate_pass_rate 改為只報告之後，章節對不對由它把關；兩種模式都比。
    pipeline: { columns: ['pipeline'], metrics: ['saved_rate', 'gate_pass_rate', 'answer_agree_rate', 'verify_agree_rate', 'chapter_acc_rate'] },

    // ── 階段 3 的兩個 suite（interfaces-stage3.md 第 8.2、8.3 條）──
    //
    // nlq：兩欄分開量是刻意的。rule_coverage 問的是「規則就夠了嗎」（＝要不要花錢），
    //      只有 rules 欄有值、llm 欄恆為 null；filters_exact 則是 rules 欄只算
    //      expect_path='rules' 的句子、llm 欄只算 expect_path='llm' 的句子。
    //      把兩條路徑混成一個平均值，會讓「規則變差但 LLM 補回來」看起來像沒事。
    nlq: { columns: ['rules', 'llm'], metrics: ['rule_coverage', 'filters_exact', 'recall10'] },

    // variant：retrieved_coverage 是「純檢索就夠用的比例」＝零 LLM 費用的那一段；
    //          gate_pass_rate 是「生成的題六個閘門全過的比例」。
    //          每題 cost_usd 與各閘門通過數**只報告不設門檻**（第 8.3 條）——
    //          成本越低越好，放進 ratchet 會變成反向門檻。
    variant: { columns: ['variant'], metrics: ['retrieved_coverage', 'gate_pass_rate'] }
};

/**
 * 〔Owner 第五輪 D-2 核准，2026-09-27，dec/r6-gates〕「設計上沒有意義、這一輪不比」的指標**白名單**。
 * suite 回報 notApplicable 時，只有列在這裡的 <suite>.<column>.<metric> 會被略過；其他一律照舊比
 *（不讓任何 suite 自己宣告「這個門檻不算」）。thresholds.json 的數字一個都不動。
 *   pipeline.pipeline.saved_rate：OCR 為主（LOCAL_EXTRACT_MODE=ocr、拆題模型是 ollama）每一題都停在人工複核（ocr_only），
 *   自動入庫率設計上恆為 0，不是品質訊號；交叉驗證與 Gemini 模式照舊比 0.87。
 * 〔Owner 2026-10-02 A 案，docs/local-mode.md 10.25 第 6 點〕
 *   pipeline.pipeline.answer_agree_rate：全部題目都是 no_claim（拆題沒寫答案）時沒有分母；有任何一題不是 no_claim 就照舊比 0.87。
 *   pipeline.pipeline.verify_agree_rate：沒有任何一題是 no_claim 時沒有分母；有一題是就照比。
 *   兩者互斥（條件由 suitePipeline.js 的 pipelineNotApplicable 判斷），有題時至少一個照比。
 * 〔Owner 2026-10-03 第 r14 輪 C-1，docs/local-mode.md 10.27〕
 *   pipeline.pipeline.gate_pass_rate：OCR 模式（與 saved_rate 同一個條件）只報告、不比門檻——0.97 是照 Gemini 定的
 *   （閘門通過＝省一次付費呼叫），本機 classify 走 LLM 不花錢、拆題模型猜的章節不可靠；章節對不對改由 chapter_acc_rate 把關
 *  （不在白名單，兩種模式都比）。Gemini（非 OCR）模式 gate_pass_rate 照舊比 0.97。
 */
const NOT_APPLICABLE_ALLOWED = Object.freeze({
    pipeline: Object.freeze({ pipeline: Object.freeze(['saved_rate', 'gate_pass_rate', 'answer_agree_rate', 'verify_agree_rate']) })
});

// ─────────────────────────────────────────────────────────────
// 〔Owner 2026-10-03 第 r14 輪 C-2，docs/local-mode.md 10.27〕依向量模型的門檻覆寫
//
// 檢索類的指標（例：variant 的 retrieved_coverage）量的是「向量夠不夠近」，數字跟著向量模型走：
// 同一份 golden，gemini-embedding-001 與 ollama:qwen3-embedding:0.6b 的餘弦分佈不同，相似度下限也不同
// （config/similarityThresholds.js，Owner V5-5）。所以門檻可以依「這一輪 suite 實際用的向量模型」另設一組：
//
//   thresholds.json 的 <suite>.by_embed_model：
//     { "<EMBED_MODEL 完整字串>": { "<column>": { "<metric>": 門檻 } }, "_note…": "…" }
//
//   - 對不上任何一組（或這一輪沒記錄向量模型）＝套用基準門檻（<suite>.<column>），行為與沒有這一節時完全相同。
//   - 對上了＝只覆寫列出來的指標，其餘照基準門檻；覆寫值同樣「第一次量測 − 0.03、之後只升不降」。
//   - 模型字串照 EMBED_MODEL 的寫法比（前後空白不算、大小寫不分）；沒設 EMBED_MODEL 時 suite 記的是本機預設
//     （eval/lib/localMode.js 的 embedModelFromEnv，與 eval/lib/embeddings.js 讀向量檔用的是同一支）。
//   - 覆寫只接受 SUITE_METRICS 裡有的欄與指標、值必須是數字——拼錯就丟錯，不讓一組打錯字的覆寫靜默失效。
// ─────────────────────────────────────────────────────────────

const BY_EMBED_MODEL_KEY = 'by_embed_model';

/** 模型字串的比對形式（前後空白不算、大小寫不分） */
function normalizeEmbedModel(model) {
    return String(model ?? '').trim().toLowerCase();
}

/**
 * 找出某個向量模型在 <suite>.by_embed_model 裡的那一組（底線開頭的鍵是說明，不是模型）。
 * @param {object} section thresholds[suite]
 * @param {string|null|undefined} embedModel
 * @returns {{key:string, override:object}|null}
 */
function findEmbedOverride(section, embedModel) {
    const by = section && section[BY_EMBED_MODEL_KEY];
    const want = normalizeEmbedModel(embedModel);
    if (!by || typeof by !== 'object' || !want) return null;
    for (const [key, override] of Object.entries(by)) {
        if (key.startsWith('_')) continue;
        if (normalizeEmbedModel(key) === want) return { key, override };
    }
    return null;
}

/**
 * 檢查 <suite>.by_embed_model 的形狀：只能覆寫 SUITE_METRICS 裡的欄與指標，值是數字或 null（null＝這一組不設這個門檻）。
 * @param {string} suite
 * @param {object} section
 */
function validateEmbedOverrides(suite, section) {
    const spec = SUITE_METRICS[suite];
    const by = section && section[BY_EMBED_MODEL_KEY];
    if (!by) return;
    if (typeof by !== 'object' || Array.isArray(by)) throw new Error(`thresholds.json 的 ${suite}.${BY_EMBED_MODEL_KEY} 必須是物件`);
    for (const [key, override] of Object.entries(by)) {
        if (key.startsWith('_')) continue;
        if (!override || typeof override !== 'object') throw new Error(`${suite}.${BY_EMBED_MODEL_KEY}["${key}"] 必須是 { <欄>: { <指標>: 門檻 } }`);
        for (const [column, metricsOverride] of Object.entries(override)) {
            if (column.startsWith('_')) continue;
            if (!spec.columns.includes(column)) throw new Error(`${suite}.${BY_EMBED_MODEL_KEY}["${key}"] 的欄「${column}」不在 SUITE_METRICS.${suite}.columns`);
            for (const [metric, v] of Object.entries(metricsOverride || {})) {
                if (metric.startsWith('_')) continue;
                if (!spec.metrics.includes(metric)) throw new Error(`${suite}.${BY_EMBED_MODEL_KEY}["${key}"].${column} 的指標「${metric}」不在 SUITE_METRICS.${suite}.metrics`);
                if (v !== null && typeof v !== 'number') throw new Error(`${suite}.${BY_EMBED_MODEL_KEY}["${key}"].${column}.${metric} 必須是數字或 null`);
            }
        }
    }
}

/**
 * 這一輪實際套用的門檻：基準門檻再疊上「這個向量模型」的覆寫（沒有對上就是基準門檻本身）。
 * @param {object} thresholds 整份 thresholds.json
 * @param {string} suite
 * @param {{embedModel?:string|null}} [ctx] embedModel：suite 實際用的向量模型（variant 的 res.meta.embedModel）
 * @returns {{table:object, profile:null|{suite:string, embedModel:string|null, key:string|null, applied:boolean,
 *            overrides:Array<{metric:string, base:number|null, value:number|null}>, reason:string}}}
 *          profile 為 null＝這個 suite 沒有 by_embed_model（與改版前完全相同，不印門檻組）。
 */
function resolveSuiteThresholds(thresholds, suite, ctx = {}) {
    const spec = SUITE_METRICS[suite];
    if (!spec) throw new Error(`未知的 suite「${suite}」`);
    const section = (thresholds && thresholds[suite]) || null;
    if (!section || !section[BY_EMBED_MODEL_KEY]) return { table: thresholds, profile: null };
    validateEmbedOverrides(suite, section);

    const embedModel = (ctx && typeof ctx.embedModel === 'string' && ctx.embedModel.trim()) ? ctx.embedModel.trim() : null;
    const hit = findEmbedOverride(section, embedModel);
    if (!hit) {
        const reason = embedModel
            ? `向量模型 ${embedModel} 沒有專屬門檻，套用基準門檻（thresholds.json 的 ${suite}.${spec.columns.join('／')}）`
            : `這一輪沒有記錄向量模型，套用基準門檻（thresholds.json 的 ${suite}.${spec.columns.join('／')}）`;
        return { table: thresholds, profile: { suite, embedModel, key: null, applied: false, overrides: [], reason } };
    }

    const merged = { ...section };
    const overrides = [];
    for (const column of spec.columns) {
        const o = hit.override[column];
        if (!o) continue;
        const base = section[column] || {};
        const next = { ...base };
        for (const metric of spec.metrics) {
            if (!(metric in o)) continue;
            next[metric] = o[metric];
            overrides.push({ metric: `${column}.${metric}`, base: typeof base[metric] === 'number' ? base[metric] : null, value: o[metric] });
        }
        merged[column] = next;
    }
    const why = typeof hit.override._note === 'string' ? `；${hit.override._note}` : '';
    const reason = `向量模型 ${embedModel} 套用專屬門檻（thresholds.json 的 ${suite}.${BY_EMBED_MODEL_KEY}["${hit.key}"]）：` +
        (overrides.length ? overrides.map(o => `${o.metric} ${o.base ?? '（無）'} → ${o.value ?? '（無）'}`).join('、') : '沒有覆寫任何指標') +
        '；其餘指標照基準門檻' + why;
    return { table: { ...thresholds, [suite]: merged }, profile: { suite, embedModel, key: hit.key, applied: true, overrides, reason } };
}

/**
 * 通用的門檻比對。
 * @param {object} thresholds  整份 thresholds.json
 * @param {string} suite       'retrieval'|'classify'|'pipeline'
 * @param {object} measured    { <column>: { <metric>: number|null } | null }
 * @param {{notApplicable?:Record<string,Record<string,string>>, embedModel?:string|null}} [opts]
 *        notApplicable：{ <column>: { <metric>: 原因 } }——只接受 NOT_APPLICABLE_ALLOWED 裡的組合，其餘丟錯
 *        embedModel：〔Owner 2026-10-03 第 r14 輪 C-2〕suite 實際用的向量模型；<suite>.by_embed_model 有這個模型就疊上它的門檻
 * @returns {{failures:string[], checked:number, skipped:string[], profile:object|null}}
 *          profile：套用了哪一組門檻、為什麼（resolveSuiteThresholds；suite 沒有 by_embed_model 時是 null）
 */
function compareSuite(thresholds, suite, measured, opts = {}) {
    const spec = SUITE_METRICS[suite];
    if (!spec) throw new Error(`未知的 suite「${suite}」`);
    const failures = [];
    const skipped = [];
    let checked = 0;
    const resolved = resolveSuiteThresholds(thresholds, suite, { embedModel: opts && opts.embedModel });
    const table = (resolved.table && resolved.table[suite]) || {};
    const na = (opts && opts.notApplicable) || {};
    for (const [column, metricsNa] of Object.entries(na)) {
        for (const metric of Object.keys(metricsNa || {})) {
            const allowed = ((NOT_APPLICABLE_ALLOWED[suite] || {})[column] || []).includes(metric);
            if (!allowed) throw new Error(`${suite}.${column}.${metric} 不在「可以不比門檻」的白名單（eval/lib/thresholds.js 的 NOT_APPLICABLE_ALLOWED）`);
        }
    }

    for (const column of spec.columns) {
        const want = table[column];
        const got = measured[column];
        // 「這一欄的門檻全是 null」＝ 還沒有基準線，與「整個欄位不存在」同義。
        // 少了這一條，thresholds.json 裡預先擺好的 {accuracy:null, macro_f1:null} 會被
        // 當成「門檻已存在」，然後對一輪 n/a 的量測報失敗——那是骨架階段的常態，不是退步。
        const hasNumber = want && spec.metrics.some(m => typeof want[m] === 'number');
        if (!hasNumber) { skipped.push(`${column}（門檻尚未建立）`); continue; }
        if (!got) { failures.push(`${column}：門檻已存在但這次沒有量到任何數字`); continue; }
        for (const metric of spec.metrics) {
            if (want[metric] === null || want[metric] === undefined) continue;
            const naReason = na[column] && na[column][metric];
            if (naReason) { skipped.push(`${column}.${metric}（${naReason}）`); continue; }
            checked++;
            const v = got[metric];
            if (v === null || v === undefined) {
                // 門檻有數字卻量不到 = 失敗。否則「cassette 被誤刪」會表現成 CI 全綠。
                failures.push(`${column}.${metric}：門檻 ${want[metric]} 但這次是 n/a`);
            } else if (v + 1e-9 < want[metric]) {
                failures.push(`${column}.${metric}：${v.toFixed(4)} < 門檻 ${want[metric]}`);
            }
        }
    }
    return { failures, checked, skipped, profile: resolved.profile };
}

/**
 * 通用的 ratchet 寫入。
 * @param {object} opts
 * @param {string} opts.suite
 * @param {object} opts.measured
 * @param {string} [opts.file]
 * @param {object} [opts.meta]     寫進 <suite>._measured_with
 * @param {string|null} [opts.embedModel] 〔Owner 2026-10-03 第 r14 輪 C-2〕suite 實際用的向量模型：<suite>.by_embed_model 有這個模型時，
 *        **它覆寫的指標寫回那一組**（不拿本機向量的數字去動 Gemini 的基準門檻，反之亦然），meta 寫進
 *        _<suite>_measured_with.byEmbedModel[模型]；其餘指標照舊寫基準門檻。
 * @returns {{written:boolean, changes:string[], kept:string[]}}
 */
function writeBaselineSuite(opts) {
    const spec = SUITE_METRICS[opts.suite];
    if (!spec) throw new Error(`未知的 suite「${opts.suite}」`);
    const target = path.resolve(opts.file || DEFAULT_PATH);
    const current = loadThresholds(target);
    current[opts.suite] = current[opts.suite] || {};
    validateEmbedOverrides(opts.suite, current[opts.suite]);
    const hit = findEmbedOverride(current[opts.suite], opts.embedModel);

    const changes = [];
    const kept = [];
    for (const column of spec.columns) {
        const got = opts.measured[column];
        if (!got) { kept.push(`${column}：這次沒有量到，維持原狀`); continue; }
        const existing = current[opts.suite][column] || null;
        const next = {};
        // 這個向量模型的覆寫（有對上才有）：它列出的指標寫回覆寫那一組
        const ov = hit && hit.override[column] ? { ...hit.override[column] } : null;
        for (const metric of spec.metrics) {
            const v = got[metric];
            const toOverride = ov !== null && metric in ov;
            const label = toOverride ? `${opts.suite}.${BY_EMBED_MODEL_KEY}["${hit.key}"].${column}.${metric}` : `${opts.suite}.${column}.${metric}`;
            if (v === null || v === undefined) { next[metric] = existing ? existing[metric] : null; continue; }
            const candidate = Math.max(0, Math.round((v - BASELINE_MARGIN) * 10000) / 10000);
            const old = toOverride ? ov[metric] : (existing ? existing[metric] : null);
            let value;
            if (old === null || old === undefined) {
                value = candidate;
                changes.push(`${label}：（無）→ ${candidate}`);
            } else if (candidate > old) {
                value = candidate;
                changes.push(`${label}：${old} → ${candidate}（ratchet 調高）`);
            } else {
                value = old;
                kept.push(`${label}：維持 ${old}（新量測 −${BASELINE_MARGIN} 後為 ${candidate}）`);
            }
            if (toOverride) { ov[metric] = value; next[metric] = existing ? existing[metric] : null; }
            else next[metric] = value;
        }
        current[opts.suite][column] = next;
        if (ov) hit.override[column] = ov;
    }

    const measuredKey = `_${opts.suite}_measured_with`;
    if (opts.meta && hit) {
        // 對上覆寫：量測環境記在那個模型底下，基準門檻的量測環境不動
        const prev = current[measuredKey] || {};
        current[measuredKey] = { ...prev, byEmbedModel: { ...(prev.byEmbedModel || {}), [hit.key]: opts.meta } };
    } else if (opts.meta) {
        // 基準門檻：照舊整份換掉，但保留各向量模型的量測環境（那幾組門檻沒有被這一次寫入）
        const prevBy = current[measuredKey] && current[measuredKey].byEmbedModel;
        current[measuredKey] = prevBy ? { ...opts.meta, byEmbedModel: prevBy } : opts.meta;
    }
    if (changes.length === 0) return { written: false, changes, kept };
    fs.writeFileSync(target, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return { written: true, changes, kept };
}

module.exports = {
    loadThresholds, compare, writeBaseline, DEFAULT_PATH, BASELINE_MARGIN,
    compareSuite, writeBaselineSuite, SUITE_METRICS,
    NOT_APPLICABLE_ALLOWED,  // 〔Owner 第五輪 D-2〕
    resolveSuiteThresholds, BY_EMBED_MODEL_KEY   // 〔Owner 2026-10-03 第 r14 輪 C-2〕
};
