// ─────────────────────────────────────────────────────────────
// chapterMigration.test.js — 舊題搬章工具的純函式（章節重整 CH-A；docs/chapter-restructure.md 第 3.1 條第 7 點）
//
// 對象：config/chapterMigrationRules.js（關鍵字規則）與 scripts/migrate_chapters.js 匯出的純函式
//（提議、CSV 讀寫與解碼、逐列驗證、參數、提議檔路徑）。DB 的部分在 test/integration/chapterMigration.pg.test.js。
// 不連 DB、不連 LLM。題幹全為自製。執行：npm test
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PLAN_CHAPTERS, MIGRATION } = require('../../config/chapterPlan');
const rules = require('../../config/chapterMigrationRules');
const mig = require('../../scripts/migrate_chapters');

const q = (subject, chapter, question_text, extra = {}) => ({ id: 1, subject, chapter, question_text, ...extra });

describe('config/chapterMigrationRules.js', () => {
    test('規則表自我檢查全數通過：去處都在新白名單、都是某個拆分舊章的去處、關鍵字不指向兩個章', () => {
        assert.deepEqual(rules.validateRules(), []);
    });

    test('validateRules 真的抓得到違規（防止測試自己壞掉還全綠）', () => {
        const bad = rules.validateRules({
            '數學': [
                { to: '不存在的章', keywords: ['x'] },
                { to: '拋物線', keywords: ['焦點'] },             // 純新增章，沒有舊章會拆過去
                { to: '級數', keywords: [] },
                { to: '二項式定理', keywords: ['二項'] },
                { to: '組合', keywords: ['二項'] },
                { to: '廣義角與極坐標', patterns: [{ name: 'x' }] }
            ]
        });
        assert.ok(bad.some(p => p.includes('不存在的章')), bad.join('\n'));
        assert.ok(bad.some(p => p.includes('拋物線') && p.includes('用不到')), bad.join('\n'));
        assert.ok(bad.some(p => p.includes('沒有關鍵字')), bad.join('\n'));
        assert.ok(bad.some(p => p.includes('「二項」同時指向')), bad.join('\n'));
        assert.ok(bad.some(p => p.includes('patterns 每一項都要有 name 與 find 函式')), bad.join('\n'));
    });

    test('契約第 3.1 條第 7 點列舉的每一組關鍵字都指向指定的新章', () => {
        const expected = [
            [['和角', '倍角', '半角'], '和角與差角公式'],
            [['疊合'], '三角函數的疊合'],
            [['條件機率', '貝氏', '獨立事件'], '條件機率與貝氏定理'],
            [['二項式', '二項展開'], '二項式定理'],
            [['Σ', '級數'], '級數'],
            [['遞迴', '數學歸納'], '數列與遞迴關係'],
            [['複數', '虛數'], '複數與多項式方程式'],
            [['不等式'], '多項式不等式'],
            [['集合', '排容', '文氏圖'], '集合與計數原理'],
            [['轉移矩陣', '線性變換', '旋轉', '鏡射'], '矩陣的應用'],
            [['聯立', '高斯消去', '三元'], '一次方程組'],
            [['二元一次', '克拉瑪'], '面積與行列式'],
            [['廣義角', '標準位置', '極坐標'], '廣義角與極坐標'],
            [['圖形', '週期', '振幅', '弧度'], '三角函數的圖形'],
            [['二項分布', '幾何分布'], '二項分布與幾何分布'],
            [['指數函數', '對數函數'], '指數函數與對數函數']
        ];
        const owner = new Map();
        for (const r of rules.KEYWORD_RULES['數學']) for (const k of r.keywords || []) owner.set(k, r.to);
        for (const [kws, to] of expected) for (const k of kws) assert.equal(owner.get(k), to, `「${k}」`);
        const phys = new Map();
        for (const r of rules.KEYWORD_RULES['物理']) for (const k of r.keywords || []) phys.set(k, r.to);
        assert.equal(phys.get('質心'), '質心與角動量');
        assert.equal(phys.get('角動量'), '質心與角動量');
    });

    test('matchKeywordRule 只在該舊章的拆分去處裡找（「不等式」不會把絕對值的題拉走）', () => {
        const targets = MIGRATION['數學']['三次函數'].to;
        assert.equal(rules.matchKeywordRule('數學', targets, [['解不等式 $x^3-x>0$']]).to, '多項式不等式');
        assert.equal(rules.matchKeywordRule('數學', ['絕對值'], [['解不等式 $|x|<3$']]), null);
    });

    test('題幹那一輪命中就不看 metadata；題幹沒命中才看 metadata', () => {
        const targets = MIGRATION['數學']['正弦與餘弦定理'].to;
        const a = rules.matchKeywordRule('數學', targets, [['把正弦與餘弦疊合成一個'], ['和角公式']]);
        assert.deepEqual(a, { to: '三角函數的疊合', keyword: '疊合', pass: 0 });
        const b = rules.matchKeywordRule('數學', targets, [['求 $\\sin 75^\\circ$'], ['和角公式', '']]);
        assert.deepEqual(b, { to: '和角與差角公式', keyword: '和角', pass: 1 });
    });

    test('LaTeX 的 \\sum 與符號 Σ 都認得；比對前做 NFKC（全形的「＼ｓｕｍ」也對得上）', () => {
        const targets = MIGRATION['數學']['數列與級數'].to;
        assert.deepEqual(rules.matchKeywordRule('數學', targets, [['求 $\\sum_{k=1}^{10} k$']]), { to: '級數', keyword: '\\sum', pass: 0 });
        assert.deepEqual(rules.matchKeywordRule('數學', targets, [['Σ 的性質']]), { to: '級數', keyword: 'Σ', pass: 0 });
        assert.deepEqual(rules.matchKeywordRule('數學', targets, [['求 ＼ｓｕｍ k']]), { to: '級數', keyword: '\\sum', pass: 0 });
        assert.equal(rules.normalizeForMatch('（Ａ）'), '(A)');
        // 連加符號 U+2211 經 NFKC 不會變成希臘字母 Σ（U+03A3），要另外收
        assert.equal('∑'.normalize('NFKC'), '∑');
        assert.deepEqual(rules.matchKeywordRule('數學', targets, [['求 ∑_{k=1}^{10} k^2']]), { to: '級數', keyword: '∑', pass: 0 });
    });

    test('findWideAngle：大於 90° 或負的角度（°、^\\circ、^{\\circ}、度）；正好 90°、減號、銳角不算', () => {
        assert.equal(rules.findWideAngle('求 sin 150° 之值'), '150°');
        assert.equal(rules.findWideAngle('cos 120^\\circ'), '120^\\circ');
        assert.equal(rules.findWideAngle('$\\tan 225^{\\circ}$'), '225^{\\circ}');
        assert.equal(rules.findWideAngle('轉了 400 度'), '400 度');
        assert.equal(rules.findWideAngle('求 $\\sin(-30^\\circ)$'), '-30^\\circ');
        assert.equal(rules.findWideAngle('角 −60° 的三角比'), '−60°');
        assert.equal(rules.findWideAngle('直角三角形 ABC 中 ∠C=90°'), null);
        assert.equal(rules.findWideAngle('sin(x-30°) 的最大值'), null, '前面是字母的減號不是負角');
        assert.equal(rules.findWideAngle('sin 30° + cos 60°'), null);
        assert.equal(rules.findWideAngle('長度 150 公分'), null);
    });

    test('〔章節重整整合〕findNonCommonLogBase：底數不是 10 的對數才算；常用對數與不寫底數的 log 不算', () => {
        assert.equal(rules.findNonCommonLogBase('求 $\\log_{2} 8$'), '\\log_{2}');
        assert.equal(rules.findNonCommonLogBase('$\\log_3 27$ 之值'), '\\log_3');
        assert.equal(rules.findNonCommonLogBase('設 log_a b = 2'), 'log_a');
        assert.equal(rules.findNonCommonLogBase('$\\log_{\\frac{1}{2}} x > 1$') !== null, true);
        assert.equal(rules.findNonCommonLogBase('$\\log_{10} 2 \\approx 0.3010$'), null);
        assert.equal(rules.findNonCommonLogBase('$\\log 2 \\approx 0.3010$，求 $\\log 5$'), null);
        assert.equal(rules.findNonCommonLogBase('$\\log_{10} 2$ 與 $\\log_{5} 2$'), '\\log_{5}', '常用對數之後的非常用底仍會命中');
        assert.equal(rules.findNonCommonLogBase(''), null);
        assert.equal(rules.findNonCommonLogBase(undefined), null);
    });

    test('〔章節重整整合〕指數與對數：換底、指數／對數方程式與不等式、非常用底 → 指數函數與對數函數；常用對數留原章', () => {
        const targets = MIGRATION['數學']['指數與對數'].to;
        const to = t => (rules.matchKeywordRule('數學', targets, [[t]]) || {}).to || null;
        assert.equal(to('利用換底公式求 $\\log_2 3 \\cdot \\log_3 4$'), '指數函數與對數函數');
        assert.equal(to('解指數方程式 $4^x - 3\\cdot 2^x + 2 = 0$'), '指數函數與對數函數');
        assert.equal(to('解對數方程式'), '指數函數與對數函數');
        assert.equal(to('解指數不等式 $2^{x+1} > 8$'), '指數函數與對數函數');
        assert.equal(to('解對數不等式'), '指數函數與對數函數');
        assert.equal(to('求 $\\log_{3} 81$'), '指數函數與對數函數');
        assert.equal(to('已知 $\\log 2 \\approx 0.3010$，求 $2^{50}$ 的位數'), null, '常用對數題沒命中 → 由 proposeChapter 回到預設去處');
    });

    test('〔章節重整整合〕三次函數：根與係數、共軛 → 複數與多項式方程式', () => {
        const targets = MIGRATION['數學']['三次函數'].to;
        assert.equal(rules.matchKeywordRule('數學', targets, [['由根與係數關係求 $\\alpha^2+\\beta^2+\\gamma^2$']]).to, '複數與多項式方程式');
        assert.equal(rules.matchKeywordRule('數學', targets, [['實係數方程式有一根 $1+i$，則其共軛也是根']]).to, '複數與多項式方程式');
    });
});

