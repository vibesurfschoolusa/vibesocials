import { beforeEach, describe, expect, it, vi } from "vitest";

// The cron's wiring only: the run itself has its own suite
// (monthlyReportEmail.test.ts). No database, Resend or Inngest is reached.
const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/monthlyReportEmail", () => ({ runMonthlyReportEmails: runMock }));

import { inngestFunctions, monthlyReportEmail } from "./inngest-functions";

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

function registeredTriggers(): unknown {
  const { getConfig } = monthlyReportEmail as unknown as {
    getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
  };
  return getConfig
    .call(monthlyReportEmail, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
    .find((config) => config.id === "vibe-socials-monthly-report-email")?.triggers;
}

const RESULT = { handled: 2, nothingToReport: 1, emailed: 1, failed: 0, errors: 0, left: 0 };

beforeEach(() => {
  runMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("monthlyReportEmail (monthly-report-email)", () => {
  it("is registered with its id, skips a run while one is going, and runs 15:00 UTC on days 1 to 3", () => {
    expect(inngestFunctions).toContain(monthlyReportEmail);
    const opts = (monthlyReportEmail as unknown as { opts: { id: string; singleton?: unknown } }).opts;
    expect(opts.id).toBe("monthly-report-email");
    expect(opts.singleton).toEqual({ mode: "skip" });
    expect(registeredTriggers()).toEqual([{ cron: "0 15 1-3 * *" }]);
  });

  it("does its work in one step and returns the run's counts", async () => {
    runMock.mockResolvedValue(RESULT);
    const step = fakeStep();
    const handler = (monthlyReportEmail as unknown as { fn: (args: unknown) => Promise<unknown> }).fn;

    const result = await handler({ event: {}, step, runId: "run-1" });

    expect(step.order).toEqual(["send"]);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(RESULT);
  });
});
