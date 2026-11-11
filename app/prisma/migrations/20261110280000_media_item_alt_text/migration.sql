-- Alt text per photo (07d). One nullable column, so the previous code keeps working.
ALTER TABLE "MediaItem" ADD COLUMN "altText" TEXT;
