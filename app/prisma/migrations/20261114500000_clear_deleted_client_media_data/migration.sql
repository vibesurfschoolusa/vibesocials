-- G4 (2026-11-14): files a client sent through an upload link that were marked
-- deleted before deletedMediaData existed still hold the client's name, note
-- and original file name. Clear exactly what deletedMediaData clears, with the
-- same values (src/server/jobs/deletedMediaData.ts; the test
-- clearDeletedClientMediaMigration.test.ts checks they agree). Only deleted
-- upload link rows that still differ are touched; no schema change.
SET lock_timeout = '5s';
UPDATE "MediaItem"
SET "metadata" = "metadata" - 'senderName' - 'note',
    "originalFilename" = CASE
      WHEN "originalFilename" ~ '\.([A-Za-z0-9]{1,10})$'
        THEN 'deleted-file.' || lower(substring("originalFilename" from '\.([A-Za-z0-9]{1,10})$'))
      ELSE 'deleted-file' END
WHERE "deletedAt" IS NOT NULL
  AND jsonb_typeof("metadata") = 'object'
  AND "metadata"->>'source' = 'upload_link'
  AND (
    ("metadata" -> 'senderName') IS NOT NULL
    OR ("metadata" -> 'note') IS NOT NULL
    OR "originalFilename" IS DISTINCT FROM CASE
      WHEN "originalFilename" ~ '\.([A-Za-z0-9]{1,10})$'
        THEN 'deleted-file.' || lower(substring("originalFilename" from '\.([A-Za-z0-9]{1,10})$'))
      ELSE 'deleted-file' END
  );
