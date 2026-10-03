// ─────────────────────────────────────────────────────────────
// classifyRulesLc2.test.js — 〔Owner 2026-09-27 改答 LC-2：加四條規則〕的誤觸檢查與 2026-09-27 重錄回放的回歸
//（dec/r6-classify-rules；docs/local-mode.md 10.22）
//
// ① 誤觸檢查（eval/tools/chapter_rules_scan.js 的 scan()）：repo 裡現有的題幹與 golden——classify golden 92 題、fixture 62 題的
//    題幹＋答案、知識點種子檔（名稱、說明、口語版）、各章例句、dedup golden、variant 回放檔生成的題、nlq golden 查詢句、
//    pdf_sample golden、公式 golden——跑四條新規則；再把 2026-09-27／2026-09-25 本機、Gemini 的 classify 回答、
//    拆題回放檔裡會走零成本閘門的題與全部 nlq 回答跑一次。〔審查修正 dec/r6-classify-rules-fix〕原本寫「全部文字」不精確，
//    掃描範圍補了 pdf_sample golden 與拆題回放檔；其他語料（answer golden、lint／verify 回放檔等）仍不在內（10.22 第 7 點）。
//    釘住：文字自己的章＝規則 from 的「誤觸」為 0、模型原本答對被改錯的為 0、nlq 一句都沒被換；逐條列出被換的題。
// ② 2026-09-27 本機 classify.v2 回放檔（Owner 重錄，92 支）：現行 agent 跑同一份回答，91/92（只剩 cls-fx-051），
//    四條新規則改了 fx-025、fx-026、fx-027、fx-041、fx-046，全部改對；拿掉這四條的調整就是重錄當天的 86/92。
//    規則是看著這幾題寫的，這個改善會高估對新題的效果（10.22 第 6 點）。回放檔不在時（被 prune）略過 ②。
// 只讀檔，不連 DB、不呼叫模型。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { scan, NEW_RULE_IDS } = require('../../eval/tools/chapter_rules_scan');
const classify = require('../../agents/classify');
const metrics = require('../../eval/lib/metrics');
const { applyToResult: repairLatex } = require('../../services/llm/latexEscapeRepair');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'golden', 'classify.json'), 'utf8')).entries;

