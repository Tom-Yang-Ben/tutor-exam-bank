// utils/tokenize.js — 全案唯一的中文分詞器（docs/interfaces.md 第 2 條）
//
// 寫入（search_tsv）、查詢（to_tsquery）、eval（LIKE 基準欄的關鍵字）三處都只能呼叫
// 這一支，不得各自實作：三邊用不同的切法，量到的 Recall 就不是同一件事。
//
// 實作選擇（規劃 §1.5 裁決 3）：@node-rs/jieba（napi 預編譯，win32 不需 node-gyp），
// 不用 Intl.Segmenter。詞典由三層疊起來：
//   1. @node-rs/jieba 內建的 dict.txt（簡體為主，但 HMM 對繁體仍有相當作用）
//   2. config/chapters.js 的全部章節名（含拆出的子詞，如「摩擦力與向心力」→ 向心力）
//   3. 本檔的 EXAM_TERMS：手寫的高中數理繁體名詞
//   4. 選用：JIEBA_DICT_BIG 指到 dict.txt.big 時額外載入（預設不啟用，見 docs/archive/questions-wsC.md）
//
// 輸出可能含 f(x)、a:b、x2 這類殘留符號——這是刻意的。呼叫端一律以 text[] 參數傳進 SQL，
// 在 SQL 端用 quote_literal 組裝 to_tsquery，不得在 JS 端拼字串。

const fs = require('fs');
const path = require('path');
const { Jieba } = require('@node-rs/jieba');
const { dict } = require('@node-rs/jieba/dict');
const { CHAPTERS } = require('../config/chapters');

// ───────────────────────── 自訂詞 ─────────────────────────

// 高中數學／物理常見繁體名詞。內建 dict.txt 是簡體詞條，繁體詞多半只能靠 HMM 猜，
// 猜錯的實例：「作圓/周運動」「求外/接圓半徑」。這份清單就是用來釘住這類詞。
// 全部是通用學科名詞，非任何考卷內容。
const EXAM_TERMS = [
    // 數學：代數與函數
    '實數', '有理數', '無理數', '絕對值', '不等式', '一元二次方程式', '聯立方程式',
    '指數函數', '對數函數', '常用對數', '自然對數', '多項式', '因式分解', '餘式定理',
    '因式定理', '綜合除法', '三次函數', '二次函數', '判別式', '根與係數',
    // 數學：座標與幾何
    '直線方程式', '斜率', '截距', '圓方程式', '圓心', '半徑', '外接圓', '內切圓',
    '切線', '法線', '對稱點', '兩點距離', '中垂線', '拋物線', '橢圓', '雙曲線',
    // 數學：三角
    '三角函數', '弧度量', '正弦', '餘弦', '正切', '正弦定理', '餘弦定理', '和角公式',
    '倍角公式', '半角公式', '三角測量', '仰角', '俯角', '振幅',
    // 數學：向量與矩陣
    '向量', '單位向量', '零向量', '係數積', '內積', '外積', '向量內積', '空間向量',
    '方向餘弦', '行列式', '克拉瑪公式', '反矩陣', '轉置矩陣', '線性組合', '平面方程式',
    '法向量', '空間直線', '參數式', '點到平面距離',
    // 數學：機率統計與微積分
    '排列', '組合', '重複排列', '二項式定理', '古典機率', '條件機率', '期望值',
    '標準差', '變異數', '相關係數', '迴歸直線', '隨機變數', '常態分配', '標準化',
    '數列', '級數', '等差數列', '等比數列', '遞迴關係', '極限', '收斂', '發散',
    '導函數', '微分', '切線斜率', '極大值', '極小值', '反曲點', '定積分', '不定積分',
    '積分', '面積', '體積',
    // 物理：力學
    '質量', '速率', '速度', '加速度', '位移', '等速率', '等加速度', '自由落體',
    '拋體運動', '圓周運動', '向心力', '向心加速度', '角速度', '摩擦力', '靜摩擦力',
    '動摩擦力', '摩擦係數', '正向力', '合力', '分力', '自由體圖', '牛頓運動定律',
    '慣性', '動量', '衝量', '動量守恆', '彈性碰撞', '非彈性碰撞', '力矩', '轉動慣量',
    '角動量', '剛體', '力偶', '槓桿', '重心',
    // 物理：能量、流體、簡諧
    '動能', '位能', '重力位能', '彈性位能', '力學能', '能量守恆', '功率',
    '重力場', '重力加速度', '萬有引力', '克卜勒定律', '簡諧運動', '彈簧常數', '單擺',
    '週期', '頻率', '共振', '浮力', '阿基米德原理', '壓力', '大氣壓力', '帕斯卡原理',
    '密度', '比重',
    // 物理：波動與光學
    '波動', '波長', '波速', '橫波', '縱波', '駐波', '都卜勒效應', '聲波', '共鳴',
    '折射率', '全反射', '凸透鏡', '凹透鏡', '成像公式', '干涉', '繞射', '楊氏雙狹縫',
    '偏振',
    // 物理：電磁與近代
    '靜電', '庫侖定律', '電場', '電位', '電位能', '電容', '電容器', '電流', '電阻',
    '電阻率', '歐姆定律', '克希荷夫定律', '串聯', '並聯', '電功率', '電流磁效應',
    '安培右手定則', '磁場', '磁力線', '勞侖茲力', '電磁感應', '法拉第定律', '楞次定律',
    '感應電動勢', '交流電', '有效值', '變壓器', '光電效應', '功函數', '光子',
    '波粒二象性', '德布羅意波長', '能階', '氫原子光譜', '半衰期', '質能互換',
    '基本粒子', '夸克'
];

