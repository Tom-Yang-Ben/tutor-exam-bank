// ─────────────────────────────────────────────────────────────
// seed_questions.js — 種子題庫（30 題高中數學／物理示範題）
//
// 用途：題庫還是空的（或題目很少）時，先灌入一批格式正確的示範題，
//       方便測試「智慧組卷 → Word 匯出」的完整流程。
//
// 用法：node seed_questions.js          → 預覽模式（只列清單，不寫入）
//       node seed_questions.js --apply  → 實際寫入（交易保護；同題幹已存在則跳過）
//
// ⚠️ 題目分佈是刻意設計的，改動前請先讀懂：
//    智慧組卷（examController）會過濾掉該學生「寫過」的題，若剩餘題數 <
//    抽題數就回 400。前端預設抽題數為 5（public/index.html 的 #count），
//    因此**每一章至少要有 5 題**，招牌功能才抽得動。
//    早期版本是「30 章各 1 題」，總題數看起來很漂亮，但預設值一送出必定
//    失敗——題庫的價值不在題數總和，而在「單章密度」。
//    現行分佈：4 章各 7~8 題（共 30 題），抽 5 題後仍有餘裕可再抽一次。
//
// 所有章節名稱皆對齊 config/chapters.js 白名單；
// 公式使用 utils/textFormatter.js 支援的 LaTeX 子集（\frac、\sqrt、\int、^\circ…）。
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const { pool } = require('./config/db');
const { isValidChapter, isValidQuestionType, normalizeDifficulty } = require('./config/chapters');

// 前端預設抽題數（public/index.html #count 的 value）。每章題數低於此值，
// 使用者一按「智慧組卷」就會撞 400，因此下方會做自我檢查。
const DEFAULT_DRAW_COUNT = 5;

