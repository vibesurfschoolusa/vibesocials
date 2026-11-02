-- 2026-11-01 scale audit (platform limits): durable rate-limit deferral.
--
-- A platform that answers with a rate limit or a quota refusal (YouTube's daily
-- upload budget, Instagram's 100 posts per 24 h, a 429) no longer fails its
-- PostJobResult. The step hands its claim back and the result stays 'pending'
-- with "deferredUntil" set to the instant the run will try again (RATE_LIMITED or
-- DAILY_LIMIT in "errorCode"); the run itself sleeps until then. The stuck-job
-- reconciler (2 h) and the stale sweep (6 h) skip a job while any of its pending
-- results has a "deferredUntil" later than the sweep's own cutoff (now - 2 h for
-- the reconciler, now - 6 h for the stale sweep): the wait is still ahead, or it
-- ended less than that long ago. So a wait of up to 26 h is not mistaken for a
-- dead run, and a run that did die becomes eligible 2 h (or 6 h) after its wait
-- ended.
--
-- One nullable column, not a new PostJobResultStatus value: 'pending' keeps its
-- meaning for every reader, including the previous deployment that is still
-- serving traffic while this migration runs (it just ignores the column).
-- Additive only; no backfill (every existing row is simply not deferred) and no
-- index (the sweeps look a job's results up through the existing
-- ("postJobId", "platform") index).

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PostJobResult" ADD COLUMN "deferredUntil" TIMESTAMP(3);
