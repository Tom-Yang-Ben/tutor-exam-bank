// utils/chapterPostRules.js 與它在 agents/classify.js、services/nlqService.js 的接線（dec/local-classify-nlq-prep）
//
// 每條界線規則都有「該觸發」與「不該觸發」的例句；例句是自撰的，不取自 golden（golden 上的效果見 localV1Regression.test.js）。
// 另有一組「不誤觸」：知識點（config/kc）的名稱與說明、各章例句、fixture 題、classify golden 題幹——
// 屬於規則 from 那一章的文字，規則一律不得觸發（否則模型答對的題會被程式改錯）。
// 執行：npm test（不連 DB、不呼叫模型）。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pr = require('../../utils/chapterPostRules');
const { CHAPTERS, isValidChapter } = require('../../config/chapters');
const { KEYWORD_RULES } = require('../../config/chapterMigrationRules');
const classify = require('../../agents/classify');
const nlq = require('../../services/nlqService');

const ROOT = path.resolve(__dirname, '..', '..');

describe('規則表', () => {
    test('每條規則的 from／to 是同一科的兩個不同白名單章；每個 from 只屬於一條規則；都寫了出處', () => {
        const froms = new Set();
        for (const rule of pr.RULES) {
            const subject = ['數學', '物理'].find(s => isValidChapter(s, rule.from));
            assert.ok(subject, `${rule.id} 的 from「${rule.from}」不是數學或物理的章`);
            assert.ok(isValidChapter(subject, rule.to), `${rule.id} 的 to「${rule.to}」不在${subject}`);
            assert.notEqual(rule.from, rule.to);
            assert.ok(!froms.has(rule.from), `「${rule.from}」有兩條規則（先後順序會變成語意）`);
            froms.add(rule.from);
            assert.ok(typeof rule.source === 'string' && rule.source.length > 10, `${rule.id} 要寫出處`);
            assert.equal(typeof rule.test, 'function');
        }
        // 〔Owner 2026-09-27 改答 LC-2：加四條規則，dec/r6-classify-rules〕末尾多四條（docs/local-mode.md 10.22）
        assert.deepEqual(pr.RULES.map(r => r.id), [
            'exp_log_third', 'exp_log_first',
            'dimension_space', 'dimension_plane', 'dimension_space', 'dimension_plane',
            'field_potential', 'coulomb', 'relative_1d', 'relative_2d', 'free_fall_computation',
            'trig_square_relation', 'general_angle', 'friction_coefficient', 'circular_kinematics'
        ]);
    });

    test('第三冊的關鍵字直接取自舊題搬章的規則表（不另抄一份）', () => {
        const fromMigration = KEYWORD_RULES['數學'].filter(r => r.to === '指數函數與對數函數').flatMap(r => r.keywords || []);
        assert.deepEqual([...pr.THIRD_VOLUME_KEYWORDS], fromMigration);
        assert.ok(pr.THIRD_VOLUME_KEYWORDS.includes('換底') && pr.THIRD_VOLUME_KEYWORDS.includes('指數方程式'));
    });
});

describe('A5：指數與對數（第一冊）／指數函數與對數函數（第三冊）', () => {
    test('第三冊的證據：底數不是 10、ln、換底等關鍵字、要解出指數或真數裡的未知數', () => {
        const cases = [
            ['求 $\\log_{7} 49$ 的值。', '\\log_{7}'],
            ['化簡 $\\log_3 5 \\cdot \\log_5 9$。', '\\log_3'],
            ['求 $\\ln e^{2}$。', '\\ln'],
            ['利用換底公式把 $\\log 12$ 化成以 2 為底。', '換底'],
            ['畫出指數函數 $y=3^x$ 的圖形並說明其漸近線。', '指數函數'],
            ['某放射性物質的半衰期為 5 年，求 20 年後剩下多少。', '半衰期'],
            ['解不等式 $5^{x-2} < 125$。', '5^{x-2}（解）'],
            ['若 $\\left(\\frac{1}{3}\\right)^{t} = 27$，求 $t$ 的值。', ')^{t}（求 $t）'],
            ['解方程式 $\\log (x+3) = 2$。', '\\log (x+3)（解）']
        ];
        for (const [text, evidence] of cases) assert.equal(pr.thirdVolumeEvidence(text), evidence, text);
    });

    test('不是第三冊：常用對數、指數律（未知數不必解出來）、底數是字母、定義域的不等號', () => {
        for (const text of [
            '已知 $\\log 3 \\approx 0.4771$，求 $3^{40}$ 是幾位數。',
            '求 $\\log_{10} 4 + \\log_{10} 25$ 之值。',
            '已知 $5^{x}=2$，求 $25^{x}+125^{x}$ 的值。',
            '若 $a^{3x}=2$，求 $a^{6x}$ 之值。',
            '當 $x>0$ 時，$\\log x$ 才有意義。',
            '了解指數律並化簡 $8^{\\frac{2}{3}}$。'
        ]) {
            assert.equal(pr.thirdVolumeEvidence(text), null, text);
        }
    });

    test('不是第三冊：未知數＋求 x，但題幹有第一冊題材（首數、尾數、位數）——A5 的第一冊題不得被換走', () => {
        const firstVolume = [
            ['已知 $\\log x=-2.3$，求 x 的首數與尾數', '首數'],
            ['已知 $\\log x = 3.2$，求 $x$ 的整數部分有幾位數？', '位數'],
            ['若 $3^{x}$ 是 10 位數的整數，求整數 x 的值', '位數'],
            ['已知 log 3=0.4771，若 $3^{x}$ 為 20 位數，求 x 的範圍', '位數']
        ];
        for (const [text, cue] of firstVolume) {
            assert.equal(pr.thirdVolumeEvidence(text), null, text);
            assert.equal(pr.boundaryTarget('指數與對數', text), null, `模型答對第一冊時不換：${text}`);
            assert.equal(pr.firstVolumeEvidence(text), cue, `反過來是第一冊的證據：${text}`);
        }
        // 明確證據（底數不是 10、第三冊關鍵字）不受第一冊題材影響
        assert.equal(pr.thirdVolumeEvidence('$\\log_{2} x$ 的首數'), '\\log_{2}');
        assert.equal(pr.thirdVolumeEvidence('利用常用對數解指數方程式 $2^{x}=5$'), '指數方程式');
    });

    test('第一冊的證據：首數、尾數、位數、科學記號、常用對數；有第三冊題材時不算', () => {
        assert.equal(pr.firstVolumeEvidence('求 $\\log 0.0072$ 的首數與尾數。'), '首數');
        assert.equal(pr.firstVolumeEvidence('把 $0.000081$ 寫成科學記號。'), '科學記號');
        assert.equal(pr.firstVolumeEvidence('已知 $\\log 7 \\approx 0.8451$，$7^{30}$ 是幾位數？'), '位數');
        assert.equal(pr.firstVolumeEvidence('對數函數 $y=\\log x$ 的圖形與首數的關係'), null, '有函數／圖形');
        assert.equal(pr.firstVolumeEvidence('$\\log_{2} 1024$ 是幾位數？'), null, '底數不是 10');
        assert.equal(pr.firstVolumeEvidence('化簡 $8^{\\frac{2}{3}}$。'), null, '沒有第一冊的明確題材就不換（指數律本身兩冊都可能出現）');
    });

    test('boundaryTarget：只在模型挑了 from 的那一章時才換', () => {
        const text = '求 $\\log_{7} 49$ 的值。';
        assert.deepEqual(
            (({ to, rule, evidence }) => ({ to, rule, evidence }))(pr.boundaryTarget('指數與對數', text)),
            { to: '指數函數與對數函數', rule: 'exp_log_third', evidence: '\\log_{7}' }
        );
        assert.equal(pr.boundaryTarget('指數函數與對數函數', text), null, '已經是第三冊');
        assert.equal(pr.boundaryTarget('數列與遞迴關係', text), null, '不是這一對的章不碰');
        assert.equal(pr.boundaryTarget('指數函數與對數函數', '求 $\\log 0.0072$ 的首數與尾數。').to, '指數與對數');
    });
});

