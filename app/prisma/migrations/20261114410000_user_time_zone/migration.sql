-- F4 (2026-11-14): the person's IANA time zone, so emails show times in it.
-- Additive: one nullable column, no row is changed.
SET lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN "timeZone" TEXT;
