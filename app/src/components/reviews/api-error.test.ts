import { describe, expect, it } from "vitest";

import { readApiError, shownError } from "./api-error";

// F7 (R1 M5): the Reviews page read every error body with response.json(), so
// a non-JSON answer (a proxy's HTML page, an empty 502) showed a parse error.
describe("readApiError", () => {
  it("uses the route's own sentence and its reconnect flag", async () => {
    const response = new Response(JSON.stringify({ error: "Google refused.", reconnect: true }), { status: 500 });

    const error = await readApiError(response, "Fallback.");

    expect(shownError(error, "Other.")).toEqual({ message: "Google refused.", settingsLink: true });
  });

  // JJ3 lead review: the in-place Google sign-in, only when it is that start URL.
  it("carries the route's in-place sign-in URL, and nothing else as one", async () => {
    const ok = await readApiError(
      new Response(JSON.stringify({ error: "Sign in.", reconnect: true, signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-1" }), { status: 500 }),
      "F.",
    );
    expect(shownError(ok, "Other.")).toEqual({ message: "Sign in.", settingsLink: true, signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-1" });

    const bad = await readApiError(
      new Response(JSON.stringify({ error: "Sign in.", signInUrl: "https://evil.example/x" }), { status: 500 }),
      "F.",
    );
    expect(shownError(bad, "Other.").signInUrl).toBeUndefined();
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