describe('平面／空間（向量內積、直線方程式）', () => {
    test('坐標分量的個數（半形、全形括號與逗號都認得；選項代號不算）', () => {
        assert.deepEqual(pr.coordinateTuples('點 $P(2,-1,4)$ 與 $Q(0,3,1)$'), { two: null, three: '(2,-1,4)' });
        assert.deepEqual(pr.coordinateTuples('$\\vec{u}=(3, k)$'), { two: '(3, k)', three: null });
        assert.deepEqual(pr.coordinateTuples('向量（1，2）'), { two: '（1，2）', three: null });
        assert.deepEqual(pr.coordinateTuples('(A) 1　(B) 2'), { two: null, three: null });
    });

    test('平面或空間：文字線索＋坐標；互相矛盾或兩種都有時不判斷', () => {
        assert.equal(pr.dimensionEvidence('點 $P(2,-1,4)$ 的位置向量與 $(0,0,1)$ 的內積').dimension, 'space');
        assert.equal(pr.dimensionEvidence('三維空間中兩向量互相垂直').dimension, 'space');
        assert.equal(pr.dimensionEvidence('坐標平面上 $\\vec{u}=(3, k)$ 與 $(1,2)$ 垂直').dimension, 'plane');
        assert.equal(pr.dimensionEvidence('$\\vec{u}=(3, 1)$ 與 $\\vec{v}=(1, 2)$ 的夾角').dimension, 'plane');
        assert.equal(pr.dimensionEvidence('空間中 $(1,2)$ 與 $(3,4)$'), null, '說空間卻只有二維坐標');
        assert.equal(pr.dimensionEvidence('$(1,2)$ 與 $(1,2,3)$'), null, '兩種坐標都有');
        assert.equal(pr.dimensionEvidence('直線在平面上，求直線與平面的交點'), null, '題幹的「平面上」常是空間單元的題材，不算平面線索');
        assert.equal(pr.dimensionEvidence('兩向量的內積為零代表什麼'), null);
    });

    test('向量內積 ↔ 空間向量內積、直線方程式 ↔ 空間直線方程式', () => {
        assert.equal(pr.boundaryTarget('向量內積', '點 $P(2,-1,4)$ 的位置向量與 $(0,0,1)$ 的內積').to, '空間向量內積');
        assert.equal(pr.boundaryTarget('空間向量內積', '$\\vec{u}=(3, 1)$ 與 $\\vec{v}=(1, 2)$ 的夾角').to, '向量內積');
        assert.equal(pr.boundaryTarget('直線方程式', '空間中過點 $(1,0,2)$、方向向量 $(2,1,1)$ 的直線').to, '空間直線方程式');
        assert.equal(pr.boundaryTarget('向量內積', '兩向量的內積為零代表什麼'), null);
        assert.equal(pr.boundaryTarget('向量內積', '點 $P(2,-1,4)$ 的內積', { skipDimension: true }), null, 'nlq 略過（它有自己的平面／空間對齊）');
    });
});

describe('物理的三組界線', () => {
    test('靜電學 → 電場與電位：電位差、電位能、作功、電力線、等位面（有庫侖就不換）', () => {
        assert.equal(pr.boundaryTarget('靜電學', '兩平行板間的電位差為 12 V，求板間的電場。').to, '電場與電位');
        assert.equal(pr.boundaryTarget('靜電學', '畫出正電荷周圍的電力線與等位線。').to, '電場與電位');
        assert.equal(pr.boundaryTarget('靜電學', '外力把電荷從 A 移到 B 作了多少功？').to, '電場與電位');
        assert.equal(pr.boundaryTarget('靜電學', '兩點電荷間的庫侖力，以及系統的電位能。'), null);
        assert.equal(pr.boundaryTarget('靜電學', '帶電玻璃棒靠近金屬球後接地，球帶什麼電？'), null);
    });

    test('電場與電位 → 靜電學：只問兩電荷之間的庫侖力（有電場、電位就不換）', () => {
        assert.equal(pr.boundaryTarget('電場與電位', '兩點電荷相距 3 m，求兩者間的庫侖力。').to, '靜電學');
        assert.equal(pr.boundaryTarget('電場與電位', '利用庫侖定律推導點電荷的電場。'), null);
    });

    test('K2：相對速度一維 → 直線運動、二維 → 平面運動；只有上下一條軸、或沒有「相對」時不判斷', () => {
        assert.deepEqual(pr.relativeMotionEvidence('甲以 5 m/s 向北、乙以 3 m/s 向南，求甲相對於乙的速度。'), { dimension: 1, evidence: '北' });
        assert.deepEqual(pr.relativeMotionEvidence('兩車同向行駛，求後車相對前車的速度。'), { dimension: 1, evidence: '同向' });
        assert.equal(pr.relativeMotionEvidence('船頭垂直河岸行駛，求船相對於岸的速度。').dimension, 2);
        assert.equal(pr.relativeMotionEvidence('雨滴鉛直落下、車向東行駛，求雨滴相對於車的速度。').dimension, 2);
        assert.equal(pr.relativeMotionEvidence('飛機向東北飛，求相對於地面的速度。').dimension, 2);
        assert.equal(pr.relativeMotionEvidence('電梯向上等速運動，球相對電梯靜止。'), null, '只有上下一條軸');
        assert.equal(pr.relativeMotionEvidence('甲車向東行駛 20 m/s。'), null, '沒有相對');
        assert.equal(pr.boundaryTarget('平面運動', '甲以 5 m/s 向北、乙以 3 m/s 向南，求甲相對於乙的速度。').to, '直線運動');
        assert.equal(pr.boundaryTarget('直線運動', '船頭垂直河岸行駛，求船相對於岸的速度。').to, '平面運動');
    });

    test('第 8.0 節第三條：自由落體、上拋給了數值又要求數值 → 直線運動；只問觀念不換', () => {
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '球以 20 m/s 鉛直上拋，求最高點的高度。').to, '直線運動');
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '石頭自 80 m 高處自由落下，幾秒後落地？').to, '直線運動');
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '自由落體的加速度和物體的質量有沒有關係？'), null);
        assert.equal(pr.boundaryTarget('物體的運動（速度與加速度）', '下列關於自由落體的敘述何者正確？(A) 第 1 秒內…'), null);
    });
});

// ───────────────── 〔Owner 2026-09-27 改答 LC-2：加四條規則〕docs/local-mode.md 10.22 ─────────────────
// 例句都是自撰的，不取自 golden（golden 與回放檔上的效果見 classifyRulesLc2.test.js）。

