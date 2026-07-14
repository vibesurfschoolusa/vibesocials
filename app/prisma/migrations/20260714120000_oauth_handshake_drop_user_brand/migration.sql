-- Ephemeral OAuth 1.0a handshake store (X request-token secret + workspace).
CREATE TABLE IF NOT EXISTS "OAuthHandshake" (
    "token" TEXT NOT NULL,
    "tokenSecret" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthHandshake_pkey" PRIMARY KEY ("token")
);

CREATE INDEX IF NOT EXISTS "OAuthHandshake_expiresAt_idx" ON "OAuthHandshake"("expiresAt");

-- Brand footer lives on Workspace only; drop dead User columns.
ALTER TABLE "User" DROP COLUMN IF EXISTS "companyWebsite";
ALTER TABLE "User" DROP COLUMN IF EXISTS "defaultHashtags";
