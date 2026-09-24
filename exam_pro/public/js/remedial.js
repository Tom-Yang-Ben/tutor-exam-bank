// ─────────────────────────────────────────────────────────────
// public/js/remedial.js — 依弱點出補救卷與題庫覆蓋率（階段 5，擁有者：WS-D；docs/interfaces-stage5.md）
//
// 骨架檔（contract 階段建立）：旗標關閉時整段不渲染，規則同階段 3／4 的 module。
// 實作由 WS-D 補上；除了本檔與 index.html 已預留的 <section id="remedial / #coverage"> 之外，
// 不需要動 index.html。
// ─────────────────────────────────────────────────────────────
function featureOn(name) {
    const meta = document.querySelector(`meta[name="feature-${name}"]`);
    const v = String(meta?.content ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

if (featureOn('remedial')) {
    // TODO(WS-D)：掛載 #remedial / #coverage
}
