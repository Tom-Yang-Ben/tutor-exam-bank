// ─────────────────────────────────────────────────────────────
// services/studentReportService.js — 學習報告（〔dec/r16-remedial〕；docs/student-report.md）
//
//   GET /api/students/:id/report?days=&audience=teacher|parent&format=json|html|docx
//
// 確定性的結構化報告，**不呼叫 LLM**：同一份資料、同一天產生的報告逐字相同。內容：
//   期間與批改量、最弱的章節（含 low_sample）、錯因分布、每週趨勢、錯題重練成效（FEATURE_RETRAIN）、
//   補救成效摘要（FEATURE_REMEDIAL）、依規則產生的建議（buildSuggestions）。
//
// 兩種讀者：
//   teacher  給老師：保留內部代碼（錯因代碼、建議代碼、錯誤率、樣本不足旗標），建議寫「該做什麼」。
//   parent   給家長：白話、不出現內部代碼（沒有錯因代碼、建議代碼、題號、知識點代碼、low_sample 之類的鍵），
//            數字用「10 題錯 6 題」的寫法，建議寫「接下來會怎麼加強」。
//
// 學生姓名會出現在報告裡（報告留在本機）；不送進任何 LLM、不寫 log。
// 弱點、錯因、趨勢沿用弱點面板的查詢（services/weaknessService.js；只算每題第一次作答，R10），
// 重練成效沿用 services/retrainStatsService.js，補救成效沿用 services/remedialEffectService.js。
//
// 純函式（buildSuggestions、assembleReport、renderReportHtml、parentView）由 test/unit/studentReport.test.js 釘住；
// I/O 的 loadStudentReport 由 test/integration/studentReport.pg.test.js 驗。
// ─────────────────────────────────────────────────────────────
'use strict';

const weakness = require('./weaknessService');
const { labelOf } = require('../config/errorTypes');
const { ERROR_STRATEGIES } = require('../config/remedialErrorStrategy');

const AUDIENCES = Object.freeze(['teacher', 'parent']);
const FORMATS = Object.freeze(['json', 'html', 'docx']);
const DEFAULT_DAYS = 30;

/** 最弱章節最多列幾章。 */
const MAX_WEAK_CHAPTERS = 5;
/** 錯誤率到這個值（且樣本夠）才建議補救。 */
const WEAK_RATE = 0.4;
/** 錯因主因：至少幾次、占錯題比例至少多少（同 config/remedialErrorStrategy.js 的兩個門檻）。 */
const DOMINANT_MIN_COUNT = 2;
const DOMINANT_MIN_SHARE = 0.4;
/** 趨勢：每週至少批改幾題才算；最近一週比之前的平均高（低）多少算進步（退步）。 */
const TREND_MIN_GRADED = 3;
const TREND_DELTA = 0.10;
/** 建議最多幾條。 */
const MAX_SUGGESTIONS = 6;

/** 給家長看的錯因說法（白話；不出現代碼）。 */
const PARENT_ERROR_TEXT = Object.freeze({
    concept: '有些觀念還不夠清楚，接下來會先用基本題把觀念講清楚。',
    method: '有時候不知道該用哪一種方法解題，接下來會多練完整的解題過程。',
    calc: '計算時容易出錯，建議平時多練習，算完再檢查一次。',
    reading: '讀題不夠仔細，建議讀題時把條件圈起來再下筆。',
    unit: '單位或有效數字常被忽略，作答時要留意。',
    formula: '有些公式還記不熟，接下來會用基本題把公式記牢。',
    careless: '常因為粗心抄錯，建議寫完養成檢查的習慣。',
    blank: '有些題目沒有作答，接下來會先從比較有把握的題目建立信心。',
    time: '寫題時間不太夠，接下來會多練基本題的速度。',
    chem_equation: '化學式或係數常出錯，接下來會多練習寫與配平反應式。'
});

