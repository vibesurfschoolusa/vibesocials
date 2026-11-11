import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 21a: POST exempt and POST trial, shaped exactly like the limits route. */

const h = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  setBillingExempt: vi.fn(),
  setTrialEndsAt: vi.fn(),
}));

vi.mock("@/lib/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator")>()),
  requireOperator: h.requireOperator,
}));
vi.mock("@/server/admin/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin/actions")>()),
  setBillingExempt: h.setBillingExempt,
  setTrialEndsAt: h.setTrialEndsAt,
}));

import { adminNotFoundResponse, adminOtherMethods } from "@/lib/operator";

import * as exemptRoute from "./exempt/route";
import * as trialRoute from "./trial/route";

const OPS = { userId: "op-1", email: "ops@example.com" };
const ctx = { params: Promise.resolve({ id: "ws-1" }) };
const NOW = new Date("2026-11-10T12:00:00Z");

function req(body: unknown) {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.requireOperator.mockResolvedValue(OPS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

it("both count against the operator's change budget and re-export the other methods as the 404", async () => {
  h.setBillingExempt.mockResolvedValue({ status: "unchanged" });
  h.setTrialEndsAt.mockResolvedValue({ status: "unchanged" });
  await exemptRoute.POST(req({ exempt: true }), ctx);
  await trialRoute.POST(req({ trialEndsAt: null }), ctx);
  expect(h.requireOperator.mock.calls).toEqual([["change"], ["change"]]);
  for (const mod of [exemptRoute, trialRoute] as Record<string, unknown>[]) {
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      expect(mod[method]).toBe(adminOtherMethods[method]);
    }
  }
});

it("a non-operator gets the plain 404 and nothing is written", async () => {
  h.requireOperator.mockImplementation(async () => adminNotFoundResponse());
  for (const response of [
    await exemptRoute.POST(req({ exempt: true }), ctx),
    await trialRoute.POST(req({ trialEndsAt: "2026-11-20" }), ctx),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  }
  expect(h.setBillingExempt).not.toHaveBeenCalled();
  expect(h.setTrialEndsAt).not.toHaveBeenCalled();
});

describe("POST exempt", () => {
  it("validates the body before writing", async () => {
    expect((await exemptRoute.POST(req({ exempt: "yes" }), ctx)).status).toBe(400);
    expect((await exemptRoute.POST(req("not json"), ctx)).status).toBe(400);
    expect(h.setBillingExempt).not.toHaveBeenCalled();
  });

  it("writes the change as the operator", async () => {
    h.setBillingExempt.mockResolvedValue({ status: "changed" });
    const response = await exemptRoute.POST(req({ exempt: true }), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(h.setBillingExempt).toHaveBeenCalledWith({ operator: OPS, workspaceId: "ws-1", exempt: true });
  });

  it("answers the plain 404 for a workspace that does not exist", async () => {
    h.setBillingExempt.mockResolvedValue({ status: "not_found" });
    const response = await exemptRoute.POST(req({ exempt: false }), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("POST trial", () => {
  it("refuses a date more than 90 days ahead, or in the past, before writing", async () => {
    const far = await trialRoute.POST(req({ trialEndsAt: "2027-02-09" }), ctx);
    expect(far.status).toBe(400);
    expect(await far.json()).toEqual({ error: "Pick a date at most 90 days ahead (8 February 2027 or earlier)." });
    expect((await trialRoute.POST(req({ trialEndsAt: "2026-11-01" }), ctx)).status).toBe(400);
    expect(h.setTrialEndsAt).not.toHaveBeenCalled();
  });

  it("sets the end of the chosen UTC day, as the operator", async () => {
    h.setTrialEndsAt.mockResolvedValue({ status: "changed" });
    const response = await trialRoute.POST(req({ trialEndsAt: "2026-11-24" }), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(h.setTrialEndsAt).toHaveBeenCalledWith({
      operator: OPS,
      workspaceId: "ws-1",
      trialEndsAt: new Date("2026-11-24T23:59:59.999Z"),
    });
  });

  it("clears it", async () => {
    h.setTrialEndsAt.mockResolvedValue({ status: "unchanged" });
    expect(await (await trialRoute.POST(req({ trialEndsAt: null }), ctx)).json()).toEqual({ ok: true, changed: false });
    expect(h.setTrialEndsAt).toHaveBeenCalledWith({ operator: OPS, workspaceId: "ws-1", trialEndsAt: null });
  });

  it("answers the plain 404 for a workspace that does not exist", async () => {
    h.setTrialEndsAt.mockResolvedValue({ status: "not_found" });
    expect((await trialRoute.POST(req({ trialEndsAt: null }), ctx)).status).toBe(404);
  });
});
