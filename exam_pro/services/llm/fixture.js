// services/llm/fixture.js — 離線用的 embedding 供應者（docs/interfaces.md 第 4 條）
//
// 以 sha256(embed_text)（hex 小寫）查 eval/fixtures/embeddings.<model>.<dim>.json。
// 查不到就丟錯並提示「請在本機執行 npm run eval:record」——**不得靜默回退成假向量**：
// 假向量會讓 eval 量到一個不存在的系統，紅燈變成噪音。
//
// 檔案格式凍結為：{ "<sha256>": [ … dim 個小數 6 位的數字 … ], … }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** sha256(text) 的十六進位小寫，與 questions.embed_hash 同一套規則 */
function sha256Hex(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** eval/fixtures/embeddings.<model>.<dim>.json 的絕對路徑（EMBED_FIXTURE_DIR 可覆寫） */
function fixturePath(model, dim) {
    const dir = process.env.EMBED_FIXTURE_DIR
        ? path.resolve(process.env.EMBED_FIXTURE_DIR)
        : path.resolve(__dirname, '..', '..', 'eval', 'fixtures');
    return path.join(dir, `embeddings.${model}.${dim}.json`);
}

// 同一支檔案在一次程序生命週期內只讀一次（eval 會連續查上百次）
const cache = new Map();   // 絕對路徑 -> { mtimeMs, table }

function loadTable(file) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (e) {
        throw new Error(`找不到 embedding fixture：${file}\n請在本機執行 npm run eval:record 產生它（CI 只讀這個檔，不會呼叫 Gemini）。`);
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.table;

    let table;
    try {
        table = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`embedding fixture 格式錯誤（應為 {"<sha256>": [數字…]}）：${file}\n${e.message}`);
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, table });
    return table;
}

/**
 * 依 texts 逐筆查表。
 * @returns {{vectors:number[][], usage:{tokenIn:number}}}  vectors[i] 對應 texts[i]
 */
function embedFromFixture({ model, texts, dim }) {
    const file = fixturePath(model, dim);
    const table = loadTable(file);

    const vectors = texts.map((text) => {
        const key = sha256Hex(text);
        const vec = table[key];
        if (!vec) {
            throw new Error(
                `embedding fixture 查無此文本（sha256=${key}）：${file}\n` +
                `請在本機執行 npm run eval:record 重新錄製。**不會**用假向量代替。\n` +
                `文本開頭：${String(text).slice(0, 60)}`
            );
        }
        if (!Array.isArray(vec) || vec.length !== dim) {
            throw new Error(`embedding fixture 維度不符：sha256=${key} 有 ${Array.isArray(vec) ? vec.length : '非陣列'} 維，期望 ${dim} 維（${file}）。`);
        }
        return vec.slice();
    });

    return { vectors, usage: { tokenIn: 0 } };   // fixture 不產生任何費用
}

/**
 * 錄製模式用：把新的向量併回 fixture 檔（小數 6 位，鍵依字典序排序，方便 diff）。
 * 只在 EMBED_MODE=record 時被呼叫，CI 不會走到。
 */
function saveToFixture({ model, dim, entries }) {
    const file = fixturePath(model, dim);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    let table = {};
    if (fs.existsSync(file)) {
        try { table = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { table = {}; }
    }
    for (const [key, vec] of entries) {
        table[key] = vec.map(v => Number(v.toFixed(6)));
    }

    const sorted = {};
    for (const key of Object.keys(table).sort()) sorted[key] = table[key];
    // 一律由 Node 寫檔（PowerShell 的 > 會寫 BOM）；結尾留一個換行讓 diff 乾淨
    fs.writeFileSync(file, JSON.stringify(sorted, null, 0) + '\n', 'utf8');
    cache.delete(file);
    return file;
}

module.exports = { embedFromFixture, saveToFixture, fixturePath, sha256Hex };
