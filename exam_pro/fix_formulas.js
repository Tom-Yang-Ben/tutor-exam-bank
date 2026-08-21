// 題庫公式自動修正 v2（預設唯讀預覽；--apply 才寫入）
// 只有「修復後可證明乾淨」的題目才會被自動更新；無法安全修復者列為人工處理，不寫入。
require('dotenv').config();
const fs = require('fs');
const path = require('path');
// 連線一律走 config/db.js，不自建連線（docs/interfaces.md 第 8 條）
const { pool } = require('./config/db');

const APPLY = process.argv.includes('--apply');

// 已知毀損字串的精準修正
const SPECIAL = [
    { find: '$\\frac{T}{2}$^{[SUPER:R|3}]=K', replace: '$\\frac{T^2}{R^3}=K$' }
];

const GREEK = '(pi|theta|alpha|beta|gamma|delta|omega|lambda|nu|sigma|phi|varphi|rho|tau|varepsilon|epsilon|psi|chi|mu)';
const UNICODE = { '×': '\\times', '÷': '\\div', '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '±': '\\pm', '≈': '\\approx' };

function transform(text) {
    if (text == null) return text;
    let s = String(text);

    // 0. 精準修正
    for (const sp of SPECIAL) if (s.includes(sp.find)) s = s.split(sp.find).join(sp.replace);

    // 1. 還原舊轉換器殘留標記
    s = s.replace(/\[FRAC:([^|\]]*)\|([^\]]*)\]/g, '\\frac{$1}{$2}');
    s = s.replace(/\[SUPER:([^|\]]*)\|([^\]]*)\]/g, '$1^{$2}');
    s = s.replace(/\[SUB:([^|\]]*)\|([^\]]*)\]/g, '$1_{$2}');
    s = s.replace(/\[SQRT:([^\]}]*)[}\]]/g, '\\sqrt{$1}');

    // 2. 錯位的 $：上/下標被擠到 $ 外  →  $X$^{n}  變回  $X^{n}$
    s = s.replace(/\$(\^\{[^{}]*\})/g, '$1$');
    s = s.replace(/\$(_\{[^{}]*\})/g, '$1$');
    // 3. 結束 $ 落在右大括號之前  →  ...$}  變回  ...}$（可能連續多個）
    for (let k = 0; k < 5; k++) s = s.replace(/\$\}/g, '}$');

    // 4. 只處理 $...$ 以外的片段
    const parts = s.split(/(\$[^$]*\$)/);
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) continue;
        let seg = parts[i];
        seg = seg.replace(/[×÷≤≥≠±≈]/g, (m) => '$' + UNICODE[m] + '$');
        // 裸希臘字母 → $...$（但若其後緊接 ^ 或 _，視為某式的底，留給轉換器自動處理，不包）
        const reGreek = new RegExp('\\\\' + GREEK + '\\b(?!\\s*[\\^_])(\\s*\\/\\s*\\d+)?', 'g');
        seg = seg.replace(reGreek, (m, g, frac) => {
            let inner = '\\' + g;
            if (frac) inner += frac.replace(/\s+/g, '');
            return '$' + inner + '$';
        });
        parts[i] = seg;
    }
    return parts.join('');
}

// 判斷修復後是否「可證明乾淨」
function isClean(text) {
    if (text == null) return true;
    const s = String(text);
    if (/\[(FRAC|SUPER|SUB|SQRT):/.test(s)) return false;          // 還有殘留標記
    if (/(^|[^\\A-Za-z])(frac|sqrt)(?![A-Za-z])/.test(s)) return false; // 裸寫 frac/sqrt
    if (/(^|[^A-Za-z\\])ell(?![A-Za-z])/.test(s)) return false;     // 裸寫 ell
    if (/\$\^|\$_|\$\}/.test(s)) return false;                      // 仍有錯位 $
    if (((s.match(/\$/g) || []).length) % 2 !== 0) return false;    // $ 不成對
    // 每個 $...$ 區段大括號需平衡
    const spans = s.split(/(\$[^$]*\$)/);
    for (let i = 1; i < spans.length; i += 2) {
        const inner = spans[i].slice(1, -1);
        if ((inner.match(/\{/g) || []).length !== (inner.match(/\}/g) || []).length) return false;
    }
    return true;
}