describe('LC-2 規則 1：三角函數的疊合 → 直角三角形的邊角關係（只有平方關係）', () => {
    const FROM = '三角函數的疊合';
    const TO = '直角三角形的邊角關係';

    test('正例：sin²＋cos²、1＋tan²、明寫「平方關係」、Unicode 上標', () => {
        const cases = [
            ['求 $\\sin^2 25^\\circ + \\cos^2 25^\\circ$ 的值。', '\\sin^2＋\\cos^2'],
            ['化簡 $\\sin^{2}\\theta+\\cos^{2}\\theta$。', '\\sin^{2}＋\\cos^{2}'],
            ['化簡 $(1+\\tan^2\\theta)\\cos^2\\theta$，其中 $\\theta$ 為銳角。', '\\tan^2＋\\cos^2'],
            ['已知 $\\theta$ 為銳角且 $\\sin\\theta = \\frac{3}{5}$，利用平方關係求 $\\cos\\theta$。', '平方關係'],
            ['sin²35° + cos²35° 之值為何？', 'sin^{2}＋cos^{2}']   // Unicode 上標先寫成 ^{2}
        ];
        for (const [text, evidence] of cases) {
            assert.equal(pr.squareRelationEvidence(text), evidence, text);
            const hit = pr.boundaryTarget(FROM, text);
            assert.equal(hit && hit.to, TO, text);
            assert.equal(hit.rule, 'trig_square_relation');
        }
    });

    test('反例：和角、疊合、倍角、一次的 sin±cos、廣義角的線索、鈍角、弧度、只有一個平方', () => {
        for (const text of [
            '已知 $\\sin^2\\theta+\\cos^2\\theta=1$，求 $\\sin(\\theta+30^\\circ)$ 的值。',             // 和角
            '把 $\\sin x+\\sqrt{3}\\cos x$ 化成 $r\\sin(x+\\phi)$，並求最大值。',                      // 疊合
            '利用 $\\sin^2\\theta+\\cos^2\\theta=1$ 與 $\\cos 2\\theta$ 的公式化簡。',                  // 倍角
            '利用倍角公式與 $\\sin^2\\theta+\\cos^2\\theta=1$ 化簡。',                                    // 倍角（字眼）
            '已知 $\\sin\\theta+\\cos\\theta=\\frac{1}{2}$，由 $\\sin^2\\theta+\\cos^2\\theta=1$ 求 $\\sin\\theta\\cos\\theta$。', // 一次的 sin＋cos
            '$\\theta$ 在第二象限且 $\\sin\\theta=\\frac{3}{5}$，由 $\\sin^2\\theta+\\cos^2\\theta=1$ 求 $\\cos\\theta$。', // 象限（廣義角也教平方關係）
            '求 $\\sin^2 120^\\circ+\\cos^2 120^\\circ$ 之值。',                                         // 鈍角
            '求 $\\sin^2\\frac{\\pi}{5}+\\cos^2\\frac{\\pi}{5}$ 之值。',                                 // 弧度
            '求 $\\sin^2 30^\\circ$ 的值。',                                                            // 只有一個平方
            '求 $y=\\sin^2 x+\\cos^2 x$ 的圖形。'                                                        // 第三冊的函數題材
        ]) {
            assert.equal(pr.squareRelationEvidence(text), null, text);
            assert.equal(pr.boundaryTarget(FROM, text), null, text);
        }
    });

    // 〔審查修正 dec/r6-classify-rules-fix〕審查的自撰反例：原本這幾題都會從「疊合」被改成「直角三角形」（模型答對也被改錯）
    test('審查反例：二次式含 sinθcosθ 交叉項（求範圍、極值、化簡）、大寫字母的倍角 → 不換', () => {
        for (const text of [
            '求 $\\sin^2\\theta+\\sin\\theta\\cos\\theta+2\\cos^2\\theta$ 的範圍。',
            '$0^\\circ\\le\\theta\\le180^\\circ$，求 $\\sin^2\\theta+4\\sin\\theta\\cos\\theta+\\cos^2\\theta$ 的極值。',
            '若 0°≤θ≤90°，則 $3\\sin^2\\theta+2\\sqrt3\\sin\\theta\\cos\\theta+\\cos^2\\theta$ 可能的值有哪些範圍？',
            '化簡 $\\sin^2 x+\\sqrt{3}\\sin x\\cos x+2\\cos^2 x$。',
            '化簡 $3\\cos^2 x-2\\cos x\\sin x+\\sin^2 x$。',                              // cos 在前的乘積
            'sin²θ + sinθcosθ + 2cos²θ 化簡後為何？',                                      // Unicode 上標、純文字的乘積
            '已知 $\\sin^2 A+\\cos^2 A=1$ 且 $\\sin A=\\frac{3}{5}$，求 $\\sin 2A$。',       // 倍角：大寫字母
            '已知 $\\sin^2 B+\\cos^2 B=1$，求 $\\cos(2B)$。'
        ]) {
            assert.equal(pr.squareRelationEvidence(text), null, text);
            assert.equal(pr.boundaryTarget(FROM, text), null, text);
        }
    });

    test('審查修正的三項排除各自生效：只有乘積、只有「範圍／極值／可能值」、只有大寫字母的倍角', () => {
        // 只有乘積（沒有範圍、極值的字眼）
        assert.equal(pr.squareRelationEvidence('化簡 $\\sin^2 x+\\sqrt{3}\\sin x\\cos x+2\\cos^2 x$。'), null);
        // 只有範圍／極值／可能值（沒有乘積）
        assert.equal(pr.squareRelationEvidence('求 $2\\sin^2\\theta+3\\cos^2\\theta$ 的範圍。'), null);
        assert.equal(pr.squareRelationEvidence('求 $\\sin^2\\theta-2\\cos^2\\theta$ 的極值。'), null);
        assert.equal(pr.squareRelationEvidence('$\\sin^2\\theta+2\\cos^2\\theta$ 的可能值為何？'), null);
        // 只有大寫字母的倍角
        assert.equal(pr.squareRelationEvidence('已知 $\\sin^2 A+\\cos^2 A=1$，求 $\\sin 2A$。'), null);
    });

    test('收窄之後仍換：分開的兩個式子不是乘積（中間有 $、中文字、等號）；倍角的字母後面還接字母的不算', () => {
        const cases = [
            ['$\\theta$ 為銳角，由 $\\sin^2\\theta+\\cos^2\\theta=1$ 及 $\\sin\\theta$ 求 $\\cos\\theta$。', '\\sin^2＋\\cos^2'],
            ['已知 $\\sin A=\\frac{3}{5}$，$A$ 為銳角，由 $\\sin^2 A+\\cos^2 A=1$ 求 $\\cos A$。', '\\sin^2＋\\cos^2'],
            ['sin²25° + cos²25° 之值為何？', 'sin^{2}＋cos^{2}']
        ];
        for (const [text, evidence] of cases) {
            assert.equal(pr.squareRelationEvidence(text), evidence, text);
            assert.equal(pr.boundaryTarget(FROM, text).to, TO, text);
        }
    });

    test('只管「疊合 → 直角三角形」這一對：模型選別章不動', () => {
        const text = '求 $\\sin^2 25^\\circ + \\cos^2 25^\\circ$ 的值。';
        assert.equal(pr.boundaryTarget(TO, text), null, '已經是直角三角形');
        assert.equal(pr.boundaryTarget('和角與差角公式', text), null, '一條規則只管一對章');
        assert.equal(pr.boundaryTarget('廣義角與極坐標', text), null);
    });
});

