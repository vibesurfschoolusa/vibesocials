-- An OAuth connect that found several accounts (Facebook Pages, Instagram
-- accounts, LinkedIn pages), waiting for the user to choose one. Rows live
-- 15 minutes. `payload` is sealed (lib/tokenCrypto.ts) because it holds tokens.
--
-- AUTHORED OFFLINE: the DDL is the output of a schema-to-schema diff
-- (`prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel
-- prisma/schema.prisma --script`), no database touched. Applied with
-- `prisma migrate deploy`.

-- CreateTable
CREATE TABLE "PendingConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "payload" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingConnection_workspaceId_userId_idx" ON "PendingConnection"("workspaceId", "userId");

-- AddForeignKey
ALTER TABLE "PendingConnection" ADD CONSTRAINT "PendingConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
