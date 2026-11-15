import type { Platform, Prisma } from "@prisma/client";

import { buildCaptionWithFooter, type CaptionFooterUser } from "@/lib/captionFooter";
import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { buildPlatformPreview } from "@/lib/platformPreview";
import { platformAcceptsTextOnly } from "@/lib/platformLimits";
import { PLATFORM_ORDER, platformCaptionEntries, platformLabel } from "@/lib/platforms";
import {
  DAY_MS,
  REVIEW_CHANGE_SHOWN_DAYS,
  REVIEW_LIST_MAX,
  isReviewLinkTokenShape,
  reviewWindowEnd,
  type ReviewPostDTO,
} from "@/lib/reviewLink";
import { STORY_NO_CAPTION, storyListing, storyPlatformsOf } from "@/lib/storyPlacement";
import { billingFieldsSelect } from "@/lib/billing";
import { planIncludes } from "@/lib/planFeatures";
import { workspaceBlock } from "@/lib/workspaceStatus";
import { resolvePlatformCaptions } from "@/server/jobs/posting";
import { buildClientChangeRequestEmail } from "@/server/notifications/clientChangeRequestEmail";
import { sendEmail } from "@/server/notifications/email";

/**
 * Client review link (2026-11-10), server side: resolving a token from the URL
 * to its link, the list the public page shows, and the owners' email when the
 * client asks for a change.
 */

export type ActiveReviewLink = {
  id: string;
  workspaceId: string;
  workspaceName: string;
};

/**
 * The active link a raw token names, or null. Unknown and revoked both give
 * null, so every caller answers them the same way. The public routes take the
 * workspace from this, never from the request. A paused workspace's link is not
 * active either (workspaceBlock) until it is resumed; the client is not told why.
 */
export async function findActiveReviewLink(token: string): Promise<ActiveReviewLink | null> {
  if (!isReviewLinkTokenShape(token)) return null;
  const row = await prisma.workspaceReviewLink.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      id: true,
      workspaceId: true,
      revokedAt: true,
      // 21a: the plan columns too, only with billing on.
      workspace: { select: { name: true, pausedAt: true, pausedReason: true, ...billingFieldsSelect() } },
    },
  });
  if (!row || row.revokedAt || workspaceBlock(row.workspace)) return null;
  // P1: without the plan feature the link is paused, answered as inactive; never revoked.
  if (!planIncludes(row.workspace, "clientLinks")) return null;
  return { id: row.id, workspaceId: row.workspaceId, workspaceName: row.workspace.name };
}

/**
 * The columns the list reads. No user, no workspace, no results: the captions
 * and the targets are read here only to work out what the page shows, and the
 * raw rows never leave this module.
 */
const REVIEW_POST_SELECT = {
  id: true,
  status: true,
  // The version an approval is pinned to.
  updatedAt: true,
  scheduledFor: true,
  baseCaption: true,
  perPlatformOverrides: true,
  publishMetadata: true,
  clientApprovedAt: true,
  clientChangeRequestedAt: true,
  clientNote: true,
  // F6: set on the Story job of a Feed and Story post.
  storyOfPostJobId: true,
  // Null for a post without a file (2026-11-10).
  mediaItemId: true,
  mediaItem: {
    select: { baseCaption: true, perPlatformOverrides: true, storageLocation: true, mimeType: true },
  },
} satisfies Prisma.PostJobSelect;

type ReviewPostRow = Prisma.PostJobGetPayload<{ select: typeof REVIEW_POST_SELECT }>;

/** What the client sees in place of the caption when nothing of it is published. */
const REVIEW_STORY_ONLY_LINE = "This goes out as a Story, with no caption.";

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(PLATFORM_ORDER);

