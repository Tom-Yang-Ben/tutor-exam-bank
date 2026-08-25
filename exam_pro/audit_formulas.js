// 題庫公式健檢腳本（在你本機執行，連 .env 的 DATABASE_URL 指向的 PostgreSQL）
// 用法：在 exam_pro 資料夾內執行  node audit_formulas.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
// 連線一律走 config/db.js，不自建連線（docs/interfaces-stage1.md 第 8 條）
const { query, pool } = require('./config/db');

let buildParagraphComponents = null;
try { ({ buildParagraphComponents } = require('./utils/textFormatter')); } catch (e) { /* 容錯 */ }

const UNICODE_MATH = /[×÷≤≥≠±√∞∑∫∏∂∇αβγδεζηθλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ°·∈∉⊂⊆∪∩→←⇒⇔]/;
const GREEK_OR_CMD = /\\(frac|sqrt|int|sum|prod|lim|vec|hat|bar|times|div|leq|geq|neq|approx|infty|pm|cdot|alpha|beta|gamma|delta|theta|pi|sigma|omega|lambda|mu|phi|sin|cos|tan|log|ln)\b/;

function analyze(text) {
    const issues = [];
    if (text == null || String(text).trim() === '') return issues; // 空字串由呼叫端另外判斷
    const s = String(text);

    // 1. $ 不成對（嚴重）
    const dollarCount = (s.match(/\$/g) || []).length;
    if (dollarCount % 2 !== 0) issues.push({ sev: 'error', msg: '錢號 $ 不成對（公式分隔符未閉合）' });

    // 2. 大括號不對稱（嚴重）
    const open = (s.match(/\{/g) || []).length;
    const close = (s.match(/\}/g) || []).length;
    if (open !== close) issues.push({ sev: 'error', msg: `大括號不對稱（{ 有 ${open} 個、} 有 ${close} 個）` });

    // 3. 斜線當分數（警告）
    if (/(?:\d|[a-zA-Zπ])\s*\/\s*(?:\d|[a-zA-Zπ])/.test(s) && !/https?:\/\//.test(s)) {
        issues.push({ sev: 'warn', msg: '疑似用斜線表示分數（建議改成 \\frac{}{}）' });
    }

    // 4. 含 Unicode 數學符號（警告）
    if (UNICODE_MATH.test(s)) issues.push({ sev: 'warn', msg: '含 Unicode 數學符號（建議改用 LaTeX 指令，如 \\theta、\\leq）' });

    // 5. 有 LaTeX 但沒包 $（提示）
    const hasDollar = dollarCount >= 2;
    if (!hasDollar && (GREEK_OR_CMD.test(s) || /[\^_]/.test(s))) {
        issues.push({ sev: 'info', msg: '含 LaTeX/上下標但未用 $...$ 包覆（仍會自動轉換，建議補上以求精準）' });
    }

    // 6. 實際轉換測試（嚴重）
    if (buildParagraphComponents) {
        try { buildParagraphComponents(s); }
        catch (e) { issues.push({ sev: 'error', msg: '轉換 Word 時發生例外：' + e.message }); }
    }
    return issues;
}

function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function main() {
    // 已封存（軟刪除）的題目不列入健檢：它們不會再出現在題庫與組卷候選中
    const { rows } = await query(
        'SELECT id, subject, chapter, question_type, question_text, answer_text FROM questions WHERE archived_at IS NULL ORDER BY id'
    );

    const flagged = [];
    let errCount = 0, warnCount = 0, infoCount = 0;

    for (const q of rows) {
        const qIssues = analyze(q.question_text).map(x => ({ ...x, field: '題目' }));
        const aIssues = analyze(q.answer_text).map(x => ({ ...x, field: '答案' }));
        if (q.answer_text == null || String(q.answer_text).trim() === '' || String(q.answer_text).trim() === '略') {
            aIssues.push({ sev: 'info', msg: '答案為空或「略」', field: '答案' });
        }
        const all = [...qIssues, ...aIssues];
        if (all.length) {
            flagged.push({ q, all });
            for (const it of all) { if (it.sev === 'error') errCount++; else if (it.sev === 'warn') warnCount++; else infoCount++; }
        }
    }

    // 主控台摘要
    console.log('========== 題庫公式健檢結果 ==========');
    console.log('總題數：' + rows.length);
    console.log('有問題的題目數：' + flagged.length);
    console.log(`嚴重(error)：${errCount}　警告(warn)：${warnCount}　提示(info)：${infoCount}`);
    console.log('=====================================');

    // HTML 報告
    const badge = (sev) => sev === 'error' ? '#dc2626' : (sev === 'warn' ? '#d97706' : '#2563eb');
    const label = (sev) => sev === 'error' ? '嚴重' : (sev === 'warn' ? '警告' : '提示');
    let html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="utf-8"><title>題庫公式健檢報告</title>
<style>body{font-family:"Noto Sans TC",sans-serif;max-width:1000px;margin:30px auto;padding:0 16px;color:#1e293b}
h1{font-size:22px}.sum{background:#f1f5f9;border-radius:12px;padding:16px 20px;margin:16px 0;line-height:1.9}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #e2e8f0;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f8fafc}code{background:#f1f5f9;padding:1px 5px;border-radius:4px;white-space:pre-wrap;word-break:break-all}
.tag{color:#fff;border-radius:6px;padding:1px 8px;font-size:12px;font-weight:700;white-space:nowrap}</style></head><body>`;
    html += `<h1>📐 題庫公式健檢報告</h1>`;
    html += `<div class="sum">產生時間：${new Date().toLocaleString('zh-TW')}<br>總題數：<b>${rows.length}</b>　有問題題目：<b>${flagged.length}</b><br>`;
    html += `<span style="color:#dc2626">嚴重 ${errCount}</span>　<span style="color:#d97706">警告 ${warnCount}</span>　<span style="color:#2563eb">提示 ${infoCount}</span></div>`;

    if (!flagged.length) {
        html += `<p>🎉 太棒了，沒有偵測到任何公式問題！</p>`;
    } else {
        html += `<table><thead><tr><th>ID</th><th>科目/章節</th><th>欄位</th><th>等級</th><th>問題</th><th>內容片段</th></tr></thead><tbody>`;
        for (const f of flagged) {
            for (const it of f.all) {
                const snippet = (it.field === '題目' ? f.q.question_text : f.q.answer_text) || '';
                html += `<tr><td>${f.q.id}</td><td>${esc(f.q.subject)}<br><small>${esc(f.q.chapter)}</small></td>`;
                html += `<td>${it.field}</td><td><span class="tag" style="background:${badge(it.sev)}">${label(it.sev)}</span></td>`;
                html += `<td>${esc(it.msg)}</td><td><code>${esc(String(snippet).slice(0, 160))}</code></td></tr>`;
            }
        }
        html += `</tbody></table>`;
    }
    html += `</body></html>`;

    const outPath = path.join(__dirname, '公式健檢報告.html');
    fs.writeFileSync(outPath, html, 'utf8');
    console.log('已輸出報告：' + outPath);

    await pool.end();
}

if (require.main === module) {
main().catch(e => {
    console.error('健檢失敗：', e.message);
    try { fs.writeFileSync(path.join(__dirname, '公式健檢報告.html'), '<meta charset="utf-8"><h2>健檢失敗</h2><p>' + e.message + '</p>'); } catch (_) {}
    process.exit(1);
});
}
module.exports = { analyze };
