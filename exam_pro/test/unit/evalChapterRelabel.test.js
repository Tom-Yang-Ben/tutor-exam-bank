// ─────────────────────────────────────────────────────────────
// test/unit/evalChapterRelabel.test.js — eval 素材改標（章節重整 CH-B，docs/chapter-restructure.md 第 3.2 條第 1 點）
//
// 改標後的 fixture／golden 以 config/chapterPlan.js 的定案清單（PLAN_CHAPTERS）＋化學章節驗證：
//   1. 用**同一套硬閘門**（eval/lib 的 validate*／load*，注入章節白名單）驗證全部素材；
//      CH-A 合入前本分支的 config/chapters.js 還是舊白名單，既有測試會用它檢查而紅，這一支不會。
//   2. 沒有任何一筆還標著重整後不存在的章名。
//   3. 各份 golden 抄下來的章名與 fixture 一致；nlq rules 路徑的 relevant 就是 expect 四欄篩出來的題。
//   4. eval/CHAPTER_RELABEL-2026-09.md 的表格逐列與檔案內容相符，而且沒有漏列（含第 2.1 節新增的題）。
//   5. nlq 改寫過的查詢句，在新白名單下的規則解析結果就是 golden 的期望值（子行程以 preload 模擬 CH-A 合入後）。
// ─────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PLAN_CHAPTERS, MIGRATION } = require('../../config/chapterPlan');
const { chapterGate, plannedChapters } = require('../../eval/lib/chapterGate');
const { loadFixture, validateQuestions } = require('../../eval/lib/fixtures');
const { loadClassifyGolden } = require('../../eval/lib/golden2');
const { loadSheet } = require('../../eval/lib/pdfGolden');
const { loadNlqGolden } = require('../../eval/lib/suiteNlq');
const { loadVariantGolden } = require('../../eval/lib/suiteVariant');

const APP_DIR = path.resolve(__dirname, '..', '..');
const EVAL_DIR = path.join(APP_DIR, 'eval');
const DOC = path.join(EVAL_DIR, 'CHAPTER_RELABEL-2026-09.md');
const SAMPLE_PDF = path.join(EVAL_DIR, 'fixtures', 'sample_exam.pdf');
const PDF_SAMPLE_DIR = path.join(EVAL_DIR, 'golden', 'pdf_sample');

const CHAPTERS = plannedChapters();
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** 素材原始內容（不經閘門，給一致性檢查用） */
const RAW = {
    fixture: readJson(path.join(EVAL_DIR, 'fixtures', 'questions.public.json')),
    classify: readJson(path.join(EVAL_DIR, 'golden', 'classify.json')),
    nlq: readJson(path.join(EVAL_DIR, 'golden', 'nlq.json')),
    variant: readJson(path.join(EVAL_DIR, 'golden', 'variant.json')),
    pdf: readJson(path.join(PDF_SAMPLE_DIR, fs.readdirSync(PDF_SAMPLE_DIR).find(f => f.endsWith('.json'))))
};
const FIXTURE_BY_ID = new Map(RAW.fixture.questions.map(q => [q.id, q]));

/** 舊白名單（MIGRATION 的鍵）裡、新清單沒有的章名：重整後不該再出現在任何素材裡 */
const OLD_ONLY = Object.fromEntries(Object.entries(MIGRATION).map(([subject, table]) =>
    [subject, Object.keys(table).filter(c => !PLAN_CHAPTERS[subject].includes(c))]));
/** 新清單裡、舊白名單沒有的章名 */
const NEW_ONLY = Object.fromEntries(Object.entries(PLAN_CHAPTERS).map(([subject, list]) =>
    [subject, list.filter(c => !Object.prototype.hasOwnProperty.call(MIGRATION[subject], c))]));

/**
 * 全部素材的「每一個章名標註」攤平。
 * @returns {Array<{file:string, id:string, subject:string, chapter:string}>}
 */
function allLabels() {
    const out = [];
    for (const q of RAW.fixture.questions) out.push({ file: 'questions.public.json', id: String(q.id), subject: q.subject, chapter: q.chapter });
    for (const e of RAW.classify.entries) out.push({ file: 'classify.json', id: e.id, subject: e.subject, chapter: e.chapter });
    for (const e of RAW.variant.entries) out.push({ file: 'variant.json', id: e.id, subject: e.subject, chapter: e.chapter });
    for (const q of RAW.pdf.questions) out.push({ file: 'pdf_sample', id: String(q.no), subject: q.subject, chapter: q.chapter });
    for (const e of RAW.nlq.entries) {
        for (const c of e.expect.chapters) out.push({ file: 'nlq.json', id: e.id, subject: e.expect.subject, chapter: c });
    }
    return out;
}

