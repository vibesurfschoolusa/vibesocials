-- Video cover (V1, 2026-11-14). Additive, nullable: the code live while this
-- runs neither reads nor writes these columns.
ALTER TABLE "PostJob" ADD COLUMN "coverTimeMs" INTEGER;
ALTER TABLE "PostJob" ADD COLUMN "coverImageUrl" TEXT;
ALTER TABLE "PostJobResult" ADD COLUMN "note" TEXT;
