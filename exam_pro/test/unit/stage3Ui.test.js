// 階段 3 三個新分頁的前端契約測試（P-05／P-09／P-13）
//
// 這三個檔（public/js/students.js、nlq.js、variants.js）跟 index.html 的 inline script
// 一樣**不在任何測試的路徑上**：npm test 只跑 test/unit/、整合測試打的是 API。
// 少一個右大括號，唯一的症狀是打開瀏覽器整頁沒反應，而 CI 全綠。
// 語法那一層由 eval/tools/check_html.js 顧（見 test/unit/publicAssets.test.js），
// 這一支顧的是**算得出對錯的那幾支純函式**與**檔案層級的契約**。
//
// 為什麼這幾支值得測：
//   - formatPercent(null) 要回「—」不是「0.0%」。graded=0 顯示 0% 是在對老師說謊
//     （interfaces-stage3.md 裁決 S3-3），而這種錯誤不會噴任何例外。
//   - diffResults 決定 PATCH 送出去的內容；多送會撞 100 筆上限、少送會靜默漏批。
//   - weekPoints 的 gapBefore 決定趨勢圖有沒有把「沒資料的週」畫成連續線。
//   - chipFor 要把 awaiting_approval（等你點頭）與其他七個 reason（真的有問題）分開。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.resolve(__dirname, '..', '..', 'public', 'js');

// public/js/*.js 是 ES module，但本專案 package.json 是 "type": "commonjs"，
// 直接 import() 一個 .js 檔會被當成 CJS 解析而炸在 `export` 上。
// 讀原始碼再以 data: URL 當成模組載入（與 publicAssets.test.js 同一招）。
// 三個檔都沒有任何 import，所以 data: URL 沒有相對路徑解析的問題；
// 檔尾的 `typeof document !== 'undefined'` 守衛讓它們在沒有 DOM 的 Node 裡不會爆。
const cache = new Map();
function load(name) {
    if (!cache.has(name)) {
        const src = fs.readFileSync(path.join(JS_DIR, name), 'utf8');
        cache.set(name, import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src)));
    }
    return cache.get(name);
}
const source = name => fs.readFileSync(path.join(JS_DIR, name), 'utf8');

const STAGE3_FILES = ['students.js', 'nlq.js', 'variants.js'];

