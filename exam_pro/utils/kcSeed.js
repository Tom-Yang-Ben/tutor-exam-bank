// ─────────────────────────────────────────────────────────────
// utils/kcSeed.js — 知識點種子檔（config/kc/<科目>.json）的驗證（純函式）
//
// 格式與規則凍結於 docs/interfaces-stage5.md 第 3.4 條。本檔只驗證、不碰 DB：
//   - scripts/validate_kc_seed.js（CLI）與 WS-C 的載入腳本共用這一份規則；
//   - 知識點內容組（KC-M／KC-P／KC-C）寫完種子檔後先跑 CLI，零 error 才算交付。
//
// errors：違反契約，載入腳本必須拒絕；warnings：可以載入但值得人看一眼
// （例如先備指向另一科、而那一科的種子檔這次沒有一起驗證）。
// ─────────────────────────────────────────────────────────────

const SUBJECT_PREFIX = { '數學': 'MATH', '物理': 'PHYS', '化學': 'CHEM' };
const PREFIX_SUBJECT = Object.fromEntries(Object.entries(SUBJECT_PREFIX).map(([s, p]) => [p, s]));
const CODE_RE = /^(MATH|PHYS|CHEM)\.([^.\s]+)\.(\d{2})$/;
const LIMITS = {
    perChapterMin: 3,
    perChapterMax: 8,
    nameMax: 30,
    descriptionMax: 200,
    spokenMin: 40,
    spokenMax: 300,
    curriculumCodeMax: 40
};
const STATUSES = ['draft', 'approved'];

/**
 * 章節白名單：化學尚未併入 config/chapters.js 時，退回 config/chemistryChapters.js。
 * @returns {Record<string,string[]>}
 */
function defaultChapters() {
    const { CHAPTERS } = require('../config/chapters');
    const out = { ...CHAPTERS };
    if (!out['化學']) out['化學'] = require('../config/chemistryChapters').CHEMISTRY_CHAPTERS;
    return out;
}

/**
 * 驗證一份或多份種子檔。多份一起驗證時，先備關係跨檔解析並檢查環。
 * @param {object[]} seeds 已 JSON.parse 的種子檔
 * @param {{chapters?: Record<string,string[]>}} [opts]
 * @returns {{errors:string[], warnings:string[], stats:object}}
 */
