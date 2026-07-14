-- Session invalidation after password reset: outstanding JWTs embed
-- sessionVersion at issue time; getCurrentUser rejects mismatches.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