/** The platforms the post chose, or null when it goes to whatever is connected then. */
function chosenPlatforms(publishMetadata: Prisma.JsonValue | null): Platform[] | null {
  const targets = (publishMetadata as { targetPlatforms?: unknown } | null)?.targetPlatforms;
  if (!Array.isArray(targets)) return null;
  const known = targets.filter((p): p is Platform => typeof p === "string" && KNOWN_PLATFORMS.has(p));
  return known.length ? PLATFORM_ORDER.filter((p) => known.includes(p)) : null;
}

/**
 * F6: one card of the page. A Feed and Story post is two jobs; the page shows
 * the feed one with `alsoStory`, the line that names its Story, and no card of
 * its own for the Story. Absent on every other card.
 */
export type ReviewCardDTO = ReviewPostDTO & { alsoStory?: string };

type PairFacts = { id: string; storyOfPostJobId: string | null; scheduledFor: Date | null };

/**
 * F6: the other half of a Feed and Story post that a client decision on `job`
 * also takes: the Story of a feed post, or the feed post of a Story, while it
 * is in the link's workspace, still scheduled and at the same time. A half the
 * owner cancelled, published, deleted or moved is not taken, so the decision
 * acts on what is left. The page folds a Story into its feed card by the same
 * rule (foldStoryPairs), so a decision takes exactly what the card showed.
 */
export function storyPairWhere(workspaceId: string, job: PairFacts): Prisma.PostJobWhereInput {
  return {
    workspaceId,
    status: "scheduled",
    scheduledFor: job.scheduledFor,
    id: { not: job.id },
    OR: [{ storyOfPostJobId: job.id }, ...(job.storyOfPostJobId ? [{ id: job.storyOfPostJobId }] : [])],
  };
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** "Instagram and Facebook Page". */
function joinLabels(labels: string[]): string {
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * F6: each Story whose feed post is listed with the same status and time,
 * keyed by that feed post's id. Any other Story (its feed post gone, ended,
 * moved, or in another state) stays a card of its own, as before.
 */
function foldStoryPairs(rows: ReviewPostRow[]): Map<string, ReviewPostRow> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const storyOf = new Map<string, ReviewPostRow>();
  for (const row of rows) {
    const feed = row.storyOfPostJobId ? byId.get(row.storyOfPostJobId) : undefined;
    if (feed && feed.status === row.status && sameTime(feed.scheduledFor, row.scheduledFor)) {
      storyOf.set(feed.id, row);
    }
  }
  return storyOf;
}

/** The line on a feed card for its Story: the Story's own platforms. */
function alsoStoryLine(story: ReviewPostRow): string {
  const targets = chosenPlatforms(story.publishMetadata);
  const stories = storyPlatformsOf(story.publishMetadata).filter((p) => !targets || targets.includes(p));
  return stories.length ? `Also as a Story on ${joinLabels(stories.map(platformLabel))}` : "Also as a Story";
}

/**
 * Rows each query reads: a card may hold two (a feed post and its folded
 * Story), and one card more than the page shows tells it there are more.
 */
const REVIEW_ROWS_TAKE = 2 * REVIEW_LIST_MAX + 1;

/** The order the page lists cards in: by time, the ones without a time last. */
function cardOrder(a: { scheduledFor: string | null; id: string }, b: { scheduledFor: string | null; id: string }): number {
  return (a.scheduledFor ?? "￿").localeCompare(b.scheduledFor ?? "￿") || a.id.localeCompare(b.id);
}

/**
 * What the public page lists for a workspace: its scheduled posts in the next
 * 60 days and the drafts its client asked to change in the last 30 days,
 * merged in time order, at most 100 cards (R7-client-journey L5: counted
 * after a Story is folded into its feed post's card, so the cut never parts a
 * pair) plus one more when there are more, so the page can say so
 * (review-link-view.tsx shows the 100). Only drafts and scheduled
 * posts are ever asked for, so a published, failed or cancelled post cannot
 * appear. A change request is cleared when the post is scheduled again, so a
 * draft that still carries one was not.
 */
