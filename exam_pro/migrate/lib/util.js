// ─────────────────────────────────────────────────────────────
// migrate/lib/util.js — 三支遷移腳本共用的小工具
//
// 一律走這裡的函式，不要在各腳本裡各寫一份：雜湊規則、JSONL 格式、
// 參數解析、路徑處理只要有一處不一致，verify.js 就會量到假的差異。
//
// Windows 注意事項（開發機是 Windows 11、專案路徑含中文）：
//   - 所有路徑先 path.resolve，再以 'utf8' 明確指定編碼讀寫。
//   - 檔案一律由 Node 寫（PowerShell 的 > 會塞 BOM，JSON.parse 會直接失敗）。
// ─────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 預設的匯出／匯入工作目錄（已在 .gitignore，內容可能含真實題目，不得進版控）。 */
const DEFAULT_OUT_DIR = path.resolve(__dirname, '..', 'out');

/**
 * 極簡參數解析：支援 --flag、--key=value、--key value。
 * @param {string[]} argv 通常是 process.argv.slice(2)
 * @returns {{ has(name: string): boolean, get(name: string, fallback?: string): string|undefined, rest: string[] }}
 */
function parseArgs(argv) {
    const map = new Map();
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { rest.push(a); continue; }
        const eq = a.indexOf('=');
        if (eq >= 0) { map.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { map.set(key, next); i++; }
        else map.set(key, true);
    }
    return {
        has: name => map.has(name),
        get: (name, fallback) => {
            const v = map.get(name);
            if (v === undefined || v === true) return v === true ? '' : fallback;
            return v;
        },
        rest
    };
}

/**
 * 解析 PostgreSQL 連線字串。--test 時讀 TEST_DATABASE_URL 並強制庫名以 _test 結尾
 * （與 migrate.js 同一條防呆：整合測試絕不能打到真題庫）。
 * @param {{ test?: boolean }} opts
 * @returns {string}
 */