function validateSeeds(seeds, opts = {}) {
    const chapters = opts.chapters || defaultChapters();
    const errors = [];
    const warnings = [];
    const byCode = new Map();
    const loadedSubjects = new Set();
    const stats = {};

    for (const seed of seeds) {
        const subject = seed && seed.subject;
        const where = `[${subject ?? '?'}]`;
        if (!SUBJECT_PREFIX[subject]) { errors.push(`${where} subject 必須是 數學／物理／化學`); continue; }
        if (loadedSubjects.has(subject)) { errors.push(`${where} 同一科出現兩份種子檔`); continue; }
        loadedSubjects.add(subject);
        if (!Array.isArray(seed.components)) { errors.push(`${where} components 必須是陣列`); continue; }

        const chapterList = chapters[subject] || [];
        const perChapter = new Map(chapterList.map(c => [c, 0]));
        const names = new Set();
        let approved = 0;

        seed.components.forEach((kc, i) => {
            const at = `${where} components[${i}]${kc && kc.code ? `（${kc.code}）` : ''}`;
            if (!kc || typeof kc !== 'object') { errors.push(`${at} 不是物件`); return; }
            const m = CODE_RE.exec(String(kc.code || ''));
            if (!m) { errors.push(`${at} code 格式必須是 MATH|PHYS|CHEM.<章名>.<兩位序號>`); return; }
            if (PREFIX_SUBJECT[m[1]] !== subject) errors.push(`${at} code 前綴與 subject 不符`);
            if (m[2] !== kc.chapter) errors.push(`${at} code 中的章名必須等於 chapter`);
            if (byCode.has(kc.code)) errors.push(`${at} code 重複`);
            byCode.set(kc.code, { subject, prereqs: Array.isArray(kc.prereqs) ? kc.prereqs : [] });

            if (!perChapter.has(kc.chapter)) errors.push(`${at} chapter「${kc.chapter}」不在${subject}章節白名單內`);
            else perChapter.set(kc.chapter, perChapter.get(kc.chapter) + 1);

            const name = typeof kc.name === 'string' ? kc.name.trim() : '';
            if (!name || name.length > LIMITS.nameMax) errors.push(`${at} name 必須是 1–${LIMITS.nameMax} 字`);
            const nameKey = `${kc.chapter}\u0000${name}`;
            if (names.has(nameKey)) errors.push(`${at} 同一章內 name 重複`);
            names.add(nameKey);

            const desc = typeof kc.description === 'string' ? kc.description.trim() : '';
            if (!desc || desc.length > LIMITS.descriptionMax) errors.push(`${at} description 必須是 1–${LIMITS.descriptionMax} 字`);

            const spoken = typeof kc.spoken_text === 'string' ? kc.spoken_text.trim() : '';
            if (spoken.length < LIMITS.spokenMin || spoken.length > LIMITS.spokenMax) {
                errors.push(`${at} spoken_text 必須是 ${LIMITS.spokenMin}–${LIMITS.spokenMax} 字（目前 ${spoken.length}）`);
            }
            if (/\$|\\[a-zA-Z]+/.test(spoken)) errors.push(`${at} spoken_text 不可含 LaTeX（要能直接唸出來）`);

            if (kc.curriculum_code !== null && kc.curriculum_code !== undefined &&
                (typeof kc.curriculum_code !== 'string' || !kc.curriculum_code.trim() || kc.curriculum_code.length > LIMITS.curriculumCodeMax)) {
                errors.push(`${at} curriculum_code 必須是 null 或 1–${LIMITS.curriculumCodeMax} 字字串`);
            }
            if (!STATUSES.includes(kc.status)) errors.push(`${at} status 必須是 draft 或 approved`);
            if (kc.status === 'approved') approved++;
            if (!Number.isInteger(kc.sort) || kc.sort < 1) errors.push(`${at} sort 必須是正整數`);
            if (kc.prereqs !== undefined && !Array.isArray(kc.prereqs)) errors.push(`${at} prereqs 必須是陣列`);
            if (Array.isArray(kc.prereqs) && kc.prereqs.includes(kc.code)) errors.push(`${at} prereqs 不可包含自己`);
        });

        for (const [chapter, n] of perChapter) {
            if (n < LIMITS.perChapterMin || n > LIMITS.perChapterMax) {
                errors.push(`${where} 章「${chapter}」有 ${n} 個知識點，必須是 ${LIMITS.perChapterMin}–${LIMITS.perChapterMax} 個`);
            }
        }
        stats[subject] = { components: seed.components.length, chapters: perChapter.size, approved };
    }

    // 先備關係解析：同批載入的科目解析不到 → error；指向沒載入的科目 → warning
    for (const [code, info] of byCode) {
        for (const pre of info.prereqs) {
            if (byCode.has(pre)) continue;
            const m = CODE_RE.exec(String(pre));
            if (m && !loadedSubjects.has(PREFIX_SUBJECT[m[1]])) warnings.push(`${code} 的先備 ${pre} 屬於這次沒有驗證的科目`);
            else errors.push(`${code} 的先備 ${pre} 不存在`);
        }
    }

    // 環檢查（DFS，三色標記）
    const color = new Map();
    const cycles = [];
    function visit(code, stack) {
        color.set(code, 1);
        for (const pre of (byCode.get(code)?.prereqs || [])) {
            if (!byCode.has(pre)) continue;
            const c = color.get(pre) || 0;
            if (c === 1) { cycles.push([...stack, code, pre].join(' → ')); continue; }
            if (c === 0) visit(pre, [...stack, code]);
        }
        color.set(code, 2);
    }
    for (const code of byCode.keys()) if (!color.get(code)) visit(code, []);
    for (const c of cycles.slice(0, 20)) errors.push(`先備關係有環：${c}`);

    return { errors, warnings, stats };
}

