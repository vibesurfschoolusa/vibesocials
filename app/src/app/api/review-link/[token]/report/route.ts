import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { parseReportMonth, publicMonthlyReport } from "@/lib/monthlyReport";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  REVIEW_LINK_INACTIVE_MESSAGE,
  REVIEW_LINK_IP_LIMIT_MESSAGE,
  REVIEW_LINK_IP_PER_HOUR,
} from "@/lib/reviewLink";
import { requestIp } from "@/lib/uploadLink";
import { buildMonthlyReport } from "@/server/reports/monthlyReport";
import { findActiveReviewLink } from "@/server/reviewLink";

/**
 * GET /api/review-link/[token]/report?month=YYYY-MM — the monthly report a
 * client review link shows (18a), signed out. Built as GET
 * /api/review-link/[token] is: the per-IP limit shared with the review routes
 * (failing closed), then the lookup; the workspace comes from the link and
 * nothing else, so turning the link off turns the report off. The answer is
 * the report object, rebuilt field by field (publicMonthlyReport), and nothing
 * about the link.
 */

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const ipLimit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "review-link/ip",
    limit: REVIEW_LINK_IP_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: REVIEW_LINK_IP_LIMIT_MESSAGE, retryAfterSeconds: ipLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const { token } = await context.params;
  const link = await findActiveReviewLink(token);
  if (!link) return NextResponse.json({ error: REVIEW_LINK_INACTIVE_MESSAGE }, { status: 404 });

  const now = new Date();
  const parsed = parseReportMonth(new URL(request.url).searchParams.get("month"), now);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const report = await buildMonthlyReport(link.workspaceId, parsed.month, now);
    return NextResponse.json(publicMonthlyReport(report), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("[review-link] Couldn't build the monthly report", { error, linkId: link.id });
    return NextResponse.json({ error: "Couldn't load the report. Try again." }, { status: 500 });
  }
}
