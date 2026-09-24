// ─────────────────────────────────────────────────────────────
// eval/record_embeddings.js — D-V0：對公開 fixture 錄一次向量
//
// 用法（**只在本機、由開發者本人執行**，需要 GEMINI_API_KEY）：
//   npm run eval:record
//   node eval/record_embeddings.js --dry-run     只印會送出幾題、花多少字，不呼叫 API
//   node eval/record_embeddings.js --only-missing 只錄向量檔裡還沒有的題（章節重整後改標的題；
//                                                 npm run cassettes:rerecord 的第一步就是這一行）
//
// 輸出：eval/fixtures/embeddings.<model>.<dim>.json
//   格式凍結於 docs/interfaces-stage1.md 第 4 條：{ "<sha256(embed_text)>": [ … dim 個小數 6 位 … ] }
//
// CI **永遠只讀這個檔**（EMBED_MODE=fixture），不呼叫 Gemini、不需要任何 secret。
// 這是「CI 仍零 secrets，任何人 fork 都跑得出同一張表」這條性質的來源。
//
// 〔章節重整 CH-B〕寫檔改成「併入」既有的向量檔（鍵依字典序，與 services/llm/fixture.js 的
// saveToFixture 同一個格式）：這個檔裡除了 fixture 的題（61 題），還有 nlq 查詢句、variant 生成題、
// e2e 樣卷題的向量（各自由 EMBED_MODE=record 的 suite 補錄）。原本整檔覆寫只留 fixture 的題，
// 照錯誤訊息「請執行 npm run eval:record」重錄一次就會把那些向量全部洗掉。
// 代價：併入只增不減，改標前舊 embed_text 的向量會留在檔裡、沒有任何 suite 會再讀到（只是多佔空間，
// 不影響任何數字）。npm run cassettes:prune 只管 cassette，不清這些向量；見 eval/README.md 第 3f 節。
//
// 三個拒絕執行的情況，都是為了不產出一份「永遠對不上的向量檔」：
//   1. utils/embedText.js 還是 eval stub —— 鍵是 sha256(buildEmbedText(q))，
//      規則一差一個字元，錄出來的表在 WS-C 合入後全部查不到。
//   2. EMBED_MODE=fixture —— 那是「讀 fixture」模式，用它錄等於拿舊表抄一份新表。
//   3. fixture 沒過章節硬閘門 —— 錯的題不值得花 API 額度。
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { loadFixture } = require('./lib/fixtures');
const { buildEmbedText, embedTextSource, embedHash, isStub: embedTextIsStub } = require('./lib/embedText');
const { fixturePath, DEFAULT_MODEL, DEFAULT_DIM } = require('./lib/embeddings');

const ROOT = path.resolve(__dirname, '..');
const DECIMALS = 6;   // interfaces 第 4 條：小數 6 位

function parseArgs(argv) {
    const args = { dryRun: false, onlyMissing: false, model: DEFAULT_MODEL, dim: DEFAULT_DIM, batch: Number(process.env.EMBED_BATCH || 32) };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--dry-run': args.dryRun = true; break;
            case '--only-missing': args.onlyMissing = true; break;
            case '--model': args.model = argv[++i]; break;
            case '--dim': args.dim = Number(argv[++i]); break;
            default: throw new Error(`未知的參數「${argv[i]}」`);
        }
    }
    return args;
}

/**
 * 取 WS-C 的 services/llm/index.js 的 embed()。
 * @returns {Function}
 */
function requireEmbed() {
    let mod;
    try {
        mod = require(path.join(ROOT, 'services', 'llm', 'index.js'));
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
            throw new Error(
                'services/llm/index.js（WS-C）尚未合入，無法錄製向量。\n' +
                '   docs/interfaces-stage1.md 第 4 條：embed({ model, texts, dim }) → { vectors, usage }。'
            );
        }
        throw err;
    }
    if (typeof mod.embed !== 'function') throw new Error('services/llm/index.js 沒有匯出 embed()（docs/interfaces-stage1.md 第 4 條）。');
    return mod.embed;
}

/** 小數 6 位；-0 正規化成 0，免得 JSON diff 出現無意義的變動 */
function round6(x) {
    const v = Number(x.toFixed(DECIMALS));
    return Object.is(v, -0) ? 0 : v;
}

/**
 * 讀既有的向量檔；不存在回空表。格式壞掉照樣丟錯（壞檔要修，不能當成空表整份重錄）。
 * @param {string} file
 * @returns {Record<string, number[]>}
 */