describe('LC-2 規則 2：直角三角形的邊角關係 → 廣義角與極坐標（角度 >90° 或 <0°）', () => {
    const FROM = '直角三角形的邊角關係';
    const TO = '廣義角與極坐標';

    test('正例：150°、負角、210°、400°、「135° 的正切」、U+2212 減號、有一個角超出就算', () => {
        const cases = [
            ['$\\sin 150^\\circ$ 之值為何？', '\\sin 150^\\circ'],
            ['求 $\\cos(-30^\\circ)$。', '\\cos(-30^\\circ'],
            ['$\\tan 210°$ 等於多少？', '\\tan 210°'],
            ['求 cos 400° 的值。', 'cos 400°'],
            ['寫出 $135^{\\circ}$ 的正切值。', '135^{\\circ}$ 的正切'],
            ['求 sin(−45°)。', 'sin(-45°'],
            ['求 $\\sin 30^\\circ + \\cos 120^\\circ$ 的值。', '\\cos 120^\\circ']
        ];
        for (const [text, evidence] of cases) {
            assert.equal(pr.generalAngleEvidence(text), evidence, text);
            const hit = pr.boundaryTarget(FROM, text);
            assert.equal(hit && hit.to, TO, text);
            assert.equal(hit.rule, 'general_angle');
        }
    });

    test('反例：0°～90°（含兩端）、sin²40° 不是 240°、解三角形、和角、角度裡有 ±、弧度、角度不是直接寫在函數裡', () => {
        for (const text of [
            '$\\sin 30^\\circ$ 之值為何？',
            '求 $\\cos 90^\\circ$ 與 $\\sin 0^\\circ$。',
            '$\\sin^2 40^\\circ$ 與 $\\cos^2 40^\\circ$ 的和。',
            'sin²40° + cos²40° 之值為何？',                                   // Unicode 上標：直接 NFKC 會變成 sin240°
            '$\\sin^240^\\circ+\\cos^240^\\circ$',                            // 次方只吃一位數
            '三角形 $ABC$ 中 $\\angle A=120^\\circ$，求 $\\sin 120^\\circ$ 與面積。', // 解三角形（鈍角三角形）
            '利用和角公式求 $\\sin 105^\\circ$。',
            '化簡 $\\sin(180^\\circ-30^\\circ)$。',                               // 角度裡有 ±：不判斷
            '求 $\\sin \\frac{5\\pi}{6}$ 之值。',                                  // 弧度：不處理（見 10.22）
            '已知 $\\theta=150^\\circ$，求 $\\sin\\theta$。'                       // 角度沒有直接寫在函數裡：不判斷
        ]) {
            assert.equal(pr.generalAngleEvidence(text), null, text);
            assert.equal(pr.boundaryTarget(FROM, text), null, text);
        }
    });

    test('trigAngles：Unicode 上標先改成 ^n，再做 NFKC', () => {
        assert.equal(pr.normalizeTrigText('sin²40°'), 'sin^{2}40°');
        assert.deepEqual(pr.trigAngles(pr.normalizeTrigText('sin²40°')).map(a => a.deg), [40]);
        assert.deepEqual(pr.trigAngles(pr.normalizeTrigText('sin⁻¹ 150°')).map(a => a.deg), [150], '上標的 -1 整串當次方');
        assert.deepEqual(pr.trigAngles(pr.normalizeTrigText('\\sin^{2} 40^{\\circ}')).map(a => a.deg), [40]);
        assert.deepEqual(pr.trigAngles(pr.normalizeTrigText('$\\cos\\left(-60^\\circ\\right)$')).map(a => a.deg), [-60]);
        assert.deepEqual(pr.trigAngles(pr.normalizeTrigText('basin 150°')), [], '字的一部分不算函數名');
    });

    test('只管「直角三角形 → 廣義角」這一對', () => {
        assert.equal(pr.boundaryTarget(TO, '$\\sin 150^\\circ$ 之值'), null);
        assert.equal(pr.boundaryTarget('正弦與餘弦定理', '$\\sin 150^\\circ$ 之值'), null);
    });
});

describe('LC-2 規則 3：牛頓運動定律 → 摩擦力與向心力（題幹出現摩擦係數）', () => {
    const FROM = '牛頓運動定律';
    const TO = '摩擦力與向心力';

    test('正例：動摩擦係數、靜摩擦、μ＝數、\\mu_k＝數', () => {
        const cases = [
            ['木箱與地面的動摩擦係數為 0.3，以 50 N 水平拉 10 kg 的木箱，求加速度。', '動摩擦係數'],
            ['地面對木箱的最大靜摩擦力是多少？', '靜摩擦'],
            ['物體與桌面間 $\\mu_k = 0.2$，以 6 N 拉 2 kg 物體，求加速度。', '\\mu_k = 0.2'],
            ['μ=0.25 的水平面上以 20 N 推 4 kg 的箱子，求加速度。', 'μ=0.25'],
            ['兩木塊以輕繩相連，與桌面的摩擦係數皆為 0.1，求繩張力。', '摩擦係數']
        ];
        for (const [text, evidence] of cases) {
            assert.equal(pr.frictionCoefficientEvidence(text), evidence, text);
            const hit = pr.boundaryTarget(FROM, text);
            assert.equal(hit && hit.to, TO, text);
            assert.equal(hit.rule, 'friction_coefficient');
        }
    });

    test('反例：寫明沒有摩擦、μ 的其他意思（微米、微法拉、磁導率、線密度）、功與能量的題材', () => {
        for (const text of [
            '光滑水平面（不計摩擦），以 10 N 拉 2 kg 物體，求加速度。',
            '不計動摩擦，求兩物體的共同加速度。',
            '桌面的摩擦係數可忽略，求繩張力。',
            '摩擦係數為零的水平面上，以 8 N 拉 4 kg 物體，求加速度。',
            '在 μ = 0 的冰面上推 3 kg 的冰壺，求加速度。',
            '直徑 5 μm 的塵粒受 2 N 的力，求加速度。',
            '2 μF 的電容器充電後，兩板間的電場為何？',
            '真空磁導率 $\\mu_0 = 4\\pi\\times10^{-7}$，求導線受的力。',
            '弦的線密度 μ = 0.01 kg/m、張力 4 N，求波速。',
            '木塊在動摩擦係數 0.2 的地面上滑行 5 m，摩擦力作了多少功？',
            '質量 2 kg 的物體受 10 N 合力，求加速度。'
        ]) {
            assert.equal(pr.frictionCoefficientEvidence(text), null, text);
            assert.equal(pr.boundaryTarget(FROM, text), null, text);
        }
    });

    // 〔審查修正 dec/r6-classify-rules-fix〕\frac 的分子或分母有字母就不算摩擦係數（約化質量）
    test('審查反例：約化質量 \\mu=\\frac{m_1m_2}{m_1+m_2} 不算摩擦係數；數字的 \\frac、\\sqrt 照樣算', () => {
        for (const text of [
            '兩物體 $m_1$、$m_2$ 以輕繩相連，定義 $\\mu=\\frac{m_1m_2}{m_1+m_2}$，求加速度。',
            '定義約化質量 $\\mu=\\frac{m_1m_2}{m_1+m_2}$，以輕繩相連，求加速度。',
            '約化質量 μ = 0.5 kg，受 2 N 的力，求加速度。',
            '令 $\\mu=\\sqrt{m_1m_2}$，求加速度。'
        ]) {
            assert.equal(pr.frictionCoefficientEvidence(text), null, text);
            assert.equal(pr.boundaryTarget(FROM, text), null, text);
        }
        const cases = [
            ['物體與桌面間 $\\mu_s=\\frac{1}{2}$，以 6 N 拉 2 kg 物體，求加速度。', '\\mu_s=\\frac{1}{2}'],
            ['斜面與木塊間 $\\mu = \\frac{\\sqrt{3}}{3}$，求木塊的加速度。', '\\mu = \\frac{\\sqrt{3}}{3}'],
            ['$\\mu=\\frac12$ 的水平面上推 4 kg 的箱子，求加速度。', '\\mu=\\frac12'],
            ['$\\mu_k=\\sqrt{3}$ 的斜面，求加速度。', '\\mu_k=\\sqrt{3}']
        ];
        for (const [text, evidence] of cases) {
            assert.equal(pr.frictionCoefficientEvidence(text), evidence, text);
            assert.equal(pr.boundaryTarget(FROM, text).to, TO, text);
        }
    });

    test('只管「牛頓運動定律 → 摩擦力與向心力」這一對', () => {
        const text = '木箱與地面的動摩擦係數為 0.3，求加速度。';
        assert.equal(pr.boundaryTarget(TO, text), null, '已經是摩擦力與向心力（不接著套規則 4）');
        assert.equal(pr.boundaryTarget('直線運動', text), null);
        assert.equal(pr.boundaryTarget('功與動能', text), null);
    });
});

