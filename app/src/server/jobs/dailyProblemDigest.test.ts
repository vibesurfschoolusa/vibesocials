import { beforeEach, describe, expect, it, vi } from "vitest";

// The cron's wiring only: collection and sending have their own suite
// (problemDigest.test.ts). No database, Resend or Inngest is reached.
const { collectMock, sendMock } = vi.hoisted(() => ({ collectMock: vi.fn(), sendMock: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/problemDigest", () => ({
  collectProblemDigests: collectMock,
  sendProblemDigests: sendMock,
}));

import { dailyProblemDigest, inngestFunctions } from "./inngest-functions";

/** Runs each step inline and JSON-round-trips its output, as Inngest's memoization does. */
function fakeStep() {
  const order: string[] = [];
  return {
    order,
    run: vi.fn(async (id: string, cb: () => unknown) => {
      order.push(id);
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    }),
  };
}

function runHandler(step: ReturnType<typeof fakeStep>) {
  const handler = (dailyProblemDigest as unknown as { fn: (args: unknown) => Promise<unknown> }).fn;
  return handler({ event: {}, step, runId: "run-1" });
}

function registeredTriggers(): unknown {
  const { getConfig } = dailyProblemDigest as unknown as {
    getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
  };
  return getConfig
    .call(dailyProblemDigest, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
    .find((config) => config.id === "vibe-socials-daily-problem-digest")?.triggers;
}

const DIGEST = {
  userId: "user-1",
  workspaces: [
    {
      workspaceId: "ws-1",
      name: "Surf Co",
      failedPosts: 0,
      failedPlatforms: [],
      needsReconnect: ["x"],
      waitingForApproval: 0,
    },
  ],
};

beforeEach(() => {
  collectMock.mockReset();
  sendMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("dailyProblemDigest (daily-problem-digest)", () => {
  it("is registered with its id and runs daily at 12:00 UTC", () => {
    expect(inngestFunctions).toContain(dailyProblemDigest);
    expect((dailyProblemDigest as unknown as { opts: { id: string } }).opts.id).toBe("daily-problem-digest");
    expect(registeredTriggers()).toEqual([{ cron: "0 12 * * *" }]);
  });

  it("runs one step and sends nothing on a day with no problems", async () => {
    collectMock.mockResolvedValue([]);
    const step = fakeStep();

    await runHandler(step);

    expect(step.order).toEqual(["collect"]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends the collected digests with the time the collect step recorded", async () => {
    collectMock.mockResolvedValue([DIGEST]);
    sendMock.mockResolvedValue({ sent: 1, failed: 0, left: 0 });
    const step = fakeStep();

    const result = await runHandler(step);

    expect(step.order).toEqual(["collect", "send"]);
    const collectedAt: Date = collectMock.mock.calls[0][0];
    const [digests, sentAt] = sendMock.mock.calls[0];
    expect(digests).toEqual([DIGEST]);
    expect(sentAt.toISOString()).toBe(collectedAt.toISOString());
    expect(result).toEqual({ digests: 1, sent: 1, failed: 0, left: 0 });
  });
});
