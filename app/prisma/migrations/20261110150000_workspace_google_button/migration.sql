-- The default button for every Google Business Profile post (null = none). Additive.
ALTER TABLE "Workspace" ADD COLUMN "googleButtonType" TEXT,
ADD COLUMN "googleButtonUrl" TEXT;
