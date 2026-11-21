import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R56 client-journey-2 L2: a client's /c choice and the owner's Settings
// choice share the link creator's user id. A new choice replaces only earlier
// choices from the same flow: the owner's (no link) or that one link's.
type Row = {
  id: string;
  workspaceId: string;
  userId: string;
  platform: string;
  connectLinkId: string | null;
  payload: string;
  expiresAt: Date;
};
type Where = {
  id?: string;
  workspaceId?: string;
  userId?: string;
  platform?: string;
  connectLinkId?: string | null;
  expiresAt?: { lte: Date };
  OR?: Where[];
};

const table = vi.hoisted(() => ({ rows: [] as Row[], seq: 0 }));

function matches(row: Row, where: Where): boolean {
  if (where.OR && !where.OR.some((part) => matches(row, part))) return false;
  for (const key of ["id", "workspaceId", "userId", "platform", "connectLinkId"] as const) {
    if (key in where && row[key] !== where[key]) return false;
  }
  if (where.expiresAt && !(row.expiresAt.getTime() <= where.expiresAt.lte.getTime())) return false;
  return true;
}

vi.mock("@/lib/db", () => {
  const pendingConnection = {
    async deleteMany({ where }: { where: Where }) {
      const before = table.rows.length;
      table.rows = table.rows.filter((row) => !matches(row, where));
      return { count: before - table.rows.length };
    },
    async create({ data }: { data: Omit<Row, "id" | "connectLinkId"> & { connectLinkId?: string | null } }) {
      table.seq += 1;
      const row: Row = { ...data, connectLinkId: data.connectLinkId ?? null, id: `pending-${table.seq}` };
      table.rows.push(row);
      return { id: row.id };
    },
    async findUnique({ where }: { where: { id: string } }) {
      return table.rows.find((row) => row.id === where.id) ?? null;
    },
  };
  return {
    prisma: {
      pendingConnection,
      $transaction: (operations: Array<Promise<unknown>>) => Promise.all(operations),
    },
  };
});

import { createPendingConnection, loadPendingConnection, type PendingConnectionPayload } from "./pendingConnection";

const OWNER = { workspaceId: "ws-1", userId: "creator-1" };
const PAYLOAD: PendingConnectionPayload = {
  platform: "facebook_page",
  expiresAt: "2027-01-01T00:00:00.000Z",
  pages: [{ id: "page-1", name: "Cafe", accessToken: "page-token" }],
};

const ids = () => table.rows.map((row) => row.id);

beforeEach(() => {
  table.rows = [];
  table.seq = 0;
  // A test-only key, so the payload seals and opens.
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createPendingConnection: a new choice replaces only its own flow's", () => {
  it("the owner's connect leaves a link's waiting choice in place", async () => {
    const link = await createPendingConnection({ ...OWNER, payload: PAYLOAD, connectLinkId: "link-1" });
    const owner = await createPendingConnection({ ...OWNER, payload: PAYLOAD });
    expect(ids()).toEqual([link, owner]);
    expect(table.rows.map((row) => row.connectLinkId)).toEqual(["link-1", null]);
  });

  it("a link's connect leaves the owner's waiting choice in place", async () => {
    const owner = await createPendingConnection({ ...OWNER, payload: PAYLOAD });
    const link = await createPendingConnection({ ...OWNER, payload: PAYLOAD, connectLinkId: "link-1" });
    expect(ids()).toEqual([owner, link]);
  });

  it("a second owner connect replaces the first owner choice", async () => {
    await createPendingConnection({ ...OWNER, payload: PAYLOAD });
    const second = await createPendingConnection({ ...OWNER, payload: PAYLOAD });
    expect(ids()).toEqual([second]);
  });

  it("a second connect through a link replaces that link's earlier choice, and no other link's", async () => {
    const other = await createPendingConnection({ ...OWNER, payload: PAYLOAD, connectLinkId: "link-2" });
    await createPendingConnection({ ...OWNER, payload: PAYLOAD, connectLinkId: "link-1" });
    const second = await createPendingConnection({ ...OWNER, payload: PAYLOAD, connectLinkId: "link-1" });
    expect(ids()).toEqual([other, second]);
  });

  it("expired rows of this user here are still cleared, whichever flow made them", async () => {
    const past = new Date(Date.now() - 1000);
    table.rows.push(
      { id: "old-owner", ...OWNER, platform: "linkedin", connectLinkId: null, payload: "x", expiresAt: past },
      { id: "old-link", ...OWNER, platform: "linkedin", connectLinkId: "link-9", payload: "x", expiresAt: past },
    );
    const created = await createPendingConnection({ ...OWNER, payload: PAYLOAD });
    expect(ids()).toEqual([created]);
  });

  it("both choices can still be read and chosen from", async () => {
    const link = await createPendingConnection({ ...OWNER, payload: PAYLOAD, connectLinkId: "link-1" });
    const owner = await createPendingConnection({ ...OWNER, payload: PAYLOAD });
    expect((await loadPendingConnection(link, OWNER))?.payload).toEqual(PAYLOAD);
    expect((await loadPendingConnection(owner, OWNER))?.payload).toEqual(PAYLOAD);
    // The /c route reads its row's stamp: the link's row carries it from the start.
    expect(table.rows.find((row) => row.id === link)?.connectLinkId).toBe("link-1");
  });
});
