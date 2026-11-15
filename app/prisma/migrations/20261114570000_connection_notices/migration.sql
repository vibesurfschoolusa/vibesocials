-- R5-publishing M1: each connection notice (the reconnect email, the warning a
-- week before a sign-in that cannot be renewed ends) goes out once.
-- Two nullable columns, then the release backlog: what is flagged, or has
-- lapsed, now is marked as told, so the first sweep emails nobody about old or
-- test connections; what is flagged, or comes due, after the release sends
-- (server/jobs/connectionNotices.ts; connectionNoticesMigration.test.ts checks
-- these rules against the sweep's).
SET lock_timeout = '5s';
ALTER TABLE "SocialConnection" ADD COLUMN "reconnectEmailedAt" TIMESTAMP(3);
ALTER TABLE "SocialConnection" ADD COLUMN "expiryWarnedFor" TIMESTAMP(3);

-- Flagged now: told about this flag. Its own flag time, not NOW(), so a flag
-- written by the old code just after this runs is still newer and still sends.
UPDATE "SocialConnection"
SET "reconnectEmailedAt" = COALESCE("refreshFailedAt", NOW())
WHERE "needsReconnect" = true;

-- A sign-in that cannot be renewed and has already ended: the sweep would flag
-- it and send the reconnect email. Flag it here, as told (flag fields only).
UPDATE "SocialConnection"
SET "needsReconnect" = true,
    "lastRefreshErrorCode" = 'CONNECTION_SIGN_IN_EXPIRED',
    "refreshFailedAt" = NOW(),
    "reconnectEmailedAt" = NOW()
WHERE "needsReconnect" = false
  AND "refreshToken" IS NULL
  AND "expiresAt" IS NOT NULL
  AND "platform" NOT IN ('facebook_page', 'instagram')
  AND "expiresAt" <= NOW();

-- A sign-in still running (one ending within the week too) is left alone: its
-- owners get the real warning from the sweep.
-- Instagram connections the old code flagged only because of the stored 60-day
-- date are left flagged: that guard wrote the same INSTAGRAM_RECONNECT_REQUIRED
-- as a real Graph 190 / 401, so the two cannot be told apart here.
