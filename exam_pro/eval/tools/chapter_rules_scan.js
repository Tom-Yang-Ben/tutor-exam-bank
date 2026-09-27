// ─────────────────────────────────────────────────────────────
// eval/tools/chapter_rules_scan.js — 界線規則的「誤觸檢查」：用 repo 裡現有的題幹、golden 與回放檔跑規則，列出每一次觸發
//
//   node eval/tools/chapter_rules_scan.js              只看 Owner 2026-09-27 改答 LC-2 新加的四條（預設）
//   node eval/tools/chapter_rules_scan.js --all        規則表裡全部的規則
//   node eval/tools/chapter_rules_scan.js --json       輸出 JSON（單元測試用同一個 scan()）
//
// 〔Owner 2026-09-27 改答 LC-2：加四條規則〕docs/local-mode.md 10.22「classify 重錄後的四條界線規則（2026-09-27，改答 LC-2）」。
//
// 三種文字、三種判定：
//   ① 有「自己的章」的文字（classify golden 92 題、fixture 62 題的題幹＋答案、知識點種子檔的名稱／說明／口語版、
//      各章例句、dedup golden 的改寫題、repo 內 variant 回放檔生成的題（章＝藍本的章）、nlq golden 的查詢句（章＝期望章）、
//      pdf_sample golden（樣卷答案卷）的題幹＋答案）：
//      規則的證據函式在這段文字上找得到證據就列出來。文字自己的章＝規則的 from → **誤觸**（模型答對時會被改錯）；
//      ＝ to → 模型選 from 時會被改對；其他章 → 只在模型剛好選了 from 時才會動。公式 golden（formula.json）沒有章，只列不判；
//      dedup 與 variant 有少數對不到章（藍本不在 fixture），也只列不判。
//   ② 模型的回答（2026-09-27 本機 classify.v2 回放檔、2026-09-25 本機 classify.v1 原始回應、Gemini classify.v1 回放檔、
//      拆題回放檔裡會走零成本閘門的題（拆題模型給的章在白名單內、信心 ≥ 0.8））：
//      模型選的章＝規則的 from、題幹有證據 → 列出前後章；題幹對得到 golden（classify golden，或拆題回放檔以
//      pdfSha256＋題號對到 pdf_sample golden）時判定改對／改錯／錯換錯。
//   ③ nlq（golden 50 句以期望章當作 LLM 的回答、repo 內全部 nlq 回放檔的 LLM 回答）：跑 alignChapters（與 mergeLlm 相同，
//      平面／空間略過），列出換了的章；golden 句被換＝誤觸。
//
// 不呼叫任何模型、不讀寫資料庫、不寫檔。
//
// 〔審查修正 dec/r6-classify-rules-fix〕掃描範圍就是上面列的這些，**不是 repo 裡的全部文字**：原本寫「全部」，其實漏了
//   拆題回放檔與 pdf_sample golden（這兩批已補進來）；answer golden、lint／verify 回放檔、seed_questions.js、
//   eval/tools/embed_threshold_labels.json 仍不在內（審查另用全量掃描補查過，沒有誤觸；docs/local-mode.md 10.22 第 7 點）。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const pr = require('../../utils/chapterPostRules');
const { CHAPTERS, isValidChapter } = require('../../config/chapters');

const ROOT = path.resolve(__dirname, '..', '..');
const NEW_RULE_IDS = Object.freeze(['trig_square_relation', 'general_angle', 'friction_coefficient', 'circular_kinematics']);
/** 零成本閘門的信心下限：agents/classify.js 的 DEFAULT_MIN_CONF（CLASSIFY_MIN_CONF 沒寫時） */
const GATE_MIN_CONF = 0.8;

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

