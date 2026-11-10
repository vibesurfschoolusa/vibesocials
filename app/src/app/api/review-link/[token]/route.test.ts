import { beforeEach, describe, expect, it, vi } from "vitest";

const { findActiveReviewLinkMock, listReviewPostsMock, checkRateLimitMock } = vi.hoisted(() => ({
  findActiveReviewLinkMock: vi.fn(),
  listReviewPostsMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/server/reviewLink", () => ({
  findActiveReviewLink: findActiveReviewLinkMock,
  listReviewPosts: listReviewPostsMock,
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

import { REVIEW_LINK_INACTIVE_MESSAGE } from "@/lib/reviewLink";

import { GET } from "./route";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", workspaceName: "Surf Co" };
const POST = {
  id: "post-1",
  scheduledFor: "2026-11-12T15:00:00.000Z",
  platforms: ["Instagram"],
  caption: "Dawn patrol",
  platformCaptions: [],
  media: null,
  mediaCount: 1,
  state: "none",
  note: null,
};

function call(token = TOKEN, ip = "203.0.113.7") {
  return GET(
    new Request(`http://localhost/api/review-link/${token}`, {
      headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
    }),
    { params: Promise.resolve({ token }) },
  );
}

beforeEach(() => {
  findActiveReviewLinkMock.mockReset();
  listReviewPostsMock.mockReset();
  checkRateLimitMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findActiveReviewLinkMock.mockResolvedValue(LINK);
  listReviewPostsMock.mockResolvedValue([POST]);
});

describe("GET /api/review-link/[token]", () => {
  it("lists the link's workspace's posts and nothing about the link or the workspace", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ posts: [POST] });
    expect(findActiveReviewLinkMock).toHaveBeenCalledWith(TOKEN);
    expect(listReviewPostsMock).toHaveBeenCalledWith("ws-1", expect.any(Date));
    expect(JSON.stringify(body)).not.toContain("link-1");
    expect(JSON.stringify(body)).not.toContain("ws-1");
  });

  it("answers an unknown and a revoked link identically", async () => {
    // findActiveReviewLink gives null for both (src/server/reviewLink.test.ts).
    findActiveReviewLinkMock.mockResolvedValue(null);
    const unknown = await call("unknown");
    const revoked = await call(TOKEN);

    expect(unknown.status).toBe(404);
    expect(revoked.status).toBe(404);
    const [a, b] = [await unknown.json(), await revoked.json()];
    expect(a).toEqual({ error: REVIEW_LINK_INACTIVE_MESSAGE });
    expect(b).toEqual(a);
    expect(listReviewPostsMock).not.toHaveBeenCalled();
  });

  it("counts 120 an hour per address, shared with the decision route, and fails closed", async () => {
    await call();
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "ip:203.0.113.7",
      route: "review-link/ip",
      limit: 120,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });
  });

  it("refuses over the limit before looking the link up", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });

    const response = await call();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(findActiveReviewLinkMock).not.toHaveBeenCalled();
    expect(listReviewPostsMock).not.toHaveBeenCalled();
  });

  it("answers 500 without detail when the list cannot be read", async () => {
    listReviewPostsMock.mockRejectedValue(new Error("db down at 10.0.0.5"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.5");
  });
});
