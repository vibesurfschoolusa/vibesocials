import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * withConnectLink (16): decides whether a callback request is a connect-link
 * flow, checks rules 4, 2 and 3 for one, runs the callback with the link, and
 * turns its /settings redirect into the visitor's page. Not a link flow: the
 * callback runs with null and its response goes out untouched.
 */

const h = vi.hoisted(() => ({
  handshakeFind: vi.fn(),
  linkFind: vi.fn(),
  linkUpdate: vi.fn(),
  connectionFind: vi.fn(),
  pendingUpdateMany: vi.fn(),
  isOwner: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthHandshake: { findUnique: h.handshakeFind },
    workspaceConnectLink: { findUnique: h.linkFind, update: h.linkUpdate },
    socialConnection: { findUnique: h.connectionFind },
    pendingConnection: { updateMany: h.pendingUpdateMany },
  },
}));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: h.isOwner }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: h.getCurrentUser }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { ConnectLinkFlow } from "@/lib/connectLink";
import { generateInviteToken } from "@/lib/inviteToken";
import { createConnectLinkState, createOAuthState } from "@/lib/oauthState";

import { connectLinkWrappedPlatform, withConnectLink } from "./callback";
import { sealConnectCookie } from "./cookie";

const ORIGIN = "https://app.example.com";
const NOW = new Date("2026-11-11T08:00:00Z");
const TOKEN = generateInviteToken().raw;
const CREATOR = "user-creator";
const WORKSPACE = "ws-1";

function linkRow(overrides: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: WORKSPACE,
    createdById: CREATOR,
    platforms: ["tiktok", "facebook_page", "x"],
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    workspace: { name: "Surf Co", pausedAt: null, pausedReason: null, ...workspace },
    ...overrides,
  };
}

function cookieFor(linkId = "link-1", nonce = "nonce-1", token = TOKEN): string {
  return `vs_connect=${encodeURIComponent(sealConnectCookie({ linkId, nonce, token }))}`;
}

function linkState(linkId = "link-1", nonce = "nonce-1"): string {
  return createConnectLinkState({ linkId, nonce, userId: CREATOR, workspaceId: WORKSPACE });
}

function stateRequest(state: string, cookie?: string, extra: Record<string, string> = {}): NextRequest {
  const url = new URL("/api/auth/tiktok/callback", ORIGIN);
  url.searchParams.set("code", "auth-code");
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return new NextRequest(url, cookie ? { headers: { cookie } } : undefined);
}

function xRequest(cookie?: string): Request {
  return new Request(`${ORIGIN}/api/auth/x/callback?oauth_token=req-token&oauth_verifier=v`, {
    headers: cookie ? { cookie } : {},
  });
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") as string);
}

