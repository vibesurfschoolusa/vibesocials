-- R7-new-customer H1 (2026-11-14): an email change records when the address it
-- replaced was never confirmed; such a change opens no undo window. Additive:
-- one nullable column, no default, no row changes, so the code still serving
-- during the release keeps working.
SET lock_timeout = '5s';

ALTER TABLE "EmailChangeRequest" ADD COLUMN "previousEmailUnverified" BOOLEAN;
