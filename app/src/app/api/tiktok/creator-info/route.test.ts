import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  findFirst: vi.fn(),
  ensureFreshTikTokToken: vi.fn(),
  getTikTokCreatorInfo: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: h.getWorkspaceContext }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: h.findFirst } } }));
vi.mock("@/server/platforms/tiktokClient", () => ({
  TIKTOK_CREATOR_CANNOT_POST: "TIKTOK_CREATOR_CANNOT_POST",
  ensureFreshTikTokToken: h.ensureFreshTikTokToken,
  getTikTokCreatorInfo: h.getTikTokCreatorInfo,
}));

import { GET } from "./route";

function as(role: "owner" | "member") {
  h.getWorkspaceContext.mockResolvedValue({ user: { id: "u1" }, workspace: { id: "ws-1" }, role });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findFirst.mockResolvedValue({ id: "c1", platform: "tiktok", accessToken: "t" });
  h.ensureFreshTikTokToken.mockRejectedValue(Object.assign(new Error("expired"), { code: "TIKTOK_RECONNECT_REQUIRED" }));
});

// R12 sweep: Create's TikTok panel shows this answer as is; only an owner can reconnect.
describe("GET /api/tiktok/creator-info when TikTok needs reconnecting", () => {
  it("an owner: reconnect in Settings, as before", async () => {
    as("owner");
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Reconnect TikTok in Settings to keep posting.",
      code: "TIKTOK_RECONNECT_REQUIRED",
    });
  });

  it("a member: who can reconnect it", async () => {
    as("member");
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "The workspace owner can reconnect TikTok to keep posting.",
      code: "TIKTOK_RECONNECT_REQUIRED",
    });
  });
});