describe('① 誤觸檢查：現有的全部文字', () => {
    const r = scan();

    test('掃的是四條新規則，文字量夠（量尺自我檢查）', () => {
        assert.deepEqual(r.ruleIds, ['trig_square_relation', 'general_angle', 'friction_coefficient', 'circular_kinematics']);
        assert.deepEqual([...NEW_RULE_IDS], r.ruleIds);
        assert.ok(r.counts.labeled > 1000, `文字 ${r.counts.labeled}`);
        assert.ok(r.counts.predictions >= 92 * 4, `模型回答 ${r.counts.predictions}`);
        assert.ok(r.counts.nlq >= 50, `nlq 回答 ${r.counts.nlq}`);
    });

    // 〔審查修正 dec/r6-classify-rules-fix〕10.22 第 3 點的數字：1,098 段原本就含公式 golden 150 則（沒有章）；
    // 補掃 pdf_sample golden 10 題、拆題回放檔（走閘門的 9 題；第 4 題的章「三角函數的定義」不在白名單，不走閘門）之後的精確值
    // 〔2026-09-28 重錄第 2、3 步入庫〕語料變大：variant 回放檔（qwen3:8b）多 59 題（本機 60 → 119；var-008#1 錄製逾時，少 1 題），
    // 1,108 → 1,167、有章 958 → 1,017；pipeline 錄的 classify.v2 多 2 筆（樣卷第 6、10 題），模型回答 466 → 468。10.22 第 3 點的附記。
    // 〔2026-10-02 樣卷改用 extract_ocr.v3 重錄入庫〕拆出的題幹寫法變了（例如選項括號），pipeline 多錄 2 支 classify.v2（樣卷第 6、10 題的新題幹），
    // 模型回答 468 → 470；其中第 10 題同樣被規則 4 改成「平面運動」＝pdf_sample golden，工具只用 classify golden 對答案，所以列 unknown。
    // 〔2026-10-03 r15 閘門證據否決〕樣卷第 7 題（拆題模型給「位能與能量守恆」、題幹沒有能量線索）改走第二層，
    // pipeline 補錄 1 支 classify.v2，模型回答 470 → 471；那一筆沒有被任何界線規則換章（下面逐筆列出的換章清單不變）。
    test('掃描範圍（10.22 第 3、7 點的數字；2026-10-03 補錄後）：共 1,167 段、有章的 1,017 段、沒有章的 150 段（公式 golden）；模型回答 471 筆', () => {
        assert.equal(r.counts.labeled, 1167);
        assert.equal(r.counts.labeledWithChapter, 1017);
        assert.equal(r.counts.predictions, 471);
        assert.equal(r.counts.nlq, 90);
        const corpora = [...new Set(r.evidence.map(e => e.corpus))];
        assert.ok(corpora.includes('pdf_sample golden 題幹＋答案'), '有掃 pdf_sample golden');
        assert.ok(r.changes.some(c => /拆題回放檔（走閘門）$/.test(c.corpus)), '有掃拆題回放檔');
    });

    test('誤觸 0：文字自己的章＝from 的一段都沒有、原本答對被改錯的一題都沒有、nlq 一句都沒被換', () => {
        assert.deepEqual(r.misfires, []);
        assert.deepEqual(r.evidence.filter(e => e.kind === 'misfire'), []);
        assert.deepEqual(r.changes.filter(c => c.verdict === 'broken'), []);
        assert.deepEqual(r.nlq, []);
    });

    test('找得到證據的文字，自己的章全是規則的 to（改了也是改對的方向）', () => {
        const kinds = [...new Set(r.evidence.map(e => e.kind))];
        assert.deepEqual(kinds, ['target']);
        const perRule = Object.fromEntries(r.ruleIds.map(id => [id, r.evidence.filter(e => e.rule === id).length]));
        // 〔審查修正 dec/r6-classify-rules-fix〕trig_square_relation 11 → 12：多掃了 pdf_sample golden 第 4 題（fixture #25，本來就是 to 的章）
        // 〔2026-09-28 重錄入庫〕friction_coefficient 22 → 24：新錄的 variant 回放檔（qwen3:8b）多 2 題，章＝藍本的「摩擦力與向心力」（to 的章）
        assert.deepEqual(perRule, { trig_square_relation: 12, general_angle: 9, friction_coefficient: 24, circular_kinematics: 2 });
        // classify golden 裡找得到證據的題（題號與規則）
        const golden = r.evidence.filter(e => e.corpus === 'classify golden').map(e => `${e.id}:${e.rule}`).sort();
        assert.deepEqual(golden, [
            'cls-dr-008:trig_square_relation', 'cls-dr-009:general_angle', 'cls-dr-022:general_angle', 'cls-dr-027:friction_coefficient',
            'cls-fx-025:trig_square_relation', 'cls-fx-026:trig_square_relation', 'cls-fx-027:general_angle', 'cls-fx-028:general_angle',
            'cls-fx-040:friction_coefficient', 'cls-fx-041:friction_coefficient', 'cls-fx-044:friction_coefficient',
            'cls-fx-045:friction_coefficient', 'cls-fx-046:circular_kinematics'
        ]);
    });

    test('模型的回答被換章的：逐筆列出，全部改對', () => {
        const rows = r.changes.map(c => `${c.corpus}｜${c.id}｜${c.from}→${c.to}｜${c.verdict}`).sort();
        assert.deepEqual(rows, [
            '2026-09-25 本機 classify.v1 回放檔｜cls-dr-008｜三角函數的疊合→直角三角形的邊角關係｜fixed',
            '2026-09-25 本機 classify.v1 回放檔｜cls-fx-046｜摩擦力與向心力→平面運動｜fixed',
            // 〔2026-09-28 重錄入庫〕pipeline 錄的樣卷第 10 題（「關於等速圓周運動，下列敘述何者正確？（複選）」）：模型答「摩擦力與向心力」、
            // 規則 4 改成「平面運動」，與 pdf_sample golden 第 10 題相同＝改對的方向。工具只用 classify golden 對答案，所以判成 unknown。
            // 同一次錄的第 6 題（繩的張力）模型答「摩擦力與向心力」＝golden，規則沒有動它。
            // 〔2026-10-02〕extract_ocr.v3 重錄後樣卷第 10 題的新題幹，同下（＝pdf_sample golden；陣列依字串排序）
            '2026-09-27 本機 classify.v2 回放檔｜09d4a923｜摩擦力與向心力→平面運動｜unknown',
            '2026-09-27 本機 classify.v2 回放檔｜1b7f0693｜摩擦力與向心力→平面運動｜unknown',
            '2026-09-27 本機 classify.v2 回放檔｜cls-fx-025｜三角函數的疊合→直角三角形的邊角關係｜fixed',
            '2026-09-27 本機 classify.v2 回放檔｜cls-fx-026｜三角函數的疊合→直角三角形的邊角關係｜fixed',
            '2026-09-27 本機 classify.v2 回放檔｜cls-fx-027｜直角三角形的邊角關係→廣義角與極坐標｜fixed',
            '2026-09-27 本機 classify.v2 回放檔｜cls-fx-041｜牛頓運動定律→摩擦力與向心力｜fixed',
            '2026-09-27 本機 classify.v2 回放檔｜cls-fx-046｜摩擦力與向心力→平面運動｜fixed',
            'gemini-3.5-flash classify.v1 回放檔｜cls-fx-041｜牛頓運動定律→摩擦力與向心力｜fixed',
            // 〔審查修正 dec/r6-classify-rules-fix〕拆題回放檔第 10 題走閘門：Gemini 拆題給「摩擦力與向心力」、信心 1，
            // 規則 4 改成「平面運動」，與 pdf_sample golden 相同（CI 在 LOCAL_EXTRACT_MODE=ocr 下不讀這支回放檔）
            'gemini-3.5-flash extract.v2 拆題回放檔（走閘門）｜0c8e90c3#10｜摩擦力與向心力→平面運動｜fixed',
            'local_raw_2026-09-25.json｜cls-dr-008｜三角函數的疊合→直角三角形的邊角關係｜fixed',
            'local_raw_2026-09-25.json｜cls-fx-046｜摩擦力與向心力→平面運動｜fixed'
        ]);
    });
});

