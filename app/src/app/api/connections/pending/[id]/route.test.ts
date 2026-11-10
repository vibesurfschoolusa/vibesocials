import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /api/connections/pending/[id] — choosing which account a Facebook,
// Instagram or LinkedIn connect saves (2026-11-09). The access checks and the
// payload handling (server/connections/pendingConnection.ts, sealed with the
// real lib/tokenCrypto.ts) run for real against a mocked Prisma; the shared
// save functions are mocked so each test sees exactly what would be saved.
const {
  requireOwnerContextMock,
  checkRateLimitMock,
  findUniqueMock,
  deleteManyMock,
  saveFacebookPageConnectionMock,
  saveInstagramConnectionMock,
  saveLinkedInConnectionMock,
  savePinterestConnectionMock,
  fetchInstagramAccountDetailsMock,
} = vi.hoisted(() => ({
  requireOwnerContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findUniqueMock: vi.fn(),
  deleteManyMock: vi.fn(),
  saveFacebookPageConnectionMock: vi.fn(),
  saveInstagramConnectionMock: vi.fn(),
  saveLinkedInConnectionMock: vi.fn(),
  savePinterestConnectionMock: vi.fn(),
  fetchInstagramAccountDetailsMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: requireOwnerContextMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    pendingConnection: {
      findUnique: findUniqueMock,
      deleteMany: deleteManyMock,
    },
  },
}));

