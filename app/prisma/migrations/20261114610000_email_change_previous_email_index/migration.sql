-- R6-security M1 (2026-11-14): registration, Google sign-in and email changes
-- look up whether an open undo window holds an address, by the address an
-- email change replaced. Additive: one index; no row or column changes.
SET lock_timeout = '5s';

CREATE INDEX "EmailChangeRequest_previousEmail_idx" ON "EmailChangeRequest"("previousEmail");
