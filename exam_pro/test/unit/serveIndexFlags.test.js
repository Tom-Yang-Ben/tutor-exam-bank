// ─────────────────────────────────────────────────────────────
// serveIndexFlags 單元測試 —— app.js 的四個旗標注入（第 7.3 條 + 裁決 S3-R25，擁有者：WS-A）
//
// 這支測試刻意很淺，而且**它自己知道**：真正的功能驗證要等 WS-D 把四個
// <meta> 放進 public/index.html（第 7.2 條的插入點 1 與裁決 S3-R25）之後，由
// `npm run check:html` 與 e2e 接手。在那之前，佔位字串根本不在檔案裡，
// 任何「打 / 看回應」的測試都會空轉通過。
//
// 而 app.js 又沒辦法在 npm test 裡啟動：它 require config/db.js，
// 缺 DATABASE_URL 就直接丟錯（interfaces.md 第 8 條、D-X1 移除 DB_* 退路之後）。
//
// 所以這裡驗的是**原始碼層級**的三件事，它們正好對應第 7.3 條踩過的坑：
//   1. 四個佔位字串一字不差（打錯一個字元 = 前端永遠讀到未替換的字串）
//   2. 用 replaceAll 不是 replace（佔位字串在說明註解裡也會有一份，
//      __FEATURE_PIPELINE__ 就是這樣被換到註解上的）
//   3. 未設定時退回字面 'false'（安全預設；parseBool 對它判為假）
//
// 執行：npm test
// ─────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = path.resolve(__dirname, '..', '..', 'app.js');
const source = fs.readFileSync(APP_JS, 'utf8');

/** 第 7.3 條凍結的三組（佔位字串, 環境變數名），加上裁決 S3-R25 的第四組。 */
const INJECTIONS = [
    ['__FEATURE_STUDENTS__', 'FEATURE_STUDENTS'],
    ['__FEATURE_NLQ__', 'FEATURE_NLQ'],
    ['__FEATURE_VARIANTS__', 'FEATURE_VARIANTS'],
    // S3-R25：第四個注入點。對應的是**階段 1 就有**的 FEATURE_SIMILAR，
    // 不是階段 3 新旗標——「找相似」打的是 GET /api/questions/:id/similar，
    // 那條路由沒掛載時按鈕得跟著關，否則老師只會拿到 404。
    ['__FEATURE_SIMILAR__', 'FEATURE_SIMILAR'],
    // 階段 4 A1：對話式助教（第七個注入點）
    ['__FEATURE_ASSISTANT__', 'FEATURE_ASSISTANT']
];

describe('app.js 的 serveIndex — 階段 3 的四個 replaceAll（第 7.3 條 + S3-R25）', () => {
    test('四個佔位字串各自被 replaceAll 一次，對應正確的環境變數與預設 false', () => {
        for (const [placeholder, envName] of INJECTIONS) {
            const pattern = new RegExp(
                `\\.replaceAll\\(\\s*'${placeholder}'\\s*,\\s*process\\.env\\.${envName}\\s*\\|\\|\\s*'false'\\s*\\)`
            );
            assert.match(source, pattern,
                `app.js 缺少 .replaceAll('${placeholder}', process.env.${envName} || 'false')`);
        }
    });

    test('階段 2 的兩個注入原封不動（__API_KEY__ 與 __FEATURE_PIPELINE__）', () => {
        assert.match(source, /\.replaceAll\('__API_KEY__', key\)/);
        assert.match(source, /\.replaceAll\('__FEATURE_PIPELINE__', pipeline\)/);
    });

    test('__FEATURE_SIMILAR__ 讀的是階段 1 的 FEATURE_SIMILAR，不是自己新造的變數（S3-R25）', () => {
        // 這一項要擋的是「順手加一個 FEATURE_SIMILAR_UI 之類的新旗標」：
        // 那會讓路由掛不掛載與按鈕顯不顯示由兩個變數決定，遲早各走各的。
        assert.match(source,
            /\.replaceAll\('__FEATURE_SIMILAR__', process\.env\.FEATURE_SIMILAR \|\| 'false'\)/);
        assert.ok(!/FEATURE_SIMILAR_[A-Z]/.test(source),
            '不得另造 FEATURE_SIMILAR_* 旗標——與 routes 的 isSimilarEnabled() 必須是同一個變數');
    });

    test('七個注入全部用 replaceAll，沒有一個是 replace', () => {
        // 佔位字串在 index.html 的說明註解裡也會有一份；replace 只換第一個，
        // 會換到註解而讓真正的 <meta> 留著佔位字串（__FEATURE_PIPELINE__ 踩過）。
        const placeholders = ['__API_KEY__', '__FEATURE_PIPELINE__', ...INJECTIONS.map(i => i[0])];
        for (const placeholder of placeholders) {
            const singleReplace = new RegExp(`\\.replace\\(\\s*'${placeholder}'`);
            assert.ok(!singleReplace.test(source),
                `${placeholder} 用了 replace，必須改成 replaceAll`);
        }
    });

    test('旗標不得被寫死（四個都要走 process.env）', () => {
        for (const [, envName] of INJECTIONS) {
            assert.ok(!new RegExp(`'${envName}'\\s*:\\s*'?true`).test(source),
                `${envName} 疑似被寫死成 true`);
            assert.ok(!new RegExp(`\\.replaceAll\\('__${envName}__',\\s*'true'`).test(source),
                `${envName} 疑似被寫死成 'true'`);
        }
    });
});
