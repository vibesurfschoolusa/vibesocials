import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// X (OAuth 1.0a) has no app-controlled `state`: the user who started the flow
// is carried by the server-side OAuthHandshake row keyed by oauth_token.
// `fetch` is stubbed globally: no test ever reaches api.twitter.com.
const {
  getCurrentUserMock,
  isWorkspaceOwnerMock,
  handshakeFindUniqueMock,
  handshakeDeleteMock,
  upsertMock,
  fetchMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  isWorkspaceOwnerMock: vi.fn(),
  handshakeFindUniqueMock: vi.fn(),
  handshakeDeleteMock: vi.fn(),
  upsertMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("@/lib/workspace", () => ({
  isWorkspaceOwner: isWorkspaceOwnerMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthHandshake: {
      findUnique: handshakeFindUniqueMock,
      delete: handshakeDeleteMock,
    },
    socialConnection: { upsert: upsertMock },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "./route";

const ORIGIN = "https://app.example.com";
const STARTER = "user-attacker";
const WORKSPACE = "ws-attacker";

function handshakeRow(overrides: Record<string, unknown> = {}) {
  return {
    token: "req-token",
    tokenSecret: "req-token-secret",
    userId: STARTER,
    workspaceId: WORKSPACE,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

function callbackRequest(): Request {
  return new Request(
    `${ORIGIN}/api/auth/x/callback?oauth_token=req-token&oauth_verifier=the-verifier`,
  );
}

function location(res: Response): URL {
  const raw = res.headers.get("location");
  expect(raw).toBeTruthy();
  return new URL(raw as string);
}

function accessTokenResponse(): Response {
  return new Response(
    "oauth_token=access-token&oauth_token_secret=access-secret&screen_name=brand&user_id=42",
    { status: 200 },
  );
}

beforeEach(() => {
  for (const m of [
    getCurrentUserMock,
    isWorkspaceOwnerMock,
    handshakeFindUniqueMock,
    handshakeDeleteMock,
    upsertMock,
    fetchMock,
  ]) {
    m.mockReset();
  }
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  vi.stubEnv("X_CONSUMER_KEY", "ck");
  vi.stubEnv("X_CONSUMER_SECRET", "cs");
  vi.stubGlobal("fetch", fetchMock);
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }

  handshakeFindUniqueMock.mockResolvedValue(handshakeRow());
  handshakeDeleteMock.mockResolvedValue({});
  isWorkspaceOwnerMock.mockResolvedValue(true);
  upsertMock.mockResolvedValue({ id: "conn-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("X OAuth callback: session binding", () => {
  it("when the signed-in user is not the handshake's user, redirects with oauth_session_mismatch and never exchanges the verifier or writes", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-victim" });

    const res = await GET(callbackRequest());

    const loc = location(res);
    expect(loc.origin).toBe(ORIGIN);
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("error")).toBe("oauth_session_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(handshakeDeleteMock).not.toHaveBeenCalled();
    expect(isWorkspaceOwnerMock).not.toHaveBeenCalled();
  });

  it("with no session, redirects to /login?callbackUrl=%2Fsettings and writes nothing", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await GET(callbackRequest());

    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?callbackUrl=%2Fsettings`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(handshakeDeleteMock).not.toHaveBeenCalled();
  });

  it("when the signed-in user started the flow, connects the handshake's workspace (session checked before the exchange)", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STARTER });
    fetchMock.mockResolvedValue(accessTokenResponse());

    const res = await GET(callbackRequest());

    expect(location(res).searchParams.get("success")).toBe("x_connected");
    expect(getCurrentUserMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const args = upsertMock.mock.calls[0][0] as {
      where: { workspaceId_platform: { workspaceId: string } };
      create: { userId: string; workspaceId: string };
    };
    expect(args.where.workspaceId_platform.workspaceId).toBe(WORKSPACE);
    expect(args.create.userId).toBe(STARTER);
    // One-time handshake consumed.
    expect(handshakeDeleteMock).toHaveBeenCalledWith({ where: { token: "req-token" } });
  });

  it("keeps the owner re-check after the session check", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STARTER });
    isWorkspaceOwnerMock.mockResolvedValue(false);

    const res = await GET(callbackRequest());

    expect(location(res).searchParams.get("error")).toBe("x_not_workspace_owner");
    expect(isWorkspaceOwnerMock).toHaveBeenCalledWith(STARTER, WORKSPACE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("an expired handshake is still x_session_expired, before any session lookup", async () => {
    handshakeFindUniqueMock.mockResolvedValue(handshakeRow({ expiresAt: new Date(Date.now() - 1000) }));

    const res = await GET(callbackRequest());

    expect(location(res).searchParams.get("error")).toBe("x_session_expired");
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("X OAuth callback: unexpected errors redirect to x_connect_failed instead of a 500", () => {
  it("handshake lookup failure", async () => {
    handshakeFindUniqueMock.mockRejectedValue(new Error("db down"));

    const res = await GET(callbackRequest());

    expect(res.status).toBe(307);
    expect(location(res).searchParams.get("error")).toBe("x_connect_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("session lookup failure", async () => {
    getCurrentUserMock.mockRejectedValue(new Error("db down"));

    const res = await GET(callbackRequest());

    expect(location(res).searchParams.get("error")).toBe("x_connect_failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("owner re-check failure", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STARTER });
    isWorkspaceOwnerMock.mockRejectedValue(new Error("db down"));

    const res = await GET(callbackRequest());

    expect(location(res).searchParams.get("error")).toBe("x_connect_failed");
  });

  it("network failure on the access-token exchange", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STARTER });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const res = await GET(callbackRequest());

    expect(location(res).searchParams.get("error")).toBe("x_connect_failed");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("DB failure writing the connection", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STARTER });
    fetchMock.mockResolvedValue(accessTokenResponse());
    upsertMock.mockRejectedValue(new Error("db down"));

    const res = await GET(callbackRequest());

    expect(location(res).searchParams.get("error")).toBe("x_connect_failed");
  });
});