describe('LC-2 規則 4：摩擦力與向心力 → 平面運動（等速圓周運動只問運動學量）', () => {
    const FROM = '摩擦力與向心力';
    const TO = '平面運動';

    test('正例：速率、週期、向心加速度、速度方向；選項裡「合力為零」是要判斷的敘述，不算受力計算（CHAPTER_RELABEL 8.1 #46）', () => {
        const cases = [
            ['一質點作等速圓周運動，半徑 2 m、週期 4 s，求其速率與向心加速度的量值。', '等速圓周運動＋週期'],
            ['等速圓周運動的物體，其速度方向與加速度方向的關係為何？', '等速圓周運動＋速度'],
            ['關於等速率圓周運動，下列何者正確？(A) 速率不變 (B) 加速度為零 (C) 合力為零', '等速率圓周運動＋速率']
        ];
        // 主題字「等速率圓周運動」本身含「速率」，不能拿來當「題目問了運動學量」的證據
        assert.equal(pr.circularKinematicsEvidence('等速率圓周運動的題目'), null);
        for (const [text, evidence] of cases) {
            assert.equal(pr.circularKinematicsEvidence(text), evidence, text);
            const hit = pr.boundaryTarget(FROM, text);
            assert.equal(hit && hit.to, TO, text);
            assert.equal(hit.rule, 'circular_kinematics');
        }
    });

    test('反例：算張力、向心力、摩擦提供向心力、合力的方向、質量、別章的題材（簡諧、磁場、衛星、能量）、不是等速', () => {
        for (const text of [
            '以輕繩繫住的小球在光滑水平面上作等速圓周運動，速率 3 m/s，求繩的張力。',
            '2 kg 的物體作等速圓周運動，半徑 1 m、速率 2 m/s，求所需的向心力。',
            '汽車在水平彎道上作等速圓周運動，由靜摩擦力提供向心力，求不打滑的最大速率。',
            '等速圓周運動的物體所受合力的方向為何？',
            '等速圓周運動中，速率 4 m/s 的物體所受的合力是多少？',
            '質量 3 kg 的小球作等速圓周運動，速率 2 m/s，求其加速度與受力。',
            '簡諧運動可視為等速圓周運動在直徑上的投影，求最大速度。',
            '帶電粒子垂直射入均勻磁場作等速圓周運動，求週期。',
            '人造衛星繞地球作等速圓周運動，求其速率。',
            '等速圓周運動的物體動能是否改變？速率是否改變？',
            '鉛直面上的圓周運動，求最高點的最小速率。'
        ]) {
            assert.equal(pr.circularKinematicsEvidence(text), null, text);
            assert.equal(pr.boundaryTarget(FROM, text), null, text);
        }
    });

    // 〔審查修正 dec/r6-classify-rules-fix〕審查的自撰反例：只「問」運動學量、但要做受力分析才解得出來。原本都會被改成「平面運動」
    test('審查反例：只寫 μ 的轉盤、彎道、旋轉圓筒，沒寫繩的圓錐擺 → 不換', () => {
        for (const text of [
            '硬幣放在轉盤上隨轉盤作等速圓周運動，硬幣與轉盤間 μ = 0.4，距轉軸 0.1 m，求不滑動的最大角速度。',
            '汽車在半徑 50 m 的水平彎道上作等速圓周運動，輪胎與路面間 $\\mu_s=0.5$，求不打滑的最大速率。',
            '圓筒狀旋轉遊樂設施繞鉛直軸作等速圓周運動，人貼在內壁不會掉落，若 μ = 0.5、半徑 5 m，求最小轉速。',
            '圓錐擺：擺錘在水平面上作等速圓周運動，擺長 1 m，與鉛直線夾 60°，求週期。'
        ]) {
            assert.equal(pr.circularKinematicsEvidence(text), null, text);
            assert.equal(pr.boundaryTarget(FROM, text), null, text);
        }
    });

    test('審查修正加的線索各自生效：μ、\\mu、擺、滑動、打滑、滑落、掉落、不會掉', () => {
        for (const text of [
            '物體隨轉盤作等速圓周運動，μ = 0.4、半徑 0.1 m，求最大角速度。',
            '物體隨轉盤作等速圓周運動，$\\mu_s = 0.4$、半徑 0.1 m，求最大角速度。',
            '擺錘在水平面上作等速圓周運動，擺長 1 m，求週期。',
            '硬幣隨轉盤作等速圓周運動，距轉軸 0.1 m，求硬幣不滑動的最大角速度。',
            '汽車在水平彎道上作等速圓周運動，半徑 40 m，求不打滑的最大速率。',
            '物體在旋轉的圓盤上作等速圓周運動，恰好不滑落時的角速度為何？',
            '旋轉圓筒作等速圓周運動，貼壁的人恰好不掉落，求最小轉速。',
            '旋轉圓筒作等速圓周運動，貼壁的人不會掉下來，求最小轉速。'
        ]) {
            assert.equal(pr.circularKinematicsEvidence(text), null, text);
        }
        // 收窄後 fx-046 那一型（選項只問速率、速度、加速度方向與合力是否為零）照樣換
        const fx046Like = '關於等速圓周運動，下列敘述何者正確？（複選）\n(A) 速率不變　(B) 速度不變　(C) 加速度指向圓心　(D) 合力為零';
        assert.equal(pr.circularKinematicsEvidence(fx046Like), '等速圓周運動＋速率');
        assert.equal(pr.boundaryTarget(FROM, fx046Like).to, TO);
    });

    test('只管「摩擦力與向心力 → 平面運動」這一對（換過去之後不再接著套 K2 的 relative_1d）', () => {
        const text = '一質點作等速圓周運動，半徑 2 m、週期 4 s，求其速率。';
        assert.equal(pr.boundaryTarget(TO, text), null);
        assert.equal(pr.boundaryTarget('牛頓運動定律', text), null);
    });
});

