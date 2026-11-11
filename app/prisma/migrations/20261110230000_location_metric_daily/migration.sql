-- Google listing numbers (2026-11-10). Additive: one new table, its indexes and
-- its foreign key. No existing row is touched, so the code still serving during
-- the release keeps working.

-- CreateTable
CREATE TABLE "LocationMetricDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "searchViews" INTEGER NOT NULL DEFAULT 0,
    "mapsViews" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "directionRequests" INTEGER NOT NULL DEFAULT 0,
    "websiteClicks" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationMetricDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LocationMetricDaily_workspaceId_locationName_day_key" ON "LocationMetricDaily"("workspaceId", "locationName", "day");

-- CreateIndex
CREATE INDEX "LocationMetricDaily_workspaceId_day_idx" ON "LocationMetricDaily"("workspaceId", "day");

-- AddForeignKey
ALTER TABLE "LocationMetricDaily" ADD CONSTRAINT "LocationMetricDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
