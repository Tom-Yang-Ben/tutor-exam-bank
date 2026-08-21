// replay miss 的辨識與 fork PR 降級（介面第 5.2 條、裁決 S2-14）
//
// 第 5.2 條把判斷留給 WS-D：「fork PR 由 CI（WS-D）判斷後降為 warning，
// **這個判斷不在 services/llm 裡**」。這一支釘的就是那個判斷。
//
// 裁決 S2-14 的重點是**比對只到 `--suite ` 為止**：`<suite>` 由 services/llm 保持字面
// 不代換，後面還可以再接一行預期路徑。拿整串去比，會讓「多印一行有用的提示」
// 變成一個破壞性改動——這裡的測試就是要保證不會變成那樣。

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rm = require('../../eval/lib/replayMiss');

// 第 5.2 條凍結訊息的完整長相（services/llm/fake.js 實際會丟的那一串）
const REAL_MISS =
    'LLM_MODE=replay 找不到 cassette（agent=classify key=3f2a8c1d）。請在本機執行 npm run eval:record -- --suite <suite>' +
    '\n（預期路徑：eval/cassettes/classify/3f2a8c1d.json）';

describe('isReplayMiss（裁決 S2-14：只比到 --suite 為止）', () => {
    test('認得出實作端真正丟的那一串', () => {
        assert.equal(rm.isReplayMiss(new Error(REAL_MISS)), true);
        assert.equal(rm.isReplayMiss(REAL_MISS), true);
    });

    test('`--suite ` 之後接什麼都不影響判定', () => {
        const base = 'LLM_MODE=replay 找不到 cassette（agent=x key=y）。請在本機執行 npm run eval:record -- --suite ';
        for (const tail of ['<suite>', 'classify', 'pipeline', 'all', '', '\n（預期路徑：a/b.json）', '\n任何未來新增的說明']) {
            assert.equal(rm.isReplayMiss(base + tail), true, JSON.stringify(tail));
        }
    });

    test('agent 與 key 換成什麼都不影響判定（訊息中段不是比對對象）', () => {
        const msg = 'LLM_MODE=replay 找不到 cassette（agent=extract key=deadbeefcafe）。請在本機執行 npm run eval:record -- --suite pipeline';
        assert.equal(rm.isReplayMiss(msg), true);
    });

    test('其他錯誤不會被誤判成 replay miss', () => {
        const others = [
            'cassette 缺少 response.data：eval/cassettes/classify/abc.json',
            'LLM_MODE 只能是 live / record / replay，收到「bogus」。',
            '找不到 cassette',                                   // 缺前綴的 LLM_MODE=replay
            'LLM_MODE=replay 找不到 cassette（agent=x key=y）。',   // 缺 --suite 標記
            '',
            null,
            undefined
        ];
        for (const o of others) assert.equal(rm.isReplayMiss(o), false, JSON.stringify(o));
    });

    test('前綴常數與 services/llm/fake.js 的實際字串一致', () => {
        // 這一條是跨 workstream 的契約檢查：WS-B 若改了訊息開頭，這裡會第一個轉紅，
        // 而不是等到某次 fork PR 的 miss 沒有被降級才發現。
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'services', 'llm', 'fake.js'), 'utf8');
        assert.ok(src.includes(rm.REPLAY_MISS_PREFIX), `fake.js 找不到前綴「${rm.REPLAY_MISS_PREFIX}」`);
        assert.ok(src.includes(rm.REPLAY_MISS_SUITE_MARKER), `fake.js 找不到標記「${rm.REPLAY_MISS_SUITE_MARKER}」`);
    });
});

describe('parseReplayMiss', () => {
    test('撈得出 agent 與 key', () => {
        assert.deepEqual(rm.parseReplayMiss(REAL_MISS), { agent: 'classify', key: '3f2a8c1d' });
    });

    test('撈不到時回 null，不拋例外（中段不是凍結的比對對象）', () => {
        assert.deepEqual(rm.parseReplayMiss('LLM_MODE=replay 找不到 cassette。請在本機執行 npm run eval:record -- --suite x'),
            { agent: null, key: null });
    });
});

describe('shouldDowngradeMiss（fork PR 才降級）', () => {
    const saved = process.env.EVAL_FORK_PR;
    afterEach(() => {
        if (saved === undefined) delete process.env.EVAL_FORK_PR;
        else process.env.EVAL_FORK_PR = saved;
    });

    test('未設定時不降級——本機跑出 miss 就是真的少錄了 cassette', () => {
        delete process.env.EVAL_FORK_PR;
        assert.equal(rm.shouldDowngradeMiss(), false);
    });

    test('只有 true／1 才降級，false／空字串都不降級', () => {
        const table = [['true', true], ['TRUE', true], ['1', true], ['false', false], ['0', false], ['', false]];
        for (const [value, want] of table) {
            process.env.EVAL_FORK_PR = value;
            assert.equal(rm.shouldDowngradeMiss(), want, `EVAL_FORK_PR=${JSON.stringify(value)}`);
        }
    });

    test('解讀規則與後端 config/features.js 的 parseBool 一致', () => {
        const { parseBool } = require('../../config/features');
        for (const v of ['true', '1', 'false', '0', 'yes', 'on', '']) {
            process.env.EVAL_FORK_PR = v;
            assert.equal(rm.shouldDowngradeMiss(), parseBool(v), v);
        }
    });

    test('ci.yml 有把 fork 這個事實傳進來', () => {
        // 少了這一行，fork PR 的降級永遠不會發生，而且完全沒有症狀。
        const yml = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
        assert.match(yml, /EVAL_FORK_PR:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.fork\s*\}\}/);
    });
});

describe('partitionFailures', () => {
    test('把 replay miss 與其他失敗分開', () => {
        const { misses, others } = rm.partitionFailures([REAL_MISS, '章節不在白名單', REAL_MISS]);
        assert.equal(misses.length, 2);
        assert.deepEqual(others, ['章節不在白名單']);
    });

    test('空輸入回兩個空陣列', () => {
        assert.deepEqual(rm.partitionFailures(), { misses: [], others: [] });
        assert.deepEqual(rm.partitionFailures([]), { misses: [], others: [] });
    });
});
