import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: vi.fn() } } }));

import {
  X_TEXT_EMPTY_DRAFT_EDIT_MESSAGE,
  X_TEXT_EMPTY_EDIT_MESSAGE,
  X_TEXT_EMPTY_MESSAGE,
  xTextEmptyRefusal,
} from "@/lib/xTextRefusal";

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

  // R64 pages-a L1: a draft card offers Delete, not Cancel, so a draft's step names Delete.
  it("a draft's edit names deleting the draft", async () => {
    expect(X_TEXT_EMPTY_DRAFT_EDIT_MESSAGE).toBe(
      "X removes @mentions from posts sent through its API, so this post would have no text for X. Add some words to the caption or to X's own caption. To post without X, delete this draft and create it again without X.",
    );
    await expect(
      xTextEmptyRefusal({ baseCaption: "@surfshop", xOverride: null, workspace, targetPlatforms: ["x"], editing: "draft" }),
    ).resolves.toBe(X_TEXT_EMPTY_DRAFT_EDIT_MESSAGE);
  });

  it("a scheduled post's edit still names cancelling it", async () => {
    expect(X_TEXT_EMPTY_EDIT_MESSAGE).toBe(
      "X removes @mentions from posts sent through its API, so this post would have no text for X. Add some words to the caption or to X's own caption. To post without X, cancel this post and create it again without X.",
    );
    await expect(
      xTextEmptyRefusal({
        baseCaption: "@surfshop",
        xOverride: null,
        workspace,
        targetPlatforms: ["x"],
        editing: "scheduled",
      }),
    ).resolves.toBe(X_TEXT_EMPTY_EDIT_MESSAGE);
  });
});
