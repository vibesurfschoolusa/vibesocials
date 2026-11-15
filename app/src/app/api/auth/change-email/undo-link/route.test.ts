import { beforeEach, describe, expect, it, vi } from "vitest";

// Settings, Account says until when the previous address can undo the last
// email change; this is where it reads that date.
const { getCurrentUserMock, findFirstMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/db", () => ({
  prisma: { emailChangeRequest: { findFirst: findFirstMock } },
}));

import { GET } from "./route";

const UNTIL = new Date("2026-11-21T12:00:00.000Z");

beforeEach(() => {
  for (const mock of [getCurrentUserMock, findFirstMock]) mock.mockReset();
  getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "new@example.com" });
  findFirstMock.mockResolvedValue({ undoExpiresAt: UNTIL });
});

/** The live undo links: this change's (to the current address), not used, not expired. */
function expectLiveWhere(where: Record<string, unknown>) {
  expect(where).toMatchObject({
    userId: "user-1",
    newEmail: "new@example.com",
    usedAt: { not: null },
    undoneAt: null,
  });
  expect(where).not.toHaveProperty("undoTurnedOffAt");
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

// Review 3: no way to turn the link off from the account. Whoever changed the
// email knows the password, so such a switch would only help a hijacker.
describe("no turn-off", () => {
  it("the route has no DELETE", async () => {
    const route = await import("./route");
    expect(Object.keys(route)).toEqual(["GET"]);
  });
});
