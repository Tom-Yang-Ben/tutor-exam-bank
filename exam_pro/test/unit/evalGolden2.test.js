// 階段 2 三份 golden（classify／answer／dedup）的硬閘門測試（A-T6）
//
// 與 evalFixtures.test.js 同一個用意：這一支測的是**資料**，不只是程式。
// 每次 CI 都把 90 筆分類標籤、250 個答案比對案例、30 組重複判定重新過一次閘門。
// golden 是純檔案，沒有 DB 的 CHECK 幫忙擋；一個手滑改錯的章節名不會讓任何東西壞掉，
// 只會讓 accuracy 安靜地少 1/90，看起來像模型退步。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { loadFixture } = require('../../eval/lib/fixtures');
const g2 = require('../../eval/lib/golden2');
const { isValidChapter, isValidQuestionType } = require('../../config/chapters');
const { normalizeStem, textHash, normalizeStemSource } = require('../../eval/lib/stage2Shims');

const fixture = loadFixture();
// 載入本身就會跑硬閘門，不過關會丟錯——這三行等於三個斷言
const classify = g2.loadClassifyGolden({ fixtureById: fixture.byId });
const answer = g2.loadAnswerGolden();
const dedup = g2.loadDedupGolden({ fixtureById: fixture.byId });

describe('classify golden（章節分類）', () => {
    test('共 90 筆＝ 60 題 fixture + 30 筆漂移變體', () => {
        assert.equal(classify.entries.length, 90);
        assert.equal(classify.entries.filter(e => e.source === 'fixture').length, 60);
        assert.equal(classify.entries.filter(e => e.source === 'drift').length, 30);
    });

    test('漂移變體兩種各 15 筆', () => {
        const byKind = {};
        for (const e of classify.entries.filter(e => e.source === 'drift')) {
            byKind[e.drift_kind] = (byKind[e.drift_kind] || 0) + 1;
        }
        assert.deepEqual(byKind, { stem_rewrite: 15, chapter_synonym: 15 });
    });

    test('每一筆的正解章節都在白名單內', () => {
        for (const e of classify.entries) {
            assert.ok(isValidChapter(e.subject, e.chapter), `${e.id} 的「${e.subject}／${e.chapter}」不在白名單`);
        }
    });

    test('fixture 段的標籤與 eval/fixtures/questions.public.json 完全一致', () => {
        // 規劃 §5.3.2：「標籤沿用 fixture」。這一條防的是「有人只改了其中一邊」——
        // 兩邊不同步時，classify 的分數會與檢索 eval 對不起來，而且沒有任何錯誤訊息。
        for (const e of classify.entries.filter(e => e.source === 'fixture')) {
            const q = fixture.byId.get(e.from);
            assert.ok(q, `${e.id} 的 from=${e.from} 不在 fixture`);
            assert.equal(e.subject, q.subject, `${e.id} 的 subject 與 fixture 不符`);
            assert.equal(e.chapter, q.chapter, `${e.id} 的 chapter 與 fixture 不符`);
            assert.equal(e.question_text, q.question_text, `${e.id} 的題幹與 fixture 不符`);
        }
    });

    test('decoy_chapter 不得等於正解（那樣「漂移」就沒有意義）', () => {
        for (const e of classify.entries) {
            if (e.decoy_chapter) assert.notEqual(e.decoy_chapter, e.chapter, e.id);
        }
    });

    test('漂移變體的題幹不得與來源 fixture 題逐字相同', () => {
        // 「改寫」而不是「複製」——完全相同就退化成 fixture 段的重複，白測一次。
        for (const e of classify.entries.filter(e => e.source === 'drift')) {
            const src = fixture.byId.get(e.from);
            assert.notEqual(e.question_text, src.question_text, `${e.id} 與 fixture #${e.from} 逐字相同`);
        }
    });

    test('已全部定案（裁決 S2-30：needs_human_confirm 為 0）', () => {
        assert.equal(classify.pendingConfirm, 0);
    });

    test('閘門會擋下白名單外的章節', () => {
        const bad = [{ id: 'x', question_text: 'q', subject: '數學', chapter: '不存在的章', source: 'fixture', from: 1, drift_kind: null, decoy_chapter: null, needs_human_confirm: true }];
        const problems = g2.validateClassify(bad);
        assert.ok(problems.some(p => p.includes('不在')), problems.join('；'));
    });
});

