// scripts/record_cassettes.js — 錄製 extract／classify 的 cassette（WS-B / A-T3、A-T8、A-T9）
//
// ⚠ 這支腳本會**真的呼叫 Gemini 並產生費用**，只能在本機執行，CI 永遠是 LLM_MODE=replay。
// ⚠ 只錄公開素材（NOTICE 第 4 條）：
//      extract  → eval/fixtures/sample_exam.pdf（自製 6 題）
//      classify → eval/fixtures/questions.public.json（自製 60 題）
//    私有題庫、真實考卷一律不得從這裡錄；那些要走 eval/private/（gitignore）。
//
// 執行：
//     node scripts/record_cassettes.js --agent all      （預設；--agent extract|classify 可分開錄）
//     node scripts/record_cassettes.js --limit 8        （classify 錄幾題，預設 8）
//     node scripts/record_cassettes.js --dry-run        （只印要錄哪些，不呼叫模型）
//
// 環境變數：GEMINI_API_KEY（.env）、MODEL_EXTRACT。腳本自己把 LLM_MODE 設成 record。
//
// ── classify 為什麼刻意「不接資料庫」──
// cassette 的鍵含 fewShotIds（第 5.2 條）。錄的時候如果接了開發庫，few-shot 會取到題庫既有題、
// fewShotIds 是一串 id；但 CI 沒有那個資料庫，重放時 fewShotIds 會是 []，鍵對不上、全部 miss。
// 所以這裡 ctx.db = null，few-shot 一律走 config/chapterExamples.js——錄製與回放兩邊一致。

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const llm = require('../services/llm');
const models = require('../config/models');
const extractAgent = require('../agents/extract');
const classifyAgent = require('../agents/classify');
const { cassetteDir } = require('../services/llm/cassette');

const SAMPLE_PDF = path.resolve(__dirname, '..', 'eval', 'fixtures', 'sample_exam.pdf');
const PUBLIC_FIXTURE = path.resolve(__dirname, '..', 'eval', 'fixtures', 'questions.public.json');

function parseArgs(argv) {
    const args = { agent: 'all', limit: 8, dryRun: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--agent') args.agent = argv[++i];
        else if (argv[i] === '--limit') args.limit = Number.parseInt(argv[++i], 10);
        else if (argv[i] === '--dry-run') args.dryRun = true;
    }
    return args;
}

/** 錄製用的最小 Ctx：db 一律 null（見檔頭說明），logger 直接印 */
function buildCtx() {
    return {
        llm,
        db: null,
        job: { id: 0, budget_usd: 0, cost_usd: 0 },
        jq: null,
        logger: {
            info: (o) => console.log(JSON.stringify(o)),
            warn: (o) => console.warn(JSON.stringify(o)),
            error: (o) => console.error(JSON.stringify(o))
        },
        config: {
            models: { extract: models.MODEL_EXTRACT, verify: models.MODEL_VERIFY },
            thresholds: {
                classifyMinConf: Number(process.env.CLASSIFY_MIN_CONF || 0.8),
                pdfChunkPages: Number.parseInt(process.env.JOB_PDF_CHUNK_PAGES || '20', 10),
                inlineMaxBytes: Number.parseInt(process.env.GEMINI_INLINE_MAX_BYTES || '15728640', 10)
            },
            features: {}
        },
        signal: undefined
    };
}

async function recordExtract(ctx, dryRun) {
    if (!fs.existsSync(SAMPLE_PDF)) {
        throw new Error(`找不到 ${SAMPLE_PDF}；請先執行 node scripts/make_sample_exam_pdf.js`);
    }
    const bytes = fs.readFileSync(SAMPLE_PDF);
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const chunks = extractAgent.planChunks(doc.getPageCount(), ctx.config.thresholds.pdfChunkPages);

    console.log(`\n[extract] ${SAMPLE_PDF}（${doc.getPageCount()} 頁 → ${chunks.length} 塊）`);
    if (dryRun) return { calls: chunks.length, questions: 0 };

    let questions = 0;
    for (const chunk of chunks) {
        const outcome = await extractAgent.run(ctx, { pdfPath: SAMPLE_PDF, chunk });
        if (outcome.kind !== 'pass') {
            console.error(`  ✖ 第 ${chunk.no} 塊 ${outcome.kind}：${outcome.feedback || outcome.message}`);
            continue;
        }
        questions += outcome.data.questions.length;
        console.log(`  ✔ 第 ${chunk.no} 塊：合格 ${outcome.data.questions.length} 題、不合格 ${outcome.data.rejected.length} 題、` +
            `token in/out/thinking = ${outcome.data.usage.tokenIn}/${outcome.data.usage.tokenOut}/${outcome.data.usage.tokenThinking}`);
        for (const q of outcome.data.questions) {
            console.log(`      #${q.idx} ${q.subject}｜${q.chapter}（信心 ${q.chapter_confidence}）｜${q.question_type}`);
        }
    }
    return { calls: chunks.length, questions };
}