function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function main() {
    const conn = await pool.connect();
    // 已封存（軟刪除）的題目不修：它們不會再出現在題庫與組卷候選中
    const { rows } = await conn.query('SELECT id, subject, chapter, question_text, answer_text FROM questions WHERE archived_at IS NULL ORDER BY id');

    const autoFix = [];   // 可安全自動修復
    const manual = [];    // 需人工處理
    for (const q of rows) {
        const nq = transform(q.question_text);
        const na = transform(q.answer_text);
        if (nq === q.question_text && na === q.answer_text) continue; // 無變更
        const ok = isClean(nq) && isClean(na);
        const rec = { id: q.id, subject: q.subject, chapter: q.chapter, oldQ: q.question_text, newQ: nq, oldA: q.answer_text, newA: na };
        (ok ? autoFix : manual).push(rec);
    }
    // 也把「有變更但變更後仍不乾淨」之外、原本就含殘留標記卻無法觸發變更的，一併找出（保險）
    for (const q of rows) {
        const dirty = !isClean(q.question_text) || !isClean(q.answer_text);
        const inAuto = autoFix.find(r => r.id === q.id);
        const inMan = manual.find(r => r.id === q.id);
        if (dirty && !inAuto && !inMan) {
            manual.push({ id: q.id, subject: q.subject, chapter: q.chapter, oldQ: q.question_text, newQ: transform(q.question_text), oldA: q.answer_text, newA: transform(q.answer_text) });
        }
    }
    autoFix.sort((a, b) => a.id - b.id); manual.sort((a, b) => a.id - b.id);

    console.log('總題數 ' + rows.length + ' ｜ 可自動修復 ' + autoFix.length + ' ｜ 需人工 ' + manual.length + (APPLY ? '（套用模式）' : '（預覽）'));

    if (!APPLY) {
        let h = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="utf-8"><title>公式修正預覽v2</title><style>
body{font-family:"Noto Sans TC",sans-serif;max-width:1100px;margin:30px auto;padding:0 16px;color:#1e293b}
h1{font-size:22px}h2{font-size:18px;margin-top:26px}.sum{background:#f1f5f9;border-radius:12px;padding:16px 20px;margin:16px 0}
.item{border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin:12px 0}.id{font-weight:700;color:#2563eb}.lbl{font-size:12px;color:#64748b;margin-top:6px}
.old{background:#fef2f2;border-left:3px solid #dc2626;padding:6px 10px;border-radius:4px;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:13px}
.new{background:#f0fdf4;border-left:3px solid #16a34a;padding:6px 10px;border-radius:4px;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:13px;margin-top:4px}
.man{background:#fffbeb;border-left:3px solid #d97706;padding:6px 10px;border-radius:4px;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:13px}</style></head><body>`;
        h += `<h1>🔧 公式修正預覽（尚未寫入資料庫）</h1><div class="sum">產生時間：${new Date().toLocaleString('zh-TW')}<br>總題數 <b>${rows.length}</b>｜將自動修復 <b>${autoFix.length}</b> 題｜需人工處理 <b>${manual.length}</b> 題<br>套用時只會更新「自動修復」區，人工區一律不動。</div>`;
        h += `<h2>✅ 將自動修復（${autoFix.length}）</h2>`;
        for (const c of autoFix) {
            h += `<div class="item"><div><span class="id">ID ${c.id}</span> ｜ ${esc(c.subject)} / ${esc(c.chapter)}</div>`;
            if (c.oldQ !== c.newQ) h += `<div class="lbl">題目 改前：</div><div class="old">${esc(c.oldQ)}</div><div class="lbl">改後：</div><div class="new">${esc(c.newQ)}</div>`;
            if (c.oldA !== c.newA) h += `<div class="lbl">答案 改前：</div><div class="old">${esc(c.oldA)}</div><div class="lbl">改後：</div><div class="new">${esc(c.newA)}</div>`;
            h += `</div>`;
        }
        h += `<h2>⚠️ 需人工處理（${manual.length}）— 損壞過深，自動修復可能出錯，故不動</h2>`;
        for (const c of manual) {
            h += `<div class="item"><div><span class="id">ID ${c.id}</span> ｜ ${esc(c.subject)} / ${esc(c.chapter)}</div>`;
            h += `<div class="lbl">題目（原始，未修改）：</div><div class="man">${esc(c.oldQ)}</div>`;
            if (c.oldA && !isClean(c.oldA)) h += `<div class="lbl">答案（原始，未修改）：</div><div class="man">${esc(c.oldA)}</div>`;
            h += `</div>`;
        }
        fs.writeFileSync(path.join(__dirname, '公式修正預覽.html'), h, 'utf8');
        console.log('已輸出：公式修正預覽.html（未寫入）');
    } else {
        const backup = autoFix.map(c => ({ id: c.id, question_text: c.oldQ, answer_text: c.oldA }));
        const bk = path.join(__dirname, 'formulas_backup_' + Date.now() + '.json');
        fs.writeFileSync(bk, JSON.stringify(backup, null, 2), 'utf8');
        console.log('已備份：' + path.basename(bk));
        try {
            await conn.query('BEGIN');
            for (const c of autoFix) await conn.query('UPDATE questions SET question_text=$1, answer_text=$2 WHERE id=$3', [c.newQ, c.newA, c.id]);
            await conn.query('COMMIT');
            console.log('✅ 已更新 ' + autoFix.length + ' 題；另有 ' + manual.length + ' 題需人工處理（未更動）。');
        } catch (e) {
            try { await conn.query('ROLLBACK'); } catch (_) { /* 回滾失敗不覆蓋原始錯誤 */ }
            console.error('失敗已回滾：' + e.message);
            process.exitCode = 1;
        }
    }
    conn.release();
    await pool.end();
}

if (require.main === module) main().catch(e => { console.error('執行失敗：', e.message); process.exit(1); });
module.exports = { transform, isClean };
