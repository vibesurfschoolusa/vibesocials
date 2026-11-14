import { describe, expect, it } from "vitest";

import {
  INVALID_WORKSPACE_ID_CODE,
  MISSING_WORKSPACE_ID_CODE,
  MISSING_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
  renderedWorkspaceRefusal,
  withWorkspaceId,
} from "./workspaceChanged";

// F3 (R1 security H1): owner writes carry the workspace id their page was
// rendered for, and a request without it, or with another one, is refused.
describe("renderedWorkspaceRefusal", () => {
  it("lets the request on when the id is the active workspace", () => {
    expect(renderedWorkspaceRefusal("ws-1", "ws-1")).toBeNull();
  });

  it("409s another workspace's id with the reload sentence", async () => {
    const refusal = renderedWorkspaceRefusal("ws-2", "ws-1");
    expect(refusal?.status).toBe(409);
    await expect(refusal?.json()).resolves.toEqual({
      error: WORKSPACE_CHANGED_SAVE_MESSAGE,
      code: WORKSPACE_CHANGED_CODE,
    });
  });

  it.each([undefined, null, ""])("400s a missing id (%s): the page is from before the id was sent", async (sent) => {
    const refusal = renderedWorkspaceRefusal(sent, "ws-1");
    expect(refusal?.status).toBe(400);
    await expect(refusal?.json()).resolves.toEqual({
      error: MISSING_WORKSPACE_ID_MESSAGE,
      code: MISSING_WORKSPACE_ID_CODE,
    });
  });

  it.each([7, true, ["ws-1"], { id: "ws-1" }])("400s an id that is not text (%j)", async (sent) => {
    const refusal = renderedWorkspaceRefusal(sent, "ws-1");
    expect(refusal?.status).toBe(400);
    await expect(refusal?.json()).resolves.toMatchObject({ code: INVALID_WORKSPACE_ID_CODE });
  });

  it("says what to do next", () => {
    expect(WORKSPACE_CHANGED_SAVE_MESSAGE).toBe("You switched workspace in another tab. Reload this page, then try again.");
    expect(MISSING_WORKSPACE_ID_MESSAGE).toBe("This page is out of date. Reload it, then try again.");
  });
});

describe("withWorkspaceId", () => {
  it("adds the id to an address without a query", () => {
    expect(withWorkspaceId("/api/auth/youtube/start", "ws-1")).toBe("/api/auth/youtube/start?workspaceId=ws-1");
  });

  it("adds it after an existing query", () => {
    expect(withWorkspaceId("/api/auth/linkedin/start?vanity_name=acme", "ws-1")).toBe(
      "/api/auth/linkedin/start?vanity_name=acme&workspaceId=ws-1",
    );
  });

  it("encodes the id", () => {
    expect(withWorkspaceId("/x", "a b&c")).toBe("/x?workspaceId=a%20b%26c");
  });
});
