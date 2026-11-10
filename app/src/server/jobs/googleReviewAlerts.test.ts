import { beforeEach, describe, expect, it, vi } from "vitest";

// The cron's wiring only: the checks and sends have their own suite
// (reviewAlerts.test.ts). No database, Google, Resend or Inngest is reached.
const { collectMock, checkMock, sendMock } = vi.hoisted(() => ({
  collectMock: vi.fn(),
  checkMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/reviewAlerts", () => ({
  collectReviewAlertConnections: collectMock,
  checkReviewConnections: checkMock,
  sendReviewAlerts: sendMock,
}));

import { googleReviewAlerts, inngestFunctions } from "./inngest-functions";

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
  const handler = (googleReviewAlerts as unknown as { fn: (args: unknown) => Promise<unknown> }).fn;
  return handler({ event: {}, step, runId: "run-1" });
}

function registeredTriggers(): unknown {
  const { getConfig } = googleReviewAlerts as unknown as {
    getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
  };
  return getConfig
    .call(googleReviewAlerts, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
    .find((config) => config.id === "vibe-socials-google-review-alerts")?.triggers;
}

const ALERT = {
  connectionId: "conn-1",
  workspaceId: "ws-1",
  locationName: "accounts/1/locations/2",
  locationTitle: "Surf Co",
  seenThrough: "2026-11-10T08:00:00Z",
  reviews: [{ starRating: "FIVE", reviewerName: "Dana", comment: "Great" }],
};

beforeEach(() => {
  collectMock.mockReset();
  checkMock.mockReset();
  sendMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("googleReviewAlerts (google-review-alerts)", () => {
  it("is registered with its id and runs daily at 13:00 UTC", () => {
    expect(inngestFunctions).toContain(googleReviewAlerts);
    expect((googleReviewAlerts as unknown as { opts: { id: string } }).opts.id).toBe("google-review-alerts");
    expect(registeredTriggers()).toEqual([{ cron: "0 13 * * *" }]);
  });

  it("stops after one step when there is no Google connection", async () => {
    collectMock.mockResolvedValue([]);
    const step = fakeStep();

    await runHandler(step);

    expect(step.order).toEqual(["collect"]);
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("sends nothing when the check found no new reviews", async () => {
    collectMock.mockResolvedValue(["conn-1"]);
    checkMock.mockResolvedValue({ alerts: [], checked: 1, skipped: 0, failed: 0, left: 0 });
    const step = fakeStep();

    await runHandler(step);

    expect(step.order).toEqual(["collect", "check"]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("checks the collected connections and sends the alerts, with the time the collect step recorded", async () => {
    collectMock.mockResolvedValue(["conn-1"]);
    checkMock.mockResolvedValue({ alerts: [ALERT], checked: 1, skipped: 0, failed: 0, left: 0 });
    sendMock.mockResolvedValue({ sent: 1, failed: 0, left: 0 });
    const step = fakeStep();

    const result = await runHandler(step);

    expect(step.order).toEqual(["collect", "check", "send"]);
    const [ids, checkedAt] = checkMock.mock.calls[0];
    expect(ids).toEqual(["conn-1"]);
    const [alerts, sentAt] = sendMock.mock.calls[0];
    expect(alerts).toEqual([ALERT]);
    expect(sentAt.toISOString()).toBe(checkedAt.toISOString());
    expect(result).toEqual({ connections: 1, checked: 1, skipped: 0, failed: 0, left: 0, alerts: 1, sent: 1, sendFailed: 0, sendLeft: 0 });
  });
});
