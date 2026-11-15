-- R6-security M1 (2026-11-14): registration, Google sign-in and email changes
-- look up whether an open undo window holds an address, by the address an
-- email change replaced; the daily sweep and the account routes clear passed
-- windows by their undo expiry (R6-pages L6). Additive: two indexes; no row
-- or column changes.
SET lock_timeout = '5s';

CREATE INDEX "EmailChangeRequest_previousEmail_idx" ON "EmailChangeRequest"("previousEmail");
CREATE INDEX "EmailChangeRequest_undoExpiresAt_idx" ON "EmailChangeRequest"("undoExpiresAt");
