// agents/extract.js 與 agents/schemas/ 的單元測試（WS-B / A-T8）
//
// ctx.llm 一律用注入的假物件：不連 Gemini、不需要金鑰、不讀 cassette。
// 執行：npm test

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');

const extract = require('../../agents/extract');
const { buildSchema, ENUM_SOURCES } = require('../../agents/schemas');
const { CHAPTERS, SUBJECTS, QUESTION_TYPES } = require('../../config/chapters');

/** 造一份 n 頁的空白 PDF（只測切塊，不需要內容） */
async function makePdf(pages) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
    return Buffer.from(await doc.save());
}

const GOOD = {
    subject: '數學',
    chapter: '向量內積',
    chapter_confidence: 0.92,
    question_type: '計算',
    difficulty: 3,
    question_text: '設 $\\vec{a}=(1,2)$、$\\vec{b}=(3,-1)$，求 $\\vec{a}\\cdot\\vec{b}$。',
    answer_text: '$1$'
};

/** 假的 ctx：llm 回固定 data，config 帶門檻 */
function fakeCtx(data, { thresholds } = {}) {
    const calls = [];
    return {
        calls,
        ctx: {
            llm: {
                generateJson: async (opts) => {
                    calls.push(opts);
                    return { data, usage: { tokenIn: 1, tokenOut: 2, tokenThinking: 3, tokenCached: 0 }, latencyMs: 4, raw: null };
                }
            },
            db: null, job: { id: 1, budget_usd: 1, cost_usd: 0 }, jq: null,
            logger: { info() {}, warn() {}, error() {} },
            config: {
                models: { extract: 'gemini:gemini-3.5-flash' },
                thresholds: thresholds || { pdfChunkPages: 20, inlineMaxBytes: 15728640 }
            },
            signal: undefined
        }
    };
}

// ───────────────────────── schema ─────────────────────────

describe('agents/schemas — buildSchema', () => {
    test('x-enum 被換成 enum，且值來自 config/chapters.js（沒有第二份真相）', () => {
        const s = buildSchema('extract');
        const props = s.properties.questions.items.properties;
        assert.equal(props.chapter['x-enum'], undefined);
        assert.deepEqual(props.subject.enum, SUBJECTS);
        assert.deepEqual(props.question_type.enum, QUESTION_TYPES);
        assert.deepEqual(props.chapter.enum, [...CHAPTERS['數學'], ...CHAPTERS['物理']]);
        assert.equal(props.chapter.enum.length, 66);
    });

    test('chapter 是兩科合併（Gemini 的 schema 沒辦法依 subject 切 enum）', () => {
        assert.equal(ENUM_SOURCES.chapter.length, CHAPTERS['數學'].length + CHAPTERS['物理'].length);
        assert.deepEqual(ENUM_SOURCES.answer_form, ['option', 'number', 'expression', 'text']);
    });

    test('回傳的物件是深凍結的，且同一個 name 拿到同一個實例', () => {
        const a = buildSchema('classify');
        const b = buildSchema('classify');
        assert.equal(a, b);
        assert.ok(Object.isFrozen(a));
        assert.ok(Object.isFrozen(a.properties.chapter.enum));
        assert.throws(() => { 'use strict'; a.properties.chapter.description = 'x'; }, TypeError);
    });

    test('不存在的 name 丟錯', () => {
        assert.throws(() => buildSchema('不存在'), /找不到 schema 檔/);
    });
});

// ───────────────────────── prompt ─────────────────────────

