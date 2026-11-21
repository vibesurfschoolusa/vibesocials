import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: vi.fn() } } }));

import { X_TEXT_EMPTY_MESSAGE, xTextEmptyRefusal } from "@/lib/xTextRefusal";

const workspace = { id: "ws-1" };

describe("xTextEmptyRefusal", () => {
  // R63 pages-a L1: POST keeps its sentence, which can offer to leave X out.
  it("POST's sentence is as before", async () => {
    expect(X_TEXT_EMPTY_MESSAGE).toBe(
      "X removes @mentions from posts sent through its API, so this post has no text left for X. Add some words, or leave X out.",
    );
    await expect(
      xTextEmptyRefusal({ baseCaption: "@surfshop", xOverride: null, workspace, targetPlatforms: ["x"] }),
    ).resolves.toBe(X_TEXT_EMPTY_MESSAGE);
  });
});