async function recordClassify(ctx, limit, dryRun) {
    const fixture = JSON.parse(fs.readFileSync(PUBLIC_FIXTURE, 'utf8'));
    const all = Array.isArray(fixture.questions) ? fixture.questions : [];

    // 挑「涵蓋最多不同章節」的前 limit 題：cassette 的價值在於覆蓋面，不是題數
    const seen = new Set();
    const picked = [];
    for (const q of all) {
        if (picked.length >= limit) break;
        const key = `${q.subject}／${q.chapter}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(q);
    }

    console.log(`\n[classify] 自 questions.public.json 取 ${picked.length} 題（涵蓋 ${seen.size} 個章節）`);
    if (dryRun) {
        for (const q of picked) console.log(`  · #${q.id} ${q.subject}｜${q.chapter}`);
        return { calls: picked.length, agree: 0 };
    }

    let agree = 0;
    for (const q of picked) {
        // chapter_confidence 給 0，強迫走第二層（第一層是零成本閘門，根本不會呼叫模型，也就沒有 cassette 可錄）
        const outcome = await classifyAgent.run(ctx, {
            subject: q.subject,
            chapter: null,
            chapter_confidence: 0,
            question_text: q.question_text
        });
        if (outcome.kind === 'pass') {
            const ok = outcome.data.chapter === q.chapter;
            if (ok) agree += 1;
            console.log(`  ${ok ? '✔' : '△'} #${q.id} 標註「${q.chapter}」→ 模型「${outcome.data.chapter}」（信心 ${outcome.data.confidence}）`);
        } else {
            console.error(`  ✖ #${q.id} ${outcome.kind}：${outcome.feedback || outcome.message}`);
        }
    }
    return { calls: picked.length, agree };
}

async function main() {
    const args = parseArgs(process.argv);

    if (!args.dryRun) {
        if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_API_KEY.trim()) {
            throw new Error('缺少 GEMINI_API_KEY：錄製 cassette 必須真的呼叫模型（CI 請維持 LLM_MODE=replay）。');
        }
        process.env.LLM_MODE = 'record';
        // 2026-08-22 實測：免費層對 gemini-3.5-flash 的 generateContent 是
        // **每分鐘 5 次**（quotaId=GenerateRequestsPerMinutePerProjectPerModel-FreeTier）。
        // throttle 的預設 60 對這把金鑰太高，錄製時會一直撞 429 靠退避硬拗；這裡先壓到 5。
        if (!process.env.GEMINI_RPM) process.env.GEMINI_RPM = '5';
    } else {
        process.env.LLM_MODE = 'replay';
    }

    console.log(`模式：${process.env.LLM_MODE}`);
    console.log(`模型：MODEL_EXTRACT=${models.MODEL_EXTRACT}`);
    console.log(`輸出：${cassetteDir()}`);
    models.warnIfSameModel();

    const ctx = buildCtx();
    const summary = {};
    if (args.agent === 'all' || args.agent === 'extract') summary.extract = await recordExtract(ctx, args.dryRun);
    if (args.agent === 'all' || args.agent === 'classify') summary.classify = await recordClassify(ctx, args.limit, args.dryRun);

    console.log('\n── 摘要 ──');
    console.log(JSON.stringify(summary, null, 2));
    console.log('錄完請執行 npm test 確認回放正常，並把 eval/cassettes/** 一起進版控。');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`\n錄製失敗：${err.message}`);
        process.exit(1);
    });
}

module.exports = { buildCtx, recordExtract, recordClassify };