function resolvePgUrl(opts) {
    if (opts && opts.test) {
        const url = process.env.TEST_DATABASE_URL;
        if (!url) throw new Error('缺少 TEST_DATABASE_URL');
        if (!/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL 的資料庫名必須以 _test 結尾');
        return url;
    }
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('缺少 DATABASE_URL（要打測試庫請加 --test）');
    return url;
}

/**
 * 逐列雜湊的唯一定義：sha256(question_text + answer_text)。
 * NULL 一律當空字串；MySQL 端與 PostgreSQL 端都用這一支，兩邊才比得起來。
 * @param {{ question_text?: string|null, answer_text?: string|null }} row
 * @returns {string} hex 小寫
 */
function rowHash(row) {
    const q = row.question_text === null || row.question_text === undefined ? '' : String(row.question_text);
    const a = row.answer_text === null || row.answer_text === undefined ? '' : String(row.answer_text);
    return sha256(q + a);
}

/**
 * @param {string} s
 * @returns {string} hex 小寫
 */
function sha256(s) {
    return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * 章節分佈鍵：`${subject}｜${chapter}`。用全形直線，避免與章節名裡可能出現的半形符號混淆。
 * @param {{subject: string, chapter: string}} row
 * @returns {string}
 */
function chapterKey(row) {
    return `${row.subject}｜${row.chapter}`;
}

/**
 * 統計章節分佈。
 * @param {Array<{subject: string, chapter: string}>} rows
 * @returns {Record<string, number>} 依鍵排序（輸出必須可重現）
 */
function countByChapter(rows) {
    const m = new Map();
    for (const r of rows) {
        const k = chapterKey(r);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * docx 元件樹的確定性序列化。
 *
 * buildParagraphComponents 回傳的是 docx 的 TextRun／Math 物件（有 rootKey／root／properties
 * 三個欄位的巢狀結構）。JSON.stringify 對它不穩定（鍵的順序取決於建構順序），
 * 所以這裡自己走一遍：鍵排序 + 帶上建構子名稱，讓「同輸入必得同字串」。
 * verify.js 的「隨機 20 題逐位元比對」就是比這個字串的 sha256。
 *
 * @param {any} value
 * @returns {string}
 */
function stableSerialize(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const t = typeof value;
    if (t === 'function') return 'fn';
    if (t !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
    const ctor = value.constructor && value.constructor.name ? value.constructor.name : '';
    const keys = Object.keys(value).sort();
    return ctor + '{' + keys.map(k => JSON.stringify(k) + ':' + stableSerialize(value[k])).join(',') + '}';
}

/**
 * 一題的 Word 產物指紋：題幹與答案各跑一次 buildParagraphComponents。
 * @param {{question_text?: string|null, answer_text?: string|null}} row
 * @param {(text: string, opts?: object) => any[]} buildParagraphComponents
 * @returns {{question: string, answer: string}} 兩個 sha256（hex 小寫）
 */
function docxFingerprint(row, buildParagraphComponents) {
    const q = row.question_text === null || row.question_text === undefined ? '' : String(row.question_text);
    const a = row.answer_text === null || row.answer_text === undefined ? '' : String(row.answer_text);
    return {
        question: sha256(stableSerialize(buildParagraphComponents(q))),
        answer: sha256(stableSerialize(buildParagraphComponents(a)))
    };
}

/**
 * 讀 JSONL（UTF-8、忽略空行）。
 * @param {string} file
 * @returns {any[]}
 */
function readJsonl(file) {
    const abs = path.resolve(file);
    const text = fs.readFileSync(abs, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        out.push(JSON.parse(s));
    }
    return out;
}

/**
 * 建立 JSONL 寫入器（逐批 append，不把整份資料留在記憶體）。
 * @param {string} file
 * @returns {{ write(obj: any): void, close(): void, count: number }}
 */
function openJsonlWriter(file) {
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const fd = fs.openSync(abs, 'w');
    const state = {
        count: 0,
        write(obj) {
            fs.writeSync(fd, JSON.stringify(obj) + '\n', null, 'utf8');
            state.count++;
        },
        close() { fs.closeSync(fd); }
    };
    return state;
}

/**
 * 寫 JSON 檔（UTF-8、兩格縮排、結尾換行）。一律由 Node 寫，不經 PowerShell 的 >。
 * @param {string} file
 * @param {any} data
 */
function writeJson(file, data) {
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * 讀 JSON 檔（UTF-8；容忍檔頭的 BOM，因為使用者可能不小心用 PowerShell 產過檔）。
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
    const abs = path.resolve(file);
    return JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
}

/**
 * 寫純文字檔（UTF-8）。
 * @param {string} file
 * @param {string} text
 */
function writeText(file, text) {
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
}

/**
 * 本地時區的 ISO 時間字串（不要用 toISOString()，那是 UTC，台灣早上 8 點前會差一天）。
 * @param {Date} [d]
 * @returns {string} 例如 2026-08-21T18:30:05+08:00
 */
function localIso(d) {
    const t = d || new Date();
    const p = n => String(n).padStart(2, '0');
    const off = -t.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T` +
        `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}` +
        `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/**
 * 檔名用的本地時間戳，例如 2026-08-21_1830。
 * @param {Date} [d]
 * @returns {string}
 */
function stampForFilename(d) {
    const t = d || new Date();
    const p = n => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}${p(t.getMinutes())}`;
}

/**
 * 把陣列切成固定大小的批次（給 unnest 批次寫入用）。
 * @param {any[]} arr
 * @param {number} size
 * @returns {any[][]}
 */
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

module.exports = {
    DEFAULT_OUT_DIR,
    parseArgs,
    resolvePgUrl,
    sha256,
    rowHash,
    chapterKey,
    countByChapter,
    stableSerialize,
    docxFingerprint,
    readJsonl,
    openJsonlWriter,
    writeJson,
    readJson,
    writeText,
    localIso,
    stampForFilename,
    chunk
};
