-- Tracking tags on the website link (opt-in). NOT NULL with a default of false,
-- so every existing workspace stays off and the previous code keeps working.
ALTER TABLE "Workspace" ADD COLUMN "trackWebsiteLinks" BOOLEAN NOT NULL DEFAULT false;
