-- Drops the deliberately-left DB drift from the team-workspaces release
-- (20260712000000_team_workspaces): the schema replaced PostMetric's
-- `@@index([userId])` with `@@index([workspaceId])`, but the DROP was
-- deferred per design doc §2 ("the DB index is left in place; dropping it
-- is a later cleanup"). This is that cleanup — after it, schema and DB
-- agree byte-for-byte (verified via offline `prisma migrate diff`).
--
-- OWNER APPLIES via `prisma migrate deploy` in the gated release step.
-- Plain DROP INDEX (not CONCURRENTLY): it takes an ACCESS EXCLUSIVE lock
-- on PostMetric — briefly blocking reads (dashboard metric joins) as well
-- as writes (hourly metrics cron). The table is one row per tracked
-- YouTube video, so the lock is sub-second — a non-event.

-- DropIndex
DROP INDEX "PostMetric_userId_idx";
