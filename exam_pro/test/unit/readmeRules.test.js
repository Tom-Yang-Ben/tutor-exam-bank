// ─────────────────────────────────────────────────────────────
// test/unit/readmeRules.test.js — README 寫作規則的自動檢查（規則全文見 repo 根目錄 CLAUDE.md）
//
//   1. 根目錄 README.md 與 exam_pro/README.md 各不超過 200 行。
//   2. README 只寫現況：不得出現〔修訂…〕〔整合…〕〔審查…〕這類修訂註記（歷史寫到 docs/HANDOFF.md 或 commit 訊息）。
// ─────────────────────────────────────────────────────────────
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FILES = ['README.md', path.join('exam_pro', 'README.md')];
const MAX_LINES = 200;
const HISTORY_MARKER = /〔[^〕]*(修訂|整合|審查|更正|補充|合併回填|Owner\s*第|20\d\d-\d\d-\d\d)[^〕]*〕/;

describe('README 寫作規則（CLAUDE.md）', () => {
    for (const rel of FILES) {
        const file = path.join(REPO, rel);
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);

        test(`${rel} 不超過 ${MAX_LINES} 行`, () => {
            assert.ok(lines.length <= MAX_LINES, `${rel} 有 ${lines.length} 行，超過 ${MAX_LINES} 行：細節請移到 docs/，README 只留連結`);
        });

        test(`${rel} 沒有修訂歷史註記`, () => {
            const hits = lines
                .map((l, i) => ({ n: i + 1, l }))
                .filter(({ l }) => HISTORY_MARKER.test(l))
                .map(({ n, l }) => `第 ${n} 行：${l.trim().slice(0, 80)}`);
            assert.deepEqual(hits, [], `README 只寫現況，歷史請寫到 docs/HANDOFF.md 或 commit 訊息：\n${hits.join('\n')}`);
        });
    }

    test('檢查器本身抓得到違規（量尺自我檢查）', () => {
        assert.ok(HISTORY_MARKER.test('〔修訂 2026-09-26〕某段'));
        assert.ok(HISTORY_MARKER.test('〔整合 2026-09-26〕'));
        assert.ok(HISTORY_MARKER.test('〔Owner 第六輪 DA-11＝1〕'));
        assert.ok(!HISTORY_MARKER.test('**現況（2026-10）**：預設是本機模式'));
    });
});
