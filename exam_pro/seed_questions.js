// ─────────────────────────────────────────────────────────────
// seed_questions.js — 種子題庫（30 題高中數學／物理示範題）
//
// 用途：題庫還是空的（或題目很少）時，先灌入一批格式正確的示範題，
//       方便測試「智慧組卷 → Word 匯出」的完整流程。
//
// 用法：node seed_questions.js          → 預覽模式（只列清單，不寫入）
//       node seed_questions.js --apply  → 實際寫入（交易保護；同題幹已存在則跳過）
//
// 所有章節名稱皆對齊 config/chapters.js 白名單；
// 公式使用 utils/textFormatter.js 支援的 LaTeX 子集（\frac、\sqrt、\int、^\circ…）。
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const pool = require('./config/db');
const { isValidChapter, isValidQuestionType, normalizeDifficulty } = require('./config/chapters');

const QUESTIONS = [
    // ══════════ 數學（17 題）══════════
    {
        subject: '數學', chapter: '絕對值', question_type: '單選', difficulty: 2,
        question_text: '不等式 $|2x - 3| < 5$ 的解為下列何者？\n(A) $-1 < x < 4$　(B) $x < -1$ 或 $x > 4$　(C) $-4 < x < 1$　(D) $1 < x < 4$',
        answer_text: '(A)。由 $-5 < 2x - 3 < 5$ 得 $-2 < 2x < 8$，故 $-1 < x < 4$。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '單選', difficulty: 2,
        question_text: '$\\log_{2} 8 + \\log_{2} 4$ 之值為何？\n(A) $5$　(B) $6$　(C) $7$　(D) $12$',
        answer_text: '(A)。$\\log_{2} 8 = 3$，$\\log_{2} 4 = 2$，故和為 $5$。'
    },
    {
        subject: '數學', chapter: '直線方程式', question_type: '填空', difficulty: 2,
        question_text: '通過點 $(1, 2)$ 且斜率為 $3$ 的直線方程式為何？',
        answer_text: '$y = 3x - 1$。由點斜式 $y - 2 = 3(x - 1)$ 整理而得。'
    },
    {
        subject: '數學', chapter: '圓方程式', question_type: '計算', difficulty: 3,
        question_text: '求圓 $x^2 + y^2 - 4x + 6y - 12 = 0$ 的圓心座標與半徑。',
        answer_text: '配方得 $(x - 2)^2 + (y + 3)^2 = 25$，故圓心為 $(2, -3)$，半徑為 $5$。'
    },
    {
        subject: '數學', chapter: '多項式除法', question_type: '填空', difficulty: 2,
        question_text: '多項式 $f(x) = x^3 - 2x^2 + 3x - 5$ 除以 $x - 1$ 的餘式為何？',
        answer_text: '$-3$。由餘式定理，餘式為 $f(1) = 1 - 2 + 3 - 5 = -3$。'
    },
    {
        subject: '數學', chapter: '數列與級數', question_type: '計算', difficulty: 2,
        question_text: '等差數列首項為 $3$、公差為 $4$，求前 $10$ 項之和。',
        answer_text: '$S_{10} = \\frac{10}{2} (2 \\times 3 + 9 \\times 4) = 5 \\times 42 = 210$。'
    },
    {
        subject: '數學', chapter: '排列', question_type: '單選', difficulty: 2,
        question_text: '甲、乙、丙、丁、戊 $5$ 人排成一列，若甲不站在最前端，共有幾種排法？\n(A) $96$　(B) $120$　(C) $24$　(D) $72$',
        answer_text: '(A)。全部排法 $5! = 120$ 種，甲站最前端有 $4! = 24$ 種，故 $120 - 24 = 96$ 種。'
    },
    {
        subject: '數學', chapter: '組合', question_type: '填空', difficulty: 2,
        question_text: '從 $10$ 位同學中選出 $3$ 位組成委員會（不分職務），共有幾種選法？',
        answer_text: '$C^{10}_{3} = \\frac{10 \\times 9 \\times 8}{3 \\times 2 \\times 1} = 120$ 種。'
    },
    {
        subject: '數學', chapter: '古典機率', question_type: '單選', difficulty: 2,
        question_text: '同時擲兩顆公正骰子，點數和為 $7$ 的機率為何？\n(A) $\\frac{1}{6}$　(B) $\\frac{1}{9}$　(C) $\\frac{5}{36}$　(D) $\\frac{7}{36}$',
        answer_text: '(A)。點數和為 $7$ 的組合有 $(1,6),(2,5),(3,4),(4,3),(5,2),(6,1)$ 共 $6$ 種，機率為 $\\frac{6}{36} = \\frac{1}{6}$。'
    },
    {
        subject: '數學', chapter: '期望值', question_type: '計算', difficulty: 3,
        question_text: '某抽獎活動中，抽中 $100$ 元的機率為 $\\frac{1}{10}$，抽中 $20$ 元的機率為 $\\frac{3}{10}$，其餘情形不中獎。求抽一次的獎金期望值。',
        answer_text: '$E = 100 \\times \\frac{1}{10} + 20 \\times \\frac{3}{10} + 0 \\times \\frac{6}{10} = 10 + 6 = 16$ 元。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '填空', difficulty: 2,
        question_text: '$\\sin 150^\\circ$ 之值為何？',
        answer_text: '$\\frac{1}{2}$。因 $\\sin 150^\\circ = \\sin (180^\\circ - 30^\\circ) = \\sin 30^\\circ = \\frac{1}{2}$。'
    },
    {
        subject: '數學', chapter: '正弦與餘弦定理', question_type: '計算', difficulty: 3,
        question_text: '三角形 $ABC$ 中，$a = 3$，$b = 5$，夾角 $C = 60^\\circ$，求邊長 $c$。',
        answer_text: '由餘弦定理 $c^2 = a^2 + b^2 - 2ab \\cos C = 9 + 25 - 2 \\times 3 \\times 5 \\times \\frac{1}{2} = 19$，故 $c = \\sqrt{19}$。'
    },
    {
        subject: '數學', chapter: '向量內積', question_type: '單選', difficulty: 2,
        question_text: '設 $\\vec{a} = (1, 2)$，$\\vec{b} = (3, -1)$，則 $\\vec{a} \\cdot \\vec{b}$ 之值為何？\n(A) $1$　(B) $5$　(C) $-1$　(D) $7$',
        answer_text: '(A)。$\\vec{a} \\cdot \\vec{b} = 1 \\times 3 + 2 \\times (-1) = 3 - 2 = 1$。'
    },
    {
        subject: '數學', chapter: '微分導函數', question_type: '計算', difficulty: 3,
        question_text: '設 $f(x) = x^3 - 3x^2 + 2x$，求導函數 $f\'(x)$，並求 $f\'(1)$ 之值。',
        answer_text: '$f\'(x) = 3x^2 - 6x + 2$，故 $f\'(1) = 3 - 6 + 2 = -1$。'
    },
    {
        subject: '數學', chapter: '函數圖形與極值', question_type: '計算', difficulty: 4,
        question_text: '求函數 $f(x) = x^3 - 3x$ 的極大值與極小值。',
        answer_text: '$f\'(x) = 3x^2 - 3 = 0$ 得 $x = \\pm 1$。$f\'\'(x) = 6x$：$x = -1$ 時 $f\'\'(-1) = -6 < 0$ 為極大，極大值 $f(-1) = 2$；$x = 1$ 時 $f\'\'(1) = 6 > 0$ 為極小，極小值 $f(1) = -2$。'
    },
    {
        subject: '數學', chapter: '定積分與面積', question_type: '計算', difficulty: 3,
        question_text: '求定積分 $\\int_{0}^{2} (3x^2 + 1) dx$ 之值。',
        answer_text: '原式 $= [x^3 + x]_{0}^{2} = (8 + 2) - 0 = 10$。'
    },
    {
        subject: '數學', chapter: '常態分配', question_type: '單選', difficulty: 2,
        question_text: '某次段考成績近似常態分配，平均 $70$ 分、標準差 $10$ 分。依經驗法則，成績介於 $60$ 分與 $80$ 分之間的學生約占全體多少？\n(A) $68\\%$　(B) $95\\%$　(C) $99.7\\%$　(D) $50\\%$',
        answer_text: '(A)。$60$ 到 $80$ 分即平均數 $\\pm 1$ 個標準差的範圍，依經驗法則約占 $68\\%$。'
    },

    // ══════════ 物理（13 題）══════════
    {
        subject: '物理', chapter: '物體的運動（速度與加速度）', question_type: '單選', difficulty: 1,
        question_text: '一物體由靜止開始作等加速度直線運動，加速度為 $2$ $m/s^2$，則第 $3$ 秒末的速度為多少？\n(A) $6$ m/s　(B) $2$ m/s　(C) $9$ m/s　(D) $18$ m/s',
        answer_text: '(A)。$v = v_0 + at = 0 + 2 \\times 3 = 6$ m/s。'
    },
    {
        subject: '物理', chapter: '直線運動', question_type: '計算', difficulty: 2,
        question_text: '汽車以 $10$ m/s 等速前進，煞車後以大小 $2$ $m/s^2$ 的等減速度滑行，求汽車自煞車起到完全停止共滑行多少距離？',
        answer_text: '由 $v^2 = v_0^2 + 2as$：$0 = 10^2 - 2 \\times 2 \\times s$，得 $s = \\frac{100}{4} = 25$ 公尺。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '單選', difficulty: 2,
        question_text: '質量 $2$ kg 的物體受到 $6$ N 的水平合力作用，其加速度大小為多少？\n(A) $3$ $m/s^2$　(B) $12$ $m/s^2$　(C) $0.33$ $m/s^2$　(D) $6$ $m/s^2$',
        answer_text: '(A)。由 $F = ma$ 得 $a = \\frac{F}{m} = \\frac{6}{2} = 3$ $m/s^2$。'
    },
    {
        subject: '物理', chapter: '摩擦力與向心力', question_type: '計算', difficulty: 3,
        question_text: '質量 $0.5$ kg 的小球以 $4$ m/s 的等速率作半徑 $2$ m 的水平圓周運動，求小球所受向心力的大小。',
        answer_text: '$F = \\frac{m v^2}{r} = \\frac{0.5 \\times 16}{2} = 4$ N。'
    },
    {
        subject: '物理', chapter: '動量與衝量', question_type: '單選', difficulty: 2,
        question_text: '質量 $0.2$ kg 的球以 $10$ m/s 垂直撞牆後，以原速率反彈，則球的動量變化量大小為多少？\n(A) $4$ kg·m/s　(B) $2$ kg·m/s　(C) $0$　(D) $1$ kg·m/s',
        answer_text: '(A)。取反彈方向為正：$\\Delta p = 0.2 \\times 10 - (-0.2 \\times 10) = 4$ kg·m/s。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '計算', difficulty: 3,
        question_text: '質量 $3$ kg 的滑塊以 $4$ m/s 沿光滑水平面前進，與靜止的 $1$ kg 滑塊發生完全非彈性碰撞（碰後合為一體），求碰後共同速度。',
        answer_text: '由動量守恆：$3 \\times 4 = (3 + 1) v$，得 $v = 3$ m/s，方向與碰前相同。'
    },
    {
        subject: '物理', chapter: '功與動能', question_type: '計算', difficulty: 2,
        question_text: '質量 $2$ kg 的物體速率由 $3$ m/s 增加到 $5$ m/s，求合力對物體所作的功。',
        answer_text: '由功能定理：$W = \\Delta E_k = \\frac{1}{2} \\times 2 \\times (5^2 - 3^2) = 25 - 9 = 16$ J。'
    },
    {
        subject: '物理', chapter: '位能與能量守恆', question_type: '填空', difficulty: 2,
        question_text: '一物體自 $20$ m 高處由靜止自由落下（不計空氣阻力，$g = 10$ $m/s^2$），落地時的速率為多少 m/s？',
        answer_text: '$20$ m/s。由力學能守恆 $v = \\sqrt{2gh} = \\sqrt{2 \\times 10 \\times 20} = 20$ m/s。'
    },
    {
        subject: '物理', chapter: '簡諧運動(SHM)', question_type: '填空', difficulty: 3,
        question_text: '一質點作簡諧運動，位移函數為 $x = 0.1 \\sin(2 \\pi t)$（單位：公尺、秒），求其週期與最大速率。',
        answer_text: '角頻率 $\\omega = 2\\pi$ rad/s，週期 $T = \\frac{2\\pi}{\\omega} = 1$ 秒；最大速率 $v_{max} = A\\omega = 0.1 \\times 2\\pi = 0.2\\pi$ m/s（約 $0.63$ m/s）。'
    },
    {
        subject: '物理', chapter: '靜電學', question_type: '單選', difficulty: 2,
        question_text: '兩點電荷間的距離增為原來的 $2$ 倍（電量不變），則兩者間的庫侖力變為原來的幾倍？\n(A) $\\frac{1}{4}$ 倍　(B) $\\frac{1}{2}$ 倍　(C) $2$ 倍　(D) $4$ 倍',
        answer_text: '(A)。庫侖力 $F$ 與距離平方成反比，距離加倍則力變為 $\\frac{1}{4}$ 倍。'
    },
    {
        subject: '物理', chapter: '電流與電路', question_type: '計算', difficulty: 2,
        question_text: '將 $4$ Ω 與 $2$ Ω 的電阻串聯後接上 $12$ V 的電源（內電阻不計），求電路電流及 $4$ Ω 電阻兩端的電壓。',
        answer_text: '總電阻 $R = 4 + 2 = 6$ Ω，電流 $I = \\frac{12}{6} = 2$ A；$4$ Ω 電阻兩端電壓 $V = IR = 2 \\times 4 = 8$ V。'
    },
    {
        subject: '物理', chapter: '電磁感應', question_type: '單選', difficulty: 3,
        question_text: '一 $50$ 匝線圈，通過的磁通量在 $0.4$ 秒內由 $0.2$ Wb 均勻減為零，則線圈的平均感應電動勢大小為多少？\n(A) $25$ V　(B) $10$ V　(C) $0.25$ V　(D) $4$ V',
        answer_text: '(A)。$\\varepsilon = N \\frac{\\Delta \\Phi}{\\Delta t} = 50 \\times \\frac{0.2}{0.4} = 25$ V。'
    },
    {
        subject: '物理', chapter: '量子現象（光電效應與波粒二象性）', question_type: '單選', difficulty: 3,
        question_text: '光電效應實驗中，若入射光的頻率不變而僅增加光的強度，則下列敘述何者正確？\n(A) 光電子數目增加，最大動能不變　(B) 光電子數目不變，最大動能增加　(C) 光電子數目與最大動能皆增加　(D) 光電子數目與最大動能皆不變',
        answer_text: '(A)。光強度只影響單位時間的光子數（光電子數目），最大動能 $E_k = h\\nu - W$ 只由頻率決定，故不變。'
    }
];

