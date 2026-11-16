import { describe, expect, it } from "vitest";

import { REPLY_FINAL_CODES } from "@/server/googleReviews";
import { CONNECTION_RECONNECT_REQUIRED_CODE } from "@/server/platforms/connectionRefresh";

import { FINAL_FAILURE_CODES, canRetry, readApiError, shownError, signInHref } from "./api-error";

// F7 (R1 M5): the Reviews page read every error body with response.json(), so
// a non-JSON answer (a proxy's HTML page, an empty 502) showed a parse error.
describe("readApiError", () => {
  it("uses the route's own sentence and its reconnect flag", async () => {
    const response = new Response(JSON.stringify({ error: "Google refused.", reconnect: true }), { status: 500 });

    const error = await readApiError(response, "Fallback.");

    expect(shownError(error, "Other.")).toEqual({ message: "Google refused.", settingsLink: true });
  });

  // JJ3 lead review: the route sends only a flag; the page builds the URL from
  // the workspace it was drawn for, never from the server's active workspace.
  it("carries the route's sign-in flag, and ignores any URL in the answer", async () => {
    const ok = await readApiError(
      new Response(JSON.stringify({ error: "Sign in.", reconnect: true, signIn: true, signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-B" }), { status: 500 }),
      "F.",
    );
    expect(shownError(ok, "Other.")).toEqual({ message: "Sign in.", settingsLink: true, signIn: true });
  });

  it("the sign-in link names the page's own workspace", () => {
    expect(signInHref({ message: "x", settingsLink: true, signIn: true }, "ws-A")).toBe(
      "/api/auth/google_business_profile/start?workspaceId=ws-A",
    );
    expect(signInHref({ message: "x", settingsLink: true }, "ws-A")).toBeUndefined();
  });

  it("has no Settings link when the route did not ask for one", async () => {
    const error = await readApiError(new Response(JSON.stringify({ error: "Try again." }), { status: 500 }), "F.");

    expect(shownError(error, "Other.")).toEqual({ message: "Try again.", settingsLink: false });
  });

  it.each([
    ["an HTML page", "<html><body>Bad gateway</body></html>"],
    ["an empty body", ""],
    ["JSON with no error", JSON.stringify({ ok: false })],
    ["JSON whose error is not text", JSON.stringify({ error: { code: 7 } })],
  ])("falls back to the plain sentence for %s", async (_label, body) => {
    const error = await readApiError(new Response(body, { status: 502 }), "Fallback.");

    expect(shownError(error, "Other.")).toEqual({ message: "Fallback.", settingsLink: false });
  });
});

// R25 (KK1): a member asking for another location than the workspace's own
// gets a 403. Asking again gives the same answer, so the page offers no Retry.
describe("an answer a retry can't change", () => {
  it("a 403 is said plainly, with no retry", async () => {
    const error = await readApiError(
      new Response(JSON.stringify({ error: "Members read and answer the reviews of this workspace's own Google location only." }), { status: 403 }),
      "F.",
    );
    const shown = shownError(error, "Other.");
    expect(shown).toEqual({
      message: "Members read and answer the reviews of this workspace's own Google location only.",
      settingsLink: false,
      retry: false,
    });
    expect(canRetry(shown)).toBe(false);
  });

  it("anything else keeps Retry: a plain 5xx, a 429 and no answer at all", async () => {
    const shown = shownError(await readApiError(new Response("", { status: 500 }), "F."), "Other.");
    expect(canRetry(shown)).toBe(true);
    expect(canRetry(shownError(await readApiError(new Response("{}", { status: 429 }), "F."), "O."))).toBe(true);
    expect(canRetry(shownError(new TypeError("Failed to fetch"), "F."))).toBe(true);
  });

  // R25 lead review: a reply refused for a reason a retry can't change: the
  // route's code (kept equal to the server's list), a 404 or a 400.
  it.each(Object.values(REPLY_FINAL_CODES))("a 500 with code %s is final", async (code) => {
    const error = await readApiError(new Response(JSON.stringify({ error: "No.", code }), { status: 500 }), "F.");
    expect(canRetry(shownError(error, "O."))).toBe(false);
  });

  it("the page's list of final codes is the server's", () => {
    expect([...FINAL_FAILURE_CODES].sort()).toEqual(Object.values(REPLY_FINAL_CODES).sort());
    expect(REPLY_FINAL_CODES.reconnect).toBe(CONNECTION_RECONNECT_REQUIRED_CODE);
  });

  it.each([400, 404])("a %i is final", async (status) => {
    const error = await readApiError(new Response(JSON.stringify({ error: "No." }), { status }), "F.");
    expect(canRetry(shownError(error, "O."))).toBe(false);
  });
});

describe("shownError", () => {
  it.each([
    ["a JSON parse error", new SyntaxError("Unexpected token < in JSON at position 0")],
    ["a network failure", new TypeError("Failed to fetch")],
    ["anything else", "boom"],
  ])("never shows the text of %s", (_label, error) => {
    expect(shownError(error, "Fallback.")).toEqual({ message: "Fallback.", settingsLink: false });
  });
});
