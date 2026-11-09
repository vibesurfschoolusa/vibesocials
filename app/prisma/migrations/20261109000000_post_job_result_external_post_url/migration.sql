-- The post's public link, when the platform's id is not one (Instagram media ids).
ALTER TABLE "PostJobResult" ADD COLUMN "externalPostUrl" TEXT;