/**
 * 讀 Markdown 表格：找到指定的表頭那一行，一直讀到下一個空行。
 * @param {string} header 例如 '| 檔案 | 題號 | 舊章 | 新章 | 理由 |'
 * @returns {string[][]} 每列的儲存格（已去頭尾空白）
 */
function readTable(header) {
    const lines = fs.readFileSync(DOC, 'utf8').split(/\r?\n/);
    const start = lines.findIndex(l => l.trim() === header);
    assert.ok(start >= 0, `${path.basename(DOC)} 找不到表頭：${header}`);
    const rows = [];
    for (let i = start + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    }
    return rows;
}

/** 表格的「檔案＋題號」→ 素材裡的那一筆 */
function lookup(file, id) {
    switch (file) {
        case 'questions.public.json': { const q = FIXTURE_BY_ID.get(Number(id)); return q && { subject: q.subject, chapter: q.chapter }; }
        case 'classify.json': { const e = RAW.classify.entries.find(x => x.id === id); return e && { subject: e.subject, chapter: e.chapter }; }
        case 'variant.json': { const e = RAW.variant.entries.find(x => x.id === id); return e && { subject: e.subject, chapter: e.chapter }; }
        case 'pdf_sample': { const q = RAW.pdf.questions.find(x => x.no === Number(id)); return q && { subject: q.subject, chapter: q.chapter }; }
        case 'nlq.json': {
            const e = RAW.nlq.entries.find(x => x.id === id);
            return e && { subject: e.expect.subject, chapter: e.expect.chapters.length === 1 ? e.expect.chapters[0] : null };
        }
        default: return null;
    }
}

describe('改標後的素材以新清單（PLAN_CHAPTERS＋化學）過得了全部硬閘門', () => {
    test('chapterGate 注入：新清單有、舊清單沒有的章名被接受；反過來被擋', () => {
        const gate = chapterGate(CHAPTERS);
        assert.ok(gate.isValidChapter('數學', '廣義角與極坐標'));
        assert.ok(!gate.isValidChapter('數學', '三角函數的定義'));
        assert.ok(!gate.isValidChapter('物理', '宇宙學簡介'));
        assert.ok(gate.isValidChapter('化學', CHAPTERS['化學'][0]), '化學沿用 config/chapters.js');
        assert.ok(!gate.isValidSubject('生物'));
        assert.throws(() => chapterGate({ 數學: '實數' }), /字串陣列/);
        // 不注入時就是 config/chapters.js（既有閘門一個字都沒變）
        assert.equal(chapterGate().source, 'config/chapters.js');
    });

    test('fixture 61 題（新增自製干擾題 #61，改標清單第 2.1 節）', () => {
        const fixture = loadFixture(undefined, { chapters: CHAPTERS });
        assert.equal(fixture.questions.length, 61);
        // 注入新清單時，舊章名會被同一套閘門擋下（證明注入真的生效，不是全部放行）
        const bad = validateQuestions([{ ...fixture.questions[0], chapter: '三角函數的定義' }], { chapters: CHAPTERS });
        assert.ok(bad.some(p => p.includes('三角函數的定義')), bad.join('\n'));
    });

    test('classify 91 筆（fixture 段 61＋漂移段 30）、nlq 50 句、variant 30 個藍本、樣卷答案卷 10 題', () => {
        const fixture = loadFixture(undefined, { chapters: CHAPTERS });
        assert.equal(loadClassifyGolden({ fixtureById: fixture.byId, chapters: CHAPTERS }).entries.length, 91);
        assert.equal(loadNlqGolden({ fixtureById: fixture.byId, chapters: CHAPTERS }).entries.length, 50);
        assert.equal(loadVariantGolden({ fixtureById: fixture.byId, chapters: CHAPTERS }).entries.length, 30);
        assert.equal(loadSheet({ pdfPath: SAMPLE_PDF, chapters: CHAPTERS }).doc.questions.length, 10);
    });

    test('定案仍然是定案：needs_human_confirm 一筆都沒有被打開（待抽查的判斷列在改標清單第 6 節）', () => {
        for (const [name, raw] of [['classify', RAW.classify], ['nlq', RAW.nlq], ['variant', RAW.variant]]) {
            assert.equal(raw.entries.filter(e => e.needs_human_confirm).length, 0, name);
        }
        assert.equal(RAW.pdf.needs_human_confirm, false);
    });
});

