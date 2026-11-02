-- 2026-11-01 scale audit (jobs H6): per-result publish claim.
--
-- A platform step now claims its PostJobResult with one conditional write
-- (status = 'pending' AND "claimRunId" IS NULL) before it calls the platform, so
-- two runs of one job can never both publish the same platform. "claimRunId" is
-- the Inngest run id of the step about to call the platform and "claimedAt" is
-- when it took the claim. A claim is only held inside one step (<= 300 s), so a
-- pending row that still has one after that lost its run mid-call and is marked
-- PUBLISH_UNCONFIRMED rather than retried blindly.
--
-- Two nullable columns, not a new PostJobResultStatus value: 'pending' keeps its
-- meaning for every reader, including the previous deployment that is still
-- serving traffic while this migration runs. Additive only; no backfill (every
-- existing row is simply unclaimed) and no index (the claim is a primary-key
-- lookup).

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PostJobResult" ADD COLUMN "claimRunId" TEXT, ADD COLUMN "claimedAt" TIMESTAMP(3);
