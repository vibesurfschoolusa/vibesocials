import { NextRequest, NextResponse } from "next/server";

import { Prisma } from "@prisma/client";
import type { Platform } from "@prisma/client";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { editApprovalEffect, holdForApprovalData } from "@/lib/approval";
import { findOverlongCaption, pickPlatformOverrides } from "@/lib/captionLimits";
import { captionTooLongResponse, invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { toPostJobDetailDto, toPostJobResultSummaryDto } from "@/lib/postsDto";
import {
  DELETABLE_POST_JOB_STATUSES,
  isValidPerPlatformOverrides,
  MUTABLE_POST_JOB_STATUSES,
  validateScheduledFor,
} from "@/lib/scheduling";
import { platformCaptionEntries } from "@/lib/platforms";
import { resolvePlatformCaptions, resolvePostCaptionSource } from "@/server/jobs/posting";
import { storyPlatformsOf, withStoryCaptions } from "@/lib/storyPlacement";
import { notifyOwnersOfApprovalRequest } from "@/server/notifications/approvalRequested";
import { checkDailyPostLimit } from "@/server/usage/workspaceUsage";
import { utcDayKey } from "@/lib/usageLimits";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

/** See cancel/route.ts — generous throttle shared by the DB-only mutations. */
const MUTATE_RATE_LIMIT = { route: "posts/mutate", limit: 60, windowMs: 5 * 60 * 1000 } as const;

/** 429 helper for the mutation endpoints. Returns null when the request is allowed. */
async function enforceMutateRateLimit(userId: string): Promise<NextResponse | null> {
  const rateLimit = await checkRateLimit({ userId, ...MUTATE_RATE_LIMIT });
  if (rateLimit.allowed) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
  );
}

type CaptionFacts = {
  baseCaption: string | null;
  perPlatformOverrides: Prisma.JsonValue | null;
  publishMetadata: Prisma.JsonValue | null;
  scheduledFor: Date | null;
  mediaItem: { baseCaption: string; perPlatformOverrides: Prisma.JsonValue | null } | null;
};

/** The main text, each platform's own text and the time, as they would publish. */
function publishedShape(job: CaptionFacts): string {
  const media = job.mediaItem ?? { baseCaption: "", perPlatformOverrides: null };
  return JSON.stringify([
    resolvePostCaptionSource(job, media).baseCaption,
    platformCaptionEntries(resolvePlatformCaptions(job, media)).map((e) => [e.platform, e.text]),
    job.scheduledFor?.getTime() ?? null,
  ]);
}

/** Does this PATCH change the caption, a platform's caption or the time? (Platforms cannot be edited here.) */
function changesWhatClientApproved(
  existing: CaptionFacts,
  data: Prisma.PostJobUpdateInput,
  perPlatformOverrides: Partial<Record<Platform, string>> | null | undefined,
): boolean {
  const after: CaptionFacts = {
    ...existing,
    baseCaption: typeof data.baseCaption === "string" ? data.baseCaption : existing.baseCaption,
    perPlatformOverrides:
      perPlatformOverrides !== undefined
        ? (perPlatformOverrides as Prisma.JsonValue | null)
        : existing.perPlatformOverrides,
    scheduledFor: data.scheduledFor instanceof Date ? data.scheduledFor : existing.scheduledFor,
  };
  return publishedShape(after) !== publishedShape(existing);
}

/** Editable fields on a scheduled/draft job (Roadmap Phase 5 PATCH, §6.2). */
interface PatchBody {
  baseCaption?: unknown;
  perPlatformOverrides?: unknown;
  scheduledFor?: unknown;
}

export async function GET(_request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Next 16 passes `params` as a promise — it MUST be awaited. Reading it
  // synchronously yielded `postJobId: undefined`, and Prisma treats an
  // undefined WHERE field as "unfiltered", so every request silently operated
  // on the FIRST job in the workspace. Same pattern as every sibling route
  // (cancel/publish/retry/media).
  const { postJobId } = await Promise.resolve(context.params);

  // Team Workspaces (Task 4): any member of the job's workspace, not just its
  // creator — see the permission matrix (design doc §1). A job in a
  // DIFFERENT workspace simply doesn't match this WHERE, so it 404s exactly
  // like "doesn't exist" (no 403 existence oracle).
  const postJob = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
  });

  if (!postJob) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const results = await prisma.postJobResult.findMany({
    where: { postJobId: postJob.id },
  });

  // SEC-1 (post-release review Task C): project to the display-safe DTOs —
  // the raw rows carry userId/workspaceId/publishMetadata (job) and
  // socialConnectionId/errorCode (results), none of which any caller needs
  // (this endpoint has zero UI callers today, but the wire contract should
  // still never leak internal fields).
  return NextResponse.json(
    {
      postJob: toPostJobDetailDto(postJob),
      results: results.map(toPostJobResultSummaryDto),
    },
    { status: 200 },
  );
}