vi.mock("@/server/connections/saveConnection", () => ({
  saveFacebookPageConnection: saveFacebookPageConnectionMock,
  saveInstagramConnection: saveInstagramConnectionMock,
  saveLinkedInConnection: saveLinkedInConnectionMock,
  savePinterestConnection: savePinterestConnectionMock,
  fetchInstagramAccountDetails: fetchInstagramAccountDetailsMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sealSecret } from "@/lib/tokenCrypto";
import type { PendingConnectionPayload } from "@/server/connections/pendingConnection";
import { DELETE, GET, POST } from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
};

const PENDING_ID = "pending-1";
const TOKEN_EXPIRY = "2027-01-08T12:00:00.000Z";

const FACEBOOK: PendingConnectionPayload = {
  platform: "facebook_page",
  expiresAt: TOKEN_EXPIRY,
  pages: [
    { id: "page-1", name: "My Surf School", accessToken: "page-token-1" },
    { id: "page-2", name: "Client Cafe", accessToken: "page-token-2" },
  ],
};

const INSTAGRAM: PendingConnectionPayload = {
  platform: "instagram",
  expiresAt: TOKEN_EXPIRY,
  accounts: [
    {
      igAccountId: "ig-1",
      pageId: "page-1",
      pageName: "My Surf School",
      pageAccessToken: "page-token-1",
      username: "mysurfschool",
    },
    {
      igAccountId: "ig-2",
      pageId: "page-2",
      pageName: "Client Cafe",
      pageAccessToken: "page-token-2",
      username: null,
    },
  ],
};

// LinkedIn's organization ids arrive as numbers.
const LINKEDIN = {
  platform: "linkedin",
  token: {
    accessToken: "li-access",
    refreshToken: "li-refresh",
    expiresAt: TOKEN_EXPIRY,
    scope: "w_organization_social",
  },
  profile: { sub: "member-1", name: "A B", email: null, picture: null },
  organizations: [
    { id: 111, name: "My Surf School", vanityName: "my-surf-school" },
    { id: 222, name: "Client Cafe" },
  ],
} as unknown as PendingConnectionPayload;

// Pinterest (2026-11-10): the choice is the board the Pins go on.
const PINTEREST: PendingConnectionPayload = {
  platform: "pinterest",
  token: {
    accessToken: "pin-access",
    refreshToken: "pin-refresh",
    expiresAt: TOKEN_EXPIRY,
    scopes: ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"],
  },
  account: { id: "9001", username: "mysurfschool", accountType: "BUSINESS" },
  boards: [
    { id: "555", name: "Surf lessons", privacy: "PUBLIC" },
    { id: "666", name: "Team photos", privacy: "SECRET" },
  ],
};

const TOKENS = ["page-token-1", "page-token-2", "li-access", "li-refresh", "pin-access", "pin-refresh"];

function row(
  payload: PendingConnectionPayload,
  overrides: Partial<{ workspaceId: string; userId: string; expiresAt: Date; payload: string }> = {},
) {
  return {
    id: PENDING_ID,
    workspaceId: "ws-1",
    userId: "user-1",
    platform: payload.platform,
    payload: sealSecret(JSON.stringify(payload)),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

function ctx(id = PENDING_ID) {
  return { params: Promise.resolve({ id }) };
}

function postReq(body: unknown) {
  return new Request("http://localhost/api/connections/pending/pending-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const getReq = () => new Request("http://localhost/api/connections/pending/pending-1");
const deleteReq = () =>
  new Request("http://localhost/api/connections/pending/pending-1", { method: "DELETE" });

function expectNothingSaved() {
  expect(saveFacebookPageConnectionMock).not.toHaveBeenCalled();
  expect(saveInstagramConnectionMock).not.toHaveBeenCalled();
  expect(saveLinkedInConnectionMock).not.toHaveBeenCalled();
  expect(savePinterestConnectionMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const m of [
    requireOwnerContextMock,
    checkRateLimitMock,
    findUniqueMock,
    deleteManyMock,
    saveFacebookPageConnectionMock,
    saveInstagramConnectionMock,
    saveLinkedInConnectionMock,
    savePinterestConnectionMock,
    fetchInstagramAccountDetailsMock,
  ]) {
    m.mockReset();
  }

  // Seal for real, so the tests also prove the route opens sealed payloads.
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));

  requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  deleteManyMock.mockResolvedValue({ count: 1 });
  saveFacebookPageConnectionMock.mockResolvedValue(undefined);
  saveInstagramConnectionMock.mockResolvedValue(undefined);
  saveLinkedInConnectionMock.mockResolvedValue(undefined);
  savePinterestConnectionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type Handler = (request: Request, context: ReturnType<typeof ctx>) => Promise<Response>;

const HANDLERS: Array<[string, Handler, () => Request]> = [
  ["GET", GET, getReq],
  ["POST", POST, () => postReq({ candidateId: "page-2" })],
  ["DELETE", DELETE, deleteReq],
];

describe.each(HANDLERS)("%s /api/connections/pending/[id]: access", (_method, handler, request) => {
  it("returns the owner gate's 401 as-is when signed out, touching nothing", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await handler(request(), ctx());

    expect(response.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it("returns the owner gate's 403 as-is for a member, touching nothing", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

    const response = await handler(request(), ctx());

    expect(response.status).toBe(403);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it("404s when there is no such pending connect", async () => {
    findUniqueMock.mockResolvedValue(null);

    const response = await handler(request(), ctx());

    expect(response.status).toBe(404);
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    expect(deleteManyMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it("404s on an expired pending connect, and deletes it", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK, { expiresAt: new Date(Date.now() - 1000) }));

    const response = await handler(request(), ctx());

    expect(response.status).toBe(404);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    expectNothingSaved();
  });

  it("404s on another workspace's pending connect, and leaves it alone", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK, { workspaceId: "ws-other" }));

    const response = await handler(request(), ctx());

    expect(response.status).toBe(404);
    expect(deleteManyMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it("404s on another user's pending connect in the same workspace, and leaves it alone", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK, { userId: "user-2" }));

    const response = await handler(request(), ctx());

    expect(response.status).toBe(404);
    expect(deleteManyMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it("404s on a payload that can't be opened (e.g. the key changed), and deletes it", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK, { payload: "enc:v1:bm90LXJlYWxseS1zZWFsZWQtYXQtYWxs" }));

    const response = await handler(request(), ctx());

    expect(response.status).toBe(404);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    expectNothingSaved();
  });
});

describe("GET /api/connections/pending/[id]", () => {
  it("lists the Facebook Pages by id and name", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK));

    const response = await GET(getReq(), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      platform: "facebook_page",
      candidates: [
        { id: "page-1", name: "My Surf School" },
        { id: "page-2", name: "Client Cafe" },
      ],
    });
  });

  it("lists the Instagram accounts by Page name, with the @username when it is known", async () => {
    findUniqueMock.mockResolvedValue(row(INSTAGRAM));

    const response = await GET(getReq(), ctx());

    await expect(response.json()).resolves.toEqual({
      platform: "instagram",
      candidates: [
        { id: "ig-1", name: "My Surf School", detail: "@mysurfschool" },
        { id: "ig-2", name: "Client Cafe" },
      ],
    });
  });

  it("lists the LinkedIn pages with string ids and their vanity URL when there is one", async () => {
    findUniqueMock.mockResolvedValue(row(LINKEDIN));

    const response = await GET(getReq(), ctx());

    await expect(response.json()).resolves.toEqual({
      platform: "linkedin",
      candidates: [
        { id: "111", name: "My Surf School", detail: "linkedin.com/company/my-surf-school" },
        { id: "222", name: "Client Cafe" },
      ],
    });
  });

  it("lists the Pinterest boards by id and name, marking a secret one", async () => {
    findUniqueMock.mockResolvedValue(row(PINTEREST));

    const response = await GET(getReq(), ctx());

    await expect(response.json()).resolves.toEqual({
      platform: "pinterest",
      candidates: [
        { id: "555", name: "Surf lessons" },
        { id: "666", name: "Team photos", detail: "Secret board" },
      ],
    });
  });

  it.each([
    ["facebook_page", FACEBOOK],
    ["instagram", INSTAGRAM],
    ["linkedin", LINKEDIN],
    ["pinterest", PINTEREST],
  ])("never returns a token (%s)", async (_platform, payload) => {
    findUniqueMock.mockResolvedValue(row(payload));

    const response = await GET(getReq(), ctx());
    const text = await response.text();

    for (const token of TOKENS) {
      expect(text).not.toContain(token);
    }
    expect(text).not.toMatch(/token/i);
  });

  it("does not delete or save anything", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK));

    await GET(getReq(), ctx());

    expect(deleteManyMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });
});

