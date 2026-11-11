import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock } = vi.hoisted(() => ({ getWorkspaceContextMock: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));

import { SUPPORT_EMAIL } from "@/lib/siteInfo";

import { GET } from "./route";

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
});

describe("GET /api/workspaces/status", () => {
  it("is 401 when signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("gives no message for a workspace that is not paused", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
    const response = await GET();
    expect(await response.json()).toEqual({ blockedMessage: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("gives the pause message for a paused one, and nothing else about it", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ pausedAt: new Date("2026-11-10T08:00:00Z"), pausedReason: "Unpaid invoice." }),
    );
    expect(await (await GET()).json()).toEqual({
      blockedMessage: `This workspace is paused: Unpaid invoice. Contact ${SUPPORT_EMAIL}.`,
    });
  });

  it("says nothing about an unconfirmed address with billing off", async () => {
    const base = makeWorkspaceContext();
    getWorkspaceContextMock.mockResolvedValue({ ...base, user: { ...base.user, emailVerifiedAt: null, googleLinkedAt: null } });
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
  });
});