function setCookie(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

/** A fake callback answering the given /settings (or other) redirect. */
function handlerAnswering(path: string) {
  return vi.fn(async (_request: Request, _link: ConnectLinkFlow | null) =>
    NextResponse.redirect(new URL(path, ORIGIN)),
  );
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  for (const [key, value] of Object.entries({
    TIKTOK_CLIENT_KEY: "k",
    TIKTOK_CLIENT_SECRET: "s",
    TIKTOK_REDIRECT_URI: "r",
    FACEBOOK_APP_ID: "k",
    FACEBOOK_APP_SECRET: "s",
    FACEBOOK_PAGE_REDIRECT_URI: "r",
    X_CONSUMER_KEY: "k",
    X_CONSUMER_SECRET: "s",
    X_CALLBACK_URL: "r",
  })) {
    vi.stubEnv(key, value);
  }
  h.linkFind.mockResolvedValue(linkRow());
  h.isOwner.mockResolvedValue(true);
  h.connectionFind.mockResolvedValue(null);
  h.linkUpdate.mockResolvedValue({});
  h.pendingUpdateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("withConnectLink: not a link flow (state platforms)", () => {
  it("runs the callback with null and returns its response untouched, with no query", async () => {
    const answer = NextResponse.redirect(new URL("/settings?success=tiktok_connected", ORIGIN));
    const handler = vi.fn(async () => answer);
    const GET = withConnectLink("tiktok", handler);
    const request = stateRequest(createOAuthState({ userId: CREATOR, workspaceId: WORKSPACE }));

    const res = await GET(request);

    expect(res).toBe(answer);
    expect(handler).toHaveBeenCalledWith(request, null);
    for (const m of Object.values(h)) expect(m).not.toHaveBeenCalled();
  });

  it("an ordinary state with a stray connect cookie is the ordinary path", async () => {
    const answer = NextResponse.redirect(new URL("/settings?success=tiktok_connected", ORIGIN));
    const handler = vi.fn(async () => answer);
    const request = stateRequest(createOAuthState({ userId: CREATOR, workspaceId: WORKSPACE }), cookieFor());

    const res = await withConnectLink("tiktok", handler)(request);

    expect(res).toBe(answer);
    expect(handler).toHaveBeenCalledWith(request, null);
    expect(setCookie(res)).toBe("");
  });

  it("no state, or garbage, is the ordinary path", async () => {
    const handler = handlerAnswering("/settings?error=tiktok_missing_code_or_state");
    await withConnectLink("tiktok", handler)(new NextRequest(`${ORIGIN}/api/auth/tiktok/callback?code=c`));
    await withConnectLink("tiktok", handler)(stateRequest("%%%not-base64"));
    expect(handler.mock.calls.every(([, link]) => link === null)).toBe(true);
  });
});

describe("withConnectLink: rule 4, the browser that finishes is the one that started", () => {
  it.each([
    ["no cookie", undefined],
    ["a cookie for another link", cookieFor("link-2")],
    ["a wrong nonce", cookieFor("link-1", "nonce-other")],
    ["a cookie that does not open", "vs_connect=enc%3Av1%3Agarbage"],
  ])("%s: refused with the open-your-link-again page, callback not called", async (_name, cookie) => {
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    const res = await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookie));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).toString()).toBe(`${ORIGIN}/c`);
    expect(h.linkFind).not.toHaveBeenCalled();
    expect(res.headers.get("location")).not.toContain(TOKEN);
  });

  it("a signed-in creator finishing a link state without the cookie is refused, and the session is never asked", async () => {
    h.getCurrentUser.mockResolvedValue({ id: CREATOR });
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    const res = await withConnectLink("tiktok", handler)(stateRequest(linkState()));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).pathname).toBe("/c");
    expect(h.getCurrentUser).not.toHaveBeenCalled();
  });

  it("a tampered link state is refused", async () => {
    const handler = handlerAnswering("/settings?success=tiktok_connected");
    const envelope = JSON.parse(Buffer.from(linkState(), "base64url").toString("utf8")) as Record<string, string>;
    const payload = JSON.parse(envelope.p) as Record<string, unknown>;
    payload.workspaceId = "ws-attacker";
    const tampered = Buffer.from(JSON.stringify({ ...envelope, p: JSON.stringify(payload) })).toString("base64url");

    const res = await withConnectLink("tiktok", handler)(stateRequest(tampered, cookieFor()));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).pathname).toBe("/c");
  });
});

