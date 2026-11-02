import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLISH_CONCURRENCY_GLOBAL,
  DEFAULT_PUBLISH_CONCURRENCY_PER_WORKSPACE,
  PUBLISH_PRIORITY,
  publishConcurrency,
  publishConcurrencyLimits,
} from "./publishFlowControl";

describe("publishConcurrencyLimits", () => {
  it("defaults to 20 per workspace and 80 global when the env vars are absent", () => {
    expect(publishConcurrencyLimits({})).toEqual({ perWorkspace: 20, global: 80 });
    expect(DEFAULT_PUBLISH_CONCURRENCY_PER_WORKSPACE).toBe(20);
    expect(DEFAULT_PUBLISH_CONCURRENCY_GLOBAL).toBe(80);
  });

  it("reads PUBLISH_CONCURRENCY_PER_WORKSPACE and PUBLISH_CONCURRENCY_GLOBAL", () => {
    expect(
      publishConcurrencyLimits({
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
          PUBLISH_CONCURRENCY_PER_WORKSPACE: raw,
          PUBLISH_CONCURRENCY_GLOBAL: raw,
        }),
      ).toEqual({ perWorkspace: 20, global: 80 });
    },
  );

  it("falls back per variable, not for both", () => {
    expect(
      publishConcurrencyLimits({
        PUBLISH_CONCURRENCY_PER_WORKSPACE: "abc",
        PUBLISH_CONCURRENCY_GLOBAL: "120",
      }),
    ).toEqual({ perWorkspace: 20, global: 120 });
  });

  it("falls back for a number too large to be a safe integer", () => {
    expect(
      publishConcurrencyLimits({ PUBLISH_CONCURRENCY_GLOBAL: "99999999999999999999" }).global,
    ).toBe(80);
  });

  it("reads process.env by default", () => {
    const before = {
      ws: process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE,
      global: process.env.PUBLISH_CONCURRENCY_GLOBAL,
    };
    try {
      process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE = "7";
      process.env.PUBLISH_CONCURRENCY_GLOBAL = "33";
      expect(publishConcurrencyLimits()).toEqual({ perWorkspace: 7, global: 33 });
    } finally {
      if (before.ws === undefined) delete process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE;
      else process.env.PUBLISH_CONCURRENCY_PER_WORKSPACE = before.ws;
      if (before.global === undefined) delete process.env.PUBLISH_CONCURRENCY_GLOBAL;
      else process.env.PUBLISH_CONCURRENCY_GLOBAL = before.global;
    }
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
