// ─────────────────────────────────────────────────────────────
// services/studentReportDocx.js — 學習報告的 Word 匯出（〔dec/r16-remedial〕；docs/student-report.md）
//
// 用與考卷匯出（services/wordService.js 的 generateExamPaperDocx）同一套 docx 套件與排版慣例
// （標題置中、Heading 1 分節、段落與表格）。考卷那一支是專為題目與答案區寫的，報告的內容不是題目，
// 所以另寫這一支，不改考卷匯出的任何一行。內容與 renderReportHtml 一致（同一個 forAudience 的輸出）。
// 不呼叫 LLM；學生姓名只寫進檔案本身（留在本機）。
// ─────────────────────────────────────────────────────────────
'use strict';

const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, Table, TableRow, TableCell, WidthType } = require('docx');
const { STATUS_LABEL } = require('./studentReportService');

const pct = r => (r === null || r === undefined ? '—' : `${Math.round(Number(r) * 100)}%`);

function table(head, body) {
    const row = (cells, bold) => new TableRow({
        children: cells.map(c => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(c ?? ''), bold })] })] }))
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(head, true), ...body.map(b => row(b, false))] });
}

/**
 * 報告 → .docx（Buffer）。
 * @param {object} v studentReportService.forAudience 的輸出
 * @returns {Promise<Buffer>}
 */
async function buildReportDocx(v) {
    const parent = v.audience === 'parent';
    const title = `${parent ? '給家長的學習報告' : '學習報告（老師版）'}－${v.student.name}`;
    const c = [];
    c.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
    c.push(new Paragraph({ text: `期間：${v.period.from} ～ ${v.period.to}（近 ${v.period.days} 天）　產生日期：${v.generated_on}` }));
    const s = v.summary;
    c.push(new Paragraph({ text: parent ? '練習概況' : '批改量', heading: HeadingLevel.HEADING_1 }));
    c.push(new Paragraph({ text: parent
        ? `這段期間寫了 ${s.papers} 份卷，批改完成 ${s.graded} 題，答對率 ${pct(s.correct_rate)}。`
        : `卷 ${s.papers} 份、派題 ${s.assigned} 題、已批改 ${s.graded} 題、答對 ${s.correct}（答對率 ${pct(s.correct_rate)}）。只算每題第一次作答。` }));
    c.push(new Paragraph({ text: parent ? '需要加強的單元' : '最弱的章節', heading: HeadingLevel.HEADING_1 }));
    if (v.weakest_chapters.length === 0) c.push(new Paragraph({ text: '這段期間沒有批改紀錄。' }));
    else c.push(parent
        ? table(['單元', '批改題數', '錯的題數'], v.weakest_chapters.map(x => [x.chapter, x.graded, x.wrong]))
        : table(['章節', '批改', '錯', '錯誤率', '備註'], v.weakest_chapters.map(x => [x.chapter, x.graded, x.wrong, pct(x.wrong_rate), x.low_sample ? '樣本不足' : ''])));
    if (v.error_types.length) {
        c.push(new Paragraph({ text: parent ? '常見的錯誤類型' : '錯因分布', heading: HeadingLevel.HEADING_1 }));
        c.push(parent
            ? table(['類型', '次數'], v.error_types.map(e => [e.label, e.count]))
            : table(['錯因', '代碼', '次數', '占錯題'], v.error_types.map(e => [e.label, e.code, e.count, pct(e.share)])));
    }
    if (v.weekly_trend.length) {
        c.push(new Paragraph({ text: '每週趨勢', heading: HeadingLevel.HEADING_1 }));
        c.push(table(['週（週一）', '批改', '答對率'], v.weekly_trend.map(w => [w.week_start, w.graded, pct(w.correct_rate)])));
    }
    if (v.retrain) {
        c.push(new Paragraph({ text: parent ? '錯題再練習' : '錯題重練', heading: HeadingLevel.HEADING_1 }));
        c.push(new Paragraph({ text: parent
            ? `正在反覆練習的錯題 ${v.retrain.practicing} 題，已經練會 ${v.retrain.mastered} 題。`
            : `進行中 ${v.retrain.active} 題、練到會 ${v.retrain.mastered} 題、卡關 ${v.retrain.stuck} 題、到期 ${v.retrain.due_now} 題；重練答對率 ${pct(v.retrain.first_retrain?.rate)}、隔週回測答對率 ${pct(v.retrain.spaced?.rate)}。` }));
    }
    if (v.remedial_effect && v.remedial_effect.units.length) {
        c.push(new Paragraph({ text: parent ? '加強練習的成果' : '補救成效', heading: HeadingLevel.HEADING_1 }));
        c.push(parent
            ? table(['單元', '結果'], v.remedial_effect.units.map(u => [u.name, u.result]))
            : table(['單位', '狀態', '補救前', '之後', '之後批改'], v.remedial_effect.units.map(u => [u.name, STATUS_LABEL[u.status] || u.status, pct(u.before_rate), pct(u.after_rate), `${u.after_graded}${u.low_sample ? '（樣本少）' : ''}`])));
    }
    c.push(new Paragraph({ text: parent ? '接下來的安排' : '建議', heading: HeadingLevel.HEADING_1 }));
    if (v.suggestions.length === 0) c.push(new Paragraph({ text: '目前沒有特別的建議。' }));
    for (const x of v.suggestions) c.push(new Paragraph({ text: `・${x.text}` }));
    const doc = new Document({ sections: [{ children: c }] });
    return Packer.toBuffer(doc);
}

module.exports = { buildReportDocx };
