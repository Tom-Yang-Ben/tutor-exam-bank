// ─────────────────────────────────────────────────────────────
// test/unit/lib/recordedData.js — repo 內「錄好的資料」齊不齊（〔章節重整 CH-B〕）
//
// 有幾支單元測試直接拿 repo 內錄好的資料跑 eval 的 suite：
//   eval/fixtures/embeddings.<model>.<dim>.json（向量）、eval/cassettes/（LLM 回放）。
// 章節重整（docs/chapter-restructure.md 第 1 條）**刻意**讓其中一部分失效：
//   - fixture 改標後，embed_text 第一行的章名變了 → 那幾題的向量查不到；
//   - 章節白名單換了 → classify／extract／nlq／variant 的 schemaHash 變了 → cassette 查不到。
// 在 Owner 重錄（npm run cassettes:rerecord）之前，eval 與 e2e 會以 replay miss 紅燈——那才是該擋的地方。
// 單元測試在這段期間改成：
//   - 資料齊全：原本的斷言一條不少；
//   - 資料不齊：斷言 suite **以 miss 拒絕**（不拿假向量、假回應湊數字），依賴數字的斷言 skip 並指名缺什麼。
// 與 test/unit/cassetteReplay.test.js 的 extract 組「依現行樣卷算出預期的鍵、檔案不在就 skip」是同一條線：
// 重錄完就自動恢復執行，不必再改測試。
// ─────────────────────────────────────────────────────────────

const path = require('node:path');

const { loadFixture } = require('../../../eval/lib/fixtures');
const { loadEmbeddings } = require('../../../eval/lib/embeddings');

const RERECORD_HINT = '請 Owner 執行 npm run cassettes:rerecord 重錄（docs/chapter-restructure.md 第 5 條），錄好後這一則自動恢復執行';

/**
 * 公開 fixture 的每一題在向量檔裡都查得到嗎？
 * 向量檔整個不存在時照舊丟錯（那不是「待重錄」，是檔案不見了）。
 * @returns {{complete:boolean, missing:number[], file:string, reason:string|false}}
 *          reason：不齊時給 node:test 的 skip 字串；齊全時為 false
 */
function fixtureVectorGap() {
    const fixture = loadFixture();
    const emb = loadEmbeddings({ questions: fixture.questions });
    const complete = emb.missing.length === 0;
    return {
        complete,
        missing: emb.missing.slice(),
        file: emb.file,
        reason: complete ? false
            : `${path.basename(emb.file)} 缺 ${emb.missing.length} 題的向量（id：${emb.missing.join(', ')}；章節重整改標後 embed_text 變了）——${RERECORD_HINT}`
    };
}

module.exports = { fixtureVectorGap, RERECORD_HINT };
