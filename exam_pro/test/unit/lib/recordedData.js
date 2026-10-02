// ─────────────────────────────────────────────────────────────
// test/unit/lib/recordedData.js — repo 內「錄好的資料」齊不齊（〔章節重整 CH-B〕）
//
// 有幾支單元測試直接拿 repo 內錄好的資料跑 eval 的 suite：
//   eval/fixtures/embeddings.<model>.<dim>.json（向量）、eval/cassettes/（LLM 回放）。
// 章節重整（docs/chapter-restructure.md 第 1 條）**刻意**讓其中一部分失效：
//   - fixture 改標後，embed_text 第一行的章名變了 → 那幾題的向量查不到；
//   - 章節白名單換了 → classify／extract／nlq／variant 的 schemaHash 變了 → cassette 查不到。
// 在 Owner 重錄（npm run cassettes:rerecord）之前，eval 與 e2e 會以 replay miss 紅燈——那才是該擋的地方。
// 單元測試在這段期間改成：
//   - 資料齊全：原本的斷言一條不少；
//   - 資料不齊：斷言 suite **以 miss 拒絕**（不拿假向量、假回應湊數字），依賴數字的斷言 skip 並指名缺什麼。
// 與 test/unit/cassetteReplay.test.js 的 extract_ocr 組「依現行樣卷算出預期的鍵、檔案不在就 skip」是同一條線：
// 重錄完就自動恢復執行，不必再改測試。
//
// 〔r7 測試空轉清理 2026-09-27〕判斷「齊不齊」一律對 **CI 讀的那一份**：
//   - 向量：原本固定讀 Gemini 的 embeddings.gemini-embedding-001.768.json。本機模式之後 Owner 只重錄本機模型的向量，
//     Gemini 那一份缺的 5 題（#51、#53～#55、#62）永遠不會補上，靠它判斷的 runVariantSuite 一組因此**永遠 skip**，
//     skip 訊息卻叫 Owner 重錄（重錄的是另一份檔）。改成讀 ci.yml 的 EMBED_MODEL（CI_EMBED_MODEL）；
//     Gemini 那一份留給「確實缺向量的真實資料」這種用途（RECORDED_EMBED_MODEL，名稱不變）。
//   - 樣卷的拆題回放檔：CI 是 LOCAL_EXTRACT_MODE=ocr（本機拆題只用 OCR），讀的是 extract_ocr，不是 Gemini 的 extract
//     （sampleExtractOcrCassette）。
// ─────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadFixture } = require('../../../eval/lib/fixtures');
const { loadEmbeddings } = require('../../../eval/lib/embeddings');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const SAMPLE_PDF = path.join(APP_DIR, 'eval', 'fixtures', 'sample_exam.pdf');

const RERECORD_HINT = '請 Owner 執行 npm run cassettes:rerecord 重錄（docs/chapter-restructure.md 第 5 條），錄好後這一則自動恢復執行';

/** 樣卷的 OCR 與 extract_ocr 回放檔由哪一步錄（docs/local-mode.md 10.21 的重錄計畫） */
// 〔dec/r13-extract-fixes〕extract_ocr.v2 → v3（本機模板多了 answer_text 與矩陣等寫法），要錄的是 10.25 第 8 點那一步
const EXTRACT_OCR_RECORD_STEP = 'docs/local-mode.md 10.25 第 8 點（scripts\\windows\\record_local.bat pipeline,e2e --only-missing；'
    + 'OCR 為主，只錄 ocr 與 extract_ocr.v3，不呼叫看圖模型）';

/**
 * repo 內 Gemini 錄的舊向量檔（embeddings.gemini-embedding-001.768.json）。
 * 本機模式之後不再重錄這一份；章節重整後它缺 5 題的向量，是「確實缺向量」的真實資料，
 * 給「缺向量時要以查不到拒絕」「--only-missing 挑出的就是缺的那幾題」這類測試用。
 */
const RECORDED_EMBED_MODEL = 'gemini-embedding-001';

/**
 * CI 讀的向量檔的模型：.github/workflows/ci.yml 的 EMBED_MODEL（eval/lib/suiteProcess.js 的 readCiModels，
 * 與 npm run cassettes:rerecord 錄的是同一份）；讀不到 ci.yml 時退回 config/models.js 的預設（兩者一致）。
 */
const CI_EMBED_MODEL = (() => {
    let fromCi = null;
    try { fromCi = require('../../../eval/lib/suiteProcess').readCiModels().EMBED_MODEL || null; } catch (_) { fromCi = null; }
    return fromCi || require('../../../config/models').DEFAULT_EMBED;
})();

/**
 * 公開 fixture 的每一題在向量檔裡都查得到嗎？
 * 向量檔整個不存在時照舊丟錯（那不是「待重錄」，是檔案不見了）。
 * @param {string} [model=CI_EMBED_MODEL] 向量檔的模型（〔r7〕預設改成 CI 讀的那一份）
 * @returns {{complete:boolean, missing:number[], file:string, model:string, reason:string|false}}
 *          reason：不齊時給 node:test 的 skip 字串；齊全時為 false
 */
