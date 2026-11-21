import bcrypt from "bcryptjs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// R57 new-customer L1: asking for a change to another address retires the
// earlier pending change at once, whether or not the new email is accepted.
// A mistyped address's link must not stay able to take the account. A repeat
// to the same address keeps R56's rule (retired only after an accepted send).
// The request and confirm routes run against one in-memory table, so "dead"
// means the confirm route really refuses the link.

type Row = {
  id: string;
  userId: string;
  newEmail: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

const { store, getCurrentUserMock, deliverAccountEmailMock } = vi.hoisted(() => ({
  store: { rows: [] as Row[], clock: 0, user: { email: "old@example.com" }, taken: [] as string[] },
  getCurrentUserMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => undefined,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/server/billing/customerEmail", () => ({ followEmailChangeInStripe: async () => undefined }));
vi.mock("@/server/auth/undoWindow", () => ({
  accountUndoWindowUntil: async () => null,
  addressHeldUntil: async () => null,
  clearPassedUndoWindows: async () => undefined,
}));
vi.mock("@/lib/accountEmails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountEmails")>()),
  deliverAccountEmail: deliverAccountEmailMock,
}));
vi.mock("@/lib/db", () => {
  type Where = Record<string, unknown>;
  const matches = (row: Row, where: Where) =>
    Object.entries(where).every(([key, condition]) => {
      const value = row[key as keyof Row];
      if (condition === null || typeof condition !== "object" || condition instanceof Date) {
        return condition instanceof Date ? value instanceof Date && value.getTime() === condition.getTime() : value === condition;
      }
      const c = condition as { lt?: Date; gt?: Date; not?: unknown };
      if (c.lt && !(value instanceof Date && value < c.lt)) return false;
      if (c.gt && !(value instanceof Date && value > c.gt)) return false;
      if ("not" in c && value === c.not) return false;
      return true;
    });
  const prisma: Record<string, unknown> = {
    user: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        store.taken.includes(where.email) ? { id: "someone-else" } : null,
      update: async ({ data }: { data: { email: string } }) => {
        store.user.email = data.email;
        return {};
      },
    },
    accountToken: { deleteMany: async () => ({ count: 0 }) },
    emailChangeRequest: {
      create: async ({ data }: { data: Omit<Row, "id" | "usedAt" | "createdAt"> }) => {
        store.clock += 1;
        const row: Row = { ...data, id: `req_${store.clock}`, usedAt: null, createdAt: new Date(Date.UTC(2026, 10, 21, 0, store.clock)) };
        store.rows.push(row);
        return { id: row.id, createdAt: row.createdAt };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const before = store.rows.length;
        store.rows = store.rows.filter((row) => !matches(row, where));
        return { count: before - store.rows.length };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = store.rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const row = store.rows.find((r) => r.tokenHash === where.tokenHash);
        return row
          ? { ...row, user: { email: store.user.email, emailVerifiedAt: new Date(0), googleLinkedAt: null } }
          : null;
      },
    },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});

import { POST as requestChange } from "./route";
import { POST as confirmChange } from "./confirm/route";

let hash: string;

beforeAll(async () => {
  hash = await bcrypt.hash("the-password", 4);
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
  store.rows = [];
  store.clock = 0;
  store.user.email = "old@example.com";
  store.taken = [];
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockImplementation(async () => ({ id: "user-1", email: store.user.email, passwordHash: hash }));
  deliverAccountEmailMock.mockReset();
});

/** Asks for a change; returns the link's raw token and the route's status. */
async function ask(newEmail: string, accepted: boolean) {
  let token = "";
  deliverAccountEmailMock.mockImplementationOnce(async (_to: string, email: { text: string }) => {
    token = /\/verify-email\/new-address#(\S+)/.exec(email.text)?.[1] ?? "";
    return accepted;
  });
  const response = await requestChange(
    new Request("http://localhost/api/auth/change-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newEmail, currentPassword: "the-password" }),
    }),
  );
  expect(token).not.toBe("");
  return { token, status: response.status };
}

/** Asks for a change to an address another account uses: same answer, no email. */
async function askTaken(newEmail: string) {
  store.taken.push(newEmail);
  const response = await requestChange(
    new Request("http://localhost/api/auth/change-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newEmail, currentPassword: "the-password" }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function confirm(token: string) {
  deliverAccountEmailMock.mockResolvedValue(true);
  const response = await confirmChange(
    new Request("http://localhost/api/auth/change-email/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ token }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const DEAD_REASON = "not_valid";

describe("change-email: a correction to another address", () => {
  it("send refused: the earlier link is dead and so is the new one, so nothing is pending", async () => {
    const typo = await ask("klaus@gmial.example", true);
    const fixed = await ask("klaus@gmail.example", false);
    expect(fixed.status).toBe(502);

    expect(store.rows).toEqual([]);
    const earlier = await confirm(typo.token);
    expect(earlier.status).toBe(400);
    expect(earlier.body.reason).toBe(DEAD_REASON);
    expect((await confirm(fixed.token)).body.reason).toBe(DEAD_REASON);
    expect(store.user.email).toBe("old@example.com");
  });

  it("send accepted: only the new link works", async () => {
    const typo = await ask("klaus@gmial.example", true);
    const fixed = await ask("klaus@gmail.example", true);
    expect(fixed.status).toBe(200);

    expect(store.rows.map((row) => row.newEmail)).toEqual(["klaus@gmail.example"]);
    expect((await confirm(typo.token)).body.reason).toBe(DEAD_REASON);
    expect(store.user.email).toBe("old@example.com");
    expect((await confirm(fixed.token)).status).toBe(200);
    expect(store.user.email).toBe("klaus@gmail.example");
  });

  // No email goes out, so nothing can be accepted: the earlier change to
  // another address is retired all the same, and the answer is as before.
  it("the new address is another account's: the earlier link is dead, the answer unchanged", async () => {
    const typo = await ask("klaus@gmial.example", true);
    deliverAccountEmailMock.mockClear();
    const taken = await askTaken("klaus@gmail.example");
    expect(taken).toEqual({ status: 200, body: { ok: true } });
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();

    expect(store.rows).toEqual([]);
    expect((await confirm(typo.token)).body.reason).toBe(DEAD_REASON);
  });
});

describe("change-email: a repeat to the same address", () => {
  it("send refused: the earlier link still works", async () => {
    const first = await ask("new@example.com", true);
    const again = await ask("new@example.com", false);
    expect(again.status).toBe(502);

    expect(store.rows).toHaveLength(1);
    expect((await confirm(again.token)).body.reason).toBe(DEAD_REASON);
    expect((await confirm(first.token)).status).toBe(200);
    expect(store.user.email).toBe("new@example.com");
  });

  it("send accepted: only the new link works", async () => {
    const first = await ask("new@example.com", true);
    const again = await ask("new@example.com", true);
    expect(again.status).toBe(200);

    expect(store.rows).toHaveLength(1);
    expect((await confirm(first.token)).body.reason).toBe(DEAD_REASON);
    expect((await confirm(again.token)).status).toBe(200);
    expect(store.user.email).toBe("new@example.com");
  });
});