describe('proposeChapter：依 MIGRATION 提議新章', () => {
    test('rename：直接提議新章（多項式除法 → 多項式的運算與應用）', () => {
        assert.deepEqual(mig.proposeChapter(q('數學', '多項式除法', '以綜合除法求商式')),
            { chapter: '多項式的運算與應用', basis: 'rename' });
    });

    test('split：關鍵字命中 → keyword:<命中詞>；沒命中 → to[0]（default）', () => {
        assert.deepEqual(mig.proposeChapter(q('數學', '古典機率', '已知 A 發生的條件下，求條件機率 P(B|A)')),
            { chapter: '條件機率與貝氏定理', basis: 'keyword:條件機率' });
        assert.deepEqual(mig.proposeChapter(q('數學', '古典機率', '擲兩顆骰子，點數和為 7 的機率')),
            { chapter: '古典機率', basis: 'default' });
        assert.deepEqual(mig.proposeChapter(q('數學', '三角函數的定義', '直角三角形中已知一銳角的正弦值')),
            { chapter: '直角三角形的邊角關係', basis: 'default' });
        assert.deepEqual(mig.proposeChapter(q('物理', '剛體轉動與平衡', '求系統的質心位置')),
            { chapter: '質心與角動量', basis: 'keyword:質心' });
    });

    test('三角函數的定義：廣義角字眼 > 圖形 > 大於 90° 或負的角度 > 預設直角三角形', () => {
        const p = (text) => mig.proposeChapter(q('數學', '三角函數的定義', text));
        assert.deepEqual(p('求 $\\sin 150^\\circ$、$\\cos 120^\\circ$、$\\tan 225^\\circ$ 之值'),
            { chapter: '廣義角與極坐標', basis: 'keyword:150^\\circ' });
        assert.deepEqual(p('若 $\\theta=-45^\\circ$，求 $\\tan\\theta$'), { chapter: '廣義角與極坐標', basis: 'keyword:-45^\\circ' });
        assert.deepEqual(p('角 θ 在第二象限且 sin θ = 3/5'), { chapter: '廣義角與極坐標', basis: 'keyword:象限' });
        assert.deepEqual(p('畫出 y = sin(x + 120°) 的圖形'), { chapter: '三角函數的圖形', basis: 'keyword:圖形' });
        assert.deepEqual(p('直角三角形 ABC 中 ∠C = 90°，AB = 5、BC = 3，求 sin A'), { chapter: '直角三角形的邊角關係', basis: 'default' });
    });

    test('二項分布：「分配」的寫法也認得（二項分配、幾何分配）', () => {
        assert.deepEqual(mig.proposeChapter(q('數學', '隨機變數', 'X 服從二項分配 B(10, 0.3)，求 P(X=2)')),
            { chapter: '二項分布與幾何分布', basis: 'keyword:二項分配' });
        assert.deepEqual(mig.proposeChapter(q('數學', '隨機變數', 'X 服從成功機率 0.2 的幾何分配，求 E(X)')),
            { chapter: '二項分布與幾何分布', basis: 'keyword:幾何分配' });
    });

    test('split：題幹沒有關鍵字時改用 keywords／concept_summary', () => {
        assert.deepEqual(mig.proposeChapter(q('數學', '組合', '求 $x^3$ 項的係數', { keywords: ['二項式定理', '係數'] })),
            { chapter: '二項式定理', basis: 'keyword:二項式' });
        assert.deepEqual(mig.proposeChapter(q('數學', '隨機變數', '求期望值', { keywords: null, concept_summary: '二項分布的期望值' })),
            { chapter: '二項分布與幾何分布', basis: 'keyword:二項分布' });
    });

    test('克拉瑪公式的先後：三元 > 二元一次／克拉瑪 > 聯立', () => {
        assert.equal(mig.proposeChapter(q('數學', '克拉瑪公式', '以克拉瑪公式解二元一次聯立方程式')).chapter, '面積與行列式');
        assert.equal(mig.proposeChapter(q('數學', '克拉瑪公式', '以克拉瑪公式解三元一次聯立方程式')).chapter, '一次方程組');
        assert.equal(mig.proposeChapter(q('數學', '克拉瑪公式', '解聯立方程組')).chapter, '一次方程組');
    });

    test('removed：提議 to[0]；沒有 to 就留空（一律要老師確認）', () => {
        assert.deepEqual(mig.proposeChapter(q('物理', '宇宙學簡介', '哈伯定律')),
            { chapter: '物質的組成（夸克與原子）', basis: 'removed' });
        assert.deepEqual(mig.proposeChapter(q('物理', '流體的壓力與浮力', '木塊浮在水面')), { chapter: '', basis: 'removed' });
    });

    test('same、純新增章、化學、不在對照表的章 → null（不列進提議檔）', () => {
        assert.equal(mig.proposeChapter(q('數學', '向量內積', 'x')), null);
        assert.equal(mig.proposeChapter(q('數學', '拋物線', 'x')), null);
        assert.equal(mig.proposeChapter(q('化學', '溶解度', 'x')), null);
        assert.equal(mig.proposeChapter(q('數學', '不存在的章', 'x')), null);
    });

    test('movableChapters：只有 rename／split／removed，數量與 MIGRATION 一致', () => {
        const list = mig.movableChapters();
        for (const c of list) assert.notEqual(c.kind, 'same');
        const expected = ['數學', '物理'].flatMap(s => Object.values(MIGRATION[s]).filter(m => m.kind !== 'same')).length;
        assert.equal(list.length, expected);
        assert.ok(list.some(c => c.chapter === '多項式除法' && c.kind === 'rename'));
        assert.ok(list.some(c => c.chapter === '流體的壓力與浮力' && c.kind === 'removed'));
    });
});

