import { describe, expect, it } from "vitest";

import {
  DEFAULT_INNGEST_PLAN_CONCURRENCY,
  DEFAULT_PUBLISH_CONCURRENCY_GLOBAL,
  DEFAULT_PUBLISH_CONCURRENCY_PER_WORKSPACE,
  DEFAULT_REFRESH_CONNECTION_CONCURRENCY,
  PUBLISH_PRIORITY,
  inngestPlanConcurrency,
  publishConcurrency,
  publishConcurrencyLimits,
  refreshConnectionConcurrency,
} from "./publishFlowControl";

/** A ceiling high enough that the per-limit tests below see their own values. */
const ROOMY = { INNGEST_PLAN_CONCURRENCY: "1000" } as const;

describe("publishConcurrencyLimits", () => {
  it("defaults to the plan ceiling of 5 for both limits when no env var is set", () => {
    expect(publishConcurrencyLimits({})).toEqual({ perWorkspace: 5, global: 5 });
    expect(DEFAULT_INNGEST_PLAN_CONCURRENCY).toBe(5);
  });

  it("uses the design limits, 20 per workspace and 80 global, under a large enough plan", () => {
    expect(publishConcurrencyLimits({ INNGEST_PLAN_CONCURRENCY: "100" })).toEqual({
      perWorkspace: 20,
      global: 80,
    });
    expect(DEFAULT_PUBLISH_CONCURRENCY_PER_WORKSPACE).toBe(20);
    expect(DEFAULT_PUBLISH_CONCURRENCY_GLOBAL).toBe(80);
  });

  it("clamps explicit limits to the plan ceiling, which Inngest's sync enforces", () => {
    expect(
      publishConcurrencyLimits({
        INNGEST_PLAN_CONCURRENCY: "5",
        PUBLISH_CONCURRENCY_PER_WORKSPACE: "20",
        PUBLISH_CONCURRENCY_GLOBAL: "80",
      }),
    ).toEqual({ perWorkspace: 5, global: 5 });
    expect(
      publishConcurrencyLimits({
        INNGEST_PLAN_CONCURRENCY: "50",
        PUBLISH_CONCURRENCY_PER_WORKSPACE: "3",
        PUBLISH_CONCURRENCY_GLOBAL: "80",
      }),
    ).toEqual({ perWorkspace: 3, global: 50 });
  });

  it("reads PUBLISH_CONCURRENCY_PER_WORKSPACE and PUBLISH_CONCURRENCY_GLOBAL", () => {
    expect(
      publishConcurrencyLimits({
        ...ROOMY,
        PUBLISH_CONCURRENCY_PER_WORKSPACE: "12",
        PUBLISH_CONCURRENCY_GLOBAL: "200",
      }),
    ).toEqual({ perWorkspace: 12, global: 200 });
  });

  it.each(["0", "-3", "abc", "", "  ", "1.5", "1e3", "NaN"])(
    "falls back to the default for the invalid value %j",
    (raw) => {
      expect(
        publishConcurrencyLimits({
          ...ROOMY,
          PUBLISH_CONCURRENCY_PER_WORKSPACE: raw,
          PUBLISH_CONCURRENCY_GLOBAL: raw,
        }),
      ).toEqual({ perWorkspace: 20, global: 80 });
    },
  );

  it("falls back per variable, not for both", () => {
    expect(
      publishConcurrencyLimits({
        ...ROOMY,
        PUBLISH_CONCURRENCY_PER_WORKSPACE: "abc",
        PUBLISH_CONCURRENCY_GLOBAL: "120",
      }),
    ).toEqual({ perWorkspace: 20, global: 120 });
  });

  it("falls back for a number too large to be a safe integer", () => {
    expect(
      publishConcurrencyLimits({ ...ROOMY, PUBLISH_CONCURRENCY_GLOBAL: "99999999999999999999" })
        .global,
    ).toBe(80);
  });

  it("reads process.env by default", () => {
    const before = {
      ws: process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE,
      global: process.env.PUBLISH_CONCURRENCY_GLOBAL,
      plan: process.env.INNGEST_PLAN_CONCURRENCY,
    };
    try {
      process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE = "7";
      process.env.PUBLISH_CONCURRENCY_GLOBAL = "33";
      process.env.INNGEST_PLAN_CONCURRENCY = "30";
      expect(publishConcurrencyLimits()).toEqual({ perWorkspace: 7, global: 30 });
    } finally {
      if (before.plan === undefined) delete process.env.INNGEST_PLAN_CONCURRENCY;
      else process.env.INNGEST_PLAN_CONCURRENCY = before.plan;
      if (before.ws === undefined) delete process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE;
      else process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE = before.ws;
      if (before.global === undefined) delete process.env.PUBLISH_CONCURRENCY_GLOBAL;
      else process.env.PUBLISH_CONCURRENCY_GLOBAL = before.global;
    }
  });
});

describe("inngestPlanConcurrency", () => {
  it("defaults to 5, the per-function concurrency ceiling of Inngest's free plan", () => {
    expect(inngestPlanConcurrency({})).toBe(5);
  });

  it("reads INNGEST_PLAN_CONCURRENCY", () => {
    expect(inngestPlanConcurrency({ INNGEST_PLAN_CONCURRENCY: "100" })).toBe(100);
  });

  it.each(["0", "-3", "abc", "", "1.5"])("falls back to 5 for the invalid value %j", (raw) => {
    expect(inngestPlanConcurrency({ INNGEST_PLAN_CONCURRENCY: raw })).toBe(5);
  });
});

describe("refreshConnectionConcurrency", () => {
  it("is one run per connection plus a global limit clamped to the plan ceiling", () => {
    expect(refreshConnectionConcurrency({})).toEqual([
      { key: "event.data.socialConnectionId", limit: 1 },
      { limit: 5 },
    ]);
  });

  it("uses the design global limit of 10 under a large enough plan", () => {
    expect(DEFAULT_REFRESH_CONNECTION_CONCURRENCY).toBe(10);
    expect(refreshConnectionConcurrency({ INNGEST_PLAN_CONCURRENCY: "100" })).toEqual([
      { key: "event.data.socialConnectionId", limit: 1 },
      { limit: 10 },
    ]);
  });
});

describe("publishConcurrency", () => {
  it("is two env-scoped keys: one per workspace, one global", () => {
    expect(publishConcurrency({ perWorkspace: 20, global: 80 })).toEqual([
      { scope: "env", key: '"publish-ws-" + event.data.workspaceId', limit: 20 },
      { scope: "env", key: '"publish-global"', limit: 80 },
    ]);
  });

  it("carries the limits it is given", () => {
    const [perWorkspace, global] = publishConcurrency({ perWorkspace: 9, global: 150 });
    expect(perWorkspace.limit).toBe(9);
    expect(global.limit).toBe(150);
  });

  it("uses the env-derived limits by default", () => {
    expect(publishConcurrency()).toEqual(publishConcurrency(publishConcurrencyLimits()));
  });

  it("never exceeds Inngest's two concurrency constraints per function", () => {
    expect(publishConcurrency().length).toBeLessThanOrEqual(2);
  });
});

describe("PUBLISH_PRIORITY", () => {
  it("puts a Post-now run up to 600 s ahead of the scheduled backlog", () => {
    expect(PUBLISH_PRIORITY).toEqual({ run: "event.data.immediate == true ? 600 : 0" });
  });
});
