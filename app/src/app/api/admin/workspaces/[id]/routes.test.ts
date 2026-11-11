import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  after: vi.fn(),
  setWorkspaceLimits: vi.fn(),
  pauseWorkspace: vi.fn(),
  resumeWorkspace: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/lib/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator")>()),
  requireOperator: h.requireOperator,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: h.after,
}));
vi.mock("@/server/admin/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin/actions")>()),
  setWorkspaceLimits: h.setWorkspaceLimits,
  pauseWorkspace: h.pauseWorkspace,
  resumeWorkspace: h.resumeWorkspace,
}));
vi.mock("@/server/admin/pauseEmail", () => ({ notifyOwnersOfPauseChange: h.notify }));

import { POST as limits } from "./limits/route";
import { POST as pause } from "./pause/route";
import { POST as resume } from "./resume/route";

const OPS = { userId: "op-1", email: "ops@example.com" };
const ctx = { params: Promise.resolve({ id: "ws-1" }) };

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
  h.notify.mockResolvedValue(undefined);
});

it("every change route counts against the operator's change budget", async () => {
  h.setWorkspaceLimits.mockResolvedValue({ status: "unchanged" });
  h.pauseWorkspace.mockResolvedValue({ status: "unchanged" });
  h.resumeWorkspace.mockResolvedValue({ status: "unchanged" });
  await limits(req({ limitPostsPerDay: 1 }), ctx);
  await pause(req({ reason: "r" }), ctx);
  await resume(req({}), ctx);
  expect(h.requireOperator.mock.calls).toEqual([["change"], ["change"], ["change"]]);
});

describe("POST limits", () => {
  it("validates the body before writing", async () => {
    const response = await limits(req({ limitPostsPerDay: -1 }), ctx);
    expect(response.status).toBe(400);
    expect(h.setWorkspaceLimits).not.toHaveBeenCalled();
    expect((await limits(req("not json"), ctx)).status).toBe(400);
  });

  it("writes the change as the operator", async () => {
    h.setWorkspaceLimits.mockResolvedValue({ status: "changed" });
    const response = await limits(req({ limitPostsPerDay: 5, limitStorageMb: null }), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(h.setWorkspaceLimits).toHaveBeenCalledWith({
      operator: OPS,
      workspaceId: "ws-1",
      limits: { limitPostsPerDay: 5, limitStorageMb: null },
    });
  });

  it("answers the plain 404 for a workspace that does not exist", async () => {
    h.setWorkspaceLimits.mockResolvedValue({ status: "not_found" });
    const response = await limits(req({ limitPostsPerDay: 5 }), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("POST pause", () => {
  it("requires a reason", async () => {
    const response = await pause(req({ reason: "" }), ctx);
    expect(response.status).toBe(400);
    expect(h.pauseWorkspace).not.toHaveBeenCalled();
  });

  it("pauses and emails the owners once, after the response", async () => {
    h.pauseWorkspace.mockResolvedValue({ status: "changed", actionId: "act-1", workspaceName: "Surf Co" });
    const response = await pause(req({ reason: " Unpaid invoice. " }), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(h.pauseWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ operator: OPS, workspaceId: "ws-1", reason: "Unpaid invoice." }),
    );
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.after).toHaveBeenCalledTimes(1);
    await h.after.mock.calls[0][0]();
    expect(h.notify).toHaveBeenCalledWith({
      actionId: "act-1",
      kind: "pause",
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      reason: "Unpaid invoice.",
    });
  });

  it("emails nobody when the workspace was already paused", async () => {
    h.pauseWorkspace.mockResolvedValue({ status: "unchanged" });
    const response = await pause(req({ reason: "Again." }), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: false });
    expect(h.after).not.toHaveBeenCalled();
  });
});

describe("POST resume", () => {
  it("resumes and emails the owners once, after the response", async () => {
    h.resumeWorkspace.mockResolvedValue({ status: "changed", actionId: "act-2", workspaceName: "Surf Co" });
    const response = await resume(req({}), ctx);
    expect(await response.json()).toEqual({ ok: true, changed: true });
    expect(h.after).toHaveBeenCalledTimes(1);
    await h.after.mock.calls[0][0]();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume", actionId: "act-2" }));
  });

  it("emails nobody when the workspace was not paused", async () => {
    h.resumeWorkspace.mockResolvedValue({ status: "unchanged" });
    expect(await (await resume(req({}), ctx)).json()).toEqual({ ok: true, changed: false });
    expect(h.after).not.toHaveBeenCalled();
  });

  it("answers the plain 404 for a workspace that does not exist", async () => {
    h.resumeWorkspace.mockResolvedValue({ status: "not_found" });
    expect((await resume(req({}), ctx)).status).toBe(404);
  });
});
