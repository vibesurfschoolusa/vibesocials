import crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  findFirstMock,
  updateManyMock,
  createMock,
  transactionMock,
  executeRawMock,
  requireOwnerContextMock,
  checkRateLimitMock,
  generateInviteTokenMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  createMock: vi.fn(),
  transactionMock: vi.fn(),
  executeRawMock: vi.fn(),
  requireOwnerContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  generateInviteTokenMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceUploadLink: { findFirst: findFirstMock, updateMany: updateManyMock, create: createMock },
    $transaction: transactionMock,
  },
}));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: requireOwnerContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/inviteToken", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inviteToken")>("@/lib/inviteToken");
  return { ...actual, generateInviteToken: generateInviteTokenMock };
});

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/inviteToken";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";
import {
  INVALID_WORKSPACE_ID_CODE,
  INVALID_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";

import { DELETE, GET, POST } from "./route";

const RAW = "R".repeat(43);
const OWNER_CONTEXT = {
  user: { id: "user-1" },
  workspace: { id: "ws-1", name: "Surf Co" },
  role: "owner" as const,
};
const forbidden = () =>
  NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 });

const URL_BASE = "http://localhost/api/workspaces/upload-link";

/** GET as the Media page sends it: the page's workspace id in the query (omit with null). */
function getRequest(workspaceId: string | null = "ws-1"): Request {
  return new Request(workspaceId === null ? URL_BASE : `${URL_BASE}?workspaceId=${encodeURIComponent(workspaceId)}`);
}

/** POST / DELETE as the Media page sends them: `{ workspaceId }` in a JSON body. */
function bodyRequest(method: "POST" | "DELETE", body: unknown = { workspaceId: "ws-1" }): Request {
  return new Request(URL_BASE, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    tokenHash: hashInviteToken(RAW),
    tokenSealed: sealSecret(RAW),
    createdById: "user-1",
    createdAt: new Date("2026-11-10T10:00:00Z"),
    revokedAt: null,
    lastUsedAt: new Date("2026-11-10T12:00:00Z"),
    uploadCount: 7,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of [
    findFirstMock,
    updateManyMock,
    createMock,
    transactionMock,
    executeRawMock,
    requireOwnerContextMock,
    checkRateLimitMock,
    generateInviteTokenMock,
  ]) {
    mock.mockReset();
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  generateInviteTokenMock.mockReturnValue({ raw: RAW, hash: hashInviteToken(RAW) });
  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: executeRawMock,
      workspaceUploadLink: { updateMany: updateManyMock, create: createMock },
    }),
  );
  createMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    linkRow({ ...data, lastUsedAt: null, uploadCount: 0 }),
  );
  process.env.NEXTAUTH_URL = "https://app.example";
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
});