describe('buildProposals／summarizeProposals', () => {
    const rows = [
        { id: 9, subject: '物理', chapter: '流體的壓力與浮力', question_text: '浮力' },
        { id: 3, subject: '數學', chapter: '正弦與餘弦定理', question_text: '三角形三邊長求角' },
        { id: 2, subject: '數學', chapter: '多項式除法', question_text: '綜合除法', archived: true },
        { id: 1, subject: '數學', chapter: '正弦與餘弦定理', question_text: '利用和角公式求 sin75°' },
        { id: 5, subject: '數學', chapter: '向量內積', question_text: '不該出現' }
    ];

    test('依 MIGRATION 的宣告順序、再依 id 排；same 的題不列；已封存加註', () => {
        const p = mig.buildProposals(rows);
        assert.deepEqual(p.map(x => x.id), [2, 1, 3, 9]);
        assert.equal(p[0].stem, '（已封存）綜合除法');
        assert.equal(p[1].newChapter, '和角與差角公式');
        assert.equal(p[2].newChapter, '正弦與餘弦定理');
    });

    test('統計：依據四類、removed 留空數、提議與舊章相同的題數、各舊章的去處分布', () => {
        const s = mig.summarizeProposals(mig.buildProposals(rows));
        assert.equal(s.total, 4);
        assert.deepEqual(s.bySubject, { '數學': 3, '物理': 1 });
        assert.deepEqual(s.byBasis, { rename: 1, keyword: 1, default: 1, removed: 1 });
        assert.equal(s.removedBlank, 1);
        assert.equal(s.unchanged, 1);
        const sine = s.byOld.find(g => g.chapter === '正弦與餘弦定理');
        assert.deepEqual(sine.to, [{ chapter: '和角與差角公式', n: 1 }, { chapter: '正弦與餘弦定理', n: 1 }]);
    });

    test('題幹預覽：壓掉換行、取前 60 字、Excel 公式字元前面補單引號', () => {
        assert.equal(mig.stemPreview('第一行\n第二行'), '第一行 第二行');
        assert.equal(Array.from(mig.stemPreview('字'.repeat(100))).length, 60);
        assert.equal(mig.stemPreview('=SUM(A1)'), "'=SUM(A1)");
        assert.equal(mig.stemPreview('-3 的絕對值'), "'-3 的絕對值");
        assert.equal(mig.stemPreview('x', true), '（已封存）x');
    });
});

