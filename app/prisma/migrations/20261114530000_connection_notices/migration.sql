-- R5-publishing M1: each connection notice (the reconnect email, the warning a
-- week before a sign-in that cannot be renewed ends) goes out once.
-- Additive: two nullable columns, no row is changed.
SET lock_timeout = '5s';
ALTER TABLE "SocialConnection" ADD COLUMN "reconnectEmailedAt" TIMESTAMP(3);
ALTER TABLE "SocialConnection" ADD COLUMN "expiryWarnedFor" TIMESTAMP(3);
