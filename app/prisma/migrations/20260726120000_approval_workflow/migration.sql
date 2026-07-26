-- Approval workflow (2026-07-26 plan). Purely additive: a workspace-level
-- opt-in flag plus three nullable columns recording the submission/decision on
-- the PostJob. No new PostJobStatus value — a held post is an ordinary `draft`
-- whose `submittedForApprovalAt` is non-null (see lib/approval.ts).
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "requireApproval" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PostJob" ADD COLUMN IF NOT EXISTS "submittedForApprovalAt" TIMESTAMP(3);
ALTER TABLE "PostJob" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "PostJob" ADD COLUMN IF NOT EXISTS "approvedByUserId" TEXT;

-- Backs the Queue's "awaiting approval" lookup (workspace + submitted IS NOT NULL).
CREATE INDEX IF NOT EXISTS "PostJob_workspaceId_submittedForApprovalAt_idx"
    ON "PostJob"("workspaceId", "submittedForApprovalAt");
