-- 2026-11-02 scale audit (jobs, chunked uploads): persisted upload state.
--
-- A large video no longer has to upload inside one Inngest step. A platform step
-- stops at its time budget, saves where the upload stands, and the next step of
-- the same run resumes from it. The state is one JSON document per result:
-- { v, runId, platform, kind, savedAt, data, secret? }. `secret` holds the
-- capability URLs (YouTube session URI, TikTok upload_url, LinkedIn part URLs)
-- as sealSecret() ciphertext, so nothing readable is stored. It is written only
-- under the run's claim, cleared when the result finishes or is re-queued by the
-- retry route, and ignored when it was saved by another run.
--
-- Additive only: one nullable column (no default, so no table rewrite). The
-- previous deployment that is still serving traffic while this migration runs
-- never reads or writes it. A rollback while a run is mid-continuation leaves
-- its row `pending` and unclaimed, which the stuck-in_progress reconciler fails
-- as PUBLISH_STALLED ("you can retry"): nothing was posted, because the commit
-- call never crosses a step boundary.
--
-- The lock_timeout below makes the script give up rather than queue behind a
-- long writer and stall every insert into "PostJobResult".

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PostJobResult" ADD COLUMN "uploadState" JSONB;
