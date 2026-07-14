-- Composite index backing GET /api/posts keyset pagination (scale-readiness
-- PR-C final review follow-up 1): the per-workspace total order
-- (createdAt DESC, id DESC) was previously satisfied by a workspace-wide
-- sort on @@index([workspaceId]). OWNER APPLIES via prisma migrate deploy.
-- CreateIndex
CREATE INDEX "PostJob_workspaceId_createdAt_id_idx" ON "PostJob"("workspaceId", "createdAt", "id");
