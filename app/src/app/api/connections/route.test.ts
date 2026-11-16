import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceContextMock, findManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { findMany: findManyMock } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";
import { GET } from "./route";

/** R32: a read from a page drawn for `workspaceId` (the mock's own by default; null sends none). */
function req(workspaceId: string | null = "ws-1", query = ""): Request {
  const address = new URL(`http://localhost/api/connections${query}`);
  if (workspaceId !== null) address.searchParams.set("workspaceId", workspaceId);
  return new Request(address);
}

const SEVEN = [
  "tiktok",
  "youtube",
  "x",
  "linkedin",
  "instagram",
  "google_business_profile",
  "facebook_page",
];

async function platformsOf(response: Response): Promise<string[]> {
  const body = (await response.json()) as { connections: Array<{ platform: string }> };
  return body.connections.map((connection) => connection.platform);
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" } });
  findManyMock.mockReset();
  findManyMock.mockResolvedValue([]);
  for (const key of ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET", "PINTEREST_REDIRECT_URI"]) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// GET /api/connections feeds the dashboard's connection list and the composer.
// R32 publishing L1: a page drawn for another workspace (another tab switched)
// gets the switch sentence, never this workspace's numbers.
describe("GET /api/connections - the page's workspace", () => {
  it("409s another workspace's id and reads nothing", async () => {
    const res = await GET(req("ws-2"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: WORKSPACE_CHANGED_SAVE_MESSAGE, code: WORKSPACE_CHANGED_CODE });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  // R32 lead follow-up: Create sends its id too, so a missing one is the reload sentence, as for the writes.
  it("400s a page that sent no id and reads nothing", async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MISSING_WORKSPACE_ID");
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/connections", () => {
  it("401s when signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    expect((await GET(req())).status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("reports each platform's status for the active workspace, never any connection detail", async () => {
    findManyMock.mockResolvedValue([
      { platform: "youtube", needsReconnect: false },
      { platform: "x", needsReconnect: true },
    ]);

    const body = (await (await GET(req())).json()) as {
      connections: Array<{ platform: string; connected: boolean; needsReconnect: boolean }>;
    };

    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      select: { platform: true, needsReconnect: true, expiresAt: true, refreshToken: true },
    });
    expect(body.connections.find((c) => c.platform === "youtube")).toEqual({
      platform: "youtube",
      connected: true,
      needsReconnect: false,
      expiry: null,
    });
    expect(body.connections.find((c) => c.platform === "x")).toEqual({
      platform: "x",
      connected: true,
      needsReconnect: true,
      expiry: null,
    });
    expect(body.connections.find((c) => c.platform === "tiktok")).toEqual({
      platform: "tiktok",
      connected: false,
      needsReconnect: false,
      expiry: null,
    });
  });

  // 2026-11-10: Pinterest's code ships before Pinterest approves the app. The
  // dashboard must not count, or offer, a platform nobody can connect yet.
  it("leaves Pinterest out while this deployment has no Pinterest app", async () => {
    expect((await platformsOf(await GET(req()))).sort()).toEqual([...SEVEN].sort());
  });

  it("lists Pinterest once its app credentials are set", async () => {
    vi.stubEnv("PINTEREST_APP_ID", "1234567");
    vi.stubEnv("PINTEREST_APP_SECRET", "shh");
    vi.stubEnv("PINTEREST_REDIRECT_URI", "https://app.example.com/api/auth/pinterest/callback");

    expect(await platformsOf(await GET(req()))).toContain("pinterest");
  });

  it("still lists a Pinterest connection the workspace already has, so it can be seen and removed", async () => {
    findManyMock.mockResolvedValue([{ platform: "pinterest", needsReconnect: true }]);

    const body = (await (await GET(req())).json()) as {
      connections: Array<{ platform: string; connected: boolean; needsReconnect: boolean }>;
    };

    expect(body.connections.find((c) => c.platform === "pinterest")).toEqual({
      platform: "pinterest",
      connected: true,
      needsReconnect: true,
      expiry: null,
    });
  });

  // R7-pages L4 / client-journey L3: the dashboard widget shows the warning window and the end too.
  it("says when a connection ends soon or has ended, and never sends the token", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    findManyMock.mockResolvedValue([
      { platform: "linkedin", needsReconnect: false, expiresAt: new Date(now + 2 * day), refreshToken: null },
      { platform: "x", needsReconnect: false, expiresAt: new Date(now - day), refreshToken: null },
      { platform: "youtube", needsReconnect: false, expiresAt: new Date(now + day), refreshToken: "sealed-secret" },
    ]);

    const response = await GET(req());
    const text = await response.text();
    const body = JSON.parse(text) as { connections: Array<{ platform: string; expiry: string | null }> };

    expect(body.connections.find((c) => c.platform === "linkedin")?.expiry).toBe("ends_soon");
    expect(body.connections.find((c) => c.platform === "x")?.expiry).toBe("ended");
    expect(body.connections.find((c) => c.platform === "youtube")?.expiry).toBeNull();
    expect(text).not.toContain("sealed-secret");
    expect(text).not.toContain("expiresAt");
  });
});
