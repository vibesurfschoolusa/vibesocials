import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import {
  BILLING_FIELDS_SELECT,
  billingEnabled,
  billingFieldsSelect,
  billingStartedAt,
  newWorkspaceBillingData,
  planState,
  trialDays,
} from "./billing";

const STARTED = "2026-12-01T00:00:00Z";
const ON = { BILLING_ENABLED: "true", BILLING_STARTED_AT: STARTED };
const NOW = new Date("2026-12-10T12:00:00Z");
const AFTER_START = new Date("2026-12-02T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  loggerError.mockReset();
});

describe("billingEnabled", () => {
  it("is true only for exactly \"true\" with a valid start date", () => {
    expect(billingEnabled(ON)).toBe(true);
    expect(billingEnabled({ ...ON, BILLING_STARTED_AT: "2026-12-01" })).toBe(true);
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", " true", "true "]) {
      expect(billingEnabled({ ...ON, BILLING_ENABLED: value }), String(value)).toBe(false);
    }
    expect(billingEnabled({})).toBe(false);
  });

  it("is off without a valid BILLING_STARTED_AT, logged as a configuration error", () => {
    for (const startedAt of [undefined, "", "soon", "2026-13-01", "12/01/2026", "2026-12-01T25:00:00Z"]) {
      expect(billingEnabled({ BILLING_ENABLED: "true", BILLING_STARTED_AT: startedAt }), String(startedAt)).toBe(false);
    }
    expect(loggerError).toHaveBeenCalled();
    expect(String(loggerError.mock.calls[0][0])).toMatch(/BILLING_STARTED_AT/);
  });

  it("logs nothing when billing is simply off", () => {
    billingEnabled({});
    billingEnabled({ BILLING_ENABLED: "false", BILLING_STARTED_AT: "nonsense" });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("reads process.env at call time by default", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("BILLING_STARTED_AT", STARTED);
    expect(billingEnabled()).toBe(true);
    vi.stubEnv("BILLING_ENABLED", "");
    expect(billingEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("billingStartedAt", () => {
  it("parses an ISO date or date-time, else null", () => {
    expect(billingStartedAt(ON)?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(billingStartedAt({ BILLING_STARTED_AT: "2026-12-01" })?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(billingStartedAt({ BILLING_STARTED_AT: "2026-12-01T09:30:00+02:00" })?.toISOString()).toBe(
      "2026-12-01T07:30:00.000Z",
    );
    expect(billingStartedAt({ BILLING_STARTED_AT: "tomorrow" })).toBeNull();
    expect(billingStartedAt({})).toBeNull();
  });
});

describe("planState", () => {
  const started = new Date(STARTED);
  const base = { createdAt: AFTER_START, billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null };

  it("exempt: billingExempt wins over everything", () => {
    expect(planState({ ...base, billingExempt: true }, NOW, started)).toBe("exempt");
    expect(planState({ ...base, billingExempt: true, plan: "pro", planStatus: "canceled" }, NOW, started)).toBe("exempt");
  });

  it("exempt: a workspace created before BILLING_STARTED_AT, whatever its columns say", () => {
    const before = new Date(started.getTime() - 1);
    expect(planState({ ...base, createdAt: before }, NOW, started)).toBe("exempt");
    expect(planState({ ...base, createdAt: before, plan: "pro", planStatus: "canceled" }, NOW, started)).toBe("exempt");
    // Created at the very moment: not before, so counted.
    expect(planState({ ...base, createdAt: started }, NOW, started)).toBe("ended");
  });

  it("exempt: a row without its creation date is never caught", () => {
    expect(planState({ billingExempt: false }, NOW, started)).toBe("exempt");
  });

  it("active: a plan that is active or trialing", () => {
    expect(planState({ ...base, plan: "growth", planStatus: "active" }, NOW, started)).toBe("active");
    expect(planState({ ...base, plan: "growth", planStatus: "trialing" }, NOW, started)).toBe("active");
  });

  it("active: past_due for 7 days after the period end, then ended", () => {
    const end = new Date("2026-12-05T00:00:00Z");
    const pastDue = { ...base, plan: "starter", planStatus: "past_due", currentPeriodEnd: end };
    expect(planState(pastDue, new Date(end.getTime() + 7 * DAY - 1), started)).toBe("active");
    expect(planState(pastDue, new Date(end.getTime() + 7 * DAY), started)).toBe("ended");
    expect(planState({ ...pastDue, currentPeriodEnd: null }, NOW, started)).toBe("ended");
  });

  it("ended: a plan cancelled, unpaid, or with an unknown status", () => {
    for (const status of ["canceled", "unpaid", "incomplete_expired", "something_new", null]) {
      expect(planState({ ...base, plan: "pro", planStatus: status }, NOW, started), String(status)).toBe("ended");
    }
  });

  it("trial: no plan and the trial end in the future; ended at that very second", () => {
    expect(planState({ ...base, trialEndsAt: new Date(NOW.getTime() + 1000) }, NOW, started)).toBe("trial");
    expect(planState({ ...base, trialEndsAt: NOW }, NOW, started)).toBe("ended");
    expect(planState({ ...base, trialEndsAt: new Date(NOW.getTime() - 1000) }, NOW, started)).toBe("ended");
  });

  it("ended: no plan and no trial", () => {
    expect(planState(base, NOW, started)).toBe("ended");
  });

  it("accepts dates as strings, as a memoized job step returns them", () => {
    expect(
      planState(
        { ...base, createdAt: AFTER_START.toISOString(), trialEndsAt: new Date(NOW.getTime() + DAY).toISOString() },
        NOW,
        started,
      ),
    ).toBe("trial");
  });

  it("without a start date, every workspace is judged by its columns", () => {
    expect(planState({ ...base, createdAt: new Date("2020-01-01T00:00:00Z") }, NOW, null)).toBe("ended");
  });
});

describe("trialDays", () => {
  it("defaults to 14 and stays within 1 to 90", () => {
    expect(trialDays({})).toBe(14);
    expect(trialDays({ BILLING_TRIAL_DAYS: "30" })).toBe(30);
    expect(trialDays({ BILLING_TRIAL_DAYS: "0" })).toBe(1);
    expect(trialDays({ BILLING_TRIAL_DAYS: "1" })).toBe(1);
    expect(trialDays({ BILLING_TRIAL_DAYS: "90" })).toBe(90);
    expect(trialDays({ BILLING_TRIAL_DAYS: "91" })).toBe(90);
    expect(trialDays({ BILLING_TRIAL_DAYS: "-5" })).toBe(14);
    expect(trialDays({ BILLING_TRIAL_DAYS: "7.5" })).toBe(14);
    expect(trialDays({ BILLING_TRIAL_DAYS: "two weeks" })).toBe(14);
  });
});

describe("newWorkspaceBillingData", () => {
  it("is empty with billing off, so a workspace is created exactly as today", () => {
    expect(newWorkspaceBillingData(NOW, {})).toEqual({});
    expect(newWorkspaceBillingData(NOW, { BILLING_ENABLED: "true" })).toEqual({});
  });

  it("with billing on, starts a trial of BILLING_TRIAL_DAYS and is not exempt", () => {
    expect(newWorkspaceBillingData(NOW, ON)).toEqual({
      trialEndsAt: new Date(NOW.getTime() + 14 * DAY),
      billingExempt: false,
    });
    expect(newWorkspaceBillingData(NOW, { ...ON, BILLING_TRIAL_DAYS: "3" })).toEqual({
      trialEndsAt: new Date(NOW.getTime() + 3 * DAY),
      billingExempt: false,
    });
  });
});

describe("billingFieldsSelect", () => {
  it("adds nothing to a query with billing off, and the billing columns with it on", () => {
    expect(billingFieldsSelect({})).toEqual({});
    expect(billingFieldsSelect(ON)).toEqual(BILLING_FIELDS_SELECT);
    expect(BILLING_FIELDS_SELECT).toEqual({
      createdAt: true,
      billingExempt: true,
      plan: true,
      planStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
    });
  });
});
