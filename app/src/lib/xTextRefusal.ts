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
 * R63 pages-a L1: the Queue's Edit dialog can't change the platforms, so PATCH
 * names what that dialog can do and the way to post without X.
 */
export const X_TEXT_EMPTY_EDIT_MESSAGE =
  "X removes @mentions from posts sent through its API, so this post would have no text for X. Add some words to the caption or to X's own caption. To post without X, cancel this post and create it again without X.";

/** R64 pages-a L1: a draft card offers Delete, not Cancel. */
export const X_TEXT_EMPTY_DRAFT_EDIT_MESSAGE =
  "X removes @mentions from posts sent through its API, so this post would have no text for X. Add some words to the caption or to X's own caption. To post without X, delete this draft and create it again without X.";

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
  /** PATCH's sentence instead of POST's, worded by the post's status. */
  editing?: "draft" | "scheduled";
}): Promise<string | null> {
  const { targetPlatforms, workspace } = args;
  const message =
    args.editing === "draft"
      ? X_TEXT_EMPTY_DRAFT_EDIT_MESSAGE
      : args.editing === "scheduled"
        ? X_TEXT_EMPTY_EDIT_MESSAGE
        : X_TEXT_EMPTY_MESSAGE;
  if (targetPlatforms && !targetPlatforms.includes("x")) return null;
  const caption = args.xOverride ? args.xOverride : args.baseCaption;
  if (removeXMentions(buildCaptionWithFooter(caption, workspace, "x")).trim()) return null;
  if (targetPlatforms) return message;
  const xConnection = await prisma.socialConnection.findFirst({
    where: { workspaceId: workspace.id, platform: "x" },
    select: { id: true },
  });
  return xConnection ? message : null;
}
