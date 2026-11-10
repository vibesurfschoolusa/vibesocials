import { after, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  DAY_MS,
  REVIEW_LINK_DAILY_LIMIT_MESSAGE,
  REVIEW_LINK_DECISIONS_PER_DAY,
  REVIEW_LINK_INACTIVE_MESSAGE,
  REVIEW_LINK_IP_LIMIT_MESSAGE,
  REVIEW_LINK_IP_PER_HOUR,
  REVIEW_POST_LOCKED_MESSAGE,
  parseReviewDecision,
  reviewWindowEnd,
} from "@/lib/reviewLink";
import { requestIp } from "@/lib/uploadLink";
import { findActiveReviewLink, notifyOwnersOfClientChange } from "@/server/reviewLink";

/**
 * POST /api/review-link/[token]/posts/[postJobId] — the client's decision on
 * one post (2026-11-10), signed out: `{ decision: "approve" }` or
 * `{ decision: "change", note }`.
 *
 * Each decision is ONE conditional update, matched on the post id, the link's
 * workspace (never the body's), status `scheduled` and the page's 60-day
 * window. Anything else matches no row and answers 409 with nothing written.
 * For a change request that update is the point of no return: the due-scanner
 * claims with its own conditional update (scheduledScanner.ts), so whichever
 * commits first wins and the other changes nothing. A post the scanner just
 * claimed is `in_progress` and gets the 409; a post pulled back here is a
 * `draft` the scanner no longer selects.
 *
 * Neither decision touches the members' approval columns
 * (submittedForApprovalAt, approvedAt, approvedByUserId; lib/approval.ts).
 *
 * Order: the body is checked first (no counting for a refused body), then the
 * per-IP limit (shared with the list route), the lookup, the per-link day
 * limit, the write, and the owners' email after the response.
 */

type RouteContext = { params: Promise<{ token: string; postJobId: string }> };

function tooMany(error: string, retryAfterSeconds: number | undefined): NextResponse {
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 60) } },
  );
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();
  const decision = parseReviewDecision(body);
  if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: 400 });

  const ipLimit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "review-link/ip",
    limit: REVIEW_LINK_IP_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!ipLimit.allowed) return tooMany(REVIEW_LINK_IP_LIMIT_MESSAGE, ipLimit.retryAfterSeconds);

  const { token, postJobId } = await context.params;
  const link = await findActiveReviewLink(token);
  if (!link) return NextResponse.json({ error: REVIEW_LINK_INACTIVE_MESSAGE }, { status: 404 });

  const dayLimit = await checkRateLimit({
    userId: `review-link:${link.id}`,
    route: "review-link/decision-day",
    limit: REVIEW_LINK_DECISIONS_PER_DAY,
    windowMs: DAY_MS,
    failClosed: true,
  });
  if (!dayLimit.allowed) return tooMany(REVIEW_LINK_DAILY_LIMIT_MESSAGE, dayLimit.retryAfterSeconds);

  const now = new Date();
  const where = {
    id: postJobId,
    workspaceId: link.workspaceId,
    status: "scheduled" as const,
    scheduledFor: { lte: reviewWindowEnd(now) },
  };

  let count: number;
  try {
    ({ count } = await prisma.postJob.updateMany({
      where,
      data:
        decision.decision === "approve"
          ? { clientApprovedAt: now, clientChangeRequestedAt: null, clientNote: null }
          : {
              status: "draft",
              clientChangeRequestedAt: now,
              clientNote: decision.note,
              clientApprovedAt: null,
            },
    }));
  } catch (error) {
    logger.error("[review-link] Couldn't save a decision", { error, linkId: link.id });
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }

  if (count === 0) return NextResponse.json({ error: REVIEW_POST_LOCKED_MESSAGE }, { status: 409 });

  try {
    await prisma.workspaceReviewLink.update({ where: { id: link.id }, data: { lastUsedAt: now } });
  } catch (error) {
    // Only the owner's "last used" display: the decision itself is saved.
    logger.error("[review-link] Couldn't stamp the link's last use (ignored)", { error, linkId: link.id });
  }

  if (decision.decision === "approve") {
    return NextResponse.json({ ok: true, state: "approved" });
  }

  // After the response: the email never delays or fails the client's request.
  const note = decision.note;
  after(async () => {
    try {
      await notifyOwnersOfClientChange({
        postJobId,
        workspaceId: link.workspaceId,
        workspaceName: link.workspaceName,
        note,
        requestedAt: now,
      });
    } catch (error) {
      logger.error("[review-link] Owner email failed (ignored)", { error, linkId: link.id });
    }
  });

  return NextResponse.json({ ok: true, state: "change_requested" });
}
