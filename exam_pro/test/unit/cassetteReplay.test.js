// 錄→放的往返測試：用 repo 內已錄好的 eval/cassettes 把拆題（extract_ocr）／分類（classify）整條跑一遍（WS-B）
//
// 這是整個 WS-B 唯一一項「端到端」的單元測試：真的走 services/llm 的 replay 路徑、
// 真的讀 eval/fixtures/sample_exam.pdf、真的過 ajv 與 isValidChapter，
// 但**不連任何模型、不連 PG、不需要金鑰**——CI 跑得起來的原因就是 cassette。
//
// 〔r7 測試空轉清理 2026-09-27〕兩組回放原本在本機模式下永遠 skip：
//   - extract 組算的是 Gemini 拆題（agent extract）的鍵，本機模式（MODEL_EXTRACT＝ollama）根本不走那條路，
//     而且 CI 是 LOCAL_EXTRACT_MODE=ocr：拆題讀的是 OCR 回放檔（agent ocr）＋ extract_ocr。改成驗 extract_ocr；
//   - classify 組用 MODEL_EXTRACT（看圖模型 qwen3-vl）算鍵，但分類走的是 MODEL_TEXT（LM-15，本機＝qwen3:8b），
//     鍵永遠對不上。改成與 runner 相同：ctx.config.models.text＝MODEL_TEXT，鍵也用它算。
//     classify.v2 的本機回放檔已在基底（2026-09-27 錄，dec/r6-recorded-step1），這一組現在真的回放。
// 回放檔在就一定要跑；不在就 skip，skip 訊息指名等哪一步重錄（docs/local-mode.md 10.21）。
// 預期的鍵與 agent 實際送出的鍵是否一致，由「不需要回放檔」的兩組（extract_ocr、classify 各一）直接比對
// （skip 條件本身不會算錯而永遠 skip）。
// 〔r7 審查 2026-09-27〕①樣卷或答案卷壞掉（讀不到、sha256 不符）時，原本在載入模組就丟錯、整支檔案爆掉，
// classify 兩組也跟著跑不到。改成接住：extract_ocr 兩組 skip 並指向「樣卷前提」那一則，那一則把原錯誤丟出來（紅燈，
// 不是悄悄 skip）；classify 各組照常跑。②「classify 讀 MODEL_TEXT 的鍵」那一則不需要 classify 回放檔，
// 從會整組 skip 的 classify 組移到「classify 的回放鍵」組（斷言一字未改），回放檔被 prune 掉時照樣守著模型路由。
//
// 模型與模式一律照 config/models.js 的預設（＝ci.yml 的 unit job：沒有 env），檔頭先清掉會改變鍵的環境變數。
//
// 執行：npm test

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 會改變 cassette 鍵或拆題路徑的環境變數：清掉，照程式預設（與 CI 的 unit job 相同）。
// 要在下面算「預期的鍵」之前就清，算鍵與回放才會用同一組設定。
const ENV_KEYS = ['LLM_MODE', 'EVAL_CASSETTE_DIR', 'MODEL_EXTRACT', 'MODEL_VERIFY', 'MODEL_TEXT', 'MODEL_OCR_STRUCTURE',
    'LOCAL_EXTRACT_MODE', 'OCR_ENGINE', 'OCR_DPI'];
const envBackup = {};
for (const k of ENV_KEYS) envBackup[k] = process.env[k];
for (const k of ENV_KEYS) delete process.env[k];
process.env.LLM_MODE = 'replay';                // 用預設的 eval/cassettes、config/models.js 的預設模型

after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});

const llm = require('../../services/llm');
const extractAgent = require('../../agents/extract');
const classifyAgent = require('../../agents/classify');
const { buildSchema } = require('../../agents/schemas');
const { cassetteKey, cassettePath } = require('../../services/llm/cassette');
const models = require('../../config/models');
const { sampleExtractOcrCassette, SAMPLE_PDF } = require('./lib/recordedData');

const FIXTURE = path.resolve(__dirname, '..', '..', 'eval', 'fixtures', 'questions.public.json');

