import { NextRequest, NextResponse } from "next/server";

import { Prisma } from "@prisma/client";
import type { Platform } from "@prisma/client";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { editApprovalEffect, holdForApprovalData } from "@/lib/approval";
import { findOverlongCaption, pickPlatformOverrides } from "@/lib/captionLimits";
import { captionTooLongResponse, invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { toPostJobDetailDto, toPostJobResultSummaryDto } from "@/lib/postsDto";
import { queueCoverBlobIfUnused } from "@/server/jobs/coverBlobs";
import {
  DELETABLE_POST_JOB_STATUSES,
  isValidPerPlatformOverrides,
  MUTABLE_POST_JOB_STATUSES,
  validateScheduledFor,
} from "@/lib/scheduling";
import { platformCaptionEntries } from "@/lib/platforms";
import { xTextEmptyRefusal } from "@/lib/xTextRefusal";
import { resolvePlatformCaptions, resolvePostCaptionSource } from "@/server/jobs/posting";
import { storyPlatformsOf, withStoryCaptions } from "@/lib/storyPlacement";
import { notifyOwnersOfApprovalRequest } from "@/server/notifications/approvalRequested";
import { checkDailyPostLimit } from "@/server/usage/workspaceUsage";
import { utcDayKey } from "@/lib/usageLimits";

import {
  applyToPair,
  pairLimitArgs,
  pairStoryPlatforms,
  readPairHalf,
  takenFeedHalf,
  wantsPair,
  type PairHalf,
} from "./pairRule";
import { signedOutResponse } from "@/lib/signedOutResponse";
import { renderedWorkspaceRefusal, sentWorkspaceId } from "@/lib/workspaceChanged";
import { lostRaceAnswer, POST_GONE_TEXT, POST_NOW_DRAFT_TEXT, postMovedOnText } from "@/lib/postMovedOn";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

/** See cancel/route.ts — generous throttle shared by the DB-only mutations. */
const MUTATE_RATE_LIMIT = { route: "posts/mutate", limit: 60, windowMs: 5 * 60 * 1000 } as const;

/** 429 helper for the mutation endpoints. Returns null when the request is allowed. */
async function enforceMutateRateLimit(userId: string): Promise<NextResponse | null> {
  const rateLimit = await checkRateLimit({ userId, ...MUTATE_RATE_LIMIT });
  if (rateLimit.allowed) return null;
  return tooManyTriesResponse(rateLimit);
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

export async function GET(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return signedOutResponse();
  }

  // R32 publishing L1: the page's workspace, so the Queue's Edit never reads a post for another one.
  const workspaceRefusal = renderedWorkspaceRefusal(sentWorkspaceId(request), workspaceContext.workspace.id);
  if (workspaceRefusal) return workspaceRefusal;

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
    return NextResponse.json({ error: POST_GONE_TEXT }, { status: 404 });
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
    return signedOutResponse();
  }

  const limited = await enforceMutateRateLimit(workspaceContext.user.id);
  if (limited) return limited;

  const { postJobId } = await Promise.resolve(context.params);

  // `null` / an array / a primitive is valid JSON but not a body we can index.
  const parsedBody = await readJsonObject(request);
  if (!parsedBody) {
    return invalidJsonBodyResponse();
  }
  // R31 pages L2: the page's workspace, so a tab left on another workspace acts on nothing.
  const workspaceRefusal = renderedWorkspaceRefusal(parsedBody.workspaceId, workspaceContext.workspace.id);
  if (workspaceRefusal) return workspaceRefusal;
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
  const workspaceId = workspaceContext.workspace.id;
  const existing = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
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
      storyOfPostJobId: true,
      // R56 client-journey-2 L1: whether this edit withdraws a client approval, for the answer.
      clientApprovedAt: true,
    },
  });

  if (!existing) {
    // R31 publishing L4: a sentence, never a bare "Not found".
    return NextResponse.json({ error: POST_GONE_TEXT }, { status: 404 });
  }

  if (!MUTABLE_POST_JOB_STATUSES.includes(existing.status)) {
    // R30 publishing L1: a post that moved on says what happened and to check Activity.
    return NextResponse.json(
      { error: postMovedOnText(existing.status, "edited") ?? "Only scheduled or draft posts can be edited.", code: "NOT_EDITABLE" },
      { status: 409 },
    );
  }

  if (body.scheduledFor !== undefined) {
    if (existing.status !== "scheduled") {
      return NextResponse.json(
        {
          // R31 publishing L5: a Queue left open still shows it as Scheduled (the
          // client asked for a change, or a member's edit sent it back for approval).
          error: POST_NOW_DRAFT_TEXT,
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

  // R62 review low 2: an edit can no more leave X an empty text than POST could
  // create one. Only a post without a photo (no media item; a file still goes
  // to X), against the platforms it was made for. R63 pages-a L1: only when the
  // text X would get changes, since Edit sends the caption on every save and a
  // mentions-only post stored before this check must still be reschedulable.
  if (existing.mediaItem === null) {
    const storedOverrides = existing.perPlatformOverrides as Partial<Record<Platform, string>> | null;
    const stored = existing.publishMetadata as { targetPlatforms?: Platform[] } | null;
    const storedBase = existing.baseCaption ?? "";
    const baseCaption = typeof body.baseCaption === "string" ? body.baseCaption : storedBase;
    const xOverride = perPlatformOverrides !== undefined ? perPlatformOverrides?.x : storedOverrides?.x;
    // An empty override falls back to the main caption, as publishing does.
    // Trimmed, as publishing sends it: Edit sends the caption trimmed, so a
    // stored trailing space or newline is not a change.
    const xSourceNow = (storedOverrides?.x ? storedOverrides.x : storedBase).trim();
    const xSourceAfter = (xOverride ? xOverride : baseCaption).trim();
    if (xSourceAfter !== xSourceNow) {
      const xRefusal = await xTextEmptyRefusal({
        baseCaption,
        xOverride,
        workspace: workspaceContext.workspace,
        targetPlatforms: stored?.targetPlatforms?.length ? stored.targetPlatforms : undefined,
        editing: existing.status === "draft" ? "draft" : "scheduled",
      });
      if (xRefusal) return NextResponse.json({ error: xRefusal }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update." },
      { status: 400 },
    );
  }

  const memberUnderApproval =
    workspaceContext.workspace.requireApproval && workspaceContext.role === "member";
  const effectOf = (row: Parameters<typeof editApprovalEffect>[0]["job"]) =>
    editApprovalEffect({
      requireApproval: workspaceContext.workspace.requireApproval,
      role: workspaceContext.role,
      job: row,
    });
  const approvalEffect = effectOf(existing);

  // R4 lows, item 2: the other half of a Feed and Story post takes the main
  // caption and the time (R3-client-journey M1: the Story's caption, which is
  // not published, stays equal to the feed post's), never this post's
  // per-platform captions: each half keeps its own.
  const pairEdits: Prisma.PostJobUpdateInput = { ...data };
  delete pairEdits.perPlatformOverrides;

  /**
   * The write for one post: these edits, plus what they do to that post's own
   * approval state and client approval.
   */
  const dataFor = (
    row: CaptionFacts & Parameters<typeof editApprovalEffect>[0]["job"],
    edits: Prisma.PostJobUpdateInput,
    overrides: typeof perPlatformOverrides,
  ) => {
    const rowData: Prisma.PostJobUpdateManyMutationInput = { ...edits };
    // Client review link: the client approved this text at this time. An edit
    // that changes what will publish withdraws that approval in the same write,
    // so the page asks again. Compared as the publisher reads it (own caption or
    // the media item's, overrides narrowed to the targets), so re-saving the same
    // text and time, as the Queue's edit dialog does, leaves it alone.
    if (changesWhatClientApproved(row, edits, overrides)) {
      rowData.clientApprovedAt = null;
    }
    const effect = effectOf(row);
    if (effect === "rehold") {
      Object.assign(rowData, holdForApprovalData(new Date()));
    } else if (effect === "restamp") {
      rowData.submittedForApprovalAt = new Date();
    }
    return rowData;
  };

  const readHalf = await readPairHalf(workspaceId, { id: postJobId, ...existing }, wantsPair(parsedBody));
  // An edit with nothing for the other half (only per-platform captions, by an
  // owner) leaves it out of the write and the answer.
  const half = readHalf && Object.keys(dataFor(readHalf, pairEdits, undefined)).length > 0 ? readHalf : null;
  // A new time only fits a half that is scheduled too (a draft has none to move).
  const blocker = (other: PairHalf) =>
    data.scheduledFor instanceof Date && other.status !== "scheduled" ? "is a draft" : null;

  // Usage limits (2026-11-10): a scheduled post moved to another UTC day counts
  // toward that day. Not itself, and not when the edit re-holds it as a draft.
  const newScheduledFor = data.scheduledFor instanceof Date ? data.scheduledFor : null;
  if (
    newScheduledFor &&
    approvalEffect !== "rehold" &&
    (!existing.scheduledFor || utcDayKey(existing.scheduledFor) !== utcDayKey(newScheduledFor))
  ) {
    const refusal = await checkDailyPostLimit({
      workspaceId,
      day: newScheduledFor,
      mode: "schedule",
      // A Feed and Story card moves both halves: two posts on that day.
      ...pairLimitArgs(postJobId, half && !blocker(half) ? half : null),
      viewerUserId: workspaceContext.user.id,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
    }
  }

  // Atomic write: still mutable at write time (guards the cron-claim race).
  // A member under approval is pinned to the status the effect was decided
  // on, so e.g. a draft an owner just scheduled can't take an unreviewed edit.
  const result = await applyToPair({
    main: { id: postJobId, ...existing },
    half,
    write: async (db, row) =>
      (
        await db.postJob.updateMany({
          where: {
            id: row.id,
            workspaceId,
            status: memberUnderApproval ? row.status : { in: [...MUTABLE_POST_JOB_STATUSES] },
          },
          data: row === half ? dataFor(row, pairEdits, undefined) : dataFor(row, data, perPlatformOverrides),
        })
      ).count === 1,
    blocker,
    wording: { done: "was changed too", verb: "changed" },
  });

  if (!result.ok) {
    // Lost the race (the scanner claimed it, or, R59 publishing-flow L4, an
    // owner scheduled the draft meanwhile: the write is pinned to the status).
    // The post read again decides the answer (lostRaceAnswer).
    const now = await prisma.postJob.findFirst({ where: { id: postJobId, workspaceId }, select: { status: true } });
    return NextResponse.json(lostRaceAnswer(now, "edited", { code: "NOT_EDITABLE" }), { status: 409 });
  }
  const pairAnswer = result.pair ? { otherHalf: result.pair } : {};
  // R56 client-journey-2 L1: the write withdrew the client's approval (dataFor)
  // from a post that had one, so the Queue card drops its "Client approved"
  // badge without a reload.
  const approvalAnswer =
    existing.clientApprovedAt && changesWhatClientApproved(existing, data, perPlatformOverrides) ? { clientApprovedAt: null } : {};

  if (approvalEffect === "rehold") {
    // 2026-11-01 audit (M1): the post as it is NOW - this request's edits laid
    // over the row it replaced - so the owners see the per-platform texts that
    // will publish (including ones this very edit just changed or cleared).
    const editedCaption = typeof body.baseCaption === "string" ? body.baseCaption : null;
    // R4 lows, item 3: an edit sent from a Story that also changed its feed
    // post describes the feed post (its own per-platform captions, which the
    // edit left alone) and names this Story.
    const feedHalf = takenFeedHalf(half, result.pair);
    const described = feedHalf ?? existing;
    const editedOverrides = feedHalf ? undefined : perPlatformOverrides;
    await notifyOwnersOfApprovalRequest({
      workspaceId,
      workspaceName: workspaceContext.workspace.name,
      submitter: workspaceContext.user,
      caption: editedCaption ?? described.baseCaption ?? "",
      // A Story publishes no caption: its platform reads "Story, no caption" (2026-11-10).
      platformCaptions: withStoryCaptions(
        resolvePlatformCaptions(
          {
            baseCaption: editedCaption ?? described.baseCaption,
            perPlatformOverrides:
              editedOverrides !== undefined
                ? (editedOverrides as Prisma.JsonValue | null)
                : described.perPlatformOverrides,
            publishMetadata: described.publishMetadata,
          },
          described.mediaItem,
        ),
        storyPlatformsOf(described.publishMetadata),
      ),
      // One email for a Feed and Story card whose Story went back for approval too.
      ...(half && result.pair?.changed && (feedHalf || effectOf(half) === "rehold")
        ? { alsoAsStory: pairStoryPlatforms(existing.publishMetadata, half) }
        : {}),
    });
  }

  if (approvalEffect !== "none") {
    return NextResponse.json(
      { ok: true, status: "draft", approvalState: "pending", ...approvalAnswer, ...pairAnswer },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: true, ...approvalAnswer, ...pairAnswer }, { status: 200 });
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
 *
 * R3-client-journey M1: the optional body `{ includePair: true }` (a Feed and
 * Story card) deletes the other half too, in one transaction (pairRule.ts).
 */
export async function DELETE(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return signedOutResponse();
  }

  const limited = await enforceMutateRateLimit(workspaceContext.user.id);
  if (limited) return limited;

  const { postJobId } = await Promise.resolve(context.params);
  const workspaceId = workspaceContext.workspace.id;
  const body = await readJsonObject(request);
  // R31 pages L2: the page's workspace, so a tab left on another workspace acts on nothing.
  const workspaceRefusal = renderedWorkspaceRefusal(body?.workspaceId, workspaceId);
  if (workspaceRefusal) return workspaceRefusal;

  // V1 fix round 1: the post's video cover, read first so its file can be
  // queued for deletion once the post is gone.
  const coverRow = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
    select: { coverImageUrl: true, storyOfPostJobId: true },
  });

  const half = coverRow
    ? await readPairHalf(
        workspaceId,
        { id: postJobId, storyOfPostJobId: coverRow.storyOfPostJobId ?? null },
        wantsPair(body),
      )
    : null;

  // Team Workspaces (Task 4): any member of the job's workspace, not just its
  // creator (design §1).
  const result = await applyToPair({
    main: { id: postJobId },
    half,
    write: async (db, row) =>
      (
        await db.postJob.deleteMany({
          where: { id: row.id, workspaceId, status: { in: [...DELETABLE_POST_JOB_STATUSES] } },
        })
      ).count === 1,
    // A scheduled half must be cancelled first, like this post.
    blocker: (other) => (other.status === "scheduled" ? "is scheduled" : null),
    wording: { done: "was deleted too", verb: "deleted" },
  });

  if (!result.ok) {
    const existing = await prisma.postJob.findFirst({
      where: { id: postJobId, workspaceId },
      select: { status: true },
    });
    if (!existing) {
      return NextResponse.json({ error: POST_GONE_TEXT }, { status: 404 });
    }
    // R31 publishing L3: a draft that was scheduled, or started publishing, meanwhile says so.
    return NextResponse.json(
      {
        error:
          postMovedOnText(existing.status, "deleted") ??
          "Only draft or cancelled posts can be deleted. Cancel a scheduled post first.",
        code: "NOT_DELETABLE",
      },
      { status: 409 },
    );
  }

  // Queued, not deleted here: the hourly drain deletes the file, so a storage
  // hiccup never fails the delete. A series' other posts keep a shared cover.
  const covers = [coverRow?.coverImageUrl, result.pair?.changed ? half?.coverImageUrl : null];
  for (const cover of covers) {
    if (!cover) continue;
    try {
      await queueCoverBlobIfUnused(cover);
    } catch {
      // It never throws; this keeps the delete's answer safe if that changes.
    }
  }

  return NextResponse.json({ ok: true, ...(result.pair ? { otherHalf: result.pair } : {}) }, { status: 200 });
}