/**
 * PATCH /api/posts/[postJobId] — Roadmap Phase 5 (§6.2).
 *
 * Edit a scheduled or draft post in place (caption / per-platform overrides /
 * `scheduledFor`) — a plain DB update, no Inngest run to reconcile. Auth +
 * ownership scoped; only `scheduled`/`draft` are mutable (a running/terminal job
 * 409s). `scheduledFor` may only be changed on an already-`scheduled` job
 * (rescheduling) and must be a valid future time; to give a *draft* a time,
 * promote it via `POST …/publish`. The write is an ATOMIC conditional
 * `updateMany` (status still in the mutable set) so it can't edit a post the
 * cron just claimed.
 *
 * Approval (2026-11-01 audit, `editApprovalEffect`): a MEMBER in a workspace
 * that requires approval who edits a SCHEDULED post (approved or not) sends it
 * back for approval in the same write — otherwise the cron would publish text
 * no owner reviewed — and the owners are emailed; editing a PENDING post keeps
 * it pending with a fresh submission time. Both answer `{ ok: true, status:
 * "draft", approvalState: "pending" }`. For such a member the write is pinned
 * to the exact status the rule was decided on. Owners are unaffected.
 */
export async function PATCH(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await enforceMutateRateLimit(workspaceContext.user.id);
  if (limited) return limited;

  const { postJobId } = await Promise.resolve(context.params);

  // `null` / an array / a primitive is valid JSON but not a body we can index.
  const parsedBody = await readJsonObject(request);
  if (!parsedBody) {
    return invalidJsonBodyResponse();
  }
  const body = parsedBody as PatchBody;

  const data: Prisma.PostJobUpdateInput = {};
  // The overrides as stored: `null` = explicit clear, `undefined` = not edited.
  let perPlatformOverrides: Partial<Record<Platform, string>> | null | undefined;

  if (body.baseCaption !== undefined) {
    if (typeof body.baseCaption !== "string" || !body.baseCaption.trim()) {
      return NextResponse.json(
        { error: "baseCaption must be a non-empty string." },
        { status: 400 },
      );
    }
    // 2026-11-01 scale audit (jobs, event size): same cap as POST /api/posts - this text
    // is what a later publish event carries.
    const overlongBase = findOverlongCaption({ baseCaption: body.baseCaption });
    if (overlongBase) return captionTooLongResponse(overlongBase);
    data.baseCaption = body.baseCaption;
  }

  if (body.perPlatformOverrides !== undefined) {
    // null = explicit clear; otherwise require a Record<string,string> (review
    // Minor #3 — reject arrays and non-string values, not just non-objects).
    if (
      body.perPlatformOverrides !== null &&
      !isValidPerPlatformOverrides(body.perPlatformOverrides)
    ) {
      return NextResponse.json(
        { error: "perPlatformOverrides must be an object of string values, or null." },
        { status: 400 },
      );
    }
    // 2026-11-01 scale audit (jobs, event size): keys that are not a platform are dropped
    // (only platform keys are ever published) and the cap is checked on the rest.
    // `perPlatformOverrides` (not the raw body value) is what is stored and what
    // the re-hold email below shows.
    perPlatformOverrides =
      body.perPlatformOverrides === null
        ? null
        : pickPlatformOverrides(body.perPlatformOverrides as Record<string, string>);
    const overlongOverride = findOverlongCaption({ perPlatformOverrides });
    if (overlongOverride) return captionTooLongResponse(overlongOverride);
    data.perPlatformOverrides =
      perPlatformOverrides === null
        ? Prisma.DbNull
        : (perPlatformOverrides as unknown as Prisma.InputJsonValue);
  }

  // Ownership + status in one read (404 vs 409 disambiguation, plus the
  // scheduledFor-on-draft rule needs the current status). Team Workspaces
  // (Task 4): any member of the job's workspace may edit it (design §1) — a
  // job in a different workspace 404s here exactly like "doesn't exist".
  const existing = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
    select: {
      status: true,
      // Usage limits: whether a reschedule moves the post to another UTC day.
      scheduledFor: true,
      submittedForApprovalAt: true,
      approvedAt: true,
      baseCaption: true,
      // 2026-11-01 audit (M1): everything resolvePlatformCaptions reads, so the
      // re-hold email shows the owners the per-platform texts too.
      perPlatformOverrides: true,
      publishMetadata: true,
      mediaItem: { select: { baseCaption: true, perPlatformOverrides: true } },
    },
  });

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!MUTABLE_POST_JOB_STATUSES.includes(existing.status)) {
    return NextResponse.json(
      { error: "Only scheduled or draft posts can be edited.", code: "NOT_EDITABLE" },
      { status: 409 },
    );
  }

  if (body.scheduledFor !== undefined) {
    if (existing.status !== "scheduled") {
      return NextResponse.json(
        {
          error: "Publish a draft to schedule it — a draft has no scheduled time to edit.",
          code: "NOT_SCHEDULED",
        },
        { status: 400 },
      );
    }
    const validation = validateScheduledFor(body.scheduledFor, new Date());
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    data.scheduledFor = validation.date;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update." },
      { status: 400 },
    );
  }

  // Client review link: the client approved this text at this time. An edit
  // that changes what will publish withdraws that approval in the same write,
  // so the page asks again. Compared as the publisher reads it (own caption or
  // the media item's, overrides narrowed to the targets), so re-saving the same
  // text and time, as the Queue's edit dialog does, leaves it alone.
  if (changesWhatClientApproved(existing, data, perPlatformOverrides)) {
    data.clientApprovedAt = null;
  }

  const memberUnderApproval =
    workspaceContext.workspace.requireApproval && workspaceContext.role === "member";
  const approvalEffect = editApprovalEffect({
    requireApproval: workspaceContext.workspace.requireApproval,
    role: workspaceContext.role,
    job: existing,
  });

  if (approvalEffect === "rehold") {
    Object.assign(data, holdForApprovalData(new Date()));
  } else if (approvalEffect === "restamp") {
    data.submittedForApprovalAt = new Date();
  }

  // Usage limits (2026-11-10): a scheduled post moved to another UTC day counts
  // toward that day. Not itself, and not when the edit re-holds it as a draft.
  const newScheduledFor = data.scheduledFor instanceof Date ? data.scheduledFor : null;
  if (
    newScheduledFor &&
    approvalEffect !== "rehold" &&
    (!existing.scheduledFor || utcDayKey(existing.scheduledFor) !== utcDayKey(newScheduledFor))
  ) {
    const refusal = await checkDailyPostLimit({
      workspaceId: workspaceContext.workspace.id,
      day: newScheduledFor,
      mode: "schedule",
      excludePostJobId: postJobId,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
    }
  }

  // Atomic write: still mutable at write time (guards the cron-claim race).
  // A member under approval is pinned to the status the effect was decided
  // on, so e.g. a draft an owner just scheduled can't take an unreviewed edit.
  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: memberUnderApproval
        ? existing.status
        : { in: [...MUTABLE_POST_JOB_STATUSES] },
    },
    data,
  });

  if (count === 0) {
    return NextResponse.json(
      { error: "This post can no longer be edited.", code: "NOT_EDITABLE" },
      { status: 409 },
    );
  }

  if (approvalEffect === "rehold") {
    // 2026-11-01 audit (M1): the post as it is NOW - this request's edits laid
    // over the row it replaced - so the owners see the per-platform texts that
    // will publish (including ones this very edit just changed or cleared).
    const editedCaption = typeof body.baseCaption === "string" ? body.baseCaption : null;
    await notifyOwnersOfApprovalRequest({
      workspaceId: workspaceContext.workspace.id,
      workspaceName: workspaceContext.workspace.name,
      submitter: workspaceContext.user,
      caption: editedCaption ?? existing.baseCaption ?? "",
      // A Story publishes no caption: its platform reads "Story, no caption" (2026-11-10).
      platformCaptions: withStoryCaptions(
        resolvePlatformCaptions(
          {
            baseCaption: editedCaption ?? existing.baseCaption,
            perPlatformOverrides:
              perPlatformOverrides !== undefined
                ? (perPlatformOverrides as Prisma.JsonValue | null)
                : existing.perPlatformOverrides,
            publishMetadata: existing.publishMetadata,
          },
          existing.mediaItem,
        ),
        storyPlatformsOf(existing.publishMetadata),
      ),
    });
  }

  if (approvalEffect !== "none") {
    return NextResponse.json(
      { ok: true, status: "draft", approvalState: "pending" },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

/**
 * DELETE /api/posts/[postJobId] — Roadmap Phase 5.
 *
 * Hard-delete a draft or cancelled post from the Queue (cascades its
 * PostJobResults; the MediaItem row is kept — a dedicated draft upload simply
 * becomes a normal library item you can reuse or delete in /media). Auth +
 * ownership scoped. A `scheduled` job must be cancelled first (so it can't race
 * the cron mid-claim); running/terminal jobs are history and 409. Atomic
 * conditional delete on the deletable status set.
 */
export async function DELETE(_request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await enforceMutateRateLimit(workspaceContext.user.id);
  if (limited) return limited;

  const { postJobId } = await Promise.resolve(context.params);

  // Team Workspaces (Task 4): any member of the job's workspace, not just its
  // creator (design §1).
  const { count } = await prisma.postJob.deleteMany({
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: { in: [...DELETABLE_POST_JOB_STATUSES] },
    },
  });

  if (count === 0) {
    const existing = await prisma.postJob.findFirst({
      where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: "Only draft or cancelled posts can be deleted. Cancel a scheduled post first.",
        code: "NOT_DELETABLE",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
