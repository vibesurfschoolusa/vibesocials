import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveGbpLocationName } from "@/server/platforms/gbpLocation";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveGbpLocationName", () => {
  it("returns a full resource name as-is without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGbpLocationName(
      "token-abc",
      "accounts/111/locations/999",
    );

    expect(result).toBe("accounts/111/locations/999");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a store code to a full location resource name", async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url.includes("/locations")) {
        return Promise.resolve(
          jsonResponse({
            locations: [{ name: "locations/999", storeCode: "STORE-1" }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ accounts: [{ name: "accounts/111" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGbpLocationName("token-abc", "STORE-1");

    expect(result).toBe("accounts/111/locations/999");
  });

  it("throws GBP_STORE_CODE_NOT_FOUND when no location matches the store code", async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url.includes("/locations")) {
        return Promise.resolve(jsonResponse({ locations: [] }));
      }
      return Promise.resolve(jsonResponse({ accounts: [{ name: "accounts/111" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await resolveGbpLocationName("token-abc", "MISSING")
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GBP_STORE_CODE_NOT_FOUND");
  });

  it("throws sanitized GBP_ACCOUNTS_LIST_FAILED when the accounts list request fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("permission denied SECRET_TOKEN", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await resolveGbpLocationName("token-abc", "STORE-1")
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GBP_ACCOUNTS_LIST_FAILED");
    expect(error?.message).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain("SECRET_TOKEN");
  });

  // 2026-11-01 scale audit (platform limits, V17): the account and location
  // lookups are classified too. A location-lookup 429 must not be swallowed as
  // a soft "skip this account" failure (it would end as GBP_STORE_CODE_NOT_FOUND).
  describe("rate limits (RATE_LIMITED)", () => {
    type LimitedError = Error & { code?: string; kind?: string; retryAt?: number | null; platform?: string };

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("accounts list 429 -> RATE_LIMITED, not GBP_ACCOUNTS_LIST_FAILED", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "30" } })),
      );

      const error = await resolveGbpLocationName("token-abc", "STORE-1").then(
        () => null,
        (e: unknown) => e as LimitedError,
      );

      expect(error).toMatchObject({
        code: "RATE_LIMITED",
        platform: "google_business_profile",
        kind: "rate_limited",
      });
      expect(error?.retryAt).toBeGreaterThan(Date.now());
    });

    it("location lookup 429 -> RATE_LIMITED instead of skipping the account", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL) =>
          Promise.resolve(
            input.toString().includes("/locations")
              ? new Response("", { status: 429 })
              : jsonResponse({ accounts: [{ name: "accounts/111" }] }),
          ),
        ),
      );

      const error = await resolveGbpLocationName("token-abc", "STORE-1").then(
        () => null,
        (e: unknown) => e as LimitedError,
      );

      expect(error).toMatchObject({ code: "RATE_LIMITED", retryAt: null });
    });

    it("a non-limit location failure is still skipped softly (store code not found)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL) =>
          Promise.resolve(
            input.toString().includes("/locations")
              ? new Response("", { status: 500 })
              : jsonResponse({ accounts: [{ name: "accounts/111" }] }),
          ),
        ),
      );

      const error = await resolveGbpLocationName("token-abc", "STORE-1").then(
        () => null,
        (e: unknown) => e as LimitedError,
      );

      expect(error?.code).toBe("GBP_STORE_CODE_NOT_FOUND");
    });
  });
});
