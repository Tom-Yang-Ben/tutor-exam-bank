#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// eval/tools/calibrate_source_check.js — 原卷文字層比對的校準工具（docs/source-check.md 第 4 節）
//
// 用真實原卷 PDF ＋ 題庫裡既有的 job_questions（payload.extract／lint）量 source_check 的
// 召回與誤報。**真實考卷內容不得進 repo**（NOTICE）：本工具只把數字寫到 eval/local/（已 gitignore），
// 題目文字只在加 --show-text 時印到終端機。
//
// 用法：
//   node eval/tools/calibrate_source_check.js --pdf-dir "C:/.../各校考卷"
//        [--out eval/local/source_check.json] [--sweep] [--show-text]
//        [--positives 130,154,161,222,227] [--include-dups]
//        [--no-pua] [--tail-max 160] [--min-coverage 0.8] [--extra-digits]
//
// 資料庫：讀 DATABASE_URL，連線後 SET default_transaction_read_only = on，只下 SELECT。
// 原卷對應：PDF 檔的 sha256 = jobs.pdf_sha256。預設排除 rejected 與 duplicate 的列
// （被判重複的重拆題不是現行入庫路徑；--include-dups 可一併量）。
// 樣卷（eval/fixtures/sample_exam.pdf ＋ extract.v2 cassette）每個設定都會一起跑，
// 用來確認「樣卷 0 誤報」。
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DEFAULTS, locateSegments, compareSegment, describeMismatch, normalizeSourceText } = require('../../utils/sourceCheck');
const { readPagesText } = require('../../services/sourceTextService');

const APP_DIR = path.resolve(__dirname, '..', '..');
const LOCAL_DIR = path.resolve(APP_DIR, 'eval', 'local');
const SAMPLE_PDF = path.resolve(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');
const CASSETTE_DIR = path.resolve(APP_DIR, 'eval', 'cassettes', 'extract');
const DEFAULT_POSITIVES = [130, 154, 161, 222, 227];

function parseArgs(argv) {
    const args = { sweep: false, showText: false, includeDups: false, positives: DEFAULT_POSITIVES, options: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--pdf-dir') args.pdfDir = next();
        else if (a === '--out') args.out = next();
        else if (a === '--sweep') args.sweep = true;
        else if (a === '--show-text') args.showText = true;
        else if (a === '--include-dups') args.includeDups = true;
        else if (a === '--positives') args.positives = next().split(',').map(Number).filter(Number.isInteger);
        else if (a === '--no-pua') args.options.puaMap = false;
        else if (a === '--tail-max') args.options.tailMax = Number(next());
        else if (a === '--min-coverage') args.options.minCoverage = Number(next());
        else if (a === '--extra-digits') args.options.extraDigitsRule = true;
        else throw new Error(`未知的參數 ${a}`);
    }
    return args;
}

/** --out 只允許寫到 eval/local/ 底下（真實原卷的量測結果不進 repo） */
function resolveOut(out) {
    if (!out) return null;
    const abs = path.resolve(APP_DIR, out);
    const rel = path.relative(LOCAL_DIR, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`--out 只能寫到 ${LOCAL_DIR}（收到 ${abs}）`);
    }
    return abs;
}

function walkPdfs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walkPdfs(p);
        return e.name.toLowerCase().endsWith('.pdf') ? [p] : [];
    });
}

async function loadRows(shas, includeDups) {
    const { Client } = require('pg');
    if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query('SET default_transaction_read_only = on');
        const { rows } = await client.query(
            `SELECT q.id AS jq_id, q.job_id, q.idx, q.state, q.review_reason, q.question_id,
                    q.payload->'extract' AS extract, q.payload->'lint'->>'question_text' AS lint_text,
                    j.pdf_sha256
               FROM job_questions q JOIN jobs j ON j.id = q.job_id
              WHERE j.kind = 'pdf' AND j.pdf_sha256 = ANY($1::text[])
                AND ($2::boolean OR (q.state <> 'rejected' AND q.review_reason IS DISTINCT FROM 'duplicate'))
              ORDER BY q.job_id, q.idx`, [shas, includeDups]);
        return rows;
    } finally {
        await client.end();
    }
}

