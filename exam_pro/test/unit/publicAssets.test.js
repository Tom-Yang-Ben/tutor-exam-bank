// 前端資產的語法與契約測試（A-T13）
//
// `public/index.html` 有一段一千多行的 inline script，而它**不在任何測試的路徑上**：
// npm test 只跑 test/unit/、整合測試打的是 API。少一個右大括號，唯一的症狀是
// 打開瀏覽器整頁沒有反應，而 CI 全綠。這一支把 `npm run check:html` 的檢查搬進 CI，
// 讓它每次 push 都跑，而不是只在有人記得手動跑的時候跑。
//
// 另外測 public/js/review.js 的三個純函式（reasonSentence／payloadToQuestion／parseBool）。
// 它們是 UI 唯一「算得出對錯」的部分——原因列那句話錯了，老師看到的就是誤導。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const check = require('../../eval/tools/check_html');

const REVIEW_JS = path.resolve(__dirname, '..', '..', 'public', 'js', 'review.js');

describe('public/ 的語法檢查（npm run check:html）', () => {
    test('所有 inline script 與 public/js/*.js 都 parse 得過', () => {
        const { checked, problems } = check.checkAll();
        assert.equal(problems.length, 0, problems.join('\n\n'));
        assert.ok(checked >= 2, `只檢查到 ${checked} 段，index.html 的 inline script 應該有被掃到`);
    });

    test('interfaces-stage2.md 第 8 條的三個接點都還在', () => {
        const problems = check.checkContracts();
        assert.equal(problems.length, 0, problems.join('\n'));
    });

    test('HTML 註解會先被挖空（註解裡的 <script> 不該被當成程式碼）', () => {
        // 實際踩過：註解裡寫「只插一行 <script type="module">」會讓抽取器把註解送去 parse。
        const html = '<!-- 說明：只插一行 <script type="module">。 -->\n<script>var a = 1;</script>';
        const blocks = check.extractInlineScripts(html);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].code, 'var a = 1;');
        assert.equal(blocks[0].isModule, false);
    });

    test('挖空註解時保留行數，回報的行號才指得到原始位置', () => {
        const html = '<!-- 一\n二\n三 -->\n<script>var a = 1;</script>';
        assert.equal(check.extractInlineScripts(html)[0].line, 4);
    });

    test('有 src 的 <script> 不會被當成 inline（CDN 抓不到、本地檔另外檢查）', () => {
        const html = '<script src="https://cdn.example/x.js"></script>';
        assert.equal(check.extractInlineScripts(html).length, 0);
    });

    test('壞掉的語法會被抓到（這一條在驗檢查器本身有沒有在做事）', () => {
        const res = check.checkSyntax('function f( { return 1 }', false, 'fake.js');
        assert.equal(res.ok, false);
        assert.ok(res.message.includes('fake.js'), res.message);
    });

    test('module 與 script 兩種模式分開判定', () => {
        assert.equal(check.checkSyntax('export const a = 1;', true, 'm.mjs').ok, true);
        assert.equal(check.checkSyntax('export const a = 1;', false, 's.js').ok, false);
    });
});

