-- F1 H3 follow-up (2026-11-14): when the scheduled-post scanner first picked a
-- post up, so the 2 h give-up counts from the pickup. Additive: one nullable
-- column, no row is changed.
SET lock_timeout = '5s';
ALTER TABLE "PostJob" ADD COLUMN "pickedUpAt" TIMESTAMP(3);
