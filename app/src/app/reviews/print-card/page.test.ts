import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: vi.fn() }));
vi.mock("@/server/googleReviews", () => ({ savedNewReviewUri: vi.fn() }));

import { metadata } from "./page";

// R5 pages L11.
describe("print card page", () => {
  it("names the tab", () => {
    expect(metadata.title).toBe("Review card | Vibe Socials");
  });
});