// 〔章節重整 CH-B〕classify 組改回放 fixture #9（數學／向量內積）。原本用 #1，#1 已改標為「指數函數與對數函數」，
// 是「指數與對數」拆章後兩章都說得通的邊界題（eval/CHAPTER_RELABEL-2026-09.md）；本組驗的是「錄→放」往返，
// 不是分類正確率（那是 npm run eval:classify 的事，同 extract 組「不該讓模型少抓一題就把單元測試變紅」的原則）。
const CLASSIFY_FIXTURE_ID = 9;

/**
 * fixture #9 的 classify 回放檔在不在（依現行 schema 與模型算出預期的鍵再看檔案）。
 *
 * 原本只看「classify/ 目錄底下有沒有檔案」。章節白名單一換，schemaHash 就變、舊 cassette 全部讀不到，
 * 但目錄底下仍然有檔——那會給出一個假的綠燈條件。改成依現行 schema 算出預期的鍵再檢查檔案。
 * 〔r7〕模型用 MODEL_TEXT（LM-15：分類只讀題目文字，runner 以 ctx.config.models.text 傳入；本機預設＝qwen3:8b），
 * 不是 MODEL_EXTRACT——本機模式下兩者不同，用錯的那一個算鍵，這一組就永遠 skip。
 */
function classifyCassette(modelSpec = models.MODEL_TEXT) {
    let q;
    try {
        q = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).questions.find(x => x.id === CLASSIFY_FIXTURE_ID);
    } catch (err) {
        return { ready: false, key: null, model: modelSpec };
    }
    if (!q) return { ready: false, key: null, model: modelSpec };
    const key = cassetteKey({
        agent: 'classify',
        modelId: models.parseModel(modelSpec).id,
        template: classifyAgent.TEMPLATE,
        schema: buildSchema('classify'),
        // agents/classify.js 第二層的 cacheKeyParts；ctx.db = null 時 few-shot 全來自自製例句，fewShotIds 是 []
        cacheKeyParts: { template: classifyAgent.TEMPLATE, questionText: String(q.question_text).trim(), fewShotIds: [] }
    });
    return { ready: fs.existsSync(cassettePath('classify', key)), key, model: modelSpec };
}

const CLASSIFY = classifyCassette();

/**
 * 樣卷第 1 塊（第 1 頁；樣卷只有 1 頁）的 OCR 與 extract_ocr 回放檔。
 * sampleExtractOcrCassette 會讀樣卷、用 loadSheet 檢查答案卷的 sha256，壞了就丟錯；在這裡接住，
 * 不讓整支檔案在載入時爆掉（classify 各組與樣卷無關）。接住的錯誤由「樣卷前提」那一則丟出來＝紅燈。
 * 模型照 recordedData.js 同一條規則（MODEL_OCR_STRUCTURE 未設＝MODEL_VERIFY），給 replayCtx 用。
 */
const EXTRACT_OCR = (() => {
    try {
        return { ...sampleExtractOcrCassette({ chunkNo: 1, fromPage: 1, toPage: 1 }), error: null };
    } catch (err) {
        return {
            ready: false, ocrReady: false, ocrKey: null, key: null, error: err,
            model: String(process.env.MODEL_OCR_STRUCTURE || '').trim() || models.MODEL_VERIFY,
            reason: `樣卷或答案卷讀不到（${String(err && err.message).split('\n')[0]}）——見本檔「樣卷前提」那一則的紅燈`
        };
    }
})();

/**
 * 真的走 services/llm（replay），只有 db 是 null。
 * models 與 runner（workers/jobRunner.js）組 ctx.config.models 的規則相同：
 *   extract＝MODEL_EXTRACT、verify＝MODEL_VERIFY、ocrStructure＝MODEL_OCR_STRUCTURE（未設＝MODEL_VERIFY）、text＝MODEL_TEXT。
 * 拆題模式明寫 ocr（與 ci.yml 的 LOCAL_EXTRACT_MODE 相同），不靠程式預設。
 * @param {object} [overrides] 覆寫 ctx.config.models 的欄位（值為 undefined＝拿掉那一欄）
 */
function replayCtx(overrides = {}) {
    const m = {
        extract: models.MODEL_EXTRACT,
        verify: models.MODEL_VERIFY,
        ocrStructure: EXTRACT_OCR.model,
        text: models.MODEL_TEXT
    };
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete m[k]; else m[k] = v;
    }
    return {
        llm,
        db: null,
        job: { id: 0, budget_usd: 1, cost_usd: 0 },
        jq: null,
        logger: { info() {}, warn() {}, error() {} },
        config: {
            models: m,
            thresholds: { classifyMinConf: 0.8, pdfChunkPages: 20, inlineMaxBytes: 15728640 },
            features: {},
            localExtract: { mode: 'ocr' },
            ocr: { engine: 'paddle' }
        },
        signal: undefined
    };
}

