import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { PostJobStatus, Platform, type Prisma } from "@prisma/client";
import {
  createPostJobForExistingMedia,
  createPostJobOnly,
  MediaItemUnavailableError,
} from "@/server/jobs/posting";
import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { checkRateLimit } from "@/lib/rateLimit";
import { isValidPerPlatformOverrides, validateScheduledFor, type PostJobIntent } from "@/lib/scheduling";
import type { TikTokPostMetadata, YouTubePostMetadata } from "@/server/platforms/types";
import type { PostsResponse } from "@/lib/postsDto";

/** Runtime set of valid PostJobStatus values, for the `?status=` filter. */
const VALID_POST_JOB_STATUSES = new Set<string>(Object.values(PostJobStatus));

const YOUTUBE_PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;

/** How many recent jobs the activity views load. */
const POSTS_PAGE_SIZE = 50;

/**
 * GET /api/posts
 *
 * Additive, read-only list endpoint powering the dashboard "recent activity"
 * and the /activity view. Returns the authenticated user's most recent post
 * jobs with their per-platform results, projected to display-safe fields only
 * (SEC-1 discipline — no tokens, secrets, or raw connection metadata).
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional `?status=` filter (Roadmap Phase 5) — a comma-separated list of
  // PostJobStatus values, e.g. `?status=scheduled,draft` for the Queue view.
  // Unknown values are ignored; if nothing valid remains the filter is dropped
  // (returns all), so a bad param can never 500 or silently return empty.
  const statusParam = new URL(request.url).searchParams.get("status");
  const statusFilter = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_POST_JOB_STATUSES.has(s))
    : [];

  const where: Prisma.PostJobWhereInput = { userId: user.id };
  if (statusFilter.length > 0) {
    where.status = { in: statusFilter as PostJobStatus[] };
  }

  try {
    const jobs = await prisma.postJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: POSTS_PAGE_SIZE,
      select: {
        id: true,
        status: true,
        createdAt: true,
        scheduledFor: true,
        baseCaption: true,
        mediaItem: { select: { baseCaption: true, storageLocation: true, mimeType: true } },
        // Task 8 — compose-time publish snapshot (Task 7's `publishMetadata`),
        // surfaced read-only via the `publish` DTO field below.
        publishMetadata: true,
        results: {
          select: {
            platform: true,
            status: true,
            externalPostId: true,
            errorMessage: true,
          },
          orderBy: { platform: "asc" },
        },
      },
    });

    // Roadmap Phase 8 (analytics): join the latest engagement snapshot per
    // result. Scoped to the caller (SEC — a metric is only ever read by its
    // owner) and joined by (platform, externalPostId) — the metric's DURABLE
    // identity — so it stays correct even after a connection delete cascades the
    // originating result away but leaves the metric row. YouTube-only in v1, so
    // we only collect/join YouTube video ids. One extra bounded query.
    const youtubeVideoIds = Array.from(
      new Set(
        jobs.flatMap((job) =>
          job.results
            .filter((result) => result.platform === "youtube" && result.externalPostId)
            .map((result) => result.externalPostId as string),
        ),
      ),
    );

    const metricRows = youtubeVideoIds.length
      ? await prisma.postMetric.findMany({
          where: {
            userId: user.id,
            platform: "youtube",
            externalPostId: { in: youtubeVideoIds },
          },
          // SEC-1: display fields only — never raw payload, id, userId, or the
          // postJobResultId link.
          select: {
            externalPostId: true,
            views: true,
            likes: true,
            comments: true,
            shares: true,
            fetchedAt: true,
          },
        })
      : [];

    const metricByVideoId = new Map(metricRows.map((row) => [row.externalPostId, row]));

    const payload: PostsResponse = {
      jobs: jobs.map((job) => {
        // Task 8 — the raw JSON snapshot narrowed to the display fields the
        // DTO exposes. Untyped at the Prisma boundary (Json?), so this cast
        // only asserts the shape we read from — never trusts it beyond that.
        const snapshot = job.publishMetadata as {
          tiktok?: { privacyLevel?: string };
          youtube?: { privacyStatus?: string };
          targetPlatforms?: string[];
        } | null;

        return {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt.toISOString(),
          scheduledFor: job.scheduledFor?.toISOString() ?? null,
          // Scheduled/draft jobs snapshot their caption on the job itself so
          // editing them never mutates shared reused media; fall back to the
          // media item's caption for immediate/older jobs.
          caption: job.baseCaption ?? job.mediaItem?.baseCaption ?? null,
          // Display-only thumbnail source (SEC-1: storageLocation is a public
          // blob URL, already exposed via /api/media — no new secret surface).
          media: job.mediaItem
            ? { url: job.mediaItem.storageLocation, mimeType: job.mediaItem.mimeType }
            : null,
          // Compose-time publish choices, null for legacy/immediate jobs with
          // no snapshot (see PublishMetadataSnapshot, src/server/jobs/posting.ts).
          publish: snapshot
            ? {
                targetPlatforms: (snapshot.targetPlatforms as Platform[] | undefined) ?? null,
                youtubePrivacy: snapshot.youtube?.privacyStatus ?? null,
                tiktokPrivacy: snapshot.tiktok?.privacyLevel ?? null,
              }
            : null,
          results: job.results.map((result) => {
            const metricRow =
              result.platform === "youtube" && result.externalPostId
                ? metricByVideoId.get(result.externalPostId)
                : undefined;
            return {
              platform: result.platform,
              status: result.status,
              externalPostId: result.externalPostId,
              errorMessage: result.errorMessage,
              metric: metricRow
                ? {
                    views: metricRow.views,
                    likes: metricRow.likes,
                    comments: metricRow.comments,
                    shares: metricRow.shares,
                    fetchedAt: metricRow.fetchedAt.toISOString(),
                  }
                : null,
            };
          }),
        };
      }),
    };

    return NextResponse.json(payload);
  } catch (error: unknown) {
    logger.error("[GET /api/posts] Unexpected error", { error, userId: user.id });
    return NextResponse.json(
      { error: "Failed to load posts" },
      { status: 500 },
    );
  }
}

// Shape of the JSON POST body. Fields the handler validates at runtime are
// typed `unknown` (narrowed at use); the rest reflect their consumed types.
// `mediaItemId` (Roadmap Phase 2) is the additive reuse path: a body with
// `mediaItemId` and no `blobUrl` skips upload and re-attaches an existing,
// already-persisted MediaItem instead.
interface CreatePostBody {
  blobUrl?: string;
  mediaItemId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  baseCaption?: unknown;
  location?: unknown;
  perPlatformOverrides?: unknown;
  tiktokMetadata?: unknown;
  youtubeMetadata?: { privacyStatus?: unknown };
  // Task 7 — optional chosen subset of platforms to publish this post to.
  // Absent = every connected platform (legacy/default behavior).
  platforms?: unknown;
  // Roadmap Phase 5. `draft: true` saves a draft (no results, no event);
  // `scheduledFor` (ISO string) schedules for later (no results, no event —
  // the cron claims it when due). Absent both = immediate (today's behavior).
  draft?: unknown;
  scheduledFor?: unknown;
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Roadmap Phase 2 (spec §1.2): POST /api/posts triggers live
  // multi-platform publishing — the heaviest external action in the app —
  // and was unlimited until now. Shared by both the blobUrl and mediaItemId
  // (reuse) creation paths below; checked right after auth, before any
  // parsing/DB work.
  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "posts/publish",
    limit: 30,
    windowMs: 5 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many posts created recently. Please slow down.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
      },
    );
  }

  const contentType = request.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 400 },
    );
  }

  let body: CreatePostBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hasBlobUrl = typeof body?.blobUrl === "string" && body.blobUrl.trim().length > 0;
  const hasMediaItemId =
    typeof body?.mediaItemId === "string" && body.mediaItemId.trim().length > 0;
  // blobUrl wins if a caller somehow sends both, preserving the original
  // (pre-Phase-2) path byte-for-byte for every existing caller.
  const usingExistingMedia = hasMediaItemId && !hasBlobUrl;

  if (!hasBlobUrl && !usingExistingMedia) {
    return NextResponse.json(
      { error: "blobUrl or mediaItemId is required" },
      { status: 400 },
    );
  }

  const baseCaptionRaw = body?.baseCaption;
  const locationRaw = body?.location;
  const overridesRaw = body?.perPlatformOverrides;
  const tiktokMetadataRaw = body?.tiktokMetadata;
  const youtubeMetadataRaw = body?.youtubeMetadata;

  if (typeof baseCaptionRaw !== "string" || !baseCaptionRaw.trim()) {
    return NextResponse.json(
      { error: "baseCaption is required" },
      { status: 400 },
    );
  }

  let perPlatformOverrides: Partial<Record<Platform, string>> | undefined;
  if (overridesRaw != null) {
    // Require a Record<string,string> (review Minor #3 — reject arrays and
    // non-string values so a later publish can't feed a non-string to caption
    // building).
    if (!isValidPerPlatformOverrides(overridesRaw)) {
      return NextResponse.json(
        { error: "perPlatformOverrides must be an object of string values if provided" },
        { status: 400 },
      );
    }
    perPlatformOverrides = overridesRaw as Partial<Record<Platform, string>>;
  }

  let youtubeMetadata: YouTubePostMetadata | undefined;
  if (youtubeMetadataRaw != null) {
    if (
      typeof youtubeMetadataRaw !== "object" ||
      !YOUTUBE_PRIVACY_STATUSES.includes(
        youtubeMetadataRaw.privacyStatus as YouTubePostMetadata["privacyStatus"],
      )
    ) {
      return NextResponse.json(
        {
          error:
            "youtubeMetadata.privacyStatus must be one of: public, unlisted, private",
        },
        { status: 400 },
      );
    }
    youtubeMetadata = {
      privacyStatus: youtubeMetadataRaw.privacyStatus as YouTubePostMetadata["privacyStatus"],
    };
  }

  // Validate TikTok metadata into a clean typed object (previously forwarded raw
  // — now at parity with youtube, and normalized so it can be persisted on
  // scheduled/draft jobs, review B1). `privacyLevel` must be a STRING if present
  // but may be empty: the composer only requires an explicit level for immediate
  // posts, so a scheduled/draft post can legitimately carry none — the TikTok
  // client then applies its SELF_ONLY default at publish (a *chosen* level is
  // preserved and honored). TikTok's allowed set is per-creator (resolved from
  // creator-info), so it's not a fixed enum here; the toggles coerce to booleans.
  let tiktokMetadata: TikTokPostMetadata | undefined;
  if (tiktokMetadataRaw != null) {
    if (typeof tiktokMetadataRaw !== "object" || Array.isArray(tiktokMetadataRaw)) {
      return NextResponse.json(
        { error: "tiktokMetadata must be an object if provided" },
        { status: 400 },
      );
    }
    const raw = tiktokMetadataRaw as Record<string, unknown>;
    if (raw.privacyLevel !== undefined && typeof raw.privacyLevel !== "string") {
      return NextResponse.json(
        { error: "tiktokMetadata.privacyLevel must be a string" },
        { status: 400 },
      );
    }
    tiktokMetadata = {
      privacyLevel: typeof raw.privacyLevel === "string" ? raw.privacyLevel : "",
      disableComment: Boolean(raw.disableComment),
      disableDuet: Boolean(raw.disableDuet),
      disableStitch: Boolean(raw.disableStitch),
      ...(raw.brandedContent !== undefined ? { brandedContent: Boolean(raw.brandedContent) } : {}),
      ...(raw.brandOrganic !== undefined ? { brandOrganic: Boolean(raw.brandOrganic) } : {}),
    };
  }

  // Task 7 — optional per-post platform targeting: a chosen subset of the
  // user's connected platforms to publish to. Absent (`undefined`) means
  // "every connection" (legacy/default behavior) all the way down through
  // the create helpers. SEC-1: only ever a display-safe Platform enum value.
  const VALID_PLATFORMS = new Set<string>(Object.values(Platform));
  let targetPlatforms: Platform[] | undefined;
  if (body?.platforms != null) {
    if (!Array.isArray(body.platforms) || body.platforms.some((p) => typeof p !== "string")) {
      return NextResponse.json(
        { error: "platforms must be an array of platform names" },
        { status: 400 },
      );
    }
    const unknown = body.platforms.filter((p) => !VALID_PLATFORMS.has(p));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Unknown platform(s): ${unknown.join(", ")}` },
        { status: 400 },
      );
    }
    const deduped = Array.from(new Set(body.platforms)) as Platform[];
    if (deduped.length === 0) {
      return NextResponse.json({ error: "Select at least one platform." }, { status: 400 });
    }
    targetPlatforms = deduped;
  }

  const location = typeof locationRaw === "string" && locationRaw.trim() ? locationRaw.trim() : undefined;

  // Roadmap Phase 5 — resolve the intent. `draft: true` wins; otherwise a
  // present `scheduledFor` means "schedule" (validated to be a real, future
  // time); otherwise it's an immediate post (today's path, byte-for-byte).
  let intent: PostJobIntent = "immediate";
  let scheduledForDate: Date | null = null;
  if (body?.draft === true) {
    intent = "draft";
  } else if (body?.scheduledFor != null) {
    const validation = validateScheduledFor(body.scheduledFor, new Date());
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    intent = "scheduled";
    scheduledForDate = validation.date;
  }

  try {
    // Create job records without executing (for background processing).
    // Reuse (mediaItemId, Roadmap Phase 2) skips MediaItem creation via
    // createPostJobForExistingMedia; the original blobUrl path is untouched.
    let postJobId: string;
    let mediaItemId: string;

    if (usingExistingMedia) {
      const created = await createPostJobForExistingMedia({
        userId: user.id,
        mediaItemId: body.mediaItemId as string,
        baseCaption: baseCaptionRaw,
        perPlatformOverrides,
        location,
        intent,
        scheduledFor: scheduledForDate,
        // Persisted onto the job for scheduled/draft (review B1); ignored for
        // immediate (which carries them in the event below).
        tiktokMetadata,
        youtubeMetadata,
        // Task 7 — chosen platform subset; undefined = every connection.
        targetPlatforms,
      });
      postJobId = created.postJobId;
      mediaItemId = created.mediaItemId;
    } else {
      // Redundant with the `hasBlobUrl` check above at runtime (this branch
      // only runs when `usingExistingMedia` is false, which — given the
      // earlier guard — guarantees `hasBlobUrl`), but TypeScript can't carry
      // that guarantee through the intermediate boolean, so this narrows
      // `body.blobUrl` to `string` for the call below.
      if (typeof body.blobUrl !== "string" || !body.blobUrl.trim()) {
        return NextResponse.json(
          { error: "blobUrl is required" },
          { status: 400 },
        );
      }

      const created = await createPostJobOnly({
        userId: user.id,
        media: {
          storageLocation: body.blobUrl,
          originalFilename: body.filename || "upload",
          mimeType: body.mimeType || "application/octet-stream",
          sizeBytes: body.sizeBytes || 0,
        },
        baseCaption: baseCaptionRaw,
        location,
        perPlatformOverrides,
        intent,
        scheduledFor: scheduledForDate,
        // Persisted onto the job for scheduled/draft (review B1); ignored for
        // immediate (which carries them in the event below).
        tiktokMetadata,
        youtubeMetadata,
        // Task 7 — chosen platform subset; undefined = every connection.
        targetPlatforms,
      });
      postJobId = created.postJobId;
      mediaItemId = created.mediaItemId;
    }

    // Immediate posts trigger the background publish now. Scheduled/draft jobs
    // send NO event here (Roadmap Phase 5): a scheduled job is picked up by the
    // cron due-scanner when `scheduledFor` arrives (which materializes its
    // per-platform results from the connections that exist THEN — the review's
    // run-time-result-creation fix), and a draft is promoted via the publish
    // endpoint. The event shape is identical to the reuse path; the publisher
    // resolves media by id, so it needs no changes.
    if (intent === "immediate") {
      await inngest.send({
        name: "post/publish.requested",
        data: {
          postJobId,
          userId: user.id,
          mediaItemId,
          baseCaption: baseCaptionRaw,
          location,
          perPlatformOverrides,
          tiktokMetadata,
          youtubeMetadata,
        },
      });
    }

    // Return immediately - job runs in background
    const postJob = await prisma.postJob.findUnique({
      where: { id: postJobId },
    });
    const results = await prisma.postJobResult.findMany({
      where: { postJobId },
    });

    const message =
      intent === "draft"
        ? "Draft saved."
        : intent === "scheduled"
          ? "Post scheduled."
          : "Publishing in progress. Large videos may take a few minutes.";

    return NextResponse.json({ postJob, results, message });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "NO_CONNECTIONS") {
      return NextResponse.json(
        {
          error: "No connected platforms",
          code: "NO_CONNECTIONS",
          message: "Connect at least one platform before creating a post.",
        },
        { status: 400 },
      );
    }

    if (error instanceof MediaItemUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 404 },
      );
    }

    logger.error("[POST /api/posts] Unexpected error", { error, usingExistingMedia, userId: user.id });
    return NextResponse.json(
      { error: "Failed to create post" },
      { status: 500 },
    );
  }
}
