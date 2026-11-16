import { describe, expect, it } from "vitest";

import {
  INVALID_WORKSPACE_ID_CODE,
  MISSING_WORKSPACE_ID_CODE,
  MISSING_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
  readWorkspaceRefusalText,
  renderedWorkspaceRefusal,
  sentWorkspaceId,
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

  it.each([undefined, ""])("400s a missing id (%s): the page is from before the id was sent", async (sent) => {
    const refusal = renderedWorkspaceRefusal(sent, "ws-1");
    expect(refusal?.status).toBe(400);
    await expect(refusal?.json()).resolves.toEqual({
      error: MISSING_WORKSPACE_ID_MESSAGE,
      code: MISSING_WORKSPACE_ID_CODE,
    });
  });

  // JSON null is a value sent, as POST /api/posts treats it.
  it.each([null, 7, true, ["ws-1"], { id: "ws-1" }])("400s an id that is not text (%j)", async (sent) => {
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

  it("leaves the path as it is for a page that couldn't read its workspace", () => {
    expect(withWorkspaceId("/api/posts?status=completed", null)).toBe("/api/posts?status=completed");
  });

  it("encodes the id", () => {
    expect(withWorkspaceId("/x", "a b&c")).toBe("/x?workspaceId=a%20b%26c");
  });
});

// R31 (lead follow-up): the pages that word a refusal by its code say the
// shared sentence for another workspace, or for a page from before the release.
describe("pageWorkspaceRefusalText", () => {
  it("names the two sentences by code, and nothing for any other code", async () => {
    const { pageWorkspaceRefusalText } = await import("./workspaceChanged");
    expect(pageWorkspaceRefusalText("WORKSPACE_CHANGED")).toBe("You switched workspace in another tab. Reload this page, then try again.");
    expect(pageWorkspaceRefusalText("MISSING_WORKSPACE_ID")).toBe("This page is out of date. Reload it, then try again.");
    expect(pageWorkspaceRefusalText("INVALID_WORKSPACE_ID")).toBe("This page is out of date. Reload it, then try again.");
    expect(pageWorkspaceRefusalText("AI_WORKSPACE_DAILY_LIMIT")).toBeNull();
    expect(pageWorkspaceRefusalText(undefined)).toBeNull();
  });
});

// R32 publishing L1: reads take the page's id from the query, as writes take it from the body.
describe("sentWorkspaceId", () => {
  it("reads ?workspaceId=, and an absent one is undefined (renderedWorkspaceRefusal's 400)", () => {
    expect(sentWorkspaceId(new Request("http://localhost/api/posts?workspaceId=ws-1&status=x"))).toBe("ws-1");
    expect(sentWorkspaceId(new Request("http://localhost/api/posts"))).toBeUndefined();
  });
});

describe("readWorkspaceRefusalText", () => {
  it("gives the shared sentence for a read refused for the page's workspace", async () => {
    const changed = renderedWorkspaceRefusal("ws-2", "ws-1") as Response;
    await expect(readWorkspaceRefusalText(changed)).resolves.toBe(WORKSPACE_CHANGED_SAVE_MESSAGE);
    const missing = renderedWorkspaceRefusal(undefined, "ws-1") as Response;
    await expect(readWorkspaceRefusalText(missing)).resolves.toBe(MISSING_WORKSPACE_ID_MESSAGE);
  });

  it("is null for any other answer, and leaves the body for the caller", async () => {
    const other = Response.json({ error: "Invalid cursor." }, { status: 400 });
    await expect(readWorkspaceRefusalText(other)).resolves.toBeNull();
    await expect(other.json()).resolves.toEqual({ error: "Invalid cursor." });
    await expect(readWorkspaceRefusalText(Response.json({ jobs: [] }))).resolves.toBeNull();
    await expect(readWorkspaceRefusalText(new Response("<html>", { status: 409 }))).resolves.toBeNull();
  });
});
