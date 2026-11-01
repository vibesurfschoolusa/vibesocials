-- 2026-11-01 audit (Task 4 item 8b, controller ruling R6). DATA-ONLY: no schema
-- change.
--
-- The old approval bypass could leave a member's post `scheduled` while it was
-- still awaiting owner approval (submittedForApprovalAt set, approvedAt null),
-- so the cron would have published unreviewed text. The scheduled-post claim
-- now skips such rows (scheduledScanner.ts); this re-holds the existing ones as
-- ordinary held posts — `draft` + submittedForApprovalAt (lib/approval.ts) — so
-- an owner can approve or reject them.
--
-- Deliberately untouched:
--  * scheduledFor — the member's chosen time; approval honors it when it is
--    still in the future, else publishes now (lib/approval.ts approvalOutcome).
--  * updatedAt — the approval route pins decisions to the `updatedAt` the owner
--    reviewed; the reviewable content is unchanged here, so an open review must
--    not be invalidated.
UPDATE "PostJob"
SET "status" = 'draft'::"PostJobStatus"
WHERE "status" = 'scheduled'::"PostJobStatus"
  AND "submittedForApprovalAt" IS NOT NULL
  AND "approvedAt" IS NULL;