/** 樣卷：extract.v2 cassette 的題目 ＋ 樣卷文字層 */
async function loadSample() {
    const file = fs.readdirSync(CASSETTE_DIR).map(f => path.join(CASSETTE_DIR, f))
        .find(f => JSON.parse(fs.readFileSync(f, 'utf8')).meta?.template === 'extract.v2');
    if (!file) throw new Error('找不到 extract.v2 的 cassette');
    const questions = JSON.parse(fs.readFileSync(file, 'utf8')).response.data.questions;
    const { text } = await readPagesText(fs.readFileSync(SAMPLE_PDF), 1, null);
    return { questions, text };
}

/**
 * 以一組參數跑一遍：每份 PDF 依 page_range 分塊定位、逐題比對。
 * @returns {object} 統計與逐題結果
 */
async function runOnce({ jobs, sample, positives, options }) {
    const stats = { total: 0, checked: 0, match: 0, mismatch: 0, skipped: {}, tp: 0, fp: 0, fn: 0, fnCheckable: 0 };
    const items = [];
    const bump = (k) => { stats.skipped[k] = (stats.skipped[k] || 0) + 1; };

    for (const job of jobs) {
        const byChunk = new Map();
        for (const r of job.rows) {
            const pr = Array.isArray(r.extract?.page_range) ? r.extract.page_range : [1, null];
            const key = `${pr[0]}-${pr[1]}`;
            if (!byChunk.has(key)) byChunk.set(key, { pr, rows: [] });
            byChunk.get(key).rows.push(r);
        }
        for (const { pr, rows } of byChunk.values()) {
            const text = job.textFor(pr[0], pr[1]);
            const located = locateSegments(rows.map(r => r.extract || {}), text, options);
            rows.forEach((r, i) => {
                stats.total += 1;
                const loc = located[i];
                const isPositive = positives.includes(Number(r.question_id));
                let verdict = 'skipped';
                let res = null;
                if (loc.status !== 'located') {
                    bump(loc.status);
                } else {
                    const ex = r.extract || {};
                    res = compareSegment({
                        questionText: r.lint_text ?? ex.question_text,
                        segment: loc.segment,
                        hasFigure: Boolean(ex.figure_desc || ex.figure_box || ex.figure_img)
                    }, options);
                    verdict = res.verdict;
                    if (verdict === 'skipped') bump(res.reason);
                    else { stats.checked += 1; stats[verdict] += 1; }
                }
                if (verdict === 'mismatch') { if (isPositive) stats.tp += 1; else stats.fp += 1; }
                if (isPositive && verdict !== 'mismatch') {
                    stats.fn += 1;
                    if (verdict === 'match') stats.fnCheckable += 1;
                }
                items.push({ r, loc, res, verdict, isPositive });
            });
        }
    }

    const sampleLoc = locateSegments(sample.questions, sample.text, options);
    const sampleStats = { total: sample.questions.length, checked: 0, mismatch: 0, skipped: 0 };
    sample.questions.forEach((q, i) => {
        const loc = sampleLoc[i];
        if (loc.status !== 'located') { sampleStats.skipped += 1; return; }
        const res = compareSegment({ questionText: q.question_text, segment: loc.segment, hasFigure: Boolean(q.figure_desc) }, options);
        if (res.verdict === 'skipped') { sampleStats.skipped += 1; return; }
        sampleStats.checked += 1;
        if (res.verdict === 'mismatch') sampleStats.mismatch += 1;
    });

    return { stats, sampleStats, items };
}

function pct(n, d) {
    return d ? `${(100 * n / d).toFixed(1)}%` : 'n/a';
}

