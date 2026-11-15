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
import { clientLinkCreateRefusal, clientLinkPanelStatus } from "@/server/clientLinkPanelStatus";
import { requireOwnerContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";

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
 * wrong one's link. A change without the id is refused (F3); a read without it
 * is answered as before.
 */

/**
 * GET's check: a read without the id is answered as before. POST and DELETE
 * require it (F3, lib/workspaceChanged.ts renderedWorkspaceRefusal).
 */
function readMismatch(sent: string | null, activeWorkspaceId: string): Response | null {
  return sent === null ? null : renderedWorkspaceRefusal(sent, activeWorkspaceId);
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
  const mismatch = readMismatch(new URL(request.url).searchParams.get("workspaceId"), workspaceId);
  if (mismatch) return mismatch;

  const link = await prisma.workspaceReviewLink.findFirst({
    where: { workspaceId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ link: link ? toLinkDto(link, workspaceId) : null, ...clientLinkPanelStatus(contextOrError.workspace) });
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
  const mismatch = renderedWorkspaceRefusal(await bodyWorkspaceId(request), workspaceId);
  if (mismatch) return mismatch;
  // GG2 review: no new link while the workspace is blocked (it would answer "not active").
  const blocked = clientLinkCreateRefusal(context.workspace);
  if (blocked) return NextResponse.json({ error: blocked, code: "WORKSPACE_BLOCKED" }, { status: 403 });
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
  const mismatch = renderedWorkspaceRefusal(await bodyWorkspaceId(request), contextOrError.workspace.id);
  if (mismatch) return mismatch;

  await prisma.workspaceReviewLink.updateMany({
    where: { workspaceId: contextOrError.workspace.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
