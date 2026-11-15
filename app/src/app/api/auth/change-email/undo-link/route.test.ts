import bcrypt from "bcryptjs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Review 2 item 3: the account holder can turn off the undo link sent to the
// previous address, for someone moving away from a lost or hacked mailbox.
const { getCurrentUserMock, checkRateLimitMock, findFirstMock, updateManyMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/db", () => ({
  prisma: { emailChangeRequest: { findFirst: findFirstMock, updateMany: updateManyMock } },
}));

import { DELETE, GET } from "./route";

let hash: string;
const UNTIL = new Date("2026-11-21T12:00:00.000Z");

function user(overrides: Record<string, unknown> = {}) {
  return { id: "user-1", email: "new@example.com", passwordHash: hash, ...overrides };
}

function del(body: unknown) {
  return DELETE(
    new Request("http://localhost/api/auth/change-email/undo-link", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  hash = await bcrypt.hash("the-password", 4);
});

beforeEach(() => {
  for (const mock of [getCurrentUserMock, checkRateLimitMock, findFirstMock, updateManyMock]) mock.mockReset();
  getCurrentUserMock.mockResolvedValue(user());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findFirstMock.mockResolvedValue({ undoExpiresAt: UNTIL });
  updateManyMock.mockResolvedValue({ count: 1 });
});

/** The live undo links: this change's (to the current address), not used, not off, not expired. */
function expectLiveWhere(where: Record<string, unknown>) {
  expect(where).toMatchObject({
    userId: "user-1",
    newEmail: "new@example.com",
    usedAt: { not: null },
    undoneAt: null,
    undoTurnedOffAt: null,
  });
  expect((where.undoExpiresAt as { gt: Date }).gt).toBeInstanceOf(Date);
}

describe("GET /api/auth/change-email/undo-link", () => {
  it("answers 401 signed out", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("says until when the previous address can undo the change", async () => {
    const response = await GET();
    await expect(response.json()).resolves.toEqual({ until: UNTIL.toISOString() });
    expectLiveWhere(findFirstMock.mock.calls[0][0].where);
  });

  it("answers null when there is no live undo link", async () => {
    findFirstMock.mockResolvedValue(null);
    await expect((await GET()).json()).resolves.toEqual({ until: null });
  });
});

describe("DELETE /api/auth/change-email/undo-link", () => {
  it("answers 401 signed out", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect((await del({ currentPassword: "the-password" })).status).toBe(401);
  });

  it("is rate limited per person and fails closed", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await del({ currentPassword: "the-password" })).status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", route: "auth/change-email-undo-off", failClosed: true }),
    );
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("needs the current password", async () => {
    const response = await del({ currentPassword: "wrong" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Your current password is not correct." });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("refuses an account without a password", async () => {
    getCurrentUserMock.mockResolvedValue(user({ passwordHash: null }));
    expect((await del({ currentPassword: "x" })).status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("turns the live undo links off", async () => {
    const response = await del({ currentPassword: "the-password" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const args = updateManyMock.mock.calls[0][0];
    expectLiveWhere(args.where);
    expect(args.data.undoTurnedOffAt).toBeInstanceOf(Date);
  });

  it("says so when there was nothing to turn off", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    const response = await del({ currentPassword: "the-password" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "There is no undo link to turn off: it was already used, turned off or has expired.",
    });
  });

  it("answers 400 Invalid JSON body for a body that isn't an object", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/auth/change-email/undo-link", { method: "DELETE", body: "[1]" }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });
});