function sweepGrid() {
    const grid = [];
    for (const puaMap of [false, true]) {
        for (const tailMax of [160, 300, 600]) {
            for (const minCoverage of [0.7, 0.8]) {
                for (const extraDigitsRule of [false, true]) grid.push({ puaMap, tailMax, minCoverage, extraDigitsRule });
            }
        }
    }
    return grid;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.pdfDir) throw new Error('缺少 --pdf-dir');
    const outFile = resolveOut(args.out);

    const pdfs = walkPdfs(args.pdfDir);
    const bySha = new Map();
    for (const f of pdfs) {
        const bytes = fs.readFileSync(f);
        bySha.set(crypto.createHash('sha256').update(bytes).digest('hex'), { file: f, bytes });
    }
    const rows = await loadRows([...bySha.keys()], args.includeDups);

    // 每份 PDF 的文字層只讀一次（整份逐頁），分塊時再切
    const jobs = [];
    const minusStats = [];
    for (const [sha, pdf] of bySha) {
        const jobRows = rows.filter(r => r.pdf_sha256 === sha);
        if (jobRows.length === 0) continue;
        const { pages } = await readPagesText(pdf.bytes, 1, null);
        const pageTexts = [];
        for (let p = 1; p <= pages[1]; p++) pageTexts.push((await readPagesText(pdf.bytes, p, p)).text);
        const all = pageTexts.join('');
        const count = (s) => (s.match(/[-\u2212]/g) || []).length;
        minusStats.push({
            file: path.basename(pdf.file).slice(0, 6),
            minus_raw: count(normalizeSourceText(all, { puaMap: false })),
            minus_pua: count(normalizeSourceText(all, { puaMap: true }))
        });
        // 同一份 PDF 可能被拆過好幾次（force 重拆），逐 job 分開算
        for (const jobId of [...new Set(jobRows.map(r => r.job_id))]) {
            jobs.push({
                jobId,
                rows: jobRows.filter(r => r.job_id === jobId),
                textFor: (from, to) => pageTexts.slice(Math.max(1, from || 1) - 1, to || pageTexts.length).join('')
            });
        }
    }
    const sample = await loadSample();

    console.log(`原卷 ${bySha.size} 份、job ${jobs.length} 個、題目 ${rows.length} 列（${args.includeDups ? '含' : '排除'} rejected／duplicate）`);
    console.log('負號字形數（PUA 對映前 → 後）：');
    for (const m of minusStats) console.log(`  ${m.file}…  ${m.minus_raw} → ${m.minus_pua}`);

    const configs = args.sweep ? sweepGrid() : [{ ...DEFAULTS, ...args.options }];
    const summaries = [];
    for (const cfg of configs) {
        const options = { ...DEFAULTS, ...cfg };
        const { stats, sampleStats, items } = await runOnce({ jobs, sample, positives: args.positives, options });
        const summary = {
            options: { puaMap: options.puaMap, tailMax: options.tailMax, minCoverage: options.minCoverage, extraDigitsRule: options.extraDigitsRule },
            real: { ...stats, fp_rate: stats.checked ? stats.fp / stats.checked : null },
            sample: sampleStats
        };
        summaries.push(summary);
        const o = summary.options;
        console.log(`\n[pua=${o.puaMap} tail=${o.tailMax} cov=${o.minCoverage} extraDigits=${o.extraDigitsRule}]`);
        console.log(`  真實：共 ${stats.total}、可比對 ${stats.checked}（${pct(stats.checked, stats.total)}）、判不一致 ${stats.mismatch}`
            + `｜TP ${stats.tp}、FP ${stats.fp}（${pct(stats.fp, stats.checked)}）、FN ${stats.fn}（其中可比對卻判一致 ${stats.fnCheckable}）`);
        console.log(`  跳過：${Object.entries(stats.skipped).map(([k, v]) => `${k} ${v}（${pct(v, stats.total)}）`).join('、') || '無'}`);
        console.log(`  樣卷：共 ${sampleStats.total}、可比對 ${sampleStats.checked}、跳過 ${sampleStats.skipped}、誤報 ${sampleStats.mismatch}`);

        if (args.showText && !args.sweep) {
            for (const it of items.filter(x => x.verdict === 'mismatch' || x.isPositive)) {
                console.log(`\n── jq #${it.r.jq_id}  question #${it.r.question_id ?? '-'}  ${it.isPositive ? '[已知正例]' : ''}  verdict=${it.verdict}`
                    + `  loc=${it.loc.status}/${it.loc.locate_score}${it.loc.shared ? ' shared' : ''}`);
                if (it.res) console.log(`   signals=${JSON.stringify(it.res.signals)} ${describeMismatch(it.res)}`);
                console.log(`   【拆題】${it.r.lint_text ?? it.r.extract?.question_text}`);
                if (it.loc.segment) console.log(`   【原卷】${it.loc.segment}`);
            }
        }
    }

    if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify({ generated_at: new Date().toISOString(), positives: args.positives, minus: minusStats, runs: summaries }, null, 2));
        console.log(`\n已寫入 ${outFile}（只含數字，不含題目內容）`);
    }
}

if (require.main === module) {
    main().catch((err) => { console.error(`❌ ${err.message}`); process.exit(1); });
}

module.exports = { parseArgs, resolveOut, sweepGrid };
