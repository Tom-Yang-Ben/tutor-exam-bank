// ─────────────────────────────────────────────────────────────
// migrate/lib/normalize.js — 姓名正規化與合併報告（D-D5a）
//
// 純函式模組：無 I/O、無隨機、無時間，可直接 node --test。
//
// 為什麼需要這支：
//   舊 MySQL 有兩個姓名來源，而且規則不一致（規劃 §2.2、§5.3.6）：
//     1. questions.history_json 的「鍵」  = safeStudentName（examController.js:23，trim 後再去掉 " 與 \）
//     2. exam_papers.student_name        = trimmedName    （examController.js:22,75，只有 trim）
//   例如學生叫『王"小明』時，history 的鍵是「王小明」、試卷上存的是「王"小明」，
//   兩邊指的是同一個人卻是兩個字串。PostgreSQL 的 students.name 有 UNIQUE，
//   匯入時必須先把兩邊收斂到同一條規則，否則會生出兩個學生、attempts 掛錯人。
//
// 收斂規則（全案唯一，PG 端的等價 SQL 見 pgNormalizeSql）：
//     trim → 去掉所有 " 與 \ → 再 trim 一次
//   最後那次 trim 不能省：『" 王小明 "』先 trim 只會削掉外層空白，
//   去掉引號後又會露出新的前後空白。
//
// 刻意不做的事（誠實說明，不要在這裡「順手」加）：
//   - 不做全形／半形轉換，不刪除全形空白（U+3000）。
//     「王 小明」與「王　小明」是不是同一個人，只有老師知道；
//     自動合併會靜默地把兩個學生的作答歷史攪在一起，代價比多一列學生大得多。
//     這類情況一律進 report.suspects，由人看過再決定（呼應規劃 §2.3.4 的誠實說明）。
//   - 不做大小寫轉換（中文無此問題；英文名字大小寫不同通常真的是不同寫法）。
// ─────────────────────────────────────────────────────────────

'use strict';

/** 會被移除的危險字元：雙引號與反斜線（舊碼拿姓名當 JSON 路徑用，見 examController.js:23）。 */
const STRIPPED_CHARS = ['"', '\\'];

/**
 * 姓名正規化：trim → 去 " 與 \ → 再 trim。
 * @param {unknown} raw 任何值；null／undefined／非字串都不會拋例外
 * @returns {string} 正規化後的姓名；完全空白或只由 " \ 組成時回空字串
 */
function normalizeName(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw).trim().replace(/["\\]/g, '').trim();
}

/**
 * PostgreSQL 端的等價寫法。import_pg.js 在 PG 內展開 history_json 時用它，
 * 並且會在同一支腳本裡把「JS 算的」與「SQL 算的」逐筆比對，兩邊不一致就中止匯入
 * （這條規則不得不寫兩次，那個自我檢查就是釘住它的測試）。
 *
 * 用 chr(92) 而不是字面的反斜線，是為了不依賴連線的 standard_conforming_strings 設定。
 *
 * @param {string} expr 任何 text 型別的 SQL 運算式，例如 'e.key' 或 '$1'
 * @returns {string} SQL 片段
 */
function pgNormalizeSql(expr) {
    return `btrim(translate(btrim(${expr}), '"' || chr(92), ''))`;
}

/**
 * 疑似同一人的比較鍵：NFKC 正規化（全形→半形）後移除所有空白（含 U+3000）。
 * 只用來「提示」，不用來合併。
 * @param {string} name 已經過 normalizeName 的姓名
 * @returns {string}
 */
function suspectKey(name) {
    return String(name).normalize('NFKC').replace(/[\s\u3000]+/g, '');
}

/**
 * history_json 可能是物件（mysql2 的 JSON 欄位）或字串（更舊的 TEXT 欄位）；壞資料一律當空物件。
 * @param {any} value
 * @returns {Record<string, any>}
 */
function parseHistory(value) {
    if (value === null || value === undefined || value === '') return {};
    let v = value;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (e) { return {}; }
    }
    if (typeof v !== 'object' || Array.isArray(v)) return {};
    return v;
}

/**
 * 把 questions 的列攤平成 buildMergeReport 需要的 historyKeys。
 * @param {Array<{id: number, history_json: any}>} rows
 * @returns {Array<{name: string, questionId: number, date: string}>}
 */
function flattenHistory(rows) {
    const out = [];
    for (const row of rows || []) {
        const h = parseHistory(row.history_json);
        for (const key of Object.keys(h)) {
            const v = h[key];
            out.push({ name: key, questionId: row.id, date: v === null || v === undefined ? '' : String(v) });
        }
    }
    return out;
}