describe('CSV 讀寫', () => {
    const proposals = [
        { id: 12, subject: '數學', oldChapter: '三次函數', newChapter: '多項式不等式', basis: 'keyword:不等式', stem: '解 "x"，並寫成區間' },
        { id: 13, subject: '物理', oldChapter: '流體的壓力與浮力', newChapter: '', basis: 'removed', stem: '含\n換行' }
    ];

    test('toCsv：UTF-8 BOM、CRLF、表頭凍結、含逗號／雙引號／換行的欄位加引號', () => {
        const csv = mig.toCsv(proposals);
        assert.ok(csv.startsWith('﻿'));
        assert.ok(csv.includes('\r\n'));
        assert.equal(csv.slice(1).split('\r\n')[0], 'id,subject,舊章,提議新章,依據,題幹前60字');
        assert.deepEqual(mig.CSV_HEADER, ['id', 'subject', '舊章', '提議新章', '依據', '題幹前60字']);
        assert.ok(csv.includes('"解 ""x""，並寫成區間"'));
    });

    test('parseCsv 讀回 toCsv 的輸出：逐欄相同（往返不失真）', () => {
        const rows = mig.parseCsv(mig.toCsv(proposals));
        assert.equal(rows.length, 3);
        assert.deepEqual(rows[1].cells, ['12', '數學', '三次函數', '多項式不等式', 'keyword:不等式', '解 "x"，並寫成區間']);
        assert.deepEqual(rows[2].cells, ['13', '物理', '流體的壓力與浮力', '', 'removed', '含\n換行']);
        assert.equal(rows[2].line, 3);
    });

    test('parseCsv：LF 換行、略過空白列、行號照實際行數算；雙引號沒收尾丟錯', () => {
        const rows = mig.parseCsv('a,b\n\n1,"x\ny"\n2,z\n');
        assert.deepEqual(rows.map(r => r.line), [1, 3, 5]);
        assert.throws(() => mig.parseCsv('a,b\n1,"x'), /沒有收尾/);
    });

    test('decodeCsvBuffer：UTF-8（含 BOM）、UTF-8（不含 BOM）、Excel 另存的 Big5', () => {
        const text = 'id,subject,舊章,提議新章\r\n';
        assert.equal(mig.decodeCsvBuffer(Buffer.from('﻿' + text, 'utf8')).encoding, 'utf-8');
        assert.equal(mig.decodeCsvBuffer(Buffer.from(text, 'utf8')).text, text);
        // 「id,subject,舊章,提議新章,依據,題幹前60字／7,物理,宇宙學簡介,物質的組成（夸克與原子）,removed,哈伯定律」的 Big5 位元組
        const big5 = Buffer.from('69642c7375626a6563742cc2c2b3b92cb4a3c4b3b773b3b92ca8ccbeda2cc344b746ab653630a6720d0a372caaabb27a2ca674a97abec7c2b2a4b62caaabbde8aabab2d5a6a8a15da66aa74abb50adeca46ca15e2c72656d6f7665642caba2a742a977abdf0d0a', 'hex');
        const d = mig.decodeCsvBuffer(big5);
        assert.equal(d.encoding, 'big5');
        const { rows, errors } = mig.readApplyRows(d.text);
        assert.deepEqual(errors, []);
        assert.deepEqual(rows[0], { line: 2, id: 7, subject: '物理', oldChapter: '宇宙學簡介', newChapter: '物質的組成（夸克與原子）', basis: 'removed' });
    });
});

