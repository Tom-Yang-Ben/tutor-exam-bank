// 精細章節白名單（與 aiService 的 prompt 同步）。
// 後端入庫時以此驗證，避免 AI 或前端傳入未授權的章節名稱。

const CHAPTERS = {
    '數學': [
        // 第一冊
        '實數', '絕對值', '指數與對數', '直線方程式', '圓方程式', '多項式除法', '三次函數',
        // 第二冊
        '數列與級數', '排列', '組合', '古典機率', '期望值', '一維數據分析', '二維數據分析',
        // 第三冊(A/B)
        '三角函數的定義', '正弦與餘弦定理', '三角測量', '向量的加減與係數積', '向量內積', '面積與行列式',
        // 第四冊(A/B)
        '空間概念與座標系', '空間向量內積', '外積', '平面方程式', '空間直線方程式', '矩陣的加減與乘法', '克拉瑪公式',
        // 選修數學
        '數列的極限', '函數的極限', '微分導函數', '函數圖形與極值', '定積分與面積', '隨機變數', '常態分配'
    ],
    '物理': [
        // 必修物理
        '科學的態度與方法', '物質的組成（夸克與原子）', '物體的運動（速度與加速度）', '四大基本交互作用', '能量的形式與守恆', '量子現象（光電效應與波粒二象性）', '宇宙學簡介',
        // 選修物理一
        '直線運動', '平面運動', '牛頓運動定律', '摩擦力與向心力', '動量與衝量', '動量守恆與碰撞',
        // 選修物理二
        '功與動能', '位能與能量守恆', '重力場與重力位能', '剛體轉動與平衡', '簡諧運動(SHM)', '流體的壓力與浮力',
        // 選修物理三
        '波動的性質', '聲波與交互作用', '幾何光學（反射折射）', '物理光學（干涉繞射）',
        // 選修物理四
        '靜電學', '電場與電位', '電流與電路', '電流磁效應', '電磁感應', '交流電',
        // 選修物理五
        '近代物理的序幕', '原子結構與光譜', '核物理與基本粒子'
    ]
};

const SUBJECTS = Object.keys(CHAPTERS);
const QUESTION_TYPES = ['單選', '多選', '填空', '計算', '證明'];

function isValidSubject(subject) {
    return SUBJECTS.includes(subject);
}

function isValidChapter(subject, chapter) {
    return isValidSubject(subject) && CHAPTERS[subject].includes(chapter);
}

function isValidQuestionType(type) {
    return QUESTION_TYPES.includes(type);
}

function normalizeDifficulty(value) {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    return n;
}

module.exports = { CHAPTERS, SUBJECTS, QUESTION_TYPES, isValidSubject, isValidChapter, isValidQuestionType, normalizeDifficulty };
