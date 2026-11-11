import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUPPORT_EMAIL } from "./siteInfo";
import {
  CREATE_WORKSPACE_WHILE_BLOCKED_MESSAGE,
  createWorkspaceWhileBlockedMessage,
  PLAN_ENDED_CODE,
  PLAN_ENDED_RESULT_FAILURE,
  blockedResultFailure,
  splitWorkspaceStatus,
  trialEndingNotice,
  WORKSPACE_PAUSED_RESULT_FAILURE,
  workspaceBlock,
  workspaceBlockResponse,
} from "./workspaceStatus";

/**
 * 21a: the second cause of a block, a trial or plan that has ended. Only with
 * billing on; with it off every combination of the new columns blocks exactly
 * as the pause alone did.
 */

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NEW = new Date("2026-12-02T00:00:00Z");

function billingOn() {
  vi.stubEnv("BILLING_ENABLED", "true");
}

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const ENDED_TRIAL = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: new Date(NOW.getTime() - DAY) };
const ENDED_PLAN = { billingExempt: false, plan: "growth", planStatus: "canceled", currentPeriodEnd: NEW };

/** Every combination of the new columns worth telling apart. */
const BILLING_COMBINATIONS: Record<string, unknown>[] = [];
for (const billingExempt of [undefined, false, true]) {
  for (const plan of [undefined, null, "starter", "pro", "unknown"]) {
    for (const planStatus of [undefined, null, "active", "past_due", "canceled"]) {
      for (const trialEndsAt of [undefined, null, "garbage", new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY)]) {
        for (const currentPeriodEnd of [null, new Date(NOW.getTime() - 3 * DAY)]) {
          BILLING_COMBINATIONS.push({ billingExempt, plan, planStatus, trialEndsAt, currentPeriodEnd });
        }
      }
    }
  }
}

const TRIAL_ENDED = "Your free trial has ended. Choose a plan in Settings to keep posting.";
const PLAN_ENDED = "Your plan has ended. Choose a plan in Settings to keep posting.";
const NONE = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null };

/**
 * Fix round 1: the rows each life of a workspace leaves, and the block each
 * must get with billing on (null: none). With billing off, none is blocked.
 */
const CASES: Record<string, { fields: Record<string, unknown>; block: string | null }> = {
  "created with billing off (column false, no trial): the bug": { fields: NONE, block: null },
  "existed at the migration (column true)": { fields: { ...NONE, billingExempt: true }, block: null },
  "created with billing on by a new user": { fields: { ...NONE, trialEndsAt: new Date(NOW.getTime() + 14 * DAY) }, block: null },
  "a second workspace inside the window": { fields: { ...NONE, trialEndsAt: new Date(NOW.getTime() + 9 * DAY) }, block: null },
  "a workspace created after the window": { fields: { ...NONE, trialEndsAt: new Date(NOW.getTime() - 6 * DAY) }, block: TRIAL_ENDED },
  "created by an operator": { fields: { ...NONE, billingExempt: true }, block: null },
  "admin started a trial and the date passed": {
    fields: { ...NONE, trialEndsAt: new Date(NOW.getTime() - DAY) },
    block: TRIAL_ENDED,
  },
  "then exempted again": { fields: { ...NONE, billingExempt: true, trialEndsAt: new Date(NOW.getTime() - DAY) }, block: null },
  "plan active": { fields: { ...NONE, plan: "growth", planStatus: "active" }, block: null },
  "plan trialing": { fields: { ...NONE, plan: "growth", planStatus: "trialing" }, block: null },
  "plan past_due, 6 days after the period end": {
    fields: { ...NONE, plan: "growth", planStatus: "past_due", currentPeriodEnd: new Date(NOW.getTime() - 6 * DAY) },
    block: null,
  },
  "plan past_due, 7 days exactly after the period end": {
    fields: { ...NONE, plan: "growth", planStatus: "past_due", currentPeriodEnd: new Date(NOW.getTime() - 7 * DAY) },
    block: PLAN_ENDED,
  },
  "plan canceled": { fields: { ...NONE, plan: "growth", planStatus: "canceled" }, block: PLAN_ENDED },
  "plan unpaid": { fields: { ...NONE, plan: "growth", planStatus: "unpaid" }, block: PLAN_ENDED },
  "plan with an unknown status": { fields: { ...NONE, plan: "growth", planStatus: "paused_by_provider" }, block: PLAN_ENDED },
  "plan with no status": { fields: { ...NONE, plan: "growth" }, block: PLAN_ENDED },
  "unparseable trial date, no plan": { fields: { ...NONE, trialEndsAt: "not a date" }, block: null },
};