const STATUS_LABEL = Object.freeze({
    improved: '進步', no_change: '持平', worse: '退步', insufficient_data: '資料不足', pending: '還沒批改完'
});

const pct = r => (r === null || r === undefined ? '—' : `${Math.round(Number(r) * 100)}%`);
const round4 = x => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10000) / 10000);
const n = x => Number(x) || 0;

// ───────────────────────── 純函式：建議 ─────────────────────────

/**
 * 依規則產生建議（純函式；順序固定：沒有資料 → 弱章節 → 錯因主因 → 趨勢 → 重練 → 補救成效 → 樣本不足）。
 *
 * @param {object} r assembleReport 組好的報告（teacher 形狀）
 * @returns {Array<{code:string, teacher:string, parent:string|null}>} parent 為 null＝家長版不列這一條
 */
function buildSuggestions(r) {
    const out = [];
    if (n(r.summary.graded) === 0) {
        out.push({ code: 'no_data', teacher: `近 ${r.period.days} 天沒有批改紀錄：先批改最近的卷，報告才有內容。`, parent: '這段期間還沒有批改完成的練習，下次報告會補上。' });
        return out;
    }
    const weak = r.weakest_chapters.filter(c => !c.low_sample && c.wrong_rate !== null && c.wrong_rate >= WEAK_RATE);
    for (const c of weak.slice(0, 2)) {
        out.push({
            code: 'weak_chapter',
            teacher: `「${c.chapter}」錯誤率 ${pct(c.wrong_rate)}（批改 ${c.graded} 題、錯 ${c.wrong} 題）：建議用「依弱點出補救卷」出一份補救卷。`,
            parent: `「${c.chapter}」這個單元還不太穩（${c.graded} 題錯 ${c.wrong} 題），接下來會加強練習。`
        });
    }
    const top = r.error_types[0];
    if (top && top.count >= DOMINANT_MIN_COUNT && top.share !== null && top.share >= DOMINANT_MIN_SHARE
        && (r.error_types.length < 2 || r.error_types[1].count < top.count)) {
        const s = ERROR_STRATEGIES[top.code];
        out.push({
            code: `error_focus:${top.code}`,
            teacher: `錯題中「${top.label}」最多（${top.count} 題，占錯題 ${pct(top.share)}）${s ? `：${s.rationale}補救卷會${s.summary}。` : '。'}`,
            parent: PARENT_ERROR_TEXT[top.code] || null
        });
    }
    const weeks = r.weekly_trend.filter(w => n(w.graded) >= TREND_MIN_GRADED);
    if (weeks.length >= 2) {
        const last = weeks[weeks.length - 1];
        const prev = weeks.slice(0, -1);
        const prevRate = prev.reduce((s, w) => s + n(w.graded) - n(w.wrong), 0) / prev.reduce((s, w) => s + n(w.graded), 0);
        const lastRate = (n(last.graded) - n(last.wrong)) / n(last.graded);
        if (lastRate - prevRate >= TREND_DELTA - 1e-9) {
            out.push({ code: 'trend_up', teacher: `最近一週答對率 ${pct(lastRate)}，比之前的 ${pct(prevRate)} 高：目前的安排有效，可以維持。`, parent: '最近一週的答對率比之前高，有在進步。' });
        } else if (lastRate - prevRate <= -TREND_DELTA + 1e-9) {
            out.push({ code: 'trend_down', teacher: `最近一週答對率 ${pct(lastRate)}，比之前的 ${pct(prevRate)} 低：看看是不是新單元太快，或該週的題目偏難。`, parent: '最近一週的答對率比之前低一些，可能是進入新單元，會再多留意。' });
        }
    }
    if (r.retrain) {
        if (n(r.retrain.stuck) > 0) {
            out.push({ code: 'retrain_stuck', teacher: `錯題重練有 ${r.retrain.stuck} 題一直錯（卡關）：建議換個方式講解，或移出清單改用變式題。`, parent: '有幾題反覆練習仍不熟，接下來會換個方式說明。' });
        }
        if (n(r.retrain.due_now) > 0) {
            out.push({ code: 'retrain_due', teacher: `有 ${r.retrain.due_now} 題錯題重練已經到期：下次出卷可以附上（組卷或補救卷的「附上到期重練」）。`, parent: null });
        }
    }
    if (r.remedial_effect) {
        const improved = r.remedial_effect.units.filter(u => u.status === 'improved').map(u => u.name);
        const worse = r.remedial_effect.units.filter(u => u.status === 'worse').map(u => u.name);
        if (improved.length) {
            out.push({ code: 'remedial_improved', teacher: `補救有效：${improved.map(x => `「${x}」`).join('、')}的答對率比補救前高。`, parent: `之前加強的${improved.map(x => `「${x}」`).join('、')}已經有進步。` });
        }
        if (worse.length) {
            out.push({ code: 'remedial_worse', teacher: `${worse.map(x => `「${x}」`).join('、')}補救後答對率反而下降：建議回頭檢查先備觀念，或換題型再練。`, parent: `${worse.map(x => `「${x}」`).join('、')}還需要再加強，會調整練習方式。` });
        }
    }
    const thin = r.weakest_chapters.filter(c => c.low_sample && n(c.wrong) > 0);
    if (thin.length) {
        out.push({ code: 'need_more_data', teacher: `${thin.slice(0, 3).map(c => `「${c.chapter}」`).join('、')}批改的題還少（不到 ${r.min_n} 題），錯誤率只供參考，先多練幾題再判斷。`, parent: null });
    }
    return out.slice(0, MAX_SUGGESTIONS);
}