/** extract 的 outcome 若是 error 就丟出它的訊息（給 assert.rejects 比對凍結的 replay miss 訊息） */
async function runExtract(chunk) {
    const o = await extractAgent.run(replayCtx(), { pdfPath: SAMPLE_PDF, chunk });
    if (o.kind === 'error') throw new Error(o.message);
    return o;
}

/** replay miss 訊息裡的 agent 與 key（services/llm/fake.js 凍結的格式） */
function missOf(message) {
    const m = /LLM_MODE=replay 找不到 cassette（agent=([^ ]+) key=([0-9a-f]{64})）/.exec(String(message));
    return m ? { agent: m[1], key: m[2] } : null;
}

// 〔r7 審查〕extract_ocr 兩組的前提：一定執行（不 skip）。樣卷與答案卷沒問題時這一則過；
// 壞了（讀不到、sha256 不符）時把 sampleExtractOcrCassette 丟的原錯誤丟出來——紅燈，而下面兩組只 skip 並指向這裡。
describe('樣卷前提（extract_ocr 兩組共用；壞了是紅燈，不是 skip）', () => {
    test('eval/fixtures/sample_exam.pdf 讀得到、答案卷的 sha256 與它相符，算得出 OCR 回放檔的鍵', () => {
        if (EXTRACT_OCR.error) throw EXTRACT_OCR.error;
        assert.match(String(EXTRACT_OCR.ocrKey), /^[0-9a-f]{64}$/);
    });
});

describe('cassette 回放 — extract_ocr（LOCAL_EXTRACT_MODE=ocr、LLM_MODE=replay，不連外）', {
    skip: EXTRACT_OCR.ready ? false : EXTRACT_OCR.reason
}, () => {
    test('extract_ocr：對公開樣卷 sample_exam.pdf 回放，每一題都通過 ajv 且欄位形狀正確；每題標 ocr_only、不帶附圖描述', async () => {
        const outcome = await extractAgent.run(replayCtx(), {
            pdfPath: SAMPLE_PDF,
            chunk: { no: 1, fromPage: 1, toPage: 1 }
        });

        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome).slice(0, 300));
        assert.deepEqual(outcome.data.rejected, []);

        // WS-D 的樣卷挑了 10 題（eval/fixtures/make_sample_pdf.js 的 PICKED）。
        // 這裡不釘死題數：本測驗的是「回放 + ajv + 欄位形狀」，模型的抓題率是 eval 的事，
        // 不該讓模型少抓一題就把單元測試變紅。
        const qs = outcome.data.questions;
        assert.ok(qs.length >= 8, `拆出的題數只有 ${qs.length}，樣卷有 10 題，少太多了`);

        // idx = chunk_no*1000 + 位置，必須連號且唯一（UNIQUE (job_id, idx) 靠它）
        assert.deepEqual(qs.map(q => q.idx), qs.map((_, i) => 1001 + i));

        // 兩科都要有（樣卷刻意跨科挑題）
        assert.ok(qs.some(q => q.subject === '數學'));
        assert.ok(qs.some(q => q.subject === '物理'));

        for (const q of qs) {
            // 題幹不得殘留 [附圖描述：…]（第 3.2 條）
            assert.ok(!q.question_text.includes('[附圖描述'), `#${q.idx} 的題幹殘留附圖描述`);
            // payload.extract 的固定欄位
            assert.equal(q.chunk_no, 1);
            assert.deepEqual(q.page_range, [1, 1]);
            assert.ok(typeof q.answer_text === 'string' && q.answer_text.length > 0);
            // 只用 OCR：文字模型看不到圖，figure_desc 一律拿掉；附圖只由 OCR 的版面位置配（agents/extractOcrFigures.js）
            assert.ok(!('figure_desc' in q), `#${q.idx} 不該有 figure_desc（只用 OCR 時文字模型回的附圖欄位一律拿掉）`);
            if ('figure_box' in q) {
                assert.equal(q.figure_page, 1, `#${q.idx} 的附圖頁碼超出本塊`);
                assert.ok(Array.isArray(q.figure_box) && q.figure_box.length === 4, `#${q.idx} 的 figure_box 不是 4 個數`);
            }
            // 每題停在人工複核的依據（workers/jobRunner.js 的 crossCheckStopReason 讀這兩個欄位）
            assert.deepEqual(q.cross_check, extractAgent.OCR_ONLY_CROSS_CHECK);
            assert.equal(q.extract_mode, 'ocr');
        }

        const s = outcome.data.cross_check_summary;
        assert.equal(s.mode, 'ocr');
        assert.equal(s.counts.ocr_only, qs.length);
        assert.equal(s.ocr_elements, qs.length);
        assert.equal(outcome.data.pdf_sha256, crypto.createHash('sha256').update(fs.readFileSync(SAMPLE_PDF)).digest('hex'));
    });
});

