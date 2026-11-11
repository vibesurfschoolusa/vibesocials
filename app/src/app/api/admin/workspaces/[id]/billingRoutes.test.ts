import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 21a (fix round 1): POST exempt ("Exempt this workspace") and POST trial
 * ("Start or change the trial"), shaped exactly like the limits route.
 */

const h = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  exemptWorkspace: vi.fn(),
  startTrial: vi.fn(),
}));

vi.mock("@/lib/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator")>()),
  requireOperator: h.requireOperator,
}));
vi.mock("@/server/admin/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin/actions")>()),
  exemptWorkspace: h.exemptWorkspace,
  startTrial: h.startTrial,
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
  h.exemptWorkspace.mockResolvedValue({ status: "unchanged" });
  h.startTrial.mockResolvedValue({ status: "unchanged" });
  await exemptRoute.POST(req({}), ctx);
  await trialRoute.POST(req({ trialEndsAt: "2026-11-20" }), ctx);
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
    await exemptRoute.POST(req({}), ctx),
    await trialRoute.POST(req({ trialEndsAt: "2026-11-20" }), ctx),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  }
  expect(h.exemptWorkspace).not.toHaveBeenCalled();
  expect(h.startTrial).not.toHaveBeenCalled();
});

describe("POST exempt", () => {
  it("exempts the workspace as the operator; the body says nothing", async () => {
    h.exemptWorkspace.mockResolvedValue({ status: "changed" });
    const response = await exemptRoute.POST(req({ exempt: false }), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(h.exemptWorkspace).toHaveBeenCalledWith({ operator: OPS, workspaceId: "ws-1" });
  });

  it("answers the plain 404 for a workspace that does not exist", async () => {
    h.exemptWorkspace.mockResolvedValue({ status: "not_found" });
    const response = await exemptRoute.POST(req({}), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("POST trial", () => {
  it("refuses a date more than 90 days ahead, in the past, or null, before writing", async () => {
    const far = await trialRoute.POST(req({ trialEndsAt: "2027-02-09" }), ctx);
    expect(far.status).toBe(400);
    expect(await far.json()).toEqual({ error: "Pick a date at most 90 days ahead (8 February 2027 or earlier)." });
    expect((await trialRoute.POST(req({ trialEndsAt: "2026-11-01" }), ctx)).status).toBe(400);
    expect((await trialRoute.POST(req({ trialEndsAt: null }), ctx)).status).toBe(400);
    expect((await trialRoute.POST(req("not json"), ctx)).status).toBe(400);
    expect(h.startTrial).not.toHaveBeenCalled();
  });

  it("starts or changes the trial to the end of the chosen UTC day, as the operator", async () => {
    h.startTrial.mockResolvedValue({ status: "changed" });
    const response = await trialRoute.POST(req({ trialEndsAt: "2026-11-24" }), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(h.startTrial).toHaveBeenCalledWith({
      operator: OPS,
      workspaceId: "ws-1",
      trialEndsAt: new Date("2026-11-24T23:59:59.999Z"),
    });
  });

  it("answers the plain 404 for a workspace that does not exist", async () => {
    h.startTrial.mockResolvedValue({ status: "not_found" });
    expect((await trialRoute.POST(req({ trialEndsAt: "2026-11-24" }), ctx)).status).toBe(404);
  });
});
