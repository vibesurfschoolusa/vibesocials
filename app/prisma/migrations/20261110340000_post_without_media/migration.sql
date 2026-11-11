-- A post that is only text has no file (2026-11-10). Additive: the code live
-- while this runs never writes a null here.
ALTER TABLE "PostJob" ALTER COLUMN "mediaItemId" DROP NOT NULL;
