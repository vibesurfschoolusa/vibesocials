-- R10-security M1 (2026-11-15): when Stripe last recorded a paid invoice for
-- the workspace's current subscription. The free limits leave a plan out only
-- once it is set (paysForPlan, src/lib/billing.ts). Additive: a nullable
-- column with no default, so no table rewrite; every existing row gets NULL
-- (no plan has been paid while billing is off), and older code ignores it.
SET lock_timeout = '5s';

ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "planPaidAt" TIMESTAMP(3);