describe('extract 的 prompt', () => {
    test('章節白名單完全來自 CHAPTERS（WS-D 會斷言同一件事）', () => {
        const prompt = extract.buildPrompt();
        for (const subject of SUBJECTS) {
            for (const chapter of CHAPTERS[subject]) {
                assert.ok(prompt.includes(chapter), `prompt 少了章節「${chapter}」`);
            }
        }
    });

    test('題型五種都列出來（現況 aiService 的 prompt 漏掉「證明」）', () => {
        const prompt = extract.buildPrompt();
        for (const t of QUESTION_TYPES) assert.ok(prompt.includes(t), `prompt 少了題型「${t}」`);
    });

    test('模板原文仍留著挖空欄位（cassette 的 promptTemplateHash 用它）', () => {
        assert.ok(extract.PROMPT_TEMPLATE.includes('{{CHAPTER_WHITELIST}}'));
        assert.ok(!extract.buildPrompt().includes('{{CHAPTER_WHITELIST}}'));
    });
});

// ───────────────────────── 切塊 ─────────────────────────

describe('planChunks', () => {
    test('剛好整除與不整除', () => {
        assert.deepEqual(extract.planChunks(20, 20), [{ no: 1, fromPage: 1, toPage: 20 }]);
        assert.deepEqual(extract.planChunks(45, 20), [
            { no: 1, fromPage: 1, toPage: 20 },
            { no: 2, fromPage: 21, toPage: 40 },
            { no: 3, fromPage: 41, toPage: 45 }
        ]);
    });

    test('0 頁回空陣列、頁數小於一塊時只有一塊', () => {
        assert.deepEqual(extract.planChunks(0, 20), []);
        assert.deepEqual(extract.planChunks(3, 20), [{ no: 1, fromPage: 1, toPage: 3 }]);
    });
});

describe('slicePdf', () => {
    test('切出來的頁數正確', async () => {
        const bytes = await makePdf(25);
        const { bytes: sliced, pageCount } = await extract.slicePdf(bytes, 21, 25);
        assert.equal(pageCount, 25);
        const doc = await PDFDocument.load(sliced);
        assert.equal(doc.getPageCount(), 5);
    });

    test('整份就是這一塊時原樣回傳（不重新編碼、不多花時間）', async () => {
        const bytes = await makePdf(3);
        const { bytes: sliced } = await extract.slicePdf(bytes, 1, 3);
        assert.equal(sliced, bytes);
    });
});

// ───────────────────────── 逐元素驗證 ─────────────────────────

describe('validateElements — 逐元素驗證（第 3.3 條）', () => {
    const chunk = { chunkNo: 2, fromPage: 21, toPage: 40 };

    test('idx = chunk_no * 1000 + 陣列位置（不是模型自己編的號碼）', () => {
        // 模型自己編的 idx（這裡故意跳號成 999）會被忽略：跳號、重號都會撞 UNIQUE (job_id, idx)
        const { questions } = extract.validateElements({ questions: [GOOD, { ...GOOD, idx: 999 }] }, chunk);
        assert.deepEqual(questions.map(q => q.idx), [2001, 2002]);
        assert.deepEqual(questions[0].page_range, [21, 40]);
        assert.equal(questions[0].chunk_no, 2);
    });

    test('壞元素只丟自己那一筆，好元素照常通過', () => {
        const bad = { ...GOOD, chapter: '平面向量' };          // 不在 enum 內
        const { questions, rejected } = extract.validateElements({ questions: [GOOD, bad, GOOD] }, chunk);
        assert.equal(questions.length, 2);
        assert.deepEqual(questions.map(q => q.idx), [2001, 2003]);   // idx 用位置，不會因為中間掉一筆而重號
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].idx, 2002);
        assert.ok(rejected[0].errors.some(e => e.includes('平面向量')), rejected[0].errors.join('；'));
    });

    test('缺必填欄位、難度越界、多出未知欄位都會被擋', () => {
        const { rejected } = extract.validateElements({
            questions: [
                { ...GOOD, answer_text: undefined },
                { ...GOOD, difficulty: 9 },
                { ...GOOD, 額外欄位: 1 }
            ]
        }, chunk);
        assert.equal(rejected.length, 3);
        assert.ok(rejected[0].errors.join().includes('answer_text'));
        assert.ok(rejected[2].errors.join().includes('額外欄位'));
    });

    test('questions 不是陣列時回空結果（交給呼叫端判 fail）', () => {
        assert.deepEqual(extract.validateElements({}, chunk), { questions: [], rejected: [] });
        assert.deepEqual(extract.validateElements(null, chunk), { questions: [], rejected: [] });
    });

    test('figure_page 由塊內頁碼換算成絕對頁碼（chunk.fromPage + 塊內頁碼 - 1）', () => {
        const withFig = { ...GOOD, figure_page: 3, figure_box: [100, 200, 400, 800] };
        const { questions } = extract.validateElements({ questions: [withFig] }, chunk);
        assert.equal(questions[0].figure_page, 23);   // fromPage 21 + 3 - 1
        assert.deepEqual(questions[0].figure_box, [100, 200, 400, 800]);
    });

    test('塊內頁碼超出本塊範圍＝模型數錯頁，整組丟掉但題目照常通過', () => {
        const withFig = { ...GOOD, figure_page: 21, figure_box: [100, 200, 400, 800] };  // 21+21-1=41 > toPage 40
        const { questions, rejected } = extract.validateElements({ questions: [withFig] }, chunk);
        assert.equal(rejected.length, 0);
        assert.equal(questions.length, 1);
        assert.ok(!('figure_page' in questions[0]) && !('figure_box' in questions[0]));
    });

    test('沒有附圖的題目，兩個鍵整個不存在', () => {
        const { questions } = extract.validateElements({ questions: [GOOD] }, chunk);
        assert.ok(!('figure_page' in questions[0]) && !('figure_box' in questions[0]));
    });
});

