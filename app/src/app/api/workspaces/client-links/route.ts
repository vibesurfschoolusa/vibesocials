import { NextResponse } from "next/server";

import { CLIENT_LINKS_NOT_MADE_MESSAGE } from "@/lib/clientLinkWording";
import { CONNECT_LINK_TTL_MS, configuredConnectLinkPlatforms, connectLinkUrl } from "@/lib/connectLink";
import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { generateInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { PLAN_FEATURE_CODE, planIncludes, planOffers } from "@/lib/planFeatures";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { reviewLinkUrl } from "@/lib/reviewLink";
import { sealSecret } from "@/lib/tokenCrypto";
import { uploadLinkUrl } from "@/lib/uploadLink";
import { isWorkspaceOwner, requireOwnerContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { clientLinkBlockKind, clientLinkCreateRefusal } from "@/server/clientLinkPanelStatus";

/**
 * POST /api/workspaces/client-links { workspaceId }
 *
 * R5-security L1 (2026-11-14): "Make new client links", offered to the owners
 * who remain after an owner is demoted or leaves (members/formerOwnerNotice.ts).
 * One press replaces the client upload link, the client review link and (R6
 * M2) the client connect link, each only if it is on, so the former owner's
 * copies stop working. Each is revoked and made again exactly as its own
 * route's Replace does, under that route's advisory lock (all taken, in one
 * order), in one transaction. The new addresses are in the answer, like the
 * link routes' own answers.
 *
 * The connect link is made again with the same platforms, less any this site
 * can no longer offer; with none left it is turned off (`connectLinkTurnedOff`).
 * A connect link acts as the owner who made it and stops working once they are
 * no longer an owner (server/connectLink/link.ts); one in that state is still
 * "on" here, so the press gives the client a working link again, made by the
 * owner who pressed.
 *
 * GET ?workspaceId= → `{ included, on: { upload, review, connect }, connectStopped }`
 * (`connectStopped`: the connect link is on but its maker is no longer an
 * owner, so it works for nobody): the Team
 * card shows the button only while a link is on and the plan includes them.
 * R22 client-journey L1: while the workspace is blocked (a pause, or with
 * billing on an ended trial or plan) every client link answers "not active",
 * so the GET adds the panels' `workspaceBlocked` sentence, the Team card
 * offers only Turn off, and the POST refuses with that sentence.
 * R23 security L1: `included` is whether the plan itself has client links,
 * its ended state aside (planOffers), so the card gives an ended trial or
 * Growth plan the block's wording and only a plan without them (Starter) the
 * plan's. The POST still follows planIncludes.
 *
 * DELETE { workspaceId } (R7-pages L3 / client-journey L2): "Turn off client
 * links". On a plan without client links they are paused, not off, and a
 * former owner's copies would work again if the plan changes back; this
 * turns all three off, on any plan, as each link route's own DELETE does
 * (none of those is gated by the plan either). POST, which makes new ones,
 * stays for plans that include client links.
 */

/** A connect link that has not been turned off or run out, whoever made it. */
function workingConnectLinkWhere(workspaceId: string) {
  return { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } };
}

export async function GET(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const workspace = contextOrError.workspace;
  const sent = new URL(request.url).searchParams.get("workspaceId");
  const mismatch = sent === null ? null : renderedWorkspaceRefusal(sent, workspace.id);
  if (mismatch) return mismatch;

  const active = { workspaceId: workspace.id, revokedAt: null };
  const [upload, review, connect] = await Promise.all([
    prisma.workspaceUploadLink.findFirst({ where: active, select: { id: true } }),
    prisma.workspaceReviewLink.findFirst({ where: active, select: { id: true } }),
    prisma.workspaceConnectLink.findFirst({ where: workingConnectLinkWhere(workspace.id), select: { createdById: true } }),
  ]);
  const connectStopped = connect !== null && !(await isWorkspaceOwner(connect.createdById, workspace.id));
  const workspaceBlocked = clientLinkCreateRefusal(workspace);
  return NextResponse.json({
    included: planOffers(workspace, "clientLinks"),
    on: { upload: upload !== null, review: review !== null, connect: connect !== null },
    connectStopped,
    // II1 review: the kind, so the card says when the kept copies work again.
    ...(workspaceBlocked ? { workspaceBlocked, workspaceBlockedBy: clientLinkBlockKind(workspace) ?? "pause" } : {}),
  });
}

/** New client links one owner makes in an hour, counted across every workspace they own. */
const CLIENT_LINKS_PER_HOUR = 10;
/** R44 new-customer L1: the reason before the wait (tooManyTriesResponse). */
export const CLIENT_LINKS_LIMIT_REASON = `You've made new client links ${CLIENT_LINKS_PER_HOUR} times this hour, counted across all your workspaces.`;
export const CLIENT_LINKS_NOT_INCLUDED_MESSAGE =
  "This workspace's plan doesn't include client links, so new ones can't be made. To stop the old ones working, press Turn off client links.";
const TURN_OFF_FAILED_MESSAGE = "Couldn't turn off the client links. Nothing changed. Try again.";

export async function POST(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const context = contextOrError;
  const workspaceId = context.workspace.id;
  const mismatch = renderedWorkspaceRefusal(((await readJsonObject(request)) ?? {}).workspaceId, workspaceId);
  if (mismatch) return mismatch;
  const blocked = clientLinkCreateRefusal(context.workspace);
  if (blocked) return NextResponse.json({ error: blocked, code: "WORKSPACE_BLOCKED" }, { status: 403 });
  if (!planIncludes(context.workspace, "clientLinks")) {
    return NextResponse.json({ error: CLIENT_LINKS_NOT_INCLUDED_MESSAGE, code: PLAN_FEATURE_CODE }, { status: 403 });
  }

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/client-links",
    limit: CLIENT_LINKS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return tooManyTriesResponse(rateLimit, CLIENT_LINKS_LIMIT_REASON);
  }

  try {
    const made = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-review-link:${workspaceId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-upload-link:${workspaceId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-connect-link:${workspaceId}`}))`;
      const active = { workspaceId, revokedAt: null };
      const [upload, review, connect] = await Promise.all([
        tx.workspaceUploadLink.findFirst({ where: active, select: { id: true } }),
        tx.workspaceReviewLink.findFirst({ where: active, select: { id: true } }),
        tx.workspaceConnectLink.findFirst({ where: workingConnectLinkWhere(workspaceId), select: { id: true, platforms: true } }),
      ]);
      const now = new Date();

      let uploadLink = null;
      if (upload) {
        const { raw, hash } = generateInviteToken();
        await tx.workspaceUploadLink.updateMany({ where: active, data: { revokedAt: now } });
        const row = await tx.workspaceUploadLink.create({
          data: { workspaceId, tokenHash: hash, tokenSealed: sealSecret(raw), createdById: context.user.id },
        });
        uploadLink = {
          url: uploadLinkUrl(process.env.NEXTAUTH_URL, raw),
          uploadCount: row.uploadCount,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        };
      }

      let reviewLink = null;
      if (review) {
        const { raw, hash } = generateInviteToken();
        await tx.workspaceReviewLink.updateMany({ where: active, data: { revokedAt: now } });
        const row = await tx.workspaceReviewLink.create({
          data: { workspaceId, tokenHash: hash, tokenSealed: sealSecret(raw), createdById: context.user.id },
        });
        reviewLink = {
          url: reviewLinkUrl(process.env.NEXTAUTH_URL, raw),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        };
      }

      let connectLink = null;
      let connectLinkTurnedOff = false;
      if (connect) {
        await tx.workspaceConnectLink.updateMany({ where: active, data: { revokedAt: now } });
        const offered = configuredConnectLinkPlatforms();
        const platforms = connect.platforms.filter((platform) => offered.includes(platform));
        if (platforms.length === 0) {
          connectLinkTurnedOff = true;
        } else {
          const { raw, hash } = generateInviteToken();
          const row = await tx.workspaceConnectLink.create({
            data: {
              workspaceId,
              tokenHash: hash,
              tokenSealed: sealSecret(raw),
              createdById: context.user.id,
              platforms,
              expiresAt: new Date(now.getTime() + CONNECT_LINK_TTL_MS),
            },
          });
          connectLink = {
            url: connectLinkUrl(process.env.NEXTAUTH_URL, raw),
            platforms: row.platforms,
            expiresAt: row.expiresAt.toISOString(),
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          };
        }
      }
      return { uploadLink, reviewLink, connectLink, ...(connectLinkTurnedOff ? { connectLinkTurnedOff } : {}) };
    });
    return NextResponse.json(made);
  } catch (error) {
    logger.error("[POST /api/workspaces/client-links] Unexpected error", { error, workspaceId });
    return NextResponse.json({ error: CLIENT_LINKS_NOT_MADE_MESSAGE }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const workspaceId = contextOrError.workspace.id;
  const mismatch = renderedWorkspaceRefusal(((await readJsonObject(request)) ?? {}).workspaceId, workspaceId);
  if (mismatch) return mismatch;

  try {
    await prisma.$transaction(async (tx) => {
      const active = { workspaceId, revokedAt: null };
      const off = { revokedAt: new Date() };
      await tx.workspaceUploadLink.updateMany({ where: active, data: off });
      await tx.workspaceReviewLink.updateMany({ where: active, data: off });
      await tx.workspaceConnectLink.updateMany({ where: active, data: off });
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[DELETE /api/workspaces/client-links] Unexpected error", { error, workspaceId });
    return NextResponse.json({ error: TURN_OFF_FAILED_MESSAGE }, { status: 500 });
  }
}
