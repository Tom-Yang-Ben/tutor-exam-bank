// ─────────────────────────────────────────────────────────────
// scripts/desktop/lib/ico.js — 寫 Windows .ico 檔（桌面捷徑的圖示；tools/make_icons.js 用）
//
// 格式：ICONDIR（6 位元組）＋每張圖一個 ICONDIRENTRY（16 位元組）＋圖檔本體。
//   - 256 以下：32 位元 BGRA 的 DIB（BITMAPINFOHEADER 高度寫兩倍＋由下往上的像素＋1 位元 AND 遮罩），所有 Windows 版本都認得；
//   - 256：PNG（Vista 以後的做法，檔案小很多）。
// 純函式；parseIco 給單元測試檢查結構。
// ─────────────────────────────────────────────────────────────

/**
 * RGBA（由上往下）→ ICO 裡的 DIB。
 * @param {number} size
 * @param {Buffer} rgba  size*size*4
 */
function dibFromRgba(size, rgba) {
    if (rgba.length !== size * size * 4) throw new Error(`dibFromRgba：${size}x${size} 需要 ${size * size * 4} 位元組，收到 ${rgba.length}`);
    const header = Buffer.alloc(40);
    const maskRow = Math.ceil(size / 32) * 4;
    const pixels = Buffer.alloc(size * size * 4);
    const mask = Buffer.alloc(maskRow * size);
    for (let y = 0; y < size; y++) {
        const dstRow = size - 1 - y;   // DIB 由下往上
        for (let x = 0; x < size; x++) {
            const s = (y * size + x) * 4;
            const d = (dstRow * size + x) * 4;
            pixels[d] = rgba[s + 2];       // B
            pixels[d + 1] = rgba[s + 1];   // G
            pixels[d + 2] = rgba[s];       // R
            pixels[d + 3] = rgba[s + 3];   // A
            if (rgba[s + 3] === 0) mask[dstRow * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    header.writeUInt32LE(40, 0);             // biSize
    header.writeInt32LE(size, 4);            // biWidth
    header.writeInt32LE(size * 2, 8);        // biHeight（XOR＋AND 兩層）
    header.writeUInt16LE(1, 12);             // biPlanes
    header.writeUInt16LE(32, 14);            // biBitCount
    header.writeUInt32LE(0, 16);             // BI_RGB
    header.writeUInt32LE(pixels.length + mask.length, 20);
    return Buffer.concat([header, pixels, mask]);
}

/**
 * @param {Array<{size:number, rgba?:Buffer, png?:Buffer}>} images  每張給 rgba（寫成 DIB）或 png（原樣）
 * @returns {Buffer}
 */
function buildIco(images) {
    const list = [...images].sort((a, b) => a.size - b.size);
    const bodies = list.map(img => (img.png ? img.png : dibFromRgba(img.size, img.rgba)));
    const dir = Buffer.alloc(6 + 16 * list.length);
    dir.writeUInt16LE(0, 0);
    dir.writeUInt16LE(1, 2);                 // 1＝圖示
    dir.writeUInt16LE(list.length, 4);
    let offset = dir.length;
    list.forEach((img, i) => {
        const e = 6 + i * 16;
        dir.writeUInt8(img.size >= 256 ? 0 : img.size, e);       // 寬（0＝256）
        dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);   // 高
        dir.writeUInt8(0, e + 2);            // 調色盤色數
        dir.writeUInt8(0, e + 3);
        dir.writeUInt16LE(1, e + 4);         // planes
        dir.writeUInt16LE(32, e + 6);        // bit count
        dir.writeUInt32LE(bodies[i].length, e + 8);
        dir.writeUInt32LE(offset, e + 12);
        offset += bodies[i].length;
    });
    return Buffer.concat([dir, ...bodies]);
}

/**
 * 讀回 .ico 的目錄（單元測試用）。
 * @param {Buffer} buf
 * @returns {Array<{size:number, bytes:number, offset:number, kind:'png'|'dib'}>}
 */
function parseIco(buf) {
    if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('不是 .ico 檔');
    const n = buf.readUInt16LE(4);
    const out = [];
    for (let i = 0; i < n; i++) {
        const e = 6 + i * 16;
        const size = buf.readUInt8(e) || 256;
        const bytes = buf.readUInt32LE(e + 8);
        const offset = buf.readUInt32LE(e + 12);
        if (offset + bytes > buf.length) throw new Error(`第 ${i} 張圖超出檔案範圍`);
        const kind = buf.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : 'dib';
        out.push({ size, bytes, offset, kind });
    }
    return out;
}

module.exports = { buildIco, parseIco, dibFromRgba };
