import { describe, expect, it, vi } from "vitest";

import { accountUndoWindowUntil, addressHeldUntil, clearPassedUndoWindows } from "./undoWindow";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const NOW = new Date("2026-11-14T12:00:00.000Z");
const UNTIL = new Date("2026-11-17T12:00:00.000Z");

function db(found: unknown = null) {
  const findFirst = vi.fn().mockResolvedValue(found);
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  return { emailChangeRequest: { findFirst, updateMany }, findFirst, updateMany };
}

// R6-security M1: while a change can be undone, the account can't change its
// email again and no other account can take the address the undo puts back.
describe("accountUndoWindowUntil", () => {
  it("reads the account's change that can still be undone", async () => {
    const fake = db({ undoExpiresAt: UNTIL });
    await expect(accountUndoWindowUntil(fake, "user-1", NOW)).resolves.toEqual(UNTIL);
    expect(fake.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", usedAt: { not: null }, undoneAt: null, undoExpiresAt: { gt: NOW } },
      orderBy: { undoExpiresAt: "desc" },
      select: { undoExpiresAt: true },
    });
  });

  it("is null when no change can be undone", async () => {
    await expect(accountUndoWindowUntil(db(), "user-1", NOW)).resolves.toBeNull();
  });
});

describe("addressHeldUntil", () => {
  it("finds an open undo window that would put this address back", async () => {
    const fake = db({ undoExpiresAt: UNTIL });
    await expect(addressHeldUntil(fake, "old@example.com", NOW)).resolves.toEqual(UNTIL);
    expect(fake.findFirst).toHaveBeenCalledWith({
      where: { previousEmail: "old@example.com", undoneAt: null, undoExpiresAt: { gt: NOW } },
      orderBy: { undoExpiresAt: "desc" },
      select: { undoExpiresAt: true },
    });
  });

  it("is null when no open window holds it", async () => {
    await expect(addressHeldUntil(db(), "old@example.com", NOW)).resolves.toBeNull();
  });
});

// R6-pages L6: the previous address is kept only while it can undo.
describe("clearPassedUndoWindows", () => {
  it("clears the previous address and the undo link of every window that has passed", async () => {
    const fake = db();
    await clearPassedUndoWindows(fake, NOW);
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: {
        undoExpiresAt: { lte: NOW },
        OR: [{ previousEmail: { not: null } }, { undoTokenHash: { not: null } }],
      },
      data: { previousEmail: null, undoTokenHash: null },
    });
  });

  it("never throws: the clean-up is lazy and must not fail the request it rides on", async () => {
    const fake = db();
    fake.updateMany.mockRejectedValue(new Error("db down"));
    await expect(clearPassedUndoWindows(fake, NOW)).resolves.toBeUndefined();
  });
});
