-- R5-security M1 (2026-11-14): a usage log the limits count that survives
-- deleting a workspace (src/server/usage/usageLog.ts). Additive: one new table
-- with no foreign keys, its indexes, and rows for the workspaces created in the
-- last 30 days, so the per-person creation limit counts them from the start.
SET lock_timeout = '5s';

CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "workspaceId" TEXT,
    "platform" "Platform",
    "accountId" TEXT,
    "sourceId" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageEvent_sourceId_key" ON "UsageEvent"("sourceId");
CREATE INDEX "UsageEvent_kind_at_idx" ON "UsageEvent"("kind", "at");
CREATE INDEX "UsageEvent_userId_kind_at_idx" ON "UsageEvent"("userId", "kind", "at");
CREATE INDEX "UsageEvent_accountId_kind_at_idx" ON "UsageEvent"("accountId", "kind", "at");
CREATE INDEX "UsageEvent_workspaceId_kind_at_idx" ON "UsageEvent"("workspaceId", "kind", "at");

-- The owner who joined a workspace as it was made is the one who created it.
-- The source id makes a second run of this insert a no-op.
INSERT INTO "UsageEvent" ("id", "kind", "userId", "workspaceId", "sourceId", "at")
SELECT 'backfill_' || m."id", 'workspace_created', m."userId", w."id", 'workspace_created:' || w."id", w."createdAt"
FROM "WorkspaceMember" m
JOIN "Workspace" w ON w."id" = m."workspaceId"
WHERE m."role" = 'owner'
  AND w."createdAt" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
  AND m."createdAt" < w."createdAt" + INTERVAL '1 minute'
ON CONFLICT DO NOTHING;