function readTable(file) {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * fixture 題的 embed_text（同一段文字只列一次），並標出向量檔裡有沒有。純函式。
 * @param {Array<object>} questions
 * @param {Record<string, number[]>} table 既有的向量檔內容
 * @returns {Array<{hash:string, text:string, ids:number[], present:boolean}>} 依第一次出現的順序
 */
function embedTargets(questions, table) {
    const byHash = new Map();
    for (const q of questions) {
        const text = buildEmbedText(q);
        const hash = embedHash(text);
        if (!byHash.has(hash)) byHash.set(hash, { hash, text, ids: [], present: Object.prototype.hasOwnProperty.call(table, hash) });
        byHash.get(hash).ids.push(q.id);
    }
    return [...byHash.values()];
}

/**
 * 這一輪要送出的 embed_text。純函式。
 * @param {Array<{hash:string, text:string, ids:number[], present:boolean}>} targets embedTargets() 的結果
 * @param {boolean} onlyMissing --only-missing：只送向量檔裡還沒有的（present=false）；否則全部重送
 * @returns {Array<{hash:string, text:string, ids:number[], present:boolean}>} 保持原順序
 */
function selectTargets(targets, onlyMissing) {
    return onlyMissing ? targets.filter(t => !t.present) : targets.slice();
}

/**
 * 把新錄的向量併進既有的表，鍵依字典序排好（與 services/llm/fixture.js 的 saveToFixture 同一個格式）。純函式。
 * @param {Record<string, number[]>} table
 * @param {Record<string, number[]>} fresh
 * @returns {Record<string, number[]>}
 */
function mergeTable(table, fresh) {
    const merged = { ...table, ...fresh };
    const sorted = {};
    for (const key of Object.keys(merged).sort()) sorted[key] = merged[key];
    return sorted;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (embedTextIsStub()) {
        throw new Error(
            `buildEmbedText 目前是 ${embedTextSource()}（WS-C 的 utils/embedText.js 尚未合入）。\n` +
            '   向量檔的鍵是 sha256(buildEmbedText(q))，用 stub 錄出來的表在 WS-C 合入後會全部查不到。\n' +
            '   請等 utils/embedText.js 合入後再錄。'
        );
    }
    if ((process.env.EMBED_MODE || '').toLowerCase() === 'fixture') {
        throw new Error('EMBED_MODE=fixture 是「讀 fixture」模式，不能用來錄製。請設 EMBED_MODE=record（或 live）後再跑。');
    }

    const fixture = loadFixture();
    const out = fixturePath(args.model, args.dim);
    const existing = readTable(out);
    const targets = embedTargets(fixture.questions, existing);

    // 同一段 embed_text 只送一次（fixture 內若有完全相同的題幹，重複送等於白花額度）
    // --only-missing：只送向量檔裡還沒有的那幾段（章節改標後 embed_text 第一行變了的題）
    const todo = selectTargets(targets, args.onlyMissing);
    const unique = new Map(todo.map(t => [t.hash, t.text]));

    console.log(`fixture：${fixture.questions.length} 題 → ${targets.length} 段相異 embed_text` +
        (args.onlyMissing ? `，向量檔裡缺 ${todo.length} 段（題號：${todo.flatMap(t => t.ids).join(', ') || '無'}）` : ''));
    console.log(`模型：${args.model} · 維度：${args.dim} · 批次：${args.batch}`);
    console.log(`輸出：${out}（併入既有的 ${Object.keys(existing).length} 筆）`);
    if (args.dryRun) {
        const chars = [...unique.values()].reduce((s, t) => s + t.length, 0);
        console.log(`--dry-run：不呼叫 API。合計 ${chars} 個字元，會分成 ${Math.ceil(unique.size / args.batch)} 批送出。`);
        return;
    }
    if (unique.size === 0) {
        console.log('\n✅ 向量檔已涵蓋全部 fixture 題，不需要錄製。');
        return;
    }

    const embed = requireEmbed();
    const keys = [...unique.keys()];
    const table = {};
    let tokenIn = 0;

    for (let i = 0; i < keys.length; i += args.batch) {
        const slice = keys.slice(i, i + args.batch);
        const res = await embed({ model: args.model, texts: slice.map(k => unique.get(k)), dim: args.dim });
        if (!res || !Array.isArray(res.vectors) || res.vectors.length !== slice.length) {
            throw new Error(`embed() 回傳的 vectors 筆數（${res && res.vectors && res.vectors.length}）與送出的 ${slice.length} 筆不符。`);
        }
        res.vectors.forEach((v, k) => {
            if (v.length !== args.dim) throw new Error(`embed() 回傳 ${v.length} 維，與 --dim ${args.dim} 不符。`);
            table[slice[k]] = v.map(round6);
        });
        tokenIn += (res.usage && res.usage.tokenIn) || 0;
        console.log(`  已錄 ${Math.min(i + args.batch, keys.length)}/${keys.length}`);
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    // 一律由 Node 寫（PowerShell 的 > 會寫 BOM），並固定 LF：eval/** 在 .gitattributes 是 eol=lf
    // 〔章節重整 CH-B〕重讀一次再併入：EMBED_MODE=record 時 embed() 自己也會寫這個檔
    const merged = mergeTable(readTable(out), table);
    fs.writeFileSync(out, JSON.stringify(merged, null, 0) + '\n', 'utf8');

    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log(`\n✅ 已錄 ${Object.keys(table).length} 筆向量，檔案共 ${Object.keys(merged).length} 筆（${kb} KB），tokenIn=${tokenIn}`);
    console.log('   這個檔要進版控：CI 只讀它，不呼叫 Gemini。');
    console.log('   fixture 題幹或 buildEmbedText() 規則一改，embed_hash 就變，必須重跑本腳本並在 PR 說明。');
}

if (require.main === module) {
    main().catch(err => { console.error(`\n❌ ${err.message}`); process.exit(1); });
}

module.exports = { main, round6, parseArgs, embedTargets, selectTargets, mergeTable, readTable };