function fixtureVectorGap(model = CI_EMBED_MODEL) {
    const fixture = loadFixture();
    const emb = loadEmbeddings({ questions: fixture.questions, model });
    const complete = emb.missing.length === 0;
    return {
        complete,
        missing: emb.missing.slice(),
        file: emb.file,
        model,
        reason: complete ? false
            : `${path.basename(emb.file)} 缺 ${emb.missing.length} 題的向量（id：${emb.missing.join(', ')}；fixture 題幹或章名改過、embed_text 變了）——${RERECORD_HINT}`
    };
}

/**
 * 〔r7 測試空轉清理〕樣卷（eval/fixtures/sample_exam.pdf）某一塊的 extract_ocr 回放檔在不在。
 *
 * 鍵照 agents/extract.js 的 ocrStructureRequest 算——LOCAL_EXTRACT_MODE=ocr 時 runLocalOcrOnly 送出的就是它
 * （test/unit/extractOcrOnly.test.js 逐鍵比對）：OCR 文字取自 repo 內樣卷的 OCR 回放檔（agent=ocr，鍵照
 * services/ocr 的 ocrCassetteKey），模型＝MODEL_OCR_STRUCTURE（未設＝MODEL_VERIFY；eval/lib/pipelineDriver.js 與 runner 同一條規則）。
 * 只看檔案在不在，不讀內容；OCR 回放檔本身不在時也回 ready:false 並指名缺的是 OCR。
 *
 * @param {{chunkNo?:number, fromPage?:number, toPage?:number}} [opts] 塊的範圍（toPage 會照樣卷頁數截短，與 agents/extract.js 相同）
 * @returns {{ready:boolean, ocrReady:boolean, ocrKey:string, agent:string, template:string, key:string|null,
 *            file:string|null, model:string, reason:string|false}}
 */
function sampleExtractOcrCassette(opts = {}) {
    const ocr = require('../../../services/ocr');
    const cassette = require('../../../services/llm/cassette');
    const extractAgent = require('../../../agents/extract');
    const models = require('../../../config/models');
    const { loadSheet } = require('../../../eval/lib/pdfGolden');

    const chunkNo = Number.isInteger(opts.chunkNo) && opts.chunkNo > 0 ? opts.chunkNo : 1;
    const bytes = fs.readFileSync(SAMPLE_PDF);
    const pdfSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    // 樣卷的頁數以答案卷為準（loadSheet 會先擋「sha256 與 PDF 不符」，頁數因此一定是這一份 PDF 的）
    const pageCount = loadSheet({ pdfPath: SAMPLE_PDF }).doc.page_count;
    const fromPage = Math.max(1, opts.fromPage || 1);
    const toPage = Math.min(pageCount, opts.toPage || pageCount);
    const model = String(process.env.MODEL_OCR_STRUCTURE || '').trim() || models.MODEL_VERIFY;
    const agent = extractAgent.AGENT_OCR;
    const template = extractAgent.TEMPLATE_OCR;

    const ocrKey = ocr.ocrCassetteKey({
        engineVersion: ocr.pinnedEngineVersion(), pdfSha256, fromPage, toPage, dpi: ocr.resolveOcrConfig().dpi
    });
    const tape = cassette.readCassette(ocr.AGENT, ocrKey);
    const tapePages = tape && tape.response && Array.isArray(tape.response.pages) ? tape.response.pages : null;
    const pages = [];
    for (let n = fromPage; tapePages && n <= toPage; n++) {
        const p = tapePages.find(x => x && x.page === n);
        if (!p || typeof p.markdown !== 'string') { pages.length = 0; break; }
        pages.push({ page: n, markdown: p.markdown, imagePath: null });
    }
    if (pages.length !== toPage - fromPage + 1) {
        return {
            ready: false, ocrReady: false, ocrKey, agent, template, key: null, file: null, model,
            reason: `樣卷第 ${fromPage}～${toPage} 頁的 OCR 回放檔不在或缺頁（agent=${ocr.AGENT} key=${ocrKey.slice(0, 12)}…）——`
                + `等 ${EXTRACT_OCR_RECORD_STEP} 錄好後自動恢復執行`
        };
    }

    const req = extractAgent.ocrStructureRequest({
        // 〔dec/r13-extract-fixes〕本機路徑的 schema（只換 answer_text 的說明）與 agent 實際送出的同一份
        group: 'math_physics', models: { ocrStructure: model }, schema: extractAgent.localExtractSchema('math_physics'),
        range: { fromPage, toPage }, ocrText: ocr.pagesToText(pages), chunkNo, pdfSha256
    });
    const key = cassette.cassetteKey({
        agent: req.agent, modelId: models.parseModel(req.model).id, template: req.template,
        schema: req.schema, cacheKeyParts: req.cacheKeyParts
    });
    const file = cassette.cassettePath(req.agent, key);
    const ready = fs.existsSync(file);
    return {
        ready, ocrReady: true, ocrKey, agent, template, key, file, model,
        reason: ready ? false
            : `樣卷第 ${chunkNo} 塊的 ${template} 回放檔還沒錄（agent=${agent} key=${key.slice(0, 12)}…，模型 ${model}）——`
                + `等 ${EXTRACT_OCR_RECORD_STEP} 錄好後自動恢復執行`
    };
}

module.exports = {
    fixtureVectorGap, sampleExtractOcrCassette,
    RERECORD_HINT, EXTRACT_OCR_RECORD_STEP, RECORDED_EMBED_MODEL, CI_EMBED_MODEL, SAMPLE_PDF
};
