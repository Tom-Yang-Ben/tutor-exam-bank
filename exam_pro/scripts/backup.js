// ─────────────────────────────────────────────────────────────
// scripts/backup.js — PostgreSQL 備份（E-X13a，規劃 §5.3.6「備份」段）
//
// 這台開發機沒有安裝 pg_dump（`where pg_dump` 沒有結果），資料庫是跑在容器裡的，
// 所以備份的做法是「借容器裡的 pg_dump」：
//     docker compose exec -T postgres pg_dump -Fc -U exam tutor_exam_bank > backups/<日期>.dump
//
// 用法（在 exam_pro 資料夾內，或直接雙擊「備份資料庫.bat」）：
//   node scripts/backup.js                  備份 DATABASE_URL 指到的資料庫
//   node scripts/backup.js --out D:\備份     指定輸出資料夾
//   node scripts/backup.js --keep 30        保留最近 30 份（預設 14，對應 MySQL 保留 14 天的窗口）
//
// 失敗一定要看得見（Docker Desktop 只有登入後才會起來，工作排程器在無人時跑最容易靜默失敗）：
//   任何一步失敗都會寫 backups/LAST_FAILED.txt 並以非零碼退出，
//   讓 .bat 停在畫面上不關視窗。成功時把這個檔刪掉。
//
// 新環境變數（列在 PR 描述，由開發者本人合進 .env.example）：
//   BACKUP_DIR         備份輸出資料夾，預設 exam_pro/backups
//   BACKUP_KEEP        保留份數，預設 14
//   BACKUP_COPY_DIR    另外複製一份到這裡（例如雲端硬碟同步資料夾），留空則不複製
//   BACKUP_PG_SERVICE  docker compose 的服務名稱，預設 postgres
// ─────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXAM_PRO = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.join(EXAM_PRO, 'backups');
const PGDMP_MAGIC = 'PGDMP';          // pg_dump -Fc 的檔頭；用來確認倒出來的不是一堆錯誤訊息