describe('public/js/review.js 的純函式', () => {
    // review.js 是 ES module，但本專案 package.json 是 "type": "commonjs"，
    // 所以直接 import() 一個 .js 檔會被當成 CJS 解析而炸在 `export` 上。
    // 讀原始碼再以 data: URL 當成模組載入，可以避開副檔名決定模組型別這件事，
    // 而且不必為了測試在 public/js/ 底下多丟一個 package.json（那會被 express.static 一起公開）。
    // review.js 沒有任何 import，所以 data: URL 沒有相對路徑解析的問題。
    // 底部的 `typeof document !== 'undefined'` 守衛讓它在沒有 DOM 的 Node 裡 import 不會爆。
    let cached = null;
    const load = () => {
        if (!cached) {
            const src = fs.readFileSync(REVIEW_JS, 'utf8');
            cached = import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
        }
        return cached;
    };

    test('parseBool 與後端 config/features.js 的規則逐字相同', async () => {
        const { parseBool } = await load();
        const { parseBool: backend } = require('../../config/features');
        for (const v of ['1', 'true', 'TRUE', ' True ', '0', 'false', 'off', 'no', '', null, undefined, '__FEATURE_PIPELINE__']) {
            assert.equal(parseBool(v), backend(v), `「${v}」兩邊解讀不同`);
        }
    });

    test('未被替換的注入佔位字串一律判成 false（安全預設）', async () => {
        const { parseBool } = await load();
        assert.equal(parseBool('__FEATURE_PIPELINE__'), false);
    });

    test('payloadToQuestion：lint 的文字優先於 extract、classify 的章節優先於 extract', async () => {
        const { payloadToQuestion } = await load();
        const q = payloadToQuestion({
            extract: { subject: '數學', chapter: '純量積', question_type: '計算', difficulty: 2, question_text: '原文', answer_text: '原答' },
            classify: { chapter: '向量內積' },
            lint: { question_text: '修過的題幹', answer_text: '修過的答案' }
        });
        // 第 3.2 條：save 用的是 classify 的章節與 lint 的文字，複核卡片也必須一致，
        // 否則老師看到的跟系統要寫進去的是兩份東西。
        assert.equal(q.chapter, '向量內積');
        assert.equal(q.question_text, '修過的題幹');
        assert.equal(q.answer_text, '修過的答案');
        assert.equal(q.subject, '數學');
        assert.equal(q.difficulty, 2);
    });

    test('payloadToQuestion：只有 extract 時退回 extract 的欄位', async () => {
        const { payloadToQuestion } = await load();
        const q = payloadToQuestion({ extract: { subject: '物理', chapter: '直線運動', question_text: 'q', answer_text: 'a' } });
        assert.equal(q.chapter, '直線運動');
        assert.equal(q.question_text, 'q');
    });

    test('payloadToQuestion：空 payload 不爆，回可用的預設值', async () => {
        const { payloadToQuestion } = await load();
        const q = payloadToQuestion(null);
        assert.equal(q.subject, '數學');
        assert.equal(q.question_text, '');
    });

    test('reasonSentence(answer_mismatch)：兩個答案都要出現在句子裡', async () => {
        const { reasonSentence } = await load();
        const s = reasonSentence('answer_mismatch', {
            verify: { final_answer: '(B)', claimed_answer: '(C)', compare: 'disagree' }
        });
        assert.ok(s.includes('(B)') && s.includes('(C)'), s);
    });

    test('reasonSentence(formula_unparsable)：指出具體規則與位置', async () => {
        const { reasonSentence } = await load();
        const s = reasonSentence('formula_unparsable', {
            lint: { rewritten: true, issues: [{ sev: 'error', rule: 'missing_rbrace', at: 8, msg: '\\frac{1}{2 缺右大括號' }] }
        });
        assert.ok(s.includes('missing_rbrace') && s.includes('8'), s);
        assert.ok(s.includes('LLM 重寫'), '應該提到已經試過重寫');
    });

    test('reasonSentence(duplicate)：說出跟誰重複', async () => {
        const { reasonSentence } = await load();
        assert.ok(reasonSentence('duplicate', { dedup0: { hit: { scope: 'db', question_id: 128 } } }).includes('#128'));
        assert.ok(reasonSentence('duplicate', { dedup0: { hit: { scope: 'job', jq_id: 55 } } }).includes('55'));
        assert.ok(reasonSentence('duplicate', {
            dedup1: { threshold_used: 0.97, top: [{ question_id: 87, cosine: 0.9812 }] }
        }).includes('#87'));
    });

    test('reasonSentence(chapter_invalid)：優先用 agent 的 feedback 原文', async () => {
        const { reasonSentence } = await load();
        const feedback = '「純量積」不在白名單內，最接近的是「向量內積」「空間向量內積」';
        assert.equal(reasonSentence('chapter_invalid', { classify: { feedback } }), feedback);
    });

    test('八個 review_reason 都有句子，且沒有一個是空字串', async () => {
        const { reasonSentence } = await load();
        const REASONS = ['chapter_invalid', 'formula_unparsable', 'answer_mismatch', 'duplicate',
            'schema_invalid', 'budget_exceeded', 'provider_error', 'awaiting_approval'];
        for (const r of REASONS) {
            const s = reasonSentence(r, {});
            assert.equal(typeof s, 'string');
            assert.ok(s.trim().length > 0, `${r} 沒有句子`);
        }
    });

    test('未知的 reason 也回得出一句話（不會顯示 undefined）', async () => {
        const { reasonSentence } = await load();
        assert.ok(reasonSentence('something_new', {}).includes('something_new'));
    });
});

describe('review.js 的檔案層級契約', () => {
    const source = fs.readFileSync(REVIEW_JS, 'utf8');

    test('不自己複製 createQuestionEditor，一律經 window.ExamApp（第 8 條）', () => {
        assert.ok(source.includes('window.ExamApp'), '沒有經橋接');
        assert.ok(!/function\s+createQuestionEditor/.test(source), 'review.js 自己定義了 createQuestionEditor');
    });

    test('FEATURE_PIPELINE 沒有被寫死成 true（第 8 條明文禁止）', () => {
        assert.ok(!/FEATURE_PIPELINE\s*=\s*true/.test(source));
        assert.ok(source.includes('meta[name="feature-pipeline"]'), '應該從 index.html 的注入點讀');
    });

    test('輪詢間隔是 3 秒（第 8 條）', () => {
        assert.match(source, /POLL_MS\s*=\s*3000/);
    });

    test('上傳的欄位名是 pdf（第 6.1 條）', () => {
        assert.ok(source.includes("formData.append('pdf'"), '欄位名必須是 pdf');
    });

    test('mock 資料只在 ?mock=1 時被讀到', () => {
        // 靜默的假資料比壞掉更難查。唯一讀 MOCK 的地方是 request()，而它第一行就檢查旗標——
        // 所以「所有讀取 MOCK 的程式碼都在那個 return 之後」就等於「旗標關閉時讀不到假資料」。
        const guard = source.indexOf('if (!mockEnabled()) return app.apiFetch');
        assert.ok(guard > 0, 'request() 沒有以旗標檢查開頭');
        let offset = 0;
        for (const line of source.split('\n')) {
            const at = offset;
            offset += line.length + 1;
            const trimmed = line.trim();
            if (!/\bMOCK\./.test(line) || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
            assert.ok(at > guard, `MOCK 在旗標檢查之前就被讀到：${trimmed}`);
        }
    });
});
