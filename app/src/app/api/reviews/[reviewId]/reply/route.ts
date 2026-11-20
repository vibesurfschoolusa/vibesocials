import { NextResponse } from "next/server";
import type { SocialConnection } from "@prisma/client";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { accessBlockResponse } from "@/lib/workspaceStatus";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { prisma } from "@/lib/db";
import { refreshGoogleTokenEarly } from "@/server/platforms/googleTokens";
import { REPLY_TOO_LONG_MESSAGE, replyTooLong } from "@/lib/reviewReplyLength";
import { classifyGoogleFailure, flagIfTokenRejected, withGoogleTokenRetry } from "@/server/googleFailure";
import {
  GBP_REPLY_UNCONFIRMED_CODE,
  MEMBER_OTHER_LOCATION_MESSAGE,
  REPLY_MAY_BE_POSTED_MESSAGE,
  REPLY_FINAL_CODES,
  replyErrorBody,
  reviewLocationName,
  savedLocationIn,
  savedLocationName,
  type ReviewsReader,
} from "@/server/googleReviews";
import { googleRouteRateLimit, listGbpLocationsWithToken } from "@/app/api/connections/google_business_profile/gbpLocations";
import { signedOutResponse } from "@/lib/signedOutResponse";
import { gbpDisconnectedBody } from "@/app/api/reviews/gbpDisconnected";

export const dynamic = "force-dynamic";

const REPLY_FAILED_MESSAGE = "Couldn't post your reply. Try again in a minute.";
const REVIEW_NOT_FOUND = { error: "Review not found." };
const WHERE = "POST /api/reviews/[reviewId]/reply";

/**
 * R32 client-journey L6: the review's location is not in the connected
 * account's complete listing (Google signed in again, maybe in another tab,
 * with an account that does not manage it). The review is there; the step is
 * the in-place sign-in, which only an owner gets. The code marks it final, as
 * Google's own refusal of the location.
 */
function locationNotManagedBody(role: ReviewsReader) {
  const what = "The connected Google account no longer manages this location, so your reply wasn't posted.";
  return role === "member"
    ? {
        error: `${what} Copy your reply. The workspace owner can sign in to Google again with the account that manages it.`,
        code: REPLY_FINAL_CODES.access,
      }
    : {
        error: `${what} Sign in to Google again with the account that manages it, then post your reply again.`,
        reconnect: true as const,
        signIn: true as const,
        code: REPLY_FINAL_CODES.access,
      };
}

/**
 * POST /api/reviews/[reviewId]/reply - Reply to a Google Business Profile
 * review. Any member may reply (Team Workspaces — design §1: "Reply to
 * Google reviews (incl. AI draft)" is member-level).
 *
 * R25 client-journey L3: a member answers only the workspace's saved location
 * (replies are public and never held for approval); an owner, any listed one.
 */