// 〔r7〕這一組不讀 extract_ocr 的回放檔（只要樣卷的 OCR 回放檔），所以不跟著上面那組 skip：
// 換一塊一定 replay miss，miss 訊息裡的鍵就是 agent 實際送出的鍵——拿它對 recordedData.js 算的預期鍵，
// 兩邊算法一有出入就在這裡紅，上面那組才不會因為預期鍵算錯而永遠 skip（或永遠跑錯的檔）。
describe('extract_ocr 的回放鍵（不需要 extract_ocr 回放檔）', {
    skip: EXTRACT_OCR.ocrReady ? false : EXTRACT_OCR.reason
}, () => {
    test('換一塊（chunkNo 不同）就是不同的鍵 → replay miss 且訊息凍結，鍵與預期鍵一致', async () => {
        const expected = sampleExtractOcrCassette({ chunkNo: 7, fromPage: 1, toPage: 1 });
        let message = null;
        await assert.rejects(() => runExtract({ no: 7, fromPage: 1, toPage: 1 }), (err) => {
            message = err.message;
            return /LLM_MODE=replay 找不到 cassette（agent=extract_ocr key=/.test(err.message);
        });
        const miss = missOf(message);
        assert.ok(miss, message);
        assert.equal(miss.key, expected.key, 'agent 實際送出的鍵與 test/unit/lib/recordedData.js 算的預期鍵不同');
        assert.notEqual(miss.key, EXTRACT_OCR.key, '換了塊，鍵卻沒變（cacheKeyParts 沒有 chunkNo？）');
    });

    test('第 1 塊：回放檔在就命中；不在時 miss 的鍵就是上面那組 skip 訊息裡的預期鍵', async () => {
        // 兩種狀態各有斷言（不是「不適用就 return」）：錄好之前守「預期鍵＝實際鍵」，錄好之後守「真的命中」
        const o = await extractAgent.run(replayCtx(), { pdfPath: SAMPLE_PDF, chunk: { no: 1, fromPage: 1, toPage: 1 } });
        if (EXTRACT_OCR.ready) {
            assert.equal(o.kind, 'pass', JSON.stringify(o).slice(0, 300));
        } else {
            assert.equal(o.kind, 'error', JSON.stringify(o).slice(0, 300));
            assert.deepEqual(missOf(o.message), { agent: 'extract_ocr', key: EXTRACT_OCR.key }, o.message);
        }
    });
});

// classify 的 cassette 與樣卷無關（鍵是 questionText + fewShotIds），
// 所以樣卷換掉時它仍然有效——兩組獨立 skip，不要互相拖累。
describe('cassette 回放 — classify（LLM_MODE=replay，不連外）', {
    skip: CLASSIFY.ready ? false
        : `fixture #${CLASSIFY_FIXTURE_ID} 的 ${classifyAgent.TEMPLATE} 本機回放檔不在（模型 ${CLASSIFY.model}，key=${String(CLASSIFY.key).slice(0, 12)}…；` +
          '被 cassettes:prune 刪掉，或章節白名單／分類 schema 又改了）——照 docs/local-mode.md 10.21 第 1 步' +
          '（scripts\\windows\\record_local.bat classify,nlq）重錄後自動恢復執行'
}, () => {
    test('classify：回放公開 fixture 的題目，輸出通過 isValidChapter', async () => {
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        const q = fixture.questions.find(x => x.id === CLASSIFY_FIXTURE_ID);

        const outcome = await classifyAgent.run(replayCtx(), {
            subject: q.subject,
            chapter: null,
            chapter_confidence: 0,     // 強迫走第二層（第一層不呼叫模型，也就沒有 cassette）
            question_text: q.question_text
        });

        assert.equal(outcome.kind, 'pass', JSON.stringify(outcome).slice(0, 300));
        assert.equal(outcome.data.source, 'llm');
        assert.equal(outcome.data.chapter, q.chapter);
        assert.deepEqual(outcome.data.few_shot_ids, []);   // 錄製時刻意不接 DB，回放才對得上
        assert.ok(outcome.data.rationale.length > 0);
        assert.ok(outcome.data.rationale.length <= 200);
    });
});