describe('normalizeElement — [附圖描述：…] 一律歸位到 figure_desc', () => {
    test('模型寫進 question_text 時搬回 figure_desc', () => {
        const el = extract.normalizeElement({
            ...GOOD,
            question_text: '一物體沿斜面下滑，求加速度。[附圖描述：傾角 30 度的光滑斜面]'
        });
        assert.equal(el.question_text, '一物體沿斜面下滑，求加速度。');
        assert.equal(el.figure_desc, '傾角 30 度的光滑斜面');
    });

    test('沒有附圖時 figure_desc 這個鍵整個不存在（第 3.2 條）', () => {
        const el = extract.normalizeElement({ ...GOOD, figure_desc: '   ' });
        assert.ok(!('figure_desc' in el));
    });

    test('兩邊都有時併起來，不覆蓋原本的 figure_desc', () => {
        const el = extract.normalizeElement({
            ...GOOD,
            question_text: '題幹 [附圖描述：後補的]',
            figure_desc: '原本的'
        });
        assert.equal(el.figure_desc, '原本的\n後補的');
    });
});

describe('normalizeElement — 附圖框（figure_page＋figure_box）的防呆', () => {
    const BOX = [100, 200, 400, 800];

    test('成對且合法時原樣保留', () => {
        const el = extract.normalizeElement({ ...GOOD, figure_page: 2, figure_box: BOX });
        assert.equal(el.figure_page, 2);
        assert.deepEqual(el.figure_box, BOX);
    });

    test('只有其中一個、或框幾何不合法（ymin≥ymax）時整組拿掉——框壞掉只該少圖不該少題', () => {
        for (const bad of [
            { figure_page: 2 },                                  // 缺 box
            { figure_box: BOX },                                 // 缺 page
            { figure_page: 0, figure_box: BOX },                 // 頁碼越界
            { figure_page: 2, figure_box: [400, 200, 100, 800] }, // ymin > ymax
            { figure_page: 2, figure_box: [100, 800, 400, 200] }, // xmin > xmax
            { figure_page: 2, figure_box: [100, 200, 400] },      // 長度不對
            { figure_page: 2, figure_box: [100, 200, 400, 1001] } // 超出 0–1000
        ]) {
            const el = extract.normalizeElement({ ...GOOD, ...bad });
            assert.ok(!('figure_page' in el) && !('figure_box' in el), JSON.stringify(bad));
        }
    });
});

// ───────────────────────── run ─────────────────────────

