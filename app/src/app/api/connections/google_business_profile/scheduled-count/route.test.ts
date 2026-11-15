import { readdirSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { Platform } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The app router serves a static segment before [platform] and never falls
// back, so /api/connections/google_business_profile/scheduled-count needs its
// own route. It must answer exactly like the dynamic one.
const { getWorkspaceContextMock, findManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({ prisma: { postJob: { findMany: findManyMock } } }));

import { GET as dynamicGET } from "../../[platform]/scheduled-count/route";
import { GET } from "./route";

const URL_BASE = "http://localhost/api/connections/google_business_profile/scheduled-count";

async function both(query: string) {
  const fixed = await GET(new NextRequest(`${URL_BASE}${query}`));
  const dynamic = await dynamicGET(new NextRequest(`${URL_BASE}${query}`), {
    params: Promise.resolve({ platform: "google_business_profile" }),
  });
  return [
    { status: fixed.status, body: await fixed.json() },
    { status: dynamic.status, body: await dynamic.json() },
  ];
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  findManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
  findManyMock.mockResolvedValue([
    { id: "a", storyOfPostJobId: null },
    { id: "b", storyOfPostJobId: null },
  ]);
});

describe("GET /api/connections/google_business_profile/scheduled-count", () => {
  it("answers like the dynamic route: the count, a stale tab, a missing workspace id", async () => {
    for (const query of ["?workspaceId=ws-1", "?workspaceId=ws-2", ""]) {
      const [fixed, dynamic] = await both(query);
      expect(fixed).toEqual(dynamic);
    }
    const [fixed] = await both("?workspaceId=ws-1");
    expect(fixed).toEqual({ status: 200, body: { count: 2 } });
  });

  it("counts Google Business Profile posts", async () => {
    await GET(new NextRequest(`${URL_BASE}?workspaceId=ws-1`));
    expect(findManyMock.mock.calls[0][0].where.publishMetadata).toEqual({
      path: ["targetPlatforms"],
      array_contains: ["google_business_profile"],
    });
  });

  it("answers 401 signed out, like the dynamic route", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const [fixed, dynamic] = await both("?workspaceId=ws-1");
    expect(fixed).toEqual(dynamic);
    expect(fixed.status).toBe(401);
  });
});

// Any other platform that gets a static folder here would shadow [platform]
// the same way, so each one must carry its own scheduled-count route.
describe("static platform folders under /api/connections", () => {
  it("each has a scheduled-count route", () => {
    const root = join(__dirname, "..", "..");
    const platforms = Object.values(Platform) as string[];
    const staticPlatformFolders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && platforms.includes(entry.name))
      .map((entry) => entry.name);
    expect(staticPlatformFolders).toEqual(["google_business_profile"]);
    for (const folder of staticPlatformFolders) {
      const files = readdirSync(join(root, folder, "scheduled-count"));
      expect(files).toContain("route.ts");
    }
  });
});
