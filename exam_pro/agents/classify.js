// agents/classify.js — 章節分類節點（A-T9；docs/interfaces-stage2.md 第 3.1／3.3 條）
//
//   input  : { subject, chapter, chapter_confidence, question_text }
//   outcome: {kind:'pass', data:{chapter, confidence, rationale, source, few_shot_ids?}}
//            {kind:'fail', reason:'chapter_invalid', feedback:'…'}
//            {kind:'error', errorClass:…}
//
// 兩層：
//
//   第一層（零成本閘門）：拆題模型給的章節本來就在白名單內、而且它自己的信心 ≥ CLASSIFY_MIN_CONF
//   → 直接 pass，**一次 LLM 都不呼叫**。這一層的通過率是階段 2 最重要的成本指標
//   （report:jobs 會印；> 95% 就代表這個節點可以降為抽樣）。
//   `chapter_confidence` **缺值或 0 一律視為閘門不過**，不得當成 1.0（裁決 S2-13）。
//
//   第二層（few-shot + LLM）：只有第一層沒過的題才走到。few-shot 候選依序：
//     A. 向量最近鄰 **8** 題（`ctx.config.features.similar` 為真、且有 `ctx.db` 時；裁決 S2-8）
//     B. 題庫各章各取 2 題
//     C. config/chapterExamples.js 的自製例句（補上 A/B 取不到的章；永遠執行）
//   取材失敗一律降級，不算節點失敗。
//   輸出**再過一次** isValidChapter：schema 的 enum 是兩科合併的 86 個（〔章節重整 CH-A〕原 66 個），
//   模型可能給出「物理題配到數學章節」這種跨科錯配，只有伺服器端擋得住。
//
//   ── 階段 3（interfaces-stage3.md 第 5 條，P-14）──
//   A 層改成「檢索式 few-shot」：k=8、排除同一份 PDF 的題、`'knn'` 也可以當範例；
//   並在 A 層與 LLM 之間插一個 **kNN 投票短路**（第 5.2 條）：最近 5 個鄰居裡
//   ≥ 4 題是**人工確認**的同一章、且最近鄰餘弦 ≥ `KNN_VOTE_SIM` → 直接 pass，
//   `source='knn'`、入庫時 `chapter_src='knn'`，**一次 LLM 都不呼叫**。
//   `'knn'` 與 `'ai'` **沒有投票權**：自動標籤餵回自動投票是閉環放大器（規劃 §4.4）。
//   題庫初期沒有人工標籤時短路率就是 0——這是誠實的起點，不是 bug。
//   第一層閘門與 `cacheKeyParts.fewShotIds` 的算法**一個字都沒改**，既有 cassette 全部不失效。
//
// 〔stage5 WS-B〕化學題（input.subject === '化學'，或化學卷的題）改用 classify_chem 的
//   SYSTEM／模板／schema（下方 VARIANTS.chemistry，ADR-010）；兩層閘門與 few-shot 取材共用。
//
// ⚠ 錄 cassette 與跑 eval 時 **ctx.db 一律為 null**（裁決 S2-8）：cassette 的鍵含 fewShotIds，
//   接了資料庫錄出來的鍵帶著一串題目 id，CI 沒有那個庫、fewShotIds 會是 []，鍵對不上、全部 miss。

const { CHAPTERS, SUBJECTS, isValidChapter, isValidSubject } = require('../config/chapters');
const { getChapterExample } = require('../config/chapterExamples');
const { buildSchema } = require('./schemas');
const { chapterWhitelistText, resolveSubjectGroup } = require('./promptParts');
const { registerTemplate } = require('../services/llm/templates');

