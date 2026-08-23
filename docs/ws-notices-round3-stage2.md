# 階段 2 第二輪補裁通知（2026-08-23）— 只給 WS-C 與 WS-D

> 第二輪四條已合入 main（`8254c00`，整合 151/151）。唯一的紅：`test/unit/answerGolden.test.js` 250 案例有 20 筆 `answerCompare` 與 golden 不符。補裁 S2-26 已寫進 `docs/interfaces-stage2.md` §12.1 與第 4.2 條。cassette 由開發者在 main 統一錄製中，WS-B 不用動。

## 給 WS-C

```
docs/interfaces-stage2.md 新增 §12.1 裁決 S2-26（第 4.2 條細則），請 git merge main && cd exam_pro && npm ci 後改 utils/answerCompare.js：
1. number：加科學記號（a \times 10^{n}、a×10^n、2.4e-4）；\mathrm{…}／\text{…}／\,／\  與其後單位整段去掉；\sqrt{n}、\frac{\sqrt{a}}{b}、\pi 可數值化的式子算出數值再比（兩邊都算得出且不等 → disagree）。
2. text：normalizeStem 後相等 → agree；不相等一律 uncertain（不回 disagree）。
3. expression：去空白／$／\left\right 後相等 → agree；否則兩邊都能數值化就照 number 比；否則 uncertain。
驗收：node --test test/unit/answerGolden.test.js 的 250 案例只剩 ans-047 的三筆 eq*（那三筆是 golden 要改，期望 agree，你的實作回 agree 即正確）；其餘 17 筆必須符合。questions2-wsC.md 補一條結案。
```

## 給 WS-D

```
docs/interfaces-stage2.md 新增 §12.1 裁決 S2-26，請 git merge main 後改 eval/golden/answer.json：ans-047（expression `\frac{3}{1}`）的 eq1／eq2／eq3 期望改 agree（3/1 與 3 數值相等，\left\right 去掉後亦同）。其餘 17 筆不改，等 WS-C 的 answerCompare 合入後 250/250 綠。questions2-wsD.md 補一條結案。
```