// ── 主流程 ──
(async () => {
    // 1. 先用白名單自我驗證，避免灌入非法資料
    const invalid = QUESTIONS.filter(q =>
        !isValidChapter(q.subject, q.chapter) ||
        !isValidQuestionType(q.question_type) ||
        normalizeDifficulty(q.difficulty) === null
    );
    if (invalid.length > 0) {
        console.error(`❌ 有 ${invalid.length} 題不符白名單，中止：`);
        invalid.forEach(q => console.error(`   [${q.subject}/${q.chapter}/${q.question_type}] ${q.question_text.slice(0, 30)}…`));
        process.exit(1);
    }

    const apply = process.argv.includes('--apply');
    console.log(`📚 種子題庫共 ${QUESTIONS.length} 題（數學 ${QUESTIONS.filter(q => q.subject === '數學').length}、物理 ${QUESTIONS.filter(q => q.subject === '物理').length}）`);
    QUESTIONS.forEach((q, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. [${q.subject}·${q.chapter}·${q.question_type}·難度${q.difficulty}] ${q.question_text.split('\n')[0].slice(0, 36)}…`);
    });

    if (!apply) {
        console.log('\n🔍 預覽模式：未寫入資料庫。確認無誤後執行 node seed_questions.js --apply');
        process.exit(0);
    }

    // 2. 交易寫入；同題幹已存在則跳過（可重複執行，不會灌重複題）
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        let inserted = 0, skipped = 0;
        const insertedIds = [];
        for (const q of QUESTIONS) {
            const [dup] = await conn.execute(
                'SELECT id FROM questions WHERE question_text = ? LIMIT 1', [q.question_text]
            );
            if (dup.length > 0) { skipped++; continue; }
            const [result] = await conn.execute(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, history_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [q.subject, q.chapter, q.question_type, q.difficulty, q.question_text, q.answer_text, '{}']
            );
            insertedIds.push(result.insertId);
            inserted++;
        }
        await conn.commit();
        console.log(`\n✅ 寫入完成：新增 ${inserted} 題、跳過已存在 ${skipped} 題`);
        if (insertedIds.length > 0) {
            console.log(`   新增題目 ID：${insertedIds[0]} ~ ${insertedIds[insertedIds.length - 1]}`);
            console.log(`   （若要整批移除：DELETE FROM questions WHERE id BETWEEN ${insertedIds[0]} AND ${insertedIds[insertedIds.length - 1]};）`);
        }
    } catch (err) {
        await conn.rollback();
        console.error('❌ 寫入失敗，已回滾：', err.message);
        process.exitCode = 1;
    } finally {
        conn.release();
        process.exit();
    }
})();