describe("POST /api/connections/pending/[id]", () => {
  it("is rate limited per user (429 + Retry-After), before reading anything", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const response = await POST(postReq({ candidateId: "page-2" }), ctx());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", route: "connections/pending" }),
    );
    expect(findUniqueMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it.each([
    ["missing", {}],
    ["empty", { candidateId: "" }],
    ["not a string", { candidateId: 222 }],
  ])("400s when candidateId is %s", async (_label, body) => {
    const response = await POST(postReq(body), ctx());

    expect(response.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it("400s when candidateId is not one of the choices, keeping the pending connect", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK));

    const response = await POST(postReq({ candidateId: "page-9" }), ctx());

    expect(response.status).toBe(400);
    expectNothingSaved();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("an id from another platform's list is not a choice either", async () => {
    findUniqueMock.mockResolvedValue(row(INSTAGRAM));

    const response = await POST(postReq({ candidateId: "page-2" }), ctx());

    expect(response.status).toBe(400);
    expectNothingSaved();
  });

  it("connects the chosen Facebook Page with its own Page token, then deletes the pending connect", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK));

    const response = await POST(postReq({ candidateId: "page-2" }), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, platform: "facebook_page" });
    expect(saveFacebookPageConnectionMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      page: { id: "page-2", name: "Client Cafe", accessToken: "page-token-2" },
      expiresAt: new Date(TOKEN_EXPIRY),
    });
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    expect(saveFacebookPageConnectionMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteManyMock.mock.invocationCallOrder[0],
    );
  });

  it("connects the chosen Instagram account, reading its details first like the callback does", async () => {
    findUniqueMock.mockResolvedValue(row(INSTAGRAM));
    const details = { username: "clientcafe", profilePicture: "https://cdn.example/pic.jpg" };
    fetchInstagramAccountDetailsMock.mockResolvedValue(details);

    const response = await POST(postReq({ candidateId: "ig-2" }), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, platform: "instagram" });
    expect(fetchInstagramAccountDetailsMock).toHaveBeenCalledWith("ig-2", "page-token-2");
    expect(saveInstagramConnectionMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      igAccountId: "ig-2",
      pageId: "page-2",
      pageAccessToken: "page-token-2",
      details,
      expiresAt: new Date(TOKEN_EXPIRY),
    });
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
  });

  it("502s when Instagram won't describe the chosen account, keeping the pending connect for a retry", async () => {
    findUniqueMock.mockResolvedValue(row(INSTAGRAM));
    fetchInstagramAccountDetailsMock.mockResolvedValue(null);

    const response = await POST(postReq({ candidateId: "ig-2" }), ctx());

    expect(response.status).toBe(502);
    expectNothingSaved();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("connects the chosen LinkedIn page with the member token, matching its numeric id", async () => {
    findUniqueMock.mockResolvedValue(row(LINKEDIN));

    const response = await POST(postReq({ candidateId: "222" }), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, platform: "linkedin" });
    expect(saveLinkedInConnectionMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      token: {
        accessToken: "li-access",
        refreshToken: "li-refresh",
        expiresAt: new Date(TOKEN_EXPIRY),
        scope: "w_organization_social",
      },
      profile: { sub: "member-1", name: "A B", email: null, picture: null },
      organization: { id: 222, name: "Client Cafe" },
    });
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
  });

  it("connects Pinterest to the chosen board, with the account's tokens", async () => {
    findUniqueMock.mockResolvedValue(row(PINTEREST));

    const response = await POST(postReq({ candidateId: "666" }), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, platform: "pinterest" });
    expect(savePinterestConnectionMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      token: {
        accessToken: "pin-access",
        refreshToken: "pin-refresh",
        expiresAt: new Date(TOKEN_EXPIRY),
        scopes: ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"],
      },
      account: { id: "9001", username: "mysurfschool", accountType: "BUSINESS" },
      board: { id: "666", name: "Team photos", privacy: "SECRET" },
    });
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
  });

  it("a board id that is not on the Pinterest list is not a choice", async () => {
    findUniqueMock.mockResolvedValue(row(PINTEREST));

    const response = await POST(postReq({ candidateId: "777" }), ctx());

    expect(response.status).toBe(400);
    expectNothingSaved();
  });

  it("500s without logging the error's message when the save fails, keeping the pending connect", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK));
    saveFacebookPageConnectionMock.mockRejectedValue(new Error("Invalid upsert: accessToken page-token-2"));
    const { logger } = await import("@/lib/logger");

    const response = await POST(postReq({ candidateId: "page-2" }), ctx());

    expect(response.status).toBe(500);
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("page-token-2");
  });
});

describe("DELETE /api/connections/pending/[id]", () => {
  it("cancels the caller's pending connect without saving anything", async () => {
    findUniqueMock.mockResolvedValue(row(LINKEDIN));

    const response = await DELETE(deleteReq(), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    expectNothingSaved();
  });
});
