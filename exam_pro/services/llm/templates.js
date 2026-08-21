// services/llm/templates.js — prompt 模板註冊表（cassette 鍵的 promptTemplateHash 來源）
//
// 為什麼需要這一支（見 docs/questions2-wsB.md Q1）：
//   interfaces-stage2.md 第 5.2 條把 cassette 的鍵定義成
//       sha256(agent + '\n' + modelId + '\n' + promptTemplateHash + '\n' + schemaHash + '\n' + …)
//   其中「promptTemplateHash = sha256(模板原文)；模板＝把可變欄位挖空後的字串，由 agent 提供」，
//   但 generateJson 的簽名（同條）只有一個 `template` 欄位，而且註明是「模板的識別名」。
//   識別名進不了雜湊、原文又沒有欄位可以傳——**簽名裡少一條路**。
//
// 在不動凍結簽名的前提下的解法：agent 在模組載入時把「識別名 → 模板原文」註冊進來，
// services/llm 依 `template` 識別名回查原文再雜湊。效果與「原文直接傳進來」完全相同：
// 模板文字改一個字，cassette 就失效（這正是第 5.2 條要的）。
//
// 沒註冊的識別名（例如 WS-C 的 lint／verify 還沒接上來）：退回 sha256(識別名) 並印一次警告。
// 那條路的語意較弱——模板改了但識別名沒改，cassette 不會自動失效——所以要靠識別名帶版號
// （`lint.v1` → `lint.v2`）。有註冊就沒有這個問題。

const crypto = require('crypto');

/** @type {Map<string, string>} 識別名 → 模板原文 */
const templates = new Map();
/** 同一個識別名只警告一次，不然每題都印一行 */
const warned = new Set();

/**
 * 註冊一份 prompt 模板。同一個識別名重複註冊不同內容時丟錯——
 * 那代表兩個 agent 撞名，鍵會互相汙染。
 * @param {string} name  識別名，慣例是 `<agent>.v<n>`（例：'extract.v1'）
 * @param {string} text  模板原文（可變欄位挖空後的字串）
 * @returns {string} name
 */
function registerTemplate(name, text) {
    const key = String(name || '').trim();
    if (!key) throw new Error('registerTemplate：模板識別名不可為空。');
    const body = String(text ?? '');
    const existing = templates.get(key);
    if (existing !== undefined && existing !== body) {
        throw new Error(`registerTemplate：識別名「${key}」已被註冊成不同內容（兩個 agent 撞名會讓 cassette 互相汙染）。`);
    }
    templates.set(key, body);
    return key;
}

/**
 * 取得模板的雜湊。
 * @param {string} name 識別名；沒給就當空字串（舊呼叫端沒有 template 也不該炸）
 * @returns {string} sha256 hex
 */
function templateHash(name) {
    const key = String(name || '');
    if (templates.has(key)) return sha256Hex(templates.get(key));
    if (key && !warned.has(key)) {
        warned.add(key);
        console.warn(`[llm] 模板「${key}」沒有註冊原文，改以識別名雜湊；模板改寫時請自行把識別名的版號 +1（services/llm/templates.js）。`);
    }
    return sha256Hex(key);
}

function sha256Hex(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 測試用：清空註冊表 */
function _resetForTest() {
    templates.clear();
    warned.clear();
}

module.exports = { registerTemplate, templateHash, sha256Hex, _resetForTest };
