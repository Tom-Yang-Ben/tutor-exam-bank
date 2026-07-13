require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const { Document, Packer, Paragraph, TextRun, Math: DocxMath, MathXml } = require('docx');
const temml = require('temml');

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 15 * 1024 * 1024 }
});

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tutor_exam_bank',
    waitForConnections: true,
    connectionLimit: 10
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const PORT = process.env.PORT || 3000;

// 🎯 1. 只清洗非法字元，絕對不碰反斜線 \
const xmlSafeClean = (rawStr) => {
    if (!rawStr) return "";
    return rawStr
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
        .trim();
};

// 🎯 2. 正統公式調校：將標準 MathML 標籤包裹轉譯為微軟 Office Math (OMML) 專用 XML 字串
function wrapWithOfficeMath(mathmlStr) {
    // 移除 MathML 的外層 <math> 標籤，只保留核心結構
    let innerContent = mathmlStr
        .replace(/<math[^>]*>/g, '')
        .replace(/<\/math>/g, '');

    // 微軟 Word 內置公式最正統的 XML 命名空間包裹
    return `<m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mml="http://www.w3.org/1998/Math/MathML">
        <m:oMath>
            ${innerContent}
        </m:oMath>
    </m:oMathPara>`;
}

// 🎯 3. 正統編譯器：LaTeX -> MathML -> Word Office Math XML
function latexToWordOMath(latex) {
    try {
        // 使用 temml 將 LaTeX 轉為標準 MathML 字串
        // xmlMode: true 確保輸出極致純淨、符合 XML 規範的 MathML 標籤
        const mathMLStr = temml.renderToString(latex, { xmlMode: true });

        // 將 MathML 透過微軟命名空間封裝成 OMML XML 內容
        const ommlXmlString = wrapWithOfficeMath(mathMLStr);

        // 利用 docx 內建的 MathXml，直接將生出來的 XML 字串灌入 Word
        return new MathXml(ommlXmlString);

    } catch (err) {
        console.error("❌ LaTeX 轉 Word 公式失敗:", err.message, " | 原始 LaTeX:", latex);
        // 如果編譯失敗（例如防禦手打錯的公式），降級回退為純文字，防止整卷打包失敗
        return new TextRun({ text: `$${latex}$` });
    }
}

// 🎯 4. 正統混合內容解析器：只抓取 $...$ 內的內容交給引擎編編譯
function parseMixedContent(textStr, textOptions = {}) {
    if (!textStr) return [];

    const safeText = xmlSafeClean(textStr);

    // 匹配 $...$ 裡面的 LaTeX
    const regex = /\$([^$]+)\$/g;

    let result = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(safeText)) !== null) {
        // 塞入 $ 前面的一般純文字
        if (match.index > lastIndex) {
            result.push(
                new TextRun({
                    text: safeText.substring(lastIndex, match.index),
                    ...textOptions
                })
            );
        }

        const latex = match[1];

        // 編譯真正的 Word Math XML 物件
        const wordMathComponent = latexToWordOMath(latex);

        // 🎯 關鍵防禦分流：如果是 MathXml 正常編譯，直接推進陣列；如果是錯誤回退的 TextRun，安全解構進去
        if (wordMathComponent instanceof MathXml) {
            result.push(wordMathComponent);
        } else {
            result.push(wordMathComponent);
        }

        lastIndex = regex.lastIndex;
    }

    // 塞入最後剩下的純文字
    if (lastIndex < safeText.length) {
        result.push(
            new TextRun({
                text: safeText.substring(lastIndex),
                ...textOptions
            })
        );
    }

    return result;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/questions', async (req, res, next) => {
    const { subject, chapter, question_type, difficulty, question_text, question_img, answer_text, solution_img } = req.body;
    if (!subject || !chapter || !question_text || !answer_text) {
        return res.status(400).json({ message: '學科、章節、題目內容與答案皆為必填欄位！' });
    }
    try {
        const sql = `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, question_img, answer_text, solution_img, history_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`;
        const [result] = await pool.execute(sql, [subject, chapter.trim(), question_type || '填空', difficulty || 3, question_text.trim(), question_img || null, answer_text.trim(), solution_img || null]);
        res.status(201).json({ message: '題目錄入成功！', questionId: result.insertId });
    } catch (err) { next(err); }
});

