// ─────────────────────────────────────────────────────────────
// test/e2e/lib/docx.js — 從 .docx 的 buffer 裡讀出 word/document.xml（E-X15）
//
// .docx 是一個 zip。要斷言「公式真的變成 OOXML 的 <m:oMath> 而不是純文字」，
// 就必須把裡面那份 XML 解出來——直接在 buffer 上 grep 是行不通的，
// 內容是 deflate 壓過的。
//
// 為什麼自己寫而不是加一個 zip 套件：這是**測試專用**的四十行，
// 而 package.json 的相依會跟著進 npm ci、進 CI、進每個人的機器。
// 為了一支 e2e 斷言加一個相依，代價與收益不成比例。
// zlib 是 Node 內建的，zip 的中央目錄格式三十年沒變過。
//
// 只支援這裡真的會遇到的兩種：stored（0）與 deflate（8）。
// 遇到別的直接丟錯，不猜。
// ─────────────────────────────────────────────────────────────

const zlib = require('node:zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/**
 * 找 End of Central Directory（從尾端往前找，因為註解長度可變）。
 * @param {Buffer} buf
 * @returns {number} EOCD 的位移
 */
function findEocd(buf) {
    // EOCD 至少 22 bytes，註解最多 65535 bytes。
    const from = Math.max(0, buf.length - (22 + 0xffff));
    for (let i = buf.length - 22; i >= from; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    throw new Error('這不是一個 zip：找不到 End of Central Directory');
}

/**
 * 列出 zip 裡的所有檔名。
 * @param {Buffer} buf
 * @returns {string[]}
 */
function listEntries(buf) {
    const eocd = findEocd(buf);
    const count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(at) !== CEN_SIG) throw new Error(`中央目錄第 ${i} 筆的簽章不對`);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const commentLen = buf.readUInt16LE(at + 32);
        names.push(buf.toString('utf8', at + 46, at + 46 + nameLen));
        at += 46 + nameLen + extraLen + commentLen;
    }
    return names;
}

/**
 * 取出 zip 裡某一個檔案的內容。
 * @param {Buffer} buf
 * @param {string} wanted 例如 'word/document.xml'
 * @returns {Buffer}
 */
function readEntry(buf, wanted) {
    const eocd = findEocd(buf);
    const count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);

    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(at + 10);
        const compressedSize = buf.readUInt32LE(at + 20);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const commentLen = buf.readUInt16LE(at + 32);
        const localOffset = buf.readUInt32LE(at + 42);
        const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
        at += 46 + nameLen + extraLen + commentLen;
        if (name !== wanted) continue;

        // 本地檔頭：簽章(4) 版本(2) 旗標(2) 方法(2) 時間(2) 日期(2) crc(4)
        //           壓縮大小(4) 原始大小(4) 檔名長(2) 額外欄位長(2)
        const lnLen = buf.readUInt16LE(localOffset + 26);
        const leLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lnLen + leLen;
        const raw = buf.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`${wanted} 用了不支援的壓縮方式 ${method}`);
    }
    throw new Error(`zip 裡找不到 ${wanted}（有的是：${listEntries(buf).join('、')}）`);
}

/**
 * 讀出 word/document.xml 的文字。
 * @param {Buffer} buf .docx 的 buffer
 * @returns {string}
 */
function documentXml(buf) {
    return readEntry(buf, 'word/document.xml').toString('utf8');
}

module.exports = { documentXml, readEntry, listEntries, findEocd };
