import { NextResponse } from "next/server";
import type { Platform } from "@prisma/client";

import {
  CONNECT_LINK_CREATES_PER_HOUR,
  CONNECT_LINK_CREATE_LIMIT_MESSAGE,
  CONNECT_LINK_TTL_MS,
  configuredConnectLinkPlatforms,
  connectLinkUrl,
  parseConnectLinkPlatforms,
} from "@/lib/connectLink";
import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { generateInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";
import { pausedByPlan, planFeatureResponse } from "@/lib/planFeatures";
import { isWorkspaceOwner, requireOwnerContext } from "@/lib/workspace";
import {
  INVALID_WORKSPACE_ID_CODE,
  INVALID_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_MESSAGE,
} from "@/lib/workspaceChanged";

/**
 * The workspace's client connect link (2026-11-11), for its owners only.
 * Built like the review link's owner routes (api/workspaces/review-link): the
 * raw token is kept sealed so an owner can copy the address again; a member
 * gets the owner gate's 403 and never sees it. The Settings group sends the
 * workspace it shows (GET `?workspaceId=`, POST and DELETE in the body), so a
 * second tab on another workspace cannot change the wrong one's link.
 * Nothing is sent to any platform when a link is created or revoked.
 */

function workspaceMismatch(sent: unknown, activeWorkspaceId: string): NextResponse | null {
  if (sent === undefined) return null;
  if (typeof sent !== "string") {
    return NextResponse.json({ error: INVALID_WORKSPACE_ID_MESSAGE, code: INVALID_WORKSPACE_ID_CODE }, { status: 400 });
  }
  if (sent !== activeWorkspaceId) {
    return NextResponse.json({ error: WORKSPACE_CHANGED_MESSAGE, code: WORKSPACE_CHANGED_CODE }, { status: 409 });
  }
  return null;
}

type LinkRow = {
  tokenSealed: string;
  platforms: Platform[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
};

function toLinkDto(row: LinkRow, workspaceId: string) {
  let url: string | null = null;
  try {
    url = connectLinkUrl(process.env.NEXTAUTH_URL, openSecret(row.tokenSealed));
  } catch (error) {
    // A changed encryption key: creating a new link fixes it.
    logger.error("[connect-link] Couldn't open the sealed link token", { error, workspaceId });
  }
  return {
    url,
    platforms: row.platforms,
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET → `{ link, available }`: the working link (or null) and the platforms this site can offer;
 * P1: plus `pausedByPlan: true` when the plan does not include client links.
 */
export async function GET(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const workspaceId = contextOrError.workspace.id;
  const mismatch = workspaceMismatch(new URL(request.url).searchParams.get("workspaceId") ?? undefined, workspaceId);
  if (mismatch) return mismatch;

  const row = await prisma.workspaceConnectLink.findFirst({
    where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  // A link acts as its creator, so once they are no longer an owner it works
  // for no visitor (server/connectLink/link.ts): show it as no link at all.
  const link = row && (await isWorkspaceOwner(row.createdById, workspaceId)) ? row : null;
  return NextResponse.json({
    link: link ? toLinkDto(link, workspaceId) : null,
    available: configuredConnectLinkPlatforms(),
    ...pausedByPlan(contextOrError.workspace, "clientLinks"),
  });
}

/**
 * POST { platforms, workspaceId? } → a new link offering those platforms for
 * 14 days. The old one is revoked in the same transaction, under a
 * per-workspace advisory lock, so two at once still leave one active link.
 */
export async function POST(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const context = contextOrError;
  const workspaceId = context.workspace.id;
  const body = (await readJsonObject(request)) ?? {};
  const mismatch = workspaceMismatch(body.workspaceId, workspaceId);
  if (mismatch) return mismatch;
  const notIncluded = planFeatureResponse(context.workspace, "clientLinks");
  if (notIncluded) return notIncluded;

  const parsed = parseConnectLinkPlatforms(body.platforms);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/connect-link",
    limit: CONNECT_LINK_CREATES_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: CONNECT_LINK_CREATE_LIMIT_MESSAGE, retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const { raw, hash } = generateInviteToken();

  let link;
  try {
    link = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-connect-link:${workspaceId}`}))`;
      const now = new Date();
      await tx.workspaceConnectLink.updateMany({
        where: { workspaceId, revokedAt: null },
        data: { revokedAt: now },
      });
      return tx.workspaceConnectLink.create({
        data: {
          workspaceId,
          tokenHash: hash,
          tokenSealed: sealSecret(raw),
          createdById: context.user.id,
          platforms: parsed.platforms,
          expiresAt: new Date(now.getTime() + CONNECT_LINK_TTL_MS),
        },
      });
    });
  } catch (error) {
    logger.error("[POST /api/workspaces/connect-link] Unexpected error", { error, workspaceId, userId: context.user.id });
    return NextResponse.json({ error: "Couldn't make the link. Try again." }, { status: 500 });
  }

  return NextResponse.json({ link: toLinkDto(link, workspaceId) });
}

/** Turn the link off. Idempotent: with nothing active it still answers ok. */
export async function DELETE(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const mismatch = workspaceMismatch(((await readJsonObject(request)) ?? {}).workspaceId, contextOrError.workspace.id);
  if (mismatch) return mismatch;

  await prisma.workspaceConnectLink.updateMany({
    where: { workspaceId: contextOrError.workspace.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
