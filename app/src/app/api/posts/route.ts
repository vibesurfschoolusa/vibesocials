import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import type { Platform } from "@prisma/client";
import { createPostJobOnly } from "@/server/jobs/posting";
import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import type { YouTubePostMetadata } from "@/server/platforms/types";
import type { PostsResponse } from "@/lib/postsDto";

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
export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const jobs = await prisma.postJob.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: POSTS_PAGE_SIZE,
      select: {
        id: true,
        status: true,
        createdAt: true,
        mediaItem: { select: { baseCaption: true } },
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

    const payload: PostsResponse = {
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt.toISOString(),
        caption: job.mediaItem?.baseCaption ?? null,
        results: job.results.map((result) => ({
          platform: result.platform,
          status: result.status,
          externalPostId: result.externalPostId,
          errorMessage: result.errorMessage,
        })),
      })),
    };

    return NextResponse.json(payload);
  } catch (error: unknown) {
    console.error("[GET /api/posts] Unexpected error", { error });
    return NextResponse.json(
      { error: "Failed to load posts" },
      { status: 500 },
    );
  }
}

// Shape of the JSON POST body. Fields the handler validates at runtime are
// typed `unknown` (narrowed at use); the rest reflect their consumed types.
interface CreatePostBody {
  blobUrl?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  baseCaption?: unknown;
  location?: unknown;
  perPlatformOverrides?: unknown;
  tiktokMetadata?: unknown;
  youtubeMetadata?: { privacyStatus?: unknown };
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  if (!body?.blobUrl) {
    return NextResponse.json(
      { error: "blobUrl is required" },
      { status: 400 },
    );
  }

  const blobUrl = body.blobUrl;
  const filename = body.filename || "upload";
  const mimeType = body.mimeType || "application/octet-stream";
  const sizeBytes = body.sizeBytes || 0;
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
    if (typeof overridesRaw !== "object") {
      return NextResponse.json(
        { error: "perPlatformOverrides must be an object if provided" },
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

  const location = typeof locationRaw === "string" && locationRaw.trim() ? locationRaw.trim() : undefined;

  try {
    // Create job records without executing (for background processing)
    const { postJobId, mediaItemId } = await createPostJobOnly({
      userId: user.id,
      media: {
        storageLocation: blobUrl,
        originalFilename: filename,
        mimeType,
        sizeBytes,
      },
      baseCaption: baseCaptionRaw,
      location,
      perPlatformOverrides,
    });

    // Trigger background job via Inngest
    await inngest.send({
      name: "post/publish.requested",
      data: {
        postJobId,
        userId: user.id,
        mediaItemId,
        baseCaption: baseCaptionRaw,
        location,
        perPlatformOverrides,
        tiktokMetadata: tiktokMetadataRaw,
        youtubeMetadata,
      },
    });

    // Return immediately - job runs in background
    const postJob = await prisma.postJob.findUnique({
      where: { id: postJobId },
    });
    const results = await prisma.postJobResult.findMany({
      where: { postJobId },
    });

    return NextResponse.json({
      postJob,
      results,
      message: "Publishing in progress. Large videos may take a few minutes.",
    });
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

    console.error("[POST /api/posts] Unexpected error (blob upload)", { error });
    return NextResponse.json(
      { error: "Failed to create post" },
      { status: 500 },
    );
  }
}
