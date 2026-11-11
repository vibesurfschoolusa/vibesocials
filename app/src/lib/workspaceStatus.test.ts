import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL } from "./siteInfo";
import {
  WORKSPACE_PAUSED_CODE,
  workspaceBlock,
  workspaceBlockResponse,
  workspacePausedMessage,
} from "./workspaceStatus";

describe("workspaceBlock", () => {
  it("is null for a workspace that is not paused", () => {
    expect(workspaceBlock({ pausedAt: null, pausedReason: null })).toBeNull();
    expect(workspaceBlock({ pausedAt: null, pausedReason: "left over" })).toBeNull();
  });

  it("refuses a paused workspace with the reason and the support address", () => {
    expect(
      workspaceBlock({ pausedAt: new Date("2026-11-10T00:00:00Z"), pausedReason: "Unpaid invoice." }),
    ).toEqual({
      code: WORKSPACE_PAUSED_CODE,
      message: `This workspace is paused: Unpaid invoice. Contact ${SUPPORT_EMAIL}.`,
    });
    expect(WORKSPACE_PAUSED_CODE).toBe("WORKSPACE_PAUSED");
  });

  it("still refuses when a paused workspace has no reason stored", () => {
    const block = workspaceBlock({ pausedAt: new Date(), pausedReason: null });
    expect(block?.code).toBe("WORKSPACE_PAUSED");
    expect(block?.message).toBe(`This workspace is paused. Contact ${SUPPORT_EMAIL}.`);
  });

  it("accepts a date string, as a memoized job step returns it", () => {
    expect(workspaceBlock({ pausedAt: "2026-11-10T00:00:00.000Z", pausedReason: "x" })?.code).toBe(
      "WORKSPACE_PAUSED",
    );
  });

  it("treats missing fields as not paused (an old memoized row)", () => {
    expect(workspaceBlock({})).toBeNull();
  });
});

describe("workspacePausedMessage", () => {
  it("ends the reason with a full stop when it has none", () => {
    expect(workspacePausedMessage("Spam reports")).toBe(
      `This workspace is paused: Spam reports. Contact ${SUPPORT_EMAIL}.`,
    );
  });
});

describe("workspaceBlockResponse", () => {
  it("is null when not paused", () => {
    expect(workspaceBlockResponse({ pausedAt: null, pausedReason: null })).toBeNull();
  });

  it("answers 403 with the message and code when paused", async () => {
    const response = workspaceBlockResponse({ pausedAt: new Date(), pausedReason: "Abuse." });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: `This workspace is paused: Abuse. Contact ${SUPPORT_EMAIL}.`,
      code: "WORKSPACE_PAUSED",
    });
  });
});