/** What a job step's memoized output carries: dates as strings. */
function memoized(fields: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fields)) as Record<string, unknown>;
}

describe("with billing off", () => {
  it("blocks exactly as the pause alone did, for any combination of the plan columns", async () => {
    for (const pause of [
      { pausedAt: null, pausedReason: null },
      { pausedAt: new Date("2026-11-10T08:00:00Z"), pausedReason: "Unpaid invoice." },
      {},
    ]) {
      const today = workspaceBlock(pause);
      const todayResponse = workspaceBlockResponse(pause);
      for (const columns of BILLING_COMBINATIONS) {
        expect(workspaceBlock({ ...pause, ...columns }, NOW)).toEqual(today);
        // Every route answers through workspaceBlockResponse: same status, same body.
        const response = workspaceBlockResponse({ ...pause, ...columns }, NOW);
        expect(response?.status).toBe(todayResponse?.status);
        expect(await response?.json()).toEqual(await todayResponse?.clone().json());
        expect(trialEndingNotice({ ...pause, ...columns }, "owner", NOW)).toBeNull();
      }
    }
  });

  it("with BILLING_ENABLED anything but \"true\", is off", () => {
    vi.stubEnv("BILLING_ENABLED", "TRUE");
    expect(workspaceBlock(ENDED_TRIAL, NOW)).toBeNull();
  });

  it("every fix-round case blocks nothing, fresh or memoized", () => {
    for (const [name, row] of Object.entries(CASES)) {
      expect(workspaceBlock(row.fields, NOW), name).toBeNull();
      expect(workspaceBlock(memoized(row.fields), NOW), name).toBeNull();
    }
  });

  it("shows no trial notice", () => {
    expect(trialEndingNotice({ ...ENDED_TRIAL, trialEndsAt: new Date(NOW.getTime() + DAY) }, "owner", NOW)).toBeNull();
  });
});

