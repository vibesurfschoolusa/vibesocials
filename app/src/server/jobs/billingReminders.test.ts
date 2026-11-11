import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cron's wiring only: the reminders themselves have their own suite
// (src/server/billing/reminders.test.ts). No database, Resend or Inngest is reached.
const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/billing/reminders", () => ({ runBillingReminders: runMock }));

import { billingReminders, inngestFunctions } from "./inngest-functions";

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
  const handler = (billingReminders as unknown as { fn: (args: unknown) => Promise<unknown> }).fn;
  return handler({ event: {}, step, runId: "run-1" });
}

function registered() {
  const { getConfig } = billingReminders as unknown as {
    getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
  };
  return getConfig
    .call(billingReminders, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
    .find((config) => config.id === "vibe-socials-billing-reminders");
}

const SUMMARY = { trialEnding: 1, trialEnded: 0, sent: 1, failed: 0, left: 0 };

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue(SUMMARY);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("billingReminders (billing-reminders)", () => {
  it("is registered with its id, daily at 16:00 UTC, one run at a time", () => {
    expect(inngestFunctions).toContain(billingReminders);
    const opts = (billingReminders as unknown as { opts: { id: string; singleton: unknown } }).opts;
    expect(opts.id).toBe("billing-reminders");
    expect(opts.singleton).toEqual({ mode: "skip" });
    expect(registered()?.triggers).toEqual([{ cron: "0 16 * * *" }]);
  });

  it("with billing off, returns before any step", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    const step = fakeStep();
    await runHandler(step);
    expect(step.order).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("with billing on, runs one step and returns its counts", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const step = fakeStep();
    expect(await runHandler(step)).toEqual(SUMMARY);
    expect(step.order).toEqual(["send"]);
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
