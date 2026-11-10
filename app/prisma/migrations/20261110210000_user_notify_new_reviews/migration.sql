-- New Google review email preference. Additive with a default, so the previous code keeps working.
ALTER TABLE "User" ADD COLUMN "notifyNewReviews" BOOLEAN NOT NULL DEFAULT true;
