import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/members/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` at module scope, so both must be mocked before the
// route is imported below.
const { findManyMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { workspaceMember: { findMany: findManyMock } },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import {
  MISSING_WORKSPACE_ID_CODE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";
import { GET } from "./route";

/** R32: a read from a page drawn for `workspaceId` (the mock's own by default; null sends none). */
function req(workspaceId: string | null = "ws-1", query = ""): Request {
  const address = new URL(`http://localhost/api/workspaces/members/roster${query}`);
  if (workspaceId !== null) address.searchParams.set("workspaceId", workspaceId);
  return new Request(address);
}

const MEMBER_CONTEXT = {
  user: { id: "user-2", email: "member@example.com", name: "Member Two" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "member" as const,
  memberCount: 2,
};

beforeEach(() => {
  findManyMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);
});

// R32 lead follow-up: a page drawn for another workspace (another tab
// switched) gets the switch sentence; a page that sent no id, the reload one.
describe("GET /api/workspaces/members/roster - the page's workspace", () => {
  it("409s another workspace's id and reads nothing", async () => {
    const res = await GET(req("ws-2"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: WORKSPACE_CHANGED_SAVE_MESSAGE, code: WORKSPACE_CHANGED_CODE });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("400s a page that sent no id and reads nothing", async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(MISSING_WORKSPACE_ID_CODE);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspaces/members/roster", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const response = await GET(req());
    expect(response.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns names-only roster for a member, ordered by join date", async () => {
    findManyMock.mockResolvedValue([
      { role: "owner", user: { name: "Owner", email: "owner@example.com" } },
      { role: "member", user: { name: null, email: "pat.doe@example.com" } },
    ]);

    const response = await GET(req());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      members: [
        { name: "Owner", role: "owner" },
        { name: "pat.doe", role: "member" }, // email local-part fallback (posts/route.ts rule)
      ],
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("never leaks emails or user ids (SEC-1)", async () => {
    findManyMock.mockResolvedValue([
      { role: "member", user: { name: null, email: "secret.person@example.com" } },
    ]);
    const response = await GET(req());
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain("@example.com");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("userId");
  });

  // R15-new-customer L3: the roster keeps the member rule of the one person
  // label (personLabel(user, false)), so a blank name counts as no name.
  it("a blank name falls back to the part before the @", async () => {
    findManyMock.mockResolvedValue([
      { role: "member", user: { name: "  ", email: "pat.doe@example.com" } },
    ]);
    const response = await GET(req());
    expect((await response.json()).members).toEqual([{ name: "pat.doe", role: "member" }]);
  });

  it("works for owners too (any-member endpoint)", async () => {
    getWorkspaceContextMock.mockResolvedValue({ ...MEMBER_CONTEXT, role: "owner" });
    findManyMock.mockResolvedValue([]);
    const response = await GET(req());
    expect(response.status).toBe(200);
  });
});
