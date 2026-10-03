// ─────────────────────────────────────────────────────────────
// localModeSections.test.js — docs/local-mode.md 10.12～10.20 的編號與交互參照（〔整合 2026-09-26 dec/integration-r5〕；
// 〔整合 2026-09-27 dec/integration-final5〕加 10.15）
//
// dec/local-ocr-first-fix、dec/local-embed-thresholds-fix、dec/local-thinking-speed-fix 三條分支各自新增了「10.12」。
// 整合時依併入順序改號：10.12＝只用 OCR 拆題、10.13＝三個餘弦門檻、10.14＝拆題以外的時間與加速選項，
// 程式註解、執行時印出的訊息、其他文件裡指到這三節的地方一併改號。
// 〔整合 2026-09-27 dec/integration-final5〕dec/local-classify-nlq-prep-fix 也新增了「10.12 classify／nlq 重錄前修正」，
// 依併入順序改號為 10.15；它的程式註解、eval 訊息、測試一併改號。
// 這裡釘住：① 三個標題真的是這個順序、各出現一次；② 各功能的原始碼／文件指到的是自己那一節（改號沒有漏、也沒有改錯邊）；
// ③ 執行時印給 Owner 看的兩句（localTuning 的啟動訊息、report:jobs 的重跑說明）指到 10.14。
// 〔整合 2026-09-27 dec/integration-r6〕第五輪五組（A 模板、B 本機調整、C 閘門、D 預設值、E 文件知識點）各自暫編「10.16」，
// 依併入順序改號為 10.16～10.20；標題清單改回逐一列出每一節的節號與完整標題（不再允許暫編的寬鬆寫法），
// 各組自己的檔指到自己那一節也一併釘住。
// 〔Owner 2026-09-27 改答 LC-2，dec/r6-classify-rules〕末尾新增 10.22「classify 重錄後的四條界線規則」：標題清單多一節，
// 改到的檔（classify.js、chapterPostRules.js、suiteClassify.js、localV1Regression）另指到 10.22，新檔只指 10.22。
// 〔dec/r9-record-tooling〕末尾新增 10.23「重錄工具補強」：標題清單多一節；新測試與 services/llm/cassette.js 只指 10.23。
// 〔Owner 第七輪 R7-1＝4，dec/r10-variant-cap〕末尾新增 10.24「變式生成的本機輸出上限與截斷不重試」：標題清單多一節；
// services/llm/localTuning.js 另指到 10.24（變式的本機預設），兩個新測試只指 10.24。
// 〔dec/r13-extract-fixes〕末尾新增 10.25「本機拆題修正」：標題清單多一節；localTuning.js 另指到 10.25（lint／verify 逾時），
// 兩個新工具檔與新測試只指 10.25。
// 〔dec/r13-engine-choice〕末尾新增 10.26「拆題與助教可選本機或 Gemini」：標題清單多一節；新檔（config/engines.js、migration 0021、
// 兩個新測試、engineController）只指 10.26。review.js 照舊只指 10.12、10.17（它的新註解以節名稱指過去，不寫節號）。
// 〔Owner 2026-10-03 第 r14 輪 C-1、C-2，dec/r14-ci-green〕末尾新增 10.27「CI 的兩個 eval 門檻」：標題清單多一節；兩個新測試只指 10.27，
// eval/lib/thresholds.js、eval/lib/suitePipeline.js 指 10.25（verify_agree_rate）與 10.27。
// 〔dec/r15-chapter-acc〕末尾新增 10.28「pipeline 章節錯題的根因修正」：標題清單多一節；chapterPostRules.js 另指到 10.28，
// config/chapterMigrationRules.js 只指 10.28。閘門的證據否決：classify.js、eval/lib/suitePipeline.js 另指到 10.28，新測試只指 10.28。
// 只讀檔，不連 DB、不呼叫模型。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** 檔內所有「local-mode.md …10.1x」與「第 10.1x 條」的節號（去重、排序） */
function sectionRefs(text) {
    const out = new Set();
    // 〔整合 r6〕第五輪之後有 10.20，一併收 10.2x
    for (const m of text.matchAll(/10\.([12][0-9])(?![0-9])/g)) out.add(`10.${m[1]}`);
    return [...out].sort();
}

