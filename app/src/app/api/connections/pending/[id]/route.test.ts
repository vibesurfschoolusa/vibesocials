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
  connectionFindUniqueMock,
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
  connectionFindUniqueMock: vi.fn(),
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
    socialConnection: { findUnique: connectionFindUniqueMock },
  },
}));

vi.mock("@/server/connections/saveConnection", async (importOriginal) => ({
  // The real key rule: whether the connected account was on the list.
  connectionAccountKey: (await importOriginal<typeof import("@/server/connections/saveConnection")>()).connectionAccountKey,
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

/** The Settings dialog sends the workspace its page was rendered for (F3). */
function postReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/connections/pending/pending-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "ws-1", ...body }),
  });
}

const getReq = () => new Request("http://localhost/api/connections/pending/pending-1");
const deleteReq = (body: unknown = { workspaceId: "ws-1" }) =>
  new Request("http://localhost/api/connections/pending/pending-1", {
    method: "DELETE",
    ...(body === null ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

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
  // The shared save answers whether it saved (R6 review low 1).
  saveFacebookPageConnectionMock.mockResolvedValue({ ok: true });
  saveInstagramConnectionMock.mockResolvedValue({ ok: true });
  saveLinkedInConnectionMock.mockResolvedValue({ ok: true });
  savePinterestConnectionMock.mockResolvedValue({ ok: true });
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

  // R6 review low 1: a reconnect only ever replaces the same account.
  it("409s with both names when the chosen account is not the one connected, keeping the choice and the connection", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK));
    // The connected Page is not on this list.
    connectionFindUniqueMock.mockResolvedValue({ platform: "facebook_page", accountIdentifier: "page-9", metadata: {} });
    saveFacebookPageConnectionMock.mockResolvedValue({
      ok: false,
      reason: "different_account",
      connectedName: "My Surf School",
      signedInName: "Client Cafe",
    });

    const response = await POST(postReq({ candidateId: "page-2" }), ctx());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        // R8-pages L1: a Facebook Page is managed, not signed in to.
        "You chose Client Cafe, not My Surf School, and My Surf School wasn't in the list. Sign in with a Facebook account that manages My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
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

// F3 (2026-11-14 review): choosing or cancelling in a tab rendered for another
// workspace is refused with the reload sentence, before the pending connect
// is read.
describe("pending/[id] and the rendered workspace", () => {
  it("POST 409s another workspace's id, and connects nothing", async () => {
    findUniqueMock.mockResolvedValue(row(LINKEDIN));

    const response = await POST(postReq({ candidateId: "222", workspaceId: "ws-2" }), ctx());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it("POST 400s a body without the id, and connects nothing", async () => {
    const response = await POST(
      new Request("http://localhost/api/connections/pending/pending-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId: "222" }),
      }),
      ctx(),
    );

    expect(response.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expectNothingSaved();
  });

  it.each([
    ["another workspace's id", { workspaceId: "ws-2" }, 409],
    ["no body", null, 400],
  ])("DELETE refuses %s, and cancels nothing", async (_label, body, status) => {
    findUniqueMock.mockResolvedValue(row(LINKEDIN));

    const response = await DELETE(deleteReq(body), ctx());

    expect(response.status).toBe(status);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});

// R7 review 3: the list included the connected account, so the way forward is to choose it.
describe("POST: a refused choice, by whether the connected one was on the list", () => {
  beforeEach(() => {
    requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
    checkRateLimitMock.mockResolvedValue({ allowed: true });
  });

  it("the list contains the connected Page: choose it", async () => {
    findUniqueMock.mockResolvedValue(row(FACEBOOK));
    connectionFindUniqueMock.mockResolvedValue({ platform: "facebook_page", accountIdentifier: "page-1", metadata: {} });
    saveFacebookPageConnectionMock.mockResolvedValue({
      ok: false,
      reason: "different_account",
      connectedName: "My Surf School",
      signedInName: "Client Cafe",
    });

    const response = await POST(postReq({ candidateId: "page-2" }), ctx());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "You chose Client Cafe, not My Surf School. Choose My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    });
    expect(connectionFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "facebook_page" } },
      select: { platform: true, accountIdentifier: true, metadata: true },
    });
  });

  it("LinkedIn, the connected page not on the list (another member signed in): the sign-out step", async () => {
    findUniqueMock.mockResolvedValue(row(LINKEDIN));
    connectionFindUniqueMock.mockResolvedValue({
      platform: "linkedin",
      accountIdentifier: "member-9",
      metadata: { organizations: [{ id: "999", name: "Old Page" }] },
    });
    saveLinkedInConnectionMock.mockResolvedValue({
      ok: false,
      reason: "different_account",
      connectedName: "Old Page",
      signedInName: "Client Cafe",
    });

    const response = await POST(postReq({ candidateId: "222" }), ctx());

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      // R8-client-journey L2: a LinkedIn page is managed, not signed in to.
      "LinkedIn connected a different page than Old Page, so nothing changed. Sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that manages Old Page. To use the other page instead, use Switch account.",
    );
  });

  it("LinkedIn, the connected page on the list: choose it", async () => {
    findUniqueMock.mockResolvedValue(row(LINKEDIN));
    connectionFindUniqueMock.mockResolvedValue({
      platform: "linkedin",
      accountIdentifier: "member-1",
      metadata: { organizations: [{ id: "111", name: "My Surf School" }] },
    });
    saveLinkedInConnectionMock.mockResolvedValue({
      ok: false,
      reason: "different_account",
      connectedName: "My Surf School",
      signedInName: "Client Cafe",
    });

    const response = await POST(postReq({ candidateId: "222" }), ctx());

    expect((await response.json()).error).toBe(
      "You chose Client Cafe, not My Surf School. Choose My Surf School to reconnect it, or use Switch account to change to Client Cafe.",
    );
  });
});

// R7 review 4: a LinkedIn choice whose sign-in still ends within a week says so in Settings.
describe("POST: the same-end flag on a LinkedIn choice", () => {
  const DAY = 24 * 60 * 60 * 1000;
  function linkedInEnding(inDays: number): PendingConnectionPayload {
    const payload = LINKEDIN as unknown as { token: Record<string, unknown> };
    return {
      ...payload,
      token: { ...payload.token, refreshToken: null, expiresAt: new Date(Date.now() + inDays * DAY).toISOString() },
    } as unknown as PendingConnectionPayload;
  }

  beforeEach(() => {
    requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    saveLinkedInConnectionMock.mockResolvedValue({ ok: true });
    deleteManyMock.mockResolvedValue({ count: 1 });
  });

  it("renewed (60 days): the usual answer", async () => {
    findUniqueMock.mockResolvedValue(row(linkedInEnding(60)));
    const response = await POST(postReq({ candidateId: "111" }), ctx());
    await expect(response.json()).resolves.toEqual({ ok: true, platform: "linkedin" });
  });

  it("same end (3 days): sameEnd, for the success address", async () => {
    findUniqueMock.mockResolvedValue(row(linkedInEnding(3)));
    const response = await POST(postReq({ candidateId: "111" }), ctx());
    await expect(response.json()).resolves.toEqual({ ok: true, platform: "linkedin", sameEnd: true });
  });
});

// R29 lead follow-up (as /c, client-journey L3): a gone choice said "This
// choice expired. Connect again." even when the account was already chosen
// and the Settings row showed it connected, with no Connect button. The
// dialog passes `?platform=` once known; the answer follows the row Settings
// shows for it (shownControl), and without it names no button.
describe("pending/[id]: a choice that is gone", () => {
  const hinted = (method: string, platform: string) =>
    new Request(`http://localhost/api/connections/pending/pending-1?platform=${platform}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({ workspaceId: "ws-1", candidateId: "page-2" }),
    });
  const working = { platform: "facebook_page", needsReconnect: false, expiresAt: null, refreshToken: null };

  beforeEach(() => {
    findUniqueMock.mockResolvedValue(null);
    connectionFindUniqueMock.mockReset();
  });

  it("connected: says the choice was already used and the platform is connected, on GET and POST", async () => {
    connectionFindUniqueMock.mockResolvedValue(working);
    for (const response of [await GET(hinted("GET", "facebook_page"), ctx()), await POST(hinted("POST", "facebook_page"), ctx())]) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "This choice was already used: Facebook Page is connected.",
        connected: true,
      });
    }
    expect(connectionFindUniqueMock.mock.calls[0][0].where).toEqual({
      workspaceId_platform: { workspaceId: "ws-1", platform: "facebook_page" },
    });
    expectNothingSaved();
  });

  it("flagged, or about to end: names Reconnect, the button its row shows", async () => {
    connectionFindUniqueMock.mockResolvedValue({ ...working, needsReconnect: true });
    const flagged = await GET(hinted("GET", "facebook_page"), ctx());
    await expect(flagged.json()).resolves.toEqual({
      error: "This choice has ended: it expired, or an account was already chosen. To choose again, press Reconnect on Facebook Page.",
    });
    // LinkedIn's sign-in can't be renewed: inside its warning window the row shows Reconnect.
    connectionFindUniqueMock.mockResolvedValue({
      platform: "linkedin",
      needsReconnect: false,
      refreshToken: null,
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    });
    const soon = await GET(hinted("GET", "linkedin"), ctx());
    expect((await soon.json()).error).toContain("press Reconnect on LinkedIn");
  });

  // R30 (security-billing L1): the hint outlives a reload in another workspace,
  // and this workspace's row says nothing about the choice's own workspace.
  it("a choice started in another workspace: says so, never this workspace's row", async () => {
    findUniqueMock.mockResolvedValue(row(INSTAGRAM, { workspaceId: "ws-other" }));
    connectionFindUniqueMock.mockResolvedValue({ ...working, platform: "instagram" });
    for (const response of [
      await GET(hinted("GET", "instagram"), ctx()),
      await POST(hinted("POST", "instagram"), ctx()),
      await GET(getReq(), ctx()),
    ]) {
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "This choice was started in another workspace. Switch back to it to choose." });
      expect(body.error).not.toMatch(/connected/);
    }
    expectNothingSaved();
  });

  it("another user's choice in another workspace is not named: the row's sentence as before", async () => {
    findUniqueMock.mockResolvedValue(row(INSTAGRAM, { workspaceId: "ws-other", userId: "user-2" }));
    connectionFindUniqueMock.mockResolvedValue(null);
    const response = await GET(hinted("GET", "instagram"), ctx());
    await expect(response.json()).resolves.toEqual({
      error: "This choice expired. To start again, press Connect on Instagram.",
    });
  });

  it("no row: names Connect", async () => {
    connectionFindUniqueMock.mockResolvedValue(null);
    const response = await GET(hinted("GET", "instagram"), ctx());
    await expect(response.json()).resolves.toEqual({
      error: "This choice expired. To start again, press Connect on Instagram.",
    });
  });

  it("no platform named, or one that never ends in a choice: names no button, looks nothing up", async () => {
    for (const request of [getReq(), hinted("GET", "youtube"), hinted("GET", "nonsense")]) {
      const response = await GET(request, ctx());
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({
        error: "This choice has ended: it expired, or an account was already chosen. Close this to see your connections.",
      });
      expect(body.error).not.toMatch(/Connect again/i);
    }
    expect(connectionFindUniqueMock).not.toHaveBeenCalled();
  });

  it("a member still gets the owner gate's 403, with no step", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );
    const response = await GET(hinted("GET", "facebook_page"), ctx());
    expect(response.status).toBe(403);
    expect(connectionFindUniqueMock).not.toHaveBeenCalled();
  });
});