describe('readApplyRows：逐列驗證（不碰 DB）', () => {
    const header = 'id,subject,舊章,提議新章,依據,題幹前60字';
    const read = (...lines) => mig.readApplyRows([header, ...lines].join('\r\n'));

    test('合法列：新章照白名單的正式寫法回傳；全形／半形括號與多打的空白都認得', () => {
        const { rows, errors } = read(
            '1,數學,三次函數,多項式不等式,keyword:不等式,x',
            '2,物理,宇宙學簡介,物質的組成(夸克與原子),removed,y',
            '3,數學,排列, 集合與計數原理 ,default,z');
        assert.deepEqual(errors, []);
        assert.equal(rows[1].newChapter, '物質的組成（夸克與原子）');
        assert.equal(rows[2].newChapter, '集合與計數原理');
    });

    test('Excel 調動欄位順序也讀得到（以表頭名稱找欄）；依據、題幹欄可以沒有', () => {
        const { rows, errors } = mig.readApplyRows('提議新章,id,舊章,subject\n級數,5,數列與級數,數學\n');
        assert.deepEqual(errors, []);
        assert.deepEqual(rows[0], { line: 2, id: 5, subject: '數學', oldChapter: '數列與級數', newChapter: '級數', basis: '' });
    });

    test('每一種錯都列出行號與原因', () => {
        const { rows, errors } = read(
            'abc,數學,三次函數,多項式不等式,,',
            '0,數學,三次函數,多項式不等式,,',
            '4,化學,溶解度,溶解度,,',
            '5,數學,,多項式不等式,,',
            '6,物理,流體的壓力與浮力,,removed,',
            '7,數學,三次函數,三次函數,,',
            '8,物理,動量與衝量,拋物線,,',
            '9,數學,三次函數,多項式不等式,,',
            '9,數學,三次函數,多項式不等式,,');
        assert.equal(rows.length, 1);
        assert.equal(errors.length, 8, errors.join('\n'));
        assert.match(errors[0], /^第 2 行：id「abc」不是正整數/);
        assert.match(errors[1], /^第 3 行：id「0」/);
        assert.match(errors[2], /第 4 行.*必須是數學或物理/);
        assert.match(errors[3], /第 5 行.*「舊章」是空的/);
        assert.match(errors[4], /第 6 行.*「提議新章」是空的.*把整列刪掉/);
        assert.match(errors[5], /第 7 行.*「三次函數」不在數學的新章節白名單內/);
        assert.match(errors[6], /第 8 行.*「拋物線」不在物理的新章節白名單內/);
        assert.match(errors[7], /第 10 行：題號 9 與第 9 行重複/);
    });

    test('表頭缺欄位、空檔：直接回錯，不逐列看', () => {
        assert.match(mig.readApplyRows('id,subject,舊章\n1,數學,三次函數\n').errors[0], /缺少欄位：提議新章/);
        assert.deepEqual(mig.readApplyRows('').errors, ['CSV 是空的']);
    });

    test('resolveChapter：逐字相同優先；查不到回 null', () => {
        assert.equal(mig.resolveChapter('物理', '簡諧運動(SHM)'), '簡諧運動(SHM)');
        assert.equal(mig.resolveChapter('物理', '簡諧運動（SHM）'), '簡諧運動(SHM)');
        assert.equal(mig.resolveChapter('數學', '宇宙學簡介'), null);
        assert.equal(mig.resolveChapter('數學', ''), null);
        for (const c of PLAN_CHAPTERS['數學']) assert.equal(mig.resolveChapter('數學', c), c);
    });
});

