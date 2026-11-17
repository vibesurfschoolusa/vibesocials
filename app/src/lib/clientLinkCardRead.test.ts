import { describe, expect, it } from "vitest";

import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import {
  MISSING_WORKSPACE_ID_MESSAGE,
  renderedWorkspaceRefusal,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";

import { clientLinkLoadTexts, readClientLinkCard } from "./clientLinkCardRead";

/**
 * R42 pages-b L1: the Queue's review-link card and Settings' connect-link
 * card read their link by one rule, as the upload-link card does (R41 L6):
 * a failure says what happened, a workspace refusal asks for a reload, and
 * only a 403 is left to the caller (a member may not see the card).
 */

const texts = clientLinkLoadTexts("client review link");
const hasLink = (data: unknown): data is { link: unknown } =>
  typeof data === "object" && data !== null && "link" in data;

function read(response: Response | Error) {
  const fetchImpl = (() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))) as typeof fetch;
  return readClientLinkCard("/api/x?workspaceId=ws-1", texts, hasLink, fetchImpl);
}

describe("readClientLinkCard", () => {
  it("words the card by name", () => {
    expect(texts).toEqual({
      offline: "We couldn't reach Vibe Socials to load the client review link. Check your connection and try again.",
      failed: "We couldn't load the client review link. Try again in a moment.",
    });
  });

  it("a good answer is ready", async () => {
    expect(await read(Response.json({ link: null }))).toEqual({ kind: "ready", data: { link: null } });
  });

  it("offline: the connection sentence", async () => {
    expect(await read(new TypeError("Failed to fetch"))).toEqual({ kind: "failed", message: texts.offline });
  });

  it("a JSON 5xx, an HTML 5xx, a 429 and an unreadable 200: the failed sentence", async () => {
    for (const response of [
      Response.json({ error: "Internal" }, { status: 500 }),
      new Response("<html></html>", { status: 502, headers: { "content-type": "text/html" } }),
      Response.json({ error: "Too many" }, { status: 429 }),
      Response.json({ nope: true }),
    ]) {
      expect(await read(response)).toEqual({ kind: "failed", message: texts.failed });
    }
  });

  it("a 401: the signed-out sentence", async () => {
    expect(await read(Response.json({ error: "Unauthorized" }, { status: 401 }))).toEqual({
      kind: "failed",
      message: SIGNED_OUT_ERROR,
    });
  });

  it("a 409 (switched in another tab): changed, with the switch sentence", async () => {
    expect(await read(renderedWorkspaceRefusal("ws-1", "ws-2") as Response)).toEqual({
      kind: "changed",
      message: WORKSPACE_CHANGED_SAVE_MESSAGE,
    });
  });

  it("a 409 without a code still asks for a reload", async () => {
    expect(await read(Response.json({ error: "x" }, { status: 409 }))).toEqual({
      kind: "changed",
      message: WORKSPACE_CHANGED_SAVE_MESSAGE,
    });
  });

  it("a missing workspace id: changed, with its sentence", async () => {
    expect(await read(renderedWorkspaceRefusal(undefined, "ws-1") as Response)).toEqual({
      kind: "changed",
      message: MISSING_WORKSPACE_ID_MESSAGE,
    });
  });

  it("a 403 is left to the caller", async () => {
    expect(await read(Response.json({ error: "Owners only" }, { status: 403 }))).toEqual({ kind: "forbidden" });
  });
});
