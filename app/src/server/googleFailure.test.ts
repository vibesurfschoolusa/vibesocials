import { afterEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

import { classifyGoogleFailure, googleFailureKind } from "./googleFailure";

/**
 * JJ3 lead review: Google failures were turned into text in three places
 * (Reviews routes, the link route, the Settings location picker), each with
 * its own rule. One rule now sorts a failure into a kind; each surface words
 * the kind itself.
 */
const failure = (fields: Record<string, unknown>) => Object.assign(new Error("Google failed"), fields);
const refresh = (status: number | undefined, oauthError?: string) =>
  failure({ code: "GOOGLE_TOKEN_REFRESH_FAILED", status, ...(oauthError ? { oauthError } : {}) });

afterEach(() => vi.restoreAllMocks());

describe("googleFailureKind", () => {
  it.each([
    ["an API 401", failure({ status: 401 })],
    ["a 403 for a missing scope (a reconnect grants it)", failure({ status: 403, googleReasons: ["accesstokenscopeinsufficient"] })],
    ["a row already flagged", failure({ code: "RECONNECT_REQUIRED" })],
    ["a row removed meanwhile", failure({ code: "CONNECTION_GONE" })],
    ["no refresh token", failure({ code: "GOOGLE_NO_REFRESH_TOKEN" })],
    ["a refresh refused with invalid_grant", refresh(400, "invalid_grant")],
    ["a refresh 400 unauthorized_client", refresh(400, "unauthorized_client")],
    ["a refresh 401 without an OAuth code", refresh(401)],
    ["invalid_grant with no status", refresh(undefined, "invalid_grant")],
  ])("reconnect: %s", (_label, error) => {
    expect(googleFailureKind(error)).toBe("reconnect");
  });

  it.each([
    ["no reason", failure({ status: 403 })],
    ["an empty reason list", failure({ status: 403, googleReasons: [] })],
    ["forbidden", failure({ status: 403, googleReasons: ["forbidden"] })],
    ["PERMISSION_DENIED", failure({ status: 403, googleReasons: ["permissiondenied"] })],
  ])("access: a 403 with %s", (_label, error) => {
    expect(googleFailureKind(error)).toBe("access");
  });

  it.each([
    ["a 403 SERVICE_DISABLED", failure({ status: 403, googleReasons: ["servicedisabled"] })],
    ["a 403 accessNotConfigured", failure({ status: 403, googleReasons: ["accessnotconfigured"] })],
    ["a 403 quotaExceeded", failure({ status: 403, googleReasons: ["quotaexceeded"] })],
    ["a 403 rate limit among other reasons", failure({ status: 403, googleReasons: ["forbidden", "ratelimitexceeded"] })],
    ["a 429", failure({ status: 429 })],
    ["a 500", failure({ status: 500 })],
    ["a 503", failure({ status: 503 })],
    ["no answer at all", new TypeError("fetch failed")],
    ["our own timeout", failure({ code: FETCH_TIMEOUT_CODE })],
    ["a refresh 503", refresh(503)],
    ["a refresh 429", refresh(429)],
    ["a refresh invalid_client (our OAuth client)", refresh(401, "invalid_client")],
    ["missing OAuth credentials", failure({ code: "GOOGLE_MISSING_OAUTH_CREDENTIALS" })],
    ["another refresh holding the lock", failure({ code: "CONNECTION_REFRESH_BUSY" })],
  ])("tryLater: %s", (_label, error) => {
    expect(googleFailureKind(error)).toBe("tryLater");
  });

  it.each([
    ["a 404", failure({ status: 404 })],
    ["a refresh 403 (not flagged)", refresh(403, "unauthorized_client")],
    ["a JSON parse error", new SyntaxError("Unexpected token < in JSON at position 0")],
    ["a programming TypeError", new TypeError("Cannot read properties of undefined")],
    ["something that is not an error", "boom"],
    ["nothing", undefined],
  ])("other: %s", (_label, error) => {
    expect(googleFailureKind(error)).toBe("other");
  });
});

describe("classifyGoogleFailure: one log line per failure", () => {
  it("logs the kind, status, code and reasons once, and nothing that could be a token", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = failure({
      status: 403,
      code: "GBP_REVIEWS_FETCH_FAILED",
      googleReasons: ["servicedisabled"],
      accessToken: "ya29.secret",
    });

    expect(classifyGoogleFailure(error, "GET /api/reviews")).toBe("tryLater");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[Google] request failed", {
      where: "GET /api/reviews",
      kind: "tryLater",
      status: 403,
      code: "GBP_REVIEWS_FETCH_FAILED",
      reasons: ["servicedisabled"],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("ya29");
  });

  it("an unexpected failure logs its name, never its message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    classifyGoogleFailure(new SyntaxError("Unexpected token < at https://example.com/?token=x"), "GET /api/reviews");

    expect(warn).toHaveBeenCalledWith("[Google] request failed", { where: "GET /api/reviews", kind: "other", name: "SyntaxError" });
  });

  it("logs the OAuth code of a refresh failure, when there is one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    classifyGoogleFailure(refresh(400, "invalid_grant"), "picker");

    expect(warn).toHaveBeenCalledWith("[Google] request failed", {
      where: "picker",
      kind: "reconnect",
      status: 400,
      code: "GOOGLE_TOKEN_REFRESH_FAILED",
      oauthError: "invalid_grant",
    });
  });
});
