import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { generateInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";
import {
  UPLOAD_LINK_CREATE_LIMIT_MESSAGE,
  UPLOAD_LINK_CREATES_PER_HOUR,
  uploadLinkUrl,
} from "@/lib/uploadLink";
import { requireOwnerContext } from "@/lib/workspace";
import {
  INVALID_WORKSPACE_ID_CODE,
  INVALID_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_MESSAGE,
} from "@/lib/workspaceChanged";

/**
 * The workspace's client upload link (2026-11-10), for its owners only. The raw
 * token is kept sealed so an owner can copy the address again; a member gets
 * the owner gate's 403 and never sees it.
 *
 * The active workspace is a cookie every tab shares, so the Media page sends
 * the workspace it was rendered for (GET: `?workspaceId=`, POST and DELETE: a
 * `{ workspaceId }` body). A mismatch is a 409 with the library's sentence, as
 * POST /api/media answers, so an owner with two workspaces in two tabs cannot
 * copy, replace or turn off the wrong one's link. An absent id keeps the plain
 * behaviour, as there.
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
  uploadCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
};

function toLinkDto(row: LinkRow, workspaceId: string) {
  let url: string | null = null;
  try {
    url = uploadLinkUrl(process.env.NEXTAUTH_URL, openSecret(row.tokenSealed));
  } catch (error) {
    // A changed encryption key: the counts still show, and Replace makes a new link.
    logger.error("[upload-link] Couldn't open the sealed link token", { error, workspaceId });
  }
  return {
    url,
    uploadCount: row.uploadCount,
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

  const link = await prisma.workspaceUploadLink.findFirst({
    where: { workspaceId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ link: link ? toLinkDto(link, workspaceId) : null });
}

/**
 * Create the link, or replace it: the old one is revoked in the same
 * transaction, under a per-workspace advisory lock, so two at once still leave
 * exactly one active link (as POST /api/workspaces/invites does).
 */
export async function POST(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const context = contextOrError;
  const workspaceId = context.workspace.id;
  const mismatch = workspaceMismatch(await bodyWorkspaceId(request), workspaceId);
  if (mismatch) return mismatch;

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/upload-link",
    limit: UPLOAD_LINK_CREATES_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: UPLOAD_LINK_CREATE_LIMIT_MESSAGE, retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const { raw, hash } = generateInviteToken();

  let link;
  try {
    link = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-upload-link:${workspaceId}`}))`;
      await tx.workspaceUploadLink.updateMany({
        where: { workspaceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return tx.workspaceUploadLink.create({
        data: {
          workspaceId,
          tokenHash: hash,
          tokenSealed: sealSecret(raw),
          createdById: context.user.id,
        },
      });
    });
  } catch (error) {
    logger.error("[POST /api/workspaces/upload-link] Unexpected error", {
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

  await prisma.workspaceUploadLink.updateMany({
    where: { workspaceId: contextOrError.workspace.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