describe('answer golden（答案比對）', () => {
    test('共 50 題，展開後 250 個 answerCompare 案例', () => {
        assert.equal(answer.entries.length, 50);
        const cases = answer.entries.flatMap(g2.expandAnswerCases);
        assert.equal(cases.length, 250);
        assert.equal(cases.filter(c => c.role === 'equivalent').length, 150);
        assert.equal(cases.filter(c => c.role === 'wrong').length, 100);
    });

    test('每題剛好 3 種等價寫法 + 2 種典型錯答', () => {
        for (const e of answer.entries) {
            assert.equal(e.equivalents.length, 3, e.id);
            assert.equal(e.wrong.length, 2, e.id);
        }
    });

    test('等價寫法彼此不重複，錯答也不得與等價寫法重疊', () => {
        for (const e of answer.entries) {
            assert.equal(new Set(e.equivalents).size, 3, `${e.id} 的等價寫法有重複`);
            for (const w of e.wrong) {
                assert.ok(!e.equivalents.includes(w), `${e.id} 的錯答「${w}」同時被列為等價寫法`);
            }
        }
    });

    test('question_type 都在白名單內，answer_form 都在四個值內', () => {
        for (const e of answer.entries) {
            assert.ok(isValidQuestionType(e.question_type), `${e.id} 的題型「${e.question_type}」`);
            assert.ok(g2.ANSWER_FORMS.includes(e.answer_form), `${e.id} 的 answer_form「${e.answer_form}」`);
        }
    });

    test('證明題一律期望 uncertain（interfaces-stage2.md 第 4.2 條）', () => {
        const proofs = answer.entries.filter(e => e.question_type === '證明');
        assert.ok(proofs.length >= 1, '至少要有一題證明題，否則這條規則沒被測到');
        for (const e of proofs) {
            assert.equal(e.expect.equivalent, 'uncertain', e.id);
            assert.equal(e.expect.wrong, 'uncertain', e.id);
        }
    });

    test('等價寫法不得期望 disagree、錯答不得期望 agree', () => {
        for (const e of answer.entries) {
            assert.ok(['agree', 'uncertain'].includes(e.expect.equivalent), e.id);
            assert.ok(['disagree', 'uncertain'].includes(e.expect.wrong), e.id);
        }
    });

    test('涵蓋四種 answer_form 與至少四種題型', () => {
        const forms = new Set(answer.entries.map(e => e.answer_form));
        assert.equal(forms.size, 4, `只涵蓋 ${[...forms].join('、')}`);
        const types = new Set(answer.entries.map(e => e.question_type));
        assert.ok(types.size >= 4, `只涵蓋 ${[...types].join('、')}`);
    });

    test('已全部定案（裁決 S2-30：needs_human_confirm 為 0）', () => {
        assert.equal(answer.pendingConfirm, 0);
    });

    test('閘門會擋下「證明題期望 agree」這種違反第 4.2 條的標註', () => {
        const bad = [{
            id: 'x', question_type: '證明', answer_form: 'text', claimed: 'a',
            equivalents: ['1', '2', '3'], wrong: ['4', '5'],
            expect: { equivalent: 'agree', wrong: 'disagree' },
            extraction_hazard: false, needs_human_confirm: true
        }];
        const problems = g2.validateAnswer(bad);
        assert.ok(problems.some(p => p.includes('證明')), problems.join('；'));
    });
});

