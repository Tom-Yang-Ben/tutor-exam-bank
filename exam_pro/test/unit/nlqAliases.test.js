// config/chapterAliases.js 的三條硬規則（docs/interfaces-stage3.md 第 6.2 條，P-07）
//
// 第 6.2 條逐字要求釘住三件事：
//   ① 所有值都過 isValidChapter；
//   ② 沒有重複鍵；
//   ③ 沒有別名是另一個別名的子字串卻對到不同章節（會讓「長的優先」規則產生歧義）。
//
// ② 特別容易漏測：JS 物件字面值遇到重複鍵是靜默覆寫，直接對成品物件數鍵數
// 永遠看不出少了一個。所以 chapterAliases.js 由「章節 → 別名陣列」組裝，
// 這裡拿 ALIAS_COUNT（陣列總長度）與實際鍵數對照。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CHAPTERS, isValidChapter } = require('../../config/chapters');
const aliases = require('../../config/chapterAliases');

describe('config/chapterAliases.js（第 6.2 條）', () => {
    test('① 每個值都是白名單章節', () => {
        for (const [alias, chapter] of Object.entries(aliases.CHAPTER_ALIASES)) {
            const subject = aliases.subjectOfChapter(chapter);
            assert.ok(subject, `別名「${alias}」對到的「${chapter}」不屬於任何一科`);
            assert.ok(isValidChapter(subject, chapter), `isValidChapter('${subject}', '${chapter}') 為 false`);
        }
    });

    test('② 沒有重複鍵（陣列總長度 === 物件鍵數）', () => {
        assert.deepEqual(aliases.DUPLICATE_ALIASES, [], '有別名被重複宣告，後宣告的那一個被靜默丟掉了');
        assert.equal(Object.keys(aliases.CHAPTER_ALIASES).length, aliases.ALIAS_COUNT);
    });

    test('③ 沒有跨章節的子字串別名', () => {
        const entries = Object.entries(aliases.CHAPTER_ALIASES);
        const bad = [];
        for (const [shortAlias, shortChapter] of entries) {
            for (const [longAlias, longChapter] of entries) {
                if (shortAlias === longAlias || shortChapter === longChapter) continue;
                if (longAlias.includes(shortAlias)) bad.push(`${shortAlias}(→${shortChapter}) ⊂ ${longAlias}(→${longChapter})`);
            }
        }
        assert.deepEqual(bad, []);
    });

    test('validateAliases() 是同一套規則，且目前全數通過', () => {
        assert.deepEqual(aliases.validateAliases(), []);
    });

    test('validateAliases() 真的抓得到違規（防止測試自己壞掉還全綠）', () => {
        // 值不在白名單
        assert.ok(aliases.validateAliases({ '亂寫': '不存在的章節' }).length > 0);
        // 跨章節的子字串
        const bad = aliases.validateAliases({ '內積': '向量內積', '空間內積': '空間向量內積' });
        assert.ok(bad.some(p => p.includes('子字串')), bad.join('\n'));
    });

    test('每個白名單章節至少 3 個口語別名', () => {
        const few = aliases.chaptersWithTooFewAliases(3);
        assert.deepEqual(few, [], `這些章節的別名不足 3 個：${few.map(f => f.chapter).join('、')}`);
    });

    test('66 個章節一個都沒漏', () => {
        const declared = Object.keys(aliases.ALIASES_BY_CHAPTER);
        const whitelist = Object.values(CHAPTERS).flat();
        assert.equal(whitelist.length, 66);
        assert.deepEqual([...declared].sort(), [...whitelist].sort());
    });

    test('第 6.2 條舉的兩個例子確實在表裡', () => {
        assert.equal(aliases.CHAPTER_ALIASES['牛頓第二定律'], '牛頓運動定律');
        assert.equal(aliases.CHAPTER_ALIASES['摩擦力'], '摩擦力與向心力');
    });

    test('別名不得等於「別章」的章節本名', () => {
        for (const [alias, chapter] of Object.entries(aliases.CHAPTER_ALIASES)) {
            const asChapter = aliases.subjectOfChapter(alias);
            assert.ok(!asChapter || alias === chapter,
                `別名「${alias}」本身就是章節名，卻對到「${chapter}」`);
        }
    });
});
