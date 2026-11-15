-- R5-publishing M1: each connection notice (the reconnect email, the warning a
-- week before a sign-in that cannot be renewed ends) goes out once.
-- Two nullable columns, then the release backlog: what is already there now is
-- marked as told, so the first sweep emails nobody about old or test
-- connections; only what is flagged, or comes due, after the release sends
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

-- One already inside its 7-day warning window: warned.
UPDATE "SocialConnection"
SET "expiryWarnedFor" = "expiresAt"
WHERE "needsReconnect" = false
  AND "refreshToken" IS NULL
  AND "expiresAt" IS NOT NULL
  AND "platform" NOT IN ('facebook_page', 'instagram')
  AND "expiresAt" <= NOW() + INTERVAL '7 days';
