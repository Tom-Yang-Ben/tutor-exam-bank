// ─────────────────────────────────────────────────────────────
// eval/lib/report2.js — 階段 2 兩個 suite 的報表（A-T14）
//
// 三個出口與階段 1 的 eval/lib/report.js 完全一致：
//   終端機 Markdown 表 → eval/reports/<suite>-<日期>-<sha>.json → $GITHUB_STEP_SUMMARY。
// 不自動寫進 README（規劃 §5.6.7），趨勢由 eval/trend.js 印差值。
//
// 與階段 1 一樣，**報表一定要帶量測環境**：agent 來源、狀態機來源、LLM 模式、cassette 目錄、
// golden 是否還有待人工確認。缺這幾欄的數字不能拿來互相比較——
// 階段 2 尤其危險，因為「用 stub 跑」與「用真 agent 跑」的數字長得一模一樣。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { shortSha, today, REPORT_DIR } = require('./report');
const { round4 } = require('./metrics');

/** @param {number|null} v @returns {string} */
function cell(v) {
    if (v === null || v === undefined) return 'n/a';
    if (typeof v !== 'number') return String(v);
    return Number.isInteger(v) ? String(v) : round4(v).toFixed(4);
}

/** classify suite 的 Markdown */
function markdownClassify(res) {
    const m = res.measured.classify;
    const lines = [
        '',
        '## 章節分類 eval（`--suite classify`）',
        '',
        '| 指標 | 值 | 說明 |',
        '|---|---:|---|',
        `| accuracy | ${cell(m && m.accuracy)} | 整體對幾題（${m ? `${m.correct}/${m.n}` : '—'}） |`,
        `| macro-F1 | ${cell(m && m.macro_f1)} | 每章各算 F1 再平均，稀有章節與大宗章節等重 |`,
        ''
    ];

    if (res.bySource && Object.keys(res.bySource).length) {
        lines.push('| 分段 | accuracy |', '|---|---:|');
        const label = {
            fixture: 'fixture 題（60，乾淨輸入）',
            drift: '漂移變體（30）',
            stem_rewrite: '　└ 同題幹改寫（15）',
            chapter_synonym: '　└ 章節名同義詞（15）'
        };
        for (const [k, v] of Object.entries(res.bySource)) {
            lines.push(`| ${label[k] || k} | ${cell(v)} |`);
        }
        lines.push('');
    }

    lines.push('**Top-5 混淆對**（正解 → 預測，出現最多次的組合）：', '');
    if (!res.confusion || res.confusion.length === 0) {
        lines.push('（這一輪沒有量到分類結果，或完全沒有混淆）', '');
    } else {
        lines.push('| 正解 | 預測 | 次數 |', '|---|---|---:|');
        for (const c of res.confusion) lines.push(`| ${c.gold} | ${c.pred} | ${c.count} |`);
        lines.push('');
    }

    lines.push(
        `- decoy 命中：${res.decoyHits === null ? 'n/a' : res.decoyHits} 筆的預測值剛好等於 golden 預先寫下的「最可能漂到的章節」` +
        `（golden 共 ${res.decoyTotal} 筆有 decoy，其中 ${res.decoyInWhitelist} 筆的 decoy 本身也在白名單內——` +
        '那幾筆 `isValidChapter` 擋不住，只有第二層 LLM 判得出來)',
        `- classify 來源：gate ${res.sourceCounts.gate} 筆、llm ${res.sourceCounts.llm} 筆` +
        '（本 suite 刻意把 chapter_confidence 設成 0 強迫走第二層，gate 應為 0）'
    );
    return lines.join('\n');
}

