import { describe, expect, it } from "vitest";

import { readApiError, shownError, signInHref } from "./api-error";

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

describe("shownError", () => {
  it.each([
    ["a JSON parse error", new SyntaxError("Unexpected token < in JSON at position 0")],
    ["a network failure", new TypeError("Failed to fetch")],
    ["anything else", "boom"],
  ])("never shows the text of %s", (_label, error) => {
    expect(shownError(error, "Fallback.")).toEqual({ message: "Fallback.", settingsLink: false });
  });
});
