import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { flagRejectedTokenMock } = vi.hoisted(() => ({ flagRejectedTokenMock: vi.fn() }));
vi.mock("@/server/platforms/connectionHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionHealth")>()),
  flagRejectedToken: flagRejectedTokenMock,
}));

import { resolveGbpLocationName } from "@/server/platforms/gbpLocation";
import { MIN_REQUEST_WINDOW_MS, PUBLISH_BUDGET_EXCEEDED_CODE } from "@/server/platforms/publishBudget";

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

  // R21 platform-clients L1: the sentence says where the location is chosen.
  it("throws GBP_STORE_CODE_NOT_UNIQUE, saying where to choose the location, when two locations match", async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url.includes("/locations")) {
        return Promise.resolve(jsonResponse({ locations: [{ name: "locations/999", storeCode: "STORE-1" }] }));
      }
      return Promise.resolve(jsonResponse({ accounts: [{ name: "accounts/111" }, { name: "accounts/222" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await resolveGbpLocationName("token-abc", "STORE-1")
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GBP_STORE_CODE_NOT_UNIQUE");
    expect(error?.message).toBe(
      "This store code matches more than one Google Business Profile location. In Settings, choose the location from the list under Google Business Profile, or paste its full resource name under Advanced, then retry.",
    );
  });

  it("throws sanitized GBP_ACCOUNTS_LIST_FAILED when the accounts list request fails", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("permission denied SECRET_TOKEN", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await resolveGbpLocationName("token-abc", "STORE-1")
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error).toMatchObject({ code: "GBP_ACCOUNTS_LIST_FAILED", status: 403 });
    expect(error?.message).not.toContain("SECRET_TOKEN");
    // Logged by kind and status only (googleFailure.ts), never Google's body.
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain("SECRET_TOKEN");
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

    // R25: when no account's locations could be read, Google failed: a failure
    // with its status (so a 5xx is retried), never "store code not found".
    it("the only account's locations failing is Google's failure, not store code not found", async () => {
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

      expect(error).toMatchObject({ code: "GBP_ACCOUNTS_LIST_FAILED", status: 500 });
    });

    it("an account failing while another answers is still skipped softly (store code not found)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL) => {
          const url = input.toString();
          if (url.includes("accounts/111/locations")) return Promise.resolve(new Response("", { status: 500 }));
          if (url.includes("/locations")) return Promise.resolve(jsonResponse({ locations: [] }));
          return Promise.resolve(jsonResponse({ accounts: [{ name: "accounts/111" }, { name: "accounts/222" }] }));
        }),
      );

      const error = await resolveGbpLocationName("token-abc", "STORE-1").then(
        () => null,
        (e: unknown) => e as LimitedError,
      );

      expect(error?.code).toBe("GBP_STORE_CODE_NOT_FOUND");
    });
  });
});

