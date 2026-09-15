// 變式 job 的 source_check（〔修訂 2026-09-15f〕docs/source-check.md）——直接用真的 agent。
//
// 變式題沒有原卷，payload.extract.source_text 不存在，真 agent 一律回 skipped('no_source_text')；
// 它是純函式、不呼叫 LLM、不碰 DB，拿來當假 agent 用與正式環境的行為完全一致。
module.exports = require('../../../agents/source_check');
