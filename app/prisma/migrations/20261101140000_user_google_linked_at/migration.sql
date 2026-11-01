-- 2026-11-01 audit (Task 7): record when an account was linked to Google SSO.
--
-- Additive only: a new nullable column, no backfill. A Google sign-in now
-- auto-links into an existing account only when that account is already
-- linked (googleLinkedAt set) or has no password; a password account that was
-- never linked is refused (src/lib/googleSso.ts planGoogleSsoLink).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "googleLinkedAt" TIMESTAMP(3);