describe("withConnectLink: rule 2, the link still works", () => {
  it.each([
    ["revoked", () => h.linkFind.mockResolvedValue(linkRow({ revokedAt: new Date(NOW.getTime() - 1) }))],
    ["expired", () => h.linkFind.mockResolvedValue(linkRow({ expiresAt: NOW }))],
    ["creator no longer owner", () => h.isOwner.mockResolvedValue(false)],
    ["workspace paused", () => h.linkFind.mockResolvedValue(linkRow({}, { pausedAt: NOW }))],
  ])("%s: the visitor's page (which says the link is not active), callback not called", async (_name, arrange) => {
    arrange();
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    const res = await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookieFor()));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}`);
    expect(setCookie(res)).toMatch(/^vs_connect=;/);
  });

  it("a platform the link does not offer is refused", async () => {
    h.linkFind.mockResolvedValue(linkRow({ platforms: ["facebook_page"] }));
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    const res = await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookieFor()));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).searchParams.get("error")).toBe("tiktok_connect_failed");
  });

  it("a platform that is no longer configured is refused", async () => {
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    const res = await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookieFor()));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).searchParams.get("error")).toBe("tiktok_connect_failed");
  });
});

describe("withConnectLink: rule 3, a link never replaces a working account", () => {
  it("a place taken by a working connection is refused before the callback runs", async () => {
    h.connectionFind.mockResolvedValue({ needsReconnect: false });
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    const res = await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookieFor()));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=tiktok_already_connected`);
  });

  it("a place whose connection needs reconnecting is allowed", async () => {
    h.connectionFind.mockResolvedValue({ needsReconnect: true });
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookieFor()));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("withConnectLink: running the callback with the link", () => {
  it("passes the creator, the workspace, the link id and nonce, and the token", async () => {
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookieFor()));

    expect(handler.mock.calls[0][1]).toEqual({
      id: "link-1",
      nonce: "nonce-1",
      userId: CREATOR,
      workspaceId: WORKSPACE,
      token: TOKEN,
    });
  });

  it("success: the visitor's page with the same query, lastUsedAt set, cookie cleared", async () => {
    const res = await withConnectLink("tiktok", handlerAnswering("/settings?success=tiktok_connected"))(
      stateRequest(linkState(), cookieFor()),
    );

    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?success=tiktok_connected`);
    expect(h.linkUpdate).toHaveBeenCalledWith({ where: { id: "link-1" }, data: { lastUsedAt: NOW } });
    expect(setCookie(res)).toMatch(/^vs_connect=;/);
    expect(setCookie(res).toLowerCase()).toContain("max-age=0");
  });

  it("an error: the visitor's page with the same query, lastUsedAt not set, cookie cleared", async () => {
    const res = await withConnectLink("tiktok", handlerAnswering("/settings?error=tiktok_token_exchange_failed"))(
      stateRequest(linkState(), cookieFor()),
    );

    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=tiktok_token_exchange_failed`);
    expect(h.linkUpdate).not.toHaveBeenCalled();
    expect(setCookie(res)).toMatch(/^vs_connect=;/);
  });

  it("a choice: the pending row is stamped with the link, the cookie is kept", async () => {
    const res = await withConnectLink("facebook_page", handlerAnswering("/settings?choose=pending-1"))(
      stateRequest(linkState(), cookieFor()),
    );

    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?choose=pending-1`);
    expect(h.pendingUpdateMany).toHaveBeenCalledWith({
      where: { id: "pending-1", workspaceId: WORKSPACE, userId: CREATOR },
      data: { connectLinkId: "link-1" },
    });
    expect(setCookie(res)).toBe("");
  });

  it("a choice whose row cannot be stamped is a failure, and the cookie is cleared", async () => {
    h.pendingUpdateMany.mockResolvedValue({ count: 0 });
    const res = await withConnectLink("facebook_page", handlerAnswering("/settings?choose=pending-1"))(
      stateRequest(linkState(), cookieFor()),
    );

    expect(location(res).searchParams.get("error")).toBe("facebook_page_connect_failed");
    expect(location(res).searchParams.get("choose")).toBeNull();
    expect(setCookie(res)).toMatch(/^vs_connect=;/);
  });

  it("a redirect to /login becomes the visitor's page with a generic error", async () => {
    const res = await withConnectLink("tiktok", handlerAnswering("/login?callbackUrl=%2Fsettings"))(
      stateRequest(linkState(), cookieFor()),
    );

    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=tiktok_connect_failed`);
  });

  it("a response that is not a redirect is passed through", async () => {
    const answer = new Response("ok", { status: 200 });
    const res = await withConnectLink("tiktok", vi.fn(async () => answer))(stateRequest(linkState(), cookieFor()));
    expect(res).toBe(answer);
  });

  it("LinkedIn's state is read before the first dot", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "k");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "s");
    vi.stubEnv("LINKEDIN_REDIRECT_URI", "r");
    h.linkFind.mockResolvedValue(linkRow({ platforms: ["linkedin"] }));
    const handler = handlerAnswering("/settings?success=linkedin_connected");

    await withConnectLink("linkedin", handler)(stateRequest(`${linkState()}.YWNtZQ`, cookieFor()));

    expect(handler.mock.calls[0][1]).not.toBeNull();
  });

  it("a database failure while checking the link is a generic error on the visitor's page", async () => {
    h.linkFind.mockRejectedValue(new Error("db down"));
    const handler = handlerAnswering("/settings?success=tiktok_connected");

    const res = await withConnectLink("tiktok", handler)(stateRequest(linkState(), cookieFor()));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=tiktok_connect_failed`);
  });
});

describe("withConnectLink: X", () => {
  const linkHandshake = (overrides: Record<string, unknown> = {}) => ({
    token: "req-token",
    userId: CREATOR,
    workspaceId: WORKSPACE,
    connectLinkId: "link-1",
    connectLinkNonce: "nonce-1",
    ...overrides,
  });

  it("without the cookie: no query at all, the callback runs with null", async () => {
    const handler = handlerAnswering("/settings?success=x_connected");
    const request = xRequest();

    await withConnectLink("x", handler)(request);

    expect(handler).toHaveBeenCalledWith(request, null);
    expect(h.handshakeFind).not.toHaveBeenCalled();
  });

  it("with a cookie but an ordinary handshake row: the callback runs with null", async () => {
    h.handshakeFind.mockResolvedValue(linkHandshake({ connectLinkId: null, connectLinkNonce: null }));
    const answer = NextResponse.redirect(new URL("/settings?success=x_connected", ORIGIN));
    const handler = vi.fn(async () => answer);

    const res = await withConnectLink("x", handler)(xRequest(cookieFor()));

    expect(res).toBe(answer);
    expect(handler.mock.calls[0][1]).toBeNull();
    expect(h.handshakeFind).toHaveBeenCalledWith({ where: { token: "req-token" } });
  });

  it("the lookup failing falls back to the callback with null", async () => {
    h.handshakeFind.mockRejectedValue(new Error("db down"));
    const handler = handlerAnswering("/settings?error=x_connect_failed");

    await withConnectLink("x", handler)(xRequest(cookieFor()));

    expect(handler.mock.calls[0][1]).toBeNull();
  });

  it("a link handshake with the matching cookie runs the callback with the link", async () => {
    h.handshakeFind.mockResolvedValue(linkHandshake());
    const handler = handlerAnswering("/settings?success=x_connected");

    const res = await withConnectLink("x", handler)(xRequest(cookieFor()));

    expect(handler.mock.calls[0][1]).toMatchObject({ id: "link-1", nonce: "nonce-1", userId: CREATOR });
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?success=x_connected`);
  });

  it.each([
    ["a cookie for another link", cookieFor("link-2")],
    ["a wrong nonce", cookieFor("link-1", "nonce-other")],
  ])("%s: refused, callback not called", async (_name, cookie) => {
    h.handshakeFind.mockResolvedValue(linkHandshake());
    const handler = handlerAnswering("/settings?success=x_connected");

    const res = await withConnectLink("x", handler)(xRequest(cookie));

    expect(handler).not.toHaveBeenCalled();
    expect(location(res).pathname).toBe("/c");
  });

  it("X's denial in a link flow lands on the visitor's page", async () => {
    h.handshakeFind.mockResolvedValue(linkHandshake());
    const handler = handlerAnswering("/settings?error=x_auth_denied");

    const res = await withConnectLink("x", handler)(
      new Request(`${ORIGIN}/api/auth/x/callback?denied=req-token`, { headers: { cookie: cookieFor() } }),
    );

    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=x_auth_denied`);
  });
});

describe("connectLinkWrappedPlatform", () => {
  it("names the platform of a wrapped handler and nothing for any other function", () => {
    const GET = withConnectLink("pinterest", handlerAnswering("/settings"));
    expect(connectLinkWrappedPlatform(GET)).toBe("pinterest");
    expect(connectLinkWrappedPlatform(async () => new Response())).toBeNull();
  });
});