/** repo 內某個 agent 的全部回放檔（依檔名排序，結果穩定） */
function cassettes(agent) {
    const dir = path.join(ROOT, 'eval', 'cassettes', agent);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
        .map(f => ({ file: `${agent}/${f}`, c: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

/** repo 內的 pdf_sample golden（樣卷答案卷；依檔名排序） */
function pdfSampleGoldens() {
    const dir = path.join(ROOT, 'eval', 'golden', 'pdf_sample');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
        .map(f => ({ file: f, g: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

/** 章屬於哪一科（數學／物理／化學；都不是回 null） */
function subjectOf(chapter) {
    return Object.keys(CHAPTERS).find(s => CHAPTERS[s].includes(chapter)) || null;
}

/**
 * ① 有自己的章的文字。
 * @returns {Array<{corpus:string, id:string, chapters:string[]|null, text:string}>}
 */
function labeledTexts() {
    const out = [];
    const golden = readJson('eval/golden/classify.json').entries;
    for (const e of golden) out.push({ corpus: 'classify golden', id: e.id, chapters: [e.chapter], text: String(e.question_text).trim() });

    const fixture = readJson('eval/fixtures/questions.public.json').questions;
    const fixtureChapter = new Map(fixture.map(q => [q.id, q.chapter]));
    for (const q of fixture) out.push({ corpus: 'fixture 題幹＋答案', id: `#${q.id}`, chapters: [q.chapter], text: `${q.question_text} ${q.answer_text || ''}` });

    for (const subject of ['數學', '物理']) {
        const kc = readJson(`config/kc/${subject}.json`);
        for (const k of kc.components) {
            out.push({ corpus: '知識點種子檔', id: k.code, chapters: [k.chapter], text: [k.name, k.description, k.spoken_text].filter(Boolean).join(' ') });
        }
    }
    const { CHAPTER_EXAMPLES } = require('../../config/chapterExamples');
    for (const subject of ['數學', '物理']) {
        for (const [chapter, text] of Object.entries(CHAPTER_EXAMPLES[subject])) out.push({ corpus: '各章例句', id: chapter, chapters: [chapter], text });
    }
    for (const e of readJson('eval/golden/dedup.json').entries) {
        for (const side of ['a', 'b']) {
            const x = e[side];
            if (x && typeof x.text === 'string') out.push({ corpus: 'dedup golden', id: `${e.id}.${side}`, chapters: fixtureChapter.has(x.from) ? [fixtureChapter.get(x.from)] : null, text: x.text });
        }
    }
    for (const { file, c } of cassettes('variant')) {
        const d = c.response && c.response.data;
        const parts = c.request && c.request.cacheKeyParts;
        if (!d || typeof d.question_text !== 'string') continue;
        const chapter = parts && fixtureChapter.get(parts.sourceQuestionId);
        out.push({ corpus: `variant 回放檔（${c.meta.model}）`, id: file.slice(8, 16), chapters: chapter ? [chapter] : null, text: `${d.question_text} ${d.answer_text || ''}` });
    }
    for (const e of readJson('eval/golden/nlq.json').entries) {
        out.push({ corpus: 'nlq golden 查詢句', id: e.id, chapters: e.expect.chapters.length ? e.expect.chapters.slice() : null, text: e.query });
    }
    // 〔審查修正 dec/r6-classify-rules-fix〕樣卷答案卷（pdf_sample golden）
    for (const { file, g } of pdfSampleGoldens()) {
        for (const q of g.questions) out.push({ corpus: 'pdf_sample golden 題幹＋答案', id: `${file.slice(0, 8)}#${q.no}`, chapters: [q.chapter], text: `${q.question_text} ${q.answer_text || ''}` });
    }
    for (const e of readJson('eval/golden/formula.json').entries) {
        out.push({ corpus: 'formula golden（沒有章）', id: e.id, chapters: null, text: String(e.latex) });
    }
    return out;
}

/**
 * ② 模型的回答。
 * @returns {Array<{corpus:string, id:string, text:string, pred:string, gold:string|null}>}
 */
function predictions() {
    const golden = readJson('eval/golden/classify.json').entries;
    const goldByText = new Map(golden.map(e => [String(e.question_text).trim(), e]));
    const out = [];
    for (const { file, c } of cassettes('classify')) {
        const text = String(c.request.cacheKeyParts.questionText || '').trim();
        const g = goldByText.get(text);
        const pred = c.response && c.response.data && c.response.data.chapter;
        if (typeof pred !== 'string') continue;
        const corpus = c.meta.model === 'qwen3:8b' && c.meta.template === 'classify.v2' ? '2026-09-27 本機 classify.v2 回放檔'
            : c.meta.model === 'qwen3:8b' ? '2026-09-25 本機 classify.v1 回放檔'
                : `${c.meta.model} ${c.meta.template} 回放檔`;
        out.push({ corpus, id: g ? g.id : file.slice(9, 17), text, pred, gold: g ? g.chapter : null });
    }
    // 2026-09-25 的原始回應檔（回放檔被 prune 之後仍在；與上面 classify.v1 本機那 92 支逐字相同，另列一次）
    const raw = readJson('eval/fixtures/local_raw_2026-09-25.json');
    for (const r of raw.classify) {
        const g = goldByText.get(String(r.questionText).trim());
        out.push({ corpus: 'local_raw_2026-09-25.json', id: r.id, text: r.questionText, pred: r.data.chapter, gold: g ? g.chapter : null });
    }
    // 〔審查修正 dec/r6-classify-rules-fix〕拆題回放檔：拆題模型給的章在白名單內、信心 ≥ 0.8 的題走零成本閘門，
    // 閘門與第二層用同一個 boundaryTarget（LC-3），題幹同樣是 question_text。golden 以 pdfSha256＋題號對 pdf_sample golden。
    // 注意：CI（LOCAL_EXTRACT_MODE=ocr）的 pipeline eval 讀 extract_ocr 回放檔，不讀這裡的 extract（看圖）回放檔。
    const pdfGold = new Map(pdfSampleGoldens().map(({ g }) => [g.sha256, g]));
    for (const { file, c } of cassettes('extract')) {
        const qs = c.response && c.response.data && c.response.data.questions;
        if (!Array.isArray(qs)) continue;
        const g = pdfGold.get(c.request && c.request.cacheKeyParts && c.request.cacheKeyParts.pdfSha256);
        for (const q of qs) {
            const conf = Number(q.chapter_confidence);
            if (!isValidChapter(q.subject, q.chapter) || !(conf >= GATE_MIN_CONF)) continue;
            const gq = g && g.questions.find(x => x.no === q.idx);
            out.push({
                corpus: `${c.meta.model} ${c.meta.template} 拆題回放檔（走閘門）`, id: `${file.slice(8, 16)}#${q.idx}`,
                text: String(q.question_text || '').trim(), pred: q.chapter, gold: gq ? gq.chapter : null
            });
        }
    }
    return out;
}

/**
 * ③ nlq：golden 的期望章當作 LLM 的回答，以及 repo 內全部 nlq 回放檔與原始回應檔的 LLM 回答。
 * @returns {Array<{corpus:string, id:string, query:string, chapters:string[], expect:string[]|null}>}
 */
function nlqAnswers() {
    const golden = readJson('eval/golden/nlq.json').entries;
    const byQuery = new Map(golden.map(e => [e.query, e]));
    const out = [];
    for (const e of golden) {
        if (e.expect.chapters.length) out.push({ corpus: 'nlq golden（期望章當回答）', id: e.id, query: e.query, chapters: e.expect.chapters.slice(), expect: e.expect.chapters.slice() });
    }
    for (const { file, c } of cassettes('nlq')) {
        const q = c.request.cacheKeyParts.query;
        const d = c.response && c.response.data;
        if (!d || !Array.isArray(d.chapters)) continue;
        const g = byQuery.get(q);
        out.push({ corpus: `nlq 回放檔（${c.meta.model} ${c.meta.template}）`, id: g ? g.id : file.slice(4, 12), query: q, chapters: d.chapters.slice(), expect: g ? g.expect.chapters.slice() : null });
    }
    const raw = readJson('eval/fixtures/local_raw_2026-09-25.json');
    for (const r of raw.nlq) {
        const g = byQuery.get(r.query);
        out.push({ corpus: 'local_raw_2026-09-25.json（nlq）', id: r.id, query: r.query, chapters: r.data.chapters.slice(), expect: g ? g.expect.chapters.slice() : null });
    }
    return out;
}

/**
 * 跑誤觸檢查。
 * @param {{ruleIds?:string[]}} [opts] 預設只看新加的四條
 * @returns {{
 *   ruleIds:string[],
 *   counts:{labeled:number, labeledWithChapter:number, predictions:number, nlq:number},
 *   evidence:Array<{rule:string, from:string, to:string, corpus:string, id:string, chapters:string[]|null, evidence:string, kind:'misfire'|'target'|'other'|'unlabeled'}>,
 *   changes:Array<{rule:string, corpus:string, id:string, from:string, to:string, gold:string|null, evidence:string, verdict:'fixed'|'broken'|'wrong_to_wrong'|'unknown'}>,
 *   nlq:Array<{corpus:string, id:string, query:string, before:string[], after:string[], expect:string[]|null, rules:string[], misfire:boolean}>,
 *   misfires:string[]
 * }}
 */
function scan(opts = {}) {
    const ruleIds = opts.ruleIds || NEW_RULE_IDS.slice();
    const rules = pr.RULES.filter(r => ruleIds.includes(r.id));
    const labeled = labeledTexts();
    const preds = predictions();
    const nlqRows = nlqAnswers();

    const evidence = [];
    for (const t of labeled) {
        for (const rule of rules) {
            const ev = rule.test(t.text);
            if (!ev) continue;
            // 規則只管一科：證據在別科的文字上出現不算（模型不可能在那一科選到 from）
            if (t.chapters && !t.chapters.some(c => subjectOf(c) === subjectOf(rule.from))) continue;
            const kind = !t.chapters ? 'unlabeled'
                : t.chapters.includes(rule.from) && !t.chapters.includes(rule.to) ? 'misfire'
                    : t.chapters.includes(rule.to) ? 'target' : 'other';
            evidence.push({ rule: rule.id, from: rule.from, to: rule.to, corpus: t.corpus, id: t.id, chapters: t.chapters, evidence: String(ev), kind });
        }
    }

    const changes = [];
    for (const p of preds) {
        const hit = pr.boundaryTarget(p.pred, p.text);
        if (!hit || !ruleIds.includes(hit.rule)) continue;
        const verdict = p.gold === null ? 'unknown'
            : hit.to === p.gold ? 'fixed'
                : p.pred === p.gold ? 'broken' : 'wrong_to_wrong';
        changes.push({ rule: hit.rule, corpus: p.corpus, id: p.id, from: p.pred, to: hit.to, gold: p.gold, evidence: hit.evidence, verdict });
    }

    const nlq = [];
    for (const n of nlqRows) {
        const r = pr.alignChapters(n.chapters, n.query, { skipDimension: true });
        const mine = r.changes.filter(c => ruleIds.includes(c.rule));
        if (!mine.length) continue;
        const misfire = n.corpus.startsWith('nlq golden');
        nlq.push({ corpus: n.corpus, id: n.id, query: n.query, before: n.chapters, after: r.chapters, expect: n.expect, rules: mine.map(c => `${c.rule}（${c.evidence}）`), misfire });
    }

    const misfires = [
        ...evidence.filter(e => e.kind === 'misfire').map(e => `${e.corpus} ${e.id}：${e.rule}（${e.chapters.join('、')}，證據「${e.evidence}」）`),
        ...changes.filter(c => c.verdict === 'broken').map(c => `${c.corpus} ${c.id}：${c.rule} 把對的「${c.from}」改成「${c.to}」`),
        ...nlq.filter(n => n.misfire).map(n => `${n.corpus} ${n.id}：${n.rules.join('、')}`)
    ];
    const counts = { labeled: labeled.length, labeledWithChapter: labeled.filter(t => t.chapters).length, predictions: preds.length, nlq: nlqRows.length };
    return { ruleIds, counts, evidence, changes, nlq, misfires };
}

function printMarkdown(r) {
    const byRule = (list) => r.ruleIds.map(id => [id, list.filter(x => x.rule === id)]);
    console.log(`## 界線規則誤觸檢查（${r.ruleIds.join('、')}）\n`);
    // 〔審查修正 dec/r6-classify-rules-fix〕counts.labeled 含沒有章的段落（公式 golden、對不到藍本的 dedup／variant），分開印
    console.log(`掃描的文字：共 ${r.counts.labeled} 段（其中有章的 ${r.counts.labeledWithChapter} 段、沒有章的 ${r.counts.labeled - r.counts.labeledWithChapter} 段）、` +
        `模型回答 ${r.counts.predictions} 筆、nlq 回答 ${r.counts.nlq} 筆。\n`);
    console.log('### ① 文字裡找得到證據的（文字自己的章＝from 才是誤觸）\n');
    for (const [id, rows] of byRule(r.evidence)) {
        const rule = pr.RULES.find(x => x.id === id);
        console.log(`**${id}**（${rule.from} → ${rule.to}）：${rows.length} 段` +
            `（誤觸 ${rows.filter(x => x.kind === 'misfire').length}、本來就是 to 的章 ${rows.filter(x => x.kind === 'target').length}、` +
            `其他章 ${rows.filter(x => x.kind === 'other').length}、沒有章 ${rows.filter(x => x.kind === 'unlabeled').length}）`);
        for (const x of rows) console.log(`- ${x.kind === 'misfire' ? '❌ 誤觸 ' : ''}${x.corpus} ${x.id}〔${x.chapters ? x.chapters.join('、') : '沒有章'}〕證據「${x.evidence}」`);
        console.log('');
    }
    console.log('### ② 模型的回答被換章的（前 → 後，golden）\n');
    for (const [id, rows] of byRule(r.changes)) {
        console.log(`**${id}**：${rows.length} 筆`);
        for (const x of rows) {
            const mark = { fixed: '改對', broken: '❌ 改錯', wrong_to_wrong: '錯換錯', unknown: 'golden 沒有這題' }[x.verdict];
            console.log(`- ${x.corpus} ${x.id}：${x.from} → ${x.to}（golden：${x.gold || '—'}；${mark}；證據「${x.evidence}」）`);
        }
        console.log('');
    }
    console.log('### ③ nlq（alignChapters，平面／空間略過）\n');
    if (!r.nlq.length) console.log('一句都沒有被換。\n');
    for (const x of r.nlq) console.log(`- ${x.misfire ? '❌ 誤觸 ' : ''}${x.corpus} ${x.id}「${x.query}」：[${x.before.join('、')}] → [${x.after.join('、')}]（期望 ${x.expect ? `[${x.expect.join('、')}]` : '—'}；${x.rules.join('、')}）`);
    console.log(`\n誤觸合計：${r.misfires.length}${r.misfires.length ? `\n${r.misfires.map(m => `  - ${m}`).join('\n')}` : ''}`);
}

function main() {
    const argv = process.argv.slice(2);
    for (const a of argv) if (!['--all', '--json'].includes(a)) throw new Error(`不認得的參數：${a}`);
    const r = scan({ ruleIds: argv.includes('--all') ? pr.RULES.map(x => x.id).filter((id, i, a) => a.indexOf(id) === i) : undefined });
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else printMarkdown(r);
    return r.misfires.length ? 1 : 0;
}

if (require.main === module) {
    const { exitAfterFlush } = require('../lib/exitAfterFlush');
    let code = 1;
    try { code = main(); } catch (err) { console.error(err); }
    exitAfterFlush(code);
}

module.exports = { scan, NEW_RULE_IDS, labeledTexts, predictions, nlqAnswers };
