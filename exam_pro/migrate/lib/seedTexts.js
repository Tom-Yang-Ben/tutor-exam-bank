// ─────────────────────────────────────────────────────────────
// migrate/lib/seedTexts.js — 從 seed_questions.js 取出 30 題種子題的題幹
//
// 為什麼要用「抽出字面量再求值」而不是直接 require：
//   seed_questions.js 的結尾是一個立刻執行的 async IIFE，會 require('./config/db')
//   並嘗試連線資料庫。遷移腳本只想要那個純資料陣列，不能順便把 DB 連線拉起來。
//
// 抽出來的用途：import_pg.js 把題幹完全相同的題設成 origin='seed'、chapter_src='human'
// （這 30 題是自己編的示範題，章節是人工標的，不是 AI 猜的）。
// ─────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SEED_FILE = path.resolve(__dirname, '..', '..', 'seed_questions.js');
const MARKER = 'const QUESTIONS = ';

/**
 * 從 src 的 startIndex（必須指向 '['）開始，找出對應的 ']' 的索引。
 * 會跳過字串（'、"、`）與 // 行註解、/* 區塊註解裡的括號。
 * @param {string} src
 * @param {number} startIndex
 * @returns {number} 對應右括號的索引；找不到回 -1
 */
function matchBracket(src, startIndex) {
    let depth = 0;
    for (let i = startIndex; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { i++; continue; }
        if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) break;
                i++;
            }
            continue;
        }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/**
 * 讀出種子題陣列。
 * @param {string} [file] 預設 exam_pro/seed_questions.js
 * @returns {Array<{subject: string, chapter: string, question_type: string, difficulty: number,
 *                  question_text: string, answer_text: string}>}
 */
function loadSeedQuestions(file) {
    const abs = path.resolve(file || SEED_FILE);
    if (!fs.existsSync(abs)) return [];
    const src = fs.readFileSync(abs, 'utf8');
    const at = src.indexOf(MARKER);
    if (at < 0) return [];
    const open = src.indexOf('[', at + MARKER.length);
    if (open < 0) return [];
    const close = matchBracket(src, open);
    if (close < 0) return [];
    const literal = src.slice(open, close + 1);
    // 純資料字面量，在空的 context 裡求值：沒有 require、沒有 process、沒有 I/O
    const value = vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 2000 });
    return Array.isArray(value) ? value : [];
}

/**
 * 種子題的題幹清單（去重、去空）。import_pg.js 拿它比對 questions.question_text。
 * @param {string} [file]
 * @returns {string[]}
 */
function loadSeedTexts(file) {
    const seen = new Set();
    for (const q of loadSeedQuestions(file)) {
        if (q && typeof q.question_text === 'string' && q.question_text.trim()) seen.add(q.question_text);
    }
    return [...seen];
}

module.exports = { SEED_FILE, loadSeedQuestions, loadSeedTexts, matchBracket };
