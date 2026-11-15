import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ prune: vi.fn(async () => 3), clearUndo: vi.fn(async () => 2) }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({
  del: vi.fn(),
  head: vi.fn(),
  list: vi.fn(async () => ({ blobs: [], folders: [], hasMore: false })),
}));
vi.mock("@/server/usage/usageLog", () => ({ pruneUsageEvents: m.prune }));
vi.mock("@/server/auth/undoWindow", () => ({ clearPassedUndoWindows: m.clearUndo }));

import { orphanBlobSweep } from "./orphanBlobSweep";

/**
 * Review of R5-security M1: the usage log is pruned in this existing daily
 * job, inside its one step, so it costs no new function and no new execution.
 */
describe("orphanBlobSweep prunes the usage log", () => {
  it("prunes old usage rows in its one step and reports how many", async () => {
    const steps: string[] = [];
    const step = {
      run: async (id: string, cb: () => unknown) => {
        steps.push(id);
        return cb();
      },
    };
    const handler = (orphanBlobSweep as unknown as { fn: (args: unknown) => Promise<Record<string, unknown>> }).fn;

    const summary = await handler({ step, runId: "run-1" });

    expect(steps).toEqual(["sweep"]);
    expect(m.prune).toHaveBeenCalledWith(expect.any(Date));
    expect(summary).toMatchObject({ usageEventsPruned: 3 });
  });
});

// R6-pages L6: the privacy page promises the previous address is deleted
// after 72 hours, so the passed undo windows are cleared here every day too,
// in the same step (no new function, no new execution).
describe("orphanBlobSweep clears passed email-change undo windows", () => {
  it("clears them in its one step and reports how many", async () => {
    const steps: string[] = [];
    const step = {
      run: async (id: string, cb: () => unknown) => {
        steps.push(id);
        return cb();
      },
    };
    const handler = (orphanBlobSweep as unknown as { fn: (args: unknown) => Promise<Record<string, unknown>> }).fn;

    const summary = await handler({ step, runId: "run-1" });

    expect(steps).toEqual(["sweep"]);
    expect(m.clearUndo).toHaveBeenCalledWith(expect.anything(), expect.any(Date));
    expect(summary).toMatchObject({ undoWindowsCleared: 2 });
  });
});
