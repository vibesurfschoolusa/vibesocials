import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import {
  EMAIL_VERIFY_REQUIRED_MESSAGE,
  isEmailVerifiedForPublish,
} from "@/lib/emailVerified";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { inngest } from "@/lib/inngest";
import { checkRateLimit } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { getWorkspaceContext } from "@/lib/workspace";
import { recomputeAndStorePostJobStatus } from "@/server/jobs/failPendingResults";
import { buildRetryEvent } from "@/server/jobs/posting";
import { Prisma, type Platform } from "@prisma/client";

interface RetryRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

/**
 * Parsed retry request: retry every failed platform, or one named platform.
 */
export type RetryTarget =
  | { kind: "all" }
  | { kind: "platform"; platform: Platform };

/**
 * Pure request-body validator for `POST /api/posts/[postJobId]/retry`. Split
 * out (no DB, no auth) so the accept/reject matrix is unit-testable in
 * isolation — mirrors the `isMediaDeletable` / `assertMediaItemReusable`
 * pattern. `retryAllFailed: true` wins if a caller somehow sends both.
 */
export function parseRetryBody(body: unknown): RetryTarget | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Body must be an object with `platform` or `retryAllFailed`." };
  }

  const { platform, retryAllFailed } = body as {
    platform?: unknown;
    retryAllFailed?: unknown;
  };

  if (retryAllFailed === true) {
    return { kind: "all" };
  }

  if (typeof platform === "string") {
    if (!(PLATFORM_ORDER as readonly string[]).includes(platform)) {
      return { error: "Unknown platform." };
    }
    return { kind: "platform", platform: platform as Platform };
  }

  return { error: "Provide `platform` (one) or `retryAllFailed: true`." };
}

/**
 * POST /api/posts/[postJobId]/retry — Roadmap Phase 3.
 *
 * Re-publishes previously failed platform(s) of an existing post without
 * touching the ones that already succeeded. Auth + ownership scoped (404 if the
 * job isn't the caller's). Body: `{ platform }` (one) or `{ retryAllFailed:
 * true }`.
 *
 * Two subtle guards:
 *  - IDEMPOTENCY: each target platform is flipped `failed -> pending` via an
 *    ATOMIC conditional `updateMany({ where: { status: "failed" } })`. Only a
 *    row still in `failed` flips; a double-click or a concurrent retry that
 *    already claimed it gets `count === 0` and is dropped, so a live post is
 *    never created twice (publishing is NOT idempotent). If NOTHING was
 *    eligible -> 409.
 *  - RATE LIMIT: a tight per-user bucket (abuse = duplicate live posts).
 *
 * On success it sets `PostJob.status = in_progress` and emits
 * `post/retry.requested` for the `retryPlatforms` Inngest function.
 */
