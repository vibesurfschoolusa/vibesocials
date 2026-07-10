import { NextRequest, NextResponse } from "next/server";

import { Prisma } from "@prisma/client";
import type { Platform } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  DELETABLE_POST_JOB_STATUSES,
  isValidPerPlatformOverrides,
  MUTABLE_POST_JOB_STATUSES,
  validateScheduledFor,
} from "@/lib/scheduling";

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

/** Editable fields on a scheduled/draft job (Roadmap Phase 5 PATCH, §6.2). */
interface PatchBody {
  baseCaption?: unknown;
  perPlatformOverrides?: unknown;
  scheduledFor?: unknown;
}

export async function GET(_request: NextRequest, context: PostJobRouteContext) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Preserve the existing synchronous params access (see PlatformRouteContext
  // in connections/[platform]); the union type keeps the handler signature
  // assignable to Next's generated route type.
  const { postJobId } = context.params as { postJobId: string };

  const postJob = await prisma.postJob.findFirst({
    where: { id: postJobId, userId: user.id },
  });

  if (!postJob) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const results = await prisma.postJobResult.findMany({
    where: { postJobId: postJob.id },
  });

  return NextResponse.json({ postJob, results }, { status: 200 });
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
 */
export async function PATCH(request: NextRequest, context: PostJobRouteContext) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await enforceMutateRateLimit(user.id);
  if (limited) return limited;

  const { postJobId } = context.params as { postJobId: string };

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: Prisma.PostJobUpdateInput = {};

  if (body.baseCaption !== undefined) {
    if (typeof body.baseCaption !== "string" || !body.baseCaption.trim()) {
      return NextResponse.json(
        { error: "baseCaption must be a non-empty string." },
        { status: 400 },
      );
    }
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
    data.perPlatformOverrides =
      body.perPlatformOverrides === null
        ? Prisma.DbNull
        : (body.perPlatformOverrides as Partial<
            Record<Platform, string>
          > as unknown as Prisma.InputJsonValue);
  }

  // Ownership + status in one read (404 vs 409 disambiguation, plus the
  // scheduledFor-on-draft rule needs the current status).
  const existing = await prisma.postJob.findFirst({
    where: { id: postJobId, userId: user.id },
    select: { status: true },
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

  // Atomic write: still mutable at write time (guards the cron-claim race).
  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      userId: user.id,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
    },
    data,
  });

  if (count === 0) {
    return NextResponse.json(
      { error: "This post can no longer be edited.", code: "NOT_EDITABLE" },
      { status: 409 },
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
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await enforceMutateRateLimit(user.id);
  if (limited) return limited;

  const { postJobId } = context.params as { postJobId: string };

  const { count } = await prisma.postJob.deleteMany({
    where: {
      id: postJobId,
      userId: user.id,
      status: { in: [...DELETABLE_POST_JOB_STATUSES] },
    },
  });

  if (count === 0) {
    const existing = await prisma.postJob.findFirst({
      where: { id: postJobId, userId: user.id },
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