// ───────────────── ② 2026-09-27 本機 classify.v2 回放檔 ─────────────────

function v2Cassettes() {
    const dir = path.join(ROOT, 'eval', 'cassettes', 'classify');
    const map = new Map();
    if (!fs.existsSync(dir)) return map;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (c.meta.template === 'classify.v2' && c.meta.model === 'qwen3:8b') map.set(c.request.cacheKeyParts.questionText, c.response.data);
    }
    return map;
}
const V2 = v2Cassettes();
const V2_READY = GOLDEN.every(e => V2.has(String(e.question_text).trim()));

describe('② 2026-09-27 本機 classify.v2 回放檔：現行 agent 跑同一份回答', { skip: V2_READY ? false : '2026-09-27 的 classify.v2 本機回放檔不齊（被 prune 或尚未錄）' }, () => {
    /** 與 eval/lib/suiteClassify.js 相同的 ctx：db=null、閘門刻意不過；模型那一步換成回放檔的回答（先過 LaTeX 修復，與正式回放相同） */
    async function run() {
        const ctx = {
            llm: {
                generateJson: async (opts) => repairLatex({
                    data: JSON.parse(JSON.stringify(V2.get(opts.cacheKeyParts.questionText))),
                    usage: { tokenIn: 0, tokenOut: 0, tokenThinking: 0, tokenCached: 0 }, latencyMs: 0, raw: null
                })
            },
            db: null, job: { id: 0, budget_usd: Infinity, cost_usd: 0 }, jq: { id: 0, idx: 0, payload: {}, retries: {} },
            logger: { info() {}, warn() {}, error() {} },
            config: { models: { extract: 'ollama:qwen3-vl:8b', verify: 'ollama:qwen3:8b', text: 'ollama:qwen3:8b' }, thresholds: { classifyMinConf: 0.8 }, features: { similar: false, pipeline: true } },
            signal: undefined
        };
        const rows = [];
        for (const e of GOLDEN) {
            const out = await classify.run(ctx, { subject: e.subject, chapter: e.decoy_chapter || '', chapter_confidence: 0, question_text: e.question_text });
            rows.push({ id: e.id, gold: e.chapter, pred: out.data.chapter, adjustments: out.data.adjustments || [] });
        }
        return rows;
    }

    test('91/92（accuracy 0.9891、macro-F1 0.9744），只剩 cls-fx-051；四條新規則改了 5 題、全部改對', async () => {
        const rows = await run();
        assert.deepEqual(rows.filter(r => r.pred !== r.gold).map(r => r.id), ['cls-fx-051']);
        assert.equal(metrics.round4(metrics.accuracy(rows).accuracy), 0.9891);
        assert.equal(metrics.round4(metrics.macroF1(rows).macroF1), 0.9744);
        const byNew = rows.filter(r => r.adjustments.some(a => NEW_RULE_IDS.includes(a.rule)))
            .map(r => `${r.id}:${r.adjustments.map(a => a.rule).join('+')}`);
        assert.deepEqual(byNew, [
            'cls-fx-025:trig_square_relation', 'cls-fx-026:trig_square_relation', 'cls-fx-027:general_angle',
            'cls-fx-041:friction_coefficient', 'cls-fx-046:circular_kinematics'
        ]);
        for (const r of rows.filter(x => x.adjustments.length)) assert.equal(r.pred, r.gold, `${r.id} 改完要等於 golden`);
    });

    test('拿掉四條新規則的調整＝重錄當天的 86/92（accuracy 0.9348、macro-F1 0.8477，未達門檻 0.8956）', async () => {
        const rows = (await run()).map(r => {
            const mine = r.adjustments.find(a => NEW_RULE_IDS.includes(a.rule));
            return mine ? { ...r, pred: mine.from } : r;
        });
        assert.deepEqual(rows.filter(r => r.pred !== r.gold).map(r => r.id),
            ['cls-fx-025', 'cls-fx-026', 'cls-fx-027', 'cls-fx-041', 'cls-fx-046', 'cls-fx-051']);
        assert.equal(metrics.round4(metrics.accuracy(rows).accuracy), 0.9348);
        assert.equal(metrics.round4(metrics.macroF1(rows).macroF1), 0.8477);
        const th = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'thresholds.json'), 'utf8')).classify.classify;
        assert.deepEqual(th, { accuracy: 0.87, macro_f1: 0.8956 }, '門檻數字不動');
        assert.ok(metrics.macroF1(rows).macroF1 < th.macro_f1);
    });
});