export async function POST(request: NextRequest, context: RetryRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Tight rate limit right after auth, before any parsing/DB work. Retrying is
  // a live external publish; abuse would create duplicate posts.
  const rateLimit = await checkRateLimit({
    userId: workspaceContext.user.id,
    route: "posts/retry",
    limit: 10,
    windowMs: 5 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many retries recently. Please slow down.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
      },
    );
  }

  // Same live-publish gate as POST /api/posts and publish-now.
  if (!isEmailVerifiedForPublish(workspaceContext.user)) {
    return NextResponse.json(
      { error: EMAIL_VERIFY_REQUIRED_MESSAGE, code: "EMAIL_VERIFY_REQUIRED" },
      { status: 403 },
    );
  }

  const { postJobId } = await Promise.resolve(context.params);

  const rawBody = await readJsonObject(request);
  if (!rawBody) {
    return invalidJsonBodyResponse();
  }

  const target = parseRetryBody(rawBody);
  if ("error" in target) {
    return NextResponse.json({ error: target.error }, { status: 400 });
  }

  // Ownership + the data needed to decide eligibility, in one query. Team
  // Workspaces (Task 4): any member of the job's workspace, not just its
  // creator (design §1) — a job in a different workspace 404s exactly like
  // "doesn't exist" (no 403 existence oracle).
  const postJob = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
    select: {
      id: true,
      mediaItem: { select: { deletedAt: true } },
      results: { select: { platform: true, status: true } },
    },
  });

  if (!postJob) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The blob must still exist to re-fetch and re-publish (Phase 1 soft-delete
  // removes it). If it's gone, the post can't be retried — only recreated.
  if (postJob.mediaItem.deletedAt !== null) {
    return NextResponse.json(
      {
        error: "This post's media is no longer available — recreate the post.",
        code: "MEDIA_UNAVAILABLE",
      },
      { status: 409 },
    );
  }

  // Candidate platforms: the named one, or every currently-failed platform.
  let candidates: Platform[];
  if (target.kind === "all") {
    candidates = postJob.results
      .filter((r) => r.status === "failed")
      .map((r) => r.platform);
  } else {
    const hasResult = postJob.results.some((r) => r.platform === target.platform);
    if (!hasResult) {
      return NextResponse.json(
        {
          error: "That platform has no result on this post to retry.",
          code: "NOTHING_TO_RETRY",
        },
        { status: 409 },
      );
    }
    candidates = [target.platform];
  }

  if (candidates.length === 0) {
    return NextResponse.json(
      {
        error: "Nothing to retry — this post has no failed platforms.",
        code: "NOTHING_TO_RETRY",
      },
      { status: 409 },
    );
  }

  // Reconnect preflight for the single-platform path (the UI's call): if the
  // connection is dead, retrying would just fail again — surface a reconnect
  // signal the client can turn into a "Reconnect … in Settings" link, and don't
  // flip anything to pending.
  if (target.kind === "platform") {
    // Team Workspaces (Task 4): the connection lookup now reads the caller's
    // ACTIVE workspace directly off the context (replaces the Task 2
    // `resolveWorkspaceForUser` bridge, which always resolved the caller's
    // PERSONAL workspace — wrong for an invited member acting in someone
    // else's shared workspace).
    const connection = await prisma.socialConnection.findUnique({
      where: {
        workspaceId_platform: {
          workspaceId: workspaceContext.workspace.id,
          platform: target.platform,
        },
      },
      select: { needsReconnect: true },
    });

    if (!connection || connection.needsReconnect) {
      return NextResponse.json(
        {
          error: `Reconnect ${platformLabel(target.platform)} in Settings before retrying.`,
          code: "RECONNECT_REQUIRED",
          platform: target.platform,
        },
        { status: 409 },
      );
    }
  }

  // IDEMPOTENCY GUARD: atomically claim each candidate (failed -> pending).
  // Only rows still in `failed` flip; a concurrent/duplicate retry that already
  // claimed a platform sees `count === 0` for it and it's dropped — so the same
  // platform can never be published twice by OUR retries. The flip also clears
  // the result's publish claim (claimRunId / claimedAt, 2026-11-01 scale audit,
  // jobs H6): a result that failed — including one marked PUBLISH_UNCONFIRMED —
  // carries its dead run's claim, and the retry run must be able to take its own.
  // It also drops any saved upload state (2026-11-02 scale audit, jobs, chunked
  // uploads): the retry run uploads from the start, and the old state holds
  // sealed capability URLs of a session that is over.
  //
  // KNOWN LIMITATION (accepted for v1): this cannot stop a provider false
  // negative — if a platform actually published but we recorded `failed`
  // (notably TikTok's TIKTOK_PUBLISH_PENDING, where the video "may still be
  // processing"), a retry creates a second live post. No provider exposes an
  // idempotency key here. A future guard could warn on retrying a timeout-coded
  // failure or persist provider post-ids to dedupe.
  const claims = await Promise.all(
    candidates.map(async (platform) => {
      const { count } = await prisma.postJobResult.updateMany({
        where: { postJobId, platform, status: "failed" },
        data: {
          status: "pending",
          errorCode: null,
          errorMessage: null,
          claimRunId: null,
          claimedAt: null,
          // ...and any deferral a dead run left on it (platform limits).
          deferredUntil: null,
          uploadState: Prisma.DbNull,
        },
      });
      return { platform, claimed: count > 0 };
    }),
  );

  const eligible = claims.filter((c) => c.claimed).map((c) => c.platform);

  if (eligible.length === 0) {
    // Everything was already pending/in-flight/succeeded — nothing this call
    // legitimately claimed. This is the double-click / concurrent-retry stop.
    return NextResponse.json(
      {
        error: "Nothing to retry — those platforms aren't in a failed state.",
        code: "NOTHING_TO_RETRY",
      },
      { status: 409 },
    );
  }

  // The claim above flipped these rows failed -> pending. If we now fail to move
  // the job to in_progress or to enqueue the retry run, those rows would be stuck
  // `pending` forever with no run to terminalize them — and un-retryable (the
  // claim requires `failed`). So revert them to `failed` on any error here.
  //
  // `inngest.send` can throw AFTER Inngest accepted the event, so the retry run
  // may already be running. The revert therefore touches only rows no run has
  // claimed (`claimRunId: null`, 2026-11-01 scale audit jobs H6): a claimed row
  // belongs to a run that is, or was, calling the platform, and reverting it to
  // `failed` would tell the user "couldn't start" about a post that may be live
  // (inviting a second post). Its run records the real outcome.
  try {
    // Parent job re-enters the running state while the retried platforms publish.
    await prisma.postJob.update({
      where: { id: postJobId },
      data: { status: "in_progress" },
    });

    // Hand off to the background retry function for exactly the claimed platforms.
    // 2026-11-01 scale audit (jobs H6 + H1): the event id is unique per REQUEST
    // (Inngest keeps an id for 24 h, so a fixed per-job id would swallow a
    // legitimate second retry of the job), and the ACTIVE workspace feeds the
    // shared concurrency key.
    await inngest.send(
      buildRetryEvent(
        {
          postJobId,
          userId: workspaceContext.user.id,
          workspaceId: workspaceContext.workspace.id,
          platforms: eligible,
        },
        randomUUID(),
      ),
    );
  } catch (error) {
    console.error("[retry] failed to enqueue retry run; reverting claim", error);
    await prisma.postJobResult.updateMany({
      where: { postJobId, platform: { in: eligible }, status: "pending", claimRunId: null },
      data: {
        status: "failed",
        errorCode: "RETRY_ENQUEUE_FAILED",
        errorMessage: "Couldn't start the retry. Please try again.",
      },
    });
    // Final review F10: the job went `in_progress` above and nothing will move it
    // now, so it would sit there until the 2 h reconciler. Recompute it over ALL its
    // results (row-locked): reverted rows read `failed`, and a row a live run still
    // holds keeps the job `in_progress`. A failure here must not change the 500.
    try {
      await recomputeAndStorePostJobStatus(postJobId);
    } catch (recomputeError) {
      logger.error("[retry] failed to recompute the job status after reverting the claim", {
        postJobId,
        error: recomputeError,
      });
    }
    return NextResponse.json(
      { error: "Couldn't start the retry. Please try again.", code: "RETRY_ENQUEUE_FAILED" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, retrying: eligible }, { status: 202 });
}