/** pipeline suite 的 Markdown */
function markdownPipeline(res) {
    // measured.pipeline 為 null = 這一輪根本沒跑起來（例如 replay miss）。
    // 用一組全 null 的替身讓報表照常印出來——report 的價值在這種時候最高，
    // 因為 meta 會告訴你是哪個 agent、哪支 cassette 出的問題。
    const m = res.measured.pipeline || { saved_rate: null, gate_pass_rate: null, answer_agree_rate: null, n: 0 };
    const c = res.counts;
    const lines = [
        '',
        '## 管線 eval（`--suite pipeline`）',
        '',
        `對 \`${res.meta.pdf}\`（${res.meta.questionsExpected} 題）以 \`LLM_MODE=${res.meta.llmMode}\` 跑完整條管線。`,
        '',
        '### 各節點通過率',
        '',
        '| 節點 | 呼叫 | pass | fail | error | skipped | 通過率 | p50 ms | p95 ms |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    ];
    for (const [node, s] of Object.entries(res.nodes)) {
        lines.push(`| ${node} | ${s.calls} | ${s.pass} | ${s.fail} | ${s.error} | ${s.skipped} | ${cell(s.pass_rate)} | ${s.p50_ms} | ${s.p95_ms} |`);
    }
    lines.push('', '> 通過率的分母是 `pass + fail + error`，**不含 skipped**——證明題的 verify 與未就緒的 dedup1 本來就該跳過，把它算成「沒通過」會讓數字失去意義。', '');

    lines.push('### 結果分佈', '',
        `- 已入庫 ${c.saved}／待複核 ${c.needs_review}／不採用 ${c.rejected}／未完成 ${c.pending}（共 ${c.total} 題）`,
        `- saved_rate：${cell(m.saved_rate)}　classify 零成本閘門通過率：${cell(m.gate_pass_rate)}　answer_agree_rate：${cell(m.answer_agree_rate)}`,
        '');

    lines.push('**needs_review 原因分佈**：', '');
    if (!res.reviewReasons || res.reviewReasons.length === 0) {
        lines.push('（這一輪沒有題目進複核佇列）', '');
    } else {
        lines.push('| 原因 | 題數 |', '|---|---:|');
        for (const r of res.reviewReasons) lines.push(`| ${r.key} | ${r.count} |`);
        lines.push('');
    }

    lines.push('### 每份成本', '',
        '| token_in | token_out（candidates） | thinking | token_out（計費） | cost_usd | 總延遲 ms |',
        '|---:|---:|---:|---:|---:|---:|',
        `| ${res.cost.token_in} | ${res.cost.token_out} | ${res.cost.token_thinking} | ${res.cost.token_out_billed} | ${cell(res.cost.cost_usd)} | ${res.cost.latency_ms} |`,
        '',
        '> 計費的 token_out **一定**是 `candidatesTokenCount + thoughtsTokenCount`（interfaces-stage2.md 第 0.4 條）；漏算 thinking 會系統性低估成本兩到五倍。',
        '');

    lines.push(`- agent 來源：${JSON.stringify(res.meta.agentSources)}`);
    lines.push(`- 狀態機：\`${res.meta.stateMachine}\`　ctx.db：${res.meta.db}`);
    return lines.join('\n');
}

/**
 * 輸出報表。
 * @param {object} opts
 * @param {object} opts.res     suite 的回傳
 * @param {string} [opts.dir]
 * @param {boolean} [opts.private]
 * @returns {{file:string, doc:object}}
 */
function emit(opts) {
    const res = opts.res;
    const md = (res.suite === 'classify' ? markdownClassify(res) : markdownPipeline(res)) + '\n' +
        [
            `- golden／答案卷：${res.meta.golden || res.meta.pdfSha256 || '—'}` +
            (res.meta.goldenPending ? `（其中 ${res.meta.goldenPending} 筆仍是 needs_human_confirm 草稿）` : ''),
            `- 轉接層：${JSON.stringify(res.meta.sources)}`,
            `- cassette 目錄：\`${res.meta.cassetteDir}\``,
            ...[...new Set(res.warnings || [])].map(w => `- ⚠️ ${w}`)
        ].join('\n') + '\n';

    console.log(md);

    const dir = path.resolve(opts.dir || REPORT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${res.suite}-${today()}-${shortSha()}.json`);
    const doc = {
        generated_at: new Date().toISOString(),
        suite: res.suite,
        meta: res.meta,
        measured: res.measured,
        warnings: [...new Set(res.warnings || [])],
        // 私有層一律不寫逐題明細（規劃 §5.3.2）
        detail: opts.private ? null : {
            confusion: res.confusion || null,
            by_source: res.bySource || null,
            per_class: res.perClass || null,
            per_entry: res.perEntry || null,
            nodes: res.nodes || null,
            review_reasons: res.reviewReasons || null,
            counts: res.counts || null,
            cost: res.cost || null,
            per_question: res.perQuestion || null
        }
    };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`報表已寫入 ${file}`);

    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md, 'utf8');
    }
    return { file, doc };
}

module.exports = { emit, markdownClassify, markdownPipeline, cell };
