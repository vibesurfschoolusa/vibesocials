import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock } = vi.hoisted(() => ({ getWorkspaceContextMock: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));

import { SUPPORT_EMAIL } from "@/lib/siteInfo";

import {
  MISSING_WORKSPACE_ID_CODE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";
import { GET } from "./route";

/** R32: a read from a page drawn for `workspaceId` (the mock's own by default; null sends none). */
function req(workspaceId: string | null = "ws-1", query = ""): Request {
  const address = new URL(`http://localhost/api/workspaces/status${query}`);
  if (workspaceId !== null) address.searchParams.set("workspaceId", workspaceId);
  return new Request(address);
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
});

// R32 lead follow-up: a page drawn for another workspace (another tab
// switched) gets the switch sentence; a page that sent no id, the reload one.
describe("GET /api/workspaces/status - the page's workspace", () => {
  beforeEach(() => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  });

  it("409s another workspace's id and reads nothing", async () => {
    const res = await GET(req("ws-2"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: WORKSPACE_CHANGED_SAVE_MESSAGE, code: WORKSPACE_CHANGED_CODE });

  });

  it("400s a page that sent no id and reads nothing", async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(MISSING_WORKSPACE_ID_CODE);

  });
});

describe("GET /api/workspaces/status", () => {
  it("is 401 when signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("gives no message for a workspace that is not paused", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
    const response = await GET(req());
    expect(await response.json()).toEqual({ blockedMessage: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("gives the pause message for a paused one, and nothing else about it", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ pausedAt: new Date("2026-11-10T08:00:00Z"), pausedReason: "Unpaid invoice." }),
    );
    expect(await (await GET(req())).json()).toEqual({
      blockedMessage: `This workspace is paused: Unpaid invoice. Contact ${SUPPORT_EMAIL}.`,
    });
  });

  it("says nothing about an unconfirmed address with billing off", async () => {
    const base = makeWorkspaceContext();
    getWorkspaceContextMock.mockResolvedValue({ ...base, user: { ...base.user, emailVerifiedAt: null, googleLinkedAt: null } });
    expect(await (await GET(req())).json()).toEqual({ blockedMessage: null });
  });
});