// ─────────────────────────────────────────────────────────────
describe('三個新分頁共同的檔案層級契約（interfaces-stage3.md 第 7 條）', () => {
    for (const name of STAGE3_FILES) {
        const src = source(name);
        const meta = { 'students.js': 'feature-students', 'nlq.js': 'feature-nlq', 'variants.js': 'feature-variants' }[name];

        test(`${name}：parseBool 與後端 config/features.js 逐字相同`, async () => {
            const mod = await load(name);
            const { parseBool: backend } = require('../../config/features');
            for (const v of ['1', 'true', 'TRUE', ' True ', '0', 'false', 'off', 'no', '',
                null, undefined, '__FEATURE_STUDENTS__', '__FEATURE_NLQ__', '__FEATURE_VARIANTS__']) {
                assert.equal(mod.parseBool(v), backend(v), `「${v}」兩邊解讀不同`);
            }
        });

        test(`${name}：旗標從 <meta name="${meta}"> 讀，沒有寫死`, () => {
            assert.ok(src.includes(`meta[name="${meta}"]`), `應該從 index.html 的注入點讀 ${meta}`);
            assert.ok(!new RegExp(`${meta.replace('-', '_').toUpperCase()}\\s*=\\s*true`, 'i').test(src),
                '旗標被寫死成 true');
        });

        test(`${name}：不自己複製橋接的函式，一律經 window.ExamApp`, () => {
            assert.ok(src.includes('window.ExamApp'), '沒有經橋接');
            for (const fn of ['apiFetch', 'showToast', 'renderMath', 'createQuestionEditor']) {
                assert.ok(!new RegExp(`function\\s+${fn}\\b`).test(src), `${name} 自己定義了 ${fn}`);
            }
        });

        test(`${name}：mock 資料只在 ?mock=1 時被讀到`, () => {
            // 靜默的假資料比壞掉更難查（review.js 檔頭第 4 點）。唯一讀 MOCK 的地方是
            // request()，而它第一行就檢查旗標——所以「所有讀 MOCK 的程式碼都在那個 return 之後」
            // 就等於「旗標關閉時讀不到假資料」。
            const guard = src.indexOf('if (!mockEnabled()) return app.apiFetch');
            assert.ok(guard > 0, `${name} 的 request() 沒有以旗標檢查開頭`);
            let offset = 0;
            for (const line of src.split('\n')) {
                const at = offset;
                offset += line.length + 1;
                const trimmed = line.trim();
                if (!/\bMOCK\./.test(line) || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                assert.ok(at > guard, `${name}：MOCK 在旗標檢查之前就被讀到：${trimmed}`);
            }
        });
    }
});

// ─────────────────────────────────────────────────────────────
describe('students.js 的純函式（P-05）', () => {
    test('formatPercent：null／undefined 是「—」，不是 0%（裁決 S3-3）', async () => {
        const { formatPercent } = await load('students.js');
        // wrong_rate = null 代表 graded = 0：沒批改不等於全對，面板要能誠實地說「不知道」。
        assert.equal(formatPercent(null), '—');
        assert.equal(formatPercent(undefined), '—');
        assert.equal(formatPercent(0), '0.0%');          // 真的量到 0 的時候才顯示 0%
        assert.equal(formatPercent(0.5556), '55.6%');
        assert.equal(formatPercent(1), '100.0%');
    });

    test('barPercent：null 回 0，其餘夾在 0~100', async () => {
        const { barPercent } = await load('students.js');
        assert.equal(barPercent(null), 0);
        assert.equal(barPercent(0.5), 50);
        assert.equal(barPercent(1.4), 100);
        assert.equal(barPercent(-0.2), 0);
    });

    test('resultLabel：三態（null 與 undefined 都是未批）', async () => {
        const { resultLabel } = await load('students.js');
        assert.equal(resultLabel(1), '對');
        assert.equal(resultLabel(0), '錯');
        assert.equal(resultLabel(null), '未批');
        assert.equal(resultLabel(undefined), '未批');
    });

    test('diffResults：只送改過的題，順序照 current', async () => {
        const { diffResults } = await load('students.js');
        const before = [
            { question_id: 12, result: 1 },
            { question_id: 8, result: null },
            { question_id: 30, result: 0 }
        ];
        const after = [
            { question_id: 12, result: 1 },      // 沒改
            { question_id: 8, result: 0 },       // 未批 → 錯
            { question_id: 30, result: null }    // 錯 → 取消批改
        ];
        assert.deepEqual(diffResults(before, after), [
            { question_id: 8, result: 0 },
            { question_id: 30, result: null }
        ]);
    });

    test('diffResults：沒有任何改動時回空陣列（避免送出 400「results 必須是非空陣列。」）', async () => {
        const { diffResults } = await load('students.js');
        const rows = [{ question_id: 12, result: 1 }, { question_id: 8, result: null }];
        assert.deepEqual(diffResults(rows, rows.map(r => ({ ...r }))), []);
    });

    test('diffResults：0 與 null 是不同的值（取消批改要真的送出去）', async () => {
        const { diffResults } = await load('students.js');
        // 這一條在防「用 falsy 判斷」的寫法：0 是「答錯」，null 是「還沒批」，
        // 兩者都是要寫進 attempts 的合法值（第 1.4 條），混在一起就會漏批或亂批。
        assert.deepEqual(
            diffResults([{ question_id: 5, result: 0 }], [{ question_id: 5, result: null }]),
            [{ question_id: 5, result: null }]
        );
        assert.deepEqual(
            diffResults([{ question_id: 5, result: null }], [{ question_id: 5, result: 0 }]),
            [{ question_id: 5, result: 0 }]
        );
    });

    test('weekPoints：x 是「距離第一週幾週」，中斷的週標 gapBefore', async () => {
        const { weekPoints } = await load('students.js');
        const { points, spanWeeks, maxGraded } = weekPoints([
            { week_start: '2026-07-27', graded: 6, wrong: 3 },
            { week_start: '2026-08-03', graded: 10, wrong: 2 },
            { week_start: '2026-08-17', graded: 12, wrong: 5 }   // 中間跳過 08-10
        ]);
        assert.deepEqual(points.map(p => p.x), [0, 1, 3]);
        assert.deepEqual(points.map(p => p.gapBefore), [false, false, true]);
        assert.equal(spanWeeks, 3);
        assert.equal(maxGraded, 12);
        assert.equal(points[0].rate, 0.5);
    });

    test('weekPoints：graded = 0 的那一週 rate 是 null（折線在那裡要斷開）', async () => {
        const { weekPoints } = await load('students.js');
        const { points } = weekPoints([{ week_start: '2026-08-17', graded: 0, wrong: 0 }]);
        assert.equal(points[0].rate, null);
    });

    test('weekPoints：空陣列與非法輸入不爆', async () => {
        const { weekPoints } = await load('students.js');
        assert.deepEqual(weekPoints([]).points, []);
        assert.deepEqual(weekPoints(null).points, []);
        assert.deepEqual(weekPoints([null, { graded: 1 }]).points, []);
    });

    test('週趨勢的 SVG 是自己畫的，沒有引進任何圖表函式庫（規劃 §4.1 的 Non-goal）', () => {
        const src = source('students.js');
        assert.ok(src.includes('createElementNS'), '應該用 inline SVG');
        assert.ok(!/^\s*import\s/m.test(src), 'students.js 不該 import 任何東西（含圖表函式庫）');
    });

    test('PATCH 的 100 筆上限有被擋（第 1.4 條）', () => {
        const src = source('students.js');
        assert.match(src, /MAX_PATCH\s*=\s*100/);
        assert.ok(src.includes('results.length > MAX_PATCH'), '沒有擋 100 筆上限');
    });
});

// ─────────────────────────────────────────────────────────────
describe('nlq.js 的純函式（P-09）', () => {
    test('explainFilters：沒抓到的條件也要講出來（老師要知道系統少理解了什麼）', async () => {
        const { explainFilters } = await load('nlq.js');
        const s = explainFilters({
            subject: null, chapters: [], question_types: [],
            difficulty_min: null, difficulty_max: null,
            exclude_student_name: null, semantic_text: '', keywords: []
        });
        assert.ok(s.includes('不分科'), s);
        assert.ok(s.includes('章節：不限'), s);
        assert.ok(s.includes('題型：不限'), s);
        assert.ok(s.includes('難度：不限'), s);
    });

    test('explainFilters：抓到的條件逐項出現，難度單值不寫成 4~4', async () => {
        const { explainFilters } = await load('nlq.js');
        const s = explainFilters({
            subject: '物理', chapters: ['牛頓運動定律', '摩擦力與向心力'], question_types: ['計算'],
            difficulty_min: 4, difficulty_max: 5, exclude_student_name: '小明',
            semantic_text: '牛頓第二定律 摩擦力', keywords: []
        });
        assert.ok(s.includes('物理') && s.includes('牛頓運動定律') && s.includes('摩擦力與向心力'), s);
        assert.ok(s.includes('難度：4~5'), s);
        assert.ok(s.includes('小明'), s);

        const one = explainFilters({ subject: '數學', chapters: [], question_types: [], difficulty_min: 3, difficulty_max: 3 });
        assert.ok(one.includes('難度：3') && !one.includes('3~3'), one);
    });

    test('fallbackNotice：level 0 + rules 是中性提示（不是警告）', async () => {
        const { fallbackNotice } = await load('nlq.js');
        const n = fallbackNotice({ parse_path: 'rules', fallback_level: 0, warnings: [] });
        assert.equal(n.tone, 'slate');
        assert.deepEqual(n.lines, []);
    });

    test('fallbackNotice：parse_path=llm_failed 或 fallback_level ≥ 1 一律轉淡黃', async () => {
        const { fallbackNotice } = await load('nlq.js');
        assert.equal(fallbackNotice({ parse_path: 'llm_failed', fallback_level: 1, warnings: [] }).tone, 'amber');
        assert.equal(fallbackNotice({ parse_path: 'rules', fallback_level: 2, warnings: [] }).tone, 'amber');
        assert.equal(fallbackNotice({ parse_path: 'rules', fallback_level: 3, warnings: [] }).tone, 'amber');
        // 理論上不會發生的組合（llm_failed 一定伴隨 level 1），但真的來了也要顯示成警告
        assert.equal(fallbackNotice({ parse_path: 'llm_failed', fallback_level: 0, warnings: [] }).tone, 'amber');
    });

    test('fallbackNotice：伺服器的 warning 原文一字不改地放在最前面（第 6.6 條逐字凍結）', async () => {
        const { fallbackNotice } = await load('nlq.js');
        const frozen = 'LLM 解析逾時或不合 schema，只用規則解析的結果。';
        const n = fallbackNotice({ parse_path: 'llm_failed', fallback_level: 1, warnings: [frozen] });
        assert.equal(n.lines[0], frozen, '不得重寫或翻譯伺服器的 warning');
        assert.ok(n.lines.length > 1, '除了原文之外還要有一句白話說明');
    });

    test('四級回退階梯都有白話說明，0 級沒有', async () => {
        const { FALLBACK_NOTE } = await load('nlq.js');
        assert.equal(FALLBACK_NOTE[0], null);
        for (const level of [1, 2, 3]) {
            assert.equal(typeof FALLBACK_NOTE[level], 'string');
            assert.ok(FALLBACK_NOTE[level].trim().length > 0, `level ${level} 沒有說明`);
        }
    });

    test('formatScore：fallback_level=3 的 null 是「—」，不是 0.0000', async () => {
        const { formatScore } = await load('nlq.js');
        assert.equal(formatScore(null), '—');
        assert.equal(formatScore(undefined), '—');
        assert.equal(formatScore(0.0325), '0.0325');
        assert.equal(formatScore(0), '0.0000');
    });

    test('dropdownWriteback：多章節只回寫第一個，其餘要被講出來（不得悄悄丟掉）', async () => {
        const { dropdownWriteback } = await load('nlq.js');
        const w = dropdownWriteback({
            subject: '物理', chapters: ['牛頓運動定律', '摩擦力與向心力'], question_types: ['計算', '證明'],
            difficulty_min: 4, difficulty_max: 5, exclude_student_name: '小明'
        });
        assert.equal(w.subject, '物理');
        assert.equal(w.chapter, '牛頓運動定律');
        assert.equal(w.question_type, '計算');
        assert.equal(w.dropped.length, 4, w.dropped.join(' / '));
        assert.ok(w.dropped.some(d => d.includes('摩擦力與向心力')), w.dropped.join(' / '));
        assert.ok(w.dropped.some(d => d.includes('難度')), w.dropped.join(' / '));
    });

    test('dropdownWriteback：全空時三個下拉都清成「全部」', async () => {
        const { dropdownWriteback } = await load('nlq.js');
        const w = dropdownWriteback({ subject: null, chapters: [], question_types: [], difficulty_min: null });
        assert.deepEqual({ ...w, dropped: w.dropped.length }, { subject: '', chapter: '', question_type: '', dropped: 0 });
    });

    test('回寫時只觸發一次 change（三個下拉各觸發一次 = 三次查詢）', () => {
        const src = source('nlq.js');
        const dispatches = src.match(/dispatchEvent\(new Event\('change'/g) || [];
        assert.equal(dispatches.length, 1, `應該只有一次 change，實際 ${dispatches.length} 次`);
        assert.ok(src.includes('getChapterWhitelist'), '章節選項應該自己用 getChapterWhitelist 重建');
    });
});

// ─────────────────────────────────────────────────────────────
describe('variants.js 的純函式（P-13）', () => {
    test('chipFor：needs_review 的 awaiting_approval 與其他 reason 必須分開', async () => {
        const { chipFor } = await load('variants.js');
        // 兩者停在同一個 state，但意義完全相反：一個是「等你點頭」，一個是「有東西壞了」。
        const ok = chipFor({ state: 'needs_review', review_reason: 'awaiting_approval' });
        const bad = chipFor({ state: 'needs_review', review_reason: 'answer_mismatch' });
        assert.equal(ok.label, '待核准');
        assert.equal(ok.tone, 'amber');
        assert.ok(bad.label.includes('答案對不上'), bad.label);
        assert.equal(bad.tone, 'rose');
        assert.notEqual(ok.label, bad.label);
    });

    test('chipFor：九個合法 state 都有 chip，沒有一個是空字串', async () => {
        const { chipFor } = await load('variants.js');
        const STATES = ['extracted', 'hashed', 'classified', 'linted', 'verified',
            'deduped', 'saved', 'needs_review', 'rejected'];
        for (const state of STATES) {
            const c = chipFor({ state, review_reason: null });
            assert.equal(typeof c.label, 'string');
            assert.ok(c.label.trim().length > 0, state);
            assert.ok(['indigo', 'emerald', 'amber', 'rose', 'slate'].includes(c.tone), `${state} 的 tone=${c.tone}`);
        }
    });

    test('chipFor：六個中間狀態只講「生成中／檢查中」，不洩漏節點名', async () => {
        const { chipFor } = await load('variants.js');
        assert.equal(chipFor({ state: 'extracted' }).label, '生成中');
        for (const s of ['hashed', 'classified', 'linted', 'verified', 'deduped']) {
            assert.equal(chipFor({ state: s }).label, '檢查中', s);
        }
    });

    test('chipFor：未知 state 也回得出東西（不會顯示 undefined）', async () => {
        const { chipFor } = await load('variants.js');
        const c = chipFor({ state: 'something_new' });
        assert.equal(c.label, 'something_new');
        assert.equal(c.tone, 'slate');
        assert.equal(chipFor(null).label, '未知');
    });

    test('八個 review_reason 都有標籤（與 review.js 的 REASON_LABEL 同一組字）', async () => {
        const { REASON_LABEL } = await load('variants.js');
        const REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate',
            'schema_invalid', 'budget_exceeded', 'provider_error', 'awaiting_approval'];
        assert.deepEqual(Object.keys(REASON_LABEL).sort(), [...REASONS].sort());
    });

    test('jobRunning：只有 done／failed 是終態', async () => {
        const { jobRunning } = await load('variants.js');
        for (const s of ['queued', 'extracting', 'processing']) assert.equal(jobRunning(s), true, s);
        for (const s of ['done', 'failed']) assert.equal(jobRunning(s), false, s);
    });

    test('formatCost：0 顯示 $0.0000（不是「—」），null 才是「—」', async () => {
        const { formatCost } = await load('variants.js');
        assert.equal(formatCost(0), '$0.0000');
        assert.equal(formatCost(0.0288), '$0.0288');
        assert.equal(formatCost(null), '—');
        assert.equal(formatCost(undefined), '—');
    });

    test('jobSummary：queued／extracting 不印 counts（裁決 S2-22 的同一條線）', async () => {
        const { jobSummary } = await load('variants.js');
        // 這兩個狀態下 job_questions 還沒被建出來，counts 一定全 0；
        // 印成「已入庫 0」會讓老師以為出事了。
        for (const state of ['queued', 'extracting']) {
            const s = jobSummary({ state, counts: { saved: 0, needs_review: 0, pending: 0, rejected: 0 } });
            assert.ok(!s.includes('已入庫'), `${state}：${s}`);
        }
        const done = jobSummary({ state: 'done', counts: { saved: 2, needs_review: 1, pending: 0, rejected: 0 } });
        assert.ok(done.includes('已入庫 2') && done.includes('待複核 1'), done);
    });

    test('jobSummary：failed 要把 jobs.error 講出來', async () => {
        const { jobSummary } = await load('variants.js');
        const s = jobSummary({ state: 'failed', error: '變式生成全部未通過文字閘門或跑題檢查。' });
        assert.ok(s.includes('變式生成全部未通過文字閘門或跑題檢查。'), s);
    });

    test('輪詢是每 2 秒、上限 60 秒（第 3.2 條）', () => {
        const src = source('variants.js');
        assert.match(src, /POLL_MS\s*=\s*2000/);
        assert.match(src, /POLL_MAX_MS\s*=\s*60000/);
    });

    test('輪詢期間按鈕停用（第 3.2 條：雙擊不該付兩次錢）', () => {
        const src = source('variants.js');
        assert.ok(src.includes('setActionsDisabled(true)'), '沒有在請求開始時停用按鈕');
        assert.ok(src.includes('data-variant-action'), '沒有可以一次停用全部按鈕的標記');
        // students.js 那一端要真的打上這個標記，否則停用永遠是空集合。
        assert.ok(source('students.js').includes("'data-variant-action': action"),
            'students.js 的按鈕沒有標上 data-variant-action');
    });

    test('COUNT／DELTA 的選項與預設值照介面（裁決 S3-R24）', async () => {
        const { COUNT_OPTIONS, DEFAULT_COUNT, DELTA_OPTIONS, DEFAULT_DELTA } = await load('variants.js');
        // 上限 3 = VARIANT_MAX_PER_REQUEST 的預設；預設 1／0 與第 3 條的 body 預設逐字一致。
        assert.deepEqual(COUNT_OPTIONS, [1, 2, 3]);
        assert.equal(DEFAULT_COUNT, 1);
        assert.deepEqual(DELTA_OPTIONS.map(([v]) => v), [-1, 0, 1]);
        assert.equal(DEFAULT_DELTA, 0);
        // 前端不得再寫死 count（之前是 2，那是 eval 的數字不是產品的）
        assert.ok(!/count:\s*2/.test(source('variants.js')), 'variants.js 還把 count 寫死成 2');
        assert.ok(source('variants.js').includes('requestOptions()'), '沒有從下拉讀值');
    });

    test('顯示的是實際 cost_usd，不是預算', () => {
        const src = source('variants.js');
        assert.ok(src.includes('formatCost(job.cost_usd)'), '沒有顯示實際花費');
        assert.ok(src.includes('existing'), '沒有處理合流（裁決 S3-8 的 existing:true）');
    });

    test('待核准會把人帶到複核分頁，而不是在這一頁自己做核准', () => {
        const src = source('variants.js');
        assert.ok(src.includes('前往複核分頁'), '沒有導向複核分頁的出口');
        assert.ok(!src.includes('/approve'), 'variants.js 不該自己呼叫 approve（複核有既有介面）');
    });
});

// ─────────────────────────────────────────────────────────────
describe('students.js 與 variants.js 之間的事件契約', () => {
    test('兩邊宣告的事件名一致，而且不互相 import', async () => {
        const a = await load('students.js');
        const b = await load('variants.js');
        assert.equal(a.VARIANT_EVENT, b.VARIANT_EVENT);
        assert.equal(a.VARIANT_EVENT, 'examapp:variant-request');
        // 互相 import 會讓兩個檔沒辦法各自用 data: URL 載入做單元測試（相對路徑解析不了），
        // 也會在其中一個旗標關閉時把另一個一起拖下水。
        for (const name of ['students.js', 'variants.js']) {
            assert.ok(!/^\s*import\s/m.test(source(name)), `${name} 不該 import 另一個 module`);
        }
    });

    test('「立即批改」的事件名兩邊一致（index.html 發、students.js 收）', async () => {
        const { GRADE_EVENT } = await load('students.js');
        assert.equal(GRADE_EVENT, 'examapp:grade-paper');
        const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
        assert.ok(html.includes("new CustomEvent('examapp:grade-paper')"),
            'index.html 的「立即批改」沒有發出 examapp:grade-paper');
    });

    test('paper_id 從 getPaperCache 讀，不是從事件 detail 帶（裁決 S3-19）', () => {
        const src = source('students.js');
        // currentPaperCache 是會被重新賦值的 let，掛值只會掛到組卷之前那個 null 的快照。
        assert.ok(src.includes('app.getPaperCache()'), '沒有經 getPaperCache 讀 currentPaperCache');
    });
});

// ─────────────────────────────────────────────────────────────
describe('index.html 的橋接（interfaces-stage3.md 第 7.1 條）', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    const bridge = html.match(/window\.ExamApp\s*=\s*Object\.assign\([\s\S]*?\n\s*\}\);/);

    test('十個鍵都在（階段 2 五個 + 階段 3 五個）', () => {
        assert.ok(bridge, '找不到 window.ExamApp 的 Object.assign');
        for (const key of ['apiFetch', 'showToast', 'renderMath', 'escapeHtml', 'createQuestionEditor',
            'getPaperCache', 'setPaperCache', 'getChapters', 'getChapterWhitelist', 'showSection']) {
            assert.ok(bridge[0].includes(key), `橋接少了 ${key}`);
        }
    });

    test('三個會被重新賦值的 let 走 getter，不是掛快照（裁決 S3-19）', () => {
        // 直接 Object.assign 掛的是**當下那個值**：組卷之前 currentPaperCache 是 null，
        // module 之後怎麼讀都還是那個 null。
        assert.ok(/getPaperCache:\s*\(\)\s*=>\s*currentPaperCache/.test(bridge[0]), 'getPaperCache 不是 getter');
        assert.ok(/getChapters:\s*\(\)\s*=>\s*allChapters/.test(bridge[0]), 'getChapters 不是 getter');
        assert.ok(/getChapterWhitelist:\s*\(\)\s*=>\s*chapterWhitelist/.test(bridge[0]), 'getChapterWhitelist 不是 getter');
    });

    test('setPaperCache 是淺層合併並回傳新值（第 7.1 條的簽名）', () => {
        assert.ok(bridge[0].includes('Object.assign({}, currentPaperCache || {}, patch || {})'), bridge[0]);
    });

    test('三個 <meta> 的佔位字串沒被改掉（第 7.3 條的 replaceAll 對象）', () => {
        for (const [name, ph] of [['feature-students', '__FEATURE_STUDENTS__'],
            ['feature-nlq', '__FEATURE_NLQ__'], ['feature-variants', '__FEATURE_VARIANTS__'],
            ['feature-similar', '__FEATURE_SIMILAR__']]) {                    // 第四個（裁決 S3-R25）
            assert.ok(html.includes(`<meta name="${name}" content="${ph}">`), `${name} 的注入點不對`);
        }
    });

    test('index.html 自己那份旗標規則也與 config/features.js 相同', () => {
        // inline script 不是 module，拿不到 public/js/*.js 匯出的 parseBool，所以自己有一份。
        assert.ok(html.includes("v === '1' || v === 'true'"), 'featureOn 的規則與 parseBool 不一致');
    });

    test('舊流程與階段 2 的接點都沒被動到', () => {
        for (const marker of ['/api/analyze-pdf', '/api/batch-save-questions',
            '<section id="review"></section>', '/js/review.js']) {
            assert.ok(html.includes(marker), `index.html 找不到 ${marker}`);
        }
    });
});
