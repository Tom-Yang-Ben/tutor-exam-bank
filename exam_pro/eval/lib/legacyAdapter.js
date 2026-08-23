// ─────────────────────────────────────────────────────────────
// eval/lib/legacyAdapter.js — 解析「舊流程」的進入點（E-X12a）
//
// 規劃 §5.3.5：「--method legacy（保留 aiService.js 為 services/legacy/analyzePdf.js）
//                零相依，第 1 天就能跑出基準線」。
//
// 問題在於：WS-B 的 A-T8 會把 `aiService.analyzePdfContent` 改成新 extract agent 的**相容包裝**。
// 那一刻起，`--method legacy` 若還是直接呼叫 aiService，量到的就會是**新管線**，
// 卻在報表上標成 legacy——這是整份對照實驗最容易發生、也最難發現的錯誤：
// 兩欄數字會神奇地一模一樣，而沒有任何東西會報錯。
//
// 因此本檔做三件事：
//   1. 依序找 services/legacy/analyzePdf.js → services/aiService.js，並**把實際用了哪一支記進報表**。
//   2. 退回 aiService 時，檢查它裡面還在不在「手抄的章節白名單」這個 legacy 指紋
//      （aiService.js:14-27，A-T8 會刪掉它）。指紋不見了就**大聲警告**，
//      因為那代表 aiService 已經是新包裝。
//   3. 算 prompt_hash：只雜湊原始碼裡的長樣板字串（＝ prompt 本體），
//      不雜湊整個檔案——這樣「改了 prompt」與「改了周邊程式」在報表上分得開。
//
// 裁決 S2-19：`services/legacy/analyzePdf.js` 由 **WS-B** 從 A-T8 之前的 `aiService.js` 快照建立
//    （`git show e1740ca:exam_pro/services/aiService.js`），歸 WS-B（第 10.1 條）。
//    **指紋檢查照樣保留**：快照萬一取錯版本、或日後有人「順手」把它改成呼叫新 agent，
//    這裡的警告是唯一會出聲的地方。檢查成本是一次 `String.includes`。
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

const CANDIDATES = [
    { rel: 'services/legacy/analyzePdf.js', kind: 'snapshot' },
    { rel: 'services/aiService.js', kind: 'aiService' }
];

// A-T8 會刪掉 aiService.js:14-27 手抄的那份白名單，改由 config/chapters.js 產生。
// 這一行字串在不在，就是「這支還是不是舊版」最直接的指紋。
const LEGACY_FINGERPRINT = '【數學科精細章節白名單】';

/**
 * 從原始碼抽出 prompt 本體並雜湊。
 * @param {string} source
 * @returns {{hash:string, basis:'template-literals'|'whole-file', chars:number}}
 */
function promptHash(source) {
    // 長度 > 200 的樣板字串＝ prompt；短的多半是錯誤訊息或路徑組字。
    const literals = (source.match(/`[\s\S]*?`/g) || []).filter(s => s.length > 200);
    if (literals.length > 0) {
        const joined = literals.join('\n');
        return {
            hash: crypto.createHash('sha256').update(joined, 'utf8').digest('hex'),
            basis: 'template-literals',
            chars: joined.length
        };
    }
    return {
        hash: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
        basis: 'whole-file',
        chars: source.length
    };
}

/**
 * 解析 legacy 進入點。
 * @returns {{
 *   analyzePdfContent: (pdfBase64:string) => Promise<Array<object>>,
 *   file: string, rel: string, kind: 'snapshot'|'aiService',
 *   promptHash: string, promptBasis: string, promptChars: number,
 *   model: string|null, warnings: string[]
 * }}
 * @throws 兩支都找不到時
 */
function resolveLegacy() {
    const warnings = [];
    for (const c of CANDIDATES) {
        const abs = path.resolve(ROOT, c.rel);
        if (!fs.existsSync(abs)) continue;

        const source = fs.readFileSync(abs, 'utf8');
        const mod = require(abs);
        const fn = mod.analyzePdfContent;
        if (typeof fn !== 'function') {
            warnings.push(`${c.rel} 存在但沒有匯出 analyzePdfContent，跳過。`);
            continue;
        }

        if (c.kind === 'aiService' && !source.includes(LEGACY_FINGERPRINT)) {
            warnings.push(
                '⚠️ 退回用 services/aiService.js 當 legacy，但它裡面已經找不到手抄的章節白名單' +
                `（指紋「${LEGACY_FINGERPRINT}」）。這通常代表 A-T8 已經把它換成新 extract agent 的相容包裝——` +
                '也就是說 --method legacy 這一欄量到的很可能是**新管線**。' +
                '請先把舊版快照留成 services/legacy/analyzePdf.js 再跑基準線。'
            );
        }
        if (c.kind === 'aiService') {
            warnings.push('legacy 進入點用的是 services/aiService.js（services/legacy/analyzePdf.js 尚未建立）。');
        }

        // 舊流程的模型 ID 是寫死在原始碼裡的（aiService.js:6），不是環境變數——
        // 這本身就是 E-X12a 要呈現的差異之一，所以從原始碼撈出來記進報表。
        const modelMatch = source.match(/model:\s*['"]([^'"]+)['"]/);
        const ph = promptHash(source);

        return {
            analyzePdfContent: fn,
            file: abs,
            rel: c.rel,
            kind: c.kind,
            promptHash: ph.hash,
            promptBasis: ph.basis,
            promptChars: ph.chars,
            model: modelMatch ? modelMatch[1] : null,
            warnings
        };
    }

    throw new Error(
        '找不到 legacy 進入點。找過：\n  - ' + CANDIDATES.map(c => c.rel).join('\n  - ') + '\n' +
        '至少要有一支匯出 analyzePdfContent(pdfBase64) → Promise<Array>。'
    );
}

module.exports = { resolveLegacy, promptHash, CANDIDATES, LEGACY_FINGERPRINT };