// ───────────────────────── 純函式：組裝 ─────────────────────────

/**
 * 原始查詢結果 → 報告（純函式；teacher 形狀，parentView 再轉成家長版）。
 *
 * @param {object} raw
 * @param {{id:number, name:string}} raw.student
 * @param {number} raw.days
 * @param {string} raw.today 'YYYY-MM-DD'
 * @param {string} raw.from  'YYYY-MM-DD'
 * @param {number} raw.minN WEAKNESS_MIN_N
 * @param {{assigned:number, graded:number, correct:number, papers:number}} raw.summary
 * @param {object[]} raw.byChapter    weaknessService.buildByChapter 的列（已依錯誤率由高到低）
 * @param {object[]} raw.byErrorType  weaknessService.buildByErrorType 的列
 * @param {object[]} raw.trend        weaknessService.buildTrendWeekly 的列
 * @param {object|null} raw.retrain   retrainStatsService.stats 的回應；null＝沒開或沒有資料
 * @param {object|null} raw.remedial  remedialEffectService.loadRemedialEffect 的回應；null＝沒開
 * @returns {object}
 */
function assembleReport(raw) {
    const graded = n(raw.summary.graded);
    const report = {
        student: { id: raw.student.id, name: raw.student.name },
        audience: 'teacher',
        generated_on: raw.today,
        period: { days: raw.days, from: raw.from, to: raw.today },
        min_n: raw.minN,
        summary: {
            papers: n(raw.summary.papers),
            assigned: n(raw.summary.assigned),
            graded,
            correct: round4(raw.summary.correct) ?? 0,
            correct_rate: graded > 0 ? round4(n(raw.summary.correct) / graded) : null
        },
        weakest_chapters: (raw.byChapter || [])
            .filter(c => n(c.graded) > 0)
            .slice(0, MAX_WEAK_CHAPTERS)
            .map(c => ({ chapter: c.chapter, graded: n(c.graded), wrong: n(c.wrong), wrong_rate: c.wrong_rate === null ? null : Number(c.wrong_rate), low_sample: n(c.graded) < raw.minN })),
        error_types: (raw.byErrorType || []).map(e => ({ code: e.error_type, label: labelOf(e.error_type) || e.error_type, count: n(e.count), share: e.share === null ? null : Number(e.share) })),
        weekly_trend: (raw.trend || []).map(w => ({
            week_start: w.week_start, graded: n(w.graded), wrong: n(w.wrong),
            correct_rate: n(w.graded) > 0 ? round4((n(w.graded) - n(w.wrong)) / n(w.graded)) : null
        })),
        retrain: raw.retrain ? {
            active: n(raw.retrain.active), mastered: n(raw.retrain.mastered), stuck: n(raw.retrain.stuck),
            first_retrain: raw.retrain.first_retrain, spaced: raw.retrain.spaced, due_now: n(raw.retrain.backlog?.due_now)
        } : null,
        remedial_effect: raw.remedial ? summarizeEffect(raw.remedial) : null
    };
    report.suggestions = buildSuggestions(report).map(s => ({ code: s.code, text: s.teacher, parent_text: s.parent }));
    return report;
}