describe('章名的一致性', () => {
    test('沒有任何一筆還標著重整後不存在的章名（含被刪的兩個物理章）', () => {
        const stale = allLabels().filter(l => (OLD_ONLY[l.subject] || []).includes(l.chapter));
        assert.deepEqual(stale, [], JSON.stringify(stale.slice(0, 5)));
        assert.ok(OLD_ONLY['物理'].includes('宇宙學簡介') && OLD_ONLY['物理'].includes('流體的壓力與浮力'));
    });

    test('classify 的 fixture 段、variant 的藍本、樣卷答案卷的章名與 fixture 一致', () => {
        for (const e of RAW.classify.entries.filter(x => x.source === 'fixture')) {
            assert.equal(e.chapter, FIXTURE_BY_ID.get(e.from).chapter, e.id);
        }
        for (const e of RAW.variant.entries) assert.equal(e.chapter, FIXTURE_BY_ID.get(e.source_question_id).chapter, e.id);
        for (const q of RAW.pdf.questions) assert.equal(q.chapter, FIXTURE_BY_ID.get(q.fixture_id).chapter, `no=${q.no}`);
    });

    test('nlq rules 路徑的 relevant ＝ expect 四欄對 fixture 篩出來的題（golden 檔頭的定義）', () => {
        for (const e of RAW.nlq.entries.filter(x => x.expect_path === 'rules')) {
            const x = e.expect;
            const ids = RAW.fixture.questions.filter(q => q.subject === x.subject && x.chapters.includes(q.chapter)
                && (x.question_types.length === 0 || x.question_types.includes(q.question_type))
                && (x.difficulty_min === null || q.difficulty >= x.difficulty_min)
                && (x.difficulty_max === null || q.difficulty <= x.difficulty_max)).map(q => q.id);
            assert.deepEqual([...e.relevant].sort((a, b) => a - b), ids, `${e.id}「${e.query}」`);
        }
    });

    test('fixture 的結構仍然成立：每個有換數字配對的章都至少有一題同章干擾題（D-E1）', () => {
        const paired = new Set(RAW.fixture.questions.filter(q => q.role === 'numeric_variant').map(q => `${q.subject}/${q.chapter}`));
        for (const key of paired) {
            assert.ok(RAW.fixture.questions.some(q => `${q.subject}/${q.chapter}` === key && q.role === 'distractor'), key);
        }
    });
});

describe('eval/CHAPTER_RELABEL-2026-09.md 與檔案內容相符', () => {
    const relabel = readTable('| 檔案 | 題號 | 舊章 | 新章 | 理由 |');
    const rewrites = readTable('| 題號 | 舊查詢 | 新查詢 | 舊章 | 新章 | 理由 |');
    const relevantOnly = readTable('| 題號 | 查詢 | 舊 relevant | 新 relevant |');
    const kept = readTable('| 檔案 | 題號 | 章 | 理由 |');
    const added = readTable('| 檔案 | 題號 | 新增到的章 | 理由 |');

    test('改標清單逐列：檔案裡現在的章名就是「新章」，而且照 MIGRATION 的去處改', () => {
        assert.ok(relabel.length >= 40, `改標清單只有 ${relabel.length} 列`);
        for (const [file, id, from, to, why] of relabel) {
            const item = lookup(file, id);
            assert.ok(item, `${file} ${id} 找不到`);
            assert.equal(item.chapter, to, `${file} ${id} 現在是「${item.chapter}」，表上寫「${to}」`);
            assert.ok(PLAN_CHAPTERS[item.subject].includes(to), `${to} 不在新清單`);
            const rule = MIGRATION[item.subject][from];
            assert.ok(rule, `${from} 不是舊白名單的章`);
            assert.ok(rule.to.includes(to), `${from} → ${to} 不在 MIGRATION 的去處（${rule.to.join('、')}）`);
            assert.ok(why && why.length >= 4, `${file} ${id} 沒寫理由`);
        }
    });

    test('nlq 改寫：現在的查詢句與期望章節就是表上寫的', () => {
        for (const [id, oldQuery, newQuery, , to, why] of rewrites) {
            const e = RAW.nlq.entries.find(x => x.id === id);
            assert.ok(e, id);
            assert.equal(e.query, newQuery, id);
            assert.notEqual(oldQuery, newQuery, id);
            assert.deepEqual(e.expect.chapters, [to], id);
            assert.ok(PLAN_CHAPTERS[e.expect.subject].includes(to), `${id}：${to} 不在新清單`);
            assert.ok(why && why.length >= 4, `${id} 沒寫理由`);
        }
    });

    test('只調 relevant 的 nlq 句子：新 relevant 與檔案一致', () => {
        for (const [id, query, , now] of relevantOnly) {
            const e = RAW.nlq.entries.find(x => x.id === id);
            assert.equal(e.query, query, id);
            assert.deepEqual(e.relevant, now.split(',').map(s => Number(s.trim())), id);
        }
    });

    test('新增的題（第 2.1 節）：章名與表上相同；fixture 的新題是自製干擾題，classify 的 fixture 段逐字沿用它', () => {
        assert.ok(added.length >= 2, `新增表只有 ${added.length} 列`);
        for (const [file, id, chapter, why] of added) {
            const item = lookup(file, id);
            assert.ok(item, `${file} ${id} 找不到`);
            assert.equal(item.chapter, chapter, `${file} ${id}`);
            assert.ok(PLAN_CHAPTERS[item.subject].includes(chapter), `${chapter} 不在新清單`);
            assert.ok(why && why.length >= 4, `${file} ${id} 沒寫理由`);
            if (file === 'questions.public.json') {
                const q = FIXTURE_BY_ID.get(Number(id));
                assert.equal(q.role, 'distractor', `#${id} 是為了滿足 D-E1 而新增的干擾題`);
                assert.ok(!q.variant_group && !q.latex_broken, `#${id} 不該加入換數字家族，也不是刻意寫壞的題`);
            }
            if (file === 'classify.json') {
                const e = RAW.classify.entries.find(x => x.id === id);
                assert.equal(e.source, 'fixture', id);
                assert.equal(e.question_text, FIXTURE_BY_ID.get(e.from).question_text, `${id} 的題幹要逐字沿用 fixture`);
                assert.ok(added.some(([f, qid]) => f === 'questions.public.json' && Number(qid) === e.from), `${id} 的來源題也要列在新增表`);
            }
        }
    });

    test('沒有漏列：標著新設章名的每一筆都在改標清單、改寫表或新增表裡', () => {
        const listed = new Set([
            ...relabel.map(([file, id]) => `${file}#${id}`),
            ...rewrites.map(([id]) => `nlq.json#${id}`),
            ...added.map(([file, id]) => `${file}#${id}`)
        ]);
        const unlisted = allLabels()
            .filter(l => (NEW_ONLY[l.subject] || []).includes(l.chapter))
            .filter(l => !listed.has(`${l.file}#${l.id}`));
        assert.deepEqual(unlisted, [], JSON.stringify(unlisted.slice(0, 5)));
    });

    test('拆分章裡維持原章的題也都列了理由（fixture／classify／variant／樣卷）', () => {
        const keptIds = new Set();
        for (const [file, ids, chapter, why] of kept) {
            assert.ok(why && why.length >= 4, `${file} ${ids} 沒寫理由`);
            for (const id of ids.split('、').map(s => s.trim())) {
                const item = lookup(file, id);
                assert.ok(item, `${file} ${id} 找不到`);
                assert.equal(item.chapter, chapter, `${file} ${id}`);
                keptIds.add(`${file}#${id}`);
            }
        }
        const splitOld = allLabels().filter(l => l.file !== 'nlq.json'
            && MIGRATION[l.subject][l.chapter] && MIGRATION[l.subject][l.chapter].kind === 'split');
        const missing = splitOld.filter(l => !keptIds.has(`${l.file}#${l.id}`));
        assert.deepEqual(missing, [], JSON.stringify(missing.slice(0, 5)));
    });
});

