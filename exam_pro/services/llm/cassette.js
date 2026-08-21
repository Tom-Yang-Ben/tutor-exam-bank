// services/llm/cassette.js — cassette 的鍵、路徑與檔案格式（docs/interfaces-stage2.md 第 5.2 條）
//
// 鍵（逐字凍結）：
//     key = sha256( agent + '\n' + modelId + '\n' + promptTemplateHash + '\n' + schemaHash + '\n'
//                 + JSON.stringify(cacheKeyParts) )
//   - modelId 是**去掉 vendor 前綴**的裸 ID（gemini-3.5-flash）
//   - promptTemplateHash = sha256(模板原文)，見 services/llm/templates.js
//   - schemaHash = sha256(JSON.stringify(schema))——章節白名單改了 cassette 就該失效，這是刻意的
//   - cacheKeyParts 由 agent 傳，逐節點的最小集合見第 5.2 條
//
// ⚠ JSON.stringify 依「插入順序」序列化，所以 agent 每次都要以**相同的鍵順序**組
//   cacheKeyParts（本檔不排序，因為第 5.2 條的公式凍結為 JSON.stringify 原樣）。
//
// 檔案：<EVAL_CASSETTE_DIR>/<agent>/<key>.json，預設 EVAL_CASSETTE_DIR=eval/cassettes。
// request 只存**摘要**（字數 + sha256），不存 PDF base64、不存試題全文——NOTICE 第 4 條。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { templateHash, sha256Hex } = require('./templates');

const DEFAULT_DIR = path.resolve(__dirname, '..', '..', 'eval', 'cassettes');

/** cassette 根目錄（EVAL_CASSETTE_DIR 可覆寫；相對路徑以 exam_pro/ 為基準） */
function cassetteDir() {
    const raw = process.env.EVAL_CASSETTE_DIR;
    if (!raw || !String(raw).trim()) return DEFAULT_DIR;
    // 路徑可能含中文（期中專案-wsB），一律 path.resolve 成絕對路徑再用
    return path.resolve(__dirname, '..', '..', String(raw).trim());
}

/**
 * 算 cassette 鍵。
 * @param {{agent:string, modelId:string, template?:string, schema?:object, cacheKeyParts?:object}} opts
 * @returns {string} sha256 hex
 */
function cassetteKey({ agent, modelId, template, schema, cacheKeyParts }) {
    if (!agent || !String(agent).trim()) {
        throw new Error('cassette：record／replay 模式下 generateJson 的 agent 是必填（第 5.1 條）。');
    }
    const schemaHash = sha256Hex(schema ? JSON.stringify(schema) : '');
    const parts = [
        String(agent),
        String(modelId || ''),
        templateHash(template),
        schemaHash,
        JSON.stringify(cacheKeyParts ?? {})
    ].join('\n');
    return sha256Hex(parts);
}

/** <dir>/<agent>/<key>.json 的絕對路徑 */
function cassettePath(agent, key) {
    return path.join(cassetteDir(), String(agent), `${key}.json`);
}

/**
 * 公開 fixture 題庫的雜湊，寫進 meta.fixtureHash。
 * few-shot 的內容變了但 id 沒變時，鍵不會變（第 5.2 條刻意如此），
 * 靠這個欄位在回放時印 warning 提醒「cassette 可能過期」。
 * @returns {string|null} 找不到 fixture 檔時回 null（不是錯誤：不是每個 agent 都用 fixture）
 */
function fixtureHash() {
    const file = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'questions.public.json');
    try {
        return sha256Hex(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return null;
    }
}

/**
 * 把 parts 壓成不含內容的摘要。
 * text → {kind:'text', chars, sha256}；PDF → {kind:'pdf', bytes, sha256}（sha256 算在 base64 解碼後的原始位元組上）
 */
function summarizeParts(parts) {
    return (parts || []).map((p) => {
        if (p.text !== undefined) {
            const text = String(p.text);
            return { kind: 'text', chars: text.length, sha256: sha256Hex(text) };
        }
        if (p.pdfBase64 !== undefined) {
            const buf = Buffer.from(String(p.pdfBase64), 'base64');
            return { kind: 'pdf', bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
        }
        if (p.fileUri !== undefined) return { kind: 'fileUri', uri: String(p.fileUri) };
        return { kind: 'unknown' };
    });
}

/**
 * 讀一支 cassette。
 * @returns {object|null} 檔案不存在回 null；格式壞掉丟錯（壞檔要修，不能當成 miss 靜默重錄）
 */
function readCassette(agent, key) {
    const file = cassettePath(agent, key);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`cassette 格式錯誤（不是合法 JSON）：${file}\n${err.message}`);
    }
}

/**
 * 寫一支 cassette（record 模式）。已存在同鍵檔案時覆寫並回傳 { file, overwritten }。
 * 一律由 Node 寫檔、UTF-8、結尾一個換行（PowerShell 的 > 會寫成 UTF-16LE + BOM）。
 */
function writeCassette({ agent, key, meta, request, response }) {
    const file = cassettePath(agent, key);
    const overwritten = fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { meta, request, response };
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    return { file, overwritten };
}

module.exports = {
    cassetteKey, cassettePath, cassetteDir, readCassette, writeCassette,
    summarizeParts, fixtureHash, sha256Hex
};