// 〔章節重整整合 CR-9〕2026-09-26 v1 → v2（docs/chapter-restructure.md 第 8 條 CR-9）：
//   ① 規則 5 補上「指數與對數」（第一冊）／「指數函數與對數函數」（第三冊）的分冊界線（決策單 A5）；
//   ② config/chapterExamples.js 這兩章的例句改寫。
//   ③ 〔CR-9 審查〕v2 發布前再調整：界線規則改成「只給該科看」（下方 SUBJECT_RULES，模板只留
//      {{SUBJECT_RULES}} 占位），並補上已有書面原則的界線（數學：平面／空間向量內積；物理：
//      eval/CHAPTER_RELABEL-2026-09.md 第 8.0 節的三組相鄰章）。v2 還沒錄過任何 cassette，所以不再升版。
//   ④ 〔重練與收尾決策單 2026-09-26 K2／K3〕v2 發布前再補兩條 Owner 定的界線（物理 8：直線運動／平面運動；
//      數學 7：直角三角形的邊角關係／三角函數的疊合），並把 SUBJECT_RULES 併進註冊的模板文字（見下方
//      REGISTERED_TEMPLATE）。v2 仍然沒錄過任何 cassette，所以不再升版。
//   cassette 的鍵只含模板原文、題幹與 few-shot 的 **id**（第 5.2 條），**不含例句文字**——只改例句的話鍵不變，
//   回放會拿到舊答案、量不到改善。所以改例句要把識別名版號 +1：cacheKeyParts.template 跟著變，數學與物理
//   （共用這一份模板與識別名）的 classify cassette 全部要重錄。化學走 classify_chem.v1，不受影響。
//   界線規則自 ④ 起已在註冊的模板文字裡，改規則鍵會自己變（回放 miss、不會拿到舊答案）；仍照慣例升版，
//   單元測試把規則雜湊與版號一起釘住當提醒。
const TEMPLATE = 'classify.v2';
const DEFAULT_MIN_CONF = 0.8;
const FEW_SHOT_K = 8;              // 向量最近鄰取幾題（階段 3 第 5.1 條把 5 改成 8）
const KNN_VOTE_N = 5;              // 投票只看最近的幾個鄰居（第 5.2 條）
const KNN_VOTE_MIN_HUMAN = 4;      // 這 5 個裡至少幾題是「人工確認且同章」
const DEFAULT_KNN_VOTE_SIM = 0.90; // 最近鄰餘弦下限（ctx.config.thresholds.knnVoteSim）
const PER_CHAPTER_EXAMPLES = 2;    // 各章取幾題（規劃 §3.3.4）
const RATIONALE_MAX = 200;         // 第 3.2 條：rationale ≤ 200 字

const SYSTEM = '你是一位資深的台灣高中數學與物理家教老師，正在替題庫的題目標註精細章節。你只輸出 JSON，不輸出任何其他文字。';

const PROMPT_TEMPLATE = `請判斷下面這道題目屬於哪一個精細章節。

{{CHAPTER_WHITELIST}}
（白名單依冊別分組列出；「第一冊」「選修物理一」這類冊名只是分組標題，不是章名。）

【規則】
1. chapter 必須「完全等於」白名單裡的某一個字串，一個字都不能差，也不得自創新詞。
2. 判斷依據是「解這一題需要用到哪一章的觀念」，不是題目裡出現了哪些名詞。例如用到向量夾角公式的題目屬於向量內積，即使題幹在講風力或斜面。
3. 若題目橫跨兩章，選「非用不可」的那一章；只是順帶用到的計算工具不算。
4. confidence 請誠實給分：低於門檻的題目會被送去人工複核，這比標錯章節便宜得多。
{{SUBJECT_RULES}}

{{FEW_SHOT}}

{{FEEDBACK}}

【要分類的題目】
{{QUESTION}}`;

// 〔重練與收尾決策單 2026-09-26〕模板的註冊（registerTemplate）移到 SUBJECT_RULES 之後，見下方 REGISTERED_TEMPLATE。

