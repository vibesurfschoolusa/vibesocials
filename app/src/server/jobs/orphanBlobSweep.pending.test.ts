import { describe, expect, it, vi } from "vitest";

type Row = { id: string; workspaceId: string; userId: string; expiresAt: Date };

const m = vi.hoisted(() => ({ rows: [] as Row[], fail: false }));

// An in-memory pendingConnection table: deleteMany honours the `expiresAt.lte` filter it is given.
vi.mock("@/lib/db", () => ({
  prisma: {
    pendingConnection: {
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (m.fail) throw new Error("db down");
        const keys = Object.keys(where);
        if (keys.length !== 1 || keys[0] !== "expiresAt") throw new Error(`unexpected filter ${JSON.stringify(where)}`);
        const lte = (where.expiresAt as { lte: Date }).lte;
        const before = m.rows.length;
        m.rows = m.rows.filter((row) => row.expiresAt.getTime() > lte.getTime());
        return { count: before - m.rows.length };
      }),
    },
  },
}));
vi.mock("@vercel/blob", () => ({
  del: vi.fn(),
  head: vi.fn(),
  list: vi.fn(async () => ({ blobs: [], folders: [], hasMore: false })),
}));
vi.mock("@/server/usage/usageLog", () => ({ pruneUsageEvents: vi.fn(async () => 0) }));
vi.mock("@/server/auth/undoWindow", () => ({ clearPassedUndoWindows: vi.fn(async () => 0) }));

import { orphanBlobSweep } from "./orphanBlobSweep";

async function runSweep() {
  const steps: string[] = [];
  const step = {
    run: async (id: string, cb: () => unknown) => {
      steps.push(id);
      return cb();
    },
  };
  const handler = (orphanBlobSweep as unknown as { fn: (args: unknown) => Promise<Record<string, unknown>> }).fn;
  return { summary: await handler({ step, runId: "run-1" }), steps };
}

/**
 * R31 security-billing L1: an account choice that is never finished keeps
 * sealed tokens for every account it offered. Its 15 minutes passed, it goes
 * in the existing daily sweep step: no new function, step or execution.
 */
describe("orphanBlobSweep deletes waiting account choices whose time has passed", () => {
  it("an expired row of any user and workspace is gone after one run; an unexpired one stays", async () => {
    const now = Date.now();
    m.rows = [
      { id: "old-other", workspaceId: "ws-2", userId: "user-2", expiresAt: new Date(now - 60_000) },
      { id: "old-mine", workspaceId: "ws-1", userId: "user-1", expiresAt: new Date(now - 24 * 60 * 60 * 1000) },
      { id: "waiting", workspaceId: "ws-1", userId: "user-1", expiresAt: new Date(now + 10 * 60 * 1000) },
    ];

    const { summary, steps } = await runSweep();

    expect(steps).toEqual(["sweep"]);
    expect(m.rows.map((row) => row.id)).toEqual(["waiting"]);
    expect(summary).toMatchObject({ pendingConnectionsCleared: 2 });
  });

  it("a failure there never stops the rest of the sweep", async () => {
    m.fail = true;
    try {
      const { summary } = await runSweep();
      expect(summary).toMatchObject({ pendingConnectionsCleared: 0, finished: true });
    } finally {
      m.fail = false;
    }
  });
});