export async function POST(request: Request) {
  // R12 L1: who reads the answer. Until the context is read, nobody is offered a reconnect.
  let role: ReviewsReader = "member";
  // The row whose token the Google calls send: a token Google refuses is flagged with it.
  let used: SocialConnection | null = null;
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return signedOutResponse();
    }
    role = context.role;

    const body = await readJsonObject(request);
    if (!body) {
      return invalidJsonBodyResponse();
    }
    // R27 security-billing L1: the workspace the page was rendered for, never
    // the cookie alone: a stale tab would post publicly through another
    // workspace's connection. Before any Google call.
    // No id is a page open from before the id was sent: as before, until reloaded.
    // R28 client-journey L6: before the pause, which is the cookie's workspace's.
    const refusal =
      body.workspaceId === undefined ? null : renderedWorkspaceRefusal(body.workspaceId, context.workspace.id);
    if (refusal) return refusal;

    // Pause (2026-11-10): a paused workspace cannot create or move work.
    const blocked = accessBlockResponse(context);
    if (blocked) return blocked;

    // R25 security-billing L1: before any Google call (after the workspace and
    // pause checks, which write nothing); a reply is a public write.
    const limited = await googleRouteRateLimit(context.user.id, "reviews/reply", 20);
    if (limited) return limited;

    const { comment, reviewName } = body;

    if (!comment || typeof comment !== "string" || comment.trim().length === 0) {
      return NextResponse.json(
        { error: "Reply comment is required" },
        { status: 400 }
      );
    }

    // R17 L1: Google refuses a reply over 4096 bytes (a 400 that would never
    // pass on retry), so nothing over the limit is sent.
    if (replyTooLong(comment)) {
      return NextResponse.json({ error: REPLY_TOO_LONG_MESSAGE }, { status: 400 });
    }

    if (!reviewName || typeof reviewName !== "string") {
      return NextResponse.json(
        { error: "Review name is required" },
        { status: 400 }
      );
    }

    // R1-security L5: the reply is sent to `<reviewName>/reply`, so only a
    // review's own resource name is sent on, and only on a location this
    // connection's Google account lists (checked below, once the token is ready).
    const reviewLocation = reviewLocationName(reviewName);
    if (!reviewLocation) {
      return NextResponse.json(REVIEW_NOT_FOUND, { status: 404 });
    }

    // Get the workspace's Google Business Profile connection
    const connection = await prisma.socialConnection.findFirst({
      where: {
        workspaceId: context.workspace.id,
        platform: "google_business_profile",
      },
    });

    if (!connection) {
      return NextResponse.json(gbpDisconnectedBody(role, { reply: true }), { status: 404 });
    }

    // A connection Google has revoked reads "Reconnect" at once, as the link
    // route does, instead of after the stored token runs out. R25 lead review:
    // every Google failure answers through replyErrorBody, whose code tells the
    // page a retry can't change it.
    if (connection.needsReconnect) {
      return NextResponse.json(replyErrorBody("reconnect", REPLY_FAILED_MESSAGE, role), { status: 500 });
    }

    // R23 client-journey L1: a token in its last 5 minutes is refreshed too,
    // so a long listing never runs past expiry (Google's 401 reads "Reconnect").
    // A failed early refresh of a still-valid token goes on with the stored one.
    const { refreshAccessToken } = await import("@/server/googleReviews");
    used = await refreshGoogleTokenEarly(connection, refreshAccessToken);

    if (!used.accessToken) {
      return NextResponse.json(replyErrorBody("reconnect", REPLY_FAILED_MESSAGE, role), { status: 500 });
    }

    // R26 platform-clients L1: a 401 on a token that ran out on the way is
    // refreshed once and the work retried once (withGoogleTokenRetry). A 401
    // means Google took nothing, so the reply is never posted twice.
    return await withGoogleTokenRetry(used, refreshAccessToken, async (row) => {
      used = row;
      const accessToken = row.accessToken ?? "";
      // The same paged listing the Reviews page shows, so any location the
      // person can open there can be answered. An account that could not be
      // read is a failure to retry, not a review that does not exist.
      const listing = await listGbpLocationsWithToken(
        { id: row.id, accessToken, refreshToken: row.refreshToken ?? null, expiresAt: row.expiresAt },
        WHERE,
      );
      if (!listing.ok) {
        return NextResponse.json(replyErrorBody(listing.kind, REPLY_FAILED_MESSAGE, role), { status: 500 });
      }
      if (!listing.locations.some((location) => location.resourceName === reviewLocation)) {
        return listing.complete
          ? NextResponse.json(locationNotManagedBody(role), { status: 403 })
          : NextResponse.json({ error: REPLY_FAILED_MESSAGE }, { status: 500 });
      }
      if (
        role === "member" &&
        savedLocationIn(listing.locations, savedLocationName(connection.metadata))?.resourceName !== reviewLocation
      ) {
        return NextResponse.json({ error: MEMBER_OTHER_LOCATION_MESSAGE }, { status: 403 });
      }

      // Post reply to Google Business Profile API using full review name
      const { replyToReview } = await import("@/server/googleReviews");
      const result = await replyToReview(
        accessToken,
        reviewName,
        comment.trim()
      );

      return NextResponse.json({
        success: true,
        reply: result,
      });
    });
  } catch (error: unknown) {
    // R48 platform: the reply was sent and its answer lost, so it may be live.
    // No final code: Post reply again is the step, and it replaces the reply.
    if ((error as { code?: unknown } | null)?.code === GBP_REPLY_UNCONFIRMED_CODE) {
      console.warn("[Google] reply sent, answer lost", { where: WHERE });
      return NextResponse.json({ error: REPLY_MAY_BE_POSTED_MESSAGE }, { status: 500 });
    }
    // R25 platform-clients L2: a token Google refused flags the row first.
    const settled = await flagIfTokenRejected(error, used);
    // Classified once, by kind (classifyGoogleFailure), then worded with its code.
    const body = replyErrorBody(classifyGoogleFailure(settled, WHERE), REPLY_FAILED_MESSAGE, role);
    return NextResponse.json(body, { status: 500 });
  }
}
