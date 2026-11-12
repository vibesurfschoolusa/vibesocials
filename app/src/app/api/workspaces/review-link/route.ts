import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { generateInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  REVIEW_LINK_CREATE_LIMIT_MESSAGE,
  REVIEW_LINK_CREATES_PER_HOUR,
  reviewLinkUrl,
} from "@/lib/reviewLink";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";
import { planFeatureResponse } from "@/lib/planFeatureResponse";
import { pausedByPlan } from "@/lib/planFeatures";
import { requireOwnerContext } from "@/lib/workspace";
import {
  INVALID_WORKSPACE_ID_CODE,
  INVALID_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_MESSAGE,
} from "@/lib/workspaceChanged";

/**
 * The workspace's client review link (2026-11-10), for its owners only. Built
 * like the upload link's owner routes (api/workspaces/upload-link/route.ts):
 * the raw token is kept sealed so an owner can copy the address again; a member
 * gets the owner gate's 403 and never sees it.
 *
 * The active workspace is a cookie every tab shares, so the Queue page sends
 * the workspace it is showing (GET: `?workspaceId=`, POST and DELETE: a
 * `{ workspaceId }` body). A mismatch is a 409 with the library's sentence, so
 * an owner with two workspaces in two tabs cannot copy, replace or turn off the
 * wrong one's link. An absent id keeps the plain behaviour, as there.
 */

/** The 400 / 409 for a workspace id that is not the active one, or null when it may go on. */
function workspaceMismatch(sent: unknown, activeWorkspaceId: string): NextResponse | null {
  if (sent === undefined) return null;
  if (typeof sent !== "string") {
    return NextResponse.json(
      { error: INVALID_WORKSPACE_ID_MESSAGE, code: INVALID_WORKSPACE_ID_CODE },
      { status: 400 },
    );
  }
  if (sent !== activeWorkspaceId) {
    return NextResponse.json(
      { error: WORKSPACE_CHANGED_MESSAGE, code: WORKSPACE_CHANGED_CODE },
      { status: 409 },
    );
  }
  return null;
}

/** The workspace id a POST or DELETE body carries; an empty or non-JSON body carries none. */
async function bodyWorkspaceId(request: Request): Promise<unknown> {
  return ((await readJsonObject(request)) ?? {}).workspaceId;
}

type LinkRow = {
  tokenSealed: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};

function toLinkDto(row: LinkRow, workspaceId: string) {
  let url: string | null = null;
  try {
    url = reviewLinkUrl(process.env.NEXTAUTH_URL, openSecret(row.tokenSealed));
  } catch (error) {
    // A changed encryption key: Replace makes a new link.
    logger.error("[review-link] Couldn't open the sealed link token", { error, workspaceId });
  }
  return {
    url,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const workspaceId = contextOrError.workspace.id;
  const mismatch = workspaceMismatch(
    new URL(request.url).searchParams.get("workspaceId") ?? undefined,
    workspaceId,
  );
  if (mismatch) return mismatch;

  const link = await prisma.workspaceReviewLink.findFirst({
    where: { workspaceId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ link: link ? toLinkDto(link, workspaceId) : null, ...pausedByPlan(contextOrError.workspace, "clientLinks") });
}

/**
 * Create the link, or replace it: the old one is revoked in the same
 * transaction, under a per-workspace advisory lock, so two at once still leave
 * exactly one active link.
 */
export async function POST(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const context = contextOrError;
  const workspaceId = context.workspace.id;
  const mismatch = workspaceMismatch(await bodyWorkspaceId(request), workspaceId);
  if (mismatch) return mismatch;
  const notIncluded = planFeatureResponse(context.workspace, "clientLinks");
  if (notIncluded) return notIncluded;

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/review-link",
    limit: REVIEW_LINK_CREATES_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: REVIEW_LINK_CREATE_LIMIT_MESSAGE, retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const { raw, hash } = generateInviteToken();

  let link;
  try {
    link = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-review-link:${workspaceId}`}))`;
      await tx.workspaceReviewLink.updateMany({
        where: { workspaceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return tx.workspaceReviewLink.create({
        data: {
          workspaceId,
          tokenHash: hash,
          tokenSealed: sealSecret(raw),
          createdById: context.user.id,
        },
      });
    });
  } catch (error) {
    logger.error("[POST /api/workspaces/review-link] Unexpected error", {
      error,
      workspaceId,
      userId: context.user.id,
    });
    return NextResponse.json({ error: "Couldn't make the link. Try again." }, { status: 500 });
  }

  return NextResponse.json({ link: toLinkDto(link, workspaceId) });
}

/** Turn the link off. Idempotent: with nothing active it still answers ok. */
export async function DELETE(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const mismatch = workspaceMismatch(await bodyWorkspaceId(request), contextOrError.workspace.id);
  if (mismatch) return mismatch;

  await prisma.workspaceReviewLink.updateMany({
    where: { workspaceId: contextOrError.workspace.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