// ───────────── 各科的章節界線規則（〔CR-9 審查〕2026-09-26，docs/chapter-restructure.md CR-9） ─────────────
//
// 數學與物理共用上面的模板；界線規則會提到該科的章名，放在共用模板裡的話，物理題也會看到
// 「指數函數與對數函數」這類數學章名。所以改成只把「該科」的規則填進 {{SUBJECT_RULES}}，
// 接在共用的規則 1～4 後面、從 5 開始編號；沒有規則的科目整行拿掉（不留空行）。
//
// 只收**已有書面原則**的界線，不自創新原則；除了數學 5 沿用 CR-9 原文（前面兩句是前言），每條一句：
//   數學 5：決策單 A5（第一冊只教常用對數；CR-6／CR-9）。文字與 CR-9 寫在共用模板時逐字相同，只是搬過來。
//   數學 6：章名本身的定義——第三冊「向量內積」是平面向量，第四冊「空間向量內積」是空間（三維坐標）向量。
//          只談內積；空間向量的加減沒有章（CR-8 待 Owner），這裡不涵蓋。
//   物理 5～7：eval/CHAPTER_RELABEL-2026-09.md 第 8.0 節的分界原則（Owner 2026-09-25 裁決；CR-8 之二），
//          等位面與電力線歸電場與電位見同檔第 8.6 節第 5 點；與 config/chapterAliases.js 既有別名一致
//          （等速圓周運動→平面運動、向心力→摩擦力與向心力、等位面→電場與電位、庫侖定律→靜電學）。
//   尚未有書面原則、**刻意不寫**的界線（待 Owner）：直線運動／平面運動（一維相對速度，#52 維持直線運動）、
//   直角三角形的邊角關係／三角函數的疊合。
//   〔重練與收尾決策單 2026-09-26 K2／K3〕上一行的兩組 Owner 已定原則（都選 1），各寫成一條、接在該科最後：
//   數學 7（K3）：只用到銳角與平方、商數、餘角關係 → 第二冊「直角三角形的邊角關係」；化成 r sin(x＋φ) 的
//          疊合才歸第三冊「三角函數的疊合」（與 eval/CHAPTER_RELABEL-2026-09.md 第 0 節的原則一致）。
//   物理 8（K2）：同一直線上（一維）的運動，含一維相對速度 →「直線運動」；要用向量分解或二維才解得出 →「平面運動」。
//
// 〔重練與收尾決策單 2026-09-26〕規則文字已併進註冊的模板文字（下方 REGISTERED_TEMPLATE），改這裡 cassette 的鍵
//   會自己變。原本的做法仍照舊：改規則就把 TEMPLATE 的版號 +1，數學＋物理的 classify cassette 全部重錄
//   （docs/llm.md「什麼時候必須重錄」）；單元測試把規則文字的雜湊與版號一起釘住，當作升版的提醒。
const SUBJECT_RULES = Object.freeze({
    '數學': Object.freeze([
        '冊別依 108 課綱。章名相近、分在不同冊的兩章，看題目實際用到的內容，不要只看章名字面。數學第一冊「指數與對數」只收指數律與以 10 為底的常用對數（不寫底數的 log；含其運算、科學記號、首數與尾數、位數估計）；底數不是 10 的對數（含對數律、換底公式）、指數或對數方程式與不等式、指數函數與對數函數的圖形，都屬第三冊「指數函數與對數函數」。',
        '同樣是向量的內積，平面向量（二維坐標）屬第三冊「向量內積」，空間向量（三維坐標）屬第四冊「空間向量內積」。',
        // 〔重練與收尾決策單 2026-09-26 K3〕選 1
        '題目只用到銳角與平方、商數、餘角關係的，屬第二冊「直角三角形的邊角關係」；要化成 r sin(x＋φ) 的疊合，才屬第三冊「三角函數的疊合」。'
    ]),
    '物理': Object.freeze([
        '必修「物體的運動（速度與加速度）」與選修「直線運動」：只需定義、名詞辨析、圖形意義或定性說明就能作答的，歸「物體的運動（速度與加速度）」；需要代入等加速度公式或從圖求數值的，歸「直線運動」。',
        '「平面運動」與「摩擦力與向心力」：圓周運動只問速率、速度方向、向心加速度或週期（運動學）的，歸「平面運動」；需要求向心力、張力或摩擦力的，歸「摩擦力與向心力」。',
        '「靜電學」與「電場與電位」：求兩個電荷之間的力（庫侖定律）的，歸「靜電學」；求電場、電位、電位能或作功，或問電力線（電場線）與等位面的，歸「電場與電位」。',
        // 〔重練與收尾決策單 2026-09-26 K2〕選 1
        '「直線運動」與「平面運動」：在同一直線上（一維）的運動，包含一維的相對速度，歸「直線運動」；要用向量分解或在二維平面上才解得出來的，歸「平面運動」。'
    ])
});
const SHARED_RULE_COUNT = 4;        // 模板裡共用的規則 1～4；各科規則從 5 開始編號

// 〔重練與收尾決策單 2026-09-26〕審查意見：原本註冊的是挖空後的 PROMPT_TEMPLATE，SUBJECT_RULES 不在裡面，
//   改了規則 cassette 的鍵不會變，只能靠人記得升版。改成把規則（序列化）接在模板後面一起註冊，
//   分隔符照化學與 tutor 的慣例用 '\n---\n'；改任何一條規則，templateHash 就跟著變。
//   送給模型的 prompt 不變：仍由 fillSubjectRules 只填該科的規則。
const REGISTERED_TEMPLATE = `${PROMPT_TEMPLATE}\n---\n${JSON.stringify(SUBJECT_RULES)}`;
registerTemplate(TEMPLATE, REGISTERED_TEMPLATE);

