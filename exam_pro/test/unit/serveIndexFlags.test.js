// ─────────────────────────────────────────────────────────────
// serveIndexFlags 單元測試 —— app.js 的三個旗標注入（第 7.3 條，擁有者：WS-A）
//
// 這支測試刻意很淺，而且**它自己知道**：真正的功能驗證要等 WS-D 把三個
// <meta> 放進 public/index.html（第 7.2 條的插入點 1）之後，由
// `npm run check:html` 與 e2e 接手。在那之前，佔位字串根本不在檔案裡，
// 任何「打 / 看回應」的測試都會空轉通過。
//
// 而 app.js 又沒辦法在 npm test 裡啟動：它 require config/db.js，
// 缺 DATABASE_URL 就直接丟錯（interfaces.md 第 8 條、D-X1 移除 DB_* 退路之後）。
//
// 所以這裡驗的是**原始碼層級**的三件事，它們正好對應第 7.3 條踩過的坑：
//   1. 三個佔位字串一字不差（打錯一個字元 = 前端永遠讀到未替換的字串）
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

/** 第 7.3 條凍結的三組（佔位字串, 環境變數名）。 */
const INJECTIONS = [
    ['__FEATURE_STUDENTS__', 'FEATURE_STUDENTS'],
    ['__FEATURE_NLQ__', 'FEATURE_NLQ'],
    ['__FEATURE_VARIANTS__', 'FEATURE_VARIANTS']
];

describe('app.js 的 serveIndex — 階段 3 的三個 replaceAll（第 7.3 條）', () => {
    test('三個佔位字串各自被 replaceAll 一次，對應正確的環境變數與預設 false', () => {
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

    test('五個注入全部用 replaceAll，沒有一個是 replace', () => {
        // 佔位字串在 index.html 的說明註解裡也會有一份；replace 只換第一個，
        // 會換到註解而讓真正的 <meta> 留著佔位字串（__FEATURE_PIPELINE__ 踩過）。
        const placeholders = ['__API_KEY__', '__FEATURE_PIPELINE__', ...INJECTIONS.map(i => i[0])];
        for (const placeholder of placeholders) {
            const singleReplace = new RegExp(`\\.replace\\(\\s*'${placeholder}'`);
            assert.ok(!singleReplace.test(source),
                `${placeholder} 用了 replace，必須改成 replaceAll`);
        }
    });

    test('旗標不得被寫死（三個都要走 process.env）', () => {
        for (const [, envName] of INJECTIONS) {
            assert.ok(!new RegExp(`'${envName}'\\s*:\\s*'?true`).test(source),
                `${envName} 疑似被寫死成 true`);
            assert.ok(!new RegExp(`\\.replaceAll\\('__${envName}__',\\s*'true'`).test(source),
                `${envName} 疑似被寫死成 'true'`);
        }
    });
});
