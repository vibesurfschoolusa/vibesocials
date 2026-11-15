import { describe, expect, it, vi } from "vitest";

import { accountUndoWindowUntil, addressHeldUntil, clearPassedUndoWindows } from "./undoWindow";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const NOW = new Date("2026-11-14T12:00:00.000Z");
const UNTIL = new Date("2026-11-17T12:00:00.000Z");

function db(found: unknown = null) {
  const findFirst = vi.fn().mockResolvedValue(found);
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  return { emailChangeRequest: { findFirst, deleteMany }, findFirst, deleteMany };
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

// R6-pages L6, R7-pages L1 / security L2: a request row is kept only while it
// is needed: an unused link until it expires, a made change until its undo
// window ends. Then the row goes, with every address on it (A -> B -> C
// leaves neither A nor B behind).
describe("clearPassedUndoWindows", () => {
  it("deletes every change whose undo window has passed, and every link past its expiry with no window", async () => {
    const fake = db();
    fake.deleteMany.mockResolvedValue({ count: 4 });
    await expect(clearPassedUndoWindows(fake, NOW)).resolves.toBe(4);
    expect(fake.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ undoExpiresAt: { lte: NOW } }, { undoExpiresAt: null, expiresAt: { lte: NOW } }],
      },
    });
  });

  // The two cases, run against rows: a tiny reading of the where clause above.
  it("leaves no old address after A -> B -> C once both windows pass, and removes an expired unused link", async () => {
    const HOUR = 60 * 60 * 1000;
    const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
    type Row = { id: string; newEmail: string; previousEmail: string | null; expiresAt: Date; undoExpiresAt: Date | null };
    let rows: Row[] = [
      { id: "a-to-b", newEmail: "b@example.com", previousEmail: "a@example.com", expiresAt: at(-100), undoExpiresAt: at(-1) },
      { id: "b-to-c", newEmail: "c@example.com", previousEmail: "b@example.com", expiresAt: at(-30), undoExpiresAt: at(-0.5) },
      { id: "expired-unused", newEmail: "typo@example.com", previousEmail: null, expiresAt: at(-2), undoExpiresAt: null },
      { id: "open-window", newEmail: "e@example.com", previousEmail: "d@example.com", expiresAt: at(-20), undoExpiresAt: at(50) },
      { id: "live-link", newEmail: "f@example.com", previousEmail: null, expiresAt: at(10), undoExpiresAt: null },
    ];
    type Cond = { undoExpiresAt: { lte: Date } | null; expiresAt?: { lte: Date } };
    const matches = (row: Row, cond: Cond) =>
      (cond.undoExpiresAt === null
        ? row.undoExpiresAt === null
        : row.undoExpiresAt !== null && row.undoExpiresAt <= cond.undoExpiresAt.lte) &&
      (!cond.expiresAt || row.expiresAt <= cond.expiresAt.lte);
    const fake = {
      emailChangeRequest: {
        findFirst: vi.fn(),
        deleteMany: vi.fn().mockImplementation(async ({ where }: { where: { OR: Cond[] } }) => {
          const before = rows.length;
          rows = rows.filter((row) => !where.OR.some((cond) => matches(row, cond)));
          return { count: before - rows.length };
        }),
      },
    };
    await expect(clearPassedUndoWindows(fake, NOW)).resolves.toBe(3);
    expect(rows.map((row) => row.id)).toEqual(["open-window", "live-link"]);
    const left = JSON.stringify(rows);
    for (const gone of ["a@example.com", "b@example.com", "c@example.com", "typo@example.com"]) {
      expect(left).not.toContain(gone);
    }
  });

  it("never throws: the clean-up is lazy and must not fail the request it rides on", async () => {
    const fake = db();
    fake.deleteMany.mockRejectedValue(new Error("db down"));
    await expect(clearPassedUndoWindows(fake, NOW)).resolves.toBe(0);
  });
});