/**
 * 該科的界線規則（已編號、以換行分隔）；沒有規則的科目回空字串。
 * @param {string} subject
 * @returns {string}
 */
function subjectRulesText(subject) {
    const rules = Object.prototype.hasOwnProperty.call(SUBJECT_RULES, subject) ? SUBJECT_RULES[subject] : [];
    return rules.map((rule, i) => `${SHARED_RULE_COUNT + 1 + i}. ${rule}`).join('\n');
}

/** 把 {{SUBJECT_RULES}} 換成該科規則；沒有規則就連同前面的換行一起拿掉。用函式替換，規則裡的 $ 不會被當成替換樣式 */
function fillSubjectRules(template, subject) {
    const rules = subjectRulesText(subject);
    return template.replace('\n{{SUBJECT_RULES}}', () => (rules ? `\n${rules}` : ''));
}

// ───────────────────── 化學題（〔stage5 WS-B〕DEC-019、ADR-010）─────────────────────
//
// 科目是化學（或化學卷的題）時改走這一組：agent 名 classify_chem、模板 classify_chem.v1、
// 化學值域的 schema。第一層零成本閘門、kNN 投票短路、few-shot 取材與 cacheKeyParts 的算法
// 與數學／物理完全相同——只換 SYSTEM、模板與 schema。上面數學／物理的三者一個字都沒動。
// 註冊字串 = SYSTEM + '\n---\n' + 模板（docs/interfaces-stage5.md 第 1.2 條）。

const AGENT_CHEM = 'classify_chem';
const TEMPLATE_CHEM = 'classify_chem.v1';

const SYSTEM_CHEM = '你是一位資深的台灣高中化學家教老師，正在替題庫的化學題標註精細章節。你只輸出 JSON，不輸出任何其他文字。';

const PROMPT_TEMPLATE_CHEM = `請判斷下面這道化學題目屬於哪一個精細章節。

{{CHAPTER_WHITELIST}}

【規則】
1. chapter 必須「完全等於」白名單裡某一個「」內的字串（連頓號在內），一個字都不能差，也不得自創新詞。
2. 判斷依據是「解這一題需要用到哪一章的觀念」，不是題目裡出現了哪些名詞。例如用溶度積判斷是否產生沉澱的題目屬於溶解平衡與溶度積，即使題幹在講廢水處理。
3. 若題目橫跨兩章，選「非用不可」的那一章；只是順帶用到的計算工具（例如莫耳數換算）不算。
4. confidence 請誠實給分：低於門檻的題目會被送去人工複核，這比標錯章節便宜得多。

{{FEW_SHOT}}

{{FEEDBACK}}

【要分類的題目】
{{QUESTION}}`;

registerTemplate(TEMPLATE_CHEM, `${SYSTEM_CHEM}\n---\n${PROMPT_TEMPLATE_CHEM}`);

/** 卷別 → agent 名、模板、SYSTEM、模板原文與 schema 選項 */
const VARIANTS = {
    math_physics: { agent: 'classify', template: TEMPLATE, system: SYSTEM, promptTemplate: PROMPT_TEMPLATE, schemaOpts: undefined },
    chemistry: { agent: AGENT_CHEM, template: TEMPLATE_CHEM, system: SYSTEM_CHEM, promptTemplate: PROMPT_TEMPLATE_CHEM, schemaOpts: { group: 'chemistry' } }
};

// ───────────────────────── 純函式 ─────────────────────────

/** 字串切成相鄰字元的 bigram 集合（中文沒有空白可切，用 bigram 當粗略的「詞」） */
function bigrams(text) {
    const s = String(text || '');
    const set = new Set();
    if (s.length === 1) set.add(s);
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
}

/** Dice 係數：兩個集合的重疊程度，0~1 */
function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const g of a) if (b.has(g)) common += 1;
    return (2 * common) / (a.size + b.size);
}

/** 單字元集合（bigram 完全不重疊時的第二把尺：「電磁學」與「靜電學」共用「電」「學」） */
function chars(text) {
    return new Set(String(text || ''));
}

/**
 * 找出白名單內與 value 最像的幾章（給失敗 feedback 用）。
 * 分數 = 0.7×bigram Dice + 0.3×單字元 Dice：只用 bigram 的話，
 * 「電磁學」對每一章都是 0 分，回出來的兩個候選會是宣告順序的前兩章（毫無幫助）。
 * 同分時依 config/chapters.js 的宣告順序——確定性，同一個輸入永遠回同一組候選。
 * @returns {string[]}
 */