describe('dedup golden（重複判定）', () => {
    test('共 30 組，四種 kind 齊備', () => {
        assert.equal(dedup.entries.length, 30);
        const byKind = {};
        for (const e of dedup.entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
        assert.deepEqual(byKind, { verbatim: 8, resend: 8, numeric_change: 7, different: 7 });
    });

    test('kind 與 expect_l0 自洽', () => {
        for (const e of dedup.entries) {
            const want = (e.kind === 'verbatim' || e.kind === 'resend') ? 'hit' : 'miss';
            assert.equal(e.expect_l0, want, e.id);
        }
    });

    test('L0：expect_hit 的組雜湊必須相同、expect_miss 的必須不同', () => {
        // 這是整份 golden 唯一「現在就守得住」的硬數字：normalizeStem 是純函式，
        // 不需要模型、不需要 DB。規劃 §3.8：「L0 對逐字／重傳 recall 100%」。
        for (const e of dedup.entries) {
            const a = textHash(e.a.text);
            const b = textHash(e.b.text);
            assert.ok(a && b, `${e.id} 有一邊算不出雜湊`);
            if (e.expect_l0 === 'hit') {
                assert.equal(a, b, `${e.id}（${e.kind}）應該命中，但雜湊不同：\n  A=${normalizeStem(e.a.text)}\n  B=${normalizeStem(e.b.text)}`);
            } else {
                assert.notEqual(a, b, `${e.id}（${e.kind}）不該命中，但雜湊相同`);
            }
        }
    });

    test('L0 對 verbatim + resend 的 recall = 100%、對其餘的誤報 = 0', () => {
        const positives = dedup.entries.filter(e => e.expect_l0 === 'hit');
        const negatives = dedup.entries.filter(e => e.expect_l0 === 'miss');
        const hit = e => textHash(e.a.text) === textHash(e.b.text);
        assert.equal(positives.filter(hit).length, positives.length, `recall 不是 100%（${positives.length} 組）`);
        assert.equal(negatives.filter(hit).length, 0, '有誤報');
    });

    test('8 筆 resend 的兩邊題幹不得逐字相同（否則就退化成 verbatim）', () => {
        for (const e of dedup.entries.filter(e => e.kind === 'resend')) {
            assert.notEqual(e.a.text, e.b.text, `${e.id} 兩邊逐字相同`);
        }
    });

    test('已全部定案（裁決 S2-30：needs_human_confirm 為 0）', () => {
        assert.equal(dedup.pendingConfirm, 0);
    });
});

describe('normalizeStem 轉接層與 scripts/backfill_text_hash.js 的參考實作一致', () => {
    // WS-C 合入 utils/normalizeStem.js 之後，這一支會改成比對「真實作 vs 參考實作」。
    // 在那之前它比對的是「轉接層 vs 參考實作」——兩者本來就同一份程式碼，
    // 但這條斷言的價值在於：WS-C 合入的那一刻，若新實作與參考實作不同，這裡會第一個轉紅，
    // 而不是等到 backfill 跑完發現全庫雜湊作廢。
    const FIGURE_DESC_RE = /\[附圖描述[：:][\s\S]*?\]/g;
    const BRACKET_OPTION_RE = /[（(［[【]\s*([A-Ha-h])\s*[）)］\]】]/g;
    const BARE_OPTION_RE = /(^|[\s\n])([A-Ha-h])[.、．:：]/gm;
    function reference(text) {
        if (typeof text !== 'string' || text.length === 0) return '';
        let s = text.replace(FIGURE_DESC_RE, '').normalize('NFKC');
        s = s.replace(BRACKET_OPTION_RE, (m, ch) => `(${ch.toUpperCase()})`);
        s = s.replace(BARE_OPTION_RE, (m, pre, ch) => `${pre}(${ch.toUpperCase()})`);
        return s.replace(/\$/g, '').replace(/\s+/g, '').toLowerCase();
    }

    test('對 fixture 60 題與 dedup golden 的 60 段文字產出逐位元相同的雜湊', () => {
        const texts = [
            ...fixture.questions.map(q => q.question_text),
            ...dedup.entries.flatMap(e => [e.a.text, e.b.text])
        ];
        for (const t of texts) {
            const want = reference(t);
            assert.equal(normalizeStem(t), want, `正規化結果不同：${t.slice(0, 40)}…`);
            const wantHash = want === '' ? null : crypto.createHash('sha256').update(want, 'utf8').digest('hex');
            assert.equal(textHash(t), wantHash);
        }
    });

    test('空字串與非字串一律回 \'\'，不拋例外（第 4.1 條第 1 步）', () => {
        for (const v of ['', null, undefined, 123, {}, []]) {
            assert.equal(normalizeStem(v), '');
            assert.equal(textHash(v), null);
        }
    });

    test('轉接層會回報自己的來源（報表 meta 要記）', () => {
        assert.equal(typeof normalizeStemSource(), 'string');
        assert.ok(normalizeStemSource().length > 0);
    });
});
