// test/fixtures/planChapters.preload.js — 以 config/chapterPlan.js 的定案清單模擬「CH-A 合入後」的
// config/chapters.js（〔章節重整 CH-B〕，只給測試用：node --require 本檔 …）。
//
// 為什麼需要：utils/nlqHeuristics.js 等模組在載入時就從 config/chapters.js 建好章名表，
// 單元測試沒辦法事後注入。CH-A 合入之前，本分支的 config/chapters.js 還是舊白名單；
// 用這支 preload 在子行程裡把數學／物理換成 PLAN_VOLUMES，就能驗證 golden 在新白名單下的解析結果。
// CH-A 合入之後，換上去的值與 config/chapters.js 原本的值逐字相同，這支 preload 等於沒做事。
//
// 就地修改匯出的物件（VOLUMES、CHAPTERS 是模組內 const 參照的同一個物件，isValidChapter 會跟著變），
// LEGACY_CHAPTERS 是凍結陣列，改成換掉匯出屬性——之後才 require 的模組解構到的就是新值。

const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const chapters = require(path.join(APP_DIR, 'config', 'chapters'));
const { PLAN_VOLUMES, PLAN_CHAPTERS } = require(path.join(APP_DIR, 'config', 'chapterPlan'));

for (const subject of ['數學', '物理']) {
    chapters.VOLUMES[subject].splice(0, chapters.VOLUMES[subject].length, ...PLAN_VOLUMES[subject]);
    chapters.CHAPTERS[subject] = PLAN_CHAPTERS[subject].slice();
}
chapters.LEGACY_CHAPTERS = Object.freeze(chapters.LEGACY_SUBJECTS.flatMap(s => PLAN_CHAPTERS[s]));