// R25 (lead follow-up): the store-code lookup reads every page, with the same
// paged listing as Reviews and the Settings picker.
describe("resolveGbpLocationName reads every page", () => {
  const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
  const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";

  function google(pages: Record<string, { status?: number; body?: Record<string, unknown> }>) {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString());
      const page = pages[`${url.origin}${url.pathname}|${url.searchParams.get("pageToken") ?? ""}`];
      if (!page) throw new Error(`unexpected request ${url.toString()}`);
      return jsonResponse(page.body ?? {}, page.status ?? 200);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    flagRejectedTokenMock.mockReset();
    flagRejectedTokenMock.mockResolvedValue("flagged");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("finds a store code on the second page of locations, asking 100 a page", async () => {
    const fetchMock = google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/111" }] } },
      [`${INFO}/accounts/111/locations|`]: { body: { locations: [{ name: "locations/1", storeCode: "A" }], nextPageToken: "p2" } },
      [`${INFO}/accounts/111/locations|p2`]: { body: { locations: [{ name: "locations/2", storeCode: "STORE-1" }] } },
    });

    await expect(resolveGbpLocationName("token-abc", "STORE-1")).resolves.toBe("accounts/111/locations/2");
    const locationCalls = fetchMock.mock.calls.map(([u]) => new URL(u.toString())).filter((u) => u.pathname.endsWith("/locations"));
    expect(locationCalls.map((u) => u.searchParams.get("pageSize"))).toEqual(["100", "100"]);
  });

  it("finds a store code in an account on the second page of accounts", async () => {
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/111" }], nextPageToken: "a2" } },
      [`${ACCOUNTS}|a2`]: { body: { accounts: [{ name: "accounts/222" }] } },
      [`${INFO}/accounts/111/locations|`]: { body: { locations: [] } },
      [`${INFO}/accounts/222/locations|`]: { body: { locations: [{ name: "locations/7", storeCode: "STORE-1" }] } },
    });

    await expect(resolveGbpLocationName("token-abc", "STORE-1")).resolves.toBe("accounts/222/locations/7");
  });

  it("a store code on two pages is not unique", async () => {
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/111" }] } },
      [`${INFO}/accounts/111/locations|`]: { body: { locations: [{ name: "locations/1", storeCode: "STORE-1" }], nextPageToken: "p2" } },
      [`${INFO}/accounts/111/locations|p2`]: { body: { locations: [{ name: "locations/2", storeCode: "STORE-1" }] } },
    });

    await expect(resolveGbpLocationName("token-abc", "STORE-1")).rejects.toMatchObject({ code: "GBP_STORE_CODE_NOT_UNIQUE" });
  });

  // R25 (lead follow-up): a 401 here flags the row, as on every Google call.
  it("a 401 flags the row, with the tokens that call sent, and fails with the 401", async () => {
    google({ [`${ACCOUNTS}|`]: { status: 401 } });
    const used = { id: "conn-1", accessToken: "token-abc", refreshToken: "refresh" };

    const error = await resolveGbpLocationName("token-abc", "STORE-1", undefined, used).then(
      () => null,
      (e: unknown) => e as Error & { status?: number },
    );

    expect(flagRejectedTokenMock).toHaveBeenCalledWith(used, "GOOGLE_API_TOKEN_REJECTED");
    expect(error?.status).toBe(401);
  });

  it("a 503 flags nothing", async () => {
    google({ [`${ACCOUNTS}|`]: { status: 503 } });

    const error = await resolveGbpLocationName("token-abc", "STORE-1", undefined, {
      id: "conn-1",
      accessToken: "token-abc",
      refreshToken: null,
    }).catch((e: unknown) => e as Error & { status?: number });

    expect(error).toMatchObject({ code: "GBP_ACCOUNTS_LIST_FAILED", status: 503 });
    expect(flagRejectedTokenMock).not.toHaveBeenCalled();
  });
});

// 2026-11-01 scale audit (step budget, Task 7): the store-code lookup makes one
// request for the accounts and one per account, so a business with many
// accounts could outrun the step. Each lookup is clamped to the time left and
// none is started with under 5 s left.
describe("resolveGbpLocationName — step deadline", () => {
  const NOW = Date.parse("2026-11-01T12:00:00Z");
  type CodedError = Error & { code?: string };
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Two accounts, neither holding the store code. */
  function stubTwoAccounts(onFetch?: (url: string) => void) {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = input.toString();
      onFetch?.(url);
      return Promise.resolve(
        url.includes("/locations")
          ? jsonResponse({ locations: [] })
          : jsonResponse({ accounts: [{ name: "accounts/111" }, { name: "accounts/222" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("clamps every lookup's timeout to the time left (a deadline 8 s away -> each <= 8 s)", async () => {
    stubTwoAccounts();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await failure(resolveGbpLocationName("token-abc", "STORE-1", NOW + 8_000));

    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    // accounts list + one lookup per account
    expect(timeouts).toHaveLength(3);
    for (const timeout of timeouts) {
      expect(timeout).toBeLessThanOrEqual(8_000);
      expect(timeout).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
    }
  });

  it("keeps the 30 s default per lookup without a deadline", async () => {
    stubTwoAccounts();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await failure(resolveGbpLocationName("token-abc", "STORE-1"));

    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([30_000, 30_000, 30_000]);
  });

  it("refuses to start the accounts request with under 5 s left", async () => {
    const fetchMock = stubTwoAccounts();

    const error = await failure(
      resolveGbpLocationName("token-abc", "STORE-1", NOW + MIN_REQUEST_WINDOW_MS - 1),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops looking up accounts once the budget is spent mid-search (each lookup checks the time left)", async () => {
    // The accounts list answers after 4 s of the 8 s left: the first location
    // lookup would start with 4 s (< 5 s) left and must not be sent.
    const fetchMock = stubTwoAccounts((url) => {
      if (!url.includes("/locations")) vi.setSystemTime(NOW + 4_000);
    });

    const error = await failure(resolveGbpLocationName("token-abc", "STORE-1", NOW + 8_000));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a full resource name as-is even with the budget spent (no request needed)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveGbpLocationName("token-abc", "accounts/111/locations/999", NOW - 1),
    ).resolves.toBe("accounts/111/locations/999");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