describe('extract.run', () => {
    test('全部合格 → pass，data.questions 是 payload.extract 的形狀', async () => {
        const pdf = await makePdf(2);
        const { ctx, calls } = fakeCtx({ questions: [GOOD, { ...GOOD, question_type: '證明' }] });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: { no: 1, fromPage: 1, toPage: 2 } });

        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.questions.length, 2);
        assert.deepEqual(Object.keys(outcome.data.questions[0]).sort(), [
            'answer_text', 'chapter', 'chapter_confidence', 'chunk_no', 'difficulty',
            'idx', 'page_range', 'question_text', 'question_type', 'subject'
        ]);
        assert.equal(outcome.data.pdf_sha256.length, 64);

        // 送進 generateJson 的參數：agent／template／cacheKeyParts 必須齊全（第 5.2 條）
        assert.equal(calls[0].agent, 'extract');
        assert.equal(calls[0].template, 'extract.v1');
        assert.deepEqual(Object.keys(calls[0].cacheKeyParts), ['template', 'chunkNo', 'pdfSha256']);
        assert.equal(calls[0].cacheKeyParts.pdfSha256, outcome.data.pdf_sha256);
        assert.ok(calls[0].parts[0].pdfBase64, 'PDF 要以 inlineData 送出');
    });

    test('部分合格 → 仍然 pass，壞的只記進 rejected', async () => {
        const pdf = await makePdf(1);
        const { ctx } = fakeCtx({ questions: [GOOD, { ...GOOD, subject: '化學' }] });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: { no: 1, fromPage: 1, toPage: 1 } });
        assert.equal(outcome.kind, 'pass');
        assert.equal(outcome.data.questions.length, 1);
        assert.equal(outcome.data.rejected.length, 1);
    });

    test('整包都不合格 → fail(schema_invalid)', async () => {
        const pdf = await makePdf(1);
        const { ctx } = fakeCtx({ questions: [{ ...GOOD, chapter: '亂寫的章' }] });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: { no: 1, fromPage: 1, toPage: 1 } });
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'schema_invalid');
        assert.equal(outcome.data.rejected.length, 1);
    });

    test('一題都沒有（封面頁那種塊）→ pass 空陣列，不是失敗', async () => {
        const pdf = await makePdf(1);
        const { ctx } = fakeCtx({ questions: [] });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: { no: 1, fromPage: 1, toPage: 1 } });
        assert.equal(outcome.kind, 'pass');
        assert.deepEqual(outcome.data.questions, []);
    });

    test('超過 inlineData 門檻 → fail(provider_error)，訊息帶裁決 S0-4 的字串', async () => {
        const pdf = await makePdf(1);
        const { ctx } = fakeCtx({ questions: [] }, { thresholds: { pdfChunkPages: 20, inlineMaxBytes: 10 } });
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: { no: 1, fromPage: 1, toPage: 1 } });
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'provider_error');
        assert.match(outcome.feedback, /Files API 路徑尚未啟用/);
    });

    test('llm 丟錯 → 包成 {kind:error}，agent 自己不 throw（第 3.1 條）', async () => {
        const pdf = await makePdf(1);
        const ctx = {
            llm: { generateJson: async () => { const e = new Error('429 配額用盡'); e.errorClass = 'rate_limited'; throw e; } },
            logger: console, config: { models: {}, thresholds: {} }
        };
        const outcome = await extract.run(ctx, { pdfBytes: pdf, chunk: { no: 1, fromPage: 1, toPage: 1 } });
        assert.equal(outcome.kind, 'error');
        assert.equal(outcome.errorClass, 'rate_limited');
    });

    test('沒有 pdfPath 也沒有 pdfBytes → fail 而不是丟例外', async () => {
        const { ctx } = fakeCtx({ questions: [] });
        const outcome = await extract.run(ctx, {});
        assert.equal(outcome.kind, 'fail');
        assert.equal(outcome.reason, 'schema_invalid');
    });
});