// ── 階段 5 WS-C 新增（docs/interfaces-stage5.md 第 4.3 條；只新增，上面的規則一個字都沒動）──
//
// 單一欄位的檢查：PATCH /api/kc/:id 要套「長度規則同第 3.4 條」，但它一次只改幾個欄位，
// 不能整份種子檔丟進 validateSeeds。這裡把第 3.4 條的欄位規則拆成逐欄的函式，
// 數字一律讀上面同一份 LIMITS／STATUSES（不另抄一份）。
// LaTeX 偵測的 regex 與 validateSeeds 內的那一條逐字相同；test/unit/kcService.test.js
// 拿同一組樣本同時餵兩邊，確認兩者判定一致（不會出現「種子檔擋、API 放」的落差）。

/** spoken_text 不可含 LaTeX（與 validateSeeds 內的 regex 逐字相同） */
const LATEX_RE = /\$|\\[a-zA-Z]+/;

/** PATCH 可以改的欄位（第 4.3 條第 2 點） */
const EDITABLE_FIELDS = ['name', 'description', 'spoken_text', 'curriculum_code', 'status'];

/**
 * 檢查單一欄位是否符合第 3.4 條。字串會先 trim 再量長度（與 validateSeeds 相同）。
 * @param {'name'|'description'|'spoken_text'|'curriculum_code'|'status'} field
 * @param {any} value
 * @returns {string|null} 違規時回錯誤訊息（繁中），合法回 null
 */
function checkKcField(field, value) {
    const str = typeof value === 'string' ? value.trim() : null;
    switch (field) {
        case 'name':
            if (str === null || !str || str.length > LIMITS.nameMax) return `name 必須是 1–${LIMITS.nameMax} 字`;
            return null;
        case 'description':
            if (str === null || !str || str.length > LIMITS.descriptionMax) return `description 必須是 1–${LIMITS.descriptionMax} 字`;
            return null;
        case 'spoken_text':
            if (str === null || str.length < LIMITS.spokenMin || str.length > LIMITS.spokenMax) {
                return `spoken_text 必須是 ${LIMITS.spokenMin}–${LIMITS.spokenMax} 字（目前 ${str === null ? 0 : str.length}）`;
            }
            if (LATEX_RE.test(str)) return 'spoken_text 不可含 LaTeX（要能直接唸出來）';
            return null;
        case 'curriculum_code':
            if (value === null) return null;
            if (str === null || !str || value.length > LIMITS.curriculumCodeMax) {
                return `curriculum_code 必須是 null 或 1–${LIMITS.curriculumCodeMax} 字字串`;
            }
            return null;
        case 'status':
            return STATUSES.includes(value) ? null : 'status 必須是 draft 或 approved';
        default:
            return `不認得的欄位 ${field}`;
    }
}

/**
 * 由 code 推回科目與章名（code 格式不合時回 null）。
 * 跨科先備解析、前端標示「跨科」都用這支，不各自切字串。
 * @param {string} code
 * @returns {{subject:string, chapter:string, seq:number}|null}
 */
function parseKcCode(code) {
    const m = CODE_RE.exec(String(code ?? ''));
    if (!m) return null;
    return { subject: PREFIX_SUBJECT[m[1]], chapter: m[2], seq: Number(m[3]) };
}

module.exports = {
    validateSeeds, SUBJECT_PREFIX, CODE_RE, LIMITS, STATUSES,
    // 階段 5 WS-C 新增的匯出
    defaultChapters, LATEX_RE, EDITABLE_FIELDS, checkKcField, parseKcCode
};