export async function listReviewPosts(workspaceId: string, now: Date): Promise<ReviewCardDTO[]> {
  const scheduled = await prisma.postJob.findMany({
    where: {
      workspaceId,
      status: "scheduled",
      scheduledFor: { gte: now, lte: reviewWindowEnd(now) },
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    take: REVIEW_ROWS_TAKE,
    select: REVIEW_POST_SELECT,
  });
  const changed = await prisma.postJob.findMany({
    where: {
      workspaceId,
      status: "draft",
      clientChangeRequestedAt: { gte: new Date(now.getTime() - REVIEW_CHANGE_SHOWN_DAYS * DAY_MS) },
    },
    orderBy: [{ clientChangeRequestedAt: "desc" }, { id: "asc" }],
    take: REVIEW_ROWS_TAKE,
    select: REVIEW_POST_SELECT,
  });
  const listed: ReviewPostRow[] = [...scheduled, ...changed];
  if (listed.length === 0) return [];
  // F6: a Story folded into its feed post's card has no card of its own.
  const storyOf = foldStoryPairs(listed);
  const folded = new Set(Array.from(storyOf.values(), (row) => row.id));
  const rows = listed
    .filter((row) => !folded.has(row.id))
    .sort((a, b) => cardOrder(cardKey(a), cardKey(b)))
    .slice(0, REVIEW_LIST_MAX + 1);

  // As GET /api/posts: one grouped count for the posts with several photos.
  const photoCounts = await prisma.postJobMedia.groupBy({
    by: ["postJobId"],
    where: { postJobId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  });
  const photoCountById = new Map(photoCounts.map((row) => [row.postJobId, row._count._all]));

  // A post with no chosen platforms goes to whatever is connected when it publishes.
  let connected: Platform[] = [];
  if (rows.some((row) => chosenPlatforms(row.publishMetadata) === null)) {
    const connections = await prisma.socialConnection.findMany({
      where: { workspaceId },
      select: { platform: true },
    });
    const present = new Set(connections.map((c) => c.platform));
    connected = PLATFORM_ORDER.filter((p) => present.has(p));
  }

  // The footer the publisher adds to every caption (inngest-functions.ts). These
  // two fields go out with every post, so they may appear in the text; the
  // tracking-tags flag only decides whether each platform's link is tagged, as
  // it is at publish time. Nothing else of the workspace is read.
  const footer: CaptionFooterUser =
    (await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { companyWebsite: true, defaultHashtags: true, trackWebsiteLinks: true },
    })) ?? {};

  const posts = rows.map((row): ReviewCardDTO => {
    // Only a draft is on hold. A scheduled post always gets its buttons, whatever
    // its client columns say (every write that schedules a post clears them).
    const changeRequested = row.status === "draft" && row.clientChangeRequestedAt !== null;
    const caption = row.baseCaption ?? row.mediaItem?.baseCaption ?? "";
    // A post without a file goes only to the connected platforms that take text alone.
    const textPost = row.mediaItemId === null;
    const targets =
      chosenPlatforms(row.publishMetadata) ?? (textPost ? connected.filter(platformAcceptsTextOnly) : connected);
    // A Story publishes no caption, so none may be shown as going out.
    // Only a platform the post goes to: a Story choice for any other adds nothing.
    const stories: Platform[] = storyPlatformsOf(row.publishMetadata).filter((p) => targets.includes(p));
    const listing = storyListing(targets, resolvePlatformCaptions(row, row.mediaItem), stories);
    const story = storyOf.get(row.id);
    // A pair reads as approved only when the client's approval is on both halves.
    const approved = row.clientApprovedAt !== null && (!story || story.clientApprovedAt !== null);
    return {
      id: row.id,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      platforms: listing.platformLabels,
      caption: listing.storyOnly ? REVIEW_STORY_ONLY_LINE : buildCaptionWithFooter(caption, footer),
      // Each platform's own text as that platform posts it: footer added, X
      // without @-mentions, cut to the platform's length (lib/platformPreview.ts).
      platformCaptions: platformCaptionEntries(listing.platformCaptions).map(({ platform, label, text }) => ({
        label,
        // The Story entry is a fixed note, not caption text: no footer, no cut.
        text:
          stories.includes(platform) && text === STORY_NO_CAPTION
            ? text
            : buildPlatformPreview({ platform, caption, override: text, user: footer }).rendered,
      })),
      media: row.mediaItem
        ? { url: row.mediaItem.storageLocation, mimeType: row.mediaItem.mimeType }
        : null,
      mediaCount: textPost ? 0 : (photoCountById.get(row.id) ?? 1),
      state: changeRequested ? "change_requested" : approved ? "approved" : "none",
      note: changeRequested ? row.clientNote : null,
      version: row.updatedAt.toISOString(),
      ...(story ? { alsoStory: alsoStoryLine(story) } : {}),
    };
  });

  return posts.sort(cardOrder);
}

