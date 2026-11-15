-- R6-publishing L2 (2026-11-14): each PostJob records which post-finished
-- email its outcome went out in, and for which publish attempt, so a Feed and
-- Story pair's combined email is never sent after either half emailed alone.
-- Additive: two nullable columns, no default (no table rewrite).
SET lock_timeout = '5s';

ALTER TABLE "PostJob" ADD COLUMN "outcomeEmailAttempt" TEXT;
ALTER TABLE "PostJob" ADD COLUMN "outcomeEmailKey" TEXT;
