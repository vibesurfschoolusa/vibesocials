-- Brand voice per workspace. Two nullable columns, so the previous code keeps working.
ALTER TABLE "Workspace" ADD COLUMN "brandVoice" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "brandVoiceExamples" TEXT;
