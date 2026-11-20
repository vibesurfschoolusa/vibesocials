import { randomBytes } from "crypto";

import { NextResponse } from "next/server";

import { readBodyAtMost } from "@/lib/boundedBody";
import { CONNECT_LIMIT_CODES, LIMIT_UNCHECKED_WAIT_SECONDS, connectAgainQuery } from "@/lib/clientLinkLimit";
import {
  CONNECT_LINK_STARTS_PER_HOUR,
  CONNECT_LINK_STARTS_PER_LINK_PER_HOUR,
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

/**
 * R45 pages-a L7: a limit's refusal goes back to the page, as every other
 * outcome does; a plain form post would otherwise leave /c for a bare text
 * page. The page builds the sentence from the code, the wait and the platform.
 * R46 client-journey L1: the address carries the wait's end, not the wait,
 * so a reload much later reads what is left, never the wait at the press.
 * R46 pages-a L1: a limit that couldn't be checked comes back the same way.
 */
function tooMany(
  request: Request,
  token: string,
  code: (typeof CONNECT_LIMIT_CODES)[keyof typeof CONNECT_LIMIT_CODES],
  retryAfterSeconds: number | undefined,
  platform: FormDataEntryValue | null,
): NextResponse {
  const url = new URL(`/c/${encodeURIComponent(token)}`, appOrigin(request));
  const query = connectAgainQuery(code, retryAfterSeconds ?? 60, Date.now());
  url.searchParams.set("error", query.error);
  url.searchParams.set("until", query.until);
  if (isPlatform(platform)) url.searchParams.set("platform", platform);
  return NextResponse.redirect(url, 303);
}

/**
 * R45 review L3: the form is read before the per-IP limit (so a refusal can
 * name the platform), so it is read only up to this. Our form sends one field.
 */
const FORM_MAX_BYTES = 4 * 1024;

/** R38 new-customer L1: a limit that couldn't be checked; back to the page, as a refusal is. */
function unchecked(request: Request, token: string, platform: FormDataEntryValue | null): NextResponse {
  return tooMany(request, token, CONNECT_LIMIT_CODES.unchecked, LIMIT_UNCHECKED_WAIT_SECONDS, platform);
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return new NextResponse("Open the link you were sent and press Connect there.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const { token } = await context.params;
  const form = await readBodyAtMost(request, FORM_MAX_BYTES);
  if (!form.ok && form.reason === "too_large") {
    return new NextResponse("That request was too large. Open the link you were sent and press Connect there.", {
      status: 413,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const platformValue = form.ok ? new URLSearchParams(form.bytes.toString("utf8")).get("platform") : null;

  const limit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "connect-link/start",
    limit: CONNECT_LINK_STARTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (limit.unavailable) return unchecked(request, token, platformValue);
  if (!limit.allowed) {
    return tooMany(request, token, CONNECT_LIMIT_CODES.network, limit.retryAfterSeconds, platformValue);
  }

  if (!isConnectLinkTokenShape(token)) {
    return new NextResponse("Not found", { status: 404 });
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
    if (linkLimit.unavailable) return unchecked(request, token, platformValue);
    if (!linkLimit.allowed) {
      return tooMany(request, token, CONNECT_LIMIT_CODES.link, linkLimit.retryAfterSeconds, platformValue);
    }

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