app.post('/api/generate-paper', async (req, res, next) => {
    const { student_name, subject, chapter, count } = req.body;
    const limitCount = parseInt(count) || 5;

    if (!student_name || !subject || !chapter || !count) {
        return res.status(400).json({ message: "所有篩選欄位皆為必填！" });
    }

    try {
        const safeStudentName = student_name.replace(/"/g, '');
        const [rows] = await pool.execute('SELECT id, history_json FROM questions WHERE subject = ? AND chapter = ?', [subject, chapter]);

        const availableQuestions = rows.filter(q => {
            let history = q.history_json;
            if (typeof history === 'string') {
                try { history = JSON.parse(history); } catch (e) { history = {}; }
            }
            history = history || {};
            return !history.hasOwnProperty(safeStudentName);
        });

        if (availableQuestions.length < count) {
            return res.status(400).json({ message: `新題目庫存不足！該章節 [${safeStudentName}] 沒寫過的題目僅剩 ${availableQuestions.length} 題。` });
        }

        const shuffled = [...availableQuestions].sort(() => 0.5 - Math.random());
        const rawSelectedIds = shuffled.slice(0, count).map(q => q.id);

        const placeholders = rawSelectedIds.map(() => '?').join(',');
        const [fullQuestions] = await pool.execute(
            `SELECT id, question_text, question_type, difficulty, answer_text FROM questions WHERE id IN (${placeholders})`,
            rawSelectedIds
        );

        const typeWeights = { '單選': 1, '多選': 2, '填空': 3, '計算': 4, '證明': 5 };
        const sortedQuestions = fullQuestions.sort((a, b) => {
            const wA = typeWeights[a.question_type] || 99;
            const wB = typeWeights[b.question_type] || 99;
            if (wA !== wB) return wA - wB;
            return (a.difficulty || 3) - (b.difficulty || 3);
        });

        const finalSortedIds = sortedQuestions.map(q => q.id);

        // 🎯 關鍵修正：手動組合安全格式日期 (YYYY_MM_DD)，避開底層控制字元
        const d = new Date();
        const safeDateStr = `${d.getFullYear()}_${d.getMonth() + 1}_${d.getDate()}`;
        const paperTitle = `${student_name}-${chapter}特訓卷(${safeDateStr})`;

        await pool.execute(
            'INSERT INTO exam_papers (title, student_name, question_ids) VALUES (?, ?, ?)',
            [paperTitle, student_name, JSON.stringify(finalSortedIds)]
        );

        const todayStr = d.toISOString().split('T')[0];
        await Promise.all(finalSortedIds.map(id =>
            pool.execute(`UPDATE questions SET history_json = JSON_SET(history_json, ?, ?) WHERE id = ?`, [`$."${safeStudentName}"`, todayStr, id])
        ));

        res.status(200).json({
            message: '智慧組卷成功！已自動記錄學生作答歷史，避免下次重複。',
            paper_title: paperTitle,
            question_ids: finalSortedIds,
            questions: sortedQuestions
        });

    } catch (err) { next(err); }
});

app.post('/api/analyze-pdf', upload.single('pdf'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ message: "沒有上傳檔案" });
        const pdfBase64 = fs.readFileSync(req.file.path).toString('base64');

        const aiResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
                `你是一個專業的台灣高中數學與物理家教老師。請細心閱讀這份 PDF 檔案，找出裡面「所有的」題目。
                請將每一題各自拆解，並「嚴格」以下列的 JSON 陣列格式回傳。

                特別注意【chapter】欄位，必須「完全符合」以下規定的精細章節名稱，不得自己發明新名詞：

                【數學科精細章節白名單】：
                - 第一冊：實數、絕對值、指數與對數、直線方程式、圓方程式、多項式除法、三次函數
                - 第二冊：數列與級數、排列、組合、古典機率、期望值、一維數據分析、二維數據分析
                - 第三冊(A/B)：三角函數的定義、正弦與餘弦定理、三角測量、向量的加減與係數積、向量內積、面積與行列式
                - 第四冊(A/B)：空間概念與座標系、空間向量內積、外積、平面方程式、空間直線方程式、矩陣的加減與乘法、克拉瑪公式
                - 選修數學：數列的極限、函數的極限、微分導函數、函數圖形與極值、定積分與面積、隨機變數、常態分配

                【物理科精細章節白名單】：
                - 必修物理：科學的態度與方法、物質的組成（夸克與原子）、物體的運動（速度與加速度）、四大基本交互作用、能量的形式與守恆、量子現象（光電效應與波粒二象性）、宇宙學簡介
                - 選修物理一：直線運動、平面運動、牛頓運動定律、摩擦力與向心力、動量與衝量、動量守恆與碰撞
                - 選修物理二：功與動能、位能與能量守恆、重力場與重力位能、剛體轉動與平衡、簡諧運動(SHM)、流體的壓力與浮力
                - 選修物理三：波動的性質、聲波與交互作用、幾何光學（反射折射）、物理光學（干涉繞射）
                - 選修物理四：靜電學、電場與電位、電流與電路、電流磁效應、電磁感應、交流電
                - 選修物理五：近代物理的序幕、原子結構與光譜、核物理與基本粒子

                JSON 回傳格式：
                [
                    {
                        "subject": "數學" 或 "物理",
                        "chapter": "必須是上方白名單中的精細章節名稱",
                        "question_type": "單選、多選、填空 或 計算",
                        "difficulty": 1到5的難度整數,
                        "question_text": "題目的完整題目與選項文字。⚠️【極度重要】：所有數學公式、希臘字母、方程式、數字變數，不論長短，都必須單獨使用錢字號包覆，格式為：$這裡放公式$（例如：$x=2$、$\\pi$、$\\frac{1}{2}$、$10^{2}$）。分數一律使用 \\frac{}{}，上標一律使用 ^{}，絕對禁止使用 Unicode 數學符號代替 LaTeX，否則系統會崩潰！",
                        "answer_text": "請提供該題的正確答案"
                    }
                ]`,
                `\n\n【系統額外強制指令：圖表與幾何圖形分析】\n請務必仔細觀測考卷中的所有附圖、幾何圖形或圖表資料。由於你無法直接匯出圖片檔案，請將該圖表所有的「解題關鍵視覺資訊」（包含：精確的座標點、邊長、角度、函數曲線趨勢、物體受力方向或電路圖連接方式等）進行詳細的文字解讀，並以「[附圖描述：...]」的文字形式，直接補充進該題的 \`question_text\` 欄位末端。確保學生在沒有原始圖片的情況下，也能完全依賴你的文字描述解出題目。`
            ],
            config: { responseMimeType: "application/json" }
        });

        let rawText = aiResponse.text.trim();
        if (rawText.startsWith("```")) {
            rawText = rawText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
        }

        let questionsArray = [];
        try {
            questionsArray = JSON.parse(rawText);
        } catch (e) {
            return res.status(500).json({ message: 'AI 回傳的 JSON 格式錯誤，請重新分析' });
        }
        res.json(questionsArray);

    } catch (err) { next(err); } finally {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

app.post('/api/batch-save-questions', async (req, res, next) => {
    const { questions } = req.body;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ message: "資料格式不正確或陣列為空" });
    }
    try {
        const sql = `INSERT INTO questions (subject, chapter, question_type, difficulty, question_text, answer_text, history_json) VALUES ?`;
        const values = questions.map(q => [q.subject || '數學', q.chapter || '未分類', q.question_type || '填空', q.difficulty || 3, q.question_text, q.answer_text || '略', '{}']);
        await pool.query(sql, [values]);
        res.json({ message: `🎉 成功！已將共 ${questions.length} 題自動錄入資料庫！` });
    } catch (err) { next(err); }
});

