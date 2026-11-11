-- Report logo and monthly report email. All additive: two nullable columns and a
-- boolean with a default, so the previous code keeps working with the new schema.
ALTER TABLE "Workspace" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "monthlyReportSentFor" TEXT;
ALTER TABLE "User" ADD COLUMN "notifyMonthlyReport" BOOLEAN NOT NULL DEFAULT true;
