import type { Platform } from "@prisma/client";

import { buildCaptionWithFooter, type CaptionFooterUser } from "@/lib/captionFooter";
import { prisma } from "@/lib/db";
import { removeXMentions } from "@/lib/xMentions";

/**
 * R62 platform-clients L2: X refuses an empty text on every Retry, and X's text
 * goes out without @mentions (computeTweetText), so a post without a photo
 * whose X text is left empty is refused before it is created or edited.
 */
export const X_TEXT_EMPTY_MESSAGE =
  "X removes @mentions from posts sent through its API, so this post has no text left for X. Add some words, or leave X out.";

/**
 * The refusal for a post without a photo whose X text would be empty, or null.
 * Shared by POST /api/posts and PATCH /api/posts/[postJobId], so the two can't
 * disagree. The text is built as publishing builds it: the X override (an empty
 * one falls back to the base caption, inngest-functions.ts) with the workspace's
 * footer, then without mentions. With no platform list a text post goes to every
 * connection that takes text, so X is a target when the workspace has it; that
 * read runs only when the text is empty.
 */
export async function xTextEmptyRefusal(args: {
  baseCaption: string;
  xOverride: string | null | undefined;
  workspace: CaptionFooterUser & { id: string };
  targetPlatforms: readonly Platform[] | undefined;
}): Promise<string | null> {
  const { targetPlatforms, workspace } = args;
  if (targetPlatforms && !targetPlatforms.includes("x")) return null;
  const caption = args.xOverride ? args.xOverride : args.baseCaption;
  if (removeXMentions(buildCaptionWithFooter(caption, workspace, "x")).trim()) return null;
  if (targetPlatforms) return X_TEXT_EMPTY_MESSAGE;
  const xConnection = await prisma.socialConnection.findFirst({
    where: { workspaceId: workspace.id, platform: "x" },
    select: { id: true },
  });
  return xConnection ? X_TEXT_EMPTY_MESSAGE : null;
}
