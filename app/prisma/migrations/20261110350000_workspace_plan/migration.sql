-- Plans and the free trial (21a, 2026-11-10). Additive: five new columns on
-- Workspace, four nullable and one with a default. The code still serving
-- during the release never reads them.
--
-- Every workspace that exists when this runs must be exempt, so the operator's
-- own and hand-invoiced clients keep working when billing is switched on.
-- billingExempt is added with DEFAULT true, which fills every existing row
-- (Postgres stores a constant default without rewriting the table), and the
-- default is then changed to false for workspaces created afterwards. There is
-- no UPDATE, and every ADD is IF NOT EXISTS, so a second run changes nothing
-- and cannot exempt a workspace created since the first.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "plan" TEXT,
ADD COLUMN IF NOT EXISTS "planStatus" TEXT,
ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "currentPeriodEnd" TIMESTAMP(3);

-- AlterTable: existing workspaces exempt
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "billingExempt" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: new workspaces not exempt
ALTER TABLE "Workspace" ALTER COLUMN "billingExempt" SET DEFAULT false;