function nearestChapters(subject, value, k = 2) {
    const list = isValidSubject(subject) ? CHAPTERS[subject] : Object.values(CHAPTERS).flat();
    const targetBi = bigrams(value);
    const targetCh = chars(value);
    return list
        .map((chapter, order) => ({
            chapter,
            order,
            score: 0.7 * dice(targetBi, bigrams(chapter)) + 0.3 * dice(targetCh, chars(chapter))
        }))
        .sort((a, b) => (b.score - a.score) || (a.order - b.order))
        .slice(0, k)
        .map(x => x.chapter);
}

/**
 * 失敗時的 feedback，格式凍結（第 3.3 條）：
 *   「${回傳值}」不在白名單內，最接近的是「${候選1}」「${候選2}」
 */
function invalidChapterFeedback(subject, value) {
    const near = nearestChapters(subject, value, 2);
    return `「${value}」不在白名單內，最接近的是${near.map(c => `「${c}」`).join('')}`;
}

/** rationale 太長就截斷（schema 不設 maxLength：那會讓「話多」變成整題失敗，代價不成比例） */
function clampRationale(text) {
    const s = String(text ?? '').trim();
    return s.length > RATIONALE_MAX ? `${s.slice(0, RATIONALE_MAX - 1)}…` : s;
}

/** few-shot 例句 → prompt 區塊 */
function fewShotText(examples) {
    if (!examples.length) return '';
    const lines = examples.map(e => `- 題目：${oneLine(e.question_text)}\n  章節：${e.chapter}`);
    return `【已標註好的範例（章節都是正確的，請照這個粒度判斷）】\n${lines.join('\n')}`;
}