describe('名稱容錯', () => {
    test('只差空白、引號、全形半形、開頭的冊名 → 對回白名單；對不到或跨科 → null', () => {
        assert.equal(pr.canonicalChapter('物理', '物體的運動(速度與加速度)'), '物體的運動（速度與加速度）');
        assert.equal(pr.canonicalChapter('數學', '「向量內積」'), '向量內積');
        assert.equal(pr.canonicalChapter('數學', ' 向量 內積 '), '向量內積');
        assert.equal(pr.canonicalChapter('數學', '第三冊指數函數與對數函數'), '指數函數與對數函數');
        assert.equal(pr.canonicalChapter('數學', '向量內積'), '向量內積', '本來就合法的原樣回傳');
        assert.equal(pr.canonicalChapter('數學', '平面向量'), null);
        assert.equal(pr.canonicalChapter('數學', '靜電學'), null, '跨科照樣不對');
        assert.equal(pr.canonicalChapter('數學', null), null);
        assert.equal(pr.canonicalChapter('數學', ''), null);
        assert.equal(pr.canonicalChapter('不存在', '向量內積'), null);
    });

    test('科目不知道時在三科裡找，恰好一科對得到才回（化學章名含頓號）', () => {
        const chem = CHAPTERS['化學'].find(c => c.includes('、'));
        assert.ok(chem);
        assert.equal(pr.canonicalChapterAny(null, `「${chem}」`), chem);
        assert.equal(pr.canonicalChapterAny(null, '「向量內積」'), '向量內積');
        assert.equal(pr.canonicalChapterAny('數學', '「靜電學」'), null, '給了科目就只在那一科找');
        assert.equal(pr.canonicalChapterAny(null, '不存在的章'), null);
    });
});

describe('alignChapters（nlq 的多章清單）', () => {
    test('換過去的章已經列了就不換；順序不變、去重；沒有證據不動', () => {
        const q = '求 2 的 40 次方是幾位數';
        assert.deepEqual(pr.alignChapters(['指數函數與對數函數'], q), {
            chapters: ['指數與對數'],
            changes: [{ from: '指數函數與對數函數', to: '指數與對數', rule: 'exp_log_first', evidence: '位數' }]
        });
        assert.deepEqual(pr.alignChapters(['指數函數與對數函數', '指數與對數'], q).chapters, ['指數函數與對數函數', '指數與對數']);
        assert.deepEqual(pr.alignChapters(['數列與遞迴關係', '數列與遞迴關係'], q), { chapters: ['數列與遞迴關係'], changes: [] });
        assert.deepEqual(pr.alignChapters([], q), { chapters: [], changes: [] });
        assert.deepEqual(pr.alignChapters(undefined, q), { chapters: [], changes: [] });
    });
});

describe('不誤觸：屬於 from 那一章的文字，規則一律不觸發', () => {
    test('知識點名稱與說明、各章例句、fixture 題、classify golden 題幹', () => {
        const texts = [];
        for (const subject of ['數學', '物理']) {
            const kc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kc', `${subject}.json`), 'utf8'));
            const items = Array.isArray(kc) ? kc : (kc.kcs || kc.items || Object.values(kc).find(Array.isArray) || []);
            assert.ok(items.length > 100, `${subject} 的知識點要讀得到`);
            for (const k of items) texts.push({ tag: k.code, chapter: k.chapter, text: [k.name, k.description, (k.aliases || []).join(' ')].join(' ') });
        }
        const { CHAPTER_EXAMPLES } = require('../../config/chapterExamples');
        for (const subject of ['數學', '物理']) {
            for (const [chapter, text] of Object.entries(CHAPTER_EXAMPLES[subject])) texts.push({ tag: `例句 ${chapter}`, chapter, text });
        }
        const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'fixtures', 'questions.public.json'), 'utf8')).questions;
        for (const q of fixture) texts.push({ tag: `fixture #${q.id}`, chapter: q.chapter, text: `${q.question_text} ${q.answer_text || ''}` });
        const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'golden', 'classify.json'), 'utf8')).entries;
        for (const e of golden) texts.push({ tag: e.id, chapter: e.chapter, text: e.question_text });

        const misfires = [];
        let checked = 0;
        for (const t of texts) {
            const hit = pr.boundaryTarget(t.chapter, t.text);
            if (pr.RULES.some(r => r.from === t.chapter)) checked += 1;
            if (hit) misfires.push(`${t.tag}（${t.chapter} → ${hit.to}，證據「${hit.evidence}」）`);
        }
        assert.ok(checked > 80, `量尺自我檢查：屬於 from 章的文字要夠多（${checked}）`);
        assert.deepEqual(misfires, []);
    });
});

// ───────────────── agents/classify.js 的接線 ─────────────────

function classifyCtx(data) {
    const calls = [];
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    return { data, usage: { tokenIn: 1, tokenOut: 1, tokenThinking: 0, tokenCached: 0 }, latencyMs: 1, raw: null };
                }
            },
            db: null,
            job: { id: 1, budget_usd: 1, cost_usd: 0 },
            jq: { id: 1, idx: 1, payload: {}, retries: {} },
            logger: { info() {}, warn() {}, error() {} },
            config: { models: { extract: 'ollama:qwen3-vl:8b', text: 'ollama:qwen3:8b' }, thresholds: { classifyMinConf: 0.8 }, features: {} },
            signal: undefined
        }
    };
}