const QUESTIONS = [
    // ══════════ 數學 · 指數與對數（8 題）══════════
    {
        subject: '數學', chapter: '指數與對數', question_type: '單選', difficulty: 1,
        question_text: '$\\log_{2} 8 + \\log_{2} 4$ 之值為何？\n(A) $5$　(B) $6$　(C) $7$　(D) $12$',
        answer_text: '(A)。$\\log_{2} 8 = 3$，$\\log_{2} 4 = 2$，故和為 $5$。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '填空', difficulty: 1,
        question_text: '$8^{\\frac{2}{3}}$ 之值為何？',
        answer_text: '$4$。因 $8 = 2^3$，故 $8^{\\frac{2}{3}} = 2^{3 \\times \\frac{2}{3}} = 2^2 = 4$。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '單選', difficulty: 2,
        question_text: '已知 $\\log_{10} 2 = 0.3010$，則 $\\log_{10} 5$ 之值約為何？\n(A) $0.6990$　(B) $0.3010$　(C) $0.1505$　(D) $1.6990$',
        answer_text: '(A)。$\\log_{10} 5 = \\log_{10} \\frac{10}{2} = 1 - \\log_{10} 2 = 1 - 0.3010 = 0.6990$。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '計算', difficulty: 2,
        question_text: '解方程式 $2^{x+1} = 32$。',
        answer_text: '$32 = 2^5$，故 $x + 1 = 5$，得 $x = 4$。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '填空', difficulty: 3,
        question_text: '$\\log_{2} 3 \\times \\log_{3} 8$ 之值為何？',
        answer_text: '$3$。換底後 $\\frac{\\log 3}{\\log 2} \\times \\frac{\\log 8}{\\log 3} = \\frac{\\log 8}{\\log 2} = \\log_{2} 8 = 3$。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '計算', difficulty: 3,
        question_text: '解方程式 $\\log_{3} (x - 1) + \\log_{3} (x + 1) = 1$。',
        answer_text: '合併得 $\\log_{3} (x^2 - 1) = 1$，故 $x^2 - 1 = 3$，$x = \\pm 2$。又真數須為正（$x > 1$），故僅 $x = 2$ 合乎所求。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '單選', difficulty: 3,
        question_text: '某放射性元素的半衰期為 $8$ 天，則經過 $24$ 天後，其質量約剩下原來的幾分之幾？\n(A) $\\frac{1}{8}$　(B) $\\frac{1}{3}$　(C) $\\frac{1}{6}$　(D) $\\frac{1}{16}$',
        answer_text: '(A)。$24$ 天為 $3$ 個半衰期，故剩下 $\\left( \\frac{1}{2} \\right)^3 = \\frac{1}{8}$。'
    },
    {
        subject: '數學', chapter: '指數與對數', question_type: '計算', difficulty: 4,
        question_text: '已知 $\\log_{10} 2 = 0.3010$，求 $2^{50}$ 為幾位數的整數。',
        answer_text: '$\\log_{10} 2^{50} = 50 \\times 0.3010 = 15.05$，即 $10^{15} < 2^{50} < 10^{16}$，故 $2^{50}$ 為 $16$ 位數。'
    },

    // ══════════ 數學 · 三角函數的定義（7 題）══════════
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '單選', difficulty: 1,
        question_text: '$\\sin^2 40^\\circ + \\cos^2 40^\\circ$ 之值為何？\n(A) $1$　(B) $0$　(C) $\\frac{1}{2}$　(D) 需查表才能得知',
        answer_text: '(A)。由畢氏恆等式 $\\sin^2 \\theta + \\cos^2 \\theta = 1$，與角度無關。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '填空', difficulty: 2,
        question_text: '$\\sin 150^\\circ$ 之值為何？',
        answer_text: '$\\frac{1}{2}$。因 $\\sin 150^\\circ = \\sin (180^\\circ - 30^\\circ) = \\sin 30^\\circ = \\frac{1}{2}$。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '單選', difficulty: 2,
        question_text: '$\\cos 120^\\circ$ 之值為何？\n(A) $-\\frac{1}{2}$　(B) $\\frac{1}{2}$　(C) $-\\frac{\\sqrt{3}}{2}$　(D) $\\frac{\\sqrt{3}}{2}$',
        answer_text: '(A)。$\\cos 120^\\circ = -\\cos 60^\\circ = -\\frac{1}{2}$（第二象限餘弦為負）。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '填空', difficulty: 2,
        question_text: '已知 $\\theta$ 為銳角且 $\\sin \\theta = \\frac{3}{5}$，求 $\\cos \\theta$。',
        answer_text: '$\\frac{4}{5}$。由 $\\cos^2 \\theta = 1 - \\left( \\frac{3}{5} \\right)^2 = \\frac{16}{25}$，銳角餘弦為正，故 $\\cos \\theta = \\frac{4}{5}$。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '填空', difficulty: 3,
        question_text: '$\\tan 225^\\circ$ 之值為何？',
        answer_text: '$1$。$225^\\circ = 180^\\circ + 45^\\circ$ 位於第三象限，正切為正，故 $\\tan 225^\\circ = \\tan 45^\\circ = 1$。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '計算', difficulty: 3,
        question_text: '已知 $\\sin \\theta = \\frac{5}{13}$ 且 $\\theta$ 位於第二象限，求 $\\cos \\theta$ 與 $\\tan \\theta$。',
        answer_text: '$\\cos^2 \\theta = 1 - \\frac{25}{169} = \\frac{144}{169}$，第二象限餘弦為負，故 $\\cos \\theta = -\\frac{12}{13}$；$\\tan \\theta = \\frac{\\sin \\theta}{\\cos \\theta} = -\\frac{5}{12}$。'
    },
    {
        subject: '數學', chapter: '三角函數的定義', question_type: '計算', difficulty: 3,
        question_text: '求 $\\sin 30^\\circ \\cos 60^\\circ + \\cos 30^\\circ \\sin 60^\\circ$ 之值。',
        answer_text: '原式 $= \\frac{1}{2} \\times \\frac{1}{2} + \\frac{\\sqrt{3}}{2} \\times \\frac{\\sqrt{3}}{2} = \\frac{1}{4} + \\frac{3}{4} = 1$（亦即 $\\sin (30^\\circ + 60^\\circ) = \\sin 90^\\circ = 1$）。'
    },

    // ══════════ 物理 · 牛頓運動定律（8 題）══════════
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '單選', difficulty: 1,
        question_text: '下列何者為牛頓第一運動定律（慣性定律）的正確敘述？\n(A) 物體不受外力或所受合力為零時，靜者恆靜、動者作等速度直線運動　(B) 物體的加速度與所受合力成反比　(C) 作用力與反作用力大小相等、方向相同　(D) 物體必須持續受力才能維持等速度運動',
        answer_text: '(A)。慣性定律描述合力為零時物體維持原有運動狀態；(D) 為亞里斯多德式的錯誤直覺。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '單選', difficulty: 2,
        question_text: '質量 $2$ kg 的物體受到 $6$ N 的水平合力作用，其加速度大小為多少？\n(A) $3$ $m/s^2$　(B) $12$ $m/s^2$　(C) $0.33$ $m/s^2$　(D) $6$ $m/s^2$',
        answer_text: '(A)。由 $F = ma$ 得 $a = \\frac{F}{m} = \\frac{6}{2} = 3$ $m/s^2$。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '計算', difficulty: 2,
        question_text: '質量 $5$ kg 的物體靜止於光滑水平面上，受到 $10$ N 的水平定力作用，求 $3$ 秒末的速度與這 $3$ 秒內的位移。',
        answer_text: '$a = \\frac{F}{m} = \\frac{10}{5} = 2$ $m/s^2$；$v = at = 2 \\times 3 = 6$ m/s；$s = \\frac{1}{2} a t^2 = \\frac{1}{2} \\times 2 \\times 9 = 9$ 公尺。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '填空', difficulty: 2,
        question_text: '一質量 $60$ kg 的人站在電梯內，電梯以 $2$ $m/s^2$ 的加速度向上加速（取 $g = 10$ $m/s^2$），則地板對此人的正向力為多少牛頓？',
        answer_text: '$720$ N。由 $N - mg = ma$ 得 $N = m(g + a) = 60 \\times (10 + 2) = 720$ N。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '計算', difficulty: 3,
        question_text: '質量 $2$ kg 的木塊置於粗糙水平面，受到 $10$ N 的水平推力，同時受到大小 $4$ N 的摩擦力，求木塊的加速度。',
        answer_text: '合力 $F = 10 - 4 = 6$ N，故 $a = \\frac{F}{m} = \\frac{6}{2} = 3$ $m/s^2$，方向與推力同向。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '單選', difficulty: 3,
        question_text: '關於作用力與反作用力，下列敘述何者正確？\n(A) 大小相等、方向相反，且分別作用在兩個不同物體上　(B) 大小相等、方向相反，作用在同一物體上因此互相抵消　(C) 只有在物體靜止時才成立　(D) 質量較大的物體所受的作用力較大',
        answer_text: '(A)。牛頓第三定律的一對力必分屬兩個不同物體，因此不會互相抵消——這正是它與「平衡力」最容易被混淆之處。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '計算', difficulty: 3,
        question_text: '一物體置於傾角 $30^\\circ$ 的光滑斜面上由靜止釋放（取 $g = 10$ $m/s^2$），求其沿斜面下滑的加速度大小。',
        answer_text: '沿斜面方向的合力為 $mg \\sin 30^\\circ$，故 $a = g \\sin 30^\\circ = 10 \\times \\frac{1}{2} = 5$ $m/s^2$（與質量無關）。'
    },
    {
        subject: '物理', chapter: '牛頓運動定律', question_type: '計算', difficulty: 4,
        question_text: '質量 $3$ kg 與 $2$ kg 的兩物體以一條質量可忽略的細繩相連，置於光滑水平面上。今以 $10$ N 的水平力拉動 $3$ kg 物體（$2$ kg 物體在後方被拖行），求系統的加速度與繩中張力。',
        answer_text: '以整體為系統：$a = \\frac{F}{m_1 + m_2} = \\frac{10}{5} = 2$ $m/s^2$。再單獨分析 $2$ kg 物體（只受繩張力）：$T = m_2 a = 2 \\times 2 = 4$ N。'
    },

    // ══════════ 物理 · 動量守恆與碰撞（7 題）══════════
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '單選', difficulty: 2,
        question_text: '動量守恆定律成立的條件為下列何者？\n(A) 系統所受合外力為零　(B) 系統的動能保持不變　(C) 碰撞必須為彈性碰撞　(D) 系統內物體的質量必須相等',
        answer_text: '(A)。動量守恆的唯一條件是合外力為零（或碰撞瞬間外力遠小於內力），與碰撞是否為彈性、動能是否守恆無關。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '填空', difficulty: 2,
        question_text: '一靜止的 $6$ kg 物體突然炸裂為 $2$ kg 與 $4$ kg 兩塊。若 $2$ kg 的碎塊以 $6$ m/s 向右飛出，則 $4$ kg 碎塊的速度為多少？',
        answer_text: '$3$ m/s 向左。由動量守恆 $0 = 2 \\times 6 + 4 \\times v$，得 $v = -3$ m/s（負號表示方向向左）。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '計算', difficulty: 3,
        question_text: '質量 $3$ kg 的滑塊以 $4$ m/s 沿光滑水平面前進，與靜止的 $1$ kg 滑塊發生完全非彈性碰撞（碰後合為一體），求碰後共同速度。',
        answer_text: '由動量守恆：$3 \\times 4 = (3 + 1) v$，得 $v = 3$ m/s，方向與碰前相同。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '計算', difficulty: 3,
        question_text: '兩滑塊質量皆為 $2$ kg，分別以 $4$ m/s 向右與 $2$ m/s 向左在光滑水平面上正向對撞，碰後黏在一起，求碰後的共同速度。',
        answer_text: '取向右為正，由動量守恆：$2 \\times 4 + 2 \\times (-2) = (2 + 2) v$，即 $4 = 4v$，得 $v = 1$ m/s 向右。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '計算', difficulty: 3,
        question_text: '一位質量 $60$ kg 的人站在靜止的 $40$ kg 平板車上（車與地面間的摩擦可忽略）。當此人相對地面以 $2$ m/s 向前走時，求平板車的速度。',
        answer_text: '系統原動量為零，由動量守恆：$0 = 60 \\times 2 + 40 \\times v$，得 $v = -3$ m/s，即平板車以 $3$ m/s 向後移動。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '單選', difficulty: 3,
        question_text: '關於彈性碰撞與完全非彈性碰撞，下列敘述何者正確？\n(A) 兩者的總動量皆守恆，但只有彈性碰撞的總動能守恆　(B) 兩者的總動量與總動能皆守恆　(C) 只有彈性碰撞的總動量守恆　(D) 兩者的總動能皆不守恆',
        answer_text: '(A)。只要合外力為零，動量在任何碰撞中都守恆；動能則只有彈性碰撞才守恆，非彈性碰撞會轉為熱能與形變能。'
    },
    {
        subject: '物理', chapter: '動量守恆與碰撞', question_type: '計算', difficulty: 4,
        question_text: '質量 $0.02$ kg 的子彈以 $300$ m/s 的水平速度射入靜止於光滑水平面上、質量 $1.98$ kg 的木塊並嵌入其中。求：(1) 碰後兩者的共同速度　(2) 此過程中損失的動能。',
        answer_text: '(1) 由動量守恆：$0.02 \\times 300 = (0.02 + 1.98) v$，即 $6 = 2v$，得 $v = 3$ m/s。\n(2) 碰前動能 $= \\frac{1}{2} \\times 0.02 \\times 300^2 = 900$ J；碰後動能 $= \\frac{1}{2} \\times 2 \\times 3^2 = 9$ J，故損失 $891$ J（轉為熱能與形變能）。'
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

    // 2. 單章密度自我檢查：任一章題數低於前端預設抽題數，智慧組卷一按就 400
    const byChapter = new Map();
    for (const q of QUESTIONS) {
        const key = `${q.subject}·${q.chapter}`;
        byChapter.set(key, (byChapter.get(key) || 0) + 1);
    }
    const thin = [...byChapter.entries()].filter(([, n]) => n < DEFAULT_DRAW_COUNT);
    if (thin.length > 0) {
        console.error(`❌ 有 ${thin.length} 章的題數少於前端預設抽題數（${DEFAULT_DRAW_COUNT} 題），智慧組卷會直接回 400：`);
        thin.forEach(([key, n]) => console.error(`   ${key}：僅 ${n} 題`));
        console.error('   請補題或調整分佈後再執行。');
        process.exit(1);
    }

    const apply = process.argv.includes('--apply');
    console.log(`📚 種子題庫共 ${QUESTIONS.length} 題（數學 ${QUESTIONS.filter(q => q.subject === '數學').length}、物理 ${QUESTIONS.filter(q => q.subject === '物理').length}）`);
    console.log(`   分佈：${byChapter.size} 章，每章 ${Math.min(...byChapter.values())}~${Math.max(...byChapter.values())} 題（≥ 預設抽題數 ${DEFAULT_DRAW_COUNT}，智慧組卷可直接使用）`);
    for (const [key, n] of byChapter) {
        console.log(`     ・${key}：${n} 題`);
    }
    console.log('');
    QUESTIONS.forEach((q, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. [${q.subject}·${q.chapter}·${q.question_type}·難度${q.difficulty}] ${q.question_text.split('\n')[0].slice(0, 36)}…`);
    });

    if (!apply) {
        console.log('\n🔍 預覽模式：未寫入資料庫。確認無誤後執行 node seed_questions.js --apply');
        process.exit(0);
    }

    // 3. 交易寫入；同題幹已存在則跳過（可重複執行，不會灌重複題）
    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        let inserted = 0, skipped = 0;
        const insertedIds = [];
        for (const q of QUESTIONS) {
            // 已封存的同題幹也算存在：重跑種子不該把封存過的題再灌一份回來
            const { rows: dup } = await conn.query(
                'SELECT id FROM questions WHERE question_text = $1 LIMIT 1', [q.question_text]
            );
            if (dup.length > 0) { skipped++; continue; }
            // 這 30 題是作者自行編寫、章節已對齊白名單 ⇒ origin='seed'、chapter_src='human'
            // （規劃 §4.3.1 的來源標記規則；WS-B 的 import_pg.js 也用同一組值回填舊資料）
            const { rows } = await conn.query(
                `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, origin, chapter_src)
                 VALUES ($1, $2, $3, $4, $5, $6, 'seed', 'human')
                 RETURNING id`,
                [q.subject, q.chapter, q.question_type, q.difficulty, q.question_text, q.answer_text]
            );
            insertedIds.push(rows[0].id);
            inserted++;
        }
        await conn.query('COMMIT');
        console.log(`\n✅ 寫入完成：新增 ${inserted} 題、跳過已存在 ${skipped} 題`);
        if (insertedIds.length > 0) {
            console.log(`   新增題目 ID：${insertedIds[0]} ~ ${insertedIds[insertedIds.length - 1]}`);
            console.log(`   （若要整批移除：DELETE FROM questions WHERE id BETWEEN ${insertedIds[0]} AND ${insertedIds[insertedIds.length - 1]};）`);
        }
    } catch (err) {
        try { await conn.query('ROLLBACK'); } catch (e) { /* 回滾失敗不覆蓋原始錯誤 */ }
        console.error('❌ 寫入失敗，已回滾：', err.message);
        process.exitCode = 1;
    } finally {
        conn.release();
        await pool.end();
    }
})();