describe("with billing on", () => {
  beforeEach(billingOn);

  it("blocks a workspace whose trial ended, with the trial sentence", () => {
    expect(workspaceBlock(ENDED_TRIAL, NOW)).toEqual({
      code: "PLAN_ENDED",
      message: "Your free trial has ended. Choose a plan in Settings to keep posting.",
    });
    expect(PLAN_ENDED_CODE).toBe("PLAN_ENDED");
  });

  it("blocks a workspace whose plan ended, with the plan sentence", () => {
    expect(workspaceBlock(ENDED_PLAN, NOW)).toEqual({
      code: "PLAN_ENDED",
      message: "Your plan has ended. Choose a plan in Settings to keep posting.",
    });
  });

  it("each fix-round case gets its block, the same from fresh rows and from a memoized step output", () => {
    for (const [name, row] of Object.entries(CASES)) {
      const expected = row.block ? { code: "PLAN_ENDED", message: row.block } : null;
      expect(workspaceBlock(row.fields, NOW), name).toEqual(expected);
      expect(workspaceBlock(memoized(row.fields), NOW), name).toEqual(expected);
    }
  });

  it("does not block a workspace in trial, on an active plan, or exempt", () => {
    expect(workspaceBlock({ ...ENDED_TRIAL, trialEndsAt: new Date(NOW.getTime() + DAY) }, NOW)).toBeNull();
    expect(workspaceBlock({ ...ENDED_PLAN, planStatus: "active" }, NOW)).toBeNull();
    expect(workspaceBlock({ ...ENDED_TRIAL, billingExempt: true }, NOW)).toBeNull();
  });

  it("the pause wins when both apply", () => {
    const block = workspaceBlock({ ...ENDED_TRIAL, pausedAt: NOW, pausedReason: "Unpaid invoice." }, NOW);
    expect(block).toEqual({
      code: "WORKSPACE_PAUSED",
      message: `This workspace is paused: Unpaid invoice. Contact ${SUPPORT_EMAIL}.`,
    });
  });

  it("accepts the dates as strings, as a memoized job step returns them", () => {
    expect(
      workspaceBlock({ ...ENDED_TRIAL, trialEndsAt: ENDED_TRIAL.trialEndsAt.toISOString() }, NOW)
        ?.code,
    ).toBe("PLAN_ENDED");
  });

  it("the route answers 403 with the sentence and the code", async () => {
    const response = workspaceBlockResponse(ENDED_TRIAL, NOW);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "Your free trial has ended. Choose a plan in Settings to keep posting.",
      code: "PLAN_ENDED",
    });
  });

  it("uses the current time by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      expect(workspaceBlock({ ...ENDED_TRIAL, trialEndsAt: new Date(NOW.getTime() + 1000) })).toBeNull();
      vi.setSystemTime(NOW.getTime() + 1000);
      expect(workspaceBlock({ ...ENDED_TRIAL, trialEndsAt: new Date(NOW.getTime() + 1000) })?.code).toBe("PLAN_ENDED");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("trialEndingNotice", () => {
    const inTrial = (msLeft: number) => ({ ...ENDED_TRIAL, trialEndsAt: new Date(NOW.getTime() + msLeft) });

    it("tells owners in the last 3 days of a trial", () => {
      expect(trialEndingNotice(inTrial(3 * DAY), "owner", NOW)).toBe(
        "Your free trial ends on 13 December. Choose a plan in Settings.",
      );
      expect(trialEndingNotice(inTrial(60 * 1000), "owner", NOW)).toBe(
        "Your free trial ends on 10 December. Choose a plan in Settings.",
      );
    });

    it("says nothing earlier, to members, or outside a trial", () => {
      expect(trialEndingNotice(inTrial(3 * DAY + 1), "owner", NOW)).toBeNull();
      expect(trialEndingNotice(inTrial(DAY), "member", NOW)).toBeNull();
      expect(trialEndingNotice(ENDED_TRIAL, "owner", NOW)).toBeNull();
      expect(trialEndingNotice({ ...inTrial(DAY), billingExempt: true }, "owner", NOW)).toBeNull();
    });
  });
});

describe("blockedResultFailure", () => {
  it("writes the pause's failure for a pause and the plan's for an ended plan", () => {
    expect(blockedResultFailure("WORKSPACE_PAUSED")).toBe(WORKSPACE_PAUSED_RESULT_FAILURE);
    expect(blockedResultFailure("PLAN_ENDED")).toBe(PLAN_ENDED_RESULT_FAILURE);
    expect(PLAN_ENDED_RESULT_FAILURE).toEqual({
      errorCode: "PLAN_ENDED",
      errorMessage: "Not published: this workspace has no active plan.",
    });
  });
});

describe("createWorkspaceWhileBlockedMessage", () => {
  it("names the pause or the plan", () => {
    expect(createWorkspaceWhileBlockedMessage("WORKSPACE_PAUSED")).toBe(CREATE_WORKSPACE_WHILE_BLOCKED_MESSAGE);
    expect(createWorkspaceWhileBlockedMessage("PLAN_ENDED")).toBe(
      "You cannot create a workspace while one of your workspaces has no active plan. Choose a plan in Settings first.",
    );
  });
});

describe("splitWorkspaceStatus", () => {
  it("takes the status columns off a row and leaves the rest untouched", () => {
    const row = {
      id: "ws-1",
      companyWebsite: "x.com",
      pausedAt: null,
      pausedReason: null,
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
    };
    const { status, rest } = splitWorkspaceStatus(row);
    expect(rest).toEqual({ id: "ws-1", companyWebsite: "x.com" });
    expect(status).toEqual({
      pausedAt: null,
      pausedReason: null,
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
    });
  });

  it("gives back only the keys the row had", () => {
    const { status, rest } = splitWorkspaceStatus({ id: "ws-1", pausedAt: null, pausedReason: "x" });
    expect(rest).toEqual({ id: "ws-1" });
    expect(status).toEqual({ pausedAt: null, pausedReason: "x" });
    expect(Object.keys(status)).toEqual(["pausedAt", "pausedReason"]);
  });
});
