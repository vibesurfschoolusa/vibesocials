-- N3 (2026-11-14): when a post was last retried, so Activity's "Had a
-- problem" tab keeps it. Additive: one nullable column, no row is changed.
SET lock_timeout = '5s';
ALTER TABLE "PostJob" ADD COLUMN "retriedAt" TIMESTAMP(3);