describe('nlq 改寫的查詢句在新白名單下的規則解析（子行程模擬 CH-A 合入後）', () => {
    test('章節、題型、難度、學生與 semantic_text 都等於 golden 的期望值', () => {
        const rewrites = readTable('| 題號 | 舊查詢 | 新查詢 | 舊章 | 新章 | 理由 |').map(r => r[0]);
        const entries = RAW.nlq.entries.filter(e => rewrites.includes(e.id));
        assert.equal(entries.length, rewrites.length);
        const script = `
            const { parseQuery } = require(${JSON.stringify(path.join(APP_DIR, 'utils', 'nlqHeuristics'))});
            const { CHAPTER_ALIASES } = require(${JSON.stringify(path.join(APP_DIR, 'config', 'chapterAliases'))});
            const queries = JSON.parse(process.argv[1]);
            process.stdout.write(JSON.stringify(queries.map(q => parseQuery(q, { aliases: CHAPTER_ALIASES }))));
        `;
        const res = spawnSync(process.execPath, [
            '--require', path.join(APP_DIR, 'test', 'fixtures', 'planChapters.preload.js'),
            '-e', script, JSON.stringify(entries.map(e => e.query))
        ], { cwd: APP_DIR, encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
        const parsed = JSON.parse(res.stdout);
        entries.forEach((e, i) => {
            const got = parsed[i];
            assert.equal(got.confident, true, `${e.id} 規則應該抓得到章節`);
            assert.equal(e.expect_path, 'rules', e.id);
            assert.deepEqual(got.filters.chapters, e.expect.chapters, e.id);
            assert.equal(got.filters.subject, e.expect.subject, e.id);
            assert.deepEqual(got.filters.question_types, e.expect.question_types, e.id);
            assert.equal(got.filters.difficulty_min, e.expect.difficulty_min, e.id);
            assert.equal(got.filters.difficulty_max, e.expect.difficulty_max, e.id);
            assert.equal(got.filters.exclude_student_name, e.expect.exclude_student_name, e.id);
            assert.equal(got.semantic_text, e.expect.semantic_text, e.id);
        });
    });
});