describe('agents/classify.js：第二層的章節後處理', () => {
    test('界線規則換章：chapter、adjustments、rationale 前面的說明；cacheKeyParts 與模板不變', async () => {
        const { ctx, calls } = classifyCtx({ chapter: '指數與對數', confidence: 0.95, rationale: '用到對數律。' });
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '求 $\\log_{7} 49$ 的值。' });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.chapter, '指數函數與對數函數');
        assert.equal(outcome.data.source, 'llm');
        assert.equal(outcome.data.confidence, 0.95, '信心照模型給的');
        assert.deepEqual(outcome.data.adjustments, [{ rule: 'exp_log_third', from: '指數與對數', to: '指數函數與對數函數', evidence: '\\log_{7}' }]);
        assert.equal(outcome.data.rationale, '〔界線規則：模型選「指數與對數」，依題幹的「\\log_{7}」改為「指數函數與對數函數」〕用到對數律。');
        assert.equal(calls[0].template, 'classify.v2');
        assert.deepEqual(Object.keys(calls[0].cacheKeyParts), ['template', 'questionText', 'fewShotIds'], '鍵的組成不變');
    });

    test('沒有改的題：outcome.data 的鍵與改版前逐一相同（沒有 adjustments）、rationale 原樣', async () => {
        const { ctx } = classifyCtx({ chapter: '向量內積', confidence: 0.9, rationale: '夾角公式。' });
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求夾角。' });
        assert.deepEqual(Object.keys(outcome.data), ['chapter', 'confidence', 'rationale', 'source', 'few_shot_ids']);
        assert.equal(outcome.data.rationale, '夾角公式。');
    });

    test('名稱容錯：「」包起來的章名對回白名單並記一筆；對不到的照舊 chapter_invalid（feedback 用模型原字）', async () => {
        const ok = classifyCtx({ chapter: '「向量內積」', confidence: 0.9, rationale: 'r' });
        const passed = await classify.run(ok.ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '設 $\\vec{a}=(1,2)$，求長度。' });
        assert.equal(passed.kind, 'pass');
        assert.equal(passed.data.chapter, '向量內積');
        assert.deepEqual(passed.data.adjustments, [{ rule: 'chapter_name', from: '「向量內積」', to: '向量內積' }]);
        assert.equal(passed.data.rationale, 'r', '只改名稱不加說明');

        const bad = classifyCtx({ chapter: '「平面向量」', confidence: 0.9, rationale: 'r' });
        const failed = await classify.run(bad.ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '設 $\\vec{a}=(1,2)$，求長度。' });
        assert.equal(failed.reason, 'chapter_invalid');
        assert.match(failed.feedback, /^「「平面向量」」不在白名單內/);
    });

    // 〔Owner 第五輪 LC-3 核准，2026-09-27，dec/r6-gates〕原本這裡釘的是「零成本閘門不套用」；Owner 選 2 之後改成套用。
    test('零成本閘門也套界線規則：規則判定要換章 → 直接改章、仍是閘門通過（source gate、不呼叫 LLM）、附 adjustments', async () => {
        const { ctx, calls } = classifyCtx({});
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '指數與對數', chapter_confidence: 0.9, question_text: '求 $\\log_{7} 49$ 的值。' });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'gate');
        assert.equal(outcome.data.chapter, '指數函數與對數函數');
        assert.equal(outcome.data.confidence, 0.9, '信心照拆題模型給的');
        assert.deepEqual(outcome.data.adjustments, [{ rule: 'exp_log_third', from: '指數與對數', to: '指數函數與對數函數', evidence: '\\log_{7}' }]);
        assert.equal(outcome.data.rationale,
            '〔界線規則：拆題模型給「指數與對數」，依題幹的「\\log_{7}」改為「指數函數與對數函數」〕拆題模型給的章節在白名單內，且信心 0.9 ≥ 0.8，零成本閘門直接採用。');
        assert.equal(calls.length, 0);
    });

    test('零成本閘門：規則沒觸發的題 outcome.data 與改版前逐鍵相同（沒有 adjustments）', async () => {
        const { ctx, calls } = classifyCtx({});
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '指數與對數', chapter_confidence: 0.9, question_text: '已知 $\\log 2 = 0.3010$，求 $2^{20}$ 是幾位數。' });
        assert.deepEqual(outcome.data, {
            chapter: '指數與對數', confidence: 0.9,
            rationale: '拆題模型給的章節在白名單內，且信心 0.9 ≥ 0.8，零成本閘門直接採用。', source: 'gate'
        });
        assert.equal(calls.length, 0);
    });

    test('零成本閘門沒過（信心不足）的題照舊走第二層，後處理照舊只由第二層做一次', async () => {
        const { ctx, calls } = classifyCtx({ chapter: '指數與對數', confidence: 0.95, rationale: 'r' });
        const outcome = await classify.run(ctx, { subject: '數學', chapter: '指數與對數', chapter_confidence: 0.5, question_text: '求 $\\log_{7} 49$ 的值。' });
        assert.equal(outcome.data.source, 'llm');
        assert.equal(outcome.data.chapter, '指數函數與對數函數');
        assert.equal(outcome.data.adjustments.length, 1);
        assert.equal(calls.length, 1);
    });

    // 〔Owner 2026-09-27 改答 LC-2，dec/r6-classify-rules〕原本是 77 → 90、改對 13；加了四條規則之後 dr-008（trig_square_relation）、
    // fx-046（circular_kinematics）也改對，變成 77 → 92、改對 15。這兩條是看過這類錯題才寫的，92/92 會高估對新題的效果（10.22）。
    test('不誤觸（local_v1_counterfactual --gate）：golden 92 題以正確的章走閘門一題都不改；以 2026-09-25 的回答代用時 77 → 92 對、改錯 0', async () => {
        const { gateCounterfactual } = require('../../eval/tools/local_v1_counterfactual');
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'fixtures', 'local_raw_2026-09-25.json'), 'utf8'));
        const g = await gateCounterfactual(raw);
        assert.equal(g.golden.n, 92);
        assert.deepEqual(g.golden.misfires, []);
        assert.deepEqual(g.golden.notGate, []);
        assert.equal(g.proxy.n, 92);
        assert.deepEqual(g.proxy.notGate, []);
        assert.equal(g.proxy.rawCorrect, 77);
        assert.equal(g.proxy.gateCorrect, 92);
        assert.equal(g.proxy.fixed.length, 15);
        assert.ok(g.proxy.fixed.includes('cls-dr-008') && g.proxy.fixed.includes('cls-fx-046'));
        assert.deepEqual(g.proxy.broken, []);
    });

    test('不誤觸：fixture 62 題以自己的章走閘門，一題都不改', async () => {
        const fixtureQs = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'fixtures', 'questions.public.json'), 'utf8')).questions;
        const { ctx } = classifyCtx({});
        for (const q of fixtureQs) {
            const outcome = await classify.run(ctx, { subject: q.subject, chapter: q.chapter, chapter_confidence: 1, question_text: q.question_text });
            if (outcome.data && outcome.data.source === 'gate') {
                assert.equal(outcome.data.chapter, q.chapter, q.id);
                assert.equal(outcome.data.adjustments, undefined, q.id);
            }
        }
    });

    // 〔Owner 2026-09-27 改答 LC-2〕四條新規則走同一條接線：第二層與零成本閘門都套（LC-3），cassette 的鍵不變
    test('LC-2 新規則在第二層：模型選「牛頓運動定律」、題幹有動摩擦係數 → 摩擦力與向心力；模板與鍵不變', async () => {
        const { ctx, calls } = classifyCtx({ rationale: '用 F=ma。', chapter: '牛頓運動定律', confidence: 0.95 });
        const outcome = await classify.run(ctx, { subject: '物理', chapter: '', chapter_confidence: 0, question_text: '木箱與地面的動摩擦係數為 0.3，以 50 N 水平拉 10 kg 的木箱，求加速度。' });
        assert.equal(outcome.data.source, 'llm');
        assert.equal(outcome.data.chapter, '摩擦力與向心力');
        assert.deepEqual(outcome.data.adjustments, [{ rule: 'friction_coefficient', from: '牛頓運動定律', to: '摩擦力與向心力', evidence: '動摩擦係數' }]);
        assert.equal(outcome.data.rationale, '〔界線規則：模型選「牛頓運動定律」，依題幹的「動摩擦係數」改為「摩擦力與向心力」〕用 F=ma。');
        assert.equal(calls[0].template, 'classify.v2');
        assert.deepEqual(Object.keys(calls[0].cacheKeyParts), ['template', 'questionText', 'fewShotIds']);
    });

    test('LC-2 新規則在零成本閘門（LC-3）：拆題模型給「摩擦力與向心力」、題幹只問等速圓周運動的運動學量 → 平面運動，不呼叫 LLM', async () => {
        const { ctx, calls } = classifyCtx({});
        const outcome = await classify.run(ctx, { subject: '物理', chapter: '摩擦力與向心力', chapter_confidence: 0.9, question_text: '一質點作等速圓周運動，半徑 2 m、週期 4 s，求其速率。' });
        assert.equal(outcome.data.source, 'gate');
        assert.equal(outcome.data.chapter, '平面運動');
        assert.deepEqual(outcome.data.adjustments, [{ rule: 'circular_kinematics', from: '摩擦力與向心力', to: '平面運動', evidence: '等速圓周運動＋週期' }]);
        assert.ok(outcome.data.rationale.startsWith('〔界線規則：拆題模型給「摩擦力與向心力」，依題幹的「等速圓周運動＋週期」改為「平面運動」〕'));
        assert.equal(calls.length, 0);
    });

    test('LC-2 新規則：數學兩條在第二層與閘門都生效；沒有證據的題 outcome.data 與改版前逐鍵相同', async () => {
        const a = classifyCtx({ rationale: 'r', chapter: '三角函數的疊合', confidence: 0.95 });
        const sq = await classify.run(a.ctx, { subject: '數學', chapter: '', chapter_confidence: 0, question_text: '求 $\\sin^2 25^\\circ + \\cos^2 25^\\circ$ 的值。' });
        assert.equal(sq.data.chapter, '直角三角形的邊角關係');
        assert.equal(sq.data.adjustments[0].rule, 'trig_square_relation');

        const b = classifyCtx({});
        const ga = await classify.run(b.ctx, { subject: '數學', chapter: '直角三角形的邊角關係', chapter_confidence: 1, question_text: '$\\sin 150^\\circ$ 之值為何？' });
        assert.equal(ga.data.source, 'gate');
        assert.equal(ga.data.chapter, '廣義角與極坐標');
        assert.equal(ga.data.adjustments[0].rule, 'general_angle');

        const c = classifyCtx({});
        const keep = await classify.run(c.ctx, { subject: '數學', chapter: '直角三角形的邊角關係', chapter_confidence: 1, question_text: '$\\sin 30^\\circ$ 之值為何？' });
        assert.deepEqual(keep.data, {
            chapter: '直角三角形的邊角關係', confidence: 1,
            rationale: '拆題模型給的章節在白名單內，且信心 1 ≥ 0.8，零成本閘門直接採用。', source: 'gate'
        });
    });

    test('化學題：界線規則全是數學／物理的章，不會動到化學', async () => {
        const chem = CHAPTERS['化學'][0];
        const { ctx } = classifyCtx({ chapter: chem, confidence: 0.9, rationale: 'r' });
        const outcome = await classify.run(ctx, { subject: '化學', chapter: '', chapter_confidence: 0, question_text: '電位差與等位面（刻意放物理的證據字）' });
        assert.equal(outcome.data.chapter, chem);
        assert.equal(outcome.data.adjustments, undefined);
    });
});