afterEach(() => {
  delete process.env.NEXTAUTH_URL;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("owner only", () => {
  it("passes a member's 403 through on every method, touching nothing", async () => {
    requireOwnerContextMock.mockResolvedValue(forbidden());

    for (const response of [
      await GET(getRequest()),
      await POST(bodyRequest("POST")),
      await DELETE(bodyRequest("DELETE")),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("passes a signed-out 401 through", async () => {
    requireOwnerContextMock.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    expect((await GET(getRequest())).status).toBe(401);
  });
});

describe("GET /api/workspaces/upload-link", () => {
  it("says there is no link", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ link: null });
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", revokedAt: null } }),
    );
  });

  it("gives the owner the address again, opened from the sealed token, and the counts", async () => {
    findFirstMock.mockResolvedValue(linkRow());

    const body = await (await GET(getRequest())).json();

    expect(body).toEqual({
      link: {
        url: `https://app.example/u/${RAW}`,
        uploadCount: 7,
        lastUsedAt: "2026-11-10T12:00:00.000Z",
        createdAt: "2026-11-10T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain("enc:v1:");
  });

  it("gives no address when the sealed token cannot be opened", async () => {
    findFirstMock.mockResolvedValue(linkRow({ tokenSealed: "enc:v1:broken" }));

    const body = await (await GET(getRequest())).json();

    expect(body.link.url).toBeNull();
    expect(body.link.uploadCount).toBe(7);
  });
});

describe("POST /api/workspaces/upload-link", () => {
  it("revokes the old link and creates the new one in one locked transaction", async () => {
    const response = await POST(bodyRequest("POST"));

    expect(response.status).toBe(200);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const lockSql = (executeRawMock.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(executeRawMock.mock.calls[0][1]).toBe("ws-upload-link:ws-1");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    // The lock is taken, then the old link revoked, then the new one made.
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateManyMock.mock.invocationCallOrder[0],
    );
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      createMock.mock.invocationCallOrder[0],
    );
    const data = createMock.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "ws-1", tokenHash: hashInviteToken(RAW), createdById: "user-1" });

    await expect(response.json()).resolves.toEqual({
      link: {
        url: `https://app.example/u/${RAW}`,
        uploadCount: 0,
        lastUsedAt: null,
        createdAt: "2026-11-10T10:00:00.000Z",
      },
    });
  });

  it("stores the raw token sealed, and the seal opens back to it", async () => {
    await POST(bodyRequest("POST"));

    const { tokenSealed } = createMock.mock.calls[0][0].data as { tokenSealed: string };
    expect(tokenSealed).not.toContain(RAW);
    expect(tokenSealed.startsWith("enc:v1:")).toBe(true);
    expect(openSecret(tokenSealed)).toBe(RAW);
  });

  it("is limited to 10 an hour per user", async () => {
    await POST(bodyRequest("POST"));
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", limit: 10, windowMs: 60 * 60 * 1000 }),
    );

    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    const response = await POST(bodyRequest("POST"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when the transaction fails", async () => {
    transactionMock.mockRejectedValue(new Error("db down"));
    expect((await POST(bodyRequest("POST"))).status).toBe(500);
  });
});

describe("DELETE /api/workspaces/upload-link", () => {
  it("revokes the workspace's active link", async () => {
    const response = await DELETE(bodyRequest("DELETE"));

    expect(response.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe("the page's workspace (another tab may have switched it)", () => {
  it("answers 409 with the library's sentence on every method when it is not the active one", async () => {
    for (const response of [
      await GET(getRequest("ws-other")),
      await POST(bodyRequest("POST", { workspaceId: "ws-other" })),
      await DELETE(bodyRequest("DELETE", { workspaceId: "ws-other" })),
    ]) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: WORKSPACE_CHANGED_SAVE_MESSAGE,
        code: WORKSPACE_CHANGED_CODE,
      });
    }
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("answers 400 when the id is not a string", async () => {
    for (const response of [
      await POST(bodyRequest("POST", { workspaceId: 5 })),
      await DELETE(bodyRequest("DELETE", { workspaceId: null })),
    ]) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: INVALID_WORKSPACE_ID_MESSAGE,
        code: INVALID_WORKSPACE_ID_CODE,
      });
    }
    expect(transactionMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  // F3 (2026-11-14 review): a change needs the id; only reading works without it.
  it("reads as before when the id is absent", async () => {
    findFirstMock.mockResolvedValue(null);
    expect((await GET(getRequest(null))).status).toBe(200);
  });

  it("refuses a change without the id (a page from before it was sent), and writes nothing", async () => {
    for (const response of [await POST(bodyRequest("POST", {})), await DELETE(bodyRequest("DELETE", {}))]) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "MISSING_WORKSPACE_ID" });
    }
    expect(transactionMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("checks the owner first: a member gets 403, not 409", async () => {
    requireOwnerContextMock.mockResolvedValue(forbidden());
    expect((await DELETE(bodyRequest("DELETE", { workspaceId: "ws-other" }))).status).toBe(403);
  });
});

// GG2 review: the panel hides Create while the workspace is blocked, and the
// server refuses too, so a hand-sent request can't make a link that answers
// "not active" until the block ends.
describe("POST while the workspace is blocked", () => {
  it("a paused workspace gets a 403 with the panel's sentence and no link is made", async () => {
    requireOwnerContextMock.mockResolvedValue({
      ...OWNER_CONTEXT,
      workspace: { ...OWNER_CONTEXT.workspace, pausedAt: new Date("2026-11-10T00:00:00Z"), pausedReason: null },
    });
    const response = await POST(bodyRequest("POST"));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/^Client links don't work right now\./);
    expect(createMock).not.toHaveBeenCalled();
  });
});

// R44 new-customer L1: the limit is a fixed hour counted across every workspace
// the person owns, so the refusal names the real wait, not "Try again later".
describe("the hourly limit names its wait", () => {
  it("at 40 minutes left: the reason, the wait in minutes, and Retry-After", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 40 * 60 });
    const response = await POST(bodyRequest("POST"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2400");
    await expect(response.json()).resolves.toEqual({
      error: "You've made 10 new upload links this hour, counted across all your workspaces. Too many tries. Wait 40 minutes, then try again.",
      retryAfterSeconds: 2400,
    });
  });
});
