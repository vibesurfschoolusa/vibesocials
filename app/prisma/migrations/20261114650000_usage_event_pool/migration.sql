-- R7-security M1 (2026-11-14): each run (a "send" row) records the pool it
-- drew from and the workspace's owners at the time of the run, so new
-- accounts have a pool of their own and leaving or handing over a workspace
-- lowers nobody's count. Additive: a nullable column, and an array column
-- with a constant default (no table rewrite); older code ignores both.
SET lock_timeout = '5s';

ALTER TABLE "UsageEvent" ADD COLUMN "pool" TEXT;
ALTER TABLE "UsageEvent" ADD COLUMN "ownerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
