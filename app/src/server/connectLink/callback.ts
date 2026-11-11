import { timingSafeEqual } from "crypto";

import { NextResponse } from "next/server";
import type { Platform } from "@prisma/client";

import { alreadyConnectedCode, cancelledCode, connectFailedCode, type ConnectLinkFlow } from "@/lib/connectLink";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { looksLikeConnectLinkState, readConnectLinkState } from "@/lib/oauthState";

import { clearConnectCookie, rawConnectCookie, readConnectCookie, type ConnectCookie } from "./cookie";
import { findActiveConnectLink, linkOffers, placeTaken } from "./link";
import { appOrigin } from "./origin";

/**
 * withConnectLink (2026-11-11): the one place a platform callback learns about
 * client connect links. Each callback's body runs unchanged as `handler`.
 *
 * Not a link flow (an ordinary state; for X, no `vs_connect` cookie or a
 * handshake row without a link): `handler(request, null)` and its response go
 * out untouched. A signed-in owner's connect is never touched; for a state
 * platform not even a query is added, for X only when the cookie is present.
 *
 * A link flow: rule 4 (the sealed cookie opens and names the same link id and
 * nonce as the state or handshake row), rule 2 (the link still works and
 * offers the platform), rule 3 (the place is free), then the handler with the
 * link, and its /settings redirect becomes the visitor's /c/<token> page. A
 * link flow never falls through to the signed-in path: every refusal here
 * answers without calling the handler.
 */

type Handler<R extends Request> = (request: R, link: ConnectLinkFlow | null) => Promise<Response>;

/** What detection read from the request: the link id and nonce it claims, if any could be read. */
type Claimed = { linkId: string | null; nonce: string | null };

const WRAPPED = new WeakMap<object, Platform>();

/** The platform a callback's exported GET was wrapped for, or null when it is not wrapped. */
export function connectLinkWrappedPlatform(handler: unknown): Platform | null {
  return (typeof handler === "function" && WRAPPED.get(handler)) || null;
}

export function withConnectLink<R extends Request>(platform: Platform, handler: Handler<R>): (request: R) => Promise<Response> {
  const wrapped = async (request: R): Promise<Response> => {
    let claimed: Claimed | null;
    try {
      claimed = await detectLinkFlow(platform, request);
    } catch {
      // Detection must never stand in the way of an ordinary connect.
      claimed = null;
    }
    if (!claimed) return handler(request, null);
    return runLinkFlow(platform, request, handler, claimed);
  };
  WRAPPED.set(wrapped, platform);
  return wrapped;
}

