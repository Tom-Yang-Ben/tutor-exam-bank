// ─────────────────────────────────────────────────────────────
// eval/tools/suggest_golden.js — 產生檢索 golden 的「建議稿」
//
// 用法：node eval/tools/suggest_golden.js [--out eval/golden/retrieval.json]
//
// 這支腳本**不會**產出定稿。規劃 §5.3.2 寫得很清楚：
//   「候選池用 pooling，不只用 embedding 近鄰 → 人工逐一判相關 → 只有人工判定才進 relevant」。
// 所以它做的是：把候選池建好、把「看起來是正樣本／硬負樣本」的建議填好、
// 每一筆蓋上 needs_human_confirm，等開發者本人逐筆看過再把旗標拿掉。
//
// 建議從哪裡來（都是 fixture 的結構標註，不是任何檢索系統的輸出）：
//   relevant       = 同一個 variant_group 的其他題（「換數字的同一題」）
//   hard_negatives = 跨章字面相近組（lookalike_of）+ 同章不同概念的干擾題
// 刻意**不用**向量近鄰來填 relevant：用被測系統的輸出當答案，就是規劃裡說的自證。
// 向量近鄰只用來擴大**候選池**（_pool），讓人工判定看得到更多可能漏掉的正樣本。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { loadFixture, groupByVariant } = require('../lib/fixtures');
const { buildPool, likeKeywords } = require('../lib/pooling');
const { rankLike, candidates } = require('../lib/ranker');
const { loadEmbeddings } = require('../lib/embeddings');
const { tokenizerSource } = require('../lib/tokenize');

/**
 * 序列化：物件照常展開，但「元素全是純量」的陣列壓成一行。
 *
 * 為什麼要自己寫：這份檔案是要**人**逐筆看過 40 次的。用 JSON.stringify(…, 2)
 * 會把 relevant:[2] 與候選池攤成一題二十幾行、整份三千多行，
 * 光捲動就足以讓人放棄逐筆判定——而「逐筆人工判定」正是這份 golden 唯一的價值來源。
 *
 * @param {*} value
 * @param {number} [level=0]
 * @returns {string}
 */
function stringifyCompact(value, level = 0) {
    const pad = '  '.repeat(level);
    const padIn = '  '.repeat(level + 1);
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        if (value.every(v => v === null || typeof v !== 'object')) {
            return `[${value.map(v => JSON.stringify(v)).join(', ')}]`;
        }
        return `[\n${value.map(v => padIn + stringifyCompact(v, level + 1)).join(',\n')}\n${pad}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        return `{\n${keys.map(k => `${padIn}${JSON.stringify(k)}: ${stringifyCompact(value[k], level + 1)}`).join(',\n')}\n${pad}}`;
    }
    return JSON.stringify(value);
}

function parseArgs(argv) {
    const out = { out: path.resolve(__dirname, '..', 'golden', 'retrieval.json') };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    }
    return out;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const fx = loadFixture();
    const groups = groupByVariant(fx.questions);
    const emb = loadEmbeddings({ questions: fx.questions, optional: true });

    // 向量近鄰：有錄過向量才有這一路來源；沒有就少一路，候選池小一點但不報錯。
    const vectorNeighbours = emb.available
        ? (id) => {
            const src = fx.byId.get(id);
            const cands = candidates({ source: src, questions: fx.questions, scope: 'subject' });
            const qv = emb.vectorOf(src);
            if (!qv) return [];
            return cands
                .map(q => ({ id: q.id, v: emb.vectorOf(q) }))
                .filter(r => r.v)
                .map(r => ({ id: r.id, s: r.v.reduce((acc, x, i) => acc + x * qv[i], 0) }))
                .sort((a, b) => b.s - a.s || a.id - b.id)
                .map(r => r.id);
        }
        : null;

    const keywordHits = (id) => {
        const src = fx.byId.get(id);
        const cands = candidates({ source: src, questions: fx.questions, scope: 'subject' });
        return rankLike(src, cands).map(r => r.id);
    };

    const entries = [];
    let seq = 0;
    for (const q of fx.questions) {
        if (!q.variant_group) continue;                    // 只有「換數字的同一題」家族成員當 query
        const siblings = (groups.get(q.variant_group) || []).filter(id => id !== q.id);
        if (siblings.length === 0) continue;

        // 硬負樣本 1：跨章字面相近組（向量內積 ↔ 空間向量內積）
        const negatives = new Set();
        if (q.lookalike_of) {
            for (const id of groups.get(q.lookalike_of) || []) negatives.add(id);
            for (const other of fx.questions) {
                if (other.role === 'lookalike' && other.lookalike_of === q.variant_group) negatives.add(other.id);
            }
        }
        // 硬負樣本 2：同章不同概念的干擾題（最多 2 個，取 id 最小的以求可重現）
        fx.questions
            .filter(o => o.id !== q.id && o.subject === q.subject && o.chapter === q.chapter && o.role === 'distractor')
            .sort((a, b) => a.id - b.id)
            .slice(0, 2)
            .forEach(o => negatives.add(o.id));

        siblings.forEach(id => negatives.delete(id));
        negatives.delete(q.id);

        const pool = buildPool({ query: q, questions: fx.questions, vectorNeighbours, keywordHits });

        seq++;
        entries.push({
            id: `R${String(seq).padStart(3, '0')}`,
            query: { kind: 'question_id', value: q.id },
            relevant: siblings,
            hard_negatives: [...negatives].sort((a, b) => a - b),
            needs_human_confirm: true,
            _suggestion: {
                basis: `relevant = variant_group「${q.variant_group}」的其他成員；hard_negatives = ${q.lookalike_of ? `跨章對照組「${q.lookalike_of}」+ ` : ''}同章干擾題`,
                like_keywords: likeKeywords(q),
                // 候選池壓成「id ← 來源」的字串：人工判定時要看的是「有哪些候選、
                // 從哪一路進來的」，不需要每一筆都攤成一個物件
                pool: pool.map(p => `${p.id} ← ${p.sources.join('+')}`)
            }
        });
    }

    const doc = {
        _notice: '檢索 golden（公開層）。query 與候選皆為 eval/fixtures/questions.public.json 的自製題，不含任何真實考卷內容。',
        _status: 'needs_human_confirm — 由 eval/tools/suggest_golden.js 依 fixture 的結構標註產生建議，須由開發者本人逐筆判定後把每筆的 needs_human_confirm 改為 false 才算定稿。',
        _schema: '{ id, query: { kind: "question_id", value }, relevant: [qid…], hard_negatives: [qid…] }；_ 開頭的鍵是標註輔助資訊，loader 會忽略。',
        _how_pool_was_built: `候選池 = 向量近鄰前 20 ∪ 關鍵字前 10 ∪ 同章隨機 5（規劃 §5.3.2）。本次向量來源：${emb.available ? emb.file : '（尚未錄製，此次候選池缺向量那一路）'}；分詞器：${tokenizerSource()}。`,
        version: 1,
        entries
    };

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, stringifyCompact(doc) + '\n', 'utf8');
    console.log(`已寫出 ${entries.length} 筆建議 → ${args.out}`);
    console.log(`   全部標記 needs_human_confirm，請逐筆核對後再定稿。`);
}

if (require.main === module) main();
module.exports = { main };
