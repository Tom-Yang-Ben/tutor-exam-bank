// ─────────────────────────────────────────────────────────────
// scripts/desktop/tools/make_icons.js — 產生桌面捷徑的兩個圖示（只在要改圖示時跑；產物已進版控）
//
//   node scripts/desktop/tools/make_icons.js
//   → scripts/desktop/assets/tutor-exam-bank.ico       「出題系統」：藍底、一張考卷、三行字、一個勾
//   → scripts/desktop/assets/tutor-exam-bank-stop.ico  「關閉出題系統」：同一張考卷＋紅色停止徽章
//
// 圖案是本檔的 SVG 幾何圖形（只有矩形、路徑、圓，沒有文字與字型），自己畫的、不引用任何既有圖檔。
// 用專案既有的 sharp 把 SVG 點陣化成各尺寸，再由 lib/ico.js 包成 .ico。
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { buildIco } = require('../lib/ico');

const OUT_DIR = path.resolve(__dirname, '..', 'assets');
/** Windows 捷徑會用到的尺寸（桌面 100%～300% 縮放、檔案總管的各種檢視） */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

const PAPER = `
  <rect x="16" y="16" width="224" height="224" rx="48" fill="#1E4E8C"/>
  <path d="M72 44 H156 L190 78 V214 H72 Z" fill="#FFFFFF"/>
  <path d="M156 44 V78 H190 Z" fill="#BFD0EA"/>
  <rect x="92" y="98" width="78" height="13" rx="6.5" fill="#8FA8CF"/>
  <rect x="92" y="126" width="62" height="13" rx="6.5" fill="#8FA8CF"/>
  <rect x="92" y="154" width="70" height="13" rx="6.5" fill="#8FA8CF"/>`;

const CHECK = `
  <path d="M104 190 L128 212 L178 160" fill="none" stroke="#F2A900" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`;

const STOP_BADGE = `
  <circle cx="186" cy="186" r="50" fill="#C62828" stroke="#FFFFFF" stroke-width="10"/>
  <rect x="164" y="164" width="44" height="44" rx="6" fill="#FFFFFF"/>`;

const svg = body => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">${body}</svg>`);

async function render(svgBuf) {
    const images = [];
    for (const size of SIZES) {
        const img = sharp(svgBuf).resize(size, size);
        if (size >= 256) {
            images.push({ size, png: await img.png({ compressionLevel: 9 }).toBuffer() });
        } else {
            const { data } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            images.push({ size, rgba: data });
        }
    }
    return buildIco(images);
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const targets = [
        ['tutor-exam-bank.ico', svg(PAPER + CHECK)],
        ['tutor-exam-bank-stop.ico', svg(PAPER + STOP_BADGE)]
    ];
    for (const [name, buf] of targets) {
        const ico = await render(buf);
        fs.writeFileSync(path.join(OUT_DIR, name), ico);
        console.log(`已寫入 ${path.relative(process.cwd(), path.join(OUT_DIR, name))}（${ico.length} 位元組）`);
    }
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { SIZES };
