-- Per-workspace usage limit overrides. Null = the environment value or the built-in default.
ALTER TABLE "Workspace" ADD COLUMN "limitPostsPerDay" INTEGER,
ADD COLUMN "limitXPostsPerMonth" INTEGER,
ADD COLUMN "limitYoutubeUploadsPerDay" INTEGER,
ADD COLUMN "limitStorageMb" INTEGER;