describe('參數與提議檔路徑', () => {
    test('parseArgs：預設 dry-run；--apply／--out／--test；互斥與缺值丟錯', () => {
        assert.deepEqual(mig.parseArgs([]), { mode: 'dry-run', apply: null, out: null, test: false, help: false, includeNew: false });
        assert.equal(mig.parseArgs(['--apply', 'a.csv', '--test']).apply, 'a.csv');
        assert.equal(mig.parseArgs(['--dry-run', '--out', 'x.csv']).out, 'x.csv');
        assert.equal(mig.parseArgs(['--include-new']).includeNew, true);
        assert.throws(() => mig.parseArgs(['--apply']), /--apply 後面/);
        assert.throws(() => mig.parseArgs(['--dry-run', '--apply', 'a.csv']), /擇一/);
        assert.throws(() => mig.parseArgs(['--apply', 'a.csv', '--out', 'b.csv']), /--out 只用在/);
        assert.throws(() => mig.parseArgs(['--apply', 'a.csv', '--include-new']), /--include-new 只用在/);
        assert.throws(() => mig.parseArgs(['--force']), /未知的參數/);
    });

    test('defaultOutPath：data/chapter-migration-<日期>.csv；同名檔存在時加 -2、-3，絕不覆寫', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chapter-mig-'));
        try {
            const first = mig.defaultOutPath(dir, '2026-09-25');
            assert.equal(path.basename(first), 'chapter-migration-2026-09-25.csv');
            fs.writeFileSync(first, 'x');
            assert.equal(path.basename(mig.defaultOutPath(dir, '2026-09-25')), 'chapter-migration-2026-09-25-2.csv');
            fs.writeFileSync(path.join(dir, 'chapter-migration-2026-09-25-2.csv'), 'x');
            assert.equal(path.basename(mig.defaultOutPath(dir, '2026-09-25')), 'chapter-migration-2026-09-25-3.csv');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        assert.match(mig.localDate(new Date(2026, 8, 5)), /^2026-09-05$/);
    });

    test('npm run chapters:migrate 指向這支腳本；結束時要印的兩個指令', () => {
        const pkg = require('../../package.json');
        assert.equal(pkg.scripts['chapters:migrate'], 'node scripts/migrate_chapters.js');
        assert.deepEqual(mig.NEXT_COMMANDS.map(c => c.cmd), ['npm run embed:backfill', 'npm run search:reindex']);
        for (const c of mig.NEXT_COMMANDS) assert.ok(pkg.scripts[c.cmd.replace('npm run ', '')], c.cmd);
    });
});
