import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { generateInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { planFeatureResponse } from "@/lib/planFeatureResponse";
import { checkRateLimit } from "@/lib/rateLimit";
import { reviewLinkUrl } from "@/lib/reviewLink";
import { sealSecret } from "@/lib/tokenCrypto";
import { uploadLinkUrl } from "@/lib/uploadLink";
import { requireOwnerContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";

/**
 * POST /api/workspaces/client-links { workspaceId }
 *
 * R5-security L1 (2026-11-14): "Make new client links", offered to the owners
 * who remain after an owner is demoted or leaves (members/formerOwnerNotice.ts).
 * One press replaces the client upload link and the client review link, each
 * only if it is on, so the former owner's copies stop working. Each is revoked
 * and made again exactly as its own route's Replace does, under that route's
 * advisory lock (both taken, in one order), in one transaction. The new
 * addresses are in the answer, like the link routes' own answers.
 */

export const CLIENT_LINKS_LIMIT_MESSAGE = "You made new client links many times this hour. Try again later.";
const FAILED_MESSAGE = "Couldn't make new client links. The old ones still work. Try again.";

export async function POST(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const context = contextOrError;
  const workspaceId = context.workspace.id;
  const mismatch = renderedWorkspaceRefusal(((await readJsonObject(request)) ?? {}).workspaceId, workspaceId);
  if (mismatch) return mismatch;
  const notIncluded = planFeatureResponse(context.workspace, "clientLinks");
  if (notIncluded) return notIncluded;

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/client-links",
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: CLIENT_LINKS_LIMIT_MESSAGE, retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  try {
    const made = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-review-link:${workspaceId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-upload-link:${workspaceId}`}))`;
      const active = { workspaceId, revokedAt: null };
      const [upload, review] = await Promise.all([
        tx.workspaceUploadLink.findFirst({ where: active, select: { id: true } }),
        tx.workspaceReviewLink.findFirst({ where: active, select: { id: true } }),
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
      return { uploadLink, reviewLink };
    });
    return NextResponse.json(made);
  } catch (error) {
    logger.error("[POST /api/workspaces/client-links] Unexpected error", { error, workspaceId });
    return NextResponse.json({ error: FAILED_MESSAGE }, { status: 500 });
  }
}