describe('docs/local-mode.md 10.12～10.20（整合 r5、final5、r6 改號）', () => {
    const doc = read('docs/local-mode.md');

    // 〔整合 2026-09-27 dec/integration-r6〕第五輪五組各自暫編的「10.16」依併入順序改號，這裡逐一釘住節號與標題（不再允許暫編）
    // 每一節的完整標題（逐字，不用部分比對）
    const EXPECTED = [
        ["10.12", "只用 OCR 拆題（`LOCAL_EXTRACT_MODE=ocr`；2026-09-26 Owner 選「OCR 為主」，`dec/local-ocr-first`）"],
        ["10.13", "三個餘弦門檻依本機向量重新校準（V5；2026-09-26，`dec/local-embed-thresholds`）——**待 Owner 核准，未改任何門檻**"],
        ["10.14", "拆題以外的時間花在哪裡、加速選項（2026-09-26，`dec/local-thinking-speed`；**待 Owner 決定，預設未改**）"],
        ["10.15", "classify／nlq 重錄前修正（2026-09-26，`dec/local-classify-nlq-prep`；原編 10.12，整合時改號）"],
        ["10.16", "第五輪 A 模板與 schema（2026-09-27）"],
        ["10.17", "第五輪 B 本機呼叫調整（2026-09-27）"],
        ["10.18", "第五輪 C 閘門與計分（2026-09-27）"],
        ["10.19", "第五輪 D 預設值與門檻（2026-09-27，`dec/r6-defaults`；Owner 第五輪 D-3、V5-1～V5-5、O-2 核准）"],
        ["10.20", "第五輪 E 文件與知識點（2026-09-27）"],
        ["10.21", "重錄計畫（2026-09-27，第五輪之後）"],   // 整合 r6 新增（test/unit/rerecordPlanR6.test.js）
        ["10.22", "classify 重錄後的四條界線規則（2026-09-27，改答 LC-2）"],   // 〔Owner 2026-09-27 改答 LC-2〕dec/r6-classify-rules
        ["10.23", "重錄工具補強：只補錄缺的、錯誤回放檔（2026-10-01，`dec/r9-record-tooling`）"],   // 〔dec/r9-record-tooling〕末尾新增
        ["10.24", "變式生成的本機輸出上限與截斷不重試（2026-10-01，`dec/r10-variant-cap`；Owner 第七輪 R7-1＝4）"],   // 〔dec/r10-variant-cap〕末尾新增
        ["10.25", "本機拆題修正：不准編答案、解答頁、LaTeX、答案比對、lint／verify 逾時（2026-10-02，`dec/r13-extract-fixes`；Owner 2026-10-02 同意）"],   // 〔dec/r13-extract-fixes〕末尾新增
        ["10.26", "拆題與助教可選本機或 Gemini（2026-10-02，`dec/r13-engine-choice`；Owner 2026-10-01）"],   // 〔dec/r13-engine-choice〕末尾新增
        ["10.27", "CI 的兩個 eval 門檻：本機的章節正確率、依向量模型的變式覆蓋率（2026-10-03，`dec/r14-ci-green`；Owner 第 r14 輪 C-1、C-2）"],   // 〔dec/r14-ci-green〕末尾新增
        ["10.28", "pipeline 章節錯題的根因修正（2026-10-03，`dec/r15-chapter-acc`）"]   // 〔dec/r15-chapter-acc〕末尾新增
    ];

    test(`第 10 章 10.12 之後的標題依併入順序各出現一次：${EXPECTED.map(e => e[0]).join('、')}`, () => {
        const heads = [...doc.matchAll(/^### (10\.(?:1[2-9]|[2-9][0-9])) (.*)$/gm)].map(m => [m[1], m[2]]);
        assert.deepEqual(heads.map(h => h[0]), EXPECTED.map(e => e[0]), JSON.stringify(heads));
        assert.deepEqual(heads, EXPECTED, '節號與標題逐字相符');
        assert.match(heads[0][1], /只用 OCR 拆題/);
        assert.match(heads[1][1], /三個餘弦門檻/);
        assert.match(heads[2][1], /拆題以外的時間/);
        assert.match(heads[3][1], /classify／nlq 重錄前修正/);
        const idx = EXPECTED.map(([no]) => doc.indexOf(`### ${no} `));
        assert.ok(idx.every((v, i) => v >= 0 && (i === 0 || idx[i - 1] < v)), `依編號排列：${JSON.stringify(idx)}`);
        assert.equal(/^<{7}|^={7}$|^>{7}/m.test(doc), false, '沒有殘留的衝突標記');
    });

    test('10.7 第 9 點、10.5 速度表的指引指到正確的節', () => {
        assert.match(doc, /分析與選項見 \*\*10\.13\*\*/);
        assert.match(doc, /OCR 結果整理成題目 \| 10～20 分鐘〔10\.14 以實測速度估/);
        assert.match(doc, /〔2026-09-26 實測，10\.14；審查修正〕/);
    });

    const OWN = [
        // [檔案, 應該只指到的節]
        ['exam_pro/config/localExtractMode.js', ['10.12', '10.19']],   // 〔Owner 第五輪 D-3〕預設改 ocr 的說明指 10.19（整合 r6 改號）
        ['exam_pro/config/similarityThresholds.js', ['10.19']],
        ['exam_pro/agents/extractOcrFigures.js', ['10.12']],
        ['exam_pro/migrations/0019_ocr_only_review.sql', ['10.12']],
        // 〔r7 測試空轉清理 審查 2026-09-27〕replay miss 的斷言訊息原本叫人跑 eval:record（需要金鑰），改成指向 10.21 第 3 步的重錄
        ['exam_pro/test/e2e/pipeline.e2e.test.js', ['10.12', '10.21']],
        ['exam_pro/eval/.env.replay', ['10.12']],
        ['exam_pro/eval/tools/embed_threshold_report.js', ['10.13']],
        ['exam_pro/eval/lib/embedThresholds.js', ['10.13']],
        ['exam_pro/eval/tools/embed_threshold_labels.json', ['10.13']],
        ['docs/local-embed-thresholds-report.md', ['10.13']],
        ['exam_pro/services/llm/localTuning.js', ['10.14', '10.24', '10.25']],   // 〔Owner 第七輪 R7-1〕變式的本機預設另指 10.24；〔dec/r13-extract-fixes〕lint／verify 逾時指 10.25
        ['exam_pro/migrations/0020_output_truncated_review.sql', ['10.17']],   // 〔第五輪 B；整合 r6 改號〕
        ['exam_pro/eval/tools/local_bench_text.js', ['10.14']],
        ['exam_pro/test/unit/localTuning.test.js', ['10.14']],
        ['exam_pro/test/unit/localBenchText.test.js', ['10.14']],
        ['exam_pro/test/unit/localPerfThinking.test.js', ['10.14']],
        // 〔Owner 2026-09-27 改答 LC-2〕classify.js、chapterPostRules.js、suiteClassify.js、localV1Regression 另指到 10.22（四條新規則）
        ['exam_pro/agents/classify.js', ['10.15', '10.22', '10.28']],   // 〔dec/r15-chapter-acc〕閘門的證據否決另指 10.28
        ['exam_pro/utils/chapterPostRules.js', ['10.15', '10.22', '10.28']],   // 〔dec/r15-chapter-acc〕對數下標另指 10.28
        ['exam_pro/eval/lib/suiteClassify.js', ['10.15', '10.22']],
        ['exam_pro/eval/tools/local_v1_counterfactual.js', ['10.15']],
        ['exam_pro/eval/fixtures/local_raw_2026-09-25.json', ['10.15']],
        ['exam_pro/test/unit/localV1Regression.test.js', ['10.15', '10.22']],
        ['exam_pro/eval/tools/chapter_rules_scan.js', ['10.22']],
        ['exam_pro/test/unit/classifyRulesLc2.test.js', ['10.22']],
        // 〔dec/r9-record-tooling〕只補錄缺的、錯誤回放檔
        ['exam_pro/test/unit/recordTooling.test.js', ['10.23']],
        ['exam_pro/services/llm/cassette.js', ['10.23']],
        // 〔dec/r10-variant-cap〕變式的本機輸出上限與截斷不重試
        ['exam_pro/test/unit/variantCap.test.js', ['10.24']],
        ['exam_pro/test/integration/variantTruncation.pg.test.js', ['10.24']],
        // 〔dec/r13-extract-fixes〕本機拆題修正
        ['exam_pro/utils/answerKey.js', ['10.25']],
        ['exam_pro/utils/extractLatexRepair.js', ['10.25']],
        ['exam_pro/test/unit/extractFixesR13.test.js', ['10.25']],
        // 〔dec/r13-engine-choice〕拆題與助教可選本機或 Gemini
        ['exam_pro/config/engines.js', ['10.26']],
        ['exam_pro/migrations/0021_job_engine.sql', ['10.26']],
        ['exam_pro/controllers/engineController.js', ['10.26']],
        ['exam_pro/test/unit/engineChoice.test.js', ['10.26']],
        ['exam_pro/test/integration/engineChoice.pg.test.js', ['10.26']],
        // 〔Owner 2026-10-03 第 r14 輪 C-1、C-2，dec/r14-ci-green〕CI 的兩個 eval 門檻
        ['exam_pro/test/unit/evalPipelineChapterAcc.test.js', ['10.27', '10.28']],   // 〔dec/r15-chapter-acc〕門檻 ratchet 另指 10.28
        ['exam_pro/test/unit/evalThresholdsEmbedModel.test.js', ['10.27']],
        ['exam_pro/eval/lib/thresholds.js', ['10.25', '10.27']],
        // 〔dec/r15-chapter-acc〕pipeline 章節錯題的根因修正
        ['exam_pro/config/chapterMigrationRules.js', ['10.28']],
        ['exam_pro/test/unit/gateEvidenceVeto.test.js', ['10.28']],
        ['exam_pro/eval/lib/suitePipeline.js', ['10.25', '10.27', '10.28']],
        // 〔整合 2026-09-27 dec/integration-r6〕第五輪各組暫編的 10.16 改號後，各組自己的檔指到自己那一節
        ['exam_pro/controllers/reviewController.js', ['10.12', '10.17']],   // B：output_truncated
        ['exam_pro/public/js/review.js', ['10.12', '10.17']],               // B
        ['docs/formulas.md', ['10.18']],                                    // C：control_char
        ['docs/llm.md', ['10.18']],                                         // C：L-1／L-3
        ['exam_pro/test/unit/latexEscapeRepair.test.js', ['10.18']],        // C
        ['.github/workflows/ci.yml', ['10.12', '10.18', '10.19']],          // C 的 D-2、D 的 D-3
        ['exam_pro/test/unit/similarityThresholds.test.js', ['10.19']],     // D
        ['docs/variants.md', ['10.13', '10.19']]                            // D
    ];
    for (const [file, want] of OWN) {
        test(`${file} 只指到 ${want.join('、')}`, () => {
            assert.deepEqual(sectionRefs(read(file)), want);
        });
    }

    test('兩邊都有的檔：OCR 的那幾行指 10.12，拆題以外的時間那幾行指 10.14', () => {
        const rj = read('exam_pro/scripts/report_jobs.js');
        assert.match(rj, /LOCAL_EXTRACT_MODE=ocr 的版面配圖（docs\/local-mode\.md 10\.12 第 4 點）/);
        assert.match(rj, /要不要關掉見 docs\/local-mode\.md 第 10\.14 條/);
        assert.match(rj, /本機模式要不要關掉這次重跑（docs\/local-mode\.md 第 10\.14 條）/);
        const env = read('exam_pro/.env.example');
        assert.match(env, /本機拆題的方式（〔OCR 為主 2026-09-26〕docs\/local-mode\.md 10\.12；/);
        // 〔Owner 第五輪 C-b、C-c〕加速選項已有本機預設：說明行改寫，仍指到 10.14（第五輪的決定另指 10.17，整合 r6 改號）
        assert.match(env, /（加速選項，docs\/local-mode\.md 第 10\.14 條；Owner 第五輪決定見 10\.17）/);
        assert.deepEqual(sectionRefs(read('exam_pro/eval/tools/local_perf_report.js')), ['10.10', '10.11', '10.14']);
        assert.match(read('docs/variants.md'), /\[`local-mode\.md` 10\.13\]\(local-mode\.md\)/);
    });

    test('執行時印給 Owner 的訊息指到 10.14（localTuning 的啟動訊息、report:jobs 的重跑說明）', () => {
        const tuning = require('../../services/llm/localTuning');
        const logs = [];
        tuning._resetAnnounceForTest();
        try {
            tuning.announceOverrides({ LLM_MODE: 'live', OLLAMA_NO_THINK: 'verify' }, { log: (s) => logs.push(s), warn: (s) => logs.push(s) });
        } finally {
            tuning._resetAnnounceForTest();
        }
        assert.ok(logs.some(l => l.includes('docs/local-mode.md 第 10.14 條')), JSON.stringify(logs));

        const { renderMarkdown } = require('../../scripts/report_jobs');
        const md = renderMarkdown({
            since: { label: '7d', from: '2026-09-20T00:00:00.000Z' },
            totals: { events: 0, jobs: 0 },
            nodes: [], outcomes: [], errorClasses: [], reviewReasons: [],
            perJob: { jobs: 0, total_cost: 0, avg_cost: 0, p50_cost: 0, max_cost: 0, saved: 0 },
            classifyGate: { calls: 0, gate_pass: 0, llm_calls: 0, rate: null },
            verify: { calls: 0, skipped: 0, mismatch: 0, mismatch_rate: null, label: '資料不足',
                rerun: { reruns: 1, rerun_pass: 1, rerun_mismatch: 0, rerun_other: 0, no_next: 0 } },
            ocrFigures: { chunks: 1, detected: 2, assigned: 1, hinted: 1, no_layout: 0, truncated: 0 }
        });
        // 兩條分支加的兩節同時出現（collect 的回傳同時帶 verify.rerun 與 ocrFigures）
        assert.ok(md.includes('要不要關掉見 docs/local-mode.md 第 10.14 條'), md);
        assert.ok(md.includes('## OCR 版面配圖（LOCAL_EXTRACT_MODE=ocr）'), md);
        assert.ok(md.indexOf('原地重跑') < md.indexOf('## OCR 版面配圖'), '重跑列在 verify 表裡、OCR 配圖是後面的一節');
    });
});
