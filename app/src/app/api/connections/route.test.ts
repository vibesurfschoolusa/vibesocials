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

import { GET } from "./route";

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
describe("GET /api/connections", () => {
  it("401s when signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    expect((await GET()).status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("reports each platform's status for the active workspace, never any connection detail", async () => {
    findManyMock.mockResolvedValue([
      { platform: "youtube", needsReconnect: false },
      { platform: "x", needsReconnect: true },
    ]);

    const body = (await (await GET()).json()) as {
      connections: Array<{ platform: string; connected: boolean; needsReconnect: boolean }>;
    };

    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      select: { platform: true, needsReconnect: true },
    });
    expect(body.connections.find((c) => c.platform === "youtube")).toEqual({
      platform: "youtube",
      connected: true,
      needsReconnect: false,
    });
    expect(body.connections.find((c) => c.platform === "x")).toEqual({
      platform: "x",
      connected: true,
      needsReconnect: true,
    });
    expect(body.connections.find((c) => c.platform === "tiktok")).toEqual({
      platform: "tiktok",
      connected: false,
      needsReconnect: false,
    });
  });

  // 2026-11-10: Pinterest's code ships before Pinterest approves the app. The
  // dashboard must not count, or offer, a platform nobody can connect yet.
  it("leaves Pinterest out while this deployment has no Pinterest app", async () => {
    expect((await platformsOf(await GET())).sort()).toEqual([...SEVEN].sort());
  });

  it("lists Pinterest once its app credentials are set", async () => {
    vi.stubEnv("PINTEREST_APP_ID", "1234567");
    vi.stubEnv("PINTEREST_APP_SECRET", "shh");
    vi.stubEnv("PINTEREST_REDIRECT_URI", "https://app.example.com/api/auth/pinterest/callback");

    expect(await platformsOf(await GET())).toContain("pinterest");
  });

  it("still lists a Pinterest connection the workspace already has, so it can be seen and removed", async () => {
    findManyMock.mockResolvedValue([{ platform: "pinterest", needsReconnect: true }]);

    const body = (await (await GET()).json()) as {
      connections: Array<{ platform: string; connected: boolean; needsReconnect: boolean }>;
    };

    expect(body.connections.find((c) => c.platform === "pinterest")).toEqual({
      platform: "pinterest",
      connected: true,
      needsReconnect: true,
    });
  });
});
