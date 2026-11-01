-- 2026-11-01 audit (Task 7): normalize legacy mixed-case / padded emails.
--
-- Since PR #21 every email is stored as normalizeEmail() (trim + lowercase)
-- and login, forgot-password, register and Google SSO all look a user up by an
-- exact match on that form, so an account registered earlier as
-- "Alice@Example.com" can no longer be found.
--
-- Data-only. A row is rewritten to its normalized form only when it differs
-- AND no other row has the same normalized value, so the unique index on
-- "email" can never be violated; conflicting rows are left as they are. The
-- trim regex matches JS String.prototype.trim() for ordinary whitespace.
UPDATE "User" AS u
SET "email" = lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g'))
WHERE u."email" <> lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g'))
  AND NOT EXISTS (
    SELECT 1
    FROM "User" AS other
    WHERE other."id" <> u."id"
      AND lower(regexp_replace(other."email", '^\s+|\s+$', '', 'g'))
        = lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g'))
  );