async function detectLinkFlow(platform: Platform, request: Request): Promise<Claimed | null> {
  const url = new URL(request.url);
  if (platform === "x") {
    // X has no state: only a browser holding the cookie can be in a link
    // flow, so without it nothing is looked up.
    if (!rawConnectCookie(request)) return null;
    const token = url.searchParams.get("oauth_token") ?? url.searchParams.get("denied");
    if (!token) return null;
    const handshake = await prisma.oAuthHandshake.findUnique({ where: { token } });
    if (!handshake?.connectLinkId) return null;
    return { linkId: handshake.connectLinkId, nonce: handshake.connectLinkNonce ?? null };
  }

  const state = url.searchParams.get("state");
  if (!state) return null;
  // LinkedIn's start route may append an unsigned ".vanityName"; a link never does.
  const signed = state.split(".")[0];
  if (!looksLikeConnectLinkState(signed)) return null;
  // In the link envelope: a link flow from here on, even when the signature
  // or age fails (rule 4 then refuses it), never the ordinary path.
  const payload = readConnectLinkState(signed);
  return { linkId: payload?.linkId ?? null, nonce: payload?.nonce ?? null };
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function visitorPage(origin: string, token: string): URL {
  return new URL(`/c/${encodeURIComponent(token)}`, origin);
}

/** A redirect that ends the flow: the cookie goes. */
function ending(url: URL, status = 307): NextResponse {
  const response = NextResponse.redirect(url, status);
  clearConnectCookie(response);
  return response;
}

async function runLinkFlow<R extends Request>(
  platform: Platform,
  request: R,
  handler: Handler<R>,
  claimed: Claimed,
): Promise<Response> {
  const origin = appOrigin(request);

  // Rule 4. Without a cookie that opens and matches, the visitor gets the
  // "open your link again" page and nothing is exchanged or written.
  const cookie = readConnectCookie(request);
  if (
    !cookie ||
    !claimed.linkId ||
    !claimed.nonce ||
    !sameText(cookie.linkId, claimed.linkId) ||
    !sameText(cookie.nonce, claimed.nonce)
  ) {
    logger.warn("[connect-link] A link flow finished without its browser's cookie", { platform });
    return ending(new URL("/c", origin));
  }

  let flow: ConnectLinkFlow;
  try {
    // Rule 2.
    const link = await findActiveConnectLink(cookie.token);
    if (!link || link.id !== cookie.linkId) {
      // The page itself says the link is not active.
      return ending(visitorPage(origin, cookie.token));
    }
    if (!linkOffers(link, platform)) {
      return ending(withError(visitorPage(origin, cookie.token), connectFailedCode(platform)));
    }
    // Rule 3, again before the code exchange.
    if (await placeTaken(link.workspaceId, platform)) {
      return ending(withError(visitorPage(origin, cookie.token), alreadyConnectedCode(platform)));
    }
    flow = { id: link.id, nonce: cookie.nonce, userId: link.createdById, workspaceId: link.workspaceId, token: cookie.token };
  } catch (error) {
    logger.error("[connect-link] Couldn't check the link in a callback", { platform, connectLinkId: cookie.linkId, error });
    return ending(withError(visitorPage(origin, cookie.token), connectFailedCode(platform)));
  }

  const response = await handler(request, flow);
  return toVisitorPage(platform, request, response, flow, cookie);
}

/**
 * What the platform itself said, when it sent the visitor back with a refusal:
 * "cancelled" when the person said no, "failed" for any other platform error,
 * null when it sent none. Several callbacks give one code for every provider
 * error, so only the platform's own parameters can tell a "no" from a fault.
 */
function platformRefusal(platform: Platform, request: Request): "cancelled" | "failed" | null {
  const params = new URL(request.url).searchParams;
  if (platform === "x") return params.has("denied") ? "cancelled" : null;
  const error = params.get("error");
  if (!error) return null;
  if (error === "access_denied" || error.startsWith("user_cancelled") || params.get("error_reason") === "user_denied") {
    return "cancelled";
  }
  return "failed";
}

function withError(url: URL, code: string): URL {
  url.searchParams.set("error", code);
  return url;
}

/**
 * The callback answers as it would for an owner (a redirect to /settings with
 * its query); the visitor goes to their own page with the same query instead.
 */
async function toVisitorPage(
  platform: Platform,
  request: Request,
  response: Response,
  flow: ConnectLinkFlow,
  cookie: ConnectCookie,
): Promise<Response> {
  const location = response.headers.get("location");
  if (!location || response.status < 300 || response.status >= 400) return response;

  const target = new URL(location);
  const page = visitorPage(target.origin, cookie.token);

  const refusal = platformRefusal(platform, request);
  if (refusal) {
    const code = refusal === "cancelled" ? cancelledCode(platform) : connectFailedCode(platform);
    return ending(withError(page, code), response.status);
  }

  if (target.pathname !== "/settings") {
    // /login (and anything else) has nothing to tell the visitor.
    return ending(withError(page, connectFailedCode(platform)), response.status);
  }
  page.search = target.search;

  const choose = page.searchParams.get("choose");
  if (choose) {
    // The choice endpoints authorise by the token in the address and this
    // stamp, so the cookie stays for nothing but is kept until the choice ends.
    if (await stampPending(choose, flow, platform)) {
      return NextResponse.redirect(page, response.status);
    }
    return ending(withError(visitorPage(target.origin, cookie.token), connectFailedCode(platform)), response.status);
  }

  if (page.searchParams.get("success")) {
    await prisma.workspaceConnectLink
      .update({ where: { id: flow.id }, data: { lastUsedAt: new Date() } })
      .catch((error: unknown) => {
        logger.error("[connect-link] Couldn't record when the link was used (ignored)", { connectLinkId: flow.id, error });
      });
  }
  return ending(page, response.status);
}

async function stampPending(pendingId: string, flow: ConnectLinkFlow, platform: Platform): Promise<boolean> {
  try {
    const { count } = await prisma.pendingConnection.updateMany({
      where: { id: pendingId, workspaceId: flow.workspaceId, userId: flow.userId },
      data: { connectLinkId: flow.id },
    });
    return count === 1;
  } catch (error) {
    logger.error("[connect-link] Couldn't mark the waiting choice as the link's", { platform, connectLinkId: flow.id, error });
    return false;
  }
}