app.post('/api/download-word', async (req, res, next) => {
    const { paper_title, student_name, question_ids } = req.body;
    if (!question_ids || !Array.isArray(question_ids) || question_ids.length === 0) {
        return res.status(400).json({ message: "無效的題目資料，無法產生 Word" });
    }

    try {
        const placeholders = question_ids.map(() => '?').join(',');
        const [questions] = await pool.execute(`SELECT id, question_text, question_type, difficulty, question_img, answer_text FROM questions WHERE id IN (${placeholders})`, question_ids);

        const sortedQuestions = question_ids.map(id => questions.find(q => q.id === id)).filter(Boolean);
        const childrenElements = [];

        childrenElements.push(new Paragraph({ text: paper_title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
        childrenElements.push(new Paragraph({ text: `學生姓名：${student_name}     |     得分：__________     |     列印日期：${new Date().toLocaleDateString('zh-TW')}` }));
        childrenElements.push(new Paragraph({ text: "=".repeat(60) }));
        childrenElements.push(new Paragraph({ text: "一、 精選特訓試題區", heading: HeadingLevel.HEADING_1 }));

        for (let i = 0; i < sortedQuestions.length; i++) {
            const q = sortedQuestions[i];

            // 🎯 使用抽取出來的共用函式組合題目，安全且乾淨
            const paragraphComponents = [
                new TextRun({ text: `第 ${i + 1} 題. [${q.question_type}] (難度: ${'★'.repeat(q.difficulty)})\n`, bold: true, color: "2B6CB0" }),
                ...parseMixedContent(q.question_text)
            ];

            childrenElements.push(new Paragraph({ children: paragraphComponents }));

            if (q.question_img && (q.question_img.startsWith('http://') || q.question_img.startsWith('https://'))) {
                try {
                    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                    const imgResponse = await fetch(q.question_img);
                    if (imgResponse.ok) {
                        const arrayBuffer = await imgResponse.arrayBuffer();
                        const imageBuffer = Buffer.from(arrayBuffer);
                        childrenElements.push(new Paragraph({ children: [new ImageRun({ data: imageBuffer, transformation: { width: 300, height: 200 } })], alignment: AlignmentType.CENTER }));
                        childrenElements.push(new Paragraph({ text: "" }));
                    }
                } catch (imgError) { console.error(`圖片下載失敗`, imgError.message); }
            }
            if (q.question_type === '計算' || q.question_type === '證明') {
                childrenElements.push(new Paragraph({ text: "" }), new Paragraph({ text: "" }));
            }
        }

        childrenElements.push(new Paragraph({ children: [new PageBreak()] }));
        childrenElements.push(new Paragraph({ text: "🎯 參考答案區（解答邊界）", heading: HeadingLevel.HEADING_1 }));

        // 🎯 解答區一併使用通用渲染器，確保解答包含分數時不會只出現 [FRAC:x|y]
        sortedQuestions.forEach((q, index) => {
            childrenElements.push(new Paragraph({
                children: [
                    new TextRun({ text: `第 ${index + 1} 題答案：`, bold: true }),
                    new TextRun({ text: "  " }),
                    ...parseMixedContent(q.answer_text, { color: "E53E3E", bold: true }),
                    new TextRun({ text: "  " })
                ]
            }));
        });

        const doc = new Document({ sections: [{ children: childrenElements }] });
        const docBuffer = await Packer.toBuffer(doc);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(paper_title)}.docx`);
        res.setHeader('Content-Length', docBuffer.length);

        return res.send(docBuffer);

    } catch (err) { next(err); }
});

app.get('/api/chapters', async (req, res, next) => {
    try {
        const [rows] = await pool.execute('SELECT DISTINCT subject, chapter FROM questions WHERE chapter IS NOT NULL AND chapter != ""');
        res.json(rows);
    } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
    console.error("【全域系統錯誤中樞捕捉】異常回報:", err.message);
    res.status(500).json({ message: '後端伺服器內部發生未知錯誤', error: err.message });
});
app.listen(PORT, () => console.log(`🚀 家教題庫後端系統已成功安全啟動：http://localhost:${PORT}`));