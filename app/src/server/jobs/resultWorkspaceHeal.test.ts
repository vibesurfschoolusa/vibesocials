import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeRawMock, updateManyMock, updateMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn(),
  updateManyMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { updateMany: updateManyMock, update: updateMock },
    $executeRaw: executeRawMock,
  },
}));

import { healResultWorkspaceIds, RESULT_WORKSPACE_HEAL_BATCH } from "./resultWorkspaceHeal";

/** The SQL text of the one tagged-template call, with its bound values. */
function sqlOfCall(index = 0): { text: string; values: unknown[] } {
  const [strings, ...values] = executeRawMock.mock.calls[index] as [readonly string[], ...unknown[]];
  return { text: strings.join("?"), values };
}

beforeEach(() => {
  executeRawMock.mockReset();
  updateManyMock.mockReset();
  updateMock.mockReset();
  executeRawMock.mockResolvedValue(0);
});

describe("healResultWorkspaceIds", () => {
  it("runs one raw UPDATE and reports how many rows it healed", async () => {
    executeRawMock.mockResolvedValue(7);

    await expect(healResultWorkspaceIds()).resolves.toEqual({ healed: 7 });

    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it("only touches rows that still have no workspace, a bounded batch at a time", async () => {
    await healResultWorkspaceIds();

    const { text, values } = sqlOfCall();
    expect(text).toContain('"workspaceId" IS NULL');
    expect(text).toContain("LIMIT");
    expect(text).toContain('"PostJob"');
    // The batch size is bound as a parameter, not interpolated into the text.
    expect(values).toContain(RESULT_WORKSPACE_HEAL_BATCH);
    expect(RESULT_WORKSPACE_HEAL_BATCH).toBe(1000);
  });

  // publish-health reads PostJobResult.updatedAt as "when the result finished".
  // A Prisma updateMany would bump @updatedAt and drag every healed old result
  // back into the 30-day window, so the heal is a raw UPDATE that never sets it.
  it("never writes updatedAt and never goes through Prisma's updateMany", async () => {
    await healResultWorkspaceIds();

    expect(sqlOfCall().text).not.toContain("updatedAt");
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("takes the workspace from the owning job", async () => {
    await healResultWorkspaceIds();

    const { text } = sqlOfCall();
    expect(text).toContain('SET "workspaceId" = (SELECT j."workspaceId" FROM "PostJob" j');
    expect(text).toContain('j."id" = r."postJobId"');
    // The batch is the NULL rows found by the inner SELECT.
    expect(text).toContain('r."id" IN (');
  });
});
