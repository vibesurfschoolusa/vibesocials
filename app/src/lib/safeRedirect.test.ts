import { describe, expect, it } from "vitest";

import { authPageHref, safeCallbackPath } from "./safeRedirect";

describe("safeCallbackPath", () => {
  // Every input here must fall back. `searchParams.get` hands the page the
  // ONCE-decoded value, so `?callbackUrl=/%5Cexample.com` arrives as
  // "/\\example.com" (the live open-redirect repro).
  it.each([
    ["backslash after the slash (decoded /%5C repro)", "/\\evil.com"],
    ["backslash-t text", "/\\t/evil.com"],
    ["a real TAB (browsers strip it: /<TAB>/x becomes //x)", "/\t/evil.com"],
    ["a real newline", "/\n/evil.com"],
    ["a carriage return", "/\r/evil.com"],
    ["a NUL", "/\u0000/evil.com"],
    ["DEL", "/\u007f/evil.com"],
    ["a space", "/ /evil.com"],
    ["a non-ASCII space", "/ /evil.com"],
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with a path", "//evil.com/queue"],
    ["percent-encoded backslash (raw)", "/%5Cevil.com"],
    ["percent-encoded backslash, lowercase (raw)", "/%5cevil.com"],
    ["absolute https URL", "https://evil.com"],
    ["absolute http URL to the same-looking host", "http://internal.invalid/queue"],
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:text/html,<script>alert(1)</script>"],
    ["bare host", "evil.com"],
    ["relative path without a leading slash", "queue"],
    ["empty string", ""],
  ])("rejects %s", (_label, raw) => {
    expect(safeCallbackPath(raw)).toBe("/");
    expect(safeCallbackPath(raw, "/queue")).toBe("/queue");
  });

  it.each([null, undefined])("falls back for %s", (raw) => {
    expect(safeCallbackPath(raw)).toBe("/");
    expect(safeCallbackPath(raw, "/settings")).toBe("/settings");
  });

  it.each([
    ["/", "/"],
    ["/queue?x=1#y", "/queue?x=1#y"],
    ["/join/abc", "/join/abc"],
    ["/settings", "/settings"],
    ["/posts/new?mediaItemId=m1", "/posts/new?mediaItemId=m1"],
    // Encoded spaces stay encoded — only literal whitespace is refused.
    ["/queue?q=hello%20world", "/queue?q=hello%20world"],
  ])("allows the same-origin path %s", (raw, expected) => {
    expect(safeCallbackPath(raw)).toBe(expected);
  });

  it("returns the parsed pathname + search + hash (dot segments resolved)", () => {
    expect(safeCallbackPath("/a/../queue?x=1#y")).toBe("/queue?x=1#y");
  });
});

describe("authPageHref", () => {
  it("omits callbackUrl when it is the default home path", () => {
    expect(authPageHref("/login", "/")).toBe("/login");
    expect(authPageHref("/register", "/")).toBe("/register");
  });

  it("carries a non-default callbackUrl, URI-encoded", () => {
    expect(authPageHref("/login", "/join/abc")).toBe("/login?callbackUrl=%2Fjoin%2Fabc");
    expect(authPageHref("/register", "/queue?x=1#y")).toBe(
      "/register?callbackUrl=%2Fqueue%3Fx%3D1%23y",
    );
  });

  it("re-sanitizes the callbackUrl it is given, so an unsafe value is dropped", () => {
    expect(authPageHref("/login", "//evil.com")).toBe("/login");
    expect(authPageHref("/login", "/\\evil.com")).toBe("/login");
  });

  it("round-trips: the page reading the link gets the same safe path back", () => {
    const href = authPageHref("/login", "/join/tok_123");
    const callbackUrl = new URL(href, "http://x.invalid").searchParams.get("callbackUrl");
    expect(safeCallbackPath(callbackUrl)).toBe("/join/tok_123");
  });
});
