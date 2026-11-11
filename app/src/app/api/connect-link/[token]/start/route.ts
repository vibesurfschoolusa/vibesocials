import { randomBytes } from "crypto";

import { NextResponse } from "next/server";

import {
  CONNECT_LINK_RATE_LIMIT_MESSAGE,
  CONNECT_LINK_STARTS_PER_HOUR,
  CONNECT_LINK_STARTS_PER_LINK_PER_HOUR,
  CONNECT_LINK_USED_TOO_OFTEN_MESSAGE,
  alreadyConnectedCode,
  connectFailedCode,
  isConnectLinkTokenShape,
  isPlatform,
} from "@/lib/connectLink";
import { logger } from "@/lib/logger";
import { createConnectLinkState } from "@/lib/oauthState";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIp } from "@/lib/uploadLink";
import { buildLinkAuthorizeUrl, startXLinkFlow } from "@/server/connectLink/authorize";
import { sealConnectCookie, setConnectCookie } from "@/server/connectLink/cookie";
import { findActiveConnectLink, linkOffers, placeTaken } from "@/server/connectLink/link";
import { appOrigin, isSameOriginRequest } from "@/server/connectLink/origin";

/**
 * POST /api/connect-link/[token]/start — a visitor pressed Connect beside a
 * platform on /c/[token] (2026-11-11). A plain HTML form, so it works without
 * JavaScript; signed out.
 *
 * Order: same-origin (a flow starts only from a press on our page), the per-IP
 * limit, the link (rule 2), the platform, the free place (rule 3). Then a fresh
 * nonce goes both into the sealed `vs_connect` cookie and into the link state
 * (or, for X, the handshake row), and the visitor is sent to the platform. The
 * raw token is only ever in the cookie and the visitor's own page address.
 */

type RouteContext = { params: Promise<{ token: string }> };

function backToPage(request: Request, token: string, error?: string): NextResponse {
  const url = new URL(`/c/${encodeURIComponent(token)}`, appOrigin(request));
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

function tooMany(retryAfterSeconds: number | undefined, message = CONNECT_LINK_RATE_LIMIT_MESSAGE): NextResponse {
  return new NextResponse(message, {
    status: 429,
    headers: { "content-type": "text/plain; charset=utf-8", "Retry-After": String(retryAfterSeconds ?? 60) },
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return new NextResponse("Open the link you were sent and press Connect there.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const limit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "connect-link/start",
    limit: CONNECT_LINK_STARTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!limit.allowed) return tooMany(limit.retryAfterSeconds);

  const { token } = await context.params;
  if (!isConnectLinkTokenShape(token)) {
    return new NextResponse("Not found", { status: 404 });
  }

  let platformValue: FormDataEntryValue | null = null;
  try {
    platformValue = (await request.formData()).get("platform");
  } catch {
    platformValue = null;
  }

  try {
    const link = await findActiveConnectLink(token);
    // The page says the link is not active.
    if (!link) return backToPage(request, token);

    // Per link as well, from whatever network: one link cannot drive unlimited
    // request-token calls (X) or flows. Keyed by the link id, never the token.
    const linkLimit = await checkRateLimit({
      userId: `connect-link:${link.id}`,
      route: "connect-link/start-link",
      limit: CONNECT_LINK_STARTS_PER_LINK_PER_HOUR,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });
    if (!linkLimit.allowed) return tooMany(linkLimit.retryAfterSeconds, CONNECT_LINK_USED_TOO_OFTEN_MESSAGE);

    if (!isPlatform(platformValue)) return backToPage(request, token, "connect_failed");
    const platform = platformValue;
    if (!linkOffers(link, platform)) return backToPage(request, token, connectFailedCode(platform));
    if (await placeTaken(link.workspaceId, platform)) {
      return backToPage(request, token, alreadyConnectedCode(platform));
    }

    const nonce = randomBytes(24).toString("base64url");
    const flow = { linkId: link.id, nonce, userId: link.createdById, workspaceId: link.workspaceId };

    const authorizeUrl =
      platform === "x"
        ? await startXLinkFlow(flow)
        : buildLinkAuthorizeUrl(platform, createConnectLinkState(flow));
    if (!authorizeUrl) return backToPage(request, token, connectFailedCode(platform));

    const response = NextResponse.redirect(authorizeUrl, 303);
    setConnectCookie(response, sealConnectCookie({ linkId: link.id, nonce, token }));
    return response;
  } catch (error) {
    logger.error("[connect-link] Couldn't start a connect", { error });
    return backToPage(request, token, isPlatform(platformValue) ? connectFailedCode(platformValue) : "connect_failed");
  }
}