// ───────────────── services/nlqService.js 的接線 ─────────────────

describe('services/nlqService.js：名稱容錯與界線規則', () => {
    test('validateFilters：章名的空白、引號、全形半形與「計算題」這類題型寫法對回白名單，不附警告', () => {
        const { filters, warnings } = nlq.validateFilters({
            subject: '物理', chapters: ['「物體的運動(速度與加速度)」'], question_types: ['計算題', ' 填充 '],
            difficulty_min: null, difficulty_max: null, keywords: []
        });
        assert.deepEqual(filters.chapters, ['物體的運動（速度與加速度）']);
        assert.deepEqual(filters.question_types, ['計算', '填空']);
        assert.deepEqual(warnings, []);
    });

    test('validateFilters：對不到的照舊丟掉並警告；科目沒給時由容錯後的章名反推', () => {
        const a = nlq.validateFilters({ subject: '數學', chapters: ['平面向量'], question_types: ['申論'], keywords: [] });
        assert.deepEqual(a.filters.chapters, []);
        assert.deepEqual(a.warnings, ['章節「平面向量」不在白名單內，已忽略。', '題型「申論」不在白名單內，已忽略。']);
        const b = nlq.validateFilters({ subject: null, chapters: ['「向量內積」'], question_types: [], keywords: [] });
        assert.equal(b.filters.subject, '數學');
        assert.deepEqual(b.filters.chapters, ['向量內積']);
    });

    test('mergeLlm 帶原句：句子有第一冊的證據時把第三冊換回第一冊，記在 adjustments；已兩章都列就不換', () => {
        const rules = { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: [] };
        const q = '求 3 的 40 次方是幾位數';
        const merged = nlq.mergeLlm(rules, q, { chapters: ['指數函數與對數函數'], question_types: [], semantic_text: q }, { query: q });
        assert.deepEqual(merged.filters.chapters, ['指數與對數']);
        assert.deepEqual(merged.adjustments, ['章節「指數函數與對數函數」→「指數與對數」（句子裡有「位數」）']);
        const both = nlq.mergeLlm(rules, q, { chapters: ['指數函數與對數函數', '指數與對數'], question_types: [], semantic_text: q }, { query: q });
        assert.deepEqual(both.filters.chapters, ['指數函數與對數函數', '指數與對數']);
        assert.deepEqual(both.adjustments, []);
    });

    test('mergeLlm 不帶原句：與改版前相同（不做任何對齊）', () => {
        const rules = { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: [] };
        const merged = nlq.mergeLlm(rules, 'x', { chapters: ['指數函數與對數函數'], question_types: ['計算'] });
        assert.deepEqual(merged.filters.chapters, ['指數函數與對數函數']);
        assert.deepEqual(merged.filters.question_types, ['計算']);
        assert.deepEqual(merged.adjustments, []);
    });

    // 〔Owner 2026-09-27 改答 LC-2〕nlq 與 classify 共用規則表：新四條在 nlq 也生效（誤觸檢查見 classifyRulesLc2.test.js）
    test('LC-2 新規則在 nlq：句子有摩擦係數、LLM 只回牛頓運動定律 → 換成摩擦力與向心力；兩章都列就不換', () => {
        const rules = { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: [] };
        const q = '有動摩擦係數的斜面題';
        const merged = nlq.mergeLlm(rules, q, { chapters: ['牛頓運動定律'], question_types: [], semantic_text: q }, { query: q });
        assert.deepEqual(merged.filters.chapters, ['摩擦力與向心力']);
        assert.deepEqual(merged.adjustments, ['章節「牛頓運動定律」→「摩擦力與向心力」（句子裡有「動摩擦係數」）']);
        const both = nlq.mergeLlm(rules, q, { chapters: ['牛頓運動定律', '摩擦力與向心力'], question_types: [], semantic_text: q }, { query: q });
        assert.deepEqual(both.filters.chapters, ['牛頓運動定律', '摩擦力與向心力']);
        assert.deepEqual(both.adjustments, []);
        // 句子沒有證據（「斜面上物體受力平衡」，nlq-036 的題材）：不換
        const q2 = '斜面上物體受力平衡的題目';
        assert.deepEqual(nlq.mergeLlm(rules, q2, { chapters: ['牛頓運動定律'], question_types: [] }, { query: q2 }).filters.chapters, ['牛頓運動定律']);
    });

    test('名稱容錯在對齊之前：「」包起來的空間章名，句子明講平面時照樣換成平面那一章', () => {
        const rules = { subject: null, chapters: [], question_types: [], difficulty_min: null, difficulty_max: null, exclude_student_name: null, keywords: [] };
        const q = '坐標平面上兩個向量互相垂直';
        const merged = nlq.mergeLlm(rules, q, { chapters: ['「空間向量內積」'], question_types: [] }, { query: q });
        assert.deepEqual(merged.filters.chapters, ['向量內積']);
    });
});