/** 補救成效 → 報告用的摘要（每份補救卷的補救單位攤平，同一個單位取最新的一份）。 */
function summarizeEffect(effect) {
    const counts = { improved: 0, no_change: 0, worse: 0, insufficient_data: 0, pending: 0 };
    const seen = new Set();
    const units = [];
    for (const p of effect.papers || []) {
        for (const t of p.targets || []) {
            const key = t.unit_type === 'kc' ? `kc|${t.kc_id}` : `chapter|${t.chapter}`;
            if (seen.has(key)) continue;     // papers 新到舊：每個單位只看最新那一份
            seen.add(key);
            counts[t.status] = (counts[t.status] || 0) + 1;
            units.push({ name: t.name, status: t.status, before_rate: t.before?.correct_rate ?? null, after_rate: t.after?.rate ?? null, after_graded: t.after?.graded ?? 0, low_sample: Boolean(t.low_sample) });
        }
    }
    return { papers: (effect.papers || []).length, counts, units };
}

/**
 * 家長版（純函式）：拿掉內部代碼與統計旗標，數字留可以白話說明的。
 * @param {object} r assembleReport 的輸出
 * @returns {object}
 */
function parentView(r) {
    return {
        student: { name: r.student.name },
        audience: 'parent',
        generated_on: r.generated_on,
        period: r.period,
        summary: { papers: r.summary.papers, graded: r.summary.graded, correct_rate: r.summary.correct_rate },
        weakest_chapters: r.weakest_chapters.map(c => ({ chapter: c.chapter, graded: c.graded, wrong: c.wrong })),
        error_types: r.error_types.map(e => ({ label: e.label, count: e.count })),
        weekly_trend: r.weekly_trend.map(w => ({ week_start: w.week_start, graded: w.graded, correct_rate: w.correct_rate })),
        retrain: r.retrain ? { practicing: r.retrain.active, mastered: r.retrain.mastered } : null,
        remedial_effect: r.remedial_effect
            ? { units: r.remedial_effect.units.filter(u => u.status !== 'pending').map(u => ({ name: u.name, result: STATUS_LABEL[u.status] })) }
            : null,
        suggestions: r.suggestions.filter(s => s.parent_text).map(s => ({ text: s.parent_text }))
    };
}

/**
 * 依讀者輸出（純函式）。teacher 版的建議不帶 parent_text。
 * @param {object} r assembleReport 的輸出
 * @param {'teacher'|'parent'} audience
 */
function forAudience(r, audience) {
    if (audience === 'parent') return parentView(r);
    return { ...r, suggestions: r.suggestions.map(s => ({ code: s.code, text: s.text })) };
}

// ───────────────────────── 純函式：HTML（列印用）─────────────────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

/**
 * 報告 → 可列印的完整 HTML（純函式；只用內嵌樣式，不連外部資源；所有資料都經過跳脫）。
 * @param {object} v forAudience 的輸出
 * @returns {string}
 */
