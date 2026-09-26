-- 0018_retrain_unflag_marker.sql — 排程項目記下「移出是因為勾選消失」（錯題重練第二階段審查修正；docs/retrain-and-review.md 第 3.9 節、第 5.6.6 節）
--
-- 為什麼要這一欄：設計稿第 3.9 節規定「刪的是重練卷時，受影響的項目依剩下的作答歷史重算（等於那次重練沒發生過）」。
-- 批改卡取消勾選的規則是「還沒重練過就刪掉，重練過就移出」（第 4.4 節），所以一個因為「重練過」才被移出的項目，
-- 在它的重練卷全部刪掉之後，應該回到「取消勾選當時就會被刪掉」的樣子——也就是刪掉。
-- 但「移出」有兩種來源：批改卡取消勾選（或刪了勾選所在的卷，承上組的同組題跟著離開），與老師在清單上按「移出」（API-3）。
-- 後者是老師的決定，刪重練卷時應該保留；兩者在 teacher_override／reason 上看起來一模一樣，所以另記一欄分開。
--
--   retired_by_unflag = true   這個項目是因為「勾選消失」而移出的（services/retrainService.js 的 applyGrading 取消勾選、
--                              deletePaperAssignments 刪了勾選所在的卷），不是老師在清單上按的「移出」。
--                              只在 teacher_override = 'retired' 時可以是 true（retrain_items_unflag_check）；
--                              重新加入、判定已會時清回 false。
--   刪重練卷之後：剩下 0 筆重練派題、而且 retired_by_unflag = true 的項目 → 刪掉（那次重練沒發生過）。
--
-- 既有資料：一律 false（照舊保留）。0017 之後、本檔之前已經因取消勾選而移出的項目分不出來源，維持「移出」，
-- 行為與本檔之前相同（只多不少，不會誤刪）。
--
-- 冪等（照 repo 慣例）：ADD COLUMN IF NOT EXISTS、約束用 DO 區塊判斷是否已存在。已經套過的庫再套一次整支是 no-op。
-- 不搬資料、不呼叫任何外部服務。本檔之後的變更走新的 migration 檔。

ALTER TABLE retrain_items ADD COLUMN IF NOT EXISTS retired_by_unflag BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'retrain_items'::regclass AND conname = 'retrain_items_unflag_check') THEN
        ALTER TABLE retrain_items ADD CONSTRAINT retrain_items_unflag_check
            CHECK (NOT retired_by_unflag OR teacher_override IS NOT DISTINCT FROM 'retired');
    END IF;
END $$;

COMMENT ON COLUMN retrain_items.retired_by_unflag IS
    '移出是因為勾選消失（批改卡取消勾選、刪了勾選所在的卷），不是老師在清單上按的移出；重練派題全刪光時這種項目跟著刪（0018）';