// 從章節白名單再拆出可用的子詞：'摩擦力與向心力' → 摩擦力 / 向心力；
// '物質的組成（夸克與原子）' → 物質的組成 / 夸克與原子 / 夸克 / 原子。
function expandChapterWords(name) {
    const out = new Set();
    // 先以括號、頓號等符號切段（全形括號經 NFKC 會變半形，這裡兩種都切）
    for (const seg of String(name).split(/[（）()、，,／/]/)) {
        const s = seg.trim();
        if (s.length >= 2) out.add(s);
        // 「A與B」再拆一層；兩側都要有兩個字以上才拆，避免切出無意義的單字
        if (s.includes('與')) {
            for (const part of s.split('與')) {
                const p = part.trim();
                if (p.length >= 2) out.add(p);
            }
        }
    }
    return [...out];
}

function buildUserDict() {
    const words = new Set(EXAM_TERMS);
    for (const list of Object.values(CHAPTERS)) {
        for (const chapter of list) {
            for (const w of expandChapterWords(chapter)) words.add(w);
        }
    }
    // jieba 詞典格式：`詞 詞頻 詞性`。詞頻取 3000（足以壓過內建詞條的切法，
    // 又不至於把整段句子黏成一個詞）。
    const lines = [...words].map(w => `${w} 3000 n`);
    return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

// ───────────────────────── 斷詞器實體 ─────────────────────────

let jieba = null;

function getJieba() {
    if (jieba) return jieba;
    jieba = Jieba.withDict(dict);

    // 選用的繁體大詞典。預設不啟用：本機有、CI 沒有的話，同一題在兩邊會切出不同的 token，
    // 寫入端與查詢端就不再一致（詳見 docs/archive/questions-wsC.md 第 1 題）。
    const bigDictPath = process.env.JIEBA_DICT_BIG;
    if (bigDictPath) {
        try {
            jieba.loadDict(fs.readFileSync(path.resolve(bigDictPath)));
        } catch (e) {
            console.warn(`[tokenize] JIEBA_DICT_BIG 載入失敗，改用內建詞典：${e.message}`);
        }
    }

    jieba.loadDict(buildUserDict());
    return jieba;
}

// ───────────────────────── 前處理與過濾 ─────────────────────────

// 結構性虛詞：留著只會讓 ts_rank_cd 把「每一題都有的字」也算進分數。
// 只收單字虛詞，不收任何可能是學科名詞的字（「功」「力」「波」都不在裡面）。
const STOPWORDS = new Set([
    '的', '了', '是', '在', '有', '和', '及', '與', '或', '而', '則', '之', '其', '此',
    '為', '以', '被', '把', '對', '於', '從', '到', '就', '也', '都', '很', '再', '並',
    '個', '們', '這', '那', '中', '上', '下', '內', '外', '所', '使', '會', '能', '可',
    '請', '一', '兩', '每', '各', '若', '設', '已', '如', '按', '由', '給', '至', '等'
]);

// 至少要有一個漢字、字母或數字才留下；純標點（「，」「：」「=」「(」）丟掉。
const HAS_CONTENT = /[\p{Script=Han}\p{Letter}\p{Number}]/u;

function preprocess(text) {
    return String(text)
        .normalize('NFKC')                     // 全形英數字、全形括號 → 半形，寫入與查詢才會一致
        .replace(/\$/g, ' ')                   // 去掉行內數學的 $ 界定符，$...$ 內容本身保留
        .replace(/\\([a-zA-Z]+)/g, ' $1 ')     // \theta → theta，避免反斜線黏在詞頭
        .replace(/\s+/g, ' ')
        .toLowerCase();                        // to_tsvector('simple') 本來就會轉小寫，這裡先做讓三處一致
}

/**
 * 全案唯一的中文分詞器。
 * @param {string} text
 * @returns {string[]}  去空白後的 token 陣列，順序 = 出現順序
 */
function tokenize(text) {
    if (text === null || text === undefined) return [];
    const cleaned = preprocess(text);
    if (cleaned.trim() === '') return [];

    const raw = getJieba().cut(cleaned, true);   // hmm=true：未登錄詞才有機會被切出來
    const out = [];
    for (const t of raw) {
        const tok = t.trim();
        if (!tok) continue;
        if (!HAS_CONTENT.test(tok)) continue;
        if (STOPWORDS.has(tok)) continue;
        out.push(tok);
    }
    return out;
}

module.exports = { tokenize };