function oneLine(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function thresholdOf(ctx) {
    const t = (ctx && ctx.config && ctx.config.thresholds) || {};
    const v = Number(t.classifyMinConf);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MIN_CONF;
}

/** kNN 投票短路的最近鄰餘弦下限（第 4.5 條：由 runner 從 KNN_VOTE_SIM 組進 thresholds） */
function knnVoteSimOf(ctx) {
    const t = (ctx && ctx.config && ctx.config.thresholds) || {};
    const v = Number(t.knnVoteSim);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_KNN_VOTE_SIM;
}

// ───────────────────────── few-shot 取材 ─────────────────────────

/**
 * A. 向量最近鄰（需要 FEATURE_SIMILAR、DB、以及可用的 embedding）。
 *
 * 階段 3（interfaces-stage3.md 第 5.1 條）改了三件事，SQL 逐字凍結在那一條：
 *   1. `k = 8`（原本 5）；
 *   2. `chapter_src` 三種都可以當**範例**（`'human'`／`'ai'`／`'knn'`），
 *      但排序上 human 先——階段 2 這裡是 `IN ('human','ai')`，把 `'knn'` 排除在範例之外；
 *      第 5.2 條把「不得當範例」收窄成「**不得有投票權**」，範例仍可用。
 *   3. **排除同一份 PDF 的題**：`LEFT JOIN job_questions/jobs` + `IS DISTINCT FROM`。
 *      用 `LEFT JOIN` 而不是 `JOIN`、用 `IS DISTINCT FROM` 而不是 `<>`，是因為
 *      `seed`／`manual`／`variant` 這些題沒有 job 列，`j.pdf_sha256` 是 NULL：
 *      `NULL <> 'abc…'` 是 NULL（假），會把它們**整批**排掉；
 *      `NULL IS DISTINCT FROM 'abc…'` 才是真。這條 join 存在的唯一理由就是這個。
 *      `ctx.job.pdf_sha256` 為 NULL（變式 job）時所有題都留著。
 *
 * @returns {Promise<Array<{id, chapter, chapter_src, question_text, cosine}>|null>}
 *          **依距離排序**的原始列（kNN 投票要用這個順序，不是 examples 的順序）
 */
async function fewShotByVector(ctx, { subject, chapter, question_text }) {
    // 旗標只能從 ctx.config.features 讀（裁決 S2-8：runner 從 config/features.js 組成
    // { similar, pipeline }）——agent 不得自己讀 process.env。
    const features = (ctx.config && ctx.config.features) || {};
    if (features.similar !== true || !ctx.db || typeof ctx.db.query !== 'function') return null;
    if (!ctx.llm || typeof ctx.llm.embed !== 'function') return null;

    const { buildEmbedText } = require('../utils/embedText');
    const pgvector = require('pgvector');

    const text = buildEmbedText({
        subject,
        chapter: chapter || '',
        question_type: '計算',
        difficulty: 3,
        question_text
    });
    const { vectors } = await ctx.llm.embed({ texts: [text] });
    if (!vectors || !vectors[0]) return null;

    const { rows } = await ctx.db.query(
        `SELECT q.id, q.chapter, q.chapter_src, q.question_text,
                1 - (q.embedding <=> $2::vector) AS cosine
           FROM questions q
           LEFT JOIN job_questions jq ON jq.question_id = q.id
           LEFT JOIN jobs j           ON j.id = jq.job_id
          WHERE q.subject = $1
            AND q.archived_at IS NULL
            AND q.embedding IS NOT NULL
            AND q.chapter_src IN ('human','ai','knn')
            AND (j.pdf_sha256 IS DISTINCT FROM $3)
          ORDER BY q.embedding <=> $2::vector, q.id
          LIMIT ${FEW_SHOT_K}`,
        [subject, pgvector.toSql(vectors[0]), (ctx.job && ctx.job.pdf_sha256) || null]
    );
    if (!rows.length) return null;
    return rows.map(r => ({
        id: r.id, chapter: r.chapter, chapter_src: r.chapter_src,
        question_text: r.question_text, cosine: Number(r.cosine)
    }));
}

/**
 * few-shot 範例的排序（第 5.1 條凍結）：**先 `human`（依距離），再 `ai`／`knn`（依距離）**。
 *
 * 只重排，不篩掉任何一題——`fewShotIds` 是「examples 裡的整數 id 由小到大」，
 * 與順序無關，所以 cassette 的鍵不受影響（第 5.1 條末句）。
 *
 * @param {Array<{chapter_src?:string}>} rows 依距離排序的原始列
 * @returns {Array<object>} 新陣列
 */
function orderExamples(rows) {
    const human = [];
    const rest = [];
    for (const r of rows || []) (r.chapter_src === 'human' ? human : rest).push(r);
    return [...human, ...rest];
}

/**
 * kNN 投票短路（第 5.2 條、裁決 S3-15）。
 *
 * 三個條件同時成立才短路：
 *   1. 最近的 5 個鄰居裡**至少 4 個**滿足 `chapter_src === 'human' && chapter === top`；
 *   2. `rows[0].cosine >= KNN_VOTE_SIM`；
 *   3. `isValidChapter(subject, top)`。
 *
 * **`'knn'` 與 `'ai'` 沒有投票權**：條件 1 只數 `'human'`。自動標籤餵回自動投票是閉環放大器，
 * 錯一題會自我強化成一串同錯題（規劃 §4.4）。題庫初期沒有人工標籤時短路率就是 0，
 * **這是誠實的起點，不是 bug**。
 *
 * @param {Array<{chapter, chapter_src, cosine}>} rows 依距離排序的原始列
 * @param {string} subject
 * @param {number} minSim
 * @returns {{ok:true, chapter:string, cosine:number, humanVotes:number}|{ok:false}}
 */
function knnVote(rows, subject, minSim) {
    const list = Array.isArray(rows) ? rows.slice(0, KNN_VOTE_N) : [];
    if (list.length === 0) return { ok: false };

    const top = list[0].chapter;
    const humanVotes = list.filter(r => r.chapter_src === 'human' && r.chapter === top).length;
    const nearest = Number(list[0].cosine);

    if (humanVotes < KNN_VOTE_MIN_HUMAN) return { ok: false };
    if (!Number.isFinite(nearest) || nearest < minSim) return { ok: false };
    if (!isValidChapter(subject, top)) return { ok: false };

    return { ok: true, chapter: top, cosine: nearest, humanVotes };
}

/** B. 題庫各章各取 PER_CHAPTER_EXAMPLES 題（一句 SQL，順序確定） */
async function fewShotByChapter(ctx, { subject }) {
    if (!ctx.db || typeof ctx.db.query !== 'function') return [];
    const { rows } = await ctx.db.query(
        `SELECT id, chapter, question_text FROM (
             SELECT id, chapter, question_text,
                    row_number() OVER (PARTITION BY chapter ORDER BY id) AS rn
               FROM questions
              WHERE subject = $1
                AND archived_at IS NULL
                AND question_text IS NOT NULL
                AND chapter_src IN ('human','ai')
         ) t
         WHERE rn <= $2
         ORDER BY chapter, id`,
        [subject, PER_CHAPTER_EXAMPLES]
    );
    return rows.map(r => ({ id: r.id, chapter: r.chapter, question_text: r.question_text }));
}

/** C. 自製例句，補上 A/B 沒有涵蓋到的章（保證每一章都有東西可舉例） */
function fewShotFromConfig(subject, covered) {
    const list = isValidSubject(subject) ? CHAPTERS[subject] : [];
    const out = [];
    for (const chapter of list) {
        if (covered.has(chapter)) continue;
        const example = getChapterExample(subject, chapter);
        if (example && example.trim()) out.push({ id: null, chapter, question_text: example.trim() });
    }
    return out;
}

/**
 * 組出 few-shot 例句與它們的 id 清單。
 * @returns {Promise<{examples:Array<object>, ids:number[], source:'vector'|'chapter'|'config',
 *                    neighbors:Array<object>}>}
 *          `neighbors` 是 A 層**依距離排序**的原始列（kNN 投票用），取不到時是空陣列。
 */
async function gatherFewShot(ctx, input) {
    const logger = (ctx && ctx.logger) || console;
    let examples = [];
    let source = 'config';
    let neighbors = [];

    try {
        const byVector = await fewShotByVector(ctx, input);
        if (byVector && byVector.length) {
            neighbors = byVector;              // 原始距離順序，投票要用
            examples = orderExamples(byVector); // 範例順序：human 先，再 ai／knn
            source = 'vector';
        }
    } catch (err) {
        // 取不到向量不是失敗——退回題庫例句就好（EMBED_MODE=fixture 的 CI 一定會走到這裡）
        logger.warn?.({ node: 'classify', msg: `向量 few-shot 取材失敗，改用題庫各章取例：${err.message}` });
    }

    if (!examples.length) {
        try {
            const byChapter = await fewShotByChapter(ctx, input);
            if (byChapter.length) {
                examples = byChapter;
                source = 'chapter';
            }
        } catch (err) {
            logger.warn?.({ node: 'classify', msg: `題庫 few-shot 取材失敗，改用自製例句：${err.message}` });
        }
    }

    const covered = new Set(examples.map(e => e.chapter));
    examples = examples.concat(fewShotFromConfig(input.subject, covered));

    const ids = examples.map(e => e.id).filter(id => Number.isInteger(id));
    return { examples, ids, source, neighbors };
}

// ───────────────────────── 節點主體 ─────────────────────────

/**
 * @param {object} ctx
 * @param {{subject:string, chapter?:string, chapter_confidence?:number, question_text:string, feedback?:string}} input
 * @returns {Promise<object>} outcome
 */
async function run(ctx, input = {}) {
    try {
        const subject = input.subject;
        const questionText = String(input.question_text ?? '').trim();

        if (!isValidSubject(subject)) {
            return {
                kind: 'fail',
                reason: 'chapter_invalid',
                // 〔stage5 WS-B〕科目清單改由 SUBJECTS 產生（化學併入後是「數學」「物理」「化學」）
                feedback: `學科「${input.subject}」不在白名單內，只接受${SUBJECTS.map(s => `「${s}」`).join('')}`
            };
        }
        // 〔stage5 WS-B〕化學題走化學的 SYSTEM／模板／schema；數學與物理的 v 與階段 5 之前寫死的值相同
        const v = VARIANTS[resolveSubjectGroup(ctx, { subject })];
        if (!questionText) {
            return { kind: 'fail', reason: 'schema_invalid', feedback: 'classify：question_text 是空的。' };
        }

        // ── 第一層：零成本閘門 ──
        // 裁決 S2-13：chapter_confidence **缺值或 0 一律視為閘門不過**，不得當成 1.0。
        // 這條看起來多餘（0 >= 0.8 本來就是 false），但把它寫死才擋得住兩種情況：
        // 有人把 CLASSIFY_MIN_CONF 設成 0，以及未來有人「順手」把缺值補成預設高分。
        const minConf = thresholdOf(ctx);
        const confidence = Number(input.chapter_confidence);
        const confidenceUsable = Number.isFinite(confidence) && confidence > 0;
        if (isValidChapter(subject, input.chapter) && confidenceUsable && confidence >= minConf) {
            return {
                kind: 'pass',
                data: {
                    chapter: input.chapter,
                    confidence,
                    rationale: `拆題模型給的章節在白名單內，且信心 ${confidence} ≥ ${minConf}，零成本閘門直接採用。`,
                    source: 'gate'
                }
            };
        }

        // ── 第二層：few-shot + LLM ──
        const { examples, ids, neighbors } = await gatherFewShot(ctx, { ...input, subject, question_text: questionText });
        const fewShotIds = ids.slice().sort((a, b) => a - b);

        // ── 第二層之前的 kNN 投票短路（第 5.2 條）：成立時**不呼叫 LLM** ──
        const vote = knnVote(neighbors, subject, knnVoteSimOf(ctx));
        if (vote.ok) {
            return {
                kind: 'pass',
                data: {
                    chapter: vote.chapter,
                    confidence: vote.cosine,
                    rationale: clampRationale(
                        `最近 5 個鄰居中有 ${vote.humanVotes} 題人工確認的「${vote.chapter}」，` +
                        `最近鄰餘弦 ${vote.cosine.toFixed(4)} ≥ ${knnVoteSimOf(ctx)}，採用 kNN 投票。`),
                    source: 'knn',
                    few_shot_ids: fewShotIds
                }
            };
        }

        // 上一次失敗的具體理由（runner 會把 outcome.feedback 寫進 payload.classify.feedback）
        const feedback = input.feedback
            || (ctx.jq && ctx.jq.payload && ctx.jq.payload.classify && ctx.jq.payload.classify.feedback)
            || '';

        // 〔CR-9 審查〕界線規則只填該科的（化學模板沒有這個占位，fillSubjectRules 原樣回傳）
        const prompt = fillSubjectRules(v.promptTemplate, subject)
            .replace('{{CHAPTER_WHITELIST}}', chapterWhitelistText(subject))
            .replace('{{FEW_SHOT}}', fewShotText(examples))
            .replace('{{FEEDBACK}}', feedback ? `【上一次的錯誤，請不要再犯】\n${feedback}` : '')
            .replace('{{QUESTION}}', questionText);

        const res = await ctx.llm.generateJson({
            // 〔LM-15〕分類只讀題目文字：用 models.text（runner 由 MODEL_TEXT 組；Gemini 模式＝extract），沒給退回 extract
            model: (ctx.config && ctx.config.models && (ctx.config.models.text || ctx.config.models.extract)) || undefined,
            system: v.system,
            parts: [{ text: prompt }],
            schema: buildSchema('classify', v.schemaOpts),
            signal: ctx.signal,
            agent: v.agent,
            template: v.template,
            // 第 5.2 條：鍵納入 few-shot 的 **id 清單**而不是全文——
            // 題庫多一題、排序微動就換一份 cassette 的話，紅燈全是噪音。
            cacheKeyParts: { template: v.template, questionText, fewShotIds }
        });

        const data = res.data || {};
        if (!isValidChapter(subject, data.chapter)) {
            return {
                kind: 'fail',
                reason: 'chapter_invalid',
                feedback: invalidChapterFeedback(subject, data.chapter),
                data: {
                    chapter: data.chapter ?? null,
                    confidence: Number(data.confidence) || 0,
                    rationale: clampRationale(data.rationale),
                    source: 'llm',
                    few_shot_ids: fewShotIds
                }
            };
        }

        return {
            kind: 'pass',
            data: {
                chapter: data.chapter,
                confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0,
                rationale: clampRationale(data.rationale),
                source: 'llm',
                few_shot_ids: fewShotIds
            }
        };
    } catch (err) {
        return {
            kind: 'error',
            errorClass: err.errorClass || 'provider_error',
            message: err.message
        };
    }
}

module.exports = {
    run,
    // 給單元測試與 cassette 錄製腳本用
    nearestChapters, invalidChapterFeedback, gatherFewShot, fewShotText, clampRationale,
    // 階段 3（第 5 條）
    knnVote, orderExamples,
    TEMPLATE, SYSTEM, PROMPT_TEMPLATE,
    // 〔CR-9 審查〕各科的界線規則
    SUBJECT_RULES, subjectRulesText, fillSubjectRules,
    // 〔重練與收尾決策單 2026-09-26〕註冊的模板文字（PROMPT_TEMPLATE＋'\n---\n'＋序列化的 SUBJECT_RULES）
    REGISTERED_TEMPLATE,
    FEW_SHOT_K, KNN_VOTE_N, KNN_VOTE_MIN_HUMAN, DEFAULT_KNN_VOTE_SIM,
    // 〔stage5 WS-B〕化學題
    AGENT_CHEM, TEMPLATE_CHEM, SYSTEM_CHEM, PROMPT_TEMPLATE_CHEM
};
