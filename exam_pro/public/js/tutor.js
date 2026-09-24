// ─────────────────────────────────────────────────────────────
// public/js/tutor.js — AI 家教（含按住說話）（階段 5，擁有者：WS-E；docs/interfaces-stage5.md）
//
// 骨架檔（contract 階段建立）：旗標關閉時整段不渲染，規則同階段 3／4 的 module。
// 實作由 WS-E 補上；除了本檔與 index.html 已預留的 <section id="tutor"> 之外，
// 不需要動 index.html。
// ─────────────────────────────────────────────────────────────
function featureOn(name) {
    const meta = document.querySelector(`meta[name="feature-${name}"]`);
    const v = String(meta?.content ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

if (featureOn('tutor')) {
    // TODO(WS-E)：掛載 #tutor
}