/**
 * 建立姓名合併報告。
 *
 * @param {{
 *   historyKeys?: Array<{ name: string, questionId: number, date?: string }>,
 *   paperNames?: Array<{ name: string, paperId: number }>
 * }} input
 *   historyKeys 是把每一列 questions.history_json 攤平後的結果（一個鍵一筆，見 flattenHistory）；
 *   paperNames 是每一列 exam_papers 的 student_name（一列一筆）。
 * @returns {object} 見下方各欄位的 JSDoc
 */
function buildMergeReport(input) {
    const historyKeys = (input && input.historyKeys) || [];
    const paperNames = (input && input.paperNames) || [];

    const byName = new Map();
    const dropped = { historyKeys: [], paperNames: [] };

    function touch(name) {
        let e = byName.get(name);
        if (!e) { e = { name, raws: new Map(), historyCount: 0, paperCount: 0 }; byName.set(name, e); }
        return e;
    }
    function touchRaw(entry, raw) {
        let r = entry.raws.get(raw);
        if (!r) { r = { history: 0, paper: 0 }; entry.raws.set(raw, r); }
        return r;
    }

    // 1. history_json 的鍵。同一題同一學生只會產生一列 attempts（UNIQUE(student_id, question_id)），
    //    所以順便把「正規化後在同一題撞在一起」的鍵挑出來。
    const perQuestion = new Map();
    for (const item of historyKeys) {
        const raw = item.name === null || item.name === undefined ? '' : String(item.name);
        const name = normalizeName(raw);
        if (!name) { dropped.historyKeys.push({ raw, questionId: item.questionId }); continue; }
        const entry = touch(name);
        touchRaw(entry, raw).history += 1;
        entry.historyCount += 1;

        const pairKey = `${name}\u0000${item.questionId}`;
        const list = perQuestion.get(pairKey) || [];
        list.push({ raw, date: item.date === undefined || item.date === null ? '' : String(item.date) });
        perQuestion.set(pairKey, list);
    }

    // 2. exam_papers.student_name
    for (const item of paperNames) {
        const raw = item.name === null || item.name === undefined ? '' : String(item.name);
        const name = normalizeName(raw);
        if (!name) { dropped.paperNames.push({ raw, paperId: item.paperId }); continue; }
        const entry = touch(name);
        touchRaw(entry, raw).paper += 1;
        entry.paperCount += 1;
    }

    // 3. 同一題同一學生的多重鍵 → 只能留一列 attempts，留最早的日期
    //    （與 import_pg.js 的 DISTINCT ON (student_id, question_id) ORDER BY assigned_at 一致）
    const collisions = [];
    for (const [pairKey, entries] of perQuestion) {
        if (entries.length < 2) continue;
        const sep = pairKey.indexOf('\u0000');
        const name = pairKey.slice(0, sep);
        const qid = pairKey.slice(sep + 1);
        const sorted = entries.slice().sort((a, b) => (
            a.date < b.date ? -1 : a.date > b.date ? 1 : (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0)
        ));
        collisions.push({ name, questionId: Number(qid), entries: sorted, kept: sorted[0].date });
    }
    collisions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.questionId - b.questionId));

    // 4. 正規化後同名、但原始字串不只一種 → 需要老師確認的合併
    const students = [...byName.values()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(e => ({
            name: e.name,
            historyCount: e.historyCount,
            paperCount: e.paperCount,
            rawForms: [...e.raws.entries()]
                .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
                .map(([raw, c]) => ({ raw, history: c.history, paper: c.paper }))
        }));
    const merges = students.filter(s => s.rawForms.length > 1).map(s => ({ name: s.name, rawForms: s.rawForms }));

    // 5. 疑似同一人（只提示不合併）
    const bySuspect = new Map();
    for (const s of students) {
        const k = suspectKey(s.name);
        const list = bySuspect.get(k) || [];
        list.push(s.name);
        bySuspect.set(k, list);
    }
    const suspects = [...bySuspect.entries()]
        .filter(([, names]) => names.length > 1)
        .map(([key, names]) => ({ key, names }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    return {
        students,
        merges,
        dropped,
        collisions,
        suspects,
        totals: {
            historyKeys: historyKeys.length,
            historyKeysDropped: dropped.historyKeys.length,
            // 匯入後 attempts 應有的筆數 = 去重後的 (學生, 題目) 配對數
            attemptsExpected: perQuestion.size,
            students: students.length,
            papers: paperNames.length,
            papersDropped: dropped.paperNames.length
        }
    };
}

/**
 * 把報告轉成人看的 Markdown（給老師確認用；檔案由呼叫端負責寫）。
 * @param {object} report buildMergeReport 的輸出
 * @param {{title?: string, generatedAt?: string}} [opts] generatedAt 由呼叫端傳，本模組不碰時間
 * @returns {string}
 */
function renderMergeReport(report, opts) {
    const o = opts || {};
    const L = [];
    L.push(`# ${o.title || '姓名合併報告（MySQL → PostgreSQL）'}`);
    L.push('');
    if (o.generatedAt) { L.push(`產生時間：${o.generatedAt}`); L.push(''); }
    L.push('正規化規則：`trim` → 去掉所有 `"` 與 `\\` → 再 `trim`。全形空白與異體字**不會**自動合併。');
    L.push('');
    L.push('## 總計');
    L.push('');
    L.push('| 項目 | 數量 |');
    L.push('|---|---|');
    L.push(`| history_json 鍵總數 | ${report.totals.historyKeys} |`);
    L.push(`| 正規化後為空、被丟棄的鍵 | ${report.totals.historyKeysDropped} |`);
    L.push(`| 匯入後 attempts 應有筆數（去重後的「學生×題目」配對） | ${report.totals.attemptsExpected} |`);
    L.push(`| 學生數（students 應有筆數） | ${report.totals.students} |`);
    L.push(`| exam_papers 列數 | ${report.totals.papers} |`);
    L.push(`| 姓名正規化後為空、無法建立 student_id 的試卷 | ${report.totals.papersDropped} |`);
    L.push('');

    L.push('## 需要人工確認：正規化後合併的姓名');
    L.push('');
    if (report.merges.length === 0) {
        L.push('（無。兩邊姓名字串本來就一致。）');
    } else {
        L.push('| 合併後 | 原始字串（history 次數 / 試卷次數） |');
        L.push('|---|---|');
        for (const m of report.merges) {
            const forms = m.rawForms.map(f => `\`${f.raw}\`（${f.history} / ${f.paper}）`).join('、');
            L.push(`| ${m.name} | ${forms} |`);
        }
    }
    L.push('');

    L.push('## 需要人工確認：疑似同一人（**不會**自動合併）');
    L.push('');
    if (report.suspects.length === 0) {
        L.push('（無。）');
    } else {
        L.push('去掉全形／半形差異與所有空白後字串相同。若確實是同一人，請在切換前先到舊 MySQL 改成一致的寫法再重跑匯入。');
        L.push('');
        L.push('| 比較鍵 | 目前會各自建一列 students |');
        L.push('|---|---|');
        for (const s of report.suspects) L.push(`| \`${s.key}\` | ${s.names.map(n => `\`${n}\``).join('、')} |`);
    }
    L.push('');

    L.push('## 資料損失：正規化後為空的姓名');
    L.push('');
    if (report.dropped.historyKeys.length === 0 && report.dropped.paperNames.length === 0) {
        L.push('（無。）');
    } else {
        for (const d of report.dropped.historyKeys) {
            L.push(`- questions.id=${d.questionId} 的 history 鍵 \`${d.raw}\` 正規化後為空 → 不會產生 attempts`);
        }
        for (const d of report.dropped.paperNames) {
            L.push(`- exam_papers.id=${d.paperId} 的 student_name \`${d.raw}\` 正規化後為空 → **無法匯入**（student_id 是 NOT NULL）`);
        }
    }
    L.push('');

    L.push('## 同一題出現多個鍵指向同一位學生（只會留一列 attempts）');
    L.push('');
    if (report.collisions.length === 0) {
        L.push('（無。）');
    } else {
        L.push('`UNIQUE (student_id, question_id)` 是硬約束，重複的鍵只能留一列，取**最早**的日期。');
        L.push('');
        L.push('| 學生 | question_id | 原始鍵與日期 | 保留的 assigned_at |');
        L.push('|---|---|---|---|');
        for (const c of report.collisions) {
            const entries = c.entries.map(e => `\`${e.raw}\`=${e.date}`).join('、');
            L.push(`| ${c.name} | ${c.questionId} | ${entries} | ${c.kept} |`);
        }
    }
    L.push('');

    L.push('## 全部學生');
    L.push('');
    L.push('| 姓名 | history 鍵次數 | 試卷次數 | 原始字串 |');
    L.push('|---|---|---|---|');
    for (const s of report.students) {
        L.push(`| ${s.name} | ${s.historyCount} | ${s.paperCount} | ${s.rawForms.map(f => `\`${f.raw}\``).join('、')} |`);
    }
    L.push('');
    return L.join('\n');
}

module.exports = {
    STRIPPED_CHARS,
    normalizeName,
    pgNormalizeSql,
    suspectKey,
    parseHistory,
    flattenHistory,
    buildMergeReport,
    renderMergeReport
};
