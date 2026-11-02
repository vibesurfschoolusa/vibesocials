-- 2026-11-01 audit (M2): canonicalize legacy MediaItem.storageLocation values.
--
-- deleteBlobUnlessShared() decides whether a blob is still in use by comparing
-- storageLocation strings. Until now POST /api/media stored the URL as sent
-- (trimmed) and POST /api/posts stored it untrimmed, so one file could be
-- registered under several spellings ("U", "U?x=1", "HTTPS://HOST/...",
-- "https://host:443/...", " U") and a variant row's delete removed a
-- teammate's blob. Both write paths now store canonicalBlobUrl(); this brings
-- the existing rows to the same form, so rows that point at one file compare
-- equal again.
--
-- For http(s) rows only (anything else, such as a local file path, is left
-- alone), mirroring canonicalBlobUrl() for the cases it can be done in SQL:
--   1. drop everything from the first "?" or "#";
--   2. trim surrounding whitespace (after step 1, so "U ?x=1" ends up as "U");
--   3. lower-case the scheme and host (an authority carrying "user:pw@" is
--      left as it is: credentials are case-sensitive);
--   4. remove a literal ":443" from an https host.
-- Path dot-segments and percent-encoding are not rewritten here.
--
-- Data-only; no schema change. Idempotent: the result is a fixed point of the
-- expression (a second run finds nothing to change), and the UPDATE only
-- touches rows whose value actually changes. It cannot fail on row content:
-- only text/regex functions are used, nothing is cast, and the SET value is
-- never NULL (rows whose pieces cannot be extracted are skipped).
UPDATE "MediaItem" AS m
SET "storageLocation" = c."canonical"
FROM (
  SELECT
    s."id",
    s."scheme" || '://' ||
      CASE
        WHEN position('@' IN s."authority") > 0 THEN s."authority"
        WHEN s."scheme" = 'https' THEN regexp_replace(lower(s."authority"), '(:443)+$', '')
        ELSE lower(s."authority")
      END ||
      s."rest" AS "canonical"
  FROM (
    SELECT
      t."id",
      lower(substring(t."value" FROM '^([A-Za-z]+)://')) AS "scheme",
      substring(t."value" FROM '^[A-Za-z]+://([^/]*)') AS "authority",
      substring(t."value" FROM '^[A-Za-z]+://[^/]*(.*)$') AS "rest"
    FROM (
      SELECT
        "id",
        regexp_replace(substring("storageLocation" FROM '^[^?#]*'), '^\s+|\s+$', '', 'g') AS "value"
      FROM "MediaItem"
      WHERE "storageLocation" ~* '^\s*https?://'
    ) AS t
  ) AS s
) AS c
WHERE m."id" = c."id"
  AND c."canonical" IS NOT NULL
  AND m."storageLocation" IS DISTINCT FROM c."canonical";
