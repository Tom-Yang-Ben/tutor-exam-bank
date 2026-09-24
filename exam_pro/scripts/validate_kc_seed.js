// scripts/validate_kc_seed.js — 驗證知識點種子檔（docs/interfaces-stage5.md 第 3.4 條）
//
// 用法：
//   node scripts/validate_kc_seed.js                 驗證 config/kc/ 底下全部 *.json（先備關係跨檔解析）
//   node scripts/validate_kc_seed.js config/kc/數學.json   只驗證指定檔（指向其他科的先備只給 warning）
// 有 error 時 exit code 1。
const fs = require('fs');
const path = require('path');
const { validateSeeds } = require('../utils/kcSeed');

const dir = path.resolve(__dirname, '..', 'config', 'kc');
const args = process.argv.slice(2);
const files = args.length ? args.map(f => path.resolve(f))
    : (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)) : []);

if (!files.length) { console.log('config/kc/ 沒有種子檔。'); process.exit(0); }

const seeds = [];
for (const f of files) {
    try { seeds.push(JSON.parse(fs.readFileSync(f, 'utf8'))); }
    catch (err) { console.error(`❌ ${f} 不是合法 JSON：${err.message}`); process.exit(1); }
}
const { errors, warnings, stats } = validateSeeds(seeds);
for (const [subject, s] of Object.entries(stats)) {
    console.log(`${subject}：${s.components} 個知識點、${s.chapters} 章、已審定 ${s.approved} 個`);
}
for (const w of warnings.slice(0, 50)) console.log(`⚠️ ${w}`);
if (warnings.length > 50) console.log(`⚠️ …另有 ${warnings.length - 50} 則 warning`);
for (const e of errors.slice(0, 200)) console.error(`❌ ${e}`);
if (errors.length) { console.error(`\n共 ${errors.length} 個 error。`); process.exit(1); }
console.log('✅ 種子檔全部通過。');
