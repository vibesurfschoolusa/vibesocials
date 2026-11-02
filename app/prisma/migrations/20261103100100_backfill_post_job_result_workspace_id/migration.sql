-- 2026-11-01 scale audit (db M5, web W16): backfill "PostJobResult"."workspaceId".
--
-- Copies each result's workspace from its job. Idempotent: it only touches rows
-- whose "workspaceId" is still NULL, so a re-run (for example after a failed
-- build is recovered with `prisma migrate resolve`) updates 0 rows once the
-- table is filled, and it is safe to run again at any time.
--
-- It is raw SQL on purpose and never sets "updatedAt". Publish-health reads
-- "PostJobResult"."updatedAt" as the moment a post finished; a Prisma
-- updateMany would bump @updatedAt on every row and drag every old result back
-- into the 30-day window. Only "workspaceId" changes here.
--
-- Bounded: one statement over today's production table, which is small (thousands
-- of rows). Measured on the audit's 3.6M-row seed as an upper bound (see the
-- commit message). The lock_timeout below makes a backfill that queues behind a
-- long transaction fail the build safely rather than wait; it is re-runnable.
--
-- Rows the previous deployment writes after this statement and before the new
-- code is promoted (or during a rollback) carry NULL. The hourly stale sweep
-- runs the same UPDATE in batches (resultWorkspaceHeal.ts) and fixes them.

SET lock_timeout = '5s';

UPDATE "PostJobResult" r SET "workspaceId" = j."workspaceId"
FROM "PostJob" j WHERE r."postJobId" = j."id" AND r."workspaceId" IS NULL;