function renderReportHtml(v) {
    const parent = v.audience === 'parent';
    const title = `${parent ? '給家長的學習報告' : '學習報告（老師版）'}－${v.student.name}`;
    const rows = (cells, tag = 'td') => `<tr>${cells.map(c => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`;
    const table = (head, body) => `<table><thead>${rows(head, 'th')}</thead><tbody>${body.map(b => rows(b)).join('')}</tbody></table>`;
    const parts = [];
    parts.push(`<h1>${esc(title)}</h1>`);
    parts.push(`<p class="meta">期間：${esc(v.period.from)} ～ ${esc(v.period.to)}（近 ${esc(v.period.days)} 天）　產生日期：${esc(v.generated_on)}</p>`);
    const s = v.summary;
    parts.push(`<h2>${parent ? '練習概況' : '批改量'}</h2><p>${parent
        ? `這段期間寫了 ${esc(s.papers)} 份卷，批改完成 ${esc(s.graded)} 題，答對率 ${esc(pct(s.correct_rate))}。`
        : `卷 ${esc(s.papers)} 份、派題 ${esc(s.assigned)} 題、已批改 ${esc(s.graded)} 題、答對 ${esc(s.correct)}（答對率 ${esc(pct(s.correct_rate))}）。只算每題第一次作答。`}</p>`);
    parts.push(`<h2>${parent ? '需要加強的單元' : '最弱的章節'}</h2>`);
    parts.push(v.weakest_chapters.length === 0 ? '<p>這段期間沒有批改紀錄。</p>' : (parent
        ? table(['單元', '批改題數', '錯的題數'], v.weakest_chapters.map(c => [c.chapter, c.graded, c.wrong]))
        : table(['章節', '批改', '錯', '錯誤率', '備註'], v.weakest_chapters.map(c => [c.chapter, c.graded, c.wrong, pct(c.wrong_rate), c.low_sample ? '樣本不足' : '']))));
    if (v.error_types.length) {
        parts.push(`<h2>${parent ? '常見的錯誤類型' : '錯因分布'}</h2>`);
        parts.push(parent
            ? table(['類型', '次數'], v.error_types.map(e => [e.label, e.count]))
            : table(['錯因', '代碼', '次數', '占錯題'], v.error_types.map(e => [e.label, e.code, e.count, pct(e.share)])));
    }
    if (v.weekly_trend.length) {
        parts.push(`<h2>每週趨勢</h2>`);
        parts.push(table(['週（週一）', '批改', '答對率'], v.weekly_trend.map(w => [w.week_start, w.graded, pct(w.correct_rate)])));
    }
    if (v.retrain) {
        parts.push(`<h2>${parent ? '錯題再練習' : '錯題重練'}</h2><p>${parent
            ? `正在反覆練習的錯題 ${esc(v.retrain.practicing)} 題，已經練會 ${esc(v.retrain.mastered)} 題。`
            : `進行中 ${esc(v.retrain.active)} 題、練到會 ${esc(v.retrain.mastered)} 題、卡關 ${esc(v.retrain.stuck)} 題、到期 ${esc(v.retrain.due_now)} 題；重練答對率 ${esc(pct(v.retrain.first_retrain?.rate))}、隔週回測答對率 ${esc(pct(v.retrain.spaced?.rate))}。`}</p>`);
    }
    if (v.remedial_effect && v.remedial_effect.units.length) {
        parts.push(`<h2>${parent ? '加強練習的成果' : '補救成效'}</h2>`);
        parts.push(parent
            ? table(['單元', '結果'], v.remedial_effect.units.map(u => [u.name, u.result]))
            : table(['單位', '狀態', '補救前', '之後', '之後批改'], v.remedial_effect.units.map(u => [u.name, STATUS_LABEL[u.status] || u.status, pct(u.before_rate), pct(u.after_rate), `${u.after_graded}${u.low_sample ? '（樣本少）' : ''}`])));
    }
    parts.push(`<h2>${parent ? '接下來的安排' : '建議'}</h2>`);
    parts.push(v.suggestions.length ? `<ul>${v.suggestions.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul>` : '<p>目前沒有特別的建議。</p>');
    const css = 'body{font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif;color:#1e293b;margin:24px;line-height:1.6}'
        + 'h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 6px;border-bottom:1px solid #cbd5e1}'
        + '.meta{color:#64748b;font-size:12px}table{border-collapse:collapse;width:100%;font-size:13px}'
        + 'th,td{border:1px solid #cbd5e1;padding:4px 8px;text-align:left}th{background:#f1f5f9}'
        + '@media print{body{margin:0}button{display:none}}';
    return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head>`
        + `<body>${parts.join('\n')}</body></html>`;
}

// ───────────────────────── I/O ─────────────────────────

/** 本地時區的今天與 n 天前（'YYYY-MM-DD'；與重練的 todayLocal 同一種算法）。 */
function localDay(offsetDays = 0, now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 時間窗內的批改量（只算每題第一次作答：檢視 attempts；$1 studentId、$2 days）。 */
function buildSummaryQuery({ studentId, days }) {
    return {
        text: `SELECT COUNT(*)::int AS assigned,
       COUNT(*) FILTER (WHERE a.result IS NOT NULL)::int AS graded,
       COALESCE(SUM(COALESCE(a.score::float8, a.result::float8)) FILTER (WHERE a.result IS NOT NULL), 0)::float8 AS correct,
       COUNT(DISTINCT a.paper_id)::int AS papers
  FROM attempts a
 WHERE a.student_id = $1 AND a.assigned_at >= CURRENT_DATE - $2::int`,
        values: [studentId, days]
    };
}

/**
 * 讀出某生的學習報告（teacher 形狀；呼叫端再 forAudience）。
 * @param {{studentId:number, days:number, minN:number, retrainOn:boolean, remedialOn:boolean}} p
 * @param {{query:Function}} deps
 * @returns {Promise<object|null>} 學生不存在回 null
 */
async function loadStudentReport({ studentId, days, minN, retrainOn, remedialOn }, deps) {
    const { rows: [student] } = await deps.query('SELECT id, name FROM students WHERE id = $1', [studentId]);
    if (!student) return null;
    const opts = { studentId, subject: null, days };
    const sq = buildSummaryQuery({ studentId, days });
    const [summary, chapter, errorType, trend] = await Promise.all([
        sq, weakness.buildByChapter(opts), weakness.buildByErrorType(opts), weakness.buildTrendWeekly(opts)
    ].map(({ text, values }) => deps.query(text, values)));

    let retrain = null;
    if (retrainOn) retrain = await require('./retrainStatsService').stats(deps.query, studentId, { days });
    let remedial = null;
    if (remedialOn) {
        try {
            remedial = await require('./remedialEffectService').loadRemedialEffect({ studentId, limit: 20, days: null, minN }, deps);
        } catch (err) {
            if (!(err && err.code === '42703')) throw err;   // 還沒套 0022：報告照出，不含補救成效
        }
    }
    return assembleReport({
        student, days, today: localDay(0), from: localDay(-days), minN,
        summary: summary.rows[0], byChapter: chapter.rows, byErrorType: errorType.rows, trend: trend.rows, retrain, remedial
    });
}

module.exports = {
    AUDIENCES, FORMATS, DEFAULT_DAYS, MAX_WEAK_CHAPTERS, WEAK_RATE, DOMINANT_MIN_COUNT, DOMINANT_MIN_SHARE,
    TREND_MIN_GRADED, TREND_DELTA, MAX_SUGGESTIONS, PARENT_ERROR_TEXT, STATUS_LABEL,
    buildSuggestions, assembleReport, summarizeEffect, parentView, forAudience, renderReportHtml,
    buildSummaryQuery, localDay, loadStudentReport
};
