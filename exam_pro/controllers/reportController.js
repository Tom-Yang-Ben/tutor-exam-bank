// ─────────────────────────────────────────────────────────────
// controllers/reportController.js — 學習報告（〔dec/r16-remedial〕；docs/student-report.md）
//
//   GET /api/students/:id/report?days=&audience=teacher|parent&format=json|html|docx
//
// 掛在 FEATURE_STUDENTS 之後（學生分頁的一部分；關閉時落到 Express 預設 404）。只讀、不呼叫 LLM、不寫庫。
// 重練成效只在 FEATURE_RETRAIN 開啟時列、補救成效只在 FEATURE_REMEDIAL 開啟時列（關閉時那一節是 null，不出現）。
// 慣例同 studentController：:id 不是正整數或學生不存在 → 404；查詢參數不合法 → 400。log 不含學生姓名。
// ─────────────────────────────────────────────────────────────
const { query } = require('../config/db');
const features = require('../config/features');
const report = require('../services/studentReportService');
const { _internals: studentInternals } = require('./studentController');

const { parseId, weaknessMinN } = studentInternals;
const STUDENT_NOT_FOUND = '找不到該學生';

/**
 * 查詢參數（純函式）：days 1~365（預設 30）、audience teacher|parent（預設 teacher）、format json|html|docx（預設 json）。
 * 同名參數給兩次（陣列）一律 400。
 * @param {object} q req.query
 * @returns {{error:string} | {days:number, audience:string, format:string}}
 */
function parseReportQuery(q) {
    const one = (k) => (q[k] === undefined || q[k] === '' ? undefined : q[k]);
    for (const k of ['days', 'audience', 'format']) if (Array.isArray(q[k])) return { error: `${k} 只能給一次。` };
    let days = report.DEFAULT_DAYS;
    if (one('days') !== undefined) {
        const s = String(q.days).trim();
        days = /^\d+$/.test(s) ? Number(s) : NaN;
        if (!Number.isInteger(days) || days < 1 || days > 365) return { error: 'days 必須是 1~365 的整數。' };
    }
    const audience = one('audience') ?? 'teacher';
    if (!report.AUDIENCES.includes(audience)) return { error: `audience 只接受 ${report.AUDIENCES.join('、')}。` };
    const format = one('format') ?? 'json';
    if (!report.FORMATS.includes(format)) return { error: `format 只接受 ${report.FORMATS.join('、')}。` };
    return { days, audience, format };
}

/** 下載檔名（不含副檔名）。 */
function reportFileName(v) {
    return `學習報告-${v.student.name}(${v.period.from}_${v.period.to})${v.audience === 'parent' ? '（家長版）' : ''}`;
}

exports.getReport = async (req, res, next) => {
    const studentId = parseId(req.params.id);
    if (studentId === null) return res.status(404).json({ message: STUDENT_NOT_FOUND });
    const parsed = parseReportQuery(req.query);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    try {
        const full = await report.loadStudentReport({
            studentId, days: parsed.days, minN: weaknessMinN(),
            retrainOn: features.FEATURE_RETRAIN, remedialOn: features.FEATURE_REMEDIAL
        }, { query });
        if (!full) return res.status(404).json({ message: STUDENT_NOT_FOUND });
        const view = report.forAudience(full, parsed.audience);
        if (parsed.format === 'html') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(200).send(report.renderReportHtml(view));
        }
        if (parsed.format === 'docx') {
            const buf = await require('../services/studentReportDocx').buildReportDocx(view);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(reportFileName(view))}.docx`);
            res.setHeader('Content-Length', buf.length);
            return res.status(200).send(buf);
        }
        res.status(200).json(view);
    } catch (err) {
        next(err);
    }
};

exports._internals = { parseReportQuery, reportFileName };