function cardKey(row: ReviewPostRow): { scheduledFor: string | null; id: string } {
  return { scheduledFor: row.scheduledFor?.toISOString() ?? null, id: row.id };
}

/** How long the owners' email may run before the caller carries on (as uploadLink.ts). */
const NOTIFY_TIMEOUT_MS = 5_000;

type ClientChangeNotice = {
  postJobId: string;
  workspaceId: string;
  workspaceName: string;
  note: string;
  requestedAt: Date;
  /** F6: the request also pulled back the post's Story; the email names both. */
  withStory?: boolean;
};

async function sendClientChangeEmails(args: ClientChangeNotice): Promise<void> {
  const { postJobId, workspaceId } = args;
  const post = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
    select: { scheduledFor: true, baseCaption: true, mediaItem: { select: { baseCaption: true } } },
  });
  if (!post) return;

  const owners = await prisma.workspaceMember.findMany({
    where: { workspaceId, role: "owner" },
    select: { user: { select: { id: true, email: true, timeZone: true } } },
  });
  // One email per owner: the post's time is shown in each owner's own zone (F4).
  const emailFor = (timeZone: string | null) =>
    buildClientChangeRequestEmail({
      workspaceId,
      workspaceName: args.workspaceName,
      timeZone,
      scheduledFor: post.scheduledFor,
      caption: post.baseCaption ?? post.mediaItem?.baseCaption ?? "",
      note: args.note,
      appUrl: process.env.NEXTAUTH_URL ?? "",
      ...(args.withStory ? { withStory: true } : {}),
    });
  const requestKey = args.requestedAt.toISOString();
  for (const owner of owners) {
    await sendEmail(
      { to: owner.user.email, ...emailFor(owner.user.timeZone ?? null) },
      { idempotencyKey: `client-change/${postJobId}/${requestKey}/${owner.user.id}` },
    );
  }
}

/**
 * Email the owners that the client asked for a change. Follows
 * notifyOwnersOfClientUpload: the per-owner idempotency key (the post and the
 * request time) stops a repeat, it never throws, and it stops waiting after 5
 * seconds. The decision route runs it after the response, so it never delays
 * or fails the client's request. One email per change request: a request needs
 * the post to be scheduled, and only the workspace can schedule it again.
 */
export async function notifyOwnersOfClientChange(args: ClientChangeNotice): Promise<void> {
  const { postJobId, workspaceId } = args;
  const work = sendClientChangeEmails(args).then(
    () => "sent" as const,
    (error: unknown) => {
      logger.error("[review-link] Couldn't email the owners about a change request (ignored)", {
        error,
        postJobId,
        workspaceId,
      });
      return "failed" as const;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), NOTIFY_TIMEOUT_MS);
  });
  try {
    if ((await Promise.race([work, timeout])) === "timeout") {
      logger.error("[review-link] Emailing the owners took too long; carrying on", {
        postJobId,
        workspaceId,
        timeoutMs: NOTIFY_TIMEOUT_MS,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}