// 〔r7 審查 2026-09-27〕這一組不讀 classify 的回放檔，所以不跟著上面那組 skip（比照「extract_ocr 的回放鍵」）：
// 模型路由那一則只要「看圖模型的鍵沒有回放檔」；另一則在回放檔不在時拿 miss 訊息裡的鍵對預期鍵，
// 上面那組才不會因為預期鍵算錯而永遠 skip。
describe('classify 的回放鍵（不需要 classify 回放檔）', () => {
    test('給 models.text（MODEL_TEXT）：回放檔在就命中；不在時 miss 的鍵就是上面那組 skip 訊息裡的預期鍵', async () => {
        // 兩種狀態各有斷言（不是「不適用就 return」）：錄好之前守「預期鍵＝實際鍵」，錄好之後守「真的命中」
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        const q = fixture.questions.find(x => x.id === CLASSIFY_FIXTURE_ID);
        const outcome = await classifyAgent.run(replayCtx(), {
            subject: q.subject, chapter: null, chapter_confidence: 0, question_text: q.question_text
        });
        if (CLASSIFY.ready) {
            assert.equal(outcome.kind, 'pass', JSON.stringify(outcome).slice(0, 300));
        } else {
            assert.equal(outcome.kind, 'error', JSON.stringify(outcome).slice(0, 300));
            assert.deepEqual(missOf(outcome.message), { agent: 'classify', key: CLASSIFY.key }, outcome.message);
        }
    });

    test('classify 讀的是文字模型（MODEL_TEXT）的鍵：不給 models.text 就退回看圖模型，那一支沒錄 → replay miss', async () => {
        // LM-15：runner 把 MODEL_TEXT 傳進 ctx.config.models.text；沒給時 agents/classify.js 退回 models.extract。
        // 本機預設兩者不同（qwen3:8b 與 qwen3-vl:8b），所以同一題換一個模型就是另一個鍵。
        assert.notEqual(models.parseModel(models.MODEL_TEXT).id, models.parseModel(models.MODEL_EXTRACT).id,
            '本機預設的文字模型與看圖模型應該不同（config/models.js 的 LM-15）');
        const viaExtract = classifyCassette(models.MODEL_EXTRACT);
        assert.equal(viaExtract.ready, false, `看圖模型（${models.MODEL_EXTRACT}）不該有分類的回放檔`);

        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        const q = fixture.questions.find(x => x.id === CLASSIFY_FIXTURE_ID);
        const outcome = await classifyAgent.run(replayCtx({ text: undefined }), {
            subject: q.subject, chapter: null, chapter_confidence: 0, question_text: q.question_text
        });
        assert.equal(outcome.kind, 'error', JSON.stringify(outcome).slice(0, 300));
        assert.deepEqual(missOf(outcome.message), { agent: 'classify', key: viaExtract.key });
    });
});

// 〔章節重整 CH-A〕零成本閘門這條本身不讀 cassette，原本放在上面那組裡、跟著 cassette 的有無一起略過；
// 移出來無條件執行——cassette 失效（等重錄）的期間，閘門照樣有測試守著。斷言一字未改。
describe('classify 零成本閘門（LLM_MODE=replay，不需要 cassette）', () => {
    test('classify：零成本閘門不需要 cassette（回放時也不該打到 cassette）', async () => {
        const outcome = await classifyAgent.run(replayCtx(), {
            subject: '數學', chapter: '向量內積', chapter_confidence: 0.95, question_text: '求 $\\vec{a}\\cdot\\vec{b}$'
        });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.source, 'gate');
    });
});
