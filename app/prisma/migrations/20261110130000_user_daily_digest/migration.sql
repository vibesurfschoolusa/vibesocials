-- Daily problems email preference. Additive with a default, so the previous code keeps working.
ALTER TABLE "User" ADD COLUMN "notifyDailyDigest" BOOLEAN NOT NULL DEFAULT true;