function main() {
    const args = process.argv.slice(2);
    const opt = name => {
        const i = args.indexOf(`--${name}`);
        if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
        const kv = args.find(a => a.startsWith(`--${name}=`));
        return kv ? kv.slice(name.length + 3) : undefined;
    };

    const outDir = path.resolve(opt('out') || process.env.BACKUP_DIR || DEFAULT_DIR);
    const keep = Math.max(1, parseInt(opt('keep') || process.env.BACKUP_KEEP || '14', 10) || 14);
    const service = process.env.BACKUP_PG_SERVICE || 'postgres';
    const copyDir = (process.env.BACKUP_COPY_DIR || '').trim();
    const failFile = path.join(outDir, 'LAST_FAILED.txt');

    fs.mkdirSync(outDir, { recursive: true });

    try {
        const conn = parseUrl(process.env.DATABASE_URL);

        // 1. 先確認 Docker 引擎活著。Docker Desktop 只在使用者登入後才啟動，
        //    工作排程器在鎖定畫面下跑時這一步就會失敗——必須說清楚，不能靜默。
        const info = spawnSync('docker', ['info'], { cwd: EXAM_PRO, stdio: 'ignore', shell: false });
        if (info.error || info.status !== 0) {
            throw new Error('偵測不到 Docker 引擎（docker info 失敗）。請先啟動 Docker Desktop，或確認排程器是在已登入的工作階段下執行。');
        }

        // 2. 容器要在跑
        const ps = spawnSync('docker', ['compose', 'ps', '-q', service], { cwd: EXAM_PRO, encoding: 'utf8', shell: false });
        if (ps.status !== 0 || !String(ps.stdout).trim()) {
            throw new Error(`docker compose 的服務「${service}」沒有在執行。請先雙擊「啟動資料庫.bat」或執行 npm run db:up。`);
        }

        // 3. 借容器裡的 pg_dump 倒出自訂格式（-Fc，可用 pg_restore 選擇性還原、且會壓縮）
        const stamp = stampForFilename(new Date());
        const outFile = path.join(outDir, `${conn.database}_${stamp}.dump`);
        const fd = fs.openSync(outFile, 'w');
        let dump;
        try {
            dump = spawnSync('docker', [
                'compose', 'exec', '-T', service,
                'pg_dump', '-Fc', '--no-owner', '--no-acl', '-U', conn.user, '-d', conn.database
            ], { cwd: EXAM_PRO, stdio: ['ignore', fd, 'pipe'], shell: false, maxBuffer: 16 * 1024 * 1024 });
        } finally {
            fs.closeSync(fd);
        }
        if (dump.error) throw new Error(`執行 pg_dump 失敗：${dump.error.message}`);
        if (dump.status !== 0) {
            const stderr = String(dump.stderr || '').trim().split('\n').slice(-5).join('\n');
            safeUnlink(outFile);
            throw new Error(`pg_dump 回傳非零碼 ${dump.status}：\n${stderr}`);
        }

        // 4. 驗證檔案不是空的、而且真的是 pg_dump 的自訂格式
        const size = fs.statSync(outFile).size;
        if (size === 0) { safeUnlink(outFile); throw new Error('備份檔是 0 位元組，內容沒有倒出來。'); }
        const head = Buffer.alloc(5);
        const rfd = fs.openSync(outFile, 'r');
        fs.readSync(rfd, head, 0, 5, 0);
        fs.closeSync(rfd);
        if (head.toString('latin1') !== PGDMP_MAGIC) {
            safeUnlink(outFile);
            throw new Error(`備份檔的檔頭不是 ${PGDMP_MAGIC}，倒出來的可能是錯誤訊息而不是資料。`);
        }
        console.log(`✅ 備份完成：${outFile}（${(size / 1024 / 1024).toFixed(2)} MB）`);

        // 5. 複製一份到雲端硬碟資料夾（選填）
        if (copyDir) {
            const dst = path.resolve(copyDir);
            try {
                fs.mkdirSync(dst, { recursive: true });
                fs.copyFileSync(outFile, path.join(dst, path.basename(outFile)));
                console.log(`   已複製到 ${dst}`);
            } catch (e) {
                throw new Error(`備份成功但複製到 BACKUP_COPY_DIR 失敗：${e.message}`);
            }
        }

        // 6. 只留最近 keep 份
        const olds = fs.readdirSync(outDir)
            .filter(f => f.endsWith('.dump'))
            .sort()
            .slice(0, -keep);
        for (const f of olds) { safeUnlink(path.join(outDir, f)); console.log(`   已清掉舊備份 ${f}`); }

        safeUnlink(failFile);
        console.log(`   保留最近 ${keep} 份；還原方式見 docs/cutover-runbook.md 的「回滾」段。`);
    } catch (err) {
        const msg = `[${new Date().toISOString()}] 備份失敗：${err.message}\n`;
        try {
            fs.mkdirSync(outDir, { recursive: true });
            fs.appendFileSync(failFile, msg, 'utf8');
        } catch (e) { /* 連寫旗標都失敗就只能靠 stderr 了 */ }
        console.error('❌ ' + err.message);
        console.error(`   已記到 ${failFile}`);
        process.exit(1);
    }
}

/**
 * 從 DATABASE_URL 取出使用者與資料庫名。
 * @param {string|undefined} url
 * @returns {{user: string, database: string}}
 */
function parseUrl(url) {
    if (!url) throw new Error('缺少 DATABASE_URL（.env 裡設 postgres://exam:exam@localhost:5442/tutor_exam_bank）');
    let u;
    try { u = new URL(url); } catch (e) { throw new Error(`DATABASE_URL 格式不正確：${url}`); }
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!database) throw new Error('DATABASE_URL 裡沒有資料庫名稱');
    return { user: decodeURIComponent(u.username || 'exam'), database };
}

/** 檔名用的本地時間戳（不用 toISOString，那是 UTC）。 */
function stampForFilename(t) {
    const p = n => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}${p(t.getMinutes())}`;
}

function safeUnlink(f) {
    try { fs.unlinkSync(f); } catch (e) { /* 不存在就算了 */ }
}

main();
